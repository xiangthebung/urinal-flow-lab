/**
 * Throwaway diagnostic: splashback as a function of aim point.
 *
 * Answers one question before any physics is changed -- when the stream lands
 * somewhere other than the back wall, does the model produce zero splash, and if
 * so is that the grazing-incidence result it should be or a dead branch?
 *
 * Delete once the answer is recorded.
 */
import { Simulation, defaultConfig } from '../src/sim/simulation';
import { getPreset } from '../src/geometry/presets';
import { radToDeg, v3 } from '../src/core/vec3';

const model = process.argv[2] ?? 'classic-bowl';

console.log(`model: ${model}`);
console.log(
  'aimV  landY   impAng  arrivedmL  splashFrac  onUser(uL/L)  drops  poolMax(mm)  wallHmax(um)'
);

for (const aim of [0.06, 0.1, 0.14, 0.18, 0.24, 0.3, 0.38, 0.46, 0.55]) {
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
  const act = sim.metrics.actualImpingement();

  // Where the aim ray actually lands.
  const nv = sim.surface.nv;
  const nu = sim.surface.nu;
  const j = Math.min(nv - 1, Math.round(aim * (nv - 1)));
  const target = sim.surface.getCellPos(j * nu + Math.floor(nu / 2), v3());

  let poolMax = 0;
  for (let k = 0; k < sim.film.h.length; k++) poolMax = Math.max(poolMax, sim.film.h[k]);

  console.log(
    [
      aim.toFixed(2).padStart(4),
      (target.y * 1000).toFixed(0).padStart(6),
      radToDeg(act.meanAngle).toFixed(1).padStart(7),
      (act.impactedVolume * 1e6).toFixed(2).padStart(10),
      (100 * rep.splash.splashFraction).toFixed(3).padStart(11),
      rep.splash.userMicrolitresPerLitre.toFixed(0).padStart(13),
      String(rep.splash.userDroplets).padStart(6),
      (poolMax * 1000).toFixed(2).padStart(12),
      String(rep.splash.splashEvents).padStart(13),
    ].join(' ')
  );
}
