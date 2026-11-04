/**
 * Rough, documented cost models (USD, ±30–50 %): good for comparing design options, not for quotes.
 *
 * Injection molding
 *   tooling = (3000 + 30·A + 400·d + 120·bosses + 50·ribs + 200·openings + 2500·slides + 1800·lifters)
 *             × steel factor (aluminium 0.6 ≤ 2k pcs, P20 1.0 ≤ 250k, H13 1.6 above) × (1 + 0.7·(cavities − 1))
 *     A = projected area (cm²), d = part depth (cm).
 *   unit = [material + machine + $0.05 handling] × 1.3 overhead + $250 setup / qty
 *     material = V·ρ·1.05 (runner/scrap) · $/kg; machine = cycle/3600 · rate / cavities
 *     cycle = cooling (s²/(π²α)·ln(8/π²·(Tm−Tw)/(Te−Tw)), α = 0.09 mm²/s, Te = HDT) + 8 s + 2 s per slide
 *     rate by clamp force (0.45 t/cm² of projected area): ≤50 t $35/h, ≤150 t $45/h, ≤300 t $65/h, else $90/h.
 * Sheet metal (laser + press brake, no tooling)
 *   unit = [sheet (flat area·t·ρ·$/kg ÷ 0.8 nesting) + cut ($0.6/m·(1 + t/2)) + $0.03/pierce + $0.35/bend
 *          + PEM $0.20 each + finish (powder $8/m², anodise $6/m², zinc $2.5/m², both sides)] × 1.25
 *          + ($60 programming + $25/bend setup) / qty
 * 3D printing: FDM $3 + $0.15/cm³, SLA $5 + $0.35/cm³, SLS $4 + $0.30/cm³ (no tooling)
 * CNC: stock = bbox + 3 mm/side; time = removed volume / MRR (alu 15, plastics 25, steel 4 cm³/min) + 10 min;
 *   unit = (time·$70/h + stock material × 1.3) + $150 setup / qty
 * Die casting: molding model with tooling × 2.5. Purchased: distributor price breaks when the
 *   project's PartDef has offers.
 */
import type { MechPart, Project } from '@pcbcad/core';
import { getMaterial } from '@pcbcad/core';
import { partSolid } from './parts';
import { buildSheetModel, flatFromModel } from './sheet';
import { cutoutExtents, shellGeom, ventSlots } from './shell';
import { estimateSolidVolume } from './solid';

export interface CostEstimate {
  toolingUsd: number;
  unitUsd: number;
  notes: string[];
  /** Per-unit cost components (USD). */
  breakdown: Record<string, number>;
}

const money = (v: number) => Math.round(v * 100) / 100;

function sideActions(part: MechPart): { slides: number; lifters: number; openings: number } {
  if (part.kind !== 'enclosure-shell') return { slides: 0, lifters: 0, openings: 0 };
  let H = part.outer?.height ?? 0;
  try {
    H = shellGeom(part).H;
  } catch {
    /* invalid shells still get a cost */
  }
  const faces = new Set<string>();
  for (const c of part.cutouts ?? []) if (c.face !== 'floor' && cutoutExtents(c).v1 < H - 1e-6) faces.add(c.face);
  for (const v of part.vents ?? []) if (v.face !== 'floor') faces.add(v.face);
  for (const s of part.snaps ?? []) if (s.kind === 'catch') faces.add(s.face);
  const lifters = (part.snaps ?? []).filter((s) => s.kind === 'hook').length;
  const openings = (part.cutouts ?? []).length + (part.vents ?? []).reduce((n, v) => n + Math.max(1, ventSlots(v).length / 4), 0);
  return { slides: faces.size, lifters, openings };
}

