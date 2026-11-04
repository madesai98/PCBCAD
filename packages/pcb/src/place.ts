/**
 * Connectivity-aware automatic placement.
 *
 *  1. Fixed parts (locked, or already placed with keepPlaced) are registered as obstacles.
 *  2. Connectors go to board edges facing outward (explicit `edges` win; otherwise the edge nearest
 *     their current position / round-robin), oriented by ConnectorSpec.matingDirection when known,
 *     else with their long side along the edge.
 *  3. ICs are placed by connectivity (biggest / most connected first, at the centroid of already placed
 *     neighbours); each IC immediately gets its decoupling capacitors next to the supply pins
 *     (supply pin side, supply pad facing the pin) and crystals next to its XTAL pins with load caps.
 *  4. Remaining parts are placed constructively at the centroid of their placed neighbours, choosing
 *     the 90° rotation that minimises half-perimeter wirelength (HPWL).
 *  5. Simulated annealing (moves, 90° rotations, swaps; seeded PRNG) refines HPWL on the
 *     rules.routingGrid lattice. Every accepted move is legal, so the result is always legal:
 *     courtyards (+spacing) never overlap on the same side, stay inside the outline inset by
 *     edgeClearance, avoid cutouts and mounting-hole keep-outs.
 */
import { footprintToBoard, pointInPolygon, rotate2, type Board, type ComponentInstance, type FootprintDef, type PartDef, type Side, type Vec2 } from '@pcbcad/core';
import { IC_CATEGORIES } from './erc';
import { bboxOf, distPtSeg2, mulberry32, nowMs, ringArea as ringAreaOf } from './geom';
import { isGroundNet } from './model';
import { GridIndex } from './spatial';

export type BoardEdge = 'left' | 'right' | 'top' | 'bottom';

export interface AutoPlaceOptions {
  /** Keep components that already have a position (placed === true). Locked parts always stay. */
  keepPlaced?: boolean;
  /** Pin connectors to edges. `offset` is measured along the edge from its centre (mm, +x / +y). */
  edges?: { componentId: string; edge: BoardEdge; offset?: number }[];
  /** Minimum courtyard-to-courtyard spacing (mm). Default 0.5. */
  spacing?: number;
  /** PRNG seed for the annealing phase (deterministic results). Default 1. */
  seed?: number;
}

interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PComp {
  i: number;
  c: ComponentInstance;
  part?: PartDef;
  fp?: FootprintDef;
  side: Side;
  bothSides: boolean;
  /** courtyard offsets per rotation index (0,90,180,270) relative to the origin */
  rect: Rect[];
  /** pin -> local offsets per rotation index */
  pins: Map<string, Vec2[]>;
  fixed: boolean;
  role: 'fixed' | 'edge' | 'ic' | 'decap' | 'crystal' | 'xcap' | 'other';
  placed: boolean;
  x: number;
  y: number;
  r: number;
  nets: string[];
  anchor?: { ic: number; pin: string; capPin: string };
  area: number;
  /** Extra routing room kept around the courtyard while placing (mm per side). */
  halo: number;
  /** Courtyard bbox at the pose it was last inserted with (board frame). */
  box: Rect;
}

const ROTS = [0, 90, 180, 270];

/**
 * Place components inside the board outline. Returns a new board (input untouched) and a report.
 * Must finish 150 components well under 2 s.
 */
export function autoPlace(board: Board, parts: Record<string, PartDef>, opts: AutoPlaceOptions = {}): { board: Board; report: string[] } {
  const out = structuredClone(board);
  const report: string[] = [];
  if (!out.outline || out.outline.length < 3) return { board: out, report: ['Board has no outline; nothing placed.'] };
  const placer = new Placer(out, parts, opts, report);
  placer.run();
  return { board: out, report };
}

class Placer {
  private readonly t0 = nowMs();
  private readonly spacing: number;
  private readonly grid: number;
  private readonly step: number;
  private readonly ec: number;
  private readonly bb: Rect;
  private comps: PComp[] = [];
  private byId = new Map<string, PComp>();
  private netPins = new Map<string, { k: number; pin: string }[]>();
  private netW = new Map<string, number>();
  private idx: { top: GridIndex; bottom: GridIndex };
  // allowed-area raster with summed-area table of "bad" cells
  private rr = 0.25;
  private rx0 = 0;
  private ry0 = 0;
  private rnx = 0;
  private rny = 0;
  private sat!: Int32Array;
  private readonly rand: () => number;
  private readonly tmp: number[] = [];

  constructor(
    private readonly board: Board,
    private readonly parts: Record<string, PartDef>,
    private readonly opts: AutoPlaceOptions,
    private readonly report: string[],
  ) {
    this.spacing = Math.max(0, opts.spacing ?? 0.5);
    this.grid = board.rules.routingGrid > 0 ? board.rules.routingGrid : 0.25;
    this.step = this.grid * Math.max(1, Math.round(0.5 / this.grid));
    this.ec = Math.max(0, board.rules.edgeClearance);
    this.bb = bboxOf(board.outline);
    this.idx = { top: new GridIndex(this.bb, 4, 64), bottom: new GridIndex(this.bb, 4, 64) };
    this.rand = mulberry32(opts.seed ?? 1);
  }

