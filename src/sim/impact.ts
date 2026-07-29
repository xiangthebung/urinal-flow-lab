import {
  DRY_SPLASH_K_SMOOTH,
  WET_SPLASH_K_BASE,
  WET_SPLASH_K_FILM,
  WET_SPLASH_K_FILM_EXP,
} from '../core/constants';
import { FluidProperties, ohnesorge, reynolds, weber } from '../core/fluid';
import { WallMaterial } from '../core/fluid';
import { Rng } from '../core/rng';
import { Vec3, clamp, smoothstep, v3 } from '../core/vec3';
import { UrinalSurface } from '../geometry/surface';
import { ImpactEvent, ParticleSystem } from './particles';

/**
 * What happens when liquid meets the wall.
 *
 * This is the model the whole tool turns on, so it is worth being explicit about
 * the mechanism it encodes. Splashing is driven by the component of velocity
 * *normal* to the surface, not by the speed. The tangential component slides
 * along the wall and mostly stays there; only the normal component has to be
 * turned around, and it is that reversal that inflates a corona and pinches
 * droplets off its rim.
 *
 * Everything the designer cares about follows from that one fact. Striking the
 * wall at angle alpha to the surface gives a normal velocity v*sin(alpha), so the
 * normal Weber number carries a sin^2(alpha): halve the angle and the driving
 * parameter falls roughly fourfold. Working the standard wetted-wall threshold
 * backwards for a real urine stream on a real film puts the no-splash angle in
 * the mid-twenties of degrees, and at 30 degrees the impact sits only marginally
 * above threshold. That is the same conclusion the recent splash-free urinal work
 * reaches experimentally, arrived at here from correlations that know nothing
 * about urinals -- which is the main reason to trust it.
 *
 * The second lever is coherence. An intact jet spreads into a steady attached
 * sheet and throws very little back; a train of droplets fires a corona off every
 * single arrival. So breakup length matters as much as wall angle.
 */

export const enum ImpactRegime {
  /** Merged into the film. */
  Deposit = 0,
  /** Corona on a dry or barely wetted wall. */
  PromptSplash = 1,
  /** Crown thrown from an established film. */
  CrownSplash = 2,
  /** Bounced off without wetting. Only on strongly non-wetting walls. */
  Rebound = 3,
}

export const REGIME_NAMES = ['deposit', 'prompt splash', 'crown splash', 'rebound'];

export interface ImpactModelParams {
  /**
   * Splash threshold for a dry wall, in the Mundo group K = We^0.5 Re^0.25.
   * 57.7 is the published transition. Roughness lowers it, because surface
   * asperities trip the corona early; a very smooth fired glaze raises it.
   */
  dryCriticalK: number;
  /**
   * How much less a coherent jet splashes than a droplet train of the same
   * momentum. This is the one frankly empirical factor in the model. The
   * mechanism is real and well documented -- a steady jet feeds an attached
   * lamella rather than re-inflating a corona on every impact -- but there is no
   * clean correlation for the magnitude, so it is exposed as a dial with a
   * default that reproduces the roughly order-of-magnitude reduction seen in
   * high-speed footage of jets versus droplet trains.
   */
  jetSplashAttenuation: number;
  /** Ceiling on the fraction of an impact's mass that can be ejected. */
  maxSplashFraction: number;
  /** How fast the splashed fraction rises once past threshold. */
  splashGrowthRate: number;
  /**
   * Fraction of tangential momentum the liquid keeps on impact. High, because
   * tangential motion is only opposed by wall shear over a very short contact
   * time. This is what makes a grazing impact run down the wall instead of
   * bouncing out, and it is the difference between a stream that "sticks and
   * flattens" and one that behaves like a ball.
   */
  tangentialRetention: number;
  /** Deepest splash generation tracked. Beyond this, mass simply deposits. */
  maxGeneration: number;
  /** Geometric spread of the secondary droplet sizes. */
  secondarySizeSpread: number;
  /** Allow rebound on non-wetting walls. */
  enableRebound: boolean;
  /** Cap on secondary droplets per event, to bound cost. */
  maxSecondaries: number;
}

