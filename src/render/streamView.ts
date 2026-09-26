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

const MAX_POINTS = 256;
const RADIAL = 16;

/**
 * Rings drawn between one parcel and the next.
 *
 * The simulation emits one parcel per Rayleigh wavelength, because that is the
 * liquid that becomes one droplet. The varicose swelling drawn along the tube has
 * a period of exactly one wavelength, by the same physics. Putting a ring only at
 * each parcel therefore sampled a cosine at exactly one sample per cycle -- the
 * worst place on the whole aliasing curve -- and what came out was not a necking
 * jet but a shredded worm: every ring landed at an arbitrary and slowly drifting
 * phase, so consecutive rings jumped between full swell and full pinch and the
 * surface folded over itself. Close up it was the ugliest thing in the tool.
 *
 * Six subdivisions puts six rings on each swelling, which resolves it, and the
 * centreline between parcels is straight enough over 13 mm that linear
 * interpolation of the position is not the limiting error.
 */
const SUBDIVISIONS = 6;

/** Parcels taken from the solver, before subdivision. */
const MAX_PARCELS = Math.floor(MAX_POINTS / SUBDIVISIONS);

/**
 * Smallest radius the jet is ever drawn at, in metres of world space.
 *
 * A 3 mm jet across a 0.69 m fixture that fills two thirds of a 900 px frame is
 * about two pixels wide, and an antialiased two-pixel tube on a pale background
 * is not a stream, it is a scratch. The whole subject of this tool is what the jet
 * does when it meets the ceramic, and at every camera preset the jet was
 * effectively invisible while the *marker sphere* at its origin -- 8 mm of radius,
 * pure decoration -- was four times wider than the liquid it marked.
 *
 * This is a floor, not a scale: wherever the jet is genuinely wider than 2.2 mm it
 * is drawn at its real width, so the thinning of the neck and the swelling before
 * pinch-off are still the solver's numbers. Only the part that would otherwise
 * disappear is lifted, and it is lifted to the smallest size that survives
 * antialiasing rather than to whatever looked good.
 */
const MIN_DRAW_RADIUS = 0.0011;

export class StreamView {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  private material: THREE.MeshStandardMaterial;
  private positions: Float32Array;
  private normals: Float32Array;

  /** Scratch, reused every frame. */
  private pts: Array<{ x: number; y: number; z: number; vol: number; grow: number }> = [];
  /** Subdivided rings actually drawn: position and radius, in order along the jet. */
  private ring: Array<{ x: number; y: number; z: number; r: number }> = [];

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

