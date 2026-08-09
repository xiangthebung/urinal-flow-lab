import { Profile } from './profile';

/**
 * Where the rim of the opening is, relative to the sagittal profile.
 *
 * This is the module that decides whether the fixture is an enclosed basin or an
 * open scoop, and it has now been wrong twice in different ways, so the reasoning
 * is recorded here rather than spread across the surface builder.
 *
 * ## What this used to be, and why it was not enough
 *
 * It used to return one number per profile station: how far forward in *z* the
 * side edges of the section stood. Nothing moved them in *y*, so the `u = +-1`
 * boundary of the patch was the profile itself swept out to the full half width --
 * it ran from the top of the back wall all the way *down* through the sump and
 * back up to the lip. The consequences were structural rather than cosmetic:
 *
 *   - The bowl had no side walls in its front half. At any height between the sump
 *     and the lip the surface was a back-wall sheet and a separate front-lip strip
 *     with nothing joining them, so the interior was a *saddle*, not a basin.
 *     Measured over the six presets, the boundary dived 130-405 mm below the lower
 *     of its own two ends, and the resulting slot down each side was 57-216 mm
 *     wide. On screen the front strip read as a bright ribbon standing inside the
 *     bowl with a free edge, which is exactly what it was.
 *   - Film reaching `u = +-1` was therefore leaving at the *bottom* of the bowl,
 *     where a real fixture has a side wall and nothing can leave at all. That is
 *     the undiagnosed residue of Trap 23.
 *
 * The old law also needed a fade to zero before the sump, because a forward
 * displacement that dies away while the profile is still moving forward cancels a
 * cell's extent along v and degenerates it. Three fades were composed over time
 * and each fought the others, producing three separate regressions. That is Trap
 * 3, and its lesson -- one mechanism, not a pile of them -- is why what follows
 * replaces that law rather than adding a fourth fade on top of it.
 *
 * ## What it is now
 *
 * The rim of the opening is a curve in its own right, and this module says where
 * it is: `wrap` is how far ahead of the profile it stands in z, `lift` is how far
 * above it in y. The surface builder sweeps each row from the profile out to that
 * point, so `u = +-1` really is the rim.
 *
 * The `lift` is the whole point. It is what closes the side of the bowl, and it is
 * also what makes the Trap 3 cancellation unhittable: where the profile runs
 * horizontally across the sump the rim is still descending, and where the profile
 * runs vertically down the back wall the rim is still advancing, so the boundary
 * always has somewhere to go. The old law had one degree of freedom and had to
 * spend it on enclosure and conditioning at the same time, which is why no value
 * of it was good.
 *
 * The curve is a cubic Bezier from the top of the back wall to the front of the
 * lip, walked at **constant arclength**. Parameterising it by `v` directly seemed
 * simpler and is not: a Bezier's own parameter crawls near its ends, so the rim
 * advanced about a millimetre per row near the back while the profile advanced
 * six, and the cells along the boundary came out six times shorter than those on
 * the centreline. Equal arclength fixes that ratio at `rim length / profile
 * length` everywhere, which is about a half.
 */

export interface WrapOptions {
  /**
   * How far forward of the back wall the rim reaches, m.
   *
   * A Bezier control point, so it sets the fullness of the sweep rather than a
   * distance the rim actually attains. Large values give a deeply enclosed bowl
   * whose mouth faces upward; small values leave the mouth facing the user, which
   * is what an open trough has.
   */
  depth: number;
  /**
   * Bias of the rim's arclength schedule against the profile's.
   *
   * Below 1 the rim runs ahead, so the fixture closes in further down; above 1 it
   * lags. Exactly 1 walks the two in step. Held in a band because it is also the
   * ratio of cell heights along the boundary to those on the centreline, and that
   * is a stability limit rather than a matter of taste.
   */
  decay: number;
  /** Retained for the interface; the curve is analytic and needs no relaxing. */
  smoothPasses: number;
}

