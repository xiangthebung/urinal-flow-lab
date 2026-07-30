import { CRITICAL_IMPINGEMENT_ANGLE, GRAVITY } from '../core/constants';

/**
 * The sagittal (side-view) profile of the urinal.
 *
 * Coordinates here are 2-D: `z` is depth, positive toward the user, `y` is
 * height. The datum (0, 0) sits where the back wall plane meets the top of the
 * sump, on the centreline. The profile is one continuous strip traversed from
 * the top of the back wall, down through the throat, across the sump, up the
 * front rise and over the front lip. Every surface the liquid can touch is on
 * this strip, which is what lets the film solver work on a single 2-D grid.
 *
 * Construction is anchor-driven: a handful of key points are computed directly
 * from the designer's dimensions, then joined by tangent-continuous blends.
 * The alternative -- walking a turtle forward through a chain of arcs -- reads
 * more naturally but is badly conditioned. Each arc's endpoint depends on every
 * arc before it, so a large back-wall radius eats the depth budget and leaves
 * the sump unreachable, and a fillet asked to reach an impossible target either
 * loops or silently gives up. Pinning the anchors first means the stated
 * dimensions are always honoured and an awkward parameter set degrades into a
 * slightly odd but valid shape instead of a self-intersecting one.
 */

export interface P2 {
  z: number;
  y: number;
}

export interface Profile {
  /** Points ordered from the top of the back wall to the tip of the front lip. */
  points: P2[];
  /** Cumulative arclength at each point, m. Last entry is the total. */
  arclength: number[];
  /** Total arclength, m. */
  length: number;
  /** Diagnostics surfaced to the designer. */
  info: ProfileInfo;
}

export interface ProfileInfo {
  /** Equivalent sagittal radius of the back wall, m. Infinity when planar. */
  backWallRadius: number;
  /** Where the back wall ends and the throat blend begins. */
  throatStart: P2;
  /** Lowest point, at the drain. */
  sumpLow: P2;
  /** Front lip tip. */
  lipTip: P2;
  /** Height the top of the wall actually reached, m. */
  actualRimHeight: number;
  /**
   * Mean angle the constantAngle generator actually held, radians. NaN for the
   * other modes. Reported because the ballistic correction and the depth clamp
   * both pull the result away from the requested value, and a designer needs to
   * know when the shape stopped honouring its own premise.
   */
  achievedAngle: number;
  /** True if any parameter had to be clamped to keep the shape valid. */
  clamped: boolean;
  /**
   * True if the profile crosses itself. An unmanufacturable shape, and it also
   * breaks the surface parameterisation, so it is detected rather than left to
   * produce quietly wrong physics downstream.
   */
  selfIntersects: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Curve primitives
// ---------------------------------------------------------------------------

const norm2 = (z: number, y: number): P2 => {
  const m = Math.hypot(z, y) || 1;
  return { z: z / m, y: y / m };
};

/**
 * Cubic Hermite blend between two anchors with prescribed unit tangents.
 *
 * Tangent magnitude is set to `tension` times the chord length, which is the
 * standard way to get a curve that leans into its end directions without
 * looping. Values near 1 look like a drafting spline; smaller values pull the
 * curve toward the straight chord.
 */
function hermite(
  p0: P2,
  d0: P2,
  p1: P2,
  d1: P2,
  samples: number,
  tension = 0.9
): P2[] {
  const chord = Math.hypot(p1.z - p0.z, p1.y - p0.y);
  const m = chord * tension;
  const out: P2[] = [];
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    out.push({
      z: h00 * p0.z + h10 * m * d0.z + h01 * p1.z + h11 * m * d1.z,
      y: h00 * p0.y + h10 * m * d0.y + h01 * p1.y + h11 * m * d1.y,
    });
  }
  return out;
}

/**
 * Circular arc from p0 to p1 whose tangent at p0 is straight down.
 *
 * Solved in closed form: a circle tangent to the vertical at p0 has its centre
 * level with p0, so requiring it to pass through p1 fixes the radius uniquely
 * as zc = (dz^2 + dy^2) / (2 dz). This is how the concave back wall is built --
 * the designer states how far forward the base of the wall sits and the radius
 * follows, rather than stating a radius and discovering where it lands.
 */
