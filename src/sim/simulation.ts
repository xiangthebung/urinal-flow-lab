import { CRITICAL_IMPINGEMENT_ANGLE, GRAVITY } from '../core/constants';
import {
  FluidProperties,
  URINE_37C,
  WALL_MATERIALS,
  WallMaterial,
} from '../core/fluid';
import { Rng } from '../core/rng';
import { Vec3, clamp, v3 } from '../core/vec3';
import { CompositeCollider, MeshCollider, SolidCollider } from '../geometry/collider';
import {
  FittingsMesh,
  FittingsParams,
  buildFittings,
} from '../geometry/fittings';
import { ShellMesh, ShellParams, buildShell } from '../geometry/shell';
import { UrinalPreset } from '../geometry/presets';
import { SurfaceParams, UrinalSurface, defaultSurfaceParams } from '../geometry/surface';
import { CaptureScene, CaptureZone, UserPosture, defaultPosture } from './capture';
import { FixtureExtent, fixtureExtent } from './extent';
import { FilmParams, FilmSolver, defaultFilmParams } from './film';
import { ImpactModelParams, ImpactResolver, defaultImpactParams } from './impact';
import {
  DrainageReport,
  FlowPhase,
  ImpingementReport,
  Metrics,
  ScoreBreakdown,
  SplashbackReport,
  computeImpingementMap,
  scoreDesign,
  summarise,
} from './metrics';
import {
  ParticleStepResult,
  ParticleSystem,
  PFlag,
  makeStepResult,
} from './particles';
import { StreamEmitter, StreamParams, defaultStreamParams } from './stream';

/**
 * Ties the five subsystems together and runs the clock.
 *
 * Ordering within a step is not arbitrary. Emission happens first so new liquid
 * is integrated the same step it appears. Impacts are resolved before the film
 * advances, so liquid deposited this step is carried by this step's flow rather
 * than sitting still for one frame. Drips shed by the film become particles at
 * the end, which means a drop leaving the lip is a real droplet that has to land
 * somewhere and be counted, instead of quietly vanishing from the volume balance.
 */

export const enum SimPhase {
  Idle = 0,
  Voiding = 1,
  Draining = 2,
  Finished = 3,
}

/** Whether the flush has run yet. Separate from SimPhase, which is the void. */
const enum FlushState {
  Waiting = 0,
  Running = 1,
  Done = 2,
}

