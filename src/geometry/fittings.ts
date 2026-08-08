import { Vec3, v3 } from '../core/vec3';
import { ShellMesh } from './shell';
import { UrinalSurface } from './surface';

/**
 * The metalwork: flush valve, supply pipe and outlet spud.
 *
 * These are not decoration, on two counts.
 *
 * Visually they are most of what makes a urinal read as a urinal. Every fixture in
 * the reference photographs is dominated by a chrome flushometer standing above
 * the bowl on an exposed pipe, and a bare ceramic pod without one looks like a
 * sink, a planter or a bucket -- which is exactly the note the renders kept
 * getting. The ceramic is the interesting part of the physics and it was the only
 * part being drawn.
 *
 * Physically they are solid, and they are the part of the fixture standing closest
 * to the user's aim. Peeing at the top of a urinal means hitting the spud and the
 * valve body, and a jet striking a hard chrome cylinder at head height throws
 * liquid a long way. So they go into the collider alongside the casting and splash
 * through the same exterior path. Treating them as scenery would reintroduce the
 * fault that made the casting a perfect absorber: geometry you can see but cannot
 * hit is geometry that silently deletes liquid.
 *
 * There is no film solver on them, for the same reason there is none on the
 * outside of the casting -- no structured grid -- so they use the dry splash
 * branch. See `ImpactResolver.resolveExterior`.
 */

export interface FittingsParams {
  /** Build the flushometer and its supply pipe. */
  flushValve: boolean;
  /**
   * Build a perforated sparge pipe along the length of the fixture.
   *
   * A trough is not flushed from a single valve over its middle -- that would rinse
   * 150 mm of a 1500 mm channel. It is sparged: a small-bore pipe runs nearly the
   * whole length just above the back panel, drilled with a row of holes angled at
   * the wall, and gravity-fed from an auto-siphon cistern high above. The visible
   * assembly *is* how you recognise a trough, in the same way that the absence of a
   * flushometer is how you recognise a waterless bowl.
   *
   * Off by default: it is the trough's fitting, and every other fixture in the
   * library takes a flushometer instead.
   */
  spargePipe: boolean;
  /** Build the outlet spud below the fixture. */
  outletSpud: boolean;
  /** Outside radius of the exposed supply pipe, m. */
  pipeRadius: number;
  /** Length of exposed pipe between the deck spud and the valve body, m. */
  pipeRise: number;
  /** Radius of the flushometer body, m. */
  valveRadius: number;
  /** Height of the flushometer body, m. */
  valveHeight: number;
  /** Length of the operating handle, m. */
  handleLength: number;
  /** Radius of the outlet spud below the fixture, m. */
  spudRadius: number;
  /** How far the outlet spud drops below the casting, m. */
  spudDrop: number;
  /**
   * How far in front of the mounting plane the pipe centreline sits, m.
   *
   * Measured from the back of the casting rather than from the bowl, because on a
   * real installation the pipe runs down the wall and turns in through the top
   * deck close behind it.
   */
  pipeStandoff: number;
  /** Outside radius of the sparge pipe, m. */
  spargeRadius: number;
  /** Height of the sparge centreline above the top of the casting, m. */
  spargeRise: number;
  /** How far short of each end the sparge stops, m. */
  spargeInset: number;
  /** Number of clips holding the sparge off the back panel. */
  spargeClips: number;
}

/**
 * Sized from a Sloan Royal-pattern exposed flushometer, which is the valve in most
 * of the reference photographs.
 *
 * The first attempt was thinner and taller everywhere and it read as a lollipop on a
 * mast rather than as a piece of plumbing: a 25 mm tube standing 170 mm clear with a
 * 72 mm body on top is mostly empty vertical line, and at thumbnail size the line
 * disappears and leaves a blob floating above the fixture. A real one is squat and
 * heavy -- the body is about as tall as it is wide, the tailpiece below it is short
 * and thick enough to read as metal, and there is a vacuum breaker between them that
 * is most of the visual mass. Getting the proportions right also brings the top of
 * the assembly 90 mm lower, which matters because everything is framed to the
 * bounding box.
 */
