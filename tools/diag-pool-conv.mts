/**
 * Does the film solver converge on the capillary depth limit under refinement?
 *
 * The existing sweep in `tools/diag-pool.mts` refines `nu` while keeping the blob
 * a fixed number of *cells*, so the deposited footprint and the deposited volume
 * both shrink with the grid. Five points on that sweep are five different
 * experiments, not one experiment at five resolutions, and a non-monotone reading
 * across them says nothing about convergence. This holds the physical experiment
 * fixed -- same footprint in millimetres, same initial depth, therefore the same
 * volume -- and refines only the grid.
 *
 * The quantity to watch is the cell width against the capillary length. The
 * settled depth this check asserts is a contact-line result: the pool is flat at
 * `2 l_c sin(theta/2)` across its middle and falls to nothing over a meniscus
 * about one capillary length wide. A grid whose cells are several capillary
 * lengths across cannot represent that meniscus at all, so it is not a question
 * of accuracy -- the feature being measured is absent from the discretisation.
 *
 * Usage: npx tsx tools/diag-pool-conv.mts [halfWidth mm]
 */
import { WALL_MATERIALS, URINE_37C, maxStaticPuddleThickness, capillaryLength } from '../src/core/fluid';
import { defaultSurfaceParams, UrinalSurface } from '../src/geometry/surface';
import { FilmSolver, defaultFilmParams } from '../src/sim/film';

const HALF_W = Number(process.argv[2] ?? 60) / 1000;
const wall = WALL_MATERIALS[0];
const hRef = maxStaticPuddleThickness(URINE_37C, wall.contactAngleScale);
const lc = capillaryLength(URINE_37C);

// Exactly the suite's surface parameters.
const base = defaultSurfaceParams();
base.sumpSlope = 0;
base.drainRadius = 0.0001;
base.widthSump = 0.24;

function sumpRowOf(s: UrinalSurface): number {
  let row = 0;
  let lo = Infinity;
  for (let j = 0; j < s.nv; j++) {
    const c = j * s.nu + s.nu / 2;
    if (s.cellPos[c * 3 + 1] < lo) {
      lo = s.cellPos[c * 3 + 1];
      row = j;
    }
  }
  return row;
}

/** How much of the u range is level floor, in cells and in millimetres. */
function floorWidth(s: UrinalSurface, row: number): { cells: number; mm: number } {
  const y0 = s.cellPos[(row * s.nu + s.nu / 2) * 3 + 1];
  let cells = 0;
  let mm = 0;
  for (let i = 0; i < s.nu; i++) {
    const c = row * s.nu + i;
    if (s.cellPos[c * 3 + 1] - y0 > 0.0005) continue;
    cells++;
    mm += s.cellDu[c] * 1000;
  }
  return { cells, mm };
}

console.log(
  `capillary length ${(lc * 1000).toFixed(2)} mm; ` +
    `capillary depth limit ${(hRef * 1000).toFixed(3)} mm; ` +
    `blob half width ${(HALF_W * 1000).toFixed(0)} mm`
);
// The pinning test in `FilmSolver.canAdvance` is applied to the *donor cell's*
// own depth, so a pool spreads one whole cell at a time: it advances while its
// edge cell is deeper than the limit, and each advance wets a ring of cells whose
// area is set by the grid. If the cells are coarse the last admissible advance
// overshoots and the pool settles thinner than the limit by roughly the fraction
// of its own area that one ring represents. `V / A` against the settled depth is
// the direct test of that -- if they agree, the pool is a flat pancake whose depth
// is fixed by how much area it happened to wet, not by capillarity.
console.log(
  '\n   nu   du mm  du/l_c   floor mm (cells)   volume uL   settled mm   of limit' +
    '   wet cells   wet cm2    V/A mm'
);

