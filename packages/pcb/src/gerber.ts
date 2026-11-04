/**
 * Manufacturing outputs: RS-274X Gerber (X2 attributes, mm, %FSLAX46Y46*%) and Excellon drill files.
 *
 * Layers: copper (top, inner, bottom), solder mask (pads expanded by MASK_EXPANSION, vias tented),
 * paste (SMD pads scaled by √pasteRatio, i.e. pasteRatio is an area ratio), silkscreen (footprint
 * graphics + reference designators in the built-in stroke font, clipped away from exposed pads),
 * Edge.Cuts (outline + cutouts), PTH / NPTH Excellon drills (METRIC, tool table, G85 slots).
 * Zone fills are written as G36/G37 regions: islands largest-first, outer ring dark (LPD) then its
 * holes clear (LPC), so nested islands are drawn after the holes they sit in.
 */
import { slugify, type Board, type CopperLayer, type PartDef, type Vec2 } from '@pcbcad/core';
import { fromIPath, primPaths } from './clip';
import { MASK_EXPANSION } from './constants';
import { makePrim, ringArea, type Prim } from './geom';
import { collectPads, holeCopperPrim, layerBit, stackLayers, viaMask, type PadInfo } from './model';
import { regionsFromRings } from './region';
import { clipStrokes, footprintSilk, placeRefText, silkKeepout, type SilkStroke } from './silk';

export interface GerberFile {
  name: string;
  content: string;
}

const VERSION = '0.1.0';

function fmt(v: number): string {
  return (Math.round(v * 1e6) / 1e6).toFixed(6);
}

