import {
  Profile,
  ProfileParams,
  buildProfile,
  defaultProfileParams,
  resampleByArclength,
} from './profile';
import { Vec3, v3 } from '../core/vec3';
import { Bvh } from './bvh';
import { buildRimProfile, defaultWrapOptions } from './wrap';

/**
 * The urinal as a parametric lofted surface S(u, v).
 *
 *   v in [0, 1]  runs along the sagittal profile: 0 at the top of the back
 *                wall, 1 at the tip of the front lip. Uniform in arclength.
 *   u in [-1, 1] runs across the width, 0 on the centreline.
 *
 * Why a single lofted patch rather than a triangle soup or a signed distance
 * field: the thin film that forms on the wall is the thing we most need to get
 * right, and a film solver wants a structured 2-D grid with a known metric. A
 * loft gives that for free, and it also spans every surface the liquid can
 * touch -- rim, wall, throat, sump, front rise, lip -- as one seam-free strip.
 * Liquid can therefore run from the point of impact all the way to the drain
 * without ever crossing a patch boundary, which is exactly the path a designer
 * is trying to control.
 *
 * The cost is that overhangs beyond a single-valued profile cannot be
 * represented. In practice that is not a real limitation for urinal interiors.
 */

export type RibMode = 'none' | 'vertical' | 'horizontal' | 'chevron' | 'dimple';

export interface SurfaceParams extends ProfileParams {
  /** Interior width at the rim, m. */
  widthRim: number;
  /** Interior width at the sump, m. Smaller than widthRim gives a funnel. */
  widthSump: number;
  /** Interior width at the front lip, m. */
  widthLip: number;
  /** Shaping exponent for the rim-to-sump taper. >1 delays the taper. */
  taperExponent: number;
  /**
   * How far the side edges stand forward of the centreline at the rim, m.
   *
   * This is what closes the fixture in. Set it near the bowl depth and the
   * horizontal section becomes a proper U whose open ends are at the front face,
   * so the only way out for a splash droplet is through the front opening. Set it
   * small and the fixture is a shallow dish with open sides, and splash simply
   * leaves sideways -- which is the correct behaviour for the flat-plate control
   * but wrong for anything meant to be a product.
   */
  wrapDepth: number;
  /**
   * Exponent of the horizontal section. 2 is a parabolic U; higher values keep
   * the middle of the wall flat and turn up sharply into side walls near the
   * edges, which is what most real fixtures look like in plan.
   */
  wrapExponent: number;
  /**
   * Share of the `u` columns given to the flat washout floor, per row.
   *
   * A grid quantity, not a shape one -- it moves where the cells are, not where
   * the surface is. Equal-arclength `u` spends the grid in proportion to how much
   * surface there is rather than to how much happens on it, and once the loft
   * gained side walls the floor fell to about a quarter of the row: a sump cell
   * went from 3.75 mm to 15.89 mm at the same `nu`. That is the part of the
   * fixture the drainage outputs are computed from, and it is where the film
   * pins, so it is the part that must be resolved.
   *
   * 0 restores equal arclength exactly. Values at or below the floor's own
   * arclength share are also the identity, so rows near the back rim -- which are
   * all floor and no wall -- are untouched whatever this says.
   */
  uFloorFraction: number;
  /**
   * How quickly the wrap dies away along the profile. The side walls are tallest
   * at the rim and have to vanish by the front lip, otherwise the lip would bow
   * forward at its ends instead of being a clean edge.
   */
  wrapDecay: number;
  /** Radius of the drain opening, m. */
  drainRadius: number;
  ribMode: RibMode;
  /** Peak-to-mean rib height, m. Negative values cut grooves instead. */
  ribAmplitude: number;
  /** Rib spatial period, m. */
  ribWavelength: number;
  /** Rib skew for the chevron pattern, radians. */
  ribSkew: number;
  /** Height of the rim above the bathroom floor, m. */
  rimAboveFloor: number;
}

export interface SurfaceResolution {
  /** Cells across the width. */
  nu: number;
  /** Cells along the profile. */
  nv: number;
}

/** A point located on the surface, as returned by a ray query. */
export interface SurfaceHit {
  /** Distance along the query segment, m. */
  t: number;
  /** Parametric coordinates. */
  u: number;
  v: number;
  /** Cell indices. */
  cellU: number;
  cellV: number;
  /** Flat cell index. */
  cell: number;
  point: Vec3;
  normal: Vec3;
}

export class UrinalSurface {
  readonly params: SurfaceParams;
  readonly nu: number;
  readonly nv: number;
  readonly profile: Profile;

  /** Vertex grid, (nu+1) * (nv+1), xyz interleaved. */
  readonly vertices: Float32Array;
  /** Vertex normals, same layout, for rendering. */
  readonly vertexNormals: Float32Array;
  /** Triangle indices into the vertex grid. */
  readonly indices: Uint32Array;

  // -- Per-cell quantities, length nu*nv, index = cv * nu + cu ---------------
  /** Cell centre positions, xyz interleaved. */
  readonly cellPos: Float64Array;
  /** Unit normals pointing into the bowl, xyz interleaved. */
  readonly cellNormal: Float64Array;
  /** Unit tangent along +u, xyz interleaved. */
  readonly cellTangentU: Float64Array;
  /** Unit tangent along +v, xyz interleaved. */
  readonly cellTangentV: Float64Array;
  /** Physical cell extent along u, m. */
  readonly cellDu: Float64Array;
  /** Physical cell extent along v, m. */
  readonly cellDv: Float64Array;
  /** Cell area, m^2. */
  readonly cellArea: Float64Array;
  /** Length of the face at u = i+1/2, m. Layout (nu+1) * nv. */
  readonly faceLenU: Float64Array;
  /** Length of the face at v = j+1/2, m. Layout nu * (nv+1). */
  readonly faceLenV: Float64Array;
  /** Gravity component along +u at each cell, m/s^2. */
  readonly gravU: Float64Array;
  /** Gravity component along +v at each cell, m/s^2. */
  readonly gravV: Float64Array;
  /** Gravity component along the inward normal, m/s^2. Negative presses on. */
  readonly gravN: Float64Array;
  /** Mean curvature of the substrate, 1/m. Positive where convex. */
  readonly cellCurvature: Float64Array;
  /** True where the cell is part of the drain opening. */
  readonly cellIsDrain: Uint8Array;
  /** Total drain area, m^2. */
  drainArea = 0;
  /** Total interior surface area, m^2. */
  totalArea = 0;
  /**
   * Cells whose two tangent directions are nearly parallel.
   *
   * A count above zero means the parameterisation has partly collapsed somewhere:
   * the cell area falls far below its nominal extent, the normal becomes
   * ill-conditioned, and both the film's gravity projection and the local impact
   * angle become unreliable. Surfaced as a number rather than silently tolerated,
   * because the symptom -- slightly wrong angles in a small patch -- is otherwise
   * invisible in the output.
   */
  degenerateCells = 0;
  /** Worst sine of the angle between the u and v tangents. 1 is orthogonal. */
  worstCellSkew = 1;

