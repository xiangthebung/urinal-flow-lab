import { Vec3, v3 } from '../core/vec3';
import { Bvh } from './bvh';

/**
 * Solid geometry a droplet can hit that is *not* the wetted interior.
 *
 * The simulation only ever collided against the interior loft, because for a long
 * time that was the only geometry there was. Once the fixture gained an exterior
 * casting the omission became visible immediately: splash left the bowl and flew
 * straight through the ceramic, because as far as the physics was concerned the
 * ceramic did not exist. The casting was cosmetic, and "cosmetic" quietly came to
 * mean "intangible".
 *
 * Liquid landing on the outside of a urinal is not a rendering detail either -- it
 * is one of the outcomes the tool exists to measure, and there is already a capture
 * zone for it. So the exterior needs to be collidable, but it must not be confused
 * with the interior: the film solver lives on the interior's structured grid and
 * has nowhere to put liquid that lands on the back of the casting. Hence a separate
 * and deliberately narrow interface -- distance and normal, no surface coordinates,
 * no film cell -- which is all that is needed to stop a droplet and hand it to the
 * capture accounting.
 *
 * Narrow on purpose for a second reason: anything that can answer this question can
 * be a fixture exterior, including a mesh someone imports.
 */

export interface SolidHit {
  /** Distance along the query segment, in units of the direction vector. */
  t: number;
  /** Surface normal at the hit, unnormalised sense. */
  normal: Vec3;
}

export interface SolidCollider {
  /**
   * Nearest intersection of the segment `origin -> origin + dir * maxT`, or null.
   *
   * `dir` is deliberately not required to be a unit vector: the particle sweep
   * passes the whole step as the direction with maxT = 1 so that `t` comes back as
   * a fraction of the step, which is what the caller needs.
   */
  raycastSolid(origin: Vec3, dir: Vec3, maxT: number): SolidHit | null;
}

/** A triangle mesh, made collidable. */
export class MeshCollider implements SolidCollider {
  private readonly positions: Float32Array;
  private readonly indices: Uint32Array;
  private readonly bvh = new Bvh();
  private readonly scratch = v3();

  constructor(positions: Float32Array, indices: Uint32Array) {
    this.positions = positions;
    this.indices = indices;
    this.bvh.build(positions, indices);
  }

  raycastSolid(origin: Vec3, dir: Vec3, maxT: number): SolidHit | null {
    const hit = this.bvh.intersect(this.positions, this.indices, origin, dir, maxT);
    if (!hit) return null;
    const o = hit.tri * 3;
    const ia = this.indices[o] * 3;
    const ib = this.indices[o + 1] * 3;
    const ic = this.indices[o + 2] * 3;
    const e1x = this.positions[ib] - this.positions[ia];
    const e1y = this.positions[ib + 1] - this.positions[ia + 1];
    const e1z = this.positions[ib + 2] - this.positions[ia + 2];
    const e2x = this.positions[ic] - this.positions[ia];
    const e2y = this.positions[ic + 1] - this.positions[ia + 1];
    const e2z = this.positions[ic + 2] - this.positions[ia + 2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const m = Math.hypot(nx, ny, nz) || 1;
    nx /= m;
    ny /= m;
    nz /= m;
    // Faced back along the ray, so the caller always gets the side it arrived on.
    if (nx * dir.x + ny * dir.y + nz * dir.z > 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    this.scratch.x = nx;
    this.scratch.y = ny;
    this.scratch.z = nz;
    return { t: hit.t, normal: this.scratch };
  }
}

/**
 * Several colliders tested as one, nearest hit winning.
 *
 * Exists so the metalwork is as solid as the ceramic. The particle sweep takes a
 * single exterior collider, and the alternative -- merging the casting and the
 * fittings into one mesh before building a BVH -- would rebuild the whole
 * acceleration structure whenever either changed and would lose the ability to
 * ask which of the two was struck.
 *
 * The normal is copied into this object's own scratch rather than passed through.
 * `MeshCollider` returns a reference to its own reusable vector, so holding the
 * winner's normal while testing the next part would hand back whatever the last
 * part happened to write.
 */
export class CompositeCollider implements SolidCollider {
  private readonly parts: SolidCollider[];
  private readonly scratch = v3();

  constructor(parts: Array<SolidCollider | null | undefined>) {
    this.parts = parts.filter((p): p is SolidCollider => !!p);
  }

  raycastSolid(origin: Vec3, dir: Vec3, maxT: number): SolidHit | null {
    let bestT = maxT;
    let found = false;
    for (const part of this.parts) {
      const hit = part.raycastSolid(origin, dir, bestT);
      if (!hit || hit.t > bestT) continue;
      bestT = hit.t;
      this.scratch.x = hit.normal.x;
      this.scratch.y = hit.normal.y;
      this.scratch.z = hit.normal.z;
      found = true;
    }
    return found ? { t: bestT, normal: this.scratch } : null;
  }
}
