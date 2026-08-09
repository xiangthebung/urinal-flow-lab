/**
 * Which block of the casting is paving the mouth?
 *
 * `buildShell` lays its vertices down in three blocks -- the offset skin, then the
 * rim band, then the solid body -- so a triangle's vertex indices say which
 * emission site produced it. Guessing at sites one at a time cost a lot of time
 * and eliminated three innocent ones; this asks the mesh directly.
 *
 * A triangle counts as paving if its centroid sits inside the mouth in plan and
 * above the front lip, i.e. in the open volume a person aims into. Nothing solid
 * belongs there.
 *
 * Usage: npx tsx tools/diag-pave.mts [preset-id]
 */
import { PRESETS } from '../src/geometry/presets';
import { UrinalSurface } from '../src/geometry/surface';
import { buildShell } from '../src/geometry/shell';

const id = process.argv[2] ?? 'classic-bowl';
const preset = PRESETS.find((p) => p.id === id)!;
const s = new UrinalSurface({ ...preset.params }, { nu: 72, nv: 132 });
const shell = buildShell(s, preset.shell ?? {});

const stride = s.nu + 1;
// Block boundaries, mirroring buildShell's assembly order.
const nVert = (s.nu + 1) * (s.nv + 1);
const L = 2 * (s.nu + 1) + 2 * (s.nv + 1) - 4;
const bandBase = nVert;
const bodyBase = nVert + L * 2;

// The mouth, in plan: the boundary loop projected to (x, z), and its height range.
const loop: number[] = [];
for (let i = 0; i <= s.nu; i++) loop.push(i);
for (let j = 1; j <= s.nv; j++) loop.push(j * stride + s.nu);
for (let i = s.nu - 1; i >= 0; i--) loop.push(s.nv * stride + i);
for (let j = s.nv - 1; j >= 1; j--) loop.push(j * stride);
const poly = loop.map((k) => [s.vertices[k * 3], s.vertices[k * 3 + 2]] as [number, number]);

function inPoly(x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

const blockOf = (v: number) => (v < bandBase ? 'skin' : v < bodyBase ? 'band' : 'body');
const counts: Record<string, number> = { skin: 0, band: 0, body: 0 };
const areaBy: Record<string, number> = { skin: 0, band: 0, body: 0 };
let lowest: Record<string, number> = { skin: Infinity, band: Infinity, body: Infinity };
let highest: Record<string, number> = { skin: -Infinity, band: -Infinity, body: -Infinity };

const idxs = shell.indices;
for (let t = 0; t + 2 < idxs.length; t += 3) {
  const a = idxs[t];
  const b = idxs[t + 1];
  const c = idxs[t + 2];
  const cx = (shell.positions[a * 3] + shell.positions[b * 3] + shell.positions[c * 3]) / 3;
  const cy =
    (shell.positions[a * 3 + 1] + shell.positions[b * 3 + 1] + shell.positions[c * 3 + 1]) / 3;
  const cz =
    (shell.positions[a * 3 + 2] + shell.positions[b * 3 + 2] + shell.positions[c * 3 + 2]) / 3;
  // Above the lip tip and inside the mouth outline in plan.
  if (cy < s.lipY) continue;
  if (!inPoly(cx, cz)) continue;
  const blk = blockOf(a);
  counts[blk]++;
  const e1 = [
    shell.positions[b * 3] - shell.positions[a * 3],
    shell.positions[b * 3 + 1] - shell.positions[a * 3 + 1],
    shell.positions[b * 3 + 2] - shell.positions[a * 3 + 2],
  ];
  const e2 = [
    shell.positions[c * 3] - shell.positions[a * 3],
    shell.positions[c * 3 + 1] - shell.positions[a * 3 + 1],
    shell.positions[c * 3 + 2] - shell.positions[a * 3 + 2],
  ];
  areaBy[blk] +=
    0.5 *
    Math.hypot(
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0]
    );
  lowest[blk] = Math.min(lowest[blk], cy);
  highest[blk] = Math.max(highest[blk], cy);
}

console.log(`${id}: triangles sitting in the open mouth (above lip y=${(s.lipY * 1000).toFixed(0)} mm)`);
console.log('block   count      area cm2   y range mm');
for (const blk of ['skin', 'band', 'body']) {
  const lo = Number.isFinite(lowest[blk]) ? (lowest[blk] * 1000).toFixed(0) : '-';
  const hi = Number.isFinite(highest[blk]) ? (highest[blk] * 1000).toFixed(0) : '-';
  console.log(
    `${blk.padEnd(7)}${String(counts[blk]).padStart(6)}${(areaBy[blk] * 1e4)
      .toFixed(1)
      .padStart(12)}   ${lo} .. ${hi}`
  );
}
