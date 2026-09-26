/**
 * Screenshot the running app from a headless browser.
 *
 * The viewport is WebGL, so this is the only way to see what the product actually
 * looks like without a human looking at it. Chromium runs with ANGLE on
 * SwiftShader, which gives a real WebGL 2 context in software -- slow, but it
 * renders the same shaders the browser does, and it is deterministic.
 *
 *   npx tsx tools/shoot.mts                        every model, three-quarter
 *   npx tsx tools/shoot.mts --models classic-bowl  one model
 *   npx tsx tools/shoot.mts --cameras front,side   pick cameras
 *   npx tsx tools/shoot.mts --t 0.0,0.8,2.0        pick simulated times
 *   npx tsx tools/shoot.mts --out tools/shots/x    output prefix
 *   npx tsx tools/shoot.mts --stage                crop to the viewport only
 *
 * Times are simulated seconds, not wall clock, so a shot is reproducible.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium, Browser, Page } from 'playwright';
import { createServer, ViteDevServer } from 'vite';

interface LabProbe {
  model: string;
  time: number;
  droplets: number;
  emitter: [number, number, number];
  interiorFrontZ: number;
  castingFrontZ: number | null;
  captureFrontZ: number;
  floorY: number;
  degenerateCells: number;
  selfIntersects: boolean;
  interior: number[];
  casting: number[] | null;
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name: string) => args.includes(`--${name}`);

const PORT = Number(flag('port', '5199'));
const OUT = flag('out', 'tools/shots/shot')!;
const CAMERAS = (flag('cameras', 'threeQuarter') as string).split(',');
const TIMES = (flag('t', '0.8') as string).split(',').map(Number);
const STAGE_ONLY = has('stage');
const WIDTH = Number(flag('w', '1600'));
const HEIGHT = Number(flag('h', '900'));
const FIELD = flag('field');
/** --aim 0.55 drives the aim down the profile, for the rim-strike cases. */
const AIM = flag('aim');
/** --overlays zones=0,heatmaps=0,shell=1 */
const OVERLAYS: Record<string, boolean> = {};
for (const kv of (flag('overlays', '') as string).split(',')) {
  if (!kv) continue;
  const [k, v] = kv.split('=');
  OVERLAYS[k] = v !== '0' && v !== 'false';
}

/**
 * Vite through its own API rather than as a subprocess: spawning the `vite` shim
 * needs a shell on Windows and its JS entry is not an exported subpath, so both
 * of the obvious routes are dead ends. In-process is simpler than either and the
 * server shuts down cleanly with the script.
 */
async function startServer(): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: 'vite.config.ts',
    server: { port: PORT, strictPort: true },
    logLevel: 'warn',
  });
  await server.listen();
  return server;
}

async function openApp(browser: Browser): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  (page as Page & { __problems: string[] }).__problems = problems;

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  // Waits on the automation surface rather than a timeout: the app is ready when
  // it says it is, however long software WebGL takes to come up.
  await page.waitForFunction(
    () => (window as unknown as { __lab?: { ready: boolean } }).__lab?.ready === true,
    undefined,
    { timeout: 120_000 }
  );
  const gl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!g) return 'none';
    const dbg = g.getExtension('WEBGL_debug_renderer_info');
    return dbg ? String(g.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'webgl2';
  });
  console.log(`WebGL renderer: ${gl}`);
  return page;
}

async function main(): Promise<void> {
  mkdirSync(dirname(OUT), { recursive: true });
  const server = await startServer();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-lcd-text',
        '--force-color-profile=srgb',
      ],
    });
    const page = await openApp(browser);
    const problems = (page as Page & { __problems: string[] }).__problems;

    const models: string[] =
      flag('models')?.split(',') ??
      (await page.evaluate(() =>
        (window as unknown as { __lab: { models(): string[] } }).__lab.models()
      ));

    for (const model of models) {
      await page.evaluate((id) => {
        const lab = (window as unknown as {
          __lab: { selectModel(i: string): void; setPlaying(p: boolean): void };
        }).__lab;
        lab.selectModel(id);
        lab.setPlaying(false);
      }, model);

      if (Object.keys(OVERLAYS).length) {
        await page.evaluate((o) => {
          (window as unknown as {
            __lab: { setOverlays(o: Record<string, boolean>): void };
          }).__lab.setOverlays(o);
        }, OVERLAYS);
      }
      if (FIELD) {
        await page.evaluate((f) => {
          (window as unknown as { __lab: { setFieldMode(f: string): void } }).__lab.setFieldMode(f);
        }, FIELD);
      }
      // Aim is the most sensitive input in the model and there was no way to move
      // it from here, so every screenshot the project has ever taken was of a
      // preset's default. The rim strike -- the worst outcome available, and the
      // one the exterior stain layer exists to show -- was unreachable.
      if (AIM !== undefined) {
        await page.evaluate((v) => {
          (window as unknown as { __lab: { setAim(v: number): void } }).__lab.setAim(v);
        }, Number(AIM));
      }

      for (const camera of CAMERAS) {
        await page.evaluate((c) => {
          (window as unknown as { __lab: { setCamera(c: string): void } }).__lab.setCamera(c);
        }, camera);

        for (const t of TIMES) {
          const probe: LabProbe = await page.evaluate((tt) => {
            const lab = (window as unknown as {
              __lab: { advanceTo(t: number): void; probe(): LabProbe };
            }).__lab;
            lab.advanceTo(tt);
            return lab.probe();
          }, t);

          const name = `${OUT}-${model}-${camera}-t${t}.png`;
          const target = STAGE_ONLY ? page.locator('#stage') : page;
          const buf = await target.screenshot();
          writeFileSync(name, buf);

          const gap =
            probe.castingFrontZ === null
              ? 'n/a'
              : `${((probe.castingFrontZ - probe.captureFrontZ) * 1000).toFixed(0)}mm`;
          console.log(
            `${model.padEnd(20)} ${camera.padEnd(12)} t=${String(t).padEnd(5)}` +
              ` drops ${String(probe.droplets).padStart(6)}` +
              ` castingAheadOfCapture ${gap.padStart(7)}` +
              ` degen ${probe.degenerateCells}` +
              (probe.selfIntersects ? ' SELF-INTERSECTS' : '')
          );
        }
      }
    }

    if (problems.length) {
      console.log('\nBrowser reported:');
      for (const p of [...new Set(problems)].slice(0, 25)) console.log(`  ${p}`);
    } else {
      console.log('\nNo console errors or warnings.');
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
