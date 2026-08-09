/**
 * Why the boundary cells collapse: the rim curve against the profile, station by
 * station.
 *
 * At u = +-1 both parametric tangents lie in the sagittal plane -- the u tangent
 * is the row arriving at the rim, the v tangent is the rim's own direction of
 * travel. A cell there is well shaped only while those two are at a healthy
 * angle, so that angle is the quantity to look at, not the shape of either curve
 * on its own.
 *
 * Usage: npx tsx tools/diag-rim.mts <preset-id>
 */
import { PRESETS } from '../src/geometry/presets';
import { UrinalSurface } from '../src/geometry/surface';

const id = process.argv[2] ?? 'classic-bowl';
const preset = PRESETS.find((p) => p.id === id)!;
const s = new UrinalSurface({ ...preset.params }, { nu: 112, nv: 200 });

const stride = s.nu + 1;
const at = (i: number, j: number) => {
  const o = (j * stride + i) * 3;
  return { x: s.vertices[o], y: s.vertices[o + 1], z: s.vertices[o + 2] };
};

console.log(`${id}  nu=${s.nu} nv=${s.nv}`);
console.log(
  '   v   profile(z,y)      rim(z,y)        wrap    lift    span   rowLen  ' +
    'arrive°  rimTan°  angle°   skew'
);
for (let j = 0; j <= s.nv; j += 5) {
  const p = s.profile.points[j];
  const rim = at(s.nu, j);
  // Row arrival direction at the rim, from the last two vertices of the row.
  const prev = at(s.nu - 1, j);
  const au = { y: rim.y - prev.y, z: rim.z - prev.z, x: rim.x - prev.x };
  // Rim tangent along v.
  const j0 = Math.max(0, j - 1);
  const j1 = Math.min(s.nv, j + 1);
  const a = at(s.nu, j0);
  const b = at(s.nu, j1);
  const av = { y: b.y - a.y, z: b.z - a.z, x: b.x - a.x };
  const deg = (o: { y: number; z: number }) => (Math.atan2(o.y, o.z) * 180) / Math.PI;
  const dot = au.x * av.x + au.y * av.y + au.z * av.z;
  const m = Math.hypot(au.x, au.y, au.z) * Math.hypot(av.x, av.y, av.z);
  const ang = (Math.acos(Math.max(-1, Math.min(1, dot / (m || 1)))) * 180) / Math.PI;
  // Row length, in 3-D.
  let len = 0;
  for (let i = s.nu / 2; i < s.nu; i++) {
    const q = at(i, j);
    const r = at(i + 1, j);
    len += Math.hypot(r.x - q.x, r.y - q.y, r.z - q.z);
  }
  const c = Math.min(s.nv - 1, j) * s.nu + (s.nu - 1);
  const skew = s.cellArea[c] / Math.max(1e-18, s.cellDu[c] * s.cellDv[c]);
  const f = (n: number, w = 7) => (n * 1000).toFixed(1).padStart(w);
  console.log(
    `  ${(j / s.nv).toFixed(2)} ${f(p.z, 6)},${f(p.y, 7)}  ${f(rim.z, 6)},${f(rim.y, 7)} ` +
      `${f(rim.z - p.z)} ${f(rim.y - p.y)} ${f(rim.x - 0)} ${f(len)} ` +
      `${deg(au).toFixed(1).padStart(7)} ${deg(av).toFixed(1).padStart(8)} ` +
      `${ang.toFixed(1).padStart(7)} ${skew.toFixed(3).padStart(6)}`
  );
}