export interface SimConfig {
  surface: SurfaceParams;
  /**
   * Exterior casting. Overrides only; the rest comes from defaultShellParams().
   *
   * It lives in the simulation config rather than the renderer because the casting
   * is solid: droplets collide with it, and where its faces are decides how much
   * liquid ends up on the outside of the fixture. Building it in the view layer was
   * the reason splash flew straight through the ceramic for so long.
   */
  casting: Partial<ShellParams>;
  /**
   * Flush valve, supply pipe and outlet spud. Overrides only.
   *
   * In the simulation config rather than the renderer for the same reason the
   * casting is: they are solid and droplets collide with them.
   */
  fittings: Partial<FittingsParams>;
  stream: StreamParams;
  film: FilmParams;
  impact: ImpactModelParams;
  posture: UserPosture;
  fluid: FluidProperties;
  wall: WallMaterial;
  /** Grid resolution of the fixture surface and film. */
  resolutionU: number;
  resolutionV: number;
  /** Physics step, s. */
  timeStep: number;
  /** How long to keep simulating after flow stops, s. */
  drainTime: number;
  /**
   * Depth of standing water in the sump when the run starts, m.
   *
   * A washout urinal is not dry when you walk up to it. Its trap holds a water
   * seal and the last flush left a pool over the outlet, and that pool is the
   * first thing a low aim actually strikes -- which matters, because a droplet
   * arriving on millimetres of standing liquid takes the wetted branch of the
   * splash threshold rather than the dry one, and past about one droplet diameter
   * the mechanism is cavity collapse rather than a corona. Starting every run on
   * bone-dry ceramic put the sump on the dry branch for the whole of the first
   * void, which is neither what the fixture looks like nor how it behaves.
   *
   * Measured at the sump low point, so it is the depth you would see. 8 mm is the
   * standing film a washout bowl carries over its outlet between flushes; the
   * trap's own 50 mm seal is below the china and out of the model. Zero for a
   * waterless fixture, whose sealed cartridge is the point of the product.
   */
  trapSealDepth: number;
  /**
   * Flush delivered after the void, m^3. 0 disables it.
   *
   * The flushometer and the trough's sparge pipe were built as solid collidable
   * geometry and never emitted a drop, so the most visible liquid event on a real
   * urinal did not exist and `residenceTime` and `stagnantArea` were being
   * measured on a fixture that is never washed down. 1.9 L is the 0.5 gpf that
   * every fixture in this library is specified at.
   */
  flushVolume: number;
  /** Seconds after flow stops before the flush starts. */
  flushDelay: number;
  /** How long the flush runs, s. */
  flushDuration: number;
  /**
   * If set, aim at this profile fraction instead of using the raw elevation and
   * azimuth. 0 is the top of the back wall, 0.5 the sump.
   */
  aimTargetV: number | null;
  /**
   * Where across the width to aim, -1 to 1. 0 is the centreline.
   *
   * Separate from `aimTargetV` and not nullable, because there is always a
   * sensible answer for it and defaulting to the centreline reproduces the old
   * behaviour exactly.
   */
  aimTargetU: number;
  /**
   * Whether the user re-aims as the stream weakens.
   *
   * This was a modelling choice made implicitly, by *when* the aim happened to be
   * solved. `StreamEmitter.aimAt` uses the exit speed at peak flow, so the launch
   * angles are fixed at the strongest part of the void and then held; as the
   * stream decays, range falls roughly as the square of speed and it lands
   * progressively shorter, eventually on the fixture's own front rim. Nothing
   * stated that, and it is not a detail: the weak rise and tail produce 5-20x more
   * splashback per litre than sustained flow (Trap 17), so whatever governs where
   * the tail lands governs most of the all-in figure.
   *
   * Measured, oval bowl and flat slab, 300 mL, two seeds: letting the user track
   * the target perfectly takes weak-phase splashback to **0.30-0.37x** of the
   * held-aim figure and the liquid thrown onto the outside of the fixture during
   * the tail from ~16 mL to ~5 mL. So the choice is worth a factor of three on the
   * dominant term.
   *
   * **Does a real person track? For the rise, almost certainly yes.** Time to peak
   * on the default flow curve is 6.8 s -- a quarter of the void, not a moment --
   * and `traceAim` on the oval bowl at its own default aim reads *blocked* for the
   * first ~0.6 s and again around t = 20 s, i.e. whenever exit speed is below
   * roughly 1.2 m/s. Nobody watches their stream hit the front of the fixture for
   * half a second and does not move. So `tracked` is the more realistic model of
   * the rise, and `fixed` overstates the rim strike there.
   *
   * **`fixed` is nevertheless the default, for three reasons.** Every published
   * figure for this project was measured with it. It errs pessimistic, and a
   * design tool that flatters a fixture is worse than one that is harsh. And the
   * truth is genuinely between the two bounds, so exposing both and reporting the
   * gap is more honest than picking one and hiding the choice -- which is what was
   * happening before, since nothing stated that the solve used peak speed.
   *
   * **The choice does not touch any comparison this tool exists to make.** During
   * sustained flow the stream puts 0.00% of the void on the casing under *both*
   * policies, and `sustainedMicrolitresPerLitre` reads 1041 against 1042. The
   * policy moves only the tail -- weak-phase stream-on-casing 21.8% held against
   * 8.6% tracked -- and Traps 16 and 42 already exclude the tail from the headline.
   * So fixture ranking is unaffected either way.
   *
   * Tracking only applies when the aim was set as a point on the surface
   * (`aimTargetV`); an aim given as raw angles has no target to track.
   */
  aimTracking: 'fixed' | 'tracked';
  /** Seed, so a comparison between two designs is a controlled experiment. */
  seed: number;
  /** Particle buffer size. */
  particleCapacity: number;
}

export function defaultConfig(): SimConfig {
  return {
    surface: defaultSurfaceParams(),
    casting: {},
    fittings: {},
    stream: defaultStreamParams(),
    film: defaultFilmParams(),
    impact: defaultImpactParams(),
    posture: defaultPosture(),
    fluid: URINE_37C,
    wall: WALL_MATERIALS[0],
    resolutionU: 72,
    resolutionV: 132,
    timeStep: 1 / 1000,
    drainTime: 30,
    trapSealDepth: 0.008,
    flushVolume: 1.9e-3,
    flushDelay: 3,
    flushDuration: 6,
    // Aim high enough on the back wall to stay on the surface the geometry
    // actually controls. Aiming lower pushes the impact into the throat fillet,
    // which no wall-shape strategy governs, and a carefully generated wall then
    // buys nothing: measured splashback rises by more than an order of magnitude
    // between aiming at v=0.14 and v=0.36 on the same fixture. Aim is the single
    // most sensitive input in the whole model.
    aimTargetV: 0.18,
    aimTargetU: 0,
    aimTracking: 'fixed',
    seed: 12345,
    particleCapacity: 200000,
  };
}

/**
 * Put a fixture into a config: all of it, in one place.
 *
 * The three-line "copy the surface, the shell and the fittings" idiom was written
 * out at nine call sites -- the app twice, the validation suite three times, four
 * benches -- and Trap 43 is the story of one of them being incomplete: the
 * headline A/B built its two control fixtures from `preset.params` alone, so both
 * controls wore the *default* bowl's casting and metalwork, and "same stream, same
 * seed, same aim" was controlling everything except the part of the fixture
 * nearest the user. Adding a fourth per-preset field would have set that trap
 * again in exactly the same shape, so there is now one function and the call sites
 * cannot drift apart.
 *
 * Everything a preset does not state falls back to `defaultConfig()`, so a config
 * that has been through a waterless fixture gets its water back when it is handed
 * a flushed one.
 */
