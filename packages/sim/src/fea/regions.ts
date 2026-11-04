import type { Vec3 } from '@pcbcad/core';
import type { Region } from './types';

/** Minimal grid description used by the region resolver (mm). */
export interface RegionGrid {
  nx: number;
  ny: number;
  nz: number;
  h: number;
  origin: Vec3;
  /** Per voxel: material index (> 0) of usable solid voxels, 0 otherwise. */
  solid: Uint8Array;
}

/**
 * Face direction codes used throughout the FEA module:
 * 0 = −x, 1 = +x, 2 = −y, 3 = +y, 4 = −z, 5 = +z.
 */
export const FACE_CORNER_MASK = [0x55, 0xaa, 0x33, 0xcc, 0x0f, 0xf0] as const;

/** Local corners (node numbers a = ix + 2·iy + 4·iz) of each face direction. */
export const FACE_CORNERS: ReadonlyArray<readonly number[]> = FACE_CORNER_MASK.map((m) => {
  const out: number[] = [];
  for (let a = 0; a < 8; a++) if (m & (1 << a)) out.push(a);
  return out;
});

/** A region resolved against a grid. */
export interface ResolvedRegion {
  /** Selected solid voxels (linear indices, ascending). */
  voxels: Int32Array;
  /** Per selected voxel: bit a set when local corner a belongs to the region's node set. */
  cornerMask: Uint8Array;
  /** Faces receiving pressure: voxel linear index and direction code (see FACE_CORNER_MASK). */
  faceVoxel: Int32Array;
  faceDir: Uint8Array;
  /** True when a fallback (intersection / inflated) selection had to be used. */
  usedFallback: boolean;
}

