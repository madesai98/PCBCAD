import type { FootprintDef, PackageSpec, Vec2 } from '@pcbcad/core';
import { rnd } from '../util/num';
import { FootprintBuilder, fmtMm, SILK_W } from './builder';

/* --------------------------------------------------------------------------------------------- *
 * Through-hole families. Drill / pad sizes follow IPC-2222 level B practice (hole ≈ lead + 0.25,
 * annular ring ≥ 0.3) and the manufacturers' recommended PCB layouts for the connector series.
 * Pin 1 is square / rounded-rectangle; pins run along +X unless stated otherwise.
 * --------------------------------------------------------------------------------------------- */

function exStr(s: PackageSpec, k: string): string | undefined {
  const v = s.extra?.[k];
  return typeof v === 'string' ? v : undefined;
}

function exNum(s: PackageSpec, k: string): number | undefined {
  const v = s.extra?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function exBool(s: PackageSpec, k: string): boolean | undefined {
  const v = s.extra?.[k];
  return typeof v === 'boolean' ? v : undefined;
}

/** Drill and pad diameter for a pin pitch (square-pin headers & similar). */
function holeForPitch(pitch: number): { drill: number; pad: number } {
  if (pitch >= 2.5) return { drill: 1.0, pad: 1.7 };
  if (pitch >= 1.95) return { drill: 0.8, pad: 1.35 };
  if (pitch >= 1.25) return { drill: 0.65, pad: 1.0 };
  return { drill: 0.5, pad: 0.8 };
}

/** DIP (300 / 600 mil). */
export function dipFootprint(s: PackageSpec): FootprintDef {
  const pins = s.pins ?? 8;
  const pitch = s.pitch ?? 2.54;
  const row = exNum(s, 'rowSpacing') ?? 7.62;
  const fp = new FootprintBuilder(`DIP-${pins}_W${fmtMm(row)}mm`);
  const half = pins / 2;
  const y0 = ((half - 1) / 2) * pitch;
  for (let i = 0; i < half; i++) fp.tht(String(i + 1), -row / 2, y0 - i * pitch, 1.6, 0.8, i === 0 ? 'rect' : 'circle');
  for (let i = 0; i < half; i++) fp.tht(String(half + i + 1), row / 2, -y0 + i * pitch, 1.6, 0.8, 'circle');
  const b = fp.setBody(0, 0, s.bodyW ?? 6.35, s.bodyL ?? half * pitch + 0.4);
  fp.fabBody(b, 'tl');
  // silk outline with pin-1 notch (arc) at the top edge
  const x0 = b.minX - 0.1;
  const x1 = b.maxX + 0.1;
  const y1 = b.maxY + 0.1;
  const yb = b.minY - 0.1;
  const r = 0.8;
  fp.silkPath([
    [-r, y1],
    [x0, y1],
    [x0, yb],
    [x1, yb],
    [x1, y1],
    [r, y1],
  ]);
  fp.arc('silk', [0, y1], r, 180, 360);
  return fp.build(s);
}

/** TO-92 (inline, flat face toward −Y). */
export function to92Footprint(s: PackageSpec): FootprintDef {
  const pins = s.pins ?? 3;
  const pitch = s.pitch ?? 1.27;
  const fp = new FootprintBuilder(`TO-92${pins === 2 ? '-2' : ''}_Inline`);
  const x0 = -((pins - 1) / 2) * pitch;
  const narrow = pitch < 2;
  for (let i = 0; i < pins; i++) fp.tht(String(i + 1), x0 + i * pitch, 0, narrow ? 1.05 : 1.5, 0.75, i === 0 ? 'rect' : 'oval', 1.5);
  const d = s.bodyW ?? 4.6;
  const rr = d / 2;
  const flat = -(s.bodyL ?? 3.6) + rr;
  fp.setBody(0, (flat + rr) / 2, d, rr - flat);
  fp.line('fab', [-Math.sqrt(Math.max(0, rr * rr - flat * flat)), flat], [Math.sqrt(Math.max(0, rr * rr - flat * flat)), flat]);
  const a0 = (Math.asin(Math.max(-1, Math.min(1, flat / rr))) * 180) / Math.PI;
  fp.arc('fab', [0, 0], rr, a0, 180 - a0);
  fp.arc('silk', [0, 0], rr + 0.15, a0 + 8, 180 - a0 - 8);
  fp.silkLine([-rr, flat - 0.15], [rr, flat - 0.15]);
  return fp.build(s);
}

/** TO-220 (vertical: pins inline along X, tab at +Y; horizontal: body lies toward +Y). */
export function to220Footprint(s: PackageSpec): FootprintDef {
  const pins = s.pins ?? 3;
  const pitch = s.pitch ?? 2.54;
  const horiz = s.orientation === 'horizontal';
  const fp = new FootprintBuilder(`TO-220-${pins}_${horiz ? 'Horizontal' : 'Vertical'}`);
  const x0 = -((pins - 1) / 2) * pitch;
  const padW = pitch >= 2.5 ? 1.9 : 1.5;
  for (let i = 0; i < pins; i++) fp.tht(String(i + 1), x0 + i * pitch, 0, padW, pitch >= 2.5 ? 1.2 : 1.0, i === 0 ? 'roundrect' : 'oval', 2.4);
  const w = s.bodyW ?? 10.1;
  if (horiz) {
    const b = fp.setBody(0, 2.5 + 15.5 / 2, w, 15.5);
    fp.fabBody(b);
    fp.silkRect(b);
    fp.circle('fab', [0, b.maxY - 2.8], 1.8);
  } else {
    const t = s.bodyL ?? 4.5;
    const b = fp.setBody(0, t / 2 - 1.8, w, t);
    fp.fabBody(b);
    fp.silkRect(b);
    fp.line('fab', [b.minX, b.maxY - 1.3], [b.maxX, b.maxY - 1.3]);
  }
  return fp.build(s);
}

/**
 * Pin headers / sockets: `rows` × ceil(pins/rows); odd/even zig-zag numbering for 2 rows
 * (pin 1 top-left, pin 2 below it). Right-angle bodies extend toward −Y.
 */
export function headerFootprint(s: PackageSpec): FootprintDef {
  const pitch = s.pitch ?? 2.54;
  const rows = s.rows ?? 1;
  const pins = s.pins ?? 4;
  const cols = Math.ceil(pins / rows);
  const ra = s.orientation === 'right-angle' || s.orientation === 'horizontal';
  const female = exStr(s, 'gender') === 'female';
  const { drill, pad } = holeForPitch(pitch);
  const fp = new FootprintBuilder(`${female ? 'PinSocket' : 'PinHeader'}_${rows}x${String(cols).padStart(2, '0')}_P${fmtMm(pitch, true)}mm_${ra ? 'Horizontal' : 'Vertical'}`);
  fp.courtyardMargin = 0.5;
  const x0 = -((cols - 1) / 2) * pitch;
  const yTop = ((rows - 1) / 2) * pitch;
  let k = 1;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      if (k > pins) break;
      fp.tht(String(k), x0 + c * pitch, yTop - r * pitch, pad, drill, k === 1 ? 'rect' : 'circle');
      k++;
    }
  }
  const w = cols * pitch;
  if (ra) {
    const yLow = -yTop;
    const depth = female ? 8.5 : 2.5;
    const b = fp.setBody(0, yLow - pitch / 2 - 1.0 - depth / 2, w, depth);
    fp.fabBody(b);
    fp.silkRect(b);
    if (!female) fp.include(0, b.minY - 6.0);
  } else {
    const b = fp.setBody(0, 0, w, rows * pitch);
    fp.fabBody(b, 'tl');
    fp.silkRect(b);
  }
  // pin-1 marker: L-shaped silk corner just outside pin 1
  const p1: Vec2 = [x0, yTop];
  const e = pitch / 2 + 0.25;
  fp.line('silk', [p1[0] - e, p1[1]], [p1[0] - e, p1[1] + e]);
  fp.line('silk', [p1[0] - e, p1[1] + e], [p1[0], p1[1] + e]);
  return fp.build(s);
}