export function applyPreset(cfg: SimConfig, preset: UrinalPreset): void {
  const base = defaultConfig();
  // Copied, never aliased: presets are shared objects and configs get mutated.
  cfg.surface = { ...preset.params };
  cfg.casting = { ...(preset.shell ?? {}) };
  cfg.fittings = { ...(preset.fittings ?? {}) };
  cfg.trapSealDepth = preset.water?.trapSealDepth ?? base.trapSealDepth;
  cfg.flushVolume = preset.water?.flushVolume ?? base.flushVolume;
  // Aim belongs to the model: a profile fraction that lands mid-wall on a bowl
  // lands in the throat of a stall.
  if (preset.defaultAimV !== undefined) cfg.aimTargetV = preset.defaultAimV;
}

/** Result of flying the current aim at the fixture. */
export interface AimTrace {
  /** The traced path, ending at the contact point. For drawing. */
  points: Vec3[];
  /** Where it first met the fixture, or null if it met nothing. */
  point: Vec3 | null;
  /** Interior cell struck, or -1 if it did not reach the interior. */
  cell: number;
  /** Impingement angle at that cell, radians. 0 when no interior cell. */
  angle: number;
  /** True if the solid casting stopped it before it reached the wetted interior. */
  blocked: boolean;
  /** True if it reached the wetted interior. */
  reached: boolean;
}

export interface RunReport {
  splash: SplashbackReport;
  drainage: DrainageReport;
  impingement: ImpingementReport;
  score: ScoreBreakdown;
  lines: string[];
  /** Void volume actually emitted, m^3. */
  voidedVolume: number;
  /** Every drop accounted for? Relative closure error. */
  volumeClosureError: number;
  simulatedTime: number;
  wallClockMs: number;
}

export class Simulation {
  config: SimConfig;
  surface!: UrinalSurface;
  /** Exterior casting. Rendered, and collided against. */
  casting!: ShellMesh;
  /** Flush valve, supply pipe and outlet spud. Rendered, and collided against. */
  fittings!: FittingsMesh;
  /**
   * Public because anything that asks "where does the stream go" has to consult
   * it. The aim trajectory drawn in the viewport used to raycast the interior
   * alone, so it was drawn straight through the solid casting and the aim marker
   * showed liquid reaching the sump when the real stream was being stopped dead
   * by the front rim.
   */
  castingCollider!: SolidCollider;
  /**
   * How much room the fixture occupies, interior *and* casting.
   *
   * Public because the renderer frames the camera, the room and the user figure
   * from it. Everything that needs to know where the fixture is reads this rather
   * than `surface.bounds()`, which is the wetted patch and stops 0-44 mm short of
   * the real front face.
   */
  extent!: FixtureExtent;
  film!: FilmSolver;
  particles!: ParticleSystem;
  emitter!: StreamEmitter;
  impact!: ImpactResolver;
  capture!: CaptureScene;
  metrics!: Metrics;
  private rng!: Rng;
  private stepResult: ParticleStepResult = makeStepResult();
  private bounds!: { min: Vec3; max: Vec3 };

  /**
   * Where liquid landed on the outside of the fixture, and how much.
   *
   * Published for the renderer. Trap 14 made the exterior splash properly and
   * left it invisible: the part that stays put is booked to a capture zone,
   * there is no film grid out here to hold it, and so the worst outcome the tool
   * can report -- the stream on the front rim -- drew a spotless fixture. Flat
   * `[x, y, z, nx, ny, nz, volume]` records, reset with the run.
   */
  readonly exteriorDeposits: number[] = [];

  time = 0;
  phase: SimPhase = SimPhase.Idle;
  /** Where the flush has got to. Read by the HUD so the wash is visible as an event. */
  flushState: FlushState = FlushState.Waiting;
  /** Volume of the trap seal placed at the last restart, m^3. */
  sealVolume = 0;
  /** Wall-clock cost of the last step, ms. */
  lastStepMs = 0;
  /** Cached impingement map, recomputed when geometry or aim changes. */
  impingement!: ImpingementReport;

  constructor(config: SimConfig = defaultConfig()) {
    this.config = config;
    this.rebuild();
  }

  /**
   * Peak exit speed for the configured void. Needed before any geometry exists,
   * so it is computed from the flow curve alone.
   */
  private peakExitSpeed(): number {
    const probe = new StreamEmitter(this.config.stream, this.config.fluid, new Rng(1));
    const tPeak = probe.flow.peakFraction * probe.flow.duration;
    return Math.max(0.3, probe.speedAt(tPeak));
  }

