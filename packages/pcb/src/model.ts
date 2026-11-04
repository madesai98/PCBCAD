/**
 * Board → copper model: pads, trace segments, vias, holes and zone islands as exact {@link Prim}s with
 * copper-layer bitmasks. Shared by connectivity, DRC, router, pour engine, exports and stats.
 */
import {
  copperLayers,
  placedPads,
  rotate2,
  type BBox2,
  type Board,
  type ComponentInstance,
  type CopperLayer,
  type MountingHole,
  type PadDef,
  type PartDef,
  type PlacedPad,
  type Trace,
  type Vec2,
  type Via,
  type Zone,
} from '@pcbcad/core';
import { bboxOf, makePrim, type Prim } from './geom';
import { Region, regionsFromRings } from './region';

/** Copper layers of the board's stackup, outer first: ['top', 'in1', ..., 'bottom']. */
export function stackLayers(board: Board): CopperLayer[] {
  return copperLayers(board.stackup ?? { layers: 2 } as Board['stackup']);
}

/** Bit for a layer within the stackup order (0 when the layer is not part of the stackup). */
export function layerBit(stack: CopperLayer[], layer: CopperLayer): number {
  const i = stack.indexOf(layer);
  return i < 0 ? 0 : 1 << i;
}

export function allLayersMask(stack: CopperLayer[]): number {
  return (1 << stack.length) - 1;
}

/** Layer mask of a via (through by default). */
export function viaMask(stack: CopperLayer[], via: Pick<Via, 'from' | 'to'>): number {
  const a = via.from ? stack.indexOf(via.from) : 0;
  const b = via.to ? stack.indexOf(via.to) : stack.length - 1;
  if (a < 0 || b < 0) return allLayersMask(stack);
  let m = 0;
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) m |= 1 << i;
  return m;
}

export interface PadInfo {
  /** `${componentId}:${pin}` */
  key: string;
  comp: ComponentInstance;
  part?: PartDef;
  pad: PadDef;
  /** Index of the pad within the footprint. */
  padIndex: number;
  pp: PlacedPad;
  /** Net id ('' = unconnected pin). */
  netId: string;
  /** Copper layer mask (0 for NPTH). */
  layers: number;
  /** Copper shape (null for NPTH pads). */
  prim: Prim | null;
  /** Drilled hole (THT / NPTH). */
  hole: Prim | null;
  /** Component has a real position (placed). */
  placed: boolean;
}

/** Exact copper prim of a placed pad. */
export function padPrim(pp: PlacedPad): Prim {
  const pad = pp.pad;
  const rot = pp.rotation || 0;
  const w = Math.max(0, pad.w);
  const h = Math.max(0, pad.shape === 'circle' ? pad.w : pad.h);
  switch (pad.shape) {
    case 'circle':
      return makePrim([[pp.x, pp.y]], w / 2);
    case 'oval': {
      const r = Math.min(w, h) / 2;
      const half = (Math.max(w, h) - Math.min(w, h)) / 2;
      if (half < 1e-9) return makePrim([[pp.x, pp.y]], r);
      const d = w > h ? rotate2([half, 0], rot) : rotate2([0, half], rot);
      return makePrim(
        [
          [pp.x - d[0], pp.y - d[1]],
          [pp.x + d[0], pp.y + d[1]],
        ],
        r,
      );
    }
    case 'roundrect': {
      const m = Math.min(w, h);
      const rr = Math.max(0, Math.min(m / 2, (pad.roundness ?? 0.25) * m));
      return rectPrim(pp.x, pp.y, w - 2 * rr, h - 2 * rr, rot, rr);
    }
    case 'polygon':
      if (pp.polygon.length >= 3) return makePrim(pp.polygon.map((p) => [p[0], p[1]] as Vec2), 0);
      return rectPrim(pp.x, pp.y, w, h, rot, 0);
    default:
      return rectPrim(pp.x, pp.y, w, h, rot, 0);
  }
}

/** Rectangle (w×h, rotated) ⊕ disc(r); degenerates gracefully to segment/point cores. */
export function rectPrim(cx: number, cy: number, w: number, h: number, rot: number, r: number): Prim {
  const hw = Math.max(0, w / 2);
  const hh = Math.max(0, h / 2);
  if (hw < 1e-9 && hh < 1e-9) return makePrim([[cx, cy]], r);
  if (hw < 1e-9 || hh < 1e-9) {
    const d = hw >= hh ? rotate2([hw, 0], rot) : rotate2([0, hh], rot);
    return makePrim(
      [
        [cx - d[0], cy - d[1]],
        [cx + d[0], cy + d[1]],
      ],
      r,
    );
  }
  const corners: Vec2[] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map((p) => {
    const q = rotate2(p as Vec2, rot);
    return [cx + q[0], cy + q[1]] as Vec2;
  });
  return makePrim(corners, r);
}

