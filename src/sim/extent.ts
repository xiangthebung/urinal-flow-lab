import { Vec3, v3 } from '../core/vec3';
import { FittingsMesh } from '../geometry/fittings';
import { ShellMesh } from '../geometry/shell';
import { UrinalSurface } from '../geometry/surface';

/**
 * How much room the fixture actually occupies.
 *
 * One object, built once, consumed by everything that needs to know where the
 * fixture *is*: the emitter, the capture zones, the room, the user figure and the
 * camera. It exists because every one of those used to derive its answer from
 * `surface.bounds()` -- the wetted interior -- and the interior is not the
 * fixture. The casting wraps it by 10-15 mm all round and its rim stands proud,
 * measured 0-44 mm ahead of the interior's front face depending on model.
 *
 * The consequences were not cosmetic. The user was placed `standoff` in front of
 * the *interior*, so the control labelled "stand-off from fixture" over-reported
 * the real gap by up to 44 mm out of 120 -- a third of the most sensitive posture
 * control in the tool, in the optimistic direction. And the `FixtureExterior`
 * capture plane, nominally sitting 4 mm in front of the ceramic, was placed 4 mm
 * in front of the interior, i.e. *inside* the casting, where nothing can reach it.
 * The casting collider intercepts droplets before they get there, so the fault was
 * masked rather than fixed.
 *
 * Two envelopes rather than one, and the distinction is load-bearing:
 *
 *  - `ceramic` is the interior and the casting. This is the fixture a person
 *    stands at, so it is what posture, stand-off and the capture zones measure
 *    from.
 *  - `all` additionally includes the metalwork, which reaches well above the bowl
 *    and forward of it. It is right for framing a camera and wrong for posture: a
 *    user does not stand back from the flush valve.
 */
export interface Envelope {
  min: Vec3;
  max: Vec3;
}

export interface FixtureExtent {
  /** Interior loft alone -- the wetted patch, and nothing else. */
  interior: Envelope;
  /** Interior plus the casting: the ceramic body a person stands at. */
  ceramic: Envelope;
  /** Everything solid, metalwork included. For framing, not for posture. */
  all: Envelope;
  /** Front-most point of the ceramic, m. Posture and stand-off measure from here. */
  frontZ: number;
  /** Mounting plane behind the fixture, m. */
  backZ: number;
  /** Lowest point of the ceramic, m. */
  bottomY: number;
  /** Bathroom floor, m. */
  floorY: number;
  /** World y of the front lip tip, m. */
  lipY: number;
}

const infinite = (): Envelope => ({
  min: v3(Infinity, Infinity, Infinity),
  max: v3(-Infinity, -Infinity, -Infinity),
});

const growByBox = (e: Envelope, b: Envelope): void => {
  if (b.min.x < e.min.x) e.min.x = b.min.x;
  if (b.min.y < e.min.y) e.min.y = b.min.y;
  if (b.min.z < e.min.z) e.min.z = b.min.z;
  if (b.max.x > e.max.x) e.max.x = b.max.x;
  if (b.max.y > e.max.y) e.max.y = b.max.y;
  if (b.max.z > e.max.z) e.max.z = b.max.z;
};

const copy = (e: Envelope): Envelope => ({
  min: v3(e.min.x, e.min.y, e.min.z),
  max: v3(e.max.x, e.max.y, e.max.z),
});

/** Measure the fixture. `casting` and `fittings` are optional so this works mid-build. */
export function fixtureExtent(
  surface: UrinalSurface,
  casting?: ShellMesh | null,
  fittings?: FittingsMesh | null
): FixtureExtent {
  const interior = surface.bounds();

  const ceramic = infinite();
  growByBox(ceramic, interior);
  if (casting) growByBox(ceramic, { min: casting.min, max: casting.max });

  const all = copy(ceramic);
  if (fittings && !fittings.empty) {
    growByBox(all, { min: fittings.min, max: fittings.max });
  }

  return {
    interior,
    ceramic,
    all,
    frontZ: ceramic.max.z,
    backZ: ceramic.min.z,
    bottomY: ceramic.min.y,
    floorY: surface.floorY,
    lipY: surface.lipY,
  };
}
