import { FILM_DRY_THICKNESS, GRAVITY } from '../core/constants';
import {
  FluidProperties,
  WallMaterial,
  capillaryLength,
  kinematicViscosity,
  maxStaticPuddleThickness,
} from '../core/fluid';
import { Vec3, clamp, v3 } from '../core/vec3';
import { UrinalSurface } from '../geometry/surface';
import { FilmSink } from './impact';

/**
 * The liquid that is stuck to the wall.
 *
 * This is the half of the problem that decides whether a fixture stays clean.
 * Splashback is what leaves; the film is what stays, and how long it stays sets
 * the wetted area, the residence time, and therefore the scale and the smell.
 *
 * Solved as depth-averaged shallow-water flow on the (u, v) grid of the lofted
 * surface, with the terms that matter at this scale:
 *
 *   dh/dt + div(h U)     = sources - drain
 *   d(hU)/dt + div(hUU)  = h g_t            gravity along the surface
 *                        - g_n h grad(h)    hydrostatic pressure gradient
 *                        + (sigma/rho) h grad(curvature)   capillarity
 *                        - 3 nu U / h        wall shear
 *
 * The wall shear term deserves a note, because it is what makes the film behave
 * like a film rather than like a sheet of water sliding frictionlessly. Assuming
 * the parabolic velocity profile of a thin viscous layer, the wall shear is
 * 3 mu U / h, so the deceleration is 3 nu U / h^2. At steady state on a vertical
 * wall that balances gravity and gives U = g h^2 / (3 nu) -- the Nusselt falling
 * film, exactly. So the solver reproduces the textbook drainage law without it
 * being put in by hand, and it also explains the residual film for free: since
 * speed goes as h^2, drainage slows quadratically and the last few tens of
 * microns effectively never leave. That is the film you can still see on a urinal
 * wall a minute after it was used.
 */

export interface FilmParams {
  /**
   * Thickness below which a film on a vertical wall stops creeping, m.
   * Distinct from a numerical floor: this is the measurable residual layer left
   * on glazed ceramic, tens of microns.
   */
  retentionThickness: number;
  /** Discharge coefficient of the drain opening. Lower models a restriction. */
  drainCoefficient: number;
  /** Multiplier on the capillary term. 0 disables rivulet formation. */
  capillaryStrength: number;
  /** Maximum substeps per outer step before velocities are clamped. */
  maxSubsteps: number;
  /**
   * Hard ceiling on film speed, m/s.
   *
   * A physical bound, not a numerical fudge: liquid spreading on the wall cannot
   * outrun the jet that delivered it. It matters because the momentum flux divides
   * by the donor cell's thickness, so a cell that advection has nearly emptied can
   * report an enormous velocity from a perfectly ordinary amount of momentum, and
   * that single cell then sets the stability limit for the whole grid.
   */
  maxFilmSpeed: number;
  /** Thickness above which a film on an overhang sheds a drip, in capillary lengths. */
  dripThresholdRatio: number;
  /** Enable shedding of drips from overhanging surfaces and the front lip. */
  enableShedding: boolean;
}

export function defaultFilmParams(): FilmParams {
  return {
    retentionThickness: 50e-6,
    drainCoefficient: 0.6,
    capillaryStrength: 1,
    maxSubsteps: 64,
    maxFilmSpeed: 4.0,
    dripThresholdRatio: 0.8,
    enableShedding: true,
  };
}

/** Liquid that left the fixture, tagged by where it went. */
export interface ShedEvent {
  position: Vec3;
  velocity: Vec3;
  volume: number;
  /** 0 side edge, 1 top rim, 2 front lip, 3 overhang drip. */
  boundary: number;
}

export class FilmSolver implements FilmSink {
  readonly surface: UrinalSurface;
  fluid: FluidProperties;
  wall: WallMaterial;
  params: FilmParams;

  /** Film thickness per cell, m. */
  readonly h: Float64Array;
  /** Momentum density along u, m^2/s (thickness times velocity). */
  readonly hu: Float64Array;
  /** Momentum density along v, m^2/s. */
  readonly hv: Float64Array;

  private hNew: Float64Array;
  private huNew: Float64Array;
  private hvNew: Float64Array;
  /** Curvature of the free surface plus substrate, 1/m. Scratch. */
  private curvature: Float64Array;
  /** Signed volume flux across each u-face this substep, m^3. Scratch. */
  private fluxU: Float64Array;
  /** Signed volume flux across each v-face this substep, m^3. Scratch. */
  private fluxV: Float64Array;
  /** Total volume each cell would lose this substep, m^3. Scratch. */
  private outflux: Float64Array;
  /** Per-cell scaling that keeps thickness non-negative. Scratch. */
  private limiter: Float64Array;

  /** Seconds each cell has been wet, s. Drives the scale-risk metric. */
  readonly residenceTime: Float64Array;
  /** Peak thickness each cell has reached, m. */
  readonly peakThickness: Float64Array;

