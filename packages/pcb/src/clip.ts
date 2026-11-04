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

function segmentsFor(R: number, tol: number): number {
  return Math.max(8, Math.min(256, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - tol / Math.max(R, 1e-6))))));
}

/** Circle polygon containing the true circle (CCW, circumscribed, max outward error `tol`). */
export function circlePath(cx: number, cy: number, r: number, tol = ARC_TOL): IPath {
  const n = segmentsFor(r, tol);
  const rc = r / Math.cos(Math.PI / n);
  const out: IPath = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push({ X: Math.round((cx + rc * Math.cos(a)) * SCALE), Y: Math.round((cy + rc * Math.sin(a)) * SCALE) });
  }
  return out;
}

/** Capsule (segment a-b with radius r) polygon containing the true capsule (CCW, circumscribed). */
export function capsulePath(a: Vec2, b: Vec2, r: number, tol = ARC_TOL): IPath {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return circlePath(a[0], a[1], r, tol);
  const base = Math.atan2(dy, dx);
  const n = Math.max(4, Math.ceil(segmentsFor(r, tol) / 2));
  // every vertex on the circumscribed radius: arcs and straight sides both contain the true capsule
  const rc = r / Math.cos(Math.PI / (2 * n));
  const out: IPath = [];
  for (let i = 0; i <= n; i++) {
    const t = base - Math.PI / 2 + (Math.PI * i) / n;
    out.push({ X: Math.round((b[0] + rc * Math.cos(t)) * SCALE), Y: Math.round((b[1] + rc * Math.sin(t)) * SCALE) });
  }
  for (let i = 0; i <= n; i++) {
    const t = base + Math.PI / 2 + (Math.PI * i) / n;
    out.push({ X: Math.round((a[0] + rc * Math.cos(t)) * SCALE), Y: Math.round((a[1] + rc * Math.sin(t)) * SCALE) });
  }
  return out;
}

/** Make a path CCW (positive area). */
export function ccw(p: IPath): IPath {
  return Clipper.Area(p) < 0 ? p.slice().reverse() : p;
}

/**
 * Offset closed paths by delta (mm) with round joins. With `conservative` (default) a positive offset
 * is enlarged by the arc tolerance so the result contains the true offset; otherwise round joins are
 * inscribed (result inside the true offset).
 */
export function offsetPaths(paths: IPaths, delta: number, conservative = true, tol = ARC_TOL): IPaths {
  if (!paths.length) return [];
  if (Math.abs(delta) < 1e-9) return paths;
  const co = new ClipperOffset(2, tol * SCALE * 0.5);
  co.AddPaths(paths, JoinType.jtRound, EndType.etClosedPolygon);
  const out: IPaths = [];
  co.Execute(out, (delta + (delta > 0 && conservative ? tol : 0)) * SCALE);
  return out;
}

/** Polygon(s) containing the prim inflated by `inflate` (mm). */
export function primPaths(p: Prim, inflate = 0, tol = ARC_TOL): IPaths {
  const R = p.r + inflate;
  const pts = p.pts;
  if (pts.length === 1) return R > 1e-9 ? [circlePath(pts[0][0], pts[0][1], R, tol)] : [];
  if (pts.length === 2) return R > 1e-9 ? [capsulePath(pts[0], pts[1], R, tol)] : [];
  const poly = ccw(toIPath(pts));
  if (R <= 1e-9) return [poly];
  return offsetPaths([poly], R, true, tol);
}

/** Integer bounds of paths. */
export function boundsOf(paths: IPaths): { left: number; bottom: number; right: number; top: number } {
  let left = Infinity;
  let bottom = Infinity;
  let right = -Infinity;
  let top = -Infinity;
  for (const p of paths)
    for (const q of p) {
      if (q.X < left) left = q.X;
      if (q.X > right) right = q.X;
      if (q.Y < bottom) bottom = q.Y;
      if (q.Y > top) top = q.Y;
    }
  return { left, bottom, right, top };
}

function rectPath(x0: number, y0: number, x1: number, y1: number): IPath {
  return [
    { X: x0, Y: y0 },
    { X: x1, Y: y0 },
    { X: x1, Y: y1 },
    { X: x0, Y: y1 },
  ];
}

/**
 * Morphological opening (erode by r, then dilate by r) — removes copper narrower than 2r. The result is
 * always inside the input (erosion is over-estimated by the arc tolerance, dilation uses inscribed
 * arcs). The dilation runs in vertical strips with r-wide overlaps, which is exact and keeps
 * clipper's sweep line short on large boards.
 */
export function openPaths(paths: IPaths, r: number): IPaths {
  if (r <= 0 || !paths.length) return paths;
  const eroded = offsetPaths(paths, -(r + ARC_TOL));
  if (!eroded.length) return [];
  let verts = 0;
  for (const p of eroded) verts += p.length;
  const strips = Math.max(1, Math.min(48, Math.ceil(verts / 1500)));
  if (strips === 1) return offsetPaths(eroded, r, false);
  const b = boundsOf(eroded);
  const R = Math.ceil(r * SCALE) + 2;
  const lo = b.left - R;
  const hi = b.right + R;
  const ringBounds = eroded.map((p) => boundsOf([p]));
  const pieces: IPaths = [];
  for (let k = 0; k < strips; k++) {
    const x0 = Math.round(lo + ((hi - lo) * k) / strips);
    const x1 = Math.round(lo + ((hi - lo) * (k + 1)) / strips);
    // rings that cannot reach the strip window do not influence it (holes are local)
    const local = eroded.filter((_, i) => ringBounds[i].right >= x0 - R && ringBounds[i].left <= x1 + R);
    if (!local.length) continue;
    const part = intersection(local, [rectPath(x0 - R, b.bottom - R, x1 + R, b.top + R)]);
    if (!part.length) continue;
    pieces.push(...intersection(offsetPaths(part, r, false), [rectPath(x0, b.bottom - 2 * R, x1, b.top + 2 * R)]));
  }
  return union(pieces);
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
