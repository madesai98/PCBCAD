import type { ComponentInstance, PartCategory, PartDef, PinDef, PinType } from '@pcbcad/core';
import { naturalCompare } from '../common/format';

/* ------------------------------------------------------------------------------------------------
 * Schematic symbol geometry. Units: mm, Y DOWN (SVG), pins on a 2.54 mm grid. A symbol is a list of
 * drawing primitives plus pins whose tips are the connection points.
 * ---------------------------------------------------------------------------------------------- */

export const G = 2.54;

export type Fill = 'none' | 'body' | 'stroke' | 'tint' | 'bg';

export type Prim =
  | { t: 'path'; d: string; fill?: Fill; w?: number; accent?: boolean }
  | { t: 'circle'; cx: number; cy: number; r: number; fill?: Fill; w?: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number; rx?: number; fill?: Fill; sw?: number }
  | { t: 'text'; x: number; y: number; text: string; size: number; anchor: 'start' | 'middle' | 'end'; cls: 'pinname' | 'pinnum' | 'body'; rot?: number };

export type PinDir = 'left' | 'right' | 'up' | 'down';

export interface SymPin {
  /** Pin numbers merged into this terminal (e.g. tactile switch 1+2). */
  numbers: string[];
  name: string;
  netId?: string;
  type?: PinType;
  /** Tip (connection point) relative to the symbol origin. */
  x: number;
  y: number;
  dir: PinDir;
  /** Pin line length drawn from the tip toward the body (box symbols). */
  line: number;
  /** Show pin number next to the pin line (box/connector symbols). */
  showNumber: boolean;
}

export type SymbolKind = 'box' | 'two' | 'three' | 'one' | 'connector';

export interface SymbolGeom {
  kind: SymbolKind;
  prims: Prim[];
  pins: SymPin[];
  /** Bounds of body + pin tips (symbol frame, before rotation). */
  box: { x0: number; y0: number; x1: number; y1: number };
  /** Accent colour for LEDs. */
  accent?: string;
}

export interface SymbolContext {
  comp: ComponentInstance;
  part?: PartDef;
  /** net id → class, for pin-side heuristics. */
  netClass: (netId: string | undefined) => string | undefined;
  /** Text width estimate in mm for a string at a font size. */
  measure: (text: string, size: number) => number;
  /** Connector pins face this direction (layout decides). */
  connectorSide?: 'left' | 'right';
}

export const TWO_TERMINAL: PartCategory[] = [
  'resistor',
  'capacitor',
  'capacitor-polarized',
  'inductor',
  'ferrite',
  'diode',
  'zener',
  'schottky',
  'tvs',
  'led',
  'crystal',
  'switch',
  'button',
  'fuse',
  'battery',
  'buzzer',
];
export const THREE_TERMINAL: PartCategory[] = ['bjt-npn', 'bjt-pnp', 'mosfet-n', 'mosfet-p'];
export const ONE_TERMINAL: PartCategory[] = ['testpoint', 'antenna'];

const PIN_NAME_SIZE = 1.27;
const PIN_NUM_SIZE = 1.0;

/* ------------------------------------------- utilities ------------------------------------------ */

const f = (v: number) => Math.round(v * 1000) / 1000;

function lead(x: number, y0: number, y1: number): Prim {
  return { t: 'path', d: `M${f(x)} ${f(y0)}V${f(y1)}` };
}

/** Pins of a part (falls back to the instance's pinNets when the part has no pin list). */
export function partPins(comp: ComponentInstance, part?: PartDef): PinDef[] {
  if (part?.pins?.length) return part.pins;
  return Object.keys(comp.pinNets)
    .sort(naturalCompare)
    .map((n) => ({ number: n, name: n, type: 'unspecified' as PinType }));
}

