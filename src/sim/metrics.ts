import { CRITICAL_IMPINGEMENT_ANGLE, FILM_DRY_THICKNESS } from '../core/constants';
import { Vec3, clamp, radToDeg, v3 } from '../core/vec3';
import { SolidCollider } from '../geometry/collider';
import { UrinalSurface } from '../geometry/surface';
import { CaptureZone, ZONE_NAMES } from './capture';
import { FilmSolver } from './film';

/**
 * Turning the simulation into numbers a designer can act on.
 *
 * Two families of question, kept strictly separate because they have different
 * remedies. Splashback is about what leaves the fixture and where it lands.
 * Drainage is about what stays behind, how long, and over how much area. A design
 * can be excellent at one and terrible at the other -- a deep funnel clears
 * beautifully and splashes as much as a flat plate -- so collapsing them into a
 * single number too early hides the trade-off that matters most.
 *
 * One distinction is worth calling out. Liquid that lands on the user divides
 * into two completely different failures: droplets thrown back off the wall, and
 * the primary stream simply missing the fixture. Both wet the trousers, both are
 * bad, but the first is fixed by geometry and the second by aim or by a taller
 * fixture. They are tracked separately by tagging every particle with the number
 * of impacts in its history: generation 0 never touched the wall.
 */

export interface ZoneTally {
  /** Volume landing in this zone, m^3. */
  volume: number;
  /** Number of droplets. */
  count: number;
  /** Of that volume, how much came from splash rather than a direct miss. */
  splashVolume: number;
  /** Volume that never touched the fixture at all. */
  directVolume: number;
}

const emptyTally = (): ZoneTally => ({
  volume: 0,
  count: 0,
  splashVolume: 0,
  directVolume: 0,
});

/**
 * How strong the stream was when liquid arrived.
 *
 * Splitting the result this way turned out to be necessary rather than
 * decorative. A void is not one experiment: the stream rises, holds near peak for
 * most of the volume, then decays to a dribble. A fast stream reaches the back
 * wall at the angle the wall was designed for; a decaying one on the same aim
 * falls short, and on a deep fixture "short" means the front rim of the fixture
 * itself, which throws liquid straight back at the user.
 *
 * Aggregating the two hides the mechanism completely, and the aggregate can even
 * inverse-rank two designs depending on stand-off. Reporting them separately is
 * what lets a designer see that a deep bowl buys a better wall and pays for it in
 * the tail.
 */
export const enum FlowPhase {
  /** Flow at or above half of peak. Most of the volume. */
  Sustained = 0,
  /** The rise and the decay, where the stream is slow and falls short. */
  Weak = 1,
  Count = 2,
}

export const FLOW_PHASE_NAMES = ['sustained flow', 'weak flow (rise & tail)'];

export interface PhaseTally {
  /** Volume voided during this phase, m^3. */
  emitted: number;
  /** Volume landing on the user during this phase, m^3. */
  userVolume: number;
  /** Droplets landing on the user during this phase. */
  userDroplets: number;
  /** Volume striking the outside of the fixture during this phase, m^3. */
  exteriorVolume: number;
}

const emptyPhase = (): PhaseTally => ({
  emitted: 0,
  userVolume: 0,
  userDroplets: 0,
  exteriorVolume: 0,
});

export interface TimeSample {
  t: number;
  /** Flow rate leaving the emitter, m^3/s. */
  flowRate: number;
  /** Liquid held on the wall, m^3. */
  filmVolume: number;
  /** Liquid in the air, m^3. */
  airborneVolume: number;
  /** Cumulative volume landing on the user, m^3. */
  userVolume: number;
  /** Cumulative volume through the drain, m^3. */
  drainedVolume: number;
  /** Wetted area, m^2. */
  wettedArea: number;
  /** Live particle count. */
  particles: number;
}

/** A 2-D deposition histogram, for the floor and body heat maps. */
export class Heatmap {
  readonly nx: number;
  readonly ny: number;
  readonly x0: number;
  readonly y0: number;
  readonly dx: number;
  readonly dy: number;
  readonly volume: Float64Array;
  readonly count: Uint32Array;

