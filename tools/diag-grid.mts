/**
 * Grid and opening diagnostics for the wetted interior.
 *
 * Prints, per preset and per resolution, the quantities that decide whether the
 * loft is admissible (flipped normals, degenerate cells, worst skew) alongside
 * the two that say whether it is a *basin*:
 *
 *   sideDrop   how far the u = +-1 boundary falls below the lower of its two
 *              endpoints. A basin's rim never dives into the bowl, so this is 0
 *              on a closed fixture and large on a saddle.
 *   ringGap    at each height, the largest gap in the surface's plan outline
 *              between the back-wall sheet and the front-lip strip. This is the
 *              missing side wall, measured directly.
 *
 * Usage: npx tsx tools/diag-grid.mts [--res 48x96] [--models a,b]
 */
import { PRESETS } from '../src/geometry/presets';
import { UrinalSurface } from '../src/geometry/surface';

const RES = [
  { nu: 48, nv: 96 },
  { nu: 56, nv: 104 },
  { nu: 72, nv: 132 },
  { nu: 112, nv: 200 },
];

const args = process.argv.slice(2);
const arg = (k: string): string | undefined => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = arg('--models')?.split(',');
const resFilter = arg('--res');

const FLIPPED: string[] = [];

/**
 * Flipped normals, by the shape bench's own definition: two cells side by side in
 * a row whose normals oppose. This is the number the verification bar is stated
 * in, so it is the one that counts.
 */
function flippedNormals(s: UrinalSurface): number {
  FLIPPED.length = 0;
  let bad = 0;
  for (let j = 0; j < s.nv; j++) {
    for (let i = 0; i < s.nu - 1; i++) {
      const a = j * s.nu + i;
      const b = a + 1;
      const d =
        s.cellNormal[a * 3] * s.cellNormal[b * 3] +
        s.cellNormal[a * 3 + 1] * s.cellNormal[b * 3 + 1] +
        s.cellNormal[a * 3 + 2] * s.cellNormal[b * 3 + 2];
      if (d < 0) {
        bad++;
        FLIPPED.push(`u=${(((i + 0.5) / s.nu) * 2 - 1).toFixed(2)} v=${((j + 0.5) / s.nv).toFixed(3)}`);
      }
    }
  }
  return bad;
}

/**
 * A stricter reading: a cell whose normal opposes the mean of its four
 * neighbours. Reported alongside because the row-wise test cannot see a normal
 * that has turned across v, and a change to the loft can move a fault between the
 * two. Not the bar, but a regression here is worth knowing about.
 */
function oddNormals(s: UrinalSurface): number {
  let bad = 0;
  for (let j = 0; j < s.nv; j++) {
    for (let i = 0; i < s.nu; i++) {
      const c = j * s.nu + i;
      let ax = 0;
      let ay = 0;
      let az = 0;
      let n = 0;
      for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || ii >= s.nu || jj < 0 || jj >= s.nv) continue;
        const k = jj * s.nu + ii;
        ax += s.cellNormal[k * 3];
        ay += s.cellNormal[k * 3 + 1];
        az += s.cellNormal[k * 3 + 2];
        n++;
      }
      if (n === 0) continue;
      if (
        (s.cellNormal[c * 3] * ax + s.cellNormal[c * 3 + 1] * ay + s.cellNormal[c * 3 + 2] * az) / n <
        0
      )
        bad++;
    }
  }
  return bad;
}

/** Vertex at grid index. */
function vert(s: UrinalSurface, i: number, j: number): [number, number, number] {
  const o = (j * (s.nu + 1) + i) * 3;
  return [s.vertices[o], s.vertices[o + 1], s.vertices[o + 2]];
}

/**
 * How far the side boundary dips below the lower of its endpoints, m.
 *
 * The u = +-1 column runs from the back rim to the lip tip. On a basin it
 * descends monotonically between them; on the current loft it plunges to the
 * sump and climbs back, and that plunge is exactly the missing side wall.
 */
function sideDrop(s: UrinalSurface): number {
  let worst = 0;
  for (const i of [0, s.nu]) {
    const yTop = vert(s, i, 0)[1];
    const yEnd = vert(s, i, s.nv)[1];
    const floor = Math.min(yTop, yEnd);
    for (let j = 0; j <= s.nv; j++) {
      const d = floor - vert(s, i, j)[1];
      if (d > worst) worst = d;
    }
  }
  return worst;
}

/**
 * Width of the hole in the side of the bowl, m.
 *
 * The honest statement of "the interior has no side walls". The u = +1 boundary
 * is the only edge the surface has on that side, so wherever it crosses a given
 * height twice -- once on the way down the back, once on the way up the front --
 * the two crossings are the two lips of an open slot at that height, and nothing
 * spans between them. On a closed basin the boundary crosses each height once
 * and this is 0.
 *
 * Measured in plan, since the two lips are at the same height by construction.
 */
