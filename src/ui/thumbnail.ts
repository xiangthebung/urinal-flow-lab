import { ShellParams, buildShell } from '../geometry/shell';
import { SurfaceParams, UrinalSurface } from '../geometry/surface';
import {
  RasterMesh,
  framedThreeQuarterView,
  rasterise,
  unionBox,
} from '../render/softRaster';

/**
 * Thumbnails for the fixture picker.
 *
 * Real geometry, not hand-drawn icons. The whole reason the picker exists is that
 * choosing a fixture from a dropdown of names tells you nothing about its shape,
 * and an icon that only approximates the model would be worse than nothing here --
 * it would misrepresent the thing being simulated. These are the same surface and
 * casting the solver and the viewport use, just at a coarse grid.
 */

/** Coarse enough to build six of them without a visible pause. */
const THUMB_RES = { nu: 30, nv: 56 };

export interface ThumbnailResult {
  /** Outside dimensions of the casting in mm, width x depth x height. */
  dims: { w: number; d: number; h: number };
}

export function drawFixtureThumbnail(
  canvas: HTMLCanvasElement,
  params: SurfaceParams,
  shellParams?: Partial<ShellParams>
): ThumbnailResult | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const surface = new UrinalSurface(params, THUMB_RES);
  const shell = buildShell(surface, shellParams ?? {});
  const box = unionBox(surface.bounds(), { min: shell.min, max: shell.max });

  const meshes: RasterMesh[] = [
    // Interior first so the casting wins any ties on the shared rim edge.
    { positions: surface.vertices, indices: surface.indices, tint: [196, 202, 214] },
    { positions: shell.positions, indices: shell.indices, tint: [231, 235, 242] },
  ];

  const w = canvas.width;
  const h = canvas.height;
  const rgba = rasterise(meshes, framedThreeQuarterView(box), w, h);
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0);

  return {
    dims: {
      w: Math.round((box.max.x - box.min.x) * 1000),
      d: Math.round((box.max.z - box.min.z) * 1000),
      h: Math.round((box.max.y - box.min.y) * 1000),
    },
  };
}
