import type { PartDef } from '@pcbcad/core';
import { CHIP_SIZES, completeSpec } from '../package/defaults';
import { findParam, paramNumber, paramText, parseQuantity, parseTempRange } from './params';

/* --------------------------------------------------------------------------------------------- *
 * Thermal defaults. θJA values are typical JEDEC-board (2s2p-like, modest copper) figures for the
 * package family; θJC is case/lead-to-junction where it matters for heat-sinking pads.
 * Chip resistors/capacitors: θJA chosen so that the rated power at 70 °C ambient reaches the
 * 155 °C film limit (0805 @ 125 mW → θJA ≈ 680 °C/W).
 * --------------------------------------------------------------------------------------------- */

const CHIP_POWER: Record<string, number> = { '01005': 0.031, '0201': 0.05, '0402': 0.0625, '0603': 0.1, '0805': 0.125, '1206': 0.25, '1210': 0.5, '1812': 0.75, '2010': 0.75, '2512': 1.0, '1008': 0.25, '2220': 1.0 };

const DISCRETE = ['diode', 'zener', 'schottky', 'tvs', 'led', 'bjt-npn', 'bjt-pnp', 'mosfet-n', 'mosfet-p'];
const NO_THERMAL = ['connector', 'cable', 'wire', 'fastener', 'mechanical', 'testpoint', 'antenna', 'battery', 'switch', 'button', 'module', 'rf-module', 'display', 'relay', 'buzzer'];

type Thermal = NonNullable<PartDef['thermal']>;

