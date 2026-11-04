/**
 * Solid IR: a tiny CSG description shared by every mechanical builder (shells, sheet metal, custom
 * CSG, purchased envelopes, boards/components for assembly analysis).
 *
 * It is evaluated two ways:
 *  - solidToManifold(): exact B-rep via manifold-3d (WASM) → render meshes, STL/3MF, mass properties;
 *  - rasterizeSolid() / solidContains(): analytic point-membership on a voxel grid (pure JS, sync) →
 *    voxel models for simulation, fast volume estimates, interference checks.
 * Both use the same polygons, so they agree to within discretisation.
 *
 * Matrices are row-major (core convention); `m` maps the node's local frame into its parent's frame.
 * Prism semantics: `outer` (even-odd filled, so self-intersecting input is well defined) minus the
 * union of `holes` (each even-odd; holes may cross the outline), extruded along local +Z from z0 to z1. Membership tests are half-open ([z0, z1)) so touching solids never double
 * count a sample.
 */
import type { BBox3, Mat4, Vec2, Vec3 } from '@pcbcad/core';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { mat4Invert, mul, toColumnMajor, isIdentity, apply } from './mat';
import { circleSegments, pointInPoly, polyBBox, rrPoly, sdRoundRect, type Rect2 } from './poly';
import type { Arena } from './wasm';

export interface PrismSolid {
  kind: 'prism';
  outer: Vec2[];
  holes?: Vec2[][];
  z0: number;
  z1: number;
  m?: Mat4;
}

/**
 * Rounded-rectangle "loft" centred on the local Z axis with constant draft: half sizes (hx, hy) and
 * corner radius r apply at z = zRef; at height z the outline is offset inward by
 * slope·(zRef − z) (+ a circular bottom fillet of radius `fillet` blending into the plane z = z0).
 * Always convex, so manifold builds it exactly as a hull.
 */
export interface RRLoftSolid {
  kind: 'rrloft';
  hx: number;
  hy: number;
  r: number;
  z0: number;
  z1: number;
  zRef: number;
  slope: number;
  fillet?: number;
  m?: Mat4;
}

export interface BoxSolid {
  kind: 'box';
  size: Vec3;
  center?: boolean;
  /** Edge rounding radius (hull of corner spheres). */
  radius?: number;
  m?: Mat4;
}

export interface CylSolid {
  kind: 'cylinder';
  /** Bottom / top radius. */
  r0: number;
  r1: number;
  h: number;
  center?: boolean;
  segments?: number;
  m?: Mat4;
}

export interface SphereSolid {
  kind: 'sphere';
  r: number;
  segments?: number;
  m?: Mat4;
}

/** Profile (r, z) revolved about local Z. */
export interface RevolveSolid {
  kind: 'revolve';
  profile: Vec2[];
  segments?: number;
  m?: Mat4;
}

export interface OpSolid {
  kind: 'union' | 'difference' | 'intersection';
  children: Solid[];
  m?: Mat4;
}

export type LeafSolid = PrismSolid | RRLoftSolid | BoxSolid | CylSolid | SphereSolid | RevolveSolid;
export type Solid = LeafSolid | OpSolid;

/* ------------------------------------------- builders ------------------------------------------- */

export function prism(outer: Vec2[], z0: number, z1: number, m?: Mat4, holes?: Vec2[][]): PrismSolid {
  return holes && holes.length ? { kind: 'prism', outer, holes, z0, z1, m } : { kind: 'prism', outer, z0, z1, m };
}

export function union(children: (Solid | null | undefined | false)[], m?: Mat4): Solid {
  return { kind: 'union', children: children.filter(Boolean) as Solid[], m };
}

export function difference(base: Solid, cutters: (Solid | null | undefined | false)[], m?: Mat4): Solid {
  const c = cutters.filter(Boolean) as Solid[];
  if (!c.length && !m) return base;
  return { kind: 'difference', children: [base, ...c], m };
}

export function intersection(children: (Solid | null | undefined | false)[], m?: Mat4): Solid {
  return { kind: 'intersection', children: children.filter(Boolean) as Solid[], m };
}

/** Return `s` placed by `m` (m · s.m). */
export function placed(s: Solid, m: Mat4 | undefined): Solid {
  if (!m || isIdentity(m)) return s;
  return { ...s, m: s.m ? mul(m, s.m) : m } as Solid;
}

