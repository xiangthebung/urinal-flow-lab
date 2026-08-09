import { AIR_DENSITY, GRAVITY, JET_AERO_ATTENUATION } from '../core/constants';
import { besselI0, besselI1, besselK0, besselK1 } from '../core/bessel';
import { FluidProperties, kinematicViscosity } from '../core/fluid';
import { Rng } from '../core/rng';
import { Vec3, v3 } from '../core/vec3';

/**
 * The incoming stream: how much liquid arrives, how fast, and -- most
 * importantly -- whether it is still a coherent jet or has already broken into
 * droplets by the time it reaches the wall.
 *
 * That last question dominates everything downstream. A coherent jet striking a
 * wall spreads into an attached sheet and throws very little back. A train of
 * droplets striking the same wall at the same speed and angle throws a corona
 * off every single impact. So the distance to breakup, set by the
 * Rayleigh-Plateau instability, is not a detail of the stream model -- it is one
 * of the two levers that decide whether a design splashes, alongside the
 * impingement angle. It is also why standing closer genuinely helps: it moves
 * the wall inside the breakup length.
 */

export interface StreamParams {
  // -- Anatomy and posture -------------------------------------------------
  /** Effective hydraulic diameter of the exit at peak flow, m. */
  exitDiameter: number;
  /** Height of the exit above the bathroom floor, m. */
  emitterHeight: number;
  /** Horizontal gap from the fixture's front-most point to the user, m. */
  standoff: number;
  /** Side-to-side offset of the user from the fixture centreline, m. */
  lateralOffset: number;
  /** Aim elevation, radians. Negative points downward. */
  aimElevation: number;
  /** Aim azimuth, radians. Positive points toward +x. */
  aimAzimuth: number;

  // -- The void ------------------------------------------------------------
  /** Total volume voided, m^3. */
  voidVolume: number;
  /** Peak volumetric flow rate, m^3/s. */
  peakFlowRate: number;
  /** Rise exponent of the flow curve. Smaller rises faster. */
  riseShape: number;
  /** Fall exponent of the flow curve. Larger decays more slowly. */
  fallShape: number;
  /**
   * How much the exit cross-section opens with flow rate, dimensionless.
   * 0 means a rigid orifice, where exit speed is exactly proportional to flow
   * rate. 1 means a fully compliant one, where the area grows in step with the
   * flow and the speed never changes. The urethra is in between, so the stream
   * does slow down at the start and end of a void but far less than a rigid
   * nozzle would suggest.
   */
  urethralCompliance: number;

  // -- Aim stability -------------------------------------------------------
  /** Peak angular wander of the aim, radians. */
  tremorAmplitude: number;
  /** Characteristic frequency of that wander, Hz. */
  tremorFrequency: number;

  // -- Model calibration ---------------------------------------------------
  /**
   * Initial surface disturbance as a fraction of the jet radius.
   *
   * This is the one empirically calibrated number in the breakup model, and it
   * matters because breakup length depends on it only logarithmically -- which
   * cuts both ways: the result is insensitive to getting it slightly wrong, but
   * it cannot be derived from first principles either. A quiet, precisely round
   * laboratory nozzle sits near 1e-3 and produces a jet that stays coherent for
   * a metre. The human meatus is a compliant, non-circular slit fed by a
   * pulsatile bladder, so its disturbance is orders of magnitude larger. The
   * default of 0.05 puts breakup at roughly 20 cm for a 3 mm, 3 m/s stream,
   * which is where the high-speed footage from the urethra-replica experiments
   * puts it.
   */
  disturbanceRatio: number;
  /** Fraction of each wavelength's volume that ends up in satellite drops. */
  satelliteFraction: number;
  /** Geometric standard deviation of the droplet size distribution. */
  dropletSizeSpread: number;
}

