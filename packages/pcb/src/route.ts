/**
 * Grid-based A* maze router with vias, 45° moves, rip-up-and-reroute and exact verification.
 *
 * Model
 *  - Nodes are grid points (pitch `grid`, aligned to multiples of the pitch) on each routing layer.
 *  - Obstacles (pads, traces, vias, holes, board edge) are rasterised per *trace class* (distinct
 *    half-widths) into count grids: a node is blocked when its centre is closer than
 *    clearance + halfWidth + m to obstacle copper, where m is chosen so that any straight move between
 *    two free nodes is clearance-safe (two discs of radius √(D² + L²/4) cover the stadium of radius D
 *    around a move of length L). Orthogonal and diagonal moves use separate margins.
 *  - Counts are additive, so committing / ripping up a route is exact (+1 / −1). While a net is being
 *    routed its own copper is subtracted from the grids ("session"), so A* reads them directly.
 *  - Fixed copper and router-placed copper live in separate grids: in rip-up mode router-placed
 *    copper of other nets may be crossed at a penalty; the crossed nets are ripped up and re-queued.
 *  - Vias are point obstacles checked on every stackup layer, keep hole-to-hole spacing and are never
 *    placed in SMD pads.
 * Search
 *  - Each net is connected island by island (Prim order): sources = the new island's copper,
 *    targets = all copper of the growing tree (pads, earlier routes, existing traces/vias), giving a
 *    Steiner-like tree. Pads are entered anywhere inside their copper; off-grid fine-pitch pads get an
 *    exactly-checked stub.
 *  - Costs: length, layer direction preference (top horizontal, bottom vertical, ...), bends, vias,
 *    congestion history. Failed connections retry with narrower widths (trace width, then the minimum).
 *  - Every committed segment/via is finally verified exactly against all other-net copper.
 */
import { newId, type Board, type CopperLayer, type PartDef, type Trace, type Vec2, type Via } from '@pcbcad/core';
import { analyzeConnectivity } from './connectivity';
import { HOLE_TO_HOLE } from './constants';
import { bbInflate, distPtSeg2, makePrim, nowMs, polylineLength, primGap, primPtDist, type Prim } from './geom';
import { allLayersMask, boardBBox, boardEdges, buildCopperModel, holeCopperPrim, layerBit, netTraceWidth, stackLayers, tracePrims, viaMask, type PadInfo } from './model';
import { GridIndex } from './spatial';
import { fillZonesInPlace } from './zones';

export interface AutoRouteOptions {
  /** Only route these nets (ids or names). Default: all nets. */
  nets?: string[];
  /** Never route these nets (ids or names), e.g. GND when a ground pour connects it. */
  skipNets?: string[];
  /** Copper layers to route on (default: all stackup layers). Through vias always span the whole stack. */
  layers?: CopperLayer[];
  /** Routing grid pitch (mm). Default rules.routingGrid. */
  grid?: number;
  /** Time budget (ms). Default 30 000. */
  maxTimeMs?: number;
  /** Rip-up-and-reroute passes after the first pass (only run while connections fail). Default 20. */
  ripupPasses?: number;
  /** Cost of a via in mm of trace length. Default max(1, 6·grid). */
  viaCost?: number;
}

export interface AutoRouteResult {
  board: Board;
  /** Nets that needed routing and are now fully connected. */
  routed: string[];
  failed: { netId: string; name: string; reason: string }[];
  stats: { segments: number; vias: number; lengthMm: number; timeMs: number };
}

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];
/** Bend penalty (mm) by number of 45° steps between successive move directions. */
const BEND = [0, 0.08, 0.3, 1.5, 4];
const EPSR = 1e-4;
const MAX_CELLS = 3_000_000;
/** Penalty (mm) for entering a node blocked only by another net's router-placed copper (rip-up mode). */
const SOFT_PENALTY = 4;

interface TraceClass {
  hw: number;
  mO: number;
  mD: number;
  /** per routing layer: counts of fixed obstacles within the orthogonal / diagonal threshold */
  fixO: Uint16Array[];
  fixD: Uint16Array[];
  /** per routing layer: counts of router-placed copper */
  softO: Uint16Array[];
  softD: Uint16Array[];
}

interface Obst {
  prim: Prim;
  layers: number;
  clr: number;
  net: number;
}

interface ExactItem extends Obst {
  alive: boolean;
  routed: boolean;
}

interface RSeg {
  layer: number;
  prim: Prim;
  exact: number;
}

interface RVia {
  x: number;
  y: number;
  prim: Prim;
  hole: Prim;
  exact: number;
  drill: number;
}

interface RIsland {
  pads: PadInfo[];
  copper: { prim: Prim; layers: number }[];
  anchors: Vec2[];
  inTree: boolean;
  failed: string | null;
}

interface NetState {
  idx: number;
  id: string;
  name: string;
  /** trace class indices: preferred width first, then narrower fallbacks */
  classes: number[];
  islands: RIsland[];
  own: Obst[];
  segs: RSeg[];
  vias: RVia[];
  traces: Trace[];
  viaObjs: Via[];
  unplaced: string[];
  len: number;
}

interface Term {
  node: number;
  stub: Vec2 | null;
  pad: PadInfo | null;
}

/**
 * Route unrouted nets. Returns a new board (input untouched) with added traces/vias; zones that had
 * fills are refilled so the result stays DRC-clean.
 */
export function autoRoute(board: Board, parts: Record<string, PartDef>, opts: AutoRouteOptions = {}): AutoRouteResult {
  const t0 = nowMs();
  const out = structuredClone(board);
  const router = new Router(out, parts, opts, t0);
  const res = router.run();
  return { board: out, ...res, stats: { ...res.stats, timeMs: Math.round(nowMs() - t0) } };
}

