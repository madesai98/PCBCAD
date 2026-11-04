/**
 * Sheet-metal model shared by the 3D solid, the flat pattern and the DFM checker.
 *
 * Conventions (all lengths mm, angles degrees):
 *  - Base: rectangle base.width (X) × base.length (Y) centred at the origin, z ∈ [0, thickness].
 *    Its edges are the OUTER VIRTUAL SHARPS of any bends on them: for a 90° flange on '+x' the
 *    flange's outer face lies exactly at x = +width/2, so the part's outside dimensions equal the
 *    base dimensions. The flat region of the base stops at the bend tangent line, setback
 *    OSSB = (r + t)·tan(|θ|/2) inside the edge.
 *  - Flange `length` L = distance along the flange's outer surface from the outer virtual sharp
 *    (intersection of the parent's and the flange's outer surfaces) to the flange's free edge
 *    (for 90° bends: the outside height). The straight (flat) portion is L − OSSB (− OSSB of a
 *    nested bend at its far edge).
 *  - Angle sign: positive bends toward the side of the sheet that continues the base's top (+Z)
 *    surface: base flanges bend up (+Z); a positive nested ('far') flange on an up-bent flange
 *    returns toward the part interior (C-channel), a negative one turns outward (hat/Z profile).
 *  - Flange-local hole coordinates: x = u along the edge, measured from the flange centre (edge
 *    midpoint + offset), positive along +Y for ±x edges and +X for ±y edges (nested flanges inherit
 *    the parent's u); y = v measured along the flange from the parent's outer surface (the virtual
 *    sharp line).
 *  - Flange width defaults to the available edge length: the full edge, minus (adjacent setback +
 *    corner gap) where the adjacent edge also carries a flange. Where two flanged edges meet, the base
 *    corner is notched (corner relief). Where a bend ends inside an edge (partial-width flange) a relief
 *    slot of width max(t, 0.5) is cut to depth OSSB + max(t, 0.5) from the edge ('rect'), or with a
 *    round end ('obround'); reliefs: 'none' omits them (DFM flags the tearing risk).
 *    processOptions overrides: reliefWidth, reliefDepth (beyond the tangent line), cornerGap.
 *  - Bend allowance BA = π/180·|θ|·(r + K·t); flat length = Σ flat lengths + Σ BA
 *    (= Σ outer lengths − Σ BD with BD = 2·OSSB − BA).
 */
import type { SheetFlange, SheetHole, SheetMetalPart, Vec2, Vec3 } from '@pcbcad/core';
import { mat4FromBasis, v3 } from './mat';
import { circlePoly, mapPoly, rectPoly, stadiumPoly } from './poly';
import { prism, union, type Solid } from './solid';
import { rectMinusRects, unionTiles, type ARect } from './tiles';

export interface SheetIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  suggestion?: string;
  flangeId?: string;
  holeId?: string;
}

export interface Edge2 {
  name: string;
  /** Midpoint of the edge on the virtual-sharp line (face coords). */
  pos: Vec2;
  /** Unit vector along the edge (= child u direction). */
  dir: Vec2;
  /** Outward unit normal (in-plane). */
  nrm: Vec2;
  halfLen: number;
}

export interface SheetHoleModel {
  hole: SheetHole;
  faceId: string;
  /** Outline in face coords. */
  poly: Vec2[];
  center: Vec2;
  /** Smallest dimension (diameter / min(width, height)). */
  minDim: number;
  circle?: { c: Vec2; d: number };
}

export interface SheetFaceModel {
  id: string;
  flange?: SheetFlange;
  parentId?: string;
  depth: number;
  /** 3D frame of the bottom surface: P(u, n, w) = o + u·eu + n·en + w·ez, w ∈ [0, t]. */
  o: Vec3;
  eu: Vec3;
  en: Vec3;
  ez: Vec3;
  /** Flat-pattern frame: F(u, n) = fo + u·feu + n·fen. */
  fo: Vec2;
  feu: Vec2;
  fen: Vec2;
  rect: ARect;
  removals: ARect[];
  obround: { a: Vec2; b: Vec2; bulge: Vec2 }[];
  poly: Vec2[];
  voids: Vec2[][];
  holes: SheetHoleModel[];
  /** Outer setback of the bend that created this face (0 for the base). */
  setback: number;
  /** Flange outer length L (flanges only). */
  length?: number;
  /** Bend tangent segments on this face (face coords). */
  bendEdges: { a: Vec2; b: Vec2; bendId: string; radius: number; angle: number }[];
  edges: Edge2[];
}