export function defaultStreamParams(): StreamParams {
  return {
    exitDiameter: 0.003,
    emitterHeight: 0.78,
    standoff: 0.12,
    lateralOffset: 0,
    aimElevation: -0.55,
    aimAzimuth: 0,
    voidVolume: 300e-6,
    peakFlowRate: 22e-6,
    // Peak at ~24% of the way through, which puts time-to-peak near 6.8 s and
    // Qmax/Qave near 2.0 -- both inside the clinical uroflowmetry range.
    riseShape: 0.9,
    fallShape: 2.9,
    urethralCompliance: 0.35,
    tremorAmplitude: 0.012,
    tremorFrequency: 1.1,
    disturbanceRatio: 0.05,
    satelliteFraction: 0.06,
    dropletSizeSpread: 1.18,
  };
}

// ---------------------------------------------------------------------------
// Gamma function, needed to normalise the flow curve
// ---------------------------------------------------------------------------

const LANCZOS_G = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Lanczos approximation, accurate to ~15 digits for the range used here. */
export function gamma(z: number): number {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  const zz = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS_G.length; i++) x += LANCZOS_G[i] / (zz + i + 1);
  const t = zz + LANCZOS_G.length - 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, zz + 0.5) * Math.exp(-t) * x;
}

const betaFn = (a: number, b: number): number =>
  (gamma(a) * gamma(b)) / gamma(a + b);

// ---------------------------------------------------------------------------
// Uroflowmetry curve
// ---------------------------------------------------------------------------

/**
 * Shape and timing of the flow curve.
 *
 * Urine flow is not a step function, and treating it as one would misrepresent
 * the problem: the stream is slow at the start and end of a void, which means it
 * falls more steeply, lands lower and nearer, and is still coherent when it
 * arrives. A design that only works at peak flow will fail during those seconds.
 *
 * The curve used is a Beta-function pulse, Q ~ tau^p (1-tau)^q, which is
 * compactly supported -- exactly zero at both ends, no arbitrary truncation --
 * and reproduces the fast rise and slow decay of a clinical uroflowmetry trace
 * with two parameters. Peak flow lands at tau = p / (p + q).
 */
export class FlowCurve {
  readonly duration: number;
  readonly peakFraction: number;
  private readonly p: number;
  private readonly q: number;
  private readonly norm: number;
  private readonly peakShape: number;
  readonly peakFlowRate: number;
  readonly voidVolume: number;

  constructor(params: StreamParams) {
    this.p = Math.max(0.15, params.riseShape);
    this.q = Math.max(0.15, params.fallShape);
    this.peakFraction = this.p / (this.p + this.q);
    this.norm = betaFn(this.p + 1, this.q + 1);
    this.peakShape =
      Math.pow(this.peakFraction, this.p) * Math.pow(1 - this.peakFraction, this.q);
    this.peakFlowRate = Math.max(1e-9, params.peakFlowRate);
    this.voidVolume = Math.max(1e-9, params.voidVolume);
    // Q(t) = (V / T) * shape(t/T) / norm, and Qmax pins T.
    this.duration = (this.voidVolume * this.peakShape) / (this.peakFlowRate * this.norm);
  }

  /** Volumetric flow rate at time t, m^3/s. Zero outside the void. */
  rateAt(t: number): number {
    if (t <= 0 || t >= this.duration) return 0;
    const tau = t / this.duration;
    const shape = Math.pow(tau, this.p) * Math.pow(1 - tau, this.q);
    return (this.voidVolume / this.duration) * (shape / this.norm);
  }

  /** Mean flow rate over the void, m^3/s. */
  get meanFlowRate(): number {
    return this.voidVolume / this.duration;
  }

  /** Cumulative volume passed by time t, m^3. Trapezoidal, adequate here. */
  volumeBy(t: number, steps = 400): number {
    const tt = Math.min(t, this.duration);
    if (tt <= 0) return 0;
    const dt = tt / steps;
    let sum = 0;
    for (let i = 0; i < steps; i++) {
      sum += 0.5 * (this.rateAt(i * dt) + this.rateAt((i + 1) * dt)) * dt;
    }
    return sum;
  }
}