/* ------------------------------------------- compile -------------------------------------------- */

interface CLeaf {
  leaf: true;
  s: LeafSolid;
  inv: Mat4;
  bb: BBox3;
  test: (x: number, y: number, z: number) => boolean;
}

interface COp {
  leaf: false;
  op: OpSolid['kind'];
  children: CNode[];
  bb: BBox3;
}

export type CNode = CLeaf | COp;

function localBBox(s: LeafSolid): BBox3 | null {
  switch (s.kind) {
    case 'prism': {
      if (s.outer.length < 3 || !(s.z1 > s.z0)) return null;
      const b = polyBBox(s.outer);
      return { min: [b.minX, b.minY, s.z0], max: [b.maxX, b.maxY, s.z1] };
    }
    case 'rrloft': {
      if (!(s.z1 > s.z0) || !(s.hx > 0) || !(s.hy > 0)) return null;
      const g = s.slope * Math.max(0, s.z1 - s.zRef);
      return { min: [-(s.hx + g), -(s.hy + g), s.z0], max: [s.hx + g, s.hy + g, s.z1] };
    }
    case 'box': {
      const [x, y, z] = s.size;
      if (!(x > 0 && y > 0 && z > 0)) return null;
      return s.center ? { min: [-x / 2, -y / 2, -z / 2], max: [x / 2, y / 2, z / 2] } : { min: [0, 0, 0], max: [x, y, z] };
    }
    case 'cylinder': {
      const r = Math.max(s.r0, s.r1);
      if (!(r > 0) || !(s.h > 0)) return null;
      const z0 = s.center ? -s.h / 2 : 0;
      return { min: [-r, -r, z0], max: [r, r, z0 + s.h] };
    }
    case 'sphere':
      if (!(s.r > 0)) return null;
      return { min: [-s.r, -s.r, -s.r], max: [s.r, s.r, s.r] };
    case 'revolve': {
      if (s.profile.length < 3) return null;
      const b = polyBBox(s.profile);
      const r = Math.max(0, b.maxX);
      if (!(r > 0) || !(b.maxY > b.minY)) return null;
      return { min: [-r, -r, b.minY], max: [r, r, b.maxY] };
    }
  }
}

function transformBBox(b: BBox3, m: Mat4): BBox3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const p = apply(m, [c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]]);
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  return { min, max };
}

/** Inset of an rrloft outline at height z (positive = smaller than the zRef outline). */
export function rrloftInset(s: RRLoftSolid, z: number): number {
  let inset = s.slope * (s.zRef - z);
  const f = s.fillet ?? 0;
  if (f > 0) {
    const d = z - s.z0;
    if (d < f) {
      const q = f - Math.max(0, d);
      inset += f - Math.sqrt(Math.max(0, f * f - q * q));
    }
  }
  return inset;
}

function makeTest(s: LeafSolid): CLeaf['test'] {
  switch (s.kind) {
    case 'prism': {
      const ob = polyBBox(s.outer);
      const holes = (s.holes ?? []).filter((h) => h.length >= 3).map((h) => ({ p: h, b: polyBBox(h) }));
      const inB = (b: Rect2, x: number, y: number) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
      return (x, y, z) => {
        if (z < s.z0 || z >= s.z1 || !inB(ob, x, y) || !pointInPoly(x, y, s.outer)) return false;
        for (const h of holes) if (inB(h.b, x, y) && pointInPoly(x, y, h.p)) return false;
        return true;
      };
    }
    case 'rrloft':
      return (x, y, z) => {
        if (z < s.z0 || z >= s.z1) return false;
        const inset = rrloftInset(s, z);
        const hx = s.hx - inset;
        const hy = s.hy - inset;
        if (hx <= 0 || hy <= 0) return false;
        return sdRoundRect(x, y, hx, hy, Math.max(0, s.r - inset)) <= 0;
      };
    case 'box': {
      const [sx, sy, sz] = s.size;
      const c: Vec3 = s.center ? [0, 0, 0] : [sx / 2, sy / 2, sz / 2];
      const r = Math.max(0, Math.min(s.radius ?? 0, sx / 2, sy / 2, sz / 2));
      if (r > 0) {
        return (x, y, z) => {
          const qx = Math.abs(x - c[0]) - (sx / 2 - r);
          const qy = Math.abs(y - c[1]) - (sy / 2 - r);
          const qz = Math.abs(z - c[2]) - (sz / 2 - r);
          const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
          return out + Math.min(Math.max(qx, qy, qz), 0) - r <= 0;
        };
      }
      const x0 = c[0] - sx / 2, y0 = c[1] - sy / 2, z0 = c[2] - sz / 2;
      return (x, y, z) => x >= x0 && x < x0 + sx && y >= y0 && y < y0 + sy && z >= z0 && z < z0 + sz;
    }
    case 'cylinder': {
      const zb = s.center ? -s.h / 2 : 0;
      return (x, y, z) => {
        const t = (z - zb) / s.h;
        if (t < 0 || t >= 1) return false;
        const r = s.r0 + (s.r1 - s.r0) * t;
        return x * x + y * y <= r * r;
      };
    }
    case 'sphere':
      return (x, y, z) => x * x + y * y + z * z <= s.r * s.r;
    case 'revolve':
      return (x, y, z) => pointInPoly(Math.hypot(x, y), z, s.profile);
  }
}

