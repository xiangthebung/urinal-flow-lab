import { SurfaceParams, defaultSurfaceParams } from './surface';
import { FittingsParams } from './fittings';
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
  /**
   * Metalwork. Overrides only.
   *
   * Per-model because it genuinely differs: a waterless urinal has no flush valve
   * at all, and a trough is sparged along its length rather than from a single
   * flushometer over the middle. Drawing a chrome flushometer on a waterless
   * fixture is not a small inaccuracy -- the absence of one is the entire point of
   * the product.
   */
  fittings?: Partial<FittingsParams>;
  /**
   * Where to aim on this fixture by default, as a profile fraction.
   *
   * Per-model because one global value cannot mean the same thing on a 340 mm
   * trough and a 950 mm stall: at the shared default of 0.18 the stall was struck
   * at 75 degrees, near normal incidence and the worst angle available, purely
   * because the same fraction lands somewhere different on a fixture three times
   * the height.
   */
  defaultAimV?: number;
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
    // Dimensioned against an American Standard Washbrook 6501: 358 x 388 x 640 mm
    // against a 356 x 356 x ~650 nominal, with the rim 600 mm above the floor for a
    // standard adult install rather than the 430 mm ADA cap.
    params: P({
      rimHeight: 0.49,
      bowlDepth: 0.348,
      backWallMode: 'concave',
      backWallRun: 0.12,
      widthRim: 0.31,
      // A broad washout floor with the outlet forward of centre, which is what the
      // reference product has. This is a materially different drainage geometry
      // from the narrow funnel this preset used to carry (widthSump 0.14,
      // drainZ 0.10), so its residual and clear-time figures moved with it.
      widthSump: 0.185,
      // Kept close to the rim width on purpose. Narrowing the lip looks sleeker in
      // plan but it leaves a gap on each side between the front rise and the back
      // wall's side edge, and splash leaves straight through it: dropping the lip
      // from 0.28 to 0.22 m on the constant-angle model multiplied the volume
      // reaching the user by five. A urinal is only enclosed if its front closes
      // the full width.
      widthLip: 0.275,
      taperExponent: 2.4,
      wrapDepth: 0.275,
      wrapExponent: 3.5,
      wrapDecay: 0.6,
      throatHeight: 0.06,
      sumpDepth: 0.03,
      sumpSlope: 0.12,
      // Forward of centre, and that is what pulls the notch down from 131-138 mm to
      // 47-60 mm. The side edge of the opening bottoms out where the wrap fade has
      // reached zero, which is just short of the sump, so the notch is very nearly
      // `wrapDepth - drainZ`. Moving the outlet forward raises the profile depth at
      // that point and the edge has less to dive back to. See Trap 25.
      drainZ: 0.232,
      drainRadius: 0.026,
      // The sump floor runs well forward, which is what makes room for the outlet at
      // 232 mm without it being clamped back. Load-bearing for the notch: the clamp
      // ceiling on drainZ is `bowlDepth * sumpFrontFraction - 30 mm`, so leaving this
      // at the 0.55 default pins the outlet at 161 mm and the notch stays at 120 mm.
      sumpFrontFraction: 0.76,
      // 375 mm of front rise lifts the solid pedestal to 79% of the body height, so
      // the fixture reads as a column with a mouth cut into its top rather than a
      // bucket with a plate across it. Not pushed higher: past ~440 mm the front rim
      // shadows the back wall and the only reachable aim is the rim strike of Trap 14.
      frontLipHeight: 0.375,
      frontLipInturn: 0.03,
      rimAboveFloor: 0.6,
    }),
    shell: {
      sectionSmoothing: 0,
      bulge: 0.0,
      clearance: 0.012,
      wallThickness: 0.026,
      rimThickness: 0.024,
      rimBandWidth: 0.032,
      backSetback: 0.014,
      bottomExtension: 0.12,
      bottomTaper: 0.17,
    },
    // 55 degrees, and it is 55 degrees anywhere from v = 0.10 to 0.38 — this bowl is
    // a uniformly steep target, which is the mechanism the expectation above
    // describes. Past 0.42 the casting blocks the aim entirely.
    defaultAimV: 0.26,
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
      // Slower decay, which is what cuts the notch here. Trap 25 does not bind on a
      // dead vertical wall: the profile sits at z = 0 for the whole height, so the
      // lowest point of the opening's side edge falls low on the *wall* where the
      // wrap has decayed, not at the sump. Moving the outlet forward alone took the
      // notch only 103 -> 79 mm; holding the wrap open further down took it to 52 mm.
      wrapDecay: 0.6,
      throatHeight: 0.06,
      sumpDepth: 0.028,
      sumpSlope: 0.06,
      // Forward, to unclamp against sumpFrontFraction below. Worth less here than on
      // a curved-back bowl, for the reason above, but it is not nothing.
      sumpFrontFraction: 0.72,
      drainZ: 0.17,
      drainRadius: 0.026,
      frontLipHeight: 0.3,
      frontLipInturn: 0.008,
      rimAboveFloor: 0.62,
    }),
    shell: {
      sectionSmoothing: 0,
      bulge: 0.0,
      clearance: 0.014,
      rimThickness: 0.026,
      rimBandWidth: 0.03,
      bottomTaper: 0.72,
      bottomExtension: 0.06,
    },
    // 33 degrees. The slab improves monotonically down to v = 0.38 (31 degrees) and
    // then spikes to 51 as the trace falls into the throat, so this sits one step
    // back from the optimum for margin.
    defaultAimV: 0.34,
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
    // Dimensioned against an American Standard Stallbrook 6400 / Kohler Branham
    // K-25039-T: 458 x 382 x 974 mm against a 457 x 381 x 972 nominal. The rim sits
    // 960 mm above the floor, far above the 430 mm ADA cap, because this is the
    // non-accessible tall variant -- that is what a full stall urinal is. The base
    // finishes 14 mm below finished floor, matching Kohler's note that the lip
    // installs below floor level for easier cleaning around the fixture.
    params: P({
      rimHeight: 0.92,
      bowlDepth: 0.294,
      backWallMode: 'concave',
      backWallRun: 0.125,
      widthRim: 0.41,
      // Held wide, with the taper delayed, so the channel walls stay parallel for
      // most of the height instead of flaring into a funnel. That is also what keeps
      // the fitted casting at near-full width down to the floor rather than drawing
      // it into a nose, which is the difference between a stall urinal and a boot.
      widthSump: 0.32,
      widthLip: 0.36,
      taperExponent: 3.0,
      // Generous stand-off held well down the profile: these are the full-length
      // sidewalls the reference product advertises for privacy.
      wrapDepth: 0.22,
      wrapExponent: 5.0,
      wrapDecay: 0.6,
      throatHeight: 0.1,
      sumpDepth: 0.03,
      sumpSlope: 0.09,
      // Forward outlet, with the front rise near-vertical. Together these cut the
      // notch from 91-105 mm to 34-48 mm. See Trap 25.
      drainZ: 0.185,
      drainRadius: 0.028,
      frontLipHeight: 0.3,
      frontLipInturn: 0.014,
      sumpFrontFraction: 0.9,
      rimAboveFloor: 0.96,
    }),
    shell: {
      sectionSmoothing: 0,
      bulge: 0.0,
      wallThickness: 0.036,
      rimThickness: 0.024,
      rimBandWidth: 0.03,
      bottomTaper: 0.94,
      bottomExtension: 0.02,
    },
    // Short spindle: the fixture is already a metre tall, so the flushometer sits
    // down on the deck rather than on a long riser.
    fittings: { pipeRise: 0.1 },
    // 42 degrees, against 74 at the old global default of 0.18. This is the model
    // that made per-model aim necessary: the same profile fraction lands somewhere
    // completely different on a fixture nearly a metre tall, and 0.18 put the stream
    // into the top of the back panel at near-normal incidence — the worst angle
    // available on the fixture. It improves monotonically all the way down.
    defaultAimV: 0.5,
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
    // Dimensioned against a Pland Bremen 1500 / Acorn five-foot stainless trough:
    // 1485 x 417 x 290 mm, top edge 610 mm above the floor. A trough's "length" is
    // its width in this model's terms, so it is widthRim that carries it.
    params: P({
      rimHeight: 0.2,
      bowlDepth: 0.35,
      backWallMode: 'planar',
      // Five degrees rather than four, and it earns its keep: leaning the back panel
      // carries the side edge forward just fast enough to cancel the wrap's decay,
      // which holds the notch at exactly 0 mm. At four degrees it reads 2 mm.
      backWallTilt: degToRad(5),
      backWallRun: 0,
      widthRim: 1.44,
      // Sump and lip stay within 60 mm of the rim width: the channel runs the whole
      // length, it does not funnel to a point.
      widthSump: 1.38,
      widthLip: 1.42,
      taperExponent: 1.0,
      // Barely wraps, which is a real part of why troughs spread mess to the floor.
      wrapDepth: 0.05,
      wrapExponent: 3.0,
      wrapDecay: 1.0,
      throatHeight: 0.045,
      sumpDepth: 0.03,
      sumpSlope: 0.005,
      sumpFrontFraction: 0.72,
      drainZ: 0.115,
      drainRadius: 0.022,
      // Low front upstand under a taller back panel, which is the trough profile.
      frontLipHeight: 0.12,
      frontLipInturn: 0.0,
      rimAboveFloor: 0.61,
    }),
    shell: {
      // Zero, for the same reason it is zero on the slab. At two passes the fitted
      // plan relaxes toward a circle, and on a body 1485 mm long by 417 mm deep that
      // reads as a canoe: it bows out at the middle and pinches at both ends.
      sectionSmoothing: 0,
      bulge: 0.0,
      clearance: 0.022,
      rimThickness: 0.022,
      rimBandWidth: 0.03,
      // Shallow flat underside, as a wall-hung pressed unit has.
      bottomTaper: 0.95,
      bottomExtension: 0.06,
    },
    // Lifted clear of a fixture only 290 mm tall.
    fittings: { pipeRise: 0.26 },
    // 52 degrees, and the last step before the throat: v = 0.30 jumps to 80. A
    // trough has very little wall to aim at, which is part of why it behaves badly.
    defaultAimV: 0.22,
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
    // Dimensioned against a Sloan WES-1000 waterfree urinal: 362 x 497 x 681 mm
    // against a 365 x 498 x 679 nominal. The depth is the striking figure -- this
    // fixture projects half again as far from the wall as a conventional bowl.
    //
    // rimAboveFloor cannot be the 610 mm standard here: a 679 mm body with its rim at
    // 610 puts its base through the floor. 0.74 puts the front lip at 635 mm and
    // leaves the nose 59 mm clear of the floor, which the outlet spud needs.
    params: P({
      rimHeight: 0.525,
      bowlDepth: 0.43,
      backWallMode: 'concave',
      // Needed alongside the forward drain: with a shallower run the back wall's own
      // z plus wrap dips below the drain and the wall, not the throat, becomes the
      // lowest point of the opening's side edge.
      backWallRun: 0.12,
      widthRim: 0.315,
      // The most aggressive funnel in the library, and it has to be: there is no
      // flush to rinse this fixture, so gravity does all of it. drainRadius stays at
      // 0.02, already the smallest here -- shrinking it further would throttle the
      // one thing this model is supposed to win on.
      widthSump: 0.075,
      widthLip: 0.278,
      taperExponent: 2.8,
      wrapDepth: 0.23,
      wrapExponent: 2.8,
      wrapDecay: 1.1,
      throatHeight: 0.05,
      sumpDepth: 0.045,
      sumpSlope: 0.34,
      // Forward of centre under the funnel. Cuts the notch from 149-154 mm to
      // 48-57 mm; see Trap 25.
      drainZ: 0.19,
      drainRadius: 0.02,
      frontLipHeight: 0.42,
      frontLipInturn: 0.03,
      sumpFrontFraction: 0.62,
      rimAboveFloor: 0.74,
    }),
    shell: {
      sectionSmoothing: 2,
      bulge: 0.0,
      clearance: 0.01,
      wallThickness: 0.022,
      // A rolled lip at the thin end of the band. There is no hollow flushing rim on
      // a waterless fixture, so it should not carry a washout urinal's heavy flange.
      rimThickness: 0.023,
      rimBandWidth: 0.03,
      bottomExtension: 0.11,
      bottomTaper: 0.17,
    },
    // No flush valve, and this is the whole point of the product rather than a
    // detail: a sealed cartridge in the outlet forms the trap, so there is no water
    // supply and no flushometer. The outlet spud stays, because the cartridge does
    // connect to a waste pipe.
    fittings: { flushValve: false },
    // 63 degrees. Steep everywhere, which is the price of a deep narrow funnel with
    // no flush: the walls have to converge hard, and converging walls meet a
    // descending stream closer to normal. Past v = 0.30 the casting blocks the aim.
    defaultAimV: 0.26,
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
      // 0.95, and the margin below it is the point. On this model the lowest point of
      // the opening's side edge is the generated wall's *foot*, which buildProfile
      // pins at z = min(maxWallRun/2, 0.02) -- a hardcoded 0.02 that no preset value
      // can lift -- so the wall always returns to the mounting plane at the throat
      // however far forward the outlet goes. That makes Trap 25 nearly powerless
      // here: drainZ alone moved the notch 356 -> 344 mm. Holding the wrap open
      // further down is the only lever left, and it runs straight into Trap 3: at
      // wrapDecay 0.6 the notch reaches 282 mm but the grid grows 26 degenerate cells
      // at 72x132 and 153 at 112x200 -- while staying perfectly clean at 48x96 and
      // 56x104, which is exactly how this fault hides from anyone who does not run
      // every resolution. 0.85 is clean and reaches 290; 0.95 is clean and reaches
      // 300, and is chosen for the extra distance from the cliff.
      wrapDecay: 0.95,
      sumpDepth: 0.03,
      sumpSlope: 0.15,
      sumpFrontFraction: 0.72,
      drainZ: 0.19,
      drainRadius: 0.028,
      frontLipHeight: 0.3,
      frontLipInturn: 0.03,
      rimAboveFloor: 0.62,
    }),
    shell: {
      sectionSmoothing: 3,
      bulge: 0.006,
      rimThickness: 0.022,
      rimBandWidth: 0.032,
      bottomExtension: 0.1,
      bottomTaper: 0.2,
    },
    // 25 degrees, held flat from v = 0.10 all the way to 0.42, which is the whole
    // claim of the generated wall. Kept well inside that band rather than at its
    // edge: at 0.46 the trace has left the governed wall and reads 48 degrees, and
    // the advantage goes with it.
    defaultAimV: 0.18,
  },
];

export const DEFAULT_PRESET_ID = 'classic-bowl';

export const getPreset = (id: string): UrinalPreset =>
  PRESETS.find((p) => p.id === id) ??
  PRESETS.find((p) => p.id === DEFAULT_PRESET_ID) ??
  PRESETS[0];
