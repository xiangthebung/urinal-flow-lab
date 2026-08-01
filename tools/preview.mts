/**
 * Offline preview renderer.
 *
 * A development tool, not part of the app. There is no headless browser in this
 * project, so the only way to check "does this actually read as a urinal" is to
 * rasterise the geometry straight to a PNG and look at it. The rasteriser itself
 * lives in src/render/softRaster.ts, shared with the fixture picker's thumbnails,
 * so what a model looks like here is what it looks like in the app.
 *
 *   npx tsx tools/preview.mts                  every model, three views each
 *   npx tsx tools/preview.mts classic-bowl     one model, four views
 *   npx tsx tools/preview.mts all out.png      explicit output path
 */
import { writePng } from './png.mts';
import { PRESETS, UrinalPreset } from '../src/geometry/presets';
import { buildShell } from '../src/geometry/shell';
import { UrinalSurface } from '../src/geometry/surface';
import {
  Box,
  RasterMesh,
  RasterView,
  rasterise,
  unionBox,
} from '../src/render/softRaster';

const W = 440;
const H = 440;
const BG: [number, number, number, number] = [16, 20, 26, 255];
const INTERIOR: [number, number, number] = [198, 205, 217];
const CASTING: [number, number, number] = [233, 237, 244];

function tile(images: Uint8ClampedArray[], cols: number) {
  const rows = Math.ceil(images.length / cols);
  const w = cols * W;
  const h = rows * H;
  const out = new Uint8ClampedArray(w * h * 4);
  images.forEach((img, i) => {
    const cx = (i % cols) * W;
    const cy = Math.floor(i / cols) * H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = (y * W + x) * 4;
        const d = ((cy + y) * w + cx + x) * 4;
        out[d] = img[s];
        out[d + 1] = img[s + 1];
        out[d + 2] = img[s + 2];
        out[d + 3] = img[s + 3];
      }
    }
  });
  return { px: out, w, h };
}

/** Three-quarter, front, side, top. */
function views(b: Box): RasterView[] {
  const cy = (b.min.y + b.max.y) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const span =
    Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) * 1.7;
  const target: [number, number, number] = [0, cy, cz];
  return [
    { eye: [span * 0.62, cy + span * 0.42, cz + span * 0.86], target, background: BG },
    { eye: [0.0001, cy, cz + span * 1.5], target, background: BG },
    { eye: [span * 1.5, cy, cz], target, background: BG },
    { eye: [0.0001, cy + span * 1.5, cz], target, background: BG },
  ];
}

function build(preset: UrinalPreset) {
  const surface = new UrinalSurface(preset.params, { nu: 56, nv: 104 });
  const shell = buildShell(surface, preset.shell);
  const meshes: RasterMesh[] = [
    {
      positions: surface.vertices,
      indices: surface.indices,
      normals: surface.vertexNormals,
      tint: INTERIOR,
    },
    {
      positions: shell.positions,
      indices: shell.indices,
      normals: shell.normals,
      tint: CASTING,
    },
  ];
  const box = unionBox(surface.bounds(), { min: shell.min, max: shell.max });
  return { surface, meshes, box };
}

const which = process.argv[2] ?? 'all';
const out = process.argv[3] ?? 'tools/out.png';
const imgs: Uint8ClampedArray[] = [];

if (which === 'all') {
  for (const preset of PRESETS) {
    const { surface, meshes, box } = build(preset);
    const v = views(box);
    imgs.push(rasterise(meshes, v[0], W, H));
    imgs.push(rasterise(meshes, v[1], W, H));
    imgs.push(rasterise(meshes, v[2], W, H));
    console.log(
      preset.id.padEnd(20),
      `${((box.max.x - box.min.x) * 1000).toFixed(0)} x ` +
        `${((box.max.z - box.min.z) * 1000).toFixed(0)} x ` +
        `${((box.max.y - box.min.y) * 1000).toFixed(0)} mm`,
      `degenerateCells ${surface.degenerateCells}`,
      surface.profile.info.selfIntersects ? 'SELF-INTERSECTS' : ''
    );
  }
  const t = tile(imgs, 3);
  writePng(out, t.px, t.w, t.h);
} else {
  const preset = PRESETS.find((p) => p.id === which);
  if (!preset) {
    throw new Error(`no such model: ${which}. Try one of: ${PRESETS.map((p) => p.id).join(', ')}`);
  }
  const { meshes, box } = build(preset);
  for (const v of views(box)) imgs.push(rasterise(meshes, v, W, H));
  const t = tile(imgs, 2);
  writePng(out, t.px, t.w, t.h);
}
console.log('wrote', out);
