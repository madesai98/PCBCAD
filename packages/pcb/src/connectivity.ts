/**
 * Copper connectivity: which pads of each net are joined through pads, traces, vias, plated holes
 * and zone fills. Two items connect when they belong to the same net, share a copper layer and their
 * copper touches (gap ≤ 1 µm). Pads with the same number on one component are treated as internally
 * connected. Pads of unplaced components never connect geometrically.
 */
import type { Board, PartDef, Vec2 } from '@pcbcad/core';
import { bbInflate, primGap } from './geom';
import { buildCopperModel, type CopperItem, type CopperModel } from './model';
import { GridIndex, UnionFind } from './spatial';

/** Copper "touch" tolerance (mm). */
export const TOUCH_TOL = 1e-3;

export interface Island {
  /** Pad keys `${componentId}:${pin}` (sorted, unique). */
  padKeys: string[];
  /** Item ids (into the model) of all copper in the island. */
  items: number[];
}

export interface ConnectivityAnalysis {
  model: CopperModel;
  /** net id → islands (largest first). Only nets that have pads appear. */
  nets: Map<string, Island[]>;
}

/** Full connectivity analysis (item level). */
export function analyzeConnectivity(board: Board, parts: Record<string, PartDef>, model?: CopperModel): ConnectivityAnalysis {
  const m = model ?? buildCopperModel(board, parts);
  const items = m.items;
  const uf = new UnionFind(items.length);
  const geo = items.filter((it) => it.geometric && it.copper && it.kind !== 'zone' && it.netId);
  if (geo.length) {
    let ext = geo[0].bb;
    for (const it of geo) ext = { minX: Math.min(ext.minX, it.bb.minX), minY: Math.min(ext.minY, it.bb.minY), maxX: Math.max(ext.maxX, it.bb.maxX), maxY: Math.max(ext.maxY, it.bb.maxY) };
    const index = new GridIndex(ext, 2, items.length);
    for (const it of geo) index.insert(it.id, it.bb);
    const cand: number[] = [];
    for (const a of geo) {
      index.query(bbInflate(a.bb, TOUCH_TOL), cand);
      for (const j of cand) {
        if (j <= a.id) continue;
        const b = items[j];
        if (b.netId !== a.netId || (a.layers & b.layers) === 0) continue;
        if (a.kind === 'trace' && b.kind === 'trace' && a.trace === b.trace && Math.abs((a.seg ?? 0) - (b.seg ?? 0)) === 1) {
          uf.union(a.id, b.id);
          continue;
        }
        if (uf.find(a.id) === uf.find(b.id)) continue;
        if (primGap(a.prim!, b.prim!) <= TOUCH_TOL) uf.union(a.id, b.id);
      }
    }
    // zone islands
    const zones = items.filter((it) => it.kind === 'zone' && it.netId);
    for (const z of zones) {
      index.query(bbInflate(z.bb, TOUCH_TOL), cand);
      for (const j of cand) {
        const b = items[j];
        if (b.netId !== z.netId || (z.layers & b.layers) === 0) continue;
        if (uf.find(z.id) === uf.find(b.id)) continue;
        if (z.region!.gapTo(b.prim!, TOUCH_TOL) <= TOUCH_TOL) uf.union(z.id, b.id);
      }
    }
    for (let i = 0; i < zones.length; i++) {
      for (let k = i + 1; k < zones.length; k++) {
        const a = zones[i];
        const b = zones[k];
        // islands of one zone are disjoint by construction
        if (a.zone === b.zone || a.netId !== b.netId || (a.layers & b.layers) === 0 || uf.find(a.id) === uf.find(b.id)) continue;
        if (a.region!.gapToRegion(b.region!, TOUCH_TOL) <= TOUCH_TOL) uf.union(a.id, b.id);
      }
    }
  }
  // same pin number on one component = internally connected
  const firstOfPin = new Map<string, number>();
  for (const it of items) {
    if (!it.pad || it.kind !== 'pad') continue;
    const prev = firstOfPin.get(it.pad.key);
    if (prev === undefined) firstOfPin.set(it.pad.key, it.id);
    else uf.union(prev, it.id);
  }
  // group
  const byRoot = new Map<number, { net: string; pads: Set<string>; items: number[] }>();
  for (const it of items) {
    if (!it.copper || !it.netId) continue;
    const r = uf.find(it.id);
    let g = byRoot.get(r);
    if (!g) {
      g = { net: it.netId, pads: new Set(), items: [] };
      byRoot.set(r, g);
    }
    g.items.push(it.id);
    if (it.kind === 'pad' && it.pad) g.pads.add(it.pad.key);
  }
  const nets = new Map<string, Island[]>();
  for (const g of byRoot.values()) {
    if (g.pads.size === 0) continue;
    const list = nets.get(g.net) ?? [];
    list.push({ padKeys: [...g.pads].sort(), items: g.items });
    nets.set(g.net, list);
  }
  for (const list of nets.values()) list.sort((a, b) => b.padKeys.length - a.padKeys.length || (a.padKeys[0] < b.padKeys[0] ? -1 : 1));
  return { model: m, nets };
}