/** Flatten matrices and precompute world bounding boxes. Returns null for empty solids. */
export function compileSolid(s: Solid, parent?: Mat4): CNode | null {
  const m = parent ? (s.m ? mul(parent, s.m) : parent) : s.m ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (s.kind === 'union' || s.kind === 'difference' || s.kind === 'intersection') {
    const kids = s.children.map((c) => compileSolid(c, m));
    if (s.kind === 'union') {
      const ch = kids.filter((c): c is CNode => !!c);
      if (!ch.length) return null;
      return { leaf: false, op: 'union', children: ch, bb: bbUnion(ch.map((c) => c.bb)) };
    }
    if (s.kind === 'difference') {
      const base = kids[0];
      if (!base) return null;
      const cut = kids.slice(1).filter((c): c is CNode => !!c && !!bbInter(c.bb, base.bb));
      if (!cut.length) return base;
      return { leaf: false, op: 'difference', children: [base, ...cut], bb: base.bb };
    }
    if (kids.some((c) => !c) || !kids.length) return null;
    const ch = kids as CNode[];
    let bb: BBox3 | null = ch[0].bb;
    for (const c of ch.slice(1)) bb = bb && bbInter(bb, c.bb);
    if (!bb) return null;
    return { leaf: false, op: 'intersection', children: ch, bb };
  }
  const leaf = s as LeafSolid;
  const lb = localBBox(leaf);
  if (!lb) return null;
  return { leaf: true, s: leaf, inv: mat4Invert(m), bb: transformBBox(lb, m), test: makeTest(leaf) };
}

export function bbUnion(bbs: BBox3[]): BBox3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of bbs)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  return { min, max };
}

export function bbInter(a: BBox3, b: BBox3): BBox3 | null {
  const min: Vec3 = [Math.max(a.min[0], b.min[0]), Math.max(a.min[1], b.min[1]), Math.max(a.min[2], b.min[2])];
  const max: Vec3 = [Math.min(a.max[0], b.max[0]), Math.min(a.max[1], b.max[1]), Math.min(a.max[2], b.max[2])];
  if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) return null;
  return { min, max };
}

/** World bounding box of a solid (null when empty). */
export function solidBBox(s: Solid, m?: Mat4): BBox3 | null {
  return compileSolid(s, m)?.bb ?? null;
}

/** Point membership (world/parent frame of the compiled node). */
export function solidContains(node: CNode | null, p: Vec3): boolean {
  if (!node) return false;
  const b = node.bb;
  if (p[0] < b.min[0] || p[0] > b.max[0] || p[1] < b.min[1] || p[1] > b.max[1] || p[2] < b.min[2] || p[2] > b.max[2]) return false;
  if (node.leaf) {
    const q = apply(node.inv, p);
    return node.test(q[0], q[1], q[2]);
  }
  switch (node.op) {
    case 'union':
      return node.children.some((c) => solidContains(c, p));
    case 'difference':
      return solidContains(node.children[0], p) && !node.children.slice(1).some((c) => solidContains(c, p));
    case 'intersection':
      return node.children.every((c) => solidContains(c, p));
  }
}

/* ----------------------------------------- rasterisation ---------------------------------------- */

/** Voxel grid geometry: cell (i,j,k) spans origin + [i,i+1]·h …; samples are taken at cell centres. */
export interface GridSpec {
  nx: number;
  ny: number;
  nz: number;
  h: number;
  origin: Vec3;
}