    // Water, not wax. A falling stream is a smooth dielectric with a strong
    // specular response and almost no diffuse of its own -- what you see is the
    // room in it -- so the roughness goes right down and the environment does the
    // work. Colour comes from the fluid, the same way the film's does.
    this.material = new THREE.MeshPhysicalMaterial({
      color: 0xf6efc9,
      roughness: 0.05,
      metalness: 0.0,
      transmission: 0,
      transparent: true,
      opacity: 0.86,
      side: THREE.DoubleSide,
      envMapIntensity: 1.4,
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
  update(
    ps: ParticleSystem,
    emitter: Vec3,
    emitterDiameter: number,
    breakup?: { wavelength: number; breakupTime: number; disturbanceRatio: number }
  ): void {
    // Gather coherent parcels with their age; age orders them along the stream
    // because they are emitted in sequence, and the particle buffer's free list
    // makes index order unreliable after the first recycled slot.
    const found: Array<{ age: number; i: number; t: number }> = [];
    for (let i = 0; i < ps.highWater; i++) {
      const f = ps.flags[i];
      if ((f & PFlag.Alive) === 0) continue;
      if ((f & PFlag.Coherent) === 0) continue;
      found.push({ age: ps.age[i], i, t: ps.breakupTimer[i] });
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
    this.pts.push({ x: emitter.x, y: emitter.y, z: emitter.z, vol: -1, grow: 0 });
    for (const f of found) {
      if (this.pts.length >= MAX_PARCELS) break;
      this.pts.push({
        x: ps.px[f.i],
        y: ps.py[f.i],
        z: ps.pz[f.i],
        vol: ps.volume[f.i],
        // How far this slice is through its own growth to pinch-off, 0 at the
        // exit and 1 where the thread parts.
        grow: breakup && breakup.breakupTime > 1e-6
          ? 1 - Math.max(0, f.t) / breakup.breakupTime
          : 0,
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
    const exitR = 0.5 * emitterDiameter;
    // Rayleigh-Plateau, drawn.
    //
    // The tube used to be perfectly smooth right up to the point where the
    // parcels changed colour, which is not what a breaking jet looks like: the
    // last few centimetres before pinch-off carry a visible varicose swelling
    // that grows exponentially until the thread parts, and that necking is the
    // most recognisable thing about a falling stream. Nothing had to be invented
    // to draw it -- solveBreakup already returns the fastest-growing wavelength
    // and the initial disturbance is a stated parameter, so the amplitude is
    // eps0 * exp(omega t), which reaches the jet radius exactly at pinch-off by
    // the definition of breakupTime. Phase runs along the stream at the
    // wavelength the solver picked.
    const lam = breakup && breakup.wavelength > 1e-6 ? breakup.wavelength : 0;
    const eps0 = breakup ? Math.max(1e-6, Math.min(0.9, breakup.disturbanceRatio)) : 0;

    // Per-parcel quantities first: the unmodulated radius from continuity, and
    // how far through its growth to pinch-off each parcel is.
    const baseR: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = this.pts[Math.max(0, i - 1)];
      const b = this.pts[Math.min(n - 1, i + 1)];
      const span = Math.min(n - 1, i + 1) - Math.max(0, i - 1) || 1;
      const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / span;
      const vol = this.pts[i].vol;
      baseR.push(
        vol <= 0 || len <= 1e-9
          ? exitR
          : Math.min(exitR * 1.4, Math.max(exitR * 0.25, Math.sqrt(vol / (Math.PI * len))))
      );
    }
    baseR[0] = exitR;

    // Then the rings, subdivided along each segment so the varicose wave is
    // resolved rather than aliased. Everything the ring needs -- position, radius,
    // growth phase -- is interpolated between the two parcels that bracket it, so
    // no quantity is invented between samples; only the cosine, which is analytic,
    // is evaluated at full rate.
    this.ring.length = 0;
    let arc = 0;
    for (let i = 0; i < n - 1 && this.ring.length < MAX_POINTS; i++) {
      const p0 = this.pts[i];
      const p1 = this.pts[i + 1];
      const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
      // Every segment emits its opening rings; only the final one also emits its
      // closing ring, so consecutive segments do not stack two rings on the shared
      // parcel and leave a zero-length quad there.
      const last = i === n - 2;
      for (let k = 0; k < SUBDIVISIONS + (last ? 1 : 0); k++) {
        if (this.ring.length >= MAX_POINTS) break;
        const t = k / SUBDIVISIONS;
        let r = baseR[i] + (baseR[i + 1] - baseR[i]) * t;
        if (lam > 0) {
          const grow = p0.grow + (p1.grow - p0.grow) * t;
          // eps grows from eps0 * r to r over the flight, and the surface is
          // r * (1 + eps cos(2 pi s / lambda)). Held just below 1 so the tube does
          // not pinch to a true zero and produce a degenerate ring.
          const eps = Math.min(0.85, eps0 * Math.pow(1 / eps0, grow));
          r *= 1 + eps * Math.cos((2 * Math.PI * (arc + segLen * t)) / lam);
        }
        this.ring.push({
          x: p0.x + (p1.x - p0.x) * t,
          y: p0.y + (p1.y - p0.y) * t,
          z: p0.z + (p1.z - p0.z) * t,
          r: Math.max(MIN_DRAW_RADIUS, r),
        });
      }
      arc += segLen;
    }
    // The exit ring is the nozzle itself.
    if (this.ring.length > 0) this.ring[0].r = Math.max(MIN_DRAW_RADIUS, exitR);

    // Parallel-transported frame, so the tube does not twist along its length.
    let upX = 1;
    let upY = 0;
    let upZ = 0;
    const m = this.ring.length;
    for (let i = 0; i < m; i++) {
      const a = this.ring[Math.max(0, i - 1)];
      const b = this.ring[Math.min(m - 1, i + 1)];
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

      const p = this.ring[i];
      const r = p.r;
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

    this.geometry.setDrawRange(0, Math.max(0, m - 1) * RADIAL * 6);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.visible = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
