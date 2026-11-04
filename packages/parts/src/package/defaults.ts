import type { PackageSpec } from '@pcbcad/core';
import { rnd } from '../util/num';

/**
 * Nominal package dimensions (JEDEC / EIA / manufacturer typical) used to complete partial
 * PackageSpecs. Conventions (footprint frame, Y up):
 *  - 2-terminal parts (chip, SOD, SMA, crystals, …): terminals along X → bodyW = length, bodyL = width.
 *  - Dual-row ICs (SOIC, TSSOP, DFN, SOT-23, …): pin rows run along Y, leads exit along X
 *    → bodyW = body width (between rows), bodyL = body length (along the rows), leadSpan along X.
 *  - Quad packages (QFN/QFP/LGA/BGA): bodyW × bodyL.
 * All values in mm.
 */

export interface ChipDims {
  /** Length (terminal to terminal) min/max, width min/max, height nominal, terminal length min/max. */
  L: [number, number];
  W: [number, number];
  H: number;
  T: [number, number];
}

/** EIA imperial chip sizes (resistor/MLCC typical tolerances). */
export const CHIP_SIZES: Record<string, ChipDims> = {
  '01005': { L: [0.38, 0.42], W: [0.18, 0.22], H: 0.13, T: [0.07, 0.14] },
  '0201': { L: [0.57, 0.63], W: [0.27, 0.33], H: 0.25, T: [0.1, 0.2] },
  '0402': { L: [0.95, 1.05], W: [0.45, 0.55], H: 0.35, T: [0.15, 0.35] },
  '0603': { L: [1.5, 1.7], W: [0.7, 0.9], H: 0.45, T: [0.15, 0.45] },
  '0805': { L: [1.9, 2.1], W: [1.15, 1.35], H: 0.5, T: [0.2, 0.5] },
  '1008': { L: [2.3, 2.7], W: [1.8, 2.2], H: 1.5, T: [0.3, 0.6] },
  '1206': { L: [3.05, 3.35], W: [1.45, 1.75], H: 0.55, T: [0.25, 0.65] },
  '1210': { L: [3.05, 3.35], W: [2.35, 2.65], H: 0.55, T: [0.25, 0.65] },
  '1812': { L: [4.3, 4.7], W: [3.0, 3.4], H: 0.6, T: [0.3, 0.8] },
  '2010': { L: [4.9, 5.1], W: [2.35, 2.65], H: 0.55, T: [0.35, 0.85] },
  '2220': { L: [5.4, 6.0], W: [4.7, 5.3], H: 1.6, T: [0.3, 0.9] },
  '2512': { L: [6.2, 6.5], W: [3.05, 3.35], H: 0.55, T: [0.35, 0.85] },
};

/** Metric chip codes → imperial (only used when the context says "passive"). */
export const METRIC_CHIP: Record<string, string> = {
  '0402': '01005',
  '0603': '0201',
  '1005': '0402',
  '1608': '0603',
  '2012': '0805',
  '2520': '1008',
  '3216': '1206',
  '3225': '1210',
  '4532': '1812',
  '5025': '2010',
  '5750': '2220',
  '6332': '2512',
};

/** Chip size code from body length × width (mm), e.g. 1.6 × 0.8 → '0603'. */
export function chipSizeFromDims(l: number, w: number): string | undefined {
  let best: string | undefined;
  let bestErr = Infinity;
  for (const [code, d] of Object.entries(CHIP_SIZES)) {
    const ln = (d.L[0] + d.L[1]) / 2;
    const wn = (d.W[0] + d.W[1]) / 2;
    const err = Math.abs(ln - l) / ln + Math.abs(wn - w) / wn;
    if (err < bestErr) {
      bestErr = err;
      best = code;
    }
  }
  return bestErr < 0.25 ? best : undefined;
}

/** Crystal SMD body sizes (L × W × H), keyed by the 4-digit size code. */
export const CRYSTAL_SIZES: Record<string, [number, number, number]> = {
  '1612': [1.6, 1.2, 0.35],
  '2016': [2.0, 1.6, 0.5],
  '2520': [2.5, 2.0, 0.55],
  '3225': [3.2, 2.5, 0.75],
  '5032': [5.0, 3.2, 1.0],
  '6035': [6.0, 3.5, 1.1],
  '7050': [7.0, 5.0, 1.3],
};