function arcFromVerticalStart(
  p0: P2,
  p1: P2,
  samples: number
): { pts: P2[]; radius: number; endTangent: P2 } {
  const dz = p1.z - p0.z;
  const dy = p1.y - p0.y;
  if (Math.abs(dz) < 1e-6) {
    // Degenerate: a straight vertical drop.
    const pts: P2[] = [];
    for (let i = 1; i <= samples; i++) pts.push({ z: p0.z, y: p0.y + (dy * i) / samples });
    return { pts, radius: Infinity, endTangent: { z: 0, y: Math.sign(dy) || -1 } };
  }
  const zc = (dz * dz + dy * dy) / (2 * dz);
  const R = Math.abs(zc);
  const cz = p0.z + zc;
  const cy = p0.y;
  const a0 = Math.atan2(p0.y - cy, p0.z - cz);
  let a1 = Math.atan2(p1.y - cy, p1.z - cz);
  // Choose the sweep that descends, staying on the short side.
  let d = a1 - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  a1 = a0 + d;
  const pts: P2[] = [];
  for (let i = 1; i <= samples; i++) {
    const a = a0 + (d * i) / samples;
    pts.push({ z: cz + R * Math.cos(a), y: cy + R * Math.sin(a) });
  }
  // Tangent is perpendicular to the radius, in the direction of travel.
  const s = Math.sign(d) || 1;
  const endTangent = norm2(-s * Math.sin(a1), s * Math.cos(a1));
  return { pts, radius: R, endTangent };
}