export function defaultFittingsParams(): FittingsParams {
  return {
    flushValve: true,
    outletSpud: true,
    // 32 mm OD, the 1-1/4 inch tailpiece that actually connects a urinal valve.
    pipeRadius: 0.016,
    pipeRise: 0.082,
    valveRadius: 0.041,
    valveHeight: 0.088,
    handleLength: 0.088,
    spudRadius: 0.024,
    spudDrop: 0.09,
    pipeStandoff: 0.058,
    spargePipe: false,
    // 14 mm outside diameter, which is what Pland dimension on the Bruges drawing.
    // The band across the industry is narrow -- 14-15 mm for a trough of this length,
    // 22 mm only for 3 m slab runs -- so this is a slim tube, not a rail.
    spargeRadius: 0.007,
    spargeRise: 0.052,
    // Pland dimension the pipe stopping 35 mm short at both ends.
    spargeInset: 0.035,
    // Four hospital clips on a 1200 mm unit, per the same drawing.
    spargeClips: 4,
  };
}

export interface FittingsMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  min: Vec3;
  max: Vec3;
  /** True when nothing was generated, so callers can skip the collider. */
  empty: boolean;
}

/**
 * Incremental triangle-soup builder.
 *
 * Deliberately a soup rather than a welded mesh: these are separate solids that
 * happen to touch, the collider only needs triangles, and welding would gain
 * nothing but shared normals across joints that should be sharp anyway.
 */
class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private idx: number[] = [];

  private push(p: Vec3, n: Vec3): number {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    return this.pos.length / 3 - 1;
  }

  /**
   * A capped cone between two points. Handles cylinders as the equal-radius case.
   *
   * The side normals are the true cone normals rather than the radial direction,
   * which matters where the taper is strong: the dome on top of a flushometer is a
   * 45 degree cone and shading it with radial normals makes it look like a
   * cylinder with a hole in it.
   */
  cone(
    a: Vec3,
    b: Vec3,
    ra: number,
    rb: number,
    segments = 24,
    capA = true,
    capB = true
  ): void {
    const axis = v3(b.x - a.x, b.y - a.y, b.z - a.z);
    const len = Math.hypot(axis.x, axis.y, axis.z);
    if (len < 1e-9) return;
    axis.x /= len;
    axis.y /= len;
    axis.z /= len;

    // Any perpendicular pair. Picking the least-aligned world axis keeps the
    // cross product well conditioned for vertical and horizontal fittings alike.
    const ref =
      Math.abs(axis.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
    const e1 = v3(
      ref.y * axis.z - ref.z * axis.y,
      ref.z * axis.x - ref.x * axis.z,
      ref.x * axis.y - ref.y * axis.x
    );
    const m1 = Math.hypot(e1.x, e1.y, e1.z) || 1;
    e1.x /= m1;
    e1.y /= m1;
    e1.z /= m1;
    const e2 = v3(
      axis.y * e1.z - axis.z * e1.y,
      axis.z * e1.x - axis.x * e1.z,
      axis.x * e1.y - axis.y * e1.x
    );

    // Slope of the side, for the true surface normal.
    const dr = rb - ra;
    const sideAx = -dr / Math.hypot(len, dr);
    const sideRad = len / Math.hypot(len, dr);

    const ringA: number[] = [];
    const ringB: number[] = [];
    for (let k = 0; k < segments; k++) {
      const th = (k / segments) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const dx = e1.x * c + e2.x * s;
      const dy = e1.y * c + e2.y * s;
      const dz = e1.z * c + e2.z * s;
      const n = v3(
        dx * sideRad + axis.x * sideAx,
        dy * sideRad + axis.y * sideAx,
        dz * sideRad + axis.z * sideAx
      );
      ringA.push(this.push(v3(a.x + dx * ra, a.y + dy * ra, a.z + dz * ra), n));
      ringB.push(this.push(v3(b.x + dx * rb, b.y + dy * rb, b.z + dz * rb), n));
    }
    for (let k = 0; k < segments; k++) {
      const k2 = (k + 1) % segments;
      this.idx.push(ringA[k], ringB[k], ringA[k2]);
      this.idx.push(ringA[k2], ringB[k], ringB[k2]);
    }

    if (capA && ra > 1e-6) {
      const nA = v3(-axis.x, -axis.y, -axis.z);
      const c = this.push(a, nA);
      const ring: number[] = [];
      for (let k = 0; k < segments; k++) {
        const th = (k / segments) * Math.PI * 2;
        const dx = e1.x * Math.cos(th) + e2.x * Math.sin(th);
        const dy = e1.y * Math.cos(th) + e2.y * Math.sin(th);
        const dz = e1.z * Math.cos(th) + e2.z * Math.sin(th);
        ring.push(this.push(v3(a.x + dx * ra, a.y + dy * ra, a.z + dz * ra), nA));
      }
      for (let k = 0; k < segments; k++) {
        this.idx.push(c, ring[(k + 1) % segments], ring[k]);
      }
    }
    if (capB && rb > 1e-6) {
      const nB = v3(axis.x, axis.y, axis.z);
      const c = this.push(b, nB);
      const ring: number[] = [];
      for (let k = 0; k < segments; k++) {
        const th = (k / segments) * Math.PI * 2;
        const dx = e1.x * Math.cos(th) + e2.x * Math.sin(th);
        const dy = e1.y * Math.cos(th) + e2.y * Math.sin(th);
        const dz = e1.z * Math.cos(th) + e2.z * Math.sin(th);
        ring.push(this.push(v3(b.x + dx * rb, b.y + dy * rb, b.z + dz * rb), nB));
      }
      for (let k = 0; k < segments; k++) {
        this.idx.push(c, ring[k], ring[(k + 1) % segments]);
      }
    }
  }

  finish(): FittingsMesh {
    const n = this.pos.length / 3;
    const min = v3(Infinity, Infinity, Infinity);
    const max = v3(-Infinity, -Infinity, -Infinity);
    for (let k = 0; k < n; k++) {
      const x = this.pos[k * 3];
      const y = this.pos[k * 3 + 1];
      const z = this.pos[k * 3 + 2];
      if (x < min.x) min.x = x;
      if (y < min.y) min.y = y;
      if (z < min.z) min.z = z;
      if (x > max.x) max.x = x;
      if (y > max.y) max.y = y;
      if (z > max.z) max.z = z;
    }
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      indices: new Uint32Array(this.idx),
      min,
      max,
      empty: n === 0,
    };
  }
}

