import * as THREE from 'three';

/**
 * Liquid on the outside of the fixture.
 *
 * Trap 14 fixed the physics of this and left the picture alone. A droplet that
 * reaches the casting is resolved properly -- it throws a corona by the same
 * threshold as the interior, and only the remainder is booked to
 * `CaptureZone.FixtureExterior` -- but the remainder then had nowhere to be
 * drawn, because the film solver's grid stops at the wetted interior and the
 * casting has no cells. So the single worst outcome the tool exists to
 * demonstrate, the stream catching the front rim and running down the front of
 * the bowl, left the outside of the fixture spotless on screen while the report
 * said 119,790 microlitres per litre.
 *
 * Drawn as marks rather than as a film because there is no film here to solve:
 * these are the arrival points themselves, accumulated, each one a wetted spot
 * that darkens the glaze and catches the light the way the interior's does. That
 * is honest about what is known -- where liquid landed -- without inventing a
 * shallow-water solution on a surface that has no parameterisation for one.
 *
 * They persist for the run. Liquid on the outside of a urinal does not go
 * anywhere on the timescale of a void, which is the entire complaint about it.
 */
export class StainView {
  readonly points: THREE.Points;
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private positions: Float32Array;
  private normals: Float32Array;
  private sizes: Float32Array;
  private capacity: number;
  private count = 0;
  /** Oldest slot, so a long run overwrites rather than stopping. */
  private next = 0;

  constructor(capacity = 6000) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.normals = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aNormal', new THREE.BufferAttribute(this.normals, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.4, 0.2), 4);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: 1 },
        uViewHeight: { value: 800 },
        uTint: { value: new THREE.Color(0.88, 0.83, 0.5) },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aNormal;
        attribute float aSize;
        uniform float uPixelRatio;
        uniform float uViewHeight;
        varying float vFacing;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // Fade a mark that sits on a face turned away from the eye, so stains on
          // the back of the casting do not show through it. Cheaper and steadier
          // than depth-testing points against a surface they are coplanar with,
          // which z-fights at every camera distance.
          vec3 n = normalize(normalMatrix * aNormal);
          vFacing = smoothstep(-0.05, 0.35, dot(n, normalize(-mv.xyz)));
          float scale = uViewHeight * projectionMatrix[1][1] * 0.5;
          gl_PointSize = clamp(aSize * scale / max(0.02, -mv.z), 2.0, 34.0) * uPixelRatio;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTint;
        varying float vFacing;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          // A wetted spot on glaze: darker in the middle where the layer is
          // thickest, with a bright contact line round the edge. The same two cues
          // the interior's shader uses, at the only resolution available here.
          float r = sqrt(r2) * 2.0;
          float edge = smoothstep(0.72, 0.97, r) * (1.0 - smoothstep(0.97, 1.0, r));
          float body = 1.0 - smoothstep(0.0, 1.0, r);
          vec3 col = uTint * 0.45 + vec3(0.55) * edge;
          gl_FragColor = vec4(col, (body * 0.32 + edge * 0.5) * vFacing);
        }
      `,
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  setViewport(height: number, pixelRatio: number): void {
    this.material.uniforms.uViewHeight.value = height;
    this.material.uniforms.uPixelRatio.value = pixelRatio;
  }

  setTint(t: [number, number, number]): void {
    (this.material.uniforms.uTint.value as THREE.Color).setRGB(t[0], t[1], t[2]);
  }

  clear(): void {
    this.count = 0;
    this.next = 0;
    this.geometry.setDrawRange(0, 0);
  }

  /** Record one arrival on the outside of the fixture. */
  add(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    volume: number
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    const o = i * 3;
    this.positions[o] = x;
    this.positions[o + 1] = y;
    this.positions[o + 2] = z;
    this.normals[o] = nx;
    this.normals[o + 1] = ny;
    this.normals[o + 2] = nz;
    // Radius of the spot this much liquid makes, from the same spreading law the
    // interior uses: a wetted patch a couple of diameters across, floored so a
    // single fine droplet still marks something.
    this.sizes[i] = Math.max(0.004, 2.2 * Math.cbrt((6 * volume) / Math.PI));
    this.geometry.setDrawRange(0, this.count);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aNormal') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
