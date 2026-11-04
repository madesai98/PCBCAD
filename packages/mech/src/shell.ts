/**
 * Injection-molded enclosure shell → Solid IR.
 *
 * Frame (core contract): X/Y centred on the outer footprint, z = 0 at the outer surface of the
 * floor, inner floor at z = wall, open rim at z = outer.height.
 *
 * Geometry conventions implemented here (see README for drawings):
 *  - Outer body: rounded rectangle (outer.width × outer.depth, cornerRadius) extruded 0 → height.
 *    Draft (draftDeg) is applied geometrically unless processOptions.draftGeometry === false: the
 *    nominal outline is at the rim (z = height) and every wall surface tapers inward toward the floor
 *    by tan(draft) per mm, so the wall thickness stays uniform and the part releases along +Z.
 *  - Pocket: outline offset inward by `wall` (inner corner radius = cornerRadius − wall, ≥ 0), from
 *    z = wall (floor thickness = wall) through the rim. processOptions.innerFillet (mm) adds a
 *    floor-to-wall fillet.
 *  - lip: raised ring on the rim, flush with the inner wall face, `thickness` wide (outward) and
 *    `height` tall above the rim. groove: rebate cut into the rim at the inner edge, `thickness` wide
 *    and `height` deep — a groove of (lip + clearance) receives the mating lip.
 *  - Bosses rise from the inner floor (z = wall) by `height`; the hole runs from the boss top down
 *    to the inner floor (blind) or through the floor (`throughFloor`, with an outside counterbore
 *    sized from the fastener spec when known, else Ø 2×hole, depth 0.6×hole + 0.4). Gussets are
 *    triangular ribs (0.6×wall thick, 0.8×boss height tall at the boss).
 *  - Ribs: rectangular footprint `from`→`to` × thickness, from the inner floor up `height`.
 *    Bosses, gussets and ribs are clipped to the outer envelope.
 *  - Cutouts / vents / snap catch windows are cut through the wall along the face normal, using the
 *    face (u, v) convention of ShellCutout. Cutouts reaching above the rim become open notches.
 *  - Snap 'hook': cantilever of `thickness` (inward from the inner wall face) × `width`, rising
 *    `length` above the rim, with a hook at the tip protruding `overhang` outward (retaining face
 *    toward the rim, lead-in ramp to the tip). Hook height = clamp(2·overhang, 1, 0.5·length).
 *    Snap 'catch': matching window in the wall, v ∈ [H − length − 0.3, H − length + hookH + 0.3],
 *    width + 0.5 — i.e. the mating shell (rotated 180° about X onto this rim) catches the hook.
 */
import type { EnclosureShell, FastenerSpec, ShellBoss, ShellCutout, ShellFace, SnapFit, Vec2, Vec3, VentPattern } from '@pcbcad/core';
import { mat4FromBasis, v3 } from './mat';
import { boxPoly, circlePoly, polyBBox, rectPoly, rrPoly, stadiumPoly } from './poly';
import { difference, intersection, prism, union, type RRLoftSolid, type Solid } from './solid';

export interface ShellGeom {
  W: number;
  D: number;
  H: number;
  t: number;
  /** Outer / inner vertical corner radius. */
  R: number;
  Ri: number;
  /** tan(draft) if draft is applied geometrically, else 0. */
  slope: number;
  draftDeg: number;
  /** Floor-to-wall inner fillet radius. */
  fillet: number;
}

/** Validation errors that make the shell impossible to build (empty when OK). */
export function validateShell(s: EnclosureShell): string[] {
  const e: string[] = [];
  const pos = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!s.outer || !pos(s.outer.width) || !pos(s.outer.depth) || !pos(s.outer.height)) e.push('outer.width/depth/height must be positive numbers');
  if (!pos(s.wall)) e.push('wall must be a positive number');
  if (e.length) return e;
  if (2 * s.wall >= Math.min(s.outer.width, s.outer.depth)) e.push(`wall ${s.wall} mm leaves no interior in a ${s.outer.width}×${s.outer.depth} mm footprint`);
  if (s.wall >= s.outer.height) e.push(`wall ${s.wall} mm must be less than outer.height ${s.outer.height} mm (floor thickness = wall)`);
  return e;
}

