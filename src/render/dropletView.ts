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
  /**
   * The colour of the liquid, and nothing else.
   *
   * Provenance colouring -- gold jet, red splash, pale blue satellite -- is a data
   * view, and it was the only one available on the tab whose own description is
   * "the fixture as it would look". At peak flow 906 of 973 live particles are
   * splash, so nine tenths of what the realistic view showed was a hard red dot
   * carrying an analytical meaning, over a fixture rendered as carefully as this
   * one is. It is still the right default on every other tab.
   */
  Liquid = 3,
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
  /**
   * Multiplier on the drawn droplet size.
   *
   * 1.0, not the 1.6 it was. The main drops off a 3 mm stream are 5.5 mm across
   * and leave one wavelength -- 13.3 mm -- apart, so drawing them 1.6x oversize
   * put 8.8 mm spheres at 13.3 mm centres: a two-thirds duty cycle, which is a
   * string of beads rather than a train of droplets. The sprite has a soft edge
   * and a size-carrying alpha now, so nothing needs inflating to stay visible.
   */
  sizeScale = 1.0;
  /**
   * The liquid's colour, for `DropletColorMode.Liquid`. Linear RGB, from the
   * fluid preset, so airborne liquid and the film on the wall agree.
   */
  liquidTint: [number, number, number] = [0.95, 0.92, 0.78];

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
        varying float vAlpha;
        uniform float uPixelRatio;
        uniform float uViewHeight;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // Perspective-correct: a droplet's on-screen size should shrink with
          // distance the same way the fixture does, otherwise depth reads wrong.
          float scale = uViewHeight * projectionMatrix[1][1] * 0.5;
          // Below about three pixels a hard-edged disc is an aliased square, and
          // a spray of aliased squares reads as sensor noise rather than as
          // liquid. The sprite is never drawn smaller than that; the *opacity*
          // carries the size instead, so a 0.2 mm satellite far from the camera
          // fades rather than turning into a bright pixel the size of a 5 mm drop.
          float want = aSize * scale / max(0.02, -mv.z);
          float px = clamp(want, 3.0, 44.0);
          vAlpha = clamp(want / px, 0.12, 1.0);
          gl_PointSize = px * uPixelRatio;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          // A droplet is a lens, not a marble.
          //
          // The old sprite was an opaque sphere with a diffuse term and a tight
          // highlight, which is how you draw a bead. Water in air does almost
          // nothing diffusely: it is transparent through the middle, where you see
          // whatever is behind it, and bright round the edge, where the view grazes
          // the surface and Fresnel turns it into a mirror. So the *alpha* carries
          // the shape -- near-clear at the centre, near-opaque at the rim -- and the
          // only bright things on it are the rim and one specular glint. That is
          // also why real spray photographs as a haze of tiny rings rather than as
          // a cloud of dots.
          float z = sqrt(max(0.0, 0.25 - r2)) * 2.0;
          // Fresnel on the sphere, sharpened. The reflectance of water only runs
          // away in the last few degrees of grazing -- it is 0.02 at normal, still
          // under 0.1 at sixty degrees off, and reaches one only at the silhouette
          // -- so the bright part of a drop is a *thin* ring at its outline. The
          // 2.5 power spread it over most of the disc, and a disc that is bright
          // everywhere but the very middle is a pearl.
          float fres = pow(1.0 - z, 5.0);
          float rim = smoothstep(0.55, 0.98, 1.0 - z);
          // One glint, offset up and left, where the key light sits, plus the spot
          // where the drop focuses that light through itself onto its far side.
          // A sphere of water has a focal length of about 1.5 radii, so the
          // caustic lands just inside the opposite limb, and it is the single most
          // recognisable thing about a backlit droplet.
          vec2 hg = d - vec2(-0.13, -0.13);
          float spec = pow(max(0.0, 1.0 - dot(hg, hg) * 40.0), 3.0) * 1.6;
          vec2 cg = d - vec2(0.17, 0.17);
          float caustic = pow(max(0.0, 1.0 - dot(cg, cg) * 55.0), 2.0) * 0.5;
          // Soft rim on the sprite itself, so a three-pixel droplet is not a
          // stamped hole. Two pixels of falloff is the difference between spray
          // and confetti.
          float edge = smoothstep(0.25, 0.17, r2);
          // The body is what you see *through* the drop, so it is nearly clear and
          // carries only the liquid's own colour; the bright things are the rim,
          // the glint and the caustic. It used to be a 30%-opaque wash of the
          // liquid colour at 55% brightness over the whole disc, which is an
          // opaque bead of wax -- and at the close cameras, where a drop covers
          // forty pixels, that was the most prominent object in the frame.
          vec3 col = vColor * (0.32 + 0.55 * rim) + vec3(spec + caustic);
          float a = (0.10 + 0.62 * fres + 0.45 * rim + spec + caustic) * vAlpha * edge;
          gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
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
      if (this.colorMode === DropletColorMode.Liquid) {
        // One colour, lightened a little for the smallest drops: a 0.2 mm
        // satellite has almost no path length through it and reads nearly white,
        // while a 5 mm drop carries enough liquid to show its own colour.
        const t = Math.min(1, ps.diameter[i] / 0.004);
        const lift = 1 - 0.45 * t;
        r = Math.min(1, this.liquidTint[0] + lift * (1 - this.liquidTint[0]));
        g = Math.min(1, this.liquidTint[1] + lift * (1 - this.liquidTint[1]));
        b = Math.min(1, this.liquidTint[2] + lift * (1 - this.liquidTint[2]));
      } else if (this.colorMode === DropletColorMode.Speed) {
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
