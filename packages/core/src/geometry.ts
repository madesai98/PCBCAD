import type { BBox2, Transform3, Vec2, Vec3 } from './types/common';
import type { ComponentInstance } from './types/board';
import type { FootprintDef, PadDef } from './types/part';

/* ------------------------------------------- 2D basics ------------------------------------------ */

export const DEG = Math.PI / 180;

export function rotate2(p: Vec2, deg: number): Vec2 {
  if (!deg) return [p[0], p[1]];
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

export function add2(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

export function sub2(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

export function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  }
  return -a / 2; // positive for CCW
}

export function polygonBBox(poly: Vec2[]): BBox2 {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  const [x, y] = p;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-300) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from point p to segment ab. */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Minimum distance between segments ab and cd (0 if they intersect). */
export function segmentSegmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

/** Distance from p to the boundary of a closed polygon. */
export function pointPolygonEdgeDistance(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    best = Math.min(best, pointSegmentDistance(p, poly[j], poly[i]));
  }
  return best;
}

/** Rounded rectangle polygon (CCW) with lower-left corner at (x0, y0). */
export function roundedRectPolygon(x0: number, y0: number, w: number, h: number, r = 0, segmentsPerCorner = 8): Vec2[] {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r <= 1e-9) {
    return [
      [x0, y0],
      [x0 + w, y0],
      [x0 + w, y0 + h],
      [x0, y0 + h],
    ];
  }
  const pts: Vec2[] = [];
  const corners: [number, number, number][] = [
    [x0 + w - r, y0 + r, -90],
    [x0 + w - r, y0 + h - r, 0],
    [x0 + r, y0 + h - r, 90],
    [x0 + r, y0 + r, 180],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= segmentsPerCorner; i++) {
      const a = (start + (90 * i) / segmentsPerCorner) * DEG;
      pts.push([round6(cx + r * Math.cos(a)), round6(cy + r * Math.sin(a))]);
    }
  }
  return pts;
}

export function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Circle polygon (CCW). */
export function circlePolygon(cx: number, cy: number, r: number, segments = 32): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/* ---------------------------------------- Footprint placement ----------------------------------- */

/** Transform a point from footprint frame to board frame for a placed component. */
export function footprintToBoard(c: Pick<ComponentInstance, 'x' | 'y' | 'rotation' | 'side'>, p: Vec2): Vec2 {
  const local: Vec2 = c.side === 'bottom' ? [-p[0], p[1]] : [p[0], p[1]];
  const r = rotate2(local, c.rotation || 0);
  return [c.x + r[0], c.y + r[1]];
}

/** Inverse of footprintToBoard. */
export function boardToFootprint(c: Pick<ComponentInstance, 'x' | 'y' | 'rotation' | 'side'>, p: Vec2): Vec2 {
  const r = rotate2([p[0] - c.x, p[1] - c.y], -(c.rotation || 0));
  return c.side === 'bottom' ? [-r[0], r[1]] : r;
}

export interface PlacedPad {
  pad: PadDef;
  /** Centre in board frame. */
  x: number;
  y: number;
  /** Total rotation in board frame (deg). */
  rotation: number;
  w: number;
  h: number;
  /** Copper layers the pad occupies. */
  layers: ('top' | 'bottom' | 'inner')[];
  /** Polygon outline of the pad in board frame (CCW). */
  polygon: Vec2[];
}

