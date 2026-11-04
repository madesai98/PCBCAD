import type { PartDef, PartSimModel, PinDef } from '@pcbcad/core';
import { parseValue } from '@pcbcad/core';
import { cleanPinName, isGroundName, pinTokens, SUPPLY_RE } from './pins';
import { paramNumber, paramText, parseQuantity } from './params';

/* --------------------------------------------------------------------------------------------- *
 * Simulation-model inference from category, value, distributor parameters and pin names.
 * Pin references in models are pin NUMBERS. All values SI.
 * --------------------------------------------------------------------------------------------- */

function byName(pins: PinDef[], ...res: RegExp[]): PinDef | undefined {
  for (const re of res) {
    const hit = pins.find((p) => re.test(cleanPinName(p.name)) || pinTokens(p.name).some((t) => re.test(t)));
    if (hit) return hit;
  }
  return undefined;
}

function sortedNumbers(pins: PinDef[]): string[] {
  return [...pins]
    .map((p) => p.number)
    .sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b, undefined, { numeric: true });
    });
}

function twoPins(part: PartDef): [string, string] | undefined {
  const nums = sortedNumbers(part.pins.length ? part.pins : padPins(part));
  return nums.length >= 2 ? [nums[0], nums[1]] : undefined;
}

/** Pins synthesised from footprint pads when the part has none. */
function padPins(part: PartDef): PinDef[] {
  const seen = new Set<string>();
  const out: PinDef[] = [];
  for (const p of part.footprint?.pads ?? []) {
    if (!p.number || seen.has(p.number)) continue;
    seen.add(p.number);
    out.push({ number: p.number, name: p.number, type: 'passive' });
  }
  return out;
}

function allPins(part: PartDef): PinDef[] {
  return part.pins.length ? part.pins : padPins(part);
}

/** Value from part.value, then a parameter, then a number embedded in the description. */
function valueOf(part: PartDef, paramRes: RegExp[], unitRe: RegExp): number | undefined {
  if (part.value) {
    const v = parseValue(part.value.replace(/\s+/g, ''));
    if (v !== undefined) return v;
  }
  const p = paramNumber(part.params, paramRes);
  if (p !== undefined) return p;
  const m = unitRe.exec(`${part.description} ${part.mpn}`);
  if (m) return parseValue(m[0].replace(/\s+/g, ''));
  return undefined;
}

const LED_VF: [RegExp, number][] = [
  [/infra|\bir\b|940|850/i, 1.3],
  [/red/i, 2.0],
  [/orange|amber/i, 2.1],
  [/yellow(?! ?green)/i, 2.1],
  [/yellow ?green|pure green|lime/i, 2.2],
  [/green|emerald/i, 3.0],
  [/blue|white|uv|violet|purple|pink/i, 3.1],
];

/** LED colour word from parameters / description. */
export function ledColor(part: PartDef): string | undefined {
  const c = paramText(part.params, /illumination colou?r|emitting colou?r|^colou?r$|emitted colou?r|light colou?r/i);
  const text = `${c ?? ''} ${part.description} ${part.mpn}`.toLowerCase();
  for (const name of ['infrared', 'warm white', 'white', 'emerald green', 'yellow green', 'green', 'red', 'orange', 'amber', 'yellow', 'blue', 'pink', 'purple', 'uv', 'rgb']) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return name;
  }
  return c?.toLowerCase();
}

function diodePins(part: PartDef): { a: string; k: string } | undefined {
  const pins = allPins(part);
  const a = byName(pins, /^(A|ANODE|AN|\+|A1)$/);
  const k = byName(pins, /^(K|C|CATHODE|KA|-|K1)$/);
  if (a && k && a.number !== k.number) return { a: a.number, k: k.number };
  const two = twoPins(part);
  // JEDEC / IPC convention: pin 1 = cathode
  return two ? { k: two[0], a: two[1] } : undefined;
}