  /** Bathroom floor height in world y, m. */
  readonly floorY: number;
  /** World y of the front lip tip, m. */
  readonly lipY: number;
  /** World z of the front lip tip, m. */
  readonly lipZ: number;

  private bvh: Bvh;
  /** Maps triangle index -> (u, v) of its three corners, 6 floats each. */
  private triUv: Float32Array;

  constructor(params: SurfaceParams, res: SurfaceResolution) {
    this.params = params;
    this.nu = res.nu;
    this.nv = res.nv;

    // Resample the profile so v is uniform in arclength.
    const raw = buildProfile(params);
    this.profile = resampleByArclength(raw, res.nv + 1);

    this.floorY = params.rimHeight - params.rimAboveFloor;
    const lastPt = this.profile.points[this.profile.points.length - 1];
    this.lipY = lastPt.y;
    this.lipZ = lastPt.z;

    const nVert = (this.nu + 1) * (this.nv + 1);
    const nCell = this.nu * this.nv;
    this.vertices = new Float32Array(nVert * 3);
    this.vertexNormals = new Float32Array(nVert * 3);
    this.indices = new Uint32Array(this.nu * this.nv * 6);
    this.cellPos = new Float64Array(nCell * 3);
    this.cellNormal = new Float64Array(nCell * 3);
    this.cellTangentU = new Float64Array(nCell * 3);
    this.cellTangentV = new Float64Array(nCell * 3);
    this.cellDu = new Float64Array(nCell);
    this.cellDv = new Float64Array(nCell);
    this.cellArea = new Float64Array(nCell);
    this.faceLenU = new Float64Array((this.nu + 1) * this.nv);
    this.faceLenV = new Float64Array(this.nu * (this.nv + 1));
    this.gravU = new Float64Array(nCell);
    this.gravV = new Float64Array(nCell);
    this.gravN = new Float64Array(nCell);
    this.cellCurvature = new Float64Array(nCell);
    this.cellIsDrain = new Uint8Array(nCell);
    this.triUv = new Float32Array(this.nu * this.nv * 2 * 6);

    this.buildWrapProfile();
    this.buildSections();
    this.buildVertices();
    this.buildIndices();
    this.buildCellMetrics();
    this.buildVertexNormals();
    this.markDrain();
    this.bvh = new Bvh();
    this.bvh.build(this.vertices, this.indices);
  }

  // -------------------------------------------------------------------------
  // Sampling
  // -------------------------------------------------------------------------

  /**
   * Inward reference direction in the (z, y) plane at profile sample `i`:
   * the profile tangent rotated a quarter turn. Points into the bowl for the
   * entire traversal, which is what keeps the surface normals consistently
   * oriented without any per-region special casing.
   */
  private inwardRef(i: number): { z: number; y: number } {
    const pts = this.profile.points;
    const a = Math.max(0, i - 1);
    const b = Math.min(pts.length - 1, i + 1);
    const tz = pts[b].z - pts[a].z;
    const ty = pts[b].y - pts[a].y;
    const m = Math.hypot(tz, ty) || 1;
    return { z: -ty / m, y: tz / m };
  }

  /** Same, but for the segment spanning cell row `j` exactly. */
  private inwardRefSegment(j: number): { z: number; y: number } {
    const pts = this.profile.points;
    const tz = pts[j + 1].z - pts[j].z;
    const ty = pts[j + 1].y - pts[j].y;
    const m = Math.hypot(tz, ty) || 1;
    return { z: -ty / m, y: tz / m };
  }

