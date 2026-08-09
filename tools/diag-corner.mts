/**
 * The last two rows of the patch, cell by cell, near the outer corner.
 *
 * Everything left after the rim was reshaped sits at v = 0.99 and |u| = 0.95, on
 * exactly the three presets whose front lip curls back over the bowl by 30 mm. So
 * the question is what the normals are actually doing where a rising corner meets
 * an overhang, and that needs the vectors, not another hypothesis.
 */
import { PRESETS } from '../src/geometry/presets';
import { UrinalSurface } from '../src/geometry/surface';

const id = process.argv[2] ?? 'classic-bowl';
const preset = PRESETS.find((p) => p.id === id)!;
const s = new UrinalSurface({ ...preset.params }, { nu: 112, nv: 200 });

const stride = s.nu + 1;
const vert = (i: number, j: number) => {
  const o = (j * stride + i) * 3;
  return [s.vertices[o], s.vertices[o + 1], s.vertices[o + 2]];
};

console.log(`${id}  frontLipInturn=${preset.params.frontLipInturn}  wrapExponent=${preset.params.wrapExponent}`);
for (const j of [s.nv - 3, s.nv - 2, s.nv - 1]) {
  console.log(`\n row j=${j}  v=${((j + 0.5) / s.nv).toFixed(4)}`);
  console.log('    i     u      vertex(x,y,z) mm            normal            dot(prev)  skew');
  let prev: number[] | null = null;
  for (let i = s.nu - 8; i < s.nu; i++) {
    const c = j * s.nu + i;
    const n = [s.cellNormal[c * 3], s.cellNormal[c * 3 + 1], s.cellNormal[c * 3 + 2]];
    const d = prev ? n[0] * prev[0] + n[1] * prev[1] + n[2] * prev[2] : 1;
    const p = vert(i, j);
    const skew = s.cellArea[c] / Math.max(1e-18, s.cellDu[c] * s.cellDv[c]);
    console.log(
      `  ${String(i).padStart(3)} ${(((i + 0.5) / s.nu) * 2 - 1).toFixed(3)} ` +
        `${p.map((q) => (q * 1000).toFixed(1).padStart(7)).join(',')}   ` +
        `${n.map((q) => q.toFixed(3).padStart(6)).join(',')}   ` +
        `${d.toFixed(3).padStart(7)}  ${skew.toFixed(3)}`
    );
    prev = n;
  }
}
