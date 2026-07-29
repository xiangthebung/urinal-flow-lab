import * as THREE from 'three';
import { CRITICAL_IMPINGEMENT_ANGLE } from '../core/constants';
import { UrinalSurface } from '../geometry/surface';
import { FilmSolver } from '../sim/film';
import { Metrics } from '../sim/metrics';
import { COLORMAP_GLSL, ColorScale } from './colormap';

/**
 * The fixture, the liquid clinging to it, and whichever data field is being
 * inspected.
 *
 * The liquid is the part that needed the most care. A wall film during use is a
 * few tens of microns thick -- the solver puts the median around 30 to 80 um --
 * and there is no way to draw a thickness that small as a thickness. Drawn on a
 * millimetre colour scale it sits in the bottom two percent and reads as black,
 * which makes a perfectly good simulation look like nothing is happening.
 *
 * So the film is rendered the way a thin film actually presents itself: not as a
 * measurable depth but as wetness. Glaze that is wet goes darker and much glossier,
 * the free surface of the film tilts the reflection wherever the thickness varies,
 * and standing liquid picks up a tint with depth. That makes 40 um visible for the
 * same reason a damp patch on a pavement is visible, while the millimetre-scale
 * pooling in the sump still reads as an obvious pool.
 */

export const enum FieldMode {
  /** Realistic: ceramic plus liquid, no data overlay. */
  Liquid = 'liquid',
  Impingement = 'impingement',
  FilmThickness = 'film',
  FilmSpeed = 'filmSpeed',
  Residence = 'residence',
  ImpactVolume = 'impact',
  SplashOrigin = 'splash',
  /** Dry ceramic, no liquid and no data. Geometry inspection only. */
  Dry = 'dry',
}

export interface FieldInfo {
  label: string;
  unit: string;
  scale: ColorScale;
  /** Colour scale bounds, in display units. */
  min: number;
  max: number;
  /** Where the criterion sits, in display units. NaN if none. */
  critical: number;
  /** Multiplier from SI to display units. */
  toDisplay: number;
  /** True if the scale is logarithmic. */
  log: boolean;
  description: string;
}

const SENTINEL = -1e9;

export class FixtureView {
  readonly group = new THREE.Group();
  private geometry!: THREE.BufferGeometry;
  private material!: THREE.ShaderMaterial;
  private mesh!: THREE.Mesh;
  private wire!: THREE.LineSegments;
  private surface!: UrinalSurface;
  private drainRing!: THREE.Line;

  // Per-vertex channels.
  private field!: Float32Array;
  private film!: Float32Array;
  private relief!: Float32Array;
  private speed!: Float32Array;
  // Scatter scratch.
  private accum!: Float64Array;
  private counts!: Uint16Array;
  private cellScratch!: Float64Array;

