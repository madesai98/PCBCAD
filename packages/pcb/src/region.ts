/**
 * Filled polygon regions with holes (zone fill islands). A zone's `fill` is stored as a flat list of
 * rings with even-odd semantics; {@link regionsFromRings} regroups them into islands (outer ring + its
 * holes) by nesting depth, so it works regardless of ring orientation.
 */
import type { BBox2, Vec2 } from '@pcbcad/core';
import { CLOSEST, bboxOf, bbOverlaps, pointInRing, primCoreDist, ringArea, segSegDist, type Prim } from './geom';
import { GridIndex } from './spatial';

export class Region {
  /** rings[0] = outer boundary, rings[1..] = holes. */
  readonly rings: Vec2[][];
  readonly bb: BBox2;
  private edges: Float64Array | null = null;
  private index: GridIndex | null = null;
  private readonly tmp: number[] = [];

  constructor(rings: Vec2[][]) {
    this.rings = rings;
    this.bb = bboxOf(rings[0]);
  }

  /** Area (mm²) = outer − holes. */
  area(): number {
    let a = Math.abs(ringArea(this.rings[0]));
    for (let i = 1; i < this.rings.length; i++) a -= Math.abs(ringArea(this.rings[i]));
    return a;
  }

  /** True when the point lies in the filled area. */
  contains(x: number, y: number): boolean {
    if (x < this.bb.minX || x > this.bb.maxX || y < this.bb.minY || y > this.bb.maxY) return false;
    let inside = false;
    for (const r of this.rings) if (pointInRing(x, y, r)) inside = !inside;
    return inside;
  }

  private build(): void {
    let n = 0;
    for (const r of this.rings) n += r.length;
    const e = new Float64Array(n * 4);
    let k = 0;
    for (const r of this.rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        e[k++] = r[j][0];
        e[k++] = r[j][1];
        e[k++] = r[i][0];
        e[k++] = r[i][1];
      }
    }
    this.edges = e;
    if (n > 48) {
      const w = this.bb.maxX - this.bb.minX;
      const h = this.bb.maxY - this.bb.minY;
      const cell = Math.max(0.25, Math.sqrt((w * h) / n) * 2);
      const idx = new GridIndex(this.bb, cell, n);
      for (let i = 0; i < n; i++) {
        const ax = e[i * 4];
        const ay = e[i * 4 + 1];
        const bx = e[i * 4 + 2];
        const by = e[i * 4 + 3];
        idx.insert(i, { minX: Math.min(ax, bx), minY: Math.min(ay, by), maxX: Math.max(ax, bx), maxY: Math.max(ay, by) });
      }
      this.index = idx;
    }
  }

  /**
   * Copper gap between this region and a prim (≤ 0 = touching/overlapping), or Infinity when the gap is
   * larger than `maxGap`. `at` receives the closest-approach location.
   */
  gapTo(p: Prim, maxGap: number, at?: Vec2): number {
    if (!bbOverlaps(this.bb, p.bb, maxGap)) return Infinity;
    const p0 = p.pts[0];
    if (this.contains(p0[0], p0[1])) {
      if (at) {
        at[0] = p0[0];
        at[1] = p0[1];
      }
      return -p.r;
    }
    if (!this.edges) this.build();
    const e = this.edges!;
    const lim = maxGap + p.r;
    const q = { minX: p.bb.minX - maxGap, minY: p.bb.minY - maxGap, maxX: p.bb.maxX + maxGap, maxY: p.bb.maxY + maxGap };
    let best = Infinity;
    const test = (i: number) => {
      const ax = e[i * 4];
      const ay = e[i * 4 + 1];
      const bx = e[i * 4 + 2];
      const by = e[i * 4 + 3];
      if (Math.max(ax, bx) < q.minX || Math.min(ax, bx) > q.maxX || Math.max(ay, by) < q.minY || Math.min(ay, by) > q.maxY) return;
      let d: number;
      if (p.pts.length === 2) {
        d = segSegDist(ax, ay, bx, by, p.pts[0][0], p.pts[0][1], p.pts[1][0], p.pts[1][1]);
        if (d < best && at) {
          at[0] = (CLOSEST[0] + CLOSEST[2]) / 2;
          at[1] = (CLOSEST[1] + CLOSEST[3]) / 2;
        }
      } else {
        d = primCoreDist({ pts: [[ax, ay], [bx, by]], r: 0, bb: q }, p);
        if (d < best && at) {
          at[0] = (ax + bx) / 2;
          at[1] = (ay + by) / 2;
        }
      }
      if (d < best) best = d;
    };
    if (this.index) {
      const ids = this.index.query(q, this.tmp);
      for (let k = 0; k < ids.length && best > 0; k++) test(ids[k]);
    } else {
      const n = e.length / 4;
      for (let i = 0; i < n && best > 0; i++) test(i);
    }
    if (best > lim) return Infinity;
    return best - p.r;
  }

  /** Gap between two regions (≤ 0 = overlap), Infinity if larger than maxGap. */
  gapToRegion(o: Region, maxGap: number, at?: Vec2): number {
    if (!bbOverlaps(this.bb, o.bb, maxGap)) return Infinity;
    const a0 = this.rings[0][0];
    if (o.contains(a0[0], a0[1])) {
      if (at) {
        at[0] = a0[0];
        at[1] = a0[1];
      }
      return 0;
    }
    const b0 = o.rings[0][0];
    if (this.contains(b0[0], b0[1])) {
      if (at) {
        at[0] = b0[0];
        at[1] = b0[1];
      }
      return 0;
    }
    let best = Infinity;
    for (const ring of this.rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const seg: Prim = { pts: [ring[j], ring[i]], r: 0, bb: bboxOf([ring[j], ring[i]]) };
        const g = o.gapTo(seg, Math.min(maxGap, best), at);
        if (g < best) best = g;
        if (best <= 0) return best;
      }
    }
    return best;
  }
}

/** Group even-odd rings into islands (outer + holes) using nesting depth. */
export function regionsFromRings(rings: Vec2[][] | undefined): Region[] {
  if (!rings || rings.length === 0) return [];
  const valid = rings.filter((r) => r && r.length >= 3);
  const n = valid.length;
  const bbs = valid.map((r) => bboxOf(r));
  const areas = valid.map((r) => Math.abs(ringArea(r)));
  const depth = new Array<number>(n).fill(0);
  const parent = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = valid[i][0];
    let bestParent = -1;
    for (let j = 0; j < n; j++) {
      if (i === j || areas[j] <= areas[i]) continue;
      const b = bbs[j];
      if (p[0] < b.minX || p[0] > b.maxX || p[1] < b.minY || p[1] > b.maxY) continue;
      if (pointInRing(p[0], p[1], valid[j])) {
        depth[i]++;
        if (bestParent < 0 || areas[j] < areas[bestParent]) bestParent = j;
      }
    }
    parent[i] = bestParent;
  }
  const out: Region[] = [];
  const holesOf = new Map<number, Vec2[][]>();
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 === 1 && parent[i] >= 0) {
      const list = holesOf.get(parent[i]) ?? [];
      list.push(valid[i]);
      holesOf.set(parent[i], list);
    }
  }
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 === 0) out.push(new Region([valid[i], ...(holesOf.get(i) ?? [])]));
  }
  return out;
}