export function shellGeom(s: EnclosureShell): ShellGeom {
  const errs = validateShell(s);
  if (errs.length) throw new Error(`EnclosureShell '${s.name ?? s.id}': ${errs.join('; ')}`);
  const W = s.outer.width;
  const D = s.outer.depth;
  const H = s.outer.height;
  const t = s.wall;
  const R = Math.max(0, Math.min(Number.isFinite(s.cornerRadius) ? s.cornerRadius : 0, W / 2, D / 2));
  const draftDeg = Number.isFinite(s.draftDeg) ? Math.max(0, Math.min(s.draftDeg, 15)) : 0;
  const applyDraft = s.processOptions?.draftGeometry !== false;
  const fillet = Math.max(0, Math.min(Number(s.processOptions?.innerFillet ?? 0) || 0, (H - t) / 2, Math.min(W, D) / 2 - t - 0.1));
  return { W, D, H, t, R, Ri: Math.max(0, R - t), slope: applyDraft ? Math.tan((draftDeg * Math.PI) / 180) : 0, draftDeg, fillet };
}

export function outerLoft(g: ShellGeom, z1 = g.H): RRLoftSolid {
  return { kind: 'rrloft', hx: g.W / 2, hy: g.D / 2, r: g.R, z0: 0, z1, zRef: g.H, slope: g.slope };
}

export function pocketLoft(g: ShellGeom): RRLoftSolid {
  return { kind: 'rrloft', hx: g.W / 2 - g.t, hy: g.D / 2 - g.t, r: g.Ri, z0: g.t, z1: g.H + 1, zRef: g.H, slope: g.slope, fillet: g.fillet || undefined };
}

/** Inner pocket outline (half sizes + corner radius) at height z (z ≥ wall). */
export function pocketAt(g: ShellGeom, z: number): { hx: number; hy: number; r: number } {
  let inset = g.slope * (g.H - z);
  if (g.fillet > 0 && z - g.t < g.fillet) {
    const q = g.fillet - Math.max(0, z - g.t);
    inset += g.fillet - Math.sqrt(Math.max(0, g.fillet * g.fillet - q * q));
  }
  return { hx: g.W / 2 - g.t - inset, hy: g.D / 2 - g.t - inset, r: Math.max(0, g.Ri - inset) };
}

/** Outer outline at height z. */
export function outerAt(g: ShellGeom, z: number): { hx: number; hy: number; r: number } {
  const inset = g.slope * (g.H - z);
  return { hx: g.W / 2 - inset, hy: g.D / 2 - inset, r: Math.max(0, g.R - inset) };
}

export interface FaceFrame {
  face: ShellFace;
  /** Point of the face plane at (u, v) = (0, 0) (nominal outline, i.e. at the rim for drafted walls). */
  o: Vec3;
  eu: Vec3;
  ev: Vec3;
  /** Outward unit normal. */
  nOut: Vec3;
  /** Half extent of the face along u (to the virtual sharp corner). */
  halfU: number;
}

export function faceFrame(g: ShellGeom, face: ShellFace): FaceFrame {
  switch (face) {
    case '+x':
      return { face, o: [g.W / 2, 0, 0], eu: [0, 1, 0], ev: [0, 0, 1], nOut: [1, 0, 0], halfU: g.D / 2 };
    case '-x':
      return { face, o: [-g.W / 2, 0, 0], eu: [0, 1, 0], ev: [0, 0, 1], nOut: [-1, 0, 0], halfU: g.D / 2 };
    case '+y':
      return { face, o: [0, g.D / 2, 0], eu: [1, 0, 0], ev: [0, 0, 1], nOut: [0, 1, 0], halfU: g.W / 2 };
    case '-y':
      return { face, o: [0, -g.D / 2, 0], eu: [1, 0, 0], ev: [0, 0, 1], nOut: [0, -1, 0], halfU: g.W / 2 };
    default:
      return { face: 'floor', o: [0, 0, 0], eu: [1, 0, 0], ev: [0, 1, 0], nOut: [0, 0, -1], halfU: g.W / 2 };
  }
}

/** Face-local profile of a cutout (u, v). Circle diameter = width; rounded-rect radius defaults to 0.25·min(w,h). */
export function cutoutProfile(c: ShellCutout): Vec2[] {
  const w = Math.max(0, c.width);
  const h = Math.max(0, c.height);
  switch (c.shape) {
    case 'circle':
      return circlePoly(c.u, c.v, w / 2);
    case 'slot':
      return stadiumPoly(c.u, c.v, w, h);
    case 'rounded-rect':
      return rrPoly(c.u, c.v, w / 2, h / 2, Math.min(c.radius ?? 0.25 * Math.min(w, h), w / 2, h / 2));
    default:
      return rectPoly(c.u, c.v, w, h);
  }
}