/** Offsets from the sagittal profile to the rim, one per profile station. */
export interface RimProfile {
  /** Forward stand-off of the rim over the profile, m. */
  wrap: Float64Array;
  /** Height of the rim above the profile, m. */
  lift: Float64Array;
}

export function defaultWrapOptions(): Omit<WrapOptions, 'depth' | 'decay'> {
  return { smoothPasses: 0 };
}

/** Samples used to measure the rim's arclength. Independent of the grid. */
const RIM_SAMPLES = 1024;

/**
 * The rim curve's three free constants.
 *
 * These decide whether the patch is well conditioned, and none of it shows in the
 * rendered shape, so it is worth saying what each one is holding off. All of it
 * happens at one place -- the outer corner of the front lip -- because that is
 * where the profile and the rim have to meet.
 *
 * `descentBias` -- how much of its drop the rim has done by the first control
 * point. On the front rise the profile is climbing toward the lip while the rim is
 * descending toward it, so the row joining them points up and the rim's own travel
 * points down. At 0, a rim that holds back-rim height and then plunges into the
 * lip, those two came within 7 degrees of anti-parallel over v = 0.7 to 0.9: skew
 * 0.10, and the count grew with resolution, which is the signature of a real
 * collapse rather than a sampling artefact. At 1 the rim has finished descending
 * and runs forward over the front rise instead, nearly perpendicular to the rows.
 * It is also the more honest shape -- on every fixture here the back rim stands
 * only 100-200 mm above the lip, so a real mouth is close to level over its front
 * half and rises at the back.
 *
 * `arrivalRun` -- how far behind its end the second control point sits, as a
 * fraction of the rim's chord. Sets the rim travelling forward as it arrives, so
 * it meets the front row of the patch square.
 *
 * `endReach` -- how far forward of the lip *tip* the rim finishes, as a fraction
 * of the way to the fixture's own front-most point. This one is the difference
 * between working and not. Ending the rim exactly on the lip tip forces it and the
 * profile to converge on a single point, so near v = 1 the two boundary curves
 * become tangent and the rows between them close like a fan; that leaves 4-6
 * degenerate cells at the finest grids and no setting of the other two removes
 * them. Since the lip curls back over the bowl, the tip is not the front of the
 * fixture anyway, and finishing a fifth of the way out to the plane that is keeps
 * a real gap between the two curves all the way to the corner.
 *
 * A negative result worth keeping, because it is the obvious thing to try: ending
 * the rim *above* the lip tip instead also removes the fan and gives 0 degenerate
 * cells with a much better worst skew (0.63 against 0.18). It is not usable. The
 * lip has already curled back over the bowl by then, so a rising rim there builds
 * an upstand whose outer face points away from the basin, and the normals over it
 * come out opposed to their neighbours -- 10 to 40 flipped normals across the
 * library, against 0 for `endReach`. Two mechanisms that both separate the curves;
 * only one of them respects which way the surface is facing.
 */
export const RIM_SHAPE = {
  descentBias: 1,
  arrivalRun: 0.25,
  endReach: 0.19,
};

/**
 * Where the rim sits above and ahead of the profile, at every profile station.
 *
 * `count` is the number of stations, normally nv + 1.
 */
