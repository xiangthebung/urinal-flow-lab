import * as THREE from 'three';
import { PFlag, ParticleSystem } from '../sim/particles';
import { Vec3 } from '../core/vec3';

/**
 * The coherent jet, drawn as an actual jet.
 *
 * The simulation emits one parcel per Rayleigh wavelength, which at peak flow is a
 * parcel every 13 mm. That is the physically right discretisation -- each parcel is
 * exactly the liquid that becomes one droplet -- but drawn as points it looks like a
 * dotted line, not a stream. Between two consecutive parcels there is continuous
 * liquid, so the honest way to draw the unbroken part of the stream is to run a
 * tube through them.
 *
 * The radius is not a constant either, and getting that right is most of what makes
 * it read as a jet. A falling stream accelerates, and since the volume flux through
 * every cross-section is the same, it must thin as it speeds up. Each parcel knows
 * the volume it carries, so the local radius follows from the volume divided by the
 * distance to its neighbour -- no artistic taper needed, and the neck below the exit
 * comes out at the right rate on its own.
 *
 * Only the pre-breakup portion is a tube. Past pinch-off the stream genuinely is a
 * train of separate droplets, and those are drawn as droplets.
 */

const MAX_POINTS = 96;
const RADIAL = 8;

export class StreamView {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  private material: THREE.MeshStandardMaterial;
  private positions: Float32Array;
  private normals: Float32Array;

  /** Scratch, reused every frame. */
  private pts: Array<{ x: number; y: number; z: number; vol: number }> = [];
  private radii: number[] = [];

  constructor() {
    this.positions = new Float32Array(MAX_POINTS * RADIAL * 3);
    this.normals = new Float32Array(MAX_POINTS * RADIAL * 3);

    // Index buffer is fixed: a quad strip between consecutive rings. Only the
    // draw range changes as the stream grows and shrinks.
    const idx: number[] = [];
    for (let i = 0; i < MAX_POINTS - 1; i++) {
      for (let r = 0; r < RADIAL; r++) {
        const r1 = (r + 1) % RADIAL;
        const a = i * RADIAL + r;
        const b = i * RADIAL + r1;
        const c = (i + 1) * RADIAL + r;
        const d = (i + 1) * RADIAL + r1;
        idx.push(a, c, b, b, c, d);
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    this.geometry.setIndex(idx);
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.4, 0.3), 4);

    this.material = new THREE.MeshStandardMaterial({
      color: 0xf2e9a8,
      roughness: 0.12,
      metalness: 0.0,
      transparent: true,
      opacity: 0.93,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  /**
   * Rebuild the tube from the live coherent parcels.
   *
   * `emitter` is prepended so the stream visibly starts at the exit rather than at
   * whichever parcel happens to be youngest.
   */
  update(ps: ParticleSystem, emitter: Vec3, emitterDiameter: number): void {
    // Gather coherent parcels with their age; age orders them along the stream
    // because they are emitted in sequence, and the particle buffer's free list
    // makes index order unreliable after the first recycled slot.
    const found: Array<{ age: number; i: number }> = [];
    for (let i = 0; i < ps.highWater; i++) {
      const f = ps.flags[i];
      if ((f & PFlag.Alive) === 0) continue;
      if ((f & PFlag.Coherent) === 0) continue;
      found.push({ age: ps.age[i], i });
    }
    if (found.length < 1) {
      this.geometry.setDrawRange(0, 0);
      this.mesh.visible = false;
      return;
    }
    found.sort((a, b) => a.age - b.age);

    this.pts.length = 0;
    // Exit first. Its "volume" is set from the exit area and the gap to the first
    // parcel so the starting radius matches the nozzle.
    this.pts.push({ x: emitter.x, y: emitter.y, z: emitter.z, vol: -1 });
    for (const f of found) {
      if (this.pts.length >= MAX_POINTS) break;
      this.pts.push({
        x: ps.px[f.i],
        y: ps.py[f.i],
        z: ps.pz[f.i],
        vol: ps.volume[f.i],
      });
    }
    const n = this.pts.length;
    if (n < 2) {
      this.geometry.setDrawRange(0, 0);
      this.mesh.visible = false;
      return;
    }

    // Radius from continuity: a parcel of volume V occupying a length L of stream
    // has cross-section V / L, so r = sqrt(V / (pi L)).
    this.radii.length = n;
    const exitR = 0.5 * emitterDiameter;
    for (let i = 0; i < n; i++) {
      const a = this.pts[Math.max(0, i - 1)];
      const b = this.pts[Math.min(n - 1, i + 1)];
      const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / (Math.min(n - 1, i + 1) - Math.max(0, i - 1) || 1);
      const vol = this.pts[i].vol;
      if (vol <= 0 || len <= 1e-9) {
        this.radii[i] = exitR;
      } else {
        this.radii[i] = Math.min(exitR * 1.4, Math.max(exitR * 0.25, Math.sqrt(vol / (Math.PI * len))));
      }
    }
    // The exit ring is the nozzle itself.
    this.radii[0] = exitR;

    // Parallel-transported frame, so the tube does not twist along its length.
    let upX = 1;
    let upY = 0;
    let upZ = 0;
    for (let i = 0; i < n; i++) {
      const a = this.pts[Math.max(0, i - 1)];
      const b = this.pts[Math.min(n - 1, i + 1)];
      let tx = b.x - a.x;
      let ty = b.y - a.y;
      let tz = b.z - a.z;
      const tm = Math.hypot(tx, ty, tz) || 1;
      tx /= tm;
      ty /= tm;
      tz /= tm;

      // Re-orthogonalise the carried reference against the new tangent.
      let dot = upX * tx + upY * ty + upZ * tz;
      let nx = upX - dot * tx;
      let ny = upY - dot * ty;
      let nz = upZ - dot * tz;
      let nm = Math.hypot(nx, ny, nz);
      if (nm < 1e-6) {
        // Degenerate: pick any axis not parallel to the tangent.
        nx = Math.abs(tx) < 0.9 ? 1 : 0;
        ny = Math.abs(tx) < 0.9 ? 0 : 1;
        nz = 0;
        dot = nx * tx + ny * ty + nz * tz;
        nx -= dot * tx;
        ny -= dot * ty;
        nz -= dot * tz;
        nm = Math.hypot(nx, ny, nz) || 1;
      }
      nx /= nm;
      ny /= nm;
      nz /= nm;
      upX = nx;
      upY = ny;
      upZ = nz;

      // Binormal completes the frame.
      const bx = ty * nz - tz * ny;
      const by = tz * nx - tx * nz;
      const bz = tx * ny - ty * nx;

      const r = this.radii[i];
      const p = this.pts[i];
      for (let k = 0; k < RADIAL; k++) {
        const a2 = (k / RADIAL) * Math.PI * 2;
        const ca = Math.cos(a2);
        const sa = Math.sin(a2);
        const dx = nx * ca + bx * sa;
        const dy = ny * ca + by * sa;
        const dz = nz * ca + bz * sa;
        const o = (i * RADIAL + k) * 3;
        this.positions[o] = p.x + dx * r;
        this.positions[o + 1] = p.y + dy * r;
        this.positions[o + 2] = p.z + dz * r;
        this.normals[o] = dx;
        this.normals[o + 1] = dy;
        this.normals[o + 2] = dz;
      }
    }

    this.geometry.setDrawRange(0, (n - 1) * RADIAL * 6);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.visible = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