/** Cutout extents in face coordinates. Circles use width as diameter. */
export function cutoutExtents(c: ShellCutout): { u0: number; u1: number; v0: number; v1: number } {
  const w = Math.max(0, c.width);
  const h = c.shape === 'circle' ? w : Math.max(0, c.height);
  return { u0: c.u - w / 2, u1: c.u + w / 2, v0: c.v - h / 2, v1: c.v + h / 2 };
}

/** Individual slot profiles of a vent pattern (face-local). */
export function ventSlots(v: VentPattern): Vec2[][] {
  const n = Math.max(0, Math.floor(v.count));
  const out: Vec2[][] = [];
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * v.pitch;
    if (v.orientation === 'u') out.push(stadiumPoly(v.u, v.v + off, v.slotLength, v.slotWidth));
    else out.push(stadiumPoly(v.u + off, v.v, v.slotWidth, v.slotLength));
  }
  return out.filter((p) => p.length >= 3 && v.slotWidth > 0 && v.slotLength > 0);
}

/** Overall extents of a vent pattern in face coordinates. */
export function ventExtents(v: VentPattern): { u0: number; u1: number; v0: number; v1: number } {
  const n = Math.max(1, Math.floor(v.count));
  const span = (n - 1) * v.pitch;
  const along = v.slotLength;
  const across = span + v.slotWidth;
  return v.orientation === 'u'
    ? { u0: v.u - along / 2, u1: v.u + along / 2, v0: v.v - across / 2, v1: v.v + across / 2 }
    : { u0: v.u - across / 2, u1: v.u + across / 2, v0: v.v - along / 2, v1: v.v + along / 2 };
}

export function snapHookHeight(s: SnapFit): number {
  return Math.max(Math.min(1.0, 0.5 * s.length), Math.min(Math.max(2 * s.overhang, 1.0), 0.5 * s.length));
}

/** Catch window extents (face coordinates) for a 'catch' snap on a shell of height H. */
export function snapCatchExtents(s: SnapFit, H: number): { u0: number; u1: number; v0: number; v1: number } {
  const hh = snapHookHeight(s);
  return { u0: s.u - s.width / 2 - 0.25, u1: s.u + s.width / 2 + 0.25, v0: H - s.length - 0.3, v1: H - s.length + hh + 0.3 };
}

/** Depth from 1 mm outside the face plane to 0.5 mm past the inner surface (corners/draft/fillet aware). */
export function throughDepth(g: ShellGeom, face: ShellFace, uMaxAbs: number, vMin: number): number {
  if (face === 'floor') return 1 + g.t + 0.5;
  const half = face === '+x' || face === '-x' ? g.D / 2 : g.W / 2;
  const straight = half - Math.max(g.R, g.t);
  let corner = 0;
  if (uMaxAbs > straight) {
    const d = uMaxAbs - straight;
    corner = d < g.Ri ? g.Ri - Math.sqrt(g.Ri * g.Ri - d * d) : g.R + g.t;
  }
  return 1 + g.t + corner + g.slope * Math.max(0, g.H - vMin) + g.fillet + 0.5;
}

/** Through-wall cutter for a face-local polygon. */
export function faceCutter(g: ShellGeom, face: ShellFace, poly: Vec2[]): Solid {
  const f = faceFrame(g, face);
  const bb = polyBBox(poly);
  const depth = throughDepth(g, face, Math.max(Math.abs(bb.minX), Math.abs(bb.maxX)), bb.minY);
  const nIn = v3.scale(f.nOut, -1);
  return prism(poly, 0, depth, mat4FromBasis(v3.add(f.o, f.nOut), f.eu, f.ev, nIn));
}

export interface BossGeom {
  boss: ShellBoss;
  od: number;
  hole: number;
  z0: number;
  z1: number;
  /** Counterbore (outside, through-floor bosses). */
  cb?: { d: number; depth: number; countersink?: boolean };
  gussets: number;
  /** Notes about clamped values (reported by DFM). */
  notes: string[];
}

