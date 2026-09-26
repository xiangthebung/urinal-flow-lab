import {
  AIR_DENSITY,
  AIR_VISCOSITY,
  DRY_SPLASH_K_SMOOTH,
  GRAVITY,
  WET_SPLASH_K_BASE,
  WET_SPLASH_K_FILM,
} from '../core/constants';
import {
  URINE_37C,
  WALL_MATERIALS,
  WATER_20C,
  capillaryLength,
  dragCoefficient,
  dropletDragCoefficient,
  kinematicViscosity,
  maxStaticPuddleThickness,
  nusseltFilmThickness,
  ohnesorge,
  reynolds,
  terminalVelocity,
  weber,
} from '../core/fluid';
import { Rng } from '../core/rng';
import { radToDeg, v3 } from '../core/vec3';
import { UrinalSurface, defaultSurfaceParams } from '../geometry/surface';
import { FlowCurve, solveBreakup } from '../sim/stream';
import { FilmSolver, defaultFilmParams } from '../sim/film';
import { ImpactResolver, defaultImpactParams } from '../sim/impact';
import { FlowPhase } from '../sim/metrics';
import { defaultStreamParams } from '../sim/stream';
import { applyPreset, Simulation, defaultConfig } from '../sim/simulation';
import { getPreset } from '../geometry/presets';

/**
 * Validation against closed-form results.
 *
 * The point of this file is that "physically accurate" is a claim, and a claim
 * needs evidence. Each case below has an answer that is known independently of
 * this code -- an analytical solution, a conservation law, or a published
 * correlation -- so a regression shows up as a failing number rather than as a
 * simulation that still looks plausible.
 *
 * The conservation tests matter as much as the analytical ones. Every headline
 * output is a volume, so a solver that leaks a fraction of a percent per second
 * produces confident, precise, wrong answers.
 */

export interface TestResult {
  name: string;
  group: string;
  passed: boolean;
  /** What the closed-form or reference answer is. */
  expected: string;
  /** What the code produced. */
  actual: string;
  /** Relative or absolute error, whichever the test states. */
  error: string;
  tolerance: string;
  /** Where the reference value comes from. */
  reference: string;
  notes?: string;
}

const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(1e-30, Math.abs(b));

function check(
  spec: Omit<TestResult, 'passed' | 'error' | 'tolerance'> & {
    errValue: number;
    tolValue: number;
  }
): TestResult {
  return {
    name: spec.name,
    group: spec.group,
    passed: spec.errValue <= spec.tolValue,
    expected: spec.expected,
    actual: spec.actual,
    error: `${(spec.errValue * 100).toFixed(3)}%`,
    tolerance: `${(spec.tolValue * 100).toFixed(1)}%`,
    reference: spec.reference,
    notes: spec.notes,
  };
}

// ---------------------------------------------------------------------------
// Group 1: jet breakup
// ---------------------------------------------------------------------------