export function defaultImpactParams(): ImpactModelParams {
  return {
    dryCriticalK: DRY_SPLASH_K_SMOOTH,
    jetSplashAttenuation: 0.12,
    maxSplashFraction: 0.7,
    splashGrowthRate: 0.55,
    tangentialRetention: 0.75,
    maxGeneration: 3,
    secondarySizeSpread: 1.35,
    enableRebound: true,
    maxSecondaries: 10,
  };
}

/** Where deposited liquid goes. Implemented by the film solver. */
export interface FilmSink {
  /**
   * Add liquid to a cell with a tangential velocity expressed in that cell's
   * own (u, v) tangent frame.
   */
  deposit(cell: number, volume: number, velU: number, velV: number): void;
  /** Current film thickness at a cell, m. */
  thicknessAt(cell: number): number;
}

export interface ImpactDiagnostics {
  regime: ImpactRegime;
  /** Angle between the arriving velocity and the surface, radians. */
  impingementAngle: number;
  /** Weber number on the normal velocity component. */
  weberNormal: number;
  /** Dimensionless film thickness, h / d. */
  filmRatio: number;
  /** How far past the splash threshold this impact sits. 1 = exactly at it. */
  thresholdRatio: number;
  splashedFraction: number;
  secondaryCount: number;
  /**
   * Angle below which this exact impact would not have splashed, radians.
   * Computed by inverting the threshold, so it reflects the local film, fluid
   * and droplet size rather than a quoted rule of thumb.
   */
  criticalAngle: number;
}

export interface ImpactTotals {
  depositedVolume: number;
  splashedVolume: number;
  reboundedVolume: number;
  events: number;
  splashEvents: number;
  /** Volume lost to the particle buffer being full, m^3. */
  droppedVolume: number;
}

/**
 * Resolves impacts against the wall, feeding the film and spawning secondaries.
 */
export class ImpactResolver {
  params: ImpactModelParams;
  fluid: FluidProperties;
  wall: WallMaterial;
  private rng: Rng;

  /** Last event's diagnostics, for UI inspection. */
  last: ImpactDiagnostics | null = null;
  totals: ImpactTotals = {
    depositedVolume: 0,
    splashedVolume: 0,
    reboundedVolume: 0,
    events: 0,
    splashEvents: 0,
    droppedVolume: 0,
  };

  constructor(
    params: ImpactModelParams,
    fluid: FluidProperties,
    wall: WallMaterial,
    rng: Rng
  ) {
    this.params = params;
    this.fluid = fluid;
    this.wall = wall;
    this.rng = rng;
  }

  resetTotals(): void {
    this.totals = {
      depositedVolume: 0,
      splashedVolume: 0,
      reboundedVolume: 0,
      events: 0,
      splashEvents: 0,
      droppedVolume: 0,
    };
  }

  /**
   * Public probe of the splash threshold for given conditions.
   *
   * Exposed so the threshold can be checked independently of a running
   * simulation, and so the reported "angle below which this would not splash" can
   * be verified to actually be the angle at which the threshold ratio reaches 1.
   * A splash model whose stated threshold disagrees with its own behaviour is the
   * kind of error that is invisible in the output.
   */
  probeThreshold(
    speed: number,
    impingementAngle: number,
    diameter: number,
    filmThickness: number
  ): { ratio: number; criticalAngle: number; weberNormal: number; filmRatio: number } {
    const vNormal = speed * Math.sin(impingementAngle);
    const th = this.thresholdRatio(vNormal, diameter, filmThickness);
    return {
      ratio: th.ratio,
      criticalAngle: this.criticalAngleFor(speed, impingementAngle, th.ratio, th.filmRatio),
      weberNormal: th.weberNormal,
      filmRatio: th.filmRatio,
    };
  }

  /** Effective wall contact angle, radians. */
  private contactAngle(): number {
    return Math.min(
      Math.PI * 0.98,
      this.fluid.contactAngleAdvancing * this.wall.contactAngleScale
    );
  }

