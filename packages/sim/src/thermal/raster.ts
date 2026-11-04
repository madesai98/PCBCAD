import type { BBox2, Grid2, Vec2 } from '@pcbcad/core';

/**
 * Coverage rasterisation on a uniform cell grid.
 *
 * Shapes are converted to horizontal spans on `sub` sample rows per cell row (sample row r at
 * y = y0 + (r + ½)·dy/sub). Within a sample row the covered x-intervals of all shapes are merged
 * (union, so overlapping pads/traces/pours are never double counted) and integrated EXACTLY in x
 * over each cell. The coverage fraction of a cell is the mean over its sample rows, so x-errors
 * are zero and y-errors are bounded by one sample-row height (dy/sub) per shape edge.
 */

/** Uniform grid covering a bbox with cells of approximately `res` mm (exactly tiling the bbox). */
export function makeGrid(bbox: BBox2, res: number): Grid2 {
  const W = Math.max(bbox.maxX - bbox.minX, 1e-6);
  const H = Math.max(bbox.maxY - bbox.minY, 1e-6);
  const nx = Math.max(1, Math.ceil(W / res - 1e-9));
  const ny = Math.max(1, Math.ceil(H / res - 1e-9));
  return { nx, ny, x0: bbox.minX, y0: bbox.minY, dx: W / nx, dy: H / ny };
}

/** Grid for a rectangular window [i0, i0+ni) × [j0, j0+nj) of `g` (same cell size). */
export function windowGrid(g: Grid2, i0: number, j0: number, ni: number, nj: number): Grid2 {
  return { nx: ni, ny: nj, x0: g.x0 + i0 * g.dx, y0: g.y0 + j0 * g.dy, dx: g.dx, dy: g.dy };
}

/**
 * Even-odd crossings of polygon rings with horizontal sample lines y_r = y0 + (r + ½)·h,
 * r ∈ [0, nrows). Half-open rule [ymin, ymax) per edge, so shared vertices count once.
 * Returns the first row index and per-row sorted crossing lists.
 */
export function ringCrossings(rings: readonly (readonly Vec2[])[], y0: number, h: number, nrows: number): { rLo: number; rows: number[][] } {
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    for (const p of ring) {
      if (p[1] < ymin) ymin = p[1];
      if (p[1] > ymax) ymax = p[1];
    }
  }
  if (!(ymax > ymin)) return { rLo: 0, rows: [] };
  const rLo = Math.max(0, Math.ceil((ymin - y0) / h - 0.5));
  const rHi = Math.min(nrows - 1, Math.ceil((ymax - y0) / h - 0.5) - 1);
  if (rHi < rLo) return { rLo: 0, rows: [] };
  const rows: number[][] = new Array(rHi - rLo + 1);
  for (let k = 0; k < rows.length; k++) rows[k] = [];
  for (const ring of rings) {
    const n = ring.length;
    if (n < 3) continue;
    for (let a = 0, b = n - 1; a < n; b = a++) {
      const x1 = ring[b][0];
      const y1 = ring[b][1];
      const x2 = ring[a][0];
      const y2 = ring[a][1];
      if (y1 === y2) continue;
      const lo = y1 < y2 ? y1 : y2;
      const hi = y1 < y2 ? y2 : y1;
      const ra = Math.max(rLo, Math.ceil((lo - y0) / h - 0.5));
      const rb = Math.min(rHi, Math.ceil((hi - y0) / h - 0.5) - 1);
      const slope = (x2 - x1) / (y2 - y1);
      for (let r = ra; r <= rb; r++) {
        const yc = y0 + (r + 0.5) * h;
        rows[r - rLo].push(x1 + (yc - y1) * slope);
      }
    }
  }
  for (const row of rows) if (row.length > 1) row.sort((p, q) => p - q);
  return { rLo, rows };
}

/** Union-coverage rasteriser (see module doc). */
export class CoverageRaster {
  private readonly rows: number[][];
  private readonly h: number;

  /**
   * @param grid target grid
   * @param sub  sample rows per cell row (≥ 1)
   */
  constructor(
    readonly grid: Grid2,
    readonly sub: number,
  ) {
    this.sub = Math.max(1, Math.round(sub));
    this.h = grid.dy / this.sub;
    this.rows = new Array(grid.ny * this.sub);
    for (let r = 0; r < this.rows.length; r++) this.rows[r] = [];
  }