  /**
   * Build the fixture surface, aligning a constant-angle wall to where the stream
   * will actually come from.
   *
   * Without this the generated shapes are quietly worthless. The whole premise is
   * that the wall holds a fixed angle to the *arriving* stream, so the pole of the
   * construction has to sit at the real exit point. A preset carrying a hardcoded
   * origin is designing for a user who is not there, and the resulting wall misses
   * its target angle by however far the assumption was off.
   *
   * There is a circularity: the exit position is measured from the front of the
   * fixture, and the front of the fixture depends on the wall the generator
   * produces. Two passes settle it, because the front face moves by millimetres on
   * the second pass and the angle depends on it only weakly.
   *
   * The front face is the *ceramic's*, so each pass costs a casting build. It used
   * to take the interior's, which stops 0-44 mm short of the real one, so the
   * generator was aligned to a user standing that much further forward than the
   * one the simulation then places -- the exact mistake the paragraph above warns
   * about, made by the alignment code itself.
   */
  private buildSurface(): UrinalSurface {
    const c = this.config;
    const res = { nu: c.resolutionU, nv: c.resolutionV };
    let surf = new UrinalSurface(c.surface, res);
    // Cleared first, so switching away from a constant-angle preset cannot leave
    // a stale alignment on display.
    this.alignedStreamOrigin = null;
    this.alignedStreamSpeed = 0;
    if (c.surface.backWallMode !== 'constantAngle') return surf;

    const ceramicFrontZ = (s: UrinalSurface): number =>
      fixtureExtent(s, buildShell(s, c.casting)).frontZ;

    const speed = this.peakExitSpeed();
    let frontZ = ceramicFrontZ(surf);
    for (let pass = 0; pass < 2; pass++) {
      const origin = {
        z: frontZ + c.posture.standoff,
        y: surf.floorY + c.posture.emitterHeight,
      };
      surf = new UrinalSurface(
        { ...c.surface, streamOrigin: origin, streamSpeed: speed },
        res
      );
      const nextZ = ceramicFrontZ(surf);
      const settled = Math.abs(nextZ - frontZ) < 2e-3;
      frontZ = nextZ;
      // Converged once the front face stops moving meaningfully.
      if (settled) break;
    }
    // Record what was actually used, so the UI can show it.
    this.alignedStreamOrigin = {
      z: frontZ + c.posture.standoff,
      y: surf.floorY + c.posture.emitterHeight,
    };
    this.alignedStreamSpeed = speed;
    return surf;
  }

  /** Stream origin the constant-angle generator was aligned to, if any. */
  alignedStreamOrigin: { z: number; y: number } | null = null;
  alignedStreamSpeed = 0;

  /** Rebuild everything. Called on any geometry or resolution change. */
  rebuild(): void {
    const c = this.config;
    this.surface = this.buildSurface();
    this.casting = buildShell(this.surface, c.casting);
    this.fittings = buildFittings(this.surface, this.casting, c.fittings);
    // The metalwork is solid. It stands above the bowl, closer to the user's aim
    // than any of the ceramic, so a stream put high on the fixture hits the spud
    // and the valve body -- and anything visible that cannot be hit silently
    // deletes liquid, which is the fault that made the casting an absorber.
    this.castingCollider = new CompositeCollider([
      new MeshCollider(this.casting.positions, this.casting.indices),
      this.fittings.empty
        ? null
        : new MeshCollider(this.fittings.positions, this.fittings.indices),
    ]);
    this.rng = new Rng(c.seed);
    this.extent = fixtureExtent(this.surface, this.casting, this.fittings);
    this.film = new FilmSolver(this.surface, c.fluid, c.wall, c.film);
    this.particles = new ParticleSystem(c.particleCapacity);
    this.capture = new CaptureScene(this.extent, c.posture);
    this.emitter = new StreamEmitter(c.stream, c.fluid, this.rng);
    this.emitter.attachTo(this.capture.fixtureFrontZ, this.surface.floorY);
    this.impact = new ImpactResolver(c.impact, c.fluid, c.wall, this.rng);
    this.metrics = new Metrics(this.surface, this.extent, c.posture.lateralOffset);
    this.bounds = this.capture.simulationBounds();
    this.time = 0;
    this.phase = SimPhase.Idle;
    if (c.aimTargetV !== null) this.aimAtProfileFraction(c.aimTargetV);
    this.refreshImpingement();
  }

  /**
   * Soft reset: keeps the geometry, clears the run. Used when only stream or
   * fluid parameters changed, which is the common case while iterating.
   */
  restart(): void {
    const c = this.config;
    this.rng = new Rng(c.seed);
    this.film.fluid = c.fluid;
    this.film.wall = c.wall;
    this.film.params = c.film;
    this.film.reset();
    this.particles.reset();
    this.emitter = new StreamEmitter(c.stream, c.fluid, this.rng);
    this.emitter.attachTo(this.capture.fixtureFrontZ, this.surface.floorY);
    this.impact.fluid = c.fluid;
    this.impact.wall = c.wall;
    this.impact.params = c.impact;
    this.impact.resetTotals();
    this.metrics.reset();
    this.time = 0;
    this.phase = SimPhase.Voiding;
    this.flushState = FlushState.Waiting;
    this.exteriorDeposits.length = 0;
    this.unreachableSteps = 0;
    this.placeTrapSeal();
    if (c.aimTargetV !== null) this.aimAtProfileFraction(c.aimTargetV);
    this.refreshImpingement();
  }

