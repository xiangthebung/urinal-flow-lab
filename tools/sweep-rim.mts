/**
 * Sweep the loft's free shape constants against grid admissibility.
 *
 * Everything here trades the same thing against itself: how the rim behaves where
 * the front rise is climbing toward it, against how the rows meet the lip. None of
 * it can be reasoned to a value, and picking one from a single preset at a single
 * resolution is exactly how the constant-angle model came out clean at 48x96 and
 * grew 153 degenerate cells at 112x200. So the score is the total over all six
 * presets at all four grids, and nothing counts as clean unless every one is.
 *
 * `flip` is the shape bench's own definition -- two cells side by side in a row
 * whose normals oppose -- because that is the number the verification bar is
 * stated in.
 */
import { PRESETS } from '../src/geometry/presets';
import { UrinalSurface, WALL_SHAPE } from '../src/geometry/surface';
import { RIM_SHAPE } from '../src/geometry/wrap';

const RESOLUTIONS = [
  { nu: 48, nv: 96 },
  { nu: 56, nv: 104 },
  { nu: 72, nv: 132 },
  { nu: 112, nv: 200 },
];

function flipped(s: UrinalSurface): number {
  let bad = 0;
  for (let j = 0; j < s.nv; j++) {
    for (let i = 0; i < s.nu - 1; i++) {
      const a = j * s.nu + i;
      const b = a + 1;
      if (
        s.cellNormal[a * 3] * s.cellNormal[b * 3] +
          s.cellNormal[a * 3 + 1] * s.cellNormal[b * 3 + 1] +
          s.cellNormal[a * 3 + 2] * s.cellNormal[b * 3 + 2] <
        0
      )
        bad++;
    }
  }
  return bad;
}

function vert(s: UrinalSurface, i: number, j: number): [number, number, number] {
  const o = (j * (s.nu + 1) + i) * 3;
  return [s.vertices[o], s.vertices[o + 1], s.vertices[o + 2]];
}

/** How far the u = +-1 boundary dips below the lower of its two endpoints, m. */
function sideDrop(s: UrinalSurface): number {
  let worst = 0;
  for (const i of [0, s.nu]) {
    const floor = Math.min(vert(s, i, 0)[1], vert(s, i, s.nv)[1]);
    for (let j = 0; j <= s.nv; j++) worst = Math.max(worst, floor - vert(s, i, j)[1]);
  }
  return worst;
}

/** Width of the open slot down the side of the bowl, m. Zero on a closed basin. */
function sideOpen(s: UrinalSurface): number {
  const b = s.bounds();
  let worst = 0;
  for (let k = 1; k < 48; k++) {
    const y = b.min.y + ((b.max.y - b.min.y) * k) / 48;
    const cross: Array<[number, number]> = [];
    for (let j = 0; j < s.nv; j++) {
      const a = vert(s, s.nu, j);
      const c = vert(s, s.nu, j + 1);
      if (a[1] === c[1]) continue;
      const t = (y - a[1]) / (c[1] - a[1]);
      if (t < 0 || t > 1) continue;
      cross.push([a[0] + (c[0] - a[0]) * t, a[2] + (c[2] - a[2]) * t]);
    }
    for (let n = 1; n < cross.length; n++) {
      worst = Math.max(
        worst,
        Math.hypot(cross[n][0] - cross[n - 1][0], cross[n][1] - cross[n - 1][1])
      );
    }
  }
  return worst;
}

const slopes = [14, 20, 30, 50, 100, 1e6];
const leans = [0.19];

console.log('slope  endReach  flip  degen  worstSkew  sideDrop sideOpen   per-preset flip');
for (const sl of slopes) {
  for (const el of leans) {
   for (const lf of [0]) {
    RIM_SHAPE.endLift = lf;
    WALL_SHAPE.rimLean = lf;
    WALL_SHAPE.maxSlope = sl;
    RIM_SHAPE.endReach = el;
    let degen = 0;
    let flip = 0;
    let worst = 2;
    let openWorst = 0;
    let dropWorst = 0;
    let maxWide = 0;
    const per: string[] = [];
    for (const p of PRESETS) {
      let pf = 0;
      let wideRatio = 0;
      for (const res of RESOLUTIONS) {
        const s = new UrinalSurface({ ...p.params }, res);
        degen += s.degenerateCells;
        pf += flipped(s);
        worst = Math.min(worst, s.worstCellSkew);
        dropWorst = Math.max(dropWorst, sideDrop(s));
        openWorst = Math.max(openWorst, sideOpen(s));
        const b = s.bounds();
        wideRatio = Math.max(wideRatio, (b.max.x - b.min.x) / p.params.widthRim);
      }
      flip += pf;
      per.push(`${pf}/${wideRatio.toFixed(2)}`);
      maxWide = Math.max(maxWide, wideRatio);
    }
    const clean = degen === 0 && flip === 0 && openWorst < 1e-4 && dropWorst < 1e-4 && maxWide < 1.06;
    console.log(
      `  ${String(sl).padStart(3)}  ${el.toFixed(2)}  ${String(flip).padStart(6)} ` +
        `${String(degen).padStart(6)}  ${worst.toFixed(3).padStart(8)}  ` +
        `${(dropWorst*1000).toFixed(1).padStart(6)} ${(openWorst*1000).toFixed(1).padStart(6)} w${maxWide.toFixed(2)}  ` +
        `lf ${lf.toFixed(2)}  ${per.join(' ')}${clean ? '  <<< CLEAN' : ''}`
    );
  }
 }
}