function moldingCost(part: MechPart, qty: number, notes: string[], dieCast = false): CostEstimate {
  const mat = getMaterial(part.materialId);
  const solid = partSolid(part);
  const est = solid ? estimateSolidVolume(solid, 300_000) : { volume: 0, bbox: null };
  const bb = est.bbox;
  const sx = bb ? bb.max[0] - bb.min[0] : 0;
  const sy = bb ? bb.max[1] - bb.min[1] : 0;
  const sz = bb ? bb.max[2] - bb.min[2] : 0;
  const A = (sx * sy) / 100;
  const depth = sz / 10;
  const volCm3 = est.volume / 1000;
  const { slides, lifters, openings } = sideActions(part);
  const bosses = part.kind === 'enclosure-shell' ? part.bosses?.length ?? 0 : 0;
  const ribs = part.kind === 'enclosure-shell' ? part.ribs?.length ?? 0 : 0;
  const steel = qty <= 2000 ? { name: 'aluminium (QC-7/7075, ~10k shots)', f: 0.6 } : qty <= 250_000 ? { name: 'P20 pre-hardened steel', f: 1.0 } : { name: 'H13 hardened steel', f: 1.6 };
  const cav = Math.max(1, Math.floor(Number(part.processOptions?.cavities ?? (qty > 500_000 ? 4 : qty > 250_000 ? 2 : 1))));
  let tooling = (3000 + 30 * A + 400 * depth + 120 * bosses + 50 * ribs + 200 * openings + 2500 * slides + 1800 * lifters) * steel.f * (1 + 0.7 * (cav - 1));
  if (dieCast) tooling *= 2.5;
  const wall = part.kind === 'enclosure-shell' ? part.wall : Math.max(1, Math.min(4, mat?.molding?.nominalWall ?? 2.5));
  const m = mat?.molding;
  const Tm = m?.meltTemp ?? (dieCast ? 650 : 250);
  const Tw = m?.moldTemp ?? (dieCast ? 200 : 60);
  const Te = Math.max(Tw + 10, mat?.hdt ?? Tw + 40);
  const alpha = dieCast ? 30 : 0.09; // mm²/s
  const cooling = Math.max(1, ((wall * wall) / (Math.PI ** 2 * alpha)) * Math.log((8 / Math.PI ** 2) * ((Tm - Tw) / (Te - Tw))));
  const cycle = cooling + 8 + 2 * slides + 1.5 * lifters;
  const tons = 0.45 * A * cav;
  const rate = tons <= 50 ? 35 : tons <= 150 ? 45 : tons <= 300 ? 65 : 90;
  const material = (volCm3 * ((mat?.density ?? 1100) / 1000) * 1.05 * (mat?.costPerKg ?? 3)) / 1000;
  const machine = ((cycle / 3600) * rate) / cav;
  const unit = (material + machine + 0.05) * 1.3 + 250 / Math.max(1, qty);
  notes.push(
    `${dieCast ? 'Die-cast' : 'Mold'} tool: ${steel.name}, ${cav} cavit${cav > 1 ? 'ies' : 'y'}, ${slides} slide(s), ${lifters} lifter(s); projected area ${A.toFixed(0)} cm², depth ${depth.toFixed(1)} cm`,
    `Part ≈ ${volCm3.toFixed(1)} cm³ (${(volCm3 * ((mat?.density ?? 1100) / 1000)).toFixed(1)} g); cycle ≈ ${cycle.toFixed(1)} s (cooling ${cooling.toFixed(1)} s at ${wall} mm wall) on a ~${Math.max(20, Math.ceil(tons / 10) * 10)} t press ($${rate}/h)`,
  );
  if (slides) notes.push(`Side actions add ≈ $${(2500 * steel.f * slides).toFixed(0)} tooling — open side cutouts to the parting line to avoid them`);
  return { toolingUsd: Math.round(tooling), unitUsd: money(unit), notes, breakdown: { material: money(material), machine: money(machine), handling: 0.05, setupPerUnit: money(250 / Math.max(1, qty)) } };
}

/** Rough tooling + unit cost for `qty` parts (see module docs for the models and their assumptions). */
export function estimateCost(part: MechPart, qty: number, ctx: { project?: Project } = {}): CostEstimate {
  try {
    return estimate(part, qty, ctx);
  } catch (e) {
    return { toolingUsd: 0, unitUsd: 0, notes: [`Cannot estimate cost: ${e instanceof Error ? e.message : String(e)}`], breakdown: {} };
  }
}

