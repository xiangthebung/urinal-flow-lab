import { AIR_DENSITY, AIR_VISCOSITY, GRAVITY } from './constants';

/**
 * Bulk properties of the working liquid plus its interaction with the wall.
 *
 * Getting these right matters more than it looks. Almost every published
 * urinal splash experiment uses *water*, but urine has a surface tension
 * roughly 12-18 mN/m below water's. Surface tension is the only thing
 * resisting the corona that becomes splashback, so a design validated with
 * water is optimistic about the real fluid. The presets below let a designer
 * see that gap directly.
 */
export interface FluidProperties {
  name: string;
  /** Mass density, kg/m^3. */
  density: number;
  /** Dynamic viscosity, Pa*s. */
  viscosity: number;
  /** Liquid-air surface tension, N/m. */
  surfaceTension: number;
  /** Advancing contact angle on the wall material, radians. */
  contactAngleAdvancing: number;
  /** Receding contact angle on the wall material, radians. */
  contactAngleReceding: number;
  /** Temperature, K -- carried for reporting, not used in the solver. */
  temperature: number;
  /** Free-text provenance for the numbers, surfaced in the UI. */
  source: string;
}

const deg = (d: number) => (d * Math.PI) / 180;

/**
 * Urine at body temperature on glazed vitreous china. This is the default,
 * because it is the case the tool exists to answer.
 *
 * density        1020 kg/m^3   specific gravity 1.005-1.030, mid-range
 * viscosity      8.5e-4 Pa*s   nu = 0.829 cSt at 37 degC (Rossi et al. 2013)
 *                              times rho = 1020  ->  8.46e-4 Pa*s
 * surfaceTension 0.055 N/m     water 0.072 less the 12-18 mN/m depression
 *                              measured for urine on several substrates
 * contact angle  45/25 deg     water on glazed china is ~55/35; urine runs
 *                              ~10 deg lower for the same substrate
 */
export const URINE_37C: FluidProperties = {
  name: 'Urine (37 °C)',
  density: 1020,
  viscosity: 8.5e-4,
  surfaceTension: 0.055,
  contactAngleAdvancing: deg(45),
  contactAngleReceding: deg(25),
  temperature: 310.15,
  source: 'SG 1.005-1.030; nu=0.829 cSt @37C (Rossi 2013); sigma = water - 12..18 mN/m',
};

/**
 * Dilute / high-output urine: nearly water, which is what you get from a
 * well-hydrated user. Higher surface tension, so *less* splash-prone.
 */
export const URINE_DILUTE: FluidProperties = {
  name: 'Urine, dilute (SG 1.005)',
  density: 1005,
  viscosity: 7.6e-4,
  surfaceTension: 0.064,
  contactAngleAdvancing: deg(52),
  contactAngleReceding: deg(30),
  temperature: 310.15,
  source: 'Low-solute limit of the urine range',
};

/**
 * Concentrated urine, first void of the day. Lower surface tension from the
 * urea/urobilin/organic load, higher viscosity. This is the worst case for
 * splashback and the one a design should be qualified against.
 */
export const URINE_CONCENTRATED: FluidProperties = {
  name: 'Urine, concentrated (SG 1.030)',
  density: 1032,
  viscosity: 1.05e-3,
  surfaceTension: 0.048,
  contactAngleAdvancing: deg(38),
  contactAngleReceding: deg(20),
  temperature: 310.15,
  source: 'High-solute limit; sigma depressed by urea and organic solutes',
};

/**
 * Water at 20 degC. Included so the tool can reproduce the published
 * laboratory experiments, which is how you check the model rather than
 * how you qualify a design.
 */
export const WATER_20C: FluidProperties = {
  name: 'Water (20 °C) — lab reference',
  density: 998.2,
  viscosity: 1.002e-3,
  surfaceTension: 0.0728,
  contactAngleAdvancing: deg(55),
  contactAngleReceding: deg(35),
  temperature: 293.15,
  source: 'CRC Handbook',
};

export const FLUID_PRESETS: FluidProperties[] = [
  URINE_37C,
  URINE_DILUTE,
  URINE_CONCENTRATED,
  WATER_20C,
];

/** Wall material affects both wetting and the splash threshold. */
export interface WallMaterial {
  name: string;
  /** Arithmetic mean roughness Ra, m. Drives the dry splash threshold. */
  roughness: number;
  /**
   * Multiplier on the equilibrium contact angle of the fluid. 1.0 leaves
   * the fluid's own value; >1 is a more hydrophobic coating.
   */
  contactAngleScale: number;
  source: string;
}

