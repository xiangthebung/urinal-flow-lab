/**
 * Minimal 3-vector helpers.
 *
 * Two styles coexist on purpose:
 *  - `Vec3` objects for readable, non-hot code (geometry setup, UI).
 *  - free functions on raw numbers for the particle inner loops, where
 *    allocating a Vec3 per droplet per step would dominate the frame time.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });

export const set = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });

export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => ({
  x: a.x + b.x * s,
  y: a.y + b.y * s,
  z: a.z + b.z * s,
});

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const lengthSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;

export const length = (a: Vec3): number => Math.sqrt(lengthSq(a));

export const distance = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-30 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
};

/** Component of `a` along unit vector `n`. */
export const projectOnto = (a: Vec3, n: Vec3): Vec3 => scale(n, dot(a, n));

/** Component of `a` perpendicular to unit vector `n`. */
export const tangentPart = (a: Vec3, n: Vec3): Vec3 => sub(a, projectOnto(a, n));

/** Reflect `a` about the plane with unit normal `n`. */
export const reflect = (a: Vec3, n: Vec3): Vec3 => addScaled(a, n, -2 * dot(a, n));

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

/**
 * Build an orthonormal basis containing unit vector `n` as the third axis.
 * Uses Duff et al.'s branchless construction, which stays well-conditioned
 * for every input direction (the naive "cross with up" trick degenerates
 * when n is vertical, and a urinal has plenty of horizontal surface where
 * n *is* vertical).
 */
export const orthonormalBasis = (n: Vec3): { t1: Vec3; t2: Vec3 } => {
  const sign = n.z >= 0 ? 1 : -1;
  const a = -1 / (sign + n.z);
  const b = n.x * n.y * a;
  return {
    t1: { x: 1 + sign * n.x * n.x * a, y: sign * b, z: -sign * n.x },
    t2: { x: b, y: sign + n.y * n.y * a, z: -n.y },
  };
};

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

export const degToRad = (d: number): number => (d * Math.PI) / 180;
export const radToDeg = (r: number): number => (r * 180) / Math.PI;
