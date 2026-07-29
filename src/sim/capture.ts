import { Vec3, v3 } from '../core/vec3';
import { CaptureTester } from './particles';
import { UrinalSurface } from '../geometry/surface';

/**
 * Everything that is not the fixture: the floor, and the person standing at it.
 *
 * The point of modelling the user explicitly is that "splashback" is not a
 * property of a urinal on its own -- it is a count of how much liquid lands on
 * somebody. A design that throws a fine mist straight up scores better than one
 * that throws a few large drops forward at shin height, even if the second one
 * ejects less total mass. So the geometry below is deliberately anatomical: the
 * zones are shoes, shins and trousers, because those are the outcomes a designer
 * is actually judged on.
 */

export const enum CaptureZone {
  FloorNear = 0,
  FloorFar = 1,
  Shoe = 2,
  Shin = 3,
  Thigh = 4,
  FixtureExterior = 5,
  Count = 6,
}

export const ZONE_NAMES = [
  'floor (near)',
  'floor (far)',
  'shoes',
  'shins',
  'trousers',
  'fixture exterior',
];

/** An axis-aligned rectangle that absorbs droplets crossing it. */
interface CaptureRect {
  zone: CaptureZone;
  /** Axis the plane is perpendicular to: 0 = x, 1 = y, 2 = z. */
  axis: 0 | 1 | 2;
  coord: number;
  /** Bounds on the two in-plane axes, in ascending axis order. */
  aMin: number;
  aMax: number;
  bMin: number;
  bMax: number;
  /** Crossing direction that counts: +1, -1, or 0 for either. */
  dir: number;
}

export interface UserPosture {
  /** Height of the exit above the floor, m. */
  emitterHeight: number;
  /** Horizontal gap from the fixture's front-most point, m. */
  standoff: number;
  /** Lateral offset of the user from the centreline, m. */
  lateralOffset: number;
  /** How far the legs sit behind the exit, m. */
  legSetback: number;
  /** Shoe length and width, m. */
  shoeLength: number;
  shoeWidth: number;
  /** Lateral spacing between shoe centres, m. */
  stanceWidth: number;
  /** Top of the shin zone above the floor, m. */
  shinTop: number;
  /** Top of the trouser zone above the floor, m. */
  thighTop: number;
  /** Half-width of the body zones, m. */
  bodyHalfWidth: number;
}

export function defaultPosture(): UserPosture {
  return {
    emitterHeight: 0.78,
    standoff: 0.12,
    lateralOffset: 0,
    legSetback: 0.05,
    shoeLength: 0.28,
    shoeWidth: 0.1,
    stanceWidth: 0.18,
    shinTop: 0.5,
    thighTop: 0.95,
    bodyHalfWidth: 0.22,
  };
}

export interface CaptureHit {
  t: number;
  zone: number;
}

export class CaptureScene implements CaptureTester {
  private rects: CaptureRect[] = [];
  readonly floorY: number;
  readonly fixtureFrontZ: number;
  readonly posture: UserPosture;
  /** z of the plane the legs occupy. */
  readonly legZ: number;
  /** Boundary between "near" and "far" floor, m from the fixture. */
  readonly nearFloorDepth = 0.6;

  constructor(surface: UrinalSurface, posture: UserPosture) {
    this.posture = posture;
    this.floorY = surface.floorY;
    const b = surface.bounds();
    this.fixtureFrontZ = b.max.z;
    const emitterZ = this.fixtureFrontZ + posture.standoff;
    this.legZ = emitterZ + posture.legSetback;
    this.build(surface, posture);
  }

