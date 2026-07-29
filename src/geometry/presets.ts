import { SurfaceParams, defaultSurfaceParams } from './surface';
import { degToRad } from '../core/vec3';

/**
 * A library of urinal geometries to design against.
 *
 * The set is chosen to span the real design space rather than to flatter any
 * one approach: two deliberately poor baselines, three conventional fixtures,
 * and two shapes generated from the constant-impingement-angle condition. Being
 * able to run the same stream against a flat wall and against a generated shape
 * back to back is the point -- the flat wall is the control, and without it a
 * splashback figure has no scale.
 */

export interface UrinalPreset {
  id: string;
  name: string;
  /** One line on what this shape is and what it is for. */
  summary: string;
  /** What a designer should expect to see, so the result can be sanity checked. */
  expectation: string;
  params: SurfaceParams;
}

const P = (over: Partial<SurfaceParams>): SurfaceParams => ({
  ...defaultSurfaceParams(),
  ...over,
});

export const PRESETS: UrinalPreset[] = [
  {
    id: 'flat-wall',
    name: 'Flat wall (control)',
    summary:
      'A dead-flat vertical back wall in an otherwise standard bowl. Not a ' +
      'product, a reference: the back wall every other design has to beat.',
    expectation:
      'Worst case for impingement. The stream meets the wall near normal ' +
      'incidence, so expect the highest splash fraction of the set.',
    // Deliberately identical to the classic bowl in every respect except the back
    // wall. It is tempting to make the control crude in all directions, but that
    // ruins it as a control: an open-sided plate lets splash escape past the user
    // instead of back at them, and would score *better* than a real bowl for a
    // reason that has nothing to do with the wall being flat. Changing one
    // variable is the whole point of having a baseline.
    params: P({
      backWallMode: 'planar',
      backWallTilt: 0,
      backWallRun: 0,
    }),
  },
  {
    id: 'flat-bottom-trough',
    name: 'Flat-bottom trough (control)',
    summary:
      'A wide trough with a level floor and a single outlet at one end. Common in ' +
      'older commercial installations.',
    expectation:
      'Drains badly by construction. With no floor gradient the residual film has ' +
      'nothing driving it toward the outlet, so expect a large standing volume and ' +
      'a long drain time. Splash is moderate because impacts land in shallow pooled ' +
      'liquid rather than on dry glaze.',
    params: P({
      backWallMode: 'planar',
      backWallTilt: degToRad(4),
      rimHeight: 0.36,
      bowlDepth: 0.28,
      widthRim: 0.44,
      widthSump: 0.42,
      widthLip: 0.44,
      taperExponent: 1.0,
      // Troughs are shallow and barely wrap, which is a real part of why they
      // spread mess to the floor.
      wrapDepth: 0.06,
      wrapDecay: 1.0,
      sumpDepth: 0.03,
      sumpSlope: 0.005,
      drainZ: 0.1,
      drainRadius: 0.022,
      frontLipHeight: 0.2,
      frontLipInturn: 0.0,
      throatHeight: 0.045,
    }),
  },
  {
    id: 'classic-bowl',
    name: 'Classic bowl',
    summary:
      'A conventional mid-market wall-hung fixture: gently concave back, tapered ' +
      'funnel to a central outlet, modest lip return.',
    expectation:
      'The reference product, and a useful surprise: it can score *worse* on ' +
      'splashback than the flat control. Curving the wall forward at the base tilts ' +
      'its lower face up into a descending stream, which both raises the ' +
      'impingement angle and aims the grazing splash outward toward the user. ' +
      'Curvature on its own is not the answer — the direction of the curvature is ' +
      'what matters.',
    params: P({}),
  },
  {
    id: 'deep-funnel',
    name: 'Deep funnel',
    summary:
      'Strong width taper into a narrow throat with a steeply graded sump. ' +
      'Optimised for drainage rather than for splash.',
    expectation:
      'Best drainage figures in the set: high film velocity near the outlet and ' +
      'very little residual volume. Splash is no better than the classic bowl, ' +
      'because the wall angles are unchanged.',
    params: P({
      backWallMode: 'concave',
      backWallRun: 0.05,
      rimHeight: 0.44,
      bowlDepth: 0.32,
      widthRim: 0.36,
      widthSump: 0.07,
      widthLip: 0.34,
      taperExponent: 2.4,
      wrapDepth: 0.28,
      wrapExponent: 2.6,
      wrapDecay: 1.15,
      sumpDepth: 0.035,
      sumpSlope: 0.18,
      drainZ: 0.1,
      drainRadius: 0.03,
      throatHeight: 0.07,
      frontLipHeight: 0.31,
      frontLipInturn: 0.025,
    }),
  },
  {
    id: 'ada-low',
    name: 'ADA low-mount',
    summary:
      'Rim at 430 mm to meet the accessible-reach requirement, which drops the ' +
      'stream origin relative to the fixture.',
    expectation:
      'The lower rim shortens the fall, so the stream is still partly coherent at ' +
      'impact and splashes less than its wall angles suggest. Worth checking ' +
      'against a standing user as well, since the same fixture serves both.',
    params: P({
      rimAboveFloor: 0.43,
      rimHeight: 0.4,
      bowlDepth: 0.3,
      backWallRun: 0.05,
      widthRim: 0.36,
      widthSump: 0.13,
      sumpSlope: 0.12,
      frontLipHeight: 0.29,
      frontLipInturn: 0.025,
    }),
  },
  {
    id: 'hooded-bowl',
    name: 'Hooded bowl',
    summary:
      'A classic bowl with a deep forward hood over the rim and a pronounced lip ' +
      'return. Attacks splashback by interception rather than by wall angle.',
    expectation:
      'Expect this to backfire, and badly. Interception does nothing about the ' +
      'splash itself, and the hood presents a downward-facing surface at the front ' +
      'of the fixture: droplets that strike its underside are thrown down and ' +
      'outward, which is exactly where the user is standing. It scores worst of the ' +
      'whole set. Treating splashback as something to catch rather than something ' +
      'not to create is the trap this preset exists to demonstrate.',
    params: P({
      backWallMode: 'concave',
      backWallRun: 0.055,
      rimHeight: 0.44,
      bowlDepth: 0.32,
      hoodDepth: 0.075,
      widthRim: 0.36,
      widthSump: 0.12,
      wrapDepth: 0.27,
      wrapDecay: 1.1,
      frontLipHeight: 0.32,
      frontLipInturn: 0.04,
      sumpSlope: 0.13,
    }),
  },
  {
    id: 'nautilus-tall',
    name: 'Constant-angle, tall',
    summary:
      'Back wall generated by integrating the constant-impingement-angle ' +
      'condition on the tall branch: slim, deep, film runs straight down.',
    expectation:
      'The headline result, and the one most sensitive to aim. Impingement is held ' +
      'near the target across the generated wall, and splashback on the user drops ' +
      'several-fold against the flat control — but only while the stream lands on ' +
      'that wall. Aim lower and the impact moves onto the throat fillet, which the ' +
      'generator does not govern and which is steep; the advantage then disappears ' +
      'entirely. Run the aim sweep before judging this shape.',
    params: P({
      backWallMode: 'constantAngle',
      spiralBranch: 'tall',
      targetImpingementAngle: degToRad(25),
      streamOrigin: { z: 0.4, y: 0.52 },
      streamSpeed: 3.0,
      rimHeight: 0.48,
      bowlDepth: 0.32,
      // Carried down close to the sump on purpose. The generator only governs the
      // wall it builds; whatever is below it is an ordinary fillet, and if the
      // stream reaches that fillet the constant-angle property buys nothing. The
      // wall has to extend past wherever the stream can plausibly land.
      throatHeight: 0.028,
      widthRim: 0.3,
      widthSump: 0.1,
      widthLip: 0.3,
      taperExponent: 1.8,
      wrapDepth: 0.26,
      wrapDecay: 1.15,
      sumpDepth: 0.03,
      sumpSlope: 0.15,
      drainZ: 0.12,
      drainRadius: 0.028,
      frontLipHeight: 0.3,
      frontLipInturn: 0.03,
    }),
  },
  {
    id: 'cornucopia-scoop',
    name: 'Constant-angle, scoop',
    summary:
      'The other branch of the same condition: the wall sweeps forward into a horn ' +
      'that opens toward the user.',
    expectation:
      'The strongest splashback result in the set: the horn can meet the stream at ' +
      'only a few degrees, which puts the impact far below any splash threshold and ' +
      'very nearly eliminates ejection. The cost is a large, shallowly inclined ' +
      'wetted area, so watch residence time and standing depth rather than assuming ' +
      'the win is free. Same aim sensitivity as the tall branch, and the same deep ' +
      'envelope, which is what makes these shapes look unusual.',
    params: P({
      backWallMode: 'constantAngle',
      spiralBranch: 'scoop',
      targetImpingementAngle: degToRad(25),
      streamOrigin: { z: 0.4, y: 0.52 },
      streamSpeed: 3.0,
      rimHeight: 0.46,
      bowlDepth: 0.38,
      throatHeight: 0.028,
      widthRim: 0.34,
      widthSump: 0.11,
      widthLip: 0.34,
      wrapDepth: 0.31,
      wrapDecay: 1.25,
      sumpDepth: 0.03,
      sumpSlope: 0.14,
      drainZ: 0.14,
      drainRadius: 0.028,
      frontLipHeight: 0.26,
      frontLipInturn: 0.03,
    }),
  },
  {
    id: 'ribbed-drainage',
    name: 'Vertically ribbed bowl',
    summary:
      'A classic bowl with vertical grooves cut into the back wall to channel the ' +
      'film into rivulets.',
    expectation:
      'A genuine trade-off rather than a clear win. The grooves break up the local ' +
      'surface angle and cut splashback against the plain bowl, but they gather the ' +
      'film into narrow rivulets and leave deeper standing liquid, so residence time ' +
      'and peak depth get worse. Compare depth and stagnant area against the plain ' +
      'classic bowl before calling it an improvement.',
    params: P({
      backWallMode: 'concave',
      backWallRun: 0.05,
      ribMode: 'vertical',
      ribAmplitude: -0.002,
      ribWavelength: 0.024,
      widthSump: 0.12,
      sumpSlope: 0.14,
      frontLipInturn: 0.025,
    }),
  },
];

export const getPreset = (id: string): UrinalPreset =>
  PRESETS.find((p) => p.id === id) ?? PRESETS[2];
