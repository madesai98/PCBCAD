/**
 * Design-rule check. All geometric checks use exact prim distances and a uniform-grid spatial index,
 * so cost is ~linear in the number of objects.
 */
import { componentCourtyard, pointInPolygon, type Board, type ComponentInstance, type DesignIssue, type PartDef, type Vec2 } from '@pcbcad/core';
import { analyzeConnectivity, ratsnestFrom } from './connectivity';
import { GAP_AT, bbInflate, bbOverlaps, bboxOf, makePrim, primGap, type Prim } from './geom';
import { boardBBox, boardEdges, buildCopperModel, itemLabel, itemObjectKey, type CopperItem } from './model';
import { GridIndex } from './spatial';
import { silkPrims } from './silk';
import { CLEARANCE_TOL, HOLE_TO_HOLE, MASK_EXPANSION } from './constants';

const TOL = CLEARANCE_TOL;

type Sev = DesignIssue['severity'];

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Run all design-rule checks on a board. */
export function runDrc(board: Board, parts: Record<string, PartDef>): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const counters = new Map<string, number>();
  const add = (severity: Sev, code: string, message: string, at?: Vec2, target?: DesignIssue['target'], suggestion?: string) => {
    const n = (counters.get(code) ?? 0) + 1;
    counters.set(code, n);
    const issue: DesignIssue = { id: `drc-${code}-${n}`, severity, category: 'drc', code, message, target: { boardId: board.id, ...target } };
    if (at) issue.at = [r3(at[0]), r3(at[1])];
    if (suggestion) issue.suggestion = suggestion;
    issues.push(issue);
  };
  const rules = board.rules;
  const netName = (id: string) => board.nets.find((n) => n.id === id)?.name ?? id;
  const conn = analyzeConnectivity(board, parts);
  const model = conn.model;
  const items = model.items;

  /* ---------------------------------------- per-object checks ---------------------------------------- */
  for (const c of board.components) {
    if (!c.placed) add('warning', 'unplaced', `${c.ref} is not placed`, undefined, { componentIds: [c.id] }, 'Place it (autoPlace or move_component).');
    else if (!parts[c.partId]?.footprint) add('warning', 'unplaced', `${c.ref} has no footprint; it cannot be placed on the board`, [c.x, c.y], { componentIds: [c.id] });
  }
  for (const t of board.traces ?? []) {
    if (t.width < rules.minTraceWidth - 1e-9) {
      add('error', 'trace-width', `Trace width ${r3(t.width)} mm < minimum ${rules.minTraceWidth} mm (${netName(t.netId)})`, t.points?.[0], { traceIds: [t.id], netIds: [t.netId] });
    }
  }
  for (const v of board.vias ?? []) {
    if (v.drill < rules.minDrill - 1e-9) add('error', 'drill', `Via drill ${r3(v.drill)} mm < minimum ${rules.minDrill} mm`, [v.x, v.y], { netIds: [v.netId] });
    const ring = (v.diameter - v.drill) / 2;
    if (ring < rules.minAnnularRing - 1e-9)
      add('error', 'annular-ring', `Via annular ring ${r3(ring)} mm < minimum ${rules.minAnnularRing} mm`, [v.x, v.y], { netIds: [v.netId] });
  }
  for (const p of model.pads) {
    if (p.pad.kind === 'smd' || !p.placed) continue;
    const at: Vec2 = [p.pp.x, p.pp.y];
    const label = `${p.comp.ref}.${p.pad.number}`;
    const drill = p.pad.slot ? Math.min(p.pad.slot.w, p.pad.slot.h) : p.pad.drill;
    if (!drill || drill <= 0) add('error', 'drill', `Pad ${label} is ${p.pad.kind.toUpperCase()} but has no drill size`, at, { componentIds: [p.comp.id] });
    else if (drill < rules.minDrill - 1e-9) add('error', 'drill', `Pad ${label} drill ${r3(drill)} mm < minimum ${rules.minDrill} mm`, at, { componentIds: [p.comp.id] });
    if (p.pad.kind === 'tht' && drill && drill > 0) {
      const ring = p.pad.slot
        ? Math.min((p.pad.w - p.pad.slot.w) / 2, ((p.pad.shape === 'circle' ? p.pad.w : p.pad.h) - p.pad.slot.h) / 2)
        : (Math.min(p.pad.w, p.pad.shape === 'circle' ? p.pad.w : p.pad.h) - drill) / 2;
      if (ring < rules.minAnnularRing - 1e-9)
        add('error', 'annular-ring', `Pad ${label} annular ring ${r3(ring)} mm < minimum ${rules.minAnnularRing} mm`, at, { componentIds: [p.comp.id] });
    }
  }
  for (const h of board.holes ?? []) {
    if (h.drill < rules.minDrill - 1e-9) add('error', 'drill', `Mounting hole drill ${r3(h.drill)} mm < minimum ${rules.minDrill} mm`, [h.x, h.y]);
    if (h.plated) {
      const ring = ((h.padDiameter ?? h.drill) - h.drill) / 2;
      if (ring < rules.minAnnularRing - 1e-9)
        add('error', 'annular-ring', `Plated hole annular ring ${r3(ring)} mm < minimum ${rules.minAnnularRing} mm (set padDiameter)`, [h.x, h.y], h.netId ? { netIds: [h.netId] } : undefined);
    }
  }

  /* --------------------------------------- copper-to-copper ---------------------------------------- */
  const geo = items.filter((it) => it.geometric && it.kind !== 'zone');
  const ext = bbInflate(boardBBox(board), 5);
  const index = new GridIndex(ext, 2, items.length);
  for (const it of geo) index.insert(it.id, it.bb);
  const clr = rules.clearance;
  const worst = new Map<string, { gap: number; a: CopperItem; b: CopperItem; at: Vec2 }>();
  const record = (a: CopperItem, b: CopperItem, gap: number, at: Vec2) => {
    const ka = itemObjectKey(a);
    const kb = itemObjectKey(b);
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    const prev = worst.get(key);
    if (!prev || gap < prev.gap) worst.set(key, { gap, a, b, at });
  };
  const cand: number[] = [];
  for (const a of geo) {
    index.query(bbInflate(a.bb, clr), cand);
    for (const j of cand) {
      if (j <= a.id) continue;
      const b = items[j];
      if (!b.geometric || b.kind === 'zone' || (a.layers & b.layers) === 0) continue;
      if (!a.copper && !b.copper) continue; // hole-to-hole handled separately
      const sameNet = a.netId !== '' && a.netId === b.netId && a.copper && b.copper;
      if (sameNet) continue;
      if (a.trace && a.trace === b.trace) continue;
      const sameComp = a.pad && b.pad && a.pad.comp === b.pad.comp;
      if (!bbOverlaps(a.bb, b.bb, clr)) continue;
      const gap = primGap(a.prim!, b.prim!);
      if (gap >= clr - TOL) continue;
      if (sameComp) {
        // footprint-internal geometry: only overlapping copper of two different nets is reported
        if (!(gap <= 0 && a.copper && b.copper && a.netId && b.netId)) continue;
      }
      record(a, b, gap, [GAP_AT[0], GAP_AT[1]]);
    }
  }
  // zones against other copper / zones
  const zones = items.filter((it) => it.kind === 'zone');
  const at: Vec2 = [0, 0];
  for (const z of zones) {
    index.query(bbInflate(z.bb, clr), cand);
    for (const j of cand) {
      const b = items[j];
      if (!b.geometric || (z.layers & b.layers) === 0) continue;
      if (b.copper && b.netId !== '' && b.netId === z.netId) continue;
      const gap = z.region!.gapTo(b.prim!, clr, at);
      if (gap < clr - TOL) record(z, b, gap, [at[0], at[1]]);
    }
  }
  for (let i = 0; i < zones.length; i++) {
    for (let k = i + 1; k < zones.length; k++) {
      const a = zones[i];
      const b = zones[k];
      if ((a.layers & b.layers) === 0 || (a.netId !== '' && a.netId === b.netId)) continue;
      const gap = a.region!.gapToRegion(b.region!, clr, at);
      if (gap < clr - TOL) record(a, b, gap, [at[0], at[1]]);
    }
  }
  for (const { gap, a, b, at: p } of worst.values()) {
    const target = targetsOf([a, b]);
    const la = itemLabel(a, netName);
    const lb = itemLabel(b, netName);
    if (gap <= 0 && a.copper && b.copper && (a.netId || b.netId)) {
      add('error', 'short', `Short: ${la} touches ${lb}`, p, target, 'Move or reroute the copper so different nets do not touch.');
    } else {
      add(
        'error',
        'clearance',
        gap <= 0 ? `Clearance: ${la} overlaps ${lb}` : `Clearance ${r3(gap)} mm < ${clr} mm between ${la} and ${lb}`,
        p,
        target,
      );
    }
  }

  /* --------------------------------------- board edge / outside --------------------------------------- */
  const edges = boardEdges(board);
  const hasOutline = board.outline && board.outline.length >= 3;
  if (hasOutline) {
    const eIndex = new GridIndex(ext, 4, edges.length);
    const edgePrims: Prim[] = edges.map(([a, b]) => makePrim([a, b], 0));
    edgePrims.forEach((p, i) => eIndex.insert(i, p.bb));
    const ec = rules.edgeClearance;
    const insideBoard = (x: number, y: number) => pointInPolygon([x, y], board.outline) && !(board.cutouts ?? []).some((c) => c.length >= 3 && pointInPolygon([x, y], c));
    const seen = new Set<string>();
    for (const it of items) {
      if (!it.geometric || !it.copper) continue;
      const key = itemObjectKey(it);
      if (seen.has(key)) continue;
      if (it.kind === 'zone') {
        const ring = it.region!.rings[0];
        let bad: Vec2 | null = null;
        for (const p of ring) {
          if (!insideBoard(p[0], p[1])) {
            bad = p;
            break;
          }
          eIndex.query({ minX: p[0] - ec, minY: p[1] - ec, maxX: p[0] + ec, maxY: p[1] + ec }, cand);
          const pt = makePrim([p], 0);
          if (cand.some((e) => primGap(pt, edgePrims[e]) < ec - 0.01)) {
            bad = p;
            break;
          }
        }
        if (bad) {
          seen.add(key);
          add('error', 'edge-clearance', `Zone fill (${netName(it.netId)}) is closer than ${ec} mm to the board edge`, bad, targetsOf([it]), 'Refill zones (fillZones).');
        }
        continue;
      }
      const p0 = it.prim!.pts[0];
      if (!insideBoard(p0[0], p0[1])) {
        seen.add(key);
        add('error', 'outside-board', `${capital(itemLabel(it, netName))} is outside the board outline`, p0, targetsOf([it]));
        continue;
      }
      eIndex.query(bbInflate(it.bb, ec), cand);
      let worstGap = Infinity;
      let wAt: Vec2 = p0;
      for (const e of cand) {
        const g = primGap(it.prim!, edgePrims[e]);
        if (g < worstGap) {
          worstGap = g;
          wAt = [GAP_AT[0], GAP_AT[1]];
        }
      }
      if (worstGap < ec - TOL) {
        seen.add(key);
        if (worstGap <= 0) add('error', 'outside-board', `${capital(itemLabel(it, netName))} crosses the board edge`, wAt, targetsOf([it]));
        else add('error', 'edge-clearance', `${capital(itemLabel(it, netName))} is ${r3(worstGap)} mm from the board edge (< ${ec} mm)`, wAt, targetsOf([it]));
      }
    }
    // component bodies
    for (const c of board.components) {
      const fp = parts[c.partId]?.footprint;
      if (!c.placed || !fp) continue;
      const court = componentCourtyard(c, fp);
      if (!insideBoard(c.x, c.y)) {
        add('error', 'outside-board', `${c.ref} is outside the board`, [c.x, c.y], { componentIds: [c.id] });
        continue;
      }
      const out = court.find((p) => !insideBoard(p[0], p[1]));
      const part = parts[c.partId];
      const edgeConnector = part?.category === 'connector' && !!part.connector?.matingDirection && part.connector.matingDirection !== '+z';
      if (out)
        add(
          edgeConnector ? 'info' : 'warning',
          'outside-board',
          edgeConnector ? `${c.ref} overhangs the board edge (edge connector — intended)` : `${c.ref} courtyard extends beyond the board edge`,
          out,
          { componentIds: [c.id] },
          edgeConnector ? undefined : 'Intended for edge connectors; otherwise move the part inward.',
        );
    }
  }

  /* ---------------------------------------- courtyard overlap ---------------------------------------- */
  courtyardOverlaps(board, parts, add);

  /* ------------------------------------------ silk over pad ------------------------------------------ */
  silkOverPads(board, parts, model.pads, add);

  /* ------------------------------------------- hole to hole ------------------------------------------- */
  const holes: { prim: Prim; comp?: ComponentInstance; label: string; key: string }[] = [];
  for (const p of model.pads) if (p.hole && p.placed) holes.push({ prim: p.hole, comp: p.comp, label: `${p.comp.ref}.${p.pad.number}`, key: `p:${p.comp.id}:${p.padIndex}` });
  for (const v of board.vias ?? []) holes.push({ prim: makePrim([[v.x, v.y]], v.drill / 2), label: 'via', key: `v:${v.id}` });
  for (const h of board.holes ?? []) holes.push({ prim: makePrim([[h.x, h.y]], h.drill / 2), label: 'mounting hole', key: `h:${h.id}` });
  if (holes.length) {
    const hIndex = new GridIndex(ext, 2, holes.length);
    holes.forEach((h, i) => hIndex.insert(i, h.prim.bb));
    for (let i = 0; i < holes.length; i++) {
      hIndex.query(bbInflate(holes[i].prim.bb, HOLE_TO_HOLE), cand);
      for (const j of cand) {
        if (j <= i) continue;
        const a = holes[i];
        const b = holes[j];
        if (a.comp && a.comp === b.comp) continue;
        const gap = primGap(a.prim, b.prim);
        if (gap < HOLE_TO_HOLE - TOL)
          add('error', 'hole-to-hole', `Holes ${a.label} and ${b.label} are ${r3(Math.max(0, gap))} mm apart (< ${HOLE_TO_HOLE} mm)`, [GAP_AT[0], GAP_AT[1]], {
            componentIds: [a.comp?.id, b.comp?.id].filter((x): x is string => !!x),
          });
      }
    }
  }

  /* ---------------------------------------------- unrouted --------------------------------------------- */
  const rats = ratsnestFrom(conn);
  for (const [netId, islands] of conn.nets) {
    if (islands.length < 2) continue;
    const line = rats.find((r) => r.netId === netId);
    const at = line ? ([(line.from[0] + line.to[0]) / 2, (line.from[1] + line.to[1]) / 2] as Vec2) : undefined;
    add('error', 'unrouted', `Net ${netName(netId)} has ${islands.length - 1} unrouted connection${islands.length > 2 ? 's' : ''} (${islands.length} islands)`, at, {
      netIds: [netId],
      componentIds: [...new Set(islands.flatMap((i) => i.padKeys.map((k) => k.slice(0, k.lastIndexOf(':')))))],
    }, 'Route it (autoRoute) or add a zone and fillZones.');
  }
  return issues;
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function targetsOf(list: CopperItem[]): DesignIssue['target'] {
  const comps = new Set<string>();
  const nets = new Set<string>();
  const traces = new Set<string>();
  for (const it of list) {
    if (it.pad) comps.add(it.pad.comp.id);
    if (it.netId) nets.add(it.netId);
    if (it.trace) traces.add(it.trace.id);
  }
  const t: NonNullable<DesignIssue['target']> = {};
  if (comps.size) t.componentIds = [...comps];
  if (nets.size) t.netIds = [...nets];
  if (traces.size) t.traceIds = [...traces];
  return t;
}