  constructor(x0: number, x1: number, y0: number, y1: number, nx: number, ny: number) {
    this.nx = nx;
    this.ny = ny;
    this.x0 = x0;
    this.y0 = y0;
    this.dx = (x1 - x0) / nx;
    this.dy = (y1 - y0) / ny;
    this.volume = new Float64Array(nx * ny);
    this.count = new Uint32Array(nx * ny);
  }

  add(x: number, y: number, volume: number): void {
    const i = Math.floor((x - this.x0) / this.dx);
    const j = Math.floor((y - this.y0) / this.dy);
    if (i < 0 || i >= this.nx || j < 0 || j >= this.ny) return;
    const k = j * this.nx + i;
    this.volume[k] += volume;
    this.count[k]++;
  }

  reset(): void {
    this.volume.fill(0);
    this.count.fill(0);
  }

  max(): number {
    let m = 0;
    for (let i = 0; i < this.volume.length; i++) if (this.volume[i] > m) m = this.volume[i];
    return m;
  }
}

export interface SplashbackReport {
  /** Volume on the user (shoes, shins, trousers), m^3. */
  userVolume: number;
  /** Of that, thrown back off the wall. */
  userSplashVolume: number;
  /** Of that, the stream missing the fixture outright. */
  userDirectVolume: number;
  /** Volume on the floor near the fixture, m^3. */
  floorNearVolume: number;
  /** Microlitres landing on the user per litre voided. The headline number. */
  userMicrolitresPerLitre: number;
  /** Droplet count on the user. */
  userDroplets: number;
  /** Fraction of all impacted volume that was ejected rather than deposited. */
  splashFraction: number;
  /** Number of impacts that exceeded the splash threshold. */
  splashEvents: number;
  /** Total wall impacts. */
  impactEvents: number;
  /** Volume that escaped the fixture entirely, m^3. */
  escapedVolume: number;
  perZone: ZoneTally[];
  /** Splashback split by stream strength. See FlowPhase. */
  perPhase: PhaseTally[];
  /**
   * Microlitres on the user per litre voided, counting only the sustained-flow
   * part of the void.
   *
   * This is the figure that isolates the wall: during sustained flow the stream
   * reaches the surface the design governs, so the number reflects the shape.
   * The all-in figure additionally contains the tail, where the stream falls
   * short onto the fixture's own rim, and that is dominated by how deep the
   * fixture is rather than by the wall's angle.
   */
  sustainedMicrolitresPerLitre: number;
  /** The same, for the weak rise and decay. */
  weakMicrolitresPerLitre: number;
}

export interface DrainageReport {
  /** Liquid still on the wall when the run ended, m^3. */
  residualVolume: number;
  /** Peak liquid held during the run, m^3. */
  peakFilmVolume: number;
  /**
   * The film that cannot drain: retention thickness over the wetted area, m^3.
   *
   * Worth separating out, because it is the difference between a fair drainage
   * metric and a meaningless one. Drainage speed goes as the cube of thickness, so
   * the last few tens of microns effectively never leave -- asking when a wall
   * reaches 95% drained gives "never" for every design ever built, including good
   * ones. What a designer can actually control is the liquid above that floor.
   */
  retainedFloorVolume: number;
  /** Residual above the unavoidable retained film, m^3. This is the avoidable part. */
  excessVolume: number;
  /** Time after flow stopped for the bulk to clear to twice the retained floor, s. -1 if never. */
  bulkClearTime: number;
  /** Time after flow stopped to come within 20% of the retained floor, s. -1 if never. */
  nearDryTime: number;
  /** Wetted area at the end, m^2. */
  finalWettedArea: number;
  /** Peak wetted area, m^2. */
  peakWettedArea: number;
  /** Area wet but effectively still at the end, m^2. */
  stagnantArea: number;
  /** Deepest standing film anywhere, m. */
  maxStandingDepth: number;
  /** Longest any one spot stayed wet, s. */
  maxResidenceTime: number;
  /** Area whose residence time exceeded the scale-risk threshold, m^2. */
  scaleRiskArea: number;
  /** Volume through the drain, m^3. */
  drainedVolume: number;
  /** Volume that ran off the sides or dripped off the lip, m^3. */
  spilledVolume: number;
}