/** JST PH (2.0) / XH (2.5) through-hole headers, top or side entry; SMD side-entry variants. */
export function jstThtFootprint(s: PackageSpec): FootprintDef {
  const xh = s.family === 'jst-xh';
  const pins = s.pins ?? 2;
  const pitch = s.pitch ?? (xh ? 2.5 : 2.0);
  const side = s.orientation === 'right-angle' || s.orientation === 'horizontal';
  const smd = exBool(s, 'smd') === true;
  if (smd) return jstSmdSide(s, xh ? 'XH' : 'PH');
  const series = xh ? 'XH' : 'PH';
  const mpn = `${side ? 'S' : 'B'}${pins}B-${series}-${xh ? 'A' : 'K'}`;
  const fp = new FootprintBuilder(`JST_${series}_${mpn}_1x${String(pins).padStart(2, '0')}_P${fmtMm(pitch, true)}mm_${side ? 'Horizontal' : 'Vertical'}`);
  fp.courtyardMargin = 0.5;
  const x0 = -((pins - 1) / 2) * pitch;
  const padW = xh ? 1.7 : 1.2;
  const padH = xh ? 2.0 : 1.75;
  const drill = xh ? 0.95 : 0.75;
  for (let i = 0; i < pins; i++) fp.tht(String(i + 1), x0 + i * pitch, 0, padW, drill, i === 0 ? 'roundrect' : 'oval', padH);
  const w = s.bodyW ?? (pins - 1) * pitch + (xh ? 4.9 : 3.9);
  let b: ReturnType<FootprintBuilder['setBody']>;
  if (side) {
    // side entry: housing extends toward −Y (mating face at the −Y edge)
    const depth = s.bodyL ?? (xh ? 9.8 : 7.6);
    b = fp.setBody(0, 1.6 - depth / 2, w, depth);
  } else {
    // top entry: KiCad / JST drawing — housing from −2.8 (latch side) to +1.7 (PH); −3.4 … +2.35 (XH)
    const lo = xh ? -3.4 : -2.8;
    const hi = xh ? 2.35 : 1.7;
    b = fp.setBody(0, (lo + hi) / 2, w, hi - lo);
  }
  fp.fabBody(b, 'tl');
  fp.silkRect(b);
  fp.pin1Dot([
    [x0, b.maxY + 0.45],
    [x0 - padW / 2 - 0.45, 0],
  ]);
  return fp.build(s);
}