/** Collapse pins that share a net into one terminal (switch 1+2, crystal case pins…). */
function terminals(comp: ComponentInstance, part?: PartDef): { numbers: string[]; name: string; netId?: string; type?: PinType }[] {
  const pins = partPins(comp, part);
  const byNet = new Map<string, { numbers: string[]; name: string; netId?: string; type?: PinType }>();
  const out: { numbers: string[]; name: string; netId?: string; type?: PinType }[] = [];
  for (const p of pins) {
    const net = comp.pinNets[p.number];
    if (net) {
      const hit = byNet.get(net);
      if (hit) {
        if (!hit.numbers.includes(p.number)) hit.numbers.push(p.number);
        continue;
      }
      const t = { numbers: [p.number], name: p.name, netId: net, type: p.type };
      byNet.set(net, t);
      out.push(t);
    } else out.push({ numbers: [p.number], name: p.name, type: p.type });
  }
  return out;
}

/* --------------------------------------- two-terminal bodies ------------------------------------ */

function twoBody(cat: PartCategory, accent?: string): Prim[] {
  const L = 3 * G * 0.5; // 3.81: tip distance
  switch (cat) {
    case 'resistor': {
      const pts: [number, number][] = [
        [0, -2.54],
        [0.9, -2.12],
        [-0.9, -1.27],
        [0.9, -0.42],
        [-0.9, 0.42],
        [0.9, 1.27],
        [-0.9, 2.12],
        [0, 2.54],
      ];
      return [lead(0, -L, -2.54), lead(0, 2.54, L), { t: 'path', d: 'M' + pts.map((p) => `${p[0]} ${p[1]}`).join('L') }];
    }
    case 'capacitor':
      return [lead(0, -L, -0.6), lead(0, 0.6, L), { t: 'path', d: 'M-1.6 -0.6H1.6M-1.6 0.6H1.6', w: 0.32 }];
    case 'capacitor-polarized':
      return [
        lead(0, -L, -0.6),
        lead(0, 0.35, L),
        { t: 'path', d: 'M-1.6 -0.6H1.6', w: 0.32 },
        { t: 'path', d: 'M-1.6 1.0Q0 0.15 1.6 1.0', w: 0.32 },
        { t: 'path', d: 'M-1.75 -1.75H-0.85M-1.3 -2.2V-1.3', w: 0.2 },
      ];
    case 'inductor':
      return [
        lead(0, -L, -2.54),
        lead(0, 2.54, L),
        { t: 'path', d: 'M0 -2.54A0.635 0.635 0 0 1 0 -1.27A0.635 0.635 0 0 1 0 0A0.635 0.635 0 0 1 0 1.27A0.635 0.635 0 0 1 0 2.54' },
      ];
    case 'ferrite': {
      const a = (35 * Math.PI) / 180;
      const pts: [number, number][] = [
        [-0.65, -1.7],
        [0.65, -1.7],
        [0.65, 1.7],
        [-0.65, 1.7],
      ].map(([x, y]) => [f(x * Math.cos(a) - y * Math.sin(a)), f(x * Math.sin(a) + y * Math.cos(a))]);
      return [lead(0, -L, -1.3), lead(0, 1.3, L), { t: 'path', d: 'M' + pts.map((p) => `${p[0]} ${p[1]}`).join('L') + 'Z', fill: 'tint' }];
    }
    case 'diode':
    case 'zener':
    case 'schottky':
    case 'led': {
      const prims: Prim[] = [lead(0, -L, -1.0), lead(0, 1.0, L), { t: 'path', d: 'M-1.27 -1.0H1.27L0 1.0Z', fill: 'tint' }];
      if (cat === 'zener') prims.push({ t: 'path', d: 'M-1.75 1.5L-1.27 1.0H1.27L1.75 0.5' });
      else if (cat === 'schottky') prims.push({ t: 'path', d: 'M-0.75 1.5H-1.27V1.0H1.27V0.5H0.75' });
      else prims.push({ t: 'path', d: 'M-1.27 1.0H1.27' });
      if (cat === 'led') {
        const arrow = (x0: number, y0: number) => {
          const x1 = x0 + 1.1;
          const y1 = y0 - 0.9;
          return `M${x0} ${y0}L${f(x1)} ${f(y1)}M${f(x1 - 0.55)} ${f(y1 - 0.02)}L${f(x1)} ${f(y1)}L${f(x1 - 0.12)} ${f(y1 + 0.52)}`;
        };
        prims.push({ t: 'path', d: arrow(1.55, -0.15) + arrow(1.55, 0.95), w: 0.2, accent: true });
      }
      return prims;
    }
    case 'tvs':
      return [
        lead(0, -L, -1.6),
        lead(0, 1.6, L),
        { t: 'path', d: 'M-1.27 -1.6H1.27L0 0Z', fill: 'tint' },
        { t: 'path', d: 'M-1.27 1.6H1.27L0 0Z', fill: 'tint' },
        { t: 'path', d: 'M-1.75 0.45L-1.27 0H1.27L1.75 -0.45' },
      ];
    case 'crystal':
      return [lead(0, -L, -1.6), lead(0, 1.6, L), { t: 'path', d: 'M-1.6 -1.6H1.6M-1.6 1.6H1.6', w: 0.3 }, { t: 'rect', x: -1.0, y: -1.0, w: 2.0, h: 2.0, fill: 'tint' }];
    case 'switch':
      return [lead(0, -L, -1.6), lead(0, 1.6, L), { t: 'circle', cx: 0, cy: -1.3, r: 0.3, fill: 'bg' }, { t: 'circle', cx: 0, cy: 1.3, r: 0.3, fill: 'bg' }, { t: 'path', d: 'M0.2 1.05L-1.3 -1.35' }];
    case 'button':
      return [
        lead(0, -L, -1.6),
        lead(0, 1.6, L),
        { t: 'circle', cx: 0, cy: -1.3, r: 0.3, fill: 'bg' },
        { t: 'circle', cx: 0, cy: 1.3, r: 0.3, fill: 'bg' },
        { t: 'path', d: 'M-1.0 -1.7V1.7M-1.0 0H-2.3M-2.3 -0.6V0.6' },
      ];
    case 'fuse':
      return [lead(0, -L, L), { t: 'rect', x: -0.75, y: -1.9, w: 1.5, h: 3.8, rx: 0.2, fill: 'tint' }];
    case 'battery':
      return [
        lead(0, -L, -1.1),
        lead(0, 1.1, L),
        { t: 'path', d: 'M-1.7 -1.1H1.7M-1.7 0.35H1.7', w: 0.22 },
        { t: 'path', d: 'M-0.85 -0.35H0.85M-0.85 1.1H0.85', w: 0.55 },
        { t: 'path', d: 'M1.5 -2.2H2.4M1.95 -2.65V-1.75', w: 0.2 },
      ];
    case 'buzzer':
      return [
        lead(0, -L, -1.4),
        lead(0, 1.4, L),
        { t: 'rect', x: -1.4, y: -1.4, w: 1.8, h: 2.8, rx: 0.25, fill: 'tint' },
        { t: 'path', d: 'M1.0 -0.9Q1.6 0 1.0 0.9M1.6 -1.4Q2.5 0 1.6 1.4', w: 0.2 },
      ];
    default:
      return [lead(0, -L, -1.9), lead(0, 1.9, L), { t: 'rect', x: -1.0, y: -1.9, w: 2.0, h: 3.8, rx: 0.25, fill: 'tint' }];
  }
}