function supplyAndGround(part: PartDef): { supply: string[]; ground: string[] } {
  const pins = allPins(part);
  const ground = pins.filter((p) => isGroundName(p.name)).map((p) => p.number);
  const supply = pins
    .filter((p) => !isGroundName(p.name) && (SUPPLY_RE.test(cleanPinName(p.name)) || pinTokens(p.name).some((t) => /^(VCC|VDD|AVCC|AVDD|DVDD|IOVDD|VDDIO|VBAT)$/.test(t))))
    .filter((p) => !/^(VBUS)$/.test(cleanPinName(p.name)) || part.category !== 'mcu')
    .map((p) => p.number);
  // exposed pads named by number only are usually ground
  return { supply: unique(supply), ground: unique(ground) };
}

function unique(a: string[]): string[] {
  return [...new Set(a)];
}

const ICC_PARAMS = [/^supply current/i, /operating current/i, /current - supply/i, /^supply current\b/i, /quiescent current/i, /^current consumption/i, /standby current/i, /^icc\b/i, /^idd\b/i];

/** Fixed output voltage encoded in common regulator MPNs (AMS1117-3.3, XC6206P332, HT7333, MCP1700-3302). */
export function vOutFromMpn(mpn: string): number | undefined {
  const u = mpn.toUpperCase();
  let m = /^XC62\d{2}[A-Z](\d)(\d)/.exec(u);
  if (m) return parseInt(m[1] + m[2], 10) / 10;
  m = /^HT7[0-9](\d)(\d)/.exec(u);
  if (m) return parseInt(m[1] + m[2], 10) / 10;
  m = /^MCP17\d{2}[A-Z]?-(\d)(\d)/.exec(u);
  if (m) return parseInt(m[1] + m[2], 10) / 10;
  m = /^(?:ME6211|ME6206|RT9013|RT9193)[A-Z]?(\d)(\d)/.exec(u);
  if (m) return parseInt(m[1] + m[2], 10) / 10;
  m = /[-_](\d{1,2}\.\d{1,2})(?:V|[-_A-Z]|$)/.exec(u);
  if (m) return parseFloat(m[1]);
  m = /^(?:LM|L|UA|MC)78(?:M|L)?(\d{2})/.exec(u);
  if (m) return parseInt(m[1], 10);
  return undefined;
}

function regulatorPins(part: PartDef, buck: boolean): { in: string; out: string; gnd: string } | undefined {
  const pins = allPins(part);
  const vin = byName(pins, /^(VIN|IN|VI|INPUT|PVIN|VIN1|AVIN|VCC|VDD|\+VIN|\+IN)$/);
  const out = buck
    ? byName(pins, /^(SW|LX|PH|SW1|LX1|L)$/, /^(VOUT|OUT|VO|OUTPUT|\+VOUT)$/)
    : byName(pins, /^(VOUT|OUT|VO|OUTPUT|VOUT1|\+VOUT)$/);
  const gnd = byName(pins, /^(GND|PGND|VSS|AGND|GND\/ADJ|ADJ\/GND|GND\(ADJ\)|0V|-VIN|-VOUT)$/);
  if (vin && out && gnd) return { in: vin.number, out: out.number, gnd: gnd.number };
  return undefined;
}

/** Emulator id for an MCU MPN, or undefined when no built-in emulator exists. */
export function mcuEmulator(mpn: string): { emulator: string; clockHz: number; icc: number } | undefined {
  const u = mpn.toUpperCase();
  if (/^ATMEGA328P/.test(u)) return { emulator: 'avr:atmega328p', clockHz: 16e6, icc: 0.009 };
  if (/^RP2040/.test(u)) return { emulator: 'rp2040', clockHz: 125e6, icc: 0.025 };
  return undefined;
}

