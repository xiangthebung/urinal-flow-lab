import * as THREE from 'three';
import { PFlag, ParticleSystem } from '../sim/particles';

/**
 * The airborne liquid.
 *
 * Drawn as GPU points rather than instanced spheres. A busy moment has tens of
 * thousands of droplets live, and at the scale they appear on screen -- a 1 mm
 * drop across a 0.4 m fixture -- a shaded sphere and a round point are
 * indistinguishable, while the point costs a single vertex.
 *
 * Colour encodes provenance, which is the thing worth seeing: the coherent jet,
 * the droplet train it breaks into, and splash. Watching the stream change colour
 * partway to the wall is watching Rayleigh-Plateau breakup happen, and whether
 * that colour change lands before or after the wall is the single best predictor
 * of whether the design will splash.
 */

export const enum DropletColorMode {
  /** Coherent jet / primary droplets / splash generations. */
  Provenance = 0,
  /** Speed. */
  Speed = 1,
  /** Diameter. */
  Size = 2,
}

export class DropletView {
  readonly points: THREE.Points;
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private positions: Float32Array;
  private colors: Float32Array;
  private sizes: Float32Array;
  private capacity: number;
  colorMode: DropletColorMode = DropletColorMode.Provenance;
  /** Multiplier on the drawn droplet size. Purely visual. */
  sizeScale = 1.6;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setDrawRange(0, 0);
    // Fixed generous bounding sphere: the contents change every frame and
    // recomputing bounds per frame would cost more than it saves.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.3, 0.2), 4);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: 1 },
        uViewHeight: { value: 800 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        varying vec3 vColor;
        uniform float uPixelRatio;
        uniform float uViewHeight;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // Perspective-correct: a droplet's on-screen size should shrink with
          // distance the same way the fixture does, otherwise depth reads wrong.
          float scale = uViewHeight * projectionMatrix[1][1] * 0.5;
          gl_PointSize = clamp(aSize * scale / max(0.02, -mv.z), 1.4, 40.0) * uPixelRatio;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          // Cheap spherical shading so a dense spray still reads as droplets
          // rather than as a flat cloud.
          float z = sqrt(max(0.0, 0.25 - r2)) * 2.0;
          float lit = 0.45 + 0.55 * z;
          float spec = pow(z, 12.0) * 0.5;
          gl_FragColor = vec4(vColor * lit + vec3(spec), 1.0);
        }
      `,
      transparent: false,
      depthWrite: true,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  setViewport(height: number, pixelRatio: number): void {
    this.material.uniforms.uViewHeight.value = height;
    this.material.uniforms.uPixelRatio.value = pixelRatio;
  }

  /** Copy the live particles into the draw buffers. */
  update(ps: ParticleSystem): void {
    let n = 0;
    const cap = this.capacity;
    for (let i = 0; i < ps.highWater && n < cap; i++) {
      const f = ps.flags[i];
      if ((f & PFlag.Alive) === 0) continue;
      const o = n * 3;
      this.positions[o] = ps.px[i];
      this.positions[o + 1] = ps.py[i];
      this.positions[o + 2] = ps.pz[i];
      this.sizes[n] = ps.diameter[i] * this.sizeScale;

      let r: number;
      let g: number;
      let b: number;
      if (this.colorMode === DropletColorMode.Speed) {
        const sp = Math.hypot(ps.vx[i], ps.vy[i], ps.vz[i]);
        const t = Math.min(1, sp / 4);
        r = 0.15 + 0.85 * t;
        g = 0.5 * (1 - t) + 0.35;
        b = 1.0 - 0.8 * t;
      } else if (this.colorMode === DropletColorMode.Size) {
        const t = Math.min(1, ps.diameter[i] / 0.006);
        r = 0.2 + 0.7 * t;
        g = 0.75 - 0.35 * t;
        b = 0.95 - 0.5 * t;
      } else if (f & PFlag.Coherent) {
        // Intact jet: pale, cohesive.
        r = 0.98;
        g = 0.95;
        b = 0.62;
      } else if (f & PFlag.Secondary) {
        const gen = ps.generation[i];
        if (gen <= 1) {
          // First-generation splash: the droplets that actually reach the user.
          r = 1.0;
          g = 0.32;
          b = 0.22;
        } else {
          r = 0.85;
          g = 0.2;
          b = 0.55;
        }
      } else if (f & PFlag.Satellite) {
        r = 0.55;
        g = 0.85;
        b = 1.0;
      } else {
        // Primary droplets after breakup.
        r = 0.95;
        g = 0.83;
        b = 0.42;
      }
      this.colors[o] = r;
      this.colors[o + 1] = g;
      this.colors[o + 2] = b;
      n++;
    }
    this.geometry.setDrawRange(0, n);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
