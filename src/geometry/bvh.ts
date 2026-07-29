import { Vec3 } from '../core/vec3';

export interface TriHit {
  /** Distance along the ray. */
  t: number;
  /** Triangle index. */
  tri: number;
  /** Barycentric weights of the 2nd and 3rd vertices. */
  b1: number;
  b2: number;
}

/**
 * Bounding volume hierarchy over the urinal's triangles.
 *
 * Every droplet needs a swept-segment test against the wall on every step, so
 * this is the hottest structure in the simulation. It is built once when the
 * geometry changes and then queried tens of thousands of times per frame,
 * which is why it lives in flat typed arrays with an explicit traversal stack
 * rather than as a tree of objects: no pointer chasing, no allocation, and no
 * garbage collector pauses in the middle of a run.
 *
 * Construction is a median split on the widest axis. A full surface-area
 * heuristic would build a slightly better tree, but the urinal mesh is a
 * regular grid with near-uniform triangle sizes, which is the case where
 * median split is already close to optimal.
 */
export class Bvh {
  private nodeMin!: Float32Array;
  private nodeMax!: Float32Array;
  private nodeLeft!: Int32Array;
  private nodeStart!: Int32Array;
  private nodeCount!: Int32Array;
  private triIdx!: Uint32Array;
  private nodeCountTotal = 0;

  private readonly maxLeafSize = 4;
  private stack = new Int32Array(128);

  build(vertices: Float32Array, indices: Uint32Array): void {
    const triCount = indices.length / 3;
    this.triIdx = new Uint32Array(triCount);
    for (let i = 0; i < triCount; i++) this.triIdx[i] = i;

    // Precompute per-triangle bounds and centroids once; the recursive split
    // reads them many times.
    const triMin = new Float32Array(triCount * 3);
    const triMax = new Float32Array(triCount * 3);
    const centroid = new Float32Array(triCount * 3);
    for (let t = 0; t < triCount; t++) {
      const i0 = indices[t * 3] * 3;
      const i1 = indices[t * 3 + 1] * 3;
      const i2 = indices[t * 3 + 2] * 3;
      for (let a = 0; a < 3; a++) {
        const p0 = vertices[i0 + a];
        const p1 = vertices[i1 + a];
        const p2 = vertices[i2 + a];
        const lo = Math.min(p0, p1, p2);
        const hi = Math.max(p0, p1, p2);
        triMin[t * 3 + a] = lo;
        triMax[t * 3 + a] = hi;
        centroid[t * 3 + a] = (p0 + p1 + p2) / 3;
      }
    }

    // A binary tree over N leaves of size >= 1 needs at most 2N-1 nodes.
    const maxNodes = Math.max(1, 2 * triCount);
    this.nodeMin = new Float32Array(maxNodes * 3);
    this.nodeMax = new Float32Array(maxNodes * 3);
    this.nodeLeft = new Int32Array(maxNodes).fill(-1);
    this.nodeStart = new Int32Array(maxNodes);
    this.nodeCount = new Int32Array(maxNodes);
    this.nodeCountTotal = 0;

    const alloc = (): number => this.nodeCountTotal++;

    // Explicit work stack instead of recursion: the tree can be ~20 deep and
    // recursion here would be fine, but an explicit stack keeps the build
    // allocation-free and matches the traversal style.
    const work: Array<{ node: number; start: number; count: number }> = [];
    const root = alloc();
    work.push({ node: root, start: 0, count: triCount });

    while (work.length > 0) {
      const { node, start, count } = work.pop()!;

      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      for (let i = start; i < start + count; i++) {
        const t = this.triIdx[i];
        if (triMin[t * 3] < minX) minX = triMin[t * 3];
        if (triMin[t * 3 + 1] < minY) minY = triMin[t * 3 + 1];
        if (triMin[t * 3 + 2] < minZ) minZ = triMin[t * 3 + 2];
        if (triMax[t * 3] > maxX) maxX = triMax[t * 3];
        if (triMax[t * 3 + 1] > maxY) maxY = triMax[t * 3 + 1];
        if (triMax[t * 3 + 2] > maxZ) maxZ = triMax[t * 3 + 2];
      }
      this.nodeMin[node * 3] = minX;
      this.nodeMin[node * 3 + 1] = minY;
      this.nodeMin[node * 3 + 2] = minZ;
      this.nodeMax[node * 3] = maxX;
      this.nodeMax[node * 3 + 1] = maxY;
      this.nodeMax[node * 3 + 2] = maxZ;

      if (count <= this.maxLeafSize) {
        this.nodeLeft[node] = -1;
        this.nodeStart[node] = start;
        this.nodeCount[node] = count;
        continue;
      }

      // Split on the widest axis at the median centroid.
      const ex = maxX - minX;
      const ey = maxY - minY;
      const ez = maxZ - minZ;
      const axis = ex > ey ? (ex > ez ? 0 : 2) : ey > ez ? 1 : 2;
      const sub = this.triIdx.subarray(start, start + count);
      const sorted = Array.from(sub).sort(
        (a, b) => centroid[a * 3 + axis] - centroid[b * 3 + axis]
      );
      for (let i = 0; i < count; i++) this.triIdx[start + i] = sorted[i];
      const mid = count >> 1;

      const l = alloc();
      const r = alloc();
      this.nodeLeft[node] = l;
      this.nodeStart[node] = -1;
      this.nodeCount[node] = 0;
      // Right child is always left+1, so only one index needs storing.
      work.push({ node: l, start, count: mid });
      work.push({ node: r, start: start + mid, count: count - mid });
    }
  }

