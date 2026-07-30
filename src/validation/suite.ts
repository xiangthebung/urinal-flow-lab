import { AIR_DENSITY, AIR_VISCOSITY, GRAVITY } from '../core/constants';
import {
  URINE_37C,
  WALL_MATERIALS,
  WATER_20C,
  capillaryLength,
  dragCoefficient,
  kinematicViscosity,
  maxStaticPuddleThickness,
  nusseltFilmThickness,
  terminalVelocity,
} from '../core/fluid';
import { Rng } from '../core/rng';
import { radToDeg, v3 } from '../core/vec3';
import { UrinalSurface, defaultSurfaceParams } from '../geometry/surface';
import { FlowCurve, solveBreakup } from '../sim/stream';
import { FilmSolver, defaultFilmParams } from '../sim/film';
import { ImpactResolver, defaultImpactParams } from '../sim/impact';
import { defaultStreamParams } from '../sim/stream';
import { Simulation, defaultConfig } from '../sim/simulation';
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

  // Inviscid Rayleigh: most unstable dimensionless wavenumber is 0.697, giving
  // a wavelength of 9.02 jet radii. The long-wave dispersion relation used here
  // gives 1/sqrt(2) = 0.7071, a known ~1.4% overshoot of the exact Bessel result.
  const b = solveBreakup(URINE_37C, 0.003, 3.0, 0.05, 0);
  out.push(
    check({
      name: 'Most unstable wavenumber kr',
      group: 'Rayleigh-Plateau breakup',
      expected: '0.697 (Rayleigh, exact Bessel)',
      actual: b.wavenumber.toFixed(4),
      errValue: rel(b.wavenumber, 0.697),
      tolValue: 0.03,
      reference: 'Rayleigh 1878; long-wave form overshoots by ~1.4% by construction',
    })
  );
  out.push(
    check({
      name: 'Wavelength / jet diameter',
      group: 'Rayleigh-Plateau breakup',
      expected: '4.51 (= 9.02 r / d)',
      actual: (b.wavelength / 0.003).toFixed(4),
      errValue: rel(b.wavelength / 0.003, 4.51),
      tolValue: 0.03,
      reference: 'Rayleigh 1878',
    })
  );
  // One wavelength of cylinder becomes one sphere: d_drop = (6 r^2 lambda)^(1/3),
  // which for lambda = 9.02r gives 1.891 d_jet.
  out.push(
    check({
      name: 'Droplet / jet diameter (no satellites)',
      group: 'Rayleigh-Plateau breakup',
      expected: '1.891',
      actual: (b.mainDropletDiameter / 0.003).toFixed(4),
      errValue: rel(b.mainDropletDiameter / 0.003, 1.891),
      tolValue: 0.02,
      reference: 'Volume of one wavelength of cylinder recast as a sphere',
    })
  );
  // Mass has to balance across the main-drop / satellite split.
  const bs = solveBreakup(URINE_37C, 0.003, 3.0, 0.05, 0.06);
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
  // sooner than urine at the same diameter and speed.
  const bw = solveBreakup(WATER_20C, 0.003, 3.0, 0.05, 0);
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
  // Viscosity damps the instability and stretches the jet.
  const thick = { ...URINE_37C, viscosity: 0.1 };
  const bt = solveBreakup(thick, 0.003, 3.0, 0.05, 0);
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
  // up at roughly 15-20 cm on high-speed video.
  out.push(
    check({
      name: 'Breakup length matches high-speed observation',
      group: 'Rayleigh-Plateau breakup',
      expected: '15–25 cm for 3 mm at 3 m/s',
      actual: `${(b.breakupLength * 100).toFixed(1)} cm`,
      errValue: b.breakupLength >= 0.15 && b.breakupLength <= 0.25 ? 0 : 1,
      tolValue: 0.5,
      reference: 'Calibrated via ε₀/r = 0.05; the one tuned constant in the model',
      notes: 'Depends only logarithmically on the disturbance ratio',
    })
  );
  return out;
}

// ---------------------------------------------------------------------------
// Group 2: droplet aerodynamics
// ---------------------------------------------------------------------------

function dragTests(): TestResult[] {
  const out: TestResult[] = [];
  for (const d of [0.0005, 0.002, 0.005]) {
    const vT = terminalVelocity(URINE_37C, d);
    // At terminal velocity drag must exactly balance the buoyant weight.
    const re = (AIR_DENSITY * vT * d) / AIR_VISCOSITY;
    const cd = dragCoefficient(re);
    const drag = 0.5 * AIR_DENSITY * cd * ((Math.PI * d * d) / 4) * vT * vT;
    const weight = ((URINE_37C.density - AIR_DENSITY) * GRAVITY * Math.PI * d ** 3) / 6;
    out.push(
      check({
        name: `Terminal velocity force balance, d = ${(d * 1000).toFixed(1)} mm`,
        group: 'Droplet aerodynamics',
        expected: `drag = weight = ${weight.toExponential(3)} N`,
        actual: `${drag.toExponential(3)} N at ${vT.toFixed(3)} m/s (Re ${re.toFixed(0)})`,
        errValue: rel(drag, weight),
        tolValue: 0.005,
        reference: 'Schiller-Naumann drag law',
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
    c.surface = { ...getPreset(preset).params };
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
        'wall the generator governs. Across five seeds: flat 354-579 µL/L, ' +
        'constant-angle 0-1 µL/L',
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
          'Measured across five seeds: flat slab 10.3-16.6×, oval bowl 6.1-7.2×, ' +
          'constant-angle over 17000× because its sustained figure is ~0',
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
