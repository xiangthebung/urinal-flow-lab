import { UrinalSurface } from './surface';
import { Vec3, v3 } from '../core/vec3';

/**
 * The exterior ceramic body of the fixture.
 *
 * Purely cosmetic, and deliberately kept out of `UrinalSurface`. The simulation
 * only ever touches the wetted interior, so the physics, the film grid, the BVH
 * and the validation suite are all indifferent to what happens here. Keeping the
 * two apart means the outside can be shaped for the eye without any risk of
 * quietly changing a reported number.
 *
 * It exists because a urinal is not a surface, it is a thick porcelain object,
 * and the interior loft alone does not read as one. Rendered by itself the loft
 * looks like a bent sheet of paper: no rim to catch the light, no mass under the
 * bowl, no edge thickness anywhere. Nearly all of the "that's a urinal"
 * recognition lives in the outside of the casting and in the few millimetres of
 * glaze visible at the opening, and the interior patch contains neither.
 *
 * The construction is an *envelope fit*, not an offset of the interior. Offsetting
 * was the obvious first attempt and it fails for a structural reason: offsetting a
 * thin wall gives another thin wall a fixed distance away, so the front rise of
 * the bowl came out as an unsupported fin with a hook on it and the fixture read
 * as a slab with a scoop hanging off the front. Real sanitaryware is the other way
 * round -- the interior is a cavity hollowed out of a solid body, and the ceramic
 * is whatever thickness happens to be left over. So this fits a smooth outer body
 * around the interior and then measures the thickness to it:
 *
 *   - A stack of horizontal sections is sized from the interior's own extents at
 *     each height, so the body always contains the bowl and adapts to any preset
 *     without hand-tuning -- a trough, a stall slab and a nautilus horn all get a
 *     sensible casting.
 *   - Thickness is the distance from the interior out to that envelope, which
 *     makes the ceramic naturally thin at the front lip and massive under the
 *     sump, exactly as a section drawing of a real fixture looks.
 *   - Near the opening the thickness is ramped down to a rim value, so the rim,
 *     the side edges and the front lip all show a believable few-millimetre edge
 *     instead of a chunky slab.
 *   - Where the interior faces backward the envelope is a flat plane, so the
 *     fixture sits properly against the wall and a forward-curving wall simply
 *     has more ceramic behind it.
 */

export interface ShellParams {
  /** Ceramic thickness at the opening edge, m. */
  rimThickness: number;
  /** How far in from the opening edge the wall stays thin, m. */
  rimBandWidth: number;
  /** How far behind the profile datum the flat back face sits, m. */
  backSetback: number;
  /**
   * Greatest thickness of the ceramic skin, m.
   *
   * Without a cap the skin is offset until it reaches the fitted hull, which in the
   * throat is 150 mm away, and the result is a convex lump with the bowl buried
   * inside it. A urinal is emphatically not the convex hull of its own cavity: the
   * hull spans the full width at the rim and the full depth at the lip, so it is a
   * box by construction, and no amount of tuning the fit changes that. Capping the
   * skin at a plausible casting thickness keeps the outside following the shape of
   * the bowl, which is what makes it recognisable.
   */
  wallThickness: number;
  /** Clearance between the interior and the outer body, m. */
  clearance: number;
  /** Extra fullness of the casting at mid height, m. */
  bulge: number;
  /** How far the body continues below the lowest interior point, m. */
  bottomExtension: number;
  /** Radius of the bottom tip as a fraction of the section above it. */
  bottomTaper: number;
  /**
   * Angular smoothing passes on the fitted section, which is the main lever on
   * exterior character. Few passes hug the bowl and keep its plan shape, so a
   * squarish interior gives a squarish body; many passes relax the section toward
   * a circle and give a soft oval pod.
   */
  sectionSmoothing: number;
  /** Hard cap on thickness, m. */
  maxThickness: number;
  /** Smoothing passes applied to the outer surface. */
  smoothPasses: number;
}

export function defaultShellParams(): ShellParams {
  return {
    rimThickness: 0.014,
    wallThickness: 0.028,
    rimBandWidth: 0.05,
    backSetback: 0.045,
    clearance: 0.012,
    bulge: 0.012,
    bottomExtension: 0.05,
    bottomTaper: 0.34,
    sectionSmoothing: 2,
    maxThickness: 0.3,
    smoothPasses: 2,
  };
}

export interface ShellMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Bounds of the exterior alone. */
  min: Vec3;
  max: Vec3;
  /**
   * Measurements of the fit, for `tools/fixture-lab.mts`.
   *
   * Both of these are here because the two things that have gone wrong with the
   * casting are invisible in every other number the project reports, and one of
   * them was mistaken for a shading bug for a long time. Neither costs anything to
   * compute alongside the fit.
   */
  fit: {
    /**
     * Largest distance an interior vertex lies outside the fitted envelope, mm.
     *
     * Must be 0. Above 0 the bowl pokes through its own casting.
     */
    protrusion: number;
    /**
     * Amplitude of band-to-band *ripple* in the envelope radius, mm.
     *
     * The envelope is interpolated bilinearly, so a large second difference in
     * height is a visible ring crease, and the solid body takes its shading normals
     * from the same table, so the crease is lit as a facet.
     *
     * Measured as alternation rather than as the largest second difference,
     * because the largest second difference is not a defect: a urinal has real
     * creases in it -- the corner where a vertical wall meets the sump floor, the
     * fast taper of the bottom cap -- and those are single-signed and belong there.
     * A sampling artefact is the thing that changes sign every band or two, so this
     * takes the smaller of each consecutive pair of opposite-signed second
     * differences. Designed creases score near zero on that and ribbing does not.
     * Under ~0.5 mm reads as smooth.
     */
    ribbing: number;
    /** Height and direction of the worst ripple, mm above the datum and degrees. */
    ribbingAt: { y: number; deg: number };
  };
}

/**
 * Height bands and angular bins of the fitted outer section.
 *
 * These are a sampling rate, and they were both too low. The envelope is looked up
 * by bilinear interpolation, so it is only C0 across a cell boundary and the
 * casting carries a crease at every band and every bin. At 56 bands over a 640 mm
 * fixture the creases are 11 mm apart, which is coarse enough to see: the pedestal
 * came out ribbed like a radiator, and because the body's own normals are taken
 * analytically from the same table the ribs were lit as real facets. Cost is
 * O(BANDS x ABINS^2) once per rebuild, a few hundred thousand operations, so there
 * was never a reason to be frugal here.
 */
