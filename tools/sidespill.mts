/**
 * Trap 23's residual: how much of what lands runs off the side edge of the patch.
 *
 * The contact-line test at the boundary halved this from 17.8% to 8.4% on the
 * default bowl, and the remainder was left undiagnosed. It is not a solver
 * problem. The `u = +-1` boundary used to run from the back rim *down through the
 * sump* and back up to the lip, so film reaching it was leaving at the bottom of
 * the bowl, where a real fixture has a side wall and nothing can leave at all.
 * Closing the basin should therefore drop this on its own, without touching the
 * film solver -- which makes it the honest test of whether the geometry change is
 * real rather than cosmetic.
 *
 * Reported as a fraction of deposited volume, per preset, at a fixed seed and
 * stand-off so the two sides of the comparison are the same run.
 *
 * Usage: npx tsx tools/sidespill.mts [--void 300] [--seed 12345]
 */
import { PRESETS, getPreset } from '../src/geometry/presets';
import { Simulation, defaultConfig } from '../src/sim/simulation';

const args = process.argv.slice(2);
const arg = (k: string, d: number): number => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const voidMl = arg('void', 300);
const seed = arg('seed', 12345);

console.log(`void ${voidMl} mL, seed ${seed}, 48x96\n`);
console.log('preset               deposited   side    top    lip   side%  closure%');
for (const p of PRESETS) {
  const cfg = defaultConfig();
  cfg.surface = { ...getPreset(p.id).params };
  cfg.casting = { ...(getPreset(p.id).shell ?? {}) };
  cfg.stream.voidVolume = voidMl * 1e-6;
  cfg.seed = seed;
  cfg.drainTime = 8;
  cfg.resolutionU = 48;
  cfg.resolutionV = 96;
  cfg.particleCapacity = 120000;
  if (p.defaultAimV != null) cfg.aimTargetV = p.defaultAimV;

  const sim = new Simulation(cfg);
  const rep = sim.run();
  const f = sim.film;
  const dep = f.depositedVolume;
  const pct = (v: number) => ((dep > 0 ? (v / dep) * 100 : 0)).toFixed(2);
  const ml = (v: number) => (v * 1e6).toFixed(1).padStart(7);
  console.log(
    `${p.id.padEnd(20)}${ml(dep)} ${ml(f.spilledSide)} ${ml(f.spilledTop)} ` +
      `${ml(f.spilledLip)}  ${pct(f.spilledSide).padStart(6)}  ` +
      `${(rep.volumeClosureError * 100).toFixed(4).padStart(8)}`
  );
}
