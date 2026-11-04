import type { FootprintDef, PackageSpec } from '@pcbcad/core';
import { rnd } from '../util/num';
import { FootprintBuilder, fmtMm } from './builder';

/* --------------------------------------------------------------------------------------------- *
 * Connector-specific and mechanical-ish SMD footprints. Geometry follows the manufacturers'
 * recommended PCB layouts of the most common JLCPCB/LCSC parts (noted per function).
 * --------------------------------------------------------------------------------------------- */

function exNum(s: PackageSpec, k: string): number | undefined {
  const v = s.extra?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function exBool(s: PackageSpec, k: string): boolean | undefined {
  const v = s.extra?.[k];
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * USB Type-C receptacle, mid/top mount, mating face toward −Y.
 * 16P layout = Korean Hroparts TYPE-C-31-M-12 (LCSC C165948): signal row at y = +2.475,
 * 4 slotted shell tabs and two Ø0.65 locating holes. 6P = power-only (VBUS, CC1/CC2, GND).
 */
export function usbCFootprint(s: PackageSpec): FootprintDef {
  const pins = s.pins ?? 16;
  const six = pins === 6;
  const fp = new FootprintBuilder(six ? 'USB_C_Receptacle_6P_PowerOnly' : 'USB_C_Receptacle_HRO_TYPE-C-31-M-12');
  fp.courtyardMargin = 0.5;
  const y = 2.475;
  if (six) {
    const pads: [string, number, number][] = [
      ['A12B1', -2.48, 0.7],
      ['A9B4', -1.52, 0.7],
      ['A5', -0.5, 0.6],
      ['B5', 0.5, 0.6],
      ['B9A4', 1.52, 0.7],
      ['B12A1', 2.48, 0.7],
    ];
    for (const [n, x, w] of pads) fp.smd(n, x, y, w, 1.15);
  } else {
    const pads: [string, number, number][] = [
      ['A1B12', -3.2, 0.6],
      ['A4B9', -2.4, 0.6],
      ['B8', -1.75, 0.3],
      ['A5', -1.25, 0.3],
      ['B7', -0.75, 0.3],
      ['A6', -0.25, 0.3],
      ['A7', 0.25, 0.3],
      ['B6', 0.75, 0.3],
      ['A8', 1.25, 0.3],
      ['B5', 1.75, 0.3],
      ['B4A9', 2.4, 0.6],
      ['B1A12', 3.2, 0.6],
    ];
    for (const [n, x, w] of pads) fp.smd(n, x, y, w, 1.3, { shape: 'rect' });
  }
  // shell: rear tabs 1.2×2.0 (slot 0.8×1.5), front tabs 1.2×1.8 (slot 0.8×1.2)
  for (const sx of [-1, 1]) {
    fp.tht('S1', sx * 4.325, 1.705, 1.2, 0.8, 'oval', 2.0, { w: 0.8, h: 1.5 });
    fp.tht('S1', sx * 4.325, -2.475, 1.2, 0.8, 'oval', 1.8, { w: 0.8, h: 1.2 });
    fp.npth(sx * 2.89, 1.205, 0.65);
  }
  const w = s.bodyW ?? 8.94;
  const l = s.bodyL ?? 7.35;
  const b = fp.setBody(0, 2.3 - l / 2, w, l);
  fp.fabBody(b);
  fp.silkPath([
    [b.minX - 0.1, b.minY + 2.2],
    [b.minX - 0.1, b.maxY + 0.1],
    [b.maxX + 0.1, b.maxY + 0.1],
    [b.maxX + 0.1, b.minY + 2.2],
  ]);
  fp.line('fab', [b.minX, b.minY + 0.4], [b.maxX, b.minY + 0.4]);
  return fp.build(s);
}

/**
 * Micro-USB B receptacle (5P, 0.65 mm pitch), mating face toward −Y.
 * Layout after LCSC C10418 (MICRO-USB-SMD_5P-P0.65-H-F): signal pads at y = +1.3,
 * slotted shell legs at (±3.6, −1.325) and round shell legs at (±2.425, +1.325).
 */
export function usbMicroFootprint(s: PackageSpec): FootprintDef {
  const fp = new FootprintBuilder('USB_Micro-B_Receptacle_5P_P0.65mm');
  fp.courtyardMargin = 0.5;
  const pitch = s.pitch ?? 0.65;
  for (let i = 0; i < 5; i++) fp.smd(String(i + 1), (i - 2) * pitch, 1.3, 0.4, 1.25, { shape: 'rect' });
  for (const sx of [-1, 1]) {
    fp.tht('S1', sx * 3.6, -1.325, 1.1, 0.5, 'oval', 1.9, { w: 0.5, h: 1.3 });
    fp.tht('S1', sx * 2.425, 1.325, 1.2, 0.7, 'circle');
  }
  const w = s.bodyW ?? 8.0;
  const l = s.bodyL ?? 5.6;
  const b = fp.setBody(0, -1.3, w, l);
  fp.fabBody(b);
  fp.silkRect(b);
  return fp.build(s);
}

/**
 * SMD crystals / oscillators. 4-pad: pin 1 bottom-left, counter-clockwise (1,3 = crystal, 2,4 =
 * GND/case for crystals; 1 = OE/NC, 2 = GND, 3 = OUT, 4 = VDD for oscillators). Lands scale with
 * the body (3225 → 1.4×1.2 at ±1.1/±0.85). 2-pad: lands along X.
 */
export function crystalSmdFootprint(s: PackageSpec): FootprintDef {
  const L = s.bodyW ?? 3.2;
  const W = s.bodyL ?? 2.5;
  const pins = s.pins ?? 4;
  const fp = new FootprintBuilder(`Crystal_SMD_${s.size ?? `${fmtMm(L)}x${fmtMm(W)}`}-${pins}Pin_${fmtMm(L)}x${fmtMm(W)}mm`);
  if (pins === 2) {
    const big = s.extra?.variant === 'hc49smd';
    const pw = s.padW ?? (big ? 5.5 : rnd(0.4 * L, 2));
    const ph = s.padH ?? (big ? 2.0 : rnd(0.75 * W, 2));
    const cx = exNum(s, 'padCenter') ?? (big ? 4.75 : rnd(0.37 * L, 3));
    fp.smd('1', -cx, 0, pw, ph);
    fp.smd('2', cx, 0, pw, ph);
  } else {
    const pw = s.padW ?? rnd(0.44 * L, 2);
    const ph = s.padH ?? rnd(0.48 * W, 2);
    const cx = exNum(s, 'padCenter') ?? rnd(0.34 * L, 3);
    const cy = exNum(s, 'padCenterY') ?? rnd(0.34 * W, 3);
    fp.smd('1', -cx, -cy, pw, ph, { shape: 'rect' });
    fp.smd('2', cx, -cy, pw, ph, { shape: 'rect' });
    fp.smd('3', cx, cy, pw, ph, { shape: 'rect' });
    fp.smd('4', -cx, cy, pw, ph, { shape: 'rect' });
  }
  const b = fp.setBody(0, 0, L, W);
  fp.fabBody(b, pins === 2 ? undefined : 'bl');
  fp.silkRect(b);
  if (pins !== 2) fp.pin1Dot([[b.minX - 0.35, b.minY - 0.3]]);
  return fp.build(s);
}

/** SMD aluminium electrolytic (pin 1 = +, at −X). Land sizes after typical vendor recommendations. */
export function electrolyticSmdFootprint(s: PackageSpec): FootprintDef {
  const d = exNum(s, 'diameter') ?? 6.3;
  const table: [number, number, number, number][] = [
    // D, land length (X), land width (Y), centre |x|
    [4, 2.2, 1.6, 1.75],
    [5, 2.4, 1.6, 2.1],
    [6.3, 2.8, 1.6, 2.6],
    [8, 3.4, 1.9, 3.2],
    [10, 3.8, 2.0, 4.0],
    [12.5, 4.5, 2.5, 5.0],
  ];
  const row = table.reduce((best, r) => (Math.abs(r[0] - d) < Math.abs(best[0] - d) ? r : best), table[2]);
  const scale = d / row[0];
  const pl = s.padW ?? rnd(row[1] * scale, 2);
  const pw = s.padH ?? rnd(row[2] * Math.sqrt(scale), 2);
  const cx = exNum(s, 'padCenter') ?? rnd(row[3] * scale, 3);
  const fp = new FootprintBuilder(`CP_Elec_${fmtMm(d)}x${fmtMm(s.bodyH ?? 5.4)}`);
  fp.smd('1', -cx, 0, pl, pw);
  fp.smd('2', cx, 0, pl, pw);
  const side = s.bodyW ?? d + 0.3;
  const b = fp.setBody(0, 0, side, s.bodyL ?? side);
  // base plate outline: chamfered on the + (pin 1) side
  const c = side * 0.25;
  const pts: [number, number][] = [
    [b.minX + c, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX + c, b.maxY],
    [b.minX, b.maxY - c],
    [b.minX, b.minY + c],
  ];
  fp.poly('fab', pts, true);
  fp.circle('fab', [0, 0], d / 2);
  fp.silkPath(
    pts.map((p) => [p[0] + Math.sign(p[0]) * 0.11, p[1] + Math.sign(p[1]) * 0.11] as [number, number]),
    true,
  );
  const px = -cx - pl / 2 - 0.2;
  const py = pw / 2 + 0.7;
  fp.line('silk', [px - 0.4, py], [px + 0.4, py]);
  fp.line('silk', [px, py - 0.4], [px, py + 0.4]);
  return fp.build(s);
}

/** Shielded SMD power inductor (2 terminals along X). */
export function inductorSmdFootprint(s: PackageSpec): FootprintDef {
  const w = s.bodyW ?? 4;
  const l = s.bodyL ?? w;
  const pl = s.padW ?? rnd(Math.max(0.8, 0.32 * w), 2);
  const pw = s.padH ?? rnd(0.85 * l, 2);
  const cx = exNum(s, 'padCenter') ?? rnd(w / 2 - pl / 2 + 0.3, 3);
  const fp = new FootprintBuilder(`L_${fmtMm(w)}x${fmtMm(l)}mm`);
  fp.smd('1', -cx, 0, pl, pw);
  fp.smd('2', cx, 0, pl, pw);
  const b = fp.setBody(0, 0, w, l);
  fp.fabBody(b);
  fp.silkRect(b);
  return fp.build(s);
}

/**
 * 4-terminal tactile switch. Pins 1–2 and 3–4 are internally connected (across the body, along Y);
 * pressing connects 1/2 to 3/4. SMD layout after LCSC C127509 (6×6: lands 1.0×2.2 at
 * (±2.25, ±4.27)); THT 6×6: 6.5 × 4.5 mm grid.
 */
export function tactileSwitchFootprint(s: PackageSpec): FootprintDef {
  const w = s.bodyW ?? 6;
  const l = s.bodyL ?? w;
  const pitch = s.pitch ?? rnd(0.75 * w, 2);
  const span = s.leadSpan ?? rnd(1.58 * l, 2);
  const tht = exBool(s, 'smd') === false;
  const fp = new FootprintBuilder(`SW_Push_${tht ? 'THT' : 'SMD'}_${fmtMm(w)}x${fmtMm(l)}mm`);
  const pos: [string, number, number][] = [
    ['1', -pitch / 2, -1],
    ['2', -pitch / 2, 1],
    ['3', pitch / 2, -1],
    ['4', pitch / 2, 1],
  ];
  if (tht) {
    const yc = span / 2;
    for (const [n, x, sy] of pos) fp.tht(n, x, sy * yc, 1.8, 1.0, n === '1' ? 'rect' : 'circle');
  } else {
    const ph = s.padH ?? rnd(Math.min(2.2, 0.23 * span), 2);
    const pw = s.padW ?? rnd(Math.max(0.8, Math.min(1.2, 0.22 * pitch)), 2);
    const yc = exNum(s, 'padCenter') ?? rnd(span / 2 - 0.48, 3);
    for (const [n, x, sy] of pos) fp.smd(n, x, sy * yc, pw, ph);
  }
  const b = fp.setBody(0, 0, w, l);
  fp.fabBody(b);
  fp.circle('fab', [0, 0], Math.min(w, l) * 0.29);
  fp.silkRect(b);
  return fp.build(s);
}

/**
 * Coin-cell holder (CR2032 default): two '+' tabs (pin 1) at ±X beyond the holder, '−' contact pad
 * (pin 2) under the cell centre. Approximates common SMD holders (e.g. BS-6 / Keystone 3034 class).
 */
export function batteryHolderFootprint(s: PackageSpec): FootprintDef {
  const w = s.bodyW ?? 24;
  const l = s.bodyL ?? 20.5;
  const cell = typeof s.extra?.cell === 'string' ? s.extra.cell : 'CR2032';
  const coin = /CR(\d\d)/.exec(cell) ? parseInt(/CR(\d\d)/.exec(cell)![1], 10) : 20;
  const fp = new FootprintBuilder(`BatteryHolder_${cell}_SMD`);
  fp.courtyardMargin = 0.5;
  fp.smd('1', -(w / 2 + 1.2), 0, 3.0, 4.0, { shape: 'rect' });
  fp.smd('1', w / 2 + 1.2, 0, 3.0, 4.0, { shape: 'rect' });
  fp.smd('2', 0, 0, rnd(coin * 0.5, 2), rnd(coin * 0.5, 2), { shape: 'circle' });
  const b = fp.setBody(0, 0, w, l);
  fp.fabBody(b);
  fp.circle('fab', [0, 0], coin / 2);
  fp.silkRect(b);
  const px = -(w / 2 + 1.2);
  fp.line('silk', [px - 0.6, 3.2], [px + 0.6, 3.2]);
  fp.line('silk', [px, 2.6], [px, 3.8]);
  return fp.build(s);
}

/**
 * Castellated module: pads straddle the module edge (0.5 mm outside). Pins run CCW from the top of
 * the left side; extra.pinsLeft/pinsBottom/pinsRight/pinsTop override the split (default: half
 * left, half right). extra.antennaTop reserves a pad-free zone at the top edge (mm).
 */
export function moduleFootprint(s: PackageSpec): FootprintDef {
  const pins = s.pins ?? 16;
  const pitch = s.pitch ?? 2.54;
  const w = s.bodyW ?? 18;
  const l = s.bodyL ?? 25.5;
  const left = exNum(s, 'pinsLeft') ?? Math.ceil(pins / 2);
  const bottom = exNum(s, 'pinsBottom') ?? 0;
  const right = exNum(s, 'pinsRight') ?? pins - left - bottom - (exNum(s, 'pinsTop') ?? 0);
  const top = exNum(s, 'pinsTop') ?? Math.max(0, pins - left - bottom - right);
  const antenna = exNum(s, 'antennaTop') ?? 0;
  const padLen = pitch >= 2 ? 1.8 : 1.5;
  const padWid = rnd(Math.min(pitch * 0.7, pitch >= 2 ? 1.2 : 0.9), 3);
  const fp = new FootprintBuilder(`Module_Castellated_${pins}P_${fmtMm(w)}x${fmtMm(l)}mm_P${fmtMm(pitch)}mm`);
  const out = 0.5;
  const xL = -w / 2 + padLen / 2 - out;
  const xR = w / 2 - padLen / 2 + out;
  const yB = -l / 2 + padLen / 2 - out;
  const yT = l / 2 - padLen / 2 + out;
  // vertical columns: lowest pad 1.5 mm above the bottom edge (or above the bottom row)
  const colBottom = -l / 2 + (bottom ? padLen + 0.8 : 1.5);
  let k = 1;
  const colTop = (n: number) => colBottom + (n - 1) * pitch;
  for (let i = 0; i < left; i++) fp.smd(String(k++), xL, colTop(left) - i * pitch, padLen, padWid);
  for (let i = 0; i < bottom; i++) fp.smd(String(k++), -((bottom - 1) / 2) * pitch + i * pitch, yB, padWid, padLen);
  for (let i = 0; i < right; i++) fp.smd(String(k++), xR, colBottom + i * pitch, padLen, padWid);
  for (let i = 0; i < top; i++) fp.smd(String(k++), ((top - 1) / 2) * pitch - i * pitch, yT, padWid, padLen);
  if (s.exposedPad) fp.smd(String(k++), 0, -l / 2 + l * 0.42, s.exposedPad.w, s.exposedPad.h, { shape: 'rect', pasteRatio: 0.5 });
  const b = fp.setBody(0, 0, w, l);
  fp.fabBody(b, 'tl');
  fp.silkRect(b);
  if (antenna > 0) fp.line('fab', [b.minX, b.maxY - antenna], [b.maxX, b.maxY - antenna]);
  fp.pin1Dot([[xL - padLen / 2 - 0.4, colTop(left)]]);
  return fp.build(s);
}

/** Body-only footprint for 'custom' specs (pads must be supplied separately). */
export function customFootprint(s: PackageSpec): FootprintDef {
  const fp = new FootprintBuilder(`Custom_${fmtMm(s.bodyW ?? 2)}x${fmtMm(s.bodyL ?? 2)}mm`);
  const b = fp.setBody(0, 0, s.bodyW ?? 2, s.bodyL ?? 2);
  fp.fabBody(b);
  fp.silkRect(b);
  return fp.build(s);
}
