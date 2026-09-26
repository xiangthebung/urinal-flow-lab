/**
 * How much of the frame the liquid actually changes.
 *
 * "The bowl looks wet" is not a claim anyone can check by describing it, and the
 * appearance gains in `fixtureView`'s shader were tuned by eye against a lighting
 * bug (the interior's key light was applied to a view-space normal, so it was a
 * headlamp). Correcting the lighting changes the level everything else was
 * balanced against, so the wet cue has to be re-measured rather than re-judged.
 *
 * Takes the same view rendered twice -- once in `Liquid` mode and once in `Dry`,
 * which is the same geometry and the same lighting with `uLiquid` at zero -- and
 * reports how far apart they are over the pixels the fixture occupies.
 *
 *   npx tsx tools/wetcontrast.mts <liquid.png> <dry.png>
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** Decode a non-interlaced 8-bit RGB/RGBA PNG. */
function decodePng(buf: Buffer): { rgba: Uint8ClampedArray; w: number; h: number } {
  let p = 8;
  let w = 0;
  let h = 0;
  let colour = 0;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      colour = data[9];
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const ch = colour === 6 ? 4 : 3;
  const stride = w * ch;
  const out = new Uint8ClampedArray(w * h * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[q++];
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      const v = raw[q + x];
      let r: number;
      if (filter === 0) r = v;
      else if (filter === 1) r = v + a;
      else if (filter === 2) r = v + b;
      else if (filter === 3) r = v + ((a + b) >> 1);
      else {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[x] = r & 255;
    }
    q += stride;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = cur[x * ch];
      out[o + 1] = cur[x * ch + 1];
      out[o + 2] = cur[x * ch + 2];
      out[o + 3] = ch === 4 ? cur[x * ch + 3] : 255;
    }
    prev.set(cur);
  }
  return { rgba: out, w, h };
}

const [aPath, bPath] = process.argv.slice(2);
const A = decodePng(readFileSync(aPath));
const B = decodePng(readFileSync(bPath));
if (A.w !== B.w || A.h !== B.h) throw new Error('size mismatch');

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

let n = 0;
let sumAbs = 0;
let maxAbs = 0;
let changed2 = 0;
let changed8 = 0;
let sumA = 0;
let sumB = 0;
// The fixture is the bright object in the middle third; the dark room and the
// HUD panels would otherwise dominate a whole-frame average with pixels the
// liquid can never touch.
const x0 = Math.floor(A.w * 0.25);
const x1 = Math.floor(A.w * 0.75);
const y0 = Math.floor(A.h * 0.1);
const y1 = Math.floor(A.h * 0.85);
for (let y = y0; y < y1; y++) {
  for (let x = x0; x < x1; x++) {
    const o = (y * A.w + x) * 4;
    const la = lum(A.rgba[o], A.rgba[o + 1], A.rgba[o + 2]);
    const lb = lum(B.rgba[o], B.rgba[o + 1], B.rgba[o + 2]);
    // Ceramic only: both frames bright enough to be the fixture, not the room.
    if (lb < 90) continue;
    n++;
    sumA += la;
    sumB += lb;
    const d = Math.abs(la - lb);
    sumAbs += d;
    if (d > maxAbs) maxAbs = d;
    if (d > 2) changed2++;
    if (d > 8) changed8++;
  }
}
console.log(`fixture pixels compared: ${n}`);
console.log(`mean luminance  wet ${(sumA / n).toFixed(1)}   dry ${(sumB / n).toFixed(1)}`);
console.log(`mean |wet - dry| ${(sumAbs / n).toFixed(2)}   max ${maxAbs.toFixed(0)}`);
console.log(
  `pixels visibly changed: >2/255 ${((100 * changed2) / n).toFixed(1)}%   ` +
    `>8/255 ${((100 * changed8) / n).toFixed(1)}%`
);