/** Map emulator port names to pin numbers (AVR 'PB5', RP2040 'GPIO25'). */
export function mcuPinMap(pins: PinDef[], emulator: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = emulator.startsWith('avr') ? /^(P[A-H][0-7]|ADC[67])$/ : /^(GPIO\d{1,2})$/;
  for (const p of pins) {
    for (const t of pinTokens(p.name)) {
      if (re.test(t) && map[t] === undefined) map[t] = p.number;
    }
    for (const f of p.functions ?? []) {
      const t = cleanPinName(f);
      if (re.test(t) && map[t] === undefined) map[t] = p.number;
    }
  }
  return map;
}

function frequency(part: PartDef): number | undefined {
  const f = paramNumber(part.params, [/^frequency/i, /nominal frequency/i, /^freq/i]);
  if (f) return f;
  if (part.value) {
    const v = parseValue(part.value.replace(/\s+/g, ''));
    if (v && v > 1000) return v;
  }
  const m = /(\d+(?:\.\d+)?)\s*(MHz|kHz|KHz)/i.exec(`${part.description} ${part.mpn}`);
  if (m) return parseFloat(m[1]) * (/^m/i.test(m[2]) ? 1e6 : 1e3);
  const xm = /^X\d{2}\d(\d{2})(\d{1,3})M/i.exec(part.mpn);
  if (xm) return parseInt(xm[2], 10) * 1e6;
  return undefined;
}

/**
 * Infer a simulation model for a part. Returns undefined when the deterministic rules cannot
 * produce a trustworthy model (e.g. MCUs without a built-in emulator, adjustable regulators,
 * relays, displays) — the caller should then ask the agent.
 */