/** JST PH/XH SMD side-entry (S..B-PH-SM4-TB style): signal pads at +Y, mounting tabs at −Y. */
function jstSmdSide(s: PackageSpec, series: 'PH' | 'XH'): FootprintDef {
  const pins = s.pins ?? 2;
  const pitch = s.pitch ?? 2.0;
  const fp = new FootprintBuilder(`JST_${series}_S${pins}B-${series}-SM4-TB_1x${String(pins).padStart(2, '0')}-1MP_P${fmtMm(pitch, true)}mm_Horizontal`);
  fp.courtyardMargin = 0.5;
  const x0 = -((pins - 1) / 2) * pitch;
  for (let i = 0; i < pins; i++) fp.smd(String(i + 1), x0 + i * pitch, 2.75, 1.0, 3.5);
  const mx = -x0 + 2.35;
  fp.smd('MP', -mx, -2.9, 1.6, 3.0);
  fp.smd('MP', mx, -2.9, 1.6, 3.0);
  const w = s.bodyW ?? (pins - 1) * pitch + 3.9;
  const b = fp.setBody(0, -1.0, w, s.bodyL ?? 7.5);
  fp.fabBody(b, 'tl');
  fp.silkRect(b);
  fp.pin1Dot([[x0 - 0.9, 4.2]]);
  return fp.build(s);
}

/** JST SH (1.0 mm) SMD, side entry (SMxxB-SRSS-TB) or top entry (BMxxB-SRSS-TB). */
export function jstShFootprint(s: PackageSpec): FootprintDef {
  const pins = s.pins ?? 4;
  const pitch = s.pitch ?? 1.0;
  const top = s.orientation === 'vertical';
  const series = exStr(s, 'series') ?? 'SH';
  const fp = new FootprintBuilder(`JST_${series}_${top ? 'BM' : 'SM'}${String(pins).padStart(2, '0')}B-${series === 'SH' ? 'SRSS' : 'GHS'}-TB_1x${String(pins).padStart(2, '0')}-1MP_P${fmtMm(pitch, true)}mm_${top ? 'Vertical' : 'Horizontal'}`);
  fp.courtyardMargin = 0.5;
  const x0 = -((pins - 1) / 2) * pitch;
  const sigY = top ? 1.775 : 1.9;
  for (let i = 0; i < pins; i++) fp.smd(String(i + 1), x0 + i * pitch, sigY, 0.6, 1.55);
  const mx = -x0 + 1.3;
  const my = top ? -1.2 : -1.9;
  fp.smd('MP', -mx, my, 1.2, 1.8);
  fp.smd('MP', mx, my, 1.2, 1.8);
  const w = s.bodyW ?? (pins - 1) * pitch + 3.0;
  const depth = s.bodyL ?? 4.25;
  const b = fp.setBody(0, top ? 0.1 : -0.35, w, depth);
  fp.fabBody(b, 'tl');
  fp.silkRect(b);
  fp.pin1Dot([[x0 - 0.75, sigY + 0.5]]);
  return fp.build(s);
}