function pinRole(name: string, ...cands: string[]): boolean {
  const n = name.trim().toUpperCase().replace(/^~/, '');
  return cands.some((c) => n === c || n.startsWith(c + '/') || n === c + 'NODE');
}

/** Index (0/1) of the terminal that should sit on top (anode / + side). */
function topTerminalIndex(cat: PartCategory, part: PartDef | undefined, terms: { numbers: string[]; name: string }[]): number {
  const polar = ['diode', 'zener', 'schottky', 'tvs', 'led', 'capacitor-polarized', 'battery', 'buzzer'];
  if (!polar.includes(cat)) return 0;
  const sim = part?.sim;
  if (sim && (sim.kind === 'diode' || sim.kind === 'led')) {
    const i = terms.findIndex((t) => t.numbers.includes(sim.anode));
    if (i >= 0) return i;
  }
  const i = terms.findIndex((t) => pinRole(t.name, 'A', 'ANODE', '+', 'POS', 'VCC', 'V+'));
  if (i >= 0) return i;
  const k = terms.findIndex((t) => pinRole(t.name, 'K', 'C', 'CATHODE', '-', 'NEG'));
  if (k >= 0) return 1 - k;
  return cat === 'capacitor-polarized' || cat === 'battery' || cat === 'buzzer' ? 0 : 1; // diodes: pin 1 = K
}