/** Resolve boss dimensions, counterbore and clamps. Returns null for degenerate bosses. */
export function bossGeom(g: ShellGeom, b: ShellBoss, spec?: FastenerSpec): BossGeom | null {
  const od = Number(b.outerDiameter);
  const height = Number(b.height);
  if (!(od > 0) || !(height > 0)) return null;
  const notes: string[] = [];
  let hole = Math.max(0, Number(b.holeDiameter) || 0);
  if (b.kind === 'pin') hole = 0;
  if (hole >= od - 0.2 && hole > 0) {
    notes.push(`hole Ø${hole} ≥ boss OD Ø${od} − 0.2; hole reduced`);
    hole = Math.max(0, od - 0.6);
  }
  const z0 = g.t;
  const z1 = g.t + height;
  let cb: BossGeom['cb'];
  if (b.throughFloor && hole > 0) {
    let d: number;
    let depth: number;
    let countersink = false;
    if (spec) {
      const hd = spec.headDiameter ?? defaultHeadDiameter(spec);
      const hh = spec.headHeight ?? 0.6 * spec.diameter;
      if (spec.head === 'flat') {
        countersink = true;
        d = hd + 0.4;
        depth = (d - hole) / 2;
      } else {
        d = hd + 0.6;
        depth = hh + 0.3;
      }
    } else {
      d = 2 * hole;
      depth = 0.6 * hole + 0.4;
    }
    depth = Math.min(depth, z1 - 1.0);
    if (!countersink && depth > g.t && d > od - 1.0) {
      notes.push(`counterbore Ø${d.toFixed(2)} reduced to Ø${(od - 1).toFixed(2)} to stay inside the boss`);
      d = od - 1.0;
    }
    if (d > hole + 0.2 && depth > 0.05) cb = { d, depth, countersink };
  }
  return { boss: b, od, hole, z0, z1, cb, gussets: Math.max(0, Math.floor(b.gussets ?? 0)), notes };
}

/** Default head diameter for a fastener spec when not given. */
export function defaultHeadDiameter(spec: FastenerSpec): number {
  const d = spec.diameter;
  switch (spec.head) {
    case 'socket':
      return 1.6 * d + 0.7;
    case 'button':
      return 1.9 * d;
    case 'flat':
      return 2.0 * d + 0.3;
    case 'hex':
      return 1.6 * d + 0.7;
    default:
      return 1.9 * d;
  }
}

function bossSolids(g: ShellGeom, bg: BossGeom): { body: Solid[]; cut: Solid[] } {
  const b = bg.boss;
  const body: Solid[] = [prism(circlePoly(b.x, b.y, bg.od / 2), bg.z0, bg.z1)];
  if (bg.gussets > 0) {
    const height = bg.z1 - bg.z0;
    const gt = Math.max(0.6, 0.6 * g.t);
    const L = Math.max(1.0, Math.min(0.5 * height, bg.od));
    const r0 = bg.od / 2 - 0.3;
    const tri: Vec2[] = [
      [r0, bg.z0],
      [bg.od / 2 + L, bg.z0],
      [r0, bg.z0 + 0.8 * height],
    ];
    for (let k = 0; k < bg.gussets; k++) {
      const a = (2 * Math.PI * k) / bg.gussets;
      const radial: Vec3 = [Math.cos(a), Math.sin(a), 0];
      const tang: Vec3 = [-Math.sin(a), Math.cos(a), 0];
      body.push(prism(tri, -gt / 2, gt / 2, mat4FromBasis([b.x, b.y, 0], radial, [0, 0, 1], tang)));
    }
  }
  const cut: Solid[] = [];
  if (bg.hole > 0) {
    const zLow = b.throughFloor ? -1 : bg.z0;
    cut.push(prism(circlePoly(b.x, b.y, bg.hole / 2), zLow, bg.z1 + 1));
  }
  if (bg.cb) {
    if (bg.cb.countersink) {
      cut.push(prism(circlePoly(b.x, b.y, bg.cb.d / 2), -1, 0));
      cut.push({ kind: 'cylinder', r0: bg.cb.d / 2, r1: bg.hole / 2, h: bg.cb.depth, m: [1, 0, 0, b.x, 0, 1, 0, b.y, 0, 0, 1, 0, 0, 0, 0, 1] });
    } else cut.push(prism(circlePoly(b.x, b.y, bg.cb.d / 2), -1, bg.cb.depth));
  }
  return { body, cut };
}

function ribSolid(g: ShellGeom, r: { from: Vec2; to: Vec2; height: number; thickness: number }): Solid | null {
  const dx = r.to[0] - r.from[0];
  const dy = r.to[1] - r.from[1];
  const L = Math.hypot(dx, dy);
  if (!(L > 1e-6) || !(r.thickness > 0) || !(r.height > 0)) return null;
  const nx = (-dy / L) * (r.thickness / 2);
  const ny = (dx / L) * (r.thickness / 2);
  const poly: Vec2[] = [
    [r.from[0] - nx, r.from[1] - ny],
    [r.to[0] - nx, r.to[1] - ny],
    [r.to[0] + nx, r.to[1] + ny],
    [r.from[0] + nx, r.from[1] + ny],
  ];
  return prism(poly, g.t, g.t + r.height);
}

