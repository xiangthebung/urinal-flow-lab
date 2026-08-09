/**
 * The casting's top deck, column by column.
 *
 * The deck is the strip of ceramic between the outer wall and the cavity at each
 * angle's own top height, and its inner edge is found by raycasting the bowl.
 * This prints what that raycast actually returns, so the raw signal can be looked
 * at rather than inferred from the render.
 *
 * No source is modified: the probes are horizontal rays (`dir.y === 0`) and the
 * only other raycast in `buildShell` marches straight down, so wrapping
 * `UrinalSurface.raycast` and keeping the horizontal calls picks out exactly the
 * deck probes, in angular order.
 *
 * Usage: npx tsx tools/diag-deck.mts [preset-id]
 */
import { PRESETS } from '../src/geometry/presets';
import { UrinalSurface } from '../src/geometry/surface';
import { buildShell } from '../src/geometry/shell';

const id = process.argv[2] ?? 'classic-bowl';
const nu = Number(process.argv[3] ?? 56);
const nv = Number(process.argv[4] ?? 104);
const preset = PRESETS.find((p) => p.id === id)!;
const s = new UrinalSurface({ ...preset.params }, { nu, nv });

type Probe = { t: number; rOut: number; y: number; width: number | null };
const probes: Probe[] = [];
const real = s.raycast.bind(s);
(s as unknown as { raycast: typeof real }).raycast = (o, d, maxT) => {
  const hit = real(o, d, maxT);
  if (d.y === 0) {
    // dir = (-sin(t)*ex/m, 0, -cos(t)/m), unit length, so m is recoverable from
    // the ratio of the two components once ex is divided out of x.
    const th = Math.atan2(-d.x, -d.z); // = atan2(sin t * ex, cos t): scaled angle
    const m = 1; // |dir| is 1 by construction; hit.t is already a real distance
    void m;
    void th;
    probes.push({
      t: Math.atan2(-d.x, -d.z),
      rOut: maxT ?? 0,
      y: o.y,
      width: hit ? hit.t : null,
    });
  }
  return hit;
};

const shell = buildShell(s, { ...(preset.shell ?? {}) });

// The finished deck, read back off the mesh. Its vertices are the only ones in
// the casting pushed with an exactly vertical normal, and they come out in
// out/in pairs in angular order, so the real width of the strip at each column is
// just the distance between the two. Comparing that with the raw raycast is the
// check that smoothing the width has not let the deck reach out over the cavity:
// Trap 7(c) allows the raycast to narrow the strip and nothing to widen it.
const deck: Array<[number, number]> = [];
for (let k = 0; k < shell.normals.length / 3; k++) {
  if (shell.normals[k * 3] === 0 && shell.normals[k * 3 + 1] === 1 && shell.normals[k * 3 + 2] === 0) {
    deck.push([k, 0]);
  }
}
let worstOver = 0;
let worstAt = 0;
if (deck.length === 2 * probes.length) {
  for (let a = 0; a < probes.length; a++) {
    const o = deck[a * 2][0] * 3;
    const i2 = deck[a * 2 + 1][0] * 3;
    const w =
      Math.hypot(
        shell.positions[o] - shell.positions[i2],
        shell.positions[o + 1] - shell.positions[i2 + 1],
        shell.positions[o + 2] - shell.positions[i2 + 2]
      );
    const raw = probes[a].width;
    if (raw !== null && w - raw > worstOver) {
      worstOver = w - raw;
      worstAt = (probes[a].t * 180) / Math.PI;
    }
  }
} else {
  console.log(`  (deck readback: ${deck.length} vertices for ${probes.length} columns -- skipped)`);
}

console.log(`${id}: ${probes.length} horizontal deck probes`);
console.log(
  `deck overhang past the raw cavity: ${(worstOver * 1000).toFixed(1)} mm ` +
    `at ${worstAt.toFixed(1)} deg\n`
);
console.log('  col   angle°     y mm   rayLen mm   rawWidth mm');
const mm = (n: number) => (n * 1000).toFixed(1).padStart(9);
let jumps = 0;
let maxJump = 0;
for (let i = 0; i < probes.length; i++) {
  const p = probes[i];
  const w = p.width;
  const prev = i > 0 ? probes[i - 1].width : null;
  if (prev !== null && w !== null) {
    const j = Math.abs(w - prev);
    if (j > maxJump) maxJump = j;
    if (j > 0.005) jumps++;
  }
  if (prev === null !== (w === null)) jumps++;
  console.log(
    `  ${String(i).padStart(3)} ${((p.t * 180) / Math.PI).toFixed(1).padStart(7)} ` +
      `${mm(p.y)} ${mm(p.rOut)} ${w === null ? '     null' : mm(w)}`
  );
}
console.log(
  `\njumps over 5 mm between neighbouring columns: ${jumps}   largest: ${(
    maxJump * 1000
  ).toFixed(1)} mm`
);
const nulls = probes.filter((p) => p.width === null).length;
console.log(`null (no cavity found): ${nulls} of ${probes.length}`);
