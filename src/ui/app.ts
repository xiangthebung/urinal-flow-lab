import { CRITICAL_IMPINGEMENT_ANGLE, GRAVITY } from '../core/constants';
import { FLUID_PRESETS, WALL_MATERIALS, capillaryLength, ohnesorge } from '../core/fluid';
import { clamp, degToRad, radToDeg, v3 } from '../core/vec3';
import { PRESETS, getPreset } from '../geometry/presets';
import { BackWallMode, SpiralBranch } from '../geometry/profile';
import { RibMode } from '../geometry/surface';
import { ColorScale, sample, toCss } from '../render/colormap';
import { DropletColorMode } from '../render/dropletView';
import { FieldInfo, FieldMode } from '../render/fixtureView';
import { CameraPreset, SceneView } from '../render/sceneView';
import { ZONE_NAMES } from '../sim/capture';
import { RunReport, SimPhase, Simulation, defaultConfig } from '../sim/simulation';
import { BarList, Chart } from './charts';
import { Effect, Panel } from './controls';

/**
 * The application: panels, viewport, live readouts, and the analysis runner.
 *
 * One design decision runs through all of it. Every number shown is either a
 * direct simulation output or a stated model constant -- nothing is smoothed,
 * rescaled for presentation, or quietly clamped into a nicer range. When a value
 * is uncertain or was calibrated rather than derived, the control that sets it says
 * so. A tool whose whole claim is physical accuracy has to be auditable, and that
 * means the interface cannot flatter the model.
 */

// Liquid first, and the default. The data overlays are the reason the tool exists,
// but opening on one of them hid the fluid behind a static colour map and made a
// working simulation look inert.
const VIEW_TABS: Array<{ mode: FieldMode; label: string }> = [
  { mode: FieldMode.Liquid, label: 'Liquid' },
  { mode: FieldMode.Impingement, label: 'Impingement angle' },
  { mode: FieldMode.FilmThickness, label: 'Film thickness' },
  { mode: FieldMode.FilmSpeed, label: 'Film speed' },
  { mode: FieldMode.Residence, label: 'Residence time' },
  { mode: FieldMode.ImpactVolume, label: 'Arriving liquid' },
  { mode: FieldMode.SplashOrigin, label: 'Splash origin' },
  { mode: FieldMode.Dry, label: 'Dry' },
];

export class App {
  private sim: Simulation;
  private view: SceneView;
  private left!: Panel;
  private right!: Panel;
  private transport!: Panel;

  private running = false;
  private speed = 1;
  private lastFrame = performance.now();
  private nextSampleAt = 0;
  private lastHeavyUpdate = 0;
  private lastReadoutUpdate = 0;

  private presetId = 'classic-bowl';
  private report: RunReport | null = null;
  private analysing = false;

  private charts: Chart[] = [];
  private zoneBars = new BarList();
  private reportEl!: HTMLPreElement;
  private scoreEl!: HTMLDivElement;
  private notesEl!: HTMLUListElement;
  private sweepEl!: HTMLDivElement;
  private legendEl!: HTMLElement;
  private hudEl!: HTMLElement;
  private noteEl!: HTMLElement;
  private timeFill!: HTMLElement;
  private voidMark!: HTMLElement;
  private phasePill!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private tabEls: HTMLButtonElement[] = [];

  private showZones = true;
  private showUser = true;
  private showHeatmaps = true;
  private showStreamPath = true;
  private showWireframe = false;

  constructor() {
    const cfg = defaultConfig();
    cfg.surface = getPreset(this.presetId).params;
    // Interactive resolution is lower than the analysis resolution. Playback at
    // anything near real time needs a thousand physics steps a second, and the
    // film solver cost scales with the cell count; the full-resolution grid is
    // used for the headless analysis run where nothing is waiting on a frame.
    cfg.resolutionU = 56;
    cfg.resolutionV = 104;
    cfg.particleCapacity = 140000;
    this.sim = new Simulation(cfg);

    const canvas = document.getElementById('gl') as HTMLCanvasElement;
    this.view = new SceneView(canvas, cfg.particleCapacity);
    this.view.setGeometry(this.sim.surface, this.sim.capture);
    this.view.applyCameraPreset(CameraPreset.ThreeQuarter, this.sim.surface, this.sim.capture);

    this.legendEl = document.getElementById('legend')!;
    this.hudEl = document.getElementById('hud')!;
    this.noteEl = document.getElementById('overlay-note')!;

    this.buildTopbar();
    this.buildViewTabs();
    this.buildLeftPanel();
    this.buildRightPanel();
    this.buildTransport();

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.sim.restart();
    this.refreshGeometryDependent();
    requestAnimationFrame(this.frame);
  }

  // =======================================================================
  // Change routing
  // =======================================================================

  /**
   * Apply the consequences of a parameter change.
   *
   * The effect ordering is deliberate and load-bearing. A geometry change has to
   * rebuild the mesh, the BVH, the film grid and the capture scene together,
   * because they all index the same surface; rebuilding some but not others would
   * leave the film solver writing into a grid that no longer matches the shape the
   * droplets are colliding with, and the result would look plausible while being
   * meaningless.
   */
  apply(effect: Effect): void {
    switch (effect) {
      case 'rebuild':
        this.sim.rebuild();
        this.view.setGeometry(this.sim.surface, this.sim.capture);
        this.sim.restart();
        this.report = null;
        this.refreshGeometryDependent();
        break;
      case 'restart':
        this.sim.restart();
        this.report = null;
        this.refreshGeometryDependent();
        break;
      case 'aim':
        if (this.sim.config.aimTargetV !== null) {
          this.sim.aimAtProfileFraction(this.sim.config.aimTargetV);
        }
        this.sim.refreshImpingement();
        this.sim.restart();
        this.report = null;
        this.refreshGeometryDependent();
        break;
      case 'view':
        this.applyViewToggles();
        break;
      default:
        break;
    }
    this.left.refresh();
    this.right.refresh();
  }

  private refreshGeometryDependent(): void {
    this.nextSampleAt = 0;
    this.updateFixtureField();
    this.view.updateStreamPath(
      this.sim.emitter,
      this.sim.surface,
      this.sim.emitter.flow.peakFraction * this.sim.emitter.flow.duration
    );
    this.applyViewToggles();
    this.updateLegend();
    this.updateGeometryNotes();
    this.runAimSweep();
  }

  private applyViewToggles(): void {
    this.view.setZonesVisible(this.showZones);
    this.view.setUserVisible(this.showUser);
    this.view.setHeatmapsVisible(this.showHeatmaps);
    this.view.setStreamPathVisible(this.showStreamPath);
    this.view.fixture.setWireframeVisible(this.showWireframe);
  }

  private resize(): void {
    const stage = document.getElementById('stage')!;
    this.view.resize(stage.clientWidth, stage.clientHeight);
    const w = (document.getElementById('right') as HTMLElement).clientWidth - 24;
    for (const c of this.charts) {
      c.resize(Math.max(160, w), 112);
      c.draw();
    }
  }

  // =======================================================================
  // Top bar
  // =======================================================================

  private buildTopbar(): void {
    const slot = document.getElementById('preset-slot')!;
    const sel = document.createElement('select');
    for (const p of PRESETS) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.append(o);
    }
    sel.value = this.presetId;
    const desc = document.createElement('span');
    desc.className = 'hint';
    desc.style.flex = '1';
    desc.style.minWidth = '0';
    const paintDesc = () => {
      desc.textContent = getPreset(this.presetId).summary;
    };
    sel.addEventListener('change', () => {
      this.presetId = sel.value;
      // Fresh copy each time: presets are shared objects and the panels write
      // straight into the live params, so handing out the original would let one
      // session's edits leak into every later load of that preset.
      this.sim.config.surface = { ...getPreset(this.presetId).params };
      paintDesc();
      this.apply('rebuild');
    });
    paintDesc();
    slot.append(sel, desc);