  // -- Accounting, all m^3 --------------------------------------------------
  drainedVolume = 0;
  spilledSide = 0;
  spilledTop = 0;
  spilledLip = 0;
  drippedVolume = 0;
  depositedVolume = 0;
  /**
   * Liquid invented by clamping a negative thickness, m^3.
   *
   * Should stay at exactly zero. Tracked rather than assumed so that if the flux
   * limiter is ever weakened, the volume balance reports it instead of the result
   * simply being wrong by an unknown amount.
   */
  numericalGainVolume = 0;

  /** Drips produced this step, drained by the caller into the particle system. */
  readonly shed: ShedEvent[] = [];

  /** Per-boundary-cell accumulators so drips leave as droplets, not a trickle. */
  private edgeAccum: Float64Array;

  private nu: number;
  private nv: number;

  constructor(
    surface: UrinalSurface,
    fluid: FluidProperties,
    wall: WallMaterial,
    params: FilmParams
  ) {
    this.surface = surface;
    this.fluid = fluid;
    this.wall = wall;
    this.params = params;
    this.nu = surface.nu;
    this.nv = surface.nv;
    const n = this.nu * this.nv;
    this.h = new Float64Array(n);
    this.hu = new Float64Array(n);
    this.hv = new Float64Array(n);
    this.hNew = new Float64Array(n);
    this.huNew = new Float64Array(n);
    this.hvNew = new Float64Array(n);
    this.curvature = new Float64Array(n);
    this.fluxU = new Float64Array((this.nu + 1) * this.nv);
    this.fluxV = new Float64Array(this.nu * (this.nv + 1));
    this.outflux = new Float64Array(n);
    this.limiter = new Float64Array(n);
    this.residenceTime = new Float64Array(n);
    this.peakThickness = new Float64Array(n);
    this.edgeAccum = new Float64Array(n);
  }

  reset(): void {
    this.h.fill(0);
    this.hu.fill(0);
    this.hv.fill(0);
    this.residenceTime.fill(0);
    this.peakThickness.fill(0);
    this.edgeAccum.fill(0);
    this.drainedVolume = 0;
    this.spilledSide = 0;
    this.spilledTop = 0;
    this.spilledLip = 0;
    this.drippedVolume = 0;
    this.depositedVolume = 0;
    this.numericalGainVolume = 0;
    this.sanitisedCells = 0;
    this.substepBudgetExceeded = 0;
    this.shed.length = 0;
  }

  // -- FilmSink ------------------------------------------------------------

  thicknessAt(cell: number): number {
    return this.h[cell];
  }

  /**
   * Add liquid to a cell, carrying tangential momentum with it.
   *
   * The momentum matters as much as the mass. Liquid arriving from a jet is
   * moving fast along the wall, and injecting that momentum is what produces the
   * thin fast-spreading lamella around the impact point, and the ring where it
   * decelerates into a visibly thicker film. That ring is a hydraulic jump, and
   * it is not scripted anywhere -- it is what shallow-water flow does when a fast
   * thin stream runs into slower deeper liquid.
   */
  deposit(cell: number, volume: number, velU: number, velV: number): void {
    const area = this.surface.cellArea[cell];
    if (area <= 0) return;
    const dh = volume / area;
    const h0 = this.h[cell];
    const h1 = h0 + dh;
    // Momentum-weighted blend, so a small addition to a large film barely moves
    // it and a large addition dominates.
    this.hu[cell] += dh * velU;
    this.hv[cell] += dh * velV;
    this.h[cell] = h1;
    this.depositedVolume += volume;
  }