export interface SheetBendModel {
  id: string;
  parentId: string;
  childId: string;
  /** Signed bend angle (deg). */
  angle: number;
  radius: number;
  thickness: number;
  kFactor: number;
  /** Outer setback OSSB = (r + t)·tan(|θ|/2). */
  setback: number;
  /** Bend allowance BA = π/180·|θ|·(r + K·t). */
  allowance: number;
  uA: number;
  uB: number;
  edge: Edge2;
  solid: Solid;
  /** Bend zone in the flat pattern and its centre line. */
  strip: Vec2[];
  line: [Vec2, Vec2];
}

export interface SheetModel {
  part: SheetMetalPart;
  t: number;
  faces: SheetFaceModel[];
  bends: SheetBendModel[];
  issues: SheetIssue[];
  reliefWidth: number;
  reliefDepth: number;
  cornerGap: number;
}

const D2R = Math.PI / 180;

export function bendAllowance(angleDeg: number, r: number, t: number, k: number): number {
  return D2R * Math.abs(angleDeg) * (r + k * t);
}

export function outsideSetback(angleDeg: number, r: number, t: number): number {
  return (r + t) * Math.tan((D2R * Math.abs(angleDeg)) / 2);
}

/** Bend deduction BD = 2·OSSB − BA (flat = Σ outer lengths − Σ BD). */
export function bendDeduction(angleDeg: number, r: number, t: number, k: number): number {
  return 2 * outsideSetback(angleDeg, r, t) - bendAllowance(angleDeg, r, t, k);
}

function add2(a: Vec2, b: Vec2, s = 1): Vec2 {
  return [a[0] + b[0] * s, a[1] + b[1] * s];
}

/** Axis-aligned rect spanned by pos + u·dir − s·nrm for u ∈ [uA,uB], s ∈ [s0,s1]. */
function edgeRect(e: Edge2, uA: number, uB: number, s0: number, s1: number): ARect {
  const p = add2(add2(e.pos, e.dir, uA), e.nrm, -s0);
  const q = add2(add2(e.pos, e.dir, uB), e.nrm, -s1);
  return [Math.min(p[0], q[0]), Math.max(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[1], q[1])];
}

function face3(f: SheetFaceModel, p: Vec2): Vec3 {
  return v3.add(v3.add(f.o, v3.scale(f.eu, p[0])), v3.scale(f.en, p[1]));
}

function face2to3dir(f: SheetFaceModel, d: Vec2): Vec3 {
  return v3.add(v3.scale(f.eu, d[0]), v3.scale(f.en, d[1]));
}

function flat2(f: SheetFaceModel, p: Vec2): Vec2 {
  return [f.fo[0] + p[0] * f.feu[0] + p[1] * f.fen[0], f.fo[1] + p[0] * f.feu[1] + p[1] * f.fen[1]];
}

function flatDir(f: SheetFaceModel, d: Vec2): Vec2 {
  return [d[0] * f.feu[0] + d[1] * f.fen[0], d[0] * f.feu[1] + d[1] * f.fen[1]];
}

function holeModel(h: SheetHole, faceId: string, cx: number, cy: number, issues: SheetIssue[]): SheetHoleModel | null {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  if (h.shape === 'circle') {
    const d = Number(h.diameter ?? h.width);
    if (!(d > 0)) {
      issues.push({ code: 'hole-size', severity: 'error', message: `Hole ${h.id}: circle without a positive diameter`, holeId: h.id });
      return null;
    }
    return { hole: h, faceId, poly: circlePoly(cx, cy, d / 2), center: [cx, cy], minDim: d, circle: { c: [cx, cy], d } };
  }
  const w = Number(h.width ?? h.diameter);
  const ht = Number(h.height ?? h.diameter ?? h.width);
  if (!(w > 0) || !(ht > 0)) {
    issues.push({ code: 'hole-size', severity: 'error', message: `Hole ${h.id}: ${h.shape} needs positive width and height`, holeId: h.id });
    return null;
  }
  const poly = h.shape === 'slot' ? stadiumPoly(cx, cy, w, ht) : rectPoly(cx, cy, w, ht);
  return { hole: h, faceId, poly, center: [cx, cy], minDim: Math.min(w, ht) };
}

