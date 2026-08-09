/**
 * Aim admissibility bench.
 *
 * Answers, for every preset, the two questions Traps 44 and 45 exist because
 * nobody was asking:
 *
 *   1. Is the fixture's own `defaultAimV` blocked by its own casting?
 *      `compact-waterless` shipped for a long time with a default aim that was a
 *      rim strike -- Trap 14's worst outcome, reported as the model's nominal
 *      behaviour on every run anyone ever did of that preset. It stayed invisible
 *      because the reach readout raycast the interior alone and answered "no wall"
 *      rather than "the casting is in the way".
 *
 *   2. Is it *adjacent* to a blocked aim? Where the trace catches the rim edge-on
 *      it returns `reached` with an impingement angle of essentially zero, which
 *      then wins "best aim" outright. That is the worst possible recommendation:
 *      one sweep step either way puts the stream on the outside of the fixture,
 *      and the model's own tremor is larger than that step.
 *
 * Adjacency is tested at the application's own sweep granularity (13 points from
 * v = 0.04 to 0.54, so a step of 1/24) because that is the resolution at which the
 * recommendation is actually made, and again at a finer step so a narrow blocked
 * sliver between two reachable aims cannot hide between samples.
 *
 *   npx tsx tools/aimcheck.mts            all presets
 *   npx tsx tools/aimcheck.mts trough     one preset, with the full band map
 */
import { PRESETS, getPreset } from '../src/geometry/presets';
import { Simulation, defaultConfig, SimConfig } from '../src/sim/simulation';

const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('--'));

/** The step the application's own aim sweep uses: 13 points over v = 0.04..0.54. */
const SWEEP_STEP = 0.5 / 12;

const configFor = (id: string, v: number): SimConfig => {
  const p = getPreset(id);
  const c = defaultConfig();
  c.surface = { ...p.params };
  c.casting = { ...(p.shell ?? {}) };
  c.fittings = { ...(p.fittings ?? {}) };
  // The coarse grid: this is a geometry question, and the casting -- which is what
  // does the blocking -- is fitted from the interior at whatever resolution it is
  // given. 48x96 is what the validation suite uses.
  c.resolutionU = 48;
  c.resolutionV = 96;
  c.aimTargetV = v;
  return c;
};

type Probe = { v: number; blocked: boolean; reached: boolean; angleDeg: number };

const probe = (id: string, v: number): Probe => {
  const sim = new Simulation(configFor(id, v));
  const tr = sim.traceAim();
  return {
    v,
    blocked: tr.blocked,
    reached: tr.reached,
    angleDeg: (tr.angle * 180) / Math.PI,
  };
};

const presets = only ? PRESETS.filter((p) => p.id === only) : PRESETS;
if (presets.length === 0) {
  console.error(`no such model: ${only}`);
  console.error(`available: ${PRESETS.map((p) => p.id).join(', ')}`);
  process.exit(1);
}

let failures = 0;

for (const p of presets) {
  const dv = p.defaultAimV ?? 0.18;
  console.log('');
  console.log(`${p.id}  (defaultAimV ${dv})`);

  const at = probe(p.id, dv);
  const neighbours: Probe[] = [];
  // The sweep's own step in both directions, then half of it, so a blocked sliver
  // narrower than the sweep grid still shows up.
  for (const d of [-SWEEP_STEP, -SWEEP_STEP / 2, SWEEP_STEP / 2, SWEEP_STEP]) {
    const v = dv + d;
    if (v <= 0.005 || v >= 0.98) continue;
    neighbours.push(probe(p.id, v));
  }

  const state = (q: Probe) =>
    q.blocked ? 'BLOCKED' : q.reached ? `${q.angleDeg.toFixed(1)}°` : 'no hit';

  console.log(`  at default            ${state(at)}`);
  console.log(
    `  neighbours            ${neighbours
      .map((q) => `${q.v.toFixed(3)}:${state(q)}`)
      .join('  ')}`
  );

  const adjacentBlocked = neighbours.some((q) => q.blocked);
  // "No hit" is not a pass either: it means the ballistic arc found neither the
  // interior nor the casting, i.e. the stream sails past the fixture entirely.
  const ok = !at.blocked && at.reached && !adjacentBlocked;
  if (at.blocked) console.log('  *** REJECT: default aim is blocked by the casting (Trap 44).');
  else if (!at.reached) console.log('  *** REJECT: default aim reaches nothing at all.');
  if (adjacentBlocked)
    console.log('  *** REJECT: default aim is adjacent to a blocked aim (Trap 45) — a graze.');
  if (!ok) failures++;
  else console.log(`  verdict               OK`);

  if (only) {
    // Full band map, at a step fine enough to see where the boundary really is.
    const map: string[] = [];
    let firstReach = NaN;
    let lastReach = NaN;
    let minA = Infinity;
    let maxA = -Infinity;
    for (let v = 0.02; v <= 0.90001; v += 0.02) {
      const q = probe(p.id, v);
      map.push(`${v.toFixed(2)}:${q.blocked ? 'X' : q.reached ? q.angleDeg.toFixed(0) : '-'}`);
      if (!q.blocked && q.reached) {
        if (Number.isNaN(firstReach)) firstReach = v;
        lastReach = v;
        minA = Math.min(minA, q.angleDeg);
        maxA = Math.max(maxA, q.angleDeg);
      }
    }
    console.log(`  band (X = blocked, - = no hit, else impingement angle in degrees)`);
    for (let i = 0; i < map.length; i += 8) {
      console.log(`    ${map.slice(i, i + 8).join('  ')}`);
    }
    console.log(
      `  reachable v           ${firstReach.toFixed(2)} .. ${lastReach.toFixed(2)}` +
        `   angles ${minA.toFixed(0)}° .. ${maxA.toFixed(0)}°  (spread ${(maxA - minA).toFixed(0)}°)`
    );
  }
}

console.log('');
console.log(
  failures === 0
    ? `all ${presets.length} preset default aims are reachable and not grazing`
    : `${failures} of ${presets.length} preset default aims REJECTED`
);
process.exit(failures === 0 ? 0 : 1);
