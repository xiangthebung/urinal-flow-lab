import * as THREE from 'three';
import { FilmSolver } from '../sim/film';
import { UrinalSurface } from '../geometry/surface';

/**
 * The solver's film state, handed to the GPU as a texture rather than as vertex
 * attributes.
 *
 * The distinction is the whole reason the wetted bowl used to read as a contour
 * map. The film lives on an nu x nv cell grid and the drawn mesh has exactly the
 * same resolution, so scattering thickness onto the vertices and letting the
 * rasteriser interpolate gives a surface that is only C0: the value is continuous
 * across a triangle edge but its *gradient* is not. Shading reads the gradient --
 * the free surface of a layer tilts by its own slope, and that tilt is what steers
 * the reflection -- so a piecewise-linear thickness field produces a
 * piecewise-constant normal, and a piecewise-constant normal over 5 mm triangles
 * draws every triangle. Turning the relief gain up to make the film visible turned
 * the triangulation up with it. That is the banding.
 *
 * A texture fixes it because it can be reconstructed with a *smooth* filter. The
 * shader samples this with a Catmull-Rom cubic, which is C1, so the gradient is
 * continuous everywhere and the analytic derivative of the same basis gives the
 * slope exactly rather than by differencing. The mesh then only has to carry the
 * shape; every liquid cue is evaluated per pixel.
 *
 * Layout, RGBA32F, one texel per cell:
 *
 *   R  thickness, micrometres     -- microns rather than metres so the numbers
 *                                    sit in a comfortable exponent range and a
 *                                    reader of a pixel dump gets a familiar unit
 *   G  film velocity along u, m/s
 *   B  film velocity along v, m/s
 *   A  fraction of the film that is voided liquid rather than flush water
 *
 * Full float rather than half. Half-float carries about eleven bits of mantissa,
 * which is ample for the value and useless for the *difference*: a 2 mm pool with
 * a one-part-in-a-thousand slope stores as two adjacent quantisation steps, and
 * the reconstructed gradient -- which is what gets shaded -- comes out as noise.
 * A still pool that sparkles is worse than one that bands. The whole grid is 93 kB
 * at the shipped resolution, so there is nothing to save by shrinking it.
 *
 * Sampled NEAREST on purpose. Every filter this surface needs is implemented in
 * the shader, and asking for LINEAR would silently require float-linear support
 * that is an extension rather than core.
 */
export class FilmField {
  texture: THREE.DataTexture;
  private data: Float32Array;
  private nu = 0;
  private nv = 0;

  constructor() {
    this.data = new Float32Array(4);
    this.texture = FilmField.makeTexture(this.data, 1, 1);
  }