  run(): void {
    const { board, parts } = this;
    for (const c of board.components) {
      const part = parts[c.partId];
      const fp = part?.footprint;
      const pc = this.makeComp(c, part, fp);
      this.comps.push(pc);
      this.byId.set(c.id, pc);
    }
    // nets
    for (const pc of this.comps) {
      for (const [pin, net] of Object.entries(pc.c.pinNets ?? {})) {
        if (!net || !pc.pins.has(pin)) continue;
        const l = this.netPins.get(net) ?? [];
        l.push({ k: pc.i, pin });
        this.netPins.set(net, l);
      }
    }
    const netInfo = new Map(board.nets.map((n) => [n.id, n]));
    for (const [net, pins] of this.netPins) {
      const n = netInfo.get(net);
      const k = pins.length;
      let w = k > 1 ? 1 / (k - 1) : 0;
      if (n && (n.class === 'power' || n.class === 'ground' || isGroundNet(n))) w *= 0.25;
      this.netW.set(net, w);
    }
    for (const pc of this.comps) pc.nets = [...new Set(Object.values(pc.c.pinNets ?? {}).filter((n) => n && this.netPins.has(n)))];
    this.buildRaster();

    // 1. fixed
    let fixedCount = 0;
    for (const pc of this.comps) {
      if (pc.c.locked || (this.opts.keepPlaced && pc.c.placed)) {
        pc.fixed = true;
        pc.role = 'fixed';
        pc.x = pc.c.x;
        pc.y = pc.c.y;
        pc.r = rotIndex(pc.c.rotation);
        pc.placed = true;
        this.insert(pc);
        fixedCount++;
      }
    }
    this.classify();
    this.computeHalos();
    // 2. connectors to edges
    this.placeEdges();
    // 3. ICs with their decaps / crystals
    const ics = this.comps.filter((p) => !p.placed && p.role === 'ic').sort((a, b) => b.nets.length - a.nets.length || b.area - a.area);
    const centre: Vec2 = [(this.bb.minX + this.bb.maxX) / 2, (this.bb.minY + this.bb.maxY) / 2];
    const icQueue = [...ics];
    while (icQueue.length) {
      // most connected to already placed parts first
      icQueue.sort((a, b) => this.placedLinks(b) - this.placedLinks(a) || b.area - a.area);
      const ic = icQueue.shift()!;
      this.placeByAffinity(ic, centre);
      if (ic.placed) this.placeSatellites(ic);
    }
    // 4. everything else
    const rest = this.comps.filter((p) => !p.placed && !p.fixed);
    while (rest.length) {
      rest.sort((a, b) => this.placedLinks(b) - this.placedLinks(a) || b.area - a.area);
      const pc = rest.shift()!;
      if (pc.anchor && !pc.placed) {
        const ic = this.comps[pc.anchor.ic];
        if (ic.placed) this.placeDecap(pc, ic);
      }
      if (!pc.placed) this.placeByAffinity(pc, centre);
    }
    // 5. anneal
    this.anneal();
    // write back
    let placed = 0;
    const failed: string[] = [];
    for (const pc of this.comps) {
      if (pc.fixed) continue;
      if (pc.placed) {
        pc.c.x = round4(pc.x);
        pc.c.y = round4(pc.y);
        pc.c.rotation = ROTS[pc.r];
        pc.c.placed = true;
        placed++;
      } else {
        pc.c.placed = false;
        failed.push(pc.c.ref);
      }
    }
    for (const r of failed) this.report.push(`Could not place ${r}: no free space inside the outline (enlarge the board or reduce spacing).`);
    this.report.push(
      `Placed ${placed} component(s)${fixedCount ? `, kept ${fixedCount} fixed` : ''}${failed.length ? `, ${failed.length} unplaced` : ''}; total wirelength (HPWL) ${this.totalHpwl().toFixed(1)} mm in ${Math.round(nowMs() - this.t0)} ms.`,
    );
  }

  /* ------------------------------------------------ setup ------------------------------------------------ */

  private makeComp(c: ComponentInstance, part: PartDef | undefined, fp: FootprintDef | undefined): PComp {
    let court: Rect | null = null;
    if (fp?.courtyard && fp.courtyard.maxX > fp.courtyard.minX && fp.courtyard.maxY > fp.courtyard.minY) court = { ...fp.courtyard };
    if (!court && fp?.pads?.length) {
      const pts: Vec2[] = [];
      for (const p of fp.pads) pts.push([p.x - p.w / 2, p.y - p.h / 2], [p.x + p.w / 2, p.y + p.h / 2]);
      const b = bboxOf(pts, 0.25);
      court = b;
    }
    if (!court && part?.body) court = { minX: -part.body.w / 2, minY: -part.body.l / 2, maxX: part.body.w / 2, maxY: part.body.l / 2 };
    if (!court) court = { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 };
    const side: Side = c.side === 'bottom' ? 'bottom' : 'top';
    const rect: Rect[] = ROTS.map((rot) => {
      const pose = { x: 0, y: 0, rotation: rot, side };
      const corners: Vec2[] = [
        [court!.minX, court!.minY],
        [court!.maxX, court!.minY],
        [court!.maxX, court!.maxY],
        [court!.minX, court!.maxY],
      ].map((p) => footprintToBoard(pose, p as Vec2));
      return bboxOf(corners);
    });
    const pins = new Map<string, Vec2[]>();
    const acc = new Map<string, { x: number; y: number; n: number }>();
    for (const p of fp?.pads ?? []) {
      const a = acc.get(p.number) ?? { x: 0, y: 0, n: 0 };
      a.x += p.x;
      a.y += p.y;
      a.n++;
      acc.set(p.number, a);
    }
    for (const [pin, a] of acc) {
      const local: Vec2 = [a.x / a.n, a.y / a.n];
      pins.set(
        pin,
        ROTS.map((rot) => footprintToBoard({ x: 0, y: 0, rotation: rot, side }, local)),
      );
    }
    for (const pin of Object.keys(c.pinNets ?? {})) if (!pins.has(pin)) pins.set(pin, ROTS.map(() => [0, 0] as Vec2));
    return {
      i: this.comps.length,
      c,
      part,
      fp,
      side,
      bothSides: !!fp?.pads?.some((p) => p.kind !== 'smd'),
      rect,
      pins,
      fixed: false,
      role: 'other',
      placed: false,
      x: c.x,
      y: c.y,
      r: rotIndex(c.rotation),
      nets: [],
      area: (court.maxX - court.minX) * (court.maxY - court.minY),
      halo: 0,
      box: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    };
  }

