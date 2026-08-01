/**
 * Contact sheet of the fixture picker's own thumbnails.
 *
 *   npx tsx tools/thumbsheet.mts --out tools/shots/thumbs.png
 *   npx tsx tools/thumbsheet.mts --scale 3
 *
 * This calls `renderFixtureThumbnail` — the exact function the picker calls — so
 * what lands in the PNG is what the cards show. `--scale` renders at a multiple of
 * the card size for inspection; artefacts at 128 px are hard to judge, and a
 * nearest-neighbour blow-up of a 128 px image would show the upscaler's stairsteps
 * rather than the renderer's.
 *
 * The cards are drawn on the panel's own background so the composite matches what
 * the user sees; a fixture that reads well on white and vanishes on #12161c is
 * still a broken thumbnail.
 */
import { PRESETS } from '../src/geometry/presets';
import { renderFixtureThumbnail } from '../src/ui/thumbnail';
import { blit, writePng } from './png.mts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// Must track CW/CH in `buildModelPicker`. See the header note.
const scale = Number(flag('scale') ?? 2);
const CARD_W = Math.round(126 * scale);
const CARD_H = Math.round(126 * scale);
const PAD = Math.round(10 * scale);
const COLS = 3;
// Matches --panel in src/styles.css. See the header note.
const BG: [number, number, number, number] = [18, 22, 28, 255];

const rows = Math.ceil(PRESETS.length / COLS);
const sheetW = COLS * (CARD_W + PAD) + PAD;
const sheetH = rows * (CARD_H + PAD) + PAD;
const sheet = new Uint8ClampedArray(sheetW * sheetH * 4);
for (let i = 0; i < sheetW * sheetH; i++) {
  sheet[i * 4] = BG[0];
  sheet[i * 4 + 1] = BG[1];
  sheet[i * 4 + 2] = BG[2];
  sheet[i * 4 + 3] = 255;
}

console.log(`thumbnail sheet, ${CARD_W}x${CARD_H} per card`);
console.log('');
console.log('model                W x D x H mm     ink %   mean L   p95 L');

PRESETS.forEach((p, i) => {
  const img = renderFixtureThumbnail(CARD_W, CARD_H, p.params, p.shell, p.fittings);

  // Coverage and luminance of the drawn pixels. A thumbnail can be geometrically
  // right and still unusable: too little ink means it is framed too far out, and a
  // low mean luminance against a dark panel means it cannot be made out at all.
  // Both were true of this picker before, and neither is visible from the numbers
  // the geometry bench prints.
  let ink = 0;
  let sum = 0;
  const ls: number[] = [];
  for (let k = 0; k < CARD_W * CARD_H; k++) {
    if (img.rgba[k * 4 + 3] === 0) continue;
    ink++;
    const l =
      0.2126 * img.rgba[k * 4] + 0.7152 * img.rgba[k * 4 + 1] + 0.0722 * img.rgba[k * 4 + 2];
    sum += l;
    ls.push(l);
  }
  ls.sort((a, b) => a - b);
  const mean = ink ? sum / ink : 0;
  const p95 = ls.length ? ls[Math.floor(ls.length * 0.95)] : 0;

  console.log(
    [
      p.id.padEnd(20),
      `${img.dims.w} x ${img.dims.d} x ${img.dims.h}`.padEnd(16),
      ((ink / (CARD_W * CARD_H)) * 100).toFixed(1).padStart(5),
      mean.toFixed(0).padStart(8),
      p95.toFixed(0).padStart(7),
    ].join(' ')
  );

  // Composite over the panel colour so the sheet shows the real appearance.
  const flat = new Uint8ClampedArray(CARD_W * CARD_H * 4);
  for (let k = 0; k < CARD_W * CARD_H; k++) {
    const a = img.rgba[k * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) {
      flat[k * 4 + c] = img.rgba[k * 4 + c] * a + BG[c] * (1 - a);
    }
    flat[k * 4 + 3] = 255;
  }

  const cx = PAD + (i % COLS) * (CARD_W + PAD);
  const cy = PAD + Math.floor(i / COLS) * (CARD_H + PAD);
  blit(sheet, sheetW, flat, CARD_W, CARD_H, cx, cy);
});

const out = flag('out') ?? 'tools/shots/thumbs.png';
writePng(out, sheet, sheetW, sheetH);
console.log('');
console.log(`wrote ${out}  (${PRESETS.map((p) => p.id).join(', ')}, row major)`);
