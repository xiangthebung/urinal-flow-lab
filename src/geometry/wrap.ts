import { Profile } from './profile';

/**
 * How far forward the side edges of the section stand, along the profile.
 *
 * This is the parameter that decides whether the fixture is an enclosed bowl or an
 * open scoop, and it took three wrong answers to get right, so the reasoning is
 * recorded here rather than spread across the surface builder.
 *
 * The wrap must be full at the rim, because that is what makes the section a U and
 * gives splash only the front opening to leave through. It must be zero from the
 * sump onward: the sump floor is horizontal, so a forward displacement there points
 * the same way the profile does and collapses the cells, and the front rise must
 * not carry side walls of its own or its outer corners stand forward of the lip.
 *
 * Getting from one to the other is the hard part, because the side edges sit `wrap`
 * ahead of the centreline: wherever the wrap falls away, the edges move backward in
 * z while the profile is still moving forward, and where those two motions cancel a
 * cell loses its extent along v and degenerates. Three attempts:
 *
 *   - Scaling by the vertical component of the profile tangent. Zero on the sump
 *     floor as required, but it collapses over the couple of centimetres where the
 *     throat swings from vertical to horizontal, which is precisely where the
 *     cancellation bites. Measured 2.1 mm of v-extent against a nominal 4.4 mm.
 *   - Adding a fade in v past the sump on top of it. Fixed the front rise and left
 *     the throat collapse untouched, and an early version reached back far enough
 *     to thin the throat itself, which dropped the settled depth of a standing pool
 *     by 28%.
 *   - Bounding the slope against arclength. Removed the flipped normals and then
 *     fought the tangent factor, holding the wrap open across the sump floor and
 *     degenerating more cells than it saved.
 *
 * What works is to stop composing mechanisms and use one: fade the wrap out over a
 * generous arclength that *ends before the sump*. By the time the profile turns
 * horizontal the wrap is already zero, so there is nothing left to cancel, the
 * floor and the front rise get none for free, and the gradient is set by a distance
 * chosen for the purpose rather than by however fast the throat happens to curve.
 */

export interface WrapOptions {
  /** Forward stand-off of the side edges at the rim, m. */
  depth: number;
  /** How quickly the stand-off decays down the profile. */
  decay: number;
  /**
   * Arclength before the sump low point at which the wrap has already reached
   * zero, m. Keeps the collapse clear of the horizontal floor.
   */
  clearance: number;
  /** Arclength over which the wrap fades to zero, m. */
  fadeLength: number;
  /** Smoothing passes. */
  smoothPasses: number;
}

export function defaultWrapOptions(): Omit<WrapOptions, 'depth' | 'decay'> {
  return { clearance: 0.02, fadeLength: 0.085, smoothPasses: 8 };
}

/**
 * Wrap stand-off at every profile sample.
 *
 * `sumpIndex` is the sample the fade is measured back from; `count` is the number
 * of samples, normally nv + 1.
 */
export function buildWrapProfile(
  profile: Profile,
  sumpIndex: number,
  count: number,
  opts: WrapOptions
): Float64Array {
  const raw = new Float64Array(count);
  const arc = profile.arclength;
  const last = arc.length - 1;
  const sumpArc = arc[Math.min(last, Math.max(0, sumpIndex))];
  const decay = Math.max(0.1, opts.decay);
  const fade = Math.max(1e-4, opts.fadeLength);

  for (let j = 0; j < count; j++) {
    const v = count > 1 ? j / (count - 1) : 0;
    // Distance still to go before the wrap must be gone. Negative past that point.
    const remaining = sumpArc - opts.clearance - arc[Math.min(last, j)];
    const q = Math.min(1, Math.max(0, remaining / fade));
    const ramp = q * q * (3 - 2 * q);
    raw[j] = opts.depth * Math.pow(Math.max(0, 1 - v), decay) * ramp;
  }

  // Endpoints held: the rim keeps its full wrap and the lip its zero.
  const tmp = new Float64Array(count);
  for (let pass = 0; pass < opts.smoothPasses; pass++) {
    tmp[0] = raw[0];
    tmp[count - 1] = raw[count - 1];
    for (let j = 1; j < count - 1; j++) {
      tmp[j] = 0.25 * raw[j - 1] + 0.5 * raw[j] + 0.25 * raw[j + 1];
    }
    raw.set(tmp);
  }
  return raw;
}
