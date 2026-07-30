import { SurfaceParams, defaultSurfaceParams } from './surface';
import { ShellParams } from './shell';
import { degToRad } from '../core/vec3';

/**
 * The fixture library.
 *
 * Six models, chosen so they are told apart at a glance and so they span the
 * design space rather than flattering any one approach: four ordinary products
 * you would actually find installed, one deliberate control, and one shape
 * generated from the constant-impingement-angle condition.
 *
 * Distinguishable at a glance matters more than it sounds. The whole point of the
 * tool is comparing fixtures, and a picker full of near-identical bowls makes the
 * comparison feel arbitrary -- if two entries look the same, a difference in the
 * numbers reads as noise. So the set is spread across envelope as well as wall
 * shape: a compact bowl, a hard-edged slab, a full-height stall, a wide trough, a
 * deep narrow waterless bowl, and the generated shape.
 *
 * Dimensions are taken from real fixtures where there is a real fixture to copy.
 * A wall-hung bowl is around 330-360 mm wide, 330-345 mm deep and 445-540 mm tall
 * (TOTO's wall-hung bowl is 320 x 340 x 540, RAK's Jazira 355 x 330 x 445), and
 * the accessible mounting limit is a 430 mm rim.
 */

export interface UrinalPreset {
  id: string;
  name: string;
  /** One line on what this shape is and what it is for. */
  summary: string;
  /** What a designer should expect to see, so the result can be sanity checked. */
  expectation: string;
  params: SurfaceParams;
  /**
   * Exterior character. Cosmetic only -- it changes the casting around the bowl,
   * never the wetted surface the simulation runs on. Present because the outside
   * is most of what makes one fixture recognisably different from another, and
   * two models with the same bowl can still be a soft oval and a hard slab.
   */
  shell?: Partial<ShellParams>;
}

const P = (over: Partial<SurfaceParams>): SurfaceParams => ({
  ...defaultSurfaceParams(),
  ...over,
});

