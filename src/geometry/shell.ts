import { UrinalSurface } from './surface';
import { Vec3, v3 } from '../core/vec3';

/**
 * The exterior ceramic body of the fixture.
 *
 * Purely cosmetic, and deliberately kept out of `UrinalSurface`. The simulation
 * only ever touches the wetted interior, so the physics, the film grid, the BVH
 * and the validation suite are all indifferent to what happens here. Keeping the
 * two apart means the outside can be shaped for the eye without any risk of
 * quietly changing a reported number.
 *
 * It exists because a urinal is not a surface, it is a thick porcelain object,
 * and the interior loft alone does not read as one. Rendered by itself the loft
 * looks like a bent sheet of paper: no rim to catch the light, no mass under the
 * bowl, no edge thickness anywhere. Nearly all of the "that's a urinal"
 * recognition lives in the outside of the casting and in the few millimetres of
 * glaze visible at the opening, and the interior patch contains neither.
 *
 * The construction is an *envelope fit*, not an offset of the interior. Offsetting
 * was the obvious first attempt and it fails for a structural reason: offsetting a
 * thin wall gives another thin wall a fixed distance away, so the front rise of
 * the bowl came out as an unsupported fin with a hook on it and the fixture read
 * as a slab with a scoop hanging off the front. Real sanitaryware is the other way
 * round -- the interior is a cavity hollowed out of a solid body, and the ceramic
 * is whatever thickness happens to be left over. So this fits a smooth outer body
 * around the interior and then measures the thickness to it:
 *
 *   - A stack of horizontal sections is sized from the interior's own extents at
 *     each height, so the body always contains the bowl and adapts to any preset
 *     without hand-tuning -- a trough, a stall slab and a nautilus horn all get a
 *     sensible casting.
 *   - Thickness is the distance from the interior out to that envelope, which
 *     makes the ceramic naturally thin at the front lip and massive under the
 *     sump, exactly as a section drawing of a real fixture looks.
 *   - Near the opening the thickness is ramped down to a rim value, so the rim,
 *     the side edges and the front lip all show a believable few-millimetre edge
 *     instead of a chunky slab.
 *   - Where the interior faces backward the envelope is a flat plane, so the
 *     fixture sits properly against the wall and a forward-curving wall simply
 *     has more ceramic behind it.
 */

export interface ShellParams {
  /** Ceramic thickness at the opening edge, m. */
  rimThickness: number;
  /** How far in from the opening edge the wall stays thin, m. */
  rimBandWidth: number;
  /** How far behind the profile datum the flat back face sits, m. */
  backSetback: number;
  /**
   * Greatest thickness of the ceramic skin, m.
   *
   * Without a cap the skin is offset until it reaches the fitted hull, which in the
   * throat is 150 mm away, and the result is a convex lump with the bowl buried
   * inside it. A urinal is emphatically not the convex hull of its own cavity: the
   * hull spans the full width at the rim and the full depth at the lip, so it is a
   * box by construction, and no amount of tuning the fit changes that. Capping the
   * skin at a plausible casting thickness keeps the outside following the shape of
   * the bowl, which is what makes it recognisable.
   */
  wallThickness: number;
  /** Clearance between the interior and the outer body, m. */
  clearance: number;
  /** Extra fullness of the casting at mid height, m. */
  bulge: number;
  /** How far the body continues below the lowest interior point, m. */
  bottomExtension: number;
  /** Radius of the bottom tip as a fraction of the section above it. */
  bottomTaper: number;
  /**
   * Angular smoothing passes on the fitted section, which is the main lever on
   * exterior character. Few passes hug the bowl and keep its plan shape, so a
   * squarish interior gives a squarish body; many passes relax the section toward
   * a circle and give a soft oval pod.
   */
  sectionSmoothing: number;
  /** Hard cap on thickness, m. */
  maxThickness: number;
  /** Smoothing passes applied to the outer surface. */
  smoothPasses: number;
}

export function defaultShellParams(): ShellParams {
  return {
    rimThickness: 0.014,
    wallThickness: 0.028,
    rimBandWidth: 0.05,
    backSetback: 0.045,
    clearance: 0.012,
    bulge: 0.012,
    bottomExtension: 0.05,
    bottomTaper: 0.34,
    sectionSmoothing: 2,
    maxThickness: 0.3,
    smoothPasses: 2,
  };
}

export interface ShellMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Bounds of the exterior alone. */
  min: Vec3;
  max: Vec3;
}