  /** Index of the profile sample with the lowest y, i.e. the sump floor. */
  private sumpIndex(): number {
    let best = 0;
    let bestY = Infinity;
    const pts = this.profile.points;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].y < bestY) {
        bestY = pts[i].y;
        best = i;
      }
    }
    return best;
  }

  /**
   * Half width of the flat part of the interior at profile fraction v.
   *
   * Wide at the rim, narrow at the sump, wide again at the lip. The taper is
   * the funnel: concentrating the drainage cross-section raises the film
   * velocity near the outlet, which is what stops the last few millilitres
   * from lingering.
   *
   * This is the *floor* of the basin at each station, not the whole row. Beyond
   * it the row turns up into the side wall and climbs to the rim, so `widthSump`
   * now states how wide the washout floor is rather than how wide the fixture is
   * down there -- which is what it was always meant to describe, and what a
   * drainage cross-section actually is.
   */
  private halfWidthAt(v: number): number {
    const p = this.params;
    const vSump = this.sumpIndex() / this.nv;
    const wRim = p.widthRim * 0.5;
    const wSump = Math.max(0.008, p.widthSump * 0.5);
    const wLip = p.widthLip * 0.5;
    const e = Math.max(0.3, p.taperExponent);
    // Smoothstepped, so the width arrives at the sump with zero slope from both
    // sides. The previous form was continuous but not smooth there: it used
    // pow(t, 1/e) on the way up the front rise, which for any exponent above 1 has
    // an infinite derivative at the sump. The width therefore changed
    // discontinuously fast at exactly the point where the profile is horizontal,
    // the v tangent picked up an unbounded lateral component, and the cells at the
    // outer edge of the sump ended up skewed to 6 degrees with their normals
    // flipped against their neighbours -- which silently inverts gravity and the
    // impact angle in the few cells that decide drainage. The exponent still
    // controls whether the taper is delayed or early; it no longer controls
    // whether the surface is differentiable.
    const S = (x: number) => x * x * (3 - 2 * x);
    if (v <= vSump) {
      const t = vSump > 1e-6 ? Math.min(1, v / vSump) : 0;
      return wRim + (wSump - wRim) * S(Math.pow(t, e));
    }
    const t = vSump < 1 - 1e-6 ? Math.min(1, (v - vSump) / (1 - vSump)) : 0;
    return wSump + (wLip - wSump) * S(t);
  }

  /**
   * Half width of the mouth at profile fraction v, before the steepness floor.
   *
   * The plan outline of the opening: `widthRim` across the back, `widthLip`
   * across the front, and a smooth sweep between. Deliberately independent of the
   * funnel -- the bowl narrows toward its outlet, the mouth above it does not,
   * and tying the two together is what used to give the opening a waist.
   */
  private mouthHalfWidthAt(v: number): number {
    const p = this.params;
    const a = p.widthRim * 0.5;
    const b = p.widthLip * 0.5;
    const t = Math.min(1, Math.max(0, v));
    return a + (b - a) * (t * t * (3 - 2 * t));
  }

  /** Where the rim sits relative to the profile. See geometry/wrap.ts. */
  private rimWrap!: Float64Array;
  private rimLift!: Float64Array;

  private buildWrapProfile(): void {
    const p = this.params;
    const rim = buildRimProfile(this.profile, this.nv + 1, {
      ...defaultWrapOptions(),
      depth: p.wrapDepth,
      decay: p.wrapDecay,
    });
    this.rimWrap = rim.wrap;
    this.rimLift = rim.lift;
  }

  /**
   * Plan width of the side wall at profile fraction v, m.
   *
   * The row runs flat out to `halfWidthAt` and then climbs to the rim, so this is
   * the horizontal distance it has to do the climbing in. Ordinarily it is
   * whatever the mouth outline asks for. The floor underneath it is the part that
   * matters:
   *
   * just below the back rim the funnel has barely started, so the mouth and the
   * floor are still the same width and the plan span between them is nearly zero
   * -- while the profile has already dropped away, so the rim is well above it.
   * A wall with height and no plan width is a vertical fin, and a fin's cells have
   * their u tangent pointing straight up the same line the v tangent runs down.
   * That is a collapse of exactly the kind Trap 3 describes, arriving from the
   * other direction. Holding the wall no steeper than `MAX_WALL_SLOPE` costs a few
   * millimetres of width near the rim and removes the failure at the source.
   *
   * Smoothed rather than clamped, because a hard `max` puts a crease along the
   * line where the two terms cross and the curvature term in the film solver reads
   * that crease as a capillary ridge.
   */
  private wallSpanAt(v: number, j: number): number {
    const wanted = this.mouthHalfWidthAt(v) - this.halfWidthAt(v);
    const floor = Math.abs(this.rimLift[j]) / WALL_SHAPE.maxSlope;
    return smoothMax(wanted, floor, 0.004);
  }

  /**
   * Offset of every vertex from its profile station, indexed the same way as the
   * vertex grid.
   *
   * Rows are not horizontal. `sectionY` is the reason this class stopped being a
   * saddle and became a basin, and it is worth being explicit about why it had to
   * exist. The row used to be a curve in the horizontal plane through its profile
   * station -- x across, z forward, y whatever the profile said. Every point on a
   * row was therefore at the same height, so the surface at any height was the one
   * or two rows that happened to be there: a sheet across the back and a separate
   * strip across the front lip, with an open slot 85-300 mm wide down each side
   * where a side wall should be. The bowl had no sides in its front half, which
   * is what a saddle is, and the free edge of the front strip is what read on
   * screen as a bright ribbon standing inside every fixture.
   *
   * Now a row runs from its profile station out *and up* to the rim, so the
   * surface climbs in y as |u| goes to 1 and every horizontal section of the bowl
   * is a closed ring. Walking from the drain in any direction now climbs to a rim,
   * which is the definition of a basin and was not true before.
   *
   * Two properties are load-bearing and easy to lose:
   *
   *   - u advances by equal arclength along the row, measured in three dimensions
   *     now rather than in plan. That is what keeps cells near-square where the
   *     wall is steep; without it the outer cells carry the entire climb.
   *   - the row is a *plane* curve, tilted back rather than twisted, because the
   *     height and the depth share one shape function. A twisted row puts a
   *     lateral component into the v tangent and costs skew for nothing.
   */
  private sectionX!: Float64Array;
  private sectionY!: Float64Array;
  private sectionZ!: Float64Array;

  private buildSections(): void {
    const stride = this.nu + 1;
    const total = stride * (this.nv + 1);
    this.sectionX = new Float64Array(total);
    this.sectionY = new Float64Array(total);
    this.sectionZ = new Float64Array(total);

    // Resolution of the traced row. Independent of nu so the arclength measure
    // does not change when the solver grid changes. The first sample is the
    // centreline and the second the outer end of the flat floor; the rest walk
    // the quadrant that climbs to the rim.
    const CORNER = 1;
    const QUAD = 192;
    const SAMPLES = CORNER + QUAD;
    const xs = new Float64Array(SAMPLES + 1);
    const ys = new Float64Array(SAMPLES + 1);
    const zs = new Float64Array(SAMPLES + 1);
    const arc = new Float64Array(SAMPLES + 1);
    // 2 is a circular quarter arc, higher is squarer in plan. Clamped low so the
    // start and end tangents stay well defined.
    const n = Math.min(8, Math.max(1.4, this.params.wrapExponent));

    for (let j = 0; j <= this.nv; j++) {
      const v = j / this.nv;
      const hw = this.halfWidthAt(v);
      const span = this.wallSpanAt(v, j);
      const lift = this.rimLift[j];
      const wrap = this.rimWrap[j];

      // Flat floor, out to the funnel's half width at this station.
      xs[0] = 0;
      ys[0] = 0;
      zs[0] = 0;
      arc[0] = 0;
      xs[1] = hw;
      ys[1] = 0;
      zs[1] = 0;
      arc[1] = hw;
      // Then a superellipse quadrant, drawn in the plane spanned by +x and the
      // direction from the profile to the rim. Because the height and the depth
      // share one shape function, the row is a plane curve tilted back by
      // atan(lift / wrap) rather than a twisted one -- the same quadrant this
      // model has always used, stood up instead of laid flat. That is what makes
      // the side wall a genuine wall whose normal is +-x, and it costs nothing in
      // conditioning: the quadrant leaves the floor heading straight across and
      // arrives at the rim heading straight up the wall.
      for (let k = 1; k <= QUAD; k++) {
        const phi = (Math.PI / 2) * (k / QUAD);
        const xi = Math.pow(Math.max(0, Math.sin(phi)), 2 / n);
        const zeta = 1 - Math.pow(Math.max(0, Math.cos(phi)), 2 / n);
        const m = CORNER + k;
        xs[m] = hw + span * xi;
        ys[m] = lift * zeta;
        zs[m] = wrap * zeta;
        arc[m] =
          arc[m - 1] +
          Math.hypot(xs[m] - xs[m - 1], ys[m] - ys[m - 1], zs[m] - zs[m - 1]);
      }

      const len = arc[SAMPLES];
      // Columns biased onto the washout floor.
      //
      // `u` used to advance by equal arclength, which spends the grid in
      // proportion to how much *surface* there is rather than to how much
      // happens on it. Once the loft gained side walls the floor stopped being
      // the whole row and became about a quarter of it, so at the same `nu` a
      // cell at the sump went from 3.75 mm to 15.89 mm -- 4.24x coarser on the
      // one part of the fixture where liquid pools, drains and pins, and which
      // the residual-volume and clear-time outputs are computed from. The
      // standing-pool check reads the capillary depth off cells several
      // capillary lengths wide and lands pre-asymptotic; the sweep across `nu`
      // that looked like a solver failing to converge is that, and nothing else.
      //
      // Raising `resolutionU` fixes it by brute force and costs about 4x the
      // film solve on every frame, almost all of it spent resolving side walls
      // where very little happens. This puts the cells where the physics is
      // instead.
      //
      // The map is the rational bias this project already uses for the rim
      // curve: monotone, fixes both ends, and finite slope at each. A power law
      // arrives at an end with infinite slope, which is Trap 2's failure moved
      // into the parameterisation, and a piecewise-linear grading would put a
      // step in cell width exactly at the floor-to-wall corner, where the
      // geometry already has a curvature discontinuity and can least afford one.
      //
      // `b` is solved per row so the floor receives `uFloorFraction` of the
      // columns whatever fraction of the arclength it happens to be, and it is
      // clamped to 1 wherever the floor already has at least that share -- which
      // is every row near the back rim, where there is no wall yet and the map
      // is exactly the identity.
      //
      // Nothing downstream needed changing: `cellDu`, `cellArea` and both face
      // lengths are all measured off the vertices, so the metric follows the
      // spacing automatically. Volume closure stays at 0.0000%, which is the
      // check that the metric and the geometry still agree.
      const f0 = len > 1e-12 ? hw / len : 1;
      const F = Math.min(0.95, Math.max(0, this.params.uFloorFraction));
      const bias =
        f0 > 1e-6 && f0 < 1 - 1e-6 && F > f0
          ? Math.max(1, (F * (1 - f0)) / (f0 * (1 - F)))
          : 1;
      for (let i = 0; i <= this.nu; i++) {
        const u = (i / this.nu) * 2 - 1;
        const au = Math.abs(u);
        const o = j * stride + i;
        if (len <= 1e-12) {
          this.sectionX[o] = hw * u;
          this.sectionY[o] = 0;
          this.sectionZ[o] = 0;
          continue;
        }
        const su = bias === 1 ? au : au / (au + (1 - au) * bias);
        const target = su * len;
        let k = 0;
        while (k < SAMPLES - 1 && arc[k + 1] < target) k++;
        const seg = arc[k + 1] - arc[k];
        const f = seg > 1e-12 ? (target - arc[k]) / seg : 0;
        const x = xs[k] + (xs[k + 1] - xs[k]) * f;
        const y = ys[k] + (ys[k + 1] - ys[k]) * f;
        const z = zs[k] + (zs[k + 1] - zs[k]) * f;
        this.sectionX[o] = u < 0 ? -x : x;
        this.sectionY[o] = y;
        this.sectionZ[o] = z;
      }
    }
  }

  /**
   * Surface detail displaced along the base normal.
   *
   * Ribs and grooves are a real design lever and they cut both ways. Vertical
   * grooves gather the film into fast rivulets and clear the wall quickly.
   * Horizontal ribs do the opposite: each one is a small weir that pins a bead
   * of liquid, which is why heavily ribbed "decorative" urinals stain in
   * bands. Modelling the displacement geometrically rather than as a friction
   * fudge means the solver shows that difference on its own.
   */
  private displacementAt(x: number, arcLen: number): number {
    const p = this.params;
    if (p.ribMode === 'none' || Math.abs(p.ribAmplitude) < 1e-7) return 0;
    const lam = Math.max(0.004, p.ribWavelength);
    const k = (2 * Math.PI) / lam;
    switch (p.ribMode) {
      case 'vertical':
        return p.ribAmplitude * Math.cos(k * x);
      case 'horizontal':
        return p.ribAmplitude * Math.cos(k * arcLen);
      case 'chevron': {
        const skew = Math.tan(p.ribSkew);
        return p.ribAmplitude * Math.cos(k * (Math.abs(x) + arcLen * skew));
      }
      case 'dimple':
        return p.ribAmplitude * Math.cos(k * x) * Math.cos(k * arcLen);
      default:
        return 0;
    }
  }

  /** Base surface point before rib displacement, at a grid index. */
  private basePoint(i: number, j: number): Vec3 {
    const pr = this.profile.points[j];
    const o = j * (this.nu + 1) + i;
    return v3(this.sectionX[o], pr.y + this.sectionY[o], pr.z + this.sectionZ[o]);
  }

  /**
   * Approximate base normal by finite differences of the base surface.
   * Used only to orient the rib displacement; the final normals are taken
   * from the displaced geometry.
   */
  private baseNormal(i: number, vIndex: number): Vec3 {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(this.nu, i + 1);
    const j0 = Math.max(0, vIndex - 1);
    const j1 = Math.min(this.nv, vIndex + 1);
    const a = this.basePoint(i0, vIndex);
    const b = this.basePoint(i1, vIndex);
    const c = this.basePoint(i, j0);
    const d = this.basePoint(i, j1);
    const eu = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const ev = { x: d.x - c.x, y: d.y - c.y, z: d.z - c.z };
    let nx = ev.y * eu.z - ev.z * eu.y;
    let ny = ev.z * eu.x - ev.x * eu.z;
    let nz = ev.x * eu.y - ev.y * eu.x;
    const m = Math.hypot(nx, ny, nz) || 1;
    nx /= m;
    ny /= m;
    nz /= m;
    // Orient inward using the 2-D profile normal, which points into the bowl
    // over the whole traversal (see profileInwardNormal).
    const ref = this.inwardRef(vIndex);
    if (ny * ref.y + nz * ref.z < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    return v3(nx, ny, nz);
  }

  private buildVertices(): void {
    const arc = this.profile.arclength;
    for (let j = 0; j <= this.nv; j++) {
      for (let i = 0; i <= this.nu; i++) {
        const base = this.basePoint(i, j);
        const disp = this.displacementAt(base.x, arc[j]);
        let px = base.x;
        let py = base.y;
        let pz = base.z;
        if (disp !== 0) {
          const n = this.baseNormal(i, j);
          px += n.x * disp;
          py += n.y * disp;
          pz += n.z * disp;
        }
        const o = (j * (this.nu + 1) + i) * 3;
        this.vertices[o] = px;
        this.vertices[o + 1] = py;
        this.vertices[o + 2] = pz;
      }
    }
  }

  private buildIndices(): void {
    let k = 0;
    let t = 0;
    const stride = this.nu + 1;
    for (let j = 0; j < this.nv; j++) {
      for (let i = 0; i < this.nu; i++) {
        const a = j * stride + i;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        // Two triangles per cell, wound so the normal faces into the bowl.
        this.indices[k++] = a;
        this.indices[k++] = c;
        this.indices[k++] = b;
        this.indices[k++] = b;
        this.indices[k++] = c;
        this.indices[k++] = d;
        const u0 = (i / this.nu) * 2 - 1;
        const u1 = ((i + 1) / this.nu) * 2 - 1;
        const v0 = j / this.nv;
        const v1 = (j + 1) / this.nv;
        // Parametric coords of each triangle's corners, in winding order.
        const o = t * 6;
        this.triUv[o] = u0;
        this.triUv[o + 1] = v0;
        this.triUv[o + 2] = u0;
        this.triUv[o + 3] = v1;
        this.triUv[o + 4] = u1;
        this.triUv[o + 5] = v0;
        const o2 = (t + 1) * 6;
        this.triUv[o2] = u1;
        this.triUv[o2 + 1] = v0;
        this.triUv[o2 + 2] = u0;
        this.triUv[o2 + 3] = v1;
        this.triUv[o2 + 4] = u1;
        this.triUv[o2 + 5] = v1;
        t += 2;
      }
    }
  }

  private vert(i: number, j: number, out: Vec3): Vec3 {
    const o = (j * (this.nu + 1) + i) * 3;
    out.x = this.vertices[o];
    out.y = this.vertices[o + 1];
    out.z = this.vertices[o + 2];
    return out;
  }

  /**
   * Per-cell geometric quantities.
   *
   * The finite-volume film solver needs exact face lengths and cell areas, not
   * just an average spacing: mass conservation is what the reported splashback
   * and residual volumes rest on, so the metric is computed from the actual
   * displaced vertex positions rather than from the analytic base surface.
   */
  /**
   * Decide the global normal orientation once, from a single trustworthy cell.
   *
   * The (u, v) parameterisation is smooth and consistently wound over the whole
   * patch, so cross(ev, eu) already points the same way relative to the interior
   * everywhere -- up to one overall sign. Testing that sign per cell against the
   * 2-D profile normal looks safer but is actually wrong: the profile normal lies
   * in the z-y plane and has no lateral component, so on the side walls, where the
   * true surface normal is almost entirely ±x, the test is comparing two nearly
   * perpendicular vectors and its sign is decided by rounding noise. That produced
   * isolated flipped normals along the side walls near the sump, which would put
   * the wrong sign on gravity and on every impact angle in those cells.
   *
   * So the sign is fixed once, sampled mid-way down the back wall on the
   * centreline, where the profile normal and the surface normal genuinely agree.
   */
  private globalNormalSign(): number {
    const j = Math.max(1, Math.min(this.nv - 1, Math.round(this.nv * 0.15)));
    const i = Math.floor(this.nu / 2);
    const A = this.vert(i, j, v3());
    const B = this.vert(i + 1, j, v3());
    const C = this.vert(i, j + 1, v3());
    const D = this.vert(i + 1, j + 1, v3());
    const euX = 0.5 * (B.x - A.x + D.x - C.x);
    const euY = 0.5 * (B.y - A.y + D.y - C.y);
    const euZ = 0.5 * (B.z - A.z + D.z - C.z);
    const evX = 0.5 * (C.x - A.x + D.x - B.x);
    const evY = 0.5 * (C.y - A.y + D.y - B.y);
    const evZ = 0.5 * (C.z - A.z + D.z - B.z);
    const ny = evZ * euX - evX * euZ;
    const nz = evX * euY - evY * euX;
    const ref = this.inwardRefSegment(j);
    return ny * ref.y + nz * ref.z >= 0 ? 1 : -1;
  }

  private buildCellMetrics(): void {
    const A = v3();
    const B = v3();
    const C = v3();
    const D = v3();
    let total = 0;
    const sign = this.globalNormalSign();

    for (let j = 0; j < this.nv; j++) {
      for (let i = 0; i < this.nu; i++) {
        this.vert(i, j, A);
        this.vert(i + 1, j, B);
        this.vert(i, j + 1, C);
        this.vert(i + 1, j + 1, D);

        // Mean edge vectors across the cell.
        const euX = 0.5 * (B.x - A.x + D.x - C.x);
        const euY = 0.5 * (B.y - A.y + D.y - C.y);
        const euZ = 0.5 * (B.z - A.z + D.z - C.z);
        const evX = 0.5 * (C.x - A.x + D.x - B.x);
        const evY = 0.5 * (C.y - A.y + D.y - B.y);
        const evZ = 0.5 * (C.z - A.z + D.z - B.z);

        const lu = Math.hypot(euX, euY, euZ) || 1e-9;
        const lv = Math.hypot(evX, evY, evZ) || 1e-9;

        let nx = evY * euZ - evZ * euY;
        let ny = evZ * euX - evX * euZ;
        let nz = evX * euY - evY * euX;
        const nm = Math.hypot(nx, ny, nz) || 1e-12;
        nx = (nx / nm) * sign;
        ny = (ny / nm) * sign;
        nz = (nz / nm) * sign;

        // Exact area as two triangles rather than |eu x ev|. The cells are
        // skewed by up to a few percent where the width taper meets the wrap,
        // and the reported splashback volume and residual volume are integrals
        // over these areas, so a systematic few-percent area error would show
        // up directly in the numbers the designer is comparing.
        const area = triArea(A, C, B) + triArea(B, C, D);

        const c = j * this.nu + i;
        const o = c * 3;
        this.cellPos[o] = 0.25 * (A.x + B.x + C.x + D.x);
        this.cellPos[o + 1] = 0.25 * (A.y + B.y + C.y + D.y);
        this.cellPos[o + 2] = 0.25 * (A.z + B.z + C.z + D.z);
        this.cellNormal[o] = nx;
        this.cellNormal[o + 1] = ny;
        this.cellNormal[o + 2] = nz;

        // Orthonormalise the tangent pair against the normal so the film's
        // velocity components are a genuine orthonormal frame. Without this,
        // a skewed cell would leak momentum between the u and v components.
        let tuX = euX / lu;
        let tuY = euY / lu;
        let tuZ = euZ / lu;
        const dn = tuX * nx + tuY * ny + tuZ * nz;
        tuX -= dn * nx;
        tuY -= dn * ny;
        tuZ -= dn * nz;
        const tum = Math.hypot(tuX, tuY, tuZ) || 1e-9;
        tuX /= tum;
        tuY /= tum;
        tuZ /= tum;
        // tv = n x tu completes a right-handed frame; then align its sign with
        // the actual +v edge direction.
        let tvX = ny * tuZ - nz * tuY;
        let tvY = nz * tuX - nx * tuZ;
        let tvZ = nx * tuY - ny * tuX;
        if (tvX * evX + tvY * evY + tvZ * evZ < 0) {
          tvX = -tvX;
          tvY = -tvY;
          tvZ = -tvZ;
        }

        this.cellTangentU[o] = tuX;
        this.cellTangentU[o + 1] = tuY;
        this.cellTangentU[o + 2] = tuZ;
        this.cellTangentV[o] = tvX;
        this.cellTangentV[o + 1] = tvY;
        this.cellTangentV[o + 2] = tvZ;

        this.cellDu[c] = lu;
        this.cellDv[c] = lv;
        this.cellArea[c] = area;
        total += area;

        // sin of the angle between the tangents; 1 means a well-shaped cell.
        const skew = area / Math.max(1e-18, lu * lv);
        if (skew < this.worstCellSkew) this.worstCellSkew = skew;
        if (skew < 0.15) this.degenerateCells++;

        // Gravity resolved into the local frame. -9.80665 in world y.
        const g = -9.80665;
        this.gravU[c] = g * tuY;
        this.gravV[c] = g * tvY;
        this.gravN[c] = g * ny;
      }
    }
    this.totalArea = total;
    this.buildFaceLengths();
    this.buildCurvature();
  }

  private buildFaceLengths(): void {
    const A = v3();
    const B = v3();
    // u-faces: vertical edges of the grid, indexed i in [0, nu].
    for (let j = 0; j < this.nv; j++) {
      for (let i = 0; i <= this.nu; i++) {
        this.vert(i, j, A);
        this.vert(i, j + 1, B);
        this.faceLenU[j * (this.nu + 1) + i] = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
      }
    }
    // v-faces: horizontal edges, indexed j in [0, nv].
    for (let j = 0; j <= this.nv; j++) {
      for (let i = 0; i < this.nu; i++) {
        this.vert(i, j, A);
        this.vert(i + 1, j, B);
        this.faceLenV[j * this.nu + i] = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
      }
    }
  }

  /**
   * Mean curvature of the substrate from the divergence of the normal field.
   *
   * The film's capillary pressure has two parts: one from the curvature of the
   * free surface and one from the curvature of the wall underneath it. The
   * second is what makes liquid migrate off convex ridges and collect in
   * concave grooves, so a ribbed design cannot be evaluated without it.
   */
  private buildCurvature(): void {
    for (let j = 0; j < this.nv; j++) {
      for (let i = 0; i < this.nu; i++) {
        const c = j * this.nu + i;
        const iL = Math.max(0, i - 1);
        const iR = Math.min(this.nu - 1, i + 1);
        const jD = Math.max(0, j - 1);
        const jU = Math.min(this.nv - 1, j + 1);
        const cL = j * this.nu + iL;
        const cR = j * this.nu + iR;
        const cD = jD * this.nu + i;
        const cU = jU * this.nu + i;

        // d(n . tu)/du + d(n . tv)/dv, using neighbour normals projected onto
        // this cell's tangent frame.
        const tuX = this.cellTangentU[c * 3];
        const tuY = this.cellTangentU[c * 3 + 1];
        const tuZ = this.cellTangentU[c * 3 + 2];
        const tvX = this.cellTangentV[c * 3];
        const tvY = this.cellTangentV[c * 3 + 1];
        const tvZ = this.cellTangentV[c * 3 + 2];

        const projU =
          (this.cellNormal[cR * 3] - this.cellNormal[cL * 3]) * tuX +
          (this.cellNormal[cR * 3 + 1] - this.cellNormal[cL * 3 + 1]) * tuY +
          (this.cellNormal[cR * 3 + 2] - this.cellNormal[cL * 3 + 2]) * tuZ;
        const projV =
          (this.cellNormal[cU * 3] - this.cellNormal[cD * 3]) * tvX +
          (this.cellNormal[cU * 3 + 1] - this.cellNormal[cD * 3 + 1]) * tvY +
          (this.cellNormal[cU * 3 + 2] - this.cellNormal[cD * 3 + 2]) * tvZ;

        const spanU = Math.max(1e-6, this.cellDu[c] * (iR - iL));
        const spanV = Math.max(1e-6, this.cellDv[c] * (jU - jD));
        this.cellCurvature[c] = projU / spanU + projV / spanV;
      }
    }
  }

  private buildVertexNormals(): void {
    this.vertexNormals.fill(0);
    const stride = this.nu + 1;
    for (let j = 0; j < this.nv; j++) {
      for (let i = 0; i < this.nu; i++) {
        const c = j * this.nu + i;
        const nx = this.cellNormal[c * 3];
        const ny = this.cellNormal[c * 3 + 1];
        const nz = this.cellNormal[c * 3 + 2];
        const w = this.cellArea[c];
        for (const vi of [
          j * stride + i,
          j * stride + i + 1,
          (j + 1) * stride + i,
          (j + 1) * stride + i + 1,
        ]) {
          this.vertexNormals[vi * 3] += nx * w;
          this.vertexNormals[vi * 3 + 1] += ny * w;
          this.vertexNormals[vi * 3 + 2] += nz * w;
        }
      }
    }
    for (let i = 0; i < this.vertexNormals.length; i += 3) {
      const m =
        Math.hypot(
          this.vertexNormals[i],
          this.vertexNormals[i + 1],
          this.vertexNormals[i + 2]
        ) || 1;
      this.vertexNormals[i] /= m;
      this.vertexNormals[i + 1] /= m;
      this.vertexNormals[i + 2] /= m;
    }
  }

  /** Flag cells inside the drain opening and total up its area. */
  private markDrain(): void {
    const p = this.params;
    // Locate the drain centre: on the centreline, at the profile sample whose
    // depth is closest to the requested drain position, searched only over the
    // sump region so the front rise cannot be picked by accident.
    const sump = this.sumpIndex();
    const pts = this.profile.points;
    let bestJ = sump;
    let bestErr = Infinity;
    const lo = Math.max(0, sump - Math.floor(this.nv * 0.25));
    const hi = Math.min(this.nv, sump + Math.floor(this.nv * 0.25));
    for (let j = lo; j <= hi; j++) {
      const err = Math.abs(pts[j].z - p.drainZ);
      if (err < bestErr) {
        bestErr = err;
        bestJ = j;
      }
    }
    const cz = pts[bestJ].z;
    const cy = pts[bestJ].y;
    const r = Math.max(0.004, p.drainRadius);
    let area = 0;
    for (let c = 0; c < this.cellIsDrain.length; c++) {
      const dx = this.cellPos[c * 3];
      const dy = this.cellPos[c * 3 + 1] - cy;
      const dz = this.cellPos[c * 3 + 2] - cz;
      if (dx * dx + dy * dy + dz * dz <= r * r) {
        this.cellIsDrain[c] = 1;
        area += this.cellArea[c];
      }
    }
    // A drain smaller than one cell would silently vanish. Fall back to the
    // single nearest cell so the outlet always exists.
    if (area === 0) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < this.cellIsDrain.length; c++) {
        const dx = this.cellPos[c * 3];
        const dy = this.cellPos[c * 3 + 1] - cy;
        const dz = this.cellPos[c * 3 + 2] - cz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      this.cellIsDrain[best] = 1;
      area = this.cellArea[best];
    }
    this.drainArea = area;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Flat cell index from parametric coordinates. */
  cellFromUv(u: number, v: number): number {
    let cu = Math.floor(((u + 1) / 2) * this.nu);
    let cv = Math.floor(v * this.nv);
    if (cu < 0) cu = 0;
    if (cu > this.nu - 1) cu = this.nu - 1;
    if (cv < 0) cv = 0;
    if (cv > this.nv - 1) cv = this.nv - 1;
    return cv * this.nu + cu;
  }

  /**
   * Parametric coordinates of a cell centre. The inverse of `cellFromUv`.
   *
   * Needed so a point picked in the viewport can be turned back into an aim
   * target that survives a change of grid resolution or of fixture: (u, v) is
   * resolution-independent and means the same thing on every model, where a cell
   * index means nothing outside the grid that produced it.
   */
  uvOfCell(cell: number): { u: number; v: number } {
    const cu = cell % this.nu;
    const cv = (cell - cu) / this.nu;
    return {
      u: ((cu + 0.5) / this.nu) * 2 - 1,
      v: (cv + 0.5) / this.nv,
    };
  }

  getCellNormal(cell: number, out: Vec3): Vec3 {
    out.x = this.cellNormal[cell * 3];
    out.y = this.cellNormal[cell * 3 + 1];
    out.z = this.cellNormal[cell * 3 + 2];
    return out;
  }

  getCellPos(cell: number, out: Vec3): Vec3 {
    out.x = this.cellPos[cell * 3];
    out.y = this.cellPos[cell * 3 + 1];
    out.z = this.cellPos[cell * 3 + 2];
    return out;
  }

  /**
   * Closest intersection of the segment origin -> origin + dir*maxT with the
   * surface. Returns null when the segment misses.
   *
   * Droplet-wall collision is resolved as a swept segment test rather than by
   * checking whether a point ended up behind the wall. At 5 m/s with a 1 ms
   * step a droplet moves 5 mm, which is several cells and more than the
   * thickness of any feature on the wall, so a point-in-solid test would let
   * droplets tunnel straight through the geometry and out the back.
   */
  raycast(origin: Vec3, dir: Vec3, maxT: number): SurfaceHit | null {
    const hit = this.bvh.intersect(this.vertices, this.indices, origin, dir, maxT);
    if (!hit) return null;
    const o = hit.tri * 6;
    const w = 1 - hit.b1 - hit.b2;
    const u =
      w * this.triUv[o] + hit.b1 * this.triUv[o + 2] + hit.b2 * this.triUv[o + 4];
    const v =
      w * this.triUv[o + 1] + hit.b1 * this.triUv[o + 3] + hit.b2 * this.triUv[o + 5];
    const cell = this.cellFromUv(u, v);
    return {
      t: hit.t,
      u,
      v,
      cellU: cell % this.nu,
      cellV: Math.floor(cell / this.nu),
      cell,
      point: v3(origin.x + dir.x * hit.t, origin.y + dir.y * hit.t, origin.z + dir.z * hit.t),
      normal: this.getCellNormal(cell, v3()),
    };
  }

  /** World-space axis-aligned bounds of the interior surface. */
  bounds(): { min: Vec3; max: Vec3 } {
    const min = v3(Infinity, Infinity, Infinity);
    const max = v3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < this.vertices.length; i += 3) {
      const x = this.vertices[i];
      const y = this.vertices[i + 1];
      const z = this.vertices[i + 2];
      if (x < min.x) min.x = x;
      if (y < min.y) min.y = y;
      if (z < min.z) min.z = z;
      if (x > max.x) max.x = x;
      if (y > max.y) max.y = y;
      if (z > max.z) max.z = z;
    }
    return { min, max };
  }

  /**
   * Angle between an arriving stream direction and the surface at a cell,
   * measured from the surface plane. This is the quantity the 30 deg criterion
   * is stated in, so it is reported directly rather than as an angle from the
   * normal.
   */
  impingementAngle(cell: number, dir: Vec3): number {
    const nx = this.cellNormal[cell * 3];
    const ny = this.cellNormal[cell * 3 + 1];
    const nz = this.cellNormal[cell * 3 + 2];
    const m = Math.hypot(dir.x, dir.y, dir.z) || 1;
    // dir points into the wall, so the dot with the inward normal is negative.
    const cosFromNormal = -(dir.x * nx + dir.y * ny + dir.z * nz) / m;
    return Math.asin(Math.min(1, Math.max(0, cosFromNormal)));
  }
}

