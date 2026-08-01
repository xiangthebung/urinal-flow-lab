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
 * Z-buffered, and smooth shaded when the mesh supplies normals.
 *
 * It used to shade flat from the face normal and ignore the vertex normals both
 * meshes carry, and that was not a cosmetic shortcut -- it actively misrepresented
 * the geometry. The casting's exterior is fitted in 56 height bands, so flat shading
 * drew each band as its own facet and every fixture came out wearing horizontal
 * corduroy stripes that do not exist on the object. Thumbnails are the first thing
 * anyone sees of a model, so the one renderer that feeds them was inventing a defect
 * and hiding the real surface underneath it.
 */

export interface RasterMesh {
  positions: Float32Array | Float64Array;
  indices: Uint32Array | Uint16Array;
  /**
   * Per-vertex normals, same layout as `positions`. Optional: without them the
   * face normal is used and the result is flat shaded.
   */
  normals?: Float32Array | Float64Array;
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

  /**
   * Light a normal, two-sided.
   *
   * The normal is turned to face the camera first. Both meshes here are legitimately
   * viewed from either side -- the interior loft is a single sheet seen from inside
   * the bowl, and the casting skin is open at the lip -- so a one-sided term would
   * drop half of each fixture into silhouette. This is the same choice the WebGL
   * shader makes, for the same reason.
   */
  const lightOf = (n: number[], toEye: number[]): number => {
    const s = dot(n, toEye) < 0 ? -1 : 1;
    const nx = n[0] * s;
    const ny = n[1] * s;
    const nz = n[2] * s;
    const dk = Math.max(0, nx * key[0] + ny * key[1] + nz * key[2]);
    const df = Math.max(0, nx * fill[0] + ny * fill[1] + nz * fill[2]);
    // Hemispheric term, plus a raised floor. Two directional lights and a flat
    // 0.2 ambient sent everything facing away from both of them to 20 per cent,
    // which on white ceramic is near black -- so the side walls of the bowl, which
    // are seen almost edge on in a three-quarter view, came out as dark slots that
    // looked like holes in the fixture. Glazed white sanitaryware in a lit room has
    // almost no truly dark side; what it has is a bright top and a dimmer underside.
    const sky = 0.5 + 0.5 * ny;
    return 0.3 + 0.44 * dk + 0.14 * df + 0.16 * sky;
  };

  for (const mesh of meshes) {
    const { positions: P, indices: I, normals: N, tint } = mesh;
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

      const face = unit(cross(sub(b, a), sub(c, a)));
      // Per-vertex shade, interpolated across the triangle below. Interpolating the
      // scalar rather than the vector is a visible approximation only where a
      // triangle spans a very large change in normal, which at this triangle density
      // does not happen, and it keeps the inner loop to one multiply-add per corner.
      let sa = 0;
      let sb = 0;
      let sc = 0;
      if (N) {
        const toA = unit(sub(eye, a));
        const toB = unit(sub(eye, b));
        const toC = unit(sub(eye, c));
        sa = lightOf([N[ia], N[ia + 1], N[ia + 2]], toA);
        sb = lightOf([N[ib], N[ib + 1], N[ib + 2]], toB);
        sc = lightOf([N[ic], N[ic + 1], N[ic + 2]], toC);
      } else {
        const flat = lightOf(face, unit(sub(eye, a)));
        sa = flat;
        sb = flat;
        sc = flat;
      }

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
          const shade = w0 * sa + w1 * sb + w2 * sc;
          px[o * 4] = tint[0] * shade;
          px[o * 4 + 1] = tint[1] * shade;
          px[o * 4 + 2] = tint[2] * shade;
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
 *
 * The fit is solved against the projection rather than guessed from a size, for the
 * same reason the viewport camera is. `1.68 x` the largest dimension, which is what
 * was here, is a guess that has to be loose enough for the worst case and is
 * therefore far too loose for every other case: these are portrait objects in a
 * landscape frame, so the binding constraint is height, and scaling off the largest
 * dimension of the *box* ignored both that and the aspect ratio. The fixtures were
 * covering 11 to 16 per cent of their cards. Projecting the eight corners and
 * shrinking the distance until they just fit uses the frame that exists.
 */
export function framedThreeQuarterView(
  b: Box,
  aspect = 1,
  fovDeg = 34,
  margin = 1.04
): RasterView {
  const cy = (b.min.y + b.max.y) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const target: [number, number, number] = [0, cy, cz];
  const off = unit([0.62, 0.42, 0.86]);
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);

  const corners: number[][] = [];
  for (const x of [b.min.x, b.max.x]) {
    for (const y of [b.min.y, b.max.y]) {
      for (const z of [b.min.z, b.max.z]) corners.push([x, y, z]);
    }
  }

  const span = Math.max(
    1e-4,
    Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z)
  );
  let dist = span * 2;
  // Fixed point on "how far outside the frame is the worst corner". The normalised
  // coordinates fall off roughly as 1/dist, so scaling the distance by the overshoot
  // converges in a handful of passes; it is iterated rather than solved because the
  // perspective divide makes the exact relation awkward and this costs nothing.
  for (let iter = 0; iter < 24; iter++) {
    const eye = [
      target[0] + off[0] * dist,
      target[1] + off[1] * dist,
      target[2] + off[2] * dist,
    ];
    const fwd = [-off[0], -off[1], -off[2]];
    const right = unit(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    let worst = 0;
    for (const c of corners) {
      const d = sub(c, eye);
      const z = dot(d, fwd);
      if (z <= 1e-4) {
        worst = Infinity;
        break;
      }
      worst = Math.max(
        worst,
        Math.abs((dot(d, right) / z) * (f / aspect)),
        Math.abs((dot(d, up) / z) * f)
      );
    }
    if (!Number.isFinite(worst)) {
      dist *= 2;
      continue;
    }
    dist *= worst * margin;
    if (Math.abs(worst * margin - 1) < 1e-4) break;
  }

  return {
    eye: [
      target[0] + off[0] * dist,
      target[1] + off[1] * dist,
      target[2] + off[2] * dist,
    ],
    target,
    fovDeg,
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