export const WALL_MATERIALS: WallMaterial[] = [
  {
    name: 'Glazed vitreous china',
    roughness: 0.3e-6,
    contactAngleScale: 1.0,
    source: 'Ra 0.2-0.5 um for fired sanitary glaze',
  },
  {
    name: 'Glazed china, scaled/aged',
    roughness: 4e-6,
    contactAngleScale: 0.85,
    source: 'Uric acid scale roughens and hydrophilises the glaze',
  },
  {
    name: 'Stainless steel 2B',
    roughness: 0.5e-6,
    contactAngleScale: 1.4,
    source: 'Ra ~0.5 um; higher contact angle than glaze',
  },
  {
    name: 'Hydrophobic coating',
    roughness: 0.8e-6,
    contactAngleScale: 2.2,
    source: 'Fluoropolymer, theta ~100 deg',
  },
  {
    name: 'Superhydrophobic (θ≈155°)',
    roughness: 2e-6,
    contactAngleScale: 3.4,
    source: 'Textured; note this *increases* splash for jets, see docs',
  },
];

// ---------------------------------------------------------------------------
// Dimensionless groups
//
// These four numbers decide everything the simulation does at an impact.
// They are cheap, so they are recomputed per event rather than cached.
// ---------------------------------------------------------------------------

/**
 * Weber number: inertia versus surface tension.
 * We = rho * v^2 * L / sigma
 * High We means inertia wins and the interface shatters into droplets.
 */
export const weber = (f: FluidProperties, v: number, L: number): number =>
  (f.density * v * v * L) / f.surfaceTension;

/**
 * Reynolds number: inertia versus viscosity.
 * Re = rho * v * L / mu
 */
export const reynolds = (f: FluidProperties, v: number, L: number): number =>
  (f.density * v * L) / f.viscosity;

/**
 * Ohnesorge number: viscosity versus the inertia-surface-tension pair.
 * Oh = mu / sqrt(rho * sigma * L) = sqrt(We) / Re
 * Independent of velocity, so it characterises the *fluid and length scale*
 * alone. For a 3 mm urine stream Oh ~ 2e-3, i.e. firmly inviscid: breakup is
 * governed by surface tension, not by viscous damping.
 */
export const ohnesorge = (f: FluidProperties, L: number): number =>
  f.viscosity / Math.sqrt(f.density * f.surfaceTension * L);

/**
 * Bond number: gravity versus surface tension.
 * Bo = rho * g * L^2 / sigma
 * Bo < 1 means surface tension can hold the liquid against gravity, which is
 * exactly the condition for a film to pin on the wall instead of draining.
 */
export const bond = (f: FluidProperties, L: number): number =>
  (f.density * GRAVITY * L * L) / f.surfaceTension;

/**
 * Capillary length, m. sqrt(sigma / (rho g)).
 * The natural thickness scale for a puddle: about 2.3 mm for urine.
 */
export const capillaryLength = (f: FluidProperties): number =>
  Math.sqrt(f.surfaceTension / (f.density * GRAVITY));

/** Kinematic viscosity, m^2/s. */
export const kinematicViscosity = (f: FluidProperties): number => f.viscosity / f.density;

/**
 * Mundo splash group, K = We^0.5 * Re^0.25.
 * Written this way it is directly comparable to both the dry-wall threshold
 * (~58) and the Cossali wet-wall threshold (2100+).
 */
export const splashK = (f: FluidProperties, v: number, L: number): number =>
  Math.sqrt(weber(f, v, L)) * Math.pow(reynolds(f, v, L), 0.25);

/**
 * Maximum thickness a static puddle can reach on a horizontal surface before
 * it spreads under its own weight:
 *     h_max = 2 * l_c * sin(theta / 2)
 * from balancing hydrostatic pressure against the capillary pressure of the
 * pinned contact line. Gives ~2.4 mm for urine on glaze at 45 deg, which is
 * the observed depth of a standing puddle in a flat-bottomed urinal.
 *
 * This is the number that decides whether a design "accumulates".
 */
export const maxStaticPuddleThickness = (
  f: FluidProperties,
  contactAngleScale = 1
): number => {
  const theta = Math.min(Math.PI, f.contactAngleAdvancing * contactAngleScale);
  return 2 * capillaryLength(f) * Math.sin(theta / 2);
};

/**
 * Steady thickness of a film draining down a vertical wall at volumetric
 * flux q per unit width (Nusselt, 1916):
 *     h = (3 * nu * q / g_tangential)^(1/3)
 * Used both by the solver as a sanity bound and by the validation suite as a
 * ground-truth benchmark.
 */
export const nusseltFilmThickness = (
  f: FluidProperties,
  fluxPerWidth: number,
  gTangential = GRAVITY
): number => {
  if (fluxPerWidth <= 0 || gTangential <= 1e-9) return 0;
  return Math.cbrt((3 * kinematicViscosity(f) * fluxPerWidth) / gTangential);
};

