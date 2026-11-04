/**
 * 4×4 matrix helpers complementing @pcbcad/core (row-major, same convention as core's Mat4:
 * m[r*4 + c], points are column vectors, p' = M·p).
 */
import type { Mat4, Transform3, Vec3 } from '@pcbcad/core';
import { mat4FromTransform, mat4Identity, mat4Multiply } from '@pcbcad/core';

export { mat4Identity, mat4Multiply };

/** Matrix whose columns are the images of the local axes, translated to `o`. Works for mirrored bases too. */
export function mat4FromBasis(o: Vec3, ex: Vec3, ey: Vec3, ez: Vec3): Mat4 {
  return [ex[0], ey[0], ez[0], o[0], ex[1], ey[1], ez[1], o[1], ex[2], ey[2], ez[2], o[2], 0, 0, 0, 1];
}

export function mat4Translation(v: Vec3): Mat4 {
  return [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2], 0, 0, 0, 1];
}

export function mat4RotZ(deg: number): Mat4 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function mat4Scale(sx: number, sy: number, sz: number): Mat4 {
  return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1];
}

export function mat4FromT(t: Transform3 | undefined): Mat4 {
  if (!t) return mat4Identity();
  return mat4FromTransform({ position: t.position ?? [0, 0, 0], rotation: t.rotation ?? [0, 0, 0] });
}

/** Compose left-to-right: mul(A, B, C) = A·B·C. */
export function mul(...ms: (Mat4 | undefined | null)[]): Mat4 {
  let r: Mat4 | null = null;
  for (const m of ms) {
    if (!m) continue;
    r = r ? mat4Multiply(r, m) : m.slice();
  }
  return r ?? mat4Identity();
}

/** General affine inverse (3×3 linear part + translation). */
export function mat4Invert(m: Mat4): Mat4 {
  const a = m[0], b = m[1], c = m[2];
  const d = m[4], e = m[5], f = m[6];
  const g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-300) throw new Error('Singular matrix');
  const inv = 1 / det;
  const r00 = A * inv;
  const r01 = -(b * i - c * h) * inv;
  const r02 = (b * f - c * e) * inv;
  const r10 = B * inv;
  const r11 = (a * i - c * g) * inv;
  const r12 = -(a * f - c * d) * inv;
  const r20 = C * inv;
  const r21 = -(a * h - b * g) * inv;
  const r22 = (a * e - b * d) * inv;
  const tx = m[3], ty = m[7], tz = m[11];
  return [
    r00, r01, r02, -(r00 * tx + r01 * ty + r02 * tz),
    r10, r11, r12, -(r10 * tx + r11 * ty + r12 * tz),
    r20, r21, r22, -(r20 * tx + r21 * ty + r22 * tz),
    0, 0, 0, 1,
  ];
}

/** Column-major copy (manifold-3d's Mat4 layout). */
export function toColumnMajor(m: Mat4): number[] {
  return [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
}

export function isIdentity(m: Mat4 | undefined | null, tol = 1e-12): boolean {
  if (!m) return true;
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let k = 0; k < 16; k++) if (Math.abs(m[k] - I[k]) > tol) return false;
  return true;
}

export function apply(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

export function applyDir(m: Mat4, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[4] * v[0] + m[5] * v[1] + m[6] * v[2], m[8] * v[0] + m[9] * v[1] + m[10] * v[2]];
}

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  /** a + s·b */
  madd: (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
};
