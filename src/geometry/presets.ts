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
 * Dimensions are taken from real fixtures, and the reference product is named in a
 * comment beside every preset so the numbers can be checked rather than trusted.
 *
 * TWO OF THEM HAD THEIR AXES TRANSPOSED, which is worth stating here because the
 * mistake is easy to repeat: several manufacturers print three numbers with no axis
 * labels, and the orders differ between them. American Standard and Sloan list
 * D x W x H; Kohler lists H x W x D; Falcon spells out W x H x D. Read against the
 * wrong convention, `classic-bowl` came out 112 mm too narrow and 33 mm too deep,
 * and `compact-waterless` came out 140 mm too deep and 130 mm too narrow -- in both
 * cases inverting the plan aspect ratio, not just missing a size.
 *
 * Two independent checks catch it. Every US bowl and every waterless unit is WIDER
 * THAN IT IS DEEP, typically 1.2-1.35:1, because ANSI A117.1 pins the projection at
 * a minimum (343 mm) while the width is free, so the whole class piles up just above
 * that floor. And the phrase to look for on the sheet is "elongated 14 inch rim from
 * finished wall" -- that 14 inches is the PROJECTION, and it is the number that most
 * often ends up copied into the width slot as well.
 *
 * MARKET IDENTITY: THIS LIBRARY IS THE NORTH AMERICAN COMMERCIAL RANGE, on purpose.
 *
 * Urinals come in two size classes and they barely overlap. US fixtures carry
 * integral privacy sides and run wide -- Washbrook 470 x 355, Lynbrook 470 x 356,
 * Zurn Z5755-U 470 x 362, Kohler Bardon 457 x 359. European fixtures have no shields
 * and are far smaller -- V&B Subway 285 x 315, O.novo 290 x 245, Duravit Starck 3
 * 330 x 350, Geberit Selva 340 x 370.
 *
 * That distinction is not decoration here. The privacy sides ARE the enclosure, and
 * enclosure is what Trap 9 says governs how much splash leaves sideways -- so the two
 * classes are physically different objects for this simulation, not just different
 * sizes. Mixing them silently would make a comparison between two cards a comparison
 * of two markets.
 *
 * `classic-bowl` at its old 358 x 388 was, by accident, a credible European bowl
 * (within a few mm of a Geberit Selva) wearing an American spec sheet's name. It has
 * been re-dimensioned to the Washbrook it always claimed rather than re-attributed to
 * the European product, because the rest of the set -- the Stallbrook stall, the
 * Falcon waterless unit -- is North American, and because the wide shielded bowl is
 * the fixture the tool's headline claim is most often argued about.
 *
 * A European range would be a legitimate second library rather than an entry in this
 * one. If one is ever added, note that Geberit Selva and both Armitage Shanks models
 * are RIMLESS, which falsifies the "chunky rolled rim flange every real fixture has"
 * claim in the casting-style notes -- `rimThickness` would need to express a near
 * knife edge, and nothing in the current set exercises that.
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
    // Named for what it is rather than what it was. The id stays `classic-bowl`
    // because `src/validation/suite.ts` hardcodes it.
    name: 'Shielded wall-hung bowl',
    summary:
      'The everyday commercial fixture: a rounded-rectangular washout bowl, wider ' +
      'than it is deep, with extended sides for privacy and a gently concave back.',
    expectation:
      'The reference product, and a useful surprise: it can score worse on ' +
      'splashback than a dead flat wall. Curving the back forward at its base tilts ' +
      'the lower face up into a descending stream, which raises the impingement ' +
      'angle and throws the grazing splash outward toward the user. Curvature is ' +
      'not the answer on its own — its direction is what matters.',
    // Dimensioned against an American Standard Washbrook 6501.010 wall-hung washout:
    // 18-1/2 x 14 x 27-1/4 in = 470 W x 355 D x 692 H mm, rim 610 mm above finished
    // floor for a standard adult install.
    //
    // THE PLAN ASPECT USED TO BE INVERTED, and this is the default fixture every run
    // opens on. The reference was recorded as "356 x 356 x ~650 nominal" -- but the
    // 14 in on the spec sheet is the ELONGATED RIM FROM FINISHED WALL, i.e. the
    // projection, and it had been copied into the width slot as well. The real
    // fixture is 470 wide and 355 deep, W/D = 1.32; the preset built 358 x 388,
    // W/D = 0.92. It was 112 mm too narrow and 33 mm too deep, and it was the wrong
    // shape of object in plan, not merely the wrong size.
    //
    // Every full-size US shielded bowl is wider than it is deep, and by about the
    // same ratio: Washbrook FloWise 6590 480x360, Lynbrook 470x356, Zurn Z5755
    // 470x362, TOTO UT445U 451x362, Sloan SU-1009 438x362. The ratio is not
    // incidental -- ANSI A117.1 pins the projection at >= 343 mm while the width is
    // free, so the whole class lands in the same place. Only the compact class
    // (Kohler Dexter 343x368, Zurn Z5738 368x365) is square or deeper than wide, and
    // this preset is not one of those.
    params: P({
      rimHeight: 0.52,
      bowlDepth: 0.308,
      backWallMode: 'concave',
      backWallRun: 0.12,
      widthRim: 0.422,
      // A broad washout floor with the outlet forward of centre, which is what the
      // reference product has. This is a materially different drainage geometry
      // from the narrow funnel this preset used to carry (widthSump 0.14,
      // drainZ 0.10), so its residual and clear-time figures moved with it.
      widthSump: 0.252,
      // Kept close to the rim width on purpose. Narrowing the lip looks sleeker in
      // plan but it leaves a gap on each side between the front rise and the back
      // wall's side edge, and splash leaves straight through it: dropping the lip
      // from 0.28 to 0.22 m on the constant-angle model multiplied the volume
      // reaching the user by five. A urinal is only enclosed if its front closes
      // the full width.
      widthLip: 0.375,
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
      // 232 mm, and it wants to be as far forward as it can get: the notch is very
      // nearly `wrapDepth - drainZ`, so every millimetre forward is a millimetre off
      // it (Trap 25). The ceiling is `bowlDepth * sumpFrontFraction - 30 mm`, which
      // is 235 mm here -- 235 itself lands exactly ON the clamp and `buildProfile`
      // then reports the profile as clamped, which is a rejected state even though
      // the geometry is fine. Sitting 3 mm under it is free.
      drainZ: 0.232,
      drainRadius: 0.026,
      // The sump floor runs well forward, which is what makes room for the outlet at
      // 232 mm without it being clamped back. Load-bearing for the notch: the clamp
      // ceiling on drainZ is `bowlDepth * sumpFrontFraction - 30 mm`, so leaving this
      // at the 0.55 default pins the outlet at 161 mm and the notch stays at 120 mm.
      sumpFrontFraction: 0.86,
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
      // A broad rounded base, NOT a long narrow nose. This is a full-size shielded
      // bowl, and the whole class ends in a scalloped bottom edge with a small round
      // trap boss hanging below the centre -- Washbrook, Lynbrook, TOTO UT445U and
      // the Bardon all do. The narrow nose belongs to the compact egg class (Kohler
      // Dexter, Zurn Z5738), which is a different product and a different silhouette,
      // and drawing one on a 470 mm-wide body reads as a funnel on a plinth.
      bottomExtension: 0.142,
      bottomTaper: 0.6,
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
    // Dimensioned against a Pland Bruges TR1500P wall-hung stainless trough:
    // 1500 x 583 x 300 mm, tapering to 150 mm deep at the base, with an exposed
    // 14 mm sparge pipe on four hospital clips inset 35 mm at each end and a 50 mm
    // domed central waste. Mounted at the UK/US-agreed 610 mm from finished floor
    // to the front lip.
    //
    // THE PREVIOUS VERSION WAS THE WRONG SHAPE OF OBJECT, not merely the wrong size.
    // It was 290 mm tall and 419 mm deep -- a wide shallow dish. Every trough
    // actually in production is the other way round: tall and shallow, because the
    // back panel *is* the splashback and the gutter at its foot is only a collector.
    // Measured heights across six manufacturers: Pland Bruges 583, Pland Bremen 593,
    // Delabie 575, Franke Centinel 555, KWC Campus 516, GEC Anderson 431, Acorn
    // Thorn 440. Depths: 220-300. Nothing on the market is 290 x 419.
    //
    // Getting this right fixes three separate complaints at once, which is the usual
    // sign that the dimension rather than the tuning was wrong. The fixture gains
    // 260 mm of back wall to aim at, so the aim band stops falling off a cliff at
    // v = 0.30. It gets shallower, so its own casting stops standing in front of the
    // wall the stream is trying to reach. And the top edge now has a real height
    // difference to ramp across at the end caps instead of 76 mm crammed into eight
    // degrees of the polar fit, which is what drew the V-notches.
    params: P({
      // 460 mm of back panel above the datum. With the sump and the bottom extension
      // under it this is the 583 mm overall the data sheet gives.
      rimHeight: 0.46,
      bowlDepth: 0.25,
      backWallMode: 'planar',
      // Dead vertical. The 5 degrees this used to carry was bought to cancel the
      // wrap's decay and hold the notch at 0 mm, and on a 200 mm back panel it cost
      // 17 mm of lean, which is invisible. On a 460 mm panel the same 5 degrees is a
      // 40 mm overhang, and a trough's back panel is a flat sheet fixed to the wall.
      // The notch is held instead by wrapDecay, which is the lever for a vertical
      // wall -- see the generalisation under outstanding item 0.
      backWallTilt: 0,
      backWallRun: 0,
      // A 1500 mm unit. Pland list 1200/1500/1800/2400/3000; 1500 keeps the
      // multi-user character that makes this card unmistakable in the picker while
      // staying the shortest length nobody would call a single bowl.
      widthRim: 1.44,
      // Sump and lip stay within 60 mm of the rim width: the channel runs the whole
      // length, it does not funnel to a point.
      widthSump: 1.38,
      widthLip: 1.42,
      taperExponent: 1.0,
      // Barely wraps, which is a real part of why troughs spread mess to the floor.
      wrapDepth: 0.05,
      wrapExponent: 3.0,
      // Held open further down, which is what keeps the notch at zero now that the
      // back panel is vertical rather than tilted.
      wrapDecay: 0.6,
      throatHeight: 0.045,
      sumpDepth: 0.03,
      sumpSlope: 0.005,
      sumpFrontFraction: 0.72,
      drainZ: 0.115,
      drainRadius: 0.022,
      // Low front upstand under a tall back panel, which is the trough section:
      // Pland and Willoughby both dimension the depth as tapering from the top of
      // the back panel down to about half that at the base.
      frontLipHeight: 0.1,
      frontLipInturn: 0.0,
      // Top of the back panel. The catalogue mounting figure is 610 mm floor to the
      // *front lip*; the panel stands 360 mm above that.
      rimAboveFloor: 0.97,
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
    // Sparged, not flushed from a valve. A single flushometer over the middle would
    // rinse 150 mm of a 1500 mm channel, and no trough on the market is plumbed that
    // way: the UK and European fixtures this one is dimensioned to all take a
    // perforated pipe along the length, gravity-fed from an auto-siphon cistern
    // above. The US fabricated troughs (Acorn, Willoughby) do use a single valve,
    // but they hide the distribution inside an integral welded channel, so nothing
    // like a flushometer is visible on those either.
    fittings: { flushValve: false, spargePipe: true },
    // 55 degrees, and the reachable band is now 0.02 to 0.76 -- 35 degrees of spread
    // where the old 290 mm-tall trough had almost none and v = 0.30 already read 80.
    // That change is entirely the corrected height: a trough with 460 mm of back
    // panel is a fixture you can actually aim at, which is what the real product is
    // for. The angle falls monotonically from 88 degrees at v = 0.12 down to 52 at
    // 0.52, then breaks up as the trace drops into the throat and across the sump.
    // 0.48 sits on the smooth part with a sweep step of margin either side of it,
    // rather than on the 0.52 minimum, which is two steps from the discontinuity.
    defaultAimV: 0.48,
  },
  {
    id: 'compact-waterless',
    name: 'Compact waterless',
    summary:
      'A broad upright panel with a narrow bowl scooped into its lower half, ' +
      'funnelling to a sealed trap cartridge. No flush, so drainage is gravity alone.',
    expectation:
      'The narrow funnel is the point: it concentrates the flow into a small wetted ' +
      'area and drains it under gravity alone, which it has to do — there is no ' +
      'flush to rinse this fixture and anything left behind concentrates. Splashback ' +
      'is not what this shape is optimised for, and the tight converging walls meet a ' +
      'descending stream closer to normal than a wide bowl does.',
    // Dimensioned against a Falcon Waterfree F-4000, sold identically as the Sloan
    // WES-4000: 391 x 356 x 575 mm (15-3/8 x 14 x 22-5/8 in), 35 lb. Rim 610 mm
    // above finished floor for a standard install, 432 mm for ADA. The side
    // elevation is dimensioned as a wedge -- 50 mm deep at the top, the full 356 mm
    // at the rim, tapering to 150 mm at the base -- with 240 mm of fixture below the
    // rim and a 58 mm lip band.
    //
    // THE OLD VERSION HAD ITS AXES TRANSPOSED, and that is the whole story of this
    // preset. It was dimensioned "362 x 497 x 681 against a 365 x 498 x 679
    // nominal", with the comment "the depth is the striking figure -- this fixture
    // projects half again as far from the wall as a conventional bowl". Sloan's data
    // sheet for the WES-1000 prints `14.375" x 19.625" x 26.75" (365 x 498 x 679mm)`
    // with NO AXIS LABELS. Falcon publish the identical fixture with the order
    // spelled out: `NOMINAL DIMENSIONS (W x H x D) 19.375 x 25.875 x 14.375 inches
    // (492 x 657 x 366 mm)`. So 498 is the WIDTH and 366 is the depth -- the fixture
    // is broad and upright, not deep and narrow, and it was modelled 140 mm too deep
    // and 130 mm too narrow.
    //
    // There is a physical check on this that no catalogue can contradict: ADA 605.2
    // requires at least 343 mm of rim projection, and every compliant waterless unit
    // sits just above it. 356-397 mm across Falcon, Sloan, Zurn and Kohler. Nothing
    // is anywhere near 497.
    //
    // The depth error was not cosmetic. A 497 mm bowl puts its own rim so far in
    // front of the back wall that the casting blocked every aim past v = 0.15, which
    // is Trap 44 -- the fixture could not be aimed into, and its stated default was
    // inside the blocked band. Correcting the depth is what reopens it.
    params: P({
      // 335 mm of back panel above the front lip, which with 240 mm of fixture below
      // the lip gives the 575 mm overall.
      rimHeight: 0.485,
      bowlDepth: 0.32,
      backWallMode: 'concave',
      // Modest. The front face of a waterless unit is essentially vertical and the
      // maximum projection is reached low, near the bottom of the bowl -- so the
      // back wall sweeps forward gently rather than leaning out over the user.
      // Measured cost of curving it harder: at 0.085 the impingement angle across
      // the reachable band is 72-62 degrees, at 0.05 it is 70-56. A concave wall
      // tilts its own lower face up into a descending stream, which is the mechanism
      // classic-bowl's expectation text describes, and this fixture has no depth to
      // spare for it.
      backWallRun: 0.05,
      widthRim: 0.349,
      // The most aggressive funnel in the library, and it has to be: there is no
      // flush to rinse this fixture, so gravity does all of it. drainRadius stays at
      // 0.02, already the smallest here -- shrinking it further would throttle the
      // one thing this model is supposed to win on.
      widthSump: 0.08,
      // Trap 9: within 0.85-0.9 of the rim width. A waterless bowl is narrow at the
      // sump, not at the mouth.
      widthLip: 0.285,
      taperExponent: 2.6,
      wrapDepth: 0.165,
      wrapExponent: 2.8,
      wrapDecay: 0.85,
      throatHeight: 0.05,
      // A deep bowl. Zurn dimension the Z5795's drop from the front rim to the drain
      // centreline at about 200 mm, and this family is all built the same way -- the
      // cartridge sits well down inside the fixture, not just under the lip. With the
      // lip at 150 mm above the datum this puts the drain 220 mm below it.
      sumpDepth: 0.07,
      sumpSlope: 0.3,
      // Forward of centre under the funnel, which is what holds the notch down --
      // the side edge of the opening bottoms out at the profile's own depth at the
      // drain. See Trap 25.
      drainZ: 0.185,
      drainRadius: 0.02,
      // A real front wall, not a ramp. At 100 mm the rise climbed 140 mm over 134 mm
      // of depth -- a 45-degree shelf, which renders as a wide flat tray across the
      // front of the fixture and is nothing like the product. At 150 mm over a foot
      // pushed forward to 0.72 of the depth it is a 70-degree wall.
      frontLipHeight: 0.15,
      frontLipInturn: 0.022,
      // The 356 -> 150 mm wedge the side elevation dimensions. Pinning this near 1.0
      // would make the front face vertical and the body a rounded box (Trap 4).
      sumpFrontFraction: 0.72,
      // MOUNTED AT THE ACCESSIBLE HEIGHT, and this is a real design finding rather
      // than a convenience. Falcon publish two installs for this fixture: a 610 mm
      // lip for a standard adult install and a 432 mm lip for ADA. At 610 the
      // fixture's entire wetted back wall stands above the stream's own exit point,
      // so every reachable aim is a near-normal strike -- measured 89, 87, 85, 80
      // degrees walking down the wall, which is the worst angle available and the
      // sort of default Trap 44 exists to stop shipping. At the ADA 432 the same
      // geometry reads 70, 65, 60, 56. Nothing about the fixture changed; the
      // stream simply arrives descending instead of level.
      //
      // 0.767 = 432 mm to the front lip plus the 335 mm of back panel above it. It
      // is the only preset in the library on the accessible mounting, which is worth
      // knowing when comparing it with the others.
      rimAboveFloor: 0.767,
    }),
    shell: {
      // Squarish in plan with generously rounded corners, which is what the top view
      // of every unit in this family shows -- a rounded trapezoid, not an oval. One
      // pass rounds the corners without relaxing the section into a pod.
      sectionSmoothing: 1,
      bulge: 0.0,
      clearance: 0.01,
      wallThickness: 0.022,
      // Thin and crisp, 20-30 mm of ceramic following the outer body edge. There is
      // no hollow flushing rim on a waterless fixture, so it must not carry a washout
      // urinal's heavy rolled flange -- the absence is visible in every photograph.
      rimThickness: 0.021,
      rimBandWidth: 0.03,
      // Runs essentially straight down to a stepped-in skirt over the cartridge.
      // This body does NOT draw into a narrow nose the way a wall-hung china bowl
      // does, and that is the single biggest departure from a conventional urinal.
      backSetback: 0.016,
      bottomExtension: 0.02,
      bottomTaper: 0.66,
    },
    // No flush valve, and this is the whole point of the product rather than a
    // detail: a sealed cartridge in the outlet forms the trap, so there is no water
    // supply and no flushometer. The outlet spud stays, because the cartridge does
    // connect to a waste pipe.
    fittings: { flushValve: false },
    // 56 degrees, on a band that is now reachable from v = 0.02 all the way to 0.50.
    //
    // The old preset could be aimed into only as far as v = 0.15 before its own
    // casting blocked the stream, and its stated default of 0.26 was inside the
    // blocked band -- so every run ever done of this model at its own default was a
    // rim strike reported as nominal behaviour (Trap 44). The cause was the
    // transposed depth: a 497 mm bowl stands its rim so far forward that it shadows
    // the wall behind it. At the true 356 mm the shadow is gone, and the band goes
    // from 13 sample points wide to 25.
    //
    // 0.34 rather than the shallowest reachable 0.42: the casting blocks everything
    // from 0.44 on, and an aim one sweep step from a blocked one is a graze that
    // reports a flattering angle for the worst possible reason (Trap 45). 0.34 is
    // two clear sweep steps back and costs three degrees. Deepening the bowl moved
    // this boundary once already -- it was 0.52 before the sump went to 70 mm -- so
    // re-run `tools/aimcheck.mts` after any change to this preset's profile.
    defaultAimV: 0.34,
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
