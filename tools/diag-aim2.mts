/**
 * Throwaway diagnostic 2: is the stream landing where aim says, and what is the
 * primary-impact angle as distinct from the secondary-impact angle?
 *
 * The first diagnostic showed the volume-weighted mean impingement angle sitting
 * at ~51 deg for every aim point from the top of the wall to the sump, which
 * cannot be right. Two candidate explanations: aim is not moving the landing
 * point, or the mean is dominated by secondary droplets re-impacting and so says
 * nothing about the stream. This separates them.
 */
import { Simulation, defaultConfig } from '../src/sim/simulation';
import { getPreset } from '../src/geometry/presets';
import { GRAVITY } from '../src/core/constants';
import { radToDeg, v3 } from '../src/core/vec3';

const model = process.argv[2] ?? 'classic-bowl';

const c0 = defaultConfig();
c0.surface = { ...getPreset(model).params };
c0.casting = { ...(getPreset(model).shell ?? {}) };
c0.resolutionU = 48;
c0.resolutionV = 96;
const probe = new Simulation(c0);
const b = probe.surface.bounds();
console.log(`model: ${model}`);
console.log(
  `interior y ${(b.min.y * 1000).toFixed(0)}..${(b.max.y * 1000).toFixed(0)} mm, ` +
    `floorY ${(probe.surface.floorY * 1000).toFixed(0)} mm, ` +
    `emitter y ${(probe.emitter.position.y * 1000).toFixed(0)} z ${(probe.emitter.position.z * 1000).toFixed(0)}`
);
console.log('');
console.log('aimV  solved  targetY  tracedY  tracedAng  hitCell  note');

for (const aim of [0.06, 0.14, 0.24, 0.34, 0.44, 0.5, 0.55, 0.6]) {
  const c = defaultConfig();
  c.surface = { ...getPreset(model).params };
  c.casting = { ...(getPreset(model).shell ?? {}) };
  c.resolutionU = 48;
  c.resolutionV = 96;
  c.aimTargetV = null; // aim manually so we can see the solve result
  const sim = new Simulation(c);

  const nv = sim.surface.nv;
  const nu = sim.surface.nu;
  const j = Math.min(nv - 1, Math.max(0, Math.round(aim * (nv - 1))));
  const targetCell = j * nu + Math.floor(nu / 2);
  const target = sim.surface.getCellPos(targetCell, v3());

  const solved = sim.aimAtProfileFraction(aim);

  // Trace the aim ray at peak speed and see where it really lands.
  const tPeak = sim.emitter.flow.peakFraction * sim.emitter.flow.duration;
  const speed = sim.emitter.speedAt(tPeak);
  const dir = sim.emitter.aimDirection();
  const o = sim.emitter.position;
  let prev = v3(o.x, o.y, o.z);
  let tracedY = NaN;
  let tracedAng = NaN;
  let hitCell = -1;
  for (let i = 1; i <= 400; i++) {
    const t = i * 0.003;
    const p = v3(
      o.x + dir.x * speed * t,
      o.y + dir.y * speed * t - 0.5 * GRAVITY * t * t,
      o.z + dir.z * speed * t
    );
    const seg = v3(p.x - prev.x, p.y - prev.y, p.z - prev.z);
    const hit = sim.surface.raycast(prev, seg, 1);
    if (hit) {
      tracedY = hit.point.y;
      tracedAng = sim.surface.impingementAngle(hit.cell, seg);
      hitCell = hit.cell;
      break;
    }
    prev = p;
    if (p.y < sim.surface.floorY - 0.2) break;
  }

  console.log(
    [
      aim.toFixed(2).padStart(4),
      String(solved).padStart(7),
      (target.y * 1000).toFixed(0).padStart(8),
      Number.isFinite(tracedY) ? (tracedY * 1000).toFixed(0).padStart(8) : '     ---',
      Number.isFinite(tracedAng) ? radToDeg(tracedAng).toFixed(1).padStart(10) : '       ---',
      String(hitCell).padStart(8),
      hitCell < 0 ? '  MISSED THE INTERIOR ENTIRELY' : `  row ${Math.floor(hitCell / nu)} of ${nv}`,
    ].join(' ')
  );
}

// ---- primary vs secondary impact angle ------------------------------------
console.log('');
console.log('Splitting impact angle by droplet generation:');
console.log('aimV  primaryAng  primarymL  secondAng  secondmL  splashFrac  onUser');

for (const aim of [0.1, 0.18, 0.3, 0.44]) {
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

  // Instrument: tally impact angle by generation by wrapping the resolver.
  let pAng = 0;
  let pVol = 0;
  let sAng = 0;
  let sVol = 0;
  const inner = sim.impact.resolve.bind(sim.impact);
  sim.impact.resolve = (ev, surf, parts, film) => {
    inner(ev, surf, parts, film);
    const a = sim.impact.last ? sim.impact.last.impingementAngle : 0;
    if (ev.generation === 0) {
      pAng += a * ev.volume;
      pVol += ev.volume;
    } else {
      sAng += a * ev.volume;
      sVol += ev.volume;
    }
  };

  const rep = sim.run();
  console.log(
    [
      aim.toFixed(2).padStart(4),
      (pVol > 0 ? radToDeg(pAng / pVol) : 0).toFixed(1).padStart(11),
      (pVol * 1e6).toFixed(2).padStart(10),
      (sVol > 0 ? radToDeg(sAng / sVol) : 0).toFixed(1).padStart(10),
      (sVol * 1e6).toFixed(2).padStart(9),
      (100 * rep.splash.splashFraction).toFixed(2).padStart(11),
      rep.splash.userMicrolitresPerLitre.toFixed(0).padStart(7),
    ].join(' ')
  );
}