function estimate(part: MechPart, qty: number, ctx: { project?: Project }): CostEstimate {
  qty = Math.max(1, Math.floor(Number(qty) || 1));
  const notes: string[] = [];
  const mat = getMaterial(part.materialId);
  if (!mat && part.kind !== 'purchased') notes.push(`Unknown material '${part.materialId}' — generic values used`);
  if (part.kind === 'purchased') {
    const def = ctx.project?.parts?.[part.partId];
    let best: number | undefined;
    for (const o of def?.offers ?? []) {
      const pb = [...(o.priceBreaks ?? [])].sort((a, b) => a.qty - b.qty).filter((b) => b.qty <= qty).pop() ?? o.priceBreaks?.[0];
      if (pb && (best === undefined || pb.price < best)) best = pb.price;
    }
    if (best === undefined) notes.push('Purchased part: no distributor pricing available (add offers to the PartDef)');
    else notes.push(`Distributor price at qty ${qty}`);
    return { toolingUsd: 0, unitUsd: money(best ?? 0), notes, breakdown: { purchase: money(best ?? 0) } };
  }
  switch (part.process) {
    case 'injection-molding':
      return moldingCost(part, qty, notes);
    case 'die-casting':
      return moldingCost(part, qty, notes, true);
    case 'sheet-metal': {
      if (part.kind !== 'sheet-metal') break;
      const model = buildSheetModel(part);
      const flat = flatFromModel(model);
      const perim = (p: [number, number][]) => p.reduce((s, q, i) => s + Math.hypot(p[(i + 1) % p.length][0] - q[0], p[(i + 1) % p.length][1] - q[1]), 0);
      const cutM = (perim(flat.outline) + flat.holes.reduce((s, h) => s + perim(h), 0)) / 1000;
      const t = part.thickness;
      const massKg = flat.areaMm2 * t * (mat?.density ?? 7850) * 1e-9;
      const sheet = ((massKg * (mat?.costPerKg ?? 2)) / 0.8) || 0;
      const cut = cutM * 0.6 * (1 + t / 2);
      const pierce = 0.03 * (flat.holes.length + 1);
      const bends = model.bends.length;
      const bend = 0.35 * bends;
      const pems = model.faces.reduce((n, f) => n + f.holes.filter((h) => h.hole.pemPartId).length, 0);
      const pem = 0.2 * pems;
      const finish = String(part.processOptions?.finish ?? '');
      const areaM2 = (2 * flat.areaMm2) / 1e6;
      const fin = /powder|paint/.test(finish) ? 8 * areaM2 : /anodi/.test(finish) ? 6 * areaM2 : /zinc|plat/.test(finish) ? 2.5 * areaM2 : 0;
      const setup = 60 + 25 * bends;
      const unit = (sheet + cut + pierce + bend + pem + fin) * 1.25 + setup / qty;
      notes.push(`Flat ${flat.size[0].toFixed(0)} × ${flat.size[1].toFixed(0)} mm, ${massKg.toFixed(3)} kg, ${cutM.toFixed(2)} m cut, ${flat.holes.length} pierces, ${bends} bend(s)${pems ? `, ${pems} PEM` : ''}${finish ? `, finish ${finish}` : ''}`);
      if (qty > 5000) notes.push('At this volume a progressive/compound die may be cheaper per part (tooling $5k–50k)');
      return { toolingUsd: 0, unitUsd: money(unit), notes, breakdown: { sheet: money(sheet), cutting: money(cut + pierce), bending: money(bend), hardware: money(pem), finish: money(fin), setupPerUnit: money(setup / qty) } };
    }
    case 'fdm-printing':
    case 'sla-printing':
    case 'sls-printing': {
      const solid = partSolid(part);
      const v = solid ? estimateSolidVolume(solid, 200_000).volume / 1000 : 0;
      const [base, per] = part.process === 'fdm-printing' ? [3, 0.15] : part.process === 'sla-printing' ? [5, 0.35] : [4, 0.3];
      const infill = part.process === 'fdm-printing' ? 0.5 + 0.5 * Math.min(1, Math.max(0.1, Number(part.processOptions?.infill ?? 0.4))) : 1;
      const unit = base + per * v * infill;
      notes.push(`${v.toFixed(1)} cm³ printed${part.process === 'fdm-printing' ? ` (infill factor ${infill.toFixed(2)})` : ''}; no tooling`);
      return { toolingUsd: 0, unitUsd: money(unit), notes, breakdown: { setup: base, volume: money(per * v * infill) } };
    }
    case 'cnc-machining':
    case 'extrusion':
    default: {
      const solid = partSolid(part);
      const est = solid ? estimateSolidVolume(solid, 200_000) : { volume: 0, bbox: null };
      const bb = est.bbox;
      const stock = bb ? (bb.max[0] - bb.min[0] + 6) * (bb.max[1] - bb.min[1] + 6) * (bb.max[2] - bb.min[2] + 6) : 0;
      const removed = Math.max(0, stock - est.volume) / 1000;
      const mrr = mat?.family === 'metal' ? (/al|alu/i.test(mat.id) ? 15 : 4) : 25;
      const minutes = removed / mrr + 10;
      const material = ((stock / 1000) * ((mat?.density ?? 2700) / 1000) * (mat?.costPerKg ?? 5) * 1.3) / 1000;
      const unit = (minutes / 60) * 70 + material + 150 / qty;
      notes.push(`${part.process}: modelled as CNC from stock (${(stock / 1000).toFixed(0)} cm³ stock, ${removed.toFixed(0)} cm³ removed, ≈ ${minutes.toFixed(0)} min)`);
      return { toolingUsd: 0, unitUsd: money(unit), notes, breakdown: { machining: money((minutes / 60) * 70), material: money(material), setupPerUnit: money(150 / qty) } };
    }
  }
  return { toolingUsd: 0, unitUsd: 0, notes: [...notes, `No cost model for ${part.kind} via ${part.process}`], breakdown: {} };
}
