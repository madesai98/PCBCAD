import type { Board, ComponentInstance, CopperLayer, PartDef, Vec2, Zone } from '@pcbcad/core';
import { COPPER_RESISTIVITY, placedPads, pointInPolygon, pointPolygonEdgeDistance, pointSegmentDistance, polygonArea, polygonBBox } from '@pcbcad/core';
import { barrelAreaMm2, layerCopperMm, layerZ, stackLayers, viaSpan } from './stackup';

/**
 * Electrical resistor network of a board's copper, one graph per net.
 *
 * Nodes:
 *  - trace vertices (per layer; vertices within {@link MERGE_TOL} are merged),
 *  - one node per component pin (all pads sharing that pin number, on every copper layer the pad
 *    exists on — THT pads are a single node through the board: lead + solder short the barrel),
 *  - one node per via per spanned copper layer,
 *  - one node per zone fill island ("low-impedance hub").
 * Edges (resistances quoted at 20 °C, scaled by (1 + α(T − 20)) at solve time):
 *  - trace (sub-)segments: R = ρ·L / (w·t), t = layer copper thickness;
 *    segments are split where another trace's end, a via or a pad touches them mid-way
 *    (T-junctions, pass-through pads/vias);
 *  - via barrels between consecutive layers: R = ρ·Δz / (π·t_p·(d + t_p)), t_p = 25 µm plating;
 *  - zone attachments (star model): every pad / via / trace vertex inside a fill island connects
 *    to the island hub through the radial spreading resistance of a disc contact of radius a in a
 *    sheet of sheet-resistance R□ = ρ/t out to the island's equivalent radius L = √(A/π):
 *      R = R□/(2π) · ln(max(2, L/a))
 *    (two contacts then see R□/(2π)·(ln(L/a1) + ln(L/a2)), the classical two-contact sheet result
 *    with their separation ≈ L). Pads in zones with thermalRelief add 4 spokes of 0.5 mm × gap.
 * Trace endpoints connect (merge) to pads whose polygon contains them or lies within half the
 * trace width, and to vias whose pad they overlap.
 */

/** Vertex merge tolerance (mm). */
export const MERGE_TOL = 1e-3;

/** Default thermal-relief spoke count and width (mm), KiCad defaults. */
const RELIEF_SPOKES = 4;
const RELIEF_SPOKE_WIDTH = 0.5;

export type NetEdgeKind = 'trace' | 'via' | 'zone';

