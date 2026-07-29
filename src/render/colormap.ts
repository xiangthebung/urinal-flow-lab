/**
 * Colour scales, shared between the GPU (fixture surface) and the CPU (2-D heat
 * maps and legends).
 *
 * The stop lists below are the single source of truth: the CPU sampler reads them
 * directly and the GLSL is generated from them at module load. That matters
 * because a legend that disagrees with the surface it labels is worse than no
 * legend at all, and two hand-maintained copies of the same gradient will drift.
 *
 * The impingement scale is deliberately not a smooth gradient. The ~30 degree
 * criterion is a threshold, not a preference, so the scale breaks hard there:
 * everything acceptable reads cool, everything over the line reads hot, and there
 * is no ambiguous middle to squint at.
 */

export const enum ColorScale {
  /** Film thickness: dry to deep. */
  Film = 0,
  /** Impingement angle, hard break at the critical value. */
  Impingement = 1,
  /** Residence time / scale risk. */
  Residence = 2,
  /** Generic magnitude, perceptually uniform. */
  Magnitude = 3,
  /** Splash intensity. */
  Splash = 4,
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const rgb = (r: number, g: number, b: number): Rgb => ({ r, g, b });

/** Six-stop approximations. Enough fidelity for a legend, cheap on the GPU. */
const VIRIDIS: Rgb[] = [
  rgb(0.267, 0.005, 0.329),
  rgb(0.254, 0.265, 0.53),
  rgb(0.164, 0.471, 0.558),
  rgb(0.135, 0.659, 0.518),
  rgb(0.478, 0.821, 0.318),
  rgb(0.993, 0.906, 0.144),
];

const INFERNO: Rgb[] = [
  rgb(0.001, 0.0, 0.014),
  rgb(0.229, 0.05, 0.322),
  rgb(0.472, 0.11, 0.428),
  rgb(0.736, 0.216, 0.33),
  rgb(0.955, 0.49, 0.084),
  rgb(0.988, 0.998, 0.645),
];

const SPLASH: Rgb[] = [
  rgb(0.05, 0.08, 0.13),
  rgb(0.11, 0.27, 0.45),
  rgb(0.22, 0.55, 0.71),
  rgb(0.72, 0.72, 0.45),
  rgb(0.95, 0.42, 0.21),
  rgb(1.0, 0.15, 0.15),
];

/** Impingement, below the criterion. */
const IMP_OK: [Rgb, Rgb] = [rgb(0.05, 0.35, 0.42), rgb(0.45, 0.85, 0.7)];
/** Impingement, above the criterion. */
const IMP_BAD: [Rgb, Rgb] = [rgb(1.0, 0.72, 0.2), rgb(0.82, 0.06, 0.12)];

/** Grey used for surfaces the stream cannot reach. */
export const SHADOWED: Rgb = rgb(0.34, 0.35, 0.38);

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
});

/**
 * Successive-mix ramp.
 *
 * Written as a chain of mixes with clamped weights rather than as an indexed
 * lookup, because the GPU side has to run under GLSL ES 1.00 where arrays cannot
 * be indexed by a computed value and `min` has no integer overload. Using the same
 * formulation on both sides keeps them provably identical instead of merely
 * similar.
 */
const ramp = (stops: Rgb[], t: number): Rgb => {
  const n = stops.length - 1;
  const x = clamp01(t) * n;
  let out = stops[0];
  for (let i = 0; i < n; i++) {
    out = mix(out, stops[i + 1], clamp01(x - i));
  }
  return out;
};

/**
 * Map a normalised value to a colour.
 * `t` is expected in [0, 1]; the Impingement scale additionally needs
 * `criticalT`, the normalised position of the threshold.
 */
export function sample(scale: ColorScale, t: number, criticalT = 0.5): Rgb {
  switch (scale) {
    case ColorScale.Film:
      return ramp(VIRIDIS, t);
    case ColorScale.Residence:
      return ramp(INFERNO, t);
    case ColorScale.Splash:
      return ramp(SPLASH, t);
    case ColorScale.Impingement: {
      if (t <= criticalT) {
        const k = criticalT > 1e-6 ? t / criticalT : 0;
        return mix(IMP_OK[0], IMP_OK[1], clamp01(k));
      }
      const k = clamp01((t - criticalT) / Math.max(1e-6, 1 - criticalT));
      return mix(IMP_BAD[0], IMP_BAD[1], k);
    }
    case ColorScale.Magnitude:
    default:
      return ramp(VIRIDIS, t);
  }
}

export const toCss = (c: Rgb): string =>
  `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;

// ---------------------------------------------------------------------------
// GLSL generation
// ---------------------------------------------------------------------------

const glslVec3 = (c: Rgb): string =>
  `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;

/** Emit a ramp function with the stops inlined as literals. */
function glslRamp(name: string, stops: Rgb[]): string {
  const n = stops.length - 1;
  let body = `  float x = clamp(t, 0.0, 1.0) * ${n.toFixed(1)};\n`;
  body += `  vec3 c = ${glslVec3(stops[0])};\n`;
  for (let i = 0; i < n; i++) {
    body += `  c = mix(c, ${glslVec3(stops[i + 1])}, clamp(x - ${i.toFixed(1)}, 0.0, 1.0));\n`;
  }
  body += '  return c;\n';
  return `vec3 ${name}(float t) {\n${body}}\n`;
}

/**
 * The GPU half of the colour scales.
 *
 * Constrained to GLSL ES 1.00: no integer `min`, no dynamically indexed arrays, no
 * array function parameters. Those all work on some drivers and fail on others,
 * which is the worst possible failure mode for a shader -- it would render
 * correctly on the machine it was written on and produce a black viewport
 * elsewhere.
 */
export const COLORMAP_GLSL = /* glsl */ `
${glslRamp('viridis', VIRIDIS)}
${glslRamp('inferno', INFERNO)}
${glslRamp('splashMap', SPLASH)}

// Hard break at the criterion: cool if it passes, warm if it does not.
vec3 impingementMap(float t, float criticalT) {
  if (t <= criticalT) {
    float k = criticalT > 1.0e-6 ? t / criticalT : 0.0;
    return mix(${glslVec3(IMP_OK[0])}, ${glslVec3(IMP_OK[1])}, clamp(k, 0.0, 1.0));
  }
  float k = clamp((t - criticalT) / max(1.0e-6, 1.0 - criticalT), 0.0, 1.0);
  return mix(${glslVec3(IMP_BAD[0])}, ${glslVec3(IMP_BAD[1])}, k);
}

vec3 colorScale(int scale, float t, float criticalT) {
  if (scale == 1) return impingementMap(t, criticalT);
  if (scale == 2) return inferno(t);
  if (scale == 4) return splashMap(t);
  return viridis(t);
}
`;
