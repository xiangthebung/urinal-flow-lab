/**
 * Throwaway diagnostic 3: where does the whole void go when aiming low?
 *
 * Diagnostic 1 found that a full run at aimTargetV = 0.55 produces zero wall
 * impacts, an empty film and zero splash, while diagnostic 2 found that the aim
 * ray at that same v traces cleanly onto the interior at 63 degrees. One of those
 * is lying. This prints the complete volume ledger per aim point.
 */
import { Simulation, defaultConfig } from '../src/sim/simulation';
import { getPreset } from '../src/geometry/presets';
import { ZONE_NAMES } from '../src/sim/capture';
import { radToDeg } from '../src/core/vec3';

const model = process.argv[2] ?? 'classic-bowl';

for (const aim of [0.18, 0.44, 0.5, 0.55]) {
  const c = defaultConfig();
  c.surface = { ...getPreset(model).params };
  c.casting = { ...(getPreset(model).shell ?? {}) };
  c.stream.voidVolume = 120e-6;
  c.drainTime = 1;
  c.resolutionU = 48;
  c.resolutionV = 96;
  c.particleCapacity = 120000;
  c.seed = 4242;
  c.aimTargetV = aim;

  const sim = new Simulation(c);
  const rep = sim.run();
  const it = sim.impact.totals;

  console.log(`\n=== aim v = ${aim.toFixed(2)} ===`);
  console.log(
    `  aim elevation ${radToDeg(sim.config.stream.aimElevation).toFixed(2)}deg  ` +
      `azimuth ${radToDeg(sim.config.stream.aimAzimuth).toFixed(2)}deg`
  );
  console.log(`  emitted            ${(sim.metrics.emittedVolume * 1e6).toFixed(3)} mL`);
  console.log(`  impact events      ${it.events}  splash events ${it.splashEvents}`);
  console.log(`  deposited on wall  ${(it.depositedVolume * 1e6).toFixed(3)} mL`);
  console.log(`  splashed at wall   ${(it.splashedVolume * 1e6).toFixed(3)} mL`);
  console.log(`  rebounded          ${(it.reboundedVolume * 1e6).toFixed(3)} mL`);
  console.log(`  film now holds     ${(sim.film.totalVolume() * 1e6).toFixed(3)} mL`);
  console.log(`  drained            ${(sim.film.drainedVolume * 1e6).toFixed(3)} mL`);
  console.log(`  airborne           ${(sim.airborneVolume() * 1e6).toFixed(3)} mL`);
  console.log(`  buffer overflow    ${(sim.particles.overflowVolume * 1e6).toFixed(3)} mL`);
  console.log(`  escaped domain     ${(sim.metrics.escapedVolume * 1e6).toFixed(3)} mL`);
  console.log('  captures:');
  for (let z = 0; z < sim.metrics.perZone.length; z++) {
    const t = sim.metrics.perZone[z];
    if (t.volume <= 0) continue;
    console.log(
      `    ${ZONE_NAMES[z].padEnd(18)} ${(t.volume * 1e6).toFixed(3)} mL in ${t.count} drops`
    );
  }
  console.log(`  closure error      ${(100 * rep.volumeClosureError).toFixed(4)} %`);
}
