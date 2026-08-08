/**
 * Drive the comparison workflow and read what it says.
 *
 * A screenshot cannot check this: the whole value of the panel is whether it
 * refuses to rank two runs that used different conditions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, Browser, Page } from 'playwright';
import { createServer, ViteDevServer } from 'vite';

const PORT = 5195;
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'shots';

const COMPARE = `(() => {
  const t = document.querySelector('.compare-table');
  if (!t) return { rows: [], foot: '(no table)' };
  const rows = Array.from(t.querySelectorAll('tr')).map((r) => ({
    cls: r.className,
    cells: Array.from(r.querySelectorAll('td,th')).map((c) => c.textContent.trim()),
    title: (r.querySelector('td') || {}).title || ''
  }));
  const foot = Array.from(document.querySelectorAll('.compare-table ~ p')).map((p) => p.textContent).join(' ');
  return { rows, foot };
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const server: ViteDevServer = await createServer({
    configFile: 'vite.config.ts',
    server: { port: PORT, strictPort: true },
    logLevel: 'warn',
  });
  await server.listen();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page: Page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__lab && window.__lab.ready === true', undefined, {
      timeout: 180_000,
    });

    // The section is hidden until a run lands in it.
    const hiddenAtStart = await page.evaluate(
      `Boolean(document.querySelector('.compare-table')) === false`
    );
    console.log(`Compare section empty before any run: ${hiddenAtStart}`);

    // Run 1 and 2: two fixtures, identical conditions. Comparable.
    for (const m of ['classic-bowl', 'flat-wall']) {
      await page.evaluate(`window.__lab.selectModel('${m}'); window.__lab.setAimUv(0, 0.20);`);
      await page.evaluate(`window.__lab.advanceTo(999)`);
    }
    let state = (await page.evaluate(COMPARE)) as {
      rows: Array<{ cls: string; cells: string[]; title: string }>;
      foot: string;
    };
    console.log('\n=== Two runs, same aim / stand-off / seed ===');
    for (const r of state.rows) console.log(`  [${r.cls || '-'}] ${r.cells.join(' | ')}`);
    console.log(`  FOOT: ${state.foot}`);

    // Run 3: same fixture, deliberately different stand-off. Not comparable.
    await page.evaluate(`(() => {
      const app = window.__lab;
      app.selectModel('nautilus-tall');
      app.setAimUv(0, 0.20);
    })()`);
    // Move stand-off through the real control, the way a user would.
    await page.evaluate(`(() => {
      const labels = Array.from(document.querySelectorAll('#left .ctl'));
      const row = labels.find((r) => (r.textContent || '').includes('Stand-off'));
      const input = row.querySelector('input[type=range]');
      input.value = '200';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await page.evaluate(`window.__lab.advanceTo(999)`);
    state = (await page.evaluate(COMPARE)) as typeof state;
    console.log('\n=== Third run at a different stand-off ===');
    for (const r of state.rows) console.log(`  [${r.cls || '-'}] ${r.cells.join(' | ')}`);
    console.log(`  FOOT: ${state.foot}`);
    console.log('\n  row tooltips:');
    for (const r of state.rows) if (r.title) console.log(`    ${r.title}`);

    writeFileSync(`${OUT}/compare.png`, await page.screenshot());
    console.log(`\nwrote ${OUT}/compare.png`);
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
