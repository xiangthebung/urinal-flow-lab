import { CRITICAL_IMPINGEMENT_ANGLE, GRAVITY } from '../core/constants';
import { FLUID_PRESETS, WALL_MATERIALS, capillaryLength, ohnesorge } from '../core/fluid';
import { clamp, radToDeg, v3 } from '../core/vec3';
import { PRESETS, getPreset } from '../geometry/presets';
import { ColorScale, sample, toCss } from '../render/colormap';
import { DropletColorMode } from '../render/dropletView';
import { FieldInfo, FieldMode } from '../render/fixtureView';
import { CameraPreset, SceneView } from '../render/sceneView';
import { ZONE_NAMES } from '../sim/capture';
import { FLOW_PHASE_NAMES, FlowPhase } from '../sim/metrics';
import {
  AimTrace,
  RunReport,
  SimPhase,
  Simulation,
  defaultConfig,
} from '../sim/simulation';
import { LabProbe } from './automation';
import { BarList, Chart } from './charts';
import { Effect, Panel } from './controls';
import { drawFixtureThumbnail } from './thumbnail';

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
  // Public because the offline screenshot harness drives them. See
  // src/ui/automation.ts for the reasoning: without a way to render the real
  // WebGL viewport headlessly there is no way to verify that a change to the
  // geometry actually looks right in the product, and reviewing a fixture mesh
  // in isolation is not the same claim.
  readonly sim: Simulation;
  readonly view: SceneView;
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

  private showShell = true;
  private showZones = true;
  private showUser = true;
  private showHeatmaps = true;
  private showStreamPath = true;
  private showWireframe = false;

  constructor() {
    const cfg = defaultConfig();
    cfg.surface = { ...getPreset(this.presetId).params };
    cfg.casting = { ...(getPreset(this.presetId).shell ?? {}) };
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
    this.view.setGeometry(this.sim.surface, this.sim.casting, this.sim.capture);
    this.view.applyCameraPreset(CameraPreset.ThreeQuarter, this.sim.surface, this.sim.capture);

    this.legendEl = document.getElementById('legend')!;
    this.hudEl = document.getElementById('hud')!;
    this.noteEl = document.getElementById('overlay-note')!;

    this.buildTopbar();
    this.buildViewTabs();
    this.buildLeftPanel();
    this.buildRightPanel();
    this.buildTransport();
    this.buildAimPicking();

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
        this.view.setGeometry(this.sim.surface, this.sim.casting, this.sim.capture);
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

  /**
   * Redraw the aim trajectory for the conditions in force right now.
   *
   * It used to be drawn once, for the exit speed at peak flow, and then left alone
   * for the whole run. Exit speed varies by more than a factor of two across a void
   * -- 1.5 m/s at t = 0.9 s against 3.1 m/s at the peak on the default flow curve --
   * so for most of the run the dashed line sat a long way from the droplets actually
   * on screen. Both were right; the picture said the trajectory model was broken.
   * Before flow starts there is no current speed to use, so the peak is the honest
   * choice there.
   */
  private updateStreamPath(): void {
    const flow = this.sim.emitter.flow;
    const t =
      this.sim.phase === SimPhase.Voiding && this.sim.time > 0
        ? Math.min(this.sim.time, flow.duration)
        : flow.peakFraction * flow.duration;
    this.aimTrace = this.sim.traceAim(t);
    this.view.updateStreamPath(this.aimTrace);
  }

  /** Latest aim trace, shared by the trajectory line and the aim readouts. */
  private aimTrace: AimTrace | null = null;

  /** Set the aim target and re-solve the launch angles for it. */
  setAimTarget(u: number, v: number): void {
    this.sim.config.aimTargetU = clamp(u, -1, 1);
    this.sim.config.aimTargetV = clamp(v, 0, 1);
    this.apply('aim');
  }

  /**
   * Aim by clicking the fixture.
   *
   * This replaced a pair of abstract numbers, and the reason is that aim is the
   * most sensitive input in the whole model while being the least legible as a
   * scalar. "Profile fraction 0.18" is not a thing anyone can picture; a spot on
   * the back wall is. Dragging it makes the relationship between where the stream
   * lands and what comes back at you something you can feel out in a few seconds,
   * which is the entire question the tool exists to answer.
   *
   * The pick is resolved against the wetted interior only. Clicking the outside of
   * the casting is not a legal aim target -- there is nothing to aim *at* there --
   * so a miss leaves the aim alone rather than snapping it somewhere arbitrary.
   */
  private pickAimAt(clientX: number, clientY: number): boolean {
    const canvas = document.getElementById('gl') as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const ndcX = ((clientX - r.left) / r.width) * 2 - 1;
    const ndcY = -(((clientY - r.top) / r.height) * 2 - 1);
    const ray = this.view.rayThrough(ndcX, ndcY);
    const hit = this.sim.surface.raycast(ray.origin, ray.dir, 1);
    if (!hit) return false;
    const uv = this.sim.surface.uvOfCell(hit.cell);
    this.setAimTarget(uv.u, uv.v);
    return true;
  }

  /**
   * Wire up aim picking.
   *
   * Held behind a modifier-free drag on the canvas would fight the orbit
   * controls, so aiming is a deliberate mode: armed by the "Aim" button or by
   * holding Shift. While armed the cursor changes and orbiting is suspended, so
   * there is never any doubt about which gesture is in force.
   */
  private buildAimPicking(): void {
    const canvas = document.getElementById('gl') as HTMLCanvasElement;

    const armed = (e: MouseEvent): boolean => this.aimMode || e.shiftKey;
    const setCursor = () => {
      canvas.style.cursor = this.aimMode ? 'crosshair' : '';
      this.view.controls.enabled = !this.aimMode;
    };
    this.refreshAimCursor = setCursor;

    let dragging = false;
    canvas.addEventListener('pointerdown', (e) => {
      if (!armed(e) || e.button !== 0) return;
      dragging = true;
      this.view.controls.enabled = false;
      this.pickAimAt(e.clientX, e.clientY);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.pickAimAt(e.clientX, e.clientY);
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      this.view.controls.enabled = !this.aimMode;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointerleave', end);
    // Shift held with no aim mode should still show the crosshair, so the
    // shortcut is discoverable rather than secret.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift' && !this.aimMode) canvas.style.cursor = 'crosshair';
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift' && !this.aimMode) canvas.style.cursor = '';
    });
  }

  private aimMode = false;
  private refreshAimCursor: () => void = () => {};

  private refreshGeometryDependent(): void {
    this.nextSampleAt = 0;
    this.updateFixtureField();
    this.updateStreamPath();
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
    this.view.fixture.setShellVisible(this.showShell);
  }

  /** Scene furniture, so a shot or an inspection can isolate one thing. */
  setOverlays(o: {
    zones?: boolean;
    heatmaps?: boolean;
    streamPath?: boolean;
    wireframe?: boolean;
    shell?: boolean;
  }): void {
    if (o.zones !== undefined) {
      this.showZones = o.zones;
      this.showUser = o.zones;
    }
    if (o.heatmaps !== undefined) this.showHeatmaps = o.heatmaps;
    if (o.streamPath !== undefined) this.showStreamPath = o.streamPath;
    if (o.wireframe !== undefined) this.showWireframe = o.wireframe;
    if (o.shell !== undefined) this.showShell = o.shell;
    this.applyViewToggles();
  }

  /**
   * Measurements a screenshot cannot assert on.
   *
   * The interior and casting extents are reported side by side on purpose. The
   * whole family of clipping faults on this project came from the two being
   * different and only the interior being consulted, so having both in one place
   * makes the discrepancy something that can be checked rather than noticed.
   */
  probe(): LabProbe {
    const ib = this.sim.surface.bounds();
    const cb = this.view.castingBounds;
    const e = this.sim.emitter.position;
    return {
      model: this.presetId,
      time: this.sim.time,
      phase: this.sim.phase,
      droplets: this.sim.particles.count,
      emitter: [e.x, e.y, e.z],
      interior: [ib.min.x, ib.min.y, ib.min.z, ib.max.x, ib.max.y, ib.max.z],
      casting: cb
        ? [cb.min.x, cb.min.y, cb.min.z, cb.max.x, cb.max.y, cb.max.z]
        : null,
      interiorFrontZ: ib.max.z,
      castingFrontZ: cb ? cb.max.z : null,
      captureFrontZ: this.sim.capture.fixtureFrontZ,
      floorY: this.sim.surface.floorY,
      degenerateCells: this.sim.surface.degenerateCells,
      selfIntersects: this.sim.surface.profile.info.selfIntersects,
    };
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
    const label = document.createElement('span');
    label.className = 'topbar-model';
    const desc = document.createElement('span');
    desc.className = 'hint';
    desc.style.flex = '1';
    desc.style.minWidth = '0';
    this.paintTopbarModel = () => {
      const p = getPreset(this.presetId);
      label.textContent = p.name;
      desc.textContent = p.summary;
    };
    this.paintTopbarModel();
    slot.append(label, desc);

    const actions = document.getElementById('topbar-actions')!;
    const analyse = document.createElement('button');
    analyse.className = 'btn primary';
    analyse.textContent = 'Run full analysis';
    analyse.addEventListener('click', () => this.runAnalysis());
    actions.append(analyse);
  }

  private paintTopbarModel: () => void = () => {};

  /**
   * Load a fixture.
   *
   * A fresh copy of the parameters each time, because the presets are shared
   * objects: handing out the original would let anything that writes into the live
   * config leak into every later load of that model.
   */
  selectPreset(id: string): void {
    if (id === this.presetId) return;
    this.presetId = id;
    this.sim.config.surface = { ...getPreset(id).params };
    this.sim.config.casting = { ...(getPreset(id).shell ?? {}) };
    this.paintTopbarModel();
    this.paintModelCards();
    this.apply('rebuild');
  }

  // =======================================================================
  // Fixture picker
  // =======================================================================

  /**
   * The fixture library, as a grid of cards.
   *
   * This replaced about forty sliders that between them defined the bowl: rim
   * height, bowl depth, three widths, two section exponents, wall mode and tilt and
   * run, throat, sump depth and gradient, drain position and radius, lip height and
   * curl, hood, rib pattern and amplitude and wavelength. They were expressive but
   * they were the wrong interface for the question the tool answers -- nobody
   * evaluating splashback wants to author a bowl from thirty numbers, and almost
   * every combination of them is not a fixture anyone would make. Six real
   * fixtures, each shown as the shape it actually is, get to a comparison faster and
   * the comparison means more.
   *
   * The stream, the user's posture, the fluid and the model coefficients are all
   * still adjustable. Those are the experiment, not the fixture.
   */
  private buildModelPicker(parent: Panel): void {
    const grid = document.createElement('div');
    grid.className = 'model-grid';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const CW = 128;
    const CH = 96;

    for (const p of PRESETS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'model-card';
      card.dataset.id = p.id;
      card.title = `${p.name} — ${p.summary}`;
      card.setAttribute('aria-pressed', String(p.id === this.presetId));

      const canvas = document.createElement('canvas');
      canvas.className = 'model-thumb';
      canvas.width = Math.round(CW * dpr);
      canvas.height = Math.round(CH * dpr);
      canvas.style.width = `${CW}px`;
      canvas.style.height = `${CH}px`;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${p.name}, three-quarter view`);

      const name = document.createElement('span');
      name.className = 'model-name';
      name.textContent = p.name;
      const dims = document.createElement('span');
      dims.className = 'model-dims';
      dims.textContent = '…';

      card.append(canvas, name, dims);
      card.addEventListener('click', () => this.selectPreset(p.id));
      grid.append(card);
      this.modelCards.push({ id: p.id, el: card, canvas, dims });
    }
    parent.raw(grid);

    const blurb = document.createElement('p');
    blurb.className = 'hint model-blurb';
    const expect = document.createElement('p');
    expect.className = 'hint model-expect';
    parent.raw(blurb);
    parent.raw(expect);
    this.paintModelCards = () => {
      const p = getPreset(this.presetId);
      for (const c of this.modelCards) {
        const on = c.id === this.presetId;
        c.el.classList.toggle('active', on);
        c.el.setAttribute('aria-pressed', String(on));
      }
      blurb.textContent = p.summary;
      expect.textContent = p.expectation;
    };
    this.paintModelCards();

    // Painted one per idle slice. Six castings is a few hundred milliseconds of
    // geometry, and doing it inline delays the first frame of the actual
    // simulation for pictures that nobody is looking at yet.
    let next = 0;
    const paintNext = () => {
      if (next >= this.modelCards.length) return;
      const card = this.modelCards[next++];
      const preset = getPreset(card.id);
      try {
        const res = drawFixtureThumbnail(card.canvas, preset.params, preset.shell);
        card.dims.textContent = res
          ? `${res.dims.w} × ${res.dims.d} × ${res.dims.h} mm`
          : '';
      } catch {
        card.dims.textContent = '';
      }
      schedule();
    };
    const schedule = () => window.setTimeout(paintNext, 0);
    schedule();
  }

  private modelCards: Array<{
    id: string;
    el: HTMLButtonElement;
    canvas: HTMLCanvasElement;
    dims: HTMLSpanElement;
  }> = [];
  private paintModelCards: () => void = () => {};

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

    // ---- Fixture ---------------------------------------------------------
    const fix = this.left.section('Fixture', {
      hint: 'Six models spanning the design space. Pick one to load its geometry.',
    });
    this.buildModelPicker(fix);

    // ---- Aim -------------------------------------------------------------
    // Promoted to the top of the panel and made a direct-manipulation control,
    // because aim is the single most sensitive input in the model and was
    // previously two abstract numbers buried among twenty others. Measured on one
    // fixture, moving the aim from the upper wall down onto the front rim takes
    // splashback from 335 to over 16000 µL/L. Nothing else in the tool has that
    // authority, and nothing else was as hard to picture.
    const aim = this.left.section('Aim', {
      hint: 'Click the bowl to aim. Hold Shift to aim without leaving the orbit tool.',
    });
    const aimRow = aim.buttonRow();
    this.aimBtn = aimRow.button('Aim by clicking', () => {
      this.aimMode = !this.aimMode;
      this.refreshAimCursor();
      this.paintAimButton();
    }, 'primary');
    this.paintAimButton = () => {
      this.aimBtn.textContent = this.aimMode ? '✓ Aiming — click the bowl' : 'Aim by clicking';
      this.aimBtn.classList.toggle('active', this.aimMode);
    };
    this.paintAimButton();

    aim.readout('Lands at', () => {
      const t = this.aimTrace;
      if (!t) return '—';
      if (t.blocked) return 'the outside of the fixture';
      if (!t.reached || !t.point) return 'nothing — clears the fixture';
      return `${((t.point.y - this.sim.surface.floorY) * 1000).toFixed(0)} mm above floor`;
    });
    aim.readout('Impingement there', () => {
      const t = this.aimTrace;
      if (!t) return '—';
      if (t.blocked) return 'strikes the casing';
      if (!t.reached) return '—';
      const deg = radToDeg(t.angle);
      const crit = radToDeg(CRITICAL_IMPINGEMENT_ANGLE);
      return `${deg.toFixed(1)}° — ${deg <= crit ? 'under' : 'over'} the ${crit.toFixed(0)}° criterion`;
    }, 'headline');
    aim.slider({
      label: 'Aim height',
      min: 0.02,
      max: 0.6,
      step: 0.01,
      decimals: 2,
      get: () => c.aimTargetV ?? 0.18,
      set: (v) => (c.aimTargetV = v),
      effect: 'aim',
      hint: '0 is the top of the back wall, 0.5 the sump.',
    });
    aim.slider({
      label: 'Aim side of centre',
      min: -1,
      max: 1,
      step: 0.05,
      decimals: 2,
      get: () => c.aimTargetU,
      set: (v) => (c.aimTargetU = v),
      effect: 'aim',
      hint: 'Aiming off-centre decides whether splash leaves past the side of the bowl.',
    });

    // ---- Stream and posture ----------------------------------------------
    const st = this.left.section('Stream & posture');
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

    // ---- View ------------------------------------------------------------
    const disp = this.left.section('View', { collapsed: true });
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

    this.buildAdvancedPanel(this.left);
  }

  private aimBtn!: HTMLButtonElement;
  private paintAimButton: () => void = () => {};

  /**
   * Everything that is not a decision anyone makes while evaluating a fixture.
   *
   * One collapsed section rather than four, and it exists for auditability rather
   * than for use: the two calibrated coefficients, the published thresholds, the
   * grid resolution and the seed all need to be reachable so the model can be
   * checked instead of trusted, but none of them belong in front of somebody
   * asking whether a bowl splashes. The panel used to open with twenty-four
   * controls and no indication of which three mattered.
   */
  private buildAdvancedPanel(parent: Panel): void {
    const c = this.sim.config;
    const md = parent.section('Advanced', {
      collapsed: true,
      hint:
        'Calibration, numerics and appearance. Exposed so the model can be audited ' +
        'rather than trusted — not settings you need to touch to compare fixtures.',
    });

    md.slider({
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
    md.slider({
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
    md.slider({
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
    md.slider({
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
      hint:
        'Fraction of along-wall momentum kept on impact. High: this is why liquid ' +
        'sticks and runs.',
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
    md.toggle({
      label: 'Show grid wireframe',
      get: () => this.showWireframe,
      set: (v) => (this.showWireframe = v),
      effect: 'view',
    });
    md.slider({
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
    md.slider({
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
    md.select<string>({
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
    md.slider({
      label: 'Droplet draw size',
      min: 0.4,
      max: 5,
      step: 0.1,
      decimals: 1,
      get: () => this.view.droplets.sizeScale,
      set: (v) => (this.view.droplets.sizeScale = v),
      effect: 'none',
    });
    md.readout('Surface tension', () => `${(c.fluid.surfaceTension * 1000).toFixed(1)} mN/m`);
    md.readout('Viscosity', () => `${(c.fluid.viscosity * 1000).toFixed(3)} mPa·s`);
    md.readout('Capillary length', () => `${(capillaryLength(c.fluid) * 1000).toFixed(2)} mm`);
    md.readout('Ohnesorge (3 mm)', () => ohnesorge(c.fluid, 0.003).toExponential(2));
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

    // ---- When ------------------------------------------------------------
    // Given its own section because it is the largest single effect in the model
    // and it was previously invisible: the weak rise and dribble are a fifth of
    // the volume and the great majority of the splashback.
    const when = this.right.section('When it happens', {
      hint:
        'Splashback per litre, split by how strong the stream was. A slow stream ' +
        'leaves on the same aim but falls short and steeper, so it lands nearer the ' +
        'front of the fixture — often on the rim itself.',
    });
    // Read live from the metrics rather than waiting for a full analysis, because
    // the effect is large enough to be obvious a few seconds into a playback and
    // making it wait for the report is what kept it hidden. A trailing asterisk
    // marks a mid-run figure, matching the headline.
    const phasePerL = (i: FlowPhase): string => {
      const r = this.report;
      const t = r ? r.splash.perPhase[i] : this.sim.metrics.perPhase[i];
      if (!t || t.emitted <= 1e-12) return '—';
      const v = (t.userVolume * 1e9) / (t.emitted * 1000);
      return `${v.toFixed(0)} µL/L${r ? '' : '*'}`;
    };
    when.readout('During sustained flow', () => phasePerL(FlowPhase.Sustained));
    when.readout('During rise & tail', () => phasePerL(FlowPhase.Weak), 'headline');
    when.readout('Tail penalty', () => {
      const src = this.report ? this.report.splash.perPhase : this.sim.metrics.perPhase;
      const s = src[FlowPhase.Sustained];
      const w = src[FlowPhase.Weak];
      if (!s || !w || s.emitted <= 1e-12 || w.emitted <= 1e-12) return '—';
      const sv = (s.userVolume * 1e9) / (s.emitted * 1000);
      const wv = (w.userVolume * 1e9) / (w.emitted * 1000);
      if (sv <= 0) return wv > 0 ? 'all of it in the tail' : '—';
      return `${(wv / sv).toFixed(0)}× worse per litre`;
    });

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
    // Stream arrivals only. The combined figure counts re-impacting splash, which
    // on the default bowl is over 40% of the arriving volume and lands steeper, so
    // it both dilutes and biases a statistic that claims to be about the stream.
    imp.readout('Where the stream landed', () => {
      const a = this.sim.metrics.actualImpingement();
      return a.primaryVolume > 0 ? `${radToDeg(a.primaryMeanAngle).toFixed(1)}° mean` : '—';
    });
    imp.readout('Stream volume over 30°', () => {
      const a = this.sim.metrics.actualImpingement();
      return a.primaryVolume > 0
        ? `${(100 * a.primaryFractionOverCritical).toFixed(0)} %`
        : '—';
    });
    imp.readout('Re-impacting splash', () => {
      const a = this.sim.metrics.actualImpingement();
      return a.secondaryVolume > 0
        ? `${(a.secondaryVolume * 1e6).toFixed(1)} mL at ${radToDeg(a.meanAngle).toFixed(0)}°`
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
  /**
   * Local impingement angle for each aim point, traced ballistically.
   *
   * The trace goes through `Simulation.traceAim`, which tests the casting as well
   * as the wetted interior. Tracing the interior alone -- which this did -- reports
   * an angle for aim points the ceramic physically blocks, and those are the aim
   * points that matter most: a blocked aim means the stream hits the outside of
   * the fixture, which is the worst outcome available and used to be reported as
   * the best.
   */
  private runAimSweep(): void {
    type Row = { v: number; angle: number; y: number; ok: boolean; blocked: boolean };
    const rows: Row[] = [];
    const saveEl = this.sim.config.stream.aimElevation;
    const saveAz = this.sim.config.stream.aimAzimuth;

    for (let k = 0; k <= 12; k++) {
      const v = 0.04 + (k / 12) * 0.5;
      if (!this.sim.aimAtProfileFraction(v)) continue;
      const tr = this.sim.traceAim();
      if (tr.blocked) {
        rows.push({ v, angle: Number.NaN, y: tr.point ? tr.point.y : 0, ok: false, blocked: true });
        continue;
      }
      if (!tr.reached || !tr.point) continue;
      rows.push({
        v,
        angle: tr.angle,
        y: tr.point.y,
        ok: tr.angle <= CRITICAL_IMPINGEMENT_ANGLE,
        blocked: false,
      });
    }

    this.sim.config.stream.aimElevation = saveEl;
    this.sim.config.stream.aimAzimuth = saveAz;
    this.sim.emitter.params.aimElevation = saveEl;
    this.sim.emitter.params.aimAzimuth = saveAz;
    this.sim.refreshImpingement();

    this.sweepEl.replaceChildren();
    const reachable = rows.filter((r) => !r.blocked);
    if (reachable.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent =
        'No aim point on this geometry reaches the bowl at the current exit speed — ' +
        'the stream meets the outside of the fixture first. Stand closer.';
      this.sweepEl.append(p);
      return;
    }
    let best = reachable[0];
    for (const r of reachable) if (r.angle < best.angle) best = r;

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
      if (r.blocked) tr.className = 'over';
      else if (r === best) tr.className = 'best';
      else if (!r.ok) tr.className = 'over';
      const cells = [
        r.v.toFixed(2),
        `${(r.y * 1000).toFixed(0)} mm`,
        r.blocked ? 'hits casing' : `${radToDeg(r.angle).toFixed(1)}°`,
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
    const nOk = reachable.filter((r) => r.ok).length;
    const nBlocked = rows.length - reachable.length;
    summary.textContent =
      `Best aim v=${best.v.toFixed(2)} at ${radToDeg(best.angle).toFixed(1)}°. ` +
      `${nOk} of ${reachable.length} reachable aim points meet the 30° criterion` +
      (nBlocked > 0
        ? `, and ${nBlocked} strike the outside of the fixture — the worst outcome available.`
        : '.');
    this.sweepEl.append(summary);

    const btn = document.createElement('button');
    btn.className = 'btn wide';
    btn.textContent = `Use best aim (v=${best.v.toFixed(2)})`;
    btn.addEventListener('click', () => {
      this.setAimTarget(0, best.v);
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
    this.view.setGeometry(this.sim.surface, this.sim.casting, this.sim.capture);
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

  /**
   * The report.
   *
   * Rewritten from a flat dump of every number the solver holds. That version
   * printed forty-odd quantities in solver order with no ordering by importance,
   * no comparison to anything, and no statement of what any of it implied -- so
   * reading it told you the simulation had run and very little else. Worse, its
   * headline "where the stream landed" was computed over every impact of every
   * generation, which on the default bowl is 42% liquid that had already bounced.
   *
   * This version answers, in order: how bad is it, when did it happen, where did
   * it go, why, and what would you change. The raw solver figures are still here,
   * at the bottom, because volume closure is the evidence the rest is worth
   * reading -- but they are no longer the body of the document.
   */
  private paintReport(): void {
    const r = this.report;
    if (!r) return;
    const p = getPreset(this.presetId);
    const cfg = this.sim.config;
    const act = this.sim.metrics.actualImpingement();
    const sp = r.splash;
    const L: string[] = [];

    const pad = (s: string, n = 22) => s.padEnd(n);
    const rule = (ch = '─') => ch.repeat(58);

    // ---- Verdict ---------------------------------------------------------
    const upl = sp.userMicrolitresPerLitre;
    const verdict =
      upl < 100
        ? 'CLEAN — negligible splashback on the user'
        : upl < 600
          ? 'ACCEPTABLE — noticeable but modest splashback'
          : upl < 3000
            ? 'POOR — significant splashback on the user'
            : 'BAD — the user is being sprayed';
    L.push(`${p.name.toUpperCase()} — ${cfg.fluid.name}, ${cfg.wall.name}`);
    L.push(rule('═'));
    L.push(`VERDICT   ${verdict}`);
    L.push(`          ${upl.toFixed(0)} µL on the user per litre voided`);
    L.push(
      `          ${(sp.userVolume * 1e9).toFixed(0)} µL total in ${sp.userDroplets} droplets, ` +
        `from a ${(r.voidedVolume * 1e6).toFixed(0)} mL void`
    );
    L.push('');
    L.push('          Bands: under 100 µL/L is barely detectable, 600 is noticeable,');
    L.push('          3000 and above is a visibly wet trouser leg. Compare fixtures');
    L.push('          at the same aim, stand-off and seed — the absolute figure moves');
    L.push('          a long way with all three.');
    L.push('');

    // ---- When ------------------------------------------------------------
    // The single most useful thing the tool has to say, and it was not being
    // said at all: the dribble at each end of the void does most of the damage.
    L.push('WHEN IT HAPPENS');
    L.push(rule());
    const ph = sp.perPhase;
    for (let i = 0; i < ph.length; i++) {
      const t = ph[i];
      if (t.emitted <= 0) continue;
      const perL = (t.userVolume * 1e9) / (t.emitted * 1000);
      L.push(
        `  ${pad(FLOW_PHASE_NAMES[i], 24)}${(100 * (t.emitted / Math.max(1e-12, r.voidedVolume))).toFixed(0).padStart(3)}% of the void   ` +
          `${perL.toFixed(0).padStart(6)} µL/L   ${(t.userVolume * 1e9).toFixed(0).padStart(5)} µL`
      );
    }
    const weakRatio =
      sp.weakMicrolitresPerLitre / Math.max(1, sp.sustainedMicrolitresPerLitre);
    if (weakRatio > 2) {
      L.push('');
      L.push(
        `  The weak rise and tail are ${weakRatio.toFixed(0)}× worse per litre than the`
      );
      L.push('  sustained phase. A slow stream leaves on the same aim but falls short');
      L.push('  and steeper, landing nearer the front of the fixture. This is the');
      L.push('  dominant term and no change to the bowl shape addresses it.');
    }
    L.push('');

    // ---- Where -----------------------------------------------------------
    L.push('WHERE IT WENT');
    L.push(rule());
    for (let z = 0; z < sp.perZone.length; z++) {
      const t = sp.perZone[z];
      if (t.volume <= 0) continue;
      const unit =
        t.volume >= 1e-6 ? `${(t.volume * 1e6).toFixed(2)} mL` : `${(t.volume * 1e9).toFixed(0)} µL`;
      L.push(
        `  ${pad(ZONE_NAMES[z], 24)}${unit.padStart(10)}   ${String(t.count).padStart(6)} drops` +
          (t.splashVolume > 0 && t.directVolume > 0
            ? `   (${(100 * (t.splashVolume / t.volume)).toFixed(0)}% thrown back)`
            : '')
      );
    }
    L.push('');

    // ---- Why -------------------------------------------------------------
    L.push('WHY');
    L.push(rule());
    L.push(
      `  ${pad('Stream arrivals')}${(act.primaryVolume * 1e6).toFixed(1)} mL at ` +
        `${radToDeg(act.primaryMeanAngle).toFixed(1)}° mean impingement`
    );
    L.push(
      `  ${pad('— over the 30° limit')}${(100 * act.primaryFractionOverCritical).toFixed(0)}% of that volume`
    );
    L.push(
      `  ${pad('Splash re-impacts')}${(act.secondaryVolume * 1e6).toFixed(1)} mL at ` +
        `${radToDeg(act.meanAngle).toFixed(1)}° mean (all generations)`
    );
    L.push(
      `  ${pad('Ejected at the wall')}${(100 * sp.splashFraction).toFixed(1)}% of arriving volume, ` +
        `${sp.splashEvents} of ${sp.impactEvents} impacts`
    );
    const it = this.sim.impact.totals;
    L.push(
      `  ${pad('Struck the casing')}${it.exteriorEvents} impacts, ` +
        `${(it.exteriorSplashedVolume * 1e6).toFixed(2)} mL thrown back off it`
    );
    const bu = this.sim.emitter.breakupAt(
      this.sim.emitter.flow.peakFraction * this.sim.emitter.flow.duration
    );
    const reach = this.aimTrace && this.aimTrace.point
      ? Math.hypot(
          this.aimTrace.point.x - this.sim.emitter.position.x,
          this.aimTrace.point.y - this.sim.emitter.position.y,
          this.aimTrace.point.z - this.sim.emitter.position.z
        )
      : 0;
    L.push(
      `  ${pad('Stream on arrival')}breaks up at ${(bu.breakupLength * 100).toFixed(0)} cm, ` +
        `wall at ${(reach * 100).toFixed(0)} cm — ` +
        `${reach > bu.breakupLength ? 'a droplet train' : 'still a coherent jet'}`
    );
    L.push(
      `  ${pad('Splash concentration')}${(100 * act.hotspotShare).toFixed(0)}% from the worst 10% of the surface, ` +
        `centred at v=${act.splashCentroidV.toFixed(2)}`
    );
    L.push('');

    // ---- What to change --------------------------------------------------
    // Derived from this run rather than generic advice, so it is worth reading.
    L.push('WHAT WOULD HELP');
    L.push(rule());
    const advice: string[] = [];
    if (this.aimTrace?.blocked) {
      advice.push(
        'The aim strikes the outside of the fixture. Nothing else matters until ' +
          'that is fixed — aim higher or stand closer.'
      );
    }
    if (act.primaryFractionOverCritical > 0.5) {
      advice.push(
        `${(100 * act.primaryFractionOverCritical).toFixed(0)}% of the stream lands steeper than 30°. ` +
          'Check the aim sweep for a shallower aim point on this fixture.'
      );
    }
    if (reach > bu.breakupLength * 1.3) {
      advice.push(
        `The wall is ${(reach * 100).toFixed(0)} cm away but the jet breaks up at ` +
          `${(bu.breakupLength * 100).toFixed(0)} cm, so a droplet train arrives and every ` +
          'droplet fires its own corona. Standing closer is the single most ' +
          'effective change available to the user.'
      );
    }
    if (it.exteriorSplashedVolume > 0.2e-6) {
      advice.push(
        `${(it.exteriorSplashedVolume * 1e6).toFixed(1)} mL was thrown back off the casing itself. ` +
          'That is the stream or its splash hitting the outside of the fixture.'
      );
    }
    if (weakRatio > 4) {
      advice.push(
        'Most of the splashback is in the weak phases, which the fixture cannot ' +
          'fix. A shallower fixture, or a shorter stand-off during the tail, would.'
      );
    }
    if (r.drainage.maxStandingDepth > 1.5e-3) {
      advice.push(
        `${(r.drainage.maxStandingDepth * 1000).toFixed(1)} mm of liquid is standing at the end of the run. ` +
          'Impacts into standing liquid splash more readily than onto damp glaze.'
      );
    }
    if (advice.length === 0) advice.push('Nothing stands out. This configuration behaves well.');
    for (const a of advice) {
      // Wrapped by hand: this is a <pre>, so the browser will not do it.
      const words = a.split(' ');
      let line = '  ·';
      for (const w of words) {
        if (line.length + w.length + 1 > 58) {
          L.push(line);
          line = '   ';
        }
        line += ` ${w}`;
      }
      L.push(line);
    }
    L.push('');

    // ---- Drainage --------------------------------------------------------
    L.push('DRAINAGE');
    L.push(rule());
    L.push(
      `  ${pad('Left on the wall')}${(r.drainage.residualVolume * 1e6).toFixed(2)} mL, of which ` +
        `${(r.drainage.excessVolume * 1e6).toFixed(2)} mL could have drained`
    );
    L.push(
      `  ${pad('Bulk clear time')}${
        r.drainage.bulkClearTime < 0
          ? 'never, within the run window'
          : `${r.drainage.bulkClearTime.toFixed(1)} s after flow stopped`
      }`
    );
    L.push(
      `  ${pad('Deepest standing')}${(r.drainage.maxStandingDepth * 1000).toFixed(2)} mm`
    );
    L.push(
      `  ${pad('Stagnant area')}${(r.drainage.stagnantArea * 1e4).toFixed(0)} cm² of ` +
        `${(r.drainage.peakWettedArea * 1e4).toFixed(0)} cm² wetted`
    );
    L.push('');

    // ---- Trust -----------------------------------------------------------
    L.push('SOLVER');
    L.push(rule());
    L.push(
      `  ${pad('Volume closure')}${(100 * r.volumeClosureError).toFixed(4)}% unaccounted` +
        `${r.volumeClosureError < 1e-4 ? ' — every drop accounted for' : ' — SUSPECT'}`
    );
    L.push(
      `  ${pad('Grid')}${this.sim.surface.nu} × ${this.sim.surface.nv} cells, ` +
        `${(this.sim.surface.totalArea * 1e4).toFixed(0)} cm²`
    );
    L.push(
      `  ${pad('Stability')}${this.sim.film.sanitisedCells} sanitised cells, ` +
        `${this.sim.film.substepBudgetExceeded} substep overruns`
    );
    // Only when it was actually measured. A run driven to completion by playback
    // or by the automation surface has no single wall-clock span to quote, and
    // printing "0.0 s" there reads as a suspiciously fast simulation.
    if (r.wallClockMs > 0) {
      L.push(
        `  ${pad('Cost')}${r.simulatedTime.toFixed(1)} s simulated in ` +
          `${(r.wallClockMs / 1000).toFixed(1)} s`
      );
    } else {
      L.push(`  ${pad('Simulated')}${r.simulatedTime.toFixed(1)} s`);
    }
    L.push(
      `  ${pad('Aim')}v=${(cfg.aimTargetV ?? 0).toFixed(2)}, u=${cfg.aimTargetU.toFixed(2)}, ` +
        `stand-off ${(cfg.posture.standoff * 1000).toFixed(0)} mm, seed ${cfg.seed}`
    );
    if (this.sim.surface.profile.info.notes.length) {
      L.push('');
      L.push('GEOMETRY NOTES');
      L.push(rule());
      for (const n of this.sim.surface.profile.info.notes) L.push(`  ${n}`);
    }
    this.reportEl.textContent = L.join('\n');
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
        this.finishRun();
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
      this.updateStreamPath();
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

  // =======================================================================
  // Deterministic control, for the offline screenshot harness
  // =======================================================================

  /** Which fixture is loaded. */
  get modelId(): string {
    return this.presetId;
  }

  setPlaying(v: boolean): void {
    this.running = v;
    if (this.playBtn) this.playBtn.textContent = v ? '❚❚ Pause' : '▶ Play';
  }

  /**
   * Step the simulation to a given simulated time and redraw.
   *
   * The frame loop advances by wall-clock budget so that playback degrades
   * gracefully on expensive geometry. That is right for interactive use and
   * useless for a screenshot: the same command would capture a different instant
   * on every run and on every machine. This advances by simulated time instead,
   * so a shot at t = 0.8 s is the same picture every time.
   */
  advanceTo(seconds: number): void {
    this.setPlaying(false);
    if (this.sim.phase === SimPhase.Idle) this.sim.restart();
    while (this.sim.time < seconds && !this.sim.isFinished()) {
      this.sim.step();
      if (this.sim.time >= this.nextSampleAt) {
        this.sim.sample();
        this.nextSampleAt = this.sim.time + 0.05;
      }
    }
    if (this.sim.isFinished() && !this.report) this.finishRun();
    this.refreshViews();
  }

  /**
   * Close out a completed run: take the final sample and produce the report.
   *
   * Shared by the interactive frame loop and by `advanceTo`, because the report
   * used to be built only in the frame loop. A run driven to completion any other
   * way -- which is how the screenshot harness and every scripted check drive it --
   * finished silently and left the panel saying "run a full analysis", so the one
   * output a user actually reads was unreachable from automation and therefore
   * never verified.
   */
  private finishRun(): void {
    this.sim.sample();
    this.report = this.sim.report();
    this.paintReport();
    this.right.refresh();
  }

  /** Force every throttled overlay to catch up, then draw one frame. */
  refreshViews(): void {
    this.view.updateLiquid(
      this.sim.particles,
      this.sim.emitter.position,
      this.sim.emitter.diameterAt(this.sim.time)
    );
    this.updateFixtureField();
    this.updateStreamPath();
    this.view.updateHeatmaps(this.sim.metrics.floorMap, this.sim.metrics.bodyMap);
    this.updateCharts();
    this.updateHud();
    this.updateTransport();
    this.updateZoneBars();
    this.updateScore();
    this.left.refresh();
    this.right.refresh();
    this.view.render();
  }

  setFieldMode(mode: FieldMode): void {
    this.view.fixture.mode = mode;
    this.updateFixtureField();
    this.updateLegend();
    this.paintTabs();
  }

  setCameraPreset(preset: CameraPreset): void {
    this.view.applyCameraPreset(preset, this.sim.surface, this.sim.capture);
  }

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