function familyThermal(part: PartDef): Thermal | undefined {
  const s = part.packageSpec ? completeSpec(part.packageSpec) : undefined;
  if (!s) return undefined;
  const pins = s.pins ?? 0;
  const area = (s.bodyW ?? 3) * (s.bodyL ?? 3);
  switch (s.family) {
    case 'chip': {
      const pw = findParam(part.params, /^power$|^power\s*\((watts|w)\)|^power rating|^rated power/i);
      const P = (pw && /\d\s*[mµu]?W\b/i.test(pw.value) ? parseQuantity(pw.value) : undefined) ?? CHIP_POWER[s.size ?? '0805'] ?? 0.125;
      const tj = part.category === 'resistor' ? 155 : 125;
      return { thetaJA: Math.round((tj - 70) / P), tjMax: tj };
    }
    case 'sod123':
      return { thetaJA: 350, thetaJC: 120 };
    case 'sod323':
      return { thetaJA: 450, thetaJC: 150 };
    case 'sma':
      return { thetaJA: 90, thetaJC: 20 };
    case 'smb':
      return { thetaJA: 70, thetaJC: 15 };
    case 'smc':
      return { thetaJA: 55, thetaJC: 10 };
    case 'melf':
      return { thetaJA: 300, thetaJC: 100 };
    case 'sot23':
      return pins <= 3 ? { thetaJA: 250, thetaJC: 100 } : { thetaJA: 200, thetaJC: 80 };
    case 'sot223':
      return { thetaJA: 90, thetaJC: 15 };
    case 'sot89':
      return { thetaJA: 120, thetaJC: 30 };
    case 'to252':
      return s.extra?.variant === 'd2pak' ? { thetaJA: 40, thetaJC: 2 } : { thetaJA: 55, thetaJC: 4 };
    case 'to220':
      return { thetaJA: 62, thetaJC: 3 };
    case 'to92':
      return { thetaJA: 200, thetaJC: 83 };
    case 'soic':
      if (s.exposedPad) return { thetaJA: 45, thetaJC: 10 };
      return pins <= 8 ? { thetaJA: 125, thetaJC: 45 } : s.extra?.variant === 'wide' ? { thetaJA: 75, thetaJC: 30 } : { thetaJA: 90, thetaJC: 40 };
    case 'ssop':
      return { thetaJA: 100, thetaJC: 40 };
    case 'tssop':
      if (s.exposedPad) return { thetaJA: 40, thetaJC: 8 };
      return { thetaJA: pins <= 8 ? 180 : pins <= 16 ? 120 : 95, thetaJC: 35 };
    case 'msop':
      if (s.exposedPad) return { thetaJA: 55, thetaJC: 10 };
      return { thetaJA: pins <= 8 ? 160 : 150, thetaJC: 45 };
    case 'qfn': {
      const b = Math.min(s.bodyW ?? 4, s.bodyL ?? 4);
      if (!s.exposedPad) return { thetaJA: Math.round(120 - b * 8), thetaJC: 30 };
      const ja = b <= 2.1 ? 70 : b <= 3.1 ? 50 : b <= 4.1 ? 42 : b <= 5.1 ? 38 : b <= 6.1 ? 32 : b <= 7.1 ? 30 : 26;
      return { thetaJA: ja, thetaJC: b <= 3.1 ? 8 : 4 };
    }
    case 'dfn': {
      const b = Math.min(s.bodyW ?? 3, s.bodyL ?? 3);
      if (!s.exposedPad) return { thetaJA: 150, thetaJC: 40 };
      return { thetaJA: b <= 2.1 ? 80 : b <= 3.1 ? 55 : 45, thetaJC: b <= 2.1 ? 15 : 8 };
    }
    case 'lga':
      return { thetaJA: area <= 9 ? 150 : area <= 16 ? 100 : 70, thetaJC: 40 };
    case 'qfp': {
      const ja = pins <= 32 ? 70 : pins <= 48 ? 60 : pins <= 64 ? 50 : pins <= 100 ? 45 : 38;
      return { thetaJA: ja, thetaJC: s.exposedPad ? 5 : 15 };
    }
    case 'bga':
      return { thetaJA: area <= 25 ? 60 : area <= 100 ? 40 : 28, thetaJC: 10 };
    case 'dip':
      return { thetaJA: pins <= 8 ? 100 : pins <= 16 ? 75 : 55, thetaJC: 40 };
    case 'electrolytic-smd':
    case 'electrolytic-tht':
      return { tjMax: 105 };
    case 'inductor-smd':
      return { thetaJA: Math.round(Math.max(25, 160 - area * 2.5)), tjMax: 125 };
    case 'crystal-smd':
    case 'hc49':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Thermal data (θJA, θJC in °C/W; tjMax in °C) from package family defaults. tjMax comes from a
 * junction-temperature parameter when present (or a discrete's operating range), else 150 °C for
 * discretes, 155 °C for chip resistors and 125 °C for ICs / other parts.
 * Returns undefined for parts without a meaningful thermal model (connectors, fasteners, …).
 */
export function inferThermal(part: PartDef): PartDef['thermal'] {
  if (NO_THERMAL.includes(part.category)) return undefined;
  const fam = familyThermal(part);
  const junction = parseTempRange(paramText(part.params, /junction temperature|operating junction|^tj\b|tj max/i))?.[1] ?? paramNumber(part.params, [/max(imum)? junction/i]);
  const op = parseTempRange(paramText(part.params, /^operating temperature/i))?.[1];
  let tjMax: number | undefined = junction;
  if (tjMax === undefined) {
    if (DISCRETE.includes(part.category)) tjMax = op !== undefined && op >= 100 ? op : part.category === 'led' ? 125 : 150;
    else if (part.category === 'resistor') tjMax = fam?.tjMax ?? 155;
    else if (part.category === 'capacitor-polarized') tjMax = op ?? fam?.tjMax ?? 105;
    else if (part.category === 'capacitor') tjMax = op !== undefined && op >= 85 ? op : 125;
    else tjMax = op !== undefined && op >= 125 ? op : 125;
  }
  const out: Thermal = {};
  if (fam?.thetaJA !== undefined) out.thetaJA = fam.thetaJA;
  if (fam?.thetaJC !== undefined) out.thetaJC = fam.thetaJC;
  if (tjMax !== undefined) out.tjMax = tjMax;
  if (out.thetaJA === undefined && out.thetaJC === undefined) {
    // unknown package: conservative small-IC default
    if (['ic', 'mcu', 'sensor', 'memory', 'logic', 'driver', 'interface', 'opamp', 'comparator', 'ldo', 'dc-dc', 'oscillator'].includes(part.category)) out.thetaJA = 150;
    else if (part.category === 'resistor' || part.category === 'capacitor' || part.category === 'inductor' || part.category === 'ferrite') {
      const size = part.packageSpec?.size;
      if (size && CHIP_SIZES[size]) out.thetaJA = Math.round(((tjMax ?? 125) - 70) / (CHIP_POWER[size] ?? 0.125));
    }
  }
  return Object.keys(out).length ? out : undefined;
}