/** Insert a semicircle between consecutive vertices a,b of the loop (bulging toward `bulge`). */
function insertArc(loop: Vec2[], a: Vec2, b: Vec2, bulge: Vec2, tol = 1e-6): Vec2[] {
  const near = (p: Vec2, q: Vec2) => Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % n];
    let from: Vec2 | null = null;
    if (near(p, a) && near(q, b)) from = a;
    else if (near(p, b) && near(q, a)) from = b;
    if (!from) continue;
    const to = from === a ? b : a;
    const c: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const r = Math.hypot(a[0] - b[0], a[1] - b[1]) / 2;
    if (r < 1e-6) return loop;
    const uf: Vec2 = [(from[0] - c[0]) / r, (from[1] - c[1]) / r];
    const seg = Math.max(4, Math.ceil((Math.PI * r) / 0.3));
    const arc: Vec2[] = [];
    for (let k = 1; k < seg; k++) {
      const phi = (Math.PI * k) / seg;
      arc.push([c[0] + r * (Math.cos(phi) * uf[0] + Math.sin(phi) * bulge[0]), c[1] + r * (Math.cos(phi) * uf[1] + Math.sin(phi) * bulge[1])]);
    }
    void to;
    return [...loop.slice(0, i + 1), ...arc, ...loop.slice(i + 1)];
  }
  return loop;
}

/** Round a convex 90°-ish corner vertex `p` of a CCW loop with radius r (if present and edges long enough). */
function roundCorner(loop: Vec2[], p: Vec2, r: number, tol = 1e-6): Vec2[] {
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const q = loop[i];
    if (Math.abs(q[0] - p[0]) > tol || Math.abs(q[1] - p[1]) > tol) continue;
    const prev = loop[(i - 1 + n) % n];
    const next = loop[(i + 1) % n];
    const d1: Vec2 = [prev[0] - q[0], prev[1] - q[1]];
    const d2: Vec2 = [next[0] - q[0], next[1] - q[1]];
    const l1 = Math.hypot(d1[0], d1[1]);
    const l2 = Math.hypot(d2[0], d2[1]);
    const cross = (q[0] - prev[0]) * (next[1] - q[1]) - (q[1] - prev[1]) * (next[0] - q[0]);
    if (cross <= 0) return loop; // concave
    const rr = Math.min(r, l1 * 0.999, l2 * 0.999);
    if (rr < 1e-6) return loop;
    const u1: Vec2 = [d1[0] / l1, d1[1] / l1];
    const u2: Vec2 = [d2[0] / l2, d2[1] / l2];
    const c: Vec2 = [q[0] + (u1[0] + u2[0]) * rr, q[1] + (u1[1] + u2[1]) * rr];
    const a0 = Math.atan2(q[1] + u1[1] * rr - c[1], q[0] + u1[0] * rr - c[0]);
    let a1 = Math.atan2(q[1] + u2[1] * rr - c[1], q[0] + u2[0] * rr - c[0]);
    // CCW loop, convex corner → arc runs clockwise? determine shortest signed sweep
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    a1 = a0 + sweep;
    const seg = Math.max(2, Math.ceil((Math.abs(sweep) * rr) / 0.3));
    const arc: Vec2[] = [];
    for (let k = 0; k <= seg; k++) {
      const a = a0 + (sweep * k) / seg;
      arc.push([c[0] + rr * Math.cos(a), c[1] + rr * Math.sin(a)]);
    }
    return [...loop.slice(0, i), ...arc, ...loop.slice(i + 1)];
  }
  return loop;
}

interface BuildCtx {
  part: SheetMetalPart;
  t: number;
  k: number;
  faces: SheetFaceModel[];
  bends: SheetBendModel[];
  issues: SheetIssue[];
  rw: number;
  rdx: number;
  cgap: number;
  reliefs: 'rect' | 'obround' | 'none';
}

