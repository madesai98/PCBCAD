/**
 * Sheet-metal DFM rules (category 'dfm'); see README.md for sources. Distances are measured in the
 * face containing the feature:
 *  - hole-to-edge: hole boundary to the nearest free (non-bend) edge ≥ 1.5·t (2·t for slots/rects);
 *  - hole-to-bend: hole boundary to the INSIDE face of the bend (inner virtual sharp, i.e. tangent
 *    line + r·tan(θ/2)) ≥ 2.5·t + r;
 *  - holes inside the bend zone are errors.
 */
import type { DesignIssue, Project, SheetMetalPart, Vec2, Vec3 } from '@pcbcad/core';
import { getMaterial } from '@pcbcad/core';
import { segDist } from './poly';
import { buildSheetModel, flatFromModel, type SheetFaceModel, type SheetHoleModel, type SheetModel } from './sheet';

/** Approximate PEM self-clinching hardware data (PennEngineering bulletins; verify per part number). */
interface PemData {
  kind: 'nut' | 'stud' | 'standoff';
  thread: string;
  /** Mounting hole (mm). */
  hole: number;
  /** Minimum sheet thickness (mm). */
  minSheet: number;
  /** Minimum hole centre-line to edge (mm). */
  edge: number;
}

const PEM: PemData[] = [
  { kind: 'nut', thread: 'M2', hole: 4.22, minSheet: 0.8, edge: 4.8 },
  { kind: 'nut', thread: 'M2.5', hole: 4.22, minSheet: 0.8, edge: 4.8 },
  { kind: 'nut', thread: 'M3', hole: 4.22, minSheet: 0.8, edge: 4.8 },
  { kind: 'nut', thread: 'M4', hole: 5.41, minSheet: 0.8, edge: 6.9 },
  { kind: 'nut', thread: 'M5', hole: 6.35, minSheet: 0.8, edge: 7.1 },
  { kind: 'nut', thread: 'M6', hole: 8.75, minSheet: 1.15, edge: 8.6 },
  { kind: 'stud', thread: 'M2.5', hole: 2.5, minSheet: 1.0, edge: 4.8 },
  { kind: 'stud', thread: 'M3', hole: 3.0, minSheet: 1.0, edge: 5.6 },
  { kind: 'stud', thread: 'M4', hole: 4.0, minSheet: 1.0, edge: 7.1 },
  { kind: 'stud', thread: 'M5', hole: 5.0, minSheet: 1.0, edge: 7.1 },
  { kind: 'standoff', thread: 'M2.5', hole: 4.22, minSheet: 1.0, edge: 4.8 },
  { kind: 'standoff', thread: 'M3', hole: 4.22, minSheet: 1.0, edge: 4.8 },
  { kind: 'standoff', thread: 'M4', hole: 7.14, minSheet: 1.6, edge: 8.0 },
];

/** Identify PEM hardware from a part id (S-M3-1, FH-M3-10, SO-M3-8, PEM-…) or the project's PartDef. */
export function pemLookup(pemPartId: string, holeDia: number, project?: Project): PemData | undefined {
  const spec = project?.parts?.[pemPartId]?.fastener;
  const id = pemPartId.toUpperCase();
  let kind: PemData['kind'] | undefined;
  if (spec?.type === 'pem-standoff') kind = 'standoff';
  else if (spec?.type === 'pem-nut') kind = 'nut';
  else if (/\b(FHS?|FHA|FHP|HFH)-?M?/.test(id)) kind = 'stud';
  else if (/\b(SOS?|BSOS?|SOA|KFS2)-?M?/.test(id)) kind = 'standoff';
  else if (/\b(SS?|CLS|SP|CLA|S-|PEM)/.test(id)) kind = 'nut';
  const thread = spec?.thread?.toUpperCase() ?? /M(\d+(?:\.\d)?)/.exec(id)?.[0];
  if (kind && thread) {
    const hit = PEM.find((p) => p.kind === kind && p.thread === thread);
    if (hit) return hit;
  }
  // fall back to the hole size
  let best: PemData | undefined;
  for (const p of PEM) if ((!kind || p.kind === kind) && Math.abs(p.hole - holeDia) <= 0.1 && (!best || p.hole < best.hole)) best = p;
  return best;
}