type AddFn = (severity: Sev, code: string, message: string, at?: Vec2, target?: DesignIssue['target'], suggestion?: string) => void;

/** Convex-polygon overlap depth via SAT (≤ 0 = separated or touching). */
export function convexOverlapDepth(a: Vec2[], b: Vec2[]): number {
  let depth = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const nx = poly[i][1] - poly[j][1];
      const ny = poly[j][0] - poly[i][0];
      const len = Math.hypot(nx, ny);
      if (len < 1e-12) continue;
      let amin = Infinity;
      let amax = -Infinity;
      let bmin = Infinity;
      let bmax = -Infinity;
      for (const p of a) {
        const v = (p[0] * nx + p[1] * ny) / len;
        if (v < amin) amin = v;
        if (v > amax) amax = v;
      }
      for (const p of b) {
        const v = (p[0] * nx + p[1] * ny) / len;
        if (v < bmin) bmin = v;
        if (v > bmax) bmax = v;
      }
      const o = Math.min(amax, bmax) - Math.max(amin, bmin);
      if (o < depth) depth = o;
      if (depth <= 0) return depth;
    }
  }
  return depth;
}

function courtyardOverlaps(board: Board, parts: Record<string, PartDef>, add: AddFn): void {
  const list: { c: ComponentInstance; poly: Vec2[] }[] = [];
  for (const c of board.components) {
    const fp = parts[c.partId]?.footprint;
    if (!c.placed || !fp) continue;
    const cy = fp.courtyard;
    if (!cy || !(cy.maxX > cy.minX && cy.maxY > cy.minY)) continue;
    list.push({ c, poly: componentCourtyard(c, fp) });
  }
  if (list.length < 2) return;
  const bbs = list.map((e) => bboxOf(e.poly));
  const ext = bbs.reduce((acc, b) => ({ minX: Math.min(acc.minX, b.minX), minY: Math.min(acc.minY, b.minY), maxX: Math.max(acc.maxX, b.maxX), maxY: Math.max(acc.maxY, b.maxY) }));
  const idx = new GridIndex(ext, 5, list.length);
  bbs.forEach((b, i) => idx.insert(i, b));
  const cand: number[] = [];
  for (let i = 0; i < list.length; i++) {
    idx.query(bbs[i], cand);
    for (const j of cand) {
      if (j <= i) continue;
      const a = list[i];
      const b = list[j];
      if (a.c.side !== b.c.side || !bbOverlaps(bbs[i], bbs[j])) continue;
      const depth = convexOverlapDepth(a.poly, b.poly);
      if (depth > 1e-4) {
        const bi = bbs[i];
        const bj = bbs[j];
        const at: Vec2 = [(Math.max(bi.minX, bj.minX) + Math.min(bi.maxX, bj.maxX)) / 2, (Math.max(bi.minY, bj.minY) + Math.min(bi.maxY, bj.maxY)) / 2];
        add('error', 'courtyard-overlap', `Courtyards of ${a.c.ref} and ${b.c.ref} overlap by ${r3(depth)} mm`, at, { componentIds: [a.c.id, b.c.id] }, 'Move one of the components apart.');
      }
    }
  }
}