function bendParams(fl: SheetFlange, c: BuildCtx): { theta: number; r: number; sb: number; ba: number } | null {
  const theta = Number(fl.angle);
  const r = Number(fl.bendRadius ?? c.part.bendRadius);
  if (!Number.isFinite(theta) || Math.abs(theta) < 0.5) {
    c.issues.push({ code: 'bend-angle', severity: 'error', message: `Flange ${fl.id}: bend angle ${fl.angle}° is not a bend (|angle| must be ≥ 0.5°)`, flangeId: fl.id });
    return null;
  }
  if (Math.abs(theta) > 175) {
    c.issues.push({
      code: 'bend-angle',
      severity: 'error',
      message: `Flange ${fl.id}: ${theta}° is a hem/closed bend, which is not modelled`,
      suggestion: 'Use ≤ 175° (or model a hem as two 90° bends with a 0-radius return) and specify a hem in the drawing notes.',
      flangeId: fl.id,
    });
    return null;
  }
  if (!(r >= 0) || !Number.isFinite(r)) {
    c.issues.push({ code: 'bend-radius', severity: 'error', message: `Flange ${fl.id}: invalid bend radius ${r}`, flangeId: fl.id });
    return null;
  }
  return { theta, r, sb: outsideSetback(theta, r, c.t), ba: bendAllowance(theta, r, c.t, c.k) };
}

function newFace(id: string, partial: Partial<SheetFaceModel> & Pick<SheetFaceModel, 'o' | 'eu' | 'en' | 'ez' | 'fo' | 'feu' | 'fen' | 'rect'>): SheetFaceModel {
  return {
    id,
    depth: 0,
    removals: [],
    obround: [],
    poly: [],
    voids: [],
    holes: [],
    setback: 0,
    bendEdges: [],
    edges: [],
    ...partial,
  };
}