function hookSolids(g: ShellGeom, s: SnapFit): Solid[] {
  if (!(s.width > 0) || !(s.length > 0) || !(s.thickness > 0)) return [];
  const f = faceFrame(g, s.face);
  const nIn = v3.scale(f.nOut, -1);
  const root = Math.min(2 * g.t, 3, g.H - g.t);
  const beam = prism(boxPoly(s.u - s.width / 2, g.H - root, s.u + s.width / 2, g.H + s.length), g.t, g.t + s.thickness, mat4FromBasis(f.o, f.eu, f.ev, nIn));
  const out: Solid[] = [beam];
  if (s.overhang > 0) {
    const hh = snapHookHeight(s);
    const v0 = g.H + s.length - hh;
    const tri: Vec2[] = [
      [g.t, v0],
      [g.t, g.H + s.length],
      [g.t - s.overhang, v0],
    ];
    out.push(prism(tri, s.u - s.width / 2, s.u + s.width / 2, mat4FromBasis(f.o, nIn, f.ev, f.eu)));
  }
  return out;
}

export interface ShellBuildCtx {
  /** Resolve a fastener spec by part id (for counterbore sizing). */
  fastener?: (partId: string) => FastenerSpec | undefined;
}

/** Build the shell solid (shell-local frame). Throws on impossible base geometry; skips degenerate features. */
export function shellSolid(shell: EnclosureShell, ctx: ShellBuildCtx = {}): Solid {
  const g = shellGeom(shell);
  const outer = outerLoft(g);
  const pocket = pocketLoft(g);
  const innerHx = g.W / 2 - g.t;
  const innerHy = g.D / 2 - g.t;

  // rim mating features
  let groove: Solid | null = null;
  let lip: Solid | null = null;
  const hooks = (shell.snaps ?? []).filter((s) => s.kind === 'hook' && s.face !== ('floor' as string));
  if (shell.lip && shell.lip.height > 0 && shell.lip.thickness > 0) {
    const T = shell.lip.thickness;
    if (shell.lip.kind === 'groove') {
      groove = prism(rrPoly(0, 0, innerHx + T, innerHy + T, g.Ri + T), g.H - shell.lip.height, g.H + 1);
    } else {
      const ring = prism(rrPoly(0, 0, innerHx + T, innerHy + T, g.Ri + T), g.H, g.H + shell.lip.height, undefined, [rrPoly(0, 0, innerHx, innerHy, g.Ri)]);
      const gaps = hooks.map((s) => {
        const f = faceFrame(g, s.face);
        const nIn = v3.scale(f.nOut, -1);
        return prism(boxPoly(s.u - s.width / 2 - 0.5, g.H - 0.01, s.u + s.width / 2 + 0.5, g.H + shell.lip!.height + 1), -1, g.t + 0.01, mat4FromBasis(f.o, f.eu, f.ev, nIn));
      });
      lip = difference(ring, gaps);
    }
  }
  const walls = difference(outer, [pocket, groove]);

  // interior features
  const spec = (b: ShellBoss) => (b.fastenerPartId && ctx.fastener ? ctx.fastener(b.fastenerPartId) : undefined);
  const feat: Solid[] = [];
  const cuts: Solid[] = [];
  let top = g.H;
  for (const b of shell.bosses ?? []) {
    const bg = bossGeom(g, b, spec(b));
    if (!bg) continue;
    const s = bossSolids(g, bg);
    feat.push(...s.body);
    cuts.push(...s.cut);
    top = Math.max(top, bg.z1);
  }
  for (const r of shell.ribs ?? []) {
    const s = ribSolid(g, r);
    if (!s) continue;
    feat.push(s);
    top = Math.max(top, g.t + r.height);
  }
  const features = feat.length ? intersection([union(feat), outerLoft(g, top + 1)]) : null;

  // through-wall cutters
  for (const c of shell.cutouts ?? []) {
    if (!(c.width > 0) || (c.shape !== 'circle' && !(c.height > 0))) continue;
    cuts.push(faceCutter(g, c.face, cutoutProfile(c)));
  }
  for (const v of shell.vents ?? []) for (const slot of ventSlots(v)) cuts.push(faceCutter(g, v.face, slot));
  for (const s of shell.snaps ?? []) {
    if (s.kind !== 'catch' || !(s.width > 0)) continue;
    const e = snapCatchExtents(s, g.H);
    cuts.push(faceCutter(g, s.face, boxPoly(e.u0, e.v0, e.u1, e.v1)));
  }

  const body = union([walls, lip, features, ...hooks.flatMap((s) => hookSolids(g, s))]);
  return difference(body, cuts);
}