export interface NetEdge {
  a: number;
  b: number;
  /** Resistance at 20 °C (Ω). */
  r20: number;
  kind: NetEdgeKind;
  /** Owning segment record index in {@link NetNetwork.segs} for trace edges, else −1. */
  seg: number;
  /** Heat-deposition geometry (board frame, mm); point-like edges have a == b. */
  layer: CopperLayer;
  /** Second layer for via barrels (heat is split between both). */
  layer2?: CopperLayer;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface NetPin {
  componentId: string;
  ref: string;
  pin: string;
  node: number;
}

export interface TraceSeg {
  /** Index into board.traces. */
  trace: number;
  traceId: string;
  /** Polyline segment index (points[seg] → points[seg+1]). */
  seg: number;
  layer: CopperLayer;
  width: number;
  /** Copper thickness (mm). */
  thickness: number;
  length: number;
  a: Vec2;
  b: Vec2;
  /** Node ids of the start / end vertex. */
  na: number;
  nb: number;
  /** Indices into NetNetwork.edges of this segment's sub-segments, start → end. */
  edges: number[];
}

export interface NetNetwork {
  netId: string;
  netName: string;
  nodeCount: number;
  /** Representative (union-find root) of every node. */
  root: Int32Array;
  edges: NetEdge[];
  pins: NetPin[];
  segs: TraceSeg[];
}

export interface BoardNetwork {
  nets: Map<string, NetNetwork>;
  warnings: string[];
}

interface PadRec {
  comp?: ComponentInstance;
  pin: string;
  key: string;
  layers: Set<CopperLayer>;
  polygon: Vec2[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
  /** Inscribed half-size (mm). */
  inR: number;
  /** Copper area (mm²). */
  area: number;
}

interface Island {
  outer: Vec2[];
  holes: Vec2[][];
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  holeBoxes: { minX: number; minY: number; maxX: number; maxY: number }[];
}

/** Pads of every placed component (and plated, net-assigned mounting holes) grouped by net. */
export function padsByNet(board: Board, parts: Record<string, PartDef>, warnings?: string[]): Map<string, PadRec[]> {
  const layers = stackLayers(board.stackup);
  const inner = layers.filter((l) => l !== 'top' && l !== 'bottom');
  const out = new Map<string, PadRec[]>();
  const push = (net: string, p: PadRec) => {
    let a = out.get(net);
    if (!a) out.set(net, (a = []));
    a.push(p);
  };
  for (const comp of board.components) {
    if (!comp.placed) continue;
    const fp = parts[comp.partId]?.footprint;
    if (!fp) {
      if (warnings && Object.keys(comp.pinNets).length) warnings.push(`${comp.ref}: part ${comp.partId} has no footprint; its pins are not connected to copper`);
      continue;
    }
    for (const pp of placedPads(comp, fp)) {
      const net = comp.pinNets[pp.pad.number];
      if (!net || pp.pad.kind === 'npth') continue;
      const ls = new Set<CopperLayer>();
      for (const l of pp.layers) {
        if (l === 'inner') inner.forEach((x) => ls.add(x));
        else ls.add(l);
      }
      const bb = polygonBBox(pp.polygon);
      push(net, {
        comp,
        pin: pp.pad.number,
        key: `${comp.id}\u0000${pp.pad.number}`,
        layers: ls,
        polygon: pp.polygon,
        ...bb,
        cx: pp.x,
        cy: pp.y,
        inR: Math.min(pp.w, pp.h) / 2,
        area: Math.abs(polygonArea(pp.polygon)),
      });
    }
  }
  for (const h of board.holes) {
    if (!h.plated || !h.netId) continue;
    const d = h.padDiameter ?? h.drill * 1.6;
    const r = d / 2;
    const poly: Vec2[] = [];
    for (let k = 0; k < 16; k++) poly.push([h.x + r * Math.cos((k * Math.PI) / 8), h.y + r * Math.sin((k * Math.PI) / 8)]);
    push(h.netId, {
      pin: '',
      key: `hole\u0000${h.id}`,
      layers: new Set(layers),
      polygon: poly,
      minX: h.x - r,
      minY: h.y - r,
      maxX: h.x + r,
      maxY: h.y + r,
      cx: h.x,
      cy: h.y,
      inR: r,
      area: Math.PI * r * r,
    });
  }
  return out;
}

function ringBox(r: readonly Vec2[]) {
  return polygonBBox(r as Vec2[]);
}

/** Split a zone's fill (even-odd rings) into islands: outer ring + its direct holes. */
export function zoneIslands(zone: Zone, board: Board): Island[] {
  const src = zone.fill && zone.fill.length ? zone.fill : [zone.outline && zone.outline.length >= 3 ? zone.outline : board.outline];
  const rings = src.filter((r) => r && r.length >= 3);
  const boxes = rings.map(ringBox);
  const areas = rings.map((r) => Math.abs(polygonArea(r)));
  const n = rings.length;
  const depth = new Int32Array(n);
  const containers: number[][] = rings.map(() => []);
  for (let i = 0; i < n; i++) {
    const p = rings[i][0];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = boxes[j];
      if (p[0] < b.minX || p[0] > b.maxX || p[1] < b.minY || p[1] > b.maxY) continue;
      if (areas[j] <= areas[i]) continue; // a container must be larger
      if (pointInPolygon(p, rings[j])) {
        depth[i]++;
        containers[i].push(j);
      }
    }
  }
  const islandOf = new Map<number, Island>();
  const islands: Island[] = [];
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 !== 0) continue;
    const isl: Island = { outer: rings[i], holes: [], area: areas[i], ...boxes[i], holeBoxes: [] };
    islandOf.set(i, isl);
    islands.push(isl);
  }
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 === 0) continue;
    // parent = the containing ring with depth − 1 (smallest such)
    let parent = -1;
    for (const j of containers[i]) if (depth[j] === depth[i] - 1 && (parent < 0 || areas[j] < areas[parent])) parent = j;
    const isl = parent >= 0 ? islandOf.get(parent) : undefined;
    if (!isl) continue;
    isl.holes.push(rings[i]);
    isl.holeBoxes.push(boxes[i]);
    isl.area -= areas[i];
  }
  return islands.filter((s) => s.area > 1e-9);
}