interface Win {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
  k0: number;
  k1: number;
}

function bbWin(b: BBox3, g: GridSpec): Win | null {
  const r = (lo: number, hi: number, o: number, n: number): [number, number] => [
    Math.max(0, Math.ceil((lo - o) / g.h - 0.5 - 1e-9)),
    Math.min(n, Math.floor((hi - o) / g.h - 0.5 + 1e-9) + 1),
  ];
  const [i0, i1] = r(b.min[0], b.max[0], g.origin[0], g.nx);
  const [j0, j1] = r(b.min[1], b.max[1], g.origin[1], g.ny);
  const [k0, k1] = r(b.min[2], b.max[2], g.origin[2], g.nz);
  if (i0 >= i1 || j0 >= j1 || k0 >= k1) return null;
  return { i0, i1, j0, j1, k0, k1 };
}

function winInter(a: Win, b: Win | null): Win | null {
  if (!b) return null;
  const w = { i0: Math.max(a.i0, b.i0), i1: Math.min(a.i1, b.i1), j0: Math.max(a.j0, b.j0), j1: Math.min(a.j1, b.j1), k0: Math.max(a.k0, b.k0), k1: Math.min(a.k1, b.k1) };
  return w.i0 < w.i1 && w.j0 < w.j1 && w.k0 < w.k1 ? w : null;
}

function winSize(w: Win): number {
  return (w.i1 - w.i0) * (w.j1 - w.j0) * (w.k1 - w.k0);
}

/** Copy/OR/clear a sub-window mask `src` (window sw) into `dst` (window dw). */
function blit(dst: Uint8Array, dw: Win, src: Uint8Array, sw: Win, mode: 'or' | 'clear'): void {
  const dni = dw.i1 - dw.i0;
  const dnj = dw.j1 - dw.j0;
  const sni = sw.i1 - sw.i0;
  const snj = sw.j1 - sw.j0;
  for (let k = sw.k0; k < sw.k1; k++)
    for (let j = sw.j0; j < sw.j1; j++) {
      let si = sni * ((j - sw.j0) + snj * (k - sw.k0));
      let di = sw.i0 - dw.i0 + dni * ((j - dw.j0) + dnj * (k - dw.k0));
      for (let i = sw.i0; i < sw.i1; i++, si++, di++) {
        if (!src[si]) continue;
        if (mode === 'or') dst[di] = 1;
        else dst[di] = 0;
      }
    }
}

/**
 * Even-odd crossings of the local-XY line P(i) = (ax + i·bx, ay + i·by) with polygon `poly`;
 * pushes sorted parameters i into `out` (returned length).
 */
function lineCrossings(poly: Vec2[], ax: number, ay: number, bx: number, by: number, out: number[]): number {
  out.length = 0;
  const nx = -by;
  const ny = bx;
  const l2 = bx * bx + by * by;
  const n = poly.length;
  let pa = poly[n - 1];
  let sa = nx * (pa[0] - ax) + ny * (pa[1] - ay);
  for (let e = 0; e < n; e++) {
    const pb = poly[e];
    const sb = nx * (pb[0] - ax) + ny * (pb[1] - ay);
    if (sa > 0 !== sb > 0) {
      const tau = sa / (sa - sb);
      const cx = pa[0] + (pb[0] - pa[0]) * tau - ax;
      const cy = pa[1] + (pb[1] - pa[1]) * tau - ay;
      out.push((cx * bx + cy * by) / l2);
    }
    pa = pb;
    sa = sb;
  }
  out.sort((p, q) => p - q);
  return out.length;
}

