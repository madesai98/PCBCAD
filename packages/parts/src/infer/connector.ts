import type { ConnectorSpec, PartDef } from '@pcbcad/core';
import { padPolygonLocal } from '@pcbcad/core';
import { rnd } from '../util/num';
import { paramNumber, paramText, parseQuantity } from './params';

/* --------------------------------------------------------------------------------------------- *
 * Connector inference: family / gender / role / positions / electrical ratings from the MPN,
 * description and parameters; mating direction and enclosure opening from the footprint geometry.
 * Electrical defaults are the series' datasheet ratings (JST PH: 2 A / 100 V, XH: 3 A / 250 V,
 * SH: 1 A / 50 V; USB-C: 3 A VBUS per contact pair (5 A only with e-marked cables), 20 V).
 * --------------------------------------------------------------------------------------------- */

interface SeriesDef {
  family: string;
  pitch: number;
  current: number;
  voltage: number;
  contactR: number;
  cycles: number;
  awg?: [number, number];
}

const SERIES: Record<string, SeriesDef> = {
  PH: { family: 'JST-PH', pitch: 2.0, current: 2, voltage: 100, contactR: 0.02, cycles: 30, awg: [24, 32] },
  XH: { family: 'JST-XH', pitch: 2.5, current: 3, voltage: 250, contactR: 0.01, cycles: 30, awg: [22, 28] },
  SH: { family: 'JST-SH', pitch: 1.0, current: 1, voltage: 50, contactR: 0.02, cycles: 20, awg: [28, 32] },
  ZH: { family: 'JST-ZH', pitch: 1.5, current: 1, voltage: 50, contactR: 0.02, cycles: 30, awg: [26, 32] },
  GH: { family: 'JST-GH', pitch: 1.25, current: 1, voltage: 50, contactR: 0.02, cycles: 50, awg: [26, 30] },
};

const SHELL_NAME = /^(EH|SH|SHIELD|SHELL|MP|MOUNT|MH|GND_SHIELD|S\d*|EH\d*|SH\d*|PAD|CASE|M\d)$/i;

function text(part: PartDef): string {
  return `${part.mpn} | ${part.description} | ${part.package} | ${Object.entries(part.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(' | ')}`;
}

/** Positions from MPN patterns / parameters / package spec / pins. */
function positionsOf(part: PartDef): number | undefined {
  const mpn = part.mpn.toUpperCase();
  let m = /^(?:B|S|SM|BM)(\d{1,2})B-/.exec(mpn) ?? /^(?:PHR|XHP|SHR|ZHR|GHR)-(\d{1,2})/.exec(mpn);
  if (m) return parseInt(m[1], 10);
  const holes = paramText(part.params, /holes structure|pin structure|configuration/i);
  m = holes ? /(\d)\s*[xX*]\s*(\d{1,3})/.exec(holes) : null;
  if (m) return parseInt(m[1], 10) * parseInt(m[2], 10);
  const perRow = paramNumber(part.params, [/number of pins per row/i]);
  const rowsN = paramNumber(part.params, [/number of rows/i]);
  if (perRow) return perRow * (rowsN ?? 1);
  const n = paramNumber(part.params, [/^number of (pins|positions|contacts)/i, /^pins?$/i, /^number of pin/i]);
  if (n) return n;
  m = /(\d)\s*[xX*]\s*(\d{1,3})\s*P/.exec(`${part.description} ${part.mpn}`);
  if (m) return parseInt(m[1], 10) * parseInt(m[2], 10);
  if (part.packageSpec?.pins && part.packageSpec.family !== 'usb-c') return part.packageSpec.pins;
  const signal = part.pins.filter((p) => !SHELL_NAME.test(p.name.trim()) && !SHELL_NAME.test(p.number));
  return signal.length || undefined;
}

function awgRange(part: PartDef): [number, number] | undefined {
  const t = paramText(part.params, /awg|wire gauge|wire size|applicable wire/i);
  const m = t ? /(\d{1,2})\s*[~\-–to]+\s*(\d{1,2})/.exec(t) : null;
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    return [Math.min(a, b), Math.max(a, b)];
  }
  return undefined;
}