/* --------------------------------------------- builders ----------------------------------------- */

export function ledColor(part?: PartDef, comp?: ComponentInstance): string | undefined {
  const sim = part?.sim;
  const c = (sim?.kind === 'led' ? sim.color : undefined) ?? part?.params?.Color ?? comp?.value ?? part?.value;
  if (!c) return undefined;
  if (c.startsWith('#')) return c;
  const m: Record<string, string> = { red: '#ef4444', green: '#22c55e', blue: '#3b82f6', yellow: '#eab308', amber: '#f59e0b', orange: '#f97316', white: '#e5e7eb', warm: '#fbbf24', pink: '#ec4899', purple: '#a855f7', uv: '#8b5cf6', ir: '#7f1d1d', rgb: '#22d3ee' };
  const key = Object.keys(m).find((k) => c.toLowerCase().includes(k));
  return key ? m[key] : undefined;
}

function buildTwo(ctx: SymbolContext, cat: PartCategory): SymbolGeom | null {
  const terms = terminals(ctx.comp, ctx.part);
  if (terms.length < 2) return null;
  let main = terms;
  let extras: typeof terms = [];
  if (terms.length > 2) {
    // Crystals / switches with case or extra pins: the two non-ground terminals are the main ones.
    const nonGround = terms.filter((t) => ctx.netClass(t.netId) !== 'ground');
    if (nonGround.length >= 2) {
      main = nonGround.slice(0, 2);
      extras = terms.filter((t) => !main.includes(t));
    } else {
      main = terms.slice(0, 2);
      extras = terms.slice(2);
    }
    if (extras.length > 2) return null;
  }
  const top = topTerminalIndex(cat, ctx.part, main);
  const ordered = top === 0 ? main : [main[1], main[0]];
  const accent = cat === 'led' ? ledColor(ctx.part, ctx.comp) : undefined;
  const L = 3.81;
  const pins: SymPin[] = [
    { ...ordered[0], x: 0, y: -L, dir: 'up', line: 0, showNumber: false },
    { ...ordered[1], x: 0, y: L, dir: 'down', line: 0, showNumber: false },
  ];
  const prims = twoBody(cat, accent);
  extras.forEach((t, i) => {
    const y = i === 0 ? 0 : 2.54;
    prims.push({ t: 'path', d: `M1.0 ${y}H${G}`, w: 0.2 });
    pins.push({ ...t, x: G, y, dir: 'right', line: 0, showNumber: false });
  });
  return { kind: 'two', prims, pins, box: { x0: -1.9, y0: -L, x1: extras.length ? G : 1.9, y1: L }, accent };
}