/** True when the neighbour of voxel (i,j,k) in direction `dir` is not a usable solid voxel. */
export function isExposed(g: RegionGrid, i: number, j: number, k: number, dir: number): boolean {
  const { nx, ny, nz, solid } = g;
  switch (dir) {
    case 0:
      return i === 0 || solid[i - 1 + nx * (j + ny * k)] === 0;
    case 1:
      return i === nx - 1 || solid[i + 1 + nx * (j + ny * k)] === 0;
    case 2:
      return j === 0 || solid[i + nx * (j - 1 + ny * k)] === 0;
    case 3:
      return j === ny - 1 || solid[i + nx * (j + 1 + ny * k)] === 0;
    case 4:
      return k === 0 || solid[i + nx * (j + ny * (k - 1))] === 0;
    default:
      return k === nz - 1 || solid[i + nx * (j + ny * (k + 1))] === 0;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Collect solid voxels in an index box whose centre satisfies `inside`. */
function scanBox(
  g: RegionGrid,
  i0: number,
  i1: number,
  j0: number,
  j1: number,
  k0: number,
  k1: number,
  inside: (x: number, y: number, z: number) => boolean,
): number[] {
  const out: number[] = [];
  const { nx, ny, nz, h, origin, solid } = g;
  i0 = clampInt(i0, 0, nx - 1);
  j0 = clampInt(j0, 0, ny - 1);
  k0 = clampInt(k0, 0, nz - 1);
  i1 = clampInt(i1, 0, nx - 1);
  j1 = clampInt(j1, 0, ny - 1);
  k1 = clampInt(k1, 0, nz - 1);
  for (let k = k0; k <= k1; k++) {
    const z = origin[2] + (k + 0.5) * h;
    for (let j = j0; j <= j1; j++) {
      const y = origin[1] + (j + 0.5) * h;
      const row = nx * (j + ny * k);
      for (let i = i0; i <= i1; i++) {
        if (solid[row + i] === 0) continue;
        if (inside(origin[0] + (i + 0.5) * h, y, z)) out.push(row + i);
      }
    }
  }
  return out;
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

/**
 * Resolve a region to solid voxels, node corners and pressure faces.
 * Throws for malformed regions (non-finite numbers, zero-length cylinder axis).
 */
export function resolveRegion(g: RegionGrid, region: Region): ResolvedRegion {
  const { nx, ny, nz, h, origin, solid } = g;
  let voxels: number[] = [];
  let usedFallback = false;
  const finite = (v: Vec3) => v.length === 3 && v.every((c) => Number.isFinite(c));

  if (region.kind === 'plane') {
    const ax = AXIS_INDEX[region.axis];
    if (ax === undefined) throw new Error(`plane region: invalid axis '${String(region.axis)}'`);
    const depth = region.depth != null && Number.isFinite(region.depth) && region.depth > 0 ? region.depth : h;
    const dims = [nx, ny, nz];
    // extreme layer index along the axis
    let ext = region.side === 'min' ? Infinity : -Infinity;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          if (solid[i + nx * (j + ny * k)] === 0) continue;
          const c = ax === 0 ? i : ax === 1 ? j : k;
          if (region.side === 'min' ? c < ext : c > ext) ext = c;
        }
    if (!Number.isFinite(ext)) return emptyRegion();
    const layers = Math.max(1, Math.ceil(depth / h - 1e-9));
    const lo = region.side === 'min' ? ext : Math.max(0, ext - layers + 1);
    const hi = region.side === 'min' ? Math.min(dims[ax] - 1, ext + layers - 1) : ext;
    const dir = ax * 2 + (region.side === 'min' ? 0 : 1);
    const vox: number[] = [];
    const masks: number[] = [];
    const fv: number[] = [];
    const fd: number[] = [];
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const idx = i + nx * (j + ny * k);
          if (solid[idx] === 0) continue;
          const c = ax === 0 ? i : ax === 1 ? j : k;
          if (c < lo || c > hi) continue;
          if (!isExposed(g, i, j, k, dir)) continue;
          vox.push(idx);
          masks.push(FACE_CORNER_MASK[dir]);
          fv.push(idx);
          fd.push(dir);
        }
    return {
      voxels: Int32Array.from(vox),
      cornerMask: Uint8Array.from(masks),
      faceVoxel: Int32Array.from(fv),
      faceDir: Uint8Array.from(fd),
      usedFallback: false,
    };
  }

  if (region.kind === 'box') {
    if (!finite(region.min) || !finite(region.max)) throw new Error('box region: min/max must be finite Vec3');
    const mn = [0, 1, 2].map((a) => Math.min(region.min[a], region.max[a]));
    const mx = [0, 1, 2].map((a) => Math.max(region.min[a], region.max[a]));
    const lo = (a: number) => Math.ceil((mn[a] - origin[a]) / h - 0.5 - 1e-9);
    const hi = (a: number) => Math.floor((mx[a] - origin[a]) / h - 0.5 + 1e-9);
    voxels = scanBox(g, lo(0), hi(0), lo(1), hi(1), lo(2), hi(2), (x, y, z) => {
      const e = 1e-9 * h;
      return x >= mn[0] - e && x <= mx[0] + e && y >= mn[1] - e && y <= mx[1] + e && z >= mn[2] - e && z <= mx[2] + e;
    });
    if (voxels.length === 0) {
      usedFallback = true;
      const flo = (a: number) => Math.ceil((mn[a] - origin[a]) / h - 1 - 1e-9);
      const fhi = (a: number) => Math.floor((mx[a] - origin[a]) / h + 1e-9);
      voxels = scanBox(g, flo(0), fhi(0), flo(1), fhi(1), flo(2), fhi(2), () => true);
    }
  } else if (region.kind === 'cylinder') {
    if (!finite(region.center) || !finite(region.axis)) throw new Error('cylinder region: center/axis must be finite Vec3');
    const al = Math.hypot(region.axis[0], region.axis[1], region.axis[2]);
    if (!(al > 0)) throw new Error('cylinder region: axis must be non-zero');
    if (!(region.radius > 0) || !(region.length > 0)) throw new Error('cylinder region: radius and length must be > 0');
    const a: Vec3 = [region.axis[0] / al, region.axis[1] / al, region.axis[2] / al];
    const c = region.center;
    const select = (r: number, halfL: number) => {
      const ext = halfL + r;
      const lo = (q: number) => Math.floor((c[q] - ext - origin[q]) / h);
      const hi = (q: number) => Math.ceil((c[q] + ext - origin[q]) / h);
      const r2 = r * r;
      return scanBox(g, lo(0), hi(0), lo(1), hi(1), lo(2), hi(2), (x, y, z) => {
        const dx = x - c[0];
        const dy = y - c[1];
        const dz = z - c[2];
        const t = dx * a[0] + dy * a[1] + dz * a[2];
        if (Math.abs(t) > halfL + 1e-9 * h) return false;
        return dx * dx + dy * dy + dz * dz - t * t <= r2 + 1e-9 * h * h;
      });
    };
    voxels = select(region.radius, region.length / 2);
    if (voxels.length === 0) {
      usedFallback = true;
      const pad = 0.5 * Math.sqrt(3) * h;
      voxels = select(region.radius + pad, region.length / 2 + pad);
    }
  } else if (region.kind === 'cells') {
    const n = nx * ny * nz;
    const seen = new Set<number>();
    const src = region.indices ?? [];
    for (let q = 0; q < src.length; q++) {
      const v = src[q];
      if (!Number.isInteger(v) || v < 0 || v >= n || solid[v] === 0 || seen.has(v)) continue;
      seen.add(v);
    }
    voxels = Array.from(seen).sort((x, y) => x - y);
  } else {
    throw new Error(`unknown region kind '${(region as { kind?: string }).kind}'`);
  }

  const sel = Int32Array.from(voxels);
  const cornerMask = new Uint8Array(sel.length).fill(0xff);
  const fv: number[] = [];
  const fd: number[] = [];
  for (const idx of sel) {
    const i = idx % nx;
    const j = Math.floor(idx / nx) % ny;
    const k = Math.floor(idx / (nx * ny));
    for (let dir = 0; dir < 6; dir++) {
      if (isExposed(g, i, j, k, dir)) {
        fv.push(idx);
        fd.push(dir);
      }
    }
  }
  return { voxels: sel, cornerMask, faceVoxel: Int32Array.from(fv), faceDir: Uint8Array.from(fd), usedFallback };
}

function emptyRegion(): ResolvedRegion {
  return {
    voxels: new Int32Array(0),
    cornerMask: new Uint8Array(0),
    faceVoxel: new Int32Array(0),
    faceDir: new Uint8Array(0),
    usedFallback: false,
  };
}

/** Short human-readable description of a region, for messages. */
export function describeRegion(r: Region): string {
  const f = (v: Vec3) => `[${v.map((c) => +c.toFixed(3)).join(', ')}]`;
  switch (r.kind) {
    case 'box':
      return `box ${f(r.min)}–${f(r.max)}`;
    case 'plane':
      return `plane ${r.axis}-${r.side}${r.depth != null ? ` (depth ${r.depth} mm)` : ''}`;
    case 'cylinder':
      return `cylinder c=${f(r.center)} axis=${f(r.axis)} r=${r.radius} L=${r.length}`;
    case 'cells':
      return `cells (${r.indices?.length ?? 0} indices)`;
    default:
      return 'region';
  }
}