  /** True when nothing has been added. */
  get empty(): boolean {
    for (const r of this.rows) if (r.length) return false;
    return true;
  }

  /** Sample-row index range [lo, hi] whose sample line lies within the closed interval [ymin, ymax]. */
  private rowRange(ymin: number, ymax: number): [number, number] {
    const { y0 } = this.grid;
    const lo = Math.max(0, Math.ceil((ymin - y0) / this.h - 0.5));
    const hi = Math.min(this.rows.length - 1, Math.floor((ymax - y0) / this.h - 0.5));
    return [lo, hi];
  }

  private rowY(r: number): number {
    return this.grid.y0 + (r + 0.5) * this.h;
  }

  /** Even-odd filled polygon (outer rings and holes as separate rings). */
  addPolygon(rings: readonly (readonly Vec2[])[]): void {
    const { rLo, rows } = ringCrossings(rings, this.grid.y0, this.h, this.rows.length);
    for (let k = 0; k < rows.length; k++) {
      const c = rows[k];
      if (c.length < 2) continue;
      const dst = this.rows[rLo + k];
      for (let i = 0; i + 1 < c.length; i += 2) if (c[i + 1] > c[i]) dst.push(c[i], c[i + 1]);
    }
  }

  /** Filled disc. */
  addDisc(cx: number, cy: number, r: number): void {
    if (!(r > 0)) return;
    const [lo, hi] = this.rowRange(cy - r, cy + r);
    for (let k = lo; k <= hi; k++) {
      const dyc = this.rowY(k) - cy;
      const hw = Math.sqrt(Math.max(0, r * r - dyc * dyc));
      if (hw > 0) this.rows[k].push(cx - hw, cx + hw);
    }
  }

  /** Capsule (stadium): all points within distance r of segment a–b (a trace segment of width 2r). */
  addCapsule(ax: number, ay: number, bx: number, by: number, r: number): void {
    if (!(r > 0)) return;
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-9) {
      this.addDisc(ax, ay, r);
      return;
    }
    const ux = (bx - ax) / L;
    const uy = (by - ay) / L;
    const [lo, hi] = this.rowRange(Math.min(ay, by) - r, Math.max(ay, by) + r);
    const EPS = 1e-12;
    for (let k = lo; k <= hi; k++) {
      const yc = this.rowY(k);
      let xl = Infinity;
      let xr = -Infinity;
      // end discs
      for (const [cx, cy] of [
        [ax, ay],
        [bx, by],
      ]) {
        const d = yc - cy;
        if (Math.abs(d) <= r) {
          const hw = Math.sqrt(r * r - d * d);
          if (cx - hw < xl) xl = cx - hw;
          if (cx + hw > xr) xr = cx + hw;
        }
      }
      // rectangle body: s = (p−a)·u ∈ [0, L], q = (p−a)·n ∈ [−r, r], n = (−uy, ux)
      let lo1 = -Infinity;
      let hi1 = Infinity;
      const cs = -ax * ux + (yc - ay) * uy; // s = ux·x + cs
      if (Math.abs(ux) > EPS) {
        const p1 = -cs / ux;
        const p2 = (L - cs) / ux;
        lo1 = Math.min(p1, p2);
        hi1 = Math.max(p1, p2);
      } else if (cs < 0 || cs > L) {
        lo1 = Infinity;
        hi1 = -Infinity;
      }
      let lo2 = -Infinity;
      let hi2 = Infinity;
      const cq = ax * uy + (yc - ay) * ux; // q = −uy·x + cq
      if (Math.abs(uy) > EPS) {
        const p1 = (cq + r) / uy;
        const p2 = (cq - r) / uy;
        lo2 = Math.min(p1, p2);
        hi2 = Math.max(p1, p2);
      } else if (Math.abs(cq) > r) {
        lo2 = Infinity;
        hi2 = -Infinity;
      }
      const rl = Math.max(lo1, lo2);
      const rr = Math.min(hi1, hi2);
      if (rr > rl) {
        if (rl < xl) xl = rl;
        if (rr > xr) xr = rr;
      }
      if (xr > xl) this.rows[k].push(xl, xr);
    }
  }

  /**
   * Coverage fraction (0..1) per cell, row-major (j*nx + i). With `out` given, the fractions are
   * written into it (overwriting).
   */
  finish(out?: Float64Array): Float64Array {
    const { nx, ny, x0, dx } = this.grid;
    const res = out ?? new Float64Array(nx * ny);
    if (out) res.fill(0);
    const w = 1 / this.sub;
    const idx: number[] = [];
    for (let r = 0; r < this.rows.length; r++) {
      const s = this.rows[r];
      if (!s.length) continue;
      const rowBase = Math.floor(r / this.sub) * nx;
      let spans = s;
      if (s.length > 2) {
        // sort pairs by start and merge overlaps
        const npairs = s.length / 2;
        idx.length = npairs;
        for (let p = 0; p < npairs; p++) idx[p] = p;
        idx.sort((p, q) => s[2 * p] - s[2 * q]);
        const merged: number[] = [];
        let ca = s[2 * idx[0]];
        let cb = s[2 * idx[0] + 1];
        for (let p = 1; p < npairs; p++) {
          const a = s[2 * idx[p]];
          const b = s[2 * idx[p] + 1];
          if (a <= cb) {
            if (b > cb) cb = b;
          } else {
            merged.push(ca, cb);
            ca = a;
            cb = b;
          }
        }
        merged.push(ca, cb);
        spans = merged;
      }
      for (let p = 0; p < spans.length; p += 2) {
        let ua = (spans[p] - x0) / dx;
        let ub = (spans[p + 1] - x0) / dx;
        if (ua < 0) ua = 0;
        if (ub > nx) ub = nx;
        if (!(ub > ua)) continue;
        const ia = Math.floor(ua);
        const ib = Math.min(nx - 1, Math.ceil(ub) - 1);
        for (let i = ia; i <= ib; i++) {
          const ov = Math.min(ub, i + 1) - Math.max(ua, i);
          if (ov > 0) res[rowBase + i] += ov * w;
        }
      }
    }
    for (let i = 0; i < res.length; i++) if (res[i] > 1) res[i] = 1;
    return res;
  }
}

