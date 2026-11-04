/**
 * Uniform-grid spatial index over axis-aligned bounding boxes (ids are small non-negative integers).
 * Items outside the indexed extent are clamped into the border buckets, so queries stay correct.
 */
import type { BBox2 } from '@pcbcad/core';

export class GridIndex {
  private readonly minX: number;
  private readonly minY: number;
  private readonly inv: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly cells: (number[] | undefined)[];
  private stamp: Uint32Array;
  private cur = 0;

  /**
   * @param extent region that will contain most items (mm)
   * @param cellSize bucket size (mm); clamped so the grid has at most ~1M buckets
   */
  constructor(extent: BBox2, cellSize: number, capacityHint = 64) {
    const w = Math.max(1e-6, extent.maxX - extent.minX);
    const h = Math.max(1e-6, extent.maxY - extent.minY);
    let cs = Math.max(cellSize, 1e-3);
    while ((w / cs) * (h / cs) > 1_000_000) cs *= 2;
    this.minX = extent.minX;
    this.minY = extent.minY;
    this.inv = 1 / cs;
    this.nx = Math.max(1, Math.ceil(w / cs) + 1);
    this.ny = Math.max(1, Math.ceil(h / cs) + 1);
    this.cells = new Array(this.nx * this.ny);
    this.stamp = new Uint32Array(Math.max(16, capacityHint));
  }

  private ix(x: number): number {
    const i = Math.floor((x - this.minX) * this.inv);
    return i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
  }

  private iy(y: number): number {
    const j = Math.floor((y - this.minY) * this.inv);
    return j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j;
  }

  insert(id: number, bb: BBox2): void {
    if (id >= this.stamp.length) {
      const s = new Uint32Array(Math.max(id + 1, this.stamp.length * 2));
      s.set(this.stamp);
      this.stamp = s;
    }
    const i0 = this.ix(bb.minX);
    const i1 = this.ix(bb.maxX);
    const j0 = this.iy(bb.minY);
    const j1 = this.iy(bb.maxY);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.nx + i;
        const c = this.cells[k];
        if (c) c.push(id);
        else this.cells[k] = [id];
      }
    }
  }

  remove(id: number, bb: BBox2): void {
    const i0 = this.ix(bb.minX);
    const i1 = this.ix(bb.maxX);
    const j0 = this.iy(bb.minY);
    const j1 = this.iy(bb.maxY);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = this.cells[j * this.nx + i];
        if (!c) continue;
        const at = c.lastIndexOf(id);
        if (at >= 0) {
          c[at] = c[c.length - 1];
          c.pop();
        }
      }
    }
  }

  /** Unique ids whose buckets intersect `bb` (a superset of the true overlaps). */
  query(bb: BBox2, out: number[] = []): number[] {
    out.length = 0;
    this.cur++;
    if (this.cur === 0xffffffff) {
      this.stamp.fill(0);
      this.cur = 1;
    }
    const cur = this.cur;
    const stamp = this.stamp;
    const i0 = this.ix(bb.minX);
    const i1 = this.ix(bb.maxX);
    const j0 = this.iy(bb.minY);
    const j1 = this.iy(bb.maxY);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = this.cells[j * this.nx + i];
        if (!c) continue;
        for (let k = 0; k < c.length; k++) {
          const id = c[k];
          if (stamp[id] !== cur) {
            stamp[id] = cur;
            out.push(id);
          }
        }
      }
    }
    return out;
  }
}

/** Disjoint-set forest with path halving and union by size. */
export class UnionFind {
  private readonly parent: Int32Array;
  private readonly size: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.size = new Int32Array(n).fill(1);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(a: number): number {
    const p = this.parent;
    while (p[a] !== a) {
      p[a] = p[p[a]];
      a = p[a];
    }
    return a;
  }
  union(a: number, b: number): boolean {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    if (this.size[ra] < this.size[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
    return true;
  }
}