/** Radial electrolytic lead pitch by can diameter. */
export function electrolyticPitch(d: number): number {
  if (d <= 4.5) return 1.5;
  if (d <= 5.5) return 2.0;
  if (d <= 6.5) return 2.5;
  if (d <= 8.5) return 3.5;
  if (d <= 11) return 5.0;
  if (d <= 13) return 5.0;
  if (d <= 18.5) return 7.5;
  return 10.0;
}

/** Standard QFN/QFP pitches (mm), largest first. */
const STD_PITCHES = [1.27, 1.0, 0.8, 0.65, 0.5, 0.4, 0.35];

/** Common (pins, body) → pitch for square QFNs. */
const QFN_PITCH: Record<string, number> = {
  '8x2': 0.5,
  '12x3': 0.5,
  '16x3': 0.5,
  '20x3': 0.4,
  '16x4': 0.65,
  '20x4': 0.5,
  '24x4': 0.5,
  '28x4': 0.4,
  '16x5': 0.8,
  '20x5': 0.65,
  '28x5': 0.5,
  '32x5': 0.5,
  '40x5': 0.4,
  '28x6': 0.65,
  '36x6': 0.5,
  '40x6': 0.5,
  '48x6': 0.4,
  '44x7': 0.5,
  '48x7': 0.5,
  '56x7': 0.4,
  '56x8': 0.5,
  '64x8': 0.4,
  '64x9': 0.5,
  '72x10': 0.5,
};

/** Default QFN body size by pin count. */
const QFN_BODY: Record<number, number> = { 8: 2, 12: 3, 16: 3, 20: 4, 24: 4, 28: 5, 32: 5, 36: 6, 40: 6, 44: 7, 48: 7, 52: 8, 56: 7, 64: 9, 68: 8, 72: 10, 76: 9, 88: 10 };

/** Pitch for a quad no-lead package with `n` terminals on a side of length `body`. */
export function quadNoLeadPitch(pins: number, body: number): number {
  const key = `${pins}x${Math.round(body)}`;
  if (Math.abs(body - Math.round(body)) < 0.05 && QFN_PITCH[key]) return QFN_PITCH[key];
  const n = Math.ceil(pins / 4);
  for (const p of STD_PITCHES) if ((n - 1) * p <= body - 1.4 + 1e-6) return p;
  return 0.35;
}

/** Pitch for a dual no-lead package (DFN/SON) with pins/2 terminals along a side of length `len`. */
export function dualNoLeadPitch(pins: number, len: number): number {
  const table: Record<string, number> = { '6x2': 0.65, '8x2': 0.5, '6x3': 0.95, '8x2.5': 0.65, '8x3': 0.65, '10x3': 0.5, '12x3': 0.45, '14x3': 0.4, '8x4': 0.8, '10x4': 0.8, '8x5': 1.27, '8x6': 1.27, '8x3.3': 0.65 };
  const key = `${pins}x${rnd(len, 1)}`;
  if (table[key]) return table[key];
  const n = Math.ceil(pins / 2);
  for (const p of STD_PITCHES) if ((n - 1) * p <= len - 0.5 + 1e-6) return p;
  return 0.35;
}

/** LQFP/TQFP body size (square) and pitch by pin count. */
export function qfpDefaults(pins: number): { body: number; pitch: number } {
  const t: Record<number, [number, number]> = {
    32: [7, 0.8],
    44: [10, 0.8],
    48: [7, 0.5],
    52: [10, 0.65],
    64: [10, 0.5],
    80: [12, 0.5],
    100: [14, 0.5],
    128: [14, 0.4],
    144: [20, 0.5],
    176: [24, 0.5],
    208: [28, 0.5],
  };
  const v = t[pins];
  if (v) return { body: v[0], pitch: v[1] };
  const n = Math.ceil(pins / 4);
  const pitch = n <= 8 ? 0.8 : n <= 16 ? 0.5 : 0.4;
  return { body: Math.ceil(((n - 1) * pitch + 2.0) / 1) * 1, pitch };
}

