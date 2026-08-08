/**
 * Whole-library admissibility sweep.
 *
 * `fixture-lab` shapes one fixture; this runs the same metrics over every preset at
 * every grid resolution and prints one table, because the acceptance criterion for
 * the library is a property of the *set*: 0 flipped normals, 0 degenerate cells, no
 * self-intersection and no clamped parameters, on all of them, at all four
 * resolutions.
 *
 * All four resolutions is the load-bearing part. Trap 3 hides specifically from
 * anyone who runs only the coarse grids: a wrap change that was perfectly clean at
 * 48x96 and 56x104 grew 26 degenerate cells at 72x132 and 153 at 112x200. One
 * process rather than six `tsx` starts, so the whole library costs about what a
 * single `fixture-lab --full` does.
 *
 *   npx tsx tools/labsheet.mts
 *   npx tsx tools/labsheet.mts --quick     48x96 and 112x200 only, for iterating
 */
import { PRESETS } from '../src/geometry/presets';
import { buildShell } from '../src/geometry/shell';
import { UrinalSurface } from '../src/geometry/surface';
import { unionBox } from '../src/render/softRaster';

const args = process.argv.slice(2);
const quick = args.includes('--quick');

const RES: Array<[number, number]> = quick
  ? [
      [48, 96],
      [112, 200],
    ]
  : [
      [48, 96],
      [56, 104],
      [72, 132],
      [112, 200],
    ];

type Row = {
  id: string;
  res: string;
  w: number;
  d: number;
  h: number;
  flipped: number;
  degen: number;
  selfInt: boolean;
  clamped: boolean;
  notch: number;
  openMouth: number;
  protrude: number;
  ribbing: number;
  skew: number;
  notes: string[];
};

const rows: Row[] = [];

for (const preset of PRESETS) {
  for (const [nu, nv] of RES) {
    const s = new UrinalSurface(preset.params, { nu, nv });
    const shell = buildShell(s, preset.shell ?? {});
    const box = unionBox(s.bounds(), { min: shell.min, max: shell.max });

    // Neighbouring cells across u whose normals disagree. A flipped normal
    // silently inverts gravity and the impingement angle in the cell it is in,
    // which is why this is a reject rather than a blemish.
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

    // The surface's own skew measure -- area / (lu * lv), 1 when orthogonal --
    // rather than one derived from the stored tangents, which are orthogonalised
    // by construction and so read 1.00 everywhere and tell you nothing. This is
    // the quantity the doc tracks at 0.42-0.99, and `degenerateCells` counts the
    // cells that fall below 0.15 on it.
    const skew = s.worstCellSkew;

    // Notch: how far the u = +-1 side edge dives back toward the mounting plane
    // below its height at the rim. That edge is the rim of the opening, so a big
    // number means the bowl is slit open at the sides.
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

    rows.push({
      id: preset.id,
      res: `${nu}x${nv}`,
      w: (box.max.x - box.min.x) * 1000,
      d: (box.max.z - box.min.z) * 1000,
      h: (box.max.y - box.min.y) * 1000,
      flipped,
      degen: s.degenerateCells,
      selfInt: s.profile.info.selfIntersects,
      clamped: s.profile.info.clamped,
      notch: (zRim - zMin) * 1000,
      openMouth: (lz1 - lz0) * 1000,
      protrude: shell.fit.protrusion,
      ribbing: shell.fit.ribbing,
      skew,
      notes: s.profile.info.notes,
    });
  }
}

console.log(
  'preset             res       W x D x H mm      flip degen selfI clamp  notch  mouth  protr   ribb   skew'
);
for (const r of rows) {
  console.log(
    [
      r.id.padEnd(18),
      r.res.padEnd(9),
      `${r.w.toFixed(0)} x ${r.d.toFixed(0)} x ${r.h.toFixed(0)}`.padEnd(17),
      String(r.flipped).padStart(4),
      String(r.degen).padStart(5),
      String(r.selfInt).padStart(5),
      String(r.clamped).padStart(5),
      `${r.notch.toFixed(0)}mm`.padStart(6),
      `${r.openMouth.toFixed(0)}mm`.padStart(6),
      `${r.protrude.toFixed(1)}mm`.padStart(6),
      `${r.ribbing.toFixed(1)}mm`.padStart(6),
      r.skew.toFixed(2).padStart(6),
    ].join(' ')
  );
}

// -- Verdict ---------------------------------------------------------------
// Reported per preset rather than per row, because the criterion is that a
// preset is clean at *every* resolution -- one bad row condemns the model.
console.log('');
const ids = [...new Set(rows.map((r) => r.id))];
let bad = 0;
for (const id of ids) {
  const rs = rows.filter((r) => r.id === id);
  const flip = Math.max(...rs.map((r) => r.flipped));
  const degen = Math.max(...rs.map((r) => r.degen));
  const si = rs.some((r) => r.selfInt);
  const cl = rs.some((r) => r.clamped);
  const protr = Math.max(...rs.map((r) => r.protrude));
  const ribb = Math.max(...rs.map((r) => r.ribbing));
  const notch = Math.max(...rs.map((r) => r.notch));
  const skew = Math.min(...rs.map((r) => r.skew));
  const fail = flip > 0 || degen > 0 || si || cl || protr > 0.01;
  if (fail) bad++;
  const why = [
    flip > 0 ? `${flip} flipped` : '',
    degen > 0 ? `${degen} degenerate` : '',
    si ? 'self-intersects' : '',
    cl ? 'CLAMPED' : '',
    protr > 0.01 ? `protrudes ${protr.toFixed(1)}mm` : '',
  ]
    .filter(Boolean)
    .join(', ');
  console.log(
    `${fail ? 'REJECT ' : 'ok     '}${id.padEnd(18)} ` +
      `notch<=${notch.toFixed(0)}mm  ribbing<=${ribb.toFixed(1)}mm  skew>=${skew.toFixed(2)}` +
      (why ? `   ${why}` : '')
  );
  if (cl) {
    for (const n of new Set(rs.flatMap((r) => r.notes))) console.log(`         ! ${n}`);
  }
}
console.log('');
console.log(
  bad === 0
    ? `all ${ids.length} presets clean at ${RES.length} resolutions`
    : `${bad} of ${ids.length} presets REJECTED`
);
process.exit(bad === 0 ? 0 : 1);