/** Scanline rasterisation of a prism leaf (rows map to straight lines in the local frame). */
function rasterPrism(node: CLeaf, g: GridSpec, w: Win, lw: Win, out: Uint8Array): void {
  const s = node.s as PrismSolid;
  const m = node.inv;
  const h = g.h;
  const [ox, oy, oz] = g.origin;
  const ni = w.i1 - w.i0;
  const nj = w.j1 - w.j0;
  const bx = m[0] * h, by = m[4] * h, bz = m[8] * h;
  const holes = (s.holes ?? []).filter((p) => p.length >= 3);
  const width = lw.i1 - lw.i0;
  const outerD = new Int32Array(width + 1);
  const holeD = new Int32Array(width + 1);
  const xs: number[] = [];
  const x0 = ox + 0.5 * h;
  const axisRow = Math.abs(bx) + Math.abs(by) < 1e-12 * h;
  const mark = (d: Int32Array, sgn: number, lo: number, hi: number, t0: number, t1: number) => {
    const a = Math.max(lo, Math.floor(t0) + 1);
    const b = Math.min(hi, Math.ceil(t1));
    if (a < b) {
      d[a - lw.i0] += sgn;
      d[b - lw.i0] -= sgn;
    }
  };
  for (let k = lw.k0; k < lw.k1; k++) {
    const z = oz + (k + 0.5) * h;
    for (let j = lw.j0; j < lw.j1; j++) {
      const y = oy + (j + 0.5) * h;
      const ax = m[0] * x0 + m[1] * y + m[2] * z + m[3];
      const ay = m[4] * x0 + m[5] * y + m[6] * z + m[7];
      const az = m[8] * x0 + m[9] * y + m[10] * z + m[11];
      // local z ∈ [z0, z1)
      let lo = lw.i0;
      let hi = lw.i1;
      if (Math.abs(bz) < 1e-15) {
        if (az < s.z0 || az >= s.z1) continue;
      } else if (bz > 0) {
        lo = Math.max(lo, Math.ceil((s.z0 - az) / bz));
        hi = Math.min(hi, Math.ceil((s.z1 - az) / bz));
      } else {
        lo = Math.max(lo, Math.floor((s.z1 - az) / bz) + 1);
        hi = Math.min(hi, Math.floor((s.z0 - az) / bz) + 1);
      }
      if (lo >= hi) continue;
      const base = ni * ((j - w.j0) + nj * (k - w.k0)) - w.i0;
      if (axisRow) {
        if (node.test(ax, ay, s.z0)) for (let i = lo; i < hi; i++) out[base + i] = 1;
        continue;
      }
      outerD.fill(0);
      const nc = lineCrossings(s.outer, ax, ay, bx, by, xs);
      if (!nc) continue;
      for (let q = 0; q + 1 < nc; q += 2) mark(outerD, 1, lo, hi, xs[q], xs[q + 1]);
      let anyHole = false;
      if (holes.length) {
        holeD.fill(0);
        for (const hp of holes) {
          const hc = lineCrossings(hp, ax, ay, bx, by, xs);
          for (let q = 0; q + 1 < hc; q += 2) {
            mark(holeD, 1, lo, hi, xs[q], xs[q + 1]);
            anyHole = true;
          }
        }
      }
      let oc = 0;
      let hcnt = 0;
      for (let i = lo; i < hi; i++) {
        oc += outerD[i - lw.i0];
        if (anyHole) hcnt += holeD[i - lw.i0];
        if (oc > 0 && hcnt <= 0) out[base + i] = 1;
      }
    }
  }
}

/**
 * Row fast path for rrloft leaves whose grid rows run along local ±X or ±Y at constant local z
 * (shells placed with 90°-multiple rotations). Returns false when not applicable.
 */
function rasterRRLoft(node: CLeaf, g: GridSpec, w: Win, lw: Win, out: Uint8Array): boolean {
  const s = node.s as RRLoftSolid;
  const m = node.inv;
  const h = g.h;
  const bx = m[0] * h, by = m[4] * h, bz = m[8] * h;
  const eps = 1e-12 * h;
  const alongX = Math.abs(by) < eps && Math.abs(bx) > eps;
  const alongY = Math.abs(bx) < eps && Math.abs(by) > eps;
  if (Math.abs(bz) > eps || (!alongX && !alongY)) return false;
  const [ox, oy, oz] = g.origin;
  const ni = w.i1 - w.i0;
  const nj = w.j1 - w.j0;
  const x0 = ox + 0.5 * h;
  for (let k = lw.k0; k < lw.k1; k++) {
    const z = oz + (k + 0.5) * h;
    for (let j = lw.j0; j < lw.j1; j++) {
      const y = oy + (j + 0.5) * h;
      const ax = m[0] * x0 + m[1] * y + m[2] * z + m[3];
      const ay = m[4] * x0 + m[5] * y + m[6] * z + m[7];
      const az = m[8] * x0 + m[9] * y + m[10] * z + m[11];
      if (az < s.z0 || az >= s.z1) continue;
      const inset = rrloftInset(s, az);
      const hx = s.hx - inset;
      const hy = s.hy - inset;
      if (hx <= 0 || hy <= 0) continue;
      const r = Math.max(0, Math.min(s.r - inset, hx, hy));
      // fixed coordinate c across the row, half-extent along the row
      const c = alongX ? Math.abs(ay) : Math.abs(ax);
      const hAlong = alongX ? hx : hy;
      const hAcross = alongX ? hy : hx;
      if (c > hAcross) continue;
      const dc = c - (hAcross - r);
      const half = dc <= 0 ? hAlong : hAlong - r + Math.sqrt(Math.max(0, r * r - dc * dc));
      const a0 = alongX ? ax : ay;
      const b = alongX ? bx : by;
      let t0 = (-half - a0) / b;
      let t1 = (half - a0) / b;
      if (t0 > t1) [t0, t1] = [t1, t0];
      const lo = Math.max(lw.i0, Math.ceil(t0));
      const hi = Math.min(lw.i1 - 1, Math.floor(t1));
      const base = ni * ((j - w.j0) + nj * (k - w.k0)) - w.i0;
      for (let i = lo; i <= hi; i++) out[base + i] = 1;
    }
  }
  return true;
}