/**
 * Binary mask by cell-centre sampling: 1 where the centre lies inside the even-odd region of
 * `rings` (outline + cutouts) and outside every disc in `holes`.
 */
export function centreMask(grid: Grid2, rings: readonly (readonly Vec2[])[], holes: readonly { x: number; y: number; r: number }[] = []): Uint8Array {
  const { nx, ny, x0, y0, dx, dy } = grid;
  const mask = new Uint8Array(nx * ny);
  const { rLo, rows } = ringCrossings(rings, y0, dy, ny);
  for (let k = 0; k < rows.length; k++) {
    const c = rows[k];
    const j = rLo + k;
    for (let p = 0; p + 1 < c.length; p += 2) {
      // cells whose centre x_c = x0 + (i+½)dx ∈ [c[p], c[p+1])
      const ia = Math.max(0, Math.ceil((c[p] - x0) / dx - 0.5));
      const ib = Math.min(nx - 1, Math.ceil((c[p + 1] - x0) / dx - 0.5) - 1);
      for (let i = ia; i <= ib; i++) mask[j * nx + i] = 1;
    }
  }
  for (const h of holes) {
    if (!(h.r > 0)) continue;
    const ia = Math.max(0, Math.ceil((h.x - h.r - x0) / dx - 0.5));
    const ib = Math.min(nx - 1, Math.floor((h.x + h.r - x0) / dx - 0.5));
    const ja = Math.max(0, Math.ceil((h.y - h.r - y0) / dy - 0.5));
    const jb = Math.min(ny - 1, Math.floor((h.y + h.r - y0) / dy - 0.5));
    for (let j = ja; j <= jb; j++)
      for (let i = ia; i <= ib; i++) {
        const xc = x0 + (i + 0.5) * dx - h.x;
        const yc = y0 + (j + 0.5) * dy - h.y;
        if (xc * xc + yc * yc < h.r * h.r) mask[j * nx + i] = 0;
      }
  }
  return mask;
}