/**
 * Terminal velocity of a droplet falling in still air, m/s.
 *
 * Solved by fixed-point iteration because Cd depends on Re, which depends on the
 * velocity being solved for, and now also on the deformation, which depends on
 * both. Converges in a handful of iterations over the 0.02-6 mm range used here.
 *
 * Uses the *deformed* drag law, because a millimetric drop at terminal velocity
 * genuinely is flattened and that is what the measurements see. Checked against
 * Gunn & Kinzer's 1949 measured raindrop terminal velocities in the validation
 * suite -- the first non-circular test of the drag law in this project. The
 * checks that were there before assert only that drag balances weight using the
 * same Cd the solver used, which proves the iteration converges and nothing else.
 */
export const terminalVelocity = (f: FluidProperties, diameter: number): number => {
  const buoyantWeight = ((f.density - AIR_DENSITY) * GRAVITY * Math.PI * diameter ** 3) / 6;
  const area = (Math.PI * diameter * diameter) / 4;
  let v = 1;
  for (let i = 0; i < 200; i++) {
    const re = Math.max(1e-6, (AIR_DENSITY * v * diameter) / AIR_VISCOSITY);
    const weGas = (AIR_DENSITY * v * v * diameter) / f.surfaceTension;
    const cd = dropletDragCoefficient(re, weGas);
    // drag = 0.5 rho_air Cd A v^2  ==  weight  ->  solve for v
    const vNew = Math.sqrt((2 * buoyantWeight) / (AIR_DENSITY * cd * area));
    if (Math.abs(vNew - v) < 1e-10) return vNew;
    v = 0.7 * v + 0.3 * vNew; // damped, because Cd now feeds back through We too
  }
  return v;
};

/**
 * Rigid-sphere drag coefficient, Clift & Gauvin (1970):
 *     Cd = (24/Re)(1 + 0.15 Re^0.687) + 0.42 / (1 + 42500 Re^-1.16)
 *
 * Reduces to Schiller-Naumann below Re ~ 1000 and carries the Newton plateau
 * above it in one continuous expression.
 *
 * The previous form was Schiller-Naumann below Re = 1000 and a flat 0.44 above.
 * The seam itself was a minor complaint -- 0.4383 against 0.44, a 0.39% step --
 * but the flat 0.44 was not: the real coefficient keeps falling past Re = 1000
 * and bottoms out near 0.387, so the old value was **9-14% high through
 * Re = 2000-5000**, which is exactly where the 5-6 mm drops off a urine stream
 * sit. Measured against Gunn & Kinzer's raindrop data, that error was partly
 * cancelling the *absence* of the deformation correction below, and the two
 * together are why the old pair looked tolerable: rigid-sphere drag alone with a
 * correct Cd is 30.6% out at 5 mm, worse than the old law's 22%. Fixing either
 * one on its own makes the model worse, which is the reason they were changed
 * together and the reason a non-circular check was needed to see it at all.
 */
export const dragCoefficient = (re: number): number => {
  if (re < 1e-8) return 1e8;
  return (
    (24 / re) * (1 + 0.15 * Math.pow(re, 0.687)) +
    0.42 / (1 + 42500 * Math.pow(re, -1.16))
  );
};

/**
 * Drag coefficient of a *droplet*, which is not a rigid sphere.
 *
 * Aerodynamic pressure flattens a drop into an oblate shape, which presents more
 * frontal area and a worse wake, and the effect is not small at the sizes this
 * model works in: Rayleigh breakup of a 3 mm stream makes 5.5 mm drops, and a
 * 5.8 mm raindrop at terminal velocity carries about 95% more drag than a sphere
 * of the same volume.
 *
 * Liu, Mather & Reitz (SAE 930072, 1993) scale the sphere value by the TAB
 * distortion parameter y of O'Rourke & Amsden (1987):
 *     Cd = Cd_sphere * (1 + 2.632 y),   0 <= y <= 1
 * The 2.632 is not fitted: it is the interpolation between a sphere (0.424) and a
 * disk (1.54), since 1.54/0.424 - 1 = 2.632. `y` is taken at its quasi-steady
 * value, y = We_gas / 24 on the drop diameter, capped at the disk limit.
 *
 * Deformation only; there is deliberately no secondary breakup. The bag-breakup
 * threshold is We_gas ~ 11-13 (Pilch & Erdman 1987; Guildenbecher et al. 2009,
 * We_crit = 11 +/- 2) and the largest We_gas reachable here is about 3.6 -- a
 * 6 mm drop at 6 m/s, which is already beyond anything a urinal produces. So the
 * airborne liquid in this model never breaks up aerodynamically, and modelling it
 * would be inventing a regime the problem does not enter. The Ohnesorge
 * correction to that threshold, 12(1 + 1.077 Oh^1.6), is likewise pointless here:
 * at Oh ~ 0.002 it moves 12 to 12.003.
 */
export const dropletDragCoefficient = (re: number, weberGas: number): number => {
  const y = Math.min(1, Math.max(0, weberGas / 24));
  return dragCoefficient(re) * (1 + 2.632 * y);
};