function rasterNode(node: CNode, g: GridSpec, w: Win): Uint8Array {
  const out = new Uint8Array(winSize(w));
  const ni = w.i1 - w.i0;
  const nj = w.j1 - w.j0;
  if (node.leaf) {
    const lw = winInter(w, bbWin(node.bb, g));
    if (!lw) return out;
    if (node.s.kind === 'prism') {
      rasterPrism(node, g, w, lw, out);
      return out;
    }
    if (node.s.kind === 'rrloft' && rasterRRLoft(node, g, w, lw, out)) return out;
    const m = node.inv;
    const [ox, oy, oz] = g.origin;
    const h = g.h;
    const test = node.test;
    for (let k = lw.k0; k < lw.k1; k++) {
      const z = oz + (k + 0.5) * h;
      for (let j = lw.j0; j < lw.j1; j++) {
        const y = oy + (j + 0.5) * h;
        const bx = m[1] * y + m[2] * z + m[3];
        const by = m[5] * y + m[6] * z + m[7];
        const bz = m[9] * y + m[10] * z + m[11];
        let idx = lw.i0 - w.i0 + ni * ((j - w.j0) + nj * (k - w.k0));
        for (let i = lw.i0; i < lw.i1; i++, idx++) {
          const x = ox + (i + 0.5) * h;
          if (test(m[0] * x + bx, m[4] * x + by, m[8] * x + bz)) out[idx] = 1;
        }
      }
    }
    return out;
  }
  if (node.op === 'union') {
    for (const c of node.children) {
      const cw = winInter(w, bbWin(c.bb, g));
      if (!cw) continue;
      blit(out, w, rasterNode(c, g, cw), cw, 'or');
    }
    return out;
  }
  if (node.op === 'difference') {
    const w0 = winInter(w, bbWin(node.children[0].bb, g));
    if (!w0) return out;
    const base = rasterNode(node.children[0], g, w0);
    for (const c of node.children.slice(1)) {
      const cw = winInter(w0, bbWin(c.bb, g));
      if (!cw) continue;
      blit(base, w0, rasterNode(c, g, cw), cw, 'clear');
    }
    blit(out, w, base, w0, 'or');
    return out;
  }
  // intersection
  let w0: Win | null = w;
  for (const c of node.children) w0 = w0 && winInter(w0, bbWin(c.bb, g));
  if (!w0) return out;
  const acc = rasterNode(node.children[0], g, w0);
  for (const c of node.children.slice(1)) {
    const m2 = rasterNode(c, g, w0);
    for (let q = 0; q < acc.length; q++) if (!m2[q]) acc[q] = 0;
  }
  blit(out, w, acc, w0, 'or');
  return out;
}

/** Rasterise a solid (cell-centre sampling) into a full-grid 0/1 mask (index i + nx·(j + ny·k)). */
export function rasterizeSolid(s: Solid | CNode | null, g: GridSpec, m?: Mat4): Uint8Array {
  const node = s && ('leaf' in s ? s : compileSolid(s, m));
  const full: Win = { i0: 0, i1: g.nx, j0: 0, j1: g.ny, k0: 0, k1: g.nz };
  if (!node) return new Uint8Array(g.nx * g.ny * g.nz);
  return rasterNode(node, g, full);
}