export function inferSimModel(part: PartDef): PartSimModel | undefined {
  const P = part.params ?? {};
  switch (part.category) {
    case 'resistor': {
      const R = valueOf(part, [/^resistance/i, /resistance value/i], /\b\d+(\.\d+)?\s*[kKmM]?\s*(Ω|ohm|R)\b|\b\d+[kKmMR]\d+\b/);
      return R !== undefined ? { kind: 'resistor', R, pins: twoPins(part) } : undefined;
    }
    case 'capacitor':
    case 'capacitor-polarized': {
      const Cv = valueOf(part, [/^capacitance/i, /capacitance value/i], /\b\d+(\.\d+)?\s*[pnuµμm]F\b/);
      if (Cv === undefined) return undefined;
      const esr = paramNumber(P, [/equivalent series resistance|\besr\b/i]);
      const pins = allPins(part);
      let pp = twoPins(part);
      const plus = byName(pins, /^(\+|POS|PLUS|ANODE|A)$/);
      const minus = byName(pins, /^(-|NEG|MINUS|CATHODE|K)$/);
      if (plus && minus) pp = [plus.number, minus.number];
      const m: PartSimModel = { kind: 'capacitor', C: Cv, pins: pp };
      if (esr !== undefined) m.esr = esr;
      return m;
    }
    case 'inductor': {
      const L = valueOf(part, [/^inductance/i], /\b\d+(\.\d+)?\s*[nuµμm]H\b/);
      if (L === undefined) return undefined;
      const dcr = paramNumber(P, [/dc resistance|\bdcr\b/i]);
      const m: PartSimModel = { kind: 'inductor', L, pins: twoPins(part) };
      if (dcr !== undefined) m.dcr = dcr;
      return m;
    }
    case 'ferrite': {
      const R = paramNumber(P, [/dc resistance|\bdcr\b/i]) ?? 0.1;
      return { kind: 'ferrite', R, pins: twoPins(part) };
    }
    case 'diode':
    case 'schottky':
    case 'zener':
    case 'tvs': {
      const dp = diodePins(part);
      if (!dp) return undefined;
      const vfParam = paramText(P, /voltage - forward|forward voltage|^vf\b/i);
      const Vf = parseQuantity(vfParam, 'first') ?? (part.category === 'schottky' ? 0.45 : 0.7);
      const cond = vfParam ? /@\s*\(?([\d.]+\s*[munµ]?A)/i.exec(vfParam) : null;
      const If = (cond ? parseValue(cond[1].replace(/\s+/g, '')) : undefined) ?? (part.category === 'schottky' ? 1 : 0.01);
      const m: PartSimModel = { kind: 'diode', anode: dp.a, cathode: dp.k, Vf, If };
      let Bv: number | undefined;
      if (part.category === 'zener') {
        Bv = paramNumber(P, [/zener voltage|voltage - zener|^vz\b/i]) ?? zenerFromMpn(part.mpn);
        if (Bv === undefined) return undefined;
      } else if (part.category === 'tvs') {
        Bv = paramNumber(P, [/breakdown voltage|^vbr\b/i]) ?? (paramNumber(P, [/stand-?off|reverse stand|^vrwm\b|working voltage/i]) ?? 0) * 1.11;
        if (!Bv) Bv = undefined;
      } else {
        Bv = paramNumber(P, [/voltage - dc reverse|reverse voltage|^vr\b|peak reverse|repetitive reverse|^vrrm\b/i]);
      }
      if (Bv !== undefined) m.Bv = Bv;
      if (part.category === 'schottky') m.n = 1.05;
      return m;
    }
    case 'led': {
      const dp = diodePins(part);
      if (!dp) return undefined;
      const color = ledColor(part);
      const vfText = paramText(P, /voltage - forward|forward voltage|^vf\b/i);
      let Vf = parseQuantity(vfText, 'mid');
      if (Vf === undefined || Vf <= 0.5 || Vf > 5) Vf = LED_VF.find(([re]) => re.test(color ?? ''))?.[1] ?? 2.0;
      const If = paramNumber(P, [/test current|forward current|^if\b|current - test/i]) ?? 0.02;
      const m: PartSimModel = { kind: 'led', anode: dp.a, cathode: dp.k, Vf: Math.round(Vf * 1000) / 1000, If };
      if (color) m.color = color;
      return m;
    }
    case 'bjt-npn':
    case 'bjt-pnp': {
      const pins = allPins(part);
      const b = byName(pins, /^(B|BASE)$/)?.number ?? '1';
      const e = byName(pins, /^(E|EMITTER)$/)?.number ?? '2';
      const c = byName(pins, /^(C|COLLECTOR)$/)?.number ?? '3';
      const beta = paramNumber(P, [/dc current gain|\bhfe\b/i], 'min') ?? 100;
      return { kind: 'bjt', polarity: part.category === 'bjt-pnp' ? 'pnp' : 'npn', b, c, e, beta };
    }
    case 'mosfet-n':
    case 'mosfet-p': {
      const pins = allPins(part);
      const g = byName(pins, /^(G|GATE|G1)$/)?.number ?? '1';
      const s = byName(pins, /^(S|SOURCE|S1)$/)?.number ?? '2';
      const d = byName(pins, /^(D|DRAIN|D1)$/)?.number ?? '3';
      const vth = paramNumber(P, [/gate threshold|vgs\(th\)|^vth\b/i], 'mid') ?? 2.0;
      const rds = paramNumber(P, [/rds\(on\)|drain source on resistance|on-?state resistance|^rds/i]) ?? 0.05;
      const vgs = paramNumber(P, [/^vgs$|gate source voltage|gate-source voltage|vgs\b(?!\()/i]);
      const m: PartSimModel = { kind: 'mosfet', polarity: part.category === 'mosfet-p' ? 'p' : 'n', g, d, s, Vth: Math.abs(vth), Rds_on: rds };
      if (vgs !== undefined) m.Vgs_rated = Math.abs(vgs);
      return m;
    }
    case 'ldo': {
      const rp = regulatorPins(part, false);
      if (!rp) return undefined;
      const outType = paramText(P, /output type/i) ?? '';
      let Vout = paramNumber(P, [/^output voltage/i, /voltage - output/i, /^vout/i]);
      const outText = paramText(P, /^output voltage/i, /voltage - output/i) ?? '';
      if (/~|adj/i.test(outText) || /adjust/i.test(outType)) Vout = undefined;
      Vout ??= vOutFromMpn(part.mpn);
      if (Vout === undefined) return undefined;
      const dropout = paramNumber(P, [/dropout/i]) ?? 0.3;
      const Iq = paramNumber(P, [/quiescent current/i, /standby current/i, /ground current/i, /supply current/i]);
      const Imax = paramNumber(P, [/^output current/i, /current - output/i]);
      const m: PartSimModel = { kind: 'ldo', in: rp.in, out: rp.out, gnd: rp.gnd, Vout, dropout };
      if (Iq !== undefined) m.Iq = Iq;
      if (Imax !== undefined) m.Imax = Imax;
      return m;
    }
    case 'dc-dc': {
      const rp = regulatorPins(part, true);
      if (!rp) return undefined;
      const outText = paramText(P, /^output voltage/i, /voltage - output/i) ?? '';
      let Vout = /~|adj/i.test(outText) ? undefined : paramNumber(P, [/^output voltage/i, /voltage - output/i]);
      Vout ??= vOutFromMpn(part.mpn);
      if (Vout === undefined) return undefined;
      const eff = paramNumber(P, [/efficiency/i]);
      const Iq = paramNumber(P, [/quiescent current/i]);
      const Imax = paramNumber(P, [/^output current/i, /current - output/i]);
      const m: PartSimModel = { kind: 'buck', in: rp.in, out: rp.out, gnd: rp.gnd, Vout, efficiency: eff && eff > 1 ? eff / 100 : (eff ?? 0.9) };
      if (Iq !== undefined) m.Iq = Iq;
      if (Imax !== undefined) m.Imax = Imax;
      return m;
    }
    case 'mcu': {
      const emu = mcuEmulator(part.mpn);
      if (!emu) return undefined;
      const { supply, ground } = supplyAndGround(part);
      if (!supply.length || !ground.length) return undefined;
      const Icc = paramNumber(P, ICC_PARAMS) ?? emu.icc;
      return { kind: 'mcu', emulator: emu.emulator, clockHz: emu.clockHz, supplyPins: supply, groundPins: ground, Icc, pinMap: mcuPinMap(allPins(part), emu.emulator) };
    }
    case 'opamp': {
      const pins = allPins(part);
      const inp = byName(pins, /^(IN\+|\+IN|INA\+|\+INA|IN1\+|\+IN1|NONINV|IN_P|INP)$/);
      const inn = byName(pins, /^(IN-|-IN|INA-|-INA|IN1-|-IN1|INV|IN_N|INN)$/);
      const out = byName(pins, /^(OUT|OUTA|OUT1|VOUT|OUTPUT|AOUT)$/);
      const vp = byName(pins, /^(V\+|VCC|VDD|VS\+|VCC\+|\+VS|VS)$/);
      const vn = byName(pins, /^(V-|VEE|VSS|GND|VS-|VCC-|-VS)$/);
      if (inp && inn && out && vp && vn) {
        const gbw = paramNumber(P, [/gain bandwidth|\bgbp\b|\bgbw\b/i]);
        const m: PartSimModel = { kind: 'opamp', inp: inp.number, inn: inn.number, out: out.number, vp: vp.number, vn: vn.number, gain: 1e5 };
        if (gbw !== undefined) m.gbw = gbw;
        return m;
      }
      return genericIc(part);
    }
    case 'crystal': {
      const freq = frequency(part);
      if (freq === undefined) return undefined;
      const pins = allPins(part);
      const xa = byName(pins, /^(XTAL1|X1|OSC1|XIN|XI|IN|XTAL|OSC_IN)$/);
      const xb = byName(pins, /^(XTAL2|X2|OSC2|XOUT|XO|OUT|OSC_OUT)$/);
      let a = xa?.number;
      let b = xb?.number;
      if (!a || !b || a === b) {
        const nonGnd = sortedNumbers(pins.filter((p) => !isGroundName(p.name)));
        if (nonGnd.length >= 2) {
          a = nonGnd[0];
          b = pins.length === 4 && nonGnd.includes('3') ? '3' : nonGnd[1];
        }
      }
      return a && b ? { kind: 'crystal', a, b, freq } : undefined;
    }
    case 'switch':
    case 'button': {
      const nums = sortedNumbers(allPins(part));
      if (nums.length < 2) return undefined;
      // 4-terminal tactile switches: 1–2 and 3–4 are internally connected; the switch is 1/2 ↔ 3/4
      const b = nums.length === 4 && nums.includes('3') ? '3' : nums[1];
      return { kind: 'switch', a: nums[0], b, closed: false, Ron: 0.1 };
    }
    case 'fuse': {
      const two = twoPins(part);
      if (!two) return undefined;
      const R = paramNumber(P, [/resistance/i]) ?? 0.05;
      const Ihold = paramNumber(P, [/hold current|current - hold|current rating|rated current|^current\b/i]) ?? 0.5;
      return { kind: 'fuse', a: two[0], b: two[1], R, Ihold };
    }
    case 'battery': {
      const pins = allPins(part);
      const p = byName(pins, /^(\+|POS|BAT\+|VBAT|PLUS)$/)?.number ?? twoPins(part)?.[0];
      const n = byName(pins, /^(-|NEG|BAT-|GND|MINUS)$/)?.number ?? twoPins(part)?.[1];
      const V = paramNumber(P, [/nominal voltage|^voltage/i]) ?? (/LIR|18650|LI-?ION|LIPO/i.test(part.mpn + part.description) ? 3.7 : /CR\d{4}/i.test(part.mpn + part.description) ? 3.0 : undefined);
      if (!p || !n || V === undefined || p === n) return undefined;
      return { kind: 'vsource', p, n, V, Rint: /CR\d{4}/i.test(part.mpn + part.description) ? 15 : 0.1 };
    }
    case 'connector':
    case 'cable':
    case 'wire':
    case 'testpoint':
      return { kind: 'connector' };
    case 'oscillator':
    case 'ic':
    case 'sensor':
    case 'memory':
    case 'logic':
    case 'driver':
    case 'interface':
    case 'comparator':
    case 'rf-module':
    case 'module':
      return genericIc(part);
    default:
      return undefined;
  }
}

/** Typical average supply current when the distributor data has none (A). */
const DEFAULT_ICC: Partial<Record<PartDef['category'], number>> = {
  'rf-module': 0.08,
  module: 0.02,
  interface: 0.005,
  driver: 0.002,
  memory: 0.002,
  sensor: 0.001,
  oscillator: 0.005,
  logic: 1e-4,
  comparator: 1e-4,
  opamp: 5e-4,
  ic: 0.002,
};

/** Supply current from the distributor parameters (A), if present. */
export function iccFromParams(params: Record<string, string> | undefined): number | undefined {
  return paramNumber(params, ICC_PARAMS);
}

function genericIc(part: PartDef): PartSimModel | undefined {
  const { supply, ground } = supplyAndGround(part);
  if (!supply.length || !ground.length) return undefined;
  const Icc = iccFromParams(part.params) ?? DEFAULT_ICC[part.category] ?? 1e-3;
  return { kind: 'ic', supplyPins: supply, groundPins: ground, Icc };
}

function zenerFromMpn(mpn: string): number | undefined {
  const m = /(?:C|B|-)(\d{1,2})V(\d)/i.exec(mpn);
  if (m) return parseFloat(`${m[1]}.${m[2]}`);
  const m2 = /(?:C|B)(\d{1,2})(?![\dV])/i.exec(mpn.replace(/^(BZT52|BZX84|BZX79|MM3Z|MMSZ)/i, ''));
  return m2 ? parseFloat(m2[1]) : undefined;
}