  /**
   * Splash threshold, returned as the ratio K / K_crit so the dry and wetted
   * correlations can be compared on one scale.
   *
   * Two regimes with different groups:
   *  - Dry or barely wetted: Mundo's K = We^0.5 Re^0.25 against ~57.7.
   *  - Established film: Cossali's K = We Oh^-0.4 against 2100 + 5880 delta^1.44.
   *
   * They are blended smoothly across delta rather than switched between. A
   * urinal is dry for the first fraction of a second of use and wet thereafter,
   * so a hard switch would put a step discontinuity right in the middle of the
   * event being measured, and the splash rate would jump for a purely numerical
   * reason.
   */
  private thresholdRatio(
    vNormal: number,
    diameter: number,
    filmThickness: number
  ): { ratio: number; filmRatio: number; weberNormal: number } {
    const f = this.fluid;
    const weN = weber(f, vNormal, diameter);
    const reN = reynolds(f, vNormal, diameter);
    const oh = ohnesorge(f, diameter);
    const delta = filmThickness / Math.max(1e-9, diameter);

    // Dry branch. Roughness relative to the droplet sets the correction: an
    // asperity comparable to the lamella thickness is what trips the corona.
    const roughRatio = this.wall.roughness / Math.max(1e-9, diameter);
    const dryK = Math.sqrt(weN) * Math.pow(Math.max(1e-9, reN), 0.25);
    const dryCrit =
      this.params.dryCriticalK * clamp(1 / (1 + 900 * roughRatio), 0.45, 1.6);
    const dryRatio = dryK / Math.max(1e-9, dryCrit);

    // Wetted branch.
    const wetK = weN * Math.pow(Math.max(1e-12, oh), -0.4);
    const wetCrit =
      WET_SPLASH_K_BASE +
      WET_SPLASH_K_FILM * Math.pow(Math.max(0, delta), WET_SPLASH_K_FILM_EXP);
    const wetRatio = wetK / Math.max(1e-9, wetCrit);

    // Blend: fully dry below delta = 0.005, fully wetted above 0.05.
    const w = smoothstep(0.005, 0.05, delta);
    return {
      ratio: dryRatio * (1 - w) + wetRatio * w,
      filmRatio: delta,
      weberNormal: weN,
    };
  }

  /**
   * Angle below which this impact would not splash, by inverting the threshold.
   *
   * Both thresholds scale the driving parameter as a power of the normal
   * velocity, and the normal velocity carries sin(alpha), so the inversion is
   * analytic once the exponent is known: the wetted branch goes as sin^2 and the
   * dry branch as sin^1.25. Reporting this per impact is more useful than
   * quoting a single figure, because it moves with flow rate, droplet size and
   * how wet the wall already is.
   */
  private criticalAngleFor(
    speed: number,
    alpha: number,
    ratio: number,
    filmRatio: number
  ): number {
    if (ratio <= 1e-9 || speed <= 1e-9) return Math.PI / 2;
    const wetWeight = smoothstep(0.005, 0.05, filmRatio);
    const exponent = 1.25 * (1 - wetWeight) + 2.0 * wetWeight;
    const sinAlpha = Math.sin(Math.max(1e-6, alpha));
    // ratio ∝ sin(alpha)^exponent  =>  sin(critical) = sin(alpha) * ratio^(-1/e)
    const sinCrit = sinAlpha * Math.pow(ratio, -1 / exponent);
    return Math.asin(clamp(sinCrit, 0, 1));
  }