/** Bend `fl` off edge `e` of `parent` over [uA, uB]; creates the child face + bend and recurses. */
function addFlange(c: BuildCtx, parent: SheetFaceModel, e: Edge2, fl: SheetFlange, uA: number, uB: number, avail: [number, number], bp: { theta: number; r: number; sb: number; ba: number }): void {
  const { theta, r, sb, ba } = bp;
  const t = c.t;
  // bend zone + reliefs on the parent
  parent.removals.push(edgeRect(e, uA, uB, 0, sb));
  const partial = uA > avail[0] + 1e-6 || uB < avail[1] - 1e-6;
  if (partial && c.reliefs !== 'none') {
    const depth = sb + c.rdx;
    const mk = (lo: number, hi: number) => {
      const w = hi - lo;
      if (w <= 1e-6) return;
      if (c.reliefs === 'obround' && depth > w / 2) {
        const d0 = depth - w / 2;
        parent.removals.push(edgeRect(e, lo, hi, 0, d0));
        parent.obround.push({ a: add2(add2(e.pos, e.dir, lo), e.nrm, -d0), b: add2(add2(e.pos, e.dir, hi), e.nrm, -d0), bulge: [-e.nrm[0], -e.nrm[1]] });
      } else parent.removals.push(edgeRect(e, lo, hi, 0, depth));
    };
    if (uA > avail[0] + 1e-6) mk(Math.max(avail[0], uA - c.rw), uA);
    if (uB < avail[1] - 1e-6) mk(uB, Math.min(avail[1], uB + c.rw));
  } else if (partial) {
    c.issues.push({
      code: 'bend-relief',
      severity: 'warning',
      message: `Flange ${fl.id} is narrower than its edge but reliefs are 'none' — the sheet will tear/bulge at the bend ends`,
      suggestion: `Set reliefs: 'rect' or 'obround' (width ≥ ${t} mm = t, depth ≥ r + t = ${(r + t).toFixed(2)} mm), or make the flange full width.`,
      flangeId: fl.id,
    });
  }

  const tp = (u: number): Vec2 => add2(add2(e.pos, e.nrm, -sb), e.dir, u);
  parent.bendEdges.push({ a: tp(uA), b: tp(uB), bendId: fl.id, radius: r, angle: theta });

  const uc = (uA + uB) / 2;
  const w = uB - uA;
  const nrm3 = face2to3dir(parent, e.nrm);
  const dir3 = face2to3dir(parent, e.dir);
  const th = theta * D2R;
  const P = face3(parent, tp(uc));
  const A = theta > 0 ? v3.madd(P, parent.ez, t + r) : v3.madd(P, parent.ez, -r);
  const en = v3.add(v3.scale(nrm3, Math.cos(th)), v3.scale(parent.ez, Math.sin(th)));
  const ez = v3.add(v3.scale(nrm3, -Math.sin(th)), v3.scale(parent.ez, Math.cos(th)));
  const o = theta > 0 ? v3.madd(A, ez, -(r + t)) : v3.madd(A, ez, r);
  const fnrm = flatDir(parent, e.nrm);
  const fdir = flatDir(parent, e.dir);
  const fo = add2(flat2(parent, tp(uc)), fnrm, ba);

  const L = Number(fl.length);
  let len = L - sb;
  if (!Number.isFinite(L) || len < 0.05) {
    c.issues.push({
      code: 'flange-too-short',
      severity: 'error',
      message: `Flange ${fl.id}: length ${fl.length} mm is not longer than its bend setback ${sb.toFixed(2)} mm (no straight portion)`,
      suggestion: `Increase length to at least ${(sb + Math.max(2 * t, 1)).toFixed(1)} mm or reduce the bend radius/angle.`,
      flangeId: fl.id,
    });
    len = Math.max(0.05, Number.isFinite(len) ? len : 0.05);
  }
  const child = newFace(fl.id, {
    flange: fl,
    parentId: parent.id,
    depth: parent.depth + 1,
    o,
    eu: dir3,
    en,
    ez,
    fo,
    feu: fdir,
    fen: fnrm,
    rect: [-w / 2, w / 2, 0, len],
    setback: sb,
    length: L,
  });
  child.bendEdges.push({ a: [-w / 2, 0], b: [w / 2, 0], bendId: fl.id, radius: r, angle: theta });
  const far: Edge2 = { name: 'far', pos: [0, len], dir: [1, 0], nrm: [0, 1], halfLen: w / 2 };
  child.edges.push(far);
  c.faces.push(child);

  // bend solid (cross-section in (along nrm from the tangent line, along ez from the bottom surface))
  const segs = Math.max(4, Math.min(48, Math.ceil((Math.abs(th) * (r + t)) / 0.35), Math.ceil(Math.abs(theta) / 7.5)));
  const outerArc: Vec2[] = [];
  const innerArc: Vec2[] = [];
  for (let i = 0; i <= segs; i++) {
    const phi = (Math.abs(th) * i) / segs;
    if (theta > 0) {
      outerArc.push([(r + t) * Math.sin(phi), t + r - (r + t) * Math.cos(phi)]);
      innerArc.push([r * Math.sin(phi), t + r - r * Math.cos(phi)]);
    } else {
      outerArc.push([(r + t) * Math.sin(phi), -r + (r + t) * Math.cos(phi)]);
      innerArc.push([r * Math.sin(phi), -r + r * Math.cos(phi)]);
    }
  }
  const section = [...outerArc, ...innerArc.reverse()];
  const solid = prism(section, uA, uB, mat4FromBasis(face3(parent, tp(0)), nrm3, parent.ez, dir3));
  const f0 = flat2(parent, tp(uA));
  const f1 = flat2(parent, tp(uB));
  const strip: Vec2[] = [f0, f1, add2(f1, fnrm, ba), add2(f0, fnrm, ba)];
  c.bends.push({
    id: fl.id,
    parentId: parent.id,
    childId: child.id,
    angle: theta,
    radius: r,
    thickness: t,
    kFactor: c.k,
    setback: sb,
    allowance: ba,
    uA,
    uB,
    edge: e,
    solid,
    strip,
    line: [add2(f0, fnrm, ba / 2), add2(f1, fnrm, ba / 2)],
  });

  // nested flanges
  const nested = fl.flanges ?? [];
  for (const nf of nested) {
    if (nf.edge !== 'far') {
      c.issues.push({ code: 'flange-edge', severity: 'error', message: `Nested flange ${nf.id} must use edge 'far' (got '${nf.edge}')`, flangeId: nf.id });
    }
  }
  processEdge(c, child, far, nested.filter((n) => n.edge === 'far'), [-w / 2, w / 2]);
}

