/**
 * Physical constants. Everything in this project is strict SI:
 * metres, seconds, kilograms, newtons, pascals, kelvin.
 *
 * There is exactly one exception, and it is confined to the UI layer:
 * volumes are *displayed* in millilitres and microlitres because a
 * designer thinks in "mL voided" and "µL on the shoe", not m^3.
 */

/** Standard gravity, m/s^2. */
export const GRAVITY = 9.80665;

/** Ambient air density at 20 degC, 1 atm, kg/m^3. */
export const AIR_DENSITY = 1.204;

/** Ambient air dynamic viscosity at 20 degC, Pa*s. */
export const AIR_VISCOSITY = 1.825e-5;

/**
 * Splash threshold constants.
 *
 * DRY_SPLASH_K -- Mundo, Sommerfeld & Tropea (1995) correlated the
 * deposition/splash transition for a droplet striking a *dry* wall with
 *     K = Oh * Re^1.25 = We^0.5 * Re^0.25
 * and found the transition at K ~ 57.7 for smooth surfaces. Surface
 * roughness lowers it substantially (down to ~35-40 for rough walls)
 * because asperities trigger the corona early, so we expose it as a
 * roughness-dependent value rather than a hard constant.
 */
export const DRY_SPLASH_K_SMOOTH = 57.7;
export const DRY_SPLASH_K_ROUGH = 33.0;

/**
 * WET_SPLASH_K_BASE / WET_SPLASH_K_FILM -- Cossali, Coghe & Marengo (1997)
 * for a droplet striking a wall already covered by a liquid film:
 *     K_crit = 2100 + 5880 * delta^1.44,    delta = h_film / d_drop
 * Below K_crit the drop merges into the film; above it a crown forms and
 * throws secondary droplets.
 *
 * **This K is not the Mundo K.** Cossali's group is K = We * Oh^-0.4, and
 * since Oh = sqrt(We)/Re that is We^0.8 * Re^0.4 -- exactly the Mundo group
 * raised to the power 1.6. `ImpactResolver.thresholdRatio` computes the two
 * separately and compares each against its own threshold, which is correct;
 * this comment used to claim they shared the We^0.5 Re^0.25 grouping "so a
 * single K can be compared against either threshold", which is false and is
 * an invitation to collapse two correlations into one. There is a check that
 * pins the 1.6 relationship so that cannot happen quietly.
 *
 * **The two thresholds do not order the way this comment used to say.** Put on
 * one scale through that identity, Mundo's dry 57.7 corresponds to a Cossali
 * K of 57.7^1.6 = 657, well below Cossali's 2100 at delta -> 0. So the pair as
 * implemented says a wetted wall is 2.1x harder to splash in K than a dry one
 * at a thin film, rising to 4.8x at delta = 1 -- roughly a factor of two in
 * velocity, in the opposite direction to the "a urinal gets messier as it is
 * used" story that stood here before. Measured on the blend: at exactly the
 * normal velocity where a 5.5 mm drop reaches the dry threshold, taking the
 * film from 27 um to 275 um drops the threshold ratio from 1.00 to 0.30.
 *
 * **Why, and it is not what it looks like.** Cossali's own paper carries a
 * *dry* correlation too, in the same group, and it is roughness-dependent:
 *     K_crit,dry = 649 + 3.76 / R^0.63,      R = Ra / d_drop
 * Mundo's 57.7 is the rough asymptote of exactly that curve -- at R = 1 it
 * gives 653, i.e. K_Mundo = 57.4. So 57.7 is not "a smooth dry wall": it is a
 * *dimensionlessly rough* one, which for Mundo's 60-150 um drops needs only
 * Ra of a few microns. Put the project's own glaze into that formula instead
 * (Ra = 0.3 um, 5.5 mm drop, R = 5.5e-5) and the dry threshold comes out near
 * K_Cossali 2470, i.e. K_Mundo ~ 132 -- which is *within a few percent of the
 * wetted threshold at delta = 0.1*, and the 2.1x step above disappears.
 *
 * The honest ordering is therefore: rough dry (649) < wetted (2100-2300) <
 * smooth dry (~2500-4100). A film makes a *smooth* wall easier to splash and a
 * *rough* wall harder, so the "a urinal gets messier as it is used" story is
 * defensible -- it is the constant this file uses for the dry branch that is
 * the rough one, not the story that is wrong.
 *
 * **This is left alone deliberately, and it is the largest known open item in
 * the splash model.** Raising the dry branch to Cossali's dry correlation would
 * move every splashback figure in the project, and it bears hardest on the
 * casting exterior, which has no film and so always takes the dry branch --
 * i.e. on Trap 14's mechanism and on the "peeing on the fixture" claim. It
 * needs the primary sources checked and the whole measured-state table
 * re-measured, not a one-line edit. See Trap 40, which set 57.7 here believing
 * it to be the smooth-glaze value.
 */