export interface ImpingementReport {
  /** Per-cell predicted angle, radians. NaN where the stream cannot reach. */
  angle: Float64Array;
  /** True where a straight path from the emitter is blocked by the fixture. */
  shadowed: Uint8Array;
  /** Fraction of reachable area steeper than the 30 deg criterion. */
  fractionOverCritical: number;
  /** Area-weighted mean angle over reachable cells, radians. */
  meanAngle: number;
  /** Steepest angle on any reachable cell, radians. */
  maxAngle: number;
  /** Reachable area, m^2. */
  reachableArea: number;
}

export interface ImpactMapReport {
  /** Volume that actually struck each cell, m^3. */
  volume: Float64Array;
  /** Volume-weighted mean impingement angle per cell, radians. */
  angle: Float64Array;
  /** Volume ejected from each cell, m^3. */
  splashed: Float64Array;
}

export class Metrics {
  readonly surface: UrinalSurface;
  perZone: ZoneTally[] = [];
  samples: TimeSample[] = [];
  /** Splashback split by how strong the stream was. See FlowPhase. */
  perPhase: PhaseTally[] = [];
  /**
   * Which phase the stream is in right now, set by the simulation each step.
   *
   * Captures are attributed by the moment they land rather than the moment they
   * were emitted. Splash transit is a few tens of milliseconds against a void of
   * fifteen-odd seconds, so the two agree except at the phase boundary, and
   * tagging every particle with its birth phase would cost a byte per particle to
   * move that boundary by one frame.
   */
  currentPhase: FlowPhase = FlowPhase.Weak;

  /** Deposition on the floor, plan view. */
  floorMap: Heatmap;
  /** Deposition on the user's front, elevation view. */
  bodyMap: Heatmap;

  /** Per-cell record of what actually hit the wall. */
  impactVolume: Float64Array;
  impactAngleSum: Float64Array;
  impactSplashed: Float64Array;
  /**
   * The same, restricted to droplets straight from the stream.
   *
   * Kept separately because the combined figure does not answer the question it
   * appears to. "Where the stream landed" was reported over every impact of every
   * generation, and secondary droplets re-impacting are not a small correction:
   * measured on the default bowl, 117 mL of primary arrivals at 46 deg against
   * 84 mL of secondary arrivals at 59 deg. Nearly half the weight of a statistic
   * about the stream came from liquid that had already bounced, which both dilutes
   * the aim signal and drags the angle upward.
   */
  primaryVolume: Float64Array;
  primaryAngleSum: Float64Array;

  /** Volume that left the domain without being captured, m^3. */
  escapedVolume = 0;
  /** Volume voided so far, m^3. */
  emittedVolume = 0;

  peakFilmVolume = 0;
  peakWettedArea = 0;
  /** Peak drainable film volume, m^3. The baseline the drain time is measured against. */
  peakExcessVolume = 0;
  /** Time flow stopped, s. -1 while still flowing. */
  flowEndTime = -1;
  private drainMark95 = -1;
  private drainMark99 = -1;

  constructor(surface: UrinalSurface, floorY: number, frontZ: number) {
    this.surface = surface;
    const b = surface.bounds();
    this.floorMap = new Heatmap(
      b.min.x - 0.5,
      b.max.x + 0.5,
      b.min.z - 0.2,
      frontZ + 0.9,
      72,
      72
    );
    this.bodyMap = new Heatmap(-0.3, 0.3, floorY, floorY + 1.0, 48, 80);
    const n = surface.nu * surface.nv;
    this.impactVolume = new Float64Array(n);
    this.impactAngleSum = new Float64Array(n);
    this.impactSplashed = new Float64Array(n);
    this.primaryVolume = new Float64Array(n);
    this.primaryAngleSum = new Float64Array(n);
    this.reset();
  }

  reset(): void {
    this.perZone = [];
    for (let i = 0; i < CaptureZone.Count; i++) this.perZone.push(emptyTally());
    this.perPhase = [];
    for (let i = 0; i < FlowPhase.Count; i++) this.perPhase.push(emptyPhase());
    this.currentPhase = FlowPhase.Weak;
    this.samples = [];
    this.floorMap.reset();
    this.bodyMap.reset();
    this.impactVolume.fill(0);
    this.impactAngleSum.fill(0);
    this.impactSplashed.fill(0);
    this.primaryVolume.fill(0);
    this.primaryAngleSum.fill(0);
    this.escapedVolume = 0;
    this.emittedVolume = 0;
    this.peakFilmVolume = 0;
    this.peakWettedArea = 0;
    this.peakExcessVolume = 0;
    this.flowEndTime = -1;
    this.drainMark95 = -1;
    this.drainMark99 = -1;
  }

