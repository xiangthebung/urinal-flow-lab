/**
 * Is the coherent-jet regime reachable at all from the UI?
 *
 * Trap 18 says the parabolic wetted patch belongs to the coherent-jet regime and
 * must not be forced, and `depositJet` supplies the physics for it. But that path
 * only runs when a parcel is still `coherent` on arrival, so it is worth knowing
 * whether any combination of the controls a designer actually has puts the wall
 * inside the breakup length -- otherwise the most carefully described mechanism
 * in the model is one nobody can ever see.
 *
 * Walks stand-off against aim for every preset and prints the shortest traced
 * path, against the longest breakup length the flow curve reaches.
 */
import { applyPreset, Simulation, defaultConfig } from '../src/sim/simulation';
import { PRESETS } from '../src/geometry/presets';
import { solveBreakup } from '../src/sim/stream';

const STANDOFFS = [0.02, 0.06, 0.12, 0.2];

for (const preset of PRESETS) {
  const cfg = defaultConfig();
  applyPreset(cfg, preset);
  const sim = new Simulation(cfg);

  // Longest breakup length anywhere on the flow curve.
  let lMax = 0;
  const flow = sim.emitter.flow;
  for (let k = 1; k < 200; k++) {
    const t = (k / 200) * flow.duration;
    const v = sim.emitter.speedAt(t);
    const d = sim.emitter.diameterAt(t);
    if (v <= 0) continue;
    const b = solveBreakup(cfg.fluid, d, v, cfg.stream.disturbanceRatio, cfg.stream.satelliteFraction);
    lMax = Math.max(lMax, b.breakupLength);
  }

  let best = Infinity;
  let bestAt = '';
  for (const so of STANDOFFS) {
    cfg.stream.standoff = so;
    sim.rebuild();
    for (let vi = 0; vi <= 40; vi++) {
      const v = vi / 40;
      cfg.aimTargetV = v;
      if (!sim.aimAtProfileFraction(v)) continue;
      const tr = sim.traceAim();
      if (!tr.reached) continue;
      let len = 0;
      for (let i = 1; i < tr.points.length; i++) {
        const a = tr.points[i - 1];
        const b2 = tr.points[i];
        len += Math.hypot(b2.x - a.x, b2.y - a.y, b2.z - a.z);
      }
      if (len < best) {
        best = len;
        bestAt = `standoff ${(so * 100).toFixed(0)} cm, aimV ${v.toFixed(2)}, ${((tr.angle * 180) / Math.PI).toFixed(0)} deg`;
      }
    }
  }
  const verdict = best <= lMax ? 'REACHABLE' : 'never coherent';
  console.log(
    `${preset.id.padEnd(19)} max breakup ${(lMax * 100).toFixed(1).padStart(5)} cm  ` +
      `shortest reachable wall ${(best * 100).toFixed(1).padStart(5)} cm  ${verdict.padEnd(14)} (${bestAt})`
  );
}
