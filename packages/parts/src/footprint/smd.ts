import type { FootprintDef, PackageSpec, Vec2 } from '@pcbcad/core';
import { CHIP_SIZES } from '../package/defaults';
import { floorTo, rnd } from '../util/num';
import { FootprintBuilder, fmtMm, padBox, type Box } from './builder';
import { FILLETS, ipcLand, range, type Fillets, type Range } from './ipc';

/* --------------------------------------------------------------------------------------------- *
 * SMD footprint families. Every function receives a spec already completed by completeSpec().
 * Orientation conventions (IPC-7351 "level A" zero orientation, Y up):
 *   - 2-terminal parts: pin 1 at −X (cathode / anode+ for polarized parts).
 *   - dual-row ICs: pin 1 top-left, pins counter-clockwise (left column top→bottom, right column
 *     bottom→top); extra.numbering='cw' mirrors this (e.g. Bosch LGA parts).
 *   - quad packages: pin 1 at the top of the left column, counter-clockwise.
 * --------------------------------------------------------------------------------------------- */

function exNum(s: PackageSpec, k: string): number | undefined {
  const v = s.extra?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function exStr(s: PackageSpec, k: string): string | undefined {
  const v = s.extra?.[k];
  return typeof v === 'string' ? v : undefined;
}

function exBool(s: PackageSpec, k: string): boolean | undefined {
  const v = s.extra?.[k];
  return typeof v === 'boolean' ? v : undefined;
}

function isPolarized(s: PackageSpec): boolean {
  return exBool(s, 'polarized') === true;
}

/** Lead width range for gull-wing / no-lead terminals by pitch. */
export function leadWidth(pitch: number): Range {
  if (pitch >= 1.2) return { min: 0.31, max: 0.51 };
  if (pitch >= 0.9) return { min: 0.3, max: 0.5 };
  if (pitch >= 0.75) return { min: 0.3, max: 0.45 };
  if (pitch >= 0.64) return { min: 0.22, max: 0.38 };
  if (pitch >= 0.6) return { min: 0.2, max: 0.3 };
  if (pitch >= 0.49) return { min: 0.17, max: 0.27 };
  if (pitch >= 0.39) return { min: 0.13, max: 0.23 };
  return { min: 0.1, max: 0.2 };
}

/** No-lead (QFN/DFN) terminal width range by pitch. */
function noLeadWidth(pitch: number): Range {
  if (pitch >= 1.2) return { min: 0.35, max: 0.5 };
  if (pitch >= 0.9) return { min: 0.3, max: 0.45 };
  if (pitch >= 0.75) return { min: 0.25, max: 0.4 };
  if (pitch >= 0.64) return { min: 0.25, max: 0.35 };
  if (pitch >= 0.49) return { min: 0.18, max: 0.3 };
  if (pitch >= 0.39) return { min: 0.15, max: 0.25 };
  return { min: 0.12, max: 0.22 };
}

/** Widest land that keeps a copper gap of max(0.15, 0.3·pitch) between neighbours. */
export function maxLandWidth(pitch: number): number {
  return floorTo(pitch - Math.max(0.15, 0.3 * pitch), 0.05);
}

function gullFillets(pitch: number): Fillets {
  return pitch > 0.625 ? FILLETS.gullWing : FILLETS.gullWingFine;
}

/** Positions of a dual-row package: rows at x = ±xc along Y. */
export function dualRow(n: number, pitch: number, xc: number, cw = false): { num: string; x: number; y: number; left: boolean }[] {
  const half = Math.ceil(n / 2);
  const y0 = ((half - 1) / 2) * pitch;
  const out: { num: string; x: number; y: number; left: boolean }[] = [];
  for (let i = 0; i < half; i++) out.push({ num: String(i + 1), x: cw ? xc : -xc, y: rnd(y0 - i * pitch), left: !cw });
  for (let i = 0; i < n - half; i++) out.push({ num: String(half + i + 1), x: cw ? -xc : xc, y: rnd(-y0 + i * pitch), left: cw });
  return out;
}

export interface QuadPos {
  num: string;
  x: number;
  y: number;
  side: 'L' | 'B' | 'R' | 'T';
}

/** Positions of a quad package: ny pins on left/right columns (x = ∓xc), nx on bottom/top rows (y = ∓yc). */
export function quad(nx: number, ny: number, pitch: number, xc: number, yc: number): QuadPos[] {
  const out: QuadPos[] = [];
  let k = 1;
  const yTop = ((ny - 1) / 2) * pitch;
  const xLeft = -((nx - 1) / 2) * pitch;
  for (let i = 0; i < ny; i++) out.push({ num: String(k++), x: -xc, y: rnd(yTop - i * pitch), side: 'L' });
  for (let i = 0; i < nx; i++) out.push({ num: String(k++), x: rnd(xLeft + i * pitch), y: -yc, side: 'B' });
  for (let i = 0; i < ny; i++) out.push({ num: String(k++), x: xc, y: rnd(-yTop + i * pitch), side: 'R' });
  for (let i = 0; i < nx; i++) out.push({ num: String(k++), x: rnd(-xLeft - i * pitch), y: yc, side: 'T' });
  return out;
}

/** Split a quad pin count into (nx per bottom/top row, ny per left/right column) by aspect ratio. */
export function quadSplit(pins: number, w: number, l: number): { nx: number; ny: number } {
  const half = Math.floor(pins / 2);
  if (Math.abs(w - l) < 1e-6) return { nx: Math.floor(pins / 4), ny: Math.ceil(pins / 4) };
  const ny = Math.max(1, Math.min(half - 1, Math.round((half * l) / (w + l))));
  return { nx: half - ny, ny };
}

/** Cathode / polarity bracket around pad 1 (opening toward pad 2). */
function polarityBracket(fp: FootprintBuilder, pad1: Box, pad2: Box): void {
  const g = 0.25;
  const x0 = pad1.minX - g;
  const ytop = Math.max(pad1.maxY, pad2.maxY) + g;
  const ybot = Math.min(pad1.minY, pad2.minY) - g;
  const xe = pad2.minX + (pad2.maxX - pad2.minX) * 0.5;
  fp.line('silk', [xe, ytop], [x0, ytop]);
  fp.line('silk', [x0, ytop], [x0, ybot]);
  fp.line('silk', [x0, ybot], [xe, ybot]);
}

/* ------------------------------------------------------------------------------------ chips */

/** Rectangular chip (resistor / capacitor / inductor / LED / fuse), IPC-7351B Table 3-5/3-6. */
export function chipFootprint(s: PackageSpec): FootprintDef {
  const size = s.size ?? '0805';
  const t = CHIP_SIZES[size] ?? CHIP_SIZES['0805'];
  const halfL = (t.L[1] - t.L[0]) / 2;
  const halfW = (t.W[1] - t.W[0]) / 2;
  const Lnom = s.bodyW ?? (t.L[0] + t.L[1]) / 2;
  const Wnom = s.bodyL ?? (t.W[0] + t.W[1]) / 2;
  const small = ['01005', '0201', '0402'].includes(size);
  const land = ipcLand({ L: range(Lnom, halfL), T: { min: t.T[0], max: t.T[1] }, W: range(Wnom, halfW), fillets: small ? FILLETS.chipSmall : FILLETS.chip });
  const padLen = s.padW ?? land.length;
  const padWid = s.padH ?? land.width;
  const c = exNum(s, 'padCenter') ?? land.center;
  const fp = new FootprintBuilder(`${isPolarized(s) ? 'Chip-Polarized' : 'Chip'}_${size}_${metricCode(size)}Metric`);
  const p1 = fp.smd('1', -c, 0, padLen, padWid);
  const p2 = fp.smd('2', c, 0, padLen, padWid);
  const body = fp.setBody(0, 0, Lnom, Wnom);
  fp.fabBody(body);
  if (isPolarized(s)) {
    const bx = body.minX + Math.min(0.4, Lnom * 0.2);
    fp.line('fab', [bx, body.minY], [bx, body.maxY]);
    polarityBracket(fp, padBox(p1), padBox(p2));
  } else if (!small) {
    fp.silkRect(body);
  }
  return fp.build(s);
}

function metricCode(size: string): string {
  const m: Record<string, string> = { '01005': '0402', '0201': '0603', '0402': '1005', '0603': '1608', '0805': '2012', '1008': '2520', '1206': '3216', '1210': '3225', '1812': '4532', '2010': '5025', '2220': '5750', '2512': '6332' };
  return m[size] ?? size;
}

/* ------------------------------------------------------------------- 2-terminal discretes */

interface TwoTermLeads {
  T: Range;
  W: Range;
  fillets: Fillets;
  minGapFrac?: number;
}

const TWO_TERM: Record<string, TwoTermLeads> = {
  sod123: { T: { min: 0.3, max: 0.6 }, W: { min: 0.5, max: 0.7 }, fillets: FILLETS.gullWing },
  sod323: { T: { min: 0.2, max: 0.45 }, W: { min: 0.25, max: 0.4 }, fillets: FILLETS.gullWing },
  sma: { T: { min: 0.76, max: 1.52 }, W: { min: 1.25, max: 1.65 }, fillets: FILLETS.inwardL, minGapFrac: 0.35 },
  smb: { T: { min: 0.76, max: 1.52 }, W: { min: 1.96, max: 2.21 }, fillets: FILLETS.inwardL, minGapFrac: 0.35 },
  smc: { T: { min: 0.76, max: 1.52 }, W: { min: 2.9, max: 3.2 }, fillets: FILLETS.inwardL, minGapFrac: 0.35 },
};

/** SOD-123 / SOD-323 / SMA / SMB / SMC (pin 1 = cathode at −X). */
export function twoTerminalFootprint(s: PackageSpec): FootprintDef {
  const fam = s.family;
  const leads = TWO_TERM[fam] ?? TWO_TERM.sod123;
  const bodyLen = s.bodyW ?? 2.7;
  const span = s.leadSpan ?? bodyLen + 1;
  const isGull = leads.fillets === FILLETS.gullWing;
  const land = ipcLand({
    L: range(span, 0.15),
    T: leads.T,
    W: leads.W,
    fillets: leads.fillets,
    minGap: isGull ? bodyLen - 0.05 : rnd(bodyLen * (leads.minGapFrac ?? 0.35), 2),
  });
  const padLen = s.padW ?? land.length;
  const padWid = s.padH ?? land.width;
  const c = exNum(s, 'padCenter') ?? land.center;
  const label = fam === 'sod123' ? 'SOD-123' : fam === 'sod323' ? 'SOD-323' : fam.toUpperCase();
  const fp = new FootprintBuilder(`D_${label}`);
  const p1 = fp.smd('1', -c, 0, padLen, padWid);
  const p2 = fp.smd('2', c, 0, padLen, padWid);
  const b = fp.setBody(0, 0, bodyLen, s.bodyL ?? 1.6);
  fp.fabBody(b);
  const bx = b.minX + Math.min(0.6, bodyLen * 0.2);
  fp.line('fab', [bx, b.minY], [bx, b.maxY]);
  polarityBracket(fp, padBox(p1), padBox(p2));
  return fp.build(s);
}

/** MELF / MiniMELF (cylindrical); pads from typical manufacturer recommendations. */
export function melfFootprint(s: PackageSpec): FootprintDef {
  const big = (s.bodyW ?? 3.5) > 4.2;
  const padLen = s.padW ?? (big ? 1.3 : 1.0);
  const padWid = s.padH ?? (big ? 2.6 : 1.6);
  const c = exNum(s, 'padCenter') ?? (big ? 2.45 : 1.7);
  const fp = new FootprintBuilder(big ? 'D_MELF' : 'D_MiniMELF');
  const p1 = fp.smd('1', -c, 0, padLen, padWid);
  const p2 = fp.smd('2', c, 0, padLen, padWid);
  const b = fp.setBody(0, 0, s.bodyW ?? 3.5, s.bodyL ?? 1.5);
  fp.fabBody(b);
  if (isPolarized(s)) polarityBracket(fp, padBox(p1), padBox(p2));
  else fp.silkRect(b);
  return fp.build(s);
}

/* --------------------------------------------------------------------------- gull-wing ICs */

/** Generic dual-row gull-wing land pattern (SOT-23, SOIC, SSOP, TSSOP, MSOP). */
function gullLand(s: PackageSpec, T: Range, spanTol = 0.2) {
  const pitch = s.pitch ?? 1.27;
  // JEDEC MO-153 (TSSOP) leads are narrower than MO-150/MO-187 at the same pitch
  const W = s.family === 'tssop' && pitch > 0.6 ? { min: 0.19, max: 0.3 } : leadWidth(pitch);
  return ipcLand({
    L: range(s.leadSpan ?? (s.bodyW ?? 3.9) + 2, spanTol),
    T,
    W,
    fillets: gullFillets(pitch),
    minGap: (s.bodyW ?? 3.9) - 0.05,
  });
}

/** SOT-23 / SOT-23-5 / SOT-23-6 / SOT-23-8 / SC-70 family. */
export function sot23Footprint(s: PackageSpec): FootprintDef {
  const pins = s.pins ?? 3;
  const pitch = s.pitch ?? 0.95;
  const sc70 = s.extra?.variant === 'sc70';
  const land = gullLand(s, sc70 ? { min: 0.26, max: 0.46 } : { min: 0.3, max: 0.6 }, 0.2);
  const len = s.padW ?? land.length;
  const wid = s.padH ?? Math.min(land.width, maxLandWidth(pitch));
  const c = exNum(s, 'padCenter') ?? land.center;
  const fp = new FootprintBuilder(`${sc70 ? 'SC-70' : 'SOT-23'}${pins === 3 ? '' : `-${pins}`}`);
  let pos: { num: string; x: number; y: number }[];
  if (pins === 3) {
    pos = [
      { num: '1', x: -c, y: pitch },
      { num: '2', x: -c, y: -pitch },
      { num: '3', x: c, y: 0 },
    ];
  } else if (pins === 5) {
    pos = [
      { num: '1', x: -c, y: pitch },
      { num: '2', x: -c, y: 0 },
      { num: '3', x: -c, y: -pitch },
      { num: '4', x: c, y: -pitch },
      { num: '5', x: c, y: pitch },
    ];
  } else {
    pos = dualRow(pins, pitch, c);
  }
  for (const p of pos) fp.smd(p.num, p.x, p.y, len, wid);
  const b = fp.setBody(0, 0, s.bodyW ?? 1.3, s.bodyL ?? 2.9);
  fp.fabBody(b, 'tl');
  fp.silkRect(b);
  const p1 = pos[0];
  fp.pin1Dot([
    [p1.x - len / 2 - 0.35, p1.y + wid / 2 + 0.35],
    [p1.x, p1.y + wid / 2 + 0.4],
    [b.minX - 0.3, b.maxY + 0.3],
  ]);
  return fp.build(s);
}

/** SOT-223 (pins 1..n−1 on the left, wide tab = pin n on the right). */
export function sot223Footprint(s: PackageSpec): FootprintDef {
  const pins = s.pins ?? 4;
  const pitch = s.pitch ?? 2.3;
  const land = ipcLand({ L: range(s.leadSpan ?? 7.0, 0.3), T: { min: 0.75, max: 1.1 }, W: { min: 0.6, max: 0.84 }, fillets: FILLETS.gullWing, minGap: (s.bodyW ?? 3.5) - 0.05 });
  const tabW = ipcLand({ L: range(s.leadSpan ?? 7.0, 0.3), T: { min: 0.75, max: 1.1 }, W: { min: 2.9, max: 3.1 }, fillets: FILLETS.gullWing, minGap: (s.bodyW ?? 3.5) - 0.05 }).width;
  const fp = new FootprintBuilder(`SOT-223${pins === 4 ? '-3_TabPin4' : `-${pins - 1}`}`);
  const n = pins - 1;
  const y0 = ((n - 1) / 2) * pitch;
  for (let i = 0; i < n; i++) fp.smd(String(i + 1), -land.center, y0 - i * pitch, land.length, land.width);
  fp.smd(String(pins), land.center, 0, land.length, tabW);
  const b = fp.setBody(0, 0, s.bodyW ?? 3.5, s.bodyL ?? 6.5);
  fp.fabBody(b, 'tl');
  fp.silkRect(b);
  fp.pin1Dot([[-land.center - land.length / 2 - 0.35, y0 + land.width / 2 + 0.4]]);
  return fp.build(s);
}

/** SOT-89-3: pins 1–3 on the left column, pin-2 tab under the body (typical vendor land pattern). */
export function sot89Footprint(s: PackageSpec): FootprintDef {
  const pitch = s.pitch ?? 1.5;
  const fp = new FootprintBuilder('SOT-89-3');
  const x = -1.75;
  fp.smd('1', x, pitch, 1.3, 0.9);
  fp.smd('2', x, 0, 1.3, 0.9);
  fp.smd('3', x, -pitch, 1.3, 0.9);
  fp.smd('2', 0.35, 0, 2.6, 1.9, { shape: 'rect' });
  const b = fp.setBody(0, 0, s.bodyW ?? 2.5, s.bodyL ?? 4.5);
  fp.fabBody(b, 'tl');
  fp.silkRect(b);
  fp.pin1Dot([[x - 0.65 - 0.35, pitch + 0.45 + 0.35]]);
  return fp.build(s);
}

/** TO-252 (DPAK) / TO-263 (D²PAK): leads on the left, heat-sink tab on the right. */
export function to252Footprint(s: PackageSpec): FootprintDef {
  const d2 = s.extra?.variant === 'd2pak';
  const leads = exNum(s, 'leads') ?? 2;
  const pitch = s.pitch ?? (d2 ? 2.54 : 2.28);
  const span = s.leadSpan ?? (d2 ? 15.3 : 9.9);
  const fp = new FootprintBuilder(d2 ? `TO-263-${leads === 2 ? 2 : leads}` : `TO-252-${leads === 2 ? 2 : leads}`);
  const leadLen = d2 ? 3.6 : 2.2;
  const leadWid = d2 ? 1.1 : 1.2;
  const xl = -span / 2 + leadLen / 2 - 0.1;
  const tabW = d2 ? 9.5 : 6.0;
  const tabL = d2 ? 10.8 : 5.8;
  const xt = span / 2 - tabW / 2 + 0.3;
  if (leads === 2) {
    fp.smd('1', xl, pitch, leadLen, leadWid);
    fp.smd('3', xl, -pitch, leadLen, leadWid);
    fp.smd('2', xt, 0, tabW, tabL, { shape: 'rect' });
  } else {
    const n = leads;
    const p = n >= 5 ? (d2 ? 1.7 : 1.14) : pitch;
    const y0 = ((n - 1) / 2) * p;
    for (let i = 0; i < n; i++) fp.smd(String(i + 1), xl, y0 - i * p, leadLen, Math.min(leadWid, p * 0.6));
    fp.smd(String(Math.ceil(n / 2)), xt, 0, tabW, tabL, { shape: 'rect' });
  }
  const b = fp.setBody(span / 2 - (s.bodyW ?? 6.1) / 2 - (d2 ? 0.6 : 0.5), 0, s.bodyW ?? 6.1, s.bodyL ?? 6.6);
  fp.fabBody(b, 'tl');
  fp.silkRect(b);
  fp.pin1Dot([[xl - leadLen / 2 - 0.4, pitch + leadWid / 2 + 0.4]]);
  return fp.build(s);
}

/** SOIC / SOP / SSOP / TSSOP / MSOP (dual-row gull-wing), optional exposed pad. */
export function dualGullFootprint(s: PackageSpec): FootprintDef {
  const pins = s.pins ?? 8;
  const pitch = s.pitch ?? 1.27;
  const T: Range = s.family === 'soic' ? { min: 0.4, max: 1.27 } : s.family === 'msop' ? { min: 0.4, max: 0.7 } : s.family === 'ssop' ? { min: 0.55, max: 0.95 } : { min: 0.45, max: 0.75 };
  const land = gullLand(s, T, s.family === 'msop' ? 0.15 : 0.2);
  const len = s.padW ?? land.length;
  const wid = s.padH ?? Math.min(land.width, maxLandWidth(pitch));
  const c = exNum(s, 'padCenter') ?? land.center;
  const label = s.family.toUpperCase();
  const ep = s.exposedPad;
  const name = `${label}-${pins}${ep ? '-1EP' : ''}_${fmtMm(s.bodyW ?? 3.9)}x${fmtMm(s.bodyL ?? 4.9)}mm_P${fmtMm(pitch)}mm${ep ? `_EP${fmtMm(ep.w)}x${fmtMm(ep.h)}mm` : ''}`;
  const fp = new FootprintBuilder(name);
  const cw = exStr(s, 'numbering') === 'cw';
  const pos = dualRow(pins, pitch, c, cw);
  for (const p of pos) fp.smd(p.num, p.x, p.y, len, wid);
  if (ep) fp.smd(String(pins + 1), 0, 0, Math.min(ep.w, 2 * c - len - 0.4), ep.h, { shape: 'rect', pasteRatio: 0.65 });
  const b = fp.setBody(0, 0, s.bodyW ?? 3.9, s.bodyL ?? 4.9);
  fp.fabBody(b, cw ? 'tr' : 'tl');
  fp.silkRect(b);
  const p1 = pos[0];
  const sx = p1.x < 0 ? -1 : 1;
  // classic SOIC marker: short line extending outward from pin 1 along the silk edge, plus a dot
  fp.pin1Dot([
    [p1.x + sx * (len / 2 + 0.35), p1.y + wid / 2 + 0.3],
    [p1.x, p1.y + wid / 2 + 0.45],
  ]);
  return fp.build(s);
}

/** LQFP / TQFP (quad gull-wing). */
export function qfpFootprint(s: PackageSpec): FootprintDef {
  const pins = s.pins ?? 32;
  const pitch = s.pitch ?? 0.8;
  const bw = s.bodyW ?? 7;
  const bl = s.bodyL ?? bw;
  const { nx, ny } = quadSplit(pins, bw, bl);
  const W = leadWidth(pitch);
  const fil = gullFillets(pitch);
  const T = { min: 0.45, max: 0.75 };
  const spanX = s.leadSpan ?? bw + 2;
  const spanY = exNum(s, 'leadSpanY') ?? bl + (spanX - bw);
  const lx = ipcLand({ L: range(spanX, 0.2), T, W, fillets: fil, minGap: bw - 0.05 });
  const ly = ipcLand({ L: range(spanY, 0.2), T, W, fillets: fil, minGap: bl - 0.05 });
  const len = s.padW ?? lx.length;
  const wid = s.padH ?? Math.min(lx.width, maxLandWidth(pitch));
  const variant = s.extra?.variant === 'tqfp' ? 'TQFP' : 'LQFP';
  const fp = new FootprintBuilder(`${variant}-${pins}_${fmtMm(bw)}x${fmtMm(bl)}mm_P${fmtMm(pitch)}mm`);
  const pos = quad(nx, ny, pitch, lx.center, ly.center);
  for (const p of pos) {
    if (p.side === 'L' || p.side === 'R') fp.smd(p.num, p.x, p.y, len, wid);
    else fp.smd(p.num, p.x, p.y, wid, s.padW ?? ly.length);
  }
  if (s.exposedPad) fp.smd(String(pins + 1), 0, 0, s.exposedPad.w, s.exposedPad.h, { shape: 'rect', pasteRatio: 0.65 });
  const b = fp.setBody(0, 0, bw, bl);
  fp.fabBody(b, 'tl');
  fp.silkRect(b);
  const p1 = pos[0];
  fp.pin1Dot([
    [p1.x - len / 2 - 0.35, p1.y + wid / 2 + 0.35],
    [p1.x - len / 2 + 0.1, b.maxY + 0.35],
  ]);
  return fp.build(s);
}

/* --------------------------------------------------------------------------- no-lead / LGA */

/** QFN (quad) or DFN/SON (dual) bottom-termination packages, IPC-7351B Table 3-15/3-16. */
export function noLeadFootprint(s: PackageSpec): FootprintDef {
  const dual = s.family === 'dfn';
  const pins = s.pins ?? (dual ? 8 : 32);
  const pitch = s.pitch ?? 0.5;
  const bw = s.bodyW ?? 3;
  const bl = s.bodyL ?? bw;
  const T: Range = Math.min(bw, bl) <= 2.1 ? { min: 0.2, max: 0.4 } : { min: 0.3, max: 0.5 };
  const W = noLeadWidth(pitch);
  const split = dual ? { nx: 0, ny: Math.ceil(pins / 2) } : quadSplit(pins, bw, bl);
  const { nx, ny } = split;
  const Xw = ipcLand({ L: range(bw, 0.1), T, W, fillets: FILLETS.noLead }).width;
  // corner clearance between adjacent sides (≥ 0.15 mm per side of the corner)
  const gxMin = dual ? 0 : (nx - 1) * pitch + Xw + 0.3;
  const gyMin = (ny - 1) * pitch + Xw + 0.3;
  const lx = ipcLand({ L: range(bw, 0.1), T, W, fillets: FILLETS.noLead, minGap: gxMin });
  const ly = ipcLand({ L: range(bl, 0.1), T, W, fillets: FILLETS.noLead, minGap: dual ? undefined : gyMin });
  const len = s.padW ?? lx.length;
  const wid = s.padH ?? Math.min(lx.width, maxLandWidth(pitch));
  const ep = s.exposedPad;
  const kind = dual ? 'DFN' : 'QFN';
  const fp = new FootprintBuilder(`${kind}-${pins}${ep ? '-1EP' : ''}_${fmtMm(bw)}x${fmtMm(bl)}mm_P${fmtMm(pitch)}mm${ep ? `_EP${fmtMm(ep.w)}x${fmtMm(ep.h)}mm` : ''}`);
  let pos: { num: string; x: number; y: number; vertical: boolean }[];
  const cw = exStr(s, 'numbering') === 'cw';
  if (dual) pos = dualRow(pins, pitch, lx.center, cw).map((p) => ({ ...p, vertical: false }));
  else pos = quad(nx, ny, pitch, lx.center, ly.center).map((p) => ({ num: p.num, x: p.x, y: p.y, vertical: p.side === 'B' || p.side === 'T' }));
  for (const p of pos) {
    if (p.vertical) fp.smd(p.num, p.x, p.y, wid, s.padW ?? ly.length);
    else fp.smd(p.num, p.x, p.y, len, wid);
  }
  if (ep) {
    const innerX = 2 * lx.center - len;
    const innerY = dual ? bl : 2 * ly.center - ly.length;
    const ew = rnd(Math.min(ep.w, innerX - 0.4), 3);
    const eh = rnd(Math.min(ep.h, dual ? ep.h : innerY - 0.4), 3);
    if (ew > 0.2 && eh > 0.2) fp.smd(String(pins + 1), 0, 0, ew, eh, { shape: 'rect', pasteRatio: 0.65 });
  }
  const b = fp.setBody(0, 0, bw, bl);
  fp.fabBody(b, cw ? 'tr' : 'tl');
  fp.silkRect(b);
  const corner: Vec2 = cw ? [b.maxX + 0.35, b.maxY + 0.35] : [b.minX - 0.35, b.maxY + 0.35];
  fp.pin1Dot([corner, [pos[0].x - (cw ? -1 : 1) * (len / 2 + 0.3), pos[0].y + wid / 2 + 0.35]]);
  return fp.build(s);
}

/** LGA: lands under the body (2 or 4 sides). Overrides: padW (land length, X), padH (land width, Y), extra.padCenter (|x| of the land centres). */
export function lgaFootprint(s: PackageSpec): FootprintDef {
  const pins = s.pins ?? 8;
  const pitch = s.pitch ?? 0.65;
  const bw = s.bodyW ?? 2.5;
  const bl = s.bodyL ?? bw;
  const sides = exNum(s, 'sides') ?? (pins <= 10 ? 2 : 4);
  const term = rnd(Math.min(0.5, Math.max(0.25, 0.18 * Math.min(bw, bl))), 3);
  const landLen = s.padW ?? rnd(term + 0.1, 3);
  const landWid = s.padH ?? rnd(Math.max(0.2, Math.min(0.55 * pitch, pitch - 0.2)), 3);
  const cx = exNum(s, 'padCenter') ?? rnd(bw / 2 - term / 2 + 0.025, 4);
  const cy = exNum(s, 'padCenterY') ?? rnd(bl / 2 - term / 2 + 0.025, 4);
  const cw = exStr(s, 'numbering') === 'cw';
  const fp = new FootprintBuilder(`LGA-${pins}_${fmtMm(bw)}x${fmtMm(bl)}mm_P${fmtMm(pitch)}mm`);
  if (sides === 2) {
    for (const p of dualRow(pins, pitch, cx, cw)) fp.smd(p.num, p.x, p.y, landLen, landWid);
  } else {
    const { nx, ny } = quadSplit(pins, bw, bl);
    for (const p of quad(nx, ny, pitch, cx, cy)) {
      if (p.side === 'L' || p.side === 'R') fp.smd(p.num, p.x, p.y, landLen, landWid);
      else fp.smd(p.num, p.x, p.y, landWid, landLen);
    }
  }
  if (s.exposedPad) fp.smd(String(pins + 1), 0, 0, s.exposedPad.w, s.exposedPad.h, { shape: 'rect', pasteRatio: 0.65 });
  const b = fp.setBody(0, 0, bw, bl);
  fp.fabBody(b, cw ? 'tr' : 'tl');
  fp.silkRect(b);
  fp.pin1Dot([cw ? [b.maxX + 0.35, b.maxY + 0.35] : [b.minX - 0.35, b.maxY + 0.35]]);
  return fp.build(s);
}

/** BGA / WLCSP: NSMD circular lands (≈ 0.8 × ball, ball ≈ 0.6 × pitch). Ball A1 top-left. */
export function bgaFootprint(s: PackageSpec): FootprintDef {
  const pins = s.pins ?? 64;
  const pitch = s.pitch ?? 0.8;
  const cols = exNum(s, 'cols') ?? Math.ceil(Math.sqrt(pins));
  const rows = exNum(s, 'rows') ?? Math.ceil(pins / cols);
  const ball = exNum(s, 'ballDiameter') ?? rnd(0.6 * pitch, 3);
  const land = s.padW ?? rnd(Math.max(0.15, 0.8 * ball), 3);
  const bw = s.bodyW ?? (cols + 1) * pitch;
  const bl = s.bodyL ?? (rows + 1) * pitch;
  const fp = new FootprintBuilder(`BGA-${pins}_${cols}x${rows}_${fmtMm(bw)}x${fmtMm(bl)}mm_Layout${cols}x${rows}_P${fmtMm(pitch)}mm`);
  const letters = bgaRowLetters(rows);
  let k = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (k++ >= pins) break;
      const x = (c - (cols - 1) / 2) * pitch;
      const y = ((rows - 1) / 2 - r) * pitch;
      fp.smd(`${letters[r]}${c + 1}`, x, y, land, land, { shape: 'circle' });
    }
  }
  const b = fp.setBody(0, 0, bw, bl);
  fp.fabBody(b, 'tl');
  fp.silkRect(b);
  fp.pin1Dot([[b.minX - 0.35, b.maxY + 0.35]]);
  return fp.build(s);
}

/** JEDEC BGA row letters (I, O, Q, S, X, Z skipped; AA, AB… after Y). */
export function bgaRowLetters(n: number): string[] {
  const alpha = 'ABCDEFGHJKLMNPRTUVWY';
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(i < alpha.length ? alpha[i] : alpha[Math.floor(i / alpha.length) - 1] + alpha[i % alpha.length]);
  }
  return out;
}
