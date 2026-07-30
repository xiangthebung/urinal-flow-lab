import { GRAVITY } from '../core/constants';
import {
  FluidProperties,
  URINE_37C,
  WALL_MATERIALS,
  WallMaterial,
} from '../core/fluid';
import { Rng } from '../core/rng';
import { Vec3, v3 } from '../core/vec3';
import { MeshCollider } from '../geometry/collider';
import { ShellMesh, ShellParams, buildShell } from '../geometry/shell';
import { SurfaceParams, UrinalSurface, defaultSurfaceParams } from '../geometry/surface';
import { CaptureScene, CaptureZone, UserPosture, defaultPosture } from './capture';
import { FilmParams, FilmSolver, defaultFilmParams } from './film';
import { ImpactModelParams, ImpactResolver, defaultImpactParams } from './impact';
import {
  DrainageReport,
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
   * If set, aim at this profile fraction on the centreline instead of using the
   * raw elevation and azimuth. 0 is the top of the back wall, 0.5 the sump.
   */
  aimTargetV: number | null;
  /** Seed, so a comparison between two designs is a controlled experiment. */
  seed: number;
  /** Particle buffer size. */
  particleCapacity: number;
}

export function defaultConfig(): SimConfig {
  return {
    surface: defaultSurfaceParams(),
    casting: {},
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
    // Aim high enough on the back wall to stay on the surface the geometry
    // actually controls. Aiming lower pushes the impact into the throat fillet,
    // which no wall-shape strategy governs, and a carefully generated wall then
    // buys nothing: measured splashback rises by more than an order of magnitude
    // between aiming at v=0.14 and v=0.36 on the same fixture. Aim is the single
    // most sensitive input in the whole model.
    aimTargetV: 0.18,
    seed: 12345,
    particleCapacity: 200000,
  };
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
  private castingCollider!: MeshCollider;
  film!: FilmSolver;
  particles!: ParticleSystem;
  emitter!: StreamEmitter;
  impact!: ImpactResolver;
  capture!: CaptureScene;
  metrics!: Metrics;
  private rng!: Rng;
  private stepResult: ParticleStepResult = makeStepResult();
  private bounds!: { min: Vec3; max: Vec3 };

  time = 0;
  phase: SimPhase = SimPhase.Idle;
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

    const speed = this.peakExitSpeed();
    for (let pass = 0; pass < 2; pass++) {
      const frontZ = surf.bounds().max.z;
      const floorY = surf.floorY;
      const origin = {
        z: frontZ + c.posture.standoff,
        y: floorY + c.posture.emitterHeight,
      };
      const prevZ = frontZ;
      surf = new UrinalSurface(
        { ...c.surface, streamOrigin: origin, streamSpeed: speed },
        res
      );
      // Converged once the front face stops moving meaningfully.
      if (Math.abs(surf.bounds().max.z - prevZ) < 2e-3) break;
    }
    // Record what was actually used, so the UI can show it.
    this.alignedStreamOrigin = {
      z: surf.bounds().max.z + c.posture.standoff,
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
    this.castingCollider = new MeshCollider(this.casting.positions, this.casting.indices);
    this.rng = new Rng(c.seed);
    this.film = new FilmSolver(this.surface, c.fluid, c.wall, c.film);
    this.particles = new ParticleSystem(c.particleCapacity);
    this.capture = new CaptureScene(this.surface, c.posture);
    this.emitter = new StreamEmitter(c.stream, c.fluid, this.rng);
    this.emitter.attachTo(this.capture.fixtureFrontZ, this.surface.floorY);
    this.impact = new ImpactResolver(c.impact, c.fluid, c.wall, this.rng);
    this.metrics = new Metrics(
      this.surface,
      this.surface.floorY,
      this.capture.fixtureFrontZ
    );
    this.bounds = this.capture.simulationBounds(this.surface);
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
    if (c.aimTargetV !== null) this.aimAtProfileFraction(c.aimTargetV);
    this.refreshImpingement();
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
    const nv = this.surface.nv;
    const nu = this.surface.nu;
    const j = Math.min(nv - 1, Math.max(0, Math.round(v * (nv - 1))));
    const cell = j * nu + Math.floor(nu / 2);
    const target = this.surface.getCellPos(cell, v3());
    const ok = this.emitter.aimAt(target, GRAVITY);
    if (ok) {
      this.config.stream.aimElevation = this.emitter.params.aimElevation;
      this.config.stream.aimAzimuth = this.emitter.params.aimAzimuth;
      this.refreshImpingement();
    }
    return ok;
  }

  /** Recompute the design-time impingement map for the current aim. */
  refreshImpingement(): void {
    const peakT = this.emitter.flow.peakFraction * this.emitter.flow.duration;
    const speed = Math.max(0.2, this.emitter.speedAt(peakT));
    this.impingement = computeImpingementMap(
      this.surface,
      this.emitter.position,
      speed,
      GRAVITY
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

    // 1. Emit.
    if (this.phase === SimPhase.Voiding) {
      this.emitter.step(this.time, dt, (p) => {
        this.particles.spawnFromEmitter(p);
        this.metrics.emittedVolume += p.volume;
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

    // 3. Resolve wall impacts. Each one either wets the wall, throws
    //    secondaries, or both.
    for (const ev of this.stepResult.impacts) {
      const before = this.impact.totals.splashedVolume;
      this.impact.resolve(ev, this.surface, this.particles, this.film);
      const splashed = this.impact.totals.splashedVolume - before;
      const ang = this.impact.last ? this.impact.last.impingementAngle : 0;
      this.metrics.recordImpact(ev.hit.cell, ev.volume, ang, splashed);
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
      }
      this.particles.kill(cap.index);
    }

    // 5. Advance the film.
    this.film.step(dt);

    // 6. Turn shed drips into real droplets so they land somewhere countable.
    for (const s of this.film.shed) {
      const d = Math.cbrt((6 * s.volume) / Math.PI);
      this.particles.spawnDroplet(s.position, s.velocity, d, s.volume, 1);
    }

    // 7. Retire anything that has left the region of interest.
    const escaped = this.particles.cullOutside(this.bounds.min, this.bounds.max);
    void escaped;

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
      this.particles.overflowVolume;
    const emitted = this.metrics.emittedVolume;
    const closure = emitted > 0 ? Math.abs(accounted - emitted) / emitted : 0;

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