  /**
   * Resolve one impact. The particle is always consumed: its volume either joins
   * the film, leaves as secondary droplets, or rebounds as a single droplet.
   */
  resolve(
    ev: ImpactEvent,
    surface: UrinalSurface,
    particles: ParticleSystem,
    film: FilmSink
  ): void {
    const cell = ev.hit.cell;
    const n = surface.getCellNormal(cell, v3());
    const f = this.fluid;

    // -- Decompose the arriving velocity -----------------------------------
    const vDotN = ev.velocity.x * n.x + ev.velocity.y * n.y + ev.velocity.z * n.z;
    // Approaching the wall means moving against the inward normal.
    const vNormal = Math.max(0, -vDotN);
    const vtX = ev.velocity.x - vDotN * n.x;
    const vtY = ev.velocity.y - vDotN * n.y;
    const vtZ = ev.velocity.z - vDotN * n.z;
    const vTanMag = Math.hypot(vtX, vtY, vtZ);
    const speed = Math.hypot(ev.velocity.x, ev.velocity.y, ev.velocity.z);
    const alpha = Math.atan2(vNormal, Math.max(1e-9, vTanMag));

    const hFilm = film.thicknessAt(cell);
    const d = Math.max(1e-6, ev.diameter);
    const th = this.thresholdRatio(vNormal, d, hFilm);
    let ratio = th.ratio;

    // An intact jet feeds an attached sheet instead of re-inflating a corona on
    // every arrival, so its effective drive toward splashing is much lower.
    if (ev.coherent) ratio *= this.params.jetSplashAttenuation;

    this.totals.events++;

    // -- Rebound check ------------------------------------------------------
    // Only meaningful on a non-wetting wall and only at low Weber number. Worth
    // modelling because superhydrophobic coatings get proposed as a splash fix,
    // and this is where the tool can show that they are not one: a droplet that
    // refuses to wet keeps its momentum and leaves, which is the opposite of
    // what is wanted.
    const theta = this.contactAngle();
    const weTotal = weber(f, speed, d);
    if (
      this.params.enableRebound &&
      !ev.coherent &&
      theta > Math.PI / 2 &&
      weTotal < 5 + 25 * (theta / Math.PI) &&
      hFilm < 0.2 * d
    ) {
      this.reboundParticle(ev, particles, n, vDotN, d);
      return;
    }

    // -- Splashed fraction --------------------------------------------------
    let splashFraction = 0;
    if (ratio > 1) {
      splashFraction =
        this.params.maxSplashFraction *
        (1 - Math.exp(-this.params.splashGrowthRate * (ratio - 1)));
    }
    if (ev.generation >= this.params.maxGeneration) splashFraction = 0;

    const regime: ImpactRegime =
      splashFraction <= 0
        ? ImpactRegime.Deposit
        : th.filmRatio > 0.05
          ? ImpactRegime.CrownSplash
          : ImpactRegime.PromptSplash;

    const splashVolume = ev.volume * splashFraction;
    const depositVolume = ev.volume - splashVolume;

    // -- Deposit -------------------------------------------------------------
    // Deposited liquid arrives with most of its tangential momentum intact. This
    // is what produces the fast radial lamella at the impact point and, on a
    // flat wall, the ring where it decelerates into a visibly thicker film -- a
    // hydraulic jump. Neither is scripted; both fall out of injecting tangential
    // momentum into a shallow-water film.
    const kt = this.params.tangentialRetention;
    const tu = surface.cellTangentU;
    const tv = surface.cellTangentV;
    const o = cell * 3;
    const velU = (vtX * tu[o] + vtY * tu[o + 1] + vtZ * tu[o + 2]) * kt;
    const velV = (vtX * tv[o] + vtY * tv[o + 1] + vtZ * tv[o + 2]) * kt;
    if (depositVolume > 0) film.deposit(cell, depositVolume, velU, velV);
    this.totals.depositedVolume += depositVolume;

    // -- Secondaries --------------------------------------------------------
    let secondaryCount = 0;
    if (splashVolume > 0) {
      secondaryCount = this.emitSecondaries(
        ev,
        surface,
        particles,
        film,
        cell,
        n,
        { x: vtX, y: vtY, z: vtZ },
        vTanMag,
        vNormal,
        speed,
        d,
        splashVolume,
        alpha
      );
      this.totals.splashedVolume += splashVolume;
      this.totals.splashEvents++;
    }

    this.last = {
      regime,
      impingementAngle: alpha,
      weberNormal: th.weberNormal,
      filmRatio: th.filmRatio,
      thresholdRatio: ratio,
      splashedFraction: splashFraction,
      secondaryCount,
      criticalAngle: this.criticalAngleFor(speed, alpha, ratio, th.filmRatio),
    };

    particles.kill(ev.index);
  }