function silkOverPads(board: Board, parts: Record<string, PartDef>, pads: ReturnType<typeof buildCopperModel>['pads'], add: AddFn): void {
  const exposed = pads.filter((p) => p.placed && (p.prim || p.hole));
  if (!exposed.length) return;
  const ext = bbInflate(boardBBox(board), 5);
  const idx = new GridIndex(ext, 2, exposed.length);
  exposed.forEach((p, i) => idx.insert(i, (p.prim ?? p.hole)!.bb));
  const cand: number[] = [];
  const reported = new Set<string>();
  for (const c of board.components) {
    const part = parts[c.partId];
    if (!c.placed || !part?.footprint) continue;
    const strokes = silkPrims(c, part.footprint);
    for (const s of strokes) {
      idx.query(bbInflate(s.bb, MASK_EXPANSION), cand);
      for (const j of cand) {
        const p = exposed[j];
        const onSide = p.pad.kind !== 'smd' || p.comp.side === c.side;
        if (!onSide) continue;
        const key = `${c.id}|${p.comp.id}`;
        if (reported.has(key)) continue;
        const shape = (p.prim ?? p.hole)!;
        if (primGap(s, shape) < MASK_EXPANSION - TOL) {
          reported.add(key);
          add(
            'warning',
            'silk-over-pad',
            p.comp === c ? `Silkscreen of ${c.ref} overlaps its own pad ${p.pad.number}` : `Silkscreen of ${c.ref} overlaps pad ${p.comp.ref}.${p.pad.number}`,
            [GAP_AT[0], GAP_AT[1]],
            { componentIds: [...new Set([c.id, p.comp.id])] },
            'Silk is clipped in Gerber output; move the part or graphic to keep markings legible.',
          );
        }
      }
    }
  }
}