  recordCapture(
    zone: number,
    position: Vec3,
    volume: number,
    generation: number
  ): void {
    const z = this.perZone[zone];
    if (!z) return;
    z.volume += volume;
    z.count++;
    if (generation > 0) z.splashVolume += volume;
    else z.directVolume += volume;

    const ph = this.perPhase[this.currentPhase];
    if (ph) {
      if (
        zone === CaptureZone.Shoe ||
        zone === CaptureZone.Shin ||
        zone === CaptureZone.Thigh
      ) {
        ph.userVolume += volume;
        ph.userDroplets++;
      } else if (zone === CaptureZone.FixtureExterior) {
        ph.exteriorVolume += volume;
      }
    }

    if (
      zone === CaptureZone.FloorNear ||
      zone === CaptureZone.FloorFar ||
      zone === CaptureZone.Shoe
    ) {
      this.floorMap.add(position.x, position.z, volume);
    }
    if (zone === CaptureZone.Shin || zone === CaptureZone.Thigh) {
      this.bodyMap.add(position.x, position.y, volume);
    }
  }

  recordImpact(
    cell: number,
    volume: number,
    angle: number,
    splashed: number,
    generation = 0
  ): void {
    this.impactVolume[cell] += volume;
    this.impactAngleSum[cell] += angle * volume;
    this.impactSplashed[cell] += splashed;
    if (generation === 0) {
      this.primaryVolume[cell] += volume;
      this.primaryAngleSum[cell] += angle * volume;
    }
  }

  sample(s: TimeSample, film: FilmSolver): void {
    this.samples.push(s);
    if (s.filmVolume > this.peakFilmVolume) this.peakFilmVolume = s.filmVolume;
    if (s.wettedArea > this.peakWettedArea) this.peakWettedArea = s.wettedArea;
    const excess = film.excessVolume();
    if (excess > this.peakExcessVolume) this.peakExcessVolume = excess;
    if (this.flowEndTime >= 0 && this.peakExcessVolume > 1e-12) {
      const frac = excess / this.peakExcessVolume;
      if (this.drainMark95 < 0 && frac <= 0.1) this.drainMark95 = s.t - this.flowEndTime;
      if (this.drainMark99 < 0 && frac <= 0.02) this.drainMark99 = s.t - this.flowEndTime;
    }
  }

  /** Volume of the film that retention pins in place and drainage cannot remove. */
  retainedFloor(film: FilmSolver): number {
    return Math.max(0, film.totalVolume() - film.excessVolume());
  }

  // -----------------------------------------------------------------------

  splashback(
    impactedVolume: number,
    splashedVolume: number,
    splashEvents: number,
    impactEvents: number
  ): SplashbackReport {
    const shoe = this.perZone[CaptureZone.Shoe];
    const shin = this.perZone[CaptureZone.Shin];
    const thigh = this.perZone[CaptureZone.Thigh];
    const userVolume = shoe.volume + shin.volume + thigh.volume;
    const userSplash = shoe.splashVolume + shin.splashVolume + thigh.splashVolume;
    const userDirect = shoe.directVolume + shin.directVolume + thigh.directVolume;
    const litres = Math.max(1e-12, this.emittedVolume) * 1000;
    const perL = (p: PhaseTally): number =>
      p.emitted > 1e-12 ? (p.userVolume * 1e9) / (p.emitted * 1000) : 0;
    return {
      userVolume,
      userSplashVolume: userSplash,
      userDirectVolume: userDirect,
      floorNearVolume: this.perZone[CaptureZone.FloorNear].volume,
      perPhase: this.perPhase,
      sustainedMicrolitresPerLitre: perL(this.perPhase[FlowPhase.Sustained]),
      weakMicrolitresPerLitre: perL(this.perPhase[FlowPhase.Weak]),
      // Microlitres per litre voided: normalises out how much was voided so two
      // runs with different volumes can be compared directly.
      userMicrolitresPerLitre: (userVolume * 1e9) / litres,
      userDroplets: shoe.count + shin.count + thigh.count,
      splashFraction: impactedVolume > 0 ? splashedVolume / impactedVolume : 0,
      splashEvents,
      impactEvents,
      escapedVolume: this.escapedVolume,
      perZone: this.perZone,
    };
  }