/** Place flanges along one edge of a face (spans, overlap checks) and build them. */
function processEdge(c: BuildCtx, face: SheetFaceModel, e: Edge2, flanges: SheetFlange[], avail: [number, number]): void {
  const placed: [number, number][] = [];
  for (const fl of flanges) {
    const bp = bendParams(fl, c);
    if (!bp) continue;
    let uA: number;
    let uB: number;
    if (fl.width != null && Number.isFinite(fl.width) && fl.width > 0) {
      const off = Number(fl.offset ?? 0) || 0;
      uA = off - fl.width / 2;
      uB = off + fl.width / 2;
      if (uA < avail[0] - 1e-6 || uB > avail[1] + 1e-6) {
        c.issues.push({
          code: 'flange-width',
          severity: 'info',
          message: `Flange ${fl.id}: width ${fl.width} mm (offset ${off}) exceeds the available edge span [${avail[0].toFixed(2)}, ${avail[1].toFixed(2)}] and was clipped (corner reliefs / adjacent bends)`,
          flangeId: fl.id,
        });
      }
      uA = Math.max(uA, avail[0]);
      uB = Math.min(uB, avail[1]);
    } else {
      uA = avail[0];
      uB = avail[1];
    }
    if (uB - uA < Math.max(c.t, 0.5)) {
      c.issues.push({ code: 'flange-width', severity: 'error', message: `Flange ${fl.id}: no usable width on edge ${e.name} (span ${(uB - uA).toFixed(2)} mm)`, flangeId: fl.id });
      continue;
    }
    if (placed.some(([a, b]) => uA < b - 1e-6 && uB > a + 1e-6)) {
      c.issues.push({ code: 'flange-overlap', severity: 'error', message: `Flange ${fl.id} overlaps another flange on edge ${e.name}; skipped`, flangeId: fl.id });
      continue;
    }
    placed.push([uA, uB]);
    addFlange(c, face, e, fl, uA, uB, avail, bp);
  }
}

