import { PRESETS } from '../geometry/presets';
import { FieldMode } from '../render/fixtureView';
import { CameraPreset } from '../render/sceneView';
import { App } from './app';

/**
 * A scripted control surface, attached to `window.__lab`.
 *
 * This exists because of a specific and expensive mistake. The viewport is WebGL,
 * so nothing outside a browser can see it, and the geometry work on this project
 * was reviewed instead through an offline rasteriser that drew the fixture mesh on
 * its own -- no shaders, no liquid, no droplets, no user figure, no room. That is a
 * different claim from "the product looks right", and reporting one as the other
 * hid a set of integration faults completely: capture planes buried inside the
 * casting, an opaque exterior occluding the stream, and an aim constant tuned for
 * one fixture applied to all of them. None of it was visible in a picture of a
 * bowl by itself, and all of it was obvious in a screenshot of the actual app.
 *
 * So the app can now be driven from a headless browser and photographed. The
 * surface is deliberately small and side-effect free apart from what it names, and
 * it is additive -- the interactive UI does not go through it.
 */

export interface LabAutomation {
  readonly ready: true;
  /** Ids of every registered fixture, in picker order. */
  models(): string[];
  /** Load a fixture and rebuild. */
  selectModel(id: string): void;
  currentModel(): string;
  /** Step the simulation to a simulated time, in seconds, then redraw. */
  advanceTo(seconds: number): void;
  /** Simulated time now, in seconds. */
  time(): number;
  setPlaying(playing: boolean): void;
  /** Surface data overlay, or 'liquid' / 'dry' for the realistic views. */
  setFieldMode(mode: string): void;
  setCamera(preset: string): void;
  /**
   * Aim at a fraction along the sagittal profile, keeping the current `u`.
   *
   * Not "on the centreline", which is what this used to claim: it writes
   * `aimTargetV` only, and the solve then runs at whatever `aimTargetU` is set to.
   * Use `setAimUv(0, v)` when the centreline is what you actually want.
   */
  setAim(v: number): void;
  /** Aim at a parametric point: u across the width (-1..1), v down the profile. */
  setAimUv(u: number, v: number): void;
  /** Toggle scene furniture, so a shot can isolate the fixture. */
  setOverlays(opts: {
    zones?: boolean;
    heatmaps?: boolean;
    streamPath?: boolean;
    wireframe?: boolean;
    shell?: boolean;
    /** The flushometer and its pipework. Additive: every existing key is unchanged. */
    fittings?: boolean;
  }): void;
  /** Numbers worth asserting on without reading pixels. */
  probe(): LabProbe;
  redraw(): void;
}

export interface LabProbe {
  model: string;
  time: number;
  phase: number;
  /** Live droplet count. */
  droplets: number;
  /**
   * Where the emitter is. The contact point is *not* here — ask `traceAim` for
   * that. The comment used to promise both and the probe only ever carried the
   * exit position.
   */
  emitter: [number, number, number];
  /** Interior bounds, min then max. */
  interior: [number, number, number, number, number, number];
  /** Casting bounds, min then max. Null when there is no casting. */
  casting: [number, number, number, number, number, number] | null;
  /** Front face of the interior, and of the casting. */
  interiorFrontZ: number;
  castingFrontZ: number | null;
  /** Where the capture scene believes the front of the fixture is. */
  captureFrontZ: number;
  floorY: number;
  degenerateCells: number;
  selfIntersects: boolean;
  /**
   * Whether the stream, at the aim and the instant now set, is stopped by the
   * casting or the metalwork before it reaches the wetted interior.
   *
   * Here because Traps 44 and 45 both require a re-check after any casting or
   * posture change, and neither could be answered from outside the browser. The
   * fault they describe is not visible in a screenshot: `compact-waterless` spent
   * its whole life with a default aim inside the band its own casting blocked, and
   * it survived because the readouts raycast the interior alone and answered "no
   * wall" rather than "the casting is in the way".
   */
  aimBlocked: boolean;
  /** Whether it reached the interior at all. Blocked and short are different. */
  aimReached: boolean;
  /** Impingement angle where it lands, degrees. Near zero on a grazing hit. */
  aimAngleDeg: number;
}

const FIELD_MODES: Record<string, FieldMode> = {
  liquid: FieldMode.Liquid,
  impingement: FieldMode.Impingement,
  film: FieldMode.FilmThickness,
  filmSpeed: FieldMode.FilmSpeed,
  residence: FieldMode.Residence,
  impact: FieldMode.ImpactVolume,
  splash: FieldMode.SplashOrigin,
  dry: FieldMode.Dry,
};

const CAMERAS: Record<string, CameraPreset> = {
  threeQuarter: CameraPreset.ThreeQuarter,
  front: CameraPreset.Front,
  side: CameraPreset.Side,
  top: CameraPreset.Top,
  userEye: CameraPreset.UserEye,
};

export function attachAutomation(app: App): void {
  const api: LabAutomation = {
    ready: true,
    models: () => PRESETS.map((p) => p.id),
    selectModel: (id) => {
      app.selectPreset(id);
      app.refreshViews();
    },
    currentModel: () => app.modelId,
    advanceTo: (seconds) => app.advanceTo(seconds),
    time: () => app.sim.time,
    setPlaying: (playing) => app.setPlaying(playing),
    setFieldMode: (mode) => {
      const m = FIELD_MODES[mode];
      if (m === undefined) throw new Error(`unknown field mode: ${mode}`);
      app.setFieldMode(m);
    },
    setCamera: (preset) => {
      const p = CAMERAS[preset];
      if (p === undefined) throw new Error(`unknown camera: ${preset}`);
      app.setCameraPreset(p);
    },
    setAim: (v) => {
      app.sim.config.aimTargetV = v;
      app.apply('aim');
    },
    setAimUv: (u, v) => app.setAimTarget(u, v),
    setOverlays: (o) => {
      app.setOverlays(o);
      app.refreshViews();
    },
    probe: () => app.probe(),
    redraw: () => app.refreshViews(),
  };
  (window as unknown as { __lab: LabAutomation }).__lab = api;
}
