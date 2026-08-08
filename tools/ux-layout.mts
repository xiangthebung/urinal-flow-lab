/**
 * Layout probe: bounding boxes of every stage overlay, at several widths.
 *
 * Overlap between the tab strip and the HUD is the specific fault that made two
 * of eight surface views unclickable on a 1280-wide laptop, and it is invisible
 * in a screenshot unless you happen to look at the right corner. This asserts on
 * geometry instead.
 */
import { chromium, Browser, Page } from 'playwright';
import { createServer, ViteDevServer } from 'vite';

const PORT = 5194;
const SIZES = [
  { w: 1600, h: 1000 },
  { w: 1366, h: 768 },
  { w: 1280, h: 800 },
  { w: 1024, h: 768 },
];

const RECTS = `(() => {
  const sel = ['#view-tabs', '#hud', '#legend', '#overlay-note', '.cam-bar', '.shortcuts', '.first-hint', '#left', '#right', '#stage', '#gl'];
  const out = {};
  for (const s of sel) {
    const e = document.querySelector(s);
    if (!e) { out[s] = null; continue; }
    const r = e.getBoundingClientRect();
    const vis = getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0;
    out[s] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vis };
  }
  return out;
})()`;

type Rect = { x: number; y: number; w: number; h: number; vis: boolean } | null;

function overlaps(a: Rect, b: Rect): boolean {
  if (!a || !b || !a.vis || !b.vis) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

async function main(): Promise<void> {
  const server: ViteDevServer = await createServer({
    configFile: 'vite.config.ts',
    server: { port: PORT, strictPort: true },
    logLevel: 'warn',
  });
  await server.listen();
  let browser: Browser | null = null;
  let bad = 0;
  try {
    browser = await chromium.launch({
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    for (const { w, h } of SIZES) {
      const page: Page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction('window.__lab && window.__lab.ready === true', undefined, {
        timeout: 180_000,
      });
      const r = (await page.evaluate(RECTS)) as Record<string, Rect>;
      const stage = r['#stage']!;
      console.log(`\n### ${w} x ${h}   stage ${stage.w}px = ${((100 * stage.w) / w).toFixed(0)}% of window`);
      for (const [k, v] of Object.entries(r)) {
        if (!v) continue;
        console.log(`   ${k.padEnd(14)} ${v.vis ? '' : '(hidden) '}x=${v.x} y=${v.y} w=${v.w} h=${v.h}`);
      }
      const pairs: Array<[string, string]> = [
        ['#view-tabs', '#hud'],
        ['#view-tabs', '.cam-bar'],
        ['.cam-bar', '#right'],
        ['.cam-bar', '#overlay-note'],
        ['#hud', '#right'],
        ['#overlay-note', '.first-hint'],
        ['#legend', '.first-hint'],
      ];
      for (const [a, b] of pairs) {
        if (overlaps(r[a], r[b])) {
          console.log(`   !! OVERLAP ${a} x ${b}`);
          bad++;
        }
      }
      // Every tab reachable?
      const tabsClickable = await page.evaluate(`(() => {
        const bs = Array.from(document.querySelectorAll('#view-tabs .tab'));
        let blocked = 0;
        for (const b of bs) {
          const r = b.getBoundingClientRect();
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          if (!b.contains(top) && top !== b) blocked++;
        }
        return { total: bs.length, blocked };
      })()`);
      console.log(`   tabs: ${JSON.stringify(tabsClickable)}`);
      if ((tabsClickable as { blocked: number }).blocked > 0) bad++;

      // Focus mode.
      await page.evaluate(
        `(() => { const b = Array.from(document.querySelectorAll('#topbar-actions button')).find((x) => (x.textContent||'').includes('Focus')); b.click(); })()`
      );
      const f = (await page.evaluate(RECTS)) as Record<string, Rect>;
      console.log(
        `   focus: stage ${f['#stage']!.w}px = ${((100 * f['#stage']!.w) / w).toFixed(0)}%` +
          `  left ${f['#left']!.vis ? 'shown' : 'hidden'}  right ${f['#right']!.vis ? 'shown' : 'hidden'}`
      );
      if (f['#left']!.vis || f['#right']!.vis) {
        console.log('   !! focus mode did not hide a panel');
        bad++;
      }
      await page.close();
    }
    console.log(bad === 0 ? '\nOK — no overlaps, no blocked tabs.' : `\n${bad} PROBLEM(S)`);
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
