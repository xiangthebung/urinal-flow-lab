import { AIR_DENSITY, AIR_VISCOSITY, GRAVITY } from '../core/constants';
import { FluidProperties, dropletDragCoefficient } from '../core/fluid';
import { Vec3, v3 } from '../core/vec3';
import { SolidCollider } from '../geometry/collider';
import { SurfaceHit, UrinalSurface } from '../geometry/surface';
import { CaptureZone } from './capture';
import { EmittedParcel } from './stream';

/**
 * The airborne liquid: the coherent jet, the droplet train it breaks into, and
 * every secondary droplet thrown off an impact.
 *
 * Stored as a struct of arrays in typed buffers. A splash event can spawn a
 * dozen secondaries and a full void produces hundreds of thousands of parcels,
 * so per-particle objects would spend more time in allocation and cache misses
 * than in physics.
 */

/** Bit flags packed into the `flags` array. */
export const enum PFlag {
  Alive = 1 << 0,
  /** Still part of the coherent, unbroken jet. */
  Coherent = 1 << 1,
  /** Produced by a wall impact rather than by the emitter. */
  Secondary = 1 << 2,
  /** A satellite droplet from Rayleigh breakup. */
  Satellite = 1 << 3,
}

// A `PEnd` enum -- StillAlive / HitSurface / Captured / OutOfBounds / TooSlow,
// commented "why a particle left the simulation, for accounting" -- used to stand
// here. Nothing in the project ever referenced it: no particle was ever tagged
// with one, no total was ever kept per cause, and the accounting it named is done
// elsewhere, by volume rather than by cause. Removed rather than wired up, because
// the volume balance already closes at 0.0000% without it and a per-cause count
// that agreed with nothing would be a second source of truth. If a cause breakdown
// is ever wanted, it has to be added to the closure sum on the same day (Trap 24).

export interface ImpactEvent {
  index: number;
  hit: SurfaceHit;
  /** Velocity at the moment of impact, m/s. */
  velocity: Vec3;
  /** Volume carried, m^3. */
  volume: number;
  /** Diameter driving the impact physics, m. */
  diameter: number;
  /** True if this arrived as an unbroken jet rather than as a droplet. */
  coherent: boolean;
  /** How many splash generations deep this particle is. 0 = from the stream. */
  generation: number;
}

export interface CaptureEvent {
  index: number;
  from: Vec3;
  /** Where it landed. */
  to: Vec3;
  velocity: Vec3;
  volume: number;
  diameter: number;
  generation: number;
  coherent: boolean;
  /** Which capture zone absorbed it. */
  zone: number;
  /**
   * Surface normal where it landed, for solid captures only.
   *
   * Present when the capture was a real surface -- currently the casting
   * exterior -- and absent for the abstract zone rectangles. It is here because
   * the outside of the fixture is ceramic and splashes; without a normal the
   * impact model has no frame to throw a corona in, and the exterior was
   * therefore a perfect absorber that could swallow an entire void.
   */
  normal?: Vec3;
}

/**
 * Tests a swept segment against everything that is not the fixture: the floor,
 * the user, the room. Implemented by the metrics layer; the particle system only
 * needs to know whether the segment ended somewhere and how far along.
 */
export interface CaptureTester {
  /** Returns the fraction along [from, to] where capture happened, or -1. */
  test(from: Vec3, to: Vec3, out: { t: number; zone: number }): boolean;
}

/**
 * A satellite drop pinched off the thread between two main drops.
 *
 * Emitted as a request rather than spawned inside the integration loop, so that
 * allocating a slot cannot change how many particles that same loop visits. The
 * caller spawns them immediately afterwards, which costs the satellite one step
 * of flight -- a millimetre or two -- and keeps the sweep deterministic.
 */
export interface SatelliteSplit {
  position: Vec3;
  velocity: Vec3;
  volume: number;
  diameter: number;
}

export interface ParticleStepResult {
  impacts: ImpactEvent[];
  captures: CaptureEvent[];
  /** Satellite drops pinched off this step, for the caller to spawn. */
  satellites: SatelliteSplit[];
  /** Volume that had to be dropped because the buffer was full, m^3. */
  overflowVolume: number;
}