export const PRESETS: UrinalPreset[] = [
  {
    id: 'classic-bowl',
    name: 'Oval wall-hung bowl',
    summary:
      'The everyday mid-market fixture: rounded oval casting, gently concave back, ' +
      'tapered funnel to a central outlet.',
    expectation:
      'The reference product, and a useful surprise: it can score worse on ' +
      'splashback than a dead flat wall. Curving the back forward at its base tilts ' +
      'the lower face up into a descending stream, which raises the impingement ' +
      'angle and throws the grazing splash outward toward the user. Curvature is ' +
      'not the answer on its own — its direction is what matters.',
    params: P({
      rimHeight: 0.4,
      bowlDepth: 0.28,
      backWallMode: 'concave',
      backWallRun: 0.045,
      widthRim: 0.32,
      widthSump: 0.14,
      // Kept close to the rim width on purpose. Narrowing the lip looks sleeker in
      // plan but it leaves a gap on each side between the front rise and the back
      // wall's side edge, and splash leaves straight through it: dropping the lip
      // from 0.28 to 0.22 m on the constant-angle model multiplied the volume
      // reaching the user by five. A urinal is only enclosed if its front closes
      // the full width.
      widthLip: 0.28,
      taperExponent: 2.0,
      // Deep enough to actually enclose the bowl. This used to have to be held
      // back to 0.14 to keep the grid conditioned, which left an open scoop that
      // neither looked like a fixture nor contained any splash; with the section
      // walked at constant arclength and the width taper made differentiable at
      // the sump, 0.18 costs nothing -- no flipped normals and no degenerate cells
      // at any resolution.
      wrapDepth: 0.22,
      wrapExponent: 2.6,
      wrapDecay: 1.2,
      throatHeight: 0.055,
      sumpDepth: 0.025,
      sumpSlope: 0.12,
      drainZ: 0.1,
      drainRadius: 0.025,
      frontLipHeight: 0.26,
      frontLipInturn: 0.022,
      rimAboveFloor: 0.6,
    }),
    shell: { sectionSmoothing: 5, bulge: 0.014, bottomTaper: 0.3 },
  },
  {
    id: 'flat-wall',
    name: 'Square slab',
    summary:
      'Rectilinear designer fixture: flat planes, crisp edges, and a dead flat ' +
      'vertical back wall.',
    expectation:
      'Worst case for impingement, and the reason it is in the set. A vertical flat ' +
      'wall meets the stream near normal incidence, so it gives the highest splash ' +
      'fraction here and acts as the reference every other back wall has to beat — ' +
      'without it a splashback percentage has no scale. The square styling is real, ' +
      'not a caricature; it is also what makes a flat back wall attractive to ' +
      'specify.',
    params: P({
      backWallMode: 'planar',
      backWallTilt: 0,
      backWallRun: 0,
      rimHeight: 0.46,
      bowlDepth: 0.3,
      // Barely tapered and squarely sectioned, which is what makes it read as a
      // slab rather than a bowl.
      widthRim: 0.34,
      widthSump: 0.17,
      widthLip: 0.3,
      taperExponent: 1.0,
      wrapDepth: 0.2,
      // Squarish in plan, which is the whole look, but not so square that the
      // corner of the section pinches the cells there.
      wrapExponent: 3.4,
      wrapDecay: 1.0,
      throatHeight: 0.06,
      sumpDepth: 0.028,
      sumpSlope: 0.06,
      drainZ: 0.11,
      drainRadius: 0.026,
      frontLipHeight: 0.3,
      frontLipInturn: 0.008,
      rimAboveFloor: 0.62,
    }),
    shell: {
      sectionSmoothing: 0,
      bulge: 0.004,
      clearance: 0.014,
      bottomTaper: 0.78,
      bottomExtension: 0.04,
    },
  },
  {
    id: 'stall-urinal',
    name: 'Full-height stall',
    summary:
      'Floor-standing stall urinal: a tall back panel carried almost to the floor, ' +
      'wide and shallow, with a low front.',
    expectation:
      'The tall panel means the stream can land a long way up, so aim matters more ' +
      'here than on any conventional bowl — sweep it before drawing conclusions. ' +
      'Reaching the floor makes it accessible without a low mount, but it also puts ' +
      'a large wetted area in play and the residual film has a long way to travel.',
    params: P({
      rimHeight: 0.95,
      bowlDepth: 0.32,
      backWallMode: 'concave',
      backWallRun: 0.03,
      widthRim: 0.4,
      widthSump: 0.16,
      widthLip: 0.34,
      taperExponent: 1.6,
      wrapDepth: 0.2,
      wrapExponent: 2.6,
      wrapDecay: 1.0,
      throatHeight: 0.08,
      sumpDepth: 0.03,
      sumpSlope: 0.1,
      drainZ: 0.12,
      drainRadius: 0.028,
      frontLipHeight: 0.32,
      frontLipInturn: 0.018,
      // Rim nearly a metre up with the sump just clear of the floor.
      rimAboveFloor: 1.02,
    }),
    shell: { sectionSmoothing: 2, bulge: 0.008, bottomTaper: 0.72, bottomExtension: 0.03 },
  },
  {
    id: 'trough',
    name: 'Multi-user trough',
    summary:
      'A wide level-floored gutter with one outlet at the centre. Common in older ' +
      'commercial and stadium installations.',
    expectation:
      'Drains badly by construction. With almost no floor gradient the residual film ' +
      'has nothing driving it toward the outlet, so expect a large standing volume ' +
      'and a long drain time. Splashback is only moderate, because impacts land in ' +
      'shallow pooled liquid rather than on dry glaze — but the shallow wrap means ' +
      'what does splash leaves sideways and reaches the floor.',
    params: P({
      rimHeight: 0.34,
      bowlDepth: 0.26,
      backWallMode: 'planar',
      backWallTilt: degToRad(4),
      backWallRun: 0,
      widthRim: 0.9,
      widthSump: 0.84,
      widthLip: 0.88,
      taperExponent: 1.0,
      // Barely wraps, which is a real part of why troughs spread mess to the floor.
      wrapDepth: 0.05,
      wrapExponent: 3.0,
      wrapDecay: 1.0,
      throatHeight: 0.045,
      sumpDepth: 0.03,
      sumpSlope: 0.005,
      drainZ: 0.1,
      drainRadius: 0.022,
      frontLipHeight: 0.2,
      frontLipInturn: 0.0,
      rimAboveFloor: 0.52,
    }),
    shell: {
      sectionSmoothing: 1,
      bulge: 0.006,
      clearance: 0.016,
      bottomTaper: 0.82,
      bottomExtension: 0.04,
    },
  },
  {
    id: 'compact-waterless',
    name: 'Compact waterless',
    summary:
      'Small, deep and narrow, with a steeply graded sump into a trap cartridge. ' +
      'No flush, so drainage is gravity alone.',
    expectation:
      'The deep enclosed section is the point: it puts the impact well inside the ' +
      'casting and gives splash a long way to travel before it can reach anyone. ' +
      'Drainage should be the best of the conventional set thanks to the steep sump ' +
      'and tight throat, which it has to be — there is no flush to rinse it and ' +
      'anything left behind concentrates.',
    params: P({
      rimHeight: 0.36,
      bowlDepth: 0.31,
      backWallMode: 'concave',
      backWallRun: 0.055,
      widthRim: 0.26,
      widthSump: 0.09,
      widthLip: 0.22,
      taperExponent: 2.6,
      // Enclosure here comes mostly from the depth and from a lip nearly as wide as
      // the rim; the side wrap is held back because this bowl's narrow sump and
      // strong taper make it the model most prone to skewing cells.
      wrapDepth: 0.23,
      wrapExponent: 2.4,
      wrapDecay: 1.1,
      throatHeight: 0.05,
      sumpDepth: 0.04,
      sumpSlope: 0.2,
      drainZ: 0.09,
      drainRadius: 0.02,
      frontLipHeight: 0.24,
      frontLipInturn: 0.03,
      rimAboveFloor: 0.58,
    }),
    shell: { sectionSmoothing: 6, bulge: 0.018, bottomTaper: 0.2, bottomExtension: 0.07 },
  },
  {
    id: 'nautilus-tall',
    name: 'Constant-angle (splash-free)',
    summary:
      'Back wall generated by integrating the constant-impingement-angle condition: ' +
      'slim, tall and deep, with a wall the film runs straight down.',
    expectation:
      'The headline result, and the one most sensitive to aim. Impingement is held ' +
      'near the target across the generated wall and splashback on the user drops ' +
      'several-fold against the flat slab — but only while the stream lands on that ' +
      'wall. Aim lower and the impact moves onto the throat fillet, which the ' +
      'generator does not govern and which is steep; the advantage then disappears ' +
      'entirely. Run the aim sweep before judging this shape. Note the envelope: at ' +
      '510 mm deep this is half again the depth of a conventional bowl, and the ' +
      'result depends on the deep section as much as on the wall.',
    params: P({
      backWallMode: 'constantAngle',
      spiralBranch: 'tall',
      targetImpingementAngle: degToRad(25),
      streamOrigin: { z: 0.4, y: 0.52 },
      streamSpeed: 3.0,
      rimHeight: 0.48,
      bowlDepth: 0.32,
      // Carried down close to the sump on purpose. The generator only governs the
      // wall it builds; below that is an ordinary fillet, and if the stream reaches
      // the fillet the constant-angle property buys nothing.
      throatHeight: 0.028,
      widthRim: 0.3,
      widthSump: 0.1,
      // Deeply enclosed, and it has to be. The generated wall is what stops splash
      // being created; the section is what stops whatever is still created from
      // getting out. Opening either one up throws the result away.
      widthLip: 0.28,
      taperExponent: 1.8,
      // Deep, and it has to be. The wrap is what keeps the splash in once the wall
      // has stopped it being created: at 0.15 the splashback advantage over the flat
      // slab falls from eight-fold to none, and at 0.21 it is still only 1.8-fold.
      // The cost is a very large casting -- the wrap is measured forward from
      // wherever the generated wall has already swept to, so this fixture ends up
      // 510 mm deep against 360 mm for a conventional bowl. That is a real trade and
      // it is left visible rather than tuned away, because a shape that only works
      // at half a metre of depth is a fact a specifier needs.
      wrapDepth: 0.26,
      wrapExponent: 2.6,
      wrapDecay: 1.15,
      sumpDepth: 0.03,
      sumpSlope: 0.15,
      drainZ: 0.12,
      drainRadius: 0.028,
      frontLipHeight: 0.3,
      frontLipInturn: 0.03,
      rimAboveFloor: 0.62,
    }),
    shell: { sectionSmoothing: 7, bulge: 0.02, bottomTaper: 0.24, bottomExtension: 0.075 },
  },
];

export const DEFAULT_PRESET_ID = 'classic-bowl';

export const getPreset = (id: string): UrinalPreset =>
  PRESETS.find((p) => p.id === id) ??
  PRESETS.find((p) => p.id === DEFAULT_PRESET_ID) ??
  PRESETS[0];