  /**
   * Deposit a jet impact as a spreading wall jet rather than as a point source.
   *
   * This is what makes an impact look like liquid hitting ceramic instead of ink
   * hitting blotting paper, and it is a physics correction rather than a cosmetic
   * one.
   *
   * `deposit` alone throws away the normal component of the arriving velocity. For
   * a near-normal impact that is nearly all of the momentum: the liquid was
   * handed to a single cell with almost no in-plane speed, so it sat there and
   * oozed downhill under gravity, spreading only by hydrostatic diffusion. That
   * is the wrong mechanism and it looks wrong -- a soaking stain with a soft edge.
   *
   * What really happens is a stagnation-point wall jet. The jet's normal momentum
   * is turned by the wall into a radially outward sheet, and because the pressure
   * returns to atmospheric just outside the stagnation region, inviscid Bernoulli
   * puts the sheet's speed at very nearly the incoming jet speed. That fast thin
   * sheet runs outward until it can no longer outrun gravity and surface tension,
   * where it thickens abruptly. On an inclined wall the resulting boundary is not
   * a circle: the sheet climbs a little way up, spreads sideways, and is swept
   * down, so the thickened rim traces out a parabola-like curve open at the
   * bottom, with the liquid draining from the open end. That is the shape you see
   * in any video of a urinal in use, and it is a documented hydraulic jump on an
   * incline (Edwards, Howison, Ockendon & Ockendon, "Hydraulic jumps on an
   * incline", J. Fluid Mech. 2008 -- a thick outer rim "resembling a parabola").
   *
   * Nothing here draws a parabola. The rim falls out of the shallow-water solver
   * once the sheet is given the right initial condition: radial momentum at jet
   * speed, spread over the real footprint instead of one cell. The footprint
   * matters too -- a 3 mm jet feeds a sheet tens of millimetres across, and
   * injecting all of it into one 3 mm cell produces a spike the advection scheme
   * then has to smear out, which is the soft edge again.
   */
  depositJet(
    cell: number,
    volume: number,
    velU: number,
    velV: number,
    spreadSpeed: number,
    footprintRadius: number
  ): void {
    const s = this.surface;
    const du = Math.max(1e-6, s.cellDu[cell]);
    const dv = Math.max(1e-6, s.cellDv[cell]);
    // Footprint in cells, bounded: one ring is enough at coarse resolution and
    // more than three would smear the impact over a region the jet never touches.
    const ru = Math.min(3, Math.max(0, Math.round(footprintRadius / du)));
    const rv = Math.min(3, Math.max(0, Math.round(footprintRadius / dv)));
    if (ru === 0 && rv === 0) {
      this.deposit(cell, volume, velU, velV);
      return;
    }

    const i0 = cell % this.nu;
    const j0 = (cell - i0) / this.nu;

    // Weight by a cosine bell over the footprint, and normalise over whatever part
    // of it is actually on the grid so the volume is exact at the edges too.
    let wSum = 0;
    for (let dj = -rv; dj <= rv; dj++) {
      const j = j0 + dj;
      if (j < 0 || j >= this.nv) continue;
      for (let di = -ru; di <= ru; di++) {
        const i = i0 + di;
        if (i < 0 || i >= this.nu) continue;
        const rn = Math.hypot(ru > 0 ? di / ru : 0, rv > 0 ? dj / rv : 0);
        if (rn > 1) continue;
        wSum += 0.5 * (1 + Math.cos(Math.PI * rn));
      }
    }
    if (wSum <= 0) {
      this.deposit(cell, volume, velU, velV);
      return;
    }

    for (let dj = -rv; dj <= rv; dj++) {
      const j = j0 + dj;
      if (j < 0 || j >= this.nv) continue;
      for (let di = -ru; di <= ru; di++) {
        const i = i0 + di;
        if (i < 0 || i >= this.nu) continue;
        const nu2 = ru > 0 ? di / ru : 0;
        const nv2 = rv > 0 ? dj / rv : 0;
        const rn = Math.hypot(nu2, nv2);
        if (rn > 1) continue;
        const w = (0.5 * (1 + Math.cos(Math.PI * rn))) / wSum;

        // Radially outward from the impact point, at the wall-jet speed, plus the
        // tangential momentum the jet already had. At the very centre there is no
        // radial direction, which is correct -- that is the stagnation point.
        let su = 0;
        let sv = 0;
        if (rn > 1e-6) {
          su = (nu2 / rn) * spreadSpeed;
          sv = (nv2 / rn) * spreadSpeed;
        }
        this.deposit(this.idx(i, j), volume * w, velU + su, velV + sv);
      }
    }
  }

  // -- Diagnostics ---------------------------------------------------------

  /** Total liquid held on the wall, m^3. */
  totalVolume(): number {
    let sum = 0;
    const a = this.surface.cellArea;
    for (let c = 0; c < this.h.length; c++) sum += this.h[c] * a[c];
    return sum;
  }

  /**
   * Liquid above what retention can hold, m^3.
   *
   * The drainable part of the film, measured cell by cell rather than by
   * subtracting a global estimate of the retained layer. It matters because this
   * is the only part of the residual a designer can do anything about, so it is
   * the honest quantity to judge drainage on -- and computing it per cell means a
   * design that leaves 2 mm standing in one spot is not excused by having a dry
   * wall everywhere else.
   */
  excessVolume(retention = this.params.retentionThickness): number {
    let sum = 0;
    const a = this.surface.cellArea;
    for (let c = 0; c < this.h.length; c++) {
      const d = this.h[c] - retention;
      if (d > 0) sum += d * a[c];
    }
    return sum;
  }

  /** Area with a film thicker than `threshold`, m^2. */
  wettedArea(threshold = FILM_DRY_THICKNESS * 4): number {
    let sum = 0;
    const a = this.surface.cellArea;
    for (let c = 0; c < this.h.length; c++) if (this.h[c] > threshold) sum += a[c];
    return sum;
  }

  /** Speed of the film at a cell, m/s. */
  speedAt(cell: number): number {
    const h = this.h[cell];
    if (h <= FILM_DRY_THICKNESS) return 0;
    return Math.hypot(this.hu[cell], this.hv[cell]) / h;
  }

  /**
   * Cells that are wet but nearly stationary: where liquid sits instead of
   * leaving. These are the spots that scale and smell, and they are the direct
   * answer to "does this design accumulate".
   */
  stagnantArea(minThickness = 20e-6, maxSpeed = 1e-3): number {
    let sum = 0;
    for (let c = 0; c < this.h.length; c++) {
      if (this.h[c] > minThickness && this.speedAt(c) < maxSpeed) {
        sum += this.surface.cellArea[c];
      }
    }
    return sum;
  }

  // -- Solver --------------------------------------------------------------