/** Build the shared sheet-metal model (faces, bends, issues). Pure JS. */
export function buildSheetModel(part: SheetMetalPart): SheetModel {
  const t = Number(part.thickness);
  const W = Number(part.base?.width);
  const Lb = Number(part.base?.length);
  if (!(t > 0) || !(W > 0) || !(Lb > 0)) throw new Error(`SheetMetalPart '${part.name ?? part.id}': thickness and base width/length must be positive`);
  const k = Number.isFinite(part.kFactor) ? Math.max(0, Math.min(1, part.kFactor)) : 0.44;
  const po = part.processOptions ?? {};
  const c: BuildCtx = {
    part,
    t,
    k,
    faces: [],
    bends: [],
    issues: [],
    rw: Math.max(0.05, Number(po.reliefWidth ?? Math.max(t, 0.5))),
    rdx: Math.max(0, Number(po.reliefDepth ?? Math.max(t, 0.5))),
    cgap: Math.max(0.05, Number(po.cornerGap ?? Math.max(0.5 * t, 0.3))),
    reliefs: part.reliefs ?? 'rect',
  };
  const base = newFace('base', {
    o: [0, 0, 0],
    eu: [1, 0, 0],
    en: [0, 1, 0],
    ez: [0, 0, 1],
    fo: [0, 0],
    feu: [1, 0],
    fen: [0, 1],
    rect: [-W / 2, W / 2, -Lb / 2, Lb / 2],
  });
  c.faces.push(base);
  const edges: Record<'+x' | '-x' | '+y' | '-y', Edge2> = {
    '+x': { name: '+x', pos: [W / 2, 0], dir: [0, 1], nrm: [1, 0], halfLen: Lb / 2 },
    '-x': { name: '-x', pos: [-W / 2, 0], dir: [0, 1], nrm: [-1, 0], halfLen: Lb / 2 },
    '+y': { name: '+y', pos: [0, Lb / 2], dir: [1, 0], nrm: [0, 1], halfLen: W / 2 },
    '-y': { name: '-y', pos: [0, -Lb / 2], dir: [1, 0], nrm: [0, -1], halfLen: W / 2 },
  };
  base.edges.push(...Object.values(edges));
  const adj: Record<string, [string, string]> = { '+x': ['-y', '+y'], '-x': ['-y', '+y'], '+y': ['-x', '+x'], '-y': ['-x', '+x'] };
  const byEdge = new Map<string, SheetFlange[]>();
  for (const fl of part.flanges ?? []) {
    if (!(fl.edge in edges)) {
      c.issues.push({ code: 'flange-edge', severity: 'error', message: `Base flange ${fl.id} uses edge '${fl.edge}' — base flanges must be on '+x', '-x', '+y' or '-y'`, flangeId: fl.id });
      continue;
    }
    byEdge.set(fl.edge, [...(byEdge.get(fl.edge) ?? []), fl]);
  }
  const sbMax = (name: string) => {
    let m = 0;
    for (const fl of byEdge.get(name) ?? []) {
      const r = Number(fl.bendRadius ?? part.bendRadius);
      const th = Number(fl.angle);
      if (Number.isFinite(th) && Math.abs(th) >= 0.5 && Math.abs(th) <= 175 && r >= 0) m = Math.max(m, outsideSetback(th, r, t));
    }
    return byEdge.has(name) ? m : -1;
  };
  // corner notches where two flanged edges meet
  const corners: { x: '+x' | '-x'; y: '+y' | '-y' }[] = [
    { x: '+x', y: '+y' },
    { x: '-x', y: '+y' },
    { x: '-x', y: '-y' },
    { x: '+x', y: '-y' },
  ];
  const notched = new Set<string>();
  for (const cn of corners) {
    const sx = sbMax(cn.x);
    const sy = sbMax(cn.y);
    if (sx < 0 || sy < 0) continue;
    const X = cn.x === '+x' ? W / 2 : -W / 2;
    const Y = cn.y === '+y' ? Lb / 2 : -Lb / 2;
    const ix = X - Math.sign(X) * (sx + c.cgap);
    const iy = Y - Math.sign(Y) * (sy + c.cgap);
    base.removals.push([Math.min(X, ix), Math.max(X, ix), Math.min(Y, iy), Math.max(Y, iy)]);
    notched.add(`${cn.x}${cn.y}`);
  }
  for (const name of ['+x', '-x', '+y', '-y'] as const) {
    const fls = byEdge.get(name);
    if (!fls?.length) continue;
    const e = edges[name];
    const [aS, aE] = adj[name];
    const s0 = sbMax(aS);
    const s1 = sbMax(aE);
    const avail: [number, number] = [-e.halfLen + (s0 >= 0 ? s0 + c.cgap : 0), e.halfLen - (s1 >= 0 ? s1 + c.cgap : 0)];
    processEdge(c, base, e, fls, avail);
  }

  // holes
  for (const h of part.holes ?? []) {
    const hm = holeModel(h, 'base', Number(h.x), Number(h.y), c.issues);
    if (hm) base.holes.push(hm);
  }
  for (const f of c.faces) {
    if (!f.flange) continue;
    for (const h of f.flange.holes ?? []) {
      const hm = holeModel(h, f.id, Number(h.x), Number(h.y) - f.setback, c.issues);
      if (hm) f.holes.push(hm);
    }
  }

  // face outlines
  const cr = Math.max(0, Number(part.base?.cornerRadius ?? 0) || 0);
  for (const f of c.faces) {
    const u = rectMinusRects(f.rect, f.removals);
    let loop = u.outer[0] ?? [];
    if (u.outer.length > 1)
      c.issues.push({ code: 'face-split', severity: 'error', message: `Face ${f.id} is split into ${u.outer.length} pieces by reliefs/bend zones`, flangeId: f.flange?.id });
    for (const ob of f.obround) loop = insertArc(loop, ob.a, ob.b, ob.bulge);
    if (f.id === 'base' && cr > 0) {
      const corner: [string, Vec2][] = [
        ['+x+y', [W / 2, Lb / 2]],
        ['-x+y', [-W / 2, Lb / 2]],
        ['-x-y', [-W / 2, -Lb / 2]],
        ['+x-y', [W / 2, -Lb / 2]],
      ];
      for (const [key, p] of corner) if (!notched.has(key)) loop = roundCorner(loop, p, cr);
    }
    f.poly = loop;
    f.voids = u.holes;
  }
  return { part, t, faces: c.faces, bends: c.bends, issues: c.issues, reliefWidth: c.rw, reliefDepth: c.rdx, cornerGap: c.cgap };
}

