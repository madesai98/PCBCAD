/**
 * Small 2D polygon toolkit used by every geometry builder (pure JS, no WASM).
 * All lengths in mm. Polygons are arrays of [x, y]; CCW = positive area.
 */
import type { Vec2 } from '@pcbcad/core';

/** Number of segments for a full circle of radius r (≈ 0.4 mm chords, multiple of 4, 16..96). */
export function circleSegments(r: number, maxEdge = 0.4): number {
  if (!(r > 0) || !Number.isFinite(r)) return 16;
  const n = Math.ceil((2 * Math.PI * r) / maxEdge);
  return Math.max(16, Math.min(96, Math.ceil(n / 4) * 4));
}

export function circlePoly(cx: number, cy: number, r: number, n = circleSegments(r)): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Axis-aligned rectangle centred at (cx, cy), CCW. */
export function rectPoly(cx: number, cy: number, w: number, h: number): Vec2[] {
  const a = w / 2;
  const b = h / 2;
  return [
    [cx - a, cy - b],
    [cx + a, cy - b],
    [cx + a, cy + b],
    [cx - a, cy + b],
  ];
}

/** Rectangle from min/max corners, CCW. */
export function boxPoly(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/**
 * Rounded rectangle centred at (cx, cy) with half sizes (hx, hy) and corner radius r (CCW).
 * `segPerCorner` defaults to a chord length of ≈ 0.4 mm.
 */
export function rrPoly(cx: number, cy: number, hx: number, hy: number, r: number, segPerCorner?: number): Vec2[] {
  hx = Math.max(hx, 0);
  hy = Math.max(hy, 0);
  r = Math.max(0, Math.min(r, hx, hy));
  if (r <= 1e-9) return rectPoly(cx, cy, 2 * hx, 2 * hy);
  const n = Math.max(1, segPerCorner ?? circleSegments(r) / 4);
  const pts: Vec2[] = [];
  const corners: [number, number, number][] = [
    [cx + hx - r, cy - hy + r, -90],
    [cx + hx - r, cy + hy - r, 0],
    [cx - hx + r, cy + hy - r, 90],
    [cx - hx + r, cy - hy + r, 180],
  ];
  for (const [ox, oy, a0] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = ((a0 + (90 * i) / n) * Math.PI) / 180;
      pts.push([ox + r * Math.cos(a), oy + r * Math.sin(a)]);
    }
  }
  return dedupe(pts);
}

/** Obround / stadium of overall size w × h (ends rounded on the shorter dimension). */
export function stadiumPoly(cx: number, cy: number, w: number, h: number): Vec2[] {
  return rrPoly(cx, cy, w / 2, h / 2, Math.min(w, h) / 2);
}

/** Remove consecutive duplicate points (and a closing duplicate). */
export function dedupe(p: Vec2[], tol = 1e-9): Vec2[] {
  const out: Vec2[] = [];
  for (const q of p) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - q[0]) > tol || Math.abs(last[1] - q[1]) > tol) out.push([q[0], q[1]]);
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol) out.pop();
    else break;
  }
  return out;
}

/** Signed area (CCW positive). */
export function polyArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return a / 2;
}

export function ensureCCW(p: Vec2[]): Vec2[] {
  return polyArea(p) < 0 ? [...p].reverse() : p;
}

/** Even-odd point-in-polygon test. */
export function pointInPoly(x: number, y: number, p: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const yi = p[i][1];
    const yj = p[j][1];
    if (yi > y !== yj > y) {
      const xi = p[i][0];
      const xj = p[j][0];
      if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export interface Rect2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function polyBBox(p: Vec2[]): Rect2 {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of p) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from a point to a closed polygon boundary. */
export function polyBoundaryDist(x: number, y: number, p: Vec2[]): number {
  let d = Infinity;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) d = Math.min(d, segDist(x, y, p[j][0], p[j][1], p[i][0], p[i][1]));
  return d;
}

/** Signed distance to a centred rounded rectangle (negative inside). */
export function sdRoundRect(x: number, y: number, hx: number, hy: number, r: number): number {
  r = Math.max(0, Math.min(r, hx, hy));
  const qx = Math.abs(x) - hx + r;
  const qy = Math.abs(y) - hy + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

/** Map polygon from local (u, v) to the plane o + u·eu + v·ev. */
export function mapPoly(p: Vec2[], o: Vec2, eu: Vec2, ev: Vec2): Vec2[] {
  return p.map(([u, v]) => [o[0] + u * eu[0] + v * ev[0], o[1] + u * eu[1] + v * ev[1]] as Vec2);
}

/** Remove (nearly) collinear vertices from a closed loop. */
export function simplifyCollinear(p: Vec2[], tol = 1e-7): Vec2[] {
  let pts = dedupe(p, tol);
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    const out: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const bcx = c[0] - b[0];
      const bcy = c[1] - b[1];
      const cross = abx * bcy - aby * bcx;
      const len = Math.hypot(abx, aby) + Math.hypot(bcx, bcy);
      if (Math.abs(cross) <= tol * Math.max(len, 1) && abx * bcx + aby * bcy > 0) {
        changed = true;
        continue;
      }
      out.push(b);
    }
    pts = out;
  }
  return pts;
}
