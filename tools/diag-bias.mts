/**
 * Sump resolution and settled pool depth against `uFloorFraction`.
 *
 * The standing-pool check reads the capillary depth off cells at the sump, so
 * what decides whether it is asymptotic is the sump cell width against the
 * capillary length -- not `nu`. This sweeps the bias at a fixed `nu` and prints
 * both, so the value can be chosen from the measurement.
 *
 * Usage: npx tsx tools/diag-bias.mts [nu] [nv]
 */
import { WALL_MATERIALS, URINE_37C, maxStaticPuddleThickness, capillaryLength } from '../src/core/fluid';
import { defaultSurfaceParams, UrinalSurface } from '../src/geometry/surface';
import { FilmSolver, defaultFilmParams } from '../src/sim/film';

const NU = Number(process.argv[2] ?? 64);
const NV = Number(process.argv[3] ?? 128);
const wall = WALL_MATERIALS[0];
const hRef = maxStaticPuddleThickness(URINE_37C, wall.contactAngleScale);
const lc = capillaryLength(URINE_37C);

console.log(
  `nu=${NU} nv=${NV}; capillary length ${(lc * 1000).toFixed(2)} mm; limit ${(hRef * 1000).toFixed(3)} mm`
);
console.log('  bias   sump du mm   du/l_c   floor cells   settled mm   of limit   wall cells');

for (const bias of [0, 0.3, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]) {
  const p = defaultSurfaceParams();
  p.sumpSlope = 0;
  p.drainRadius = 0.0001;
  p.widthSump = 0.24;
  p.uFloorFraction = bias;
  const s = new UrinalSurface(p, { nu: NU, nv: NV });
  let row = 0;
  let lo = Infinity;
  for (let j = 0; j < s.nv; j++) {
    const c = j * s.nu + s.nu / 2;
    if (s.cellPos[c * 3 + 1] < lo) {
      lo = s.cellPos[c * 3 + 1];
      row = j;
    }
  }
  const cMid = row * s.nu + s.nu / 2;
  const y0 = s.cellPos[cMid * 3 + 1];
  let floorCells = 0;
  for (let i = 0; i < s.nu; i++) {
    if (s.cellPos[(row * s.nu + i) * 3 + 1] - y0 <= 0.0005) floorCells++;
  }
  // The suite's own blob: eight columns by five rows at the sump.
  const fp = defaultFilmParams();
  fp.drainCoefficient = 0;
  const film = new FilmSolver(s, URINE_37C, wall, fp);
  for (let j = row - 2; j <= row + 2; j++) {
    for (let i = s.nu / 2 - 4; i < s.nu / 2 + 4; i++) {
      const c = j * s.nu + i;
      film.deposit(c, hRef * s.cellArea[c], 0, 0);
    }
  }
  const dt = 1 / 2000;
  for (let i = 0; i < 20000; i++) film.step(dt);
  let maxH = 0;
  for (let c = 0; c < film.h.length; c++) maxH = Math.max(maxH, film.h[c]);
  const du = s.cellDu[cMid];
  console.log(
    `  ${bias.toFixed(2)}   ${(du * 1000).toFixed(2).padStart(9)}   ${(du / lc)
      .toFixed(2)
      .padStart(6)}   ${String(floorCells).padStart(11)}   ${(maxH * 1000)
      .toFixed(3)
      .padStart(10)}   ${((maxH / hRef) * 100).toFixed(1).padStart(6)}%   ${String(
      s.nu - floorCells
    ).padStart(10)}`
  );
}