  drainage(film: FilmSolver, scaleRiskSeconds = 20): DrainageReport {
    let maxDepth = 0;
    let maxResidence = 0;
    let scaleArea = 0;
    for (let c = 0; c < film.h.length; c++) {
      if (film.h[c] > maxDepth) maxDepth = film.h[c];
      const r = film.residenceTime[c];
      if (r > maxResidence) maxResidence = r;
      if (r > scaleRiskSeconds) scaleArea += this.surface.cellArea[c];
    }
    const residual = film.totalVolume();
    const excess = film.excessVolume();
    return {
      residualVolume: residual,
      peakFilmVolume: this.peakFilmVolume,
      retainedFloorVolume: Math.max(0, residual - excess),
      excessVolume: excess,
      bulkClearTime: this.drainMark95,
      nearDryTime: this.drainMark99,
      finalWettedArea: film.wettedArea(),
      peakWettedArea: this.peakWettedArea,
      stagnantArea: film.stagnantArea(),
      maxStandingDepth: maxDepth,
      maxResidenceTime: maxResidence,
      scaleRiskArea: scaleArea,
      drainedVolume: film.drainedVolume,
      spilledVolume:
        film.spilledSide + film.spilledTop + film.spilledLip + film.drippedVolume,
    };
  }

  /**
   * What the stream actually did, as opposed to what the design map predicted.
   *
   * The surface-wide impingement map answers "if the stream landed here, how
   * steep would it be". This answers "how steep was it where the stream really
   * landed, weighted by how much liquid arrived there". The two can disagree
   * sharply, and when they do the map is the misleading one: a design can hold a
   * shallow angle over 90% of its area and still splash badly if the stream
   * happens to land on the remaining 10%. This is the number that explains the
   * splash figure.
   */
  actualImpingement(): {
    meanAngle: number;
    p90Angle: number;
    impactedVolume: number;
    /** Fraction of arriving volume that landed steeper than the criterion. */
    fractionOverCritical: number;
    /** Profile fraction v where most of the splashed volume originated. */
    splashCentroidV: number;
    /** Share of splashed volume from the worst 10% of impacted cells. */
    hotspotShare: number;
    /** Volume arriving straight from the stream, m^3. */
    primaryVolume: number;
    /** Volume-weighted mean angle of stream arrivals only, radians. */
    primaryMeanAngle: number;
    /** Fraction of stream arrivals steeper than the criterion. */
    primaryFractionOverCritical: number;
    /** Volume arriving as re-impacting splash, m^3. */
    secondaryVolume: number;
  } {
    let volSum = 0;
    let angVolSum = 0;
    let overVol = 0;
    let splashSum = 0;
    let splashVSum = 0;
    let pVolSum = 0;
    let pAngVolSum = 0;
    let pOverVol = 0;
    const nu = this.surface.nu;
    const nv = this.surface.nv;
    const pairs: Array<{ a: number; v: number }> = [];

    for (let c = 0; c < this.impactVolume.length; c++) {
      const pv = this.primaryVolume[c];
      if (pv > 0) {
        const pAng = this.primaryAngleSum[c] / pv;
        pVolSum += pv;
        pAngVolSum += this.primaryAngleSum[c];
        if (pAng > CRITICAL_IMPINGEMENT_ANGLE) pOverVol += pv;
      }
      const vol = this.impactVolume[c];
      if (vol <= 0) continue;
      const ang = this.impactAngleSum[c] / vol;
      volSum += vol;
      angVolSum += this.impactAngleSum[c];
      if (ang > CRITICAL_IMPINGEMENT_ANGLE) overVol += vol;
      pairs.push({ a: ang, v: vol });
      const sp = this.impactSplashed[c];
      if (sp > 0) {
        splashSum += sp;
        splashVSum += sp * (Math.floor(c / nu) / nv);
      }
    }

    // Volume-weighted 90th percentile impingement angle.
    pairs.sort((x, y) => x.a - y.a);
    let acc = 0;
    let p90 = 0;
    for (const p of pairs) {
      acc += p.v;
      if (acc >= 0.9 * volSum) {
        p90 = p.a;
        break;
      }
    }

    // Concentration of splash: share coming from the worst tenth of cells.
    const splashed = Array.from(this.impactSplashed).filter((x) => x > 0).sort((a, b) => b - a);
    const topN = Math.max(1, Math.floor(splashed.length * 0.1));
    let top = 0;
    for (let i = 0; i < topN; i++) top += splashed[i];

    return {
      meanAngle: volSum > 0 ? angVolSum / volSum : 0,
      p90Angle: p90,
      impactedVolume: volSum,
      fractionOverCritical: volSum > 0 ? overVol / volSum : 0,
      splashCentroidV: splashSum > 0 ? splashVSum / splashSum : 0,
      hotspotShare: splashSum > 0 ? top / splashSum : 0,
      primaryVolume: pVolSum,
      primaryMeanAngle: pVolSum > 0 ? pAngVolSum / pVolSum : 0,
      primaryFractionOverCritical: pVolSum > 0 ? pOverVol / pVolSum : 0,
      secondaryVolume: Math.max(0, volSum - pVolSum),
    };
  }