  /**
   * Largest stable step for the current state.
   *
   * Gravity waves on a thin film are slow (sqrt(g h) is 0.1 m/s at a
   * millimetre), so it is the advective speed that usually binds -- and right at
   * a jet impact the lamella can move at several metres per second, which is why
   * the limit is recomputed every step rather than fixed once.
   */
  private stableStep(): number {
    let maxRate = 1e-6;
    const s = this.surface;
    for (let c = 0; c < this.h.length; c++) {
      const h = this.h[c];
      if (h <= FILM_DRY_THICKNESS) continue;
      const u = Math.abs(this.hu[c]) / h;
      const v = Math.abs(this.hv[c]) / h;
      const gN = Math.abs(s.gravN[c]);
      const wave = Math.sqrt(gN * h);
      const rateU = (u + wave) / Math.max(1e-6, s.cellDu[c]);
      const rateV = (v + wave) / Math.max(1e-6, s.cellDv[c]);
      const r = Math.max(rateU, rateV);
      if (r > maxRate) maxRate = r;
    }
    return 0.4 / maxRate;
  }

  /** Advance the film by dt, substepping internally for stability. */
  step(dt: number): void {
    this.shed.length = 0;
    if (dt <= 0) return;

    // Enforce the physical speed ceiling before sizing substeps, so one nearly
    // empty cell cannot dictate the step for the entire grid.
    this.clampVelocities(this.params.maxFilmSpeed);

    let remaining = dt;
    let guard = 0;
    while (remaining > 1e-12 && guard++ < this.params.maxSubsteps) {
      const dtMax = this.stableStep();
      const sub = Math.min(remaining, dtMax);
      this.substep(sub);
      remaining -= sub;
    }
    if (remaining > 1e-12) {
      // Substep budget exhausted. Damping hard and taking one more stable step is
      // safe; forcing an oversized step is not, and an unstable film poisons every
      // downstream number with NaN. So the remainder is damped, advanced at a
      // stable size, and any leftover time is skipped and counted rather than
      // integrated unstably.
      this.clampVelocities(this.params.maxFilmSpeed * 0.25);
      const sub = Math.min(remaining, this.stableStep());
      this.substep(sub);
      this.substepBudgetExceeded++;
    }

    this.sanitise();

    // Residence and peak tracking, for the accumulation metrics.
    for (let c = 0; c < this.h.length; c++) {
      const h = this.h[c];
      if (h > FILM_DRY_THICKNESS * 4) this.residenceTime[c] += dt;
      if (h > this.peakThickness[c]) this.peakThickness[c] = h;
    }
  }

  substepBudgetExceeded = 0;
  /** Cells that had to be scrubbed of non-finite or negative values. */
  sanitisedCells = 0;

  /**
   * Last line of defence against a corrupted field.
   *
   * A single non-finite thickness would spread through the neighbour stencils
   * within a few steps and turn every reported volume into NaN -- and worse, it
   * would do so silently, since a NaN total still prints. Scrubbing here and
   * counting the repairs means a solver problem shows up as a diagnostic rather
   * than as a plausible-looking wrong answer.
   */
  private sanitise(): void {
    for (let c = 0; c < this.h.length; c++) {
      const h = this.h[c];
      if (!Number.isFinite(h) || h < 0) {
        this.h[c] = 0;
        this.hu[c] = 0;
        this.hv[c] = 0;
        this.sanitisedCells++;
        continue;
      }
      if (!Number.isFinite(this.hu[c]) || !Number.isFinite(this.hv[c])) {
        this.hu[c] = 0;
        this.hv[c] = 0;
        this.sanitisedCells++;
      }
    }
  }

  /** Liquid that has left the surface but not yet been released as a drip, m^3. */
  pendingEdgeVolume(): number {
    let sum = 0;
    for (let c = 0; c < this.edgeAccum.length; c++) sum += this.edgeAccum[c];
    return sum;
  }

  private clampVelocities(maxSpeed: number): void {
    for (let c = 0; c < this.h.length; c++) {
      const h = this.h[c];
      if (h <= FILM_DRY_THICKNESS) {
        this.hu[c] = 0;
        this.hv[c] = 0;
        continue;
      }
      const u = this.hu[c] / h;
      const v = this.hv[c] / h;
      const sp = Math.hypot(u, v);
      if (sp > maxSpeed) {
        const k = maxSpeed / sp;
        this.hu[c] = u * k * h;
        this.hv[c] = v * k * h;
      }
    }
  }

  private idx(i: number, j: number): number {
    return j * this.nu + i;
  }

  /**
   * Curvature driving the capillary pressure: the Laplacian of the film surface
   * plus the curvature of the wall it sits on.
   *
   * Both parts are needed. The film-surface part is what breaks a spreading sheet
   * into rivulets, which is why a draining wall ends up streaked rather than
   * uniformly damp. The substrate part is what makes liquid migrate off convex
   * ridges and collect in concave grooves, so a ribbed or fluted design cannot be
   * evaluated without it -- and grooves are one of the few genuinely effective
   * drainage features available to a designer.
   */
  private computeCurvature(): void {
    const s = this.surface;
    for (let j = 0; j < this.nv; j++) {
      for (let i = 0; i < this.nu; i++) {
        const c = this.idx(i, j);
        const iL = i > 0 ? i - 1 : 0;
        const iR = i < this.nu - 1 ? i + 1 : this.nu - 1;
        const jD = j > 0 ? j - 1 : 0;
        const jU = j < this.nv - 1 ? j + 1 : this.nv - 1;
        const du = Math.max(1e-6, s.cellDu[c]);
        const dv = Math.max(1e-6, s.cellDv[c]);
        const lap =
          (this.h[this.idx(iR, j)] - 2 * this.h[c] + this.h[this.idx(iL, j)]) / (du * du) +
          (this.h[this.idx(i, jU)] - 2 * this.h[c] + this.h[this.idx(i, jD)]) / (dv * dv);
        this.curvature[c] = lap + s.cellCurvature[c];
      }
    }
  }

