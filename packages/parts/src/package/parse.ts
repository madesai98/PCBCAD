import type { PackageFamily, PackageSpec, PartCategory } from '@pcbcad/core';
import { rnd } from '../util/num';
import { CHIP_SIZES, CRYSTAL_SIZES, METRIC_CHIP, chipSizeFromDims, completeSpec } from './defaults';

/** Extra hints that disambiguate distributor package strings. */
export interface PackageContext {
  /** Pin/pad count from the symbol or distributor attributes (may include an exposed pad). */
  pins?: number;
  mpn?: string;
  description?: string;
  category?: PartCategory;
}

interface Dims {
  /** EasyEDA style L/W/H/P/LS tokens (e.g. 'SOP-16_L10.0-W3.9-P1.27-LS6.0'). */
  L?: number;
  W?: number;
  H?: number;
  P?: number;
  LS?: number;
  /** "(5x5)", "_3.9x9.9mm", "SMD,6x6mm" style: a × b (× c). */
  ab?: [number, number, number?];
  /** Electrolytic "D6.3xL7.7". */
  D?: number;
  DL?: number;
  /** "P=2.54mm". */
  pitchEq?: number;
}

const NUM = '(\\d+(?:\\.\\d+)?)';

function normalise(pkg: string): string {
  return pkg
    .replace(/插件|直插/g, 'PLUGIN')
    .replace(/弯插/g, 'PLUGIN-RA')
    .replace(/卧贴/g, 'SMD-RA')
    .replace(/立贴/g, 'SMD-V')
    .replace(/贴片/g, 'SMD')
    .replace(/[，、]/g, ',')
    .replace(/[×*]/g, 'X')
    .replace(/Φ|φ|∅/g, 'D')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDims(s: string): Dims {
  const d: Dims = {};
  const tok = (re: RegExp) => {
    const m = re.exec(s);
    return m ? parseFloat(m[1]) : undefined;
  };
  d.L = tok(new RegExp(`(?:^|[_\\-])L${NUM}(?=[_\\-]|$)`));
  d.W = tok(new RegExp(`(?:^|[_\\-])W${NUM}(?=[_\\-]|$)`));
  d.H = tok(new RegExp(`(?:^|[_\\-])H${NUM}(?=[_\\-]|$)`));
  d.P = tok(new RegExp(`(?:^|[_\\-])P${NUM}(?=[_\\-]|$|MM)`));
  d.LS = tok(new RegExp(`(?:^|[_\\-])LS${NUM}(?=[_\\-]|$)`));
  d.pitchEq = tok(new RegExp(`P\\s*=\\s*${NUM}`));
  const dl = new RegExp(`D${NUM}\\s*X\\s*L?${NUM}`).exec(s);
  if (dl) {
    d.D = parseFloat(dl[1]);
    d.DL = parseFloat(dl[2]);
  } else {
    const dOnly = new RegExp(`(?:^|[,_\\s(-])D${NUM}(?:MM)?(?=$|[,_\\s)-])`).exec(s);
    if (dOnly) d.D = parseFloat(dOnly[1]);
  }
  const ab =
    new RegExp(`\\(${NUM}X${NUM}(?:X${NUM})?\\)`).exec(s) ??
    new RegExp(`(?:^|[_,\\s-])${NUM}X${NUM}(?:X${NUM})?\\s*MM`).exec(s) ??
    new RegExp(`(?:^|[_,\\s-])${NUM}X${NUM}(?:X${NUM})?(?=$|[_,\\s)-])`).exec(s);
  if (ab && !/^\d+X\d+P$/.test(ab[0].trim())) {
    d.ab = [parseFloat(ab[1]), parseFloat(ab[2]), ab[3] ? parseFloat(ab[3]) : undefined];
  }
  return d;
}

/** Pin count following a family keyword, e.g. 'SOIC-8' → 8, 'QFN52' → 52. */
function countAfter(s: string, kw: string): number | undefined {
  const m = new RegExp(`${kw}-?(\\d{1,4})(?!\\.\\d)`).exec(s);
  return m ? parseInt(m[1], 10) : undefined;
}

/** "1X4P" / "2X5P" / "1*40P" → { rows, cols }. */
function rowsCols(...texts: string[]): { rows: number; cols: number } | undefined {
  for (const t of texts) {
    const m = /(?:^|[^\d.])(\d)\s*X\s*(\d{1,3})\s*P/i.exec(t);
    if (m) return { rows: parseInt(m[1], 10), cols: parseInt(m[2], 10) };
  }
  return undefined;
}

/** "4P" / "16PIN" / "4-PIN" in free text. */
function pinsInText(...texts: string[]): number | undefined {
  for (const t of texts) {
    const m = /(?:^|[^\dX.])(\d{1,3})\s*-?\s*(?:P|PIN|PINS|POS|POSITIONS|WAY)\b/i.exec(t);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

function spec(family: PackageFamily, fields: Partial<PackageSpec> = {}, extra?: Record<string, string | number | boolean>): PackageSpec {
  const s: PackageSpec = { family, ...fields };
  if (extra && Object.keys(extra).length) s.extra = { ...(s.extra ?? {}), ...extra };
  return completeSpec(s);
}

const POLARIZED: PartCategory[] = ['diode', 'zener', 'schottky', 'tvs', 'led', 'capacitor-polarized'];

function polarity(ctx: PackageContext): Record<string, boolean> {
  return ctx.category && POLARIZED.includes(ctx.category) ? { polarized: true } : {};
}

const PASSIVE: PartCategory[] = ['resistor', 'capacitor', 'capacitor-polarized', 'inductor', 'ferrite', 'led', 'fuse', 'diode'];

/**
 * Parse a distributor / EasyEDA package name into a parametric PackageSpec.
 * Returns undefined when the string does not identify a supported package.
 *
 * Handles e.g. '0805', 'R0603', 'SOT-23-5', 'SOT-223', 'SOD-123F', 'SMA(DO-214AC)', 'SOIC-8',
 * 'SOIC-16_3.9x9.9mm', 'TSSOP-20', 'MSOP-10', 'QFN-32(5x5)', 'LQFN-56_L7.0-W7.0-P0.4-EP',
 * 'DFN-8(3x3)', 'LGA-8(2.5x2.5)', 'TQFP-32(7x7)', 'DIP-8', 'TO-92', 'TO-252-2(DPAK)',
 * 'Plugin,P=2mm' (+MPN B4B-PH-K-S), 'Plugin,P=2.54mm' (+'1x4P'), 'SMD3225-4P',
 * 'SMD,D6.3xL7.7mm', 'SMD-4P,6x6mm', 'HC-49US', USB-C / micro-USB receptacles.
 */
export function parsePackageName(pkg: string, ctx: PackageContext = {}): PackageSpec | undefined {
  if (typeof pkg !== 'string') return undefined;
  const s = normalise(pkg);
  const mpn = (ctx.mpn ?? '').toUpperCase().trim();
  const desc = normalise(ctx.description ?? '');
  const cat = ctx.category;
  const all = `${s} | ${mpn} | ${desc}`;
  const d = parseDims(s);
  const pol = polarity(ctx);
  const isConn = cat === 'connector' || /CONNECTOR|HEADER|RECEPTACLE|HOUSING|WIRE TO BOARD|TERMINAL/.test(desc);

  // ----------------------------------------------------------------- connectors (MPN driven)
  const jst = /^(B|S|SM|BM)(\d{1,2})B-(PH|XH|SR|SH|ZR|GH)/.exec(mpn);
  if (jst) {
    const n = parseInt(jst[2], 10);
    const series = jst[3];
    const smd = jst[1] === 'SM' || jst[1] === 'BM' || /-SM\d|-TB\b|-T\b/.test(mpn);
    const side = jst[1] === 'S' || jst[1] === 'SM';
    const orientation = side ? 'right-angle' : 'vertical';
    if (series === 'PH') return spec('jst-ph', { pins: n, pitch: 2.0, orientation }, { smd });
    if (series === 'XH') return spec('jst-xh', { pins: n, pitch: 2.5, orientation }, { smd });
    if (series === 'SR' || series === 'SH') return spec('jst-sh', { pins: n, pitch: 1.0, orientation }, { smd: true });
    if (series === 'GH') return spec('jst-sh', { pins: n, pitch: 1.25, orientation }, { smd: true, series: 'GH' });
    if (series === 'ZR') return spec('jst-sh', { pins: n, pitch: 1.5, orientation }, { smd, series: 'ZH' });
  }
  if (/TYPE-?C|USB-?C\b|USB_C|USB 3\.\d TYPE C|USB3\.1/.test(all) && (isConn || /USB/.test(s) || !cat)) {
    const n = ctx.pins && [6, 12, 14, 16, 24].includes(ctx.pins) ? ctx.pins : (pinsInText(desc, s) ?? 16);
    return spec('usb-c', { pins: [6, 16, 24].includes(n) ? n : 16 });
  }
  if (/MICRO-?USB|MICRO USB|MICROUSB|MICRO-?B\b|MICRO_USB|USB-?MICRO/.test(all)) return spec('usb-micro', { pins: 5 });
  if (/CR2032|CR2025|CR2016|CR1220|BATTERY HOLDER|BAT-HLD|COIN CELL HOLDER/.test(all) || (cat === 'battery' && /SMD|PLUGIN/.test(s))) {
    const cell = /CR(\d{4})/.exec(all)?.[0] ?? 'CR2032';
    const small = /CR1[0-2]\d\d/.test(cell);
    return spec('battery-holder', small ? { bodyW: 15, bodyL: 13, bodyH: 4 } : {}, { cell, smd: !/PLUGIN|THT/.test(s) });
  }

  // ----------------------------------------------------------------- chip passives
  const chipM = /^(?:(?:R|C|L|D|F|FB|LED|CAP|RES|IND|LED-SMD)[_-]?)?(01005|0201|0402|0603|0805|1008|1206|1210|1812|2010|2220|2512|1005|1608|2012|3216|3225|4532|5025|6332)(?:[_-]|\b|$)/.exec(s);
  if (chipM && !/SMD\d{4}-\dP|CRYSTAL|XTAL|OSC/.test(s) && !(cat === 'crystal' || cat === 'oscillator')) {
    let code = chipM[1];
    const metricOnly = ['1005', '1608', '2012', '3216', '3225', '4532', '5025', '6332'].includes(code);
    if (metricOnly) {
      const passive = cat ? PASSIVE.includes(cat) : !/^3225$/.test(code);
      if (!passive) code = '';
      else code = METRIC_CHIP[code];
    }
    if (code && CHIP_SIZES[code]) return spec('chip', { size: code, pins: 2 }, pol);
  }
  if (/LED-SMD|^LED[_-]|^(R|C|L)[_-]?SMD/.test(s) && d.L && d.W) {
    const code = chipSizeFromDims(d.L, d.W);
    if (code) return spec('chip', { size: code, pins: 2 }, pol);
  }

  // ----------------------------------------------------------------- crystals
  const xtal = /(?:SMD|X|XTAL|CRYSTAL|OSC)?[_-]?(1612|2016|2520|3225|5032|6035|7050)(?:[_-](\d)P)?/.exec(s);
  if (xtal && (cat === 'crystal' || cat === 'oscillator' || /SMD\d{4}|CRYSTAL|XTAL|OSC|-\dP/.test(s) || /^\d{4}$/.test(s))) {
    const pins = xtal[2] ? parseInt(xtal[2], 10) : ctx.pins === 2 ? 2 : 4;
    const size = xtal[1];
    if (CRYSTAL_SIZES[size]) return spec('crystal-smd', { size, pins }, { oscillator: cat === 'oscillator' });
  }
  if (/CRYSTAL-SMD|XTAL-SMD|OSC-SMD/.test(s) && d.L && d.W) {
    const pins = /(\d)P/.exec(s) ? parseInt(/(\d)P/.exec(s)![1], 10) : 4;
    return spec('crystal-smd', { size: nearestCrystal(d.L, d.W), bodyW: d.L, bodyL: d.W, pins });
  }
  if (/HC-?49/.test(s)) {
    if (/SMD|SMT/.test(s)) return spec('crystal-smd', { size: '5032', bodyW: 11.4, bodyL: 4.7, bodyH: 4.2, pins: 2 }, { variant: 'hc49smd' });
    const tall = /HC-?49\/?U(?!S)/.test(s);
    return spec('hc49', { pins: 2 }, { variant: tall ? 'hc49u' : 'hc49s' });
  }

  // ----------------------------------------------------------------- discretes
  if (/SOD-?123/.test(s)) return spec('sod123', dimsFor2Term(d), { ...pol, flat: /123F/.test(s) });
  if (/SOD-?323|SOD-?523|SC-?76|SC-?90/.test(s)) return spec('sod323', dimsFor2Term(d), pol);
  if (/MINIMELF|MINI-MELF|SOD-?80|LL-?34|DO-?213AA/.test(s)) return spec('melf', {}, { ...pol, variant: 'minimelf' });
  if (/\bMELF\b|LL-?41|DO-?213AB/.test(s)) return spec('melf', { bodyW: 5.0, bodyL: 2.5 }, { ...pol, variant: 'melf' });
  if (!isConn) {
    if (/^SMAF?\b|DO-?214AC|^SMA[_(-]|SMA\(DO/.test(s)) return spec('sma', dimsFor2Term(d), pol);
    if (/^SMBF?\b|DO-?214AA|^SMB[_(-]/.test(s)) return spec('smb', dimsFor2Term(d), pol);
    if (/^SMCF?\b|DO-?214AB|^SMC[_(-]/.test(s)) return spec('smc', dimsFor2Term(d), pol);
  }
  const sot23 = /SOT-?23(?:-(\d))?(?!\d)|TO-?236|SC-?59|SOT-?346|SOT-?25\b|SOT-?26\b|SOT-?753|SOT-?457/.exec(s);
  if (sot23) {
    let pins = sot23[1] ? parseInt(sot23[1], 10) : /SOT-?25\b|SOT-?753/.test(s) ? 5 : /SOT-?26\b|SOT-?457/.test(s) ? 6 : 3;
    if (!sot23[1] && ctx.pins && [5, 6, 8].includes(ctx.pins) && /SOT-?23/.test(s)) pins = ctx.pins;
    return spec('sot23', { pins, bodyW: d.W, bodyL: d.L, leadSpan: d.LS }, {});
  }
  if (/SC-?70|SOT-?323|SOT-?363|SC-?88|SOT-?353|US6|SC-?70-?\d/.test(s)) {
    const n = countAfter(s, 'SC-?70') ?? (/SOT-?363|SC-?88|US6/.test(s) ? 6 : /SOT-?353/.test(s) ? 5 : 3);
    return spec('sot23', { pins: n }, { variant: 'sc70' });
  }
  if (/SOT-?223/.test(s)) {
    const n = countAfter(s, 'SOT-?223');
    const pins = n === 5 || n === 6 ? n + 1 : 4;
    return spec('sot223', { pins, bodyW: d.W, bodyL: d.L, leadSpan: d.LS });
  }
  if (/SOT-?89/.test(s)) return spec('sot89', { pins: 3 });
  if (/TO-?252|DPAK|D-PAK/.test(s) && !/D2PAK/.test(s)) {
    const n = countAfter(s, 'TO-?252');
    return spec('to252', { pins: n === 5 ? 5 : 3 }, { leads: n === 5 ? 5 : n === 3 ? 3 : 2 });
  }
  if (/TO-?263|D2PAK|D2-PAK/.test(s)) {
    const n = countAfter(s, 'TO-?263');
    return spec('to252', { pins: n === 5 ? 5 : n === 7 ? 7 : 3 }, { variant: 'd2pak', leads: n && n > 3 ? n : 2 });
  }
  if (/TO-?220|TO-?247|TO-?3P/.test(s)) {
    const n = countAfter(s, 'TO-?220') ?? 3;
    return spec('to220', { pins: n >= 2 && n <= 7 ? n : 3, orientation: /-H\b|HORIZ/.test(s) ? 'horizontal' : 'vertical' });
  }
  if (/TO-?92/.test(s)) {
    const n = countAfter(s, 'TO-?92') ?? 3;
    return spec('to92', { pins: n === 2 ? 2 : 3 }, { variant: /TO-?92S/.test(s) ? 'to92s' : 'to92' });
  }

  // ----------------------------------------------------------------- leaded ICs
  const qfpM = /(?:L|T|M|V|H|P|E|C)?QFP-?(\d{2,3})/.exec(s);
  if (qfpM) {
    const pins = parseInt(qfpM[1], 10);
    const body = d.ab ?? (d.L && d.W ? [d.L, d.W] : undefined);
    return spec('qfp', { pins, bodyW: body?.[0], bodyL: body?.[1], pitch: d.P, leadSpan: d.LS }, { variant: /TQFP/.test(s) ? 'tqfp' : 'lqfp' });
  }
  const tssopM = /(?:H|E)?TSSOP-?(\d{1,2})/.exec(s);
  if (tssopM) {
    const pins = parseInt(tssopM[1], 10);
    return spec('tssop', withEP({ pins, pitch: d.P, leadSpan: d.LS, ...rowDims(d) }, s, pins), {});
  }
  const msopM = /(?:MSOP|VSSOP|HVSSOP|MSO|UMAX|ΜMAX|MICROMAX)-?(\d{1,2})/.exec(s);
  if (msopM) {
    const pins = parseInt(msopM[1], 10);
    return spec('msop', withEP({ pins, pitch: d.P, leadSpan: d.LS, ...rowDims(d) }, s, pins));
  }
  const ssopM = /(QSOP|SSOP)-?(\d{1,2})/.exec(s);
  if (ssopM) {
    const pins = parseInt(ssopM[2], 10);
    return spec('ssop', { pins, pitch: d.P, leadSpan: d.LS, ...rowDims(d) }, ssopM[1] === 'QSOP' ? { variant: 'qsop' } : {});
  }
  const soicM = /(?:^|[^A-Z])(?:E|H|P)?(SOIC|SOP|SO)-?(\d{1,2})(W)?/.exec(s);
  if (soicM && !/SOD|SOT/.test(soicM[0])) {
    const pins = parseInt(soicM[2], 10);
    const rd = rowDims(d);
    const wide = soicM[3] === 'W' || /300MIL|7\.5MM|WIDE|-W\b|7\.5X/.test(s) || (rd.bodyW !== undefined && rd.bodyW > 6.5);
    const eiaj = /208MIL|5\.3MM|5\.3X|EIAJ/.test(s) || (rd.bodyW !== undefined && rd.bodyW > 4.6 && rd.bodyW <= 6.5);
    return spec('soic', withEP({ pins, pitch: d.P, leadSpan: d.LS, ...rd }, s, pins), wide ? { variant: 'wide' } : eiaj ? { variant: 'eiaj' } : {});
  }

  // ----------------------------------------------------------------- no-lead / array
  const lgaM = /LGA-?(\d{1,3})/.exec(s);
  if (lgaM) {
    const pins = parseInt(lgaM[1], 10);
    const body = d.ab ?? (d.L && d.W ? [d.W, d.L] : undefined);
    return spec('lga', { pins, bodyW: body?.[0], bodyL: body?.[1], pitch: d.P });
  }
  const dfnM = /(?:T|U|W|X|V|P)?(?:DFN|SON)-?(\d{1,2})|MLF-?(\d{1,2})(?=\D|$)/.exec(s);
  const qfnM = /(?:V|W|U|X|T|L|H)?QFN-?(\d{1,3})|LFCSP-?(\d{1,3})|MLF-?(\d{2,3})/.exec(s);
  if (dfnM && !(qfnM && /QFN/.test(qfnM[0]))) {
    const pins = parseInt(dfnM[1] ?? dfnM[2], 10);
    if (!dfnM[2] || pins <= 12) {
      const body = d.ab ?? (d.L && d.W ? [d.W, d.L] : undefined);
      return spec('dfn', { pins, bodyW: body?.[0], bodyL: body?.[1], pitch: d.P }, epFlag(s, ctx, pins, true));
    }
  }
  if (qfnM) {
    const pins = parseInt(qfnM[1] ?? qfnM[2] ?? qfnM[3], 10);
    const body = d.ab ?? (d.L && d.W ? [d.W, d.L] : undefined);
    const ep = epFlag(s, ctx, pins, true);
    return spec('qfn', { pins, bodyW: body?.[0], bodyL: body?.[1], pitch: d.P, bodyH: d.H }, { ...ep, ...(/WQFN/.test(s) ? { variant: 'wqfn' } : {}) });
  }
  const bgaM = /(?:FBGA|TFBGA|LFBGA|BGA|DSBGA|WLCSP|CSP|WLP|UCSP)-?(\d{1,4})/.exec(s);
  if (bgaM) {
    const pins = parseInt(bgaM[1], 10);
    const wl = /WLCSP|DSBGA|WLP|UCSP|^CSP/.test(s);
    return spec('bga', { pins, pitch: d.P ?? (wl ? 0.4 : undefined), bodyW: d.ab?.[0], bodyL: d.ab?.[1] });
  }
  const dipM = /(?:P|C)?DIP-?(\d{1,2})|DIL-?(\d{1,2})/.exec(s);
  if (dipM) {
    const pins = parseInt(dipM[1] ?? dipM[2], 10);
    return spec('dip', { pins }, /600MIL|15\.24|-W\b|WIDE/.test(s) ? { variant: 'wide' } : {});
  }

  // ----------------------------------------------------------------- electrolytics / round parts
  if (d.D !== undefined && d.DL !== undefined && (cat === 'capacitor-polarized' || cat === 'capacitor' || !cat)) {
    const smd = /SMD|SMT/.test(s) && !/PLUGIN|TH\b|RADIAL/.test(s);
    return spec(smd ? 'electrolytic-smd' : 'electrolytic-tht', { bodyH: d.DL }, { diameter: d.D, polarized: true });
  }
  if (cat === 'led' && /PLUGIN|TH\b|DIP|THT|LED-TH/.test(s)) {
    const dia = d.D ?? (/(\d)MM/.exec(s) ? parseInt(/(\d)MM/.exec(s)![1], 10) : 5);
    return spec('led-tht', {}, { diameter: dia === 3 ? 3 : 5, polarized: true });
  }

  // ----------------------------------------------------------------- connectors (string / description driven)
  const pitch = d.pitchEq ?? d.P;
  if (isConn || /HDR|HEADER/.test(s)) {
    const rc = rowsCols(desc, s, mpn);
    const n = ctx.pins ?? (rc ? rc.rows * rc.cols : (pinsInText(desc, s) ?? countAfter(s, 'HDR-(?:TH|SMD)_')));
    const ra = /RIGHT ANGLE|PLUGIN-RA|SMD-RA|\b-H\b|HORIZONTAL|SIDE ENTRY|90°|-RA\b|_H_|-H-/.test(all);
    const smd = /^SMD|SMD,|SMD-|SURFACE MOUNT/.test(s) || /SURFACE MOUNT/.test(desc);
    if (/TERMINAL|SCREW|PLUGGABLE/.test(desc) || /^(KF|DB\d|WJ\d|XY\d|MX\d|JL\d|DG\d)/.test(mpn)) {
      return spec('terminal-block', { pins: n ?? 2, pitch: pitch ?? 5.08 }, {});
    }
    if (pitch !== undefined) {
      const series = /\bPH\b/.test(desc) ? 'PH' : /\bXH\b/.test(desc) ? 'XH' : /\bSH\b|\bSR\b/.test(desc) ? 'SH' : '';
      if ((series === 'PH' || /^PH|PHB|A2001W/.test(mpn)) && Math.abs(pitch - 2.0) < 0.01) return spec('jst-ph', { pins: n ?? 2, pitch: 2.0, orientation: ra ? 'right-angle' : 'vertical' }, { smd });
      if ((series === 'XH' || /^XH|A2501W/.test(mpn)) && Math.abs(pitch - 2.5) < 0.05) return spec('jst-xh', { pins: n ?? 2, pitch: 2.5, orientation: ra ? 'right-angle' : 'vertical' }, { smd });
      if ((series === 'SH' || /^SH|A1001W/.test(mpn)) && Math.abs(pitch - 1.0) < 0.01) return spec('jst-sh', { pins: n ?? 4, pitch: 1.0, orientation: ra ? 'right-angle' : 'vertical' }, { smd: true });
      if ([2.54, 2.0, 1.27].some((p) => Math.abs(p - pitch) < 0.02) || /HEADER|HDR/.test(all)) {
        const rows = rc?.rows ?? (/2X|DOUBLE|DUAL ROW/.test(all) ? 2 : 1);
        const female = /FEMALE|SOCKET|RECEPTACLE/.test(all) && !/MALE PIN/.test(all);
        return spec('header', { pins: n ?? rows * 4, pitch, rows, orientation: ra ? 'right-angle' : 'vertical' }, { gender: female ? 'female' : 'male', smd });
      }
    }
    if (/HDR|HEADER/.test(s)) {
      const p = d.P ?? 2.54;
      const rows = rc?.rows ?? (/2X/.test(s) ? 2 : 1);
      const np = ctx.pins ?? countAfter(s, 'HDR-(?:TH|SMD)_') ?? (rc ? rc.rows * rc.cols : undefined);
      return spec('header', { pins: np ?? 4, pitch: p, rows, orientation: /-H\b|_H\b|-RA/.test(s) ? 'right-angle' : 'vertical' }, { gender: /FEMALE|-F\b|_F\b/.test(s) ? 'female' : 'male' });
    }
  }

  // ----------------------------------------------------------------- switches / inductors / modules
  if (cat === 'button' || cat === 'switch' || /^KEY-|TACTILE|TACT/.test(s)) {
    const sz = d.ab ?? (d.L && d.W ? [d.L, d.W] : undefined);
    if (sz) {
      const smd = !/PLUGIN|TH\b|THT|DIP/.test(s);
      return spec('tactile-switch', { bodyW: sz[0], bodyL: sz[1], bodyH: sz[2] ?? d.H, pitch: d.P, leadSpan: d.LS }, { smd });
    }
  }
  if (cat === 'inductor' || cat === 'ferrite' || /^IND-SMD|^CD\d{2}\b|POWER INDUCTOR/.test(s)) {
    const cd = /^CD(\d)(\d)\b/.exec(s);
    if (cd) {
      const table: Record<string, [number, number, number]> = { '32': [4.1, 3.6, 2.0], '43': [4.8, 4.3, 3.2], '54': [5.8, 5.2, 4.5], '75': [7.8, 7.0, 5.0], '105': [10, 9, 5.4] };
      const t = table[`${cd[1]}${cd[2]}`];
      if (t) return spec('inductor-smd', { bodyW: t[0], bodyL: t[1], bodyH: t[2] });
    }
    const sz = d.ab ?? (d.L && d.W ? [d.L, d.W, d.H] : undefined);
    if (sz && /SMD|IND/.test(s)) return spec('inductor-smd', { bodyW: sz[0], bodyL: sz[1], bodyH: sz[2] });
  }
  if (cat === 'module' || cat === 'rf-module' || /^WIFIM|^BTM|^RFM|MODULE/.test(s)) {
    if (/ESP32-(WROOM|WROVER)/.test(mpn) || /ESP32-WROOM|ESP32-WROVER/.test(s)) {
      return spec('module', { pins: 38, pitch: 1.27, bodyW: 18, bodyL: 25.5, bodyH: 3.1, exposedPad: { w: 3.7, h: 3.7 } }, { pinsLeft: 14, pinsBottom: 10, pinsRight: 14, antennaTop: 6.0 });
    }
    const sz = d.ab ?? (d.L && d.W ? [d.W, d.L, d.H] : undefined);
    if (sz) return spec('module', { bodyW: sz[0], bodyL: sz[1], bodyH: sz[2], pins: ctx.pins, pitch: d.P ?? pitch });
  }
  if (cat === 'led' && d.L && d.W) {
    const code = chipSizeFromDims(d.L, d.W);
    if (code) return spec('chip', { size: code, pins: 2 }, pol);
  }
  return undefined;
}

function nearestCrystal(l: number, w: number): string {
  let best = '3225';
  let err = Infinity;
  for (const [k, v] of Object.entries(CRYSTAL_SIZES)) {
    const e = Math.abs(v[0] - l) + Math.abs(v[1] - w);
    if (e < err) {
      err = e;
      best = k;
    }
  }
  return best;
}

/** 2-terminal packages: EasyEDA 'L' runs along the terminals (our X). */
function dimsFor2Term(d: Dims): Partial<PackageSpec> {
  return { bodyW: d.L, bodyL: d.W, leadSpan: d.LS, bodyH: d.H };
}

/** Dual-row ICs: EasyEDA 'L' runs along the rows (our Y), 'W' across (our X). */
function rowDims(d: Dims): Partial<PackageSpec> {
  if (d.L !== undefined || d.W !== undefined) return { bodyW: d.W, bodyL: d.L, bodyH: d.H };
  if (d.ab) {
    const [a, b] = d.ab;
    return { bodyW: Math.min(a, b), bodyL: Math.max(a, b) };
  }
  return {};
}

function withEP(fields: Partial<PackageSpec>, s: string, pins: number): Partial<PackageSpec> {
  if (/-EP|EP\b|_EP|ESOP|HSOP|HTSSOP|POWERPAD|PWP|DDA|EXPOSED/.test(s)) {
    const w = fields.bodyW ?? 3.9;
    const l = fields.bodyL ?? 4.9;
    return { ...fields, exposedPad: { w: rnd(Math.min(2.4, w * 0.6), 2), h: rnd(Math.min(l * 0.65, (pins / 2) * 0.6 + 0.5), 2) } };
  }
  return fields;
}

function epFlag(s: string, ctx: PackageContext, pins: number, defaultEp: boolean): Record<string, boolean> {
  if (/-EP|_EP|EP\b|EP\(|EXPOSED|PAD/.test(s)) return {};
  if (ctx.pins !== undefined && ctx.pins === pins + 1) return {};
  if (/LGA/.test(s)) return { noEP: true };
  return defaultEp ? {} : { noEP: true };
}
