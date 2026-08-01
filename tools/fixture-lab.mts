/**
 * Fixture shaping bench.
 *
 * Iterating on a fixture's shape needs a fast loop and a hard yardstick, and this
 * provides both without a browser and without touching the preset library. It
 * merges an override file over a preset, renders four views to a PNG, and prints
 * the numbers that decide whether the shape is admissible.
 *
 *   npx tsx tools/fixture-lab.mts classic-bowl
 *   npx tsx tools/fixture-lab.mts classic-bowl --out tools/shots/try1.png
 *   npx tsx tools/fixture-lab.mts classic-bowl --full     (all resolutions)
 *
 * Overrides are read from `tools/tuned/<id>.json`, shaped:
 *
 *   { "params": { "rimHeight": 0.5 }, "shell": { "bulge": 0 }, "notes": "why" }
 *
 * `params` merges over SurfaceParams (which includes ProfileParams), `shell` over
 * ShellParams. Anything absent keeps the preset's value.
 *
 * WHAT THE NUMBERS MEAN
 *
 *   flipped / degenerate  Must both be 0 at every resolution. These are the
 *                         failure mode the wrap has produced three times: cells
 *                         whose normals disagree with their neighbours silently
 *                         invert gravity and the impingement angle in the sump,
 *                         which is where drainage is decided. A shape that is
 *                         prettier and has flipped normals is worse, not better.
 *   selfIntersects        Must be false. Unmanufacturable, and it breaks the
 *                         surface parameterisation.
 *   notch                 How far the u = +-1 side edge dives back toward the
 *                         mounting plane below the rim. That edge is the rim of
 *                         the opening, so a big number means the bowl is slit open
 *                         at the sides. Lower is better; a real fixture is ~0.
 *   openMouth             Spread in z of the whole opening loop. A real fixture's
 *                         mouth is nearly planar, 40-60 mm. Lower is better.
 *   clamped               True if buildProfile had to clamp a parameter. Read the
 *                         notes it prints -- a clamped value is not the value you
 *                         asked for.
 */
import { existsSync, readFileSync } from 'node:fs';
import { blit, writePng } from './png.mts';
import { PRESETS } from '../src/geometry/presets';
import { ShellParams, buildShell } from '../src/geometry/shell';
import { SurfaceParams, UrinalSurface } from '../src/geometry/surface';
import { buildFittings, FittingsParams } from '../src/geometry/fittings';
import { Box, RasterMesh, RasterView, rasterise, unionBox } from '../src/render/softRaster';

const W = 460;
const H = 460;
const BG: [number, number, number, number] = [16, 20, 26, 255];
const INTERIOR: [number, number, number] = [188, 196, 210];
const CASTING: [number, number, number] = [234, 238, 245];
const CHROME: [number, number, number] = [140, 152, 166];

const args = process.argv.slice(2);
const id = args[0];
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (n: string) => args.includes(`--${n}`);

const preset = PRESETS.find((p) => p.id === id);
if (!preset) {
  console.error(`no such model: ${id}`);
  console.error(`available: ${PRESETS.map((p) => p.id).join(', ')}`);
  process.exit(1);
}

const overridePath = `tools/tuned/${id}.json`;
let over: {
  params?: Partial<SurfaceParams>;
  shell?: Partial<ShellParams>;
  fittings?: Partial<FittingsParams>;
  notes?: string;
} = {};
if (existsSync(overridePath)) {
  over = JSON.parse(readFileSync(overridePath, 'utf8'));
  console.log(`overrides: ${overridePath}`);
  if (over.notes) console.log(`notes: ${over.notes}`);
} else {
  console.log(`overrides: none (${overridePath} does not exist) — showing the preset as-is`);
}