/** Drill hole prim of a THT/NPTH pad (disc, or capsule for slots); null for SMD. */
export function padHolePrim(pp: PlacedPad): Prim | null {
  const pad = pp.pad;
  if (pad.kind === 'smd') return null;
  if (pad.slot && pad.slot.w > 0 && pad.slot.h > 0) {
    const r = Math.min(pad.slot.w, pad.slot.h) / 2;
    const half = (Math.max(pad.slot.w, pad.slot.h) - 2 * r) / 2;
    if (half < 1e-9) return makePrim([[pp.x, pp.y]], r);
    const d = pad.slot.w > pad.slot.h ? rotate2([half, 0], pp.rotation) : rotate2([0, half], pp.rotation);
    return makePrim(
      [
        [pp.x - d[0], pp.y - d[1]],
        [pp.x + d[0], pp.y + d[1]],
      ],
      r,
    );
  }
  const drill = pad.drill && pad.drill > 0 ? pad.drill : Math.min(pad.w, pad.h) * 0.6;
  return makePrim([[pp.x, pp.y]], drill / 2);
}

/** All pads of all components (placed or not), in board frame. */
export function collectPads(board: Board, parts: Record<string, PartDef>, stack: CopperLayer[] = stackLayers(board)): PadInfo[] {
  const out: PadInfo[] = [];
  const all = allLayersMask(stack);
  for (const comp of board.components) {
    const part = parts[comp.partId];
    const fp = part?.footprint;
    if (!fp || !fp.pads || fp.pads.length === 0) continue;
    const pps = placedPads(comp, fp);
    for (let i = 0; i < pps.length; i++) {
      const pp = pps[i];
      const pad = pp.pad;
      const netId = comp.pinNets?.[pad.number] ?? '';
      const layers = pad.kind === 'smd' ? layerBit(stack, comp.side === 'bottom' ? 'bottom' : 'top') : pad.kind === 'tht' ? all : 0;
      out.push({
        key: `${comp.id}:${pad.number}`,
        comp,
        part,
        pad,
        padIndex: i,
        pp,
        netId,
        layers,
        prim: pad.kind === 'npth' ? null : padPrim(pp),
        hole: padHolePrim(pp),
        placed: comp.placed !== false,
      });
    }
  }
  return out;
}

/** Segment prims of a trace (one per segment; a single point becomes a disc). */
export function tracePrims(t: Trace): Prim[] {
  const r = Math.max(0, t.width) / 2;
  const pts = t.points ?? [];
  if (pts.length === 0) return [];
  if (pts.length === 1) return [makePrim([[pts[0][0], pts[0][1]]], r)];
  const out: Prim[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a[0] === b[0] && a[1] === b[1]) {
      if (pts.length === 2) out.push(makePrim([[a[0], a[1]]], r));
      continue;
    }
    out.push(
      makePrim(
        [
          [a[0], a[1]],
          [b[0], b[1]],
        ],
        r,
      ),
    );
  }
  return out;
}

/** Copper ring of a plated mounting hole (null when not plated). */
export function holeCopperPrim(h: MountingHole): Prim | null {
  if (!h.plated) return null;
  const d = Math.max(h.padDiameter ?? 0, h.drill);
  return makePrim([[h.x, h.y]], d / 2);
}

/** Board outline + cutout edges as segments. */
export function boardEdges(board: Board): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  const add = (ring: Vec2[] | undefined) => {
    if (!ring || ring.length < 2) return;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) out.push([ring[j], ring[i]]);
  };
  add(board.outline);
  for (const c of board.cutouts ?? []) add(c);
  return out;
}

/** Board outline bbox (falls back to the copper extent / a unit square). */
export function boardBBox(board: Board): BBox2 {
  if (board.outline && board.outline.length >= 3) return bboxOf(board.outline);
  return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
}

export type ItemKind = 'pad' | 'trace' | 'via' | 'hole' | 'npth' | 'zone';

/** A piece of copper (or a non-plated hole) with its net and layers. */
export interface CopperItem {
  id: number;
  kind: ItemKind;
  /** '' = no net. */
  netId: string;
  layers: number;
  /** Shape (null for zone islands). */
  prim: Prim | null;
  region?: Region;
  bb: BBox2;
  /** True for copper; false for NPTH holes (obstacles only). */
  copper: boolean;
  /** Participates in geometric checks (false for pads of unplaced components). */
  geometric: boolean;
  pad?: PadInfo;
  trace?: Trace;
  seg?: number;
  via?: Via;
  hole?: MountingHole;
  zone?: Zone;
  /** Island index within the zone fill. */
  island?: number;
}

export interface CopperModel {
  stack: CopperLayer[];
  pads: PadInfo[];
  items: CopperItem[];
}