/** QFP pitch from pins and body when the string only gives the body. */
export function qfpPitch(pins: number, body: number): number {
  const d = qfpDefaults(pins);
  if (Math.abs(d.body - body) < 0.2) return d.pitch;
  const n = Math.ceil(pins / 4);
  for (const p of [1.0, 0.8, 0.65, 0.5, 0.4]) if ((n - 1) * p <= body - 1.5 + 1e-6) return p;
  return 0.4;
}

/** Narrow SOIC body length by pin count (JEDEC MS-012). */
function soicLength(pins: number, wide: boolean): number {
  if (wide) {
    const t: Record<number, number> = { 8: 5.85, 14: 9.0, 16: 10.3, 18: 11.55, 20: 12.8, 24: 15.4, 28: 17.9, 32: 20.5 };
    return t[pins] ?? rnd((pins / 2) * 1.27 + 0.6, 2);
  }
  const t: Record<number, number> = { 8: 4.9, 10: 4.9, 14: 8.65, 16: 9.9 };
  return t[pins] ?? rnd((pins / 2) * 1.27 + 0.35, 2);
}

function tssopLength(pins: number, pitch: number): number {
  const t: Record<number, number> = { 8: 3.0, 10: 3.0, 14: 5.0, 16: 5.0, 20: 6.5, 24: 7.8, 28: 9.7, 30: 7.8, 38: 9.7, 48: 12.5, 56: 14.0, 64: 17.0 };
  return t[pins] ?? rnd((pins / 2) * pitch + 0.6, 2);
}

function ssopLength(pins: number, qsop: boolean): number {
  if (qsop) {
    const t: Record<number, number> = { 16: 4.9, 20: 8.65, 24: 8.65, 28: 9.9 };
    return t[pins] ?? rnd((pins / 2) * 0.635 + 0.6, 2);
  }
  const t: Record<number, number> = { 8: 3.0, 14: 6.2, 16: 6.2, 18: 7.2, 20: 7.2, 22: 8.2, 24: 8.2, 28: 10.2, 30: 10.2 };
  return t[pins] ?? rnd((pins / 2) * 0.65 + 0.8, 2);
}

function ex(spec: PackageSpec, key: string): string | number | boolean | undefined {
  return spec.extra?.[key];
}