const BANDS = 112;
const ABINS = 49;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(1e-9, edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export function buildShell(s: UrinalSurface, over: Partial<ShellParams> = {}): ShellMesh {
  const p = { ...defaultShellParams(), ...over };
  const nu = s.nu;
  const nv = s.nv;
  const stride = nu + 1;
  const nVert = stride * (nv + 1);
  const zBack = -p.backSetback;

  // -- Outward direction at every interior vertex ---------------------------
  // Interior normals face into the bowl, so the exterior is the other way.
  const outward = new Float64Array(nVert * 3);
  for (let k = 0; k < nVert; k++) {
    outward[k * 3] = -s.vertexNormals[k * 3];
    outward[k * 3 + 1] = -s.vertexNormals[k * 3 + 1];
    outward[k * 3 + 2] = -s.vertexNormals[k * 3 + 2];
  }

  // -- The boundary of the opening -----------------------------------------
  // One closed loop: across the top of the back wall, down the right side edge,
  // back across the front lip, up the left side edge. That loop is the rim of a
  // real urinal, which is why the whole opening can be edged in a single band.
  const loop: number[] = [];
  for (let i = 0; i <= nu; i++) loop.push(i);
  for (let j = 1; j <= nv; j++) loop.push(j * stride + nu);
  for (let i = nu - 1; i >= 0; i--) loop.push(nv * stride + i);
  for (let j = nv - 1; j >= 1; j--) loop.push(j * stride);
  const L = loop.length;

  // -- Distance from each vertex to the opening edge ------------------------
  // Brute force against the boundary ring. A few million distance evaluations on
  // a rebuild is nothing, and it gives a true metric distance, so the rim keeps a
  // constant physical width instead of a constant number of cells.
  const edgeDist = new Float64Array(nVert);
  for (let k = 0; k < nVert; k++) {
    const x = s.vertices[k * 3];
    const y = s.vertices[k * 3 + 1];
    const z = s.vertices[k * 3 + 2];
    let best = Infinity;
    for (let m = 0; m < L; m++) {
      const b = loop[m] * 3;
      const dx = s.vertices[b] - x;
      const dy = s.vertices[b + 1] - y;
      const dz = s.vertices[b + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
    edgeDist[k] = Math.sqrt(best);
  }

  // -- Fit the outer envelope ----------------------------------------------
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let k = 0; k < nVert; k++) {
    const y = s.vertices[k * 3 + 1];
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const yBot = yMin - p.bottomExtension;
  const yTop = yMax;
  const ySpan = Math.max(1e-6, yTop - yBot);
  /** Continuous band coordinate of a height. */
  const bandCoord = (y: number) => ((y - yBot) / ySpan) * (BANDS - 1);
  const clampBand = (b: number) => Math.min(BANDS - 1, Math.max(0, b));

  // The section of the casting is fitted as a *support function* in the plane
  // (x, z - zBack): for each height band and each direction, how far out the
  // supporting line of the interior sits. The body is then the convex region
  // bounded by all of those lines.
  //
  // Two cheaper fits were tried first and both failed for instructive reasons. A
  // width-and-depth box has corners the bowl never fills, so it either cut the
  // side edges or, once grown until the corners cleared them, inflated the whole
  // casting by 70 mm. Recording the furthest reach per angle instead left the
  // directions the bowl does not occupy undefined, and filling those from their
  // neighbours carried the deep forward reach of the front lip out sideways --
  // a 340 mm bowl came out 600 mm wide.
  //
  // A support function has neither failure mode. Every direction is defined
  // whether or not the interior happens to point that way, offsetting outward is
  // exactly an additive constant, and the result provably contains the interior,
  // so no correction pass is needed. It is also convex, which is what the outside
  // of a piece of sanitaryware is.
  // -- Plan elongation ------------------------------------------------------
  //
  // The whole section fit lives in a polar frame about x = 0, and a polar frame is
  // only an even sampling of a body that is roughly as wide as it is deep. On the
  // trough it is not: 1.49 m wide against 0.42 m deep, and the consequences are not
  // subtle. Measured on the old trough, the fitted radius ran 408 mm at theta = 0,
  // peaked at 810 mm at 65 deg and came back to 745 mm at 90 deg -- non-monotonic,
  // because the far corner of an elongated box is further from the origin than its
  // end is, so the bins crowd the entire length of the fixture into the last few
  // degrees. Two visible faults followed. `topY` sat at the front-lip height right
  // out to 74 deg and then climbed 76 mm in the eight degrees to 82, which the 24
  // smoothing passes drew as the swept-up wing at each end -- the "V-notch at the
  // end caps". And the band-to-band ripple read 228 mm against 0.8 mm on the
  // cleanest model.
  //
  // The fix is to do the fit in a plan frame where x is divided by the elongation,
  // so a long shallow body is fitted as a roughly square one and the bins spread
  // along it evenly. Everything downstream is a linear map away: an anisotropic
  // scale is linear, so convexity and the support function's containment guarantee
  // both survive it, and the only care needed is that normals transform by the
  // inverse transpose (x component divided by `ex`, not multiplied).
  //
  // Clamped at 1, so this is *exactly* the identity for every fixture that is not
  // wider than it is deep. All five compact presets sit at 0.35-0.60 and are
  // untouched, bit for bit; only the trough moves.
  let planHalfWidth = 0;
  let planDepth = 1e-6;
  for (let k = 0; k < nVert; k++) {
    const ax = Math.abs(s.vertices[k * 3]);
    const dz = s.vertices[k * 3 + 2] - zBack;
    if (ax > planHalfWidth) planHalfWidth = ax;
    if (dz > planDepth) planDepth = dz;
  }
  const ex = Math.max(1, planHalfWidth / planDepth);

  const dirS = new Float64Array(ABINS);
  const dirC = new Float64Array(ABINS);
  for (let a = 0; a < ABINS; a++) {
    const th = -Math.PI / 2 + (a / (ABINS - 1)) * Math.PI;
    dirS[a] = Math.sin(th);
    dirC[a] = Math.cos(th);
  }

  const H = new Float64Array(BANDS * ABINS).fill(-Infinity);
  const raiseAt = (bi: number, dx: number, dz: number): void => {
    const row = bi * ABINS;
    for (let a = 0; a < ABINS; a++) {
      const h = dx * dirS[a] + dz * dirC[a];
      if (h > H[row + a]) H[row + a] = h;
    }
  };

  // The interior is sampled by EDGE, not by vertex.
  //
  // Binning vertices into the band nearest their own height is the obvious way to
  // do this and it is where the ribbing came from. Interior rows are uniform in
  // arclength, not in height, so wherever the profile is steep -- the whole back
  // wall -- consecutive rows are further apart in y than the bands are. Bands
  // between two rows then receive nothing and get filled by copying a neighbour,
  // while bands that happen to catch a row jump out to it. The result is a
  // staircase whose period is the row spacing, and since the raw fit is used again
  // below as a floor under the smoothed one, no amount of smoothing removes it: it
  // is put straight back.
  //
  // Walking each grid edge and raising every band it crosses, at the height where
  // it crosses, makes the fit a continuous function of y instead of a sampled one.
  // Vertices are still raised into the two bands bracketing them, which is what
  // guarantees containment: the envelope interpolates linearly in y between those
  // two bands, so if both are at least as far out as the vertex then so is every
  // height in between.
  // `sx` is in the *scaled* plan frame, which is what puts the whole support-function
  // fit -- vertices and spanned edges alike -- into that frame in one place.
  const sx = (k: number) => s.vertices[k * 3] / ex;
  const sy = (k: number) => s.vertices[k * 3 + 1];
  const sz = (k: number) => Math.max(0, s.vertices[k * 3 + 2] - zBack);

  // Vertices are spread into both bracketing bands ONLY where their column turns
  // back in height.
  //
  // Spreading every vertex is the obvious way to guarantee containment and it
  // reintroduced the ribbing in a subtler form. A vertex three tenths of a band
  // above a band line raises that band to its own reach, which is further out than
  // the surface actually is there; the next vertex may sit almost on a band line and
  // overshoot by nothing. So consecutive bands alternate between the true slice and
  // an overshoot, and the alternation is a ripple of |dh/dy| x band spacing -- about
  // 2 mm here, with a period of a few bands. That is precisely a fine rib.
  //
  // On a stretch where the column climbs monotonically the spread is redundant: the
  // edges either side of the vertex cross every band it lies between, so the
  // interpolated envelope already passes through it. It is only at a turning point
  // -- the front lip tip, the top of the rim, the bottom of the sump -- that no edge
  // reaches the extremum, and those are the few places it is needed. `fit.protrusion`
  // is the check that this reasoning is right rather than merely plausible.
  // A run that is FLAT in y needs the spread for the same reason a turning point
  // does: no edge along it crosses a band line, so the argument that the
  // neighbouring edges already cover the vertex does not hold there either.
  //
  // This is the sump floor, and it is why the bowl was poking through its own
  // casting. `sumpSlope` 0.005 on the trough puts the whole sump inside a third of
  // one 5 mm band, so the only point on it that ever reached the fit was the drain
  // -- a turning point, being the profile's minimum -- and the 65 mm of floor
  // running forward from the drain to the foot of the front rise was simply absent
  // from the envelope. Measured protrusion tracked sump slope across the library
  // almost monotonically: trough 0.005 rad and 30 mm through, compact 0.34 rad and
  // 11 mm, stall 0.09 and 7 mm, classic-bowl 0.12 and 4 mm.
  //
  // Deliberately narrower than "spread every vertex", which is the thing Trap 29(b)
  // warns about: spreading a vertex part-way above a band line raises that band to a
  // reach the surface does not have there, and consecutive vertices alternate
  // between the true slice and an overshoot. On a genuinely flat run there is no
  // overshoot to alternate with -- every vertex on it is at the same height -- so
  // the mechanism that produces the ripple is absent.
  const flatInY = (j: number, i: number): boolean => {
    if (j === 0 || j === nv) return false;
    const t = bandCoord(sy(j * stride + i));
    const tUp = bandCoord(sy((j + 1) * stride + i));
    const tDn = bandCoord(sy((j - 1) * stride + i));
    return Math.floor(t) === Math.floor(tUp) && Math.floor(t) === Math.floor(tDn);
  };
  const turnsInY = (j: number, i: number): boolean => {
    if (j === 0 || j === nv) return true;
    const y = sy(j * stride + i);
    const yUp = sy((j + 1) * stride + i);
    const yDn = sy((j - 1) * stride + i);
    return (y - yUp) * (y - yDn) >= 0;
  };
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      if (!turnsInY(j, i) && !flatInY(j, i)) continue;
      const k = j * stride + i;
      const tb = bandCoord(sy(k));
      raiseAt(clampBand(Math.floor(tb)), sx(k), sz(k));
      raiseAt(clampBand(Math.ceil(tb)), sx(k), sz(k));
    }
  }
  const spanEdge = (k0: number, k1: number): void => {
    const t0 = bandCoord(sy(k0));
    const t1 = bandCoord(sy(k1));
    const lo = Math.ceil(Math.min(t0, t1));
    const hi = Math.floor(Math.max(t0, t1));
    // `hi === lo` is an edge crossing exactly one band, which is the common case,
    // not a degenerate one. Excluding it made this whole mechanism a near no-op.
    if (hi < lo || Math.abs(t1 - t0) < 1e-12) return;
    for (let b = clampBand(lo); b <= clampBand(hi); b++) {
      const f = (b - t0) / (t1 - t0);
      if (f <= 0 || f >= 1) continue;
      raiseAt(b, sx(k0) + (sx(k1) - sx(k0)) * f, sz(k0) + (sz(k1) - sz(k0)) * f);
    }
  };
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const k = j * stride + i;
      if (j < nv) spanEdge(k, k + stride);
      if (i < nu) spanEdge(k, k + 1);
    }
  }

  // Bands with nothing in them sit below the bowl. Carry the lowest occupied
  // section down, scaling it about the back plane so the casting narrows and
  // draws back toward the wall into a rounded bottom.
  const occupied = new Uint8Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    occupied[b] = Number.isFinite(H[b * ABINS]) ? 1 : 0;
  }
  const firstOccupied = (() => {
    for (let b = 0; b < BANDS; b++) if (occupied[b]) return b;
    return 0;
  })();
  for (let b = BANDS - 2; b > firstOccupied; b--) {
    if (occupied[b]) continue;
    for (let a = 0; a < ABINS; a++) H[b * ABINS + a] = H[(b + 1) * ABINS + a];
  }
  if (!occupied[BANDS - 1]) {
    for (let a = 0; a < ABINS; a++) {
      H[(BANDS - 1) * ABINS + a] = H[(BANDS - 2) * ABINS + a];
    }
  }
  // Rounded underside, as a parabola in (height, radius) meeting the lowest fitted
  // section with zero slope, so there is no ring crease at the junction.
  //
  // The exponent is not a free choice. `sqrt(frac)`, which was here before, has an
  // infinite slope at the tip and a hard corner at the junction -- both ends wrong.
  // A smoothstep is C1 at both ends but its curvature peaks there instead, which is
  // worse: this cap only gets ~9 of the height bands, so a kink costs about
  // `6/9^2` of the section radius, around 10 mm. A parabola spreads its curvature
  // evenly and is the flattest curve that can arrive tangent, at about 3 mm.
  for (let b = 0; b < firstOccupied; b++) {
    const frac = firstOccupied > 0 ? b / firstOccupied : 1;
    const dome = 1 - (1 - frac) * (1 - frac);
    const k = p.bottomTaper + (1 - p.bottomTaper) * dome;
    for (let a = 0; a < ABINS; a++) H[b * ABINS + a] = H[firstOccupied * ABINS + a] * k;
  }

  // Offsetting a convex body outward is exactly adding a constant to its support
  // function, so clearance and the mid-height fullness go straight on.
  //
  // The offset is a REAL distance, and in the scaled frame that is not a constant.
  // Moving the supporting line out by `d` along the real outward normal shifts the
  // scaled support function by `d * hypot(sin/ex, cos)`: unchanged at theta = 0,
  // and `d/ex` at the ends. Adding `d` flat instead offsets the ends by `d * ex` --
  // on the trough that turned a 22 mm clearance into a 58 mm one per side and made
  // the casting 54 mm longer than the product it is dimensioned to.
  const offsetGain = new Float64Array(ABINS);
  for (let a = 0; a < ABINS; a++) offsetGain[a] = Math.hypot(dirS[a] / ex, dirC[a]);

  const rawH = Float64Array.from(H);
  for (let b = 0; b < BANDS; b++) {
    const sN = b / (BANDS - 1);
    const fullness = p.bulge * Math.sin(Math.PI * sN);
    for (let a = 0; a < ABINS; a++) {
      H[b * ABINS + a] += (p.clearance + fullness) * offsetGain[a];
    }
  }

  // Relax the section: angular smoothing rounds off the plan shape, vertical
  // smoothing cleans up the silhouette. Clamped back against the raw fit so
  // rounding a corner can never pull the body inside the bowl.
  const tmpH = new Float64Array(H.length);
  for (let pass = 0; pass < p.sectionSmoothing; pass++) {
    tmpH.set(H);
    for (let b = 0; b < BANDS; b++) {
      for (let a = 0; a < ABINS; a++) {
        const al = Math.max(0, a - 1);
        const ar = Math.min(ABINS - 1, a + 1);
        H[b * ABINS + a] =
          0.25 * tmpH[b * ABINS + al] +
          0.5 * tmpH[b * ABINS + a] +
          0.25 * tmpH[b * ABINS + ar];
      }
    }
  }
  for (let pass = 0; pass < 4; pass++) {
    tmpH.set(H);
    for (let b = 1; b < BANDS - 1; b++) {
      for (let a = 0; a < ABINS; a++) {
        H[b * ABINS + a] =
          0.25 * tmpH[(b - 1) * ABINS + a] +
          0.5 * tmpH[b * ABINS + a] +
          0.25 * tmpH[(b + 1) * ABINS + a];
      }
    }
  }
  // Floor under the smoothed fit, which is what keeps containment exact: the raw
  // support function provably contains the interior, so staying above it does too.
  //
  // This was the mechanism that made the ribbing permanent, and it is worth being
  // clear that it was never the fault -- it faithfully preserved a staircase that
  // was already in `rawH`. Now that the fit is sampled per edge, `rawH` is smooth
  // in y and the floor costs nothing.
  for (let i = 0; i < H.length; i++) {
    const floorH = rawH[i] + p.clearance * 0.5 * offsetGain[i % ABINS];
    if (H[i] < floorH) H[i] = floorH;
  }

  // Radial form of the same body, so the ray march is a table lookup instead of a
  // half-plane intersection at every step.
  const R = new Float64Array(BANDS * ABINS);
  for (let b = 0; b < BANDS; b++) {
    for (let a = 0; a < ABINS; a++) {
      let r = Infinity;
      for (let f = 0; f < ABINS; f++) {
        const c = dirS[a] * dirS[f] + dirC[a] * dirC[f];
        if (c <= 1e-3) continue;
        const cand = H[b * ABINS + f] / c;
        if (cand < r) r = cand;
      }
      R[b * ABINS + a] = Number.isFinite(r) ? Math.max(1e-4, r) : 1e-4;
    }
  }

  /** Envelope radius at a height and angle, bilinearly interpolated. */
  const radiusAt = (y: number, th: number): number => {
    const tb = Math.min(1, Math.max(0, (y - yBot) / ySpan)) * (BANDS - 1);
    const b0 = Math.min(BANDS - 2, Math.floor(tb));
    const fb = tb - b0;
    const ta = Math.min(1, Math.max(0, (th + Math.PI / 2) / Math.PI)) * (ABINS - 1);
    const a0 = Math.min(ABINS - 2, Math.floor(ta));
    const fa = ta - a0;
    return (
      (R[b0 * ABINS + a0] * (1 - fa) + R[b0 * ABINS + a0 + 1] * fa) * (1 - fb) +
      (R[(b0 + 1) * ABINS + a0] * (1 - fa) + R[(b0 + 1) * ABINS + a0 + 1] * fa) * fb
    );
  };

  // Measured over the fitted bands only. Below `firstOccupied` the section is the
  // designed bottom cap, a deliberately fast taper whose curvature would swamp the
  // number this is for. See ShellMesh.fit.ribbing for why it looks for alternation.
  let ribbing = 0;
  let ribBand = 0;
  let ribBin = 0;
  const d2 = (b: number, a: number) =>
    R[(b - 1) * ABINS + a] - 2 * R[b * ABINS + a] + R[(b + 1) * ABINS + a];
  for (let a = 0; a < ABINS; a++) {
    for (let b = Math.max(2, firstOccupied + 2); b < BANDS - 2; b++) {
      const u = d2(b, a);
      const w = d2(b + 1, a);
      if (u * w >= 0) continue;
      const amp = Math.min(Math.abs(u), Math.abs(w));
      if (amp > ribbing) {
        ribbing = amp;
        ribBand = b;
        ribBin = a;
      }
    }
  }

  /**
   * Envelope field. Negative inside the casting, positive outside.
   *
   * Closed at the top as well as the bottom and the back. Leaving the top open let
   * a ray march upward for ever without escaping, because heights above the rim
   * clamp to the topmost band and that band is the widest one -- so a wall that
   * leans forward at the top, which the constant-angle shapes all do, had its rim
   * vertices thrown 170 mm into the air on the thickness cap.
   */
  const field = (x: number, y: number, z: number): number => {
    if (y < yBot) return (yBot - y) * 50;
    if (y > yTop) return (y - yTop) * 50;
    const dz = z - zBack;
    if (dz < 0) return -dz * 50;
    const sxq = x / ex;
    const r = Math.hypot(sxq, dz);
    return r / radiusAt(y, Math.atan2(sxq, dz)) - 1;
  };

  // Containment, measured rather than asserted. See ShellMesh.fit.
  //
  // Reported as a REAL distance, not a scaled one. The comparison happens in the
  // scaled frame, but a scaled overshoot of d along direction theta is a real
  // overshoot of d * hypot(ex sin, cos) -- so on an elongated body the two differ by
  // up to `ex`, and quoting the scaled figure in millimetres would under-report the
  // very case this metric exists to catch.
  let protrusion = 0;
  for (let k = 0; k < nVert; k++) {
    const x = s.vertices[k * 3];
    const y = s.vertices[k * 3 + 1];
    const dz = s.vertices[k * 3 + 2] - zBack;
    if (dz < 0 || y < yBot || y > yTop) continue;
    const sxq = x / ex;
    const th = Math.atan2(sxq, dz);
    const r = Math.hypot(sxq, dz);
    const over =
      (r - radiusAt(y, th)) * Math.hypot(ex * Math.sin(th), Math.cos(th));
    if (over > protrusion) protrusion = over;
  }

  // -- Convexity of the interior, per vertex -------------------------------
  // Offsetting outward from a surface that bulges into the bowl walks toward the
  // centre of curvature, and past the radius it folds through itself. The front
  // lip curl is the case that matters: a 25 mm curl cannot carry 40 mm of body.
  const convexity = new Float64Array(nVert);
  const wsum = new Float64Array(nVert);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const c = j * nu + i;
      const kk = s.cellCurvature[c];
      const w = s.cellArea[c];
      for (const vi of [
        j * stride + i,
        j * stride + i + 1,
        (j + 1) * stride + i,
        (j + 1) * stride + i + 1,
      ]) {
        convexity[vi] += kk * w;
        wsum[vi] += w;
      }
    }
  }
  for (let k = 0; k < nVert; k++) if (wsum[k] > 0) convexity[k] /= wsum[k];

  // -- Thickness: march out to the envelope --------------------------------
  const outer = new Float64Array(nVert * 3);
  const step = 0.0025;
  for (let k = 0; k < nVert; k++) {
    const o = k * 3;
    const x = s.vertices[o];
    const y = s.vertices[o + 1];
    const z = s.vertices[o + 2];
    const ox = outward[o];
    const oy = outward[o + 1];
    const oz = outward[o + 2];

    let tEnv = p.rimThickness;
    if (field(x, y, z) < 0) {
      let lo = 0;
      let hi = -1;
      for (let d = step; d <= p.maxThickness; d += step) {
        if (field(x + ox * d, y + oy * d, z + oz * d) >= 0) {
          hi = d;
          lo = d - step;
          break;
        }
      }
      if (hi < 0) {
        tEnv = p.maxThickness;
      } else {
        for (let b = 0; b < 12; b++) {
          const mid = 0.5 * (lo + hi);
          if (field(x + ox * mid, y + oy * mid, z + oz * mid) >= 0) hi = mid;
          else lo = mid;
        }
        tEnv = 0.5 * (lo + hi);
      }
    }

    // Thin the wall down to a rim edge as the opening is approached -- but only
    // where the wall is genuinely part of the opening. The top of the back wall is
    // an edge of the patch too, and thinning it left the back face of the fixture
    // stepping 30 mm forward of the mounting plane for the top 50 mm, which is not
    // how a wall-hung fixture sits. Where the surface faces backward the full
    // thickness is kept, so the back stays flush and the rim reads as the chunky
    // rolled edge it is on a real bowl.
    const ramp = smoothstep(0, p.rimBandWidth, edgeDist[k]);
    // Facing backward is not the same as being at the back, and conflating the two
    // put a pair of thin plates out of the sides of the fixture like carrying
    // handles. The exemption exists so the ceramic behind the back wall stays thick
    // enough to reach the mounting plane, which is a statement about *position*. The
    // rim wraps forward to 275 mm at the sides on the default bowl, and those points
    // still face backward and upward, so they were being granted the full 300 mm
    // thickness cap 275 mm from the wall -- and the rim band, whose width is exactly
    // this thickness, drew the result edge on.
    const nearBack =
      1 - smoothstep(p.backSetback, p.backSetback + 3 * p.wallThickness, z - zBack);
    const backness = smoothstep(0.35, 0.85, Math.max(0, -oz)) * nearBack;
    const thinning = ramp + (1 - ramp) * backness;
    let t = p.rimThickness + (Math.max(tEnv, p.rimThickness) - p.rimThickness) * thinning;

    // Never offset past the local centre of curvature.
    if (convexity[k] > 1e-6) t = Math.min(t, 0.7 / convexity[k]);
    // A skin, not a fill. See wallThickness. The back is exempt, because there the
    // extra thickness is what carries the casting out to the mounting plane and is
    // genuinely solid on a real fixture.
    const cap = p.wallThickness + (p.maxThickness - p.wallThickness) * backness;
    t = Math.max(0.002, Math.min(t, cap));

    outer[o] = x + ox * t;
    outer[o + 1] = y + oy * t;
    outer[o + 2] = Math.max(zBack, z + oz * t);
  }

  // -- Smooth the outside ---------------------------------------------------
  // The boundary ring is pinned so the rim band stays exactly on the edge of the
  // opening; everything else relaxes, which drops any rib pattern cut into the
  // interior instead of embossing it onto the outside of the pot.
  const onEdge = new Uint8Array(nVert);
  for (let m = 0; m < L; m++) onEdge[loop[m]] = 1;
  const tmp = new Float64Array(outer.length);
  for (let pass = 0; pass < p.smoothPasses; pass++) {
    tmp.set(outer);
    for (let j = 1; j < nv; j++) {
      for (let i = 1; i < nu; i++) {
        const k = j * stride + i;
        if (onEdge[k]) continue;
        const o = k * 3;
        for (let a = 0; a < 3; a++) {
          const avg =
            0.25 *
            (tmp[(k - 1) * 3 + a] +
              tmp[(k + 1) * 3 + a] +
              tmp[(k - stride) * 3 + a] +
              tmp[(k + stride) * 3 + a]);
          outer[o + a] = tmp[o + a] + 0.5 * (avg - tmp[o + a]);
        }
      }
    }
    for (let k = 0; k < nVert; k++) {
      if (outer[k * 3 + 2] < zBack) outer[k * 3 + 2] = zBack;
    }
  }

  // -- Outer surface normals ------------------------------------------------
  const outerNormal = new Float64Array(nVert * 3);
  const at = (i: number, j: number, a: number) =>
    outer[(Math.min(nv, Math.max(0, j)) * stride + Math.min(nu, Math.max(0, i))) * 3 + a];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const k = j * stride + i;
      const eu = [
        at(i + 1, j, 0) - at(i - 1, j, 0),
        at(i + 1, j, 1) - at(i - 1, j, 1),
        at(i + 1, j, 2) - at(i - 1, j, 2),
      ];
      const ev = [
        at(i, j + 1, 0) - at(i, j - 1, 0),
        at(i, j + 1, 1) - at(i, j - 1, 1),
        at(i, j + 1, 2) - at(i, j - 1, 2),
      ];
      let nx = ev[1] * eu[2] - ev[2] * eu[1];
      let ny = ev[2] * eu[0] - ev[0] * eu[2];
      let nz = ev[0] * eu[1] - ev[1] * eu[0];
      const m = Math.hypot(nx, ny, nz);
      if (m < 1e-12) {
        nx = outward[k * 3];
        ny = outward[k * 3 + 1];
        nz = outward[k * 3 + 2];
      } else {
        nx /= m;
        ny /= m;
        nz /= m;
        // Orient against the interior's outward direction, which is reliable.
        if (nx * outward[k * 3] + ny * outward[k * 3 + 1] + nz * outward[k * 3 + 2] < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
      }
      outerNormal[k * 3] = nx;
      outerNormal[k * 3 + 1] = ny;
      outerNormal[k * 3 + 2] = nz;
    }
  }

  // -- Assemble -------------------------------------------------------------
  // Vertex blocks, in order: the offset outer surface, the rim band, then the
  // solid body. The band gets its own copies of the boundary so the rim edge stays
  // sharp instead of averaging its normal into the outer surface.
  const bandBase = nVert;
  const bodyBase = nVert + L * 2;
  const body = buildBody(s, p, zBack, yBot, radiusAt, ex);
  const totalVerts = bodyBase + body.count;
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  for (let k = 0; k < nVert * 3; k++) {
    positions[k] = outer[k];
    normals[k] = outerNormal[k];
  }
  for (let k = 0; k < body.count * 3; k++) {
    positions[bodyBase * 3 + k] = body.positions[k];
    normals[bodyBase * 3 + k] = body.normals[k];
  }

  const idx: number[] = [];
  for (const t of body.indices) idx.push(t + bodyBase);
  // Winding is decided empirically from one mid-patch triangle, because the
  // interior's index order is not guaranteed to be outward-facing for every
  // geometry and the shell has to be right for all of them.
  const flip = (() => {
    const j = Math.max(0, Math.floor(nv * 0.15));
    const i = Math.floor(nu / 2);
    const a = (j * stride + i) * 3;
    const b = (j * stride + i + 1) * 3;
    const c = ((j + 1) * stride + i) * 3;
    const e1 = [outer[b] - outer[a], outer[b + 1] - outer[a + 1], outer[b + 2] - outer[a + 2]];
    const e2 = [outer[c] - outer[a], outer[c + 1] - outer[a + 1], outer[c + 2] - outer[a + 2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    const k = j * stride + i;
    return nx * outward[k * 3] + ny * outward[k * 3 + 1] + nz * outward[k * 3 + 2] < 0;
  })();

  // Only the part of the skin above the front lip is emitted.
  //
  // Below the lip the solid pedestal is the outside of the fixture, so the skin
  // there is redundant -- and worse than redundant: the throat is strongly concave,
  // so offsetting it outward converges toward the centre of curvature and the skin
  // folds through itself, which showed up as a torn shard lying across the bowl. Its
  // one remaining job is above the lip, where the pedestal has stopped and the back
  // panel and the rim around the opening still need a surface. That region is
  // convex enough to offset safely.
  // BOTH rows must be above the cut, not either.
  //
  // With "either", the one row straddling the cut is emitted, and at the front that
  // row is the front lip: the profile turns over there, so the row below the lip tip
  // is already under the cut while the tip itself is above it. The result is a single
  // ring of offset quads standing free around the lip with nothing joining it to the
  // rest of the skin, which renders as a bright flap curling out of the front of the
  // bowl. The lip does not lose its edge -- the rim band runs round the whole opening
  // loop and is what draws the visible thickness there.
  //
  // Tested per cell, at all four of its corners, rather than per row at the
  // centreline. Those were the same test while every row of the interior was
  // level, and they stopped being the same when the loft gained side walls: a row
  // now runs from the profile out and *up* to the rim, so its ends can be 400 mm
  // above its middle. Asking only the centre column then answers for the wrong
  // part of the row, and the rows just below the back rim -- whose ends have
  // already swung forward and up onto the rim while their centres are still on the
  // back wall -- were emitted whole. The strip between them swept right across the
  // opening, and the casting rendered with a fan of long triangles paving its
  // mouth over. Trap 34's rule is unchanged in spirit: every corner must clear the
  // cut, not just one of them.
  const yCut = s.lipY - 0.004;
  const above = (k: number) => s.vertices[k * 3 + 1] > yCut;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      if (!above(a) || !above(b) || !above(c) || !above(d)) continue;
      if (flip) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }

  // Centroid of the opening, used to orient the rim band outward.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let m = 0; m < L; m++) {
    const b = loop[m] * 3;
    cx += s.vertices[b];
    cy += s.vertices[b + 1];
    cz += s.vertices[b + 2];
  }
  cx /= L;
  cy /= L;
  cz /= L;

  for (let m = 0; m < L; m++) {
    const src = loop[m] * 3;
    const vi = (bandBase + m * 2) * 3;
    positions[vi] = s.vertices[src];
    positions[vi + 1] = s.vertices[src + 1];
    positions[vi + 2] = s.vertices[src + 2];
    positions[vi + 3] = outer[src];
    positions[vi + 4] = outer[src + 1];
    positions[vi + 5] = outer[src + 2];
  }

  // Band normal at each loop point: perpendicular to both the loop tangent and
  // the wall thickness direction, pointed away from the middle of the opening.
  for (let m = 0; m < L; m++) {
    const prev = loop[(m - 1 + L) % L] * 3;
    const next = loop[(m + 1) % L] * 3;
    const here = loop[m] * 3;
    const tx = s.vertices[next] - s.vertices[prev];
    const ty = s.vertices[next + 1] - s.vertices[prev + 1];
    const tz = s.vertices[next + 2] - s.vertices[prev + 2];
    const wx = outer[here] - s.vertices[here];
    const wy = outer[here + 1] - s.vertices[here + 1];
    const wz = outer[here + 2] - s.vertices[here + 2];
    let nx = ty * wz - tz * wy;
    let ny = tz * wx - tx * wz;
    let nz = tx * wy - ty * wx;
    const mag = Math.hypot(nx, ny, nz);
    if (mag < 1e-12) {
      nx = outward[loop[m] * 3];
      ny = outward[loop[m] * 3 + 1];
      nz = outward[loop[m] * 3 + 2];
    } else {
      nx /= mag;
      ny /= mag;
      nz /= mag;
      const rx = s.vertices[here] - cx;
      const ry = s.vertices[here + 1] - cy;
      const rz = s.vertices[here + 2] - cz;
      if (nx * rx + ny * ry + nz * rz < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
    }
    const vi = (bandBase + m * 2) * 3;
    normals[vi] = nx;
    normals[vi + 1] = ny;
    normals[vi + 2] = nz;
    normals[vi + 3] = nx;
    normals[vi + 4] = ny;
    normals[vi + 5] = nz;
  }

  const bandFlip = (() => {
    const a = bandBase;
    const b = bandBase + 2;
    const e1 = [
      positions[b * 3] - positions[a * 3],
      positions[b * 3 + 1] - positions[a * 3 + 1],
      positions[b * 3 + 2] - positions[a * 3 + 2],
    ];
    const e2 = [
      positions[(a + 1) * 3] - positions[a * 3],
      positions[(a + 1) * 3 + 1] - positions[a * 3 + 1],
      positions[(a + 1) * 3 + 2] - positions[a * 3 + 2],
    ];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    return (
      nx * normals[bandBase * 3] +
        ny * normals[bandBase * 3 + 1] +
        nz * normals[bandBase * 3 + 2] <
      0
    );
  })();

  for (let m = 0; m < L; m++) {
    const next = (m + 1) % L;
    // Matched to the skin: no band where there is no skin to edge.
    if (
      s.vertices[loop[m] * 3 + 1] <= yCut &&
      s.vertices[loop[next] * 3 + 1] <= yCut
    ) {
      continue;
    }
    const a0 = bandBase + m * 2;
    const a1 = a0 + 1;
    const b0 = bandBase + next * 2;
    const b1 = b0 + 1;
    if (bandFlip) idx.push(a0, b0, a1, a1, b0, b1);
    else idx.push(a0, a1, b0, a1, b1, b0);
  }

  const min = v3(Infinity, Infinity, Infinity);
  const max = v3(-Infinity, -Infinity, -Infinity);
  for (let k = 0; k < totalVerts; k++) {
    const x = positions[k * 3];
    const y = positions[k * 3 + 1];
    const z = positions[k * 3 + 2];
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }

  return {
    positions,
    normals,
    indices: new Uint32Array(idx),
    min,
    max,
    fit: {
      protrusion: protrusion * 1000,
      ribbing: ribbing * 1000,
      ribbingAt: {
        y: (yBot + (ribBand / (BANDS - 1)) * ySpan) * 1000,
        deg: -90 + (ribBin / (ABINS - 1)) * 180,
      },
    },
  };
}