  /**
   * Closest hit of the segment [origin, origin + dir*maxT].
   * `dir` need not be normalised; `t` is returned in the same units as maxT.
   *
   * Not backface culled. The urinal is an open shell with no thickness, and a
   * droplet that grazes the lip can legitimately approach from either side.
   */
  intersect(
    vertices: Float32Array,
    indices: Uint32Array,
    origin: Vec3,
    dir: Vec3,
    maxT: number
  ): TriHit | null {
    if (this.nodeCountTotal === 0) return null;

    const invX = 1 / (dir.x !== 0 ? dir.x : 1e-30);
    const invY = 1 / (dir.y !== 0 ? dir.y : 1e-30);
    const invZ = 1 / (dir.z !== 0 ? dir.z : 1e-30);

    let bestT = maxT;
    let bestTri = -1;
    let bestB1 = 0;
    let bestB2 = 0;

    let sp = 0;
    this.stack[sp++] = 0;

    while (sp > 0) {
      const node = this.stack[--sp];

      // Slab test against the node box.
      const n3 = node * 3;
      let t0 = (this.nodeMin[n3] - origin.x) * invX;
      let t1 = (this.nodeMax[n3] - origin.x) * invX;
      let tmin = Math.min(t0, t1);
      let tmax = Math.max(t0, t1);
      t0 = (this.nodeMin[n3 + 1] - origin.y) * invY;
      t1 = (this.nodeMax[n3 + 1] - origin.y) * invY;
      tmin = Math.max(tmin, Math.min(t0, t1));
      tmax = Math.min(tmax, Math.max(t0, t1));
      t0 = (this.nodeMin[n3 + 2] - origin.z) * invZ;
      t1 = (this.nodeMax[n3 + 2] - origin.z) * invZ;
      tmin = Math.max(tmin, Math.min(t0, t1));
      tmax = Math.min(tmax, Math.max(t0, t1));

      if (tmax < 0 || tmin > tmax || tmin > bestT) continue;

      const left = this.nodeLeft[node];
      if (left < 0) {
        const start = this.nodeStart[node];
        const count = this.nodeCount[node];
        for (let i = start; i < start + count; i++) {
          const tri = this.triIdx[i];
          const h = this.triangleHit(vertices, indices, tri, origin, dir, bestT);
          if (h) {
            bestT = h.t;
            bestTri = tri;
            bestB1 = h.b1;
            bestB2 = h.b2;
          }
        }
      } else {
        if (sp + 2 >= this.stack.length) {
          const bigger = new Int32Array(this.stack.length * 2);
          bigger.set(this.stack);
          this.stack = bigger;
        }
        this.stack[sp++] = left;
        this.stack[sp++] = left + 1;
      }
    }

    if (bestTri < 0) return null;
    return { t: bestT, tri: bestTri, b1: bestB1, b2: bestB2 };
  }

  /** Moller-Trumbore, double sided. */
  private triangleHit(
    vertices: Float32Array,
    indices: Uint32Array,
    tri: number,
    origin: Vec3,
    dir: Vec3,
    maxT: number
  ): { t: number; b1: number; b2: number } | null {
    const i0 = indices[tri * 3] * 3;
    const i1 = indices[tri * 3 + 1] * 3;
    const i2 = indices[tri * 3 + 2] * 3;

    const ax = vertices[i0];
    const ay = vertices[i0 + 1];
    const az = vertices[i0 + 2];
    const e1x = vertices[i1] - ax;
    const e1y = vertices[i1 + 1] - ay;
    const e1z = vertices[i1 + 2] - az;
    const e2x = vertices[i2] - ax;
    const e2y = vertices[i2 + 1] - ay;
    const e2z = vertices[i2 + 2] - az;

    const px = dir.y * e2z - dir.z * e2y;
    const py = dir.z * e2x - dir.x * e2z;
    const pz = dir.x * e2y - dir.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-14) return null;
    const inv = 1 / det;

    const tx = origin.x - ax;
    const ty = origin.y - ay;
    const tz = origin.z - az;
    const b1 = (tx * px + ty * py + tz * pz) * inv;
    if (b1 < -1e-7 || b1 > 1 + 1e-7) return null;

    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const b2 = (dir.x * qx + dir.y * qy + dir.z * qz) * inv;
    if (b2 < -1e-7 || b1 + b2 > 1 + 1e-7) return null;

    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t < 1e-9 || t > maxT) return null;
    return { t, b1, b2 };
  }
}