  /**
   * Stand the water seal in the sump.
   *
   * Filled hydrostatically rather than by painting a thickness onto the drain
   * cells: the level is a horizontal plane a stated height above the lowest point
   * of the wetted interior, and each cell takes the depth that plane leaves over
   * it, measured along the wall's own normal. That is what produces a real
   * waterline -- a contact line at a constant height that runs round the basin and
   * follows its shape -- instead of a puddle-shaped stain whose edge is wherever
   * the drain cells happen to stop.
   *
   * The solver is then left to hold it. It is an equilibrium of the terms already
   * there: the hydrostatic gradient pushes toward level and the contact line pins
   * the edge, so if this ever drifts it is a solver regression rather than a
   * cosmetic one, and volume closure will say so first.
   */
  private placeTrapSeal(): void {
    this.sealVolume = 0;
    const s = this.surface;
    const n = s.nu * s.nv;
    this.film.sealThickness.fill(0);
    const depth = this.config.trapSealDepth;
    if (!(depth > 0)) return;

    let yMin = Infinity;
    const p = v3();
    for (let c = 0; c < n; c++) {
      s.getCellPos(c, p);
      if (p.y < yMin) yMin = p.y;
    }
    if (!Number.isFinite(yMin)) return;
    const level = yMin + depth;

    const nrm = v3();
    let placed = 0;
    for (let c = 0; c < n; c++) {
      s.getCellPos(c, p);
      const head = level - p.y;
      if (head <= 0) continue;
      s.getCellNormal(c, nrm);
      // Depth normal to the wall under a horizontal free surface. On the flat
      // washout floor the normal is vertical and this is the head itself; up the
      // side of the basin it thins to nothing, which is the waterline.
      const h = head * Math.abs(nrm.y);
      if (h <= 0) continue;
      // Both the liquid and the weir that keeps it. Without the second the outlet
      // is an orifice discharging on the local head, which empties eight
      // millimetres in about thirty milliseconds -- the seal was placed and gone
      // before the first parcel arrived.
      this.film.sealThickness[c] = h;
      // Water. What stands in the trap between uses is whatever the last flush
      // left, so a fixture opens clean rather than opening with a bowl of the
      // previous user's void in it.
      this.film.deposit(c, h * s.cellArea[c], 0, 0, 0);
      placed += h * s.cellArea[c];
    }
    // `deposit` books into the film's own depositedVolume, which the closure sum
    // does not read, so the seal is declared here instead. Trap 24: liquid that
    // exists and is not in the sum is a leak waiting to be found by someone else.
    this.metrics.introducedVolume += placed;
    this.sealVolume = placed;
  }

  /**
   * Point the stream at the centreline of the fixture at profile fraction `v`.
   *
   * Gives every design the same *aim intent* rather than the same aim angle,
   * which is the only fair way to compare fixtures of different depths and rim
   * heights: a fixed elevation that lands mid-wall on a shallow bowl lands in the
   * sump of a deep one, and the sump is a much steeper target.
   */
  aimAtProfileFraction(v: number): boolean {
    return this.aimAtSurfaceUv(this.config.aimTargetU, v);
  }

  /**
   * Point the stream at a parametric point on the wetted surface.
   *
   * Two coordinates rather than one because aim is genuinely two-dimensional and
   * pretending otherwise removed the more interesting half of it. `v` walks down
   * the sagittal profile and `u` across the width, so an off-centre aim -- which
   * is what most people actually do, and which decides whether splash leaves past
   * the side of the fixture rather than into it -- can be set and measured.
   */
  aimAtSurfaceUv(u: number, v: number): boolean {
    const cell = this.surface.cellFromUv(clamp(u, -1, 1), clamp(v, 0, 1));
    const target = this.surface.getCellPos(cell, v3());
    const ok = this.emitter.aimAt(target, GRAVITY);
    if (ok) {
      // Kept so `aimTracking: 'tracked'` has something to re-solve against. The
      // aim is a point on the fixture, not a pair of angles -- the angles are only
      // the answer at one particular exit speed.
      this.aimTarget = target;
      this.config.stream.aimElevation = this.emitter.params.aimElevation;
      this.config.stream.aimAzimuth = this.emitter.params.aimAzimuth;
      this.refreshImpingement();
    }
    return ok;
  }

  /**
   * The point on the surface the aim was last solved for, if it was set as a
   * point rather than as raw angles.
   */
  aimTarget: Vec3 | null = null;

  /**
   * Steps during the void where the target was out of ballistic range at any
   * elevation. Meaningful under `aimTracking: 'tracked'`: it is the part of the
   * tail no amount of re-aiming can fix, because the stream simply cannot get
   * there any more.
   */
  unreachableSteps = 0;