/**
 * Angular (per side) and vertical resolution of the solid body.
 *
 * Kept at or above the envelope table's own resolution. Sampling the body more
 * coarsely than the table it reads from throws away detail that has already been
 * paid for, and sampling it much finer only resolves the table's interpolation
 * creases more sharply.
 */
const BODY_A = 44;
const BODY_V = 96;

/**
 * The solid lower body of the fixture.
 *
 * The offset surface above is a skin: it follows the interior, so its cross
 * section is the same C the bowl is, and a C-section casting is see-through from
 * the side -- you look straight between the front rise and the back wall. Real
 * sanitaryware is a solid lump with a cavity in it, so the volume between the
 * front of the bowl and the mounting plane has to actually be filled.
 *
 * HOW HIGH THE FILL GOES, PER DIRECTION
 *
 * The top of the solid is not one height. It follows the boundary of the opening,
 * angle by angle, which is the only definition that is right everywhere: the solid
 * ceramic ends exactly where the cavity begins.
 *
 * Two simpler rules were tried and both produce a recognisable wrong object.
 * Carrying the body to the rim height all round and cutting wings either side of
 * the opening fills in everything around the bowl and reduces the opening to a
 * slot, so the fixture reads as a rounded box. Stopping at the front lip height all
 * round -- which is right at the front and nowhere else -- leaves a horizontal
 * annulus at that height, and at the sides that annulus is over solid ceramic with
 * no cavity beneath it to trim it against, so it comes out as a 50 mm plate
 * standing proud of the fixture like a collar on a plant pot, with the thin back
 * panel apparently balanced on top of it. That collar was the single most
 * unconvincing thing about these renders.
 *
 * Following the loop gives the front lip height at the front, the side-edge height
 * at the sides and the rim height where the rim wraps round, so the casting is one
 * continuous mass from the floor to the rim with a bowl hollowed out of it.
 *
 * Sits a whisker outside the offset surface so the two cannot z-fight where they
 * touch, and the deck at the top is trimmed by raycasting the bowl, so it meets
 * the opening exactly however the interior is shaped.
 */