/** Outline polygon of a pad in footprint frame (before component transform). */
export function padPolygonLocal(pad: PadDef, segments = 16): Vec2[] {
  const rot = pad.rotation || 0;
  let pts: Vec2[];
  if (pad.shape === 'polygon' && pad.polygon && pad.polygon.length >= 3) {
    pts = pad.polygon.map((p) => [p[0], p[1]] as Vec2);
  } else if (pad.shape === 'circle') {
    pts = circlePolygon(0, 0, pad.w / 2, segments);
  } else if (pad.shape === 'oval') {
    const r = Math.min(pad.w, pad.h) / 2;
    pts = roundedRectPolygon(-pad.w / 2, -pad.h / 2, pad.w, pad.h, r, Math.max(4, segments / 4));
  } else if (pad.shape === 'roundrect') {
    const r = (pad.roundness ?? 0.25) * Math.min(pad.w, pad.h);
    pts = roundedRectPolygon(-pad.w / 2, -pad.h / 2, pad.w, pad.h, r, 4);
  } else {
    pts = roundedRectPolygon(-pad.w / 2, -pad.h / 2, pad.w, pad.h, 0);
  }
  return pts.map((p) => {
    const r = rotate2(p, rot);
    return [r[0] + pad.x, r[1] + pad.y] as Vec2;
  });
}

/** All pads of a component in board frame. */
export function placedPads(c: ComponentInstance, fp: FootprintDef): PlacedPad[] {
  return fp.pads.map((pad) => {
    const center = footprintToBoard(c, [pad.x, pad.y]);
    const mirrorRot = c.side === 'bottom' ? -(pad.rotation || 0) : pad.rotation || 0;
    const layers: PlacedPad['layers'] =
      pad.kind === 'smd' ? [c.side] : pad.kind === 'tht' ? ['top', 'bottom', 'inner'] : [];
    const polygon = padPolygonLocal(pad).map((p) => footprintToBoard(c, p));
    if (c.side === 'bottom') polygon.reverse(); // keep CCW after mirroring
    return { pad, x: center[0], y: center[1], rotation: (c.rotation || 0) + mirrorRot, w: pad.w, h: pad.h, layers, polygon };
  });
}

/** Courtyard rectangle corners of a component in board frame. */
export function componentCourtyard(c: ComponentInstance, fp: FootprintDef): Vec2[] {
  const { minX, minY, maxX, maxY } = fp.courtyard;
  const pts: Vec2[] = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
  const out = pts.map((p) => footprintToBoard(c, p));
  if (c.side === 'bottom') out.reverse();
  return out;
}

/* --------------------------------------------- 3D ----------------------------------------------- */

/** Row-major 4x4 matrix. */
export type Mat4 = number[];

export function mat4Identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
      r[i * 4 + j] = s;
    }
  return r;
}

/** Rotation matrix for intrinsic XYZ Euler angles in degrees (same as three.js Euler order 'XYZ'). */
export function mat4FromEuler(rot: Vec3): Mat4 {
  const [x, y, z] = rot.map((d) => d * DEG);
  const a = Math.cos(x),
    b = Math.sin(x);
  const c = Math.cos(y),
    d = Math.sin(y);
  const e = Math.cos(z),
    f = Math.sin(z);
  const ae = a * e,
    af = a * f,
    be = b * e,
    bf = b * f;
  // three.js Matrix4.makeRotationFromEuler, order XYZ
  return [
    c * e, -c * f, d, 0,
    af + be * d, ae - bf * d, -b * c, 0,
    bf - ae * d, be + af * d, a * c, 0,
    0, 0, 0, 1,
  ];
}

export function mat4FromTransform(t: Transform3): Mat4 {
  const m = mat4FromEuler(t.rotation);
  m[3] = t.position[0];
  m[7] = t.position[1];
  m[11] = t.position[2];
  return m;
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

export function transformDirection(m: Mat4, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[4] * v[0] + m[5] * v[1] + m[6] * v[2], m[8] * v[0] + m[9] * v[1] + m[10] * v[2]];
}

/** Inverse of a rigid transform matrix (rotation + translation). */
export function mat4InvertRigid(m: Mat4): Mat4 {
  const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  const t = [m[3], m[7], m[11]];
  r[3] = -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]);
  r[7] = -(r[4] * t[0] + r[5] * t[1] + r[6] * t[2]);
  r[11] = -(r[8] * t[0] + r[9] * t[1] + r[10] * t[2]);
  return r;
}

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vec3Scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function vec3Length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function vec3Normalize(a: Vec3): Vec3 {
  const l = vec3Length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