export class ParticleSystem {
  readonly capacity: number;

  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  /** Diameter used for drag and impact physics, m. */
  readonly diameter: Float32Array;
  /** Volume carried, m^3. */
  readonly volume: Float32Array;
  /** Diameter of the parent jet, m. Meaningful while Coherent is set. */
  readonly jetDiameter: Float32Array;
  /** Seconds remaining until Rayleigh pinch-off. */
  readonly breakupTimer: Float32Array;
  /** Diameter to adopt at pinch-off, m. */
  readonly breakupDiameter: Float32Array;
  /** Volume that leaves as a satellite at pinch-off, m^3. Zeroed once released. */
  readonly satelliteVolume: Float32Array;
  readonly age: Float32Array;
  readonly flags: Uint8Array;
  readonly generation: Uint8Array;

  /** Highest index ever used, so iteration can stop early. */
  private high = 0;
  private freeList: Int32Array;
  private freeCount = 0;
  private liveCount = 0;

  /** Running accounting, m^3. */
  overflowVolume = 0;
  /** Satellite drops pinched off since the last reset, and the volume in them. */
  satellitesReleased = 0;
  satelliteVolumeReleased = 0;

  constructor(capacity = 240000) {
    this.capacity = capacity;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.diameter = new Float32Array(capacity);
    this.volume = new Float32Array(capacity);
    this.jetDiameter = new Float32Array(capacity);
    this.breakupTimer = new Float32Array(capacity);
    this.breakupDiameter = new Float32Array(capacity);
    this.satelliteVolume = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.generation = new Uint8Array(capacity);
    this.freeList = new Int32Array(capacity);
  }

  get count(): number {
    return this.liveCount;
  }

  get highWater(): number {
    return this.high;
  }

  reset(): void {
    this.flags.fill(0);
    this.high = 0;
    this.freeCount = 0;
    this.liveCount = 0;
    this.overflowVolume = 0;
    this.satellitesReleased = 0;
    this.satelliteVolumeReleased = 0;
  }

  /** Claim a slot, or -1 when full. */
  private alloc(): number {
    if (this.freeCount > 0) return this.freeList[--this.freeCount];
    if (this.high < this.capacity) return this.high++;
    return -1;
  }

  kill(i: number): void {
    if ((this.flags[i] & PFlag.Alive) === 0) return;
    this.flags[i] = 0;
    this.liveCount--;
    if (this.freeCount < this.capacity) this.freeList[this.freeCount++] = i;
  }

  /** Add a parcel straight from the emitter. */
  spawnFromEmitter(p: EmittedParcel): number {
    const i = this.alloc();
    if (i < 0) {
      this.overflowVolume += p.volume;
      return -1;
    }
    this.px[i] = p.position.x;
    this.py[i] = p.position.y;
    this.pz[i] = p.position.z;
    this.vx[i] = p.velocity.x;
    this.vy[i] = p.velocity.y;
    this.vz[i] = p.velocity.z;
    this.diameter[i] = p.diameter;
    this.volume[i] = p.volume;
    this.jetDiameter[i] = p.jetDiameter;
    this.breakupTimer[i] = p.timeToBreakup;
    this.breakupDiameter[i] = p.breakupDiameter;
    this.satelliteVolume[i] = p.satelliteVolume;
    this.age[i] = 0;
    this.flags[i] = PFlag.Alive | PFlag.Coherent;
    this.generation[i] = 0;
    this.liveCount++;
    return i;
  }

  /**
   * Add a droplet directly. Used for splash secondaries and for satellites.
   * Returns -1 when the buffer is full, in which case the caller must account
   * for the volume itself rather than letting it vanish.
   */
  spawnDroplet(
    pos: Vec3,
    vel: Vec3,
    diameter: number,
    volume: number,
    generation: number,
    satellite = false
  ): number {
    const i = this.alloc();
    if (i < 0) {
      this.overflowVolume += volume;
      return -1;
    }
    this.px[i] = pos.x;
    this.py[i] = pos.y;
    this.pz[i] = pos.z;
    this.vx[i] = vel.x;
    this.vy[i] = vel.y;
    this.vz[i] = vel.z;
    this.diameter[i] = diameter;
    this.volume[i] = volume;
    this.jetDiameter[i] = diameter;
    this.breakupTimer[i] = -1;
    this.breakupDiameter[i] = diameter;
    this.satelliteVolume[i] = 0;
    this.age[i] = 0;
    this.flags[i] =
      PFlag.Alive |
      (generation > 0 ? PFlag.Secondary : 0) |
      (satellite ? PFlag.Satellite : 0);
    this.generation[i] = Math.min(255, generation);
    this.liveCount++;
    return i;
  }