const params: SurfaceParams = { ...preset.params, ...(over.params ?? {}) };
const shellParams: Partial<ShellParams> = { ...(preset.shell ?? {}), ...(over.shell ?? {}) };
const fittingParams: Partial<FittingsParams> = {
  ...(preset.fittings ?? {}),
  ...(over.fittings ?? {}),
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const RES: Array<[number, number]> = has('full')
  ? [
      [48, 96],
      [56, 104],
      [72, 132],
      [112, 200],
    ]
  : [[56, 104]];

console.log('');
console.log(
  'res        W x D x H mm      flipped  degen  selfInt  notch  openMouth  protrude  ribbing'
);
let worstFlipped = 0;
let worstDegen = 0;
let anySelfInt = false;
let worstProtrusion = 0;
let worstRibbing = 0;

for (const [nu, nv] of RES) {
  const s = new UrinalSurface(params, { nu, nv });
  const shell = buildShell(s, shellParams);
  const box = unionBox(s.bounds(), { min: shell.min, max: shell.max });

  let flipped = 0;
  for (let j = 0; j < s.nv; j++) {
    for (let i = 0; i < s.nu - 1; i++) {
      const a = j * s.nu + i;
      const b = a + 1;
      const d =
        s.cellNormal[a * 3] * s.cellNormal[b * 3] +
        s.cellNormal[a * 3 + 1] * s.cellNormal[b * 3 + 1] +
        s.cellNormal[a * 3 + 2] * s.cellNormal[b * 3 + 2];
      if (d < 0) flipped++;
    }
  }

  const stride = s.nu + 1;
  const zAt = (j: number) => s.vertices[(j * stride + s.nu) * 3 + 2];
  const zRim = zAt(0);
  let zMin = zRim;
  for (let j = 0; j <= s.nv; j++) zMin = Math.min(zMin, zAt(j));

  let lz0 = Infinity;
  let lz1 = -Infinity;
  const see = (k: number) => {
    const z = s.vertices[k * 3 + 2];
    if (z < lz0) lz0 = z;
    if (z > lz1) lz1 = z;
  };
  for (let i = 0; i <= s.nu; i++) see(i);
  for (let j = 0; j <= s.nv; j++) see(j * stride + s.nu);
  for (let i = 0; i <= s.nu; i++) see(s.nv * stride + i);
  for (let j = 0; j <= s.nv; j++) see(j * stride);

  worstFlipped = Math.max(worstFlipped, flipped);
  worstDegen = Math.max(worstDegen, s.degenerateCells);
  anySelfInt = anySelfInt || s.profile.info.selfIntersects;

  console.log(
    [
      `${nu}x${nv}`.padEnd(10),
      `${((box.max.x - box.min.x) * 1000).toFixed(0)} x ${((box.max.z - box.min.z) * 1000).toFixed(0)} x ${((box.max.y - box.min.y) * 1000).toFixed(0)}`.padEnd(
        17
      ),
      String(flipped).padStart(7),
      String(s.degenerateCells).padStart(6),
      String(s.profile.info.selfIntersects).padStart(8),
      `${((zRim - zMin) * 1000).toFixed(0)}mm`.padStart(7),
      `${((lz1 - lz0) * 1000).toFixed(0)}mm`.padStart(10),
      `${shell.fit.protrusion.toFixed(2)}mm`.padStart(9),
      `${shell.fit.ribbing.toFixed(2)}mm`.padStart(9),
    ].join(' ')
  );
  worstProtrusion = Math.max(worstProtrusion, shell.fit.protrusion);
  worstRibbing = Math.max(worstRibbing, shell.fit.ribbing);
}

// ---------------------------------------------------------------------------
// Geometry report
// ---------------------------------------------------------------------------

const s = new UrinalSurface(params, { nu: 56, nv: 104 });
const shell = buildShell(s, shellParams);
const fittings = buildFittings(s, shell, fittingParams);
const box = unionBox(s.bounds(), { min: shell.min, max: shell.max });
const info = s.profile.info;

console.log('');
console.log('geometry');
console.log(`  rim above floor      ${((s.bounds().max.y - s.floorY) * 1000).toFixed(0)} mm` +
  `   (ADA limit 430 mm)`);
console.log(
  `  depth, rim to back   ${((s.bounds().max.z - s.bounds().min.z) * 1000).toFixed(0)} mm` +
    `   (ADA minimum 345 mm)`
);
console.log(`  actual rim height    ${(info.actualRimHeight * 1000).toFixed(0)} mm above datum`);
console.log(`  lip height           ${(s.lipY * 1000).toFixed(0)} mm above datum`);
console.log(`  wetted area          ${(s.totalArea * 1e4).toFixed(0)} cm2`);
console.log(`  clamped              ${info.clamped}`);
for (const n of info.notes) console.log(`    ! ${n}`);
console.log(
  `  fittings             ${fittings.empty ? 'none' : `${fittings.indices.length / 3} triangles`}`
);

if (worstFlipped > 0 || worstDegen > 0 || anySelfInt) {
  console.log('');
  console.log('  *** REJECT: flipped normals, degenerate cells or self-intersection. ***');
  console.log('  *** These corrupt the physics. Fix before considering the shape.  ***');
}
if (worstProtrusion > 0.01) {
  console.log('');
  console.log(`  *** REJECT: bowl protrudes ${worstProtrusion.toFixed(2)} mm through its casting. ***`);
}
if (worstRibbing > 0.5) {
  console.log('');
  console.log(
    `  *** RIBBING: ${worstRibbing.toFixed(2)} mm alternating ripple in the casting section, ***`
  );
  console.log(
    `  *** at y = ${shell.fit.ribbingAt.y.toFixed(0)} mm, ${shell.fit.ribbingAt.deg.toFixed(0)} deg off centre.        ***`
  );
  console.log('  *** Reads as horizontal ridges on the pedestal. Not a shading bug.   ***');
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function views(b: Box): RasterView[] {
  const cy = (b.min.y + b.max.y) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const span = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) * 1.7;
  const target: [number, number, number] = [0, cy, cz];
  return [
    { eye: [span * 0.62, cy + span * 0.42, cz + span * 0.86], target, background: BG },
    { eye: [0.0001, cy, cz + span * 1.5], target, background: BG },
    { eye: [span * 1.5, cy, cz], target, background: BG },
    { eye: [0.0001, cy + span * 1.5, cz], target, background: BG },
  ];
}

const meshes: RasterMesh[] = [
  { positions: s.vertices, indices: s.indices, normals: s.vertexNormals, tint: INTERIOR },
  { positions: shell.positions, indices: shell.indices, normals: shell.normals, tint: CASTING },
];
if (!fittings.empty) {
  meshes.push({
    positions: fittings.positions,
    indices: fittings.indices,
    normals: fittings.normals,
    tint: CHROME,
  });
}
const fullBox = fittings.empty
  ? box
  : unionBox(box, { min: fittings.min, max: fittings.max });

const imgs = views(fullBox).map((v) => rasterise(meshes, v, W, H));
const cols = 2;
const rows = Math.ceil(imgs.length / cols);
const tw = cols * W;
const th = rows * H;
const px = new Uint8ClampedArray(tw * th * 4);
imgs.forEach((img, i) => {
  blit(px, tw, img, W, H, (i % cols) * W, Math.floor(i / cols) * H);
});

const out = flag('out') ?? `tools/shots/lab-${id}.png`;
writePng(out, px, tw, th);
console.log('');
console.log(`wrote ${out}  (three-quarter, front, side, top — clockwise from top-left)`);
