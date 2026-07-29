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
 * throws secondary droplets. Note this K uses the *same* We^0.5 Re^0.25
 * grouping, so a single K can be compared against either threshold.
 *
 * This is the threshold that actually governs a urinal in use: after the
 * first second the wall is wet, and a wet wall splashes at a *lower*
 * velocity than a dry one once the film is thin (delta ~ 0.1), which is
 * why a urinal gets messier as it is used.
 */
export const WET_SPLASH_K_BASE = 2100;
export const WET_SPLASH_K_FILM = 5880;
export const WET_SPLASH_K_FILM_EXP = 1.44;

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

/**
 * Rayleigh-Plateau initial disturbance ratio, eps0 / jet_radius.
 *
 * Breakup length follows L_b = (v / omega) * ln(r / eps0), so this single
 * number sets how far the coherent stream travels before it becomes a
 * droplet train. A perfectly quiet circular nozzle has eps0/r ~ 1e-3
 * (long jet). The human meatus is a compliant, non-circular slit driven by
 * a pulsatile bladder, so the disturbance is large. eps0/r = 0.03 puts
 * breakup at roughly 15-20 cm for a 3 mm, 3 m/s stream, matching the
 * high-speed video from Hurd & Truscott's urethra-replica experiments.
 */
export const JET_DISTURBANCE_RATIO = 0.03;

/** Secondary droplet count cap per impact event, to bound cost. */
export const MAX_SECONDARIES_PER_IMPACT = 12;

/** Below this film thickness (m) a cell is treated as dry. */
export const FILM_DRY_THICKNESS = 2e-6;