// ---------------------------------------------------------------------------
// Rayleigh-Plateau breakup
// ---------------------------------------------------------------------------

export interface BreakupSolution {
  /** Dimensionless wavenumber of the fastest-growing mode, x = k*r. */
  wavenumber: number;
  /** Wavelength of that mode, m. */
  wavelength: number;
  /** Its growth rate, 1/s. */
  growthRate: number;
  /** Time from exit to pinch-off, s. */
  breakupTime: number;
  /** Distance from exit to pinch-off, m. */
  breakupLength: number;
  /** Diameter of the main droplets, m. */
  mainDropletDiameter: number;
  /** Diameter of the satellite droplets, m. 0 if disabled. */
  satelliteDiameter: number;
  /** Rate at which whole wavelengths leave the exit, Hz. */
  emissionFrequency: number;
}

/**
 * Growth rate of an axisymmetric disturbance of dimensionless wavenumber x = k r
 * on a viscous liquid cylinder of radius r moving at `jetSpeed` through still air.
 *
 * Three effects, and the third one used to be missing:
 *
 *   omega = sqrt(D^2 + omega_inv^2) - D,      D = 3 nu x^2 / (2 r^2)
 *
 *   omega_inv^2 = (sigma x / (rho_l r^3)) * (I1(x)/I0(x)) * [ (1 - x^2)
 *                 + C * (We_gas / 2) * x * K0(x)/K1(x) ]
 *
 * **Capillarity**, the `1 - x^2`: only disturbances longer than the circumference
 * reduce surface area, which is the whole content of the Plateau argument.
 *
 * **Liquid inertia**, the `I1(x)/I0(x)`. This is Rayleigh's exact result, not its
 * small-argument limit x/2. The limit is cheap and costs 1.4%: it moves the most
 * unstable wavenumber from 0.697 to 1/sqrt(2) = 0.7071 and correspondingly
 * mis-sizes every droplet the stream makes. With real Bessel functions available
 * for the gas term there is no reason to keep the approximation on the liquid one.
 *
 * **Air**, the `We_gas` term, and this is the part that was absent. The relation
 * without it says breakup length rises linearly with jet speed and never stops:
 * at 20 m/s through a 3 mm orifice it claimed a coherent jet 1.35 m long, which
 * is not a small extrapolation error but the wrong regime entirely. Real jets
 * rise, reach a maximum, and then break up *sooner* as they go faster -- the
 * falling branch is the defining characteristic of the first wind-induced regime
 * (Grant & Middleman 1966), and including gas inertia is what reproduces it
 * (Weber 1931). The term also moves the fastest-growing mode to shorter waves, so
 * a fast jet makes smaller drops, which is both observed and consequential here:
 * the Mundo splash group goes as d^0.75.
 *
 * The gas factor is derived rather than fitted. Matching the perturbation
 * pressure of an inviscid outer stream on a cylinder gives K0(x)/K1(x) as the
 * geometric factor -- it tends to zero for long waves, which do not feel the air
 * at all, and to one for short waves, which feel it fully. `C` is Sterling &
 * Sleicher's 0.175; see `JET_AERO_ATTENUATION`.
 *
 * Returns a signed rate. Outside the unstable band the value is negative, which
 * the mode search needs in order to find the band edge; the old form returned a
 * flat zero for every x >= 1 and so could not represent a band that air had
 * widened past the Plateau limit.
 */