  private substep(dt: number): void {
    const s = this.surface;
    const nu = this.nu;
    const nv = this.nv;
    const nuVisc = kinematicViscosity(this.fluid);
    const sigmaOverRho = this.fluid.surfaceTension / this.fluid.density;
    const lCap = capillaryLength(this.fluid);
    const hPuddleMax = maxStaticPuddleThickness(this.fluid, this.wall.contactAngleScale);
    const hRet = Math.max(1e-7, this.params.retentionThickness);

    if (this.params.capillaryStrength > 0) this.computeCurvature();

    this.hNew.set(this.h);
    this.huNew.set(this.hu);
    this.hvNew.set(this.hv);

    // ---------------------------------------------------------------------
    // 1. Conservative, positivity-preserving advection.
    //
    // Three passes rather than one. The obvious single-pass version applies each
    // face flux as it is computed, which lets a cell hand out more liquid than it
    // holds when several of its faces drain at once. The thickness goes negative,
    // and clamping that back to zero *creates* volume -- silently, and worst
    // exactly where the flow is fastest. Measured at nearly 2% of the void over a
    // run, which is far larger than the splashback figures being reported.
    //
    // So: compute every face flux first, total up what each cell is being asked
    // to give away, scale a cell's outgoing fluxes down if that exceeds what it
    // has, and only then apply them. Fluxes stay antisymmetric across each face,
    // so the scheme remains exactly conservative while never producing a negative
    // thickness. Face lengths and cell areas come from the loft, so conservation
    // holds however skewed the parameterisation gets.
    // ---------------------------------------------------------------------
    this.fluxU.fill(0);
    this.fluxV.fill(0);
    this.outflux.fill(0);

    // -- Pass A: face fluxes ------------------------------------------------
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const hasL = i > 0;
        const hasR = i < nu;
        const cL = hasL ? this.idx(i - 1, j) : -1;
        const cR = hasR ? this.idx(i, j) : -1;
        const hL = hasL ? this.h[cL] : 0;
        const hR = hasR ? this.h[cR] : 0;
        if (hL <= FILM_DRY_THICKNESS && hR <= FILM_DRY_THICKNESS) continue;

        const uL = hasL && hL > FILM_DRY_THICKNESS ? this.hu[cL] / hL : 0;
        const uR = hasR && hR > FILM_DRY_THICKNESS ? this.hu[cR] / hR : 0;
        let uFace = hasL && hasR ? 0.5 * (uL + uR) : hasL ? uL : uR;

        // Contact line: advancing into a dry cell has to overcome pinning.
        if (uFace > 0 && hasR && hR <= FILM_DRY_THICKNESS) {
          if (!this.canAdvance(cL, hL, hPuddleMax, hRet)) uFace = 0;
        } else if (uFace < 0 && hasL && hL <= FILM_DRY_THICKNESS) {
          if (!this.canAdvance(cR, hR, hPuddleMax, hRet)) uFace = 0;
        } else if (!hasL && uFace < 0) {
          // Leaving over the side edge of the patch. Pinned by the same contact
          // line that governs any other advance -- see the note on runOffEdge.
          if (!this.canAdvance(cR, hR, hPuddleMax, hRet)) uFace = 0;
        } else if (!hasR && uFace > 0) {
          if (!this.canAdvance(cL, hL, hPuddleMax, hRet)) uFace = 0;
        }
        if (uFace === 0) continue;

        const donor = uFace > 0 ? cL : cR;
        if (donor < 0) continue; // nothing flows in from outside the domain
        const faceLen = s.faceLenU[j * (nu + 1) + i];
        const flux = this.h[donor] * uFace * faceLen * dt;
        this.fluxU[j * (nu + 1) + i] = flux;
        this.outflux[donor] += Math.abs(flux);
      }
    }

    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i < nu; i++) {
        const hasD = j > 0;
        const hasU = j < nv;
        const cD = hasD ? this.idx(i, j - 1) : -1;
        const cU = hasU ? this.idx(i, j) : -1;
        const hD = hasD ? this.h[cD] : 0;
        const hU = hasU ? this.h[cU] : 0;
        if (hD <= FILM_DRY_THICKNESS && hU <= FILM_DRY_THICKNESS) continue;

        const vD = hasD && hD > FILM_DRY_THICKNESS ? this.hv[cD] / hD : 0;
        const vU = hasU && hU > FILM_DRY_THICKNESS ? this.hv[cU] / hU : 0;
        let vFace = hasD && hasU ? 0.5 * (vD + vU) : hasD ? vD : vU;

        if (vFace > 0 && hasU && hU <= FILM_DRY_THICKNESS) {
          if (!this.canAdvance(cD, hD, hPuddleMax, hRet)) vFace = 0;
        } else if (vFace < 0 && hasD && hD <= FILM_DRY_THICKNESS) {
          if (!this.canAdvance(cU, hU, hPuddleMax, hRet)) vFace = 0;
        } else if (!hasD && vFace < 0) {
          // Over the top rim, and over the front lip below. Same contact line.
          if (!this.canAdvance(cU, hU, hPuddleMax, hRet)) vFace = 0;
        } else if (!hasU && vFace > 0) {
          if (!this.canAdvance(cD, hD, hPuddleMax, hRet)) vFace = 0;
        }
        if (vFace === 0) continue;

        const donor = vFace > 0 ? cD : cU;
        if (donor < 0) continue;
        const faceLen = s.faceLenV[j * nu + i];
        const flux = this.h[donor] * vFace * faceLen * dt;
        this.fluxV[j * nu + i] = flux;
        this.outflux[donor] += Math.abs(flux);
      }
    }

    // -- Pass B: per-cell limiter -------------------------------------------
    for (let c = 0; c < this.limiter.length; c++) {
      const out = this.outflux[c];
      if (out <= 0) {
        this.limiter[c] = 1;
        continue;
      }
      const available = this.h[c] * s.cellArea[c];
      this.limiter[c] = out > available ? available / out : 1;
    }

    // -- Pass C: apply ------------------------------------------------------
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const fi = j * (nu + 1) + i;
        let flux = this.fluxU[fi];
        if (flux === 0) continue;
        const hasL = i > 0;
        const hasR = i < nu;
        const cL = hasL ? this.idx(i - 1, j) : -1;
        const cR = hasR ? this.idx(i, j) : -1;
        const donor = flux > 0 ? cL : cR;
        if (donor < 0) continue;
        flux *= this.limiter[donor];
        if (flux === 0) continue;

        const hDon = Math.max(FILM_DRY_THICKNESS, this.h[donor]);
        const momU = (this.hu[donor] / hDon) * flux;
        const momV = (this.hv[donor] / hDon) * flux;

        if (hasL) {
          this.hNew[cL] -= flux / s.cellArea[cL];
          this.huNew[cL] -= momU / s.cellArea[cL];
          this.hvNew[cL] -= momV / s.cellArea[cL];
        }
        if (hasR) {
          this.hNew[cR] += flux / s.cellArea[cR];
          this.huNew[cR] += momU / s.cellArea[cR];
          this.hvNew[cR] += momV / s.cellArea[cR];
        }
        // Leaving through a side edge means running down the outside of the
        // fixture: a real staining failure, so it is recorded rather than
        // silently discarded.
        if (!hasL || !hasR) {
          const vol = Math.abs(flux);
          this.spilledSide += vol;
          this.edgeAccum[donor] += vol;
        }
      }
    }

    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i < nu; i++) {
        const fi = j * nu + i;
        let flux = this.fluxV[fi];
        if (flux === 0) continue;
        const hasD = j > 0;
        const hasU = j < nv;
        const cD = hasD ? this.idx(i, j - 1) : -1;
        const cU = hasU ? this.idx(i, j) : -1;
        const donor = flux > 0 ? cD : cU;
        if (donor < 0) continue;
        flux *= this.limiter[donor];
        if (flux === 0) continue;

        const hDon = Math.max(FILM_DRY_THICKNESS, this.h[donor]);
        const momU = (this.hu[donor] / hDon) * flux;
        const momV = (this.hv[donor] / hDon) * flux;

        if (hasD) {
          this.hNew[cD] -= flux / s.cellArea[cD];
          this.huNew[cD] -= momU / s.cellArea[cD];
          this.hvNew[cD] -= momV / s.cellArea[cD];
        }
        if (hasU) {
          this.hNew[cU] += flux / s.cellArea[cU];
          this.huNew[cU] += momU / s.cellArea[cU];
          this.hvNew[cU] += momV / s.cellArea[cU];
        }
        if (!hasD) {
          this.spilledTop += Math.abs(flux);
          this.edgeAccum[donor] += Math.abs(flux);
        } else if (!hasU) {
          this.spilledLip += Math.abs(flux);
          this.edgeAccum[donor] += Math.abs(flux);
        }
      }
    }

    // ---------------------------------------------------------------------
    // 2. Source terms and wall shear.
    // ---------------------------------------------------------------------
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const c = this.idx(i, j);
        let h = this.hNew[c];
        if (h <= FILM_DRY_THICKNESS) {
          if (h < 0) {
            // The flux limiter should make this unreachable. If it ever happens,
            // record the liquid that clamping invents instead of absorbing it into
            // the film, so a regression shows up in the volume balance rather than
            // as a quietly inflated result.
            this.numericalGainVolume += -h * s.cellArea[c];
            h = 0;
          }
          this.hNew[c] = h;
          this.huNew[c] = 0;
          this.hvNew[c] = 0;
          continue;
        }

        const iL = i > 0 ? i - 1 : 0;
        const iR = i < nu - 1 ? i + 1 : nu - 1;
        const jD = j > 0 ? j - 1 : 0;
        const jU = j < nv - 1 ? j + 1 : nv - 1;
        const du = Math.max(1e-6, s.cellDu[c]);
        const dv = Math.max(1e-6, s.cellDv[c]);
        const spanU = Math.max(1e-6, du * (iR - iL));
        const spanV = Math.max(1e-6, dv * (jU - jD));

        // Gravity resolved along the surface.
        let au = s.gravU[c];
        let av = s.gravV[c];

        // Hydrostatic pressure gradient. g_n is the component pressing the film
        // onto the wall; where it is positive the film is on an overhang and is
        // being pulled off instead, handled separately as dripping.
        const press = Math.max(0, -s.gravN[c]);
        const dhdu = (this.hNew[this.idx(iR, j)] - this.hNew[this.idx(iL, j)]) / spanU;
        const dhdv = (this.hNew[this.idx(i, jU)] - this.hNew[this.idx(i, jD)]) / spanV;
        au -= press * dhdu;
        av -= press * dhdv;

        // Capillary pressure gradient.
        if (this.params.capillaryStrength > 0) {
          const k = sigmaOverRho * this.params.capillaryStrength;
          const dkdu = (this.curvature[this.idx(iR, j)] - this.curvature[this.idx(iL, j)]) / spanU;
          const dkdv = (this.curvature[this.idx(i, jU)] - this.curvature[this.idx(i, jD)]) / spanV;
          au += k * dkdu;
          av += k * dkdv;
        }

        let u = this.huNew[c] / h + au * dt;
        let v = this.hvNew[c] / h + av * dt;

        // Wall shear, integrated implicitly. The relaxation rate 3 nu / h^2 blows
        // up as the film thins -- at 10 microns it is 25000 per second, thousands
        // of times faster than the outer step -- so an explicit update would
        // oscillate and diverge exactly where the film is most interesting. The
        // implicit form is the exact solution of the linear decay and is stable
        // for any step.
        const relax = (3 * nuVisc) / (h * h);
        const damp = 1 / (1 + relax * dt);
        u *= damp;
        v *= damp;

        // Yield behaviour of a pinned contact line: a film thinner than the
        // retention thickness does not creep on a slope.
        if (h < hRet) {
          const slack = h / hRet;
          u *= slack * slack;
          v *= slack * slack;
        }

        this.huNew[c] = u * h;
        this.hvNew[c] = v * h;

        // -- Drain ---------------------------------------------------------
        // Orifice discharge on the local head. A designer can throttle the
        // coefficient to model a strainer or a partly blocked outlet, which is
        // one of the more common real-world causes of standing liquid.
        if (s.cellIsDrain[c]) {
          const gN = Math.max(0.05, press);
          const vOut = this.params.drainCoefficient * Math.sqrt(2 * gN * h);
          const removed = Math.min(h, vOut * dt);
          h -= removed;
          this.hNew[c] = h;
          this.drainedVolume += removed * s.cellArea[c];
          if (h <= FILM_DRY_THICKNESS) {
            this.huNew[c] = 0;
            this.hvNew[c] = 0;
          }
        }

        // -- Dripping from overhangs ---------------------------------------
        // Where the wall faces downward, gravity pulls the film off rather than
        // holding it on, and beyond a capillary-scale thickness it detaches. This
        // is why a deep hood trades splashback for drips.
        if (this.params.enableShedding && -s.gravN[c] < 0) {
          const hDrip = this.params.dripThresholdRatio * lCap;
          if (h > hDrip) {
            const excess = h - hDrip;
            this.hNew[c] = hDrip;
            const vol = excess * s.cellArea[c];
            this.drippedVolume += vol;
            this.edgeAccum[c] += vol;
          }
        }
      }
    }

    this.h.set(this.hNew);
    this.hu.set(this.huNew);
    this.hv.set(this.hvNew);

    // Convert accumulated edge outflow into discrete drips once each spot has
    // gathered a droplet's worth. A continuous trickle would never be counted as
    // landing anywhere, but a real lip sheds real drops that hit the floor.
    if (this.params.enableShedding) this.releaseDrips(lCap);
  }

  /**
   * Can the contact line advance out of this cell into a dry neighbour?
   *
   * Two limits interpolated by surface orientation. On a horizontal floor the
   * pinned rim can support a pool up to h = 2 l_c sin(theta/2), about 2.4 mm for
   * urine on glaze, and a shallower pool simply sits there -- which is exactly
   * the standing puddle a flat-bottomed trough is criticised for. On a vertical
   * wall there is no such equilibrium and the film creeps down to the residual
   * thickness. Blending on the normal gravity component covers everything
   * between, which is most of a real bowl.
   */
  /**
   * Whether liquid is thick enough to move its contact line.
   *
   * Applied at the boundary of the patch as well as between cells, and that was a
   * real omission rather than a refinement. The two interior branches only fire
   * when the neighbour exists and is dry; at the edge of the patch there is no
   * neighbour, so no pinning test ran at all and *any* film with outward velocity
   * poured over the rim however thin it was. Measured on the default bowl: 57 mL
   * of a 300 mL void ran off the side edges -- 17.8% of everything that landed --
   * and was released as 36 000 drips down the outside of the fixture. A urinal
   * does not dump a fifth of the flow over its own sides, and on screen it read as
   * a permanent waterfall fed by a trickle.
   *
   * The threshold interpolates between the capillary puddle depth where the wall
   * is horizontal and the retention thickness where it is vertical, which is the
   * right pair of limits: liquid on a level surface is held by its own contact
   * angle, and liquid on a wall is held by hysteresis against gravity.
   */
  private canAdvance(
    cell: number,
    h: number,
    hPuddleMax: number,
    hRet: number
  ): boolean {
    const gN = Math.abs(this.surface.gravN[cell]) / GRAVITY;
    const threshold = hPuddleMax * gN + hRet * (1 - gN);
    return h > threshold;
  }

  /**
   * Turn accumulated edge outflow into discrete drips.
   *
   * The direction a drip leaves in is the direction the liquid was already
   * travelling when it ran out of surface, and which edge that was decides it.
   * Sending every drip along +v -- down the profile -- was right for the front
   * lip and wrong for the other three: liquid pouring over the left side edge left
   * heading downhill into the bowl instead of outward past the rim, so it
   * re-collided with the cell it had just left and the run-off never actually got
   * outside the fixture. The side edges are also where most of it goes.
   */
  private releaseDrips(lCap: number): void {
    const dripVol = (Math.PI / 6) * Math.pow(2.2 * lCap, 3);
    const s = this.surface;
    for (let c = 0; c < this.edgeAccum.length; c++) {
      const acc = this.edgeAccum[c];
      if (acc < dripVol) continue;
      // Release at most a few drips per cell per step to bound the particle
      // count, but only debit what was actually released. Debiting the full
      // backlog while emitting a capped number would destroy liquid, and the
      // volume balance is the main check on the whole pipeline.
      const nDrips = Math.min(4, Math.floor(acc / dripVol));
      this.edgeAccum[c] -= nDrips * dripVol;
      const pos = s.getCellPos(c, v3());
      const n = s.getCellNormal(c, v3());
      const h = Math.max(FILM_DRY_THICKNESS, this.h[c]);
      const speed = clamp(Math.hypot(this.hu[c], this.hv[c]) / h, 0, 3);
      const o = c * 3;
      const i = c % this.nu;
      const j = (c - i) / this.nu;

      // Which edge this cell sits on, and therefore which way liquid left it.
      // 0 side edge, 1 top rim, 2 front lip, 3 overhang drip.
      let boundary = 3;
      let ex = 0;
      let ey = 0;
      let ez = 0;
      const tu = s.cellTangentU;
      const tv = s.cellTangentV;
      if (i === 0 || i === this.nu - 1) {
        boundary = 0;
        const sign = i === 0 ? -1 : 1;
        ex = tu[o] * sign;
        ey = tu[o + 1] * sign;
        ez = tu[o + 2] * sign;
      } else if (j === this.nv - 1) {
        boundary = 2;
        ex = tv[o];
        ey = tv[o + 1];
        ez = tv[o + 2];
      } else if (j === 0) {
        boundary = 1;
        ex = -tv[o];
        ey = -tv[o + 1];
        ez = -tv[o + 2];
      } else {
        // Not on an edge at all: this is a drip shed from an overhang, so it
        // simply falls off the wall.
        ex = -n.x;
        ey = -n.y;
        ez = -n.z;
      }
      // Leaves along the surface in the direction it was flowing, nudged clear of
      // the wall so it does not immediately re-collide with the cell it came from.
      const vel = v3(
        ex * speed - n.x * 0.02,
        ey * speed - n.y * 0.02,
        ez * speed - n.z * 0.02
      );
      for (let k = 0; k < nDrips; k++) {
        this.shed.push({
          position: v3(
            pos.x + n.x * 0.002,
            pos.y + n.y * 0.002,
            pos.z + n.z * 0.002
          ),
          velocity: vel,
          volume: dripVol,
          boundary,
        });
      }
    }
  }

  /** Fill the film uniformly, for solver validation cases. */
  setUniform(thickness: number): void {
    this.h.fill(thickness);
    this.hu.fill(0);
    this.hv.fill(0);
  }

  /** Inject a steady flux into a row of cells, for validation cases. */
  injectRow(vIndex: number, fluxPerWidth: number, dt: number): void {
    const s = this.surface;
    for (let i = 0; i < this.nu; i++) {
      const c = this.idx(i, vIndex);
      const width = s.cellDu[c];
      const vol = fluxPerWidth * width * dt;
      this.deposit(c, vol, 0, 0);
    }
  }

  /** Bounds of the film state, for the renderer's colour scale. */
  thicknessRange(): { min: number; max: number } {
    let mn = Infinity;
    let mx = 0;
    for (let c = 0; c < this.h.length; c++) {
      const v = this.h[c];
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
    return { min: Number.isFinite(mn) ? mn : 0, max: mx };
  }
}