class Router {
  private readonly rules: Board['rules'];
  private readonly stack: CopperLayer[];
  private readonly nS: number;
  private readonly allMask: number;
  private rLayers: number[] = [];
  private nL = 0;
  private layerToRl: Int8Array;
  private g = 0.25;
  private ox = 0;
  private oy = 0;
  private W = 0;
  private H = 0;
  private NC = 0;
  private outside!: Uint8Array;
  private classes: TraceClass[] = [];
  private viaR: number;
  private viaDrill: number;
  private viaFix: Uint16Array[] = [];
  private viaSoft: Uint16Array[] = [];
  private drillBlock!: Uint16Array;
  private viaKeep!: Uint8Array;
  private hist!: Float32Array;
  // A*
  private gS!: Float32Array;
  private par!: Int32Array;
  private seen!: Uint32Array;
  private closed!: Uint32Array;
  private dirA!: Int8Array;
  private tgt!: Uint32Array;
  private sid = 0;
  private heapK = new Float64Array(1024);
  private heapV = new Int32Array(1024);
  private heapN = 0;
  // exact geometry
  private exact!: GridIndex;
  private exactItems: ExactItem[] = [];
  private drillIdx!: GridIndex;
  private drillItems: { prim: Prim; alive: boolean }[] = [];
  private maxClr = 0;
  private nets: NetState[] = [];
  private netIdx = new Map<string, number>();
  private session: NetState | null = null;
  private readonly deadline: number;
  private readonly viaCost: number;
  private timedOut = false;
  private readonly tmp: number[] = [];
  /** Diagnostics: searches run and nodes expanded. */
  readonly counters = { searches: 0, expanded: 0 };

  constructor(
    private readonly board: Board,
    private readonly parts: Record<string, PartDef>,
    private readonly opts: AutoRouteOptions,
    t0: number,
  ) {
    this.rules = board.rules;
    this.stack = stackLayers(board);
    this.nS = this.stack.length;
    this.allMask = allLayersMask(this.stack);
    this.layerToRl = new Int8Array(this.nS).fill(-1);
    this.viaR = Math.max(this.rules.viaDiameter, this.rules.viaDrill) / 2;
    this.viaDrill = this.rules.viaDrill;
    this.deadline = t0 + (opts.maxTimeMs ?? 30_000);
    const g = opts.grid && opts.grid > 0 ? opts.grid : this.rules.routingGrid > 0 ? this.rules.routingGrid : 0.25;
    this.g = g;
    this.viaCost = opts.viaCost ?? Math.max(1, 6 * g);
  }