/** Screw / pluggable terminal blocks (wire entry toward −Y). */
export function terminalBlockFootprint(s: PackageSpec): FootprintDef {
  const pins = s.pins ?? 2;
  const pitch = s.pitch ?? 5.08;
  const fp = new FootprintBuilder(`TerminalBlock_1x${String(pins).padStart(2, '0')}_P${fmtMm(pitch, true)}mm`);
  fp.courtyardMargin = 0.5;
  const drill = pitch >= 4.9 ? 1.3 : pitch >= 3.4 ? 1.2 : 1.0;
  const pad = pitch >= 4.9 ? 2.6 : pitch >= 3.4 ? 2.1 : 1.7;
  const x0 = -((pins - 1) / 2) * pitch;
  for (let i = 0; i < pins; i++) fp.tht(String(i + 1), x0 + i * pitch, 0, pad, drill, i === 0 ? 'rect' : 'circle');
  const depth = s.bodyL ?? (pitch < 4 ? 7.0 : 8.0);
  const b = fp.setBody(0, -depth / 2 + depth * 0.42, s.bodyW ?? pins * pitch, depth);
  fp.fabBody(b, 'tl');
  fp.silkRect(b);
  return fp.build(s);
}

/** HC-49/S and HC-49/U crystals (4.88 mm lead spacing). */
export function hc49Footprint(s: PackageSpec): FootprintDef {
  const pitch = s.pitch ?? 4.88;
  const fp = new FootprintBuilder(`Crystal_HC49-${s.extra?.variant === 'hc49u' ? 'U' : '4H'}_Vertical`);
  fp.tht('1', -pitch / 2, 0, 1.5, 0.8, 'circle');
  fp.tht('2', pitch / 2, 0, 1.5, 0.8, 'circle');
  const w = s.bodyW ?? 11.05;
  const l = s.bodyL ?? 4.65;
  fp.setBody(0, 0, w, l);
  const r = l / 2;
  const xs = w / 2 - r;
  for (const [layer, grow] of [
    ['fab', 0],
    ['silk', SILK_W / 2 + 0.1],
  ] as const) {
    const rr = r + grow;
    fp.line(layer, [-xs, rr], [xs, rr]);
    fp.line(layer, [-xs, -rr], [xs, -rr]);
    fp.arc(layer, [xs, 0], rr, -90, 90);
    fp.arc(layer, [-xs, 0], rr, 90, 270);
  }
  return fp.build(s);
}

/** 3 mm / 5 mm round LEDs (pin 1 = cathode, square; flat on the cathode side). */
export function ledThtFootprint(s: PackageSpec): FootprintDef {
  const d = exNum(s, 'diameter') ?? 5;
  const pitch = s.pitch ?? 2.54;
  const fp = new FootprintBuilder(`LED_D${fmtMm(d)}mm`);
  fp.tht('1', -pitch / 2, 0, 1.8, 0.9, 'rect');
  fp.tht('2', pitch / 2, 0, 1.8, 0.9, 'circle');
  const r = d / 2 + 0.4;
  fp.setBody(0, 0, d + 0.8, d + 0.8);
  const flatX = -r * Math.cos((25 * Math.PI) / 180);
  fp.arc('fab', [0, 0], r, -155, 155);
  fp.line('fab', [flatX, -r * Math.sin((25 * Math.PI) / 180)], [flatX, r * Math.sin((25 * Math.PI) / 180)]);
  fp.arc('silk', [0, 0], r + 0.15, -150, 150);
  fp.line('silk', [flatX - 0.15, -(r + 0.15) * 0.45], [flatX - 0.15, (r + 0.15) * 0.45]);
  return fp.build(s);
}

/** Radial aluminium electrolytic (pin 1 = +, square). */
export function electrolyticThtFootprint(s: PackageSpec): FootprintDef {
  const d = exNum(s, 'diameter') ?? s.bodyW ?? 5;
  const pitch = s.pitch ?? 2.0;
  const lead = d <= 4.5 ? 0.45 : d <= 6.3 ? 0.5 : d <= 10 ? 0.6 : 0.8;
  const drill = rnd(Math.ceil((lead + 0.25) / 0.05) * 0.05, 2);
  const pad = rnd(Math.max(drill + 0.4, Math.min(drill + 0.8, pitch - 0.3)), 2);
  const fp = new FootprintBuilder(`CP_Radial_D${fmtMm(d)}mm_P${fmtMm(pitch, true)}mm`);
  fp.tht('1', -pitch / 2, 0, pad, drill, 'rect');
  fp.tht('2', pitch / 2, 0, pad, drill, 'circle');
  fp.setBody(0, 0, d, d);
  fp.circle('fab', [0, 0], d / 2);
  fp.circle('silk', [0, 0], d / 2 + 0.12);
  // '+' marker near pin 1
  const px = -pitch / 2 - pad / 2 - 0.6;
  const py = pad / 2 + 0.5;
  fp.line('silk', [px - 0.4, py], [px + 0.4, py]);
  fp.line('silk', [px, py - 0.4], [px, py + 0.4]);
  return fp.build(s);
}
