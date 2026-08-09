/**
 * The standing-pool check, outside the suite, so its premise can be examined
 * without a four-minute round trip.
 *
 * Trap 12: this check has broken three times and twice the *test* was at fault.
 * It deposits a fixed blob at the sump and asserts the pool settles at the
 * capillary depth limit, so anything that changes how much liquid that blob is,
 * or how far it spreads, moves the answer without the solver being wrong.
 *
 * The blob is selected as a fixed number of *cells*. That is a dimension the test
 * does not own -- see Trap 27 -- and it is exactly what moved: a cell at the sump
 * is a different physical width once the row's arclength budget includes the side
 * wall. This prints the cell size, and then the settled depth for a blob chosen by
 * physical radius instead, at three fills, so the attractor property can be
 * checked rather than assumed.
 */
import { WALL_MATERIALS, URINE_37C, maxStaticPuddleThickness } from '../src/core/fluid';
import { defaultSurfaceParams, UrinalSurface } from '../src/geometry/surface';
import { FilmSolver, defaultFilmParams } from '../src/sim/film';

// Exactly the suite's surface. The level sump matters: it is what lets the pool
// spread along a contour until the contact line pins.
const p = defaultSurfaceParams();
p.sumpSlope = 0;
p.drainRadius = 0.0001;
p.widthSump = 0.24;
const s = new UrinalSurface(p, { nu: 64, nv: 128 });
const wall = WALL_MATERIALS[0];
const hRef = maxStaticPuddleThickness(URINE_37C, wall.contactAngleScale);

let sumpRow = 0;
let lowest = Infinity;
for (let j = 0; j < s.nv; j++) {
  const c = j * s.nu + s.nu / 2;
  if (s.cellPos[c * 3 + 1] < lowest) {
    lowest = s.cellPos[c * 3 + 1];
    sumpRow = j;
  }
}
const cMid = sumpRow * s.nu + s.nu / 2;
console.log(
  `sump row ${sumpRow}  du=${(s.cellDu[cMid] * 1000).toFixed(2)} mm  ` +
    `dv=${(s.cellDv[cMid] * 1000).toFixed(2)} mm  hRef=${(hRef * 1000).toFixed(3)} mm`
);
console.log(
  `  the suite's 8-column blob is therefore ${(8 * s.cellDu[cMid] * 1000).toFixed(0)} mm wide`
);

/**
 * The suite's own blob -- five rows by eight columns at the sump -- at a given
 * grid resolution. The question is whether the settled depth converges on the
 * capillary limit as the sump is resolved more finely. If it does, the solver is
 * right and the suite is simply under-resolving the sump at nu = 64 now that the
 * side walls take most of the u budget; if it does not, the physics has moved.
 */
function suiteBlob(nu: number, nv: number, fillMul = 1): { mm: number; du: number } {
  const surf = new UrinalSurface(p, { nu, nv });
  const fp = defaultFilmParams();
  fp.drainCoefficient = 0;
  const film = new FilmSolver(surf, URINE_37C, wall, fp);
  let row = 0;
  let lo = Infinity;
  for (let j = 0; j < surf.nv; j++) {
    const c = j * surf.nu + surf.nu / 2;
    if (surf.cellPos[c * 3 + 1] < lo) {
      lo = surf.cellPos[c * 3 + 1];
      row = j;
    }
  }
  // Same footprint in cells the suite uses, scaled with the grid so the physical
  // patch is the same at every resolution.
  // The suite's literal footprint: eight columns by five rows, whatever that is
  // in millimetres. That is the point -- the physical size of the blob is what
  // moved, so the fix is to give the sump enough columns that eight of them are a
  // small blob again.
  const halfCols = 4;
  const halfRows = 2;
  for (let j = row - halfRows; j <= row + halfRows; j++) {
    for (let i = surf.nu / 2 - halfCols; i < surf.nu / 2 + halfCols; i++) {
      const c = j * surf.nu + i;
      film.deposit(c, hRef * fillMul * surf.cellArea[c], 0, 0);
    }
  }
  const dt = 1 / 2000;
  for (let i = 0; i < 20000; i++) film.step(dt);
  let maxH = 0;
  for (let c = 0; c < film.h.length; c++) maxH = Math.max(maxH, film.h[c]);
  return { mm: maxH * 1000, du: surf.cellDu[row * surf.nu + surf.nu / 2] * 1000 };
}

console.log('resolution   du mm    settled mm   (hRef ' + (hRef * 1000).toFixed(3) + ')');
for (const [nu, nv] of [[64, 128], [128, 128], [192, 128], [256, 128], [320, 128]] as Array<[number, number]>) {
  const r = suiteBlob(nu, nv);
  console.log(
    `  ${nu}x${nv}`.padEnd(13) + `${r.du.toFixed(2).padStart(6)}   ${r.mm.toFixed(3).padStart(10)}   blob ${(8 * r.du).toFixed(0)} mm`
  );
}

/** Settle a blob chosen by physical radius about the sump low point. */
function settle(radius: number, fillMul: number): { mm: number; cells: number } {
  const fp = defaultFilmParams();
  fp.drainCoefficient = 0;
  const film = new FilmSolver(s, URINE_37C, wall, fp);
  const px = s.cellPos[cMid * 3];
  const py = s.cellPos[cMid * 3 + 1];
  const pz = s.cellPos[cMid * 3 + 2];
  let n = 0;
  for (let c = 0; c < s.cellDu.length; c++) {
    const dx = s.cellPos[c * 3] - px;
    const dy = s.cellPos[c * 3 + 1] - py;
    const dz = s.cellPos[c * 3 + 2] - pz;
    if (Math.hypot(dx, dy, dz) > radius) continue;
    film.deposit(c, hRef * fillMul * s.cellArea[c], 0, 0);
    n++;
  }
  const dt = 1 / 2000;
  for (let i = 0; i < 20000; i++) film.step(dt);
  let maxH = 0;
  for (let c = 0; c < film.h.length; c++) maxH = Math.max(maxH, film.h[c]);
  return { mm: maxH * 1000, cells: n };
}

console.log('\nradius mm   cells   depth at 1x / 1.5x / 2x fill (mm)');
for (const r of [0.015, 0.02, 0.03, 0.04]) {
  const a = settle(r, 1);
  const b = settle(r, 1.5);
  const c = settle(r, 2);
  console.log(
    `  ${(r * 1000).toFixed(0).padStart(5)}   ${String(a.cells).padStart(5)}   ` +
      `${a.mm.toFixed(3)} / ${b.mm.toFixed(3)} / ${c.mm.toFixed(3)}` +
      `   ${Math.abs(a.mm / (hRef * 1000) - 1) < 0.08 ? '<= within 8%' : ''}`
  );
}
