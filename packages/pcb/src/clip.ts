/**
 * Thin wrapper around clipper-lib (integer coordinates, 10 nm resolution).
 * All shapes produced here are *conservative*: arcs are circumscribed so the polygon always contains
 * the true shape (max outward error {@link ARC_TOL}).
 */
import ClipperLib from 'clipper-lib';
import type { ClipType as ClipTypeT, IntPoint, PolyNode } from 'clipper-lib';
import type { Vec2 } from '@pcbcad/core';
import type { Prim } from './geom';

/** mm → clipper integer units. */
export const SCALE = 1e5;
/** Maximum arc approximation error (mm). */
export const ARC_TOL = 0.002;

export type IPath = IntPoint[];
export type IPaths = IPath[];

const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType, PolyTree } = ClipperLib;

export function toIPath(pts: readonly Vec2[]): IPath {
  return pts.map((p) => ({ X: Math.round(p[0] * SCALE), Y: Math.round(p[1] * SCALE) }));
}

export function fromIPath(p: IPath): Vec2[] {
  return p.map((q) => [q.X / SCALE, q.Y / SCALE] as Vec2);
}

/** Signed area of an integer path in mm² (positive = CCW). */
export function iArea(p: IPath): number {
  return Clipper.Area(p) / (SCALE * SCALE);
}

export function areaOf(paths: IPaths): number {
  let a = 0;
  for (const p of paths) a += iArea(p);
  return a;
}

function segmentsFor(R: number): number {
  return Math.max(8, Math.min(256, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - ARC_TOL / Math.max(R, 1e-6))))));
}

/** Circle polygon containing the true circle (CCW). */
export function circlePath(cx: number, cy: number, r: number): IPath {
  const n = segmentsFor(r);
  const rc = r / Math.cos(Math.PI / n);
  const out: IPath = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push({ X: Math.round((cx + rc * Math.cos(a)) * SCALE), Y: Math.round((cy + rc * Math.sin(a)) * SCALE) });
  }
  return out;
}

/** Capsule (segment a-b with radius r) polygon containing the true capsule (CCW). */
export function capsulePath(a: Vec2, b: Vec2, r: number): IPath {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return circlePath(a[0], a[1], r);
  const base = Math.atan2(dy, dx);
  const n = Math.max(4, Math.ceil(segmentsFor(r) / 2));
  const rc = r / Math.cos(Math.PI / (2 * n));
  const out: IPath = [];
  // around b: from base-90° to base+90°
  for (let i = 0; i <= n; i++) {
    const t = base - Math.PI / 2 + (Math.PI * i) / n;
    const rr = i === 0 || i === n ? r : rc;
    out.push({ X: Math.round((b[0] + rr * Math.cos(t)) * SCALE), Y: Math.round((b[1] + rr * Math.sin(t)) * SCALE) });
  }
  for (let i = 0; i <= n; i++) {
    const t = base + Math.PI / 2 + (Math.PI * i) / n;
    const rr = i === 0 || i === n ? r : rc;
    out.push({ X: Math.round((a[0] + rr * Math.cos(t)) * SCALE), Y: Math.round((a[1] + rr * Math.sin(t)) * SCALE) });
  }
  return out;
}

/** Make a path CCW (positive area). */
export function ccw(p: IPath): IPath {
  return Clipper.Area(p) < 0 ? p.slice().reverse() : p;
}

/** Offset closed paths by delta (mm); round joins; conservative for positive deltas. */
export function offsetPaths(paths: IPaths, delta: number): IPaths {
  if (!paths.length) return [];
  if (Math.abs(delta) < 1e-9) return paths;
  const co = new ClipperOffset(2, ARC_TOL * SCALE * 0.5);
  co.AddPaths(paths, JoinType.jtRound, EndType.etClosedPolygon);
  const out: IPaths = [];
  co.Execute(out, (delta + (delta > 0 ? ARC_TOL : 0)) * SCALE);
  return out;
}

/** Polygon(s) containing the prim inflated by `inflate` (mm). */
export function primPaths(p: Prim, inflate = 0): IPaths {
  const R = p.r + inflate;
  const pts = p.pts;
  if (pts.length === 1) return R > 1e-9 ? [circlePath(pts[0][0], pts[0][1], R)] : [];
  if (pts.length === 2) return R > 1e-9 ? [capsulePath(pts[0], pts[1], R)] : [];
  const poly = ccw(toIPath(pts));
  if (R <= 1e-9) return [poly];
  return offsetPaths([poly], R);
}

function exec(type: ClipTypeT, subj: IPaths, clip: IPaths): IPaths {
  const c = new Clipper();
  c.AddPaths(subj, PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip, PolyType.ptClip, true);
  const out: IPaths = [];
  c.Execute(type, out, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return out;
}

export function union(paths: IPaths): IPaths {
  if (!paths.length) return [];
  return exec(ClipType.ctUnion, paths, []);
}

export function difference(subj: IPaths, clip: IPaths): IPaths {
  if (!subj.length) return [];
  if (!clip.length) return subj;
  return exec(ClipType.ctDifference, subj, clip);
}

export function intersection(subj: IPaths, clip: IPaths): IPaths {
  if (!subj.length || !clip.length) return [];
  return exec(ClipType.ctIntersection, subj, clip);
}

/** Islands (outer ring + holes) of a set of paths, via a PolyTree. Outer rings CCW, holes CW. */
export function islands(paths: IPaths): { outer: IPath; holes: IPath[] }[] {
  if (!paths.length) return [];
  const c = new Clipper();
  c.AddPaths(paths, PolyType.ptSubject, true);
  const tree = new PolyTree();
  c.Execute(ClipType.ctUnion, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  const out: { outer: IPath; holes: IPath[] }[] = [];
  const walk = (node: PolyNode) => {
    for (const child of node.Childs()) {
      if (!child.IsHole()) {
        const outer = child.Contour();
        const holes: IPath[] = [];
        for (const h of child.Childs()) {
          holes.push(h.Contour());
          walk(h);
        }
        out.push({ outer: Clipper.Area(outer) < 0 ? outer.slice().reverse() : outer, holes: holes.map((h) => (Clipper.Area(h) > 0 ? h.slice().reverse() : h)) });
      }
    }
  };
  walk(tree);
  return out;
}

/** Remove near-duplicate / collinear vertices (distance in mm). */
export function cleanPaths(paths: IPaths, dist = 0.0005): IPaths {
  return Clipper.CleanPolygons(paths, dist * SCALE).filter((p) => p.length >= 3);
}