function buildThree(ctx: SymbolContext, cat: PartCategory): SymbolGeom | null {
  const pins = partPins(ctx.comp, ctx.part);
  if (pins.length !== 3) return null;
  const bjt = cat.startsWith('bjt');
  const sim = ctx.part?.sim;
  let roles: Record<'in' | 'top' | 'bot', string | undefined> = { in: undefined, top: undefined, bot: undefined };
  if (bjt && sim?.kind === 'bjt') roles = { in: sim.b, top: sim.c, bot: sim.e };
  else if (!bjt && sim?.kind === 'mosfet') roles = { in: sim.g, top: sim.d, bot: sim.s };
  else {
    const find = (...names: string[]) => pins.find((p) => pinRole(p.name, ...names))?.number;
    roles = bjt ? { in: find('B', 'BASE'), top: find('C', 'COLLECTOR'), bot: find('E', 'EMITTER') } : { in: find('G', 'GATE'), top: find('D', 'DRAIN'), bot: find('S', 'SOURCE') };
    if (!roles.in || !roles.top || !roles.bot) roles = bjt ? { in: '1', top: '3', bot: '2' } : { in: '1', top: '3', bot: '2' };
  }
  const pnp = cat === 'bjt-pnp' || cat === 'mosfet-p';
  // P-type parts are drawn emitter/source on top (they hang from the positive rail).
  const topNum = pnp ? roles.bot! : roles.top!;
  const botNum = pnp ? roles.top! : roles.bot!;
  const pinBy = (n: string) => pins.find((p) => p.number === n);
  const mk = (n: string, x: number, y: number, dir: PinDir): SymPin => {
    const p = pinBy(n);
    return { numbers: [n], name: p?.name ?? n, netId: ctx.comp.pinNets[n], type: p?.type, x, y, dir, line: 0, showNumber: false };
  };
  const sp: SymPin[] = [mk(roles.in!, -5.08, 0, 'left'), mk(topNum, G, -5.08, 'up'), mk(botNum, G, 5.08, 'down')];
  const prims: Prim[] = [{ t: 'circle', cx: 0.85, cy: 0, r: 3.1, fill: 'tint', w: 0.2 }];
  if (bjt) {
    prims.push(
      { t: 'path', d: 'M-5.08 0H-0.7' },
      { t: 'path', d: 'M-0.7 -1.9V1.9', w: 0.45 },
      { t: 'path', d: 'M-0.7 -0.75L2.54 -2.65V-5.08' },
      { t: 'path', d: 'M-0.7 0.75L2.54 2.65V5.08' },
    );
    // Emitter arrow: NPN points out of the base (down here), PNP into the base (emitter on top).
    const ex0 = -0.7;
    const ey0 = pnp ? -0.75 : 0.75;
    const ex1 = 2.54;
    const ey1 = pnp ? -2.65 : 2.65;
    const t = pnp ? 0.42 : 0.82;
    const tipx = ex0 + (ex1 - ex0) * t;
    const tipy = ey0 + (ey1 - ey0) * t;
    const len = Math.hypot(ex1 - ex0, ey1 - ey0);
    let ux = (ex1 - ex0) / len;
    let uy = (ey1 - ey0) / len;
    if (pnp) {
      ux = -ux;
      uy = -uy;
    }
    const bx = tipx - ux * 1.0;
    const by = tipy - uy * 1.0;
    prims.push({ t: 'path', d: `M${f(tipx)} ${f(tipy)}L${f(bx - uy * 0.45)} ${f(by + ux * 0.45)}L${f(bx + uy * 0.45)} ${f(by - ux * 0.45)}Z`, fill: 'stroke', w: 0.1 });
  } else {
    prims.push(
      { t: 'path', d: 'M-5.08 0H-1.45M-1.45 -1.9V1.9' },
      { t: 'path', d: 'M-0.75 -2.05V-1.05M-0.75 -0.5V0.5M-0.75 1.05V2.05', w: 0.38 },
      { t: 'path', d: 'M-0.75 -1.55H2.54V-5.08M-0.75 1.55H2.54V5.08M-0.75 0H1.2' },
      { t: 'path', d: 'M1.2 0V1.55' },
    );
    // Body arrow: N-channel points into the channel, P-channel out of it.
    prims.push({ t: 'path', d: pnp ? 'M1.05 0L0.0 -0.48V0.48Z' : 'M-0.6 0L0.45 -0.48V0.48Z', fill: 'stroke', w: 0.1 });
  }
  return { kind: 'three', prims, pins: sp, box: { x0: -5.08, y0: -5.08, x1: 4.2, y1: 5.08 } };
}