  /**
   * Fly the current aim ballistically and report the first thing it actually
   * hits -- casting included.
   *
   * One method, used by the viewport trajectory, the aim marker and the aim
   * sweep, because all three previously traced against the interior loft alone.
   * The casting is 10-15 mm thicker than the interior all round and its rim
   * stands proud of it, so an aim that clears the interior lip by millimetres is
   * stopped dead by the ceramic. Tracing only the interior drew a confident
   * dashed line to a point the liquid could never reach, and on a deep fixture
   * that is not a cosmetic error: the stream really does clip the rim, and the
   * whole void is then thrown off the front of the fixture.
   *
   * `points` is returned so the caller can draw exactly the path that was
   * tested, rather than recomputing it and risking a different answer.
   */
  traceAim(t?: number, maxSteps = 260, dt = 0.004): AimTrace {
    const tSample =
      t ?? this.emitter.flow.peakFraction * this.emitter.flow.duration;
    const speed = this.emitter.speedAt(tSample);
    const points: Vec3[] = [];
    const o = this.emitter.position;
    points.push(v3(o.x, o.y, o.z));
    if (speed <= 1e-4) {
      return { points, point: null, cell: -1, angle: 0, blocked: false, reached: false };
    }
    const dir = this.emitter.aimDirection();
    let prev = v3(o.x, o.y, o.z);

    for (let i = 1; i <= maxSteps; i++) {
      const tt = i * dt;
      const p = v3(
        o.x + dir.x * speed * tt,
        o.y + dir.y * speed * tt - 0.5 * GRAVITY * tt * tt,
        o.z + dir.z * speed * tt
      );
      const seg = v3(p.x - prev.x, p.y - prev.y, p.z - prev.z);

      const inner = this.surface.raycast(prev, seg, 1);
      // Only as far as the interior hit, so the nearer of the two wins. This is
      // the same ordering the particle sweep uses, which is what makes the drawn
      // trajectory agree with where liquid actually goes.
      const solid = this.castingCollider.raycastSolid(prev, seg, inner ? inner.t : 1);

      if (solid && (!inner || solid.t < inner.t)) {
        const hp = v3(
          prev.x + seg.x * solid.t,
          prev.y + seg.y * solid.t,
          prev.z + seg.z * solid.t
        );
        points.push(hp);
        return { points, point: hp, cell: -1, angle: 0, blocked: true, reached: false };
      }
      if (inner) {
        points.push(v3(inner.point.x, inner.point.y, inner.point.z));
        return {
          points,
          point: v3(inner.point.x, inner.point.y, inner.point.z),
          cell: inner.cell,
          angle: this.surface.impingementAngle(inner.cell, seg),
          blocked: false,
          reached: true,
        };
      }
      points.push(p);
      prev = p;
      if (p.y < this.surface.floorY) break;
    }
    return { points, point: null, cell: -1, angle: 0, blocked: false, reached: false };
  }

  /** Recompute the design-time impingement map for the current aim. */
  refreshImpingement(): void {
    const peakT = this.emitter.flow.peakFraction * this.emitter.flow.duration;
    const speed = Math.max(0.2, this.emitter.speedAt(peakT));
    this.impingement = computeImpingementMap(
      this.surface,
      this.emitter.position,
      speed,
      GRAVITY,
      CRITICAL_IMPINGEMENT_ANGLE,
      this.castingCollider
    );
  }

  /**
   * Whether the run is over.
   *
   * A method rather than a direct `phase` comparison at the call sites, because
   * `step()` mutates `phase` and the type checker cannot see that through a loop
   * body -- it narrows the property on entry and then flags the loop condition as
   * unreachable. Reading it through a call keeps the check honest.
   */
  isFinished(): boolean {
    return this.phase === SimPhase.Finished;
  }

  get voidDuration(): number {
    return this.emitter.flow.duration;
  }

  get totalDuration(): number {
    return this.emitter.flow.duration + this.config.drainTime;
  }