/** Build the full copper model of a board. */
export function buildCopperModel(board: Board, parts: Record<string, PartDef>, opts: { zones?: boolean } = {}): CopperModel {
  const stack = stackLayers(board);
  const all = allLayersMask(stack);
  const pads = collectPads(board, parts, stack);
  const items: CopperItem[] = [];
  const push = (it: Omit<CopperItem, 'id'>) => {
    items.push({ ...it, id: items.length } as CopperItem);
  };
  for (const p of pads) {
    if (p.prim) push({ kind: 'pad', netId: p.netId, layers: p.layers, prim: p.prim, bb: p.prim.bb, copper: true, geometric: p.placed, pad: p });
    else if (p.hole) push({ kind: 'npth', netId: '', layers: all, prim: p.hole, bb: p.hole.bb, copper: false, geometric: p.placed, pad: p });
  }
  for (const t of board.traces ?? []) {
    const bit = layerBit(stack, t.layer);
    if (!bit) continue;
    const prims = tracePrims(t);
    prims.forEach((prim, seg) => push({ kind: 'trace', netId: t.netId ?? '', layers: bit, prim, bb: prim.bb, copper: true, geometric: true, trace: t, seg }));
  }
  for (const v of board.vias ?? []) {
    const prim = makePrim([[v.x, v.y]], Math.max(v.diameter, v.drill) / 2);
    push({ kind: 'via', netId: v.netId ?? '', layers: viaMask(stack, v), prim, bb: prim.bb, copper: true, geometric: true, via: v });
  }
  for (const h of board.holes ?? []) {
    const cu = holeCopperPrim(h);
    if (cu) push({ kind: 'hole', netId: h.netId ?? '', layers: all, prim: cu, bb: cu.bb, copper: true, geometric: true, hole: h });
    else {
      const prim = makePrim([[h.x, h.y]], h.drill / 2);
      push({ kind: 'npth', netId: '', layers: all, prim, bb: prim.bb, copper: false, geometric: true, hole: h });
    }
  }
  if (opts.zones !== false) {
    for (const z of board.zones ?? []) {
      const bit = layerBit(stack, z.layer);
      if (!bit || !z.fill || z.fill.length === 0) continue;
      regionsFromRings(z.fill).forEach((region, island) =>
        push({ kind: 'zone', netId: z.netId ?? '', layers: bit, prim: null, region, bb: region.bb, copper: true, geometric: true, zone: z, island }),
      );
    }
  }
  return { stack, pads, items };
}

/** Human-readable label of an item for messages ("pad U1.3", "trace (SDA)", "via"). */
export function itemLabel(it: CopperItem, netName: (id: string) => string): string {
  const n = it.netId ? ` (${netName(it.netId)})` : '';
  switch (it.kind) {
    case 'pad':
      return `pad ${it.pad!.comp.ref}.${it.pad!.pad.number}${n}`;
    case 'npth':
      return it.pad ? `hole ${it.pad.comp.ref}.${it.pad.pad.number}` : `hole ${it.hole?.id ?? ''}`.trim();
    case 'trace':
      return `trace${n}`;
    case 'via':
      return `via${n}`;
    case 'hole':
      return `plated hole${n}`;
    case 'zone':
      return `zone${n}`;
  }
}

/** Stable identity of the object an item belongs to (for de-duplicating issues). */
export function itemObjectKey(it: CopperItem): string {
  switch (it.kind) {
    case 'pad':
    case 'npth':
      return it.pad ? `p:${it.pad.comp.id}:${it.pad.padIndex}` : `h:${it.hole?.id}`;
    case 'trace':
      return `t:${it.trace!.id}`;
    case 'via':
      return `v:${it.via!.id}`;
    case 'hole':
      return `h:${it.hole!.id}`;
    case 'zone':
      return `z:${it.zone!.id}:${it.island}`;
  }
}

/** Is a net a ground net (class 'ground' or a GND-like name)? */
export function isGroundNet(net: { name: string; class?: string } | undefined): boolean {
  if (!net) return false;
  if (net.class === 'ground') return true;
  return /^(GND|AGND|DGND|PGND|SGND|GNDA|GNDD|VSS|VSSA|0V|GROUND|EARTH)\b/i.test(net.name.trim());
}

/** Is a net a supply net (class 'power' or ground)? */
export function isPowerNet(net: { name: string; class?: string } | undefined): boolean {
  if (!net) return false;
  return net.class === 'power' || net.class === 'ground' || isGroundNet(net);
}

/** Trace width used for a net (mm): net override → power/ground width → default width. */
export function netTraceWidth(board: Board, netId: string): number {
  const net = board.nets.find((n) => n.id === netId);
  if (net?.traceWidth && net.traceWidth > 0) return net.traceWidth;
  if (net && (net.class === 'power' || net.class === 'ground')) return board.rules.powerTraceWidth;
  return board.rules.traceWidth;
}