/** Rasterise only within a sub-box (returns mask over the window plus the window). */
export function rasterizeSolidWindow(node: CNode | null, g: GridSpec, region: BBox3): { mask: Uint8Array; win: Win } | null {
  if (!node) return null;
  const w = bbWin(region, g);
  if (!w) return null;
  return { mask: rasterNode(node, g, w), win: w };
}

/** Build a grid covering a bbox with cell size h (+ pad cells). */
export function gridForBBox(b: BBox3, h: number, pad = 0): GridSpec {
  const n = (k: number) => Math.max(1, Math.ceil((b.max[k] - b.min[k]) / h - 1e-9) + 2 * pad);
  const nx = n(0), ny = n(1), nz = n(2);
  // centre the grid on the bbox
  const origin: Vec3 = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2 - ([nx, ny, nz][k] * h) / 2) as Vec3;
  return { nx, ny, nz, h, origin };
}

/**
 * Fast volume/centroid estimate by rasterisation (≈ targetCells samples). Accuracy is typically a
 * few percent for walls ≥ 3 cells thick; use mesh-based massProperties for exact values.
 */
export function estimateSolidVolume(s: Solid, targetCells = 600_000): { volume: number; centroid: Vec3; bbox: BBox3 | null } {
  const node = compileSolid(s);
  if (!node) return { volume: 0, centroid: [0, 0, 0], bbox: null };
  const b = node.bb;
  const vol = Math.max(1e-9, (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]));
  // Several sub-cell-shifted grids are averaged: cell-centre sampling of thin walls aliases badly
  // (a 2 mm wall at h = 0.8 counts as 1.6 or 2.4 mm); shifting the sample lattice cancels that bias.
  const passes = 4;
  const h = Math.max(1e-3, Math.cbrt(vol / (targetCells / passes)));
  let total = 0, sx = 0, sy = 0, sz = 0;
  for (let p = 0; p < passes; p++) {
    const base = gridForBBox(b, h, 1);
    const off: Vec3 = [((p * 0.25 + 0.03) % 1) * h, ((p * 0.25 + 0.155) % 1) * h, ((p * 0.25 + 0.0925) % 1) * h];
    const g: GridSpec = { ...base, origin: [base.origin[0] + off[0], base.origin[1] + off[1], base.origin[2] + off[2]] };
    const mask = rasterizeSolid(node, g);
    for (let k = 0; k < g.nz; k++)
      for (let j = 0; j < g.ny; j++)
        for (let i = 0; i < g.nx; i++) {
          if (!mask[i + g.nx * (j + g.ny * k)]) continue;
          total++;
          sx += g.origin[0] + (i + 0.5) * h;
          sy += g.origin[1] + (j + 0.5) * h;
          sz += g.origin[2] + (k + 0.5) * h;
        }
  }
  const c: Vec3 = total ? [sx / total, sy / total, sz / total] : [0, 0, 0];
  return { volume: (total / passes) * h * h * h, centroid: c, bbox: b };
}

/* ------------------------------------------ manifold -------------------------------------------- */

function rrloftHullPoints(s: RRLoftSolid): Vec3[] {
  const seg = Math.max(2, Math.round(circleSegments(Math.max(s.r, 0.5)) / 4));
  const levels = new Set<number>([s.z0, s.z1]);
  const f = Math.min(s.fillet ?? 0, s.z1 - s.z0);
  if (f > 0) {
    const n = Math.max(3, seg);
    for (let i = 1; i <= n; i++) levels.add(s.z0 + f * (1 - Math.cos(((i / n) * Math.PI) / 2)));
  }
  if (s.zRef > s.z0 && s.zRef < s.z1) levels.add(s.zRef);
  const pts: Vec3[] = [];
  for (const z of [...levels].sort((a, b) => a - b)) {
    const inset = rrloftInset({ ...s, fillet: f }, z);
    const hx = s.hx - inset;
    const hy = s.hy - inset;
    if (hx <= 1e-6 || hy <= 1e-6) continue;
    for (const [x, y] of rrPoly(0, 0, hx, hy, Math.max(0, s.r - inset), seg)) pts.push([x, y, z]);
  }
  return pts;
}

/**
 * Build a manifold for the solid. All intermediate WASM objects are registered in `arena`; the
 * caller disposes the arena after extracting the mesh. Returns null for empty solids.
 */