/**
 * Build the metalwork for a fixture.
 *
 * Everything is placed relative to the casting rather than to fixed heights, so a
 * 1 m stall urinal and a 470 mm wall-hung bowl both get correctly sited fittings
 * without per-model numbers.
 */
export function buildFittings(
  surface: UrinalSurface,
  casting: ShellMesh,
  over: Partial<FittingsParams> = {}
): FittingsMesh {
  const p = { ...defaultFittingsParams(), ...over };
  const b = new MeshBuilder();

  const deckY = casting.max.y;
  const backZ = casting.min.z;
  const pipeZ = backZ + p.pipeStandoff;

  if (p.flushValve) {
    // Spud collar through the top deck. Started below the deck so there is no gap
    // however the deck surface happens to sit.
    b.cone(
      v3(0, deckY - 0.012, pipeZ),
      v3(0, deckY + 0.016, pipeZ),
      p.pipeRadius * 1.5,
      p.pipeRadius * 1.25,
      24
    );
    // Tailpiece down to the spud.
    const breakerBase = deckY + 0.016 + p.pipeRise * 0.45;
    b.cone(
      v3(0, deckY + 0.016, pipeZ),
      v3(0, breakerBase, pipeZ),
      p.pipeRadius,
      p.pipeRadius,
      20
    );
    // Vacuum breaker: the fat sleeve partway up the tailpiece. Legally required on
    // a flushometer and, more to the point here, the piece that stops the run of
    // chrome between the fixture and the valve reading as bare wire.
    const breakerTop = breakerBase + p.pipeRise * 0.34;
    b.cone(
      v3(0, breakerBase, pipeZ),
      v3(0, breakerBase + 0.006, pipeZ),
      p.pipeRadius,
      p.pipeRadius * 1.62,
      20
    );
    b.cone(
      v3(0, breakerBase + 0.006, pipeZ),
      v3(0, breakerTop - 0.006, pipeZ),
      p.pipeRadius * 1.62,
      p.pipeRadius * 1.62,
      20
    );
    b.cone(
      v3(0, breakerTop - 0.006, pipeZ),
      v3(0, breakerTop, pipeZ),
      p.pipeRadius * 1.62,
      p.pipeRadius,
      20
    );
    const pipeTop = deckY + 0.016 + p.pipeRise;
    b.cone(
      v3(0, breakerTop, pipeZ),
      v3(0, pipeTop, pipeZ),
      p.pipeRadius,
      p.pipeRadius,
      20
    );
    // Coupling nut where the tailpiece enters the valve.
    b.cone(
      v3(0, pipeTop, pipeZ),
      v3(0, pipeTop + 0.018, pipeZ),
      p.pipeRadius * 1.5,
      p.pipeRadius * 1.5,
      12
    );
    // Valve body, very slightly barrelled.
    const bodyBase = pipeTop + 0.018;
    const bodyTop = bodyBase + p.valveHeight;
    b.cone(
      v3(0, bodyBase, pipeZ),
      v3(0, bodyBase + p.valveHeight * 0.35, pipeZ),
      p.valveRadius * 0.82,
      p.valveRadius,
      28
    );
    b.cone(
      v3(0, bodyBase + p.valveHeight * 0.35, pipeZ),
      v3(0, bodyTop, pipeZ),
      p.valveRadius,
      p.valveRadius * 0.92,
      28
    );
    // Domed cap.
    b.cone(
      v3(0, bodyTop, pipeZ),
      v3(0, bodyTop + 0.026, pipeZ),
      p.valveRadius * 0.92,
      p.valveRadius * 0.45,
      28
    );
    b.cone(
      v3(0, bodyTop + 0.026, pipeZ),
      v3(0, bodyTop + 0.034, pipeZ),
      p.valveRadius * 0.45,
      p.valveRadius * 0.2,
      20
    );

    // Operating handle, out to the left and angled down toward the user, which is
    // how a flushometer lever actually sits.
    const handleY = bodyBase + p.valveHeight * 0.44;
    const handleEnd = v3(
      -p.valveRadius * 0.85 - p.handleLength,
      handleY - 0.014,
      pipeZ + p.handleLength * 0.38
    );
    b.cone(
      v3(-p.valveRadius * 0.85, handleY, pipeZ),
      handleEnd,
      0.0115,
      0.0095,
      12
    );
    // Rounded end to the lever. Without it the handle terminates in a flat disc,
    // which at any size reads as a broken-off rod.
    b.cone(
      handleEnd,
      v3(handleEnd.x - 0.007, handleEnd.y - 0.0025, handleEnd.z + 0.0026),
      0.0095,
      0.004,
      12
    );
    // Handle boss.
    b.cone(
      v3(-p.valveRadius * 0.6, handleY, pipeZ),
      v3(-p.valveRadius * 1.1, handleY, pipeZ),
      0.019,
      0.0165,
      16
    );

    // Angle stop and its cap on the right, the other signature lump.
    b.cone(
      v3(p.valveRadius * 0.6, bodyBase + p.valveHeight * 0.55, pipeZ),
      v3(p.valveRadius * 1.55, bodyBase + p.valveHeight * 0.55, pipeZ),
      0.019,
      0.017,
      16
    );
    b.cone(
      v3(p.valveRadius * 1.55, bodyBase + p.valveHeight * 0.55, pipeZ),
      v3(p.valveRadius * 1.72, bodyBase + p.valveHeight * 0.55, pipeZ),
      0.017,
      0.009,
      16
    );
  }

  if (p.spargePipe) {
    // Runs along x, just above the top of the back panel and close to the wall.
    const y = deckY + p.spargeRise;
    const z = backZ + Math.max(p.pipeStandoff * 0.55, p.spargeRadius * 2.2);
    const halfLen = Math.max(0.05, (casting.max.x - casting.min.x) / 2 - p.spargeInset);
    const r = p.spargeRadius;

    // The tube, with a domed blank at each end. A flat disc terminates as a
    // broken-off rod at any size, the same reason the flushometer handle carries one.
    b.cone(v3(-halfLen, y, z), v3(halfLen, y, z), r, r, 14);
    for (const s of [-1, 1]) {
      b.cone(v3(s * halfLen, y, z), v3(s * (halfLen + r * 0.7), y, z), r, r * 0.45, 12);
    }

    // Centre feed: a tee at the mid-point and a downpipe rising to the cistern.
    // Every UK and Australian source feeds the sparge this way -- one vertical drop
    // into the middle, splitting left and right -- rather than from an end, which is
    // why 22 x 22 x 15 reduced tees are a stocked plumbing item.
    b.cone(v3(-r * 2.1, y, z), v3(r * 2.1, y, z), r * 1.5, r * 1.5, 14);
    const feedR = r * 1.55;
    b.cone(v3(0, y, z), v3(0, y + 0.055, z), feedR, feedR, 14);
    // Compression nut where the downpipe enters the tee.
    b.cone(v3(0, y + 0.012, z), v3(0, y + 0.03, z), feedR * 1.35, feedR * 1.35, 12);
    // The drop from the cistern. Left running off the top of the frame on purpose:
    // the cistern sits 750-950 mm above the fixture, which is outside every view the
    // tool frames, and drawing a stub that stops in mid-air reads as a broken pipe.
    b.cone(v3(0, y + 0.055, z), v3(0, y + 0.42, z), feedR, feedR, 14);

    // Hospital clips: a saddle round the pipe on a short post back to the panel.
    const nClip = Math.max(2, Math.round(p.spargeClips));
    for (let i = 0; i < nClip; i++) {
      // Spread across the run, inset from the ends so no clip lands on a blank.
      const f = nClip === 1 ? 0.5 : i / (nClip - 1);
      const x = -halfLen * 0.86 + f * (halfLen * 1.72);
      if (Math.abs(x) < r * 4) continue; // the tee occupies the middle
      b.cone(v3(x, y, z), v3(x, y, backZ + 0.004), r * 1.45, r * 1.15, 10);
      b.cone(v3(x, y, backZ + 0.004), v3(x, y, backZ), r * 2.1, r * 2.1, 10);
    }

    // Perforations, as short nipples angled down and back at the wall. They are the
    // difference between a sparge and a handrail: the pipe discharges a curtain of
    // water against the back panel, and the holes face it. Modelled as raised
    // nipples rather than cut holes because the collider wants solid triangles and a
    // subtractive hole would need a boolean the mesh builder does not do.
    const pitch = 0.06;
    const nHole = Math.max(2, Math.floor((halfLen * 2 - 0.05) / pitch));
    for (let i = 0; i <= nHole; i++) {
      const x = -halfLen + 0.025 + (i * (halfLen * 2 - 0.05)) / nHole;
      if (Math.abs(x) < r * 4) continue;
      b.cone(
        v3(x, y - r * 0.45, z - r * 0.45),
        v3(x, y - r * 1.35, z - r * 1.35),
        r * 0.42,
        r * 0.28,
        6
      );
    }
  }

  if (p.outletSpud) {
    // Waste spud under the bowl, on the drain centreline. Only worth drawing when
    // the fixture is clear of the floor; a stall urinal's outlet is in the slab.
    const bottomY = casting.min.y;
    const clearOfFloor = bottomY - surface.floorY;
    if (clearOfFloor > 0.05) {
      const drop = Math.min(p.spudDrop, clearOfFloor - 0.01);
      const drainZ = surface.params.drainZ;
      b.cone(
        v3(0, bottomY + 0.01, drainZ),
        v3(0, bottomY - drop * 0.35, drainZ),
        p.spudRadius * 1.5,
        p.spudRadius * 1.15,
        20
      );
      b.cone(
        v3(0, bottomY - drop * 0.35, drainZ),
        v3(0, bottomY - drop, drainZ),
        p.spudRadius,
        p.spudRadius,
        18
      );
    }
  }

  return b.finish();
}