  mode: FieldMode = FieldMode.Liquid;
  info: FieldInfo = FixtureView.infoFor(FieldMode.Liquid, 0, 1);
  /**
   * Exaggeration on the film's surface relief. A 50 um film varying over a 3 mm
   * cell tilts its surface by only a couple of degrees, which is real but too
   * subtle to see; this scales the tilt up so rivulets and waves read clearly.
   * Purely a visualisation gain -- it changes no physics.
   */
  reliefGain = 12;
  /** Master strength of the liquid appearance, 0 disables it. */
  liquidStrength = 1;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uFieldMin: { value: 0 },
        uFieldMax: { value: 1 },
        uFieldLog: { value: 0 },
        uScale: { value: 1 },
        uCriticalT: { value: 0.5 },
        uUseField: { value: 0 },
        uLiquid: { value: 1 },
        uRelief: { value: 12 },
        uTime: { value: 0 },
        uShadowColor: { value: new THREE.Color(0.34, 0.35, 0.38) },
        uBase: { value: new THREE.Color(0.895, 0.905, 0.925) },
        uLiquidTint: { value: new THREE.Color(0.86, 0.84, 0.55) },
        uLightA: { value: new THREE.Vector3(0.4, 0.85, 0.5).normalize() },
        uLightB: { value: new THREE.Vector3(-0.6, 0.3, 0.7).normalize() },
      },
      vertexShader: /* glsl */ `
        attribute float aField;
        attribute float aFilm;
        attribute vec3 aRelief;
        attribute float aSpeed;
        varying float vField;
        varying float vFilm;
        varying vec3 vRelief;
        varying float vSpeed;
        varying vec3 vNormal;
        varying vec3 vView;
        varying vec3 vLocal;
        void main() {
          vField = aField;
          vFilm = aFilm;
          vRelief = aRelief;
          vSpeed = aSpeed;
          vLocal = position;
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        ${COLORMAP_GLSL}
        uniform float uFieldMin;
        uniform float uFieldMax;
        uniform float uFieldLog;
        uniform int uScale;
        uniform float uCriticalT;
        uniform float uUseField;
        uniform float uLiquid;
        uniform float uRelief;
        uniform float uTime;
        uniform vec3 uShadowColor;
        uniform vec3 uBase;
        uniform vec3 uLiquidTint;
        uniform vec3 uLightA;
        uniform vec3 uLightB;
        varying float vField;
        varying float vFilm;
        varying vec3 vRelief;
        varying float vSpeed;
        varying vec3 vNormal;
        varying vec3 vView;
        varying vec3 vLocal;

        void main() {
          vec3 n = normalize(vNormal);
          vec3 v = normalize(vView);
          // Two-sided: the bowl interior is visible from angles where the
          // geometric normal faces away, and a black interior is useless.
          if (dot(n, v) < 0.0) n = -n;
          vec3 nDry = n;

          // ---- liquid ------------------------------------------------------
          // Wetness saturates by ~30 um: past that the glaze is simply wet and
          // more thickness changes the tint, not the gloss.
          float wet = smoothstep(3.0e-6, 3.0e-5, vFilm) * uLiquid;
          // Depth tint saturates around 0.4 mm, so sump pooling reads distinctly
          // from a damp wall.
          float deep = (1.0 - exp(-vFilm / 4.0e-4)) * uLiquid;

          vec3 nWet = n;
          if (wet > 0.001) {
            // The relief gain has to serve two scales at once: a 50 um wall film
            // tilts its surface by under a degree, while the rim of a 2.5 mm pool
            // tilts by twenty. One linear gain large enough to reveal the first
            // would let the second overwhelm the surface normal completely and the
            // pool edge would shade as though it faced sideways. Saturating the
            // offset keeps small ripples visible and bounds the steep places.
            float rlen = length(vRelief);
            vec3 rdir = rlen > 1.0e-9 ? vRelief / rlen : vec3(0.0);
            float s = rlen * uRelief;
            float maxTilt = 0.70;
            nWet = normalize(n + rdir * (s / (1.0 + s / maxTilt)));
            // Fast film carries capillary waves far shorter than a grid cell.
            // Added here as an explicitly visual stand-in for that unresolved
            // scale; it perturbs shading only and feeds back into nothing.
            float agitate = clamp(vSpeed * 3.0, 0.0, 1.0);
            if (agitate > 0.01) {
              float p = vLocal.y * 420.0 + vLocal.x * 260.0 - uTime * 7.0;
              float q = vLocal.y * 260.0 - vLocal.z * 380.0 - uTime * 4.3;
              vec3 jitter = vec3(sin(p) + 0.6 * sin(q * 1.7), cos(q), sin(q));
              nWet = normalize(nWet + jitter * (0.05 * agitate));
            }
          }
          vec3 nUse = normalize(mix(nDry, nWet, wet));

          // ---- lighting ----------------------------------------------------
          float dA = max(dot(nUse, uLightA), 0.0);
          float dB = max(dot(nUse, uLightB), 0.0);
          float diffuse = 0.34 + 0.62 * dA + 0.30 * dB;

          // Wet surfaces are far glossier and their highlight is much tighter.
          vec3 hA = normalize(uLightA + v);
          vec3 hB = normalize(uLightB + v);
          float shin = mix(48.0, 190.0, wet);
          float specA = pow(max(dot(nUse, hA), 0.0), shin);
          float specB = pow(max(dot(nUse, hB), 0.0), shin);
          float specGain = mix(0.35, 1.35, wet);
          float spec = (specA + 0.45 * specB) * specGain;

          float rim = pow(1.0 - max(dot(nUse, v), 0.0), 3.0);

          // ---- albedo ------------------------------------------------------
          vec3 albedo;
          if (uUseField > 0.5) {
            if (vField < -1.0e8) {
              albedo = uShadowColor;
            } else {
              float t;
              if (uFieldLog > 0.5) {
                float lo = log(max(uFieldMin, 1.0e-12));
                float hi = log(max(uFieldMax, 1.0e-12));
                t = (log(max(vField, 1.0e-12)) - lo) / max(1.0e-6, hi - lo);
              } else {
                t = (vField - uFieldMin) / max(1.0e-9, uFieldMax - uFieldMin);
              }
              albedo = colorScale(uScale, clamp(t, 0.0, 1.0), uCriticalT);
            }
          } else {
            albedo = uBase;
          }

          // Wet glaze darkens, the way any wet surface does, and deeper liquid
          // takes on its own colour.
          albedo *= (1.0 - 0.30 * wet);
          albedo = mix(albedo, albedo * uLiquidTint, 0.55 * deep);

          vec3 col = albedo * diffuse + vec3(spec) + albedo * rim * 0.22;
          // Grazing reflection off the liquid surface.
          col += vec3(0.10, 0.13, 0.16) * rim * wet;

          gl_FragColor = vec4(col, 1.0);
        }
      `,
      side: THREE.DoubleSide,
      transparent: false,
    });
  }

  setSurface(surface: UrinalSurface): void {
    this.surface = surface;
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.group.remove(this.wire);
      this.geometry.dispose();
    }
    const nVert = (surface.nu + 1) * (surface.nv + 1);
    const nCell = surface.nu * surface.nv;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(surface.vertices.slice(), 3)
    );
    this.geometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(surface.vertexNormals.slice(), 3)
    );
    this.field = new Float32Array(nVert);
    this.film = new Float32Array(nVert);
    this.relief = new Float32Array(nVert * 3);
    this.speed = new Float32Array(nVert);
    this.geometry.setAttribute('aField', new THREE.BufferAttribute(this.field, 1));
    this.geometry.setAttribute('aFilm', new THREE.BufferAttribute(this.film, 1));
    this.geometry.setAttribute('aRelief', new THREE.BufferAttribute(this.relief, 3));
    this.geometry.setAttribute('aSpeed', new THREE.BufferAttribute(this.speed, 1));
    this.geometry.setIndex(new THREE.BufferAttribute(surface.indices.slice(), 1));
    this.geometry.computeBoundingSphere();

    this.accum = new Float64Array(nVert * 6);
    this.counts = new Uint16Array(nVert);
    this.cellScratch = new Float64Array(nCell);

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    this.wire = new THREE.LineSegments(
      this.buildSparseWireframe(surface, 8, 12),
      new THREE.LineBasicMaterial({ color: 0x1b2430, transparent: true, opacity: 0.22 })
    );
    this.wire.visible = false;
    this.group.add(this.wire);

    if (this.drainRing) this.group.remove(this.drainRing);
    this.drainRing = this.buildDrainOutline(surface);
    this.group.add(this.drainRing);
  }

  private buildSparseWireframe(
    s: UrinalSurface,
    everyU: number,
    everyV: number
  ): THREE.BufferGeometry {
    const pts: number[] = [];
    const stride = s.nu + 1;
    const at = (i: number, j: number) => {
      const o = (j * stride + i) * 3;
      return [s.vertices[o], s.vertices[o + 1], s.vertices[o + 2]];
    };
    for (let i = 0; i <= s.nu; i += everyU) {
      for (let j = 0; j < s.nv; j++) pts.push(...at(i, j), ...at(i, j + 1));
    }
    for (let j = 0; j <= s.nv; j += everyV) {
      for (let i = 0; i < s.nu; i++) pts.push(...at(i, j), ...at(i + 1, j));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }

  private buildDrainOutline(s: UrinalSurface): THREE.Line {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let n = 0;
    for (let c = 0; c < s.cellIsDrain.length; c++) {
      if (!s.cellIsDrain[c]) continue;
      cx += s.cellPos[c * 3];
      cy += s.cellPos[c * 3 + 1];
      cz += s.cellPos[c * 3 + 2];
      n++;
    }
    const pts: THREE.Vector3[] = [];
    if (n > 0) {
      cx /= n;
      cy /= n;
      cz /= n;
      const r = Math.max(0.004, Math.sqrt(s.drainArea / Math.PI));
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        pts.push(new THREE.Vector3(cx + r * Math.cos(a), cy + 0.0015, cz + r * Math.sin(a)));
      }
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x0e1621 }));
  }

  setWireframeVisible(v: boolean): void {
    if (this.wire) this.wire.visible = v;
  }

  /**
   * Push all per-vertex channels in one pass.
   *
   * Cell-centred solver values are averaged onto the vertices the shader
   * interpolates over. Invalid cells are excluded from the average rather than
   * counted as zero: fields like the impingement map are genuinely undefined where
   * the stream cannot reach, and folding an undefined cell into its neighbours
   * would smear a fabricated value across the boundary. A vertex with no valid
   * neighbour keeps the sentinel and renders grey.
   */
  private scatter(fieldCells: Float64Array, invalid: Uint8Array | undefined): void {
    const s = this.surface;
    const stride = s.nu + 1;
    const nVert = this.field.length;
    this.accum.fill(0);
    this.counts.fill(0);

    // Channel layout per vertex: field, film, reliefX, reliefY, reliefZ, speed.
    for (let j = 0; j < s.nv; j++) {
      for (let i = 0; i < s.nu; i++) {
        const c = j * s.nu + i;
        const bad = invalid ? invalid[c] !== 0 : false;
        const fv = fieldCells[c];
        const fieldOk = !bad && Number.isFinite(fv);

        // Film surface relief: the free surface of a layer of thickness h has
        // normal proportional to (n - grad_tangential h), so the offset is the
        // negated in-plane gradient expressed in world space.
        const iL = i > 0 ? i - 1 : 0;
        const iR = i < s.nu - 1 ? i + 1 : s.nu - 1;
        const jD = j > 0 ? j - 1 : 0;
        const jU = j < s.nv - 1 ? j + 1 : s.nv - 1;
        const spanU = Math.max(1e-6, s.cellDu[c] * (iR - iL));
        const spanV = Math.max(1e-6, s.cellDv[c] * (jU - jD));
        const hL = this.filmH[j * s.nu + iL];
        const hR = this.filmH[j * s.nu + iR];
        const hD = this.filmH[jD * s.nu + i];
        const hU = this.filmH[jU * s.nu + i];
        const dhdu = (hR - hL) / spanU;
        const dhdv = (hU - hD) / spanV;
        const o3 = c * 3;
        const rx = -dhdu * s.cellTangentU[o3] - dhdv * s.cellTangentV[o3];
        const ry = -dhdu * s.cellTangentU[o3 + 1] - dhdv * s.cellTangentV[o3 + 1];
        const rz = -dhdu * s.cellTangentU[o3 + 2] - dhdv * s.cellTangentV[o3 + 2];

        const h = this.filmH[c];
        const sp = this.filmSpeed(c);

        const vs = [
          j * stride + i,
          j * stride + i + 1,
          (j + 1) * stride + i,
          (j + 1) * stride + i + 1,
        ];
        for (const vi of vs) {
          const b = vi * 6;
          if (fieldOk) {
            this.accum[b] += fv;
            this.counts[vi]++;
          }
          this.accum[b + 1] += h;
          this.accum[b + 2] += rx;
          this.accum[b + 3] += ry;
          this.accum[b + 4] += rz;
          this.accum[b + 5] += sp;
        }
      }
    }

    // Every interior vertex touches four cells, edges two, corners one. The film
    // channels are always valid so a plain divide by the touch count works; the
    // data field uses its own count because invalid cells were skipped.
    const stride2 = s.nu + 1;
    for (let vi = 0; vi < nVert; vi++) {
      const b = vi * 6;
      const i = vi % stride2;
      const j = (vi - i) / stride2;
      const nu = i > 0 && i < s.nu ? 2 : 1;
      const nv = j > 0 && j < s.nv ? 2 : 1;
      const touch = nu * nv;
      this.field[vi] = this.counts[vi] > 0 ? this.accum[b] / this.counts[vi] : SENTINEL;
      this.film[vi] = this.accum[b + 1] / touch;
      this.relief[vi * 3] = this.accum[b + 2] / touch;
      this.relief[vi * 3 + 1] = this.accum[b + 3] / touch;
      this.relief[vi * 3 + 2] = this.accum[b + 4] / touch;
      this.speed[vi] = this.accum[b + 5] / touch;
    }

    (this.geometry.getAttribute('aField') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aFilm') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aRelief') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aSpeed') as THREE.BufferAttribute).needsUpdate = true;
  }

  private filmH!: Float64Array;
  private filmRef!: FilmSolver;
  private filmSpeed(c: number): number {
    return this.filmRef.speedAt(c);
  }

  /** Refresh the surface appearance and the displayed field. */
  update(
    film: FilmSolver,
    metrics: Metrics,
    impingement: Float64Array,
    shadowed: Uint8Array,
    time: number
  ): void {
    const s = this.surface;
    const nCell = s.nu * s.nv;
    this.filmH = film.h;
    this.filmRef = film;

    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uRelief.value = this.reliefGain;
    // Dry mode is for reading geometry, so the liquid is switched off entirely.
    const liquid = this.mode === FieldMode.Dry ? 0 : this.liquidStrength;
    this.material.uniforms.uLiquid.value = liquid;

    let values: Float64Array = this.cellScratch;
    let invalid: Uint8Array | undefined;
    let min = 0;
    let max = 1;
    let useField = 1;
    let log = false;

    switch (this.mode) {
      case FieldMode.Liquid:
      case FieldMode.Dry:
        useField = 0;
        break;
      case FieldMode.Impingement:
        values = impingement;
        invalid = shadowed;
        min = 0;
        max = Math.PI / 2;
        break;
      case FieldMode.FilmThickness:
        values = film.h;
        // Logarithmic, spanning 5 um to 3 mm. A linear millimetre scale is what
        // made the film look absent: the wall carries tens of microns while the
        // sump pools at millimetres, nearly three decades apart, and on a linear
        // scale everything except the pool collapses to the bottom swatch.
        min = 5e-6;
        max = 3e-3;
        log = true;
        break;
      case FieldMode.FilmSpeed: {
        for (let c = 0; c < nCell; c++) this.cellScratch[c] = film.speedAt(c);
        values = this.cellScratch;
        min = 1e-3;
        max = 1.5;
        log = true;
        break;
      }
      case FieldMode.Residence:
        values = film.residenceTime;
        min = 0;
        max = 60;
        break;
      case FieldMode.ImpactVolume: {
        for (let c = 0; c < nCell; c++) {
          this.cellScratch[c] = metrics.impactVolume[c] / Math.max(1e-9, s.cellArea[c]);
        }
        values = this.cellScratch;
        min = 1e-7;
        max = Math.max(1e-5, percentile(this.cellScratch, 0.99));
        log = true;
        break;
      }
      case FieldMode.SplashOrigin: {
        for (let c = 0; c < nCell; c++) {
          this.cellScratch[c] = metrics.impactSplashed[c] / Math.max(1e-9, s.cellArea[c]);
        }
        values = this.cellScratch;
        min = 1e-8;
        max = Math.max(1e-6, percentile(this.cellScratch, 0.99));
        log = true;
        break;
      }
    }

    this.info = FixtureView.infoFor(this.mode, min, max);
    this.material.uniforms.uUseField.value = useField;
    this.material.uniforms.uFieldMin.value = min;
    this.material.uniforms.uFieldMax.value = max;
    this.material.uniforms.uFieldLog.value = log ? 1 : 0;
    this.material.uniforms.uScale.value = this.info.scale;
    if (Number.isFinite(this.info.critical)) {
      const cSi = this.info.critical / this.info.toDisplay;
      this.material.uniforms.uCriticalT.value = log
        ? (Math.log(Math.max(cSi, 1e-12)) - Math.log(Math.max(min, 1e-12))) /
          Math.max(1e-6, Math.log(Math.max(max, 1e-12)) - Math.log(Math.max(min, 1e-12)))
        : (cSi - min) / Math.max(1e-9, max - min);
    } else {
      this.material.uniforms.uCriticalT.value = 2;
    }

    this.scatter(values, invalid);
  }

  static infoFor(mode: FieldMode, min: number, max: number): FieldInfo {
    switch (mode) {
      case FieldMode.Liquid:
        return {
          label: 'Liquid',
          unit: '',
          scale: ColorScale.Film,
          min: 0,
          max: 1,
          critical: Number.NaN,
          toDisplay: 1,
          log: false,
          description:
            'The fixture as it would look. Wet glaze goes darker and glossier, the ' +
            'film surface tilts the reflection where it varies in thickness, and ' +
            'standing liquid takes on a tint with depth. Switch to Film thickness ' +
            'for the numbers behind it.',
        };
      case FieldMode.Dry:
        return {
          label: 'Dry ceramic',
          unit: '',
          scale: ColorScale.Film,
          min: 0,
          max: 1,
          critical: Number.NaN,
          toDisplay: 1,
          log: false,
          description: 'Liquid hidden, for reading the geometry on its own.',
        };
      case FieldMode.Impingement:
        return {
          label: 'Impingement angle',
          unit: '°',
          scale: ColorScale.Impingement,
          min: 0,
          max: 90,
          critical: (CRITICAL_IMPINGEMENT_ANGLE * 180) / Math.PI,
          toDisplay: 180 / Math.PI,
          log: false,
          description:
            'Angle the stream would make with the surface if it landed here. Warm is ' +
            'over the 30° criterion and will throw a corona. Grey is shadowed — the ' +
            'stream cannot reach it in a straight line.',
        };
      case FieldMode.FilmThickness:
        return {
          label: 'Film thickness',
          unit: 'µm',
          scale: ColorScale.Film,
          min: min * 1e6,
          max: max * 1e6,
          critical: Number.NaN,
          toDisplay: 1e6,
          log: true,
          description:
            'Logarithmic, because the wall carries tens of microns while the sump ' +
            'pools at millimetres. Deep patches that persist after the stream stops ' +
            'are where the design accumulates.',
        };
      case FieldMode.FilmSpeed:
        return {
          label: 'Film speed',
          unit: 'm/s',
          scale: ColorScale.Magnitude,
          min,
          max,
          critical: Number.NaN,
          toDisplay: 1,
          log: true,
          description:
            'How fast the wall film is moving. Dark wetted areas are stagnant: ' +
            'liquid sitting still, which is where scale and odour develop.',
        };
      case FieldMode.Residence:
        return {
          label: 'Residence time',
          unit: 's',
          scale: ColorScale.Residence,
          min,
          max,
          critical: Number.NaN,
          toDisplay: 1,
          log: false,
          description:
            'How long each spot stayed wet over the run. The direct predictor of ' +
            'uric acid scale.',
        };
      case FieldMode.ImpactVolume:
        return {
          label: 'Arriving liquid',
          unit: 'mm³/mm²',
          scale: ColorScale.Splash,
          min: min * 1000,
          max: max * 1000,
          critical: Number.NaN,
          toDisplay: 1000,
          log: true,
          description: 'Where the stream and its droplets actually landed, per unit area.',
        };
      case FieldMode.SplashOrigin:
      default:
        return {
          label: 'Splash origin',
          unit: 'mm³/mm²',
          scale: ColorScale.Splash,
          min: min * 1000,
          max: max * 1000,
          critical: Number.NaN,
          toDisplay: 1000,
          log: true,
          description:
            'Where ejected liquid came from. Usually a small patch — fix that patch ' +
            'and most of the splashback goes with it.',
        };
    }
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material.dispose();
  }
}

/** Value at a given quantile, ignoring zeros. Robust colour bounds. */
function percentile(values: Float64Array, q: number): number {
  const nz: number[] = [];
  for (let i = 0; i < values.length; i++) if (values[i] > 0) nz.push(values[i]);
  if (nz.length === 0) return 0;
  nz.sort((a, b) => a - b);
  return nz[Math.min(nz.length - 1, Math.floor(q * nz.length))];
}