  private classify(): void {
    const netInfo = new Map(this.board.nets.map((n) => [n.id, n]));
    const isGnd = (id: string) => isGroundNet(netInfo.get(id));
    for (const pc of this.comps) {
      if (pc.fixed) continue;
      const cat = pc.part?.category;
      if (cat === 'connector' || /^(J|P|CN|USB)\d/i.test(pc.c.ref)) pc.role = 'edge';
      else if (cat && IC_CATEGORIES.has(cat)) pc.role = 'ic';
      else if (pc.pins.size >= 6) pc.role = 'ic';
    }
    // decoupling capacitors
    const powerPins: { ic: PComp; pin: string; net: string; assigned: number }[] = [];
    for (const ic of this.comps) {
      if (ic.role !== 'ic' && !(ic.fixed && ic.part && IC_CATEGORIES.has(ic.part.category))) continue;
      const nets = new Set(Object.values(ic.c.pinNets ?? {}));
      const hasGnd = [...nets].some(isGnd);
      if (!hasGnd) continue;
      for (const [pin, net] of Object.entries(ic.c.pinNets ?? {})) {
        if (!net || isGnd(net)) continue;
        const def = ic.part?.pins?.find((p) => p.number === pin);
        const isPower = def?.type === 'power_in' || /^(VDD|VCC|AVDD|DVDD|VDDA|VDDIO|VIN|VBAT|V\+|VS|VCCA|VCCIO)/i.test(def?.name ?? '');
        if (isPower) powerPins.push({ ic, pin, net, assigned: 0 });
      }
    }
    const caps = this.comps
      .filter((p) => !p.fixed && (p.part?.category === 'capacitor' || p.part?.category === 'capacitor-polarized'))
      .sort((a, b) => capValue(a) - capValue(b));
    for (const cap of caps) {
      const entries = Object.entries(cap.c.pinNets ?? {});
      const g = entries.find(([, n]) => isGnd(n));
      const p = entries.find(([, n]) => n && !isGnd(n));
      if (!g || !p) continue;
      const cands = powerPins.filter((pp) => pp.net === p[1]);
      if (!cands.length) continue;
      cands.sort((a, b) => a.assigned - b.assigned || a.ic.i - b.ic.i);
      const pick = cands[0];
      pick.assigned++;
      cap.role = 'decap';
      cap.anchor = { ic: pick.ic.i, pin: pick.pin, capPin: p[0] };
    }
    // crystals
    for (const x of this.comps) {
      if (x.fixed) continue;
      const cat = x.part?.category;
      if (!(cat === 'crystal' || cat === 'oscillator' || /^Y\d/i.test(x.c.ref))) continue;
      x.role = 'crystal';
      const xNets = new Set(Object.values(x.c.pinNets ?? {}).filter((n) => n && !isGnd(n)));
      let best: { ic: PComp; pins: string[]; score: number } | null = null;
      for (const ic of this.comps) {
        if (ic === x || !(ic.role === 'ic' || (ic.part && IC_CATEGORIES.has(ic.part.category)))) continue;
        const pins = Object.entries(ic.c.pinNets ?? {})
          .filter(([, n]) => xNets.has(n))
          .map(([pin]) => pin)
          .sort((a, b) => xtalPinRank(ic, a) - xtalPinRank(ic, b));
        // prefer the part with the most pins on the crystal nets, MCUs and XTAL-named pins first
        const score = pins.length * 10 + (ic.part?.category === 'mcu' ? 2 : 0) + (pins.some((p) => xtalPinRank(ic, p) === 0) ? 1 : 0);
        if (pins.length && (!best || score > best.score)) best = { ic, pins, score };
      }
      if (best) x.anchor = { ic: best.ic.i, pin: best.pins[0], capPin: best.pins[1] ?? best.pins[0] };
      // load caps
      for (const cap of caps) {
        if (cap.role === 'decap' && cap.anchor) continue;
        const nets = Object.values(cap.c.pinNets ?? {});
        if (nets.some((n) => xNets.has(n)) && nets.some(isGnd)) {
          cap.role = 'xcap';
          cap.anchor = { ic: x.i, pin: Object.entries(cap.c.pinNets).find(([, n]) => xNets.has(n))![0], capPin: '' };
        }
      }
    }
  }