  /** Total airborne volume, m^3. */
  totalVolume(): number {
    let sum = 0;
    for (let i = 0; i < this.high; i++) {
      if (this.flags[i] & PFlag.Alive) sum += this.volume[i];
    }
    return sum;
  }

  /**
   * Advance every live particle by dt.
   *
   * Order per particle: breakup check, then forces, then a swept-segment test
   * against the fixture, then against the capture surfaces. The sweep is the
   * important part -- a droplet at 5 m/s covers 5 mm in a millisecond, which is
   * several cells and more than the thickness of any rib on the wall, so testing
   * "did the new position end up inside the solid" would let droplets pass
   * straight through the geometry and be counted as splashback when they never
   * escaped at all.
   */
  step(
    dt: number,
    fluid: FluidProperties,
    surface: UrinalSurface,
    exterior: SolidCollider | null,
    capture: CaptureTester | null,
    out: ParticleStepResult,
    onBreakup: ((i: number) => void) | null
  ): void {
    out.impacts.length = 0;
    out.captures.length = 0;
    out.satellites.length = 0;
    out.overflowVolume = 0;

    // Gravity reduced by buoyancy. Small for liquid in air, but free to include.
    const gEff = GRAVITY * (1 - AIR_DENSITY / fluid.density);
    const dragK = (3 * AIR_DENSITY) / (4 * fluid.density);

    const from = v3();
    const to = v3();
    const dir = v3();
    const capOut = { t: 0, zone: 0 };

    for (let i = 0; i < this.high; i++) {
      const f = this.flags[i];
      if ((f & PFlag.Alive) === 0) continue;

      this.age[i] += dt;

      // -- Rayleigh pinch-off -------------------------------------------------
      let coherent = (f & PFlag.Coherent) !== 0;
      if (coherent) {
        this.breakupTimer[i] -= dt;
        if (this.breakupTimer[i] <= 0) {
          this.flags[i] = f & ~PFlag.Coherent;
          this.diameter[i] = this.breakupDiameter[i];
          coherent = false;
          // The thread between two main drops collapses into a satellite. Split
          // it off here, so the parcel's volume and its diameter agree from this
          // point on: while it was a length of jet it carried the whole
          // wavelength, and a wavelength does not become one sphere.
          const satVol = this.satelliteVolume[i];
          if (satVol > 0 && satVol < this.volume[i]) {
            this.volume[i] -= satVol;
            this.satelliteVolume[i] = 0;
            this.satellitesReleased++;
            this.satelliteVolumeReleased += satVol;
            out.satellites.push({
              position: v3(this.px[i], this.py[i], this.pz[i]),
              velocity: v3(this.vx[i], this.vy[i], this.vz[i]),
              volume: satVol,
              diameter: Math.cbrt((6 * satVol) / Math.PI),
            });
          }
          if (onBreakup) onBreakup(i);
        }
      }

      const d = this.diameter[i];
      let vxi = this.vx[i];
      let vyi = this.vy[i];
      let vzi = this.vz[i];

      // -- Forces -------------------------------------------------------------
      vyi -= gEff * dt;

      if (!coherent) {
        // Air drag on a sphere. Applied only after breakup: an intact jet is
        // decelerated by skin friction over its surface, not by form drag, which
        // is a fraction of a percent over the 20 cm it travels. Treating the jet
        // as a sphere of its own diameter would slow it far too much.
        const speed = Math.hypot(vxi, vyi, vzi);
        if (speed > 1e-9 && d > 1e-9) {
          const re = (AIR_DENSITY * speed * d) / AIR_VISCOSITY;
          // Deformed-droplet drag, not rigid-sphere. The main drops off a 3 mm
          // stream are 5-6 mm across, and at that size aerodynamic flattening is
          // worth tens of percent of the drag rather than a rounding error.
          const weGas = (AIR_DENSITY * speed * speed * d) / fluid.surfaceTension;
          const cd = dropletDragCoefficient(re, weGas);
          // Linearised implicit update: unconditionally stable and keeps the
          // direction, which explicit Euler loses for small droplets whose drag
          // time constant approaches the step size.
          const k = (dragK * cd * speed) / d;
          const damp = 1 / (1 + k * dt);
          vxi *= damp;
          vyi *= damp;
          vzi *= damp;
        }
      }

      this.vx[i] = vxi;
      this.vy[i] = vyi;
      this.vz[i] = vzi;

      // -- Sweep --------------------------------------------------------------
      from.x = this.px[i];
      from.y = this.py[i];
      from.z = this.pz[i];
      to.x = from.x + vxi * dt;
      to.y = from.y + vyi * dt;
      to.z = from.z + vzi * dt;

      dir.x = to.x - from.x;
      dir.y = to.y - from.y;
      dir.z = to.z - from.z;
      const segLen = Math.hypot(dir.x, dir.y, dir.z);

      if (segLen > 1e-12) {
        // Direction is passed unnormalised with maxT = 1, so t comes back as a
        // fraction of the step.
        const hit = surface.raycast(from, dir, 1);

        // Everything on the segment is resolved by distance, not by category.
        //
        // The capture zones used to be tested only when neither the interior nor
        // the casting was hit, so a droplet that crossed a shin panel on its way
        // to the fixture was booked to the fixture. It is a small effect at the
        // default posture and a wrong one at any posture where the user's legs
        // reach in front of part of the ceramic -- which is what `legSetback`
        // exists to control.
        let capT = Infinity;
        if (capture && capture.test(from, to, capOut)) capT = capOut.t;

        // The outside of the casting, tested only as far as the nearest thing
        // already found so the closest wins. Without this the ceramic is
        // intangible and splash leaving the bowl flies straight through the body
        // of the fixture. It is not an impact: the film solver has no cell for
        // the outside of the casting, and liquid landing there is already an
        // accounted outcome -- it soils the fixture exterior and runs down it.
        if (exterior) {
          const limit = Math.min(hit ? hit.t : 1, capT);
          const solid = limit > 0 ? exterior.raycastSolid(from, dir, limit) : null;
          if (solid) {
            out.captures.push({
              index: i,
              from: v3(from.x, from.y, from.z),
              to: v3(
                from.x + dir.x * solid.t,
                from.y + dir.y * solid.t,
                from.z + dir.z * solid.t
              ),
              velocity: v3(vxi, vyi, vzi),
              volume: this.volume[i],
              diameter: d,
              generation: this.generation[i],
              coherent,
              zone: CaptureZone.FixtureExterior,
              // Copied, not aliased: MeshCollider returns a shared scratch vector
              // and there may be many captures in one step.
              normal: v3(solid.normal.x, solid.normal.y, solid.normal.z),
            });
            continue;
          }
        }

        if (hit && hit.t <= capT) {
          out.impacts.push({
            index: i,
            hit,
            velocity: v3(vxi, vyi, vzi),
            volume: this.volume[i],
            diameter: coherent ? this.jetDiameter[i] : d,
            coherent,
            generation: this.generation[i],
          });
          continue; // resolved by the impact model, which kills or respawns it
        }

        if (capT < Infinity) {
          out.captures.push({
            index: i,
            from: v3(from.x, from.y, from.z),
            to: v3(
              from.x + dir.x * capT,
              from.y + dir.y * capT,
              from.z + dir.z * capT
            ),
            velocity: v3(vxi, vyi, vzi),
            volume: this.volume[i],
            diameter: d,
            generation: this.generation[i],
            coherent,
            zone: capOut.zone,
          });
          continue;
        }
      }

      this.px[i] = to.x;
      this.py[i] = to.y;
      this.pz[i] = to.z;
    }

    out.overflowVolume = this.overflowVolume;
  }

  /**
   * Retire particles that have wandered outside the region of interest.
   *
   * Kept separate from the main step so the bounds can be generous: a droplet
   * that has left the room is uninteresting, but one still in the air near the
   * fixture may yet land on the user, and clipping it early would understate
   * splashback.
   */
  cullOutside(min: Vec3, max: Vec3): { count: number; volume: number } {
    let killed = 0;
    let volume = 0;
    for (let i = 0; i < this.high; i++) {
      if ((this.flags[i] & PFlag.Alive) === 0) continue;
      const x = this.px[i];
      const y = this.py[i];
      const z = this.pz[i];
      if (x < min.x || x > max.x || y < min.y || y > max.y || z < min.z || z > max.z) {
        volume += this.volume[i];
        this.kill(i);
        killed++;
      }
    }
    return { count: killed, volume };
  }
}

export const makeStepResult = (): ParticleStepResult => ({
  impacts: [],
  captures: [],
  satellites: [],
  overflowVolume: 0,
});