export const WET_SPLASH_K_BASE = 2100;
export const WET_SPLASH_K_FILM = 5880;
export const WET_SPLASH_K_FILM_EXP = 1.44;

/**
 * Largest dimensionless film thickness the Cossali fit is used at.
 *
 * Their experiments cover delta = h/d up to order one. The correlation is
 * monotonically increasing in delta with no upper bound, so extrapolating it into
 * a standing pool claims that deeper liquid is ever harder to splash -- at
 * delta = 2 the critical K is already 18000, i.e. effectively unsplashable. The
 * real physics changes character instead: past roughly one diameter the impact
 * makes a cavity and a Worthington jet rather than a crown on a film, and the
 * threshold flattens. Clamping delta here keeps the correlation inside the range
 * it was fitted over rather than having it quietly assert that a jet plunging
 * into the sump cannot throw anything back.
 */
export const WET_SPLASH_K_FILM_MAX_DELTA = 1.0;

/**
 * Critical impingement angle, radians (30 degrees).
 *
 * Thurairajah, Wilson et al., "Splash-free urinals for global
 * sustainability and accessibility", PNAS 2025: when the stream meets the
 * fixture surface at 30 deg or less (measured from the *surface*, not the
 * normal) splashback is suppressed by orders of magnitude, and the
 * threshold is essentially invariant to jet speed and diameter. Their
 * Cornucopia and Nautilus geometries hold <= 30 deg over the whole wetted
 * area. We use this both as a physical input to the splash model and as
 * the headline design metric.
 */
export const CRITICAL_IMPINGEMENT_ANGLE = (30 * Math.PI) / 180;

// The Rayleigh-Plateau disturbance ratio and the secondary-droplet cap used to
// live here as module constants as well as on the parameter objects that
// actually drive the solver. Nothing read the constants, and they had drifted:
// this file said the disturbance ratio was 0.03 and put breakup at 15-20 cm
// while `defaultStreamParams` used 0.05 and the UI slider labelled it 0.05. A
// second, stale, unread copy of a calibrated number is worse than none, so the
// parameter objects are now the only statement of both. See
// `StreamParams.disturbanceRatio` and `ImpactModelParams.maxSecondaries`.

/**
 * Attenuation on the aerodynamic term of the jet-breakup dispersion relation.
 *
 * Weber (1931) extended Rayleigh's capillary analysis with the inertia of the
 * surrounding air, modelled as a Kelvin-Helmholtz pressure on the interface. That
 * term is what produces the observed *maximum* in breakup length against jet
 * velocity: capillary breakup alone gives a length that rises linearly with speed
 * for ever, whereas real jets rise, peak, and then break up sooner as they go
 * faster (Grant & Middleman 1966; the falling branch is the defining feature of
 * the first wind-induced regime).
 *
 * Weber's own coefficient overpredicts the effect, because a real jet does not
 * meet a clean velocity discontinuity -- there is a gas boundary layer, and the
 * perturbation pressure at the interface is correspondingly weaker. Sterling &
 * Sleicher, "The instability of capillary jets", *J. Fluid Mech.* 68 (1975),
 * multiply the aerodynamic force term by C = 0.175, fitted so that predicted
 * breakup lengths match measurement. That is the constant used here.
 *
 * It is a published coefficient rather than a dial, so it lives with the other
 * physical constants and is read only by `sim/stream.ts`.
 */
export const JET_AERO_ATTENUATION = 0.175;

/** Below this film thickness (m) a cell is treated as dry. */
export const FILM_DRY_THICKNESS = 2e-6;