function coord(v: number): string {
  return String(Math.round(v * 1e6));
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** Minimal RS-274X writer: apertures are collected first and emitted in the header (defined before use). */
export class GerberWriter {
  private readonly apKeys = new Map<string, number>();
  private readonly apDefs: string[] = [];
  private readonly ops: string[] = [];
  private nextD = 10;
  private cur = -1;
  private pol: 'D' | 'C' = 'D';

  constructor(
    private readonly fileFunction: string,
    private readonly polarity: 'Positive' | 'Negative',
    private readonly date: string,
  ) {}

  /** Define (or reuse) an aperture: C (circle d), R (w×h), O (obround w×h). */
  aperture(shape: 'C' | 'R' | 'O', dims: number[], fn?: string): number {
    const params = dims.map((d) => fmt(Math.max(0.001, d))).join('X');
    const key = `${fn ?? ''}|${shape}|${params}`;
    let d = this.apKeys.get(key);
    if (d === undefined) {
      d = this.nextD++;
      this.apKeys.set(key, d);
      if (fn) this.apDefs.push(`%TA.AperFunction,${fn}*%`);
      this.apDefs.push(`%ADD${d}${shape},${params}*%`);
      if (fn) this.apDefs.push('%TD*%');
    }
    return d;
  }

  private select(d: number): void {
    if (d !== this.cur) {
      this.ops.push(`D${d}*`);
      this.cur = d;
    }
  }

  setPolarity(p: 'D' | 'C'): void {
    if (p !== this.pol) {
      this.ops.push(`%LP${p}*%`);
      this.pol = p;
    }
  }

  flash(x: number, y: number, d: number): void {
    this.select(d);
    this.ops.push(`X${coord(x)}Y${coord(y)}D03*`);
  }

  /** Draw a polyline (a single point draws a dot). */
  stroke(pts: Vec2[], d: number): void {
    if (!pts.length) return;
    this.select(d);
    this.ops.push(`X${coord(pts[0][0])}Y${coord(pts[0][1])}D02*`);
    if (pts.length === 1) this.ops.push(`X${coord(pts[0][0])}Y${coord(pts[0][1])}D01*`);
    for (let i = 1; i < pts.length; i++) this.ops.push(`X${coord(pts[i][0])}Y${coord(pts[i][1])}D01*`);
  }

  /** Filled region (G36/G37) from a single closed contour. */
  region(ring: Vec2[], fn?: string): void {
    if (ring.length < 3) return;
    if (fn) this.ops.push(`%TA.AperFunction,${fn}*%`);
    this.ops.push('G36*');
    this.ops.push(`X${coord(ring[0][0])}Y${coord(ring[0][1])}D02*`);
    for (let i = 1; i < ring.length; i++) this.ops.push(`X${coord(ring[i][0])}Y${coord(ring[i][1])}D01*`);
    this.ops.push(`X${coord(ring[0][0])}Y${coord(ring[0][1])}D01*`);
    this.ops.push('G37*');
    if (fn) this.ops.push('%TD*%');
  }

  toString(): string {
    return [
      `%TF.GenerationSoftware,PCBCAD,@pcbcad/pcb,${VERSION}*%`,
      `%TF.CreationDate,${this.date}*%`,
      '%TF.SameCoordinates,Original*%',
      `%TF.FileFunction,${this.fileFunction}*%`,
      `%TF.FilePolarity,${this.polarity}*%`,
      '%FSLAX46Y46*%',
      'G04 Gerber Fmt 4.6, Leading zero omitted, Abs format (unit mm)*',
      `G04 Created by PCBCAD @pcbcad/pcb ${VERSION}*`,
      '%MOMM*%',
      '%LPD*%',
      'G01*',
      'G04 APERTURE LIST*',
      ...this.apDefs,
      'G04 APERTURE END LIST*',
      ...this.ops,
      ...(this.pol === 'C' ? ['%LPD*%'] : []),
      'M02*',
      '',
    ].join('\n');
  }
}

function normRot(r: number): number {
  return ((r % 360) + 360) % 360;
}

/** Emit one pad (grown by `grow` per side, scaled by `scale`) as a flash, stroke or region. */
function emitPad(w: GerberWriter, p: PadInfo, grow: number, scale: number, fn: string): void {
  const pad = p.pad;
  const pp = p.pp;
  const rot = normRot(pp.rotation || 0);
  const axis = Math.abs(rot % 90) < 1e-6 || Math.abs((rot % 90) - 90) < 1e-6;
  const quarter = Math.round(rot / 90) % 2 === 1;
  const pw = pad.w * scale;
  const ph = (pad.shape === 'circle' ? pad.w : pad.h) * scale;
  let W = pw + 2 * grow;
  let H = ph + 2 * grow;
  if (W <= 0 || H <= 0) return;
  if (axis && quarter) [W, H] = [H, W];
  if (pad.shape === 'circle') return w.flash(pp.x, pp.y, w.aperture('C', [W], fn));
  if (pad.shape === 'rect' && axis) return w.flash(pp.x, pp.y, w.aperture('R', [W, H], fn));
  if (pad.shape === 'oval') {
    if (axis) return w.flash(pp.x, pp.y, w.aperture('O', [W, H], fn));
    const prim = scalePrim(p.prim ?? makePrim([[pp.x, pp.y]], pad.w / 2), [pp.x, pp.y], scale);
    const d = w.aperture('C', [2 * (prim.r + grow)], fn);
    return w.stroke(prim.pts, d);
  }
  if (!p.prim) return;
  const prim = scalePrim(p.prim, [pp.x, pp.y], scale);
  for (const ring of primRegions(prim, grow)) w.region(ring, fn);
}

function scalePrim(p: Prim, c: Vec2, s: number): Prim {
  if (Math.abs(s - 1) < 1e-9) return p;
  return makePrim(
    p.pts.map((q) => [c[0] + (q[0] - c[0]) * s, c[1] + (q[1] - c[1]) * s] as Vec2),
    p.r * s,
  );
}

/** Region contours of a prim inflated by `grow` (exact polygon when no rounding is involved). */
function primRegions(p: Prim, grow: number): Vec2[][] {
  if (p.pts.length >= 3 && p.r + grow <= 1e-9) return [p.pts];
  return primPaths(p, grow).map((q) => fromIPath(q));
}

interface Ctx {
  board: Board;
  pads: PadInfo[];
  stack: CopperLayer[];
  date: string;
}

function copperLayerFile(ctx: Ctx, layer: CopperLayer, index: number): string {
  const { board, stack } = ctx;
  const n = stack.length;
  const pos = index === 0 ? 'Top' : index === n - 1 ? 'Bot' : 'Inr';
  const w = new GerberWriter(`Copper,L${index + 1},${pos}`, 'Positive', ctx.date);
  const bit = layerBit(stack, layer);
  // zone fills first (largest islands first so nested islands are drawn after the holes they sit in)
  const islands = (board.zones ?? [])
    .filter((z) => z.layer === layer && z.fill?.length)
    .flatMap((z) => regionsFromRings(z.fill))
    .sort((a, b) => Math.abs(ringArea(b.rings[0])) - Math.abs(ringArea(a.rings[0])));
  for (const isl of islands) {
    w.setPolarity('D');
    w.region(isl.rings[0], 'Conductor');
    if (isl.rings.length > 1) {
      w.setPolarity('C');
      for (const h of isl.rings.slice(1)) w.region(h);
    }
  }
  w.setPolarity('D');
  for (const t of board.traces ?? []) {
    if (t.layer !== layer || !t.points?.length) continue;
    w.stroke(t.points, w.aperture('C', [t.width], 'Conductor'));
  }
  for (const v of board.vias ?? []) {
    if (!(viaMask(stack, v) & bit)) continue;
    w.flash(v.x, v.y, w.aperture('C', [Math.max(v.diameter, v.drill)], 'ViaPad'));
  }
  for (const p of ctx.pads) {
    if (!p.placed || !p.prim || !(p.layers & bit)) continue;
    emitPad(w, p, 0, 1, p.pad.kind === 'smd' ? 'SMDPad,CuDef' : 'ComponentPad');
  }
  for (const h of board.holes ?? []) {
    const cu = holeCopperPrim(h);
    if (cu) w.flash(h.x, h.y, w.aperture('C', [cu.r * 2], 'ComponentPad'));
  }
  return w.toString();
}

function maskFile(ctx: Ctx, side: 'top' | 'bottom'): string {
  const w = new GerberWriter(`Soldermask,${side === 'top' ? 'Top' : 'Bot'}`, 'Negative', ctx.date);
  for (const p of ctx.pads) {
    if (!p.placed) continue;
    if (p.pad.kind === 'smd' && (p.comp.side === 'bottom' ? 'bottom' : 'top') !== side) continue;
    if (p.prim) emitPad(w, p, MASK_EXPANSION, 1, p.pad.kind === 'smd' ? 'SMDPad,CuDef' : 'ComponentPad');
    else if (p.hole) for (const ring of primRegions(p.hole, MASK_EXPANSION)) w.region(ring, 'ComponentPad');
  }
  for (const h of ctx.board.holes ?? []) {
    const d = Math.max(h.plated ? (h.padDiameter ?? h.drill) : h.drill, h.drill) + 2 * MASK_EXPANSION;
    w.flash(h.x, h.y, w.aperture('C', [d], 'ComponentPad'));
  }
  return w.toString();
}

function pasteFile(ctx: Ctx, side: 'top' | 'bottom'): string {
  const w = new GerberWriter(`Paste,${side === 'top' ? 'Top' : 'Bot'}`, 'Positive', ctx.date);
  for (const p of ctx.pads) {
    if (!p.placed || !p.prim) continue;
    const onSide = p.pad.kind === 'smd' ? (p.comp.side === 'bottom' ? 'bottom' : 'top') === side : true;
    if (!onSide) continue;
    const ratio = p.pad.pasteRatio ?? (p.pad.kind === 'smd' ? 1 : 0);
    if (!(ratio > 0)) continue;
    emitPad(w, p, 0, Math.sqrt(Math.min(1, ratio)), 'SMDPad,CuDef');
  }
  return w.toString();
}

function silkFile(ctx: Ctx, parts: Record<string, PartDef>, side: 'top' | 'bottom'): string {
  const w = new GerberWriter(`Legend,${side === 'top' ? 'Top' : 'Bot'}`, 'Positive', ctx.date);
  const exposed = ctx.pads.filter((p) => p.placed && (p.pad.kind !== 'smd' || (p.comp.side === 'bottom' ? 'bottom' : 'top') === side));
  const keep = new Map<number, ReturnType<typeof silkKeepout>[]>();
  const keepFor = (width: number) => {
    const k = Math.round(width * 1000);
    let list = keep.get(k);
    if (!list) {
      list = exposed.map((p) => silkKeepout((p.prim ?? p.hole)!, MASK_EXPANSION + width / 2 + 0.02));
      keep.set(k, list);
    }
    return list;
  };
  const strokes: SilkStroke[] = [];
  const fills: Vec2[][] = [];
  for (const c of ctx.board.components) {
    const part = parts[c.partId];
    const fp = part?.footprint;
    if (!c.placed || !fp || (c.side === 'bottom' ? 'bottom' : 'top') !== side) continue;
    const art = footprintSilk(c, fp, c.value ?? part?.value);
    strokes.push(...art.strokes);
    fills.push(...art.fills);
    if (!art.hasRefText) strokes.push(...placeRefText(c, fp, keepFor(0.15)));
  }
  const byWidth = new Map<number, SilkStroke[]>();
  for (const s of strokes) {
    const k = Math.round(s.width * 1000);
    const l = byWidth.get(k) ?? [];
    l.push(s);
    byWidth.set(k, l);
  }
  for (const [k, list] of byWidth) {
    const width = k / 1000;
    const d = w.aperture('C', [width]);
    for (const s of clipStrokes(list, keepFor(width))) w.stroke(s.pts, d);
  }
  for (const f of fills) w.region(f);
  return w.toString();
}

function edgeFile(ctx: Ctx): string {
  const w = new GerberWriter('Profile,NP', 'Positive', ctx.date);
  const d = w.aperture('C', [0.1], 'Profile');
  const rings = [ctx.board.outline, ...(ctx.board.cutouts ?? [])].filter((r) => r && r.length >= 2);
  for (const r of rings) w.stroke([...r, r[0]], d);
  return w.toString();
}

interface DrillHit {
  x: number;
  y: number;
  /** slot end point (G85) */
  x2?: number;
  y2?: number;
  d: number;
  fn: string;
}

function drillFile(ctx: Ctx, plated: boolean, hits: DrillHit[]): string {
  const n = ctx.stack.length;
  const tools = new Map<string, { d: number; fn: string; hits: DrillHit[] }>();
  for (const h of hits) {
    const key = `${h.d.toFixed(3)}|${h.fn}`;
    const t = tools.get(key) ?? { d: Math.round(h.d * 1000) / 1000, fn: h.fn, hits: [] };
    t.hits.push(h);
    tools.set(key, t);
  }
  const list = [...tools.values()].sort((a, b) => a.d - b.d || (a.fn < b.fn ? -1 : 1));
  const f = (v: number) => v.toFixed(3);
  const lines = [
    'M48',
    `; DRILL file {PCBCAD @pcbcad/pcb ${VERSION}} date ${ctx.date}`,
    '; FORMAT={-:-/ absolute / metric / decimal}',
    `; #@! TF.CreationDate,${ctx.date}`,
    `; #@! TF.GenerationSoftware,PCBCAD,@pcbcad/pcb,${VERSION}`,
    `; #@! TF.FileFunction,${plated ? 'Plated' : 'NonPlated'},1,${n},${plated ? 'PTH' : 'NPTH'}`,
    'FMAT,2',
    'METRIC',
  ];
  list.forEach((t, i) => {
    lines.push(`; #@! TA.AperFunction,${plated ? 'Plated,PTH' : 'NonPlated,NPTH'},${t.fn}`);
    lines.push(`T${i + 1}C${f(t.d)}`);
  });
  lines.push('%', 'G90', 'G05');
  list.forEach((t, i) => {
    lines.push(`T${i + 1}`);
    const hs = [...t.hits].sort((a, b) => a.x - b.x || a.y - b.y);
    for (const h of hs) {
      if (h.x2 !== undefined && h.y2 !== undefined) lines.push(`X${f(h.x)}Y${f(h.y)}G85X${f(h.x2)}Y${f(h.y2)}`);
      else lines.push(`X${f(h.x)}Y${f(h.y)}`);
    }
  });
  lines.push('M30', '');
  return lines.join('\n');
}

function holeHit(p: Prim, fn: string): DrillHit {
  const d = 2 * p.r;
  if (p.pts.length === 2) return { x: p.pts[0][0], y: p.pts[0][1], x2: p.pts[1][0], y2: p.pts[1][1], d, fn };
  return { x: p.pts[0][0], y: p.pts[0][1], d, fn };
}

/**
 * Export fabrication files for one board: Gerber copper/mask/paste/silk/edge layers and PTH/NPTH
 * Excellon drills. File names follow KiCad conventions (`<base>-F_Cu.gbr`, `<base>-PTH.drl`, ...).
 */
export function exportGerbers(board: Board, parts: Record<string, PartDef>, opts: { projectName?: string } = {}): { files: GerberFile[] } {
  const stack = stackLayers(board);
  const pads = collectPads(board, parts, stack);
  const ctx: Ctx = { board, pads, stack, date: isoNow() };
  const proj = opts.projectName ? slugify(opts.projectName) : '';
  const brd = slugify(board.name || 'board');
  const base = proj && proj !== brd ? `${proj}-${brd}` : brd;
  const files: GerberFile[] = [];
  const layerName = (l: CopperLayer) => (l === 'top' ? 'F_Cu' : l === 'bottom' ? 'B_Cu' : `In${l.slice(2)}_Cu`);
  stack.forEach((l, i) => files.push({ name: `${base}-${layerName(l)}.gbr`, content: copperLayerFile(ctx, l, i) }));
  files.push({ name: `${base}-F_Mask.gbr`, content: maskFile(ctx, 'top') });
  files.push({ name: `${base}-B_Mask.gbr`, content: maskFile(ctx, 'bottom') });
  files.push({ name: `${base}-F_Paste.gbr`, content: pasteFile(ctx, 'top') });
  files.push({ name: `${base}-B_Paste.gbr`, content: pasteFile(ctx, 'bottom') });
  files.push({ name: `${base}-F_Silkscreen.gbr`, content: silkFile(ctx, parts, 'top') });
  files.push({ name: `${base}-B_Silkscreen.gbr`, content: silkFile(ctx, parts, 'bottom') });
  files.push({ name: `${base}-Edge_Cuts.gbr`, content: edgeFile(ctx) });
  const pth: DrillHit[] = [];
  const npth: DrillHit[] = [];
  for (const v of board.vias ?? []) pth.push({ x: v.x, y: v.y, d: v.drill, fn: 'ViaDrill' });
  for (const p of pads) {
    if (!p.placed || !p.hole) continue;
    if (p.pad.kind === 'tht') pth.push(holeHit(p.hole, 'ComponentDrill'));
    else if (p.pad.kind === 'npth') npth.push(holeHit(p.hole, 'ComponentDrill'));
  }
  for (const h of board.holes ?? []) (h.plated ? pth : npth).push({ x: h.x, y: h.y, d: h.drill, fn: 'MechanicalDrill' });
  files.push({ name: `${base}-PTH.drl`, content: drillFile(ctx, true, pth) });
  files.push({ name: `${base}-NPTH.drl`, content: drillFile(ctx, false, npth) });
  return { files };
}
