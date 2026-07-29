/**
 * Seeded pseudo-random number generation.
 *
 * Splash is a stochastic process: the same jet hitting the same wall throws
 * a different spray every time. That is physically true, but it makes A/B
 * comparison of two urinal geometries useless if the noise differs between
 * runs. So every stochastic draw in the simulation goes through a seeded
 * stream, which means "design A vs design B" is a controlled experiment and
 * a reported improvement is a real one rather than a lucky seed.
 *
 * Algorithm is xoshiro128** -- fast, tiny state, and passes the statistical
 * batteries that Math.random-style LCGs fail.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed = 0x9e3779b9) {
    // SplitMix32 to spread a single integer seed across the 128-bit state.
    let z = seed >>> 0;
    const next = (): number => {
      z = (z + 0x9e3779b9) >>> 0;
      let t = z;
      t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
      t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
      return (t ^ (t >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Raw 32-bit unsigned draw. */
  nextUint32(): number {
    // result = rotl(s1 * 5, 7) * 9
    let r = Math.imul(this.s1, 5) >>> 0;
    r = ((r << 7) | (r >>> 25)) >>> 0;
    r = Math.imul(r, 9) >>> 0;

    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;
    return r;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.min(n - 1, Math.floor(this.next() * n));
  }

  /** Standard normal via Box-Muller (one of the pair, cached). */
  private spare: number | null = null;
  normal(mean = 0, stdDev = 1): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return mean + stdDev * v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * mul;
    return mean + stdDev * u * mul;
  }

  /**
   * Log-normal draw specified by its *median* and geometric standard
   * deviation. Droplet size distributions from atomisation and from splash
   * are close to log-normal, and sigma_g is the natural way to state the
   * spread (sigma_g = 1 means monodisperse, 1.5 is a typical spray).
   */
  logNormal(median: number, sigmaG: number): number {
    if (sigmaG <= 1.0000001) return median;
    return median * Math.exp(this.normal(0, Math.log(sigmaG)));
  }

  /** Uniform direction on the unit sphere. */
  unitVector(): { x: number; y: number; z: number } {
    const z = this.next() * 2 - 1;
    const phi = this.next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return { x: r * Math.cos(phi), y: r * Math.sin(phi), z };
  }
}
