import type { BBox2, Grid2, PlacedPad, Vec2 } from '@pcbcad/core';

/**
 * Coverage rasterisation on a uniform cell grid.
 *
 * Shapes are converted to horizontal spans on `sub` sample rows (bands) per cell row (band r
 * spans y ∈ [y0 + r·h, y0 + (r+1)·h], h = dy/sub). Within a band the covered x-intervals of all
 * shapes are merged (union, so overlapping pads/traces/pours are never double counted) and
 * integrated EXACTLY in x over each cell; a cell's coverage is the mean over its bands.
 *  - General polygons, discs and oblique capsules are point-sampled at the band centre line:
 *    x is exact, y-errors are bounded by one band height per shape edge (unbiased).
 *  - Axis-aligned rectangles (rect / roundrect / oval pads at 0/90/180/270°, horizontal and
 *    vertical trace bodies) are integrated exactly over the band height ("weighted spans"),
 *    so the most common PCB shapes are rasterised exactly in both directions. Where weighted
 *    spans overlap each other the union is approximated by their maximum.
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
  /** Full-band spans per band: flat [xa, xb, ...]. */
  private readonly rows: number[][];
  /** Partial-band spans per band: flat [xa, xb, w, ...] with w ∈ (0,1) the covered band fraction. */
  private readonly wrows: (number[] | undefined)[];
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
    this.wrows = new Array(this.rows.length);
  }

  /** True when nothing has been added. */
  get empty(): boolean {
    for (const r of this.rows) if (r.length) return false;
    for (const r of this.wrows) if (r?.length) return false;
    return true;
  }

  /** Axis-aligned rectangle [xa, xb] × [ya, yb], integrated exactly over each band's height. */
  addRect(xa: number, ya: number, xb: number, yb: number): void {
    if (xb < xa) [xa, xb] = [xb, xa];
    if (yb < ya) [ya, yb] = [yb, ya];
    if (!(xb > xa && yb > ya)) return;
    const { y0 } = this.grid;
    const h = this.h;
    const lo = Math.max(0, Math.floor((ya - y0) / h));
    const hi = Math.min(this.rows.length - 1, Math.ceil((yb - y0) / h) - 1);
    for (let r = lo; r <= hi; r++) {
      const b0 = y0 + r * h;
      const f = (Math.min(yb, b0 + h) - Math.max(ya, b0)) / h;
      if (f >= 1 - 1e-9) this.rows[r].push(xa, xb);
      else if (f > 1e-12) {
        let w = this.wrows[r];
        if (!w) this.wrows[r] = w = [];
        w.push(xa, xb, f);
      }
    }
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
    if (Math.abs(ay - by) < 1e-12 || Math.abs(ax - bx) < 1e-12) {
      // orthogonal segment: exact rectangle body + round end caps
      if (Math.abs(ay - by) < 1e-12) this.addRect(Math.min(ax, bx), ay - r, Math.max(ax, bx), ay + r);
      else this.addRect(ax - r, Math.min(ay, by), ax + r, Math.max(ay, by));
      this.addDisc(ax, ay, r);
      this.addDisc(bx, by, r);
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
    const acc = (rowBase: number, xa: number, xb: number, weight: number) => {
      let ua = (xa - x0) / dx;
      let ub = (xb - x0) / dx;
      if (ua < 0) ua = 0;
      if (ub > nx) ub = nx;
      if (!(ub > ua)) return;
      const ia = Math.floor(ua);
      const ib = Math.min(nx - 1, Math.ceil(ub) - 1);
      for (let i = ia; i <= ib; i++) {
        const ov = Math.min(ub, i + 1) - Math.max(ua, i);
        if (ov > 0) res[rowBase + i] += ov * weight;
      }
    };
    for (let r = 0; r < this.rows.length; r++) {
      const s = this.rows[r];
      const ws = this.wrows[r];
      if (!s.length && !ws?.length) continue;
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
      for (let p = 0; p < spans.length; p += 2) acc(rowBase, spans[p], spans[p + 1], w);
      if (ws?.length) for (const [xa, xb, f] of partialEnvelope(ws, spans)) acc(rowBase, xa, xb, f * w);
    }
    for (let i = 0; i < res.length; i++) if (res[i] > 1) res[i] = 1;
    return res;
  }
}