  private build(surface: UrinalSurface, p: UserPosture): void {
    const b = surface.bounds();
    const cx = p.lateralOffset;

    // -- Floor -------------------------------------------------------------
    // Two rectangles rather than one, because a drop landing 5 cm from the
    // fixture and one landing 2 m away are different outcomes: the first is the
    // puddle somebody has to stand in, the second is negligible.
    this.rects.push({
      zone: CaptureZone.FloorNear,
      axis: 1,
      coord: this.floorY,
      aMin: -1.2,
      aMax: 1.2,
      bMin: b.min.z - 0.3,
      bMax: this.fixtureFrontZ + this.nearFloorDepth,
      dir: -1,
    });
    this.rects.push({
      zone: CaptureZone.FloorFar,
      axis: 1,
      coord: this.floorY,
      aMin: -3,
      aMax: 3,
      bMin: b.min.z - 2,
      bMax: this.fixtureFrontZ + 3,
      dir: -1,
    });

    // -- Shoes -------------------------------------------------------------
    // Horizontal patches just above the floor. Placed slightly above the floor
    // plane so a droplet heading for a shoe is caught by the shoe rather than by
    // the floor underneath it.
    const shoeY = this.floorY + 0.03;
    const toeZ = this.legZ - p.shoeLength * 0.65;
    const heelZ = this.legZ + p.shoeLength * 0.35;
    for (const side of [-1, 1]) {
      const centre = cx + side * p.stanceWidth * 0.5;
      this.rects.push({
        zone: CaptureZone.Shoe,
        axis: 1,
        coord: shoeY,
        aMin: centre - p.shoeWidth * 0.5,
        aMax: centre + p.shoeWidth * 0.5,
        bMin: toeZ,
        bMax: heelZ,
        dir: -1,
      });
    }

    // -- Legs --------------------------------------------------------------
    // Vertical panels facing the fixture. Only +z crossings count: that is
    // liquid travelling back toward the user, which is the definition of
    // splashback.
    this.rects.push({
      zone: CaptureZone.Shin,
      axis: 2,
      coord: this.legZ,
      aMin: cx - p.bodyHalfWidth,
      aMax: cx + p.bodyHalfWidth,
      bMin: this.floorY + 0.02,
      bMax: this.floorY + p.shinTop,
      dir: 1,
    });
    this.rects.push({
      zone: CaptureZone.Thigh,
      axis: 2,
      coord: this.legZ,
      aMin: cx - p.bodyHalfWidth,
      aMax: cx + p.bodyHalfWidth,
      bMin: this.floorY + p.shinTop,
      bMax: this.floorY + p.thighTop,
      dir: 1,
    });

    // -- Fixture exterior --------------------------------------------------
    // The outward-facing front of the fixture below the lip. Reached only by
    // liquid that cleared the rim and came back down against it; anything
    // heading out through the opening meets the inner front wall first, which is
    // part of the fixture mesh and handled by the collision test.
    this.rects.push({
      zone: CaptureZone.FixtureExterior,
      axis: 2,
      coord: this.fixtureFrontZ + 0.004,
      aMin: b.min.x - 0.02,
      aMax: b.max.x + 0.02,
      bMin: this.floorY,
      bMax: b.max.y,
      dir: -1,
    });
  }

  /**
   * Closest capture along the segment. Zones are tested against each other by
   * distance so a droplet that would cross both a shoe and the floor is credited
   * to whichever it reaches first.
   */
  test(from: Vec3, to: Vec3, out: CaptureHit): boolean {
    let bestT = Infinity;
    let bestZone = -1;
    const f = [from.x, from.y, from.z];
    const t2 = [to.x, to.y, to.z];

    for (const r of this.rects) {
      const a0 = f[r.axis];
      const a1 = t2[r.axis];
      const delta = a1 - a0;
      if (Math.abs(delta) < 1e-12) continue;
      if (r.dir > 0 && delta <= 0) continue;
      if (r.dir < 0 && delta >= 0) continue;
      const t = (r.coord - a0) / delta;
      if (t < 0 || t > 1 || t >= bestT) continue;
      // In-plane coordinates, in ascending axis order excluding r.axis.
      const i0 = r.axis === 0 ? 1 : 0;
      const i1 = r.axis === 2 ? 1 : 2;
      const p0 = f[i0] + (t2[i0] - f[i0]) * t;
      const p1 = f[i1] + (t2[i1] - f[i1]) * t;
      if (p0 < r.aMin || p0 > r.aMax || p1 < r.bMin || p1 > r.bMax) continue;
      bestT = t;
      bestZone = r.zone;
    }

    if (bestZone < 0) return false;
    out.t = bestT;
    out.zone = bestZone;
    return true;
  }

  /** Emitter position implied by the posture. */
  emitterPosition(): Vec3 {
    return v3(
      this.posture.lateralOffset,
      this.floorY + this.posture.emitterHeight,
      this.fixtureFrontZ + this.posture.standoff
    );
  }

  /** Generous simulation bounds; anything outside is no longer interesting. */
  simulationBounds(surface: UrinalSurface): { min: Vec3; max: Vec3 } {
    const b = surface.bounds();
    return {
      min: v3(b.min.x - 1.5, this.floorY - 0.1, b.min.z - 0.6),
      max: v3(b.max.x + 1.5, b.max.y + 1.2, this.fixtureFrontZ + 2.0),
    };
  }
}
