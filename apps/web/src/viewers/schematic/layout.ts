import type { Board, ComponentInstance, NetClass, PartDef, Project } from '@pcbcad/core';
import { guessNetClass } from '@pcbcad/core';
import { buildSymbol, displayName, G, rotDir, rotPt, type PinDir, type SymbolGeom, type SymPin } from './symbols';

/* ------------------------------------------------------------------------------------------------
 * Schematic auto-layout: every IC/connector becomes a "hub" cluster with its directly attached
 * passives (pull-ups next to the pin side they serve, decoupling caps in a row above); clusters go
 * into columns (power entry → regulators → MCU → peripherals → outputs). Connections are shown as
 * short stubs ending in net labels / power / ground symbols — no long wires.
 * ---------------------------------------------------------------------------------------------- */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PlacedPin extends SymPin {
  wx: number;
  wy: number;
  wdir: PinDir;
}

export interface PlacedSymbol {
  comp: ComponentInstance;
  part?: PartDef;
  geom: SymbolGeom;
  x: number;
  y: number;
  rot: number;
  pins: PlacedPin[];
  /** World bbox of the body incl. pin tips. */
  body: Box;
  ref: { x: number; y: number; anchor: 'start' | 'middle' | 'end' };
  value: { x: number; y: number; anchor: 'start' | 'middle' | 'end'; text: string };
}

export type TerminalKind = 'label' | 'power' | 'ground' | 'nc';

export interface Terminal {
  kind: TerminalKind;
  netId?: string;
  name: string;
  cls: NetClass;
  x: number;
  y: number;
  dir: PinDir;
  /** Label body width (mm) for 'label'. */
  width: number;
  box: Box;
  compId: string;
}

export interface SchLayout {
  symbols: PlacedSymbol[];
  terminals: Terminal[];
  content: Box;
  sheet: Box;
  titleBlock: Box;
  notes: { x: number; y: number; text: string }[];
}

export type Measure = (text: string, size: number) => number;

export const LABEL = { size: 1.27, h: 2.1, pad: 0.6, stub: 0.9 };
export const REF_SIZE = 1.5;
export const VALUE_SIZE = 1.25;

const EMPTY: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