  /** Volume-weighted mean impingement angle per cell, for the impact map. */
  impactMap(): ImpactMapReport {
    const angle = new Float64Array(this.impactVolume.length);
    for (let c = 0; c < angle.length; c++) {
      angle[c] =
        this.impactVolume[c] > 0 ? this.impactAngleSum[c] / this.impactVolume[c] : Number.NaN;
    }
    return { volume: this.impactVolume, angle, splashed: this.impactSplashed };
  }
}

// ---------------------------------------------------------------------------
// Predictive impingement map
// ---------------------------------------------------------------------------

/**
 * Arrival direction of a ballistic stream at an arbitrary 3-D point.
 *
 * The trajectory stays in the vertical plane containing the launch direction, so
 * the two-dimensional solution applies once the horizontal distance is collapsed
 * to a single coordinate; the result is then expanded back onto the horizontal
 * bearing from emitter to target.
 */
export function ballisticArrival3D(
  origin: Vec3,
  speed: number,
  target: Vec3,
  gravity: number
): Vec3 | null {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const horiz = Math.hypot(dx, dz);
  const dy = target.y - origin.y;
  if (horiz < 1e-6) return dy < 0 ? v3(0, -1, 0) : null;
  const v2 = speed * speed;
  const disc = v2 * v2 - gravity * (gravity * horiz * horiz + 2 * dy * v2);
  if (disc < 0) return null;
  const theta = Math.atan((v2 - Math.sqrt(disc)) / (gravity * horiz));
  const cos = Math.cos(theta);
  if (Math.abs(cos) < 1e-9) return null;
  const t = horiz / (speed * cos);
  const vHoriz = speed * cos;
  const vy = speed * Math.sin(theta) - gravity * t;
  const ux = dx / horiz;
  const uz = dz / horiz;
  const m = Math.hypot(vHoriz, vy) || 1;
  return v3((ux * vHoriz) / m, vy / m, (uz * vHoriz) / m);
}

/**
 * The design map: for every point on the fixture, the angle at which the stream
 * would strike it.
 *
 * This is the most directly useful output the tool produces, because it needs no
 * simulation at all -- it is pure geometry plus a ballistic trajectory -- yet it
 * predicts where a design will splash. Anywhere the map exceeds the ~30 degree
 * criterion is a surface that will throw a corona if the stream lands there, and
 * the reported area fraction over that threshold is the single number that best
 * separates a good shape from a bad one.
 *
 * Two details make it honest rather than decorative. Cells the stream cannot
 * reach in a straight line are marked shadowed and excluded, so a design is not
 * flattered by counting surfaces that are tucked behind the lip. And the arrival
 * direction is the ballistic one, not a straight ray: over the half-metre from
 * exit to wall, gravity bends the stream by several degrees, and against a 30
 * degree budget that is not a rounding error.
 */