  run(): Omit<AutoRouteResult, 'board'> {
    const board = this.board;
    const netName = (id: string) => board.nets.find((n) => n.id === id)?.name ?? id;
    const resolve = (refs: string[] | undefined) => {
      const set = new Set<string>();
      for (const r of refs ?? []) {
        const n = board.nets.find((x) => x.id === r) ?? board.nets.find((x) => x.name.toLowerCase() === String(r).toLowerCase());
        set.add(n ? n.id : r);
      }
      return set;
    };
    const only = this.opts.nets?.length ? resolve(this.opts.nets) : null;
    const skip = resolve(this.opts.skipNets);
    const want = this.opts.layers?.length ? new Set(this.opts.layers) : null;
    this.rLayers = this.stack.map((l, i) => (want && !want.has(l) ? -1 : i)).filter((i) => i >= 0);
    this.nL = this.rLayers.length;
    this.rLayers.forEach((s, rl) => (this.layerToRl[s] = rl));

    // which nets need routing (zone fills count as connections)
    const full = analyzeConnectivity(board, this.parts);
    const noZoneModel = buildCopperModel(board, this.parts, { zones: false });
    const conn = analyzeConnectivity(board, this.parts, noZoneModel);
    const failed: AutoRouteResult['failed'] = [];
    const todo: string[] = [];
    for (const [netId, islands] of full.nets) {
      if (!netId || skip.has(netId) || (only && !only.has(netId))) continue;
      if (islands.length > 1) todo.push(netId);
    }
    if (!todo.length || !this.nL || !board.outline || board.outline.length < 3) {
      for (const id of todo) failed.push({ netId: id, name: netName(id), reason: !this.nL ? 'no routing layers' : 'board has no outline' });
      return { routed: [], failed, stats: { segments: 0, vias: 0, lengthMm: 0, timeMs: 0 } };
    }

    this.setupGrid();
    board.nets.forEach((n) => this.netIdx.set(n.id, this.netIdx.size + 1));
    const nidx = (id: string) => {
      if (!id) return 0;
      let v = this.netIdx.get(id);
      if (v === undefined) {
        v = this.netIdx.size + 1;
        this.netIdx.set(id, v);
      }
      return v;
    };
    // trace classes: preferred width, then rules.traceWidth, then rules.minTraceWidth
    const widthsOf = new Map<string, number[]>();
    const hws = new Set<number>();
    const minHw = Math.max(0.01, this.rules.minTraceWidth / 2);
    for (const id of todo) {
      const hw = Math.max(minHw, netTraceWidth(board, id) / 2);
      const list = [hw];
      for (const f of [this.rules.traceWidth / 2, minHw]) if (f > 0 && f < list[list.length - 1] - 1e-9) list.push(f);
      widthsOf.set(id, list);
      for (const w of list) hws.add(w);
    }
    const hwList = [...hws].sort((a, b) => a - b);
    const cmin = Math.max(1e-3, Math.min(this.rules.clearance, this.rules.edgeClearance));
    const outside = this.outside;
    for (const hw of hwList) {
      const D = cmin + hw;
      const fixed = () =>
        Array.from({ length: this.nL }, () => {
          const a = new Uint16Array(this.NC);
          for (let i = 0; i < this.NC; i++) a[i] = outside[i];
          return a;
        });
      const zero = () => Array.from({ length: this.nL }, () => new Uint16Array(this.NC));
      this.classes.push({
        hw,
        mO: Math.sqrt(D * D + (this.g * this.g) / 4) - D,
        mD: Math.sqrt(D * D + (this.g * this.g) / 2) - D,
        fixO: fixed(),
        fixD: fixed(),
        softO: zero(),
        softD: zero(),
      });
    }
    this.viaFix = Array.from({ length: this.nS }, () => {
      const a = new Uint16Array(this.NC);
      for (let i = 0; i < this.NC; i++) a[i] = outside[i];
      return a;
    });
    this.viaSoft = Array.from({ length: this.nS }, () => new Uint16Array(this.NC));
    this.drillBlock = new Uint16Array(this.NC);
    this.viaKeep = new Uint8Array(this.NC);
    const N = this.NC * this.nL;
    this.hist = new Float32Array(N);
    this.gS = new Float32Array(N);
    this.par = new Int32Array(N);
    this.seen = new Uint32Array(N);
    this.closed = new Uint32Array(N);
    this.dirA = new Int8Array(N);
    this.tgt = new Uint32Array(N);
    const ext = bbInflate(boardBBox(board), 2);
    this.exact = new GridIndex(ext, 2, 1024);
    this.drillIdx = new GridIndex(ext, 2, 256);

    // fixed obstacles
    const clr = this.rules.clearance;
    const ownByNet = new Map<number, Obst[]>();
    const addFixed = (o: Obst) => {
      this.raster(o, false, 1);
      this.addExact(o, false);
      if (o.net) {
        const l = ownByNet.get(o.net) ?? [];
        l.push(o);
        ownByNet.set(o.net, l);
      }
    };
    for (const p of noZoneModel.pads) {
      if (!p.placed) continue;
      if (p.prim) addFixed({ prim: p.prim, layers: p.layers, clr, net: nidx(p.netId) });
      else if (p.hole) addFixed({ prim: p.hole, layers: this.allMask, clr, net: 0 });
      if (p.hole) this.addDrill(p.hole);
      if (p.prim && p.pad.kind === 'smd') this.markViaKeep(p.prim);
    }
    for (const t of board.traces ?? []) {
      const bit = layerBit(this.stack, t.layer);
      if (!bit) continue;
      for (const prim of tracePrims(t)) addFixed({ prim, layers: bit, clr, net: nidx(t.netId) });
    }
    for (const v of board.vias ?? []) {
      addFixed({ prim: makePrim([[v.x, v.y]], Math.max(v.diameter, v.drill) / 2), layers: viaMask(this.stack, v), clr, net: nidx(v.netId) });
      this.addDrill(makePrim([[v.x, v.y]], v.drill / 2));
    }
    for (const h of board.holes ?? []) {
      const cu = holeCopperPrim(h);
      if (cu) addFixed({ prim: cu, layers: this.allMask, clr, net: nidx(h.netId ?? '') });
      else addFixed({ prim: makePrim([[h.x, h.y]], h.drill / 2), layers: this.allMask, clr, net: 0 });
      this.addDrill(makePrim([[h.x, h.y]], h.drill / 2));
    }
    for (const [a, b] of boardEdges(board)) addFixed({ prim: makePrim([a, b], 0), layers: this.allMask, clr: this.rules.edgeClearance, net: 0 });

    // net states
    for (const id of todo) {
      const idx = nidx(id);
      const unplaced = new Set<string>();
      const islands: RIsland[] = [];
      for (const isl of conn.nets.get(id) ?? []) {
        const pads: PadInfo[] = [];
        const copper: { prim: Prim; layers: number }[] = [];
        for (const itId of isl.items) {
          const it = noZoneModel.items[itId];
          if (it.kind === 'pad' && it.pad) {
            if (!it.pad.placed) unplaced.add(it.pad.comp.ref);
            else pads.push(it.pad);
          } else if (it.prim && it.geometric) copper.push({ prim: it.prim, layers: it.layers });
        }
        if (!pads.length) continue;
        const anchors: Vec2[] = pads.map((p) => [p.pp.x, p.pp.y]);
        for (const c of copper) if (c.prim.pts.length <= 2) anchors.push(c.prim.pts[0]);
        islands.push({ pads, copper, anchors, inTree: false, failed: null });
      }
      const ns: NetState = {
        idx,
        id,
        name: netName(id),
        classes: widthsOf.get(id)!.map((w) => hwList.indexOf(w)),
        islands,
        own: ownByNet.get(idx) ?? [],
        segs: [],
        vias: [],
        traces: [],
        viaObjs: [],
        unplaced: [...unplaced].sort(),
        len: mstLength(islands.map((i) => i.anchors[0])),
      };
      const net = board.nets.find((n) => n.id === id);
      if (net && (net.class === 'power' || net.class === 'ground')) ns.len *= 0.6;
      this.nets.push(ns);
    }
    this.nets.sort((a, b) => a.len - b.len || (a.name < b.name ? -1 : 1));

    // pass 1
    for (const ns of this.nets) {
      if (this.timeUp()) break;
      this.connectNet(ns, false);
    }
    // rip-up and reroute
    const passes = this.opts.ripupPasses ?? 20;
    for (let pass = 0; pass < passes && !this.timeUp(); pass++) {
      const failing = this.nets.filter((n) => n.islands.some((i) => !i.inTree) && n.islands.length > 1);
      if (!failing.length) break;
      const requeue: NetState[] = [];
      for (const ns of failing) {
        if (this.timeUp()) break;
        for (const isl of ns.islands) if (!isl.inTree) isl.failed = null;
        for (const v of this.connectNet(ns, true)) if (!requeue.includes(v)) requeue.push(v);
      }
      for (const v of requeue) {
        if (this.timeUp()) break;
        for (const isl of v.islands) if (!isl.inTree) isl.failed = null;
        this.connectNet(v, false);
      }
    }
    // final exact verification
    for (const ns of this.nets) {
      if (!this.verifyNet(ns)) {
        this.ripNet(ns);
        for (const isl of ns.islands) isl.failed = 'internal clearance verification failed';
      }
    }
    // write back
    let segments = 0;
    let lengthMm = 0;
    let viaCount = 0;
    board.traces ??= [];
    board.vias ??= [];
    for (const ns of this.nets) {
      for (const t of ns.traces) {
        board.traces.push(t);
        segments += t.points.length - 1;
        lengthMm += polylineLength(t.points);
      }
      for (const v of ns.viaObjs) board.vias.push(v);
      viaCount += ns.viaObjs.length;
    }
    const filled = (board.zones ?? []).filter((z) => z.fill && z.fill.length);
    if (filled.length) fillZonesInPlace(board, this.parts, new Set(filled.map((z) => z.id)));
    const after = analyzeConnectivity(board, this.parts);
    const routed: string[] = [];
    for (const ns of this.nets) {
      const islands = after.nets.get(ns.id) ?? [];
      if (islands.length <= 1) {
        routed.push(ns.id);
        continue;
      }
      const bad = ns.islands.find((i) => i.failed);
      let reason: string;
      if (ns.unplaced.length && (!bad || ns.islands.every((i) => i.inTree || !i.failed))) reason = `components not placed: ${ns.unplaced.join(', ')}`;
      else if (bad?.failed) reason = bad.failed;
      else reason = this.timedOut ? 'time limit reached' : 'could not connect all pads';
      const missing = islands.length - 1;
      failed.push({ netId: ns.id, name: ns.name, reason: `${missing} connection${missing > 1 ? 's' : ''} unrouted: ${reason}` });
    }
    return { routed, failed, stats: { segments, vias: viaCount, lengthMm: Math.round(lengthMm * 1000) / 1000, timeMs: 0 } };
  }