/** True when point p (board frame, mm) lies in the island's copper (inside the outer ring, outside its holes). */
export function inIsland(p: Vec2, s: Island): boolean {
  if (p[0] < s.minX || p[0] > s.maxX || p[1] < s.minY || p[1] > s.maxY) return false;
  if (!pointInPolygon(p, s.outer)) return false;
  for (let k = 0; k < s.holes.length; k++) {
    const b = s.holeBoxes[k];
    if (p[0] < b.minX || p[0] > b.maxX || p[1] < b.minY || p[1] > b.maxY) continue;
    if (pointInPolygon(p, s.holes[k])) return false;
  }
  return true;
}

/** Probe points for "does this pad connect to the fill": centre, and points 0.05 mm outside every polygon vertex and edge midpoint (thermal-relief spokes cross the gap there). */
function padProbes(p: PadRec): Vec2[] {
  const pts: Vec2[] = [[p.cx, p.cy]];
  const poly = p.polygon;
  const n = poly.length;
  const push = (q: Vec2) => {
    const dx = q[0] - p.cx;
    const dy = q[1] - p.cy;
    const l = Math.hypot(dx, dy);
    if (l > 1e-9) pts.push([q[0] + (dx / l) * 0.05, q[1] + (dy / l) * 0.05]);
  };
  for (let k = 0; k < n; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % n];
    push(a);
    push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  }
  return pts;
}