  private static makeTexture(data: Float32Array, w: number, h: number): THREE.DataTexture {
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  /** Size of the grid, for the shader's texel arithmetic. */
  get size(): THREE.Vector2 {
    return new THREE.Vector2(this.nu, this.nv);
  }

  /** Reallocate for a new surface. */
  resize(surface: UrinalSurface): void {
    if (surface.nu === this.nu && surface.nv === this.nv) return;
    this.nu = surface.nu;
    this.nv = surface.nv;
    this.texture.dispose();
    this.data = new Float32Array(this.nu * this.nv * 4);
    this.texture = FilmField.makeTexture(this.data, this.nu, this.nv);
  }

  /** Copy this frame's solver state across. */
  update(film: FilmSolver): void {
    const n = this.nu * this.nv;
    const h = film.h;
    const hu = film.hu;
    const hv = film.hv;
    const hs = film.hs;
    const d = this.data;
    for (let c = 0; c < n; c++) {
      const hc = h[c];
      const o = c * 4;
      d[o] = hc * 1e6;
      if (hc > 1e-9) {
        const inv = 1 / hc;
        d[o + 1] = hu[c] * inv;
        d[o + 2] = hv[c] * inv;
        // Clamped, not just divided: the tracer is advected on the same fluxes as
        // the thickness but limited independently, so a cell that has nearly
        // drained can momentarily hold a ratio slightly outside [0, 1]. Letting
        // that through would put a Beer-Lambert exponent out of range and stamp a
        // dark or a bleached speck at the tail of the wetted region.
        const s = hs[c] * inv;
        d[o + 3] = s < 0 ? 0 : s > 1 ? 1 : s;
      } else {
        d[o + 1] = 0;
        d[o + 2] = 0;
        d[o + 3] = 0;
      }
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/**
 * The GPU half: cubic reconstruction of the film, and the sub-grid structure the
 * grid cannot hold.
 *
 * Kept beside the class that fills the texture so the layout is described once.
 */
export const FILM_GLSL = /* glsl */ `
uniform sampler2D uFilm;
uniform vec2 uFilmSize;

// -- Catmull-Rom, and its derivative ----------------------------------------
//
// Interpolating rather than approximating: a B-spline would be smoother still but
// it does not pass through the samples, so a 2 mm pool would be drawn 1.5 mm deep
// and the picture would stop agreeing with the numbers beside it.
vec4 crW(float x) {
  float x2 = x * x;
  float x3 = x2 * x;
  return 0.5 * vec4(
    -x3 + 2.0 * x2 - x,
     3.0 * x3 - 5.0 * x2 + 2.0,
    -3.0 * x3 + 4.0 * x2 + x,
     x3 - x2);
}
vec4 crD(float x) {
  float x2 = x * x;
  return 0.5 * vec4(
    -3.0 * x2 + 4.0 * x - 1.0,
     9.0 * x2 - 10.0 * x,
    -9.0 * x2 + 8.0 * x + 1.0,
     3.0 * x2 - 2.0 * x);
}

vec4 filmTexel(vec2 base, float oi, float oj) {
  vec2 c = clamp(base + vec2(oi, oj), vec2(0.0), uFilmSize - 1.0);
  return texture2D(uFilm, (c + 0.5) / uFilmSize);
}

/**
 * Film state at a parametric point, with the thickness gradient in cell-index
 * units.
 *
 * Sixteen taps, unrolled. GLSL ES 1.00 permits a loop counter as a vector index
 * and several drivers in the wild disagree, and a shader that compiles on the
 * machine it was written on and produces a black viewport elsewhere is the worst
 * failure mode available here.
 */
void sampleFilm(vec2 uv, out vec4 val, out float dhdi, out float dhdj) {
  vec2 p = uv * uFilmSize - 0.5;
  vec2 fr = fract(p);
  vec2 b = floor(p);
  vec4 wx = crW(fr.x);
  vec4 wy = crW(fr.y);
  vec4 gx = crD(fr.x);
  vec4 gy = crD(fr.y);

  vec4 c00 = filmTexel(b, -1.0, -1.0);
  vec4 c10 = filmTexel(b,  0.0, -1.0);
  vec4 c20 = filmTexel(b,  1.0, -1.0);
  vec4 c30 = filmTexel(b,  2.0, -1.0);
  vec4 c01 = filmTexel(b, -1.0,  0.0);
  vec4 c11 = filmTexel(b,  0.0,  0.0);
  vec4 c21 = filmTexel(b,  1.0,  0.0);
  vec4 c31 = filmTexel(b,  2.0,  0.0);
  vec4 c02 = filmTexel(b, -1.0,  1.0);
  vec4 c12 = filmTexel(b,  0.0,  1.0);
  vec4 c22 = filmTexel(b,  1.0,  1.0);
  vec4 c32 = filmTexel(b,  2.0,  1.0);
  vec4 c03 = filmTexel(b, -1.0,  2.0);
  vec4 c13 = filmTexel(b,  0.0,  2.0);
  vec4 c23 = filmTexel(b,  1.0,  2.0);
  vec4 c33 = filmTexel(b,  2.0,  2.0);

  vec4 r0 = wx.x * c00 + wx.y * c10 + wx.z * c20 + wx.w * c30;
  vec4 r1 = wx.x * c01 + wx.y * c11 + wx.z * c21 + wx.w * c31;
  vec4 r2 = wx.x * c02 + wx.y * c12 + wx.z * c22 + wx.w * c32;
  vec4 r3 = wx.x * c03 + wx.y * c13 + wx.z * c23 + wx.w * c33;
  val = wy.x * r0 + wy.y * r1 + wy.z * r2 + wy.w * r3;

  float d0 = gx.x * c00.x + gx.y * c10.x + gx.z * c20.x + gx.w * c30.x;
  float d1 = gx.x * c01.x + gx.y * c11.x + gx.z * c21.x + gx.w * c31.x;
  float d2 = gx.x * c02.x + gx.y * c12.x + gx.z * c22.x + gx.w * c32.x;
  float d3 = gx.x * c03.x + gx.y * c13.x + gx.z * c23.x + gx.w * c33.x;
  dhdi = wy.x * d0 + wy.y * d1 + wy.z * d2 + wy.w * d3;
  dhdj = gy.x * r0.x + gy.y * r1.x + gy.z * r2.x + gy.w * r3.x;

  // A cubic through a step overshoots, and at a contact line the step is the
  // whole film. Undershoot has to be cut off before it reaches a logarithm or a
  // square root; the overshoot on the wet side is left alone, because it is a
  // fair picture of the rim of liquid that a pinned contact line actually holds.
  val.x = max(val.x, 0.0);
  val.w = clamp(val.w, 0.0, 1.0);
}

// -- sub-grid structure ------------------------------------------------------
//
// Value noise with an analytic gradient. The gradient is the point: the rivulets
// this stands for are visible because they tilt the free surface and move the
// reflected room, not because they are painted a different colour, so the shading
// needs the slope of the pattern and not just its value. Differencing the pattern
// would cost four more evaluations and give a worse answer.
float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

/** (value, d/dx, d/dy) of a value-noise lattice. */
vec3 vnoiseD(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  float k1 = b - a;
  float k2 = c - a;
  float k3 = a - b - c + d;
  return vec3(
    a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
    du.x * (k1 + k3 * u.y),
    du.y * (k2 + k3 * u.x));
}

/**
 * The rivulet field: where liquid gathers inside a cell, and how fast it changes.
 *
 * Two octaves, both stretched along the flow. A single frequency draws a comb --
 * evenly spaced parallel lines of one width -- which is what machining looks like,
 * not what liquid does; the second octave is what makes the lanes vary in width,
 * run together and split apart. Returned as (value, d/d across, d/d along) in the
 * same units the coordinate was given in.
 */
vec3 rivuletField(vec2 q) {
  vec3 n0 = vnoiseD(q);
  // The second octave is nearly all across-flow. Halving the wavelength in both
  // directions would chop the lanes into dashes, which is what the first attempt
  // produced -- a wall of short strokes reads as lichen, not as liquid. A rivulet
  // varies in width along its length and hardly at all in whether it is there.
  vec3 n1 = vnoiseD(q * vec2(2.1, 0.7) + vec2(19.3, 7.1));
  vec3 n = n0 * 0.66 + n1 * 0.34 * vec3(1.0, 2.1, 0.7);
  // Ridged: the lanes are where the field crosses its own midline, which gives a
  // branching, wandering set of curves rather than a set of blobs. |.| is not
  // differentiable at the crossing, and that is correct -- a rivulet has a crest.
  float s = n.x * 2.0 - 1.0;
  float sgn = s < 0.0 ? -1.0 : 1.0;
  return vec3(1.0 - abs(s), -sgn * 2.0 * n.y, -sgn * 2.0 * n.z);
}
`;
