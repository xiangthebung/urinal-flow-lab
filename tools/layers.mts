/**
 * Layer separation for diagnosing a surface feature.
 *
 * "Diagnose a suspicious surface feature by hiding things, not by staring" is
 * doctrine on this project, and it is doctrine because four wrong hypotheses were
 * tried on one bright flap before anyone hid the casting and saw it was the rim
 * band. `fixture-lab` always draws interior + casting + metalwork together, which
 * is right for judging the shape and useless for attributing a defect to a layer.
 *
 * This draws the same fixture four ways: interior alone, casting alone, and both
 * again from a chosen direction. Whatever the feature is, it is in exactly one of
 * the first two panels, and that answers "which mesh owns this" in one look.
 *
 *   npx tsx tools/layers.mts trough --out tools/shots/x.png
 *   npx tsx tools/layers.mts trough --view end      (down the long axis)
 *   npx tsx tools/layers.mts classic-bowl --view front|side|top|end
 */
import { blit, writePng } from './png.mts';
import { PRESETS } from '../src/geometry/presets';
import { buildShell } from '../src/geometry/shell';
import { UrinalSurface } from '../src/geometry/surface';
import { RasterMesh, RasterView, rasterise, unionBox } from '../src/render/softRaster';

const W = 520;
const H = 520;
const BG: [number, number, number, number] = [16, 20, 26, 255];
const INTERIOR: [number, number, number] = [188, 196, 210];
const CASTING: [number, number, number] = [234, 238, 245];

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

const s = new UrinalSurface(preset.params, { nu: 72, nv: 132 });
const shell = buildShell(s, preset.shell ?? {});
const box = unionBox(s.bounds(), { min: shell.min, max: shell.max });

const inner: RasterMesh = {
  positions: s.vertices,
  indices: s.indices,
  normals: s.vertexNormals,
  tint: INTERIOR,
};
const outer: RasterMesh = {
  positions: shell.positions,
  indices: shell.indices,
  normals: shell.normals,
  tint: CASTING,
};

const cy = (box.min.y + box.max.y) / 2;
const cz = (box.min.z + box.max.z) / 2;
const span =
  Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) * 1.7;
const target: [number, number, number] = [0, cy, cz];

const threeQuarter: RasterView = {
  eye: [span * 0.5, cy + span * 0.55, cz + span * 0.72],
  target,
  background: BG,
};
const named: Record<string, RasterView> = {
  // Straight down the long axis. On a trough this is the only view that shows
  // what the end cap is doing, and the end cap is where its V-notch lives.
  end: { eye: [span * 1.45, cy + span * 0.12, cz + span * 0.04], target, background: BG },
  front: { eye: [0.0001, cy, cz + span * 1.5], target, background: BG },
  side: { eye: [span * 1.5, cy, cz], target, background: BG },
  top: { eye: [0.0001, cy + span * 1.5, cz], target, background: BG },
};
const second = named[flag('view') ?? 'end'] ?? named.end;

const panels = [
  rasterise([inner], threeQuarter, W, H),
  rasterise([outer], threeQuarter, W, H),
  rasterise([inner], second, W, H),
  rasterise([inner, outer], second, W, H),
];
const tw = 2 * W;
const th = 2 * H;
const px = new Uint8ClampedArray(tw * th * 4);
panels.forEach((img, i) => blit(px, tw, img, W, H, (i % 2) * W, Math.floor(i / 2) * H));

const out = flag('out') ?? `tools/shots/layers-${id}.png`;
writePng(out, px, tw, th);
console.log(
  `wrote ${out}\n` +
    `  top-left     interior alone, three-quarter\n` +
    `  top-right    casting alone, three-quarter\n` +
    `  bottom-left  interior alone, ${flag('view') ?? 'end'}\n` +
    `  bottom-right both, ${flag('view') ?? 'end'}`
);
