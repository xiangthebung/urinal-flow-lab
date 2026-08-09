/**
 * The casting, one block at a time.
 *
 * `buildShell` returns a single merged mesh, but it is three separate pieces
 * built by three different rules -- the offset skin over the interior, the rim
 * band round the opening loop, and the solid body -- and a defect on the finished
 * object says nothing about which of the three drew it. Every triangle lies
 * wholly inside one block (the blocks are assembled by concatenation and no
 * triangle spans two), so partitioning by the first index recovers them exactly.
 *
 * Renders the interior and each block on its own, from a fixed three-quarter eye,
 * so a feature can be attributed by looking at which frame it is in. Software
 * rasteriser, so this is a second per iteration rather than the ninety seconds
 * `npm run shoot` costs -- see the doc's Verification rules: this attributes a
 * defect, it does not verify the product.
 *
 * Usage: npx tsx tools/diag-parts.mts [preset-id] [scale] [out.png]
 */
import { writePng } from './png.mts';
import { PRESETS } from '../src/geometry/presets';
import { buildShell } from '../src/geometry/shell';
import { UrinalSurface } from '../src/geometry/surface';
import { Box, RasterMesh, RasterView, rasterise, unionBox } from '../src/render/softRaster';

const id = process.argv[2] ?? 'classic-bowl';
const SCALE = Number(process.argv[3] ?? 2);
const OUT = process.argv[4] ?? 'tools/shots/diag-parts.png';
const W = 440 * SCALE;
const H = 440 * SCALE;
const BG: [number, number, number, number] = [16, 20, 26, 255];
const INTERIOR: [number, number, number] = [198, 205, 217];
const CASTING: [number, number, number] = [233, 237, 244];

const preset = PRESETS.find((p) => p.id === id)!;
const surface = new UrinalSurface({ ...preset.params }, { nu: 56, nv: 104 });
const shell = buildShell(surface, preset.shell);

const nVert = (surface.nu + 1) * (surface.nv + 1);
// The band's own copies of the boundary loop sit between the skin and the body.
// Its extent is not exported, so it is whatever lies between the two blocks that
// are identifiable by their vertex ranges.
let bodyBase = Infinity;
for (const t of shell.indices) if (t >= nVert && t < bodyBase) bodyBase = t;
// The lowest index at or above nVert belongs to the band, so walk the triangles
// and split on membership instead: skin < nVert, body >= the body's own base.
const blocks: Record<string, number[]> = { skin: [], band: [], body: [] };
// Recover the body base properly: the body is the last block pushed, and its
// triangle count is large, so take the largest contiguous run. Simpler and exact:
// a triangle is skin if all indices < nVert. Everything else is band or body, and
// the band is exactly 2 * L vertices immediately after the skin. L is the opening
// loop length, which is recoverable as the number of distinct vertices in the
// non-skin, non-body set -- but the cheap reliable split is by y-extent, so
// instead classify by whether the triangle's vertices are all in the lowest
// non-skin index range that forms a strip.
const nonSkin: number[] = [];
for (let t = 0; t < shell.indices.length; t += 3) {
  const a = shell.indices[t];
  const b = shell.indices[t + 1];
  const c = shell.indices[t + 2];
  if (a < nVert && b < nVert && c < nVert) blocks.skin.push(a, b, c);
  else nonSkin.push(a, b, c);
}
// The band is a strip of 2L vertices; the body starts after it. The gap between
// the two blocks is visible as the largest jump in the sorted set of used indices.
const used = [...new Set(nonSkin)].sort((x, y) => x - y);
let cut = used[used.length - 1] + 1;
let biggest = 0;
for (let i = 1; i < used.length; i++) {
  const gap = used[i] - used[i - 1];
  if (gap > biggest) {
    biggest = gap;
    cut = used[i];
  }
}
for (let t = 0; t < nonSkin.length; t += 3) {
  const a = nonSkin[t];
  const dst = a >= cut ? blocks.body : blocks.band;
  dst.push(a, nonSkin[t + 1], nonSkin[t + 2]);
}

const mesh = (indices: number[], tint: [number, number, number]): RasterMesh => ({
  positions: shell.positions,
  indices,
  normals: shell.normals,
  tint,
});
const interior: RasterMesh = {
  positions: surface.vertices,
  indices: surface.indices,
  normals: surface.vertexNormals,
  tint: INTERIOR,
};

const box: Box = unionBox(surface.bounds(), { min: shell.min, max: shell.max });
const cy = (box.min.y + box.max.y) / 2;
const cz = (box.min.z + box.max.z) / 2;
const span =
  Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) * 1.7;
const view: RasterView = {
  eye: [span * 0.62, cy + span * 0.42, cz + span * 0.86],
  target: [0, cy, cz],
  background: BG,
};

const frames: Array<[string, RasterMesh[]]> = [
  ['everything', [interior, mesh(shell.indices as number[], CASTING)]],
  ['casting only', [mesh(shell.indices as number[], CASTING)]],
  ['skin only', [mesh(blocks.skin, CASTING)]],
  ['body only', [mesh(blocks.body, CASTING)]],
  ['band only', [mesh(blocks.band, CASTING)]],
  ['interior only', [interior]],
];
console.log(
  `${id}: ${blocks.skin.length / 3} skin, ${blocks.band.length / 3} band, ` +
    `${blocks.body.length / 3} body triangles  (band/body split at vertex ${cut})`
);
const imgs = frames.map(([, m]) => rasterise(m, view, W, H));
frames.forEach(([n], i) => console.log(`  frame ${i}: ${n}`));

const cols = 3;
const rows = Math.ceil(imgs.length / cols);
const out = new Uint8ClampedArray(cols * W * rows * H * 4);
imgs.forEach((img, i) => {
  const cx = (i % cols) * W;
  const ry = Math.floor(i / cols) * H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4;
      const d = ((ry + y) * cols * W + cx + x) * 4;
      out[d] = img[s];
      out[d + 1] = img[s + 1];
      out[d + 2] = img[s + 2];
      out[d + 3] = img[s + 3];
    }
  }
});
writePng(OUT, out, cols * W, rows * H);
console.log('wrote', OUT);
