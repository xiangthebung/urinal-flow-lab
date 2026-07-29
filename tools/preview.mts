/**
 * Offline preview renderer.
 *
 * A development tool, not part of the app. There is no headless browser in this
 * project, so the only way to check "does this actually read as a urinal" is to
 * rasterise the surface buffers straight to a PNG and look at it.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { UrinalSurface, SurfaceParams } from '../src/geometry/surface';
import { PRESETS } from '../src/geometry/presets';
import { buildShell } from '../src/geometry/shell';

interface Mesh {
  pos: Float32Array | Float64Array;
  idx: Uint32Array;
  tint: [number, number, number];
}

const W = 460;
const H = 460;

function rasterise(meshes: Mesh[], eye: number[], target: number[], fov = 36): Uint8Array {
  const px = new Uint8Array(W * H * 3);
  // background
  for (let i = 0; i < W * H; i++) {
    px[i * 3] = 16;
    px[i * 3 + 1] = 20;
    px[i * 3 + 2] = 26;
  }
  const zbuf = new Float64Array(W * H).fill(Infinity);

  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (a: number[]) => {
    const m = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / m, a[1] / m, a[2] / m];
  };
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const fwd = norm(sub(target, eye));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const f = 1 / Math.tan((fov * Math.PI) / 360);
  const light = norm([0.45, 0.8, 0.6]);

  const project = (p: number[]): [number, number, number] => {
    const d = sub(p, eye);
    const x = dot(d, right);
    const y = dot(d, up);
    const z = dot(d, fwd);
    return [(x / z) * f, (y / z) * f, z];
  };

  for (const mesh of meshes) {
    for (let t = 0; t < mesh.idx.length; t += 3) {
      const a = [mesh.pos[mesh.idx[t] * 3], mesh.pos[mesh.idx[t] * 3 + 1], mesh.pos[mesh.idx[t] * 3 + 2]];
      const b = [mesh.pos[mesh.idx[t + 1] * 3], mesh.pos[mesh.idx[t + 1] * 3 + 1], mesh.pos[mesh.idx[t + 1] * 3 + 2]];
      const c = [mesh.pos[mesh.idx[t + 2] * 3], mesh.pos[mesh.idx[t + 2] * 3 + 1], mesh.pos[mesh.idx[t + 2] * 3 + 2]];
      const pa = project(a);
      const pb = project(b);
      const pc = project(c);
      if (pa[2] <= 0.01 || pb[2] <= 0.01 || pc[2] <= 0.01) continue;

      const n = norm(cross(sub(b, a), sub(c, a)));
      const lam = Math.abs(dot(n, light));
      const shade = 0.18 + 0.82 * lam;

      const sx = (p: [number, number, number]) => (p[0] * 0.5 + 0.5) * W;
      const sy = (p: [number, number, number]) => (0.5 - p[1] * 0.5) * H;
      const x0 = sx(pa), y0 = sy(pa);
      const x1 = sx(pb), y1 = sy(pb);
      const x2 = sx(pc), y2 = sy(pc);

      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(area) < 1e-9) continue;

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const cx = x + 0.5;
          const cy = y + 0.5;
          const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
          const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
          const o = y * W + x;
          if (z >= zbuf[o]) continue;
          zbuf[o] = z;
          px[o * 3] = Math.min(255, mesh.tint[0] * shade);
          px[o * 3 + 1] = Math.min(255, mesh.tint[1] * shade);
          px[o * 3 + 2] = Math.min(255, mesh.tint[2] * shade);
        }
      }
    }
  }
  return px;
}

function png(px: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(px.buffer, px.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function tile(images: Uint8Array[], cols: number): { px: Uint8Array; w: number; h: number } {
  const rows = Math.ceil(images.length / cols);
  const w = cols * W;
  const h = rows * H;
  const out = new Uint8Array(w * h * 3);
  images.forEach((img, i) => {
    const cx = (i % cols) * W;
    const cy = Math.floor(i / cols) * H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = (y * W + x) * 3;
        const d = ((cy + y) * w + cx + x) * 3;
        out[d] = img[s];
        out[d + 1] = img[s + 1];
        out[d + 2] = img[s + 2];
      }
    }
  });
  return { px: out, w, h };
}

function views(params: SurfaceParams, withShell: boolean): Uint8Array[] {
  const s = new UrinalSurface(params, { nu: 56, nv: 104 });
  const b = s.bounds();
  const cy = (b.min.y + b.max.y) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const span = Math.max(b.max.y - b.min.y, b.max.x - b.min.x, b.max.z - b.min.z) * 1.5;
  const meshes: Mesh[] = [{ pos: s.vertices, idx: s.indices, tint: [232, 238, 248] }];
  if (withShell) {
    const sh = buildShell(s);
    meshes.push({ pos: sh.positions, idx: sh.indices, tint: [206, 212, 224] });
  }
  const out: Uint8Array[] = [];
  out.push(rasterise(meshes, [span * 0.75, cy + span * 0.5, cz + span * 0.95], [0, cy, cz]));
  out.push(rasterise(meshes, [0.0001, cy, cz + span * 1.5], [0, cy, cz]));
  out.push(rasterise(meshes, [span * 1.5, cy, cz], [0, cy, cz]));
  out.push(rasterise(meshes, [0.0001, cy + span * 1.5, cz], [0, cy, cz]));
  return out;
}

const which = process.argv[2] ?? 'classic-bowl';
const withShell = process.argv[3] !== 'noshell';
const out = process.argv[4] ?? 'tools/out.png';

if (which === 'all') {
  const imgs: Uint8Array[] = [];
  for (const p of PRESETS) {
    const s = new UrinalSurface(p.params, { nu: 56, nv: 104 });
    const b = s.bounds();
    const cy = (b.min.y + b.max.y) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const span = Math.max(b.max.y - b.min.y, b.max.x - b.min.x, b.max.z - b.min.z) * 1.5;
    const meshes: Mesh[] = [{ pos: s.vertices, idx: s.indices, tint: [232, 238, 248] }];
    if (withShell) {
      const sh = buildShell(s);
      meshes.push({ pos: sh.positions, idx: sh.indices, tint: [206, 212, 224] });
    }
    imgs.push(rasterise(meshes, [span * 0.75, cy + span * 0.5, cz + span * 0.95], [0, cy, cz]));
    imgs.push(rasterise(meshes, [0.0001, cy, cz + span * 1.5], [0, cy, cz]));
    imgs.push(rasterise(meshes, [span * 1.5, cy, cz], [0, cy, cz]));
    console.log(p.id, JSON.stringify(b));
  }
  const t = tile(imgs, 3);
  writeFileSync(out, png(t.px, t.w, t.h));
} else {
  const preset = PRESETS.find((p) => p.id === which);
  if (!preset) throw new Error(`no preset ${which}`);
  const t = tile(views(preset.params, withShell), 2);
  writeFileSync(out, png(t.px, t.w, t.h));
  console.log('wrote', out);
}