export function computeImpingementMap(
  surface: UrinalSurface,
  emitter: Vec3,
  speed: number,
  gravity: number,
  criticalAngle = CRITICAL_IMPINGEMENT_ANGLE,
  /**
   * The solid casting, so cells it hides are excluded.
   *
   * Optional only so the map can still be computed before a casting exists.
   * Passing it matters: the line-of-sight test used to consider the wetted
   * interior alone, and the casting is thicker than the interior all round with a
   * rim that stands proud of it. Measured over the fixture library, the casting
   * hides 19-44% of interior cells from the exit point -- the deck under the rim,
   * the back of the lip, the outer reaches of the side walls. Every one of those
   * was being counted as reachable surface, so both the mean angle and the
   * fraction over the criterion were averages taken partly over ceramic the
   * stream cannot touch.
   */
  exterior?: SolidCollider | null
): ImpingementReport {
  const n = surface.nu * surface.nv;
  const angle = new Float64Array(n);
  const shadowed = new Uint8Array(n);
  let overArea = 0;
  let reachable = 0;
  let angleAreaSum = 0;
  let maxAngle = 0;

  const p = v3();
  for (let c = 0; c < n; c++) {
    surface.getCellPos(c, p);
    const dir = ballisticArrival3D(emitter, speed, p, gravity);
    if (!dir) {
      angle[c] = Number.NaN;
      shadowed[c] = 1;
      continue;
    }
    // Line of sight: march back from just off the surface toward the emitter and
    // see whether the fixture gets in the way.
    const nrm = surface.getCellNormal(c, v3());
    const start = v3(p.x + nrm.x * 1e-3, p.y + nrm.y * 1e-3, p.z + nrm.z * 1e-3);
    const back = v3(-dir.x, -dir.y, -dir.z);
    const reach = Math.hypot(emitter.x - p.x, emitter.y - p.y, emitter.z - p.z);
    const blocker = surface.raycast(start, back, reach * 0.98);
    if (blocker) {
      angle[c] = Number.NaN;
      shadowed[c] = 1;
      continue;
    }
    if (exterior) {
      // `back` is a unit direction, so the limit is a real distance here.
      const solid = exterior.raycastSolid(start, back, reach * 0.98);
      if (solid) {
        angle[c] = Number.NaN;
        shadowed[c] = 1;
        continue;
      }
    }

    const a = surface.impingementAngle(c, dir);
    angle[c] = a;
    const area = surface.cellArea[c];
    reachable += area;
    angleAreaSum += a * area;
    if (a > criticalAngle) overArea += area;
    if (a > maxAngle) maxAngle = a;
  }

  return {
    angle,
    shadowed,
    fractionOverCritical: reachable > 0 ? overArea / reachable : 0,
    meanAngle: reachable > 0 ? angleAreaSum / reachable : 0,
    maxAngle,
    reachableArea: reachable,
  };
}

// ---------------------------------------------------------------------------
// Composite score
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  splashScore: number;
  drainageScore: number;
  hygieneScore: number;
  angleScore: number;
  total: number;
  notes: string[];
}

/**
 * A single 0-100 figure, with its parts shown.
 *
 * Deliberately transparent rather than clever. The sub-scores are reported
 * alongside the total and the reference values are stated, because a composite
 * score's job here is to make two candidate designs comparable at a glance, not
 * to be the final word. A designer with a hard splashback requirement and no
 * drainage requirement should be able to see the splash sub-score and ignore the
 * rest.
 *
 * Reference points are chosen from the control geometries: a flat wall lands near
 * the bottom of each scale and a well-executed conventional bowl near the middle,
 * so a score above about 75 means the design is doing something the standard
 * fixtures do not.
 */
