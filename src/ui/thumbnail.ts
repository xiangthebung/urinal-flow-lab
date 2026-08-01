import { FittingsParams, buildFittings } from '../geometry/fittings';
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

export interface ThumbnailImage extends ThumbnailResult {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Build the thumbnail pixels, with no DOM involved.
 *
 * Split out from the canvas call so `tools/thumbsheet.mts` can render the picker's
 * own images offline and they can be looked at. Checking thumbnails by eyeballing
 * some other renderer's idea of the same fixture is how a rasteriser bug survived
 * for a long time: the viewport is a WebGL shader and looked correct, so the
 * corduroy the picker was drawing read as a geometry problem rather than a
 * shading one. This path is the picker's, byte for byte.
 */
export function renderFixtureThumbnail(
  width: number,
  height: number,
  params: SurfaceParams,
  shellParams?: Partial<ShellParams>,
  fittingParams?: Partial<FittingsParams>
): ThumbnailImage {
  const surface = new UrinalSurface(params, THUMB_RES);
  const shell = buildShell(surface, shellParams ?? {});
  // The metalwork is most of what makes a urinal recognisable at 128 px, and its
  // absence is what makes one recognisable too: the waterless model has no
  // flushometer, and that reads instantly next to five that do.
  const fittings = buildFittings(surface, shell, fittingParams ?? {});
  let box = unionBox(surface.bounds(), { min: shell.min, max: shell.max });
  if (!fittings.empty) box = unionBox(box, { min: fittings.min, max: fittings.max });

  const meshes: RasterMesh[] = [
    // Interior first so the casting wins any ties on the shared rim edge.
    {
      positions: surface.vertices,
      indices: surface.indices,
      normals: surface.vertexNormals,
      tint: [196, 202, 214],
    },
    {
      positions: shell.positions,
      indices: shell.indices,
      normals: shell.normals,
      tint: [231, 235, 242],
    },
  ];
  if (!fittings.empty) {
    meshes.push({
      positions: fittings.positions,
      indices: fittings.indices,
      normals: fittings.normals,
      tint: [138, 150, 165],
    });
  }

  return {
    rgba: rasterise(
      meshes,
      framedThreeQuarterView(box, width / height),
      width,
      height
    ),
    width,
    height,
    dims: {
      w: Math.round((box.max.x - box.min.x) * 1000),
      d: Math.round((box.max.z - box.min.z) * 1000),
      h: Math.round((box.max.y - box.min.y) * 1000),
    },
  };
}

export function drawFixtureThumbnail(
  canvas: HTMLCanvasElement,
  params: SurfaceParams,
  shellParams?: Partial<ShellParams>,
  fittingParams?: Partial<FittingsParams>
): ThumbnailResult | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = renderFixtureThumbnail(
    canvas.width,
    canvas.height,
    params,
    shellParams,
    fittingParams
  );
  ctx.putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
  return { dims: img.dims };
}
