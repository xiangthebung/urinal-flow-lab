import { CRITICAL_IMPINGEMENT_ANGLE } from '../core/constants';
import { FLUID_PRESETS, WALL_MATERIALS, capillaryLength, ohnesorge } from '../core/fluid';
import { clamp, radToDeg } from '../core/vec3';
import { PRESETS, getPreset } from '../geometry/presets';
import { ColorScale, sample, toCss } from '../render/colormap';
import { DropletColorMode } from '../render/dropletView';
import { FieldInfo, FieldMode, FixtureView } from '../render/fixtureView';
import { CameraPreset, SceneView } from '../render/sceneView';
import { ZONE_NAMES } from '../sim/capture';
import {
  DrainageReport,
  FLOW_PHASE_NAMES,
  FlowPhase,
  Metrics,
  SplashbackReport,
} from '../sim/metrics';
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
    const p0 = getPreset(this.presetId);
    cfg.surface = { ...p0.params };
    cfg.casting = { ...(p0.shell ?? {}) };
    cfg.fittings = { ...(p0.fittings ?? {}) };
    if (p0.defaultAimV !== undefined) cfg.aimTargetV = p0.defaultAimV;
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
    this.view.setGeometry(
      this.sim.surface,
      this.sim.casting,
      this.sim.capture,
      this.sim.fittings
    );
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
    this.buildViewportBar();
    this.buildHelp();
    this.buildKeyboard();

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
        this.view.setGeometry(
      this.sim.surface,
      this.sim.casting,
      this.sim.capture,
      this.sim.fittings
    );
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
   * Wire up aim picking: click to aim, drag to orbit.
   *
   * Shift (or the sticky `A` mode) paints aim continuously, and only then is
   * orbit suspended — for the duration of that one gesture, so a drag always
   * orbits and never has to be handed back. See the note in the body for what
   * this replaced and why.
   */
  private buildAimPicking(): void {
    const canvas = document.getElementById('gl') as HTMLCanvasElement;

    // Click to aim, drag to orbit, told apart by whether the pointer moved.
    //
    // This replaced a mode: you had to arm "Aim by clicking", click the bowl, then
    // remember to disarm it or it kept swallowing the orbit gesture. Aim is the most
    // used control in the tool and it was three actions behind a latch. A plain
    // click cannot be confused with an orbit as long as the two are separated by
    // movement rather than by a mode, which is what every 3-D tool does.
    //
    // The threshold is in pixels and generous, because a click on a trackpad drifts
    // a pixel or two and nobody means to orbit by 3 px.
    const DRAG_PX = 5;
    let downX = 0;
    let downY = 0;
    let moved = false;
    let painting = false;

    const setCursor = () => {
      canvas.style.cursor = this.aimMode || this.shiftHeld ? 'crosshair' : '';
      // Orbit stays live unless we are actively painting aim, so a drag always
      // orbits and never has to be "given back".
      this.view.controls.enabled = !this.aimMode;
    };
    this.refreshAimCursor = setCursor;

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      downX = e.clientX;
      downY = e.clientY;
      moved = false;
      // Sticky mode or Shift: paint aim continuously and suspend orbit for the
      // duration of this gesture only.
      if (this.aimMode || e.shiftKey) {
        painting = true;
        this.view.controls.enabled = false;
        this.pickAimAt(e.clientX, e.clientY);
        e.preventDefault();
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (Math.abs(e.clientX - downX) > DRAG_PX || Math.abs(e.clientY - downY) > DRAG_PX) {
        moved = true;
      }
      if (painting) this.pickAimAt(e.clientX, e.clientY);
    });

    const end = (e: PointerEvent) => {
      if (painting) {
        painting = false;
        this.view.controls.enabled = !this.aimMode;
        return;
      }
      // A click that did not turn into a drag is an aim.
      if (e.button === 0 && !moved) this.pickAimAt(e.clientX, e.clientY);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', () => {
      painting = false;
      this.view.controls.enabled = !this.aimMode;
    });
  }

  /** Sticky aim mode. Optional now that a plain click aims. */
  private aimMode = false;
  private shiftHeld = false;
  private refreshAimCursor: () => void = () => {};

  private refreshGeometryDependent(): void {
    this.nextSampleAt = 0;
    this.updateFixtureField();
    this.updateStreamPath();
    this.applyViewToggles();
    this.updateLegend();
    this.updateHud();
    this.scheduleAimSweep();
  }

  /**
   * The aim sweep, deferred.
   *
   * It solves and ballistically traces thirteen aim points, and it was being run
   * synchronously on every `apply('aim')` -- which is every tick of the aim sliders
   * and every mouse-move while painting aim. That is the lag: the sweep costs far
   * more than the frame it is holding up, and its result is a reference table nobody
   * reads mid-drag. Coalescing to the end of the gesture keeps aiming responsive
   * while the table still lands promptly once the pointer settles.
   */
  private aimSweepTimer = 0;

  private scheduleAimSweep(): void {
    if (this.aimSweepTimer) window.clearTimeout(this.aimSweepTimer);
    this.aimSweepTimer = window.setTimeout(() => {
      this.aimSweepTimer = 0;
      this.runAimSweep();
    }, 130);
  }

  /**
   * Run any pending sweep now.
   *
   * Called from `refreshViews`, which is the path the screenshot harness and every
   * scripted check drive, so automation never photographs a half-updated panel.
   */
  private flushAimSweep(): void {
    if (!this.aimSweepTimer) return;
    window.clearTimeout(this.aimSweepTimer);
    this.aimSweepTimer = 0;
    this.runAimSweep();
  }

  /**
   * Open a collapsed panel section.
   *
   * The report lives in a section that starts collapsed, so finishing an analysis
   * left the one document a user actually wanted to read folded away at the bottom
   * of the panel with no indication it had arrived.
   */
  private expandSection(inner: HTMLElement): void {
    const wrap = inner.closest('.section');
    if (!wrap) return;
    wrap.classList.remove('collapsed');
    const caret = wrap.querySelector('.caret');
    if (caret) caret.textContent = '▾';
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
    const p = getPreset(id);
    // Copied, never aliased: presets are shared objects and the config is mutated
    // by the controls.
    this.sim.config.surface = { ...p.params };
    this.sim.config.casting = { ...(p.shell ?? {}) };
    this.sim.config.fittings = { ...(p.fittings ?? {}) };
    // Aim belongs to the model. A profile fraction that lands mid-wall on a bowl
    // lands in the throat of a stall, so each fixture carries its own default.
    if (p.defaultAimV !== undefined) this.sim.config.aimTargetV = p.defaultAimV;
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
    // Portrait, because the fixtures are. Every one of these is taller than it is
    // wide -- a stall urinal is 2.7 times taller -- so a landscape card spends most
    // of its area on empty background either side and shrinks the object to fit the
    // short axis. The thumbnail is framed to the card, so the card's shape sets how
    // big the fixture can be drawn.
    const CW = 126;
    const CH = 126;

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
        const res = drawFixtureThumbnail(
          card.canvas,
          preset.params,
          preset.shell,
          preset.fittings
        );
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
    VIEW_TABS.forEach((t, i) => {
      const b = document.createElement('button');
      b.className = 'tab';
      b.type = 'button';
      b.textContent = t.label;
      // What the view means, on the control that selects it. The legend below
      // carries the colour scale; the prose belongs here, where it is available
      // before you switch rather than only after.
      b.title = `${i + 1} · ${FixtureView.infoFor(t.mode, 0, 1).description}`;
      b.addEventListener('click', () => {
        this.view.fixture.mode = t.mode;
        this.updateFixtureField();
        this.updateLegend();
        this.paintTabs();
      });
      bar.append(b);
      this.tabEls.push(b);
    });
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
      hint:
        'Click the bowl to aim. Drag to orbit. Shift-drag paints aim, Shift plus the ' +
        'arrow keys nudges it.',
    });
    const aimRow = aim.buttonRow();
    // Sticky mode is now a convenience rather than the way in: a plain click on the
    // fixture aims, because a mode you have to arm and then remember to disarm is
    // the wrong shape for the most-used control in the tool.
    this.aimBtn = aimRow.button('Lock aim mode (A)', () => {
      this.aimMode = !this.aimMode;
      this.refreshAimCursor();
      this.paintAimButton();
    });
    this.paintAimButton = () => {
      this.aimBtn.textContent = this.aimMode
        ? '✓ Aim locked — click or drag'
        : 'Lock aim mode (A)';
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
    // Named for the direction the slider actually moves the aim. It was "Aim
    // height", which reads as "higher number, higher on the wall" and does the
    // opposite: v walks *down* the profile from the rim, so dragging right lowers
    // the impact point. The readouts above say where it lands in millimetres
    // above the floor, which is the answer anyone actually wants.
    aim.slider({
      label: 'Aim down the wall',
      min: 0.02,
      max: 0.6,
      step: 0.01,
      decimals: 2,
      get: () => c.aimTargetV ?? 0.18,
      set: (v) => (c.aimTargetV = v),
      effect: 'aim',
      hint: '0 is the top of the back wall, 0.5 the sump. Higher means lower down.',
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
    //
    // Everything here reads live from the metrics and switches to the finished
    // report when there is one, with a trailing `*` marking a mid-run figure.
    // Nine of these used to be a literal em-dash until a full analysis had been
    // run, so the results panel spent every playback looking broken while the
    // simulation underneath it had the numbers all along.
    const head = this.right.section('Splashback');
    head.readout('On the user', () => this.userPerLitre(), 'headline');
    head.readout('— thrown back', () =>
      this.uL(this.splashNow().userSplashVolume)
    );
    head.readout('— direct miss', () => this.uL(this.splashNow().userDirectVolume));
    head.readout('Droplets on user', () => `${this.splashNow().userDroplets}${this.live}`);
    head.readout('Ejected at the wall', () => {
      const f = this.splashNow().splashFraction;
      return this.splashNow().impactEvents > 0
        ? `${(100 * f).toFixed(1)} %${this.live}`
        : '—';
    });
    head.readout('Floor near fixture', () => {
      const v = this.splashNow().floorNearVolume;
      return `${(v * 1e6).toFixed(2)} mL${this.live}`;
    });
    head.text(
      'µL/L normalises by how much was voided, so runs of different volume compare ' +
        'directly. A trailing * marks a figure from a run still in progress.'
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
    // Same guard as the headline: per-litre against a denominator of a few
    // millilitres is arithmetic, not a measurement. Below a tenth of the void in
    // a phase, the absolute volume is the honest thing to show.
    const phasePerL = (i: FlowPhase): string => {
      const r = this.report;
      const t = r ? r.splash.perPhase[i] : this.sim.metrics.perPhase[i];
      if (!t || t.emitted <= 1e-12) return '—';
      if (!r && t.emitted < 0.1 * this.sim.config.stream.voidVolume) {
        return `${(t.userVolume * 1e9).toFixed(0)} µL so far`;
      }
      const v = (t.userVolume * 1e9) / (t.emitted * 1000);
      return `${v.toFixed(0)} µL/L${r ? '' : '*'}`;
    };
    when.readout('During sustained flow', () => phasePerL(FlowPhase.Sustained));
    when.readout('During rise & tail', () => phasePerL(FlowPhase.Weak), 'headline');
    when.readout('Tail penalty', () => {
      const src = this.report ? this.report.splash.perPhase : this.sim.metrics.perPhase;
      const s = src[FlowPhase.Sustained];
      const w = src[FlowPhase.Weak];
      const floor = this.report ? 1e-12 : 0.1 * this.sim.config.stream.voidVolume;
      if (!s || !w || s.emitted <= floor || w.emitted <= floor) return '—';
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
      const a = this.impingementNow();
      return a.primaryVolume > 0
        ? `${radToDeg(a.primaryMeanAngle).toFixed(1)}° mean${this.live}`
        : '—';
    });
    imp.readout('Stream volume over 30°', () => {
      const a = this.impingementNow();
      return a.primaryVolume > 0
        ? `${(100 * a.primaryFractionOverCritical).toFixed(0)} %${this.live}`
        : '—';
    });
    imp.readout('Re-impacting splash', () => {
      const a = this.impingementNow();
      return a.secondaryVolume > 0
        ? `${(a.secondaryVolume * 1e6).toFixed(1)} mL at ` +
            `${radToDeg(a.meanAngle).toFixed(0)}°${this.live}`
        : '—';
    });
    imp.readout('Splash concentration', () => {
      const a = this.impingementNow();
      return a.hotspotShare > 0
        ? `${(100 * a.hotspotShare).toFixed(0)}% from worst 10%${this.live}`
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
    const mL = (v: number) => `${(v * 1e6).toFixed(2)} mL${this.live}`;
    const cm2 = (v: number) => `${(v * 1e4).toFixed(0)} cm²${this.live}`;
    dr.readout('Left on the wall', () => mL(this.drainageNow().residualVolume));
    dr.readout('— avoidable', () => mL(this.drainageNow().excessVolume));
    dr.readout('— retained film', () => mL(this.drainageNow().retainedFloorVolume));
    dr.readout('Bulk clear time', () => {
      const d = this.drainageNow();
      // Only meaningful once the flow has stopped: it is measured from there.
      if (this.sim.metrics.flowEndTime < 0) return 'while still flowing';
      return d.bulkClearTime < 0
        ? `not yet${this.live}`
        : `${d.bulkClearTime.toFixed(1)} s${this.live}`;
    });
    dr.readout('Deepest standing liquid', () =>
      `${(this.drainageNow().maxStandingDepth * 1000).toFixed(2)} mm${this.live}`
    );
    dr.readout('Wetted area (peak)', () => cm2(this.drainageNow().peakWettedArea));
    dr.readout('Stagnant area', () => cm2(this.drainageNow().stagnantArea));
    dr.readout('Over 20 s residence', () => cm2(this.drainageNow().scaleRiskArea));
    dr.readout('Through the drain', () =>
      `${(this.drainageNow().drainedVolume * 1e6).toFixed(1)} mL${this.live}`
    );
    dr.readout('Spilled / dripped', () => mL(this.drainageNow().spilledVolume));

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
        'because the total is a convenience, not a verdict. The splash part is scored ' +
        'on sustained flow only — that is the part the fixture governs, and the all-in ' +
        'figure reverses which of two designs is better across the stand-off range.'
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

  // =======================================================================
  // Live readouts
  //
  // The panel shows the finished report when there is one and the running
  // simulation otherwise, so a playback is as legible as an analysis. Both
  // `splashback()` and `drainage()` walk the whole film grid, and
  // `actualImpingement()` sorts two arrays as long as the grid, so each is
  // computed at most once per simulated instant and shared by every readout that
  // needs it -- there are nine of them on the drainage section alone, and they
  // all repaint together.
  // =======================================================================

  /** `*` while the figures come from a run in progress rather than a report. */
  private get live(): string {
    return this.report ? '' : '*';
  }

  private snapKey(): string {
    return this.report ? 'report' : `t${this.sim.time.toFixed(4)}`;
  }

  private splashCache: { key: string; value: SplashbackReport } | null = null;
  private drainCache: { key: string; value: DrainageReport } | null = null;
  private impactCache: {
    key: string;
    value: ReturnType<Metrics['actualImpingement']>;
  } | null = null;

  private splashNow(): SplashbackReport {
    if (this.report) return this.report.splash;
    const key = this.snapKey();
    if (this.splashCache?.key === key) return this.splashCache.value;
    const it = this.sim.impact.totals;
    const value = this.sim.metrics.splashback(
      it.depositedVolume + it.splashedVolume,
      it.splashedVolume,
      it.splashEvents,
      it.events
    );
    this.splashCache = { key, value };
    return value;
  }

  private drainageNow(): DrainageReport {
    if (this.report) return this.report.drainage;
    const key = this.snapKey();
    if (this.drainCache?.key === key) return this.drainCache.value;
    const value = this.sim.metrics.drainage(this.sim.film);
    this.drainCache = { key, value };
    return value;
  }

  private impingementNow(): ReturnType<Metrics['actualImpingement']> {
    const key = this.snapKey();
    if (this.impactCache?.key === key) return this.impactCache.value;
    const value = this.sim.metrics.actualImpingement();
    this.impactCache = { key, value };
    return value;
  }

  private uL(v: number): string {
    return `${(v * 1e9).toFixed(0)} µL${this.live}`;
  }

  /**
   * The headline figure.
   *
   * µL/L is a ratio, and for the first second of a void the denominator is a few
   * millilitres — so one splash droplet reads as tens of thousands of µL/L, and
   * the most prominent number in the tool spent the opening of every run
   * announcing a catastrophe in a band its own report calls "the user is being
   * sprayed". Arithmetically true, and useless. Below a tenth of the void the
   * absolute volume is quoted instead, which is meaningful at any point in a run.
   */
  private userPerLitre(): string {
    const sp = this.splashNow();
    if (this.report) return `${sp.userMicrolitresPerLitre.toFixed(0)} µL/L`;
    const emitted = this.sim.metrics.emittedVolume;
    if (emitted < 0.1 * this.sim.config.stream.voidVolume) {
      return `${(sp.userVolume * 1e9).toFixed(0)} µL so far`;
    }
    return `${sp.userMicrolitresPerLitre.toFixed(0)} µL/L*`;
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
    // Held so the [ and ] shortcuts can keep the visible value in step with the
    // actual playback rate.
    this.speedSel = speedSel;

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
  private speedSel: HTMLSelectElement | null = null;

  /**
   * Keyboard control.
   *
   * There was none at all, which for a tool whose main verb is "watch this run"
   * meant the play button was a mouse trip to the bottom of the window every time.
   * Space is the shortcut anyone would try first.
   *
   * Two details keep it from being a nuisance. Keys are ignored while focus is in a
   * text field, a select or a slider, so the arrow keys still nudge whichever
   * control the user is actually holding. And Space is swallowed rather than allowed
   * to fall through, because the browser's default is to scroll the panel and to
   * re-trigger whatever button was last clicked.
   */
  private buildKeyboard(): void {
    const typing = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      const tag = el.tagName.toLowerCase();
      return (
        tag === 'input' ||
        tag === 'select' ||
        tag === 'textarea' ||
        el.isContentEditable === true
      );
    };

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') {
        this.shiftHeld = true;
        this.refreshAimCursor();
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (typing(e.target)) return;

      // Aim nudges. Shift makes the arrows an aim pad, which is the only precise
      // way to explore aim without hunting with the mouse.
      if (e.shiftKey) {
        const c = this.sim.config;
        const stepV = 0.02;
        const stepU = 0.05;
        switch (e.key) {
          case 'ArrowUp':
            this.setAimTarget(c.aimTargetU, (c.aimTargetV ?? 0.18) - stepV);
            e.preventDefault();
            return;
          case 'ArrowDown':
            this.setAimTarget(c.aimTargetU, (c.aimTargetV ?? 0.18) + stepV);
            e.preventDefault();
            return;
          case 'ArrowLeft':
            this.setAimTarget(c.aimTargetU - stepU, c.aimTargetV ?? 0.18);
            e.preventDefault();
            return;
          case 'ArrowRight':
            this.setAimTarget(c.aimTargetU + stepU, c.aimTargetV ?? 0.18);
            e.preventDefault();
            return;
          default:
            break;
        }
      }

      switch (e.key) {
        case ' ':
          this.togglePlay();
          e.preventDefault();
          break;
        case 'r':
        case 'R':
          this.sim.restart();
          this.report = null;
          this.refreshGeometryDependent();
          this.refreshViews();
          break;
        case '.':
        case 's':
        case 'S':
          this.stepBy(0.1);
          break;
        case ',':
          this.stepBy(0.01);
          break;
        case 'a':
        case 'A':
          this.aimMode = !this.aimMode;
          this.refreshAimCursor();
          this.paintAimButton();
          break;
        case 'c':
        case 'C':
          this.cycleCamera();
          break;
        case '[':
          this.nudgeSpeed(-1);
          break;
        case ']':
          this.nudgeSpeed(1);
          break;
        case '?':
        case '/':
          this.toggleHelp();
          e.preventDefault();
          break;
        case 'Escape':
          if (this.aimMode) {
            this.aimMode = false;
            this.refreshAimCursor();
            this.paintAimButton();
          }
          this.setHelpVisible(false);
          break;
        default: {
          // 1-8 select a surface view.
          const n = Number(e.key);
          if (Number.isInteger(n) && n >= 1 && n <= VIEW_TABS.length) {
            this.selectViewTab(n - 1);
          }
          break;
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') {
        this.shiftHeld = false;
        this.refreshAimCursor();
      }
    });
  }

  /**
   * Camera buttons on the viewport rather than inside a collapsed panel section.
   *
   * They were under View, which is collapsed by default, so changing the camera was
   * two clicks and a scroll for something you do constantly while judging a shape.
   */
  private buildViewportBar(): void {
    const stage = document.getElementById('stage')!;
    const bar = document.createElement('div');
    bar.className = 'cam-bar';
    const add = (label: string, preset: CameraPreset, index: number) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cam-btn';
      b.textContent = label;
      b.title = `${label} view — press C to cycle`;
      b.addEventListener('click', () => {
        this.cameraIndex = index;
        this.setCameraPreset(preset);
      });
      bar.append(b);
    };
    add('3/4', CameraPreset.ThreeQuarter, 0);
    add('Front', CameraPreset.Front, 1);
    add('Side', CameraPreset.Side, 2);
    add('Top', CameraPreset.Top, 3);
    add('Eye', CameraPreset.UserEye, 4);

    const help = document.createElement('button');
    help.type = 'button';
    help.className = 'cam-btn help';
    help.textContent = '?';
    help.title = 'Keyboard shortcuts';
    help.addEventListener('click', () => this.toggleHelp());
    bar.append(help);

    stage.append(bar);
  }

  /** Shortcut reference, so the keyboard layer is discoverable rather than secret. */
  private buildHelp(): void {
    const stage = document.getElementById('stage')!;
    const box = document.createElement('div');
    box.className = 'shortcuts hidden';
    const rows: Array<[string, string]> = [
      ['Space', 'play / pause'],
      ['R', 'restart the run'],
      ['S or .', 'step 0.1 s'],
      [',', 'step 0.01 s'],
      ['[  ]', 'slower / faster'],
      ['1 – 8', 'surface view'],
      ['C', 'cycle camera'],
      ['click bowl', 'set aim'],
      ['drag', 'orbit'],
      ['Shift + drag', 'paint aim'],
      ['Shift + arrows', 'nudge aim'],
      ['A', 'sticky aim mode'],
      ['Esc', 'cancel'],
      ['?', 'this list'],
    ];
    const h = document.createElement('div');
    h.className = 'shortcuts-title';
    h.textContent = 'Shortcuts';
    box.append(h);
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      const kk = document.createElement('kbd');
      kk.textContent = k;
      const vv = document.createElement('span');
      vv.textContent = v;
      row.append(kk, vv);
      box.append(row);
    }
    stage.append(box);
    this.helpEl = box;
  }

  private helpEl!: HTMLElement;

  private toggleHelp(): void {
    this.setHelpVisible(this.helpEl.classList.contains('hidden'));
  }

  private setHelpVisible(v: boolean): void {
    this.helpEl.classList.toggle('hidden', !v);
  }

  private stepBy(seconds: number): void {
    const target = this.sim.time + seconds;
    while (this.sim.time < target && !this.sim.isFinished()) this.sim.step();
    this.sim.sample();
    if (this.sim.isFinished() && !this.report) this.finishRun();
    this.refreshViews();
  }

  private nudgeSpeed(dir: number): void {
    const steps = [0.1, 0.25, 0.5, 1, 2, 4];
    let i = steps.indexOf(this.speed);
    if (i < 0) i = 3;
    i = Math.min(steps.length - 1, Math.max(0, i + dir));
    this.speed = steps[i];
    if (this.speedSel) this.speedSel.value = String(this.speed);
  }

  private cameraOrder: CameraPreset[] = [
    CameraPreset.ThreeQuarter,
    CameraPreset.Front,
    CameraPreset.Side,
    CameraPreset.Top,
    CameraPreset.UserEye,
  ];
  private cameraIndex = 0;

  private cycleCamera(): void {
    this.cameraIndex = (this.cameraIndex + 1) % this.cameraOrder.length;
    this.setCameraPreset(this.cameraOrder[this.cameraIndex]);
  }

  private selectViewTab(i: number): void {
    const t = VIEW_TABS[i];
    if (!t) return;
    this.setFieldMode(t.mode);
    this.paintTabs();
  }

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
    type Row = {
      v: number;
      angle: number;
      y: number;
      ok: boolean;
      blocked: boolean;
      /** Next to a blocked aim: a millimetre either way and it hits the casing. */
      marginal: boolean;
    };
    const rows: Row[] = [];
    const saveEl = this.sim.config.stream.aimElevation;
    const saveAz = this.sim.config.stream.aimAzimuth;

    for (let k = 0; k <= 12; k++) {
      const v = 0.04 + (k / 12) * 0.5;
      if (!this.sim.aimAtProfileFraction(v)) continue;
      const tr = this.sim.traceAim();
      if (tr.blocked) {
        rows.push({
          v,
          angle: Number.NaN,
          y: tr.point ? tr.point.y : 0,
          ok: false,
          blocked: true,
          marginal: false,
        });
        continue;
      }
      if (!tr.reached || !tr.point) continue;
      rows.push({
        v,
        angle: tr.angle,
        y: tr.point.y,
        ok: tr.angle <= CRITICAL_IMPINGEMENT_ANGLE,
        blocked: false,
        marginal: false,
      });
    }

    // An aim wedged between two blocked ones is on a knife edge: the ray is
    // catching the rim tangentially, which reports an impingement angle of
    // essentially zero and therefore wins "best aim" outright. It is the *worst*
    // recommendation available — a nudge of one sweep step puts the stream on the
    // outside of the fixture — and the model's own tremor is larger than that
    // step. Measured on the untouched library: classic-bowl v = 0.49, flat-wall
    // 0.62 and nautilus-tall 0.55 all report 0° this way, each flanked by blocked
    // aims. They are still listed, because "there is a gap in the rim here" is
    // true and worth seeing; they are just not offered as an answer.
    for (let i = 0; i < rows.length; i++) {
      const prev = rows[i - 1];
      const next = rows[i + 1];
      if (rows[i].blocked) continue;
      rows[i].marginal = Boolean(prev?.blocked || next?.blocked);
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
    // Prefer an aim with a blocked-free neighbourhood; fall back to the marginal
    // ones only if the fixture offers nothing else.
    const robust = reachable.filter((r) => !r.marginal);
    const candidates = robust.length > 0 ? robust : reachable;
    let best = candidates[0];
    for (const r of candidates) if (r.angle < best.angle) best = r;

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
        r.blocked
          ? 'hits casing'
          : `${radToDeg(r.angle).toFixed(1)}°${r.marginal ? ' grazing' : ''}`,
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
    const nMarginal = reachable.filter((r) => r.marginal).length;
    summary.textContent =
      `Best aim v=${best.v.toFixed(2)} at ${radToDeg(best.angle).toFixed(1)}°. ` +
      `${nOk} of ${reachable.length} reachable aim points meet the 30° criterion` +
      (nBlocked > 0
        ? `, and ${nBlocked} strike the outside of the fixture — the worst outcome available.`
        : '.') +
      (nMarginal > 0
        ? ` ${nMarginal} graze the rim: they read a shallow angle only because the ` +
          'stream is catching an edge tangentially, and one step either way puts it ' +
          'on the casing. Not offered as a recommendation.'
        : '');
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
    this.view.setGeometry(
      this.sim.surface,
      this.sim.casting,
      this.sim.capture,
      this.sim.fittings
    );
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
    this.expandSection(this.reportEl);
    this.reportEl.scrollIntoView({ block: 'nearest' });
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
    // Path length, casting included: the same number the HUD quotes.
    const { dist: reach, blocked } = this.reachToFixture();
    L.push(
      `  ${pad('Stream on arrival')}breaks up at ${(bu.breakupLength * 100).toFixed(0)} cm, ` +
        `${blocked ? 'casing' : 'wall'} at ${(reach * 100).toFixed(0)} cm — ` +
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
    this.expandSection(this.reportEl);
    this.right.refresh();
  }

  /** Force every throttled overlay to catch up, then draw one frame. */
  refreshViews(): void {
    this.flushAimSweep();
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
    const reach = this.reachToFixture();
    this.hudEl.innerHTML =
      `droplets <b>${s.particles}</b><br>` +
      `coherent <b>${s.coherent}</b> · splash <b>${s.secondaries}</b><br>` +
      `film <b>${(s.filmVolume * 1e6).toFixed(2)} mL</b><br>` +
      `airborne <b>${(s.airborne * 1e9).toFixed(0)} µL</b><br>` +
      `drained <b>${(s.drained * 1e6).toFixed(1)} mL</b><br>` +
      `on user <b>${(s.userVolume * 1e9).toFixed(0)} µL</b><br>` +
      `breakup <b>${(bu.breakupLength * 100).toFixed(0)} cm</b> / reach ` +
      `<b>${reach.dist > 0 ? `${(reach.dist * 100).toFixed(0)} cm` : '—'}</b>` +
      (reach.blocked ? ' <b>(casing)</b>' : '');
    this.updateOverlayNote(bu.breakupLength, reach);
  }

  /**
   * The one-line note over the viewport.
   *
   * One element, one message, chosen by priority. The geometry warning and the
   * coherence hint used to write into it from two different update paths at two
   * different rates, and the coherence hint runs at roughly 8 Hz — so "this
   * profile self-intersects and is not manufacturable" was overwritten within a
   * frame of appearing and was, in practice, unreachable. An aim that is stopped
   * by the outside of the fixture now gets a line too: it is the worst outcome
   * available, and it used to make the note disappear entirely.
   */
  private updateOverlayNote(
    breakupLength: number,
    reach: { dist: number; blocked: boolean }
  ): void {
    const cm = (m: number) => `${(m * 100).toFixed(0)} cm`;
    let text = '';
    let tone = '';

    if (this.sim.surface.profile.info.selfIntersects) {
      tone = 'bad';
      text =
        'Profile self-intersects — this shape is not manufacturable and the ' +
        'surface parameterisation is invalid. Reduce the front lip height or the ' +
        'wall overhang.';
    } else if (reach.blocked) {
      tone = 'bad';
      text =
        'The stream meets the outside of the fixture before it reaches the bowl. ' +
        'That is the worst outcome available — it sprays straight back off the ' +
        'ceramic. Aim higher, or stand closer.';
    } else if (reach.dist <= 0 && this.sim.emitter.flow.rateAt(this.sim.time) > 0) {
      // The tail. The stream is still running but too slow to carry to the
      // fixture on the aim it left on, so it lands short — on the floor, or on
      // the user. This is the mechanism behind the largest single effect in the
      // model, and the note went blank for it because the old reach test used
      // the *peak* exit speed and so always reported a wall in front of it.
      tone = 'bad';
      text =
        'The stream is too weak to reach the fixture and is falling short — onto ' +
        'the floor, or onto the user. This is the tail, and per litre it is the ' +
        'worst part of the void.';
    } else if (reach.dist > 0 && breakupLength > reach.dist) {
      text =
        'The stream is still a coherent jet when it reaches the wall ' +
        `(breakup at ${cm(breakupLength)}, wall at ${cm(reach.dist)}). A jet ` +
        'spreads into an attached sheet instead of firing a corona, which is why ' +
        'standing closer helps.';
    } else if (reach.dist > 0) {
      text =
        'The stream has broken into droplets before it reaches the wall ' +
        `(breakup at ${cm(breakupLength)}, wall at ${cm(reach.dist)}). Every ` +
        'droplet arrival throws its own corona — this is the splash-prone regime.';
    }

    this.noteEl.classList.toggle('show', text !== '');
    this.noteEl.classList.toggle('bad', tone === 'bad');
    this.noteEl.textContent = text;
  }

  /**
   * Path length from the exit to the first contact with the fixture.
   *
   * Read off the aim trace, which tests the casting and the metalwork as well as
   * the wetted interior. This used to raycast the interior alone — Trap 15, in a
   * place that escaped the fix. It reported the distance to a point the liquid
   * could never reach, and returned 0, i.e. "no wall at all", for precisely the
   * aims that are stopped dead by the front rim: the HUD then read `reach 0 cm`
   * and the note about coherence vanished, at the aim where it matters most.
   */
  private reachToFixture(): { dist: number; blocked: boolean } {
    const tr = this.aimTrace;
    if (!tr || !tr.point || tr.points.length < 2) {
      return { dist: 0, blocked: false };
    }
    // Arc length along the traced path, not the chord: over half a metre gravity
    // bends the trajectory enough for the two to differ by centimetres, and this
    // number is compared against the breakup length.
    let d = 0;
    for (let i = 1; i < tr.points.length; i++) {
      const a = tr.points[i - 1];
      const b = tr.points[i];
      d += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    return { dist: d, blocked: tr.blocked };
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
    // The legend exists to decode a colour scale. The two appearance-only modes
    // have none, so it had nothing to show but a paragraph restating the tab that
    // is already highlighted a few centimetres away — a permanent block of prose
    // over the default view, which is where most of the looking happens. The
    // prose now lives on the tab as a tooltip, where it is readable before you
    // switch instead of only after.
    if (
      this.view.fixture.mode === FieldMode.Liquid ||
      this.view.fixture.mode === FieldMode.Dry
    ) {
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

}
