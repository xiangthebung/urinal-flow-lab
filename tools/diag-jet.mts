/**
 * What the jet actually is at the wall, in numbers.
 *
 * Written for the realism audit: every claim about how the stream should *look*
 * has to be anchored to what the solver says it *is*. Prints, across the flow
 * curve: exit speed and diameter, breakup length against the distance the stream
 * has to travel, how many parcels are still coherent on arrival, the deposition
 * footprint in cells, and the cell size at the impact.
 *
 *   npx tsx tools/diag-jet.mts [preset]
 */
import { applyPreset, Simulation, defaultConfig } from '../src/sim/simulation';
import { getPreset } from '../src/geometry/presets';
import { solveBreakup } from '../src/sim/stream';
import { PFlag } from '../src/sim/particles';

const id = process.argv[2] ?? 'classic-bowl';
const preset = getPreset(id);
const cfg = defaultConfig();
applyPreset(cfg, preset);

const sim = new Simulation(cfg);
sim.restart();

const trace = sim.traceAim();
let pathLength = 0;
for (let i = 1; i < trace.points.length; i++) {
  const a = trace.points[i - 1];
  const b2 = trace.points[i];
  pathLength += Math.hypot(b2.x - a.x, b2.y - a.y, b2.z - a.z);
}
console.log(`preset ${id}  aimV ${cfg.aimTargetV}`);
console.log(
  `trace: reached=${trace.reached} blocked=${trace.blocked} pathLen=${(pathLength * 100).toFixed(1)} cm ` +
    `angle=${((trace.angle * 180) / Math.PI).toFixed(1)} deg`
);

const flow = sim.emitter.flow;
console.log(`\nvoid ${(flow.voidVolume * 1e6).toFixed(0)} mL over ${flow.duration.toFixed(1)} s`);
console.log(
  '   t/T      Q mL/s   v m/s   d mm   lambda mm   Lbreak cm   reach cm   coherent?'
);
for (const frac of [0.02, 0.05, 0.1, 0.24, 0.4, 0.6, 0.8, 0.95]) {
  const t = frac * flow.duration;
  const q = flow.rateAt(t);
  const v = sim.emitter.speedAt(t);
  const d = sim.emitter.diameterAt(t);
  const b = solveBreakup(cfg.fluid, d, v, cfg.stream.disturbanceRatio, cfg.stream.satelliteFraction);
  const reach = pathLength;
  console.log(
    `  ${frac.toFixed(2)}   ${(q * 1e6).toFixed(2).padStart(7)}  ${v.toFixed(2).padStart(6)}  ` +
      `${(d * 1e3).toFixed(2).padStart(5)}  ${(b.wavelength * 1e3).toFixed(1).padStart(9)}  ` +
      `${(b.breakupLength * 100).toFixed(1).padStart(9)}  ${(reach * 100).toFixed(1).padStart(8)}   ` +
      `${b.breakupLength >= reach ? 'JET' : 'drops'}`
  );
}

// Run to peak and inspect what is actually in flight and on the wall.
const tPeak = flow.peakFraction * flow.duration;
while (sim.time < tPeak) sim.step();
const ps = sim.particles;
let coherent = 0;
let live = 0;
let primary = 0;
let secondary = 0;
let sat = 0;
for (let i = 0; i < ps.highWater; i++) {
  const f = ps.flags[i];
  if ((f & PFlag.Alive) === 0) continue;
  live++;
  if (f & PFlag.Coherent) coherent++;
  else if (f & PFlag.Secondary) secondary++;
  else if (f & PFlag.Satellite) sat++;
  else primary++;
}
console.log(
  `\nat t=${tPeak.toFixed(2)} s: live ${live}  coherent ${coherent}  primary ${primary}  ` +
    `satellite ${sat}  splash ${secondary}`
);