  /** Allowed-area raster: a cell is good when its whole square lies inside outline − edge clearance − keepouts. */
  private buildRaster(): void {
    const b = this.board;
    const span = Math.max(this.bb.maxX - this.bb.minX, this.bb.maxY - this.bb.minY);
    this.rr = Math.max(0.1, Math.min(0.25, span / 800));
    const rr = this.rr;
    this.rx0 = this.bb.minX;
    this.ry0 = this.bb.minY;
    this.rnx = Math.max(1, Math.ceil((this.bb.maxX - this.bb.minX) / rr));
    this.rny = Math.max(1, Math.ceil((this.bb.maxY - this.bb.minY) / rr));
    const nx = this.rnx;
    const ny = this.rny;
    const bad = new Uint8Array(nx * ny).fill(1);
    const diag = rr * Math.SQRT1_2;
    // inside outline (cell centres)
    for (let j = 0; j < ny; j++) {
      const y = this.ry0 + (j + 0.5) * rr;
      const xs: number[] = [];
      const ring = b.outline;
      for (let a = 0, c = ring.length - 1; a < ring.length; c = a++) {
        const ya = ring[a][1];
        const yc = ring[c][1];
        if (ya > y !== yc > y) xs.push(ring[a][0] + ((y - ya) * (ring[c][0] - ring[a][0])) / (yc - ya));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - this.rx0) / rr - 0.5));
        const i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - this.rx0) / rr - 0.5));
        for (let i = i0; i <= i1; i++) bad[j * nx + i] = 0;
      }
    }
    const markNear = (a: Vec2, c: Vec2, dist: number) => {
      const i0 = Math.max(0, Math.floor((Math.min(a[0], c[0]) - dist - this.rx0) / rr));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(a[0], c[0]) + dist - this.rx0) / rr));
      const j0 = Math.max(0, Math.floor((Math.min(a[1], c[1]) - dist - this.ry0) / rr));
      const j1 = Math.min(ny - 1, Math.floor((Math.max(a[1], c[1]) + dist - this.ry0) / rr));
      const d2 = dist * dist;
      for (let j = j0; j <= j1; j++) {
        const y = this.ry0 + (j + 0.5) * rr;
        for (let i = i0; i <= i1; i++) {
          const x = this.rx0 + (i + 0.5) * rr;
          if (distPtSeg2(x, y, a[0], a[1], c[0], c[1]) < d2) bad[j * nx + i] = 1;
        }
      }
    };
    const ringEdges = (ring: Vec2[], dist: number) => {
      for (let a = 0, c = ring.length - 1; a < ring.length; c = a++) markNear(ring[c], ring[a], dist);
    };
    ringEdges(b.outline, this.ec + diag + 1e-6);
    for (const cut of b.cutouts ?? []) {
      if (cut.length < 3) continue;
      ringEdges(cut, this.ec + diag + 1e-6);
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) if (pointInPolygon([this.rx0 + (i + 0.5) * rr, this.ry0 + (j + 0.5) * rr], cut)) bad[j * nx + i] = 1;
    }
    for (const h of b.holes ?? []) {
      const keep = Math.max(h.padDiameter ?? 0, h.drill * 1.9) / 2 + this.spacing;
      markNear([h.x, h.y], [h.x, h.y], keep + diag);
    }
    const sat = new Int32Array((nx + 1) * (ny + 1));
    for (let j = 0; j < ny; j++) {
      let row = 0;
      for (let i = 0; i < nx; i++) {
        row += bad[j * nx + i];
        sat[(j + 1) * (nx + 1) + (i + 1)] = sat[j * (nx + 1) + (i + 1)] + row;
      }
    }
    this.sat = sat;
  }

  private rectInside(minX: number, minY: number, maxX: number, maxY: number): boolean {
    const rr = this.rr;
    const i0 = Math.floor((minX - this.rx0) / rr + 1e-9);
    const i1 = Math.ceil((maxX - this.rx0) / rr - 1e-9) - 1;
    const j0 = Math.floor((minY - this.ry0) / rr + 1e-9);
    const j1 = Math.ceil((maxY - this.ry0) / rr - 1e-9) - 1;
    if (i0 < 0 || j0 < 0 || i1 >= this.rnx || j1 >= this.rny || i1 < i0 || j1 < j0) return false;
    const W = this.rnx + 1;
    const s = this.sat;
    return s[(j1 + 1) * W + (i1 + 1)] - s[j0 * W + (i1 + 1)] - s[(j1 + 1) * W + i0] + s[j0 * W + i0] === 0;
  }

  /* --------------------------------------------- occupancy --------------------------------------------- */

  private rectAt(pc: PComp, x: number, y: number, r: number): Rect {
    const o = pc.rect[r];
    return { minX: x + o.minX, minY: y + o.minY, maxX: x + o.maxX, maxY: y + o.maxY };
  }

  private inflated(pc: PComp, withHalo = true): Rect {
    const r = pc.box;
    const h = this.spacing / 2 + (withHalo ? pc.halo : 0);
    return { minX: r.minX - h, minY: r.minY - h, maxX: r.maxX + h, maxY: r.maxY + h };
  }

  /** Satellites sit next to their anchor (and siblings) with plain spacing, ignoring routing halos. */
  private tight(a: PComp, b: PComp): boolean {
    const sa = a.anchor && a.role !== 'edge' ? a.anchor.ic : -1;
    const sb = b.anchor && b.role !== 'edge' ? b.anchor.ic : -1;
    return sa === b.i || sb === a.i || (sa >= 0 && sa === sb);
  }

  /**
   * Routability-driven spreading: when the board is sparsely used, give every non-satellite part a
   * halo (∝ √pins) so the inflated area reaches ~45% of the board.
   */
  private computeHalos(): void {
    const s = this.spacing;
    const A = Math.abs(ringAreaOf(this.board.outline));
    if (!(A > 0)) return;
    const live = this.comps.filter((p) => !p.fixed);
    const weight = (p: PComp) => (p.role === 'decap' || p.role === 'xcap' || p.role === 'crystal' ? 0 : Math.sqrt(Math.max(2, p.pins.size) / 2));
    const areaWith = (h0: number) => {
      let tot = 0;
      for (const p of this.comps) {
        const o = p.rect[0];
        const h = p.fixed ? 0 : Math.min(2.5, h0 * weight(p));
        tot += (o.maxX - o.minX + s + 2 * h) * (o.maxY - o.minY + s + 2 * h);
      }
      return tot;
    };
    const target = 0.45 * A;
    if (!live.length || areaWith(0) >= target) return;
    let lo = 0;
    let hi = 3;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (areaWith(mid) < target) lo = mid;
      else hi = mid;
    }
    for (const p of live) p.halo = Math.round(Math.min(2.5, lo * weight(p)) / this.grid) * this.grid;
  }

  private sidesOf(pc: PComp): GridIndex[] {
    return pc.bothSides ? [this.idx.top, this.idx.bottom] : [pc.side === 'bottom' ? this.idx.bottom : this.idx.top];
  }

  private insert(pc: PComp): void {
    pc.box = this.rectAt(pc, pc.x, pc.y, pc.r);
    const r = this.inflated(pc);
    for (const ix of this.sidesOf(pc)) ix.insert(pc.i, r);
  }

  private remove(pc: PComp): void {
    const r = this.inflated(pc);
    for (const ix of this.sidesOf(pc)) ix.remove(pc.i, r);
  }

  /** Legal pose? (inside allowed area, no overlap with placed parts on the same side; `ignore` excluded). */
  private legal(pc: PComp, x: number, y: number, r: number, ignore = -1): boolean {
    const o = pc.rect[r];
    const minX = x + o.minX;
    const minY = y + o.minY;
    const maxX = x + o.maxX;
    const maxY = y + o.maxY;
    if (!pc.fixed && !this.rectInside(minX, minY, maxX, maxY)) return false;
    const h0 = this.spacing / 2;
    const h = h0 + pc.halo;
    const both = pc.bothSides;
    const sides = both ? 2 : 1;
    for (let s = 0; s < sides; s++) {
      const ix = both ? (s === 0 ? this.idx.top : this.idx.bottom) : pc.side === 'bottom' ? this.idx.bottom : this.idx.top;
      const ids = ix.queryBox(minX - h, minY - h, maxX + h, maxY + h, this.tmp);
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k];
        if (id === pc.i || id === ignore) continue;
        const q = this.comps[id];
        if (!q.placed) continue;
        let ha: number;
        let hb: number;
        if (this.tight(pc, q)) {
          ha = h0;
          hb = h0;
        } else {
          ha = h;
          hb = h0 + q.halo;
        }
        const b = q.box;
        if (minX - ha < b.maxX + hb - 1e-9 && b.minX - hb < maxX + ha - 1e-9 && minY - ha < b.maxY + hb - 1e-9 && b.minY - hb < maxY + ha - 1e-9) return false;
      }
    }
    return true;
  }

  private setPose(pc: PComp, x: number, y: number, r: number): void {
    if (pc.placed) this.remove(pc);
    pc.x = x;
    pc.y = y;
    pc.r = r;
    pc.placed = true;
    this.insert(pc);
  }

  private snap(v: number): number {
    return Math.round(v / this.grid) * this.grid;
  }

  /** Nearest legal pose to `desired` (spiral over the placement lattice), trying rotations in order. */
  private findSpot(pc: PComp, desired: Vec2, rots: number[], maxR = Infinity): { x: number; y: number; r: number; d: number } | null {
    const step = this.step;
    const cx = this.snap(desired[0]);
    const cy = this.snap(desired[1]);
    const span = Math.max(this.bb.maxX - this.bb.minX, this.bb.maxY - this.bb.minY);
    const maxSteps = Math.ceil(Math.min(maxR, span * 1.5) / step) + 1;
    let best = null as { x: number; y: number; r: number; d: number } | null;
    let foundRing = -1;
    const visit = (dx: number, dy: number, k: number) => {
      const x = cx + dx * step;
      const y = cy + dy * step;
      const d = Math.hypot(x - desired[0], y - desired[1]);
      if (best && d >= best.d) return;
      for (let ri = 0; ri < rots.length; ri++) {
        if (this.legal(pc, x, y, rots[ri])) {
          const dd = d + ri * 0.01;
          if (!best || dd < best.d) best = { x, y, r: rots[ri], d: dd };
          if (foundRing < 0) foundRing = k;
          return;
        }
      }
    };
    for (let k = 0; k <= maxSteps; k++) {
      if (foundRing >= 0 && k > foundRing + 2) break;
      if (k === 0) {
        visit(0, 0, 0);
        continue;
      }
      for (let a = -k; a <= k; a++) {
        visit(a, -k, k);
        visit(a, k, k);
      }
      for (let a = -k + 1; a <= k - 1; a++) {
        visit(-k, a, k);
        visit(k, a, k);
      }
    }
    return best;
  }

  /* --------------------------------------------- wirelength --------------------------------------------- */

  private pinPos(pc: PComp, pin: string, x = pc.x, y = pc.y, r = pc.r): Vec2 {
    const o = pc.pins.get(pin)?.[r] ?? [0, 0];
    return [x + o[0], y + o[1]];
  }

  private netHpwl(net: string, override?: { k: number; x: number; y: number; r: number }): number {
    const pins = this.netPins.get(net);
    if (!pins || pins.length < 2) return 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let n = 0;
    for (const p of pins) {
      const pc = this.comps[p.k];
      let pos: Vec2;
      if (override && override.k === p.k) pos = this.pinPos(pc, p.pin, override.x, override.y, override.r);
      else if (pc.placed) pos = this.pinPos(pc, p.pin);
      else continue;
      n++;
      if (pos[0] < minX) minX = pos[0];
      if (pos[0] > maxX) maxX = pos[0];
      if (pos[1] < minY) minY = pos[1];
      if (pos[1] > maxY) maxY = pos[1];
    }
    if (n < 2) return 0;
    return (maxX - minX + maxY - minY) * (this.netW.get(net) ?? 1);
  }

  private compCost(pc: PComp, x = pc.x, y = pc.y, r = pc.r): number {
    let s = 0;
    const ov = { k: pc.i, x, y, r };
    for (const n of pc.nets) s += this.netHpwl(n, ov);
    s += this.attachCost(pc, x, y, r);
    // parts anchored to this one
    return s;
  }

  private attachCost(pc: PComp, x = pc.x, y = pc.y, r = pc.r): number {
    if (!pc.anchor || pc.role !== 'decap') return 0;
    const ic = this.comps[pc.anchor.ic];
    if (!ic.placed) return 0;
    const a = this.pinPos(pc, pc.anchor.capPin, x, y, r);
    const b = this.pinPos(ic, pc.anchor.pin);
    return 2 * Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  private totalHpwl(): number {
    let s = 0;
    for (const [net] of this.netPins) s += this.netHpwl(net) / (this.netW.get(net) || 1);
    return s;
  }

  private placedLinks(pc: PComp): number {
    let s = 0;
    for (const n of pc.nets) {
      const w = this.netW.get(n) ?? 0;
      for (const p of this.netPins.get(n) ?? []) if (p.k !== pc.i && this.comps[p.k].placed) s += w;
    }
    return s;
  }

  /** Weighted centroid of placed neighbour pins (null when nothing connected is placed). */
  private affinityPoint(pc: PComp): Vec2 | null {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (const n of pc.nets) {
      const w = this.netW.get(n) ?? 0;
      if (w <= 0) continue;
      for (const p of this.netPins.get(n) ?? []) {
        if (p.k === pc.i) continue;
        const o = this.comps[p.k];
        if (!o.placed) continue;
        const q = this.pinPos(o, p.pin);
        sx += q[0] * w;
        sy += q[1] * w;
        sw += w;
      }
    }
    return sw > 0 ? [sx / sw, sy / sw] : null;
  }

  private placeByAffinity(pc: PComp, fallback: Vec2): void {
    const desired = this.affinityPoint(pc) ?? fallback;
    let best: { x: number; y: number; r: number; cost: number } | null = null;
    const startRot = pc.r;
    const order = [startRot, (startRot + 1) % 4, (startRot + 2) % 4, (startRot + 3) % 4];
    // rotations with identical courtyard boxes share one spiral search
    const groups: number[][] = [];
    for (const r of order) {
      const o = pc.rect[r];
      const g = groups.find((gr) => {
        const q = pc.rect[gr[0]];
        return Math.abs(q.minX - o.minX) < 1e-9 && Math.abs(q.minY - o.minY) < 1e-9 && Math.abs(q.maxX - o.maxX) < 1e-9 && Math.abs(q.maxY - o.maxY) < 1e-9;
      });
      if (g) g.push(r);
      else groups.push([r]);
    }
    for (const g of groups) {
      const spot = this.findSpot(pc, desired, [g[0]]);
      if (!spot) continue;
      for (const r of g) {
        const cost = this.compCost(pc, spot.x, spot.y, r) + 0.3 * spot.d;
        if (!best || cost < best.cost - 1e-9) best = { x: spot.x, y: spot.y, r, cost };
      }
    }
    if (best) this.setPose(pc, best.x, best.y, best.r);
  }

  /* ----------------------------------------------- edges ----------------------------------------------- */

  private placeEdges(): void {
    const explicit = new Map<string, { edge: BoardEdge; offset?: number }>();
    for (const e of this.opts.edges ?? []) explicit.set(e.componentId, { edge: e.edge, offset: e.offset });
    const list = this.comps.filter((p) => !p.fixed && (p.role === 'edge' || explicit.has(p.c.id)));
    const byEdge = new Map<BoardEdge, PComp[]>();
    const counts: Record<BoardEdge, number> = { left: 0, right: 0, top: 0, bottom: 0 };
    const order: BoardEdge[] = ['left', 'right', 'bottom', 'top'];
    let rr = 0;
    const assign = new Map<PComp, BoardEdge>();
    for (const pc of list) {
      const ex = explicit.get(pc.c.id);
      let edge: BoardEdge;
      if (ex) edge = ex.edge;
      else if (pc.c.placed && pc.c.x >= this.bb.minX && pc.c.x <= this.bb.maxX && pc.c.y >= this.bb.minY && pc.c.y <= this.bb.maxY) {
        const d = { left: pc.c.x - this.bb.minX, right: this.bb.maxX - pc.c.x, bottom: pc.c.y - this.bb.minY, top: this.bb.maxY - pc.c.y };
        edge = (Object.keys(d) as BoardEdge[]).sort((a, b) => d[a] - d[b])[0];
      } else {
        edge = order[rr++ % 4];
      }
      assign.set(pc, edge);
      counts[edge]++;
      const l = byEdge.get(edge) ?? [];
      l.push(pc);
      byEdge.set(edge, l);
    }
    for (const [edge, pcs] of byEdge) {
      pcs.forEach((pc, k) => {
        const ex = explicit.get(pc.c.id);
        const r = this.edgeRotation(pc, edge);
        const o = pc.rect[r];
        const horiz = edge === 'top' || edge === 'bottom';
        const lo = horiz ? this.bb.minX : this.bb.minY;
        const hi = horiz ? this.bb.maxX : this.bb.maxY;
        const along = ex?.offset !== undefined ? (lo + hi) / 2 + ex.offset : lo + ((hi - lo) * (k + 1)) / (pcs.length + 1);
        let x: number;
        let y: number;
        const inset = this.ec + this.rr * 1.5;
        if (edge === 'left') {
          x = this.bb.minX + inset - o.minX;
          y = along - (o.minY + o.maxY) / 2;
        } else if (edge === 'right') {
          x = this.bb.maxX - inset - o.maxX;
          y = along - (o.minY + o.maxY) / 2;
        } else if (edge === 'bottom') {
          y = this.bb.minY + inset - o.minY;
          x = along - (o.minX + o.maxX) / 2;
        } else {
          y = this.bb.maxY - inset - o.maxY;
          x = along - (o.minX + o.maxX) / 2;
        }
        const spot = this.findSpot(pc, [x, y], [r]) ?? this.findSpot(pc, [x, y], [0, 1, 2, 3]);
        if (spot) {
          this.setPose(pc, spot.x, spot.y, spot.r);
          pc.role = 'edge';
          pc.fixed = false;
          this.report.push(`${pc.c.ref} → ${edge} edge${spot.r === r ? ', facing outward' : ''}`);
        }
      });
    }
    // edge parts are not moved by annealing
    for (const pc of list) if (pc.placed) pc.role = 'edge';
  }

  /** Rotation index that points the connector's mating side outward (or its long side along the edge). */
  private edgeRotation(pc: PComp, edge: BoardEdge): number {
    const outward: Vec2 = edge === 'left' ? [-1, 0] : edge === 'right' ? [1, 0] : edge === 'top' ? [0, 1] : [0, -1];
    const md = pc.part?.connector?.matingDirection;
    const local: Vec2 | null = md === '+x' ? [1, 0] : md === '-x' ? [-1, 0] : md === '+y' ? [0, 1] : md === '-y' ? [0, -1] : null;
    if (local) {
      let best = 0;
      let bestDot = -Infinity;
      for (let r = 0; r < 4; r++) {
        const v = footprintToBoard({ x: 0, y: 0, rotation: ROTS[r], side: pc.side }, local);
        const d = v[0] * outward[0] + v[1] * outward[1];
        if (d > bestDot + 1e-9) {
          bestDot = d;
          best = r;
        }
      }
      return best;
    }
    // long side along the edge
    const horiz = edge === 'top' || edge === 'bottom';
    for (const r of [0, 1]) {
      const o = pc.rect[r];
      const w = o.maxX - o.minX;
      const h = o.maxY - o.minY;
      if ((horiz && w >= h) || (!horiz && h >= w)) return r;
    }
    return 0;
  }

  /* -------------------------------------------- satellites -------------------------------------------- */

  /** Outward unit normal (board frame) of the IC side a pin sits on. */
  private pinNormal(ic: PComp, pin: string): Vec2 {
    const p0 = ic.pins.get(pin)?.[0] ?? [0, 0]; // rotation 0, includes mirroring
    const o = ic.rect[0];
    const hx = Math.max(1e-6, (o.maxX - o.minX) / 2);
    const hy = Math.max(1e-6, (o.maxY - o.minY) / 2);
    const cx = (o.maxX + o.minX) / 2;
    const cy = (o.maxY + o.minY) / 2;
    const ux = (p0[0] - cx) / hx;
    const uy = (p0[1] - cy) / hy;
    const n0: Vec2 = Math.abs(ux) >= Math.abs(uy) ? [Math.sign(ux) || 1, 0] : [0, Math.sign(uy) || 1];
    return rotate2(n0, ROTS[ic.r]).map((v) => Math.round(v)) as Vec2;
  }

  private placeSatellites(ic: PComp): void {
    const sats = this.comps.filter((p) => !p.placed && p.anchor && p.anchor.ic === ic.i && (p.role === 'decap' || p.role === 'crystal'));
    for (const s of sats) {
      if (s.role === 'decap') this.placeDecap(s, ic);
      else this.placeCrystal(s, ic);
    }
  }

  private placeDecap(cap: PComp, ic: PComp): void {
    const a = cap.anchor!;
    const n = this.pinNormal(ic, a.pin);
    const pinPos = this.pinPos(ic, a.pin);
    const icRect = this.rectAt(ic, ic.x, ic.y, ic.r);
    // distance from pin to the courtyard edge along n
    const toEdge = n[0] > 0 ? icRect.maxX - pinPos[0] : n[0] < 0 ? pinPos[0] - icRect.minX : n[1] > 0 ? icRect.maxY - pinPos[1] : pinPos[1] - icRect.minY;
    // rotation: supply pin toward the IC (vector supply->other along +n)
    const other = [...cap.pins.keys()].find((p) => p !== a.capPin) ?? a.capPin;
    const rotsScored = [0, 1, 2, 3]
      .map((r) => {
        const ps = cap.pins.get(a.capPin)![r];
        const po = cap.pins.get(other)![r];
        const v: Vec2 = [po[0] - ps[0], po[1] - ps[1]];
        return { r, s: v[0] * n[0] + v[1] * n[1] };
      })
      .sort((x, y) => y.s - x.s);
    const r = rotsScored[0].r;
    const o = cap.rect[r];
    const ext = n[0] > 0 ? -o.minX : n[0] < 0 ? o.maxX : n[1] > 0 ? -o.minY : o.maxY;
    const ps = cap.pins.get(a.capPin)![r];
    const dist = toEdge + this.spacing + ext;
    // align the supply pad laterally with the IC pin
    const desired: Vec2 = [pinPos[0] + n[0] * dist - (n[0] === 0 ? ps[0] : 0), pinPos[1] + n[1] * dist - (n[1] === 0 ? ps[1] : 0)];
    const spot = this.findSpot(cap, desired, [r, rotsScored[1].r, rotsScored[2].r, rotsScored[3].r], 25);
    if (spot) {
      this.setPose(cap, spot.x, spot.y, spot.r);
      const net = cap.c.pinNets[a.capPin];
      const netName = this.board.nets.find((x) => x.id === net)?.name ?? net;
      this.report.push(`${cap.c.ref} → decoupling ${ic.c.ref} pin ${a.pin} (${netName})`);
    }
  }

  private placeCrystal(x: PComp, ic: PComp): void {
    const a = x.anchor!;
    const pa = this.pinPos(ic, a.pin);
    const pb = this.pinPos(ic, a.capPin);
    const n = this.pinNormal(ic, a.pin);
    const mid: Vec2 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    const icRect = this.rectAt(ic, ic.x, ic.y, ic.r);
    const toEdge = n[0] > 0 ? icRect.maxX - mid[0] : n[0] < 0 ? mid[0] - icRect.minX : n[1] > 0 ? icRect.maxY - mid[1] : mid[1] - icRect.minY;
    // align crystal pin axis with the MCU pin pair
    const xp = [...x.pins.keys()];
    const along: Vec2 = [pb[0] - pa[0], pb[1] - pa[1]];
    const rots = [0, 1, 2, 3]
      .map((r) => {
        const p1 = x.pins.get(xp[0])![r];
        const p2 = x.pins.get(xp[xp.length - 1])![r];
        const v: Vec2 = [p2[0] - p1[0], p2[1] - p1[1]];
        return { r, s: Math.abs(v[0] * along[0] + v[1] * along[1]) + (v[0] * along[0] + v[1] * along[1]) * 1e-3 };
      })
      .sort((p, q) => q.s - p.s)
      .map((e) => e.r);
    const o = x.rect[rots[0]];
    const ext = n[0] > 0 ? -o.minX : n[0] < 0 ? o.maxX : n[1] > 0 ? -o.minY : o.maxY;
    const d = toEdge + this.spacing + ext;
    const spot = this.findSpot(x, [mid[0] + n[0] * d, mid[1] + n[1] * d], rots, 25);
    if (!spot) return;
    this.setPose(x, spot.x, spot.y, spot.r);
    this.report.push(`${x.c.ref} → next to ${ic.c.ref} pins ${a.pin}/${a.capPin}`);
    // load caps beyond the crystal
    for (const cap of this.comps.filter((p) => !p.placed && p.role === 'xcap' && p.anchor?.ic === x.i)) {
      const xpos = this.pinPos(x, cap.anchor!.pin);
      const desired: Vec2 = [xpos[0] + n[0] * 2.5, xpos[1] + n[1] * 2.5];
      const s2 = this.findSpot(cap, desired, [0, 1, 2, 3], 15);
      if (s2) this.setPose(cap, s2.x, s2.y, s2.r);
    }
  }

  /* --------------------------------------------- annealing --------------------------------------------- */

  private anneal(): void {
    const movable = this.comps.filter((p) => p.placed && !p.fixed && p.role !== 'edge');
    if (movable.length < 2) return;
    const budgetEnd = this.t0 + Math.min(800, 150 + movable.length * 5);
    const rand = this.rand;
    const span = Math.max(this.bb.maxX - this.bb.minX, this.bb.maxY - this.bb.minY);
    const cx = (this.bb.minX + this.bb.maxX) / 2;
    const cy = (this.bb.minY + this.bb.maxY) / 2;
    // satellites (decaps, crystals, load caps) follow their anchor's cost and only make short moves
    const deps = new Map<number, PComp[]>();
    for (const p of this.comps) if (p.anchor && p.role === 'decap') deps.set(p.anchor.ic, [...(deps.get(p.anchor.ic) ?? []), p]);
    const isSat = (p: PComp) => p.role === 'decap' || p.role === 'crystal' || p.role === 'xcap';
    const localCost = (pc: PComp, x: number, y: number, r: number) => {
      let s = this.compCost(pc, x, y, r);
      for (const d of deps.get(pc.i) ?? []) {
        if (!d.placed) continue;
        const a = this.pinPos(d, d.anchor!.capPin);
        const b = this.pinPos(pc, d.anchor!.pin, x, y, r);
        s += 2 * Math.hypot(a[0] - b[0], a[1] - b[1]);
      }
      // weak pull toward the board centre keeps the cluster centred (HPWL is translation invariant)
      s += 0.02 * Math.hypot(x - cx, y - cy);
      return s;
    };
    let radius = span * 0.08;
    // initial temperature: half the mean |delta| of short random moves (the constructive start is good)
    let T = 0;
    let samples = 0;
    for (let k = 0; k < 40; k++) {
      const pc = movable[Math.floor(rand() * movable.length)];
      const nx = this.snap(pc.x + (rand() * 2 - 1) * radius);
      const ny = this.snap(pc.y + (rand() * 2 - 1) * radius);
      const d = Math.abs(localCost(pc, nx, ny, pc.r) - localCost(pc, pc.x, pc.y, pc.r));
      if (Number.isFinite(d)) {
        T += d;
        samples++;
      }
    }
    T = Math.max(0.02, (T / Math.max(1, samples)) * 0.3);
    const Tmin = T * 2e-3;
    const movesPerT = Math.max(50, movable.length * 6);
    let iter = 0;
    while (T > Tmin) {
      for (let m = 0; m < movesPerT; m++) {
        if ((++iter & 255) === 0 && nowMs() > budgetEnd) return;
        const pc = movable[Math.floor(rand() * movable.length)];
        const u = rand();
        if (u < 0.12) {
          // swap with a similar-size part on the same side(s)
          const o = movable[Math.floor(rand() * movable.length)];
          if (o === pc || isSat(o) || isSat(pc) || o.side !== pc.side || o.bothSides !== pc.bothSides || Math.abs(o.area - pc.area) > 0.5 * Math.max(o.area, pc.area)) continue;
          this.trySwap(pc, o, T, localCost);
          continue;
        }
        let nx = pc.x;
        let ny = pc.y;
        let nr = pc.r;
        if (u < 0.25) nr = (pc.r + 1 + Math.floor(rand() * 3)) % 4;
        else {
          const rad = isSat(pc) ? Math.min(radius, 2) : radius;
          nx = this.snap(pc.x + (rand() * 2 - 1) * rad);
          ny = this.snap(pc.y + (rand() * 2 - 1) * rad);
        }
        if (nx === pc.x && ny === pc.y && nr === pc.r) continue;
        if (!this.legal(pc, nx, ny, nr)) continue;
        const delta = localCost(pc, nx, ny, nr) - localCost(pc, pc.x, pc.y, pc.r);
        if (delta <= 0 || rand() < Math.exp(-delta / T)) this.setPose(pc, nx, ny, nr);
      }
      T *= 0.9;
      radius = Math.max(this.step, radius * 0.95);
    }
  }

  /** Swap the poses of two parts if legal; Metropolis acceptance. Returns true when accepted. */
  private trySwap(a: PComp, b: PComp, T: number, cost: (pc: PComp, x: number, y: number, r: number) => number): boolean {
    const before = cost(a, a.x, a.y, a.r) + cost(b, b.x, b.y, b.r);
    const pa = { x: a.x, y: a.y, r: a.r };
    const pb = { x: b.x, y: b.y, r: b.r };
    this.remove(a);
    this.remove(b);
    a.placed = false;
    b.placed = false;
    const restore = () => {
      a.x = pa.x;
      a.y = pa.y;
      a.r = pa.r;
      b.x = pb.x;
      b.y = pb.y;
      b.r = pb.r;
      a.placed = true;
      b.placed = true;
      this.insert(a);
      this.insert(b);
    };
    if (!this.legal(a, pb.x, pb.y, pb.r)) {
      restore();
      return false;
    }
    a.x = pb.x;
    a.y = pb.y;
    a.r = pb.r;
    a.placed = true;
    this.insert(a);
    if (!this.legal(b, pa.x, pa.y, pa.r)) {
      this.remove(a);
      restore();
      return false;
    }
    b.x = pa.x;
    b.y = pa.y;
    b.r = pa.r;
    b.placed = true;
    this.insert(b);
    const delta = cost(a, a.x, a.y, a.r) + cost(b, b.x, b.y, b.r) - before;
    if (delta <= 0 || this.rand() < Math.exp(-delta / T)) return true;
    this.remove(a);
    this.remove(b);
    restore();
    return false;
  }
}

/** 0 for pins named like crystal pins (XTAL, XIN, XOUT, OSC, XI, XO, X1, X2), else 1. */
function xtalPinRank(pc: PComp, pin: string): number {
  const name = pc.part?.pins?.find((p) => p.number === pin)?.name ?? '';
  return /^(XTAL|XIN|XOUT|OSC|XI|XO|X1|X2|XT)/i.test(name.replace(/[^A-Za-z0-9]/g, '')) ? 0 : 1;
}

function rotIndex(deg: number): number {
  const r = Math.round((((deg ?? 0) % 360) + 360) % 360 / 90) % 4;
  return r;
}

function capValue(pc: PComp): number {
  const v = pc.c.value ?? pc.part?.value ?? '';
  const m = /^([\d.]+)\s*([pnuµm]?)/i.exec(v);
  if (!m) return 1;
  const mult: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, '': 1 };
  return parseFloat(m[1]) * (mult[m[2].toLowerCase()] ?? 1);
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