/** Height bands and angular bins of the fitted outer section. */
const BANDS = 56;
const ABINS = 33;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(1e-9, edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export function buildShell(s: UrinalSurface, over: Partial<ShellParams> = {}): ShellMesh {
  const p = { ...defaultShellParams(), ...over };
  const nu = s.nu;
  const nv = s.nv;
  const stride = nu + 1;
  const nVert = stride * (nv + 1);
  const zBack = -p.backSetback;

  // -- Outward direction at every interior vertex ---------------------------
  // Interior normals face into the bowl, so the exterior is the other way.
  const outward = new Float64Array(nVert * 3);
  for (let k = 0; k < nVert; k++) {
    outward[k * 3] = -s.vertexNormals[k * 3];
    outward[k * 3 + 1] = -s.vertexNormals[k * 3 + 1];
    outward[k * 3 + 2] = -s.vertexNormals[k * 3 + 2];
  }

  // -- The boundary of the opening -----------------------------------------
  // One closed loop: across the top of the back wall, down the right side edge,
  // back across the front lip, up the left side edge. That loop is the rim of a
  // real urinal, which is why the whole opening can be edged in a single band.
  const loop: number[] = [];
  for (let i = 0; i <= nu; i++) loop.push(i);
  for (let j = 1; j <= nv; j++) loop.push(j * stride + nu);
  for (let i = nu - 1; i >= 0; i--) loop.push(nv * stride + i);
  for (let j = nv - 1; j >= 1; j--) loop.push(j * stride);
  const L = loop.length;

  // -- Distance from each vertex to the opening edge ------------------------
  // Brute force against the boundary ring. A few million distance evaluations on
  // a rebuild is nothing, and it gives a true metric distance, so the rim keeps a
  // constant physical width instead of a constant number of cells.
  const edgeDist = new Float64Array(nVert);
  for (let k = 0; k < nVert; k++) {
    const x = s.vertices[k * 3];
    const y = s.vertices[k * 3 + 1];
    const z = s.vertices[k * 3 + 2];
    let best = Infinity;
    for (let m = 0; m < L; m++) {
      const b = loop[m] * 3;
      const dx = s.vertices[b] - x;
      const dy = s.vertices[b + 1] - y;
      const dz = s.vertices[b + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
    edgeDist[k] = Math.sqrt(best);
  }

  // -- Fit the outer envelope ----------------------------------------------
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let k = 0; k < nVert; k++) {
    const y = s.vertices[k * 3 + 1];
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const yBot = yMin - p.bottomExtension;
  const yTop = yMax;
  const ySpan = Math.max(1e-6, yTop - yBot);
  const bandOf = (y: number) =>
    Math.min(BANDS - 1, Math.max(0, Math.round(((y - yBot) / ySpan) * (BANDS - 1))));

  // The section of the casting is fitted as a *support function* in the plane
  // (x, z - zBack): for each height band and each direction, how far out the
  // supporting line of the interior sits. The body is then the convex region
  // bounded by all of those lines.
  //
  // Two cheaper fits were tried first and both failed for instructive reasons. A
  // width-and-depth box has corners the bowl never fills, so it either cut the
  // side edges or, once grown until the corners cleared them, inflated the whole
  // casting by 70 mm. Recording the furthest reach per angle instead left the
  // directions the bowl does not occupy undefined, and filling those from their
  // neighbours carried the deep forward reach of the front lip out sideways --
  // a 340 mm bowl came out 600 mm wide.
  //
  // A support function has neither failure mode. Every direction is defined
  // whether or not the interior happens to point that way, offsetting outward is
  // exactly an additive constant, and the result provably contains the interior,
  // so no correction pass is needed. It is also convex, which is what the outside
  // of a piece of sanitaryware is.
  const dirS = new Float64Array(ABINS);
  const dirC = new Float64Array(ABINS);
  for (let a = 0; a < ABINS; a++) {
    const th = -Math.PI / 2 + (a / (ABINS - 1)) * Math.PI;
    dirS[a] = Math.sin(th);
    dirC[a] = Math.cos(th);
  }

  const H = new Float64Array(BANDS * ABINS).fill(-Infinity);
  for (let k = 0; k < nVert; k++) {
    const bi = bandOf(s.vertices[k * 3 + 1]);
    const dx = s.vertices[k * 3];
    const dz = Math.max(0, s.vertices[k * 3 + 2] - zBack);
    const row = bi * ABINS;
    for (let a = 0; a < ABINS; a++) {
      const h = dx * dirS[a] + dz * dirC[a];
      if (h > H[row + a]) H[row + a] = h;
    }
  }

  // Bands with nothing in them sit below the bowl. Carry the lowest occupied
  // section down, scaling it about the back plane so the casting narrows and
  // draws back toward the wall into a rounded bottom.
  const occupied = new Uint8Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    occupied[b] = Number.isFinite(H[b * ABINS]) ? 1 : 0;
  }
  const firstOccupied = (() => {
    for (let b = 0; b < BANDS; b++) if (occupied[b]) return b;
    return 0;
  })();
  for (let b = BANDS - 2; b > firstOccupied; b--) {
    if (occupied[b]) continue;
    for (let a = 0; a < ABINS; a++) H[b * ABINS + a] = H[(b + 1) * ABINS + a];
  }
  if (!occupied[BANDS - 1]) {
    for (let a = 0; a < ABINS; a++) {
      H[(BANDS - 1) * ABINS + a] = H[(BANDS - 2) * ABINS + a];
    }
  }
  for (let b = 0; b < firstOccupied; b++) {
    const frac = firstOccupied > 0 ? b / firstOccupied : 1;
    const k = p.bottomTaper + (1 - p.bottomTaper) * Math.sqrt(frac);
    for (let a = 0; a < ABINS; a++) H[b * ABINS + a] = H[firstOccupied * ABINS + a] * k;
  }

  // Offsetting a convex body outward is exactly adding a constant to its support
  // function, so clearance and the mid-height fullness go straight on.
  const rawH = Float64Array.from(H);
  for (let b = 0; b < BANDS; b++) {
    const sN = b / (BANDS - 1);
    const fullness = p.bulge * Math.sin(Math.PI * sN);
    for (let a = 0; a < ABINS; a++) H[b * ABINS + a] += p.clearance + fullness;
  }

  // Relax the section: angular smoothing rounds off the plan shape, vertical
  // smoothing cleans up the silhouette. Clamped back against the raw fit so
  // rounding a corner can never pull the body inside the bowl.
  const tmpH = new Float64Array(H.length);
  for (let pass = 0; pass < p.sectionSmoothing; pass++) {
    tmpH.set(H);
    for (let b = 0; b < BANDS; b++) {
      for (let a = 0; a < ABINS; a++) {
        const al = Math.max(0, a - 1);
        const ar = Math.min(ABINS - 1, a + 1);
        H[b * ABINS + a] =
          0.25 * tmpH[b * ABINS + al] +
          0.5 * tmpH[b * ABINS + a] +
          0.25 * tmpH[b * ABINS + ar];
      }
    }
  }
  for (let pass = 0; pass < 4; pass++) {
    tmpH.set(H);
    for (let b = 1; b < BANDS - 1; b++) {
      for (let a = 0; a < ABINS; a++) {
        H[b * ABINS + a] =
          0.25 * tmpH[(b - 1) * ABINS + a] +
          0.5 * tmpH[b * ABINS + a] +
          0.25 * tmpH[(b + 1) * ABINS + a];
      }
    }
  }
  for (let i = 0; i < H.length; i++) {
    const floorH = rawH[i] + p.clearance * 0.5;
    if (H[i] < floorH) H[i] = floorH;
  }

  // Radial form of the same body, so the ray march is a table lookup instead of a
  // half-plane intersection at every step.
  const R = new Float64Array(BANDS * ABINS);
  for (let b = 0; b < BANDS; b++) {
    for (let a = 0; a < ABINS; a++) {
      let r = Infinity;
      for (let f = 0; f < ABINS; f++) {
        const c = dirS[a] * dirS[f] + dirC[a] * dirC[f];
        if (c <= 1e-3) continue;
        const cand = H[b * ABINS + f] / c;
        if (cand < r) r = cand;
      }
      R[b * ABINS + a] = Number.isFinite(r) ? Math.max(1e-4, r) : 1e-4;
    }
  }

  /** Envelope radius at a height and angle, bilinearly interpolated. */
  const radiusAt = (y: number, th: number): number => {
    const tb = Math.min(1, Math.max(0, (y - yBot) / ySpan)) * (BANDS - 1);
    const b0 = Math.min(BANDS - 2, Math.floor(tb));
    const fb = tb - b0;
    const ta = Math.min(1, Math.max(0, (th + Math.PI / 2) / Math.PI)) * (ABINS - 1);
    const a0 = Math.min(ABINS - 2, Math.floor(ta));
    const fa = ta - a0;
    return (
      (R[b0 * ABINS + a0] * (1 - fa) + R[b0 * ABINS + a0 + 1] * fa) * (1 - fb) +
      (R[(b0 + 1) * ABINS + a0] * (1 - fa) + R[(b0 + 1) * ABINS + a0 + 1] * fa) * fb
    );
  };

  /**
   * Envelope field. Negative inside the casting, positive outside.
   *
   * Closed at the top as well as the bottom and the back. Leaving the top open let
   * a ray march upward for ever without escaping, because heights above the rim
   * clamp to the topmost band and that band is the widest one -- so a wall that
   * leans forward at the top, which the constant-angle shapes all do, had its rim
   * vertices thrown 170 mm into the air on the thickness cap.
   */
  const field = (x: number, y: number, z: number): number => {
    if (y < yBot) return (yBot - y) * 50;
    if (y > yTop) return (y - yTop) * 50;
    const dz = z - zBack;
    if (dz < 0) return -dz * 50;
    const r = Math.hypot(x, dz);
    return r / radiusAt(y, Math.atan2(x, dz)) - 1;
  };

  // -- Convexity of the interior, per vertex -------------------------------
  // Offsetting outward from a surface that bulges into the bowl walks toward the
  // centre of curvature, and past the radius it folds through itself. The front
  // lip curl is the case that matters: a 25 mm curl cannot carry 40 mm of body.
  const convexity = new Float64Array(nVert);
  const wsum = new Float64Array(nVert);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const c = j * nu + i;
      const kk = s.cellCurvature[c];
      const w = s.cellArea[c];
      for (const vi of [
        j * stride + i,
        j * stride + i + 1,
        (j + 1) * stride + i,
        (j + 1) * stride + i + 1,
      ]) {
        convexity[vi] += kk * w;
        wsum[vi] += w;
      }
    }
  }
  for (let k = 0; k < nVert; k++) if (wsum[k] > 0) convexity[k] /= wsum[k];

  // -- Thickness: march out to the envelope --------------------------------
  const outer = new Float64Array(nVert * 3);
  const step = 0.0025;
  for (let k = 0; k < nVert; k++) {
    const o = k * 3;
    const x = s.vertices[o];
    const y = s.vertices[o + 1];
    const z = s.vertices[o + 2];
    const ox = outward[o];
    const oy = outward[o + 1];
    const oz = outward[o + 2];

    let tEnv = p.rimThickness;
    if (field(x, y, z) < 0) {
      let lo = 0;
      let hi = -1;
      for (let d = step; d <= p.maxThickness; d += step) {
        if (field(x + ox * d, y + oy * d, z + oz * d) >= 0) {
          hi = d;
          lo = d - step;
          break;
        }
      }
      if (hi < 0) {
        tEnv = p.maxThickness;
      } else {
        for (let b = 0; b < 12; b++) {
          const mid = 0.5 * (lo + hi);
          if (field(x + ox * mid, y + oy * mid, z + oz * mid) >= 0) hi = mid;
          else lo = mid;
        }
        tEnv = 0.5 * (lo + hi);
      }
    }

    // Thin the wall down to a rim edge as the opening is approached -- but only
    // where the wall is genuinely part of the opening. The top of the back wall is
    // an edge of the patch too, and thinning it left the back face of the fixture
    // stepping 30 mm forward of the mounting plane for the top 50 mm, which is not
    // how a wall-hung fixture sits. Where the surface faces backward the full
    // thickness is kept, so the back stays flush and the rim reads as the chunky
    // rolled edge it is on a real bowl.
    const ramp = smoothstep(0, p.rimBandWidth, edgeDist[k]);
    const backness = smoothstep(0.35, 0.85, Math.max(0, -oz));
    const thinning = ramp + (1 - ramp) * backness;
    let t = p.rimThickness + (Math.max(tEnv, p.rimThickness) - p.rimThickness) * thinning;

    // Never offset past the local centre of curvature.
    if (convexity[k] > 1e-6) t = Math.min(t, 0.7 / convexity[k]);
    // A skin, not a fill. See wallThickness. The back is exempt, because there the
    // extra thickness is what carries the casting out to the mounting plane and is
    // genuinely solid on a real fixture.
    const cap = p.wallThickness + (p.maxThickness - p.wallThickness) * backness;
    t = Math.max(0.002, Math.min(t, cap));

    outer[o] = x + ox * t;
    outer[o + 1] = y + oy * t;
    outer[o + 2] = Math.max(zBack, z + oz * t);
  }

  // -- Smooth the outside ---------------------------------------------------
  // The boundary ring is pinned so the rim band stays exactly on the edge of the
  // opening; everything else relaxes, which drops any rib pattern cut into the
  // interior instead of embossing it onto the outside of the pot.
  const onEdge = new Uint8Array(nVert);
  for (let m = 0; m < L; m++) onEdge[loop[m]] = 1;
  const tmp = new Float64Array(outer.length);
  for (let pass = 0; pass < p.smoothPasses; pass++) {
    tmp.set(outer);
    for (let j = 1; j < nv; j++) {
      for (let i = 1; i < nu; i++) {
        const k = j * stride + i;
        if (onEdge[k]) continue;
        const o = k * 3;
        for (let a = 0; a < 3; a++) {
          const avg =
            0.25 *
            (tmp[(k - 1) * 3 + a] +
              tmp[(k + 1) * 3 + a] +
              tmp[(k - stride) * 3 + a] +
              tmp[(k + stride) * 3 + a]);
          outer[o + a] = tmp[o + a] + 0.5 * (avg - tmp[o + a]);
        }
      }
    }
    for (let k = 0; k < nVert; k++) {
      if (outer[k * 3 + 2] < zBack) outer[k * 3 + 2] = zBack;
    }
  }

  // -- Outer surface normals ------------------------------------------------
  const outerNormal = new Float64Array(nVert * 3);
  const at = (i: number, j: number, a: number) =>
    outer[(Math.min(nv, Math.max(0, j)) * stride + Math.min(nu, Math.max(0, i))) * 3 + a];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const k = j * stride + i;
      const eu = [
        at(i + 1, j, 0) - at(i - 1, j, 0),
        at(i + 1, j, 1) - at(i - 1, j, 1),
        at(i + 1, j, 2) - at(i - 1, j, 2),
      ];
      const ev = [
        at(i, j + 1, 0) - at(i, j - 1, 0),
        at(i, j + 1, 1) - at(i, j - 1, 1),
        at(i, j + 1, 2) - at(i, j - 1, 2),
      ];
      let nx = ev[1] * eu[2] - ev[2] * eu[1];
      let ny = ev[2] * eu[0] - ev[0] * eu[2];
      let nz = ev[0] * eu[1] - ev[1] * eu[0];
      const m = Math.hypot(nx, ny, nz);
      if (m < 1e-12) {
        nx = outward[k * 3];
        ny = outward[k * 3 + 1];
        nz = outward[k * 3 + 2];
      } else {
        nx /= m;
        ny /= m;
        nz /= m;
        // Orient against the interior's outward direction, which is reliable.
        if (nx * outward[k * 3] + ny * outward[k * 3 + 1] + nz * outward[k * 3 + 2] < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
      }
      outerNormal[k * 3] = nx;
      outerNormal[k * 3 + 1] = ny;
      outerNormal[k * 3 + 2] = nz;
    }
  }

  // -- Assemble -------------------------------------------------------------
  // Vertex blocks, in order: the offset outer surface, the rim band, then the
  // solid body. The band gets its own copies of the boundary so the rim edge stays
  // sharp instead of averaging its normal into the outer surface.
  const bandBase = nVert;
  const bodyBase = nVert + L * 2;
  const body = buildBody(s, p, zBack, yBot, radiusAt);
  const totalVerts = bodyBase + body.count;
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  for (let k = 0; k < nVert * 3; k++) {
    positions[k] = outer[k];
    normals[k] = outerNormal[k];
  }
  for (let k = 0; k < body.count * 3; k++) {
    positions[bodyBase * 3 + k] = body.positions[k];
    normals[bodyBase * 3 + k] = body.normals[k];
  }

  const idx: number[] = [];
  for (const t of body.indices) idx.push(t + bodyBase);
  // Winding is decided empirically from one mid-patch triangle, because the
  // interior's index order is not guaranteed to be outward-facing for every
  // geometry and the shell has to be right for all of them.
  const flip = (() => {
    const j = Math.max(0, Math.floor(nv * 0.15));
    const i = Math.floor(nu / 2);
    const a = (j * stride + i) * 3;
    const b = (j * stride + i + 1) * 3;
    const c = ((j + 1) * stride + i) * 3;
    const e1 = [outer[b] - outer[a], outer[b + 1] - outer[a + 1], outer[b + 2] - outer[a + 2]];
    const e2 = [outer[c] - outer[a], outer[c + 1] - outer[a + 1], outer[c + 2] - outer[a + 2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    const k = j * stride + i;
    return nx * outward[k * 3] + ny * outward[k * 3 + 1] + nz * outward[k * 3 + 2] < 0;
  })();

  // Only the part of the skin above the front lip is emitted.
  //
  // Below the lip the solid pedestal is the outside of the fixture, so the skin
  // there is redundant -- and worse than redundant: the throat is strongly concave,
  // so offsetting it outward converges toward the centre of curvature and the skin
  // folds through itself, which showed up as a torn shard lying across the bowl. Its
  // one remaining job is above the lip, where the pedestal has stopped and the back
  // panel and the rim around the opening still need a surface. That region is
  // convex enough to offset safely.
  const yCut = s.lipY - 0.004;
  const aboveCut = (j: number) => s.vertices[(j * stride + Math.floor(nu / 2)) * 3 + 1] > yCut;
  for (let j = 0; j < nv; j++) {
    if (!aboveCut(j) && !aboveCut(j + 1)) continue;
    for (let i = 0; i < nu; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      if (flip) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }

  // Centroid of the opening, used to orient the rim band outward.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let m = 0; m < L; m++) {
    const b = loop[m] * 3;
    cx += s.vertices[b];
    cy += s.vertices[b + 1];
    cz += s.vertices[b + 2];
  }
  cx /= L;
  cy /= L;
  cz /= L;

  for (let m = 0; m < L; m++) {
    const src = loop[m] * 3;
    const vi = (bandBase + m * 2) * 3;
    positions[vi] = s.vertices[src];
    positions[vi + 1] = s.vertices[src + 1];
    positions[vi + 2] = s.vertices[src + 2];
    positions[vi + 3] = outer[src];
    positions[vi + 4] = outer[src + 1];
    positions[vi + 5] = outer[src + 2];
  }
  // Band normal at each loop point: perpendicular to both the loop tangent and
  // the wall thickness direction, pointed away from the middle of the opening.
  for (let m = 0; m < L; m++) {
    const prev = loop[(m - 1 + L) % L] * 3;
    const next = loop[(m + 1) % L] * 3;
    const here = loop[m] * 3;
    const tx = s.vertices[next] - s.vertices[prev];
    const ty = s.vertices[next + 1] - s.vertices[prev + 1];
    const tz = s.vertices[next + 2] - s.vertices[prev + 2];
    const wx = outer[here] - s.vertices[here];
    const wy = outer[here + 1] - s.vertices[here + 1];
    const wz = outer[here + 2] - s.vertices[here + 2];
    let nx = ty * wz - tz * wy;
    let ny = tz * wx - tx * wz;
    let nz = tx * wy - ty * wx;
    const mag = Math.hypot(nx, ny, nz);
    if (mag < 1e-12) {
      nx = outward[loop[m] * 3];
      ny = outward[loop[m] * 3 + 1];
      nz = outward[loop[m] * 3 + 2];
    } else {
      nx /= mag;
      ny /= mag;
      nz /= mag;
      const rx = s.vertices[here] - cx;
      const ry = s.vertices[here + 1] - cy;
      const rz = s.vertices[here + 2] - cz;
      if (nx * rx + ny * ry + nz * rz < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
    }
    const vi = (bandBase + m * 2) * 3;
    normals[vi] = nx;
    normals[vi + 1] = ny;
    normals[vi + 2] = nz;
    normals[vi + 3] = nx;
    normals[vi + 4] = ny;
    normals[vi + 5] = nz;
  }

  const bandFlip = (() => {
    const a = bandBase;
    const b = bandBase + 2;
    const e1 = [
      positions[b * 3] - positions[a * 3],
      positions[b * 3 + 1] - positions[a * 3 + 1],
      positions[b * 3 + 2] - positions[a * 3 + 2],
    ];
    const e2 = [
      positions[(a + 1) * 3] - positions[a * 3],
      positions[(a + 1) * 3 + 1] - positions[a * 3 + 1],
      positions[(a + 1) * 3 + 2] - positions[a * 3 + 2],
    ];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    return (
      nx * normals[bandBase * 3] +
        ny * normals[bandBase * 3 + 1] +
        nz * normals[bandBase * 3 + 2] <
      0
    );
  })();

  for (let m = 0; m < L; m++) {
    const next = (m + 1) % L;
    // Matched to the skin: no band where there is no skin to edge.
    if (
      s.vertices[loop[m] * 3 + 1] <= yCut &&
      s.vertices[loop[next] * 3 + 1] <= yCut
    ) {
      continue;
    }
    const a0 = bandBase + m * 2;
    const a1 = a0 + 1;
    const b0 = bandBase + next * 2;
    const b1 = b0 + 1;
    if (bandFlip) idx.push(a0, b0, a1, a1, b0, b1);
    else idx.push(a0, a1, b0, a1, b1, b0);
  }

  const min = v3(Infinity, Infinity, Infinity);
  const max = v3(-Infinity, -Infinity, -Infinity);
  for (let k = 0; k < totalVerts; k++) {
    const x = positions[k * 3];
    const y = positions[k * 3 + 1];
    const z = positions[k * 3 + 2];
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }

  return { positions, normals, indices: new Uint32Array(idx), min, max };
}

/** Angular (per side) and vertical resolution of the solid body. */
const BODY_A = 34;
const BODY_V = 56;

/**
 * The solid lower body of the fixture.
 *
 * The offset surface above is a skin: it follows the interior, so its cross
 * section is the same C the bowl is, and a C-section casting is see-through from
 * the side -- you look straight between the front rise and the back wall. Real
 * sanitaryware is a solid lump with a cavity in it, so the volume between the
 * front of the bowl and the mounting plane has to actually be filled.
 *
 * The fill only has to reach the front lip. Below the lip a horizontal slice
 * through a urinal is a closed ring of ceramic around the cavity, so the body is
 * a plain tube and needs no cutting; above the lip the front is open by
 * definition and the thin back panel and side wings the offset surface already
 * provides are the correct shape. The step at the lip where the full body gives
 * way to the wings is a real feature of the object, not an artefact.
 *
 * Sits a whisker outside the offset surface so the two cannot z-fight where they
 * touch, and the deck at the top is trimmed by raycasting the bowl, so it meets
 * the lip exactly however the interior is shaped.
 */
function buildBody(
  s: UrinalSurface,
  p: ShellParams,
  zBack: number,
  yBot: number,
  radiusAt: (y: number, th: number) => number
): { positions: Float32Array; normals: Float32Array; indices: number[]; count: number } {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const push = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number
  ): number => {
    pos.push(x, y, z);
    nrm.push(nx, ny, nz);
    return pos.length / 3 - 1;
  };
  // Pushed out a whisker: the offset surface already lies on this envelope
  // wherever it is not thinned for the rim, and coincident surfaces flicker.
  const rOf = (y: number, t: number) => radiusAt(y, t) * 1.004;
  const HALF = Math.PI / 2;

  const stride = s.nu + 1;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let k = 0; k < stride * (s.nv + 1); k++) {
    const y = s.vertices[k * 3 + 1];
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  // The solid pedestal stops at the front lip.
  //
  // Below the lip a horizontal cut through a urinal is a closed ring of ceramic
  // around the cavity, so that part is genuinely a solid body. Above it the front is
  // open by definition, and all that remains is the back panel and a rim around the
  // opening -- which the offset skin already provides at the right thickness.
  // Carrying the solid body all the way to the rim instead, with wings either side
  // of the opening, filled in everything around the bowl and reduced the opening to
  // a slot: the fixture read as a rounded box. Stopping at the lip is both what a
  // real casting does and what lets you see into the bowl.
  const yTop = Math.min(yMax - 0.005, Math.max(yMin + 0.02, s.lipY));
  const yOf = (l: number) => yBot + ((yTop - yBot) * l) / BODY_V;

  // -- Outer wall, as a left and a right sheet ------------------------------
  const normalAt = (y: number, t: number): [number, number, number] => {
    const dy = Math.max(1e-4, (yTop - yBot) / BODY_V);
    const drdy =
      (rOf(Math.min(yTop, y + dy), t) - rOf(Math.max(yBot, y - dy), t)) / (2 * dy);
    let nx = Math.sin(t);
    let nz = Math.cos(t);
    let ny = -drdy;
    const m = Math.hypot(nx, ny, nz) || 1;
    return [nx / m, ny / m, nz / m];
  };

  {
    const rows: number[][] = [];
    const NA = BODY_A * 2;
    for (let l = 0; l <= BODY_V; l++) {
      const y = yOf(l);
      const row: number[] = [];
      for (let a = 0; a <= NA; a++) {
        const t = -HALF + (a / NA) * Math.PI;
        const r = rOf(y, t);
        const n = normalAt(y, t);
        row.push(push(r * Math.sin(t), y, zBack + r * Math.cos(t), n[0], n[1], n[2]));
      }
      rows.push(row);
    }
    for (let l = 0; l < BODY_V; l++) {
      for (let a = 0; a < NA; a++) {
        const v00 = rows[l][a];
        const v01 = rows[l][a + 1];
        const v10 = rows[l + 1][a];
        const v11 = rows[l + 1][a + 1];
        idx.push(v00, v10, v01, v01, v10, v11);
      }
    }
  }

  // -- Flat back against the mounting plane --------------------------------
  const backL: number[] = [];
  const backR: number[] = [];
  for (let l = 0; l <= BODY_V; l++) {
    const y = yOf(l);
    backL.push(push(-Math.abs(rOf(y, -HALF)), y, zBack, 0, 0, -1));
    backR.push(push(Math.abs(rOf(y, HALF)), y, zBack, 0, 0, -1));
  }
  for (let l = 0; l < BODY_V; l++) {
    idx.push(backL[l], backR[l], backL[l + 1], backL[l + 1], backR[l], backR[l + 1]);
  }

  // -- Bottom ---------------------------------------------------------------
  const bc = push(0, yBot, zBack + rOf(yBot, 0) * 0.35, 0, -1, 0);
  const bottom: number[] = [];
  const NB = BODY_A * 2;
  for (let a = 0; a <= NB; a++) {
    const t = -HALF + (a / NB) * Math.PI;
    const r = rOf(yBot, t);
    bottom.push(push(r * Math.sin(t), yBot, zBack + r * Math.cos(t), 0, -1, 0));
  }
  for (let a = 0; a < NB; a++) idx.push(bc, bottom[a + 1], bottom[a]);
  idx.push(bc, bottom[0], push(-Math.abs(rOf(yBot, -HALF)), yBot, zBack, 0, -1, 0));
  idx.push(bc, push(Math.abs(rOf(yBot, HALF)), yBot, zBack, 0, -1, 0), bottom[NB]);

  // -- Horizontal decks: the top of the lip, and the top of the rim ---------
  // Both are found by shooting a ray inward at the bowl, so the deck stops exactly
  // where the ceramic meets the cavity however the interior is shaped. Where the
  // ray misses there is no cavity at that height, so the deck runs to the axis.
  const origin = v3();
  const dir = v3();
  /**
   * How far in from the outer wall the cavity starts, at a height and angle.
   *
   * The probe is dropped a couple of millimetres below the height being decked.
   * Both decks sit exactly on an edge of the interior patch -- the rim deck on the
   * v = 0 row, the lip deck on v = 1 -- and a ray travelling in the plane of that
   * boundary row grazes it and misses about half the time, which reports no cavity
   * at all and paves the deck straight over the opening.
   */
  const cavityRadius = (y: number, t: number, probeDrop = 0.003): number | null => {
    const rOut = rOf(y, t);
    const sx = Math.sin(t);
    const sz = Math.cos(t);
    origin.x = rOut * sx;
    origin.y = y - probeDrop;
    origin.z = zBack + rOut * sz;
    dir.x = -sx;
    dir.y = 0;
    dir.z = -sz;
    const hit = s.raycast(origin, dir, rOut);
    return hit ? Math.max(0, rOut - hit.t) : null;
  };
  const quad = (a0: number, a1: number, b0: number, b1: number): void => {
    idx.push(a0, b0, a1, a1, b0, b1);
    idx.push(a0, a1, b0, a1, b1, b0);
  };

  // Top of the pedestal: a horizontal ring at the lip, from the bowl outward to
  // the wall, all the way round. Its inner edge is found by raycasting the bowl a
  // few millimetres BELOW the lip, where the front wall of the bowl still exists.
  // Probing above it looks equally reasonable and is catastrophic: above the lip the
  // bowl is open, so the ray sails over the front wall and stops on the back wall
  // instead, and the deck then paves the entire cavity into a flat shelf.
  {
    const steps = BODY_A * 2;
    // Width limited. The raycast alone is too fragile to size this: at angles where
    // the ray passes clear of the bowl's front wall it carries on and stops on the
    // back wall instead, which asks for a deck a third of a metre wide, and mixing
    // those in with the angles that do hit produced a scalloped plate lying across
    // the opening. Physically this face is the rim of the front lip and is about as
    // wide as the ceramic is thick, so the raycast is only allowed to make it
    // narrower, never wider.
    const maxDeck = p.wallThickness + p.clearance + 0.012;
    const outs: number[] = [];
    const ins: number[] = [];
    for (let a = 0; a <= steps; a++) {
      const t = -HALF + (a / steps) * Math.PI;
      const rOut = rOf(yTop, t);
      const hit = cavityRadius(yTop, t, 0.004);
      const rIn = Math.max(
        0,
        Math.max(rOut - maxDeck, hit === null ? 0 : Math.min(hit, rOut - 0.001))
      );
      const sx = Math.sin(t);
      const sz = Math.cos(t);
      outs.push(push(rOut * sx, yTop, zBack + rOut * sz, 0, 1, 0));
      ins.push(push(rIn * sx, yTop, zBack + rIn * sz, 0, 1, 0));
    }
    for (let a = 0; a < steps; a++) quad(outs[a], outs[a + 1], ins[a], ins[a + 1]);
  }

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    indices: idx,
    count: pos.length / 3,
  };
}