/** Quarter-ish arc curling the front lip back over the bowl. */
function lipCurl(p0: P2, radius: number, samples: number): P2[] {
  // Starts heading straight up, ends heading back toward -z.
  const cz = p0.z - radius;
  const cy = p0.y;
  const pts: P2[] = [];
  for (let i = 1; i <= samples; i++) {
    const a = (i / samples) * (Math.PI * 0.55);
    pts.push({ z: cz + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Constant-impingement-angle wall generator
// ---------------------------------------------------------------------------

/**
 * Direction of a ballistic stream at the moment it arrives at `target`, when
 * launched from `origin` at `speed`. Null when the target is out of range.
 *
 * Two launch angles reach any reachable point; the flatter one is taken,
 * because that is how a person actually aims at a urinal.
 */
export function ballisticArrivalDirection(
  origin: P2,
  speed: number,
  target: P2,
  gravity = GRAVITY
): P2 | null {
  // The launch-angle formula is written for a target down-range of the origin,
  // so it needs an unsigned horizontal distance. A urinal wall sits *behind*
  // the stream exit in z, so feeding it a negative range silently selects the
  // wrong root and reports the stream arriving upward instead of downward.
  const dz = target.z - origin.z;
  const horiz = Math.abs(dz);
  const horizSign = Math.sign(dz) || 1;
  const dy = target.y - origin.y;
  if (horiz < 1e-6) return dy < 0 ? { z: 0, y: -1 } : null;

  const v2 = speed * speed;
  const disc = v2 * v2 - gravity * (gravity * horiz * horiz + 2 * dy * v2);
  if (disc < 0) return null;
  // Minus root: the flatter of the two trajectories, which is how a person
  // actually aims at a urinal.
  const theta = Math.atan((v2 - Math.sqrt(disc)) / (gravity * horiz));
  const cos = Math.cos(theta);
  if (Math.abs(cos) < 1e-9) return null;
  const t = horiz / (speed * cos);
  const vz = speed * cos * horizSign;
  const vy = speed * Math.sin(theta) - gravity * t;
  return norm2(vz, vy);
}

/**
 * Which of the two constant-angle surfaces to follow.
 *
 * Through any point there are two wall orientations that meet the arriving
 * stream at the same angle, so the condition alone does not pick a shape.
 *  - 'tall'  keeps the wall close to vertical: a slim, deep fixture the film
 *            runs straight down. Drains best, fits a normal envelope.
 *  - 'scoop' sweeps the wall forward into a horn opening toward the user.
 *            Spreads the stream over more area but leaves gravity with less
 *            purchase along the surface, so drainage is slower.
 */
export type SpiralBranch = 'tall' | 'scoop';

export interface ConstantAngleOptions {
  /** Stream exit point in the sagittal plane, m. */
  origin: P2;
  /** Stream exit speed, m/s. 0 ignores gravity, giving a pure log spiral. */
  speed: number;
  /** Target angle between arriving stream and wall, radians. */
  angle: number;
  /** First point on the wall. */
  start: P2;
  /** Stop once y passes this height. */
  stopY: number;
  /** Stop once z passes this depth. */
  stopZ: number;
  /**
   * Integration sense. The wall is integrated *upward* from the throat, then
   * reversed by the caller. Marching up rather than down is what keeps the
   * shape anchored where it has to connect: with the stream arriving from above
   * and in front, a low-angle wall necessarily recedes away from the user as it
   * descends, so integrating downward from a fixed rim drifts the bottom of the
   * wall to an arbitrary depth and it no longer meets the sump. Starting at the
   * throat pins the end that matters and lets the rim land where the geometry
   * dictates.
   */
  marchUp: boolean;
  branch: SpiralBranch;
  /** Integration step, m. */
  step?: number;
  /** Hard cap on steps. */
  maxSteps?: number;
}

/**
 * Integrate the wall shape that meets the incoming stream at a constant angle
 * everywhere.
 *
 * This is the generator behind the splash-free geometries in the PNAS 2025
 * work. The condition is simply
 *
 *     angle( wall tangent, arriving stream direction ) = alpha
 *
 * With gravity off the arriving stream is a straight ray from a fixed pole, and
 * the curve cutting every ray of a pencil at a constant angle is exactly a
 * logarithmic spiral -- which is why the published shape looks like a nautilus
 * shell. Turning gravity on makes the arriving rays parabolic, so the true
 * constant-angle curve departs from the ideal spiral; integrating the real
 * trajectory gives a wall that holds its angle for a real user rather than an
 * idealised one.
 *
 * Holding alpha below the ~30 deg critical angle across the whole surface means
 * no part of the wall is ever struck steeply enough to throw a corona. That is
 * the entire mechanism, and it is why these shapes work without any coating or
 * insert.
 */
export function integrateConstantAngleWall(opts: ConstantAngleOptions): {
  pts: P2[];
  endTangent: P2;
  achievedAngle: number;
} {
  const step = opts.step ?? 0.002;
  const maxSteps = opts.maxSteps ?? 4000;
  const pts: P2[] = [{ ...opts.start }];
  let p = { ...opts.start };
  let tangent: P2 = { z: 0, y: opts.marchUp ? 1 : -1 };
  const sign = opts.marchUp ? 1 : -1;
  let angleSum = 0;
  let angleN = 0;

  const ca = Math.cos(opts.angle);
  const sa = Math.sin(opts.angle);

  for (let i = 0; i < maxSteps; i++) {
    const dz = p.z - opts.origin.z;
    const dy = p.y - opts.origin.y;
    const straight = norm2(dz, dy);
    let d: P2 | null = null;
    if (opts.speed > 1e-6) d = ballisticArrivalDirection(opts.origin, opts.speed, p);
    // Outside the ballistic envelope, fall back to the straight ray so the wall
    // keeps developing rather than terminating mid-surface.
    if (!d) d = straight;

    // The two rotations of the arrival direction that sit at alpha to it. Both
    // describe a valid surface, since a surface has no preferred tangent sense.
    const r1 = norm2(d.z * ca - d.y * sa, d.z * sa + d.y * ca);
    const r2 = norm2(d.z * ca + d.y * sa, -d.z * sa + d.y * ca);

    // Orient both to march in the requested sense, then pick the branch.
    const o1 = r1.y * sign >= 0 ? r1 : { z: -r1.z, y: -r1.y };
    const o2 = r2.y * sign >= 0 ? r2 : { z: -r2.z, y: -r2.y };
    // 'tall' hugs the vertical (larger |y| component); 'scoop' opens forward.
    const pickFirst =
      opts.branch === 'tall' ? Math.abs(o1.y) >= Math.abs(o2.y) : Math.abs(o1.z) >= Math.abs(o2.z);
    let t = pickFirst ? o1 : o2;

    // Guard against a stalled march if the rotation degenerates.
    if (Math.abs(t.y) < 1e-4) t = { z: t.z, y: sign * 1e-3 };
    tangent = norm2(t.z, t.y);

    // Record how well the condition is actually being met.
    const cosBetween = Math.abs(tangent.z * d.z + tangent.y * d.y);
    angleSum += Math.acos(Math.min(1, cosBetween));
    angleN++;

    p = { z: p.z + tangent.z * step, y: p.y + tangent.y * step };
    pts.push({ ...p });

    if (opts.marchUp) {
      if (p.y >= opts.stopY || p.z >= opts.stopZ) break;
    } else if (p.y <= opts.stopY || p.z >= opts.stopZ) break;
    if (p.z < -0.001) break; // never cut behind the mounting plane
  }
  return {
    pts,
    endTangent: tangent,
    achievedAngle: angleN > 0 ? angleSum / angleN : opts.angle,
  };
}

// ---------------------------------------------------------------------------
// Profile assembly
// ---------------------------------------------------------------------------

export type BackWallMode = 'planar' | 'concave' | 'constantAngle';

export interface ProfileParams {
  /**
   * Height of the top rim above the datum, m. For planar and concave walls this
   * is exact. For constantAngle it is an upper bound: the angle condition
   * decides how tall the wall actually gets, and the achieved value comes back
   * in ProfileInfo.actualRimHeight.
   */
  rimHeight: number;
  /** Depth of the bowl, datum plane to the deepest point of the lip, m. */
  bowlDepth: number;
  backWallMode: BackWallMode;
  /** Which constant-angle surface to follow. */
  spiralBranch: SpiralBranch;
  /** Tilt of a planar back wall from vertical, radians. + leans toward user. */
  backWallTilt: number;
  /**
   * How far forward the base of a concave back wall sits, m. Stated as a run
   * rather than a radius so it can never exceed the depth budget; the
   * equivalent radius is reported back in ProfileInfo.
   */
  backWallRun: number;
  /** Target impingement angle for constantAngle mode, radians. */
  targetImpingementAngle: number;
  /** Stream exit point used by the constantAngle generator, m. */
  streamOrigin: P2;
  /** Stream exit speed used by the constantAngle generator, m/s. */
  streamSpeed: number;
  /** Height at which the back wall hands over to the throat blend, m. */
  throatHeight: number;
  /** Depth of the sump floor below the datum, m. */
  sumpDepth: number;
  /** Rise of the sump floor from the drain toward the front, radians. */
  sumpSlope: number;
  /** Depth of the drain centre from the back wall plane, m. */
  drainZ: number;
  /** Height of the front lip above the datum, m. */
  frontLipHeight: number;
  /** Radius of the inward curl at the front lip, m. 0 disables it. */
  frontLipInturn: number;
  /**
   * Where the sump floor ends and the front rise begins, as a fraction of the bowl
   * depth.
   *
   * This decides the single most recognisable line on the fixture. It used to be
   * pinned at the bowl depth less the lip curl less 20 mm, which puts the foot of
   * the rise almost directly under the lip and makes the front wall of the bowl
   * vertical -- so the casting is a slab of constant depth from the floor to the
   * lip, and the fixture reads as a rounded box however the outside is built. Real
   * sanitaryware sweeps the front down and back, leaving the base far shallower than
   * the rim, and that undercut is most of the silhouette. Around 0.5 gives it; 1.0
   * reproduces the old vertical front.
   */
  sumpFrontFraction: number;
  /** Forward overhang of the top hood, m. 0 disables it. */
  hoodDepth: number;
}

/** Sample counts per segment, chosen so spacing lands near 1.5 mm. */
const SAMPLES = {
  hood: 14,
  wall: 90,
  throat: 40,
  sump: 30,
  rise: 50,
  lip: 16,
};

export function buildProfile(pIn: ProfileParams): Profile {
  const notes: string[] = [];
  let clamped = false;
  const clamp = (v: number, lo: number, hi: number, what: string): number => {
    if (v < lo || v > hi) {
      clamped = true;
      notes.push(`${what} clamped to [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
    }
    return Math.min(hi, Math.max(lo, v));
  };

  const p = { ...pIn };
  p.bowlDepth = Math.max(0.10, p.bowlDepth);
  p.rimHeight = Math.max(0.12, p.rimHeight);
  p.sumpDepth = clamp(p.sumpDepth, 0.0, p.rimHeight * 0.5, 'sumpDepth');
  p.throatHeight = clamp(p.throatHeight, -p.sumpDepth + 0.01, p.rimHeight * 0.6, 'throatHeight');
  p.frontLipInturn = clamp(p.frontLipInturn, 0, p.bowlDepth * 0.25, 'frontLipInturn');
  p.frontLipHeight = clamp(
    p.frontLipHeight,
    -p.sumpDepth + 0.03,
    p.rimHeight,
    'frontLipHeight'
  );

  // Foot of the front rise. Stated as a fraction of the depth so the front can
  // lean back and give the fixture an undercut; the clamp only keeps it clear of
  // the drain behind it and the lip curl in front of it.
  const frontFrac = clamp(p.sumpFrontFraction, 0.25, 1.0, 'sumpFrontFraction');
  const zSumpFront = clamp(
    p.bowlDepth * frontFrac,
    0.05,
    p.bowlDepth - Math.max(0.02, p.frontLipInturn) - 0.005,
    'front rise position'
  );
  // Drain must sit behind the front rise foot and ahead of the back wall.
  p.drainZ = clamp(p.drainZ, 0.02, zSumpFront - 0.03, 'drainZ');

  const pts: P2[] = [];
  const push = (arr: P2[]) => {
    for (const q of arr) pts.push(q);
  };

  // -- Lower anchors, fixed by the stated dimensions ------------------------
  const C: P2 = { z: p.drainZ, y: -p.sumpDepth };
  const sumpRise = (zSumpFront - p.drainZ) * Math.tan(p.sumpSlope);
  const D: P2 = { z: zSumpFront, y: -p.sumpDepth + sumpRise };
  const lipR = Math.max(0.0, p.frontLipInturn);
  const E: P2 = { z: p.bowlDepth, y: p.frontLipHeight - lipR };

  // Depth budget: the wall must not eat the space the sump needs.
  const maxWallRun = Math.max(0.005, p.drainZ * 0.75);

  // -- Back wall -----------------------------------------------------------
  // Generated first, because in constantAngle mode the angle condition decides
  // where the top of the wall lands; the rim is an output, not an input.
  const B: P2 = { z: 0, y: p.throatHeight };
  const A: P2 = { z: 0, y: p.rimHeight };
  let wallPts: P2[] = [];
  let wallStartTangent: P2 = norm2(Math.sin(p.backWallTilt), -Math.cos(p.backWallTilt));
  let wallEndTangent: P2 = wallStartTangent;
  let backWallRadius = Infinity;
  let achievedAngle = Number.NaN;

  switch (p.backWallMode) {
    case 'planar': {
      const run = clamp(
        (p.rimHeight - p.throatHeight) * Math.tan(p.backWallTilt),
        -maxWallRun,
        maxWallRun,
        'back wall tilt run'
      );
      B.z = run;
      const n = SAMPLES.wall;
      for (let i = 1; i <= n; i++) {
        wallPts.push({
          z: A.z + ((B.z - A.z) * i) / n,
          y: A.y + ((B.y - A.y) * i) / n,
        });
      }
      wallEndTangent = norm2(B.z - A.z, B.y - A.y);
      wallStartTangent = wallEndTangent;
      break;
    }
    case 'concave': {
      const run = clamp(p.backWallRun, 0.0, maxWallRun, 'backWallRun');
      B.z = run;
      const arc = arcFromVerticalStart(A, B, SAMPLES.wall);
      wallPts = arc.pts;
      wallEndTangent = arc.endTangent;
      wallStartTangent = { z: 0, y: -1 };
      backWallRadius = arc.radius;
      break;
    }
    case 'constantAngle': {
      // Integrated upward from the throat, then reversed. See the note on
      // ConstantAngleOptions.marchUp for why the throat is the fixed end.
      const footZ = Math.min(maxWallRun * 0.5, 0.02);
      const res = integrateConstantAngleWall({
        origin: p.streamOrigin,
        speed: p.streamSpeed,
        angle: p.targetImpingementAngle,
        start: { z: footZ, y: p.throatHeight },
        stopY: p.rimHeight,
        stopZ: p.bowlDepth * 0.92,
        marchUp: true,
        branch: p.spiralBranch,
        step: 0.002,
      });
      const up = res.pts;
      const top = up[up.length - 1];
      const down = up.slice().reverse();
      A.z = top.z;
      A.y = top.y;
      B.z = footZ;
      B.y = p.throatHeight;
      wallPts = down.slice(1);
      wallStartTangent = norm2(down[1].z - down[0].z, down[1].y - down[0].y);
      const a = down[down.length - 2] ?? down[down.length - 1];
      const bEnd = down[down.length - 1];
      wallEndTangent = norm2(bEnd.z - a.z, bEnd.y - a.y);
      achievedAngle = res.achievedAngle;
      if (top.y < p.rimHeight - 0.01) {
        notes.push(
          `constant-angle wall stopped at y=${top.y.toFixed(3)} m (depth budget), short of ` +
            `the requested rim ${p.rimHeight.toFixed(3)} m — raise bowlDepth or the target angle`
        );
      }
      break;
    }
  }

  // -- Top hood ------------------------------------------------------------
  // A forward-and-down curl above the wall, there to intercept droplets that
  // would otherwise clear the rim. It is a wetted surface, so it belongs in the
  // parameterisation rather than being treated as decoration.
  if (p.hoodDepth > 1e-4) {
    const hoodTip: P2 = { z: A.z + p.hoodDepth, y: A.y + p.hoodDepth * 0.4 };
    pts.push(hoodTip);
    push(hermite(hoodTip, { z: -1, y: 0.15 }, A, wallStartTangent, SAMPLES.hood, 0.8));
  } else {
    pts.push(A);
  }
  push(wallPts);

  // -- Throat blend: back wall -> drain low point ---------------------------
  // The tangent at C must be horizontal because C is the profile's minimum.
  const horizontal: P2 = { z: 1, y: 0 };
  push(hermite(B, wallEndTangent, C, horizontal, SAMPLES.throat, 0.85));

  // -- Sump floor: drain -> front rise foot --------------------------------
  // Graded away from the outlet in both directions so the low point is exactly
  // at the drain. A flat sump is the classic accumulation failure: with no
  // gradient the residual film has nothing driving it anywhere and simply sits
  // there until it evaporates into scale.
  const slopeDir = norm2(Math.cos(p.sumpSlope), Math.sin(p.sumpSlope));
  push(hermite(C, horizontal, D, slopeDir, SAMPLES.sump, 0.8));

  // -- Front rise ----------------------------------------------------------
  push(hermite(D, slopeDir, E, { z: 0, y: 1 }, SAMPLES.rise, 0.85));

  // -- Front lip curl ------------------------------------------------------
  // Curling the lip back over the bowl gives a second interception surface for
  // shallow droplets heading toward the user's shoes.
  if (lipR > 1e-4) push(lipCurl(E, lipR, SAMPLES.lip));

  const selfIntersects = detectSelfIntersection(pts);
  if (selfIntersects) {
    notes.push(
      'profile self-intersects — the wall overhangs far enough to cross the front rise; ' +
        'lower frontLipHeight or reduce the wall overhang'
    );
  }

  return finishProfile(pts, {
    backWallRadius,
    throatStart: B,
    sumpLow: C,
    lipTip: pts[pts.length - 1],
    actualRimHeight: A.y,
    achievedAngle,
    clamped,
    selfIntersects,
    notes,
  });
}

/**
 * Brute-force segment-pair intersection test, skipping neighbours.
 *
 * O(n^2) on a few hundred points, run only when the geometry changes, so the
 * simplicity is worth more than the speed here.
 */
function detectSelfIntersection(pts: P2[]): boolean {
  const skip = 4;
  for (let i = 0; i + 1 < pts.length; i++) {
    for (let j = i + skip; j + 1 < pts.length; j++) {
      if (segmentsCross(pts[i], pts[i + 1], pts[j], pts[j + 1])) return true;
    }
  }
  return false;
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const cr = (o: P2, p: P2, q: P2) =>
    (p.z - o.z) * (q.y - o.y) - (p.y - o.y) * (q.z - o.z);
  const d1 = cr(a, b, c);
  const d2 = cr(a, b, d);
  const d3 = cr(c, d, a);
  const d4 = cr(c, d, b);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function finishProfile(rawPts: P2[], info: ProfileInfo): Profile {
  const points = dedupe(rawPts);
  const arclength = new Array<number>(points.length);
  arclength[0] = 0;
  for (let i = 1; i < points.length; i++) {
    arclength[i] =
      arclength[i - 1] +
      Math.hypot(points[i].z - points[i - 1].z, points[i].y - points[i - 1].y);
  }
  return { points, arclength, length: arclength[arclength.length - 1], info };
}

function dedupe(pts: P2[]): P2[] {
  const out: P2[] = [];
  for (const p of pts) {
    if (!Number.isFinite(p.z) || !Number.isFinite(p.y)) continue;
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.z - last.z, p.y - last.y) > 1e-7) out.push(p);
  }
  return out;
}

/**
 * Resample to `n` points equally spaced in arclength.
 *
 * Uniform arclength spacing is what keeps the film grid well conditioned:
 * cells are the same physical size all along v, so the stability limit is set
 * by one number rather than by whichever cell happens to be thinnest.
 */
export function resampleByArclength(profile: Profile, n: number): Profile {
  const { points, arclength, length } = profile;
  if (points.length < 2 || length <= 0) return profile;
  const out: P2[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * length;
    while (j < arclength.length - 2 && arclength[j + 1] < target) j++;
    const segLen = arclength[j + 1] - arclength[j];
    const tt = segLen > 1e-12 ? (target - arclength[j]) / segLen : 0;
    out.push({
      z: points[j].z + (points[j + 1].z - points[j].z) * tt,
      y: points[j].y + (points[j + 1].y - points[j].y) * tt,
    });
  }
  return finishProfile(out, profile.info);
}

/** Unit tangent along the profile at sample index i, pointing toward +v. */
export function profileTangent(profile: Profile, i: number): P2 {
  const pts = profile.points;
  const a = Math.max(0, i - 1);
  const b = Math.min(pts.length - 1, i + 1);
  return norm2(pts[b].z - pts[a].z, pts[b].y - pts[a].y);
}

/**
 * Inward normal of the profile at sample i: the tangent rotated a quarter turn
 * counter-clockwise. Descending the back wall the tangent points down and this
 * gives +z, toward the user; on the sump floor the tangent points forward and
 * it gives +y, up out of the basin; on the front rise it gives -z, back into
 * the bowl. So a single rotation orients the whole traversal correctly, which
 * is what the surface builder relies on to face its normals into the bowl.
 */
export function profileInwardNormal(profile: Profile, i: number): P2 {
  const t = profileTangent(profile, i);
  return { z: -t.y, y: t.z };
}

/** Default profile parameters: a conventional mid-market wall-hung urinal. */
export function defaultProfileParams(): ProfileParams {
  return {
    rimHeight: 0.42,
    bowlDepth: 0.30,
    backWallMode: 'concave',
    spiralBranch: 'tall',
    backWallTilt: 0.0,
    backWallRun: 0.045,
    targetImpingementAngle: CRITICAL_IMPINGEMENT_ANGLE,
    streamOrigin: { z: 0.40, y: 0.52 },
    streamSpeed: 3.0,
    throatHeight: 0.06,
    sumpDepth: 0.025,
    sumpSlope: 0.10,
    drainZ: 0.10,
    frontLipHeight: 0.30,
    frontLipInturn: 0.022,
    sumpFrontFraction: 0.55,
    hoodDepth: 0,
  };
}