export function solidToManifold(s: Solid, w: ManifoldToplevel, arena: Arena): Manifold | null {
  const { Manifold, CrossSection } = w;
  let man: Manifold | null = null;
  switch (s.kind) {
    case 'prism': {
      if (s.outer.length < 3 || !(s.z1 > s.z0)) return null;
      // even-odd per polygon (self-intersecting input behaves like pointInPoly), holes = union
      let cs = arena.add(new CrossSection([s.outer as [number, number][]], 'EvenOdd'));
      const holes = (s.holes ?? []).filter((h) => h.length >= 3);
      if (holes.length) {
        const hs = holes.map((h) => arena.add(new CrossSection([h as [number, number][]], 'EvenOdd')));
        cs = arena.add(cs.subtract(hs.length === 1 ? hs[0] : arena.add(CrossSection.union(hs))));
      }
      if (cs.isEmpty()) return null;
      man = arena.add(cs.extrude(s.z1 - s.z0));
      if (s.z0 !== 0) man = arena.add(man.translate([0, 0, s.z0]));
      break;
    }
    case 'rrloft': {
      const pts = rrloftHullPoints(s);
      if (pts.length < 4) return null;
      man = arena.add(Manifold.hull(pts));
      break;
    }
    case 'box': {
      const [sx, sy, sz] = s.size;
      if (!(sx > 0 && sy > 0 && sz > 0)) return null;
      const r = Math.max(0, Math.min(s.radius ?? 0, sx / 2, sy / 2, sz / 2));
      if (r > 1e-6) {
        const sph = arena.add(Manifold.sphere(r, circleSegments(r)));
        const c0: Vec3 = s.center ? [-sx / 2 + r, -sy / 2 + r, -sz / 2 + r] : [r, r, r];
        const c1: Vec3 = s.center ? [sx / 2 - r, sy / 2 - r, sz / 2 - r] : [sx - r, sy - r, sz - r];
        const corners: Manifold[] = [];
        for (let c = 0; c < 8; c++) corners.push(arena.add(sph.translate([c & 1 ? c1[0] : c0[0], c & 2 ? c1[1] : c0[1], c & 4 ? c1[2] : c0[2]])));
        man = arena.add(Manifold.hull(corners));
      } else man = arena.add(Manifold.cube([sx, sy, sz], !!s.center));
      break;
    }
    case 'cylinder': {
      if (!(s.h > 0) || !(Math.max(s.r0, s.r1) > 0)) return null;
      man = arena.add(Manifold.cylinder(s.h, Math.max(0, s.r0), Math.max(0, s.r1), s.segments ?? circleSegments(Math.max(s.r0, s.r1)), !!s.center));
      break;
    }
    case 'sphere':
      if (!(s.r > 0)) return null;
      man = arena.add(Manifold.sphere(s.r, s.segments ?? circleSegments(s.r)));
      break;
    case 'revolve': {
      if (s.profile.length < 3) return null;
      const cs = arena.add(new CrossSection([s.profile as [number, number][]], 'EvenOdd'));
      const rmax = Math.max(...s.profile.map((p) => p[0]));
      man = arena.add(cs.revolve(s.segments ?? circleSegments(rmax)));
      break;
    }
    case 'union': {
      const parts = s.children.map((c) => solidToManifold(c, w, arena)).filter((x): x is Manifold => !!x && !x.isEmpty());
      if (!parts.length) return null;
      man = parts.length === 1 ? parts[0] : arena.add(Manifold.union(parts));
      break;
    }
    case 'difference': {
      if (!s.children.length) return null;
      const base = solidToManifold(s.children[0], w, arena);
      if (!base) return null;
      const cut = s.children.slice(1).map((c) => solidToManifold(c, w, arena)).filter((x): x is Manifold => !!x && !x.isEmpty());
      man = cut.length ? arena.add(base.subtract(cut.length === 1 ? cut[0] : arena.add(Manifold.union(cut)))) : base;
      break;
    }
    case 'intersection': {
      const parts = s.children.map((c) => solidToManifold(c, w, arena));
      if (!parts.length || parts.some((p) => !p || p.isEmpty())) return null;
      man = parts.length === 1 ? parts[0]! : arena.add(Manifold.intersection(parts as Manifold[]));
      break;
    }
  }
  if (man && s.m && !isIdentity(s.m)) man = arena.add(man.transform(toColumnMajor(s.m) as unknown as Parameters<Manifold['transform']>[0]));
  return man;
}