function num(v: string | number | boolean | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Return a copy of `spec` with every dimension the generators need filled in from the tables above.
 * Fields already present are kept. Unknown families are returned unchanged.
 */
export function completeSpec(input: PackageSpec): PackageSpec {
  const s: PackageSpec = { ...input, extra: input.extra ? { ...input.extra } : undefined };
  const setExtra = (k: string, v: string | number | boolean) => {
    s.extra = { ...(s.extra ?? {}), [k]: v };
  };
  switch (s.family) {
    case 'chip': {
      let size = s.size;
      if (!size && s.bodyW && s.bodyL) size = chipSizeFromDims(s.bodyW, s.bodyL);
      size ??= '0805';
      s.size = size;
      const d = CHIP_SIZES[size] ?? CHIP_SIZES['0805'];
      s.bodyW ??= rnd((d.L[0] + d.L[1]) / 2);
      s.bodyL ??= rnd((d.W[0] + d.W[1]) / 2);
      s.bodyH ??= d.H;
      s.pins ??= 2;
      break;
    }
    case 'sod123':
      s.bodyW ??= 2.7;
      s.bodyL ??= 1.6;
      s.bodyH ??= 1.15;
      s.leadSpan ??= 3.7;
      s.pins ??= 2;
      break;
    case 'sod323':
      s.bodyW ??= 1.7;
      s.bodyL ??= 1.25;
      s.bodyH ??= 0.95;
      s.leadSpan ??= 2.5;
      s.pins ??= 2;
      break;
    case 'sma':
      s.bodyW ??= 4.3;
      s.bodyL ??= 2.6;
      s.bodyH ??= 2.3;
      s.leadSpan ??= 5.2;
      s.pins ??= 2;
      break;
    case 'smb':
      s.bodyW ??= 4.3;
      s.bodyL ??= 3.6;
      s.bodyH ??= 2.3;
      s.leadSpan ??= 5.4;
      s.pins ??= 2;
      break;
    case 'smc':
      s.bodyW ??= 6.9;
      s.bodyL ??= 5.9;
      s.bodyH ??= 2.3;
      s.leadSpan ??= 7.9;
      s.pins ??= 2;
      break;
    case 'melf': {
      const big = (s.bodyW ?? 0) > 4.2 || ex(s, 'variant') === 'melf';
      s.bodyW ??= big ? 5.0 : 3.5;
      s.bodyL ??= big ? 2.5 : 1.5;
      s.bodyH ??= s.bodyL;
      s.pins ??= 2;
      break;
    }
    case 'sot23': {
      const pins = s.pins ?? 3;
      s.pins = pins;
      const sc70 = ex(s, 'variant') === 'sc70';
      if (sc70) {
        s.bodyW ??= 1.25;
        s.bodyL ??= 2.0;
        s.bodyH ??= 1.0;
        s.leadSpan ??= 2.1;
        s.pitch ??= 0.65;
      } else if (pins <= 3) {
        s.bodyW ??= 1.3;
        s.bodyL ??= 2.9;
        s.bodyH ??= 1.1;
        s.leadSpan ??= 2.4;
        s.pitch ??= 0.95;
      } else {
        s.bodyW ??= 1.6;
        s.bodyL ??= 2.9;
        s.bodyH ??= 1.15;
        s.leadSpan ??= 2.8;
        s.pitch ??= pins >= 8 ? 0.65 : 0.95;
      }
      break;
    }
    case 'sot223':
      s.pins ??= 4;
      s.bodyW ??= 3.5;
      s.bodyL ??= 6.5;
      s.bodyH ??= 1.65;
      s.leadSpan ??= 7.0;
      s.pitch ??= s.pins >= 6 ? 1.27 : 2.3;
      break;
    case 'sot89':
      s.pins ??= 3;
      s.bodyW ??= 2.5;
      s.bodyL ??= 4.5;
      s.bodyH ??= 1.5;
      s.leadSpan ??= 4.1;
      s.pitch ??= 1.5;
      break;
    case 'to252': {
      const d2 = ex(s, 'variant') === 'd2pak';
      s.pins ??= 3;
      s.bodyW ??= d2 ? 9.2 : 6.1;
      s.bodyL ??= d2 ? 10.2 : 6.6;
      s.bodyH ??= d2 ? 4.5 : 2.3;
      s.leadSpan ??= d2 ? 15.3 : 9.9;
      s.pitch ??= d2 ? 2.54 : 2.28;
      break;
    }
    case 'soic': {
      const pins = s.pins ?? 8;
      s.pins = pins;
      const variant = ex(s, 'variant');
      const wide = variant === 'wide' || (s.bodyW ?? 0) > 6.5;
      const eiaj = variant === 'eiaj' || ((s.bodyW ?? 0) > 4.6 && (s.bodyW ?? 0) <= 6.5);
      s.pitch ??= 1.27;
      if (wide) {
        s.bodyW ??= 7.5;
        s.leadSpan ??= 10.3;
        s.bodyH ??= 2.65;
      } else if (eiaj) {
        s.bodyW ??= 5.3;
        s.leadSpan ??= 7.9;
        s.bodyH ??= 2.0;
      } else {
        s.bodyW ??= 3.9;
        s.leadSpan ??= 6.0;
        s.bodyH ??= 1.75;
      }
      s.bodyL ??= soicLength(pins, wide);
      break;
    }
    case 'ssop': {
      const pins = s.pins ?? 20;
      s.pins = pins;
      const qsop = ex(s, 'variant') === 'qsop' || (s.pitch !== undefined && Math.abs(s.pitch - 0.635) < 0.01);
      s.pitch ??= qsop ? 0.635 : 0.65;
      s.bodyW ??= qsop ? 3.9 : 5.3;
      s.leadSpan ??= qsop ? 6.0 : 7.8;
      s.bodyH ??= qsop ? 1.75 : 2.0;
      s.bodyL ??= ssopLength(pins, qsop);
      break;
    }
    case 'tssop': {
      const pins = s.pins ?? 20;
      s.pins = pins;
      const wide = pins >= 38 || (s.bodyW ?? 0) > 5.5;
      s.pitch ??= wide ? 0.5 : 0.65;
      s.bodyW ??= wide ? 6.1 : 4.4;
      s.leadSpan ??= wide ? 8.1 : 6.4;
      s.bodyH ??= 1.2;
      s.bodyL ??= tssopLength(pins, s.pitch);
      break;
    }
    case 'msop': {
      const pins = s.pins ?? 8;
      s.pins = pins;
      s.pitch ??= pins <= 8 ? 0.65 : pins <= 10 ? 0.5 : pins <= 12 ? 0.4 : 0.5;
      s.bodyW ??= 3.0;
      s.bodyL ??= pins > 12 ? 4.04 : 3.0;
      s.leadSpan ??= 4.9;
      s.bodyH ??= 1.1;
      break;
    }
    case 'qfn': {
      const pins = s.pins ?? 32;
      s.pins = pins;
      const b = QFN_BODY[pins] ?? Math.max(2, Math.ceil((Math.ceil(pins / 4) * 0.5 + 1.4) / 1));
      s.bodyW ??= s.bodyL ?? b;
      s.bodyL ??= s.bodyW;
      s.pitch ??= quadNoLeadPitch(pins, Math.min(s.bodyW, s.bodyL));
      s.bodyH ??= 0.9;
      if (s.exposedPad === undefined && ex(s, 'noEP') !== true) {
        const e = rnd(Math.max(0.5, Math.min(s.bodyW, s.bodyL) - 1.5), 2);
        s.exposedPad = { w: rnd(Math.max(0.5, s.bodyW - 1.5), 2), h: rnd(Math.max(0.5, s.bodyL - 1.5), 2) };
        if (s.bodyW === s.bodyL) s.exposedPad = { w: e, h: e };
      }
      break;
    }
    case 'dfn': {
      const pins = s.pins ?? 8;
      s.pins = pins;
      s.bodyW ??= s.bodyL ?? (pins <= 6 ? 2 : 3);
      s.bodyL ??= s.bodyW;
      s.pitch ??= dualNoLeadPitch(pins, s.bodyL);
      s.bodyH ??= 0.8;
      if (s.exposedPad === undefined && ex(s, 'noEP') !== true) {
        s.exposedPad = {
          w: rnd(Math.max(0.4, s.bodyW - 1.4), 2),
          h: rnd(Math.max(0.4, Math.min(s.bodyL - 0.6, (Math.ceil(pins / 2) - 1) * s.pitch + 0.4)), 2),
        };
      }
      break;
    }
    case 'lga': {
      const pins = s.pins ?? 8;
      s.pins = pins;
      s.bodyW ??= s.bodyL ?? 2.5;
      s.bodyL ??= s.bodyW;
      const sides = num(ex(s, 'sides')) ?? (pins <= 10 ? 2 : 4);
      setExtra('sides', sides);
      s.pitch ??= sides === 2 ? dualNoLeadPitch(pins, s.bodyL) : quadNoLeadPitch(pins, Math.min(s.bodyW, s.bodyL));
      s.bodyH ??= 0.9;
      break;
    }
    case 'qfp': {
      const pins = s.pins ?? 32;
      s.pins = pins;
      const d = qfpDefaults(pins);
      s.bodyW ??= s.bodyL ?? d.body;
      s.bodyL ??= s.bodyW;
      s.pitch ??= qfpPitch(pins, Math.min(s.bodyW, s.bodyL));
      s.leadSpan ??= rnd(s.bodyW + 2.0, 2);
      s.bodyH ??= ex(s, 'variant') === 'tqfp' ? 1.2 : 1.6;
      break;
    }
    case 'bga': {
      const pins = s.pins ?? 64;
      s.pins = pins;
      const cols = num(ex(s, 'cols')) ?? Math.ceil(Math.sqrt(pins));
      const rows = num(ex(s, 'rows')) ?? Math.ceil(pins / cols);
      setExtra('cols', cols);
      setExtra('rows', rows);
      s.pitch ??= pins <= 16 && (s.bodyW ?? 9) < 3 ? 0.5 : 0.8;
      s.bodyW ??= rnd(Math.ceil(((cols + 1) * s.pitch) * 2) / 2, 2);
      s.bodyL ??= rnd(Math.ceil(((rows + 1) * s.pitch) * 2) / 2, 2);
      s.bodyH ??= s.pitch <= 0.5 ? 0.6 : 1.2;
      break;
    }
    case 'dip': {
      const pins = s.pins ?? 8;
      s.pins = pins;
      s.pitch ??= 2.54;
      const wide = ex(s, 'variant') === 'wide' || pins >= 32;
      setExtra('rowSpacing', num(ex(s, 'rowSpacing')) ?? (wide ? 15.24 : 7.62));
      s.bodyW ??= wide ? 13.7 : 6.35;
      s.bodyL ??= rnd((pins / 2) * s.pitch + 0.4, 2);
      s.bodyH ??= 3.3;
      break;
    }
    case 'to92':
      s.pins ??= 3;
      s.pitch ??= 1.27;
      s.bodyW ??= 4.6;
      s.bodyL ??= 3.6;
      s.bodyH ??= 4.6;
      break;
    case 'to220':
      s.pins ??= 3;
      s.pitch ??= s.pins >= 5 ? 1.7 : 2.54;
      s.bodyW ??= 10.1;
      s.bodyL ??= 4.5;
      s.bodyH ??= 15.5;
      s.orientation ??= 'vertical';
      break;
    case 'header': {
      s.pitch ??= 2.54;
      s.rows ??= 1;
      s.pins ??= 4 * s.rows;
      const cols = Math.ceil(s.pins / s.rows);
      s.bodyW ??= rnd(cols * s.pitch, 3);
      s.bodyL ??= rnd(s.rows * s.pitch, 3);
      const female = ex(s, 'gender') === 'female';
      s.bodyH ??= female ? (s.pitch >= 2.5 ? 8.5 : s.pitch >= 2 ? 6.4 : 4.4) : s.pitch >= 2.5 ? 8.5 : s.pitch >= 2 ? 6.1 : 4.0;
      s.orientation ??= 'vertical';
      break;
    }
    case 'jst-ph': {
      s.pins ??= 2;
      s.pitch ??= 2.0;
      const side = s.orientation === 'right-angle' || s.orientation === 'horizontal';
      const smd = ex(s, 'smd') === true;
      s.bodyW ??= rnd((s.pins - 1) * s.pitch + 3.9, 2);
      s.bodyL ??= smd ? 7.5 : side ? 7.6 : 4.5;
      s.bodyH ??= smd ? 4.7 : side ? 4.8 : 6.0;
      s.orientation ??= 'vertical';
      break;
    }
    case 'jst-xh': {
      s.pins ??= 2;
      s.pitch ??= 2.5;
      const side = s.orientation === 'right-angle' || s.orientation === 'horizontal';
      s.bodyW ??= rnd((s.pins - 1) * s.pitch + 4.9, 2);
      s.bodyL ??= side ? 9.8 : 5.75;
      s.bodyH ??= side ? 7.0 : 7.0;
      s.orientation ??= 'vertical';
      break;
    }
    case 'jst-sh': {
      s.pins ??= 4;
      s.pitch ??= 1.0;
      const top = s.orientation === 'vertical';
      s.bodyW ??= rnd((s.pins - 1) * s.pitch + 3.0, 2);
      s.bodyL ??= top ? 4.25 : 4.25;
      s.bodyH ??= top ? 4.25 : 2.95;
      s.orientation ??= 'right-angle';
      if (ex(s, 'smd') === undefined) setExtra('smd', true);
      break;
    }
    case 'usb-c':
      s.pins ??= 16;
      s.bodyW ??= 8.94;
      s.bodyL ??= 7.35;
      s.bodyH ??= 3.26;
      s.orientation ??= 'horizontal';
      break;
    case 'usb-micro':
      s.pins ??= 5;
      s.pitch ??= 0.65;
      s.bodyW ??= 7.5;
      s.bodyL ??= 5.0;
      s.bodyH ??= 2.5;
      s.orientation ??= 'horizontal';
      break;
    case 'crystal-smd': {
      const code = s.size && CRYSTAL_SIZES[s.size] ? s.size : '3225';
      s.size = code;
      const d = CRYSTAL_SIZES[code];
      s.bodyW ??= d[0];
      s.bodyL ??= d[1];
      s.bodyH ??= d[2];
      s.pins ??= 4;
      break;
    }
    case 'hc49': {
      const tall = ex(s, 'variant') === 'hc49u';
      s.pins ??= 2;
      s.pitch ??= 4.88;
      s.bodyW ??= 11.05;
      s.bodyL ??= 4.65;
      s.bodyH ??= tall ? 13.46 : 3.5;
      break;
    }
    case 'electrolytic-smd': {
      const d = num(ex(s, 'diameter')) ?? s.bodyW ?? 6.3;
      setExtra('diameter', d);
      s.bodyW ??= rnd(d + 0.3, 2);
      s.bodyL ??= rnd(d + 0.3, 2);
      s.bodyH ??= d <= 4 ? 5.4 : d <= 5 ? 5.4 : d <= 6.3 ? 5.4 : d <= 8 ? 6.2 : 10.2;
      s.pins ??= 2;
      break;
    }
    case 'electrolytic-tht': {
      const d = num(ex(s, 'diameter')) ?? s.bodyW ?? 5;
      setExtra('diameter', d);
      s.bodyW ??= d;
      s.bodyL ??= d;
      s.bodyH ??= d <= 5 ? 11 : d <= 6.3 ? 11 : d <= 8 ? 11.5 : d <= 10 ? 16 : 20;
      s.pitch ??= electrolyticPitch(d);
      s.pins ??= 2;
      break;
    }
    case 'inductor-smd':
      s.bodyW ??= s.bodyL ?? 4.0;
      s.bodyL ??= s.bodyW;
      s.bodyH ??= rnd(Math.min(5, Math.max(1, s.bodyW * 0.5)), 2);
      s.pins ??= 2;
      break;
    case 'tactile-switch': {
      s.bodyW ??= s.bodyL ?? 6.0;
      s.bodyL ??= s.bodyW;
      const tht = ex(s, 'smd') === false;
      s.pins ??= 4;
      if (tht) {
        s.pitch ??= rnd(s.bodyW * 0.75, 2);
        s.leadSpan ??= rnd(s.bodyL * 1.083, 2);
      } else {
        s.pitch ??= rnd(s.bodyW * 0.75, 2);
        s.leadSpan ??= rnd(s.bodyL * 1.58, 2);
      }
      s.bodyH ??= s.bodyW >= 5.9 ? 5.0 : rnd(Math.max(1.5, s.bodyW * 0.5), 2);
      break;
    }
    case 'led-tht': {
      const d = num(ex(s, 'diameter')) ?? (s.bodyW && s.bodyW < 4 ? 3 : 5);
      setExtra('diameter', d);
      s.pins ??= 2;
      s.pitch ??= 2.54;
      s.bodyW ??= d;
      s.bodyL ??= d;
      s.bodyH ??= d <= 3 ? 5.3 : 8.6;
      break;
    }
    case 'terminal-block': {
      s.pins ??= 2;
      s.pitch ??= 5.08;
      const small = s.pitch < 4;
      s.bodyW ??= rnd(s.pins * s.pitch, 2);
      s.bodyL ??= small ? 7.0 : 8.0;
      s.bodyH ??= small ? 8.5 : 10.0;
      s.rows ??= 1;
      break;
    }
    case 'battery-holder':
      s.pins ??= 2;
      s.bodyW ??= 24.0;
      s.bodyL ??= 20.5;
      s.bodyH ??= 4.2;
      if (!ex(s, 'cell')) setExtra('cell', 'CR2032');
      break;
    case 'module':
      s.pins ??= 16;
      s.pitch ??= 2.54;
      s.bodyW ??= 18;
      s.bodyL ??= 25.5;
      s.bodyH ??= 3.1;
      break;
    case 'custom':
      s.bodyW ??= 2;
      s.bodyL ??= 2;
      s.bodyH ??= 1;
      break;
    default:
      break;
  }
  return s;
}