/** 3D solid of a sheet-metal part (union of flat faces and cylindrical bend zones). */
export function sheetSolid(model: SheetModel): Solid {
  const parts: Solid[] = [];
  for (const f of model.faces) {
    if (f.poly.length < 3) continue;
    parts.push(prism(f.poly, 0, model.t, mat4FromBasis(f.o, f.eu, f.en, f.ez), [...f.voids, ...f.holes.map((h) => h.poly)]));
  }
  for (const b of model.bends) parts.push(b.solid);
  return union(parts);
}

/** Flat pattern of a sheet-metal part (see FlatPattern in index docs). */
export interface FlatPattern {
  /** Outer cut contour (CCW), flat-pattern frame = base frame (base centred at the origin, top surface up). */
  outline: Vec2[];
  /** Inner cut contours (holes, internal voids), each a closed polygon. */
  holes: Vec2[][];
  /** Circle metadata for round holes, parallel to `holes` (null for non-circular contours). */
  holeCircles: ({ center: Vec2; diameter: number } | null)[];
  bendLines: { a: Vec2; b: Vec2; angle: number; radius: number; direction: 'up' | 'down'; allowance: number; id?: string }[];
  /** Bounding-box size [x, y] of the outline. */
  size: [number, number];
  /** Net area (outline − holes), mm². */
  areaMm2: number;
  /** Bounding box of the outline. */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Messages from the model (e.g. clipped flanges). */
  warnings: string[];
}

export function flatFromModel(model: SheetModel): FlatPattern {
  const tiles: Vec2[][] = [];
  for (const f of model.faces) if (f.poly.length >= 3) tiles.push(mapPoly(f.poly, f.fo, f.feu, f.fen));
  for (const b of model.bends) tiles.push(b.strip);
  const u = unionTiles(tiles);
  const outline = u.outer[0] ?? [];
  const holes: Vec2[][] = [];
  const holeCircles: FlatPattern['holeCircles'] = [];
  for (const h of u.holes) {
    holes.push(h);
    holeCircles.push(null);
  }
  for (const loop of u.outer.slice(1)) {
    holes.push(loop);
    holeCircles.push(null);
  }
  for (const f of model.faces) {
    for (const v of f.voids) {
      holes.push(mapPoly(v, f.fo, f.feu, f.fen));
      holeCircles.push(null);
    }
    for (const h of f.holes) {
      holes.push(mapPoly(h.poly, f.fo, f.feu, f.fen));
      holeCircles.push(h.circle ? { center: flat2(f, h.circle.c), diameter: h.circle.d } : null);
    }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of outline) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!outline.length) minX = minY = maxX = maxY = 0;
  const area = (p: Vec2[]) => {
    let a = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1];
    return Math.abs(a / 2);
  };
  const areaMm2 = area(outline) - holes.reduce((s, h) => s + area(h), 0);
  return {
    outline,
    holes,
    holeCircles,
    bendLines: model.bends.map((b) => ({ a: b.line[0], b: b.line[1], angle: Math.abs(b.angle), radius: b.radius, direction: b.angle > 0 ? 'up' : 'down', allowance: b.allowance, id: b.id })),
    size: [maxX - minX, maxY - minY],
    areaMm2,
    bbox: { minX, minY, maxX, maxY },
    warnings: model.issues.map((i) => i.message),
  };
}

/**
 * Flat pattern (pure JS, no WASM needed): outline, holes, bend lines with allowances. The flat frame
 * is the base frame (top surface facing the viewer, base centred at the origin); flanges unfold
 * outward from their edges. Flat length across a bend = Σ straight lengths + BA.
 */
export function flatPattern(part: SheetMetalPart): FlatPattern {
  return flatFromModel(buildSheetModel(part));
}