export function scoreDesign(
  splash: SplashbackReport,
  drain: DrainageReport,
  imp: ImpingementReport,
  voidedVolume: number
): ScoreBreakdown {
  const notes: string[] = [];

  // Splash: microlitres on the user per litre voided. 2000 uL/L is dire,
  // 20 uL/L is excellent. Log scale, because the range spans three decades.
  const upl = Math.max(0.5, splash.userMicrolitresPerLitre);
  const splashScore = clamp(100 * (1 - (Math.log10(upl) - 1.3) / 2.0), 0, 100);
  if (upl > 500) notes.push('splashback onto the user is high');

  // Drainage: judged on the liquid that could have left but did not, plus how
  // long the bulk took to clear. Measuring against the avoidable excess rather
  // than total residual is what keeps this from scoring every design as a failure.
  const excessFrac = voidedVolume > 0 ? drain.excessVolume / voidedVolume : 1;
  const timeTerm = drain.bulkClearTime < 0 ? 0 : clamp(1 - drain.bulkClearTime / 45, 0, 1);
  const drainageScore = clamp(
    100 * (0.6 * clamp(1 - excessFrac / 0.08, 0, 1) + 0.4 * timeTerm),
    0,
    100
  );
  if (drain.bulkClearTime < 0) notes.push('bulk never cleared within the run window');
  if (drain.maxStandingDepth > 1e-3) {
    notes.push(`standing liquid ${(drain.maxStandingDepth * 1000).toFixed(1)} mm deep`);
  }

  // Hygiene: stagnant and long-residence area relative to the wetted area.
  const wetted = Math.max(1e-6, drain.peakWettedArea);
  const stagnantFrac = drain.stagnantArea / wetted;
  const scaleFrac = drain.scaleRiskArea / wetted;
  const hygieneScore = clamp(100 * (1 - 0.6 * stagnantFrac - 0.6 * scaleFrac), 0, 100);
  if (stagnantFrac > 0.4) notes.push('large stagnant area — liquid is sitting still');

  // Angle: fraction of reachable surface steeper than the criterion.
  const angleScore = clamp(100 * (1 - imp.fractionOverCritical), 0, 100);
  if (imp.fractionOverCritical > 0.5) {
    notes.push(
      `${(100 * imp.fractionOverCritical).toFixed(0)}% of the reachable surface is steeper than ` +
        `${radToDeg(CRITICAL_IMPINGEMENT_ANGLE).toFixed(0)}°`
    );
  }

  const total =
    0.4 * splashScore + 0.2 * drainageScore + 0.15 * hygieneScore + 0.25 * angleScore;

  return { splashScore, drainageScore, hygieneScore, angleScore, total, notes };
}

/** Human-readable one-line summary of a run. */
export function summarise(
  splash: SplashbackReport,
  drain: DrainageReport,
  imp: ImpingementReport
): string[] {
  const lines: string[] = [];
  lines.push(
    `splashback on user: ${splash.userMicrolitresPerLitre.toFixed(0)} µL/L ` +
      `(${(splash.userVolume * 1e9).toFixed(0)} µL total, ${splash.userDroplets} droplets)`
  );
  lines.push(
    `  of which thrown back ${(splash.userSplashVolume * 1e9).toFixed(0)} µL, ` +
      `direct miss ${(splash.userDirectVolume * 1e9).toFixed(0)} µL`
  );
  lines.push(
    `splash fraction at the wall: ${(100 * splash.splashFraction).toFixed(2)}% ` +
      `over ${splash.impactEvents} impacts (${splash.splashEvents} splashed)`
  );
  lines.push(
    `impingement: mean ${radToDeg(imp.meanAngle).toFixed(1)}°, max ${radToDeg(imp.maxAngle).toFixed(1)}°, ` +
      `${(100 * imp.fractionOverCritical).toFixed(0)}% of reachable area over ` +
      `${radToDeg(CRITICAL_IMPINGEMENT_ANGLE).toFixed(0)}°`
  );
  lines.push(
    `drainage: ${(drain.residualVolume * 1e6).toFixed(2)} mL left ` +
      `(${(drain.retainedFloorVolume * 1e6).toFixed(2)} mL unavoidable, ` +
      `${(drain.excessVolume * 1e6).toFixed(2)} mL avoidable), ` +
      `bulk clear in ${drain.bulkClearTime < 0 ? 'never' : drain.bulkClearTime.toFixed(1) + ' s'}, ` +
      `max standing depth ${(drain.maxStandingDepth * 1000).toFixed(2)} mm`
  );
  lines.push(
    `hygiene: wetted ${(drain.peakWettedArea * 1e4).toFixed(0)} cm², ` +
      `stagnant ${(drain.stagnantArea * 1e4).toFixed(0)} cm², ` +
      `over-20 s residence ${(drain.scaleRiskArea * 1e4).toFixed(0)} cm²`
  );
  for (let z = 0; z < splash.perZone.length; z++) {
    const t = splash.perZone[z];
    if (t.volume <= 0) continue;
    lines.push(
      `  ${ZONE_NAMES[z]}: ${(t.volume * 1e9).toFixed(0)} µL in ${t.count} drops ` +
        `(splash ${(t.splashVolume * 1e9).toFixed(0)}, direct ${(t.directVolume * 1e9).toFixed(0)})`
    );
  }
  return lines;
}

export const DRY_THRESHOLD = FILM_DRY_THICKNESS * 4;