  /** Advance one physics step. */
  step(): void {
    const t0 = performance.now();
    const dt = this.config.timeStep;
    if (this.phase === SimPhase.Idle) this.phase = SimPhase.Voiding;
    if (this.phase === SimPhase.Finished) return;

    // 1. Emit. The phase is set first so that everything recorded this step --
    //    emitted volume and anything landing -- is attributed to the stream
    //    strength actually in force.
    const rateNow = this.emitter.flow.rateAt(this.time);
    this.metrics.currentPhase =
      rateNow >= 0.5 * this.emitter.flow.peakFlowRate ? FlowPhase.Sustained : FlowPhase.Weak;
    // 0. Re-aim, if the user is modelled as tracking the target as the stream
    //    weakens. Solved at the *current* exit speed rather than at peak, which is
    //    the whole difference between the two policies. Where the solve fails the
    //    target is out of ballistic range at any elevation, so the aim is left
    //    where it was and the step is counted: that is the part of the tail no
    //    re-aiming can reach.
    if (
      this.phase === SimPhase.Voiding &&
      this.config.aimTracking === 'tracked' &&
      this.aimTarget
    ) {
      const sol = this.emitter.solveAimForTarget(this.aimTarget, this.time, GRAVITY);
      if (sol) {
        this.emitter.params.aimElevation = sol.elevation;
        this.emitter.params.aimAzimuth = sol.azimuth;
      } else if (rateNow > 0) {
        this.unreachableSteps++;
      }
    }
    if (this.phase === SimPhase.Voiding) {
      this.emitter.step(this.time, dt, (p) => {
        this.particles.spawnFromEmitter(p);
        this.metrics.emittedVolume += p.volume;
        this.metrics.perPhase[this.metrics.currentPhase].emitted += p.volume;
      });
      if (this.time >= this.emitter.flow.duration) {
        this.phase = SimPhase.Draining;
        this.metrics.flowEndTime = this.time;
      }
    }

    // 2. Move the airborne liquid and find what it hit.
    this.particles.step(
      dt,
      this.config.fluid,
      this.surface,
      this.castingCollider,
      this.capture,
      this.stepResult,
      null
    );

    // 2b. Release the satellite drops from any parcel that pinched off this step.
    //     Spawned here rather than inside the sweep so that claiming a slot
    //     cannot change how many particles the sweep itself visits. Generation
    //     stays 0: a satellite comes straight from the stream and has never
    //     touched the fixture, so if it reaches the user it is a direct miss and
    //     not splashback, which is a distinction the report depends on.
    for (const s of this.stepResult.satellites) {
      this.particles.spawnDroplet(s.position, s.velocity, s.diameter, s.volume, 0, true);
    }

    // 3. Resolve wall impacts. Each one either wets the wall, throws
    //    secondaries, or both.
    for (const ev of this.stepResult.impacts) {
      const before = this.impact.totals.splashedVolume;
      this.impact.resolve(ev, this.surface, this.particles, this.film);
      const splashed = this.impact.totals.splashedVolume - before;
      const ang = this.impact.last ? this.impact.last.impingementAngle : 0;
      this.metrics.recordImpact(ev.hit.cell, ev.volume, ang, splashed, ev.generation);
    }

    // 4. Record what landed on the floor, the user, or the outside of the
    //    fixture. The casting is ceramic and splashes: a droplet reaching it
    //    throws a corona by the same physics as one hitting the interior, and
    //    only the remainder is booked as landing there. Treating the exterior as
    //    a perfect absorber was the largest single error in the model -- aimed
    //    low enough to have to clear the front rim, the stream hits the casting,
    //    and an entire void could vanish reporting zero splashback.
    for (const cap of this.stepResult.captures) {
      let landed = cap.volume;
      if (cap.zone === CaptureZone.FixtureExterior && cap.normal) {
        landed = this.impact.resolveExterior(cap, this.particles).depositVolume;
      }
      if (landed > 0) {
        this.metrics.recordCapture(cap.zone, cap.to, landed, cap.generation);
        if (cap.zone === CaptureZone.FixtureExterior && cap.normal) {
          // Bounded: a rim strike puts tens of thousands of arrivals on the
          // casting, and the renderer only needs enough of them to show where.
          if (this.exteriorDeposits.length < 7 * 20000) {
            this.exteriorDeposits.push(
              cap.to.x, cap.to.y, cap.to.z,
              cap.normal.x, cap.normal.y, cap.normal.z,
              landed
            );
          }
        }
      }
      this.particles.kill(cap.index);
    }

    // 4b. The flush.
    //
    // After the void, the flushometer washes the bowl down: a sheet entering at
    // the top of the back wall and running the whole height of the fixture. It is
    // the most visible liquid event a urinal produces and it did not exist -- the
    // valve and the trough's sparge were built as solid collidable geometry that
    // never emitted a drop, so `residenceTime` and `stagnantArea` were being
    // reported for a fixture that is never washed.
    //
    // Injected as a flux into the `v = 0` row rather than as particles, because
    // that is what a rim spreader does: it is not a jet, it is a film handed to
    // the top of the wall at low speed. The solver then carries it, and the
    // Nusselt balance already in it sets the sheet thickness -- about 0.6 mm for
    // this flux over this width -- without anything being prescribed.
    if (this.phase !== SimPhase.Voiding && this.config.flushVolume > 0) {
      const start = this.metrics.flowEndTime + this.config.flushDelay;
      const dur = Math.max(1e-3, this.config.flushDuration);
      if (this.time >= start && this.time < start + dur) {
        this.flushState = FlushState.Running;
        // Volume per unit width of the receiving row, so a 1.5 m trough is washed
        // by the same sheet as a 0.3 m bowl rather than by the same total flux.
        let width = 0;
        for (let i = 0; i < this.surface.nu; i++) width += this.surface.cellDu[i];
        const q = this.config.flushVolume / dur;
        const perWidth = q / Math.max(1e-6, width);
        // Concentration 0: the flush is water. Without that the wash-down is
        // more of the same liquid, and rinsing the bowl made it look dirtier.
        this.film.injectRow(0, perWidth, dt, 0);
        this.metrics.introducedVolume += q * dt;
      } else if (this.time >= start + dur) {
        this.flushState = FlushState.Done;
      }
    }

    // 5. Advance the film.
    this.film.step(dt);

    // 6. Turn shed drips into real droplets so they land somewhere countable.
    for (const s of this.film.shed) {
      const d = Math.cbrt((6 * s.volume) / Math.PI);
      this.particles.spawnDroplet(s.position, s.velocity, d, s.volume, 1);
    }

    // 7. Retire anything that has left the region of interest.
    // Recorded, not discarded. `escapedVolume` was declared, reset and reported
    // but never actually incremented, and it was missing from the closure sum, so
    // any droplet thrown clear of the region of interest vanished unaccounted.
    // Invisible while splash stayed inside the bowl; aiming at the metalwork
    // instead throws liquid high and wide and the balance drifted to 0.07%.
    const escaped = this.particles.cullOutside(this.bounds.min, this.bounds.max);
    this.metrics.escapedVolume += escaped.volume;

    this.time += dt;
    if (this.time >= this.totalDuration) this.phase = SimPhase.Finished;
    this.lastStepMs = performance.now() - t0;
  }

  /** Volume in the air right now, m^3. */
  airborneVolume(): number {
    return this.particles.totalVolume();
  }