    const actions = document.getElementById('topbar-actions')!;
    const analyse = document.createElement('button');
    analyse.className = 'btn primary';
    analyse.textContent = 'Run full analysis';
    analyse.addEventListener('click', () => this.runAnalysis());
    actions.append(analyse);
  }

  private buildViewTabs(): void {
    const bar = document.getElementById('view-tabs')!;
    for (const t of VIEW_TABS) {
      const b = document.createElement('button');
      b.className = 'tab';
      b.type = 'button';
      b.textContent = t.label;
      b.addEventListener('click', () => {
        this.view.fixture.mode = t.mode;
        this.updateFixtureField();
        this.updateLegend();
        this.paintTabs();
      });
      bar.append(b);
      this.tabEls.push(b);
    }
    this.paintTabs();
  }

  private paintTabs(): void {
    VIEW_TABS.forEach((t, i) => {
      this.tabEls[i].classList.toggle('active', this.view.fixture.mode === t.mode);
    });
  }

  // =======================================================================
  // Left panel: the design
  // =======================================================================

  private buildLeftPanel(): void {
    const host = document.getElementById('left')!;
    this.left = new Panel(this);
    host.append(this.left.root);
    const c = this.sim.config;

    // ---- Envelope --------------------------------------------------------
    const env = this.left.section('Bowl envelope');
    env.slider({
      label: 'Rim height above datum',
      min: 0.2,
      max: 0.6,
      step: 0.005,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.rimHeight,
      set: (v) => (c.surface.rimHeight = v),
      effect: 'rebuild',
    });
    env.slider({
      label: 'Bowl depth',
      min: 0.15,
      max: 0.5,
      step: 0.005,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.bowlDepth,
      set: (v) => (c.surface.bowlDepth = v),
      effect: 'rebuild',
    });
    env.slider({
      label: 'Rim height above floor',
      min: 0.35,
      max: 0.8,
      step: 0.005,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.rimAboveFloor,
      set: (v) => (c.surface.rimAboveFloor = v),
      effect: 'rebuild',
      hint: 'Mounting height. 430 mm is the accessible limit.',
    });
    env.slider({
      label: 'Width at rim',
      min: 0.18,
      max: 0.55,
      step: 0.005,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.widthRim,
      set: (v) => (c.surface.widthRim = v),
      effect: 'rebuild',
    });
    env.slider({
      label: 'Width at sump',
      min: 0.04,
      max: 0.45,
      step: 0.005,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.widthSump,
      set: (v) => (c.surface.widthSump = v),
      effect: 'rebuild',
      hint: 'Narrowing toward the outlet raises film speed and clears the sump faster.',
    });
    env.slider({
      label: 'Side wall reach',
      min: 0,
      max: 0.4,
      step: 0.005,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.wrapDepth,
      set: (v) => (c.surface.wrapDepth = v),
      effect: 'rebuild',
      hint:
        'How far the side edges stand forward. Near the bowl depth the section ' +
        'closes into a U and splash can only leave through the front.',
    });
    env.slider({
      label: 'Section fullness',
      min: 1.5,
      max: 6,
      step: 0.1,
      decimals: 1,
      get: () => c.surface.wrapExponent,
      set: (v) => (c.surface.wrapExponent = v),
      effect: 'rebuild',
      hint: 'Low is a rounded U, high keeps the middle flat with sharp side walls.',
    });

    // ---- Back wall -------------------------------------------------------
    const bw = this.left.section('Back wall — the impact surface', {
      hint:
        'The one surface that decides splashback. What matters is the angle the ' +
        'stream makes with it, not how it looks.',
    });
    bw.select<BackWallMode>({
      label: 'Wall type',
      options: [
        { value: 'planar', label: 'Planar (flat)' },
        { value: 'concave', label: 'Concave arc' },
        { value: 'constantAngle', label: 'Constant impingement angle' },
      ],
      get: () => c.surface.backWallMode,
      set: (v) => (c.surface.backWallMode = v),
      effect: 'rebuild',
      hint:
        'Constant-angle solves for the wall that meets the arriving stream at a ' +
        'fixed angle everywhere — a logarithmic spiral, corrected for gravity.',
    });
    bw.slider({
      label: 'Planar tilt from vertical',
      min: -0.3,
      max: 0.5,
      step: 0.005,
      display: 180 / Math.PI,
      unit: '°',
      decimals: 1,
      get: () => c.surface.backWallTilt,
      set: (v) => (c.surface.backWallTilt = v),
      effect: 'rebuild',
    });
    bw.slider({
      label: 'Concave run at base',
      min: 0,
      max: 0.12,
      step: 0.002,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.backWallRun,
      set: (v) => (c.surface.backWallRun = v),
      effect: 'rebuild',
      hint: 'Stated as a run, not a radius, so it can never exceed the depth budget.',
    });
    bw.slider({
      label: 'Target impingement angle',
      min: degToRad(8),
      max: degToRad(60),
      step: degToRad(0.5),
      display: 180 / Math.PI,
      unit: '°',
      decimals: 1,
      get: () => c.surface.targetImpingementAngle,
      set: (v) => (c.surface.targetImpingementAngle = v),
      effect: 'rebuild',
      hint: 'Below about 30° splashback collapses. Leave margin: aim and flow rate move it.',
    });
    bw.select<SpiralBranch>({
      label: 'Constant-angle branch',
      options: [
        { value: 'tall', label: 'Tall (slim, drains well)' },
        { value: 'scoop', label: 'Scoop (horn, opens forward)' },
      ],
      get: () => c.surface.spiralBranch,
      set: (v) => (c.surface.spiralBranch = v),
      effect: 'rebuild',
      hint: 'Two wall orientations satisfy the same angle. Tall drains better.',
    });

    // ---- Sump and drain --------------------------------------------------
    const sump = this.left.section('Sump & drain', {
      hint: 'Decides whether liquid leaves or sits there.',
    });
    sump.slider({
      label: 'Throat handover height',
      min: 0.01,
      max: 0.16,
      step: 0.002,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.throatHeight,
      set: (v) => (c.surface.throatHeight = v),
      effect: 'rebuild',
      hint:
        'Where the back wall hands over to the fillet. Keep it below where the ' +
        'stream lands, or the fillet takes the impact and the wall shape is wasted.',
    });
    sump.slider({
      label: 'Sump depth',
      min: 0,
      max: 0.08,
      step: 0.002,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.sumpDepth,
      set: (v) => (c.surface.sumpDepth = v),
      effect: 'rebuild',
    });
    sump.slider({
      label: 'Sump floor gradient',
      min: 0,
      max: 0.35,
      step: 0.005,
      display: 180 / Math.PI,
      unit: '°',
      decimals: 1,
      get: () => c.surface.sumpSlope,
      set: (v) => (c.surface.sumpSlope = v),
      effect: 'rebuild',
      hint: 'A level sump has nothing driving the residual film anywhere.',
    });
    sump.slider({
      label: 'Drain position from wall',
      min: 0.02,
      max: 0.3,
      step: 0.005,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.drainZ,
      set: (v) => (c.surface.drainZ = v),
      effect: 'rebuild',
    });
    sump.slider({
      label: 'Drain radius',
      min: 0.005,
      max: 0.06,
      step: 0.001,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.drainRadius,
      set: (v) => (c.surface.drainRadius = v),
      effect: 'rebuild',
    });
    sump.slider({
      label: 'Drain discharge coefficient',
      min: 0.02,
      max: 0.9,
      step: 0.02,
      decimals: 2,
      get: () => c.film.drainCoefficient,
      set: (v) => (c.film.drainCoefficient = v),
      effect: 'restart',
      hint: 'Drop it to model a strainer or a partly blocked outlet.',
    });

    // ---- Rim and lip -----------------------------------------------------
    const lip = this.left.section('Rim, lip & hood', { collapsed: true });
    lip.slider({
      label: 'Front lip height',
      min: 0.05,
      max: 0.5,
      step: 0.005,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.frontLipHeight,
      set: (v) => (c.surface.frontLipHeight = v),
      effect: 'rebuild',
    });
    lip.slider({
      label: 'Lip inward curl',
      min: 0,
      max: 0.07,
      step: 0.002,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.frontLipInturn,
      set: (v) => (c.surface.frontLipInturn = v),
      effect: 'rebuild',
    });
    lip.slider({
      label: 'Top hood overhang',
      min: 0,
      max: 0.14,
      step: 0.005,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.hoodDepth,
      set: (v) => (c.surface.hoodDepth = v),
      effect: 'rebuild',
      hint:
        'Intercepts droplets that would clear the rim. It does not reduce splash, ' +
        'it relocates it — and the underside then drips.',
    });

    // ---- Surface texture -------------------------------------------------
    const rib = this.left.section('Surface texture', { collapsed: true });
    rib.select<RibMode>({
      label: 'Pattern',
      options: [
        { value: 'none', label: 'Smooth' },
        { value: 'vertical', label: 'Vertical ribs / grooves' },
        { value: 'horizontal', label: 'Horizontal ribs' },
        { value: 'chevron', label: 'Chevron' },
        { value: 'dimple', label: 'Dimpled' },
      ],
      get: () => c.surface.ribMode,
      set: (v) => (c.surface.ribMode = v),
      effect: 'rebuild',
      hint:
        'Vertical grooves channel the film and clear faster. Horizontal ribs act ' +
        'as weirs and pin liquid in bands.',
    });
    rib.slider({
      label: 'Amplitude (negative cuts grooves)',
      min: -0.006,
      max: 0.006,
      step: 0.0002,
      display: 1000,
      unit: 'mm',
      decimals: 2,
      get: () => c.surface.ribAmplitude,
      set: (v) => (c.surface.ribAmplitude = v),
      effect: 'rebuild',
    });
    rib.slider({
      label: 'Wavelength',
      min: 0.006,
      max: 0.08,
      step: 0.002,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.surface.ribWavelength,
      set: (v) => (c.surface.ribWavelength = v),
      effect: 'rebuild',
    });

    // ---- Stream and user -------------------------------------------------
    const st = this.left.section('Stream & user');
    st.slider({
      label: 'Peak flow rate',
      min: 5e-6,
      max: 40e-6,
      step: 0.5e-6,
      display: 1e6,
      unit: 'mL/s',
      decimals: 1,
      get: () => c.stream.peakFlowRate,
      set: (v) => (c.stream.peakFlowRate = v),
      effect: 'restart',
      hint: 'Healthy adult male peak is 20–25 mL/s.',
    });
    st.slider({
      label: 'Void volume',
      min: 50e-6,
      max: 600e-6,
      step: 10e-6,
      display: 1e6,
      unit: 'mL',
      decimals: 0,
      get: () => c.stream.voidVolume,
      set: (v) => (c.stream.voidVolume = v),
      effect: 'restart',
    });
    st.slider({
      label: 'Exit diameter',
      min: 0.0015,
      max: 0.006,
      step: 0.0001,
      display: 1000,
      unit: 'mm',
      decimals: 2,
      get: () => c.stream.exitDiameter,
      set: (v) => (c.stream.exitDiameter = v),
      effect: 'restart',
      hint: 'Effective hydraulic diameter at peak flow. Sets exit speed with the flow rate.',
    });
    st.slider({
      label: 'Stand-off from fixture',
      min: 0.01,
      max: 0.5,
      step: 0.005,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.posture.standoff,
      set: (v) => {
        c.posture.standoff = v;
        c.stream.standoff = v;
      },
      effect: 'rebuild',
      hint:
        'The most effective thing a user controls. Standing closer puts the wall ' +
        'inside the breakup length, so a coherent jet arrives instead of droplets.',
    });
    st.slider({
      label: 'Exit height above floor',
      min: 0.5,
      max: 1.15,
      step: 0.01,
      display: 1000,
      unit: 'mm',
      decimals: 0,
      get: () => c.posture.emitterHeight,
      set: (v) => {
        c.posture.emitterHeight = v;
        c.stream.emitterHeight = v;
      },
      effect: 'rebuild',
    });
    st.slider({
      label: 'Aim point along profile',
      min: 0.02,
      max: 0.6,
      step: 0.01,
      decimals: 2,
      get: () => c.aimTargetV ?? 0.28,
      set: (v) => (c.aimTargetV = v),
      effect: 'aim',
      hint: '0 is the top of the back wall, 0.5 the sump. Aim is solved ballistically.',
    });
    st.slider({
      label: 'Aim tremor (1σ)',
      min: 0,
      max: 0.06,
      step: 0.002,
      display: 180 / Math.PI,
      unit: '°',
      decimals: 2,
      get: () => c.stream.tremorAmplitude,
      set: (v) => (c.stream.tremorAmplitude = v),
      effect: 'restart',
      hint: 'Real aim drifts on a ~1 s timescale. A robust design tolerates it.',
    });

    // ---- Fluid and material ---------------------------------------------
    const fl = this.left.section('Fluid & wall material');
    fl.select<string>({
      label: 'Working fluid',
      options: FLUID_PRESETS.map((f) => ({ value: f.name, label: f.name })),
      get: () => c.fluid.name,
      set: (v) => {
        c.fluid = FLUID_PRESETS.find((f) => f.name === v) ?? c.fluid;
      },
      effect: 'restart',
      hint:
        'Urine has surface tension 12–18 mN/m below water, so it splashes more ' +
        'readily than a water-based lab test suggests.',
    });
    fl.select<string>({
      label: 'Wall material',
      options: WALL_MATERIALS.map((w) => ({ value: w.name, label: w.name })),
      get: () => c.wall.name,
      set: (v) => {
        c.wall = WALL_MATERIALS.find((w) => w.name === v) ?? c.wall;
      },
      effect: 'restart',
      hint:
        'Roughness lowers the dry splash threshold. A non-wetting coating makes ' +
        'droplets rebound instead of merging, which is worse, not better.',
    });
    fl.readout('Surface tension', () => `${(c.fluid.surfaceTension * 1000).toFixed(1)} mN/m`);
    fl.readout('Viscosity', () => `${(c.fluid.viscosity * 1000).toFixed(3)} mPa·s`);
    fl.readout('Capillary length', () => `${(capillaryLength(c.fluid) * 1000).toFixed(2)} mm`);
    fl.readout('Ohnesorge (3 mm)', () => ohnesorge(c.fluid, 0.003).toExponential(2));

    // ---- Model settings --------------------------------------------------
    const md = this.left.section('Model settings', {
      collapsed: true,
      hint:
        'Physical constants and the two calibrated coefficients. Exposed so the ' +
        'model can be audited rather than trusted.',
    });
    md.slider({
      label: 'Jet disturbance ratio ε₀/r',
      min: 0.002,
      max: 0.25,
      step: 0.002,
      decimals: 3,
      get: () => c.stream.disturbanceRatio,
      set: (v) => (c.stream.disturbanceRatio = v),
      effect: 'restart',
      hint:
        'Calibrated, not derived: sets breakup length. 0.05 puts breakup at ~20 cm, ' +
        'matching high-speed footage of anatomical nozzles.',
    });
    md.slider({
      label: 'Jet splash attenuation',
      min: 0.01,
      max: 1,
      step: 0.01,
      decimals: 2,
      get: () => c.impact.jetSplashAttenuation,
      set: (v) => (c.impact.jetSplashAttenuation = v),
      effect: 'restart',
      hint:
        'Calibrated: how much less a coherent jet splashes than a droplet train. ' +
        'The mechanism is well established, the magnitude is not.',
    });
    md.slider({
      label: 'Dry splash threshold K',
      min: 20,
      max: 120,
      step: 1,
      decimals: 0,
      get: () => c.impact.dryCriticalK,
      set: (v) => (c.impact.dryCriticalK = v),
      effect: 'restart',
      hint: 'Mundo transition, K = We^0.5·Re^0.25. Published value 57.7.',
    });
    md.slider({
      label: 'Tangential retention',
      min: 0.3,
      max: 1,
      step: 0.01,
      decimals: 2,
      get: () => c.impact.tangentialRetention,
      set: (v) => (c.impact.tangentialRetention = v),
      effect: 'restart',
      hint: 'Fraction of along-wall momentum kept on impact. High: this is why liquid sticks and runs.',
    });
    md.slider({
      label: 'Film retention thickness',
      min: 5e-6,
      max: 200e-6,
      step: 5e-6,
      display: 1e6,
      unit: 'µm',
      decimals: 0,
      get: () => c.film.retentionThickness,
      set: (v) => (c.film.retentionThickness = v),
      effect: 'restart',
      hint: 'The residual layer that never drains. Measurable on real glaze.',
    });
    md.slider({
      label: 'Capillary term strength',
      min: 0,
      max: 2,
      step: 0.05,
      decimals: 2,
      get: () => c.film.capillaryStrength,
      set: (v) => (c.film.capillaryStrength = v),
      effect: 'restart',
      hint: '0 disables rivulet formation. Set to 1 for physical behaviour.',
    });
    md.slider({
      label: 'Grid resolution across width',
      min: 32,
      max: 112,
      step: 8,
      decimals: 0,
      get: () => c.resolutionU,
      set: (v) => (c.resolutionU = Math.round(v)),
      effect: 'rebuild',
    });
    md.slider({
      label: 'Grid resolution along profile',
      min: 64,
      max: 200,
      step: 8,
      decimals: 0,
      get: () => c.resolutionV,
      set: (v) => (c.resolutionV = Math.round(v)),
      effect: 'rebuild',
    });
    md.slider({
      label: 'Random seed',
      min: 1,
      max: 9999,
      step: 1,
      decimals: 0,
      get: () => c.seed,
      set: (v) => (c.seed = Math.round(v)),
      effect: 'restart',
      hint: 'Splash is stochastic. Fixing the seed makes an A/B comparison controlled.',
    });

    // ---- Display ---------------------------------------------------------
    const disp = this.left.section('Display', { collapsed: true });
    disp.toggle({
      label: 'Show user & capture zones',
      get: () => this.showZones,
      set: (v) => {
        this.showZones = v;
        this.showUser = v;
      },
      effect: 'view',
    });
    disp.toggle({
      label: 'Show deposition heat maps',
      get: () => this.showHeatmaps,
      set: (v) => (this.showHeatmaps = v),
      effect: 'view',
    });
    disp.toggle({
      label: 'Show aim trajectory',
      get: () => this.showStreamPath,
      set: (v) => (this.showStreamPath = v),
      effect: 'view',
    });
    disp.toggle({
      label: 'Show grid wireframe',
      get: () => this.showWireframe,
      set: (v) => (this.showWireframe = v),
      effect: 'view',
    });
    disp.slider({
      label: 'Film surface relief',
      min: 0,
      max: 40,
      step: 1,
      decimals: 0,
      get: () => this.view.fixture.reliefGain,
      set: (v) => (this.view.fixture.reliefGain = v),
      effect: 'none',
      hint:
        'Visual gain on the tilt of the film surface. A 50 µm film varying across a ' +
        '3 mm cell tilts only a couple of degrees, which is real but nearly ' +
        'invisible; this exaggerates it so rivulets and waves read. Changes no physics.',
    });
    disp.slider({
      label: 'Liquid appearance',
      min: 0,
      max: 1,
      step: 0.05,
      decimals: 2,
      get: () => this.view.fixture.liquidStrength,
      set: (v) => (this.view.fixture.liquidStrength = v),
      effect: 'none',
      hint: '0 hides the film entirely, for reading a data overlay unobstructed.',
    });
    disp.select<string>({
      label: 'Droplet colour',
      options: [
        { value: '0', label: 'Provenance (jet / drops / splash)' },
        { value: '1', label: 'Speed' },
        { value: '2', label: 'Diameter' },
      ],
      get: () => String(this.view.droplets.colorMode),
      set: (v) => (this.view.droplets.colorMode = Number(v) as DropletColorMode),
      effect: 'none',
    });
    disp.slider({
      label: 'Droplet draw size',
      min: 0.4,
      max: 5,
      step: 0.1,
      decimals: 1,
      get: () => this.view.droplets.sizeScale,
      set: (v) => (this.view.droplets.sizeScale = v),
      effect: 'none',
    });
    const camRow = disp.buttonRow();
    camRow.button('3/4', () =>
      this.view.applyCameraPreset(CameraPreset.ThreeQuarter, this.sim.surface, this.sim.capture)
    );
    camRow.button('Front', () =>
      this.view.applyCameraPreset(CameraPreset.Front, this.sim.surface, this.sim.capture)
    );
    camRow.button('Side', () =>
      this.view.applyCameraPreset(CameraPreset.Side, this.sim.surface, this.sim.capture)
    );
    camRow.button('Top', () =>
      this.view.applyCameraPreset(CameraPreset.Top, this.sim.surface, this.sim.capture)
    );
    camRow.button('User eye', () =>
      this.view.applyCameraPreset(CameraPreset.UserEye, this.sim.surface, this.sim.capture)
    );
  }

  // =======================================================================
  // Right panel: results
  // =======================================================================

  private buildRightPanel(): void {
    const host = document.getElementById('right')!;
    this.right = new Panel(this);
    host.append(this.right.root);

    // ---- Headline --------------------------------------------------------
    const head = this.right.section('Splashback');
    head.readout(
      'On the user',
      () => {
        const r = this.report;
        if (!r) return this.liveUserVolume();
        return `${r.splash.userMicrolitresPerLitre.toFixed(0)} µL/L`;
      },
      'headline'
    );
    head.readout('— thrown back', () =>
      this.report ? `${(this.report.splash.userSplashVolume * 1e9).toFixed(0)} µL` : '—'
    );
    head.readout('— direct miss', () =>
      this.report ? `${(this.report.splash.userDirectVolume * 1e9).toFixed(0)} µL` : '—'
    );
    head.readout('Droplets on user', () =>
      this.report ? String(this.report.splash.userDroplets) : '—'
    );
    head.readout('Ejected at the wall', () =>
      this.report ? `${(100 * this.report.splash.splashFraction).toFixed(1)} %` : '—'
    );
    head.readout('Floor near fixture', () =>
      this.report ? `${(this.report.splash.floorNearVolume * 1e6).toFixed(2)} mL` : '—'
    );
    head.text(
      'µL/L normalises by how much was voided, so runs of different volume compare directly.'
    );
    head.raw(this.zoneBars.root);

    // ---- Impingement -----------------------------------------------------
    const imp = this.right.section('Impingement');
    imp.readout('Reachable area over 30°', () => {
      const f = this.sim.impingement.fractionOverCritical;
      return `${(100 * f).toFixed(0)} %`;
    });
    imp.readout(
      'Mean over reachable area',
      () => `${radToDeg(this.sim.impingement.meanAngle).toFixed(1)}°`
    );
    imp.readout('Where the stream landed', () => {
      const a = this.sim.metrics.actualImpingement();
      return a.impactedVolume > 0 ? `${radToDeg(a.meanAngle).toFixed(1)}° mean` : '—';
    });
    imp.readout('Arriving volume over 30°', () => {
      const a = this.sim.metrics.actualImpingement();
      return a.impactedVolume > 0
        ? `${(100 * a.fractionOverCritical).toFixed(0)} %`
        : '—';
    });
    imp.readout('Splash concentration', () => {
      const a = this.sim.metrics.actualImpingement();
      return a.hotspotShare > 0
        ? `${(100 * a.hotspotShare).toFixed(0)}% from worst 10%`
        : '—';
    });
    imp.text(
      'The map is what would happen anywhere; "where the stream landed" is what did. ' +
        'When they disagree, believe the second.'
    );

    // ---- Aim sweep -------------------------------------------------------
    const sweep = this.right.section('Aim sweep', {
      hint:
        'Local impingement angle for each aim point, traced ballistically. Pure ' +
        'geometry, so it is instant. Check this first: aim is the most sensitive ' +
        'input in the model. On the same fixture, moving the aim from the upper ' +
        'wall down into the throat raised measured splashback more than tenfold, ' +
        'because the throat fillet is steep and no wall-shape strategy governs it.',
    });
    this.sweepEl = document.createElement('div');
    sweep.raw(this.sweepEl);

    // ---- Drainage --------------------------------------------------------
    const dr = this.right.section('Drainage & hygiene');
    dr.readout('Left on the wall', () =>
      this.report ? `${(this.report.drainage.residualVolume * 1e6).toFixed(2)} mL` : this.liveFilm()
    );
    dr.readout('— avoidable', () =>
      this.report ? `${(this.report.drainage.excessVolume * 1e6).toFixed(2)} mL` : '—'
    );
    dr.readout('— retained film', () =>
      this.report ? `${(this.report.drainage.retainedFloorVolume * 1e6).toFixed(2)} mL` : '—'
    );
    dr.readout('Bulk clear time', () => {
      if (!this.report) return '—';
      const t = this.report.drainage.bulkClearTime;
      return t < 0 ? 'not within run' : `${t.toFixed(1)} s`;
    });
    dr.readout('Deepest standing liquid', () =>
      this.report ? `${(this.report.drainage.maxStandingDepth * 1000).toFixed(2)} mm` : '—'
    );
    dr.readout('Wetted area (peak)', () =>
      this.report ? `${(this.report.drainage.peakWettedArea * 1e4).toFixed(0)} cm²` : '—'
    );
    dr.readout('Stagnant area', () =>
      this.report ? `${(this.report.drainage.stagnantArea * 1e4).toFixed(0)} cm²` : '—'
    );
    dr.readout('Over 20 s residence', () =>
      this.report ? `${(this.report.drainage.scaleRiskArea * 1e4).toFixed(0)} cm²` : '—'
    );
    dr.readout('Through the drain', () =>
      this.report ? `${(this.report.drainage.drainedVolume * 1e6).toFixed(1)} mL` : '—'
    );
    dr.readout('Spilled / dripped', () =>
      this.report ? `${(this.report.drainage.spilledVolume * 1e6).toFixed(2)} mL` : '—'
    );

    // ---- Score -----------------------------------------------------------
    const sc = this.right.section('Design score');
    this.scoreEl = document.createElement('div');
    this.scoreEl.className = 'score-ring';
    sc.raw(this.scoreEl);
    this.notesEl = document.createElement('ul');
    this.notesEl.className = 'note-list';
    sc.raw(this.notesEl);
    sc.text(
      'Weighted 40% splash, 25% impingement, 20% drainage, 15% hygiene. Parts shown ' +
        'because the total is a convenience, not a verdict.'
    );

    // ---- Charts ----------------------------------------------------------
    const ch = this.right.section('Time series');
    const m = () => this.sim.metrics.samples;
    const marker = () =>
      this.sim.metrics.flowEndTime >= 0
        ? [{ t: this.sim.metrics.flowEndTime, label: 'flow ends', color: '#ffd166' }]
        : [];

    const c1 = new Chart({
      title: 'Flow rate (mL/s) · film volume (mL)',
      leftLabel: 'mL/s',
      rightLabel: 'mL',
      count: () => m().length,
      time: (i) => m()[i].t,
      markers: marker,
      series: [
        { label: 'flow', color: '#35e0ff', value: (i) => m()[i].flowRate * 1e6 },
        { label: 'film', color: '#4ade9b', value: (i) => m()[i].filmVolume * 1e6, axis: 'right' },
      ],
    });
    const c2 = new Chart({
      title: 'Cumulative on user (µL) · drained (mL)',
      leftLabel: 'µL',
      rightLabel: 'mL',
      count: () => m().length,
      time: (i) => m()[i].t,
      markers: marker,
      series: [
        { label: 'on user', color: '#ff5a3c', value: (i) => m()[i].userVolume * 1e9 },
        { label: 'drained', color: '#8fa3b8', value: (i) => m()[i].drainedVolume * 1e6, axis: 'right' },
      ],
    });
    const c3 = new Chart({
      title: 'Airborne (µL) · live droplets',
      leftLabel: 'µL',
      rightLabel: 'count',
      count: () => m().length,
      time: (i) => m()[i].t,
      markers: marker,
      series: [
        { label: 'airborne', color: '#ffd166', value: (i) => m()[i].airborneVolume * 1e9 },
        { label: 'droplets', color: '#a78bfa', value: (i) => m()[i].particles, axis: 'right' },
      ],
    });
    this.charts = [c1, c2, c3];
    for (const c of this.charts) ch.raw(c.canvas);

    // ---- Report ----------------------------------------------------------
    const rep = this.right.section('Report', { collapsed: true });
    this.reportEl = document.createElement('pre');
    this.reportEl.className = 'report';
    this.reportEl.textContent = 'Run a full analysis to produce a report.';
    rep.raw(this.reportEl);
    const repRow = rep.buttonRow();
    repRow.button('Copy', () => {
      void navigator.clipboard?.writeText(this.reportEl.textContent ?? '');
    });
    repRow.button('Download .txt', () => this.downloadReport());
  }

  private liveUserVolume(): string {
    const s = this.sim.stats();
    const litres = Math.max(1e-9, this.sim.metrics.emittedVolume) * 1000;
    return `${((s.userVolume * 1e9) / litres).toFixed(0)} µL/L*`;
  }

  private liveFilm(): string {
    return `${(this.sim.film.totalVolume() * 1e6).toFixed(2)} mL*`;
  }

  // =======================================================================
  // Transport
  // =======================================================================

  private buildTransport(): void {
    const host = document.getElementById('transport')!;
    this.transport = new Panel(this, 'transport-inner');
    host.append(this.transport.root);
    this.transport.root.style.display = 'flex';
    this.transport.root.style.alignItems = 'center';
    this.transport.root.style.gap = '12px';
    this.transport.root.style.width = '100%';

    this.playBtn = this.transport.button('▶ Play', () => this.togglePlay(), 'primary');
    this.transport.button('Restart', () => {
      this.sim.restart();
      this.report = null;
      this.refreshGeometryDependent();
    });
    this.transport.button('Step 0.1 s', () => {
      for (let i = 0; i < 100 && this.sim.phase !== SimPhase.Finished; i++) this.sim.step();
      this.sim.sample();
    });

    const speedSel = document.createElement('select');
    speedSel.style.width = 'auto';
    for (const s of [0.1, 0.25, 0.5, 1, 2, 4]) {
      const o = document.createElement('option');
      o.value = String(s);
      o.textContent = `${s}×`;
      speedSel.append(o);
    }
    speedSel.value = '1';
    speedSel.addEventListener('change', () => (this.speed = Number(speedSel.value)));
    this.transport.raw(speedSel);

    this.phasePill = document.createElement('span');
    this.phasePill.className = 'phase-pill';
    this.transport.raw(this.phasePill);

    const bar = document.createElement('div');
    bar.className = 'timebar';
    this.timeFill = document.createElement('div');
    this.timeFill.className = 'timebar-fill';
    this.voidMark = document.createElement('div');
    this.voidMark.className = 'timebar-void';
    bar.append(this.timeFill, this.voidMark);
    this.transport.raw(bar);

    const time = document.createElement('span');
    time.className = 'phase-pill';
    this.transport.raw(time);
    this.timeLabel = time;
  }

  private timeLabel!: HTMLElement;

  private togglePlay(): void {
    if (this.sim.phase === SimPhase.Finished) {
      this.sim.restart();
      this.report = null;
      this.refreshGeometryDependent();
    }
    this.running = !this.running;
    this.playBtn.textContent = this.running ? '❚❚ Pause' : '▶ Play';
    this.lastFrame = performance.now();
  }

  // =======================================================================
  // Aim sweep
  // =======================================================================

  /**
   * For each candidate aim point, trace the stream and report the impingement
   * angle where it actually lands.
   *
   * Pure geometry plus a ballistic arc, so it costs microseconds and needs no
   * simulation. That makes it the fastest useful feedback in the tool: it answers
   * "where should this be aimed, and does any aim work at all on this shape"
   * before committing to a run. If every row is over the criterion, the geometry
   * is wrong and no amount of aiming will save it.
   */
  private runAimSweep(): void {
    const rows: Array<{ v: number; angle: number; y: number; ok: boolean }> = [];
    const saveEl = this.sim.config.stream.aimElevation;
    const saveAz = this.sim.config.stream.aimAzimuth;

    for (let k = 0; k <= 12; k++) {
      const v = 0.04 + (k / 12) * 0.5;
      const nv = this.sim.surface.nv;
      const nu = this.sim.surface.nu;
      const j = Math.min(nv - 1, Math.max(0, Math.round(v * (nv - 1))));
      const cell = j * nu + Math.floor(nu / 2);
      const target = this.sim.surface.getCellPos(cell, v3());
      const tPeak = this.sim.emitter.flow.peakFraction * this.sim.emitter.flow.duration;
      const sol = this.sim.emitter.solveAimForTarget(target, tPeak, GRAVITY);
      if (!sol) continue;
      // Fly the solved trajectory and take the angle at the first real contact,
      // which may not be the intended cell if the lip or hood gets in the way.
      const speed = this.sim.emitter.speedAt(tPeak);
      const ce = Math.cos(sol.elevation);
      const dir = v3(
        ce * Math.sin(sol.azimuth),
        Math.sin(sol.elevation),
        -ce * Math.cos(sol.azimuth)
      );
      const o = this.sim.emitter.position;
      let prev = v3(o.x, o.y, o.z);
      let landed: { angle: number; y: number } | null = null;
      for (let i = 1; i <= 300; i++) {
        const t = i * 0.003;
        const p = v3(
          o.x + dir.x * speed * t,
          o.y + dir.y * speed * t - 0.5 * GRAVITY * t * t,
          o.z + dir.z * speed * t
        );
        const seg = v3(p.x - prev.x, p.y - prev.y, p.z - prev.z);
        const hit = this.sim.surface.raycast(prev, seg, 1);
        if (hit) {
          const vel = v3(seg.x, seg.y, seg.z);
          landed = {
            angle: this.sim.surface.impingementAngle(hit.cell, vel),
            y: hit.point.y,
          };
          break;
        }
        prev = p;
        if (p.y < this.sim.surface.floorY) break;
      }
      if (!landed) continue;
      rows.push({
        v,
        angle: landed.angle,
        y: landed.y,
        ok: landed.angle <= CRITICAL_IMPINGEMENT_ANGLE,
      });
    }

    this.sim.config.stream.aimElevation = saveEl;
    this.sim.config.stream.aimAzimuth = saveAz;
    this.sim.emitter.params.aimElevation = saveEl;
    this.sim.emitter.params.aimAzimuth = saveAz;

    // Render.
    this.sweepEl.replaceChildren();
    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No aim point on this geometry is reachable at the current exit speed.';
      this.sweepEl.append(p);
      return;
    }
    let best = rows[0];
    for (const r of rows) if (r.angle < best.angle) best = r;

    const table = document.createElement('table');
    table.className = 'sweep-table';
    const thead = document.createElement('tr');
    for (const h of ['aim v', 'height', 'angle']) {
      const th = document.createElement('th');
      th.textContent = h;
      thead.append(th);
    }
    table.append(thead);
    for (const r of rows) {
      const tr = document.createElement('tr');
      if (r === best) tr.className = 'best';
      else if (!r.ok) tr.className = 'over';
      const cells = [
        r.v.toFixed(2),
        `${(r.y * 1000).toFixed(0)} mm`,
        `${radToDeg(r.angle).toFixed(1)}°`,
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      table.append(tr);
    }
    this.sweepEl.append(table);

    const summary = document.createElement('p');
    summary.className = 'hint';
    const nOk = rows.filter((r) => r.ok).length;
    summary.textContent =
      `Best aim v=${best.v.toFixed(2)} at ${radToDeg(best.angle).toFixed(1)}°. ` +
      `${nOk} of ${rows.length} aim points meet the 30° criterion.`;
    this.sweepEl.append(summary);

    const btn = document.createElement('button');
    btn.className = 'btn wide';
    btn.textContent = `Use best aim (v=${best.v.toFixed(2)})`;
    btn.addEventListener('click', () => {
      this.sim.config.aimTargetV = best.v;
      this.apply('aim');
    });
    this.sweepEl.append(btn);
  }

  // =======================================================================
  // Analysis
  // =======================================================================

  /**
   * Full-resolution headless run, chunked so the browser stays responsive.
   *
   * Run at higher grid resolution than interactive playback and with the whole
   * drain phase included, because the drainage metrics need the film to actually
   * settle. Chunking by wall-clock time rather than by step count keeps the frame
   * budget stable regardless of how expensive the current geometry happens to be.
   */
  private async runAnalysis(): Promise<void> {
    if (this.analysing) return;
    this.analysing = true;
    this.running = false;
    this.playBtn.textContent = '▶ Play';
    const prog = document.getElementById('progress')!;
    const fill = prog.querySelector('.progress-fill') as HTMLElement;
    const label = prog.querySelector('.progress-label') as HTMLElement;
    prog.classList.remove('hidden');

    const cfg = this.sim.config;
    const savedU = cfg.resolutionU;
    const savedV = cfg.resolutionV;
    cfg.resolutionU = Math.max(savedU, 72);
    cfg.resolutionV = Math.max(savedV, 132);
    this.sim.rebuild();
    this.view.setGeometry(this.sim.surface, this.sim.capture);
    this.sim.restart();

    const total = this.sim.totalDuration;
    let n = 0;
    const chunk = () =>
      new Promise<void>((resolve) => {
        const t0 = performance.now();
        while (!this.sim.isFinished() && performance.now() - t0 < 24) {
          this.sim.step();
          if (n % 40 === 0) this.sim.sample();
          n++;
        }
        resolve();
      });

    while (!this.sim.isFinished()) {
      await chunk();
      const frac = Math.min(1, this.sim.time / total);
      fill.style.width = `${(frac * 100).toFixed(1)}%`;
      label.textContent = `Running analysis… ${this.sim.time.toFixed(1)} s of ${total.toFixed(0)} s`;
      this.updateFixtureField();
      this.view.updateHeatmaps(this.sim.metrics.floorMap, this.sim.metrics.bodyMap);
      this.view.droplets.update(this.sim.particles);
      this.view.render();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    this.sim.sample();
    this.report = this.sim.report();

    cfg.resolutionU = savedU;
    cfg.resolutionV = savedV;
    prog.classList.add('hidden');
    this.analysing = false;
    this.paintReport();
    this.right.refresh();
    this.updateCharts();
  }

  private paintReport(): void {
    const r = this.report;
    if (!r) return;
    const p = getPreset(this.presetId);
    const lines: string[] = [];
    lines.push('URINAL FLOW LAB — DESIGN REPORT');
    lines.push('='.repeat(52));
    lines.push(`design         ${p.name}`);
    lines.push(`fluid          ${this.sim.config.fluid.name}`);
    lines.push(`wall           ${this.sim.config.wall.name}`);
    lines.push(
      `void           ${(r.voidedVolume * 1e6).toFixed(0)} mL at ` +
        `${(this.sim.config.stream.peakFlowRate * 1e6).toFixed(1)} mL/s peak, ` +
        `${this.sim.emitter.flow.duration.toFixed(1)} s`
    );
    lines.push(
      `posture        ${(this.sim.config.posture.standoff * 1000).toFixed(0)} mm stand-off, ` +
        `exit ${(this.sim.config.posture.emitterHeight * 1000).toFixed(0)} mm above floor`
    );
    const bu = this.sim.emitter.breakupAt(
      this.sim.emitter.flow.peakFraction * this.sim.emitter.flow.duration
    );
    lines.push(
      `stream         breakup at ${(bu.breakupLength * 100).toFixed(1)} cm, ` +
        `droplets ${(bu.mainDropletDiameter * 1000).toFixed(2)} mm at ` +
        `${bu.emissionFrequency.toFixed(0)} Hz`
    );
    lines.push('');
    lines.push('RESULTS');
    lines.push('-'.repeat(52));
    for (const l of r.lines) lines.push(l);
    const act = this.sim.metrics.actualImpingement();
    lines.push('');
    lines.push(
      `where the stream landed: mean ${radToDeg(act.meanAngle).toFixed(1)}°, ` +
        `p90 ${radToDeg(act.p90Angle).toFixed(1)}°, ` +
        `${(100 * act.fractionOverCritical).toFixed(0)}% of arriving volume over 30°`
    );
    lines.push(
      `splash concentrated at profile v=${act.splashCentroidV.toFixed(3)}; ` +
        `worst 10% of cells produce ${(100 * act.hotspotShare).toFixed(0)}% of it`
    );
    lines.push('');
    lines.push('SCORE');
    lines.push('-'.repeat(52));
    lines.push(`total          ${r.score.total.toFixed(1)} / 100`);
    lines.push(`  splash       ${r.score.splashScore.toFixed(0)}`);
    lines.push(`  impingement  ${r.score.angleScore.toFixed(0)}`);
    lines.push(`  drainage     ${r.score.drainageScore.toFixed(0)}`);
    lines.push(`  hygiene      ${r.score.hygieneScore.toFixed(0)}`);
    for (const n of r.score.notes) lines.push(`  ! ${n}`);
    lines.push('');
    lines.push('SOLVER');
    lines.push('-'.repeat(52));
    lines.push(
      `volume closure error   ${(100 * r.volumeClosureError).toFixed(4)} %  ` +
        `(every drop emitted accounted for)`
    );
    lines.push(
      `grid                   ${this.sim.surface.nu} × ${this.sim.surface.nv} cells, ` +
        `${(this.sim.surface.totalArea * 1e4).toFixed(0)} cm² wetted-capable area`
    );
    lines.push(`film substep overruns  ${this.sim.film.substepBudgetExceeded}`);
    lines.push(`sanitised cells        ${this.sim.film.sanitisedCells}`);
    lines.push(`particle high-water    ${this.sim.particles.highWater}`);
    lines.push(
      `simulated ${r.simulatedTime.toFixed(1)} s in ${(r.wallClockMs / 1000).toFixed(1)} s wall clock`
    );
    if (this.sim.surface.profile.info.notes.length) {
      lines.push('');
      lines.push('GEOMETRY NOTES');
      lines.push('-'.repeat(52));
      for (const n of this.sim.surface.profile.info.notes) lines.push(`  ${n}`);
    }
    this.reportEl.textContent = lines.join('\n');
  }

  private downloadReport(): void {
    const text = this.reportEl.textContent ?? '';
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `urinal-report-${this.presetId}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // =======================================================================
  // Frame loop
  // =======================================================================

  private frame = (): void => {
    const now = performance.now();
    const dtReal = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.running && !this.analysing && !this.sim.isFinished()) {
      // Advance by wall-clock budget, not by a fixed step count. If the geometry
      // is expensive the sim falls behind real time gracefully instead of
      // dropping the frame rate to single digits.
      const targetTime = this.sim.time + dtReal * this.speed;
      const t0 = performance.now();
      while (
        this.sim.time < targetTime &&
        performance.now() - t0 < 13 &&
        !this.sim.isFinished()
      ) {
        this.sim.step();
        if (this.sim.time >= this.nextSampleAt) {
          this.sim.sample();
          this.nextSampleAt = this.sim.time + 0.05;
        }
      }
      if (this.sim.isFinished()) {
        this.running = false;
        this.playBtn.textContent = '▶ Play';
        this.sim.sample();
        this.report = this.sim.report();
        this.paintReport();
        this.right.refresh();
      }
    }

    this.view.updateLiquid(
      this.sim.particles,
      this.sim.emitter.position,
      this.sim.emitter.diameterAt(this.sim.time)
    );

    // Field and heat map updates are the expensive part of drawing; 12 Hz is
    // fast enough to read and leaves the budget to the physics.
    if (now - this.lastHeavyUpdate > 80) {
      this.lastHeavyUpdate = now;
      this.updateFixtureField();
      this.view.updateHeatmaps(this.sim.metrics.floorMap, this.sim.metrics.bodyMap);
      this.updateCharts();
    }
    if (now - this.lastReadoutUpdate > 130) {
      this.lastReadoutUpdate = now;
      this.updateHud();
      this.updateTransport();
      this.updateZoneBars();
      this.updateScore();
      if (!this.report) this.right.refresh();
    }

    this.view.render();
    requestAnimationFrame(this.frame);
  };

  private updateFixtureField(): void {
    this.view.fixture.update(
      this.sim.film,
      this.sim.metrics,
      this.sim.impingement.angle,
      this.sim.impingement.shadowed,
      this.sim.time
    );
  }

  private updateCharts(): void {
    for (const c of this.charts) c.draw();
  }

  private updateHud(): void {
    const s = this.sim.stats();
    const tPeak = this.sim.emitter.flow.peakFraction * this.sim.emitter.flow.duration;
    const bu = this.sim.emitter.breakupAt(Math.min(this.sim.time || tPeak, tPeak));
    const dist = this.distanceToWall();
    const coherentAtWall = dist > 0 && bu.breakupLength > dist;
    this.hudEl.innerHTML =
      `droplets <b>${s.particles}</b><br>` +
      `coherent <b>${s.coherent}</b> · splash <b>${s.secondaries}</b><br>` +
      `film <b>${(s.filmVolume * 1e6).toFixed(2)} mL</b><br>` +
      `airborne <b>${(s.airborne * 1e9).toFixed(0)} µL</b><br>` +
      `drained <b>${(s.drained * 1e6).toFixed(1)} mL</b><br>` +
      `on user <b>${(s.userVolume * 1e9).toFixed(0)} µL</b><br>` +
      `breakup <b>${(bu.breakupLength * 100).toFixed(0)} cm</b> / reach ` +
      `<b>${(dist * 100).toFixed(0)} cm</b>`;

    // The single most actionable live hint in the tool.
    if (coherentAtWall) {
      this.noteEl.classList.add('show');
      this.noteEl.textContent =
        'The stream is still a coherent jet when it reaches the wall ' +
        `(breakup at ${(bu.breakupLength * 100).toFixed(0)} cm, wall at ` +
        `${(dist * 100).toFixed(0)} cm). A jet spreads into an attached sheet ` +
        'instead of firing a corona, which is why standing closer helps.';
    } else if (dist > 0) {
      this.noteEl.classList.add('show');
      this.noteEl.textContent =
        `The stream has broken into droplets before it reaches the wall ` +
        `(breakup at ${(bu.breakupLength * 100).toFixed(0)} cm, wall at ` +
        `${(dist * 100).toFixed(0)} cm). Every droplet arrival throws its own ` +
        'corona — this is the splash-prone regime.';
    } else {
      this.noteEl.classList.remove('show');
    }
  }

  /** Straight-line distance from the exit to the first contact with the fixture. */
  private distanceToWall(): number {
    const o = this.sim.emitter.position;
    const tPeak = this.sim.emitter.flow.peakFraction * this.sim.emitter.flow.duration;
    const speed = this.sim.emitter.speedAt(tPeak);
    if (speed <= 1e-4) return 0;
    const dir = this.sim.emitter.aimDirection();
    let prev = v3(o.x, o.y, o.z);
    let dist = 0;
    for (let i = 1; i <= 300; i++) {
      const t = i * 0.003;
      const p = v3(
        o.x + dir.x * speed * t,
        o.y + dir.y * speed * t - 0.5 * GRAVITY * t * t,
        o.z + dir.z * speed * t
      );
      const seg = v3(p.x - prev.x, p.y - prev.y, p.z - prev.z);
      const segLen = Math.hypot(seg.x, seg.y, seg.z);
      const hit = this.sim.surface.raycast(prev, seg, 1);
      if (hit) return dist + segLen * hit.t;
      dist += segLen;
      prev = p;
      if (p.y < this.sim.surface.floorY) break;
    }
    return 0;
  }

  private updateTransport(): void {
    const total = this.sim.totalDuration;
    const frac = clamp(this.sim.time / Math.max(1e-6, total), 0, 1);
    this.timeFill.style.width = `${(frac * 100).toFixed(1)}%`;
    this.voidMark.style.left = `${((this.sim.voidDuration / total) * 100).toFixed(1)}%`;
    const names = ['idle', 'voiding', 'draining', 'finished'];
    const cls = ['', 'voiding', 'draining', 'finished'];
    this.phasePill.textContent = names[this.sim.phase];
    this.phasePill.className = `phase-pill ${cls[this.sim.phase]}`;
    this.timeLabel.textContent = `${this.sim.time.toFixed(1)} / ${total.toFixed(0)} s`;
  }

  private updateZoneBars(): void {
    const zones = this.sim.metrics.perZone;
    const colors = ['#5b6b7d', '#3f4c5a', '#ff5a3c', '#ff7a3c', '#ffa03c', '#7c8ea1'];
    this.zoneBars.set(
      zones.map((z, i) => ({
        label: ZONE_NAMES[i],
        value: z.volume,
        display: z.volume > 5e-10 ? `${(z.volume * 1e9).toFixed(0)} µL` : '—',
        color: colors[i],
      }))
    );
  }

  private updateScore(): void {
    const r = this.report;
    this.scoreEl.replaceChildren();
    this.notesEl.replaceChildren();
    if (!r) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Run a full analysis for a score.';
      this.scoreEl.append(p);
      return;
    }
    const num = document.createElement('div');
    num.className = 'score-num';
    num.textContent = r.score.total.toFixed(0);
    const parts = document.createElement('div');
    parts.className = 'score-parts';
    const rows: Array<[string, number]> = [
      ['splash', r.score.splashScore],
      ['angle', r.score.angleScore],
      ['drainage', r.score.drainageScore],
      ['hygiene', r.score.hygieneScore],
    ];
    for (const [label, val] of rows) {
      const row = document.createElement('div');
      row.className = 'score-part';
      const l = document.createElement('span');
      l.textContent = label;
      const t = document.createElement('div');
      t.className = 't';
      const f = document.createElement('div');
      f.className = 'f';
      f.style.width = `${clamp(val, 0, 100).toFixed(0)}%`;
      f.style.background = toCss(sample(ColorScale.Impingement, 1 - val / 100, 0.45));
      t.append(f);
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = val.toFixed(0);
      row.append(l, t, n);
      parts.append(row);
    }
    this.scoreEl.append(num, parts);
    for (const note of r.score.notes) {
      const li = document.createElement('li');
      li.textContent = note;
      this.notesEl.append(li);
    }
  }

  private updateLegend(): void {
    const info: FieldInfo = this.view.fixture.info;
    this.legendEl.replaceChildren();
    // The two appearance-only modes have no scale to show.
    if (
      this.view.fixture.mode === FieldMode.Liquid ||
      this.view.fixture.mode === FieldMode.Dry
    ) {
      const t = document.createElement('div');
      t.className = 'legend-title';
      t.textContent = info.label;
      const d = document.createElement('p');
      d.className = 'legend-desc';
      d.textContent = info.description;
      this.legendEl.append(t, d);
      return;
    }

    const title = document.createElement('div');
    title.className = 'legend-title';
    title.textContent = `${info.label}${info.unit ? ` (${info.unit})` : ''}`;

    // Position along the bar for a value, honouring a log axis. Without this the
    // criterion tick and the mid-scale label would sit at the wrong place on the
    // logarithmic fields and quietly mislabel the colours they point at.
    const posOf = (value: number): number => {
      if (info.log) {
        const lo = Math.log(Math.max(info.min, 1e-12));
        const hi = Math.log(Math.max(info.max, 1e-12));
        return (Math.log(Math.max(value, 1e-12)) - lo) / Math.max(1e-9, hi - lo);
      }
      return (value - info.min) / Math.max(1e-9, info.max - info.min);
    };

    const bar = document.createElement('div');
    bar.className = 'legend-bar';
    const criticalT = Number.isFinite(info.critical) ? posOf(info.critical) : 0.5;
    const stops: string[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      stops.push(`${toCss(sample(info.scale, t, criticalT))} ${(t * 100).toFixed(0)}%`);
    }
    bar.style.background = `linear-gradient(to right, ${stops.join(',')})`;
    if (Number.isFinite(info.critical)) {
      const tick = document.createElement('div');
      tick.className = 'legend-tick';
      tick.style.left = `${(criticalT * 100).toFixed(1)}%`;
      tick.title = `criterion ${info.critical.toFixed(0)}${info.unit}`;
      bar.append(tick);
    }

    const fmt = (v: number): string => {
      const a = Math.abs(v);
      if (a === 0) return '0';
      if (a < 0.01) return v.toExponential(1);
      if (a < 10) return v.toFixed(2);
      if (a < 1000) return v.toFixed(0);
      return v.toExponential(1);
    };

    const scale = document.createElement('div');
    scale.className = 'legend-scale';
    const lo = document.createElement('span');
    lo.textContent = fmt(info.min);
    const mid = document.createElement('span');
    // Geometric midpoint on a log axis, arithmetic on a linear one.
    mid.textContent = info.log
      ? fmt(Math.sqrt(info.min * info.max))
      : fmt(0.5 * (info.min + info.max));
    mid.style.color = 'var(--text-faint)';
    const hi = document.createElement('span');
    hi.textContent = fmt(info.max);
    scale.append(lo, mid, hi);
    if (info.log) {
      const tag = document.createElement('span');
      tag.textContent = 'log';
      tag.style.color = 'var(--text-faint)';
      scale.append(tag);
    }
    if (Number.isFinite(info.critical)) {
      const crit = document.createElement('span');
      crit.textContent = `◄ ${info.critical.toFixed(0)}${info.unit} criterion`;
      crit.style.color = 'var(--warn)';
      scale.append(crit);
    }

    const desc = document.createElement('p');
    desc.className = 'legend-desc';
    desc.textContent = info.description;

    this.legendEl.append(title, bar, scale, desc);
  }

  private updateGeometryNotes(): void {
    const info = this.sim.surface.profile.info;
    if (info.selfIntersects) {
      this.noteEl.classList.add('show');
      this.noteEl.textContent =
        'Profile self-intersects — this shape is not manufacturable and the ' +
        'surface parameterisation is invalid. Reduce the front lip height or the ' +
        'wall overhang.';
    }
  }
}
