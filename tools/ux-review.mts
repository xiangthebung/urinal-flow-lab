/**
 * UX review driver: full-window screenshots at several sizes, plus text output.
 *
 * A screenshot cannot check the report or the readouts, so this does both in one
 * pass: it photographs the whole window (not just the stage) at each size and
 * dumps the panels' textContent next to the image.
 *
 *   npx tsx <this> --out <dir> --tag before --sizes 1600x1000,1280x800
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, Browser, Page } from 'playwright';
import { createServer, ViteDevServer } from 'vite';

const args = process.argv.slice(2);
const flag = (n: string, d?: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const PORT = Number(flag('port', '5197'));
const OUT = flag('out', 'shots')!;
const TAG = flag('tag', 'shot')!;
const SIZES = (flag('sizes', '1600x1000,1280x800') as string)
  .split(',')
  .map((s) => {
    const [w, h] = s.split('x').map(Number);
    return { w, h };
  });
const MODEL = flag('model', 'classic-bowl')!;
const T = Number(flag('t', '0.8'));
/** Drive a completed run so the report exists. */
const FULL = args.includes('--full');

async function startServer(): Promise<ViteDevServer> {
  const s = await createServer({
    configFile: 'vite.config.ts',
    server: { port: PORT, strictPort: true },
    logLevel: 'warn',
  });
  await s.listen();
  return s;
}

async function openApp(browser: Browser, w: number, h: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  (page as Page & { __problems: string[] }).__problems = problems;
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => (window as unknown as { __lab?: { ready: boolean } }).__lab?.ready === true,
    undefined,
    { timeout: 180_000 }
  );
  return page;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
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

    for (const { w, h } of SIZES) {
      const page = await openApp(browser, w, h);
      await page.evaluate((id) => {
        const lab = (window as unknown as {
          __lab: { selectModel(i: string): void; setPlaying(p: boolean): void };
        }).__lab;
        lab.selectModel(id);
        lab.setPlaying(false);
      }, MODEL);
      await page.evaluate((tt) => {
        (window as unknown as { __lab: { advanceTo(t: number): void } }).__lab.advanceTo(tt);
      }, FULL ? 999 : T);

      if (args.includes('--focus')) {
        await page.evaluate(
          `(() => { const b = Array.from(document.querySelectorAll('#topbar-actions button')).find((x) => (x.textContent||'').includes('Focus')); b.click(); })()`
        );
      }

      const name = `${OUT}/${TAG}-${w}x${h}.png`;
      writeFileSync(name, await page.screenshot());
      console.log(`wrote ${name}`);

      // Text, which a picture cannot check.
      const text = await page.evaluate(() => ({
        left: (document.querySelector('#left') as HTMLElement | null)?.innerText ?? '(missing)',
        right: (document.querySelector('#right') as HTMLElement | null)?.innerText ?? '(missing)',
        hud: (document.querySelector('#hud') as HTMLElement | null)?.innerText ?? '(missing)',
        note: (document.querySelector('#overlay-note') as HTMLElement | null)?.innerText ?? '(missing)',
        top: (document.querySelector('#topbar') as HTMLElement | null)?.innerText ?? '(missing)',
        transport: (document.querySelector('#transport') as HTMLElement | null)?.innerText ?? '(missing)',
        report: (document.querySelector('.report') as HTMLElement | null)?.textContent ?? '(no report)',
      }));
      writeFileSync(
        `${OUT}/${TAG}-${w}x${h}.txt`,
        Object.entries(text)
          .map(([k, v]) => `===== ${k} =====\n${v}`)
          .join('\n\n')
      );
      console.log(`wrote ${OUT}/${TAG}-${w}x${h}.txt`);

      const problems = (page as Page & { __problems: string[] }).__problems;
      if (problems.length) {
        console.log('Browser reported:');
        for (const p of [...new Set(problems)].slice(0, 15)) console.log(`  ${p}`);
      } else {
        console.log('No console errors or warnings.');
      }
      await page.close();
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