  /** Take a time-series sample for the charts. */
  sample(): void {
    const shoe = this.metrics.perZone[2];
    const shin = this.metrics.perZone[3];
    const thigh = this.metrics.perZone[4];
    this.metrics.sample(
      {
        t: this.time,
        flowRate: this.emitter.flow.rateAt(this.time),
        filmVolume: this.film.totalVolume(),
        airborneVolume: this.airborneVolume(),
        userVolume: shoe.volume + shin.volume + thigh.volume,
        drainedVolume: this.film.drainedVolume,
        wettedArea: this.film.wettedArea(),
        particles: this.particles.count,
      },
      this.film
    );
  }

  /**
   * Run the whole thing headlessly and report.
   *
   * `onProgress` is called with a 0-1 fraction so a caller can drive a progress
   * bar or yield to the event loop between chunks.
   */
  run(onProgress?: (frac: number) => void, sampleEvery = 40): RunReport {
    const t0 = performance.now();
    this.restart();
    const total = this.totalDuration;
    // Under `tracked` the run walks the launch angles as it goes, and those angles
    // live on the shared stream params. Restored afterwards so a completed run
    // leaves the aim where the caller set it rather than at whatever the dribble
    // needed, which is what the aim readouts and `traceAim` would otherwise show.
    const aimEl = this.config.stream.aimElevation;
    const aimAz = this.config.stream.aimAzimuth;
    let n = 0;
    while (this.phase !== SimPhase.Finished) {
      this.step();
      if (n % sampleEvery === 0) {
        this.sample();
        if (onProgress) onProgress(Math.min(1, this.time / total));
      }
      n++;
    }
    this.sample();
    if (this.config.aimTracking === 'tracked') {
      this.config.stream.aimElevation = aimEl;
      this.config.stream.aimAzimuth = aimAz;
    }
    return this.report(performance.now() - t0);
  }

  report(wallClockMs = 0): RunReport {
    const it = this.impact.totals;
    const impactedVolume = it.depositedVolume + it.splashedVolume;
    const splash = this.metrics.splashback(
      impactedVolume,
      it.splashedVolume,
      it.splashEvents,
      it.events
    );
    const drainage = this.metrics.drainage(this.film);
    const score = scoreDesign(
      splash,
      drainage,
      this.impingement,
      this.metrics.emittedVolume
    );

    // -- Volume closure ----------------------------------------------------
    // Every drop emitted has to be somewhere: on the wall, in the air, down the
    // drain, on the floor or the user, or written off as buffer overflow. This is
    // the strongest single check on the whole pipeline, because a leak anywhere --
    // a lost splash fragment, a mis-accounted spill -- shows up here immediately,
    // and the reported microlitres are only meaningful if it closes.
    let captured = 0;
    for (const z of this.metrics.perZone) captured += z.volume;
    const accounted =
      this.film.totalVolume() +
      this.airborneVolume() +
      this.film.drainedVolume +
      captured +
      // Liquid that has run off an edge but not yet gathered into a drip. Small,
      // but leaving it out would show up as a permanent closure deficit.
      this.film.pendingEdgeVolume() +
      // Thrown clear of the region of interest. A real outcome rather than a loss:
      // it left the room, and it has to be counted somewhere or the balance drifts
      // exactly in the cases where splash is most violent.
      this.metrics.escapedVolume +
      this.particles.overflowVolume;
    const emitted = this.metrics.emittedVolume;
    // The seal and the flush are liquid the fixture was given rather than liquid
    // the user voided, so they belong on the input side of the balance and not in
    // the denominator of a microlitres-per-litre figure. `voidedVolume` below is
    // still `emitted`, which is what keeps every published number comparable.
    const supplied = emitted + this.metrics.introducedVolume;
    const closure = supplied > 0 ? Math.abs(accounted - supplied) / supplied : 0;

    return {
      splash,
      drainage,
      impingement: this.impingement,
      score,
      lines: summarise(splash, drainage, this.impingement),
      voidedVolume: emitted,
      volumeClosureError: closure,
      simulatedTime: this.time,
      wallClockMs,
    };
  }

  /** Live counts for the HUD. */
  stats(): {
    particles: number;
    coherent: number;
    secondaries: number;
    filmVolume: number;
    airborne: number;
    drained: number;
    userVolume: number;
  } {
    let coherent = 0;
    let secondaries = 0;
    const ps = this.particles;
    for (let i = 0; i < ps.highWater; i++) {
      const f = ps.flags[i];
      if ((f & PFlag.Alive) === 0) continue;
      if (f & PFlag.Coherent) coherent++;
      if (f & PFlag.Secondary) secondaries++;
    }
    const z = this.metrics.perZone;
    return {
      particles: ps.count,
      coherent,
      secondaries,
      filmVolume: this.film.totalVolume(),
      airborne: this.airborneVolume(),
      drained: this.film.drainedVolume,
      userVolume: z[2].volume + z[3].volume + z[4].volume,
    };
  }
}

/** Convenience: run one design headlessly and hand back the report. */
export function evaluateDesign(config: SimConfig): RunReport {
  const sim = new Simulation(config);
  return sim.run();
}

export { v3 };