const fmt = (v: number, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toString();

function faceAt(f: SheetFaceModel, p: Vec2): Vec3 {
  return [f.o[0] + p[0] * f.eu[0] + p[1] * f.en[0], f.o[1] + p[0] * f.eu[1] + p[1] * f.en[1], f.o[2] + p[0] * f.eu[2] + p[1] * f.en[2]];
}

/** Distance from a hole's boundary to segment a-b (conservative for non-circular holes). */
function holeToSeg(h: SheetHoleModel, a: Vec2, b: Vec2): number {
  if (h.circle) return segDist(h.circle.c[0], h.circle.c[1], a[0], a[1], b[0], b[1]) - h.circle.d / 2;
  let d = Infinity;
  for (const p of h.poly) d = Math.min(d, segDist(p[0], p[1], a[0], a[1], b[0], b[1]));
  return d;
}

function isOnBendEdge(f: SheetFaceModel, p: Vec2, q: Vec2): boolean {
  for (const e of f.bendEdges) {
    const d1 = segDist(p[0], p[1], e.a[0], e.a[1], e.b[0], e.b[1]);
    const d2 = segDist(q[0], q[1], e.a[0], e.a[1], e.b[0], e.b[1]);
    if (d1 < 1e-5 && d2 < 1e-5) return true;
  }
  return false;
}

/** Sheet-metal DFM review. `ctx.project` resolves PEM PartDefs (optional). */
export function checkSheetMetal(part: SheetMetalPart, ctx: { project?: Project } = {}): DesignIssue[] {
  const out: DesignIssue[] = [];
  const seen = new Map<string, number>();
  const add = (code: string, severity: DesignIssue['severity'], message: string, suggestion?: string, at?: Vec3, key?: string) => {
    const base = `dfm:${part.id}:${code}${key ? ':' + key : ''}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ id: n ? `${base}:${n}` : base, severity, category: 'dfm', code, message, target: { partId: part.id }, ...(at ? { at } : {}), ...(suggestion ? { suggestion } : {}) });
  };
  let model: SheetModel;
  try {
    model = buildSheetModel(part);
  } catch (e) {
    add('invalid-geometry', 'error', e instanceof Error ? e.message : String(e), 'Fix thickness and base dimensions.');
    return out;
  }
  for (const i of model.issues) add(i.code, i.severity, i.message, i.suggestion, undefined, i.flangeId ?? i.holeId);
  const t = model.t;
  const mat = getMaterial(part.materialId);
  const stainless = /^ss-|stainless/i.test(part.materialId);
  if (!mat) add('material', 'error', `Unknown material '${part.materialId}'`, 'Use a sheet material id (al-5052-h32, spcc, sgcc, ss-304, …).');
  else if (!mat.sheet) add('material-not-sheet', 'warning', `${mat.name} has no sheet-metal data (not normally bent)`, 'Use al-5052-h32, spcc, sgcc, ss-304 or copper.');
  if (part.process !== 'sheet-metal') add('process', 'info', `Process is '${part.process}'; these checks assume laser/punch + press brake`);

  // gauge
  const gauges = mat?.sheet?.gauges ?? [];
  if (gauges.length && !gauges.some((g) => Math.abs(g - t) <= 0.011)) {
    const near = gauges.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
    add('sheet-gauge', 'warning', `Thickness ${fmt(t)} mm is not a stocked ${mat?.name} gauge (${gauges.join(', ')} mm)`, `Use ${near} mm.`);
  }

  // K-factor
  const k = part.kFactor;
  if (!(k >= 0.25 && k <= 0.5)) add('k-factor', 'warning', `K-factor ${k} is outside the physical range 0.25–0.5 for air bending`, `Use ≈ ${mat?.sheet?.kFactor ?? 0.44} (confirm with the fabricator's bend table).`);
  else if (mat?.sheet && Math.abs(k - mat.sheet.kFactor) > 0.08) add('k-factor', 'info', `K-factor ${k} differs from the typical ${mat.sheet.kFactor} for ${mat.name}`, 'Use the fabricator’s value; the flat pattern scales with it.');

  // bends / flanges
  const minR = (mat?.sheet?.minBendRadiusFactor ?? 1) * t;
  for (const b of model.bends) {
    const face = model.faces.find((f) => f.id === b.childId)!;
    const at = faceAt(face, [0, 0]);
    if (b.radius + 1e-9 < minR) add('bend-radius', 'error', `Flange ${b.id}: inside bend radius ${fmt(b.radius)} mm < ${mat?.sheet?.minBendRadiusFactor ?? 1} × t = ${fmt(minR)} mm for ${mat?.name ?? 'this material'} — cracking on the outside of the bend`, `Use bendRadius ≥ ${fmt(minR)} mm (or a more ductile temper).`, at, b.id);
    else if (b.radius > 8 * t) add('bend-radius', 'info', `Flange ${b.id}: large radius ${fmt(b.radius)} mm (> 8t) — significant springback, needs special tooling`, undefined, at, b.id);
    const L = face.length ?? 0;
    const minL = Math.max(4 * t, 2.5 * t + b.radius);
    if (L + 1e-9 < minL) add('flange-length', 'error', `Flange ${b.id}: length ${fmt(L)} mm < max(4t, 2.5t + r) = ${fmt(minL)} mm — cannot be formed on a standard press-brake die`, `Lengthen the flange to ≥ ${fmt(minL, 1)} mm (or trim after bending).`, at, b.id);
    if (Math.abs(b.angle) > 135) add('bend-angle', 'info', `Flange ${b.id}: ${fmt(Math.abs(b.angle), 1)}° bend needs acute/hemming tooling`, undefined, at, b.id);
  }

  // reliefs
  if (model.reliefCount > 0) {
    if (model.reliefWidth + 1e-9 < t) add('relief-width', 'warning', `Bend relief width ${fmt(model.reliefWidth)} mm < t (${fmt(t)} mm)`, `Use processOptions.reliefWidth ≥ ${fmt(t)} mm.`);
    for (const b of model.bends) {
      const depth = b.setback + model.reliefDepth;
      if (depth + 1e-9 < b.radius + t) add('relief-depth', 'warning', `Flange ${b.id}: relief depth ${fmt(depth)} mm < r + t = ${fmt(b.radius + t)} mm`, `Increase processOptions.reliefDepth to ≥ ${fmt(b.radius + t - b.setback)} mm beyond the tangent line.`, undefined, b.id);
    }
  }

  // holes
  for (const f of model.faces) {
    // free edges of the face outline
    const free: [Vec2, Vec2][] = [];
    for (let i = 0; i < f.poly.length; i++) {
      const p = f.poly[i];
      const q = f.poly[(i + 1) % f.poly.length];
      if (!isOnBendEdge(f, p, q)) free.push([p, q]);
    }
    for (const h of f.holes) {
      const at = faceAt(f, h.center);
      const id = h.hole.id;
      const minHole = (stainless ? 1.2 : 1.0) * t;
      if (h.minDim + 1e-9 < minHole) add('hole-size', 'warning', `Hole ${id}: ${fmt(h.minDim)} mm < ${stainless ? '1.2 × ' : ''}t (${fmt(minHole)} mm) — punch breakage / poor laser quality`, `Make it ≥ ${fmt(minHole)} mm or drill it after forming.`, at, id);
      let dEdge = Infinity;
      for (const [p, q] of free) dEdge = Math.min(dEdge, holeToSeg(h, p, q));
      const slotty = h.hole.shape !== 'circle';
      const needEdge = (slotty ? 2 : 1.5) * t;
      if (dEdge < 0) add('hole-edge', 'error', `Hole ${id} breaks through the edge of face ${f.id}`, 'Move it inside the face.', at, id);
      else if (dEdge + 1e-9 < needEdge) add('hole-edge', 'warning', `Hole ${id}: ${fmt(dEdge)} mm from the edge (< ${slotty ? 2 : 1.5} × t = ${fmt(needEdge)} mm) — bulging/tearing`, `Keep ≥ ${fmt(needEdge)} mm between the hole and the edge.`, at, id);
      for (const be of f.bendEdges) {
        const dTan = holeToSeg(h, be.a, be.b);
        const iss = be.radius * Math.tan(((Math.abs(be.angle) * Math.PI) / 180) / 2);
        const need = 2.5 * t + be.radius;
        // inside the bend zone? (hole centre on the bend side of the tangent line)
        const ex = be.b[0] - be.a[0], ey = be.b[1] - be.a[1];
        const len2 = ex * ex + ey * ey || 1;
        const along = ((h.center[0] - be.a[0]) * ex + (h.center[1] - be.a[1]) * ey) / len2;
        const side = (h.center[0] - be.a[0]) * ey - (h.center[1] - be.a[1]) * ex;
        const centroid = f.poly.reduce((s, p) => [s[0] + p[0] / f.poly.length, s[1] + p[1] / f.poly.length], [0, 0]);
        const sideInterior = (centroid[0] - be.a[0]) * ey - (centroid[1] - be.a[1]) * ex;
        const beyond = along > -0.02 && along < 1.02 && side * sideInterior < 0;
        if (dTan < 0 || beyond) add('hole-in-bend', 'error', `Hole ${id} lies in the bend zone of ${be.bendId}`, `Move it ≥ ${fmt(need)} mm from the inside of the bend or cut it after bending.`, at, `${id}-${be.bendId}`);
        else if (dTan + iss + 1e-9 < need) add('hole-bend', 'warning', `Hole ${id}: ${fmt(dTan + iss)} mm from the inside of bend ${be.bendId} (< 2.5t + r = ${fmt(need)} mm) — the hole will distort when bent`, `Move the hole ≥ ${fmt(need - iss)} mm from the bend tangent line (${fmt(need)} mm from the inner face), or add a relief slot.`, at, `${id}-${be.bendId}`);
      }
      if (h.hole.pemPartId) {
        const pem = pemLookup(h.hole.pemPartId, h.minDim, ctx.project);
        if (!pem) add('pem-unknown', 'info', `Hole ${id}: PEM part '${h.hole.pemPartId}' not recognised — check sheet thickness, hole size and edge distance in its bulletin`, undefined, at, id);
        else {
          if (t + 1e-9 < pem.minSheet) add('pem-thickness', 'error', `Hole ${id}: ${pem.thread} PEM ${pem.kind} needs ≥ ${pem.minSheet} mm sheet (have ${fmt(t)} mm)`, `Use ≥ ${pem.minSheet} mm sheet or a different fastener.`, at, id);
          if (Math.abs(h.minDim - pem.hole) > 0.08) add('pem-hole', 'warning', `Hole ${id}: Ø${fmt(h.minDim)} mm does not match the ${pem.thread} PEM ${pem.kind} mounting hole Ø${pem.hole} (+0.08/−0) mm`, `Set the hole to Ø${pem.hole} mm.`, at, id);
          let cEdge = Infinity;
          for (const [p, q] of free) cEdge = Math.min(cEdge, segDist(h.center[0], h.center[1], p[0], p[1], q[0], q[1]));
          for (const be of f.bendEdges) cEdge = Math.min(cEdge, segDist(h.center[0], h.center[1], be.a[0], be.a[1], be.b[0], be.b[1]));
          if (cEdge + 1e-9 < pem.edge) add('pem-edge', 'warning', `Hole ${id}: PEM centre is ${fmt(cEdge)} mm from an edge/bend (< ${pem.edge} mm min. for ${pem.thread} ${pem.kind})`, `Move it ≥ ${pem.edge} mm from edges and bends.`, at, id);
          if (stainless) add('pem-stainless', 'info', `Hole ${id}: PEM hardware in stainless sheet must be harder than the sheet`, 'Specify 400-series stainless hardware (e.g. SP/SFP nuts, FHP studs) for 300-series stainless sheet.', at, id);
        }
      }
    }
  }

  // flat pattern vs stock sheet
  const flat = flatFromModel(model);
  const [fx, fy] = flat.size;
  const fits = (a: number, b: number) => (fx <= a && fy <= b) || (fx <= b && fy <= a);
  if (!fits(1220, 2440)) add('sheet-size', 'error', `Flat pattern ${fmt(fx, 1)} × ${fmt(fy, 1)} mm does not fit a standard 1220 × 2440 mm sheet`, 'Split the part into welded/riveted sections or reduce its size.');
  else if (!fits(1250, 1250) && !fits(1500, 3000)) add('sheet-size', 'info', `Flat pattern ${fmt(fx, 1)} × ${fmt(fy, 1)} mm is large`);
  return out;
}