class UnionFind {
  parent: number[] = [];
  add(): number {
    const id = this.parent.length;
    this.parent.push(id);
    return id;
  }
  find(i: number): number {
    const p = this.parent;
    let r = i;
    while (p[r] !== r) r = p[r];
    while (p[i] !== r) {
      const n = p[i];
      p[i] = r;
      i = n;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

function projT(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 <= 0) return 0;
  return Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
}

/**
 * Build the resistor networks of the given nets (default: every net with copper or pads).
 * Resistances are at 20 °C (ρ = COPPER_RESISTIVITY).
 */
export function buildBoardNetwork(board: Board, parts: Record<string, PartDef>, netIds?: Iterable<string>): BoardNetwork {
  const warnings: string[] = [];
  const layers = stackLayers(board.stackup);
  const layerSet = new Set<CopperLayer>(layers);
  const z = layerZ(board.stackup);
  const pads = padsByNet(board, parts, warnings);
  const wanted = netIds ? new Set(netIds) : new Set<string>([...board.nets.map((n) => n.id), ...board.traces.map((t) => t.netId), ...pads.keys()]);
  const badLayer = new Set<string>();
  for (const t of board.traces) if (wanted.has(t.netId) && !layerSet.has(t.layer)) badLayer.add(`${t.id}@${t.layer}`);
  if (badLayer.size) warnings.push(`${badLayer.size} trace(s) on layers not present in the ${board.stackup.layers}-layer stackup were ignored`);
  const nets = new Map<string, NetNetwork>();
  for (const netId of wanted) {
    const net = buildNet(board, netId, layerSet, z, pads.get(netId) ?? []);
    if (net) nets.set(netId, net);
  }
  return { nets, warnings };
}

interface SegBuild extends TraceSeg {
  splits: { t: number; node: number }[];
}

function buildNet(
  board: Board,
  netId: string,
  layerSet: Set<CopperLayer>,
  z: Partial<Record<CopperLayer, number>>,
  pads: PadRec[],
): NetNetwork | undefined {
  const stack = board.stackup;
  const uf = new UnionFind();
  const nodeX: number[] = [];
  const nodeY: number[] = [];
  const newNode = (x: number, y: number) => {
    nodeX.push(x);
    nodeY.push(y);
    return uf.add();
  };
  const edges: NetEdge[] = [];
  const rho = COPPER_RESISTIVITY;
  const netName = board.nets.find((n) => n.id === netId)?.name ?? netId;

  /* ---------------------------------------- trace vertices ---------------------------------------- */
  const vhash = new Map<string, number[]>();
  const vkey = (layer: string, ix: number, iy: number) => `${layer}|${ix}|${iy}`;
  const vertex = (layer: CopperLayer, x: number, y: number): number => {
    const ix = Math.round(x / MERGE_TOL);
    const iy = Math.round(y / MERGE_TOL);
    for (let ddx = -1; ddx <= 1; ddx++)
      for (let ddy = -1; ddy <= 1; ddy++) {
        const c = vhash.get(vkey(layer, ix + ddx, iy + ddy));
        if (!c) continue;
        for (const id of c) if (Math.hypot(nodeX[id] - x, nodeY[id] - y) <= MERGE_TOL) return id;
      }
    const id = newNode(x, y);
    const k = vkey(layer, ix, iy);
    const c = vhash.get(k);
    if (c) c.push(id);
    else vhash.set(k, [id]);
    return id;
  };

  const segs: SegBuild[] = [];
  const endpoints: { x: number; y: number; layer: CopperLayer; node: number; w: number }[] = [];
  const vertsByLayer = new Map<CopperLayer, { x: number; y: number; node: number; w: number }[]>();
  board.traces.forEach((tr, ti) => {
    if (tr.netId !== netId || !layerSet.has(tr.layer)) return;
    if (!(tr.width > 0) || !tr.points || tr.points.length < 2) return;
    const tcu = layerCopperMm(stack, tr.layer);
    if (!(tcu > 0) || !Number.isFinite(tcu)) return;
    const ids = tr.points.map((p) => vertex(tr.layer, p[0], p[1]));
    let vl = vertsByLayer.get(tr.layer);
    if (!vl) vertsByLayer.set(tr.layer, (vl = []));
    tr.points.forEach((p, k) => vl!.push({ x: p[0], y: p[1], node: ids[k], w: tr.width }));
    const last = tr.points.length - 1;
    endpoints.push({ x: tr.points[0][0], y: tr.points[0][1], layer: tr.layer, node: ids[0], w: tr.width });
    endpoints.push({ x: tr.points[last][0], y: tr.points[last][1], layer: tr.layer, node: ids[last], w: tr.width });
    for (let k = 0; k < last; k++) {
      const a = tr.points[k];
      const b = tr.points[k + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L <= MERGE_TOL) {
        uf.union(ids[k], ids[k + 1]);
        continue;
      }
      segs.push({
        trace: ti,
        traceId: tr.id,
        seg: k,
        layer: tr.layer,
        width: tr.width,
        thickness: tcu,
        length: L,
        a: [a[0], a[1]],
        b: [b[0], b[1]],
        na: ids[k],
        nb: ids[k + 1],
        edges: [],
        splits: [],
      });
    }
  });

  /* ---------------------------------------------- pins --------------------------------------------- */
  const pinNode = new Map<string, number>();
  const pins: NetPin[] = [];
  const padNodes: number[] = [];
  for (const p of pads) {
    let id = pinNode.get(p.key);
    if (id === undefined) {
      id = newNode(p.cx, p.cy);
      pinNode.set(p.key, id);
      if (p.comp) pins.push({ componentId: p.comp.id, ref: p.comp.ref, pin: p.pin, node: id });
    }
    padNodes.push(id);
  }

  /* ---------------------------------------------- vias --------------------------------------------- */
  const vias = board.vias.filter((v) => v.netId === netId);
  const viaNodes: Map<CopperLayer, number>[] = [];
  for (const v of vias) {
    const span = viaSpan(stack, v.from, v.to);
    const m = new Map<CopperLayer, number>();
    for (const l of span) m.set(l, newNode(v.x, v.y));
    viaNodes.push(m);
    const Ab = barrelAreaMm2(v.drill);
    for (let k = 0; k + 1 < span.length; k++) {
      const dz = Math.abs((z[span[k]] ?? 0) - (z[span[k + 1]] ?? 0));
      if (!(dz > 0)) {
        uf.union(m.get(span[k])!, m.get(span[k + 1])!);
        continue;
      }
      edges.push({
        a: m.get(span[k])!,
        b: m.get(span[k + 1])!,
        r20: (rho * dz * 1e3) / Ab, // ρ·Δz/A with Δz in mm, A in mm² → ×1e3 for SI
        kind: 'via',
        seg: -1,
        layer: span[k],
        layer2: span[k + 1],
        ax: v.x,
        ay: v.y,
        bx: v.x,
        by: v.y,
      });
    }
  }

  /* ------------------------------ trace ↔ pad / via / T-junction attachment ------------------------------ */
  for (const s of segs) {
    const hw = s.width / 2;
    const minX = Math.min(s.a[0], s.b[0]) - hw;
    const maxX = Math.max(s.a[0], s.b[0]) + hw;
    const minY = Math.min(s.a[1], s.b[1]) - hw;
    const maxY = Math.max(s.a[1], s.b[1]) + hw;
    pads.forEach((p, pi) => {
      if (!p.layers.has(s.layer)) return;
      if (p.maxX < minX || p.minX > maxX || p.maxY < minY || p.minY > maxY) return;
      const touch = (q: Vec2) => pointInPolygon(q, p.polygon) || pointPolygonEdgeDistance(q, p.polygon) <= hw + MERGE_TOL;
      const ta = touch(s.a);
      const tb = touch(s.b);
      if (ta) uf.union(s.na, padNodes[pi]);
      if (tb) uf.union(s.nb, padNodes[pi]);
      if (!ta && !tb) {
        const c: Vec2 = [p.cx, p.cy];
        if (pointSegmentDistance(c, s.a, s.b) <= p.inR) s.splits.push({ t: projT(c, s.a, s.b), node: padNodes[pi] });
      }
    });
    vias.forEach((v, vi) => {
      const vn = viaNodes[vi].get(s.layer);
      if (vn === undefined) return;
      const R = v.diameter / 2 + hw + MERGE_TOL;
      if (v.x + R < minX - hw || v.x - R > maxX + hw || v.y + R < minY - hw || v.y - R > maxY + hw) return;
      const c: Vec2 = [v.x, v.y];
      const ta = Math.hypot(s.a[0] - v.x, s.a[1] - v.y) <= R;
      const tb = Math.hypot(s.b[0] - v.x, s.b[1] - v.y) <= R;
      if (ta) uf.union(s.na, vn);
      if (tb) uf.union(s.nb, vn);
      if (!ta && !tb && pointSegmentDistance(c, s.a, s.b) <= R) s.splits.push({ t: projT(c, s.a, s.b), node: vn });
    });
    for (const e of endpoints) {
      if (e.layer !== s.layer) continue;
      const reach = (s.width + e.w) / 2;
      if (e.x < minX - reach || e.x > maxX + reach || e.y < minY - reach || e.y > maxY + reach) continue;
      const p: Vec2 = [e.x, e.y];
      if (Math.hypot(p[0] - s.a[0], p[1] - s.a[1]) <= MERGE_TOL || Math.hypot(p[0] - s.b[0], p[1] - s.b[1]) <= MERGE_TOL) continue;
      if (pointSegmentDistance(p, s.a, s.b) <= reach) s.splits.push({ t: projT(p, s.a, s.b), node: e.node });
    }
  }
  // pad ↔ via overlap (via-in-pad) and pad ↔ pad overlap on a shared layer
  vias.forEach((v, vi) => {
    for (const [l, vn] of viaNodes[vi]) {
      pads.forEach((p, pi) => {
        if (!p.layers.has(l)) return;
        if (v.x < p.minX - v.diameter || v.x > p.maxX + v.diameter || v.y < p.minY - v.diameter || v.y > p.maxY + v.diameter) return;
        const c: Vec2 = [v.x, v.y];
        if (pointInPolygon(c, p.polygon) || pointPolygonEdgeDistance(c, p.polygon) <= v.diameter / 2) uf.union(vn, padNodes[pi]);
      });
    }
  });

  /* ---------------------------------------------- zones --------------------------------------------- */
  for (const zone of board.zones) {
    if (zone.netId !== netId || !layerSet.has(zone.layer)) continue;
    const L = zone.layer;
    const tcu = layerCopperMm(stack, L);
    if (!(tcu > 0)) continue;
    const rs20 = rho / (tcu * 1e-3); // Ω/□
    for (const isl of zoneIslands(zone, board)) {
      const Lc = Math.sqrt(isl.area / Math.PI);
      const spread = (a: number) => (rs20 / (2 * Math.PI)) * Math.log(Math.max(2, Lc / Math.max(a, 1e-3)));
      let hub = -1;
      // One attachment per copper blob: pads first (largest contact), then vias, then trace
      // vertices; anything already merged into an attached node is skipped.
      const attached = new Set<number>();
      const attach = (node: number, x: number, y: number, r: number) => {
        const rt = uf.find(node);
        if (attached.has(rt)) return;
        attached.add(rt);
        if (hub < 0) hub = newNode((isl.minX + isl.maxX) / 2, (isl.minY + isl.maxY) / 2);
        edges.push({ a: node, b: hub, r20: r, kind: 'zone', seg: -1, layer: L, ax: x, ay: y, bx: x, by: y });
      };
      pads.forEach((p, pi) => {
        if (!p.layers.has(L)) return;
        if (p.maxX < isl.minX || p.minX > isl.maxX || p.maxY < isl.minY || p.minY > isl.maxY) return;
        if (!padProbes(p).some((q) => inIsland(q, isl))) return;
        let r = spread(Math.sqrt(p.area / Math.PI));
        if (zone.thermalRelief && p.comp) {
          const gap = Math.max(zone.clearance || 0, 0.2);
          const ws = Math.max(zone.minWidth ?? 0, RELIEF_SPOKE_WIDTH);
          r += (rho * gap * 1e3) / (RELIEF_SPOKES * ws * tcu);
        }
        attach(padNodes[pi], p.cx, p.cy, r);
      });
      vias.forEach((v, vi) => {
        const vn = viaNodes[vi].get(L);
        if (vn === undefined) return;
        const R = v.diameter / 2;
        const probes: Vec2[] = [[v.x, v.y]];
        for (let k = 0; k < 8; k++) probes.push([v.x + (R + 0.05) * Math.cos((k * Math.PI) / 4), v.y + (R + 0.05) * Math.sin((k * Math.PI) / 4)]);
        if (probes.some((q) => inIsland(q, isl))) attach(vn, v.x, v.y, spread(R));
      });
      const seen = new Set<number>();
      for (const v of vertsByLayer.get(L) ?? []) {
        if (seen.has(v.node)) continue;
        seen.add(v.node);
        if (inIsland([v.x, v.y], isl)) attach(v.node, v.x, v.y, spread(v.w / 2));
      }
    }
  }

  /* ------------------------------------- split segments into edges ------------------------------------- */
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si];
    const pts: { t: number; node: number }[] = [{ t: 0, node: s.na }];
    s.splits.sort((p, q) => p.t - q.t);
    for (const sp of s.splits) pts.push(sp);
    pts.push({ t: 1, node: s.nb });
    // merge points closer than MERGE_TOL along the segment
    const chain: { t: number; node: number }[] = [];
    for (const p of pts) {
      const prev = chain[chain.length - 1];
      if (prev && (p.t - prev.t) * s.length <= MERGE_TOL) uf.union(prev.node, p.node);
      else chain.push(p);
    }
    // (if the end vertex merged into a split point just before it, that point's root now
    // represents the end vertex through the union above)
    for (let k = 0; k + 1 < chain.length; k++) {
      const p = chain[k];
      const q = chain[k + 1];
      const len = (q.t - p.t) * s.length;
      const ax = s.a[0] + (s.b[0] - s.a[0]) * p.t;
      const ay = s.a[1] + (s.b[1] - s.a[1]) * p.t;
      const bx = s.a[0] + (s.b[0] - s.a[0]) * q.t;
      const by = s.a[1] + (s.b[1] - s.a[1]) * q.t;
      s.edges.push(edges.length);
      edges.push({ a: p.node, b: q.node, r20: (rho * len * 1e3) / (s.width * s.thickness), kind: 'trace', seg: si, layer: s.layer, ax, ay, bx, by });
    }
  }

  const n = uf.parent.length;
  if (n === 0) return undefined;
  const root = new Int32Array(n);
  for (let i = 0; i < n; i++) root[i] = uf.find(i);
  const outSegs: TraceSeg[] = segs.map(({ splits: _s, ...rest }) => rest);
  return { netId, netName, nodeCount: n, root, edges, pins, segs: outSegs };
}