for (const nu of [64, 96, 128, 160, 224, 320, 448]) {
  const s = new UrinalSurface(base, { nu, nv: 128 });
  const row = sumpRowOf(s);
  const cMid = row * s.nu + s.nu / 2;
  const du = s.cellDu[cMid];
  const fw = floorWidth(s, row);
  const fp = defaultFilmParams();
  fp.drainCoefficient = 0;
  const film = new FilmSolver(s, URINE_37C, wall, fp);
  // Same physical footprint at every resolution: a fixed span in x about the sump
  // low point, and the same five rows (nv is held, so dv does not move).
  const x0 = s.cellPos[cMid * 3];
  let vol = 0;
  for (let j = row - 2; j <= row + 2; j++) {
    for (let i = 0; i < s.nu; i++) {
      const c = j * s.nu + i;
      if (Math.abs(s.cellPos[c * 3] - x0) > HALF_W) continue;
      film.deposit(c, hRef * s.cellArea[c], 0, 0);
      vol += hRef * s.cellArea[c];
    }
  }
  const dt = 1 / 2000;
  for (let i = 0; i < 20000; i++) film.step(dt);
  let maxH = 0;
  let wetCells = 0;
  let wetArea = 0;
  let wetVol = 0;
  for (let c = 0; c < film.h.length; c++) {
    maxH = Math.max(maxH, film.h[c]);
    if (film.h[c] > 1e-5) {
      wetCells++;
      wetArea += s.cellArea[c];
      wetVol += film.h[c] * s.cellArea[c];
    }
  }
  console.log(
    `  ${String(nu).padStart(3)}  ${(du * 1000).toFixed(2).padStart(6)}  ` +
      `${(du / lc).toFixed(2).padStart(6)}   ${fw.mm.toFixed(0).padStart(5)} (${String(
        fw.cells
      ).padStart(3)})        ` +
      `${(vol * 1e9).toFixed(1).padStart(6)}   ${(maxH * 1000).toFixed(3).padStart(8)}   ` +
      `${((maxH / hRef) * 100).toFixed(1).padStart(5)}%   ` +
      `${String(wetCells).padStart(9)}   ${(wetArea * 1e4).toFixed(1).padStart(7)}   ` +
      `${((wetVol / wetArea) * 1000).toFixed(3).padStart(6)}`
  );
}

// Is the contact line holding, or creeping?
//
// `canAdvance` gates flow into a neighbour only while that neighbour is *dry*.
// Once a cell has taken any liquid at all it is wet, and every later step moves
// liquid into it ungated -- so the gate is a test on first wetting, not a standing
// condition. If that is what is happening, the wetted area should keep growing
// with settling time instead of stopping, and the pool should keep thinning.
// The area the capillary limit permits for this volume is printed alongside, so
// over-spreading can be read off directly rather than inferred.
console.log('\nSettling time at nu = 128, same blob:');
console.log('   seconds   wet cm2   mean mm   max mm   permitted cm2');
{
  const s = new UrinalSurface(base, { nu: 128, nv: 128 });
  const row = sumpRowOf(s);
  const cMid = row * s.nu + s.nu / 2;
  const fp = defaultFilmParams();
  fp.drainCoefficient = 0;
  const film = new FilmSolver(s, URINE_37C, wall, fp);
  const x0 = s.cellPos[cMid * 3];
  let vol = 0;
  for (let j = row - 2; j <= row + 2; j++) {
    for (let i = 0; i < s.nu; i++) {
      const c = j * s.nu + i;
      if (Math.abs(s.cellPos[c * 3] - x0) > HALF_W) continue;
      film.deposit(c, hRef * s.cellArea[c], 0, 0);
      vol += hRef * s.cellArea[c];
    }
  }
  const dt = 1 / 2000;
  let done = 0;
  for (const secs of [2.5, 5, 10, 20, 40]) {
    const want = Math.round(secs / dt);
    for (; done < want; done++) film.step(dt);
    let maxH = 0;
    let wetArea = 0;
    let wetVol = 0;
    for (let c = 0; c < film.h.length; c++) {
      maxH = Math.max(maxH, film.h[c]);
      if (film.h[c] > 1e-5) {
        wetArea += s.cellArea[c];
        wetVol += film.h[c] * s.cellArea[c];
      }
    }
    console.log(
      `  ${secs.toFixed(1).padStart(8)}   ${(wetArea * 1e4).toFixed(1).padStart(7)}   ` +
        `${((wetVol / wetArea) * 1000).toFixed(3).padStart(7)}   ` +
        `${(maxH * 1000).toFixed(3).padStart(6)}   ${((vol / hRef) * 1e4).toFixed(1).padStart(13)}`
    );
  }
}
