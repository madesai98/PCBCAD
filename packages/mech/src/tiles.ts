/**
 * Exact union of non-overlapping polygon tiles that share edges (possibly partially, i.e. with
 * T-junctions). Used for sheet-metal faces (rectangle minus notches) and flat patterns (faces +
 * bend strips). Algorithm: weld vertices, split edges at T-junctions, cancel opposite half-edges,
 * chain the remaining boundary edges into loops (leftmost turn at pinch vertices).
 */
import type { Vec2 } from '@pcbcad/core';
import { polyArea, simplifyCollinear } from './poly';

export interface TileUnion {
  /** CCW outer loops, largest first. */
  outer: Vec2[][];
  /** CW inner loops (voids). */
  holes: Vec2[][];
}

export function unionTiles(polys: Vec2[][], tol = 1e-6): TileUnion {
  // 1. weld vertices
  const pts: Vec2[] = [];
  const grid = new Map<string, number[]>();
  const cell = tol * 4;
  const keyOf = (ix: number, iy: number) => `${ix},${iy}`;
  const weld = (p: Vec2): number => {
    const ix = Math.floor(p[0] / cell);
    const iy = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get(keyOf(ix + dx, iy + dy));
        if (!list) continue;
        for (const id of list) if (Math.abs(pts[id][0] - p[0]) <= tol && Math.abs(pts[id][1] - p[1]) <= tol) return id;
      }
    const id = pts.length;
    pts.push([p[0], p[1]]);
    const k = keyOf(ix, iy);
    const l = grid.get(k);
    if (l) l.push(id);
    else grid.set(k, [id]);
    return id;
  };

  const edges: [number, number][] = [];
  for (const raw of polys) {
    if (raw.length < 3) continue;
    const area = polyArea(raw);
    if (Math.abs(area) < tol * tol) continue;
    const poly = area < 0 ? [...raw].reverse() : raw;
    const ids = poly.map(weld);
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % ids.length];
      if (a !== b) edges.push([a, b]);
    }
  }

  // 2. split at T-junctions (brute force: tile counts are small)
  const split: [number, number][] = [];
  for (const [a, b] of edges) {
    const A = pts[a];
    const B = pts[b];
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const L2 = dx * dx + dy * dy;
    const L = Math.sqrt(L2);
    const minX = Math.min(A[0], B[0]) - tol;
    const maxX = Math.max(A[0], B[0]) + tol;
    const minY = Math.min(A[1], B[1]) - tol;
    const maxY = Math.max(A[1], B[1]) + tol;
    const on: [number, number][] = [];
    for (let v = 0; v < pts.length; v++) {
      if (v === a || v === b) continue;
      const P = pts[v];
      if (P[0] < minX || P[0] > maxX || P[1] < minY || P[1] > maxY) continue;
      const t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2;
      if (t <= 1e-12 || t >= 1 - 1e-12) continue;
      const dist = Math.abs((P[0] - A[0]) * dy - (P[1] - A[1]) * dx) / L;
      if (dist <= tol) on.push([t, v]);
    }
    if (!on.length) {
      split.push([a, b]);
      continue;
    }
    on.sort((p, q) => p[0] - q[0]);
    let prev = a;
    for (const [, v] of on) {
      if (v !== prev) split.push([prev, v]);
      prev = v;
    }
    if (prev !== b) split.push([prev, b]);
  }

  // 3. cancel opposite half-edges
  const count = new Map<string, number>();
  for (const [a, b] of split) {
    const rev = `${b}>${a}`;
    const c = count.get(rev) ?? 0;
    if (c > 0) count.set(rev, c - 1);
    else count.set(`${a}>${b}`, (count.get(`${a}>${b}`) ?? 0) + 1);
  }
  const out = new Map<number, number[]>();
  let remaining = 0;
  for (const [k, c] of count) {
    if (c <= 0) continue;
    const [a, b] = k.split('>').map(Number);
    for (let i = 0; i < c; i++) {
      const l = out.get(a);
      if (l) l.push(b);
      else out.set(a, [b]);
      remaining++;
    }
  }

  // 4. chain into loops
  const loops: Vec2[][] = [];
  const takeEdge = (a: number, b: number) => {
    const l = out.get(a)!;
    l.splice(l.indexOf(b), 1);
    if (!l.length) out.delete(a);
    remaining--;
  };
  let guard = 0;
  while (remaining > 0 && guard++ < 100000) {
    const [start, nexts] = out.entries().next().value as [number, number[]];
    let prev = start;
    let cur = nexts[0];
    takeEdge(start, cur);
    const loop: number[] = [start];
    let steps = 0;
    while (cur !== start && steps++ < 100000) {
      loop.push(cur);
      const cands = out.get(cur);
      if (!cands || !cands.length) break; // open chain (should not happen)
      let best = cands[0];
      if (cands.length > 1) {
        const din: Vec2 = [pts[cur][0] - pts[prev][0], pts[cur][1] - pts[prev][1]];
        let bestAng = -Infinity;
        for (const c of cands) {
          const dout: Vec2 = [pts[c][0] - pts[cur][0], pts[c][1] - pts[cur][1]];
          let ang = Math.atan2(din[0] * dout[1] - din[1] * dout[0], din[0] * dout[0] + din[1] * dout[1]);
          if (ang >= Math.PI - 1e-9) ang = -Math.PI; // U-turn least preferred
          if (ang > bestAng) {
            bestAng = ang;
            best = c;
          }
        }
      }
      takeEdge(cur, best);
      prev = cur;
      cur = best;
    }
    if (loop.length >= 3) loops.push(simplifyCollinear(loop.map((i) => pts[i]), tol * 0.1));
  }

  const outer: Vec2[][] = [];
  const holes: Vec2[][] = [];
  for (const l of loops) {
    if (l.length < 3) continue;
    const a = polyArea(l);
    if (Math.abs(a) < tol * tol) continue;
    (a > 0 ? outer : holes).push(l);
  }
  outer.sort((p, q) => polyArea(q) - polyArea(p));
  return { outer, holes };
}

/** Axis-aligned rectangle [x0,x1]×[y0,y1]. */
export type ARect = [number, number, number, number];

/**
 * Region = rectangle minus a set of axis-aligned rectangles (notches, bend zones), returned as
 * polygon loops. Uses a grid decomposition so shared edges are exact.
 */
export function rectMinusRects(r: ARect, cuts: ARect[], tol = 1e-7): TileUnion {
  const uniq = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    const o: number[] = [];
    for (const v of s) if (!o.length || v - o[o.length - 1] > tol) o.push(v);
    return o;
  };
  const xs = uniq([r[0], r[1], ...cuts.flatMap((c) => [c[0], c[1]]).filter((v) => v > r[0] && v < r[1])]);
  const ys = uniq([r[2], r[3], ...cuts.flatMap((c) => [c[2], c[3]]).filter((v) => v > r[2] && v < r[3])]);
  const cells: Vec2[][] = [];
  for (let i = 0; i + 1 < xs.length; i++)
    for (let j = 0; j + 1 < ys.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      let removed = false;
      for (const c of cuts) {
        if (cx > c[0] && cx < c[1] && cy > c[2] && cy < c[3]) {
          removed = true;
          break;
        }
      }
      if (!removed)
        cells.push([
          [xs[i], ys[j]],
          [xs[i + 1], ys[j]],
          [xs[i + 1], ys[j + 1]],
          [xs[i], ys[j + 1]],
        ]);
    }
  return unionTiles(cells);
}