  private timeUp(): boolean {
    if (!this.timedOut && nowMs() > this.deadline) this.timedOut = true;
    return this.timedOut;
  }

  /* ------------------------------------------------ grid ------------------------------------------------ */

  private setupGrid(): void {
    const bb = boardBBox(this.board);
    let g = this.g;
    const cells = () => ((bb.maxX - bb.minX) / g + 4) * ((bb.maxY - bb.minY) / g + 4);
    if (cells() > MAX_CELLS) g = g * Math.sqrt(cells() / MAX_CELLS) * 1.01;
    this.g = g;
    this.ox = Math.floor(bb.minX / g) * g - g;
    this.oy = Math.floor(bb.minY / g) * g - g;
    this.W = Math.ceil((bb.maxX - this.ox) / g) + 2;
    this.H = Math.ceil((bb.maxY - this.oy) / g) + 2;
    this.NC = this.W * this.H;
    const W = this.W;
    const H = this.H;
    const outside = new Uint8Array(this.NC).fill(1);
    const fillRing = (ring: Vec2[], value: number) => {
      for (let j = 1; j < H - 1; j++) {
        const y = this.oy + j * g;
        const xs: number[] = [];
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const ya = ring[a][1];
          const yb = ring[b][1];
          if (ya > y !== yb > y) xs.push(ring[a][0] + ((y - ya) * (ring[b][0] - ring[a][0])) / (yb - ya));
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const i0 = Math.max(1, Math.ceil((xs[k] - this.ox) / g));
          const i1 = Math.min(W - 2, Math.floor((xs[k + 1] - this.ox) / g));
          for (let i = i0; i <= i1; i++) outside[j * W + i] = value;
        }
      }
    };
    fillRing(this.board.outline, 0);
    for (const c of this.board.cutouts ?? []) if (c.length >= 3) fillRing(c, 1);
    this.outside = outside;
  }

  private cellX(c: number): number {
    return this.ox + (c % this.W) * this.g;
  }

  private cellY(c: number): number {
    return this.oy + Math.floor(c / this.W) * this.g;
  }

  /** Visit grid cells whose centre is within `reach` of the prim's copper: fn(cell, copperDistance). */
  private forCells(prim: Prim, reach: number, fn: (c: number, d: number) => void): void {
    const g = this.g;
    const bb = prim.bb;
    const i0 = Math.max(1, Math.ceil((bb.minX - reach - this.ox) / g));
    const i1 = Math.min(this.W - 2, Math.floor((bb.maxX + reach - this.ox) / g));
    const j0 = Math.max(1, Math.ceil((bb.minY - reach - this.oy) / g));
    const j1 = Math.min(this.H - 2, Math.floor((bb.maxY + reach - this.oy) / g));
    for (let j = j0; j <= j1; j++) {
      const y = this.oy + j * g;
      const row = j * this.W;
      for (let i = i0; i <= i1; i++) {
        const d = primPtDist(prim, this.ox + i * g, y);
        if (d < reach) fn(row + i, d);
      }
    }
  }

  /** Add (delta=+1) or remove (−1) an obstacle from the fixed or soft count grids of all classes. */
  private raster(o: { prim: Prim; layers: number; clr: number }, soft: boolean, delta: number): void {
    const cls = this.classes;
    let reach = o.clr + this.viaR + EPSR;
    for (const c of cls) reach = Math.max(reach, o.clr + c.hw + c.mD + EPSR);
    const rls: number[] = [];
    const sls: number[] = [];
    for (let s = 0; s < this.nS; s++) {
      if (!(o.layers & (1 << s))) continue;
      sls.push(s);
      if (this.layerToRl[s] >= 0) rls.push(this.layerToRl[s]);
    }
    const tOs = cls.map((c) => o.clr + c.hw + c.mO + EPSR);
    const tDs = cls.map((c) => o.clr + c.hw + c.mD + EPSR);
    const tV = o.clr + this.viaR + EPSR;
    const vArr = soft ? this.viaSoft : this.viaFix;
    this.forCells(o.prim, reach, (cell, d) => {
      for (let k = 0; k < cls.length; k++) {
        if (d >= tDs[k]) continue;
        const c = cls[k];
        const AD = soft ? c.softD : c.fixD;
        const AO = soft ? c.softO : c.fixO;
        const inO = d < tOs[k];
        for (const rl of rls) {
          AD[rl][cell] += delta;
          if (inO) AO[rl][cell] += delta;
        }
      }
      if (d < tV) for (const s of sls) vArr[s][cell] += delta;
    });
  }

  private addDrill(hole: Prim): number {
    this.forCells(hole, this.viaDrill / 2 + HOLE_TO_HOLE + EPSR, (cell) => (this.drillBlock[cell] += 1));
    const id = this.drillItems.length;
    this.drillItems.push({ prim: hole, alive: true });
    this.drillIdx.insert(id, hole.bb);
    return id;
  }

  private removeDrill(id: number): void {
    const d = this.drillItems[id];
    if (!d || !d.alive) return;
    d.alive = false;
    this.drillIdx.remove(id, d.prim.bb);
    this.forCells(d.prim, this.viaDrill / 2 + HOLE_TO_HOLE + EPSR, (cell) => (this.drillBlock[cell] -= 1));
  }

  private markViaKeep(prim: Prim): void {
    this.forCells(prim, this.viaR + 0.02, (cell) => (this.viaKeep[cell] = 1));
  }

  private addExact(o: Obst, routed: boolean): number {
    const id = this.exactItems.length;
    this.exactItems.push({ ...o, alive: true, routed });
    this.exact.insert(id, o.prim.bb);
    if (o.clr > this.maxClr) this.maxClr = o.clr;
    return id;
  }

  private removeExact(id: number): void {
    const it = this.exactItems[id];
    if (!it.alive) return;
    it.alive = false;
    this.exact.remove(id, it.prim.bb);
  }

  /**
   * Exact clearance test of a prim of net `net` on a stack-layer mask. With `victims`, conflicts with
   * router-placed copper are collected instead of failing; conflicts with fixed copper always fail.
   */
  private clear(prim: Prim, layers: number, net: number, victims?: Set<number>): boolean {
    const ids = this.exact.query(bbInflate(prim.bb, this.maxClr + 1e-3), this.tmp);
    for (const id of ids) {
      const it = this.exactItems[id];
      if (!it.alive || !(it.layers & layers) || (it.net !== 0 && it.net === net)) continue;
      if (primGap(prim, it.prim) < it.clr - 1e-6) {
        if (victims && it.routed) victims.add(it.net);
        else return false;
      }
    }
    return true;
  }

  private viaHoleClear(x: number, y: number, ignore: number): boolean {
    const hole = makePrim([[x, y]], this.viaDrill / 2);
    const ids = this.drillIdx.query(bbInflate(hole.bb, HOLE_TO_HOLE + 1e-3), this.tmp);
    for (const id of ids) {
      if (id === ignore) continue;
      const d = this.drillItems[id];
      if (d.alive && primGap(hole, d.prim) < HOLE_TO_HOLE - 1e-6) return false;
    }
    return true;
  }

  /* ----------------------------------------------- states ----------------------------------------------- */

  /** Node state for a trace endpoint (orthogonal threshold): 0 free, 1 other routes (soft), 2 blocked. */
  private stO(cl: TraceClass, rl: number, c: number): number {
    return cl.fixO[rl][c] ? 2 : cl.softO[rl][c] ? 1 : 0;
  }

  /** Via state at a cell: 0 free, 1 soft, 2 blocked. */
  private stV(c: number): number {
    if (this.drillBlock[c] || this.viaKeep[c]) return 2;
    let v = 0;
    for (let s = 0; s < this.nS; s++) {
      if (this.viaFix[s][c]) return 2;
      if (this.viaSoft[s][c]) v = 1;
    }
    return v;
  }

  private segObst(s: RSeg, net: number): Obst {
    return { prim: s.prim, layers: 1 << s.layer, clr: this.rules.clearance, net };
  }

  private viaObst(v: RVia, net: number): Obst {
    return { prim: v.prim, layers: this.allMask, clr: this.rules.clearance, net };
  }

  /** Start routing a net: remove its own copper from the shared grids. */
  private beginNet(ns: NetState): void {
    for (const o of ns.own) this.raster(o, false, -1);
    for (const s of ns.segs) this.raster(this.segObst(s, ns.idx), true, -1);
    for (const v of ns.vias) this.raster(this.viaObst(v, ns.idx), true, -1);
    this.session = ns;
  }

  /** Finish routing a net: put its own copper (old and new) back into the grids. */
  private endNet(ns: NetState): void {
    for (const o of ns.own) this.raster(o, false, 1);
    for (const s of ns.segs) this.raster(this.segObst(s, ns.idx), true, 1);
    for (const v of ns.vias) this.raster(this.viaObst(v, ns.idx), true, 1);
    this.session = null;
  }

  /** Connect the islands of a net that are not yet in its tree. Returns nets ripped up (soft mode). */
  private connectNet(ns: NetState, soft: boolean): NetState[] {
    const victimsOut: NetState[] = [];
    if (ns.islands.length < 2) return victimsOut;
    if (!ns.islands.some((i) => i.inTree)) {
      let best = ns.islands[0];
      for (const i of ns.islands) if (i.pads.length > best.pads.length) best = i;
      best.inTree = true;
    }
    this.beginNet(ns);
    try {
      for (;;) {
        if (this.timeUp()) break;
        const treeAnchors = this.treeAnchors(ns);
        let pick: RIsland | null = null;
        let pickD = Infinity;
        let pickPt: Vec2 = treeAnchors[0];
        for (const isl of ns.islands) {
          if (isl.inTree || isl.failed) continue;
          for (const a of isl.anchors) {
            for (const t of treeAnchors) {
              const d = (a[0] - t[0]) ** 2 + (a[1] - t[1]) ** 2;
              if (d < pickD) {
                pickD = d;
                pick = isl;
                pickPt = t;
              }
            }
          }
        }
        if (!pick) break;
        const res = this.connectIsland(ns, pick, pickPt, soft);
        if (res.ok) {
          pick.inTree = true;
          for (const v of res.victims) if (!victimsOut.includes(v)) victimsOut.push(v);
        } else pick.failed = res.reason;
      }
    } finally {
      this.endNet(ns);
    }
    return victimsOut;
  }

  private treeAnchors(ns: NetState): Vec2[] {
    const out: Vec2[] = [];
    for (const i of ns.islands) if (i.inTree) out.push(...i.anchors);
    for (const s of ns.segs) out.push(s.prim.pts[0], s.prim.pts[s.prim.pts.length - 1]);
    return out;
  }

  private connectIsland(ns: NetState, isl: RIsland, partner: Vec2, soft: boolean): { ok: boolean; reason: string; victims: NetState[] } {
    const tries: { k: number; full: boolean }[] = [{ k: ns.classes[0], full: false }, { k: ns.classes[0], full: true }];
    for (const k of ns.classes.slice(1)) tries.push({ k, full: true });
    let unreachable = true;
    let dstEmpty = false;
    for (const t of tries) {
      if (this.timeUp()) return { ok: false, reason: 'time limit reached', victims: [] };
      const cl = this.classes[t.k];
      const src = this.islandTerms(ns, isl, cl, soft);
      if (!src.length) continue;
      unreachable = false;
      const dst: Term[] = [];
      for (const i of ns.islands) if (i.inTree) dst.push(...this.islandTerms(ns, i, cl, soft));
      for (const s of ns.segs) dst.push(...this.copperTerms(s.prim, 1 << s.layer, cl, soft));
      for (const v of ns.vias) dst.push(...this.copperTerms(v.prim, this.allMask, cl, soft));
      if (!dst.length) {
        dstEmpty = true;
        continue;
      }
      let bounds: [number, number, number, number] = [1, this.W - 2, 1, this.H - 2];
      if (!t.full) {
        let minX = partner[0];
        let maxX = partner[0];
        let minY = partner[1];
        let maxY = partner[1];
        for (const a of isl.anchors) {
          minX = Math.min(minX, a[0]);
          maxX = Math.max(maxX, a[0]);
          minY = Math.min(minY, a[1]);
          maxY = Math.max(maxY, a[1]);
        }
        const m = Math.max(4, 0.35 * Math.max(maxX - minX, maxY - minY));
        bounds = [
          Math.max(1, Math.floor((minX - m - this.ox) / this.g)),
          Math.min(this.W - 2, Math.ceil((maxX + m - this.ox) / this.g)),
          Math.max(1, Math.floor((minY - m - this.oy) / this.g)),
          Math.min(this.H - 2, Math.ceil((maxY + m - this.oy) / this.g)),
        ];
      }
      const path = this.search(src, dst, cl, soft, bounds, partner);
      if (!path) continue;
      const geo = this.buildGeometry(ns, path.nodes, path.src, path.dst, cl.hw);
      const victims = new Set<number>();
      if (soft) {
        let ok = true;
        for (const r of geo.runs) for (let i = 1; i < r.pts.length && ok; i++) ok = this.clear(makePrim([r.pts[i - 1], r.pts[i]], cl.hw), 1 << r.layer, ns.idx, victims);
        for (const v of geo.vias) if (ok) ok = this.clear(makePrim([v], this.viaR), this.allMask, ns.idx, victims);
        victims.delete(ns.idx);
        if (!ok) continue;
        for (const node of path.nodes) {
          const rl = (node / this.NC) | 0;
          if (this.stO(cl, rl, node - rl * this.NC) === 1) this.hist[node] += 1;
        }
      }
      const victimStates = this.nets.filter((n) => victims.has(n.idx));
      for (const v of victimStates) this.ripNet(v);
      this.commit(ns, geo, cl.hw);
      return { ok: true, reason: '', victims: victimStates };
    }
    const p = isl.pads[0];
    let reason: string;
    if (unreachable) {
      const onLayer = isl.pads.some((q) => this.rLayers.some((s) => q.layers & (1 << s)));
      reason = onLayer
        ? `pad ${p.comp.ref}.${p.pad.number} is not reachable (blocked by neighbouring copper)`
        : `pad ${p.comp.ref}.${p.pad.number} is not on a routing layer`;
    } else if (dstEmpty) reason = 'the rest of the net is not reachable (blocked by neighbouring copper)';
    else reason = soft ? `no path from ${p.comp.ref}.${p.pad.number}, even when ripping up other routes` : `no path from ${p.comp.ref}.${p.pad.number}`;
    return { ok: false, reason, victims: [] };
  }

  private allowed(st: number, soft: boolean): boolean {
    return st === 0 || (soft && st === 1);
  }

  /** Terminal nodes for an island's copper (pads entered anywhere inside their copper). */
  private islandTerms(ns: NetState, isl: RIsland, cl: TraceClass, soft: boolean): Term[] {
    const out: Term[] = [];
    for (const p of isl.pads) out.push(...this.padTerms(ns, p, cl, soft));
    for (const c of isl.copper) out.push(...this.copperTerms(c.prim, c.layers, cl, soft));
    return out;
  }

  private padTerms(ns: NetState, p: PadInfo, cl: TraceClass, soft: boolean): Term[] {
    const out: Term[] = [];
    const prim = p.prim!;
    for (let s = 0; s < this.nS; s++) {
      if (!(p.layers & (1 << s))) continue;
      const rl = this.layerToRl[s];
      if (rl < 0) continue;
      this.forCells(prim, cl.hw * 0.5, (c) => {
        if (this.allowed(this.stO(cl, rl, c), soft)) out.push({ node: rl * this.NC + c, stub: null, pad: p });
      });
    }
    if (out.length) return out;
    // off-grid pad: nearby free cells with an exactly checked stub into the pad copper
    const cands: { node: number; d: number; s: number; c: number }[] = [];
    for (let s = 0; s < this.nS; s++) {
      if (!(p.layers & (1 << s))) continue;
      const rl = this.layerToRl[s];
      if (rl < 0) continue;
      this.forCells(prim, this.g * 1.6, (c, d) => {
        if (this.allowed(this.stO(cl, rl, c), soft)) cands.push({ node: rl * this.NC + c, d, s, c });
      });
    }
    cands.sort((a, b) => a.d - b.d);
    for (const k of cands.slice(0, 24)) {
      const a: Vec2 = [this.cellX(k.c), this.cellY(k.c)];
      for (const target of padStubTargets(p, a)) {
        if (this.clear(makePrim([a, target], cl.hw), 1 << k.s, ns.idx)) {
          out.push({ node: k.node, stub: target, pad: p });
          break;
        }
      }
    }
    return out;
  }

  private copperTerms(prim: Prim, layers: number, cl: TraceClass, soft: boolean): Term[] {
    const out: Term[] = [];
    if (prim.r + cl.hw - 0.02 <= 0) return out;
    for (let s = 0; s < this.nS; s++) {
      if (!(layers & (1 << s))) continue;
      const rl = this.layerToRl[s];
      if (rl < 0) continue;
      this.forCells(prim, cl.hw - 0.02, (c) => {
        if (this.allowed(this.stO(cl, rl, c), soft)) out.push({ node: rl * this.NC + c, stub: null, pad: null });
      });
    }
    return out;
  }

  /* ------------------------------------------------- A* ------------------------------------------------- */

  private push(k: number, v: number): void {
    if (this.heapN >= this.heapK.length) {
      const nk = new Float64Array(this.heapK.length * 2);
      nk.set(this.heapK);
      const nv = new Int32Array(this.heapV.length * 2);
      nv.set(this.heapV);
      this.heapK = nk;
      this.heapV = nv;
    }
    const K = this.heapK;
    const V = this.heapV;
    let i = this.heapN++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= k) break;
      K[i] = K[p];
      V[i] = V[p];
      i = p;
    }
    K[i] = k;
    V[i] = v;
  }

  private pop(): number {
    const K = this.heapK;
    const V = this.heapV;
    const top = V[0];
    const n = --this.heapN;
    if (n > 0) {
      const k = K[n];
      const v = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= k) break;
        K[i] = K[c];
        V[i] = V[c];
        i = c;
      }
      K[i] = k;
      V[i] = v;
    }
    return top;
  }

  private search(
    src: Term[],
    dst: Term[],
    cl: TraceClass,
    soft: boolean,
    bounds: [number, number, number, number],
    partner: Vec2,
  ): { nodes: number[]; src: Term; dst: Term } | null {
    this.counters.searches++;
    this.sid++;
    if (this.sid >= 0xfffffff0) {
      this.seen.fill(0);
      this.closed.fill(0);
      this.tgt.fill(0);
      this.sid = 1;
    }
    const sid = this.sid;
    const { W, NC, g } = this;
    const [i0, i1, j0, j1] = bounds;
    const dstMap = new Map<number, Term>();
    for (const t of dst) {
      this.tgt[t.node] = sid;
      const prev = dstMap.get(t.node);
      if (!prev || (prev.stub && !t.stub)) dstMap.set(t.node, t);
    }
    const srcMap = new Map<number, Term>();
    this.heapN = 0;
    const hx = partner[0];
    const hy = partner[1];
    const ox = this.ox;
    const oy = this.oy;
    const H = (c: number) => {
      const dx = Math.abs(ox + (c % W) * g - hx);
      const dy = Math.abs(oy + Math.floor(c / W) * g - hy);
      return 1.05 * (dx > dy ? dx + 0.41421356 * dy : dy + 0.41421356 * dx);
    };
    for (const t of src) {
      const c = t.node % NC;
      const ci = c % W;
      const cj = (c / W) | 0;
      if (ci < i0 || ci > i1 || cj < j0 || cj > j1) continue;
      const g0 = t.stub ? Math.hypot(this.cellX(c) - t.stub[0], this.cellY(c) - t.stub[1]) : 0;
      if (this.seen[t.node] === sid && this.gS[t.node] <= g0) continue;
      this.seen[t.node] = sid;
      this.gS[t.node] = g0;
      this.par[t.node] = -1;
      this.dirA[t.node] = -1;
      srcMap.set(t.node, t);
      this.push(g0 + H(c), t.node);
    }
    const nL = this.nL;
    const multi = nL > 1;
    const offs = DX.map((dx, d) => dx + DY[d] * W);
    const orthCostH = g;
    const orthCostOff = g * (multi ? 1.3 : 1);
    const diagCost = g * Math.SQRT2 * (multi ? 1.08 : 1);
    const histW = g * 1.5;
    const viaCost = this.viaCost;
    const hist = this.hist;
    const seen = this.seen;
    const closed = this.closed;
    const gS = this.gS;
    let found = -1;
    let expanded = 0;
    while (this.heapN > 0) {
      const u = this.pop();
      if (closed[u] === sid) continue;
      closed[u] = sid;
      expanded++;
      if (this.tgt[u] === sid) {
        found = u;
        break;
      }
      const rl = (u / NC) | 0;
      const c = u - rl * NC;
      const ci = c % W;
      const cj = (c / W) | 0;
      const gu = gS[u];
      const du = this.dirA[u];
      const fO = cl.fixO[rl];
      const fD = cl.fixD[rl];
      const sO = cl.softO[rl];
      const sD = cl.softD[rl];
      const horizPref = (rl & 1) === 0;
      const base = rl * NC;
      for (let d = 0; d < 8; d++) {
        const ni = ci + DX[d];
        const nj = cj + DY[d];
        if (ni < i0 || ni > i1 || nj < j0 || nj > j1) continue;
        const nc = c + offs[d];
        const v = base + nc;
        if (closed[v] === sid) continue;
        let cost: number;
        let softHit: boolean;
        if (d & 1) {
          if (fD[nc] || fD[c]) continue;
          softHit = sD[nc] !== 0 || sD[c] !== 0;
          cost = diagCost;
        } else {
          if (fO[nc]) continue;
          softHit = sO[nc] !== 0;
          cost = (d === 0 || d === 4) === horizPref ? orthCostH : orthCostOff;
        }
        if (softHit) {
          if (!soft) continue;
          cost += SOFT_PENALTY + hist[v] * g;
        }
        if (du >= 0 && du !== d) {
          let k = du > d ? du - d : d - du;
          if (k > 4) k = 8 - k;
          cost += BEND[k];
        }
        const ng = gu + cost + hist[v] * histW;
        if (seen[v] !== sid || ng < gS[v]) {
          seen[v] = sid;
          gS[v] = ng;
          this.par[v] = u;
          this.dirA[v] = d;
          this.push(ng + H(nc), v);
        }
      }
      if (multi) {
        const ev = this.stV(c);
        if (ev === 2 || (ev === 1 && !soft)) continue;
        for (let r2 = 0; r2 < nL; r2++) {
          if (r2 === rl) continue;
          const v = r2 * NC + c;
          if (closed[v] === sid) continue;
          const e2 = this.stO(cl, r2, c);
          if (e2 === 2 || (e2 === 1 && !soft)) continue;
          const cost = viaCost + (ev === 1 ? SOFT_PENALTY * 2 : 0) + (e2 === 1 ? SOFT_PENALTY : 0) + hist[v] * histW + (r2 !== rl + 1 && r2 !== rl - 1 ? 0.01 : 0);
          const ng = gu + cost;
          if (seen[v] !== sid || ng < gS[v]) {
            seen[v] = sid;
            gS[v] = ng;
            this.par[v] = u;
            this.dirA[v] = -1;
            this.push(ng + H(c), v);
          }
        }
      }
    }
    this.counters.expanded += expanded;
    if (found < 0) return null;
    const nodes: number[] = [];
    for (let v = found; v >= 0; v = this.par[v]) nodes.push(v);
    nodes.reverse();
    const s = srcMap.get(nodes[0]) ?? { node: nodes[0], stub: null, pad: null };
    const t = dstMap.get(found) ?? { node: found, stub: null, pad: null };
    return { nodes, src: s, dst: t };
  }

  /* ---------------------------------------------- geometry ---------------------------------------------- */

  private buildGeometry(ns: NetState, nodes: number[], src: Term, dst: Term, hw: number): { runs: { layer: number; pts: Vec2[] }[]; vias: Vec2[] } {
    const NC = this.NC;
    const runs: { layer: number; pts: Vec2[] }[] = [];
    const vias: Vec2[] = [];
    let cur: { layer: number; pts: Vec2[] } | null = null;
    for (const node of nodes) {
      const rl = (node / NC) | 0;
      const c = node - rl * NC;
      const p: Vec2 = [round6(this.cellX(c)), round6(this.cellY(c))];
      const layer = this.rLayers[rl];
      if (!cur || cur.layer !== layer) {
        if (cur) vias.push(p);
        cur = { layer, pts: [p] };
        runs.push(cur);
      } else cur.pts.push(p);
    }
    const extend = (run: { layer: number; pts: Vec2[] }, t: Term, atStart: boolean) => {
      const end = atStart ? run.pts[0] : run.pts[run.pts.length - 1];
      let target: Vec2 | null = t.stub;
      if (!target && t.pad && t.pad.layers & (1 << run.layer)) {
        const centre: Vec2 = [t.pad.pp.x, t.pad.pp.y];
        if (Math.hypot(centre[0] - end[0], centre[1] - end[1]) > 1e-6 && this.clear(makePrim([end, centre], hw), 1 << run.layer, ns.idx)) target = centre;
      }
      if (!target) return;
      const q: Vec2 = [round6(target[0]), round6(target[1])];
      if (atStart) run.pts.unshift(q);
      else run.pts.push(q);
    };
    extend(runs[0], src, true);
    extend(runs[runs.length - 1], dst, false);
    for (const r of runs) r.pts = simplify(r.pts);
    return { runs, vias };
  }

  private commit(ns: NetState, geo: { runs: { layer: number; pts: Vec2[] }[]; vias: Vec2[] }, hw: number): void {
    const net = ns.idx;
    const live = this.session !== ns;
    for (const r of geo.runs) {
      const pts = r.pts.length >= 2 ? r.pts : [r.pts[0], r.pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const prim = makePrim([pts[i - 1], pts[i]], hw);
        const o: Obst = { prim, layers: 1 << r.layer, clr: this.rules.clearance, net };
        if (live) this.raster(o, true, 1);
        ns.segs.push({ layer: r.layer, prim, exact: this.addExact(o, true) });
      }
      ns.traces.push({ id: newId('trk'), netId: ns.id, layer: this.stack[r.layer], width: round6(hw * 2), points: pts });
    }
    for (const p of geo.vias) {
      const prim = makePrim([p], this.viaR);
      const hole = makePrim([p], this.viaDrill / 2);
      const o: Obst = { prim, layers: this.allMask, clr: this.rules.clearance, net };
      if (live) this.raster(o, true, 1);
      const exact = this.addExact(o, true);
      const drill = this.addDrill(hole);
      ns.vias.push({ x: p[0], y: p[1], prim, hole, exact, drill });
      ns.viaObjs.push({ id: newId('via'), netId: ns.id, x: p[0], y: p[1], drill: this.viaDrill, diameter: this.viaR * 2 });
    }
  }

  private ripNet(ns: NetState): void {
    const live = this.session !== ns;
    for (const s of ns.segs) {
      if (live) this.raster(this.segObst(s, ns.idx), true, -1);
      this.removeExact(s.exact);
    }
    for (const v of ns.vias) {
      if (live) this.raster(this.viaObst(v, ns.idx), true, -1);
      this.removeExact(v.exact);
      this.removeDrill(v.drill);
    }
    ns.segs = [];
    ns.vias = [];
    ns.traces = [];
    ns.viaObjs = [];
    for (const i of ns.islands) {
      i.inTree = false;
      i.failed = null;
    }
  }

  private verifyNet(ns: NetState): boolean {
    for (const s of ns.segs) if (!this.clear(s.prim, 1 << s.layer, ns.idx)) return false;
    for (const v of ns.vias) {
      if (!this.clear(v.prim, this.allMask, ns.idx)) return false;
      if (!this.viaHoleClear(v.x, v.y, v.drill)) return false;
    }
    return true;
  }
}

