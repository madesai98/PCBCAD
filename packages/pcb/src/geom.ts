/**
 * Low-level 2D geometry used by every engine in this package.
 *
 * All copper (pads, trace segments, vias, holes) is represented as a {@link Prim}: the Minkowski sum
 * of a "core" (a point, a segment or a closed polygon) with a disc of radius `r`. This represents
 * circles (point + r), traces/ovals (segment + r), rectangles (polygon + 0) and rounded rectangles
 * (inner rectangle + corner radius) *exactly*, so clearance distances are exact as well.
 *
 * Units: millimetres, board frame (X right, Y up).
 */
import type { BBox2, Vec2 } from '@pcbcad/core';

/** Copper primitive: core (1 point = disc, 2 points = capsule, ≥3 points = closed polygon) ⊕ disc(r). */
export interface Prim {
  pts: Vec2[];
  /** Minkowski radius (mm), ≥ 0. */
  r: number;
  /** Bounding box including `r`. */
  bb: BBox2;
}

export function bboxOf(pts: readonly Vec2[], pad = 0): BBox2 {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function makePrim(pts: Vec2[], r: number): Prim {
  return { pts, r, bb: bboxOf(pts, r) };
}

export function bbOverlaps(a: BBox2, b: BBox2, margin = 0): boolean {
  return a.minX - margin <= b.maxX && b.minX - margin <= a.maxX && a.minY - margin <= b.maxY && b.minY - margin <= a.maxY;
}

export function bbInflate(b: BBox2, d: number): BBox2 {
  return { minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d };
}

export function bbUnion(a: BBox2, b: BBox2): BBox2 {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

export function bbContainsPt(b: BBox2, x: number, y: number): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

/** Squared distance from (px,py) to segment (ax,ay)-(bx,by). */
export function distPtSeg2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/** Scratch output of {@link segSegDist}: closest points [px, py, qx, qy] on segment 1 and 2. */
export const CLOSEST = new Float64Array(4);

function projectInto(px: number, py: number, ax: number, ay: number, bx: number, by: number, out: Float64Array, o: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  out[o] = ax + t * dx;
  out[o + 1] = ay + t * dy;
  const qx = out[o] - px;
  const qy = out[o + 1] - py;
  return qx * qx + qy * qy;
}

/**
 * Distance between segments ab and cd (0 when they intersect or touch). Closest points are written to
 * {@link CLOSEST} (first pair on ab, second on cd).
 */
export function segSegDist(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  const o1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const o2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const o3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const o4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    const t = o1 / (o1 - o2);
    const x = ax + t * (bx - ax);
    const y = ay + t * (by - ay);
    CLOSEST[0] = x;
    CLOSEST[1] = y;
    CLOSEST[2] = x;
    CLOSEST[3] = y;
    return 0;
  }
  const tmp = SCRATCH;
  let best = Infinity;
  // a onto cd
  let d = projectInto(ax, ay, cx, cy, dx, dy, tmp, 0);
  if (d < best) {
    best = d;
    CLOSEST[0] = ax;
    CLOSEST[1] = ay;
    CLOSEST[2] = tmp[0];
    CLOSEST[3] = tmp[1];
  }
  d = projectInto(bx, by, cx, cy, dx, dy, tmp, 0);
  if (d < best) {
    best = d;
    CLOSEST[0] = bx;
    CLOSEST[1] = by;
    CLOSEST[2] = tmp[0];
    CLOSEST[3] = tmp[1];
  }
  d = projectInto(cx, cy, ax, ay, bx, by, tmp, 0);
  if (d < best) {
    best = d;
    CLOSEST[0] = tmp[0];
    CLOSEST[1] = tmp[1];
    CLOSEST[2] = cx;
    CLOSEST[3] = cy;
  }
  d = projectInto(dx, dy, ax, ay, bx, by, tmp, 0);
  if (d < best) {
    best = d;
    CLOSEST[0] = tmp[0];
    CLOSEST[1] = tmp[1];
    CLOSEST[2] = dx;
    CLOSEST[3] = dy;
  }
  return Math.sqrt(best);
}
const SCRATCH = new Float64Array(2);

/** Even-odd point-in-ring test (ring closed implicitly). */
export function pointInRing(px: number, py: number, ring: readonly Vec2[]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ring[i][1];
    const yj = ring[j][1];
    if (yi > py !== yj > py) {
      const xi = ring[i][0];
      const xj = ring[j][0];
      if (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Signed area (positive = CCW in a Y-up frame). */
export function ringArea(ring: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return a / 2;
}

/** Distance from a point to the core of a prim (0 inside polygon cores). */
export function primCoreDistPt(p: Prim, x: number, y: number): number {
  const pts = p.pts;
  const n = pts.length;
  if (n === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]);
  if (n === 2) return Math.sqrt(distPtSeg2(x, y, pts[0][0], pts[0][1], pts[1][0], pts[1][1]));
  if (pointInRing(x, y, pts)) return 0;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d = distPtSeg2(x, y, pts[j][0], pts[j][1], pts[i][0], pts[i][1]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Copper distance from a point to a prim (negative inside). */
export function primPtDist(p: Prim, x: number, y: number): number {
  return primCoreDistPt(p, x, y) - p.r;
}

function edgeCount(n: number): number {
  return n >= 3 ? n : 1;
}

/** Scratch: location of the closest approach found by the last {@link primGap} call. */
export const GAP_AT: Vec2 = [0, 0];

/**
 * Copper gap between two prims: distance between their cores minus both radii. ≤ 0 means the copper
 * touches/overlaps. The location of the closest approach is written to {@link GAP_AT}.
 */
export function primGap(a: Prim, b: Prim): number {
  return primCoreDist(a, b) - a.r - b.r;
}

/** Distance between the cores of two prims (0 when they overlap). Sets {@link GAP_AT}. */
export function primCoreDist(a: Prim, b: Prim): number {
  const pa = a.pts;
  const pb = b.pts;
  const na = pa.length;
  const nb = pb.length;
  if (na >= 3 && pointInRing(pb[0][0], pb[0][1], pa)) {
    GAP_AT[0] = pb[0][0];
    GAP_AT[1] = pb[0][1];
    return 0;
  }
  if (nb >= 3 && pointInRing(pa[0][0], pa[0][1], pb)) {
    GAP_AT[0] = pa[0][0];
    GAP_AT[1] = pa[0][1];
    return 0;
  }
  const ea = edgeCount(na);
  const eb = edgeCount(nb);
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let i = 0; i < ea; i++) {
    const p0 = pa[i];
    const p1 = na === 1 ? pa[0] : pa[(i + 1) % na];
    for (let j = 0; j < eb; j++) {
      const q0 = pb[j];
      const q1 = nb === 1 ? pb[0] : pb[(j + 1) % nb];
      const d = segSegDist(p0[0], p0[1], p1[0], p1[1], q0[0], q0[1], q1[0], q1[1]);
      if (d < best) {
        best = d;
        bx = (CLOSEST[0] + CLOSEST[2]) / 2;
        by = (CLOSEST[1] + CLOSEST[3]) / 2;
        if (d === 0) {
          GAP_AT[0] = bx;
          GAP_AT[1] = by;
          return 0;
        }
      }
    }
  }
  GAP_AT[0] = bx;
  GAP_AT[1] = by;
  return best;
}

/** Distance from a segment (with half-width hw) to a prim's copper: gap (≤0 = overlap). */
export function segPrimGap(ax: number, ay: number, bx: number, by: number, hw: number, p: Prim): number {
  return primGap({ pts: [[ax, ay], [bx, by]], r: hw, bb: EMPTY_BB }, p);
}
const EMPTY_BB: BBox2 = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

/** Convex hull (Andrew's monotone chain), CCW, no collinear points. */
export function convexHull(points: Vec2[]): Vec2[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Polygon (CCW) that *contains* the prim inflated by `d` (circumscribed arcs, max outward error `tol`).
 * Exact for polygon cores that are convex; non-convex cores use their convex hull (conservative).
 */
export function primOutline(p: Prim, d = 0, tol = 0.002): Vec2[] {
  const R = p.r + d;
  const core = p.pts.length >= 3 ? convexHull(p.pts) : p.pts;
  if (R <= 1e-9) return core.length >= 3 ? core : [];
  const n = Math.max(8, Math.min(128, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - tol / R)))));
  const Rc = R / Math.cos(Math.PI / n);
  const pts: Vec2[] = [];
  for (const c of core) {
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      pts.push([c[0] + Rc * Math.cos(a), c[1] + Rc * Math.sin(a)]);
    }
  }
  return core.length === 1 ? pts : convexHull(pts);
}

/** Length of a polyline. */
export function polylineLength(pts: readonly Vec2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Deterministic PRNG (mulberry32) returning floats in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Milliseconds clock usable in browsers, workers and Node. */
export function nowMs(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
}

/** Natural comparison of reference designators: R2 < R10, C1 < R1. */
export function compareRefs(a: string, b: string): number {
  const ra = /^(.*?)(\d+)(.*)$/.exec(a);
  const rb = /^(.*?)(\d+)(.*)$/.exec(b);
  if (ra && rb && ra[1] === rb[1]) {
    const d = parseInt(ra[2], 10) - parseInt(rb[2], 10);
    if (d !== 0) return d;
    return ra[3] < rb[3] ? -1 : ra[3] > rb[3] ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