// Cell metric near the impact, and the jet footprint in cells.
const s = sim.surface;
const impact = sim.impact.last;
const b = solveBreakup(
  cfg.fluid,
  sim.emitter.diameterAt(tPeak),
  sim.emitter.speedAt(tPeak),
  cfg.stream.disturbanceRatio,
  cfg.stream.satelliteFraction
);
const dJet = sim.emitter.diameterAt(tPeak);
const foot = dJet * cfg.impact.jetFootprintRatio;
let duMin = Infinity;
let duMax = 0;
let dvMin = Infinity;
let dvMax = 0;
for (let c = 0; c < s.cellDu.length; c++) {
  duMin = Math.min(duMin, s.cellDu[c]);
  duMax = Math.max(duMax, s.cellDu[c]);
  dvMin = Math.min(dvMin, s.cellDv[c]);
  dvMax = Math.max(dvMax, s.cellDv[c]);
}
console.log(
  `\ngrid ${s.nu}x${s.nv}: cellDu ${(duMin * 1e3).toFixed(2)}-${(duMax * 1e3).toFixed(2)} mm  ` +
    `cellDv ${(dvMin * 1e3).toFixed(2)}-${(dvMax * 1e3).toFixed(2)} mm`
);
console.log(
  `jet d ${(dJet * 1e3).toFixed(2)} mm  wavelength ${(b.wavelength * 1e3).toFixed(1)} mm  ` +
    `main drop ${(b.mainDropletDiameter * 1e3).toFixed(2)} mm  satellite ${(b.satelliteDiameter * 1e3).toFixed(2)} mm`
);
console.log(
  `coherent footprint radius ${(foot * 1e3).toFixed(1)} mm = ` +
    `${(foot / duMax).toFixed(2)}..${(foot / duMin).toFixed(2)} cells in u, ` +
    `${(foot / dvMax).toFixed(2)}..${(foot / dvMin).toFixed(2)} in v (code rounds and caps at 3)`
);
console.log(
  `droplet footprint radius ${((b.mainDropletDiameter * 0.75) * 1e3).toFixed(2)} mm = ` +
    `${((b.mainDropletDiameter * 0.75) / duMax).toFixed(2)}..${((b.mainDropletDiameter * 0.75) / duMin).toFixed(2)} cells in u`
);
if (impact) {
  console.log(
    `last impact: alpha ${((impact.impingementAngle * 180) / Math.PI).toFixed(1)} deg  ` +
      `WeN ${impact.weberNormal.toFixed(0)}  h/d ${impact.filmRatio.toFixed(3)}  ` +
      `K/Kc ${impact.thresholdRatio.toFixed(2)}  split ${(impact.splashedFraction * 100).toFixed(1)}%`
  );
}

// Film state.
const film = sim.film;
let wetCells = 0;
let hMax = 0;
for (let c = 0; c < film.h.length; c++) {
  if (film.h[c] > 2e-6 * 4) wetCells++;
  hMax = Math.max(hMax, film.h[c]);
}
console.log(
  `film: ${wetCells}/${film.h.length} cells wet, max thickness ${(hMax * 1e6).toFixed(0)} um, ` +
    `retention ${(cfg.film.retentionThickness * 1e6).toFixed(0)} um, held ${(film.totalVolume() * 1e6).toFixed(1)} mL`
);

// Where the liquid actually is, by thickness. The appearance of the wall is a
// nonlinear function of this, so the *distribution* is what matters and the mean
// is misleading: 20 um of mean over a cell is a third of a millimetre of rivulet
// over a twentieth of it.
const bands = [2e-6, 8e-6, 2e-5, 5e-5, 1.5e-4, 4e-4, 1e-3, 3e-3, 1];
const labels = ['<2um', '2-8', '8-20', '20-50', '50-150', '150-400', '0.4-1mm', '1-3mm', '>3mm'];
const areaIn = new Array(bands.length).fill(0);
const volIn = new Array(bands.length).fill(0);
let totalArea = 0;
for (let c = 0; c < film.h.length; c++) {
  const h = film.h[c];
  const a = sim.surface.cellArea[c];
  totalArea += a;
  let k = 0;
  while (k < bands.length - 1 && h > bands[k]) k++;
  areaIn[k] += a;
  volIn[k] += h * a;
}
console.log('\nfilm thickness distribution (peak flow):');
for (let k = 0; k < bands.length; k++) {
  if (areaIn[k] <= 0) continue;
  console.log(
    `  ${labels[k].padEnd(9)} ${((100 * areaIn[k]) / totalArea).toFixed(1).padStart(5)}% of area   ` +
      `${(volIn[k] * 1e6).toFixed(2).padStart(8)} mL`
  );
}