  private reboundParticle(
    ev: ImpactEvent,
    particles: ParticleSystem,
    n: Vec3,
    vDotN: number,
    d: number
  ): void {
    // Restitution from the contact angle: a more non-wetting surface returns
    // more of the normal momentum. Tangential motion is barely affected.
    const theta = this.contactAngle();
    const e = clamp(0.35 * (theta / Math.PI) * 2, 0.05, 0.85);
    const vx = ev.velocity.x - (1 + e) * vDotN * n.x;
    const vy = ev.velocity.y - (1 + e) * vDotN * n.y;
    const vz = ev.velocity.z - (1 + e) * vDotN * n.z;
    const off = 0.5 * d + 2e-4;
    const idx = particles.spawnDroplet(
      v3(
        ev.hit.point.x + n.x * off,
        ev.hit.point.y + n.y * off,
        ev.hit.point.z + n.z * off
      ),
      v3(vx, vy, vz),
      d,
      ev.volume,
      ev.generation + 1
    );
    if (idx < 0) this.totals.droppedVolume += ev.volume;
    this.totals.reboundedVolume += ev.volume;
    this.last = {
      regime: ImpactRegime.Rebound,
      impingementAngle: Math.asin(
        clamp(
          -vDotN / Math.max(1e-9, Math.hypot(ev.velocity.x, ev.velocity.y, ev.velocity.z)),
          0,
          1
        )
      ),
      weberNormal: weber(this.fluid, Math.abs(vDotN), d),
      filmRatio: 0,
      thresholdRatio: 0,
      splashedFraction: 0,
      secondaryCount: 1,
      criticalAngle: Math.PI / 2,
    };
    particles.kill(ev.index);
  }

  /**
   * Throw secondary droplets off an impact.
   *
   * Direction is the part that decides splashback, so it is built rather than
   * randomised. Each droplet leaves on a cone about the *downstream* tangential
   * direction -- the way the liquid was already sliding -- lifted off the surface
   * by an elevation that shrinks with the impingement angle, and spread in
   * azimuth by an amount that also shrinks with it.
   *
   * That double narrowing is the other half of why shallow impacts are safe.
   * A steep impact throws an axisymmetric corona, so a full half of it heads back
   * toward the user. A grazing impact throws a narrow, low fan that follows the
   * wall downward, so even the little mass that does leave is aimed into the
   * bowl. Total mass falling *and* direction turning away compound, which is why
   * the improvement from a shallower wall is so much larger than the change in
   * angle alone suggests.
   */
  private emitSecondaries(
    ev: ImpactEvent,
    surface: UrinalSurface,
    particles: ParticleSystem,
    film: FilmSink,
    cell: number,
    n: Vec3,
    vt: Vec3,
    vTanMag: number,
    vNormal: number,
    speed: number,
    d: number,
    splashVolume: number,
    alpha: number
  ): number {
    const p = this.params;
    const f = this.fluid;

    // Secondary size: finer as the impact gets more violent. The corona rim
    // thins with increasing Weber number and pinches off smaller drops.
    const weN = Math.max(1e-6, weber(f, vNormal, d));
    const sizeRatio = clamp(1.6 * Math.pow(weN, -0.25), 0.06, 0.6);
    const medianD = Math.max(2e-5, sizeRatio * d);

    const singleVol = (Math.PI / 6) * medianD ** 3;
    let count = Math.round(splashVolume / Math.max(1e-15, singleVol));
    count = Math.max(1, Math.min(p.maxSecondaries, count));
    const volEach = splashVolume / count;

    // Downstream tangential unit vector. For a dead-on normal impact there is no
    // downstream direction, so the cell's own u tangent stands in as an
    // arbitrary but consistent reference axis; the corona is axisymmetric in that
    // case anyway, because the azimuthal concentration collapses to uniform at
    // alpha = 90 deg.
    let tx: number;
    let ty: number;
    let tz: number;
    if (vTanMag > 1e-7) {
      tx = vt.x / vTanMag;
      ty = vt.y / vTanMag;
      tz = vt.z / vTanMag;
    } else {
      const o = cell * 3;
      tx = surface.cellTangentU[o];
      ty = surface.cellTangentU[o + 1];
      tz = surface.cellTangentU[o + 2];
    }

    // Elevation of the ejecta above the surface, and azimuthal concentration.
    const alphaFrac = clamp(alpha / (Math.PI / 2), 0, 1);
    const beta = clamp(0.55 * alpha + 0.105, 0.105, 1.05);
    const concentration = 1 + 5 * Math.pow(1 - alphaFrac, 1.5);

    // Build an orthonormal frame: t (downstream), n (out of wall), b = n x t.
    const bx = n.y * tz - n.z * ty;
    const by = n.z * tx - n.x * tz;
    const bz = n.x * ty - n.y * tx;
    const bm = Math.hypot(bx, by, bz) || 1;

    // Ejection speed budget: driven by the normal component that had to be
    // turned around, with the retained tangential motion added on top.
    const baseEject = 0.55 * vNormal + 0.12 * vTanMag;

    let spawned = 0;
    let ejectedKe = 0;
    const parentArea = Math.PI * d * d;
    let childArea = 0;

    const dirs: Array<{ x: number; y: number; z: number; sp: number; dd: number }> = [];
    for (let k = 0; k < count; k++) {
      const dd = clamp(
        this.rng.logNormal(medianD, p.secondarySizeSpread),
        1e-5,
        0.9 * d
      );
      // Azimuth concentrated toward the downstream direction.
      const u = this.rng.next();
      const s = u < 0.5 ? -1 : 1;
      const phi = Math.PI * s * Math.pow(Math.abs(2 * u - 1), concentration);
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);
      const cb = Math.cos(beta);
      const sb = Math.sin(beta);
      // Direction on the cone: elevation beta off the surface, azimuth phi about
      // the downstream axis.
      let ex = sb * n.x + cb * (cosPhi * tx + sinPhi * (bx / bm));
      let ey = sb * n.y + cb * (cosPhi * ty + sinPhi * (by / bm));
      let ez = sb * n.z + cb * (cosPhi * tz + sinPhi * (bz / bm));
      const em = Math.hypot(ex, ey, ez) || 1;
      ex /= em;
      ey /= em;
      ez /= em;
      const sp = Math.max(
        0.05,
        baseEject * this.rng.logNormal(1, 1.25) * (0.6 + 0.4 * Math.abs(cosPhi))
      );
      dirs.push({ x: ex, y: ey, z: ez, sp, dd });
      const vol = (Math.PI / 6) * dd ** 3;
      ejectedKe += 0.5 * f.density * vol * sp * sp;
      childArea += Math.PI * dd * dd;
    }