export function jetGrowthRate(
  fluid: FluidProperties,
  radius: number,
  jetSpeed: number,
  x: number,
  ambientDensity = AIR_DENSITY
): number {
  if (x <= 0) return 0;
  const nu = kinematicViscosity(fluid);
  const r2 = radius * radius;
  const r3 = r2 * radius;

  let drive = 1 - x * x;
  if (ambientDensity > 0 && jetSpeed > 0) {
    // We_gas on the jet *diameter*, the convention the regime diagram uses.
    const weGas =
      (ambientDensity * jetSpeed * jetSpeed * 2 * radius) / fluid.surfaceTension;
    drive +=
      JET_AERO_ATTENUATION * 0.5 * weGas * x * (besselK0(x) / besselK1(x));
  }

  const inertial =
    ((fluid.surfaceTension * x * (besselI1(x) / besselI0(x))) / (fluid.density * r3)) *
    drive;
  const damping = (3 * nu * x * x) / (2 * r2);
  return Math.sqrt(Math.max(0, damping * damping + inertial)) - damping;
}

/**
 * Solve for the fastest-growing mode and the resulting breakup geometry.
 *
 * The maximum is found by a coarse scan plus golden-section refinement rather
 * than by using the textbook x = 0.697. That constant is the inviscid, still-air
 * answer; solving the actual dispersion relation keeps the model correct if a
 * designer switches to a more viscous fluid or drives the jet hard enough for the
 * air to matter, and costs microseconds.
 *
 * `ambientDensity` defaults to air. Passing 0 recovers the pure capillary
 * (Rayleigh/Weber) limit, which is how the validation suite checks the classical
 * results without having to allow for an aerodynamic shift in its tolerances.
 */