function buildOne(ctx: SymbolContext, cat: PartCategory): SymbolGeom | null {
  const terms = terminals(ctx.comp, ctx.part);
  if (terms.length !== 1) return null;
  const prims: Prim[] =
    cat === 'antenna'
      ? [{ t: 'path', d: 'M0 2.54V-1.2M-1.6 -3.0L0 -1.2L1.6 -3.0M0 -1.2V-3.0' }]
      : [{ t: 'path', d: 'M0 2.54V0.8' }, { t: 'circle', cx: 0, cy: 0, r: 0.8, fill: 'tint' }];
  return { kind: 'one', prims, pins: [{ ...terms[0], x: 0, y: 2.54, dir: 'down', line: 0, showNumber: false }], box: { x0: -1.7, y0: cat === 'antenna' ? -3.0 : -0.8, x1: 1.7, y1: 2.54 } };
}

/** Pin side heuristic for box symbols. */
export function boxPinSide(p: PinDef, netClass: string | undefined, regulator: boolean): PinDir | 'nc' {
  if (p.side) return p.side === 'top' ? 'up' : p.side === 'bottom' ? 'down' : p.side;
  const name = p.name.toUpperCase().replace(/^~/, '');
  const isGround = netClass === 'ground' || /^(GND|VSS|AGND|DGND|PGND|EP|EPAD|PAD|0V)\b/.test(name) || name.startsWith('GND');
  if (isGround && (p.type === 'power_in' || p.type === 'passive' || p.type === 'unspecified' || netClass === 'ground')) return 'down';
  if (p.type === 'nc') return 'nc';
  if (regulator) {
    if (p.type === 'power_out' || /OUT/.test(name)) return 'right';
    if (p.type === 'power_in' || /^(VIN|IN|VCC|VDD)/.test(name)) return 'left';
  }
  if (p.type === 'power_in') return 'up';
  if (p.type === 'power_out' || p.type === 'output' || p.type === 'open_collector' || p.type === 'open_emitter') return 'right';
  if (p.type === 'input') return 'left';
  return 'left'; // balanced later
}