function rayleighTests(): TestResult[] {
  const out: TestResult[] = [];

  // The three classical constants below are Rayleigh's *still-air* results, so
  // they are checked in still air: `solveBreakup`'s last argument is the ambient
  // gas density and passing 0 removes the aerodynamic term. That matters now that
  // the term exists. With air at 3 m/s the wavenumber reads 0.708 rather than
  // 0.695, which still slips inside a 3% tolerance -- so leaving these on the
  // default would have gone on passing while quietly comparing an air-affected
  // number to a no-air textbook constant, and the agreement would have been
  // coincidence rather than evidence. Air gets its own checks below.
  //
  // Tolerances tightened from 3%/3%/2% at the same time. The dispersion relation
  // now carries the exact I1(x)/I0(x) instead of its small-argument limit x/2, so
  // the peak sits at 0.6947 against Rayleigh's 0.697 -- 0.33%, and that residual
  // is the genuine viscous shift for urine (Oh = 2.1e-3), not approximation error.
  // The long-wave form was out by 1.44% and the old tolerance had to cover it.
  const b = solveBreakup(URINE_37C, 0.003, 3.0, 0.05, 0, 0);
  out.push(
    check({
      name: 'Most unstable wavenumber kr, still air',
      group: 'Rayleigh-Plateau breakup',
      expected: '0.697 (Rayleigh, exact Bessel)',
      actual: b.wavenumber.toFixed(4),
      errValue: rel(b.wavenumber, 0.697),
      tolValue: 0.01,
      reference: 'Rayleigh 1878',
      notes: 'Residual is the viscous shift, x_max ≈ 0.697/√(1+3·Oh)',
    })
  );
  out.push(
    check({
      name: 'Wavelength / jet diameter, still air',
      group: 'Rayleigh-Plateau breakup',
      expected: '4.51 (= 9.02 r / d)',
      actual: (b.wavelength / 0.003).toFixed(4),
      errValue: rel(b.wavelength / 0.003, 4.51),
      tolValue: 0.01,
      reference: 'Rayleigh 1878',
    })
  );
  // One wavelength of cylinder becomes one sphere: d_drop = (6 r^2 lambda)^(1/3),
  // which for lambda = 9.02r gives 1.891 d_jet.
  out.push(
    check({
      name: 'Droplet / jet diameter, still air (no satellites)',
      group: 'Rayleigh-Plateau breakup',
      expected: '1.891',
      actual: (b.mainDropletDiameter / 0.003).toFixed(4),
      errValue: rel(b.mainDropletDiameter / 0.003, 1.891),
      tolValue: 0.01,
      reference: 'Volume of one wavelength of cylinder recast as a sphere',
    })
  );
  // Mass has to balance across the main-drop / satellite split.
  const bs = solveBreakup(URINE_37C, 0.003, 3.0, 0.05, 0.06, 0);
  const r = 0.0015;
  const cyl = Math.PI * r * r * bs.wavelength;
  const drops =
    (Math.PI / 6) * bs.mainDropletDiameter ** 3 + (Math.PI / 6) * bs.satelliteDiameter ** 3;
  out.push(
    check({
      name: 'Breakup conserves volume across the satellite split',
      group: 'Rayleigh-Plateau breakup',
      expected: `${(cyl * 1e9).toFixed(4)} mm³ of cylinder`,
      actual: `${(drops * 1e9).toFixed(4)} mm³ of droplets`,
      errValue: rel(drops, cyl),
      tolValue: 1e-6,
      reference: 'Conservation of mass',
    })
  );
  // Higher surface tension drives the instability faster, so water must break up
  // sooner than urine at the same diameter and speed. Still air on both sides, so
  // the test isolates the capillary scaling it names: surface tension also enters
  // the gas Weber number, and letting air in would mix two mechanisms that happen
  // to point the same way.
  const bw = solveBreakup(WATER_20C, 0.003, 3.0, 0.05, 0, 0);
  out.push(
    check({
      name: 'Water breaks up sooner than urine (higher σ)',
      group: 'Rayleigh-Plateau breakup',
      expected: 'water L_b < urine L_b',
      actual: `water ${(bw.breakupLength * 100).toFixed(1)} cm vs urine ${(b.breakupLength * 100).toFixed(1)} cm`,
      errValue: bw.breakupLength < b.breakupLength ? 0 : 1,
      tolValue: 0.5,
      reference: 'Growth rate scales as sqrt(σ/ρr³)',
    })
  );
  // Viscosity damps the instability and stretches the jet. Still air on both
  // sides for the same reason.
  const thick = { ...URINE_37C, viscosity: 0.1 };
  const bt = solveBreakup(thick, 0.003, 3.0, 0.05, 0, 0);
  out.push(
    check({
      name: 'Viscosity lengthens the intact jet',
      group: 'Rayleigh-Plateau breakup',
      expected: 'viscous L_b > inviscid L_b',
      actual: `${(bt.breakupLength * 100).toFixed(1)} cm at 0.1 Pa·s vs ${(b.breakupLength * 100).toFixed(1)} cm`,
      errValue: bt.breakupLength > b.breakupLength ? 0 : 1,
      tolValue: 0.5,
      reference: 'Weber 1931 viscous correction',
    })
  );
  // Sanity against observation: a 3 mm, 3 m/s anatomical stream is seen to break
  // up at roughly 15-20 cm on high-speed video. In air, because that is what was
  // filmed.
  const bAir = solveBreakup(URINE_37C, 0.003, 3.0, 0.05, 0);
  out.push(
    check({
      name: 'Breakup length matches high-speed observation',
      group: 'Rayleigh-Plateau breakup',
      expected: '15–25 cm for 3 mm at 3 m/s',
      actual: `${(bAir.breakupLength * 100).toFixed(1)} cm`,
      errValue: bAir.breakupLength >= 0.15 && bAir.breakupLength <= 0.25 ? 0 : 1,
      tolValue: 0.5,
      reference:
        'Hurd & Truscott (BYU Splash Lab, APS DFD 2013) filmed a urethra replica at ' +
        '21 mL/s and put breakup at 6–7 inches, i.e. 15–18 cm',
      notes: 'Calibrated via ε₀/r = 0.05, on which the length depends only logarithmically',
    })
  );

  // What the tuned disturbance ratio is really standing in for.
  //
  // The dispersion relation above is a *laminar* linear-stability result, and the
  // stream is not laminar: at 22 mL/s through a 3 mm exit, Re ≈ 10 800. Laminar
  // theory with a physically plausible initial disturbance (thermal capillary
  // waves, ln(r/ε₀) ≈ 15) puts breakup around a metre; the measured figure is
  // 15–18 cm. The model reaches the right answer by carrying ε₀/r = 0.05, i.e.
  // ln(r/ε₀) = 3.0 -- so that constant is not "surface finish", it is turbulence,
  // and this check ties it to a published turbulent correlation rather than to a
  // recollection of a video.
  //
  // The two do not have the same velocity scaling and are not meant to: Grant &
  // Middleman goes as We^0.32, i.e. v^0.64, while linear theory goes as v. They
  // agree near the anatomical operating point, which is where the calibration was
  // made, and drift to ~30% by 6 m/s. That is a stated limitation, not a hidden one.
  {
    const d = 0.003;
    const v = 3.0;
    const weL = (URINE_37C.density * v * v * d) / URINE_37C.surfaceTension;
    const lGM = d * 8.51 * Math.pow(weL, 0.32);
    out.push(
      check({
        name: 'Breakup length agrees with the turbulent-jet correlation at the operating point',
        group: 'Rayleigh-Plateau breakup',
        expected: `${(lGM * 100).toFixed(1)} cm from L/d = 8.51·We^0.32 at We = ${weL.toFixed(0)}`,
        actual: `${(bAir.breakupLength * 100).toFixed(1)} cm`,
        errValue: rel(bAir.breakupLength, lGM),
        tolValue: 0.2,
        reference:
          'Grant & Middleman 1966, turbulent branch. Jet Re ≈ 10 800 at peak flow, so ' +
          'the turbulent branch is the applicable one',
        notes:
          'Anatomy closes the loop independently: a 7.1 mm² urethra at Qmax 22.5 mL/s ' +
          'gives a 3.0 mm jet at 3.2 m/s, and 1.89·d_jet = 5.7 mm drops against the ' +
          '4.4–7.2 mm measured by Thurairajah et al., PNAS Nexus 2025',
      })
    );
  }

  // -- Aerodynamic breakup: the first wind-induced regime --------------------
  //
  // The single most important qualitative fact about breakup length is that it is
  // *not* monotonic in jet velocity. It rises linearly while capillarity governs,
  // reaches a maximum, and then falls as gas inertia takes over -- the falling
  // branch is what defines the first wind-induced regime, and the maximum is
  // exactly what including the aerodynamic term predicts (Grant & Middleman 1966).
  //
  // Without that term the model claimed a coherent jet 1.35 m long at 20 m/s and
  // 2.08 m at 30 m/s, growing without bound. That is Trap 22 in a different
  // correlation: a relation used far outside the regime it describes. Breakup
  // length is one of the two levers the whole tool turns on, so this is checked
  // rather than assumed.
  {
    const speeds: number[] = [];
    for (let v = 0.5; v <= 30.001; v += 0.5) speeds.push(v);
    const lengths = speeds.map(
      (v) => solveBreakup(URINE_37C, 0.003, v, 0.05, 0.06).breakupLength
    );
    let peakIdx = 0;
    for (let i = 1; i < lengths.length; i++) if (lengths[i] > lengths[peakIdx]) peakIdx = i;
    const rises = peakIdx > 0 && lengths[peakIdx] > lengths[0];
    const falls = lengths[lengths.length - 1] < 0.6 * lengths[peakIdx];
    const interior = peakIdx > 0 && peakIdx < lengths.length - 1;
    out.push(
      check({
        name: 'Breakup length peaks and then falls with jet speed',
        group: 'Rayleigh-Plateau breakup',
        expected: 'a maximum at an interior speed, then a fall to under 60% of it',
        actual:
          `peak ${(lengths[peakIdx] * 100).toFixed(0)} cm at ${speeds[peakIdx].toFixed(1)} m/s, ` +
          `${(lengths[lengths.length - 1] * 100).toFixed(0)} cm at ${speeds[speeds.length - 1].toFixed(0)} m/s`,
        errValue: rises && falls && interior ? 0 : 1,
        tolValue: 0.5,
        reference:
          'Grant & Middleman 1966: the breakup curve has a maximum; the falling branch ' +
          'is the first wind-induced regime',
        notes:
          'Capillarity alone gives a length linear in speed for ever. Gas inertia ' +
          '(Weber 1931) is what turns the curve over',
      })
    );

    // The size of the correction, at both ends. Small where the air barely matters
    // and decisive where it dominates -- a term that is merely present but
    // mis-scaled would pass a sign test and fail this one.
    const weGas = (v: number, d: number) => (AIR_DENSITY * v * v * d) / URINE_37C.surfaceTension;
    const slowAir = solveBreakup(URINE_37C, 0.003, 3.0, 0.05, 0.06).breakupLength;
    const slowVac = solveBreakup(URINE_37C, 0.003, 3.0, 0.05, 0.06, 0).breakupLength;
    const fastAir = solveBreakup(URINE_37C, 0.003, 20.0, 0.05, 0.06).breakupLength;
    const fastVac = solveBreakup(URINE_37C, 0.003, 20.0, 0.05, 0.06, 0).breakupLength;
    const slowCut = 1 - slowAir / slowVac;
    const fastCut = 1 - fastAir / fastVac;
    out.push(
      check({
        name: 'Air shortens the jet in proportion to the gas Weber number',
        group: 'Rayleigh-Plateau breakup',
        expected: 'under 10% at We_gas ≈ 0.6, over 50% at We_gas ≈ 26',
        actual:
          `We_gas ${weGas(3, 0.003).toFixed(2)} → ${(100 * slowCut).toFixed(1)}% shorter; ` +
          `We_gas ${weGas(20, 0.003).toFixed(1)} → ${(100 * fastCut).toFixed(1)}% shorter`,
        errValue: slowCut > 0 && slowCut < 0.1 && fastCut > 0.5 ? 0 : 1,
        tolValue: 0.5,
        reference: 'Weber 1931 gas-inertia term, attenuated by Sterling & Sleicher 1975 C = 0.175',
        notes:
          'At the default posture the stream sits at We_gas ≈ 0.63, just past the ' +
          'Rayleigh-regime boundary, so the correction there is a few percent and the ' +
          'documented 21 cm breakup is unchanged',
      })
    );

    // Structural: air widens the unstable band past the Plateau limit. The old
    // growth-rate function returned a flat zero for every x >= 1, so it could not
    // represent this at all however large the gas term became.
    const fast = solveBreakup(URINE_37C, 0.003, 20.0, 0.05, 0.06);
    out.push(
      check({
        name: 'Air pushes the fastest mode past the Plateau limit kr = 1',
        group: 'Rayleigh-Plateau breakup',
        expected: 'kr > 1 at We_gas ≈ 26, and drops smaller than the still-air ones',
        actual:
          `kr ${fast.wavenumber.toFixed(3)} (still air ${solveBreakup(URINE_37C, 0.003, 20, 0.05, 0.06, 0).wavenumber.toFixed(3)}), ` +
          `d_drop/d_jet ${(fast.mainDropletDiameter / 0.003).toFixed(2)}`,
        errValue:
          fast.wavenumber > 1 &&
          fast.mainDropletDiameter < solveBreakup(URINE_37C, 0.003, 20, 0.05, 0.06, 0).mainDropletDiameter
            ? 0
            : 1,
        tolValue: 0.5,
        reference:
          'Sterling & Sleicher 1975: air moves the most rapidly growing mode to the ' +
          'short-wave part of the spectrum',
        notes:
          'Consequential rather than cosmetic — a faster jet makes smaller drops, and ' +
          'the Mundo splash group goes as d^0.75',
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Group 2: droplet aerodynamics
// ---------------------------------------------------------------------------

function dragTests(): TestResult[] {
  const out: TestResult[] = [];
  for (const d of [0.0005, 0.002, 0.005]) {
    const vT = terminalVelocity(URINE_37C, d);
    // At terminal velocity drag must exactly balance the buoyant weight. This is
    // self-consistency -- it uses the same Cd the solver used, so it can only
    // catch a failure of the iteration to converge. The Gunn & Kinzer case below
    // is the one that tests whether the drag law is right.
    const re = (AIR_DENSITY * vT * d) / AIR_VISCOSITY;
    const weGas = (AIR_DENSITY * vT * vT * d) / URINE_37C.surfaceTension;
    const cd = dropletDragCoefficient(re, weGas);
    const drag = 0.5 * AIR_DENSITY * cd * ((Math.PI * d * d) / 4) * vT * vT;
    const weight = ((URINE_37C.density - AIR_DENSITY) * GRAVITY * Math.PI * d ** 3) / 6;
    out.push(
      check({
        name: `Terminal velocity force balance, d = ${(d * 1000).toFixed(1)} mm`,
        group: 'Droplet aerodynamics',
        expected: `drag = weight = ${weight.toExponential(3)} N`,
        actual:
          `${drag.toExponential(3)} N at ${vT.toFixed(3)} m/s ` +
          `(Re ${re.toFixed(0)}, We_gas ${weGas.toFixed(2)})`,
        errValue: rel(drag, weight),
        tolValue: 0.005,
        reference: 'Clift & Gauvin drag with the Liu-Reitz deformation factor',
      })
    );
  }
  // -- Against a real measurement, not against ourselves ---------------------
  //
  // The three force-balance cases above are self-consistency: they compute drag
  // with the same Cd the solver used and confirm it equals the weight. That
  // proves the iteration converges and says nothing at all about whether the drag
  // law is right. Gunn & Kinzer measured terminal velocities of real water drops
  // and the numbers have stood since 1949, so this is the first check here that
  // the drag law could actually fail.
  //
  // It found something. The old law -- Schiller-Naumann below Re = 1000, flat 0.44
  // above, rigid sphere throughout -- was 22.0% out at 5 mm. Replacing 0.44 with
  // Clift & Gauvin and *keeping* the rigid sphere makes it worse, 30.6%, because
  // the too-high plateau had been quietly standing in for the missing deformation.
  // With both corrected the worst error over 0.5-5 mm is 6.5%.
  {
    const gunnKinzer: Array<[number, number]> = [
      [0.0005, 2.06],
      [0.001, 4.03],
      [0.002, 6.49],
      [0.003, 8.06],
      [0.004, 8.83],
      [0.005, 9.09],
    ];
    let worst = 0;
    let worstD = 0;
    for (const [d, vRef] of gunnKinzer) {
      const e = rel(terminalVelocity(WATER_20C, d), vRef);
      if (e > worst) {
        worst = e;
        worstD = d;
      }
    }
    out.push(
      check({
        name: 'Terminal velocity matches measured raindrops, 0.5–5 mm',
        group: 'Droplet aerodynamics',
        expected: '2.06 / 4.03 / 6.49 / 8.06 / 8.83 / 9.09 m/s at 0.5–5 mm',
        actual:
          gunnKinzer.map(([d]) => terminalVelocity(WATER_20C, d).toFixed(2)).join(' / ') +
          ` m/s (worst at ${(worstD * 1000).toFixed(1)} mm)`,
        errValue: worst,
        tolValue: 0.09,
        reference: 'Gunn & Kinzer 1949, J. Meteorology 6, 243–248, at 1013 mb and 20 °C',
        notes:
          'The only test here the drag law can fail. Rigid-sphere drag alone reads ' +
          '30.6% high at 5 mm; a drop that size is visibly flattened and carries about ' +
          'twice a sphere’s drag',
      })
    );
  }

  // The drag law must not have a seam in it. The old one switched from
  // Schiller-Naumann to a flat 0.44 at Re = 1000 -- only a 0.39% step, but the
  // model's main drops cross that Reynolds number as they decelerate, and a
  // piecewise law invites a much larger one next time it is edited.
  {
    const below = dragCoefficient(999.999);
    const above = dragCoefficient(1000.001);
    out.push(
      check({
        name: 'Drag coefficient is continuous across the Newton transition',
        group: 'Droplet aerodynamics',
        expected: 'no step at Re = 1000',
        actual: `Cd = ${below.toFixed(6)} below, ${above.toFixed(6)} above`,
        errValue: rel(above, below),
        tolValue: 1e-5,
        reference: 'Clift & Gauvin 1970 is a single expression over the whole range',
      })
    );
  }

  // Aerodynamic breakup is deliberately absent, and this records why: the drops
  // this model makes never get near the threshold for it. If a future change
  // makes them, this fails and the omission has to be revisited.
  {
    const dMax = 0.006;
    const vMax = 8;
    const weMax = (AIR_DENSITY * vMax * vMax * dMax) / URINE_37C.surfaceTension;
    out.push(
      check({
        name: 'Airborne droplets stay below the aerodynamic breakup threshold',
        group: 'Droplet aerodynamics',
        expected: 'We_gas < 11 for any droplet this model produces',
        actual: `worst case ${(dMax * 1000).toFixed(0)} mm at ${vMax} m/s gives We_gas = ${weMax.toFixed(1)}`,
        errValue: weMax < 11 ? 0 : 1,
        tolValue: 0.5,
        reference:
          'Bag-breakup onset We_gas = 11 ± 2 (Guildenbecher, López-Rivera & Sojka 2009); ' +
          '12 (Pilch & Erdman 1987)',
        notes:
          'So secondary atomisation is not modelled, on purpose. Deformation is, because ' +
          'that begins at We_gas ≈ 1 and the main drops reach it',
      })
    );
  }

  // Stokes limit: for very small droplets Cd -> 24/Re, giving v = ρ g d²/(18 μ).
  const dSmall = 2e-5;
  const vStokes = ((URINE_37C.density - AIR_DENSITY) * GRAVITY * dSmall * dSmall) / (18 * AIR_VISCOSITY);
  const vSim = terminalVelocity(URINE_37C, dSmall);
  out.push(
    check({
      name: 'Stokes limit for a 20 µm droplet',
      group: 'Droplet aerodynamics',
      expected: `${vStokes.toFixed(5)} m/s`,
      actual: `${vSim.toFixed(5)} m/s`,
      errValue: rel(vSim, vStokes),
      tolValue: 0.05,
      reference: 'Stokes 1851',
    })
  );
  return out;
}

// ---------------------------------------------------------------------------
// Group 3: the thin film
// ---------------------------------------------------------------------------

/** A flat vertical plate, for comparison against the Nusselt solution. */
function flatPlateSurface(): UrinalSurface {
  const p = defaultSurfaceParams();
  p.backWallMode = 'planar';
  p.backWallTilt = 0;
  p.backWallRun = 0;
  // Zero forward reach for the rim, which is what makes this a plate rather than a
  // bowl. It matters more than it used to: the loft's rows now run out AND UP to
  // the rim, so a fixture with any reach at all has real side walls and a row
  // injected across the top of this control would run down into them instead of
  // falling straight. `buildRimProfile` treats zero as the explicit degenerate
  // case for exactly this reason -- see the note there.
  p.wrapDepth = 0;
  p.widthRim = 0.3;
  p.widthSump = 0.3;
  p.widthLip = 0.3;
  p.taperExponent = 1;
  p.rimHeight = 0.5;
  p.throatHeight = 0.06;
  p.ribMode = 'none';
  return new UrinalSurface(p, { nu: 40, nv: 200 });
}

function filmTests(): TestResult[] {
  const out: TestResult[] = [];
  const wall = WALL_MATERIALS[0];

  // --- Nusselt falling film -------------------------------------------------
  {
    const s = flatPlateSurface();
    const film = new FilmSolver(s, URINE_37C, wall, defaultFilmParams());
    const q = 7.33e-5; // m²/s per unit width, ~22 mL/s over 0.3 m
    const dt = 1 / 2000;
    for (let i = 0; i < 40000; i++) {
      film.injectRow(2, q, dt);
      film.step(dt);
    }
    const probe = 40 * s.nu + s.nu / 2;
    const hSim = film.h[probe];
    const uSim = film.speedAt(probe);
    const hRef = nusseltFilmThickness(URINE_37C, q, GRAVITY);
    const uRef = (GRAVITY * hRef * hRef) / (3 * kinematicViscosity(URINE_37C));

    out.push(
      check({
        name: 'Nusselt film thickness on a vertical wall',
        group: 'Thin film solver',
        expected: `${(hRef * 1e6).toFixed(2)} µm`,
        actual: `${(hSim * 1e6).toFixed(2)} µm`,
        errValue: rel(hSim, hRef),
        tolValue: 0.02,
        reference: 'Nusselt 1916: h = (3νq/g)^(1/3)',
        notes: 'Exercises wall shear, gravity projection and advection together',
      })
    );
    out.push(
      check({
        name: 'Nusselt film mean velocity',
        group: 'Thin film solver',
        expected: `${uRef.toFixed(4)} m/s`,
        actual: `${uSim.toFixed(4)} m/s`,
        errValue: rel(uSim, uRef),
        tolValue: 0.02,
        reference: 'Nusselt 1916: u = gh²/(3ν)',
      })
    );
    // Steady state means the flux is the same at every height.
    const fluxAt = (row: number) => {
      let f = 0;
      for (let i = 0; i < s.nu; i++) {
        const c = row * s.nu + i;
        f += film.hv[c] * s.cellDu[c];
      }
      return f;
    };
    const f20 = fluxAt(20);
    const f80 = fluxAt(80);
    out.push(
      check({
        name: 'Flux conserved down the wall at steady state',
        group: 'Thin film solver',
        expected: `${(q * 0.3).toExponential(4)} m³/s at every height`,
        actual: `${f20.toExponential(4)} at row 20, ${f80.toExponential(4)} at row 80`,
        errValue: Math.max(rel(f20, q * 0.3), rel(f80, q * 0.3)),
        tolValue: 0.02,
        reference: 'Conservation of mass in steady flow',
      })
    );
  }

  // --- Capillary puddle depth ----------------------------------------------
  {
    const p = defaultSurfaceParams();
    p.sumpSlope = 0;
    p.drainRadius = 0.0001;
    p.widthSump = 0.24;
    const s = new UrinalSurface(p, { nu: 64, nv: 128 });
    const fp = defaultFilmParams();
    fp.drainCoefficient = 0; // blocked outlet, so liquid has to stand
    const film = new FilmSolver(s, URINE_37C, wall, fp);

    let sumpRow = 0;
    let lowest = Infinity;
    for (let j = 0; j < s.nv; j++) {
      const c = j * s.nu + s.nu / 2;
      if (s.cellPos[c * 3 + 1] < lowest) {
        lowest = s.cellPos[c * 3 + 1];
        sumpRow = j;
      }
    }
    const hRef = maxStaticPuddleThickness(URINE_37C, wall.contactAngleScale);

    // Started deliberately *shallower* than the equilibrium depth and spread over
    // a patch, so the solver has to find the answer rather than be handed it. Left
    // alone in a level basin, the pool collects at the low point, deepens, and
    // spreads along the level contour until its depth reaches the point where the
    // pinned contact line can hold it. That final depth is a pure capillary
    // result and is known independently of this code.
    //
    // The deposit is a localised blob, and it has to stay localised. Sizing it from
    // the level floor instead looks more principled and is wrong: with a level sump
    // most of the basin lies within half a millimetre of the lowest point, so a
    // patch scaled to that area spreads liquid over the whole bowl and the depth
    // then rises monotonically with volume -- 1.5 mm, 2.2 mm, 3.2 mm -- because the
    // liquid is being held by the basin walls rather than by its own contact line.
    // That measures the shape of the sump, not capillarity.
    //
    // Kept deliberately small, so the blob collects, deepens, and spreads until the
    // contact line pins. The evidence that the result is the pinning depth and not
    // an artefact of the initial condition is that it is the same depth for one,
    // one and a half, and two times this fill -- 1.75, 1.71, 1.70 mm -- so it is an
    // attractor, which is a stronger statement than starting below it and arriving
    // once.
    const patch: number[] = [];
    for (let j = sumpRow - 2; j <= sumpRow + 2; j++) {
      for (let i = s.nu / 2 - 4; i < s.nu / 2 + 4; i++) patch.push(j * s.nu + i);
    }
    const fill = hRef;
    for (const c of patch) film.deposit(c, fill * s.cellArea[c], 0, 0);
    const dt = 1 / 2000;
    for (let i = 0; i < 20000; i++) film.step(dt);

    let maxH = 0;
    for (let c = 0; c < film.h.length; c++) maxH = Math.max(maxH, film.h[c]);

    out.push(
      check({
        name: 'Standing pool settles at the capillary depth limit',
        group: 'Thin film solver',
        expected: `${(hRef * 1000).toFixed(3)} mm`,
        actual: `${(maxH * 1000).toFixed(3)} mm`,
        errValue: rel(maxH, hRef),
        tolValue: 0.08,
        reference: 'h_max = 2 l_c sin(θ/2), capillary pressure against hydrostatic',
        notes:
          `capillary length ${(capillaryLength(URINE_37C) * 1000).toFixed(2)} mm; ` +
          `same depth for 1x, 1.5x and 2x this fill, so it is an attractor`,
      })
    );
    out.push(
      check({
        name: 'Standing pool never exceeds the capillary depth limit',
        group: 'Thin film solver',
        expected: `at most ${(hRef * 1000).toFixed(3)} mm`,
        actual: `${(maxH * 1000).toFixed(3)} mm`,
        errValue: Math.max(0, (maxH - hRef) / hRef),
        tolValue: 0.02,
        reference: 'Same relation as a one-sided bound',
      })
    );
  }

  // --- Volume closure -------------------------------------------------------
  {
    const p = defaultSurfaceParams();
    const s = new UrinalSurface(p, { nu: 64, nv: 128 });
    const film = new FilmSolver(s, URINE_37C, wall, defaultFilmParams());
    const nCells = s.nu * s.nv;
    const target = 50e-6;
    for (let k = 0; k < 200; k++) {
      film.deposit(Math.floor((k / 200) * nCells) % nCells, target / 200, 0, 0);
    }
    const dt = 1 / 1000;
    for (let i = 0; i < 15000; i++) film.step(dt);
    const accounted =
      film.totalVolume() +
      film.drainedVolume +
      film.spilledSide +
      film.spilledTop +
      film.spilledLip +
      film.drippedVolume;
    out.push(
      check({
        name: 'Film solver conserves volume exactly',
        group: 'Thin film solver',
        expected: `${(film.depositedVolume * 1e6).toFixed(6)} mL deposited`,
        actual: `${(accounted * 1e6).toFixed(6)} mL accounted`,
        errValue: rel(accounted, film.depositedVolume),
        tolValue: 1e-4,
        reference: 'Conservation of mass; finite-volume fluxes on true face lengths',
      })
    );
    out.push(
      check({
        name: 'Advection never clamps a negative thickness',
        group: 'Thin film solver',
        expected: '0 µL invented by clamping',
        actual: `${(film.numericalGainVolume * 1e9).toFixed(6)} µL`,
        errValue: film.numericalGainVolume / Math.max(1e-12, film.depositedVolume),
        tolValue: 1e-9,
        reference: 'Positivity-preserving flux limiter',
        notes: 'Without the limiter this reached ~2% of the void',
      })
    );
    out.push(
      check({
        name: 'Film solver produced no non-finite cells',
        group: 'Thin film solver',
        expected: '0 sanitised cells',
        actual: `${film.sanitisedCells}`,
        errValue: film.sanitisedCells === 0 ? 0 : 1,
        tolValue: 0.5,
        reference: 'Numerical robustness',
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Group 4: the uroflowmetry curve
// ---------------------------------------------------------------------------

function flowTests(): TestResult[] {
  const out: TestResult[] = [];
  const sp = defaultStreamParams();
  const fc = new FlowCurve(sp);
  const integrated = fc.volumeBy(fc.duration, 20000);
  out.push(
    check({
      name: 'Flow curve integrates to the stated void volume',
      group: 'Flow curve',
      expected: `${(sp.voidVolume * 1e6).toFixed(4)} mL`,
      actual: `${(integrated * 1e6).toFixed(4)} mL`,
      errValue: rel(integrated, sp.voidVolume),
      tolValue: 1e-3,
      reference: 'Beta-function pulse normalised by its own integral',
    })
  );
  let qm = 0;
  for (let i = 0; i <= 4000; i++) qm = Math.max(qm, fc.rateAt((i / 4000) * fc.duration));
  out.push(
    check({
      name: 'Flow curve peaks at the stated peak rate',
      group: 'Flow curve',
      expected: `${(sp.peakFlowRate * 1e6).toFixed(3)} mL/s`,
      actual: `${(qm * 1e6).toFixed(3)} mL/s`,
      errValue: rel(qm, sp.peakFlowRate),
      tolValue: 2e-3,
      reference: 'Analytic peak of the shape function',
    })
  );
  const ratio = fc.peakFlowRate / fc.meanFlowRate;
  out.push(
    check({
      name: 'Qmax/Qave inside the clinical range',
      group: 'Flow curve',
      expected: '1.4 – 2.3',
      actual: ratio.toFixed(3),
      errValue: ratio >= 1.4 && ratio <= 2.3 ? 0 : 1,
      tolValue: 0.5,
      reference: 'Uroflowmetry norms for adult males',
    })
  );
  const tPeak = fc.peakFraction * fc.duration;
  out.push(
    check({
      name: 'Time to peak flow inside the clinical range',
      group: 'Flow curve',
      expected: '3 – 9 s',
      actual: `${tPeak.toFixed(2)} s`,
      errValue: tPeak >= 3 && tPeak <= 9 ? 0 : 1,
      tolValue: 0.5,
      reference: 'Uroflowmetry norms for adult males',
    })
  );
  return out;
}

// ---------------------------------------------------------------------------
// Group 5: geometry and the impingement criterion
// ---------------------------------------------------------------------------

function geometryTests(): TestResult[] {
  const out: TestResult[] = [];

  // A stream travelling horizontally into a vertical wall is a 90 degree impact.
  {
    const s = flatPlateSurface();
    const cell = 40 * s.nu + s.nu / 2;
    const angle = s.impingementAngle(cell, v3(0, 0, -1));
    out.push(
      check({
        name: 'Horizontal stream on a vertical wall reads 90°',
        group: 'Geometry',
        expected: '90.0°',
        actual: `${radToDeg(angle).toFixed(3)}°`,
        errValue: rel(angle, Math.PI / 2),
        tolValue: 0.01,
        reference: 'Definition: angle measured from the surface plane',
      })
    );
    const graze = s.impingementAngle(cell, v3(0, -Math.SQRT1_2, -Math.SQRT1_2));
    out.push(
      check({
        name: 'Stream at 45° to a vertical wall reads 45°',
        group: 'Geometry',
        expected: '45.0°',
        actual: `${radToDeg(graze).toFixed(3)}°`,
        errValue: rel(graze, Math.PI / 4),
        tolValue: 0.01,
        reference: 'Definition',
      })
    );
  }

  // Surface area from two independent formulas.
  {
    const s = new UrinalSurface(defaultSurfaceParams(), { nu: 64, nv: 128 });
    let sum = 0;
    for (let c = 0; c < s.cellArea.length; c++) sum += s.cellArea[c];
    out.push(
      check({
        name: 'Cell areas sum to the reported total',
        group: 'Geometry',
        expected: `${(s.totalArea * 1e4).toFixed(4)} cm²`,
        actual: `${(sum * 1e4).toFixed(4)} cm²`,
        errValue: rel(sum, s.totalArea),
        tolValue: 1e-9,
        reference: 'Internal consistency',
      })
    );
    // Normals must be consistently oriented, or the film's gravity projection
    // and every impact angle flips sign somewhere on the surface.
    let flips = 0;
    for (let j = 0; j < s.nv; j++) {
      for (let i = 0; i < s.nu - 1; i++) {
        const a = j * s.nu + i;
        const b = a + 1;
        const d =
          s.cellNormal[a * 3] * s.cellNormal[b * 3] +
          s.cellNormal[a * 3 + 1] * s.cellNormal[b * 3 + 1] +
          s.cellNormal[a * 3 + 2] * s.cellNormal[b * 3 + 2];
        if (d < 0) flips++;
      }
    }
    out.push(
      check({
        name: 'Surface normals consistently oriented inward',
        group: 'Geometry',
        expected: '0 sign flips between neighbours',
        actual: `${flips}`,
        errValue: flips === 0 ? 0 : 1,
        tolValue: 0.5,
        reference: 'Profile tangent rotated a quarter turn',
      })
    );
    out.push(
      check({
        name: 'Default profile does not self-intersect',
        group: 'Geometry',
        expected: 'false',
        actual: String(s.profile.info.selfIntersects),
        errValue: s.profile.info.selfIntersects ? 1 : 0,
        tolValue: 0.5,
        reference: 'Manufacturability and parameterisation validity',
      })
    );
  }

  // The constant-angle generator has to hold the angle it was asked for.
  {
    const p = defaultSurfaceParams();
    p.backWallMode = 'constantAngle';
    p.targetImpingementAngle = (25 * Math.PI) / 180;
    p.streamOrigin = { z: 0.45, y: 0.62 };
    p.streamSpeed = 3.0;
    p.rimHeight = 0.46;
    p.throatHeight = 0.03;
    const s = new UrinalSurface(p, { nu: 48, nv: 128 });
    const achieved = s.profile.info.achievedAngle;
    out.push(
      check({
        name: 'Constant-angle generator holds its target angle',
        group: 'Geometry',
        expected: '25.00°',
        actual: `${radToDeg(achieved).toFixed(3)}°`,
        errValue: rel(achieved, p.targetImpingementAngle),
        tolValue: 0.02,
        reference: 'Integration of the constant-angle condition (PNAS 2025 construction)',
        notes: 'Measured against the ballistic arrival direction, not a straight ray',
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Group 6: the splash threshold
// ---------------------------------------------------------------------------

function splashTests(): TestResult[] {
  const out: TestResult[] = [];
  const resolver = new ImpactResolver(
    defaultImpactParams(),
    URINE_37C,
    WALL_MATERIALS[0],
    new Rng(1)
  );

  // The reported critical angle must be the angle at which the threshold ratio
  // is actually 1. Verified by probing at that angle.
  const speed = 3.0;
  const d = 0.0055;
  const hFilm = 3e-4;
  const at60 = resolver.probeThreshold(speed, (60 * Math.PI) / 180, d, hFilm);
  const atCrit = resolver.probeThreshold(speed, at60.criticalAngle, d, hFilm);
  out.push(
    check({
      name: 'Reported critical angle is where the threshold is met',
      group: 'Splash threshold',
      expected: 'threshold ratio = 1.000 at the reported critical angle',
      actual: `${atCrit.ratio.toFixed(4)} at ${radToDeg(at60.criticalAngle).toFixed(2)}°`,
      errValue: rel(atCrit.ratio, 1),
      tolValue: 0.02,
      reference: 'Self-consistency of the analytic inversion',
    })
  );

  // Splashing must be driven by the normal component, so the ratio has to scale
  // as sin² on the wetted branch.
  const a1 = resolver.probeThreshold(speed, (60 * Math.PI) / 180, d, hFilm);
  const a2 = resolver.probeThreshold(speed, (30 * Math.PI) / 180, d, hFilm);
  const predicted =
    a1.ratio * (Math.sin((30 * Math.PI) / 180) / Math.sin((60 * Math.PI) / 180)) ** 2;
  out.push(
    check({
      name: 'Threshold scales as sin²(impingement angle) on a wetted wall',
      group: 'Splash threshold',
      expected: predicted.toFixed(4),
      actual: a2.ratio.toFixed(4),
      errValue: rel(a2.ratio, predicted),
      tolValue: 0.02,
      reference: 'We_normal ∝ v²sin²α; this is the mechanism behind the 30° rule',
    })
  );

  // Cross-check against the published criterion: for realistic urinal conditions
  // the critical angle should land near 30 degrees. Arrived at from the Cossali
  // wetted-wall correlation, which knows nothing about urinals.
  out.push(
    check({
      name: 'Predicted critical angle brackets the published 30° criterion',
      group: 'Splash threshold',
      expected: '18° – 36° for a 5.5 mm drop at 3 m/s into a 0.3 mm film',
      actual: `${radToDeg(at60.criticalAngle).toFixed(1)}°`,
      errValue:
        radToDeg(at60.criticalAngle) >= 18 && radToDeg(at60.criticalAngle) <= 36 ? 0 : 1,
      tolValue: 0.5,
      reference: 'Cossali et al. 1997 threshold vs Thurairajah et al. PNAS 2025',
      notes: 'Independent derivation reaching the published result is the main accuracy evidence',
    })
  );

  // The dry and wetted branches use *different* dimensionless groups, and the
  // model has to keep them apart. Mundo's K = We^0.5 Re^0.25 against ~57.7;
  // Cossali's K = We Oh^-0.4 against 2100 + 5880 delta^1.44. Since Oh =
  // sqrt(We)/Re the second is We^0.8 Re^0.4, i.e. the first raised to 1.6 --
  // exactly, not approximately.
  //
  // Checked because the comment in constants.ts asserted for a long time that the
  // two shared the We^0.5 Re^0.25 grouping "so a single K can be compared against
  // either threshold". The code never did that, but the comment invited someone to
  // make it so, and collapsing the two would move the wetted threshold by a power
  // of 1.6 -- silently, and in a direction that flatters the fixture.
  {
    let worst = 0;
    for (const [v, d] of [
      [1, 0.002],
      [3, 0.0055],
      [5, 0.0005],
      [0.4, 0.004],
    ] as const) {
      const kM = Math.sqrt(weber(URINE_37C, v, d)) * Math.pow(reynolds(URINE_37C, v, d), 0.25);
      const kC = weber(URINE_37C, v, d) * Math.pow(ohnesorge(URINE_37C, d), -0.4);
      worst = Math.max(worst, rel(kC, Math.pow(kM, 1.6)));
    }
    // Where each threshold sits once mapped onto the other's scale.
    const dryOnCossali = Math.pow(DRY_SPLASH_K_SMOOTH, 1.6);
    const wetThin = WET_SPLASH_K_BASE + WET_SPLASH_K_FILM * Math.pow(0.005, 1.44);
    out.push(
      check({
        name: 'The dry and wetted correlations stay on their own scales',
        group: 'Splash threshold',
        expected: 'K_Cossali = K_Mundo^1.6 identically, over four decades of conditions',
        actual: `worst deviation ${(100 * worst).toExponential(2)}%`,
        errValue: worst,
        tolValue: 1e-9,
        reference: 'Oh = √We/Re, so We·Oh^-0.4 = We^0.8·Re^0.4 = (We^0.5·Re^0.25)^1.6',
        notes:
          `On one scale the two thresholds are dry ${dryOnCossali.toFixed(0)} against ` +
          `wetted ${wetThin.toFixed(0)} at δ = 0.005, so as implemented a thinly wetted ` +
          `wall is ${(Math.pow(wetThin, 1 / 1.6) / DRY_SPLASH_K_SMOOTH).toFixed(2)}× harder ` +
          'to splash than a dry one. Cossali also published a dry, roughness-dependent ' +
          'threshold 649 + 3.76/R^0.63 whose rough asymptote IS Mundo\'s 57.7 — so this ' +
          'branch is a rough wall, not the smooth glaze it is labelled. See constants.ts',
      })
    );
  }

  // A slow droplet must simply deposit.
  const slow = resolver.probeThreshold(0.35, Math.PI / 2, 0.002, hFilm);
  out.push(
    check({
      name: 'Slow droplet deposits rather than splashing',
      group: 'Splash threshold',
      expected: 'threshold ratio < 1',
      actual: slow.ratio.toFixed(4),
      errValue: slow.ratio < 1 ? 0 : 1,
      tolValue: 0.5,
      reference: 'Deposition regime',
    })
  );
  return out;
}

// ---------------------------------------------------------------------------
// Group 7: end-to-end
// ---------------------------------------------------------------------------

function endToEndTests(): TestResult[] {
  const out: TestResult[] = [];

  const cfg = defaultConfig();
  cfg.surface = { ...getPreset('classic-bowl').params };
  cfg.stream.voidVolume = 80e-6;
  cfg.drainTime = 8;
  cfg.resolutionU = 48;
  cfg.resolutionV = 96;
  cfg.particleCapacity = 90000;
  const sim = new Simulation(cfg);
  const rep = sim.run();

  out.push(
    check({
      name: 'End-to-end volume closure',
      group: 'End to end',
      expected: 'every drop emitted is accounted for',
      actual: `${(100 * rep.volumeClosureError).toFixed(4)}% unaccounted of ${(rep.voidedVolume * 1e6).toFixed(2)} mL`,
      errValue: rep.volumeClosureError,
      tolValue: 0.01,
      reference: 'Conservation of mass across film, air, drain, capture and overflow',
      notes: 'The strongest single check on the whole pipeline',
    })
  );
  out.push(
    check({
      name: 'Voided volume matches the requested void',
      group: 'End to end',
      expected: `${(cfg.stream.voidVolume * 1e6).toFixed(3)} mL`,
      actual: `${(rep.voidedVolume * 1e6).toFixed(3)} mL`,
      errValue: rel(rep.voidedVolume, cfg.stream.voidVolume),
      tolValue: 0.01,
      reference: 'Emitter discretisation must not lose or invent liquid',
    })
  );
  out.push(
    check({
      name: 'Film solver stayed stable through a full run',
      group: 'End to end',
      expected: '0 non-finite cells',
      actual: `${sim.film.sanitisedCells} sanitised, ${sim.film.substepBudgetExceeded} substep overruns`,
      errValue: sim.film.sanitisedCells === 0 ? 0 : 1,
      tolValue: 0.5,
      reference: 'Numerical robustness',
    })
  );

  // ---- The design conclusion ---------------------------------------------
  // Two geometries, identical stream, identical seed, identical aim.
  //
  // The comparison is made on the *sustained-flow* part of the void rather than
  // on the whole of it, and that distinction is load-bearing rather than a
  // convenience. A void is not one experiment: the stream rises, holds near peak
  // for most of the volume, then decays to a dribble. Only while it is fast does
  // it reach the wall the design governs. Once it slows it falls short on the same
  // aim, and on a deep fixture short means the fixture's own front rim.
  //
  // Aggregating the two measures wall shape and envelope depth together, and the
  // aggregate is not even stably signed: measured flat-versus-constant-angle
  // ratios of 0.42x at 90 mm stand-off, 0.51x at 120 mm and 1.22x at 180 mm. The
  // sustained-flow figure isolates the wall and is stable -- across five seeds the
  // flat slab sits at 354-579 uL/L while the constant-angle wall sits at 0-1.
  const mk = (preset: string, aim: number, seed: number) => {
    const c = defaultConfig();
    const p = getPreset(preset);
    // The preset's own casting, metalwork and water, not the defaults. This took
    // the interior alone, so the headline claim was measured on two fixtures that
    // neither the app nor the picker shows: a `flat-wall` wearing the default
    // bowl's exterior. The casting is solid and splashes, it hides a fifth to a
    // half of the interior from the exit point, and the metalwork stands closer
    // to the user than any ceramic, so "same stream, same seed, same aim" was
    // controlling everything except the part of the fixture nearest the user.
    // `applyPreset` is one call so a fourth per-preset field cannot re-open it.
    applyPreset(c, p);
    c.drainTime = 2;
    c.resolutionU = 48;
    c.resolutionV = 96;
    c.particleCapacity = 140000;
    c.seed = seed;
    c.aimTargetV = aim;
    const sim = new Simulation(c);
    const rep = sim.run();
    return { rep, act: sim.metrics.actualImpingement() };
  };

  const aim = 0.16;
  const flat = mk('flat-wall', aim, 4242);
  const shallow = mk('nautilus-tall', aim, 4242);

  // The mechanism, measured over tens of thousands of impacts and therefore
  // stable: a shallower wall converts less of the arriving liquid into ejecta.
  out.push(
    check({
      name: 'Shallow wall ejects a smaller fraction of arriving liquid',
      group: 'End to end',
      expected: 'constant-angle splash fraction < flat',
      actual:
        `flat ${(100 * flat.rep.splash.splashFraction).toFixed(2)}% vs ` +
        `constant-angle ${(100 * shallow.rep.splash.splashFraction).toFixed(2)}%`,
      errValue: shallow.rep.splash.splashFraction < flat.rep.splash.splashFraction ? 0 : 1,
      tolValue: 0.5,
      reference: 'We_normal ∝ sin²α drives the splash threshold',
      notes: 'Averaged over ~30k impacts, so insensitive to seed',
    })
  );
  out.push(
    check({
      name: 'Shallow wall receives far less liquid above the criterion',
      group: 'End to end',
      expected: 'constant-angle arriving-volume-over-30° well below flat',
      actual:
        `flat ${(100 * flat.act.fractionOverCritical).toFixed(1)}% vs ` +
        `constant-angle ${(100 * shallow.act.fractionOverCritical).toFixed(1)}%`,
      errValue: shallow.act.fractionOverCritical < 0.6 * flat.act.fractionOverCritical ? 0 : 1,
      tolValue: 0.5,
      reference: 'Impingement criterion, measured where the stream actually landed',
    })
  );
  // The headline claim, measured where the stream actually reaches the governed
  // wall: an order-of-magnitude reduction in what comes back at the user.
  const ratio =
    flat.rep.splash.sustainedMicrolitresPerLitre /
    Math.max(1, shallow.rep.splash.sustainedMicrolitresPerLitre);
  out.push(
    check({
      name: 'Constant-angle wall cuts sustained-flow splashback several-fold',
      group: 'End to end',
      expected: 'at least 5× less µL per litre voided than the flat control',
      actual:
        `flat ${flat.rep.splash.sustainedMicrolitresPerLitre.toFixed(0)} µL/L vs ` +
        `constant-angle ${shallow.rep.splash.sustainedMicrolitresPerLitre.toFixed(0)} µL/L ` +
        `(${ratio.toFixed(1)}×)`,
      errValue: ratio >= 5 ? 0 : 1,
      tolValue: 0.5,
      reference: 'Thurairajah et al., PNAS 2025 report order-of-magnitude suppression',
      notes:
        'Measured over the sustained-flow phase, which is where the stream reaches the ' +
        'wall the generator governs. Across five seeds on the interiors alone: flat ' +
        '354-579 µL/L, constant-angle 0-1 µL/L. With each control carrying its own ' +
        'casting and metalwork, seed 4242 reads flat 495 vs constant-angle 0',
    })
  );

  // The trade that comes with it, and the reason the aggregate figure is not the
  // headline. This is a claim about urination rather than about any one fixture,
  // and it holds on every geometry tested.
  for (const [label, r] of [
    ['flat slab', flat.rep.splash],
    ['constant-angle', shallow.rep.splash],
  ] as const) {
    const weakRatio = r.weakMicrolitresPerLitre / Math.max(1, r.sustainedMicrolitresPerLitre);
    out.push(
      check({
        name: `Weak flow dominates splashback (${label})`,
        group: 'End to end',
        expected: 'weak rise and tail at least 4× worse per litre than sustained flow',
        actual:
          `sustained ${r.sustainedMicrolitresPerLitre.toFixed(0)} µL/L vs ` +
          `weak ${r.weakMicrolitresPerLitre.toFixed(0)} µL/L (${weakRatio.toFixed(1)}×)`,
        errValue: weakRatio >= 4 ? 0 : 1,
        tolValue: 0.5,
        reference:
          'A slow stream leaves on the same aim but falls short and steeper, so it lands ' +
          'nearer the front of the fixture at a higher impingement angle',
        notes:
          'Measured across five seeds on the interiors alone: flat slab 10.3-16.6×, ' +
          'oval bowl 6.1-7.2×, constant-angle over 17000× because its sustained figure ' +
          'is ~0. With the controls carrying their own casting, seed 4242 reads flat ' +
          '20.8× and constant-angle 5260×',
      })
    );
  }

  // ---- Regression guard: the exterior is not a perfect absorber -----------
  // A droplet reaching the casting used to be booked straight to the fixture
  // exterior and killed -- no splash, no secondaries. For most aim points that is
  // a rounding error. Aimed low enough to have to clear the front rim, the stream
  // itself strikes the casting, and the absorber then swallowed the entire void:
  // measured 118.6 mL of a 120 mL void, reporting zero impacts, an empty film and
  // *zero splashback* for the one aim that in reality sprays straight back off the
  // front of the fixture. This check exists so that cannot return silently.
  {
    const c = defaultConfig();
    c.surface = { ...getPreset('classic-bowl').params };
    c.stream.voidVolume = 120e-6;
    c.drainTime = 1;
    c.resolutionU = 48;
    c.resolutionV = 96;
    c.particleCapacity = 120000;
    c.seed = 4242;
    c.aimTargetV = 0.55;
    const sim = new Simulation(c);
    const rep = sim.run();
    const upl = rep.splash.userMicrolitresPerLitre;
    out.push(
      check({
        name: 'Striking the fixture rim throws liquid back at the user',
        group: 'End to end',
        expected: 'well over 1000 µL/L when the stream is aimed into the front rim',
        actual:
          `${upl.toFixed(0)} µL/L in ${rep.splash.userDroplets} droplets, ` +
          `${sim.impact.totals.exteriorEvents} exterior impacts`,
        errValue: upl > 1000 ? 0 : 1,
        tolValue: 0.5,
        reference:
          'The casting is glazed ceramic and splashes by the same threshold as the interior',
        notes:
          'Was exactly 0 while the exterior was a perfect absorber. Across five seeds ' +
          'this now reads 15500-17845 µL/L, making the rim strike the worst aim on the fixture',
      })
    );
    out.push(
      check({
        name: 'Volume still closes when the stream strikes the casting',
        group: 'End to end',
        expected: 'every drop accounted for with the exterior splashing',
        actual: `${(100 * rep.volumeClosureError).toFixed(4)}% unaccounted`,
        errValue: rep.volumeClosureError,
        tolValue: 0.01,
        reference: 'Conservation of mass; the exterior split is exhaustive',
        notes:
          'The exterior split sends part of the volume back out as live droplets and ' +
          'books the rest to the zone, so closure is the check that it is exhaustive',
      })
    );

    // The splash correlations must not manufacture energy — asserted directly,
    // rather than by trusting the guard that would catch it.
    //
    // `emitSecondaries` caps outgoing kinetic energy plus new surface energy at
    // the incoming kinetic energy. Trap 38 is the story of that guard being
    // *inert*: it summed the energy of a nominal droplet instead of the parcel's
    // real multiplicity, so it under-counted by tens exactly when the secondary
    // cap was binding. It was fixed to compute on the liquid that actually moves,
    // but nothing ever checked whether it now fires.
    //
    // Measured: it does not, and that is the right answer. Over four cases and
    // 21 853 splash events — including this one, the stream thrown onto the front
    // rim, and near-normal incidence on the flat slab — it bound zero times. An
    // empirical ejection speed of 0.55·v_n + 0.12·v_t and a mass fraction capped
    // at 0.7 put outgoing kinetic energy near 14% of incoming, with the surface
    // cost around 2%, so the budget is never approached. The correlations are
    // mutually consistent and the guard has nothing to do.
    //
    // Checked as a rate rather than as zero, so that a future change which makes
    // it bind occasionally and legitimately does not fail, while one that pushes
    // the splash model past its own energy budget does.
    {
      const t = sim.impact.totals;
      const rate = t.energyGuardEvents / Math.max(1, t.splashEvents);
      out.push(
        check({
          name: 'The splash model stays inside its own energy budget',
          group: 'End to end',
          expected: 'the kinetic-energy guard has to clamp fewer than 1% of splash events',
          actual:
            `${t.energyGuardEvents} of ${t.splashEvents} clamped ` +
            `(worst scale ${t.energyGuardWorstScale.toFixed(3)})`,
          errValue: rate,
          tolValue: 0.01,
          reference:
            'Outgoing KE plus the surface energy of the new interface cannot exceed the ' +
            'incoming KE',
          notes:
            'This is the worst aim on the fixture, so if the empirical ejection speed and ' +
            'mass fraction were going to over-produce anywhere it would be here. A guard ' +
            'that never fires is only reassuring once someone has counted',
        })
      );
    }
  }
  // ---- Peeing on the fixture rather than into it -------------------------
  // The outside of a urinal is hard glazed ceramic and chrome, standing closer to
  // the user than any of the wetted interior, so hitting it has to be markedly
  // worse than hitting the bowl. Guarded because every part of this was once
  // silently wrong: the casting absorbed liquid without splashing, the metalwork
  // did not exist, and droplets thrown clear of the room vanished unaccounted.
  {
    const base = () => {
      const c = defaultConfig();
      applyPreset(c, getPreset('classic-bowl'));
      c.stream.voidVolume = 150e-6;
      c.drainTime = 1;
      c.resolutionU = 48;
      c.resolutionV = 96;
      c.particleCapacity = 140000;
      c.seed = 4242;
      return c;
    };

    // Aimed properly into the bowl, at the fixture's own default aim.
    const cIn = base();
    cIn.aimTargetV = getPreset('classic-bowl').defaultAimV ?? 0.18;
    const inBowl = new Simulation(cIn);
    const inTrace = inBowl.traceAim();
    const inRep = inBowl.run();

    // Aimed at the fixture. The elevation is found from the geometry rather than
    // hardcoded, and that matters: this check previously pinned -30 deg for "in the
    // bowl" and 0 deg for "on the fixture", which meant what it said on a 526 mm
    // body but not on the 640 mm one with a 375 mm front rise -- -30 deg then clips
    // the front rim on the way in, so both cases became partly rim strikes and the
    // ratio collapsed from 7.2x to 1.5x with no change to the physics at all. A test
    // that encodes a dimension it does not own will break every time the geometry
    // moves, and will look like a physics regression when it does.
    // Found by walking the aim target down the profile, not by scanning elevation in
    // degrees. Both were tried and only one of them is a property of the fixture.
    //
    // Scanning elevation and taking the highest blocked angle worked while the
    // casting had a 50 mm collar standing proud of it at the lip height, because that
    // collar caught a level stream. It was an artefact of the pedestal stopping at one
    // height all the way round, and removing it removed the thing the scan was
    // hitting: on the corrected casting there is no elevation between +20 and -20 deg
    // that lands on the ceramic at all. Above -14 deg the stream strikes the
    // flushometer standing over the rim -- a 32 mm tube, which most of the flow goes
    // past, so it reads 3x rather than the 30x+ a strike on the broad front gives --
    // and below it the stream simply enters the bowl. To reach the front face of the
    // pedestal from the emitter needs about -70 deg, which nobody stands like.
    //
    // `aimTargetV` is a fraction of the profile, so it means the same thing on a
    // 340 mm trough and a 950 mm stall, and the elevation is then solved
    // ballistically -- which is also how the application aims. Walking it forward
    // finds the first target the casting itself gets in the way of, which is the front
    // rim, which is the case being claimed.
    const cOn = base();
    const castingTop = new Simulation(cOn).casting.max.y;
    let onV = Number.NaN;
    for (let v = 0.45; v <= 0.86; v += 0.05) {
      const probe = base();
      probe.aimTargetV = v;
      const tr = new Simulation(probe).traceAim();
      if (tr.blocked && tr.point !== null && tr.point.y <= castingTop) {
        onV = v;
        break;
      }
    }
    cOn.aimTargetV = onV;
    const onFixture = new Simulation(cOn);
    const onTrace = onFixture.traceAim();
    const onRep = onFixture.run();

    const ratio =
      onRep.splash.userMicrolitresPerLitre /
      Math.max(1, inRep.splash.userMicrolitresPerLitre);

    out.push(
      check({
        name: 'Peeing on the fixture is far worse than peeing into it',
        group: 'End to end',
        expected: 'at least 3× more on the user when the stream is aimed at the casing',
        actual:
          `into the bowl at v=${cIn.aimTargetV} ` +
          `(${radToDeg(inTrace.angle).toFixed(0)}° on the interior) ` +
          `${inRep.splash.userMicrolitresPerLitre.toFixed(0)} µL/L vs ` +
          `on the casting at v=${onV.toFixed(2)}, ` +
          `${onTrace.point ? (onTrace.point.y * 1000).toFixed(0) : '?'} mm above the datum ` +
          `(${onTrace.blocked ? 'blocked by solid' : 'NOT BLOCKED'}) ` +
          `${onRep.splash.userMicrolitresPerLitre.toFixed(0)} µL/L (${ratio.toFixed(1)}×)`,
        errValue: Number.isFinite(onV) && onTrace.blocked && ratio >= 3 ? 0 : 1,
        tolValue: 0.5,
        reference:
          'The casting and the metalwork are solid and splash by the same threshold as ' +
          'the interior; neither has a film, so both use the dry branch',
        notes:
          'How far onto the fixture matters: on the oval bowl a stream that merely grazes ' +
          'the rim at -8° reads 1.3× the in-bowl figure, while -2°, +4°, +10° and +16° ' +
          'read 1.9×, 2.6×, 3.6× and 4.9×. The scan takes the highest elevation blocked ' +
          'by the CASTING, which is unambiguously on the fixture rather than marginally ' +
          'over its lip and is not satisfied by clipping the flush valve above it',
      })
    );
    out.push(
      check({
        name: 'The metalwork is solid, not scenery',
        group: 'End to end',
        expected: 'a level stream strikes the flush valve above the casting',
        actual: (() => {
          const f = onFixture.fittings;
          return (
            `${f.indices.length / 3} triangles reaching y=${(f.max.y * 1000).toFixed(0)} mm; ` +
            `aim ray ${onTrace.blocked ? 'blocked by solid' : 'not blocked'}, ` +
            `${onFixture.impact.totals.exteriorEvents} exterior impacts`
          );
        })(),
        errValue:
          !onFixture.fittings.empty &&
          onTrace.blocked &&
          onFixture.impact.totals.exteriorEvents > 100
            ? 0
            : 1,
        tolValue: 0.5,
        reference:
          'Geometry that can be seen but not hit deletes liquid, which is how the ' +
          'casting came to be a perfect absorber',
      })
    );
    out.push(
      check({
        name: 'Volume closes when splash is thrown clear of the room',
        group: 'End to end',
        expected: 'every drop accounted for with the stream aimed at the metalwork',
        actual: `${(100 * onRep.volumeClosureError).toFixed(4)}% unaccounted`,
        errValue: onRep.volumeClosureError,
        tolValue: 1e-4,
        reference: 'Conservation of mass, including liquid leaving the region of interest',
        notes:
          'escapedVolume was declared, reset and reported but never incremented, and was ' +
          'missing from the closure sum; this case drifted to 0.0718% before the fix',
      })
    );
  }

  // ---- Satellites, and the aim policy that governs the tail ---------------
  //
  // Two claims off one pair of runs, because each run is a few seconds of wall
  // clock and they share a configuration.
  {
    const mkRun = (tracking: 'fixed' | 'tracked') => {
      const c = defaultConfig();
      const p = getPreset('classic-bowl');
      applyPreset(c, p);
      c.stream.voidVolume = 150e-6;
      c.drainTime = 1;
      c.resolutionU = 48;
      c.resolutionV = 96;
      c.particleCapacity = 140000;
      c.seed = 4242;
      c.aimTargetV = p.defaultAimV ?? 0.18;
      c.aimTracking = tracking;
      const sim = new Simulation(c);
      const rep = sim.run();
      return { sim, rep, phi: c.stream.satelliteFraction };
    };
    const held = mkRun('fixed');
    const tracked = mkRun('tracked');

    // A wavelength of jet does not become one sphere. `solveBreakup` has always
    // computed the main-drop / satellite split and the check above has always
    // confirmed it conserves volume -- but nothing downstream acted on it. Every
    // parcel stayed whole, adopted the *main* drop's diameter while keeping the
    // *whole* wavelength's volume, and not one particle in a run ever carried
    // PFlag.Satellite, a flag the droplet renderer has its own style for. So
    // `satelliteFraction` was a parameter, a validated quantity and a render path
    // that between them changed nothing but the drop diameter, by (1-phi)^(1/3).
    const share = held.sim.particles.satelliteVolumeReleased / Math.max(1e-12, held.rep.voidedVolume);
    out.push(
      check({
        name: 'Satellite drops are actually pinched off, and carry their stated share',
        group: 'End to end',
        expected: `volume share within 80–100% of satelliteFraction = ${held.phi}`,
        actual:
          `${held.sim.particles.satellitesReleased} satellites carrying ` +
          `${(held.sim.particles.satelliteVolumeReleased * 1e6).toFixed(3)} mL, ` +
          `share ${(100 * share).toFixed(2)}% of ${(held.rep.voidedVolume * 1e6).toFixed(1)} mL voided`,
        errValue:
          held.sim.particles.satellitesReleased > 100 &&
          share > 0.8 * held.phi &&
          share <= held.phi * 1.001
            ? 0
            : 1,
        tolValue: 0.5,
        reference: 'The main-drop / satellite split solveBreakup already computed',
        notes:
          'Short of the full fraction only by the parcels that reach the wall still ' +
          'coherent, which never pinch off. Volume closure is what proves the split ' +
          'neither loses nor invents liquid',
      })
    );

    // Trap 17 says the weak rise and tail dominate splashback. That claim was
    // measured with the aim solved once at peak exit speed and then held, which
    // makes a decaying stream fall progressively shorter onto the fixture's own
    // rim -- so it was fair to ask how much of the tail was the modelling choice
    // rather than the physics. Answer: tracking the target perfectly cuts the tail
    // to roughly a third, and it *still* dominates. The claim survives its own
    // most optimistic assumption, which is a stronger statement than the original.
    const ratioHeld =
      held.rep.splash.weakMicrolitresPerLitre /
      Math.max(1, held.rep.splash.sustainedMicrolitresPerLitre);
    const ratioTracked =
      tracked.rep.splash.weakMicrolitresPerLitre /
      Math.max(1, tracked.rep.splash.sustainedMicrolitresPerLitre);
    const relief =
      tracked.rep.splash.weakMicrolitresPerLitre /
      Math.max(1, held.rep.splash.weakMicrolitresPerLitre);
    out.push(
      check({
        name: 'Weak flow dominates whether or not the user tracks their aim',
        group: 'End to end',
        expected: 'tail at least 4× sustained under both aim policies, and tracking helps',
        actual:
          `held aim ${ratioHeld.toFixed(1)}× (weak ${held.rep.splash.weakMicrolitresPerLitre.toFixed(0)} µL/L), ` +
          `tracked ${ratioTracked.toFixed(1)}× (weak ${tracked.rep.splash.weakMicrolitresPerLitre.toFixed(0)} µL/L); ` +
          `tracking leaves ${(100 * relief).toFixed(0)}% of the tail, ` +
          `${tracked.sim.unreachableSteps} steps out of ballistic range`,
        errValue: ratioHeld >= 4 && ratioTracked >= 4 && relief < 1 ? 0 : 1,
        tolValue: 0.5,
        reference:
          'Held aim is the default and what every published figure here was measured ' +
          'with; tracked is the optimistic bound of a user re-solving continuously',
        notes:
          'Measured 0.30–0.37× on the oval bowl and flat slab over two seeds, with the ' +
          'liquid thrown onto the outside of the fixture during the tail falling from ' +
          '~16 mL to ~5 mL. So the all-in figure carries a factor-of-three sensitivity ' +
          'to a modelling choice — one more reason Traps 16 and 42 rule it out as a headline',
      })
    );
    out.push(
      check({
        name: 'Volume closes under aim tracking',
        group: 'End to end',
        expected: 'every drop accounted for with the aim re-solved every step',
        actual: `${(100 * tracked.rep.volumeClosureError).toFixed(4)}% unaccounted`,
        errValue: tracked.rep.volumeClosureError,
        tolValue: 1e-4,
        reference: 'Conservation of mass; re-aiming must not disturb the balance',
      })
    );

    // Where the rim strike actually lives, per flow phase.
    //
    // `SplashbackReport.streamOnExteriorVolume` counts generation-0 liquid booked
    // to the casting -- the stream missing the bowl, not splash coming back. It
    // exists because "this fixture splashes" and "this fixture was being sprayed
    // on its own outside for part of the run" are different failures with
    // different remedies, and the headline µL/L mixes them.
    //
    // The split is stark and is the direct measurement of outstanding item 2b:
    // during sustained flow the stream never touches the casing at all, and during
    // the weak rise and tail better than a fifth of what is voided lands on it.
    // That is Trap 14's mechanism, and it is entirely a weak-flow phenomenon.
    //
    // Written as fractions of each phase's own emitted volume, so it survives the
    // fixture being reshaped: it asks where the liquid went, not how much.
    {
      const frac = (r: typeof held.rep, ph: FlowPhase) => {
        const p = r.splash.perPhase[ph];
        return p.emitted > 1e-12 ? p.exteriorDirectVolume / p.emitted : 0;
      };
      const sustained = frac(held.rep, FlowPhase.Sustained);
      const weak = frac(held.rep, FlowPhase.Weak);
      const weakTracked = frac(tracked.rep, FlowPhase.Weak);
      out.push(
        check({
          name: 'The stream lands on the fixture’s casing only while flow is weak',
          group: 'End to end',
          expected: 'under 1% of sustained-flow volume, over 5% of weak-flow volume',
          actual:
            `sustained ${(100 * sustained).toFixed(2)}%, weak ${(100 * weak).toFixed(2)}% ` +
            `(tracked aim ${(100 * weakTracked).toFixed(2)}%); ` +
            `${(100 * held.rep.splash.streamOnExteriorFraction).toFixed(2)}% of the whole void`,
          errValue: sustained < 0.01 && weak > 0.05 && weakTracked < weak ? 0 : 1,
          tolValue: 0.5,
          reference:
            'Trap 14: the stream striking the casting is the worst outcome available, ' +
            'and the aim is solved at peak exit speed so a slow stream falls short of it',
          notes:
            'The per-phase figure the fixture-comparison table wants. Measured rather ' +
            'than predicted — it is what the swept-segment test booked, so it includes ' +
            'tremor. traceAim().blocked answers the same question for one instant and is ' +
            'the right thing for a live readout',
        })
      );
    }

    // Trap 18's premise, pinned. The wetted-patch physics in `FilmSolver.
    // depositJet` belongs to the coherent-jet regime, and the trap's point is that
    // at the default posture the regime is almost never entered: the stream breaks
    // up well before it arrives, so a droplet train lands and the parabolic rim
    // does not appear. Nothing checked that, which meant the *premise* of the trap
    // was as unguarded as the physics it warns about.
    //
    // A ratio, not two distances, so a reshaped fixture does not break it.
    {
      const sim = held.sim;
      const tPeak = sim.emitter.flow.peakFraction * sim.emitter.flow.duration;
      const lb = sim.emitter.breakupAt(tPeak).breakupLength;
      const path = sim.traceAim().points;
      let reach = 0;
      for (let i = 1; i < path.length; i++) {
        reach += Math.hypot(
          path[i].x - path[i - 1].x,
          path[i].y - path[i - 1].y,
          path[i].z - path[i - 1].z
        );
      }
      out.push(
        check({
          name: 'At the default posture the stream arrives broken up, not as a jet',
          group: 'End to end',
          expected: 'breakup length well inside the distance to the wall',
          actual:
            `breaks up at ${(lb * 100).toFixed(0)} cm, wall is ${(reach * 100).toFixed(0)} cm ` +
            `away along the traced path (ratio ${(lb / Math.max(1e-9, reach)).toFixed(2)})`,
          errValue: reach > 1e-3 && lb < 0.7 * reach ? 0 : 1,
          tolValue: 0.5,
          reference:
            'Trap 18: the parabolic wetted patch (Edwards, Howison, Ockendon & Ockendon, ' +
            'JFM 2008) belongs to the coherent-jet regime and must not be forced',
          notes:
            'If this ever inverts, depositJet starts governing the deposition and the ' +
            'Film thickness view is the one to check — not the Liquid view',
        })
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export function runAllTests(): TestResult[] {
  return [
    ...rayleighTests(),
    ...dragTests(),
    ...flowTests(),
    ...geometryTests(),
    ...splashTests(),
    ...filmTests(),
    ...endToEndTests(),
  ];
}

export function summariseResults(results: TestResult[]): {
  passed: number;
  failed: number;
  total: number;
} {
  const passed = results.filter((r) => r.passed).length;
  return { passed, failed: results.length - passed, total: results.length };
}