function union(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function shift(b: Box, dx: number, dy: number): Box {
  return { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy };
}

const snap = (v: number) => Math.round(v / G) * G;

/* ------------------------------------------- terminals ------------------------------------------ */

export function terminalGeom(kind: TerminalKind, name: string, x: number, y: number, dir: PinDir, measure: Measure): { width: number; box: Box } {
  if (kind === 'nc') return { width: 0, box: { x0: x - 0.7, y0: y - 0.7, x1: x + 0.7, y1: y + 0.7 } };
  if (kind === 'ground') return { width: 2.6, box: { x0: x - 1.4, y0: y, x1: x + 1.4, y1: y + 3.0 } };
  if (kind === 'power') {
    const tw = Math.max(2.6, measure(name, LABEL.size) + 0.4);
    return { width: tw, box: { x0: x - tw / 2, y0: y - 3.9, x1: x + tw / 2, y1: y } };
  }
  const w = measure(displayName(name), LABEL.size) + 2 * LABEL.pad + 0.7;
  const h = LABEL.h;
  switch (dir) {
    case 'left':
      return { width: w, box: { x0: x - w, y0: y - h / 2, x1: x, y1: y + h / 2 } };
    case 'right':
      return { width: w, box: { x0: x, y0: y - h / 2, x1: x + w, y1: y + h / 2 } };
    case 'up':
      return { width: w, box: { x0: x - w / 2, y0: y - LABEL.stub - h, x1: x + w / 2, y1: y } };
    case 'down':
      return { width: w, box: { x0: x - w / 2, y0: y, x1: x + w / 2, y1: y + LABEL.stub + h } };
  }
}

function terminalKind(netId: string | undefined, cls: NetClass, dir: PinDir): TerminalKind {
  if (!netId) return 'nc';
  if (cls === 'ground' && dir === 'down') return 'ground';
  if (cls === 'power' && dir === 'up') return 'power';
  return 'label';
}

/* ----------------------------------------- symbol placing --------------------------------------- */

interface Proto {
  comp: ComponentInstance;
  part?: PartDef;
  geom: SymbolGeom;
  rot: number;
  /** Bounds of everything (body, terminals, texts) relative to the origin. */
  full: Box;
  body: Box;
  pins: PlacedPin[];
  terms: Omit<Terminal, 'compId'>[];
  ref: PlacedSymbol['ref'];
  value: PlacedSymbol['value'];
}

function valueText(comp: ComponentInstance, part?: PartDef): string {
  return comp.value ?? part?.value ?? part?.mpn ?? '';
}

function makeProto(comp: ComponentInstance, part: PartDef | undefined, geom: SymbolGeom, rot: number, ctx: LayoutCtx): Proto {
  const pins: PlacedPin[] = geom.pins.map((p) => {
    const [wx, wy] = rotPt(p.x, p.y, rot);
    return { ...p, wx, wy, wdir: rotDir(p.dir, rot) };
  });
  const c = [
    rotPt(geom.box.x0, geom.box.y0, rot),
    rotPt(geom.box.x1, geom.box.y0, rot),
    rotPt(geom.box.x0, geom.box.y1, rot),
    rotPt(geom.box.x1, geom.box.y1, rot),
  ];
  const body: Box = { x0: Math.min(...c.map((p) => p[0])), y0: Math.min(...c.map((p) => p[1])), x1: Math.max(...c.map((p) => p[0])), y1: Math.max(...c.map((p) => p[1])) };
  let full = { ...body };
  const terms: Omit<Terminal, 'compId'>[] = [];
  for (const p of pins) {
    const cls = ctx.netClass(p.netId);
    const name = p.netId ? ctx.netName(p.netId) : '';
    const kind = terminalKind(p.netId, cls, p.wdir);
    if (kind === 'nc' && geom.kind !== 'box' && geom.kind !== 'connector') continue;
    const g = terminalGeom(kind, name, p.wx, p.wy, p.wdir, ctx.measure);
    terms.push({ kind, netId: p.netId, name, cls, x: p.wx, y: p.wy, dir: p.wdir, width: g.width, box: g.box });
    full = union(full, g.box);
  }
  const value = valueText(comp, part);
  const refW = ctx.measure(comp.ref, REF_SIZE);
  const valW = ctx.measure(value, VALUE_SIZE);
  let ref: PlacedSymbol['ref'];
  let val: PlacedSymbol['value'];
  if (geom.kind === 'box' || geom.kind === 'connector') {
    // Reference + value stacked above the body's top-left corner (top pins are packed to the right).
    const bx0 = body.x0 + (pins.some((p) => p.wdir === 'left') ? G : 0);
    const by0 = body.y0 + (pins.some((p) => p.wdir === 'up') ? G : 0);
    ref = { x: bx0, y: by0 - 2.75, anchor: 'start' };
    val = { x: bx0, y: by0 - 0.8, anchor: 'start', text: value };
    full = union(full, { x0: bx0, y0: ref.y - REF_SIZE, x1: bx0 + Math.max(refW, valW), y1: by0 });
  } else {
    const tall = body.y1 - body.y0 >= body.x1 - body.x0;
    if (tall) {
      const x = body.x1 + 0.9;
      ref = { x, y: -0.35, anchor: 'start' };
      val = { x, y: 1.55, anchor: 'start', text: value };
      full = union(full, { x0: x, y0: -0.35 - REF_SIZE, x1: x + Math.max(refW, valW), y1: 1.6 });
    } else {
      // Horizontal: reference above, value below everything that hangs under the body.
      const below = Math.max(body.y1, ...terms.filter((t) => t.box.x1 > -valW / 2 && t.box.x0 < valW / 2 && t.box.y0 >= -0.01).map((t) => t.box.y1));
      ref = { x: 0, y: body.y0 - 0.8, anchor: 'middle' };
      val = { x: 0, y: below + 1.9, anchor: 'middle', text: value };
      full = union(full, { x0: -refW / 2, y0: body.y0 - 0.8 - REF_SIZE, x1: refW / 2, y1: body.y0 });
      full = union(full, { x0: -valW / 2, y0: below, x1: valW / 2, y1: below + 2.1 });
    }
  }
  return { comp, part, geom, rot, full, body, pins, terms, ref, value: val };
}

function place(proto: Proto, x: number, y: number): { sym: PlacedSymbol; terms: Terminal[]; full: Box } {
  const sym: PlacedSymbol = {
    comp: proto.comp,
    part: proto.part,
    geom: proto.geom,
    x,
    y,
    rot: proto.rot,
    pins: proto.pins.map((p) => ({ ...p, wx: p.wx + x, wy: p.wy + y })),
    body: shift(proto.body, x, y),
    ref: { ...proto.ref, x: proto.ref.x + x, y: proto.ref.y + y },
    value: { ...proto.value, x: proto.value.x + x, y: proto.value.y + y },
  };
  const terms = proto.terms.map((t) => ({ ...t, x: t.x + x, y: t.y + y, box: shift(t.box, x, y), compId: proto.comp.id }));
  return { sym, terms, full: shift(proto.full, x, y) };
}

/* ---------------------------------------------- layout ------------------------------------------ */

interface LayoutCtx {
  netClass: (id: string | undefined) => NetClass;
  netName: (id: string) => string;
  measure: Measure;
}

type Side = 'left' | 'right' | 'top' | 'bottom';

interface Sat {
  proto: Proto;
  hub: number;
  side: Side;
  key: number;
}

export function layoutSchematic(project: Project, board: Board, measure: Measure): SchLayout {
  const parts = project.parts;
  const nets = new Map(board.nets.map((n) => [n.id, n]));
  const ctx: LayoutCtx = {
    netClass: (id) => {
      if (!id) return 'signal';
      const n = nets.get(id);
      return n?.class ?? guessNetClass(n?.name ?? id);
    },
    netName: (id) => nets.get(id)?.name ?? id,
    measure,
  };

  const comps = board.components.filter((c) => {
    const part = parts[c.partId];
    return (part?.pins?.length ?? 0) > 0 || Object.keys(c.pinNets).length > 0;
  });
  const positioned = comps.filter((c) => c.schematic);
  const auto = comps.filter((c) => !c.schematic);

  const placed: { sym: PlacedSymbol; terms: Terminal[]; full: Box }[] = [];

  // 1) Explicit schematic positions.
  for (const c of positioned) {
    const part = parts[c.partId];
    const geom = buildSymbol({ comp: c, part, netClass: ctx.netClass, measure, connectorSide: 'right' });
    if (!geom) continue;
    const s = c.schematic!;
    placed.push(place(makeProto(c, part, geom, s.rotation ?? 0, ctx), s.x, s.y));
  }
  let usedBox = placed.reduce((b, p) => union(b, p.full), EMPTY);

  // 2) Auto layout for the rest.
  if (auto.length) {
    const result = autoLayout(auto, parts, ctx);
    const dx = Number.isFinite(usedBox.x1) ? snap(usedBox.x1 + 15 - result.box.x0) : snap(-result.box.x0);
    const dy = Number.isFinite(usedBox.y0) ? snap(usedBox.y0 - result.box.y0) : snap(-result.box.y0);
    for (const it of result.items) placed.push(place(it.proto, it.x + dx, it.y + dy));
    usedBox = placed.reduce((b, p) => union(b, p.full), EMPTY);
  }
  if (!Number.isFinite(usedBox.x0)) usedBox = { x0: 0, y0: 0, x1: 100, y1: 60 };

  const notes = (board.schematic?.notes ?? []).map((n) => ({ x: n.at[0], y: n.at[1], text: n.text }));
  for (const n of notes) usedBox = union(usedBox, { x0: n.x, y0: n.y - 2, x1: n.x + measure(n.text, 1.5), y1: n.y });

  const margin = 10;
  const tbW = 104;
  const tbH = 22;
  const content = usedBox;
  const width = Math.max(content.x1 - content.x0 + 2 * margin, tbW + 2 * margin);
  const height = content.y1 - content.y0 + 2 * margin + tbH + 4;
  const sheet: Box = { x0: content.x0 - margin, y0: content.y0 - margin, x1: content.x0 - margin + width, y1: content.y0 - margin + height };
  const titleBlock: Box = { x0: sheet.x1 - 4 - tbW, y0: sheet.y1 - 4 - tbH, x1: sheet.x1 - 4, y1: sheet.y1 - 4 };
  return { symbols: placed.map((p) => p.sym), terminals: placed.flatMap((p) => p.terms), content, sheet, titleBlock, notes };
}

function autoLayout(comps: ComponentInstance[], parts: Record<string, PartDef>, ctx: LayoutCtx): { items: { proto: Proto; x: number; y: number }[]; box: Box } {
  type HubInfo = { comp: ComponentInstance; part?: PartDef; geom: SymbolGeom; proto: Proto; column: number };
  const hubs: HubInfo[] = [];
  const satComps: { comp: ComponentInstance; part?: PartDef }[] = [];
  const isHubCat = (p?: PartDef) => {
    const cat = p?.category;
    if (!cat) return true;
    return !['resistor', 'capacitor', 'capacitor-polarized', 'inductor', 'ferrite', 'diode', 'zener', 'schottky', 'tvs', 'led', 'bjt-npn', 'bjt-pnp', 'mosfet-n', 'mosfet-p', 'crystal', 'switch', 'button', 'fuse', 'battery', 'buzzer', 'testpoint', 'antenna'].includes(cat);
  };

  // Connector side: power entry on the left, everything else on the right.
  const regulatorInputNets = new Set<string>();
  for (const c of comps) {
    const p = parts[c.partId];
    if (p?.category === 'ldo' || p?.category === 'dc-dc') {
      for (const pin of p.pins) if (pin.type === 'power_in' && ctx.netClass(c.pinNets[pin.number]) !== 'ground' && c.pinNets[pin.number]) regulatorInputNets.add(c.pinNets[pin.number]);
    }
  }
  const entryish = (c: ComponentInstance) =>
    Object.values(c.pinNets).some((n) => regulatorInputNets.has(n) || /^(VBUS|VIN|VBAT|VSYS|DC_?IN|VCC_IN|BAT)/i.test(ctx.netName(n)));

  for (const c of comps) {
    const part = parts[c.partId];
    if (!isHubCat(part)) {
      satComps.push({ comp: c, part });
      continue;
    }
    const isConn = part?.category === 'connector' || part?.category === 'cable' || part?.category === 'wire';
    const entry = isConn && entryish(c);
    const geom = buildSymbol({ comp: c, part, netClass: ctx.netClass, measure: ctx.measure, connectorSide: entry ? 'right' : 'left' });
    if (!geom) continue;
    const cat = part?.category;
    const column = isConn ? (entry ? 0 : 4) : cat === 'ldo' || cat === 'dc-dc' ? 1 : cat === 'mcu' ? 2 : 3;
    hubs.push({ comp: c, part, geom, proto: makeProto(c, part, geom, 0, ctx), column });
  }
  // Without an MCU, generic ICs take the centre column.
  if (!hubs.some((h) => h.column === 2)) for (const h of hubs) if (h.column === 3) h.column = 2;

  const hubPinsOnNet = new Map<string, { hub: number; pin: PlacedPin }[]>();
  hubs.forEach((h, hi) => {
    for (const p of h.proto.pins) {
      if (!p.netId) continue;
      let arr = hubPinsOnNet.get(p.netId);
      if (!arr) hubPinsOnNet.set(p.netId, (arr = []));
      arr.push({ hub: hi, pin: p });
    }
  });
  const dist = (a: ComponentInstance, b: ComponentInstance) => (a.placed && b.placed ? Math.hypot(a.x - b.x, a.y - b.y) : 0);
  const isRail = (n: string) => {
    const c = ctx.netClass(n);
    return c === 'power' || c === 'ground';
  };
  const sideOf = (dir: PinDir): Side => (dir === 'up' ? 'top' : dir === 'down' ? 'bottom' : dir);

  /* Attach satellites. */
  const attach = new Map<string, { hub: number; side: Side; key: number; viaNet?: string }>();
  for (const s of satComps) {
    const sig = [...new Set(Object.values(s.comp.pinNets).filter((n) => !isRail(n)))];
    let best: { hub: number; score: number; d: number; pin: PlacedPin } | null = null;
    for (const n of sig)
      for (const hp of hubPinsOnNet.get(n) ?? []) {
        const score = sig.filter((m) => hubs[hp.hub].proto.pins.some((p) => p.netId === m)).length;
        const d = dist(s.comp, hubs[hp.hub].comp);
        const connPenalty = hubs[hp.hub].geom.kind === 'connector' ? 1 : 0;
        if (!best || score > best.score || (score === best.score && (connPenalty < (hubs[best.hub].geom.kind === 'connector' ? 1 : 0) || d < best.d))) best = { hub: hp.hub, score, d, pin: hp.pin };
      }
    if (best) attach.set(s.comp.id, { hub: best.hub, side: sideOf(best.pin.wdir), key: best.pin.wy + best.pin.wx * 0.001 });
  }
  // Chains (LED behind its resistor, gate driver behind its series resistor…).
  const chainPass = () => {
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (const s of satComps) {
        if (attach.has(s.comp.id)) continue;
        const sig = Object.values(s.comp.pinNets).filter((n) => !isRail(n));
        for (const o of satComps) {
          const a = attach.get(o.comp.id);
          if (!a || o === s) continue;
          if (Object.values(o.comp.pinNets).some((n) => sig.includes(n))) {
            attach.set(s.comp.id, { hub: a.hub, side: a.side, key: a.key + 0.01 });
            changed = true;
            break;
          }
        }
      }
      if (!changed) break;
    }
  };
  chainPass();
  // Decoupling / rail-only parts: nearest hub (by board placement) sharing a rail; ICs preferred.
  for (const s of satComps) {
    if (attach.has(s.comp.id)) continue;
    const allNets = Object.values(s.comp.pinNets);
    const railOnly = allNets.every((n) => isRail(n));
    const rails = [...new Set(allNets.filter((n) => ctx.netClass(n) === 'power'))];
    let best: { hub: number; d: number; conn: number; pin: PlacedPin } | null = null;
    for (const n of rails)
      for (const hp of hubPinsOnNet.get(n) ?? []) {
        const d = dist(s.comp, hubs[hp.hub].comp);
        const conn = hubs[hp.hub].geom.kind === 'connector' ? 1 : 0;
        if (!best || conn < best.conn || (conn === best.conn && d < best.d)) best = { hub: hp.hub, d, conn, pin: hp.pin };
      }
    if (best) {
      const h = hubs[best.hub];
      const side: Side = h.geom.kind === 'connector' ? sideOf(best.pin.wdir) : railOnly ? 'top' : 'bottom';
      attach.set(s.comp.id, { hub: best.hub, side, key: side === 'top' || side === 'bottom' ? best.pin.wx : best.pin.wy });
    }
  }
  chainPass();

  /* Satellite prototypes with orientation rules. */
  const sats: Sat[] = [];
  const misc: Proto[] = [];
  for (const s of satComps) {
    const geom0 = buildSymbol({ comp: s.comp, part: s.part, netClass: ctx.netClass, measure: ctx.measure });
    if (!geom0) continue;
    let rot = 0;
    if (geom0.kind === 'two') {
      const [a, b] = geom0.pins;
      const ca = a.netId ? ctx.netClass(a.netId) : 'signal';
      const cb = b.netId ? ctx.netClass(b.netId) : 'signal';
      const polar = ['diode', 'zener', 'schottky', 'tvs', 'led', 'capacitor-polarized', 'battery', 'buzzer'].includes(s.part?.category ?? '');
      const rank = (c: NetClass) => (c === 'power' ? 0 : c === 'ground' ? 2 : 1);
      if ((ca === 'power' && cb === 'power') || (rank(ca) === 1 && rank(cb) === 1)) rot = 90;
      else if (!polar && rank(ca) > rank(cb)) rot = 180;
    }
    const proto = makeProto(s.comp, s.part, geom0, rot, ctx);
    const a = attach.get(s.comp.id);
    if (a) sats.push({ proto, hub: a.hub, side: a.side, key: a.key });
    else misc.push(proto);
  }

  /* Build clusters. */
  const GAP = G;
  type Item = { proto: Proto; x: number; y: number };
  type Cluster = { items: Item[]; box: Box; column: number };
  const clusters: Cluster[] = [];
  const packRow = (protos: Proto[], maxW: number): { items: Item[]; box: Box } => {
    // Shelf-pack cells left→right, wrapping rows; positions are cell top-left based.
    const items: Item[] = [];
    let x = 0;
    let y = 0;
    let rowH = 0;
    let box = EMPTY;
    for (const p of protos) {
      const w = p.full.x1 - p.full.x0;
      const h = p.full.y1 - p.full.y0;
      if (x > 0 && x + w > maxW) {
        x = 0;
        y += rowH + GAP;
        rowH = 0;
      }
      const ox = snap(x - p.full.x0);
      const oy = snap(y - p.full.y0);
      items.push({ proto: p, x: ox, y: oy });
      box = union(box, shift(p.full, ox, oy));
      x = ox + p.full.x1 + GAP;
      rowH = Math.max(rowH, oy + p.full.y1 - y);
    }
    return { items, box };
  };

  hubs.forEach((h, hi) => {
    const items: Item[] = [{ proto: h.proto, x: 0, y: 0 }];
    let box = h.proto.full;
    const bySide: Record<Side, Sat[]> = { left: [], right: [], top: [], bottom: [] };
    for (const s of sats) if (s.hub === hi) bySide[s.side].push(s);
    for (const side of ['left', 'right', 'top', 'bottom'] as Side[]) {
      const list = bySide[side].sort((a, b) => a.key - b.key);
      if (!list.length) continue;
      const maxW = side === 'top' || side === 'bottom' ? Math.max(40, h.proto.full.x1 - h.proto.full.x0) : 46;
      const packed = packRow(
        list.map((s) => s.proto),
        maxW,
      );
      let dx = 0;
      let dy = 0;
      const hb = h.proto.full;
      if (side === 'right') {
        dx = hb.x1 + 2 * G - packed.box.x0;
        dy = h.proto.body.y0 - packed.box.y0;
      } else if (side === 'left') {
        dx = hb.x0 - 2 * G - packed.box.x1;
        dy = h.proto.body.y0 - packed.box.y0;
      } else if (side === 'top') {
        dx = hb.x0 - packed.box.x0;
        dy = hb.y0 - 2 * G - packed.box.y1;
      } else {
        dx = hb.x0 - packed.box.x0;
        dy = hb.y1 + 2 * G - packed.box.y0;
      }
      dx = snap(dx);
      dy = snap(dy);
      for (const it of packed.items) items.push({ proto: it.proto, x: it.x + dx, y: it.y + dy });
      box = union(box, shift(packed.box, dx, dy));
    }
    clusters.push({ items, box, column: h.column });
  });
  if (misc.length) {
    const packed = packRow(misc, 80);
    clusters.push({ items: packed.items, box: packed.box, column: 5 });
  }

  /* Columns: semantic order (entry → power → core → peripherals → outputs → misc); short neighbouring
     columns are stacked so the sheet stays compact, tall ones are split. */
  const colIds = [...new Set(clusters.map((c) => c.column))].sort((a, b) => a - b);
  const VGAP = 3 * G;
  const hOf = (c: Cluster) => c.box.y1 - c.box.y0;
  const stackH = (list: Cluster[]) => list.reduce((s2, c) => s2 + hOf(c), 0) + VGAP * Math.max(0, list.length - 1);
  const totalArea = clusters.reduce((s2, c) => s2 + (c.box.x1 - c.box.x0) * hOf(c), 0);
  const semantic = colIds.map((col) => clusters.filter((c) => c.column === col));
  const tallest = Math.max(...semantic.map(stackH), ...clusters.map(hOf));
  const limit = Math.max(Math.min(tallest, Math.sqrt(totalArea / 0.55 / 1.5) * 1.15), Math.max(...clusters.map(hOf)), 90);
  const columns: Cluster[][] = [];
  for (const sem of semantic) {
    for (const c of sem) {
      const cur = columns[columns.length - 1];
      if (cur && stackH([...cur, c]) <= limit && (cur.length === 0 || cur[cur.length - 1].column === c.column || stackH(sem) + stackH(cur) <= limit)) cur.push(c);
      else columns.push([c]);
    }
  }
  const maxStack = Math.max(...columns.map(stackH));
  const out: Item[] = [];
  let cx = 0;
  let all = EMPTY;
  for (const g of columns) {
    const colW = Math.max(...g.map((c) => c.box.x1 - c.box.x0));
    let cy = (maxStack - stackH(g)) / 2;
    for (const c of g) {
      const dx = snap(cx - c.box.x0 + (colW - (c.box.x1 - c.box.x0)) / 2);
      const dy = snap(cy - c.box.y0);
      for (const it of c.items) out.push({ proto: it.proto, x: it.x + dx, y: it.y + dy });
      all = union(all, shift(c.box, dx, dy));
      cy += hOf(c) + VGAP;
    }
    cx += colW + 4 * G;
  }
  return { items: out, box: Number.isFinite(all.x0) ? all : { x0: 0, y0: 0, x1: 10, y1: 10 } };
}