function buildBox(ctx: SymbolContext): SymbolGeom {
  const part = ctx.part;
  const cat = part?.category;
  const regulator = cat === 'ldo' || cat === 'dc-dc';
  const pins = partPins(ctx.comp, part);
  const groups: Record<PinDir, PinDef[]> = { left: [], right: [], up: [], down: [] };
  const balanced: PinDef[] = [];
  const nc: PinDef[] = [];
  // Merge duplicate-named power/ground pins that share a net (GND ×3 on an MCU) into one pin entry.
  const seen = new Map<string, PinDef & { extra: string[] }>();
  const uniq: (PinDef & { extra: string[] })[] = [];
  for (const p of pins) {
    const net = ctx.comp.pinNets[p.number];
    const key = net && (p.type === 'power_in' || p.type === 'power_out' || ctx.netClass(net) === 'ground') ? `${p.name.toUpperCase()}|${net}` : `#${p.number}`;
    const hit = seen.get(key);
    if (hit) hit.extra.push(p.number);
    else {
      const e = { ...p, extra: [] as string[] };
      seen.set(key, e);
      uniq.push(e);
    }
  }
  for (const p of uniq) {
    const side = boxPinSide(p, ctx.netClass(ctx.comp.pinNets[p.number]), regulator);
    if (side === 'nc') nc.push(p);
    else if (side === 'left' && p.type !== 'input' && !p.side && !(regulator && (p.type === 'power_in' || /^(VIN|IN)/i.test(p.name)))) balanced.push(p);
    else groups[side].push(p);
  }
  const mcuLike = cat === 'mcu' || cat === 'module' || cat === 'rf-module';
  const sortPins = (a: PinDef, b: PinDef) => (mcuLike ? naturalCompare(a.name, b.name) : naturalCompare(a.number, b.number));
  balanced.sort(sortPins);
  // Balance: fill the shorter side, keeping order (first half left, second half right).
  const total = groups.left.length + groups.right.length + balanced.length;
  const leftTarget = Math.ceil(total / 2);
  const toLeft = Math.max(0, Math.min(balanced.length, leftTarget - groups.left.length));
  groups.left.push(...balanced.slice(0, toLeft));
  groups.right.push(...balanced.slice(toLeft));
  groups.right.push(...nc);
  for (const k of ['up', 'down'] as const) groups[k].sort(sortPins);
  if (!mcuLike) {
    groups.left.sort((a, b) => naturalCompare(a.number, b.number));
    groups.right.sort((a, b) => naturalCompare(a.number, b.number));
  }

  const nameW = (list: PinDef[]) => list.reduce((m, p) => Math.max(m, ctx.measure(displayName(p.name), PIN_NAME_SIZE)), 0);
  const rows = Math.max(groups.left.length, groups.right.length, 1);
  const topSpacing = Math.max(G, Math.ceil((nameW(groups.up) + 1.0) / G) * G);
  const botSpacing = Math.max(G, Math.ceil((nameW(groups.down) + 1.0) / G) * G);
  let w = Math.max(
    4 * G,
    Math.ceil((nameW(groups.left) + nameW(groups.right) + 3.2) / G) * G,
    (groups.up.length + 1) * topSpacing,
    (groups.down.length + 1) * botSpacing,
  );
  if (Math.round(w / G) % 2 === 1) w += G; // keep the centre on grid
  const padTop = groups.up.length ? 2 * G : G;
  const padBot = groups.down.length ? 2 * G : G;
  let h = (rows - 1) * G + padTop + padBot;
  if (Math.round(h / G) % 2 === 1) h += G;
  const x0 = -w / 2;
  const y0 = -h / 2;
  const prims: Prim[] = [{ t: 'rect', x: x0, y: y0, w, h, rx: 0.5, fill: 'body', sw: 0.25 }];
  const sp: SymPin[] = [];
  const PL = G; // pin length
  const add = (p: PinDef & { extra?: string[] }, x: number, y: number, dir: PinDir) => {
    sp.push({ numbers: [p.number, ...(p.extra ?? [])], name: p.name, netId: ctx.comp.pinNets[p.number], type: p.type, x, y, dir, line: PL, showNumber: true });
  };
  groups.left.forEach((p, i) => {
    const y = y0 + padTop + i * G;
    add(p, x0 - PL, y, 'left');
    prims.push({ t: 'text', x: x0 + 0.7, y, text: displayName(p.name), size: PIN_NAME_SIZE, anchor: 'start', cls: 'pinname' });
  });
  groups.right.forEach((p, i) => {
    const y = y0 + padTop + i * G;
    add(p, x0 + w + PL, y, 'right');
    prims.push({ t: 'text', x: x0 + w - 0.7, y, text: displayName(p.name), size: PIN_NAME_SIZE, anchor: 'end', cls: 'pinname' });
  });
  const spread = (n: number, spacing: number) => Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * spacing);
  spread(groups.up.length, topSpacing).forEach((x, i) => {
    const p = groups.up[i];
    const gx = Math.round(x / G) * G;
    add(p, gx, y0 - PL, 'up');
    prims.push({ t: 'text', x: gx, y: y0 + 1.25, text: displayName(p.name), size: PIN_NAME_SIZE, anchor: 'middle', cls: 'pinname' });
  });
  spread(groups.down.length, botSpacing).forEach((x, i) => {
    const p = groups.down[i];
    const gx = Math.round(x / G) * G;
    add(p, gx, y0 + h + PL, 'down');
    prims.push({ t: 'text', x: gx, y: y0 + h - 1.25, text: displayName(p.name), size: PIN_NAME_SIZE, anchor: 'middle', cls: 'pinname' });
  });
  return { kind: 'box', prims, pins: sp, box: { x0: x0 - PL, y0: y0 - (groups.up.length ? PL : 0), x1: x0 + w + PL, y1: y0 + h + (groups.down.length ? PL : 0) } };
}