/**
 * Steepest the side wall is allowed to be, as rise over plan run.
 *
 * 25 is a little over 87 degrees, and it is not a styling choice -- it is a floor
 * under the wall's plan width, and it binds only in the few centimetres just below
 * the back rim and just above the lip, where the funnel has not started narrowing
 * yet but the profile has already dropped away from the rim. There the mouth and
 * the floor are still the same width, so the span between them is nearly zero
 * while the rim is already well above: a wall with height and no plan width is a
 * vertical fin, and a fin's u tangent runs up the same line its v tangent runs
 * down. Removing the floor entirely costs 22 flipped normals; 100 costs 2; the
 * band from 14 to 50 is clean and 25 is its middle.
 *
 * It must not be set low "for safety". At 2 -- 63 degrees, which sounds harmless --
 * the floor stops being a floor and becomes the binding term over the whole bowl,
 * because the lift reaches half a metre and half a metre over a slope of 2 is a
 * quarter-metre of plan span. That flares the mouth to twice its design width: the
 * oval bowl came out 736 mm wide against 422, the exterior fitter dutifully wrapped
 * a casting round it, and 69% of the stream then struck the casing. The grid was
 * spotless throughout. Grid quality alone cannot see this -- the envelope has to be
 * checked too.
 */
export const WALL_SHAPE = { maxSlope: 25 };

