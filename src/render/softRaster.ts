/**
 * A tiny software triangle rasteriser.
 *
 * There are two places that need a picture of a fixture without a WebGL context:
 * the model picker, which wants a thumbnail per fixture next to its name, and the
 * offline preview tool, which is the only way to check a shape without a browser.
 * Spinning up a second WebGL context and render target per thumbnail is far more
 * machinery than a 130 x 96 image of a few thousand triangles deserves, and the
 * preview tool has no browser at all, so both share this.
 *
 * Flat shaded with a z-buffer, and that is the whole feature list. It is judging
 * silhouettes, not lighting.
 */

export interface RasterMesh {
  positions: Float32Array | Float64Array;
  indices: Uint32Array | Uint16Array;
  /** Base colour, 0-255. */
  tint: [number, number, number];
}

export interface RasterView {
  eye: [number, number, number];
  target: [number, number, number];
  fovDeg?: number;
  /** RGBA, 0-255. Alpha 0 gives a transparent background. */
  background?: [number, number, number, number];
}

export interface Box {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: number[]) => {
  const m = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / m, a[1] / m, a[2] / m];
};

/** Render to an RGBA buffer, row major, top row first. */
export function rasterise(
  meshes: RasterMesh[],
  view: RasterView,
  width: number,
  height: number
): Uint8ClampedArray {
  const px = new Uint8ClampedArray(width * height * 4);
  const bg = view.background ?? [0, 0, 0, 0];
  for (let i = 0; i < width * height; i++) {
    px[i * 4] = bg[0];
    px[i * 4 + 1] = bg[1];
    px[i * 4 + 2] = bg[2];
    px[i * 4 + 3] = bg[3];
  }
  const zbuf = new Float64Array(width * height).fill(Infinity);

  const eye = view.eye as unknown as number[];
  const fwd = unit(sub(view.target as unknown as number[], eye));
  const right = unit(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const f = 1 / Math.tan(((view.fovDeg ?? 34) * Math.PI) / 360);
  const key = unit([0.42, 0.82, 0.58]);
  const fill = unit([-0.5, 0.22, 0.5]);
  const aspect = width / height;

  const project = (p: number[]): [number, number, number] => {
    const d = sub(p, eye);
    const z = dot(d, fwd);
    return [(dot(d, right) / z) * (f / aspect), (dot(d, up) / z) * f, z];
  };

  for (const mesh of meshes) {
    const { positions: P, indices: I, tint } = mesh;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const ia = I[t] * 3;
      const ib = I[t + 1] * 3;
      const ic = I[t + 2] * 3;
      const a = [P[ia], P[ia + 1], P[ia + 2]];
      const b = [P[ib], P[ib + 1], P[ib + 2]];
      const c = [P[ic], P[ic + 1], P[ic + 2]];
      const pa = project(a);
      const pb = project(b);
      const pc = project(c);
      if (pa[2] <= 0.01 || pb[2] <= 0.01 || pc[2] <= 0.01) continue;

      const n = unit(cross(sub(b, a), sub(c, a)));
      const shade =
        0.17 + 0.7 * Math.abs(dot(n, key)) + 0.22 * Math.abs(dot(n, fill));

      const x0 = (pa[0] * 0.5 + 0.5) * width;
      const y0 = (0.5 - pa[1] * 0.5) * height;
      const x1 = (pb[0] * 0.5 + 0.5) * width;
      const y1 = (0.5 - pb[1] * 0.5) * height;
      const x2 = (pc[0] * 0.5 + 0.5) * width;
      const y2 = (0.5 - pc[1] * 0.5) * height;

      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(area) < 1e-9) continue;

      const r = tint[0] * shade;
      const g = tint[1] * shade;
      const bl = tint[2] * shade;

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const cx = x + 0.5;
          const cy = y + 0.5;
          const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
          const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
          const o = y * width + x;
          if (z >= zbuf[o]) continue;
          zbuf[o] = z;
          px[o * 4] = r;
          px[o * 4 + 1] = g;
          px[o * 4 + 2] = bl;
          px[o * 4 + 3] = 255;
        }
      }
    }
  }
  return px;
}

/**
 * A three-quarter view framed to fit the given bounds.
 *
 * Framed per fixture rather than to a shared scale. A shared scale would show the
 * true relative sizes, but a trough is nearly three times the width of a bowl and
 * a stall twice its height, so everything else would end up a smudge. Fitting each
 * one preserves its proportions, which is what identifies it, and the millimetre
 * dimensions are printed next to the name for the absolute size.
 */
export function framedThreeQuarterView(b: Box, margin = 1.68): RasterView {
  const cy = (b.min.y + b.max.y) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const span =
    Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) * margin;
  return {
    eye: [span * 0.62, cy + span * 0.42, cz + span * 0.86],
    target: [0, cy, cz],
  };
}

/** Union of two boxes. */
export function unionBox(a: Box, b: Box): Box {
  return {
    min: {
      x: Math.min(a.min.x, b.min.x),
      y: Math.min(a.min.y, b.min.y),
      z: Math.min(a.min.z, b.min.z),
    },
    max: {
      x: Math.max(a.max.x, b.max.x),
      y: Math.max(a.max.y, b.max.y),
      z: Math.max(a.max.z, b.max.z),
    },
  };
}