export function solveBreakup(
  fluid: FluidProperties,
  jetDiameter: number,
  jetSpeed: number,
  disturbanceRatio: number,
  satelliteFraction: number,
  ambientDensity = AIR_DENSITY
): BreakupSolution {
  const r = Math.max(1e-5, jetDiameter * 0.5);

  // Air widens the unstable band past the Plateau limit x = 1, so the search
  // cannot stop there. The band edge sits a little above C * We_gas / 2; scanning
  // to 1 + C * We_gas covers it with room to spare, and collapses to a search over
  // (0, 1.5] in still air.
  const weGas =
    ambientDensity > 0 && jetSpeed > 0
      ? (ambientDensity * jetSpeed * jetSpeed * 2 * r) / fluid.surfaceTension
      : 0;
  const xHi = Math.max(1.5, 1 + JET_AERO_ATTENUATION * weGas);
  const rate = (xx: number) => jetGrowthRate(fluid, r, jetSpeed, xx, ambientDensity);

  // Coarse scan for a bracket.
  let bestX = 0.697;
  let bestW = -Infinity;
  const N = 400;
  for (let i = 1; i <= N; i++) {
    const x = (i / N) * xHi;
    const w = rate(x);
    if (w > bestW) {
      bestW = w;
      bestX = x;
    }
  }
  // Golden-section refinement in the neighbouring interval.
  const gr = 0.6180339887;
  const step = xHi / N;
  let lo = Math.max(1e-4, bestX - step);
  let hi = Math.min(xHi, bestX + step);
  let c = hi - gr * (hi - lo);
  let d = lo + gr * (hi - lo);
  for (let i = 0; i < 60; i++) {
    if (rate(c) > rate(d)) hi = d;
    else lo = c;
    c = hi - gr * (hi - lo);
    d = lo + gr * (hi - lo);
  }
  const x = 0.5 * (lo + hi);
  const omega = Math.max(1e-9, rate(x));
  const wavelength = (2 * Math.PI * r) / x;

  // Linear growth from eps0 to pinch-off at eps ~ r.
  const ratio = Math.max(1e-6, Math.min(0.9, disturbanceRatio));
  const breakupTime = Math.log(1 / ratio) / omega;
  const breakupLength = breakupTime * Math.max(1e-6, jetSpeed);

  // One wavelength of cylinder becomes one main drop plus its satellites.
  const cylinderVolume = Math.PI * r * r * wavelength;
  const phi = Math.max(0, Math.min(0.4, satelliteFraction));
  const mainVolume = cylinderVolume * (1 - phi);
  const satVolume = cylinderVolume * phi;
  const dFromV = (V: number) => Math.cbrt((6 * V) / Math.PI);

  return {
    wavenumber: x,
    wavelength,
    growthRate: omega,
    breakupTime,
    breakupLength,
    mainDropletDiameter: dFromV(mainVolume),
    satelliteDiameter: phi > 1e-4 ? dFromV(satVolume) : 0,
    emissionFrequency: Math.max(1e-6, jetSpeed) / wavelength,
  };
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/** One parcel of liquid leaving the exit. */
export interface EmittedParcel {
  position: Vec3;
  velocity: Vec3;
  /** Volume this parcel carries, m^3. */
  volume: number;
  /**
   * Diameter used for the aerodynamic and impact physics, m. While the parcel
   * is still part of the coherent jet this is the jet diameter; after breakup it
   * is the droplet diameter.
   */
  diameter: number;
  /** Jet diameter at the moment of emission, m. */
  jetDiameter: number;
  /** Time from now until this parcel pinches off into droplets, s. */
  timeToBreakup: number;
  /** Droplet diameter this parcel will adopt at breakup, m. */
  breakupDiameter: number;
  /**
   * Volume that leaves as a satellite drop at pinch-off, m^3.
   *
   * A wavelength of jet does not become one sphere. The ligament between two
   * forming drops pinches at both ends and the thread collapses into a smaller
   * satellite, and this is the parcel's share of it.
   */
  satelliteVolume: number;
}

/**
 * Turns stream parameters into a sequence of parcels.
 *
 * Parcels are emitted at the Rayleigh frequency, one per wavelength of jet, so
 * each parcel is exactly the liquid that becomes one droplet. That choice keeps
 * the droplet count physical without any reweighting: a parcel is a droplet, not
 * a statistical stand-in for a fractional number of them.
 */
export class StreamEmitter {
  params: StreamParams;
  fluid: FluidProperties;
  readonly flow: FlowCurve;
  private rng: Rng;

  /** Emitter position in world space, m. Set by attachTo(). */
  position: Vec3 = v3();

  private emitAccumulator = 0;
  private tremorEl = 0;
  private tremorAz = 0;
  private cached: BreakupSolution | null = null;
  private cachedSpeed = -1;
  private cachedDiameter = -1;

  /** Running totals, for mass conservation checks. */
  emittedVolume = 0;
  emittedParcels = 0;

  constructor(params: StreamParams, fluid: FluidProperties, rng: Rng) {
    this.params = params;
    this.fluid = fluid;
    this.rng = rng;
    this.flow = new FlowCurve(params);
  }

  /**
   * Place the emitter relative to a fixture whose front-most point is at
   * `frontZ` and whose floor is at `floorY`, both in world coordinates.
   */
  attachTo(frontZ: number, floorY: number): void {
    this.position = v3(
      this.params.lateralOffset,
      floorY + this.params.emitterHeight,
      frontZ + this.params.standoff
    );
  }

  /** Effective exit area at a given flow rate, m^2. */
  exitAreaAt(rate: number): number {
    const aMax = (Math.PI * this.params.exitDiameter ** 2) / 4;
    if (rate <= 0) return aMax;
    const frac = Math.min(1, rate / this.flow.peakFlowRate);
    const beta = Math.min(1, Math.max(0, this.params.urethralCompliance));
    // Area grows as (Q/Qmax)^beta, so speed goes as Q^(1-beta).
    return aMax * Math.max(0.05, Math.pow(frac, beta));
  }

  /** Exit speed at time t, m/s. */
  speedAt(t: number): number {
    const q = this.flow.rateAt(t);
    if (q <= 0) return 0;
    return q / this.exitAreaAt(q);
  }

  /** Effective exit diameter at time t, m. */
  diameterAt(t: number): number {
    const q = this.flow.rateAt(t);
    return Math.sqrt((4 * this.exitAreaAt(q)) / Math.PI);
  }

  /** Breakup solution for the current instant, cached across steps. */
  breakupAt(t: number): BreakupSolution {
    const speed = this.speedAt(t);
    const dia = this.diameterAt(t);
    if (
      this.cached &&
      Math.abs(speed - this.cachedSpeed) < 1e-4 &&
      Math.abs(dia - this.cachedDiameter) < 1e-6
    ) {
      return this.cached;
    }
    this.cached = solveBreakup(
      this.fluid,
      dia,
      speed,
      this.params.disturbanceRatio,
      this.params.satelliteFraction
    );
    this.cachedSpeed = speed;
    this.cachedDiameter = dia;
    return this.cached;
  }

  /** Nominal aim direction, ignoring tremor. */
  aimDirection(): Vec3 {
    const el = this.params.aimElevation;
    const az = this.params.aimAzimuth;
    const ce = Math.cos(el);
    return v3(ce * Math.sin(az), Math.sin(el), -ce * Math.cos(az));
  }

  /**
   * Advance the aim wander and emit whatever parcels are due this step.
   *
   * Tremor is generated as a first-order filtered random walk rather than white
   * noise, because real aim drifts on a timescale of about a second instead of
   * jittering independently every millisecond. White noise would average out
   * across the void and understate how much the impact point actually moves,
   * and the spread of that impact point is what a robust design has to tolerate.
   */
  step(t: number, dt: number, emit: (p: EmittedParcel) => void): void {
    const rate = this.flow.rateAt(t);
    if (rate <= 0) return;

    const speed = this.speedAt(t);
    const dia = this.diameterAt(t);
    const breakup = this.breakupAt(t);

    // Filtered tremor: relax toward a fresh random target with time constant
    // 1 / (2 pi f), driven by white noise scaled to keep the variance steady.
    const tau = 1 / (2 * Math.PI * Math.max(0.05, this.params.tremorFrequency));
    const alpha = Math.min(1, dt / tau);
    const amp = this.params.tremorAmplitude;
    if (amp > 0) {
      // Drive scaled as sqrt(2*alpha) makes the stationary standard deviation
      // exactly 1, so tremorAmplitude reads directly as the 1-sigma wander in
      // radians instead of being an arbitrary gain.
      const drive = Math.sqrt(Math.max(1e-12, 2 * alpha));
      this.tremorEl += -alpha * this.tremorEl + drive * this.rng.normal(0, 1);
      this.tremorAz += -alpha * this.tremorAz + drive * this.rng.normal(0, 1);
    }

    const el = this.params.aimElevation + amp * this.tremorEl;
    const az = this.params.aimAzimuth + amp * this.tremorAz;
    const ce = Math.cos(el);
    const dir = v3(ce * Math.sin(az), Math.sin(el), -ce * Math.cos(az));

    // How many wavelengths left the exit during this step.
    this.emitAccumulator += breakup.emissionFrequency * dt;
    const perWavelength = 1 / Math.max(1e-9, breakup.emissionFrequency);
    let guard = 0;
    while (this.emitAccumulator >= 1 && guard++ < 512) {
      this.emitAccumulator -= 1;
      // Spread emissions across the step so parcels do not stack on one point.
      //
      // The remaining accumulator counts the wavelengths still queued behind this
      // one, so it is exactly how long ago this parcel left the exit. Using the
      // *fractional* part instead gave every parcel in a step the same age -- the
      // fractional part does not change when you subtract one -- so five parcels
      // in a millisecond were emitted from a single point with identical
      // velocities and travelled as one lump. The comment claimed otherwise.
      const back = Math.min(dt, this.emitAccumulator * perWavelength);
      const pos = v3(
        this.position.x + dir.x * speed * back,
        // Gravity over the flight so far. Sub-millimetre at these times, but it
        // costs nothing and keeps the parcel on the trajectory it would have
        // been on had the step been finer.
        this.position.y + dir.y * speed * back - 0.5 * GRAVITY * back * back,
        this.position.z + dir.z * speed * back
      );
      const volume = (Math.PI * dia * dia * 0.25) * breakup.wavelength;
      // Droplet size is drawn per parcel: atomisation is not monodisperse, and
      // the spread matters because small drops are the ones air drag carries
      // back toward the user.
      const dDrop = this.rng.logNormal(
        breakup.mainDropletDiameter,
        this.params.dropletSizeSpread
      );
      // The satellite's share of this wavelength, carried so that the parcel can
      // actually split at pinch-off. `solveBreakup` has always computed the split
      // and the validation suite has always checked that it conserves volume, but
      // nothing downstream ever acted on it: every parcel stayed whole and adopted
      // the *main* drop's diameter while keeping the *whole* wavelength's volume,
      // so `satelliteFraction` did nothing but mis-size the drop by (1-phi)^(1/3)
      // and not one particle in a run ever carried `PFlag.Satellite` -- a flag the
      // droplet renderer has a distinct style for.
      const satVolume =
        breakup.satelliteDiameter > 0
          ? volume * Math.max(0, Math.min(0.4, this.params.satelliteFraction))
          : 0;
      emit({
        position: pos,
        velocity: v3(dir.x * speed, dir.y * speed, dir.z * speed),
        volume,
        diameter: dia,
        jetDiameter: dia,
        timeToBreakup: breakup.breakupTime,
        breakupDiameter: dDrop,
        satelliteVolume: satVolume,
      });
      this.emittedVolume += volume;
      this.emittedParcels++;
    }
  }

  /**
   * Aim angles that put the stream on a given point, at the exit speed for time
   * `t`. Returns null when the point is out of ballistic range.
   *
   * Needed because aiming by angle is the wrong interface for this problem. A
   * designer thinks "the stream lands here", and the whole splash question turns
   * on exactly where that is -- a few centimetres up or down the wall changes the
   * local impingement angle by tens of degrees. Solving for the angle that hits a
   * chosen point makes the aim reproducible between designs of different depths,
   * which is what makes an A/B comparison mean anything.
   */
  solveAimForTarget(
    target: Vec3,
    t: number,
    gravity = GRAVITY
  ): { elevation: number; azimuth: number } | null {
    const speed = this.speedAt(t);
    if (speed <= 1e-6) return null;
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const dy = target.y - this.position.y;
    const R = Math.hypot(dx, dz);
    if (R < 1e-6) return null;
    const v2 = speed * speed;
    const disc = v2 * v2 - gravity * (gravity * R * R + 2 * dy * v2);
    if (disc < 0) return null;
    // Minus root: the flatter trajectory, which is how a person actually aims.
    const elevation = Math.atan((v2 - Math.sqrt(disc)) / (gravity * R));
    // Matches the direction convention in aimDirection().
    const azimuth = Math.atan2(dx, -dz);
    return { elevation, azimuth };
  }

  /** Point the stream at a target, using the exit speed at peak flow. */
  aimAt(target: Vec3, gravity = GRAVITY): boolean {
    const tPeak = this.flow.peakFraction * this.flow.duration;
    const sol = this.solveAimForTarget(target, tPeak, gravity);
    if (!sol) return false;
    this.params.aimElevation = sol.elevation;
    this.params.aimAzimuth = sol.azimuth;
    return true;
  }

  /**
   * Where the stream lands if it flies ballistically with no obstruction, and
   * how far it travels getting there. Used by the UI to show the aim point and
   * by the geometry generator to place its pole.
   */
  ballisticPath(t: number, gravity: number, steps = 200, maxTime = 1.5): Vec3[] {
    const speed = this.speedAt(t);
    const dir = this.aimDirection();
    const out: Vec3[] = [];
    const dt = maxTime / steps;
    for (let i = 0; i <= steps; i++) {
      const tt = i * dt;
      out.push(
        v3(
          this.position.x + dir.x * speed * tt,
          this.position.y + dir.y * speed * tt - 0.5 * gravity * tt * tt,
          this.position.z + dir.z * speed * tt
        )
      );
    }
    return out;
  }
}