/** If `ring` is an axis-aligned rectangle, its [minX, minY, maxX, maxY]; else undefined. */
export function axisAlignedRect(ring: readonly Vec2[]): [number, number, number, number] | undefined {
  let pts = ring;
  if (pts.length === 5 && pts[0][0] === pts[4][0] && pts[0][1] === pts[4][1]) pts = pts.slice(0, 4);
  if (pts.length !== 4) return undefined;
  const tol = 1e-9;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    if (Math.abs(a[0] - b[0]) > tol && Math.abs(a[1] - b[1]) > tol) return undefined;
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : undefined;
}

/** Add a single-ring polygon, using the exact rectangle primitive when it is axis aligned. */
export function addRing(r: CoverageRaster, ring: readonly Vec2[]): void {
  const rect = axisAlignedRect(ring);
  if (rect) r.addRect(rect[0], rect[1], rect[2], rect[3]);
  else r.addPolygon([ring]);
}

/**
 * Add a placed pad's copper. rect / roundrect / oval pads at multiples of 90° and circles are
 * built from exact rectangles + discs; anything else uses the pad polygon.
 */
export function addPadShape(r: CoverageRaster, pp: PlacedPad): void {
  const shape = pp.pad.shape;
  if (shape === 'circle') {
    r.addDisc(pp.x, pp.y, pp.w / 2);
    return;
  }
  const rot = (((pp.rotation || 0) % 360) + 360) % 360;
  const k = Math.round(rot / 90);
  if ((shape === 'rect' || shape === 'roundrect' || shape === 'oval') && Math.abs(rot - k * 90) < 1e-6) {
    const swap = k % 2 === 1;
    const w = swap ? pp.h : pp.w;
    const h = swap ? pp.w : pp.h;
    const x0 = pp.x - w / 2;
    const x1 = pp.x + w / 2;
    const y0 = pp.y - h / 2;
    const y1 = pp.y + h / 2;
    let rad = shape === 'rect' ? 0 : shape === 'oval' ? Math.min(w, h) / 2 : (pp.pad.roundness ?? 0.25) * Math.min(w, h);
    rad = Math.min(rad, w / 2, h / 2);
    if (rad <= 1e-9) {
      r.addRect(x0, y0, x1, y1);
      return;
    }
    r.addRect(x0, y0 + rad, x1, y1 - rad);
    r.addRect(x0 + rad, y0, x1 - rad, y1);
    r.addDisc(x0 + rad, y0 + rad, rad);
    r.addDisc(x1 - rad, y0 + rad, rad);
    r.addDisc(x0 + rad, y1 - rad, rad);
    r.addDisc(x1 - rad, y1 - rad, rad);
    return;
  }
  r.addPolygon([pp.polygon]);
}

/**
 * Upper envelope (max weight) of partial-band spans `ws` (flat [xa, xb, w, ...]) minus the
 * full-band spans `full` (sorted, disjoint, flat [xa, xb, ...]) of the same band.
 */
function partialEnvelope(ws: number[], full: number[]): [number, number, number][] {
  const xs: number[] = [];
  for (let p = 0; p < ws.length; p += 3) xs.push(ws[p], ws[p + 1]);
  xs.sort((a, b) => a - b);
  const out: [number, number, number][] = [];
  for (let k = 0; k + 1 < xs.length; k++) {
    const a = xs[k];
    const b = xs[k + 1];
    if (!(b > a)) continue;
    const mid = 0.5 * (a + b);
    let wmax = 0;
    for (let p = 0; p < ws.length; p += 3) if (ws[p] <= mid && ws[p + 1] >= mid && ws[p + 2] > wmax) wmax = ws[p + 2];
    if (wmax <= 0) continue;
    // subtract full-band spans from [a, b]
    let cur = a;
    for (let q = 0; q < full.length && cur < b; q += 2) {
      const fa = full[q];
      const fb = full[q + 1];
      if (fb <= cur) continue;
      if (fa >= b) break;
      if (fa > cur) out.push([cur, fa, wmax]);
      cur = Math.max(cur, fb);
    }
    if (cur < b) out.push([cur, b, wmax]);
  }
  return out;
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