    // -- Energy guard --------------------------------------------------------
    // An empirical mass fraction combined with an empirical ejection speed can
    // easily produce more kinetic energy than the impact brought in. Rather than
    // hope the correlations stay consistent, the budget is enforced: outgoing
    // kinetic energy plus the surface energy of the new interface cannot exceed
    // the incoming kinetic energy. Anything over budget is scaled back. Without
    // this the model can manufacture splashback out of nothing, and the
    // manufactured amount grows exactly where the design is worst.
    const keIn = 0.5 * f.density * ev.volume * speed * speed;
    const surfaceCost = f.surfaceTension * Math.max(0, childArea - parentArea);
    const budget = Math.max(0, keIn - surfaceCost);
    let scale = 1;
    if (ejectedKe > budget && ejectedKe > 1e-18) {
      scale = Math.sqrt(budget / ejectedKe);
    }

    const off = 0.5 * medianD + 2e-4;
    const origin = v3(
      ev.hit.point.x + n.x * off,
      ev.hit.point.y + n.y * off,
      ev.hit.point.z + n.z * off
    );
    // Tangential momentum the ejecta carry along with them.
    const ktx = vt.x * 0.35;
    const kty = vt.y * 0.35;
    const ktz = vt.z * 0.35;

    for (const dr of dirs) {
      const sp = dr.sp * scale;
      const idx = particles.spawnDroplet(
        origin,
        v3(dr.x * sp + ktx, dr.y * sp + kty, dr.z * sp + ktz),
        dr.dd,
        volEach,
        ev.generation + 1
      );
      if (idx < 0) {
        // Buffer full: the liquid still exists, so it joins the film rather
        // than disappearing and quietly breaking the volume balance.
        film.deposit(cell, volEach, 0, 0);
        this.totals.droppedVolume += volEach;
      } else {
        spawned++;
      }
    }
    return spawned;
  }
}