export function buildRimProfile(
  profile: Profile,
  count: number,
  opts: WrapOptions
): RimProfile {
  const pts = profile.points;
  const last = pts.length - 1;
  const wrap = new Float64Array(count);
  const lift = new Float64Array(count);
  if (count < 2 || last < 1) return { wrap, lift };

  // Start anchor: the top of the back wall, which is a genuine edge of the
  // ceramic. Pinning the rim to it is what makes the v = 0 row come out flat with
  // no special case.
  const az = pts[0].z;
  const ay = pts[0].y;
  const bz = pts[last].z;
  const by = pts[last].y;

  // End anchor: level with the lip tip but forward of it, out toward the plane
  // where the fixture is actually deepest. See RIM_SHAPE.endReach.
  const endY = by;
  let front = bz;
  for (let k = 0; k <= last; k++) if (pts[k].z > front) front = pts[k].z;
  const endZ = bz + (front - bz) * RIM_SHAPE.endReach;

  const chord = Math.hypot(endZ - az, endY - ay);
  const c2z = endZ - RIM_SHAPE.arrivalRun * chord;
  const c2y = endY;
  const c1y = ay + (endY - ay) * RIM_SHAPE.descentBias;
  // The forward control is held between the anchors, which keeps the rim monotone
  // in depth. `depth` is measured forward from the top of the back wall, and on
  // the constant-angle model that point is already 205 mm out because the
  // generated wall sweeps forward before it starts descending -- so a requested
  // 260 mm put the control point 465 mm out, 180 mm in front of the lip. The rim
  // bulged past the front of the fixture and had to double back to reach it, its
  // tangent swung through vertical and out the other side, and where it came back
  // anti-parallel to the rows the cells collapsed: 192 degenerate cells at 112x200
  // on that preset alone. This is Trap 13's observation -- that the stand-off is
  // measured from wherever the generated wall has already swept to -- turning up
  // somewhere new. There it cost 190 mm of envelope; here it cost the grid.
  const zLo = Math.min(az, c2z);
  const zHi = Math.max(az, c2z);
  const c1z = Math.min(zHi, Math.max(zLo, az + Math.max(0, opts.depth)));

  // Trace the curve and measure it.
  const rz = new Float64Array(RIM_SAMPLES + 1);
  const ry = new Float64Array(RIM_SAMPLES + 1);
  const arc = new Float64Array(RIM_SAMPLES + 1);
  for (let k = 0; k <= RIM_SAMPLES; k++) {
    const t = k / RIM_SAMPLES;
    const s = 1 - t;
    const w0 = s * s * s;
    const w1 = 3 * t * s * s;
    const w2 = 3 * t * t * s;
    const w3 = t * t * t;
    rz[k] = w0 * az + w1 * c1z + w2 * c2z + w3 * endZ;
    ry[k] = w0 * ay + w1 * c1y + w2 * c2y + w3 * endY;
    arc[k] = k === 0 ? 0 : arc[k - 1] + Math.hypot(rz[k] - rz[k - 1], ry[k] - ry[k - 1]);
  }
  const total = arc[RIM_SAMPLES];
  if (total <= 1e-9) return { wrap, lift };

  // Held in a band because this is a conditioning knob as much as a shape one.
  const bias = Math.min(2, Math.max(0.5, opts.decay));

  let k = 0;
  for (let j = 0; j < count; j++) {
    const v = j / (count - 1);
    // Rational bias: monotone, fixes both ends, and has a finite slope at each of
    // them. A power law does not -- it arrives at one end with infinite slope,
    // which is the Trap 2 failure moved to a new place.
    const s = v <= 0 ? 0 : v >= 1 ? 1 : v / (v + (1 - v) * bias);
    const target = s * total;
    while (k < RIM_SAMPLES - 1 && arc[k + 1] < target) k++;
    const seg = arc[k + 1] - arc[k];
    const f = seg > 1e-12 ? (target - arc[k]) / seg : 0;
    // The caller asks for one offset per grid row, but `dedupe` may have dropped a
    // coincident profile point, so the two counts are not always equal.
    const pj = Math.min(last, Math.round(v * last));
    wrap[j] = rz[k] + (rz[k + 1] - rz[k]) * f - pts[pj].z;
    lift[j] = ry[k] + (ry[k + 1] - ry[k]) * f - pts[pj].y;
  }

  // Deliberately not relaxed. The old law needed smoothing because it was a ramp
  // with corners in it; this one is a Bezier walked at constant arclength and is
  // already as smooth as it gets. Worse, these are *offsets* from the profile, so
  // relaxing them does not relax the rim -- it subtracts a smoothed copy of the
  // profile's own curvature from a curve that never had any, which put a wobble in
  // the rim's height and reopened a 14 mm slot down the side of the constant-angle
  // model. Smooth the rim, if ever, not the gap to it.
  return { wrap, lift };
}