function buildBody(
  s: UrinalSurface,
  p: ShellParams,
  zBack: number,
  yBot: number,
  radiusAt: (y: number, th: number) => number,
  /**
   * Plan elongation of the fitted frame. Every radius here is in the scaled plan
   * frame, so an x coordinate is `r * sin(theta) * ex` and an x direction carries
   * the reciprocal. 1 for every fixture that is not wider than it is deep.
   */
  ex: number
): { positions: Float32Array; normals: Float32Array; indices: number[]; count: number } {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const push = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number
  ): number => {
    pos.push(x, y, z);
    nrm.push(nx, ny, nz);
    return pos.length / 3 - 1;
  };
  // Pushed out a whisker: the offset surface already lies on this envelope
  // wherever it is not thinned for the rim, and coincident surfaces flicker.
  const rOf = (y: number, t: number) => radiusAt(y, t) * 1.004;
  const HALF = Math.PI / 2;
  /**
   * Real distance covered by one unit of scaled radius, in direction `t`.
   *
   * Needed wherever a thickness in metres meets a radius in scaled units -- the deck
   * width and the rowFloor tolerance are both real dimensions of the ceramic, and
   * subtracting them straight off a scaled radius would make them `ex` times too
   * generous toward the ends of an elongated body. 1 everywhere when `ex` is 1.
   */
  const radialScale = (t: number) => Math.hypot(ex * Math.sin(t), Math.cos(t));

  const stride = s.nu + 1;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let k = 0; k < stride * (s.nv + 1); k++) {
    const y = s.vertices[k * 3 + 1];
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  // -- Height of the top of the solid, per direction ------------------------
  //
  // Test, per angle: stand on the outer wall at a height and look straight down. If
  // the bowl is a long way below, the wall is out over the open mouth and ceramic
  // there would pave it over. If there is nothing below at all, or the ceramic
  // starts immediately, the wall is clear of the cavity and the casting can carry on
  // up. Marching down from the rim and taking the first height that passes gives the
  // front lip height at the front, and the rim height at the sides and back.
  //
  // Deriving this from the boundary loop instead is the obvious approach, and it is
  // wrong in a way worth recording because the loop looks like exactly the right
  // curve. The patch's u = +-1 boundary is not the rim of the opening: it is the
  // profile swept out to the full half width, so it runs from the top of the back
  // wall all the way DOWN through the sump and back up to the lip. On the default
  // bowl it reaches y = -28 mm at 21 degrees off centre. Taking the lowest loop
  // height per angle therefore pins the casting's top to the sump floor at that
  // angle and the body collapses to a point there, which renders as a large
  // triangular blade sticking out of the front of the fixture.
  const NA = BODY_A * 2;
  const angOf = (a: number) => -Math.PI / 2 + (a / NA) * Math.PI;
  const yCeil = yMax - 0.005;
  const yFloorTop = Math.min(yCeil, yMin + 0.02);
  const topY = new Float64Array(NA + 1);
  {
    const probe = v3();
    const down = v3(0, -1, 0);
    // How close a hit still counts as "the ceramic starts here". Sized to the
    // casting's own thickness: at the angles where the wall runs tangent to the
    // bowl's plan outline the ray grazes it, and whether it registers a hit at all
    // is then luck. Treating a graze as clear rather than as open mouth keeps the
    // top edge from breaking up along exactly the tangent directions, which is where
    // the silhouette is.
    const near = p.wallThickness + p.clearance;
    const dyStep = Math.max(0.004, (yCeil - yFloorTop) / 56);
    for (let a = 0; a <= NA; a++) {
      const t = angOf(a);
      const st = Math.sin(t);
      const ct = Math.cos(t);
      let top = yFloorTop;
      for (let y = yCeil; y >= yFloorTop; y -= dyStep) {
        const r = rOf(y, t);
        probe.x = r * st * ex;
        probe.y = y;
        probe.z = zBack + r * ct;
        const hit = s.raycast(probe, down, y - yBot);
        if (hit === null || hit.t < near) {
          top = y;
          break;
        }
      }
      topY[a] = Math.min(yCeil, Math.max(yFloorTop, top));
    }
    // Smoothed hard, because the transition matters more than the exact height.
    // The raw test steps from the lip height to the rim height over one or two
    // angular columns, and the strip that caps the wall then has to climb 115 mm in
    // that span -- a wide, steeply twisted ribbon standing out of the front of the
    // bowl, which is what it looked like. Spreading the climb over 20-odd degrees
    // turns the same strip into the sloping top edge a real casting has.
    const tmpT = new Float64Array(topY.length);
    for (let pass = 0; pass < 24; pass++) {
      tmpT.set(topY);
      for (let a = 1; a < NA; a++) {
        topY[a] = 0.25 * tmpT[a - 1] + 0.5 * tmpT[a] + 0.25 * tmpT[a + 1];
      }
    }

    // Floor: the casting may not stop below a top edge of the interior that lies on
    // its own outer wall.
    //
    // The v = 0 and v = 1 rows are the top of the back wall and the tip of the front
    // lip, and unlike the u = +-1 side edges they really are top edges of the
    // ceramic. Where one of them coincides with the outer wall, the casting has to
    // reach it: a millimetre short and the glaze edge stands out of the casting as a
    // thin bright fin, which is what the front lip was doing -- a curled flap
    // apparently unattached to the bowl, easily mistaken for a hole in the mesh. The
    // radius test is what makes this safe to apply: at theta = 0 the *rim* is only
    // 14 mm from the axis while the wall there is 340 mm out, so flooring to every
    // boundary point regardless of radius would drag the front of the casting up to
    // the rim height and pave the mouth over.
    const rowFloor = (j: number): void => {
      for (let i = 0; i <= s.nu; i++) {
        const k = (j * stride + i) * 3;
        const dz = s.vertices[k + 2] - zBack;
        if (dz <= 1e-6) continue;
        const y = s.vertices[k + 1];
        const sxq = s.vertices[k] / ex;
        const th = Math.atan2(sxq, dz);
        const a = Math.round(((th + Math.PI / 2) / Math.PI) * NA);
        if (a < 0 || a > NA) continue;
        const r = Math.hypot(sxq, dz);
        if (r < rOf(y, th) - (p.wallThickness + p.clearance + 0.02) / radialScale(th))
          continue;
        if (y > topY[a]) topY[a] = Math.min(yCeil, y);
      }
    };
    rowFloor(0);
    rowFloor(s.nv);
    // Re-smoothed lightly, so the floor does not put back a one-column spike.
    for (let pass = 0; pass < 3; pass++) {
      tmpT.set(topY);
      for (let a = 1; a < NA; a++) {
        topY[a] = Math.max(
          topY[a],
          0.25 * tmpT[a - 1] + 0.5 * tmpT[a] + 0.25 * tmpT[a + 1]
        );
      }
    }
  }
  const yOf = (a: number, l: number) => yBot + ((topY[a] - yBot) * l) / BODY_V;

  // -- Outer wall, as a left and a right sheet ------------------------------
  const normalAt = (y: number, t: number): [number, number, number] => {
    const dy = 0.004;
    const drdy = (rOf(y + dy, t) - rOf(Math.max(yBot, y - dy), t)) / (2 * dy);
    // Normals transform by the inverse transpose of the plan scaling, so the x
    // component is DIVIDED by `ex` where a position is multiplied by it. Getting
    // this backwards is not a subtle error -- it tilts the shading of the long
    // faces the wrong way and the body reads as if it were pinched rather than
    // stretched.
    let nx = Math.sin(t) / ex;
    let nz = Math.cos(t);
    let ny = -drdy;
    const m = Math.hypot(nx, ny, nz) || 1;
    return [nx / m, ny / m, nz / m];
  };

  {
    const rows: number[][] = [];
    for (let l = 0; l <= BODY_V; l++) {
      const row: number[] = [];
      for (let a = 0; a <= NA; a++) {
        const t = angOf(a);
        const y = yOf(a, l);
        const r = rOf(y, t);
        const n = normalAt(y, t);
        row.push(push(r * Math.sin(t) * ex, y, zBack + r * Math.cos(t), n[0], n[1], n[2]));
      }
      rows.push(row);
    }
    for (let l = 0; l < BODY_V; l++) {
      for (let a = 0; a < NA; a++) {
        const v00 = rows[l][a];
        const v01 = rows[l][a + 1];
        const v10 = rows[l + 1][a];
        const v11 = rows[l + 1][a + 1];
        idx.push(v00, v10, v01, v01, v10, v11);
      }
    }
  }

  // -- Flat back against the mounting plane --------------------------------
  const backL: number[] = [];
  const backR: number[] = [];
  for (let l = 0; l <= BODY_V; l++) {
    const yl = yOf(0, l);
    const yr = yOf(NA, l);
    backL.push(push(-Math.abs(rOf(yl, -HALF)) * ex, yl, zBack, 0, 0, -1));
    backR.push(push(Math.abs(rOf(yr, HALF)) * ex, yr, zBack, 0, 0, -1));
  }
  for (let l = 0; l < BODY_V; l++) {
    idx.push(backL[l], backR[l], backL[l + 1], backL[l + 1], backR[l], backR[l + 1]);
  }

  // -- Bottom ---------------------------------------------------------------
  const bc = push(0, yBot, zBack + rOf(yBot, 0) * 0.35, 0, -1, 0);
  const bottom: number[] = [];
  const NB = BODY_A * 2;
  for (let a = 0; a <= NB; a++) {
    const t = -HALF + (a / NB) * Math.PI;
    const r = rOf(yBot, t);
    bottom.push(push(r * Math.sin(t) * ex, yBot, zBack + r * Math.cos(t), 0, -1, 0));
  }
  for (let a = 0; a < NB; a++) idx.push(bc, bottom[a + 1], bottom[a]);
  idx.push(bc, bottom[0], push(-Math.abs(rOf(yBot, -HALF)) * ex, yBot, zBack, 0, -1, 0));
  idx.push(bc, push(Math.abs(rOf(yBot, HALF)) * ex, yBot, zBack, 0, -1, 0), bottom[NB]);

  // -- Horizontal decks: the top of the lip, and the top of the rim ---------
  // Both are found by shooting a ray inward at the bowl, so the deck stops exactly
  // where the ceramic meets the cavity however the interior is shaped. Where the
  // ray misses there is no cavity at that height, so the deck runs to the axis.
  const origin = v3();
  const dir = v3();
  /**
   * How far in from the outer wall the cavity starts, at a height and angle.
   *
   * The probe is dropped a couple of millimetres below the height being decked.
   * Both decks sit exactly on an edge of the interior patch -- the rim deck on the
   * v = 0 row, the lip deck on v = 1 -- and a ray travelling in the plane of that
   * boundary row grazes it and misses about half the time, which reports no cavity
   * at all and paves the deck straight over the opening.
   */
  const cavityRadius = (y: number, t: number, probeDrop = 0.003): number | null => {
    const rOut = rOf(y, t);
    const sx = Math.sin(t);
    const sz = Math.cos(t);
    // The ray has to travel in real space -- the interior it is querying lives
    // there -- while the radius it returns is in the scaled frame the deck is laid
    // out in. `m` is the conversion, so the direction is normalised after scaling
    // and the hit distance is divided back out of it.
    const m = radialScale(t);
    origin.x = rOut * sx * ex;
    origin.y = y - probeDrop;
    origin.z = zBack + rOut * sz;
    dir.x = (-sx * ex) / m;
    dir.y = 0;
    dir.z = -sz / m;
    const hit = s.raycast(origin, dir, rOut * m);
    return hit ? Math.max(0, rOut - hit.t / m) : null;
  };
  const quad = (a0: number, a1: number, b0: number, b1: number): void => {
    idx.push(a0, b0, a1, a1, b0, b1);
    idx.push(a0, a1, b0, a1, b1, b0);
  };

  // Top of the solid: the strip of ceramic between the outer wall and the cavity,
  // at each angle's own top height. Its inner edge is found by raycasting the bowl a
  // few millimetres BELOW that height, where the wall of the bowl still exists.
  // Probing above it looks equally reasonable and is catastrophic: above the opening
  // boundary the bowl is open, so the ray sails over the near wall and stops on the
  // far one instead, and the deck then paves the cavity into a flat shelf.
  {
    // Width limited. The raycast alone is too fragile to size this: at angles where
    // the ray passes clear of the near wall it carries on and stops on the far side
    // instead, which asks for a deck a third of a metre wide, and mixing those in
    // with the angles that do hit produced a scalloped plate lying across the
    // opening. Physically this face is the top edge of the ceramic and is about as
    // wide as the ceramic is thick, so the raycast is only allowed to make it
    // narrower, never wider.
    //
    // Sized to the rim, not to the wall. The cap is only a horizontal face where the
    // top edge is level; where the edge is climbing it is a near-vertical strip, and
    // a strip 52 mm wide climbing steeply is a flange sticking out of the fixture.
    // The rim of a real casting is a few millimetres of glaze.
    const maxDeck = p.rimThickness + p.clearance;
    const outs: number[] = [];
    const ins: number[] = [];
    for (let a = 0; a <= NA; a++) {
      const t = angOf(a);
      const y = topY[a];
      const rOut = rOf(y, t);
      const hit = cavityRadius(y, t, 0.004);
      // `maxDeck` is a real thickness of ceramic, so it converts into the scaled
      // frame before being taken off a scaled radius. Left unconverted it would be
      // up to `ex` times too generous along the length of an elongated body, which
      // is where the deck is most visible.
      const rIn = Math.max(
        0,
        Math.max(
          rOut - maxDeck / radialScale(t),
          hit === null ? 0 : Math.min(hit, rOut - 0.001)
        )
      );
      const sx = Math.sin(t);
      const sz = Math.cos(t);
      outs.push(push(rOut * sx * ex, y, zBack + rOut * sz, 0, 1, 0));
      ins.push(push(rIn * sx * ex, y, zBack + rIn * sz, 0, 1, 0));
    }
    for (let a = 0; a < NA; a++) quad(outs[a], outs[a + 1], ins[a], ins[a + 1]);
  }

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    indices: idx,
    count: pos.length / 3,
  };
}