function buildConnector(ctx: SymbolContext): SymbolGeom {
  const pins = [...partPins(ctx.comp, ctx.part)].sort((a, b) => naturalCompare(a.number, b.number));
  const side = ctx.connectorSide ?? 'right';
  const label = (p: PinDef) => (p.name && p.name !== p.number ? p.name : '');
  const numW = pins.reduce((m, p) => Math.max(m, ctx.measure(p.number, PIN_NUM_SIZE)), 0);
  const nameW = pins.reduce((m, p) => Math.max(m, ctx.measure(displayName(label(p)), PIN_NAME_SIZE)), 0);
  let w = Math.max(2 * G, Math.ceil((numW + nameW + 3.2) / G) * G);
  if (Math.round(w / G) % 2 === 1) w += G;
  let h = (pins.length + 1) * G;
  if (Math.round(h / G) % 2 === 1) h += G;
  const x0 = -w / 2;
  const y0 = -h / 2;
  const prims: Prim[] = [{ t: 'rect', x: x0, y: y0, w, h, rx: 0.6, fill: 'body', sw: 0.25 }];
  const sp: SymPin[] = [];
  pins.forEach((p, i) => {
    const y = y0 + G + i * G;
    const right = side === 'right';
    const edge = right ? x0 + w : x0;
    const tip = right ? edge + G : edge - G;
    sp.push({ numbers: [p.number], name: p.name, netId: ctx.comp.pinNets[p.number], type: p.type, x: tip, y, dir: right ? 'right' : 'left', line: G, showNumber: false });
    // contact marker + number + name inside
    const cx = right ? edge - 1.1 : edge + 1.1;
    prims.push({ t: 'rect', x: cx - 0.55, y: y - 0.32, w: 1.1, h: 0.64, rx: 0.15, fill: 'stroke', sw: 0 });
    prims.push({ t: 'text', x: right ? cx - 1.0 : cx + 1.0, y, text: p.number, size: PIN_NUM_SIZE, anchor: right ? 'end' : 'start', cls: 'pinnum' });
    const nm = label(p);
    if (nm) prims.push({ t: 'text', x: right ? x0 + 0.8 : x0 + w - 0.8, y, text: displayName(nm), size: PIN_NAME_SIZE, anchor: right ? 'start' : 'end', cls: 'pinname' });
  });
  return { kind: 'connector', prims, pins: sp, box: { x0: side === 'left' ? x0 - G : x0, y0, x1: side === 'right' ? x0 + w + G : x0 + w, y1: y0 + h } };
}

/** Strip overbar markers for measuring/display ("~RESET" → "RESET"; rendering adds the overline). */
export function displayName(name: string): string {
  return name.replace(/~\{([^}]*)\}/g, '$1').replace(/~/g, '');
}

export function overlined(name: string): boolean {
  return /~/.test(name);
}

export function buildSymbol(ctx: SymbolContext): SymbolGeom | null {
  const cat = ctx.part?.category ?? 'other';
  const pinCount = partPins(ctx.comp, ctx.part).length;
  if (pinCount === 0) return null;
  if (cat === 'connector' || cat === 'cable' || cat === 'wire') return buildConnector(ctx);
  if (TWO_TERMINAL.includes(cat)) return buildTwo(ctx, cat) ?? buildBox(ctx);
  if (THREE_TERMINAL.includes(cat)) return buildThree(ctx, cat) ?? buildBox(ctx);
  if (ONE_TERMINAL.includes(cat)) return buildOne(ctx, cat) ?? buildBox(ctx);
  if (cat === 'other' && pinCount === 2) return buildTwo(ctx, 'other' as PartCategory) ?? buildBox(ctx);
  return buildBox(ctx);
}

/* ------------------------------------------- rotation ------------------------------------------- */

/** Rotate a point by rot degrees CCW (visual) in a Y-down frame. */
export function rotPt(x: number, y: number, rot: number): [number, number] {
  const r = ((rot % 360) + 360) % 360;
  if (r === 0) return [x, y];
  if (r === 90) return [y, -x];
  if (r === 180) return [-x, -y];
  if (r === 270) return [-y, x];
  const a = (r * Math.PI) / 180;
  return [x * Math.cos(a) + y * Math.sin(a), -x * Math.sin(a) + y * Math.cos(a)];
}

export function rotDir(d: PinDir, rot: number): PinDir {
  const order: PinDir[] = ['right', 'up', 'left', 'down']; // CCW
  const steps = Math.round((((rot % 360) + 360) % 360) / 90);
  return order[(order.indexOf(d) + steps) % 4];
}
