import type { Vec3 } from '@pcbcad/core';

/** Staggered (MAC) velocity field on a voxel grid; lengths in mm, velocities in m/s. */
export interface StreamField {
  nx: number;
  ny: number;
  nz: number;
  h: number;
  origin: Vec3;
  solid: (cell: number) => boolean;
  /** x-face velocities, (nx+1)·ny·nz */
  u: Float64Array;
  /** y-face velocities, nx·(ny+1)·nz */
  v: Float64Array;
  /** z-face velocities, nx·ny·(nz+1) */
  w: Float64Array;
}

/** Trilinear interpolation on a node array of dims (n0, n1, n2) at continuous index (a, b, c), clamped. */
function interp(arr: Float64Array, n0: number, n1: number, n2: number, a: number, b: number, c: number): number {
  a = Math.min(Math.max(a, 0), n0 - 1);
  b = Math.min(Math.max(b, 0), n1 - 1);
  c = Math.min(Math.max(c, 0), n2 - 1);
  const i = Math.min(Math.floor(a), Math.max(n0 - 2, 0));
  const j = Math.min(Math.floor(b), Math.max(n1 - 2, 0));
  const k = Math.min(Math.floor(c), Math.max(n2 - 2, 0));
  const fa = n0 > 1 ? a - i : 0;
  const fb = n1 > 1 ? b - j : 0;
  const fc = n2 > 1 ? c - k : 0;
  const i1 = Math.min(i + 1, n0 - 1);
  const j1 = Math.min(j + 1, n1 - 1);
  const k1 = Math.min(k + 1, n2 - 1);
  const at = (x: number, y: number, z: number) => arr[x + n0 * (y + n1 * z)];
  const c00 = at(i, j, k) * (1 - fa) + at(i1, j, k) * fa;
  const c10 = at(i, j1, k) * (1 - fa) + at(i1, j1, k) * fa;
  const c01 = at(i, j, k1) * (1 - fa) + at(i1, j, k1) * fa;
  const c11 = at(i, j1, k1) * (1 - fa) + at(i1, j1, k1) * fa;
  return (c00 * (1 - fb) + c10 * fb) * (1 - fc) + (c01 * (1 - fb) + c11 * fb) * fc;
}

/** Velocity (m/s) at a point given in cell units (x ∈ [0, nx] …). */
export function sampleVelocity(F: StreamField, x: number, y: number, z: number, out: number[]): void {
  const { nx, ny, nz } = F;
  out[0] = interp(F.u, nx + 1, ny, nz, x, y - 0.5, z - 0.5);
  out[1] = interp(F.v, nx, ny + 1, nz, x - 0.5, y, z - 0.5);
  out[2] = interp(F.w, nx, ny, nz + 1, x - 0.5, y - 0.5, z);
}

/** Pick k entries spread evenly over a list. */
function spread(list: number[], k: number): number[] {
  if (k <= 0 || !list.length) return [];
  if (list.length <= k) return [...list];
  const out: number[] = [];
  for (let m = 0; m < k; m++) out.push(list[Math.floor(((m + 0.5) * list.length) / k)]);
  return out;
}

/**
 * Trace up to `maxLines` streamlines with a fixed-step midpoint (RK2) integrator on the normalised
 * velocity direction (step 0.5 cell), seeded at inflow opening cells, fan cells and the hottest air cells
 * next to heat sources (traced both upstream and downstream). Lines stop in solids, at the domain
 * boundary, in stagnant air (< 0.1 % of the max speed) or after 4·(nx+ny+nz) steps.
 * Returns polylines in grid-frame mm.
 */
export function traceStreamlines(
  F: StreamField,
  seeds: { inflow: number[]; fans: number[]; hot: number[] },
  maxLines: number,
  maxVel: number,
): Vec3[][] {
  const { nx, ny, nz, h, origin } = F;
  const nFan = seeds.fans.length ? Math.min(seeds.fans.length, Math.round(maxLines * 0.2)) : 0;
  let nIn = seeds.inflow.length ? Math.min(seeds.inflow.length, Math.round(maxLines * 0.4)) : 0;
  let nHot = Math.min(seeds.hot.length, maxLines - nFan - nIn);
  if (nHot < maxLines - nFan - nIn) nIn = Math.min(seeds.inflow.length, maxLines - nFan - nHot);
  nHot = Math.min(seeds.hot.length, maxLines - nFan - nIn);
  const vmin = 1e-3 * maxVel;
  const maxSteps = 4 * (nx + ny + nz);
  const ds = 0.5;
  const v1 = [0, 0, 0];
  const v2 = [0, 0, 0];
  const toMm = (x: number, y: number, z: number): Vec3 => [origin[0] + x * h, origin[1] + y * h, origin[2] + z * h];
  const inSolid = (x: number, y: number, z: number) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const k = Math.floor(z);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return true;
    return F.solid(i + nx * (j + ny * k));
  };
  const trace = (cell: number, sign: number): Vec3[] => {
    let x = (cell % nx) + 0.5;
    let y = (Math.floor(cell / nx) % ny) + 0.5;
    let z = Math.floor(cell / (nx * ny)) + 0.5;
    const pts: Vec3[] = [toMm(x, y, z)];
    for (let s = 0; s < maxSteps; s++) {
      sampleVelocity(F, x, y, z, v1);
      const s1 = Math.hypot(v1[0], v1[1], v1[2]);
      if (!(s1 > vmin)) break;
      const xm = x + (0.5 * ds * sign * v1[0]) / s1;
      const ym = y + (0.5 * ds * sign * v1[1]) / s1;
      const zm = z + (0.5 * ds * sign * v1[2]) / s1;
      sampleVelocity(F, xm, ym, zm, v2);
      const s2 = Math.hypot(v2[0], v2[1], v2[2]);
      if (!(s2 > vmin)) break;
      const xn = x + (ds * sign * v2[0]) / s2;
      const yn = y + (ds * sign * v2[1]) / s2;
      const zn = z + (ds * sign * v2[2]) / s2;
      if (inSolid(xn, yn, zn)) {
        // clip the final segment to the domain box for a clean end at vents
        if (xn >= 0 && yn >= 0 && zn >= 0 && xn <= nx && yn <= ny && zn <= nz) break;
        pts.push(toMm(Math.min(Math.max(xn, 0), nx), Math.min(Math.max(yn, 0), ny), Math.min(Math.max(zn, 0), nz)));
        break;
      }
      x = xn;
      y = yn;
      z = zn;
      pts.push(toMm(x, y, z));
    }
    return pts;
  };
  const lines: Vec3[][] = [];
  for (const c of spread(seeds.inflow, nIn)) {
    const l = trace(c, 1);
    if (l.length >= 3) lines.push(l);
  }
  for (const c of spread(seeds.fans, nFan)) {
    const l = trace(c, 1);
    if (l.length >= 3) lines.push(l);
  }
  for (const c of spread(seeds.hot, nHot)) {
    const back = trace(c, -1).reverse();
    const fwd = trace(c, 1);
    const l = back.concat(fwd.slice(1));
    if (l.length >= 3) lines.push(l);
  }
  return lines;
}