function pitchOf(part: PartDef): number | undefined {
  return paramNumber(part.params, [/^pitch/i, /^spacing/i]) ?? part.packageSpec?.pitch ?? parseQuantity(/P\s*=\s*([\d.]+\s*mm)/i.exec(part.package)?.[1]);
}

interface Geometry {
  dir?: ConnectorSpec['matingDirection'];
  width?: number;
}

/** Mating direction from the footprint: the body extends past the signal contacts toward the mating face. */
function geometry(part: PartDef, positions: number | undefined, vertical: boolean): Geometry {
  const fp = part.footprint;
  if (!fp || !fp.pads.length) return {};
  const shellNums = new Set(part.pins.filter((p) => SHELL_NAME.test(p.name.trim())).map((p) => p.number));
  const sig = fp.pads.filter((p) => {
    if (p.kind === 'npth' || !p.number || p.number === 'MP' || shellNums.has(p.number) || SHELL_NAME.test(p.number)) return false;
    const n = Number(p.number);
    return !(positions && Number.isInteger(n) && n > positions);
  });
  if (!sig.length) return {};
  const cx = sig.reduce((a, p) => a + p.x, 0) / sig.length;
  const cy = sig.reduce((a, p) => a + p.y, 0) / sig.length;
  const c = fp.courtyard;
  const bx = (c.minX + c.maxX) / 2;
  const by = (c.minY + c.maxY) / 2;
  const dx = bx - cx;
  const dy = by - cy;
  if (vertical) return { dir: '+z', width: c.maxX - c.minX };
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 0.3) return {};
  // signal pads spread along one axis: the mating face is perpendicular to it
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of sig) {
    for (const [x, y] of padPolygonLocal(p, 8)) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const rowAlongX = maxX - minX >= maxY - minY;
  const dir: ConnectorSpec['matingDirection'] = rowAlongX ? (dy < 0 ? '-y' : '+y') : dx < 0 ? '-x' : '+x';
  const margin = 0.25;
  const width = rowAlongX ? c.maxX - c.minX - 2 * margin : c.maxY - c.minY - 2 * margin;
  return { dir, width };
}

/**
 * Infer a ConnectorSpec (family, gender, role, positions, ratings, mates, mating direction and
 * enclosure opening). Returns undefined for parts that are not connectors.
 */