/**
 * Larger of two values, rounded off over a width of `k`.
 *
 * A hard max leaves a crease along the line where the two arguments cross. The
 * film solver differentiates the substrate normal to get its capillary term, so a
 * crease there is read as a ridge liquid should run off -- a shape artefact
 * turning into a physics artefact. Exact outside the blend width.
 */
function smoothMax(a: number, b: number, k: number): number {
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (a - b)) / k));
  return b + (a - b) * h + k * h * (1 - h);
}

/** Area of the triangle abc. */
function triArea(a: Vec3, b: Vec3, c: Vec3): number {
  const e1x = b.x - a.x;
  const e1y = b.y - a.y;
  const e1z = b.z - a.z;
  const e2x = c.x - a.x;
  const e2y = c.y - a.y;
  const e2z = c.z - a.z;
  return (
    0.5 *
    Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x)
  );
}

/** Default surface parameters: a conventional mid-market wall-hung urinal. */
export function defaultSurfaceParams(): SurfaceParams {
  return {
    ...defaultProfileParams(),
    widthRim: 0.34,
    widthSump: 0.12,
    widthLip: 0.32,
    taperExponent: 1.6,
    // Side edges stand almost as far forward as the lip, so the section is a
    // closed U and splash has to leave through the front opening.
    wrapDepth: 0.24,
    wrapExponent: 3.0,
    uFloorFraction: 0.5,
    wrapDecay: 1.2,
    drainRadius: 0.025,
    ribMode: 'none',
    ribAmplitude: 0.0015,
    ribWavelength: 0.03,
    ribSkew: 0.5,
    rimAboveFloor: 0.6,
  };
}
