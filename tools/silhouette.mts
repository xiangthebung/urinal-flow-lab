/**
 * Projection against height — the side-elevation silhouette, as a table.
 *
 * Manufacturers dimension the side elevation of a fixture with two numbers, not
 * one: the projection from the finished wall at the base and again at the top.
 * On a stall urinal those differ by nearly 2:1 (American Standard Stallbrook
 * 6400.001, 381 mm at the base and 203 mm at the top; Kohler Branham K-25039-T,
 * 414 and 205), and American Standard's own name for the product is a "sloping
 * front stall urinal" -- that taper *is* the silhouette.
 *
 * A single envelope figure cannot express that. `fixture-lab` prints
 * `W x D x H`, where D is the maximum over the whole body, so a fixture that
 * tapers correctly and a constant-depth column that reaches the same maximum
 * print the same number. This walks the body in height bands and reports the
 * furthest-forward point of interior union casting in each, which is the
 * quantity the spec sheet actually dimensions.
 *
 * Reads `tools/tuned/<id>.json` the same way `fixture-lab` does, so a candidate
 * taper can be measured before the preset is touched.
 *
 *   npx tsx tools/silhouette.mts stall-urinal
 *   npx tsx tools/silhouette.mts stall-urinal --bands 24
 *
 * Heights are reported above the floor, because that is the datum the sheets
 * dimension from. `back` is the rearmost point in the same band: it should sit
 * at or just behind z = 0, and a positive value means the body has lifted off
 * the mounting plane.
 */
import { existsSync, readFileSync } from 'node:fs';
import { PRESETS } from '../src/geometry/presets';
import { ShellParams, buildShell } from '../src/geometry/shell';
import { SurfaceParams, UrinalSurface } from '../src/geometry/surface';

const args = process.argv.slice(2);
const id = args[0];
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const preset = PRESETS.find((p) => p.id === id);
if (!preset) {
  console.error(`no such model: ${id}`);
  console.error(`available: ${PRESETS.map((p) => p.id).join(', ')}`);
  process.exit(1);
}

const overridePath = `tools/tuned/${id}.json`;
let over: { params?: Partial<SurfaceParams>; shell?: Partial<ShellParams>; notes?: string } = {};
if (existsSync(overridePath)) {
  over = JSON.parse(readFileSync(overridePath, 'utf8'));
  console.log(`overrides: ${overridePath}`);
  if (over.notes) console.log(`notes: ${over.notes}`);
} else {
  console.log(`overrides: none — showing the preset as-is`);
}

const params: SurfaceParams = { ...preset.params, ...(over.params ?? {}) };
const shellParams: Partial<ShellParams> = { ...(preset.shell ?? {}), ...(over.shell ?? {}) };

const s = new UrinalSurface(params, { nu: 72, nv: 132 });
const shell = buildShell(s, shellParams);

const nBands = Number(flag('bands') ?? 20);
const floorY = s.floorY;

// Union bounds in height, so the bands span the whole body.
let yLo = Infinity;
let yHi = -Infinity;
const scan = (pos: Float32Array | number[], fn: (x: number, y: number, z: number) => void) => {
  for (let i = 0; i + 2 < pos.length; i += 3) fn(pos[i], pos[i + 1], pos[i + 2]);
};
scan(s.vertices, (_x, y) => {
  if (y < yLo) yLo = y;
  if (y > yHi) yHi = y;
});
scan(shell.positions, (_x, y) => {
  if (y < yLo) yLo = y;
  if (y > yHi) yHi = y;
});

const band = (y: number) =>
  Math.min(nBands - 1, Math.max(0, Math.floor(((y - yLo) / (yHi - yLo)) * nBands)));

const fwdAll = new Array<number>(nBands).fill(-Infinity);
const backAll = new Array<number>(nBands).fill(Infinity);
const fwdIn = new Array<number>(nBands).fill(-Infinity);
scan(s.vertices, (_x, y, z) => {
  const b = band(y);
  if (z > fwdAll[b]) fwdAll[b] = z;
  if (z > fwdIn[b]) fwdIn[b] = z;
  if (z < backAll[b]) backAll[b] = z;
});
scan(shell.positions, (_x, y, z) => {
  const b = band(y);
  if (z > fwdAll[b]) fwdAll[b] = z;
  if (z < backAll[b]) backAll[b] = z;
});

const mm = (v: number) => (v * 1000).toFixed(0);
const peak = Math.max(...fwdAll.filter((v) => Number.isFinite(v)));

console.log('');
console.log(`${id} — side-elevation silhouette, ${nBands} bands`);
console.log(`floor y = ${mm(floorY)} mm, body spans ${mm(yLo)} .. ${mm(yHi)} mm`);
console.log('');
console.log('  height above floor   projection   interior   back      bar (to max projection)');
for (let b = nBands - 1; b >= 0; b--) {
  const yMid = yLo + ((b + 0.5) / nBands) * (yHi - yLo);
  if (!Number.isFinite(fwdAll[b])) continue;
  const n = Math.round((fwdAll[b] / peak) * 46);
  console.log(
    [
      `  ${mm(yMid - floorY).padStart(8)} mm`.padEnd(23),
      `${mm(fwdAll[b]).padStart(7)} mm`,
      `${(Number.isFinite(fwdIn[b]) ? mm(fwdIn[b]) : '-').padStart(8)} mm`,
      `${mm(backAll[b]).padStart(5)} mm`,
      ` ${'#'.repeat(Math.max(0, n))}`,
    ].join('  ')
  );
}

// Top and base projection, the two numbers a spec sheet prints. "Base" is taken
// at the top of the lip rather than at the very bottom, because that is where
// both reference sheets place their callout and because the bottom cap of a
// fitted casting tucks under.
const lipAboveFloor = s.lipY - floorY;
const nearest = (targetAboveFloor: number) => {
  let best = 0;
  let bestD = Infinity;
  for (let b = 0; b < nBands; b++) {
    if (!Number.isFinite(fwdAll[b])) continue;
    const yMid = yLo + ((b + 0.5) / nBands) * (yHi - yLo) - floorY;
    const d = Math.abs(yMid - targetAboveFloor);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return fwdAll[best];
};

let topBand = nBands - 1;
while (topBand > 0 && !Number.isFinite(fwdAll[topBand])) topBand--;

console.log('');
console.log('summary');
console.log(`  projection at top     ${mm(fwdAll[topBand])} mm   (highest band with body in it)`);
console.log(`  projection at lip     ${mm(nearest(lipAboveFloor))} mm   (top of lip, ${mm(lipAboveFloor)} mm above floor)`);
console.log(`  maximum projection    ${mm(peak)} mm`);
console.log(
  `  taper, lip : top      ${(nearest(lipAboveFloor) / Math.max(1e-6, fwdAll[topBand])).toFixed(2)} : 1`
);