export function inferConnectorSpec(part: PartDef): ConnectorSpec | undefined {
  const t = text(part);
  const T = t.toUpperCase();
  const mpn = part.mpn.toUpperCase();
  if (!['connector', 'cable'].includes(part.category) && !/CONNECTOR|HEADER|RECEPTACLE|TERMINAL BLOCK|HOUSING/.test(T)) return undefined;
  const positions = positionsOf(part);
  let family = '';
  let gender: ConnectorSpec['gender'] = 'genderless';
  let role: ConnectorSpec['role'] = 'board';
  let current = 1;
  let voltage: number | undefined;
  let contactR = 0.03;
  let cycles: number | undefined;
  let awg: [number, number] | undefined;
  let matesWith: string[] = [];
  let pitch = pitchOf(part);
  let vertical = /VERTICAL|TOP ENTRY|STRAIGHT|立贴/.test(T) || part.packageSpec?.orientation === 'vertical';
  let opening: ConnectorSpec['opening'];

  const jstBoard = /^(B|S|SM|BM)(\d{1,2})B-(PH|XH|SR|ZR|GH)/.exec(mpn);
  const jstHousing = /^(PHR|XHP|SHR|ZHR|GHR)-(\d{1,2})/.exec(mpn);
  const jstContact = /^(SPH|SXH|SSH|SZH|SSHL)-/.exec(mpn);
  const seriesFromText = /REFERENCE SERIES=(PH|XH|SH|ZH|GH)\b/.exec(T)?.[1];
  if (jstBoard || jstHousing || jstContact || seriesFromText) {
    const BOARD: Record<string, string> = { PH: 'PH', XH: 'XH', SR: 'SH', ZR: 'ZH', GH: 'GH' };
    const HOUSING: Record<string, string> = { PHR: 'PH', XHP: 'XH', SHR: 'SH', ZHR: 'ZH', GHR: 'GH' };
    const CONTACT: Record<string, string> = { SPH: 'PH', SXH: 'XH', SSH: 'SH', SZH: 'ZH', SSHL: 'GH' };
    const k = jstBoard ? BOARD[jstBoard[3]] : jstHousing ? HOUSING[jstHousing[1]] : jstContact ? CONTACT[jstContact[1]] : (seriesFromText ?? 'PH');
    const sd = SERIES[k] ?? SERIES.PH;
    family = sd.family;
    pitch = sd.pitch;
    current = sd.current;
    voltage = sd.voltage;
    contactR = sd.contactR;
    cycles = sd.cycles;
    const n = positions ?? 0;
    const housing: Record<string, string> = { PH: 'PHR', XH: 'XHP', SH: 'SHR', ZH: 'ZHR', GH: 'GHR' };
    if (jstHousing || jstContact || /HOUSING|CRIMP/.test(T)) {
      role = 'cable';
      gender = 'female';
      awg = sd.awg;
      matesWith = [`${family}:male`];
      if (jstHousing && n) matesWith.push(`B${n}B-${k}`, `S${n}B-${k}`);
    } else {
      gender = 'male';
      matesWith = [`${family}:female`];
      if (n) matesWith.push(`${housing[k] ?? 'PHR'}-${n}`);
      vertical = jstBoard ? jstBoard[1] === 'B' || jstBoard[1] === 'BM' : vertical;
    }
  } else if (/TYPE-?C|USB-?C\b|USB 3\.\d TYPE C|USB_C/.test(T) || part.packageSpec?.family === 'usb-c') {
    family = 'USB-C';
    const plug = /\bPLUG\b|\bMALE\b/.test(T) && !/FEMALE|RECEPTACLE/.test(T);
    gender = plug ? 'male' : 'female';
    matesWith = [plug ? 'USB-C:female' : 'USB-C:male'];
    current = 3;
    voltage = 20;
    contactR = 0.04;
    cycles = 10000;
    vertical = /VERTICAL|立贴/.test(T);
  } else if (/MICRO-?USB|MICRO USB|MICRO-?B\b|MICRO_USB|USB-?MICRO/.test(T) || part.packageSpec?.family === 'usb-micro') {
    family = 'USB-Micro-B';
    gender = 'female';
    matesWith = ['USB-Micro-B:male'];
    current = 1.8;
    voltage = 30;
    contactR = 0.03;
    cycles = 10000;
  } else if (/USB-?A\b|TYPE-?A\b|USB A /.test(T)) {
    family = 'USB-A';
    gender = /\bPLUG\b|\bMALE\b/.test(T) && !/FEMALE/.test(T) ? 'male' : 'female';
    matesWith = [gender === 'female' ? 'USB-A:male' : 'USB-A:female'];
    current = 1.5;
    voltage = 30;
    contactR = 0.03;
    cycles = 1500;
  } else if (/SCREW TERMINAL|TERMINAL BLOCK|BARRIER/.test(T) && !/PLUGGABLE/.test(T)) {
    pitch ??= 5.08;
    family = `TerminalBlock-${rnd(pitch, 2)}`;
    gender = 'genderless';
    matesWith = ['wire'];
    current = 10;
    voltage = 250;
    contactR = 0.005;
    awg = awgRange(part) ?? (pitch >= 4.9 ? [12, 26] : [16, 28]);
  } else if (/PLUGGABLE/.test(T)) {
    pitch ??= 3.81;
    family = `Pluggable-${rnd(pitch, 2)}`;
    gender = /MALE PLUG|\bPLUG\b/.test(T) && !/FEMALE/.test(T) ? 'male' : 'female';
    matesWith = [`${family}:${gender === 'male' ? 'female' : 'male'}`];
    current = 8;
    voltage = 300;
    contactR = 0.005;
    awg = awgRange(part);
  } else if (/FEMALE HEADER|PIN SOCKET|FEMALE HEADERS|SOCKET STRIP|RECEPTACLE/.test(T) || part.packageSpec?.extra?.gender === 'female') {
    pitch ??= 2.54;
    family = `Header-${rnd(pitch, 2)}`;
    gender = 'female';
    matesWith = [`${family}:male`];
    current = pitch >= 2.5 ? 3 : pitch >= 2 ? 2 : 1;
    voltage = pitch >= 2 ? 250 : 100;
    contactR = 0.02;
  } else if (/PIN HEADER|HEADERS|PIN STRIP|HDR|BOX HEADER|IDC/.test(T) || part.packageSpec?.family === 'header') {
    pitch ??= 2.54;
    family = /IDC|BOX HEADER/.test(T) ? `IDC-${rnd(pitch, 2)}` : `Header-${rnd(pitch, 2)}`;
    gender = 'male';
    matesWith = [`${family}:female`];
    if (family.startsWith('Header-2.54')) matesWith.push('Dupont');
    current = pitch >= 2.5 ? 3 : pitch >= 2 ? 2 : 1;
    voltage = pitch >= 2 ? 250 : 100;
    contactR = 0.02;
  } else {
    // generic wire-to-board / board-to-board connector
    const series = paramText(part.params, /reference series|series/i);
    family = series ? `${series}${pitch ? `-${rnd(pitch, 2)}` : ''}` : pitch ? `WTB-P${rnd(pitch, 2)}` : 'Generic';
    if (/HOUSING|CRIMP/.test(T)) {
      role = 'cable';
      gender = 'female';
    } else if (/FEMALE|SOCKET|RECEPTACLE/.test(T)) gender = 'female';
    else if (/MALE|PLUG|PIN|HEADER|WAFER/.test(T)) gender = 'male';
    matesWith = [`${family}:${gender === 'male' ? 'female' : gender === 'female' ? 'male' : 'genderless'}`];
  }

  // datasheet parameters override series defaults
  current = paramNumber(part.params, [/current rating|rated current|contact current|^current\b/i]) ?? current;
  voltage = paramNumber(part.params, [/voltage rating|rated voltage|^voltage\b/i]) ?? voltage;
  contactR = paramNumber(part.params, [/contact resistance/i]) ?? contactR;
  cycles = paramNumber(part.params, [/mating cycles|durability|mechanical life|insertion/i]) ?? cycles;
  awg = awgRange(part) ?? awg;

  const geo = role === 'board' ? geometry(part, positions, vertical) : {};
  let dir = geo.dir;
  if (!dir && role === 'board') {
    if (vertical) dir = '+z';
    else if (family === 'USB-C' || family === 'USB-Micro-B') dir = '-y';
  }
  if (dir && dir !== '+z' && role === 'board') {
    const spec = part.packageSpec;
    const h = part.body?.h ?? spec?.bodyH;
    const w = family === 'USB-C' ? (spec?.bodyW ?? 8.94) : (geo.width ?? spec?.bodyW);
    if (h && w) opening = { width: rnd(w + 0.6, 2), height: rnd(h + 0.6, 2), zCenter: rnd(h / 2, 3) };
  }

  const spec: ConnectorSpec = {
    family,
    gender,
    role,
    positions: positions ?? part.pins.length,
    matesWith,
    contactResistance: contactR,
    currentRating: current,
    configuredBy: 'builtin',
  };
  if (pitch !== undefined) spec.pitch = rnd(pitch, 3);
  if (voltage !== undefined) spec.voltageRating = voltage;
  if (cycles !== undefined) spec.matingCycles = cycles;
  if (awg) spec.awgRange = awg;
  if (dir && role === 'board') spec.matingDirection = dir;
  if (opening) spec.opening = opening;
  return spec;
}