/**
 * Net id → islands of pad keys (`${componentId}:${pin}`) connected through copper. Every net that has
 * at least one pad is present; a fully connected net has exactly one island.
 */
export function connectivity(board: Board, parts: Record<string, PartDef>): Map<string, string[][]> {
  const a = analyzeConnectivity(board, parts);
  const out = new Map<string, string[][]>();
  for (const [net, islands] of a.nets) out.set(net, islands.map((i) => i.padKeys));
  return out;
}

export interface RatsLine {
  netId: string;
  from: Vec2;
  to: Vec2;
}

/** Anchor points of an island used for ratsnest lines (pad centres, via centres, trace vertices). */
function islandAnchors(items: CopperItem[], island: Island): Vec2[] {
  const out: Vec2[] = [];
  for (const id of island.items) {
    const it = items[id];
    if (it.kind === 'pad' && it.pad) out.push([it.pad.pp.x, it.pad.pp.y]);
    else if (it.kind === 'via' && it.via) out.push([it.via.x, it.via.y]);
    else if (it.kind === 'trace' && it.prim) {
      const p = it.prim.pts;
      out.push([p[0][0], p[0][1]]);
      if (p.length > 1) out.push([p[p.length - 1][0], p[p.length - 1][1]]);
    }
    if (out.length > 400) break;
  }
  return out;
}

/** Ratsnest from an existing analysis. */
export function ratsnestFrom(a: ConnectivityAnalysis): RatsLine[] {
  const out: RatsLine[] = [];
  const items = a.model.items;
  for (const [netId, islands] of a.nets) {
    if (islands.length < 2) continue;
    const anchors = islands.map((isl) => islandAnchors(items, isl));
    const n = islands.length;
    const inTree = new Array<boolean>(n).fill(false);
    const best = new Array<number>(n).fill(Infinity);
    const bestFrom: (Vec2 | null)[] = new Array(n).fill(null);
    const bestTo: (Vec2 | null)[] = new Array(n).fill(null);
    let cur = 0;
    inTree[0] = true;
    for (let step = 1; step < n; step++) {
      // relax from the island just added
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue;
        for (const p of anchors[cur]) {
          for (const q of anchors[j]) {
            const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
            if (d < best[j]) {
              best[j] = d;
              bestFrom[j] = p;
              bestTo[j] = q;
            }
          }
        }
      }
      let pick = -1;
      for (let j = 0; j < n; j++) if (!inTree[j] && (pick < 0 || best[j] < best[pick])) pick = j;
      if (pick < 0 || !bestFrom[pick]) break;
      inTree[pick] = true;
      out.push({ netId, from: [bestFrom[pick]![0], bestFrom[pick]![1]], to: [bestTo[pick]![0], bestTo[pick]![1]] });
      cur = pick;
    }
  }
  return out;
}

/** Minimal set of connections (MST between islands) still needed, for display. */
export function ratsnest(board: Board, parts: Record<string, PartDef>): RatsLine[] {
  return ratsnestFrom(analyzeConnectivity(board, parts));
}