/** Candidate stub end points inside a pad: projection on its long axis, then its centre. */
function padStubTargets(p: PadInfo, from: Vec2): Vec2[] {
  const centre: Vec2 = [p.pp.x, p.pp.y];
  const pad = p.pad;
  const w = pad.w;
  const h = pad.shape === 'circle' ? pad.w : pad.h;
  const half = (Math.max(w, h) - Math.min(w, h)) / 2;
  if (half < 1e-6 || pad.shape === 'polygon') return [centre];
  const rad = ((p.pp.rotation || 0) * Math.PI) / 180;
  const u: Vec2 = w > h ? [Math.cos(rad), Math.sin(rad)] : [-Math.sin(rad), Math.cos(rad)];
  const t = Math.max(-half, Math.min(half, (from[0] - centre[0]) * u[0] + (from[1] - centre[1]) * u[1]));
  const proj: Vec2 = [centre[0] + u[0] * t, centre[1] + u[1] * t];
  return distPtSeg2(proj[0], proj[1], centre[0], centre[1], centre[0], centre[1]) < 1e-12 ? [centre] : [proj, centre];
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Remove duplicate and collinear interior points. */
function simplify(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) continue;
    out.push(p);
    while (out.length >= 3) {
      const a = out[out.length - 3];
      const b = out[out.length - 2];
      const c = out[out.length - 1];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
      if (Math.abs(cross) < 1e-9 && dot > 0) out.splice(out.length - 2, 1);
      else break;
    }
  }
  return out;
}

/** Length of the Euclidean MST over points (Prim, O(n²)). */
function mstLength(pts: Vec2[]): number {
  const n = pts.length;
  if (n < 2) return 0;
  const best = new Array<number>(n).fill(Infinity);
  const used = new Array<boolean>(n).fill(false);
  best[0] = 0;
  let total = 0;
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!used[i] && (u < 0 || best[i] < best[u])) u = i;
    used[u] = true;
    total += best[u];
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const d = Math.hypot(pts[i][0] - pts[u][0], pts[i][1] - pts[u][1]);
      if (d < best[i]) best[i] = d;
    }
  }
  return total;
}