function sideOpen(s: UrinalSurface): { gap: number; atY: number } {
  const b = s.bounds();
  let worst = 0;
  let worstY = 0;
  const SAMPLES = 48;
  for (let k = 1; k < SAMPLES; k++) {
    const y = b.min.y + ((b.max.y - b.min.y) * k) / SAMPLES;
    const cross: Array<[number, number]> = [];
    for (let j = 0; j < s.nv; j++) {
      const a = vert(s, s.nu, j);
      const c = vert(s, s.nu, j + 1);
      if (a[1] === c[1]) continue;
      const t = (y - a[1]) / (c[1] - a[1]);
      if (t < 0 || t > 1) continue;
      cross.push([a[0] + (c[0] - a[0]) * t, a[2] + (c[2] - a[2]) * t]);
    }
    // Consecutive crossings bound an open slot; a single crossing is a closed rim.
    for (let n = 1; n < cross.length; n++) {
      const d = Math.hypot(cross[n][0] - cross[n - 1][0], cross[n][1] - cross[n - 1][1]);
      if (d > worst) {
        worst = d;
        worstY = y;
      }
    }
  }
  return { gap: worst, atY: worstY };
}

/** Backward excursion of the side edge relative to the front-most rim point. */
function notch(s: UrinalSurface): number {
  let worst = 0;
  for (const i of [0, s.nu]) {
    let maxZ = -Infinity;
    let minZ = Infinity;
    for (let j = 0; j <= s.nv; j++) {
      const z = vert(s, i, j)[2];
      if (z > maxZ) maxZ = z;
      if (z < minZ) minZ = z;
    }
    worst = Math.max(worst, maxZ - minZ);
  }
  return worst;
}

/** Where the worst-conditioned cells are, in (u, v), so a collapse can be placed. */
function skewMap(s: UrinalSurface): string {
  let worst = 2;
  let wu = 0;
  let wv = 0;
  // Histogram of degenerate cells by |u| decile, to say whether the collapse is
  // at the boundary, at the floor/wall corner, or spread out.
  const byU = new Array(10).fill(0);
  const byV = new Array(10).fill(0);
  for (let j = 0; j < s.nv; j++) {
    for (let i = 0; i < s.nu; i++) {
      const c = j * s.nu + i;
      const skew = s.cellArea[c] / Math.max(1e-18, s.cellDu[c] * s.cellDv[c]);
      const u = ((i + 0.5) / s.nu) * 2 - 1;
      const v = (j + 0.5) / s.nv;
      if (skew < worst) {
        worst = skew;
        wu = u;
        wv = v;
      }
      if (skew < 0.15) {
        byU[Math.min(9, Math.floor(Math.abs(u) * 10))]++;
        byV[Math.min(9, Math.floor(v * 10))]++;
      }
    }
  }
  const nz = (a: number[]) =>
    a.map((n, k) => (n > 0 ? `${k / 10}:${n}` : '')).filter(Boolean).join(' ') || '-';
  return `worst skew ${worst.toFixed(3)} at u=${wu.toFixed(2)} v=${wv.toFixed(2)}\n` +
    `      degen by |u| ${nz(byU)}\n      degen by v   ${nz(byV)}`;
}

const mm = (v: number) => (v * 1000).toFixed(1).padStart(7);

for (const preset of PRESETS) {
  if (only && !only.includes(preset.id)) continue;
  console.log(`\n${preset.id}`);
  console.log('   res        flip  odd  degen   skew   sideDrop sideOpen  notch  selfInt clamp');
  for (const res of RES) {
    const tag = `${res.nu}x${res.nv}`;
    if (resFilter && resFilter !== tag) continue;
    const s = new UrinalSurface({ ...preset.params }, res);
    const g = sideOpen(s);
    console.log(
      `  ${tag.padEnd(9)} ${String(flippedNormals(s)).padStart(4)} ${String(oddNormals(s)).padStart(4)} ` +
        `${String(s.degenerateCells).padStart(6)} ${s.worstCellSkew.toFixed(3).padStart(6)} ` +
        `${mm(sideDrop(s))} ${mm(g.gap)} ${mm(notch(s))}    ` +
        `${s.profile.info.selfIntersects ? 'YES' : ' no'}   ${s.profile.info.clamped ? 'YES' : ' no'}`
    );
    if (FLIPPED.length) console.log('      flipped at ' + FLIPPED.slice(0, 6).join(' | '));
  }
}
