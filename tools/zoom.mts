/**
 * Crop and magnify a region of a PNG.
 *
 * `npm run shoot` writes a 1600 x 900 screenshot of the whole app, and a defect a
 * few millimetres wide on a fixture occupying a third of that is two or three
 * pixels. Judging one by eye off the full frame is guesswork; this cuts the
 * region out and blows it up with nearest-neighbour, so a stair-stepped edge
 * stays stair-stepped instead of being blurred into a smooth one by the
 * resampler.
 *
 * Usage: npx tsx tools/zoom.mts <in.png> <x> <y> <w> <h> [scale] [out.png]
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { writePng } from './png.mts';

/** Decode a non-interlaced 8-bit PNG (grey/RGB/palette/alpha) to RGBA. */
function decodePng(buf: Buffer): { rgba: Uint8ClampedArray; w: number; h: number } {
  let p = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let colour = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colour = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8) throw new Error(`only 8-bit PNGs supported, got ${depth}`);
  if (interlace !== 0) throw new Error('interlaced PNGs not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  if (!channels) throw new Error(`unsupported colour type ${colour}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  // Undo the per-scanline filters. Each line carries its filter type in a leading
  // byte and refers back to the *reconstructed* line above, not the filtered one.
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = up ? up[i] : 0;
      const c = up && i >= channels ? up[i - channels] : 0;
      let v = src[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * channels;
    let r: number, g: number, bl: number, al = 255;
    if (colour === 3) {
      const e = out[s] * 3;
      r = palette![e];
      g = palette![e + 1];
      bl = palette![e + 2];
      if (trns && out[s] < trns.length) al = trns[out[s]];
    } else if (colour === 0) r = g = bl = out[s];
    else if (colour === 4) {
      r = g = bl = out[s];
      al = out[s + 1];
    } else {
      r = out[s];
      g = out[s + 1];
      bl = out[s + 2];
      if (colour === 6) al = out[s + 3];
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = bl;
    rgba[i * 4 + 3] = al;
  }
  return { rgba, w, h };
}

const [, , inPath, xs, ys, ws, hs, ss, outPath] = process.argv;
if (!inPath) {
  console.error('usage: npx tsx tools/zoom.mts <in.png> <x> <y> <w> <h> [scale] [out.png]');
  process.exit(1);
}
const src = decodePng(readFileSync(inPath));
const x0 = Number(xs ?? 0);
const y0 = Number(ys ?? 0);
const cw = Math.min(Number(ws ?? src.w), src.w - x0);
const ch = Math.min(Number(hs ?? src.h), src.h - y0);
const scale = Number(ss ?? 4);
const out = new Uint8ClampedArray(cw * scale * ch * scale * 4);
for (let y = 0; y < ch * scale; y++) {
  for (let x = 0; x < cw * scale; x++) {
    const si = ((y0 + Math.floor(y / scale)) * src.w + x0 + Math.floor(x / scale)) * 4;
    const di = (y * cw * scale + x) * 4;
    out[di] = src.rgba[si];
    out[di + 1] = src.rgba[si + 1];
    out[di + 2] = src.rgba[si + 2];
    out[di + 3] = src.rgba[si + 3];
  }
}
const dest = outPath ?? inPath.replace(/\.png$/, `-zoom.png`);
writePng(dest, out, cw * scale, ch * scale);
console.log(`${inPath} ${src.w}x${src.h} -> ${dest} ${cw * scale}x${ch * scale} (x${scale})`);
