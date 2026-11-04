/**
 * Project → Circuit netlist conversion.
 */
import { guessNetClass, paramValue, parseValue, resolvePins, systemConnectivity } from '@pcbcad/core';
import type { Board, ComponentInstance, Net, PartDef, PartSimModel, Project } from '@pcbcad/core';
import type { Circuit, CircuitComponent, CircuitConductor, CircuitDevice, CircuitTarget, DeviceParam } from './types';

/** Options for {@link buildCircuit}. */
export interface BuildCircuitOptions {
  /**
   * Per-component parameter overrides keyed by component id, ref ('R3') or 'Board/R3'.
   * Merged over ComponentInstance.simOverrides. Values may be numbers, booleans or strings
   * with SI prefixes ('4k7'). Examples: {closed: true}, {V: 3.7}, {R: '10k'},
   * {waveform: 'pulse', v1: 0, v2: 5, td: 0, tr: 1e-6, tf: 1e-6, pw: 1e-3, per: 2e-3}.
   */
  overrides?: Record<string, Record<string, number | boolean | string>>;
  /** Temperature for semiconductor models (°C, default project.settings.ambientC or 25). */
  temperatureC?: number;
}

/** String-valued parameters that must not be parsed as numbers. */
const STRING_PARAMS = new Set(['waveform', 'points', 'mode', 'color', 'emulator', 'behaviorId', 'firmwareId']);

/** True if the net is a ground net (class 'ground' or named GND/VSS/0V/...). */
export function isGroundNet(net: Net): boolean {
  return net.class === 'ground' || guessNetClass(net.name) === 'ground';
}

const TRANSPARENT = new Set(['connector', 'testpoint', 'antenna', 'fastener', 'mechanical', 'cable', 'wire', 'crystal', 'oscillator']);

const LED_VF: Record<string, number> = {
  red: 2.0,
  orange: 2.0,
  amber: 2.1,
  yellow: 2.1,
  green: 2.2,
  blue: 3.0,
  white: 3.0,
  warmwhite: 3.0,
  pink: 3.0,
  purple: 3.1,
  violet: 3.1,
  uv: 3.3,
  ir: 1.3,
  infrared: 1.3,
};

function normColor(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.toLowerCase();
  for (const c of ['infrared', 'ir', 'uv', 'red', 'orange', 'amber', 'yellow', 'green', 'blue', 'white', 'pink', 'purple', 'violet']) {
    if (new RegExp(`\\b${c}\\b`).test(t) || (c.length > 3 && t.includes(c))) return c === 'infrared' ? 'ir' : c;
  }
  return undefined;
}

function ledColor(part: PartDef, sim?: Extract<PartSimModel, { kind: 'led' }>): string | undefined {
  if (sim?.color) return normColor(sim.color) ?? sim.color;
  for (const [k, v] of Object.entries(part.params ?? {})) if (/colou?r/i.test(k)) return normColor(v) ?? v.toLowerCase();
  return normColor(part.description) ?? normColor(part.mpn);
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return parseValue(v);
  return undefined;
}

/** Parse 'value@current' strings such as '1.1V@1A' → [1.1, 1]. */
function parseAt(s: string | undefined): [number | undefined, number | undefined] {
  if (!s) return [undefined, undefined];
  const m = /^\s*([^@(]+)\s*[@(]\s*([^)]+)\)?/.exec(s);
  if (m) return [parseValue(m[1]), parseValue(m[2])];
  return [parseValue(s.split(/[\s,;]/)[0]), undefined];
}

/** Parse power ratings like '1/10W', '0.1W', '100mW'. */
function parsePower(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const frac = /^\s*(\d+)\s*\/\s*(\d+)\s*W/i.exec(s);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  return parseValue(s.replace(/\s.*$/, ''));
}

function normalizeOverrides(ov: Record<string, number | boolean | string>): Record<string, DeviceParam> {
  const out: Record<string, DeviceParam> = {};
  for (const [k, v] of Object.entries(ov)) {
    if (typeof v === 'string' && !STRING_PARAMS.has(k)) {
      const n = parseValue(v);
      if (n !== undefined) {
        out[k] = n;
        continue;
      }
      if (/^(true|false)$/i.test(v)) {
        out[k] = /^true$/i.test(v);
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

interface Ctx {
  project: Project;
  board: Board;
  comp: ComponentInstance;
  part: PartDef;
  ov: Record<string, DeviceParam>;
  netNode: (netId: string) => string;
  warnings: string[];
  label: string;
}

interface Term {
  node: string;
  pin: string;
}

/** Resolve a pin reference (number or name) to a connected pin/node. */
function term(ctx: Ctx, ref: string | undefined): Term | null {
  if (ref == null) return null;
  const { comp, part } = ctx;
  const r = String(ref);
  if (comp.pinNets[r]) return { node: ctx.netNode(comp.pinNets[r]), pin: r };
  for (const p of resolvePins(part, r)) if (comp.pinNets[p]) return { node: ctx.netNode(comp.pinNets[p]), pin: p };
  return null;
}

/** All connected pins matching a list of references (dedup by pin). */
function terms(ctx: Ctx, refs: string[]): Term[] {
  const out: Term[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const cands = ctx.comp.pinNets[ref] ? [ref] : resolvePins(ctx.part, ref);
    for (const p of cands) {
      if (seen.has(p) || !ctx.comp.pinNets[p]) continue;
      seen.add(p);
      out.push({ node: ctx.netNode(ctx.comp.pinNets[p]), pin: p });
    }
  }
  return out;
}

/** Default two terminals: explicit pins, else the first two part pins, else first two connected pins. */
function twoTerms(ctx: Ctx, pins?: [string, string]): [Term, Term] | null {
  if (pins) {
    const a = term(ctx, pins[0]);
    const b = term(ctx, pins[1]);
    return a && b ? [a, b] : null;
  }
  const list = ctx.part.pins.length ? ctx.part.pins.map((p) => p.number) : Object.keys(ctx.comp.pinNets).sort();
  const t = list.slice(0, 2).map((p) => term(ctx, p));
  return t[0] && t[1] ? [t[0], t[1]] : null;
}

/** Two pins on different nets (switches with paired pins). */
function switchTerms(ctx: Ctx): [Term, Term] | null {
  const list = ctx.part.pins.length ? ctx.part.pins.map((p) => p.number) : Object.keys(ctx.comp.pinNets).sort();
  const conn = list.map((p) => term(ctx, p)).filter((t): t is Term => !!t);
  if (conn.length < 2) return null;
  const other = conn.find((t) => t.node !== conn[0].node);
  return other ? [conn[0], other] : [conn[0], conn[1]];
}

function pinByName(ctx: Ctx, re: RegExp): Term | null {
  for (const p of ctx.part.pins) if (re.test(p.name.trim())) {
    const t = term(ctx, p.number);
    if (t) return t;
  }
  return null;
}

function dev(ctx: Ctx, kind: CircuitDevice['kind'], t: Record<string, Term>, params: Record<string, DeviceParam>, extra: Partial<CircuitDevice> = {}): CircuitDevice {
  const nodes: Record<string, string> = {};
  const pins: Record<string, string> = {};
  for (const [k, v] of Object.entries(t)) {
    nodes[k] = v.node;
    pins[k] = v.pin;
  }
  return { id: ctx.comp.id, kind, componentId: ctx.comp.id, nodes, pins, params, ...extra };
}

function warnUnconnected(ctx: Ctx, what: string): void {
  ctx.warnings.push(`${ctx.label}: ${what} not connected — not simulated`);
}

function diodeParams(vf: number, iff: number, n: number, rs: number | undefined, vt: number): { Is: number; n: number; Rs: number } {
  const Rs = rs ?? (0.1 * vf) / iff;
  const vj = Math.max(vf - iff * Rs, 0.05);
  const Is = iff / (Math.exp(vj / (n * vt)) - 1);
  return { Is, n, Rs };
}

/** Build circuit devices for one component. */
function componentDevices(ctx: Ctx, vt: number): { devices: CircuitDevice[]; model: string; color?: string } {
  const { part, comp, ov } = ctx;
  const value = comp.value ?? part.value;
  const sim = part.sim && part.sim.kind !== 'none' ? part.sim : undefined;
  const o = (k: string): DeviceParam | undefined => ov[k];
  const on = (k: string): number | undefined => toNum(ov[k]);
  const valueNum = (): number | undefined => (comp.value != null ? parseValue(comp.value) : undefined);
  const cat = part.category;
  const kind = sim?.kind ?? inferKind(cat);
  const out: CircuitDevice[] = [];
  const voltValue = (): number | undefined => {
    const v = comp.value ?? part.value;
    return v && /v\s*$/i.test(v.trim()) ? parseValue(v) : undefined;
  };

  switch (kind) {
    case 'resistor': {
      const s = sim?.kind === 'resistor' ? sim : undefined;
      const t = twoTerms(ctx, s?.pins);
      if (!t) return { devices: [], model: kind };
      const R = on('R') ?? valueNum() ?? s?.R ?? parseValue(value) ?? paramValue(part.params, /resistance/i);
      if (R === undefined) {
        ctx.warnings.push(`${ctx.label}: resistor value unknown — not simulated`);
        return { devices: [], model: kind };
      }
      out.push(dev(ctx, 'resistor', { p: t[0], n: t[1] }, { R: Math.max(R, 1e-4) }, R < 1e-3 ? { role: 'jumper' } : {}));
      return { devices: out, model: kind };
    }
    case 'capacitor': {
      const s = sim?.kind === 'capacitor' ? sim : undefined;
      const t = twoTerms(ctx, s?.pins);
      if (!t) return { devices: [], model: kind };
      const C = on('C') ?? valueNum() ?? s?.C ?? parseValue(value) ?? paramValue(part.params, /capacitance/i);
      if (C === undefined) {
        ctx.warnings.push(`${ctx.label}: capacitor value unknown — not simulated`);
        return { devices: [], model: kind };
      }
      const esr = on('esr') ?? s?.esr ?? paramValue(part.params, /esr|equivalent series/i) ?? 0;
      // polarised: pin '+' / pin 1 assumed positive (orientation only matters for display)
      out.push(dev(ctx, 'capacitor', { p: t[0], n: t[1] }, { C, esr }));
      return { devices: out, model: kind };
    }
    case 'inductor': {
      const s = sim?.kind === 'inductor' ? sim : undefined;
      const t = twoTerms(ctx, s?.pins);
      if (!t) return { devices: [], model: kind };
      const L = on('L') ?? valueNum() ?? s?.L ?? parseValue(value) ?? paramValue(part.params, /inductance/i);
      if (L === undefined) {
        ctx.warnings.push(`${ctx.label}: inductor value unknown — not simulated`);
        return { devices: [], model: kind };
      }
      const dcr = on('dcr') ?? s?.dcr ?? paramValue(part.params, /dc ?resistance|dcr/i) ?? 0.05;
      out.push(dev(ctx, 'inductor', { p: t[0], n: t[1] }, { L, dcr }));
      return { devices: out, model: kind };
    }
    case 'ferrite': {
      const s = sim?.kind === 'ferrite' ? sim : undefined;
      const t = twoTerms(ctx, s?.pins);
      if (!t) return { devices: [], model: kind };
      const R = on('R') ?? s?.R ?? paramValue(part.params, /dc ?resistance|dcr/i) ?? 0.1;
      out.push(dev(ctx, 'resistor', { p: t[0], n: t[1] }, { R: Math.max(R, 1e-4) }, { role: 'ferrite' }));
      return { devices: out, model: kind };
    }
    case 'fuse': {
      const s = sim?.kind === 'fuse' ? sim : undefined;
      const t = s ? [term(ctx, s.a), term(ctx, s.b)] : twoTerms(ctx);
      if (!t || !t[0] || !t[1]) return { devices: [], model: kind };
      const R = on('R') ?? s?.R ?? paramValue(part.params, /resistance/i) ?? 0.05;
      const Ihold = on('Ihold') ?? s?.Ihold ?? paramValue(part.params, /hold|current rating|rated current/i) ?? 0;
      out.push(dev(ctx, 'resistor', { p: t[0], n: t[1] }, { R: Math.max(R, 1e-4), Ihold }, { role: 'fuse' }));
      return { devices: out, model: kind };
    }
    case 'switch': {
      const s = sim?.kind === 'switch' ? sim : undefined;
      const t = s ? [term(ctx, s.a), term(ctx, s.b)] : switchTerms(ctx);
      if (!t || !t[0] || !t[1]) return { devices: [], model: kind };
      const closedRaw = o('closed') ?? s?.closed ?? false;
      const closed = closedRaw === true || closedRaw === 1 || closedRaw === 'true';
      const Ron = on('Ron') ?? s?.Ron ?? 0.05;
      out.push(dev(ctx, 'resistor', { p: t[0], n: t[1] }, { R: closed ? Math.max(Ron, 1e-4) : 1e9, closed }, { role: 'switch' }));
      return { devices: out, model: kind };
    }
    case 'diode':
    case 'led': {
      const isLed = kind === 'led';
      const sd = sim?.kind === 'diode' ? sim : undefined;
      const sl = sim?.kind === 'led' ? sim : undefined;
      let a = term(ctx, sd?.anode ?? sl?.anode);
      let k = term(ctx, sd?.cathode ?? sl?.cathode);
      if (!sim) {
        a = pinByName(ctx, /^(a|anode|\+|a\d?)$/i) ?? term(ctx, '2');
        k = pinByName(ctx, /^(k|c|cathode|-|k\d?)$/i) ?? term(ctx, '1');
      }
      if (!a || !k) return { devices: [], model: kind };
      const role = isLed ? 'led' : cat === 'zener' ? 'zener' : cat === 'tvs' ? 'tvs' : cat === 'schottky' ? 'schottky' : 'diode';
      let color: string | undefined;
      let params: Record<string, DeviceParam>;
      if (isLed) {
        color = ledColor(part, sl);
        const vfDefault = LED_VF[color ?? ''] ?? 2.0;
        const [pvf, pif] = parseAt(Object.entries(part.params ?? {}).find(([kk]) => /forward voltage|vf/i.test(kk))?.[1]);
        const Vf = on('Vf') ?? sl?.Vf ?? pvf ?? vfDefault;
        const If = on('If') ?? sl?.If ?? pif ?? 0.02;
        const fit = diodeParams(Vf, If, on('n') ?? 2.0, on('Rs') ?? sl?.Rs, vt);
        params = { ...fit, Vf, If, Bv: on('Bv') ?? 0 };
      } else {
        const [pvf, pif] = parseAt(Object.entries(part.params ?? {}).find(([kk]) => /forward voltage|vf/i.test(kk))?.[1]);
        const nDefault = role === 'schottky' ? 1.05 : role === 'zener' || role === 'tvs' ? 1.5 : 1.8;
        const n = on('n') ?? sd?.n ?? nDefault;
        let Bv = on('Bv') ?? sd?.Bv;
        if (Bv === undefined && (role === 'zener' || role === 'tvs')) {
          Bv = voltValue() ?? paramValue(part.params, /zener voltage|breakdown|vbr|vz/i);
          if (Bv === undefined) ctx.warnings.push(`${ctx.label}: ${role} breakdown voltage unknown`);
        }
        const Ibv = on('Ibv') ?? (role === 'zener' ? 5e-3 : 1e-3);
        const Is = on('Is') ?? sd?.Is;
        if (Is !== undefined) {
          params = { Is, n, Rs: on('Rs') ?? sd?.Rs ?? 0, Bv: Bv ?? 0, Ibv };
        } else {
          const vfDefault = role === 'schottky' ? 0.45 : 0.72;
          const ifDefault = role === 'schottky' ? 1 : 0.01;
          const Vf = on('Vf') ?? sd?.Vf ?? pvf ?? vfDefault;
          const If = on('If') ?? sd?.If ?? pif ?? ifDefault;
          params = { ...diodeParams(Vf, If, n, on('Rs') ?? sd?.Rs, vt), Vf, If, Bv: Bv ?? 0, Ibv };
        }
      }
      out.push(dev(ctx, 'diode', { a, k }, params, { role, ...(color ? {} : {}) }));
      return { devices: out, model: kind, color };
    }
    case 'bjt': {
      const s = sim?.kind === 'bjt' ? sim : undefined;
      const pol = s ? s.polarity : cat === 'bjt-pnp' ? 'pnp' : 'npn';
      const c = term(ctx, s?.c ?? 'C') ?? pinByName(ctx, /^c(ollector)?$/i);
      const b = term(ctx, s?.b ?? 'B') ?? pinByName(ctx, /^b(ase)?$/i);
      const e = term(ctx, s?.e ?? 'E') ?? pinByName(ctx, /^e(mitter)?$/i);
      if (!c || !b || !e) {
        if (!s) ctx.warnings.push(`${ctx.label}: BJT pins not identified — not simulated`);
        return { devices: [], model: kind };
      }
      const beta = on('beta') ?? s?.beta ?? paramValue(part.params, /hfe|dc current gain/i) ?? 100;
      out.push(dev(ctx, 'bjt', { c, b, e }, { polarity: pol === 'pnp' ? -1 : 1, Is: on('Is') ?? s?.Is ?? 1e-14, betaF: beta, betaR: on('betaR') ?? 1 }));
      return { devices: out, model: kind };
    }
    case 'mosfet': {
      const s = sim?.kind === 'mosfet' ? sim : undefined;
      const pol = s ? s.polarity : cat === 'mosfet-p' ? 'p' : 'n';
      const d = term(ctx, s?.d ?? 'D') ?? pinByName(ctx, /^d(rain)?$/i);
      const g = term(ctx, s?.g ?? 'G') ?? pinByName(ctx, /^g(ate)?$/i);
      const sTerm = term(ctx, s?.s ?? 'S') ?? pinByName(ctx, /^s(ource)?$/i);
      if (!d || !g || !sTerm) {
        if (!s) ctx.warnings.push(`${ctx.label}: MOSFET pins not identified — not simulated`);
        return { devices: [], model: kind };
      }
      const Vth = Math.abs(on('Vth') ?? s?.Vth ?? paramValue(part.params, /threshold|vgs\(th\)/i) ?? 2);
      const Rds = on('Rds_on') ?? s?.Rds_on ?? paramValue(part.params, /rds|on.?resistance/i) ?? 0.1;
      let Vgs = on('Vgs_rated') ?? s?.Vgs_rated ?? (Vth < 2 ? 4.5 : 10);
      if (Vgs <= Vth + 0.1) {
        ctx.warnings.push(`${ctx.label}: Vgs_rated (${Vgs} V) must exceed Vth (${Vth} V); using Vth+2 V`);
        Vgs = Vth + 2;
      }
      const K = on('K') ?? 1 / (Math.max(Rds, 1e-5) * (Vgs - Vth));
      const polarity = pol === 'p' ? -1 : 1;
      out.push(dev(ctx, 'mosfet', { d, g, s: sTerm }, { polarity, Vth, K, lambda: on('lambda') ?? 0.01, Rds_on: Rds, Vgs_rated: Vgs }));
      // body diode: source→drain for N, drain→source for P
      const bd = polarity > 0 ? { a: sTerm, k: d } : { a: d, k: sTerm };
      out.push({ ...dev(ctx, 'diode', bd, { Is: 1e-9, n: 1.5, Rs: 0.01, Bv: 0, Ibv: 1e-3 }), id: `${comp.id}#body`, role: 'body-diode' });
      return { devices: out, model: kind };
    }
    case 'vsource': {
      const s = sim?.kind === 'vsource' ? sim : undefined;
      const p = s ? term(ctx, s.p) : pinByName(ctx, /^(\+|pos|vbat|bat\+|v\+|positive)$/i) ?? term(ctx, '1');
      const n = s ? term(ctx, s.n) : pinByName(ctx, /^(-|neg|gnd|bat-|v-|negative)$/i) ?? term(ctx, '2');
      if (!p || !n) {
        warnUnconnected(ctx, 'source terminal');
        return { devices: [], model: kind };
      }
      const V = on('V') ?? voltValue() ?? s?.V ?? paramValue(part.params, /^(nominal )?voltage/i) ?? 3;
      const params: Record<string, DeviceParam> = { V, Rint: on('Rint') ?? s?.Rint ?? (cat === 'battery' ? 0.1 : 0) };
      for (const k of ['waveform', 'v1', 'v2', 'td', 'tr', 'tf', 'pw', 'per', 'vo', 'va', 'freq', 'theta', 'phase', 'points']) {
        if (ov[k] !== undefined) params[k] = ov[k];
      }
      out.push(dev(ctx, 'vsource', { p, n }, params, { role: cat === 'battery' ? 'battery' : 'supply' }));
      return { devices: out, model: kind };
    }
    case 'ldo':
    case 'buck': {
      const s = sim?.kind === 'ldo' || sim?.kind === 'buck' ? sim : undefined;
      const tin = s ? term(ctx, s.in) : pinByName(ctx, /^(vin|in|vi|input)$/i);
      const tout = s ? term(ctx, s.out) : pinByName(ctx, /^(vout|out|vo|output)$/i);
      const tg = s ? term(ctx, s.gnd) : pinByName(ctx, /^(gnd|vss|adj\/gnd|gnd\/adj)$/i);
      if (!tin || !tout || !tg) {
        if (s) warnUnconnected(ctx, 'regulator IN/OUT/GND');
        else ctx.warnings.push(`${ctx.label}: regulator pins not identified — not simulated`);
        return { devices: [], model: kind };
      }
      const Vout = on('Vout') ?? voltValue() ?? (s as { Vout?: number } | undefined)?.Vout ?? paramValue(part.params, /output voltage/i);
      if (Vout === undefined) {
        ctx.warnings.push(`${ctx.label}: regulator output voltage unknown — not simulated`);
        return { devices: [], model: kind };
      }
      const Imax = on('Imax') ?? s?.Imax ?? part.ratings?.current ?? paramValue(part.params, /output current|current - output/i) ?? 1;
      if (kind === 'ldo') {
        const ls = s?.kind === 'ldo' ? s : undefined;
        const dropout = on('dropout') ?? ls?.dropout ?? paramValue(part.params, /dropout/i) ?? 0.3;
        const Iq = on('Iq') ?? ls?.Iq ?? paramValue(part.params, /quiescent/i) ?? 0;
        out.push(dev(ctx, 'ldo', { in: tin, out: tout, gnd: tg }, { Vout, dropout, Iq, Imax }));
      } else {
        const bs = s?.kind === 'buck' ? s : undefined;
        const efficiency = on('efficiency') ?? bs?.efficiency ?? 0.9;
        const Iq = on('Iq') ?? bs?.Iq ?? 0;
        const modeOv = o('mode');
        const desc = `${part.description} ${part.mpn}`;
        const mode = typeof modeOv === 'string' ? modeOv : /buck.?boost|sepic/i.test(desc) ? 'buck-boost' : /boost|step.?up/i.test(desc) ? 'boost' : 'buck';
        const params: Record<string, DeviceParam> = { Vout, efficiency: efficiency > 1 ? efficiency / 100 : efficiency, Iq, Imax, mode };
        if (on('uvlo') !== undefined) params.uvlo = on('uvlo')!;
        out.push(dev(ctx, 'buck', { in: tin, out: tout, gnd: tg }, params));
      }
      return { devices: out, model: kind };
    }
    case 'opamp': {
      const s = sim?.kind === 'opamp' ? sim : undefined;
      if (!s) {
        ctx.warnings.push(`${ctx.label}: op-amp without sim pin mapping — not simulated`);
        return { devices: [], model: kind };
      }
      const inp = term(ctx, s.inp);
      const inn = term(ctx, s.inn);
      const outT = term(ctx, s.out);
      if (!inp || !inn || !outT) {
        warnUnconnected(ctx, 'op-amp input/output');
        return { devices: [], model: kind };
      }
      let vp = term(ctx, s.vp);
      let vn = term(ctx, s.vn);
      const extra: CircuitDevice[] = [];
      if (!vp) {
        const node = `${comp.id}#vp`;
        vp = { node, pin: s.vp };
        extra.push({ id: `${comp.id}#railp`, kind: 'vsource', role: 'rail', componentId: comp.id, nodes: { p: node, n: '0' }, params: { V: 15, Rint: 0 } });
        ctx.warnings.push(`${ctx.label}: V+ supply pin unconnected — using a virtual +15 V rail`);
      }
      if (!vn) {
        if (extra.length) {
          const node = `${comp.id}#vn`;
          vn = { node, pin: s.vn };
          extra.push({ id: `${comp.id}#railn`, kind: 'vsource', role: 'rail', componentId: comp.id, nodes: { p: node, n: '0' }, params: { V: -15, Rint: 0 } });
        } else {
          vn = { node: '0', pin: s.vn };
          ctx.warnings.push(`${ctx.label}: V- supply pin unconnected — assuming ground`);
        }
      }
      out.push(dev(ctx, 'opamp', { inp, inn, out: outT, vp, vn }, { gain: on('gain') ?? s.gain ?? 1e5, Rout: on('Rout') ?? s.Rout ?? 25, Iq: on('Iq') ?? 0 }));
      for (const d of extra) {
        delete d.pins;
        out.push(d);
      }
      return { devices: out, model: kind };
    }
    case 'ic':
    case 'mcu': {
      const s = sim?.kind === 'ic' || sim?.kind === 'mcu' ? sim : undefined;
      if (!s) return { devices: [], model: 'none' };
      const sup = terms(ctx, s.supplyPins);
      const gnd = terms(ctx, s.groundPins);
      const Icc = on('Icc') ?? s.Icc;
      if (!sup.length || !gnd.length) {
        warnUnconnected(ctx, 'supply/ground pins');
        return { devices: [], model: kind };
      }
      if (!(Icc > 0)) return { devices: [], model: kind };
      const t: Record<string, Term> = {};
      sup.forEach((x, i) => (t[`vcc${i}`] = x));
      gnd.forEach((x, i) => (t[`gnd${i}`] = x));
      out.push(dev(ctx, 'load', t, { Icc, von: on('von') ?? 1 }, { role: kind }));
      return { devices: out, model: kind };
    }
    case 'crystal':
    case 'connector':
      return { devices: [], model: kind };
    default:
      return { devices: [], model: 'none' };
  }
}

function inferKind(cat: string): string {
  switch (cat) {
    case 'resistor':
      return 'resistor';
    case 'capacitor':
    case 'capacitor-polarized':
      return 'capacitor';
    case 'inductor':
      return 'inductor';
    case 'ferrite':
      return 'ferrite';
    case 'led':
      return 'led';
    case 'diode':
    case 'zener':
    case 'schottky':
    case 'tvs':
      return 'diode';
    case 'switch':
    case 'button':
      return 'switch';
    case 'fuse':
      return 'fuse';
    case 'battery':
      return 'vsource';
    case 'bjt-npn':
    case 'bjt-pnp':
      return 'bjt';
    case 'mosfet-n':
    case 'mosfet-p':
      return 'mosfet';
    case 'ldo':
      return 'ldo';
    default:
      return TRANSPARENT.has(cat) ? 'connector' : 'unknown';
  }
}

/**
 * Build the circuit for one board or the whole system.
 *
 * - Nodes are net ids; the reference ground is the board's ground-class net(s) (class 'ground' or
 *   named GND/VSS/0V…). All ground nets of one board are merged into one node.
 * - System targets: each board's ground is its own node, tied to the reference board through the
 *   interconnect conductors (each conductor is a resistor from core `systemConnectivity`).
 * - Devices come from `part.sim`; when absent they are inferred from the category and value
 *   (resistor, capacitor, inductor, ferrite, LED, diode/zener/schottky/TVS, switch/button, fuse,
 *   battery, BJT/MOSFET (pins named C/B/E, D/G/S), LDO (pins IN/OUT/GND)); otherwise ignored with a
 *   warning. ComponentInstance.value, simOverrides and `opts.overrides` are applied. DNP parts are
 *   excluded. Nodes without a DC path to ground get a 1 GΩ leak to ground (warning).
 */
export function buildCircuit(project: Project, target: CircuitTarget, opts: BuildCircuitOptions = {}): Circuit {
  const warnings: string[] = [];
  const system = 'system' in target && target.system === true;
  const boards = system ? project.boards : project.boards.filter((b) => b.id === (target as { boardId: string }).boardId);
  if (!boards.length) throw new Error(system ? 'Project has no boards' : `Board '${(target as { boardId: string }).boardId}' not found`);
  const temperatureC = opts.temperatureC ?? project.settings?.ambientC ?? 25;
  const vt = 8.617333262e-5 * (temperatureC + 273.15);

  // ground nets per board
  const groundNets = new Map<string, Set<string>>();
  for (const b of boards) {
    const g = new Set(b.nets.filter(isGroundNet).map((n) => n.id));
    if (!g.size) {
      // fallback: negative terminal of a source/battery
      for (const c of b.components) {
        const part = project.parts[c.partId];
        if (!part || c.dnp) continue;
        const sim = part.sim;
        let neg: string | undefined;
        if (sim?.kind === 'vsource') neg = sim.n;
        else if (part.category === 'battery') neg = part.pins.find((p) => /^(-|neg|gnd|bat-)$/i.test(p.name))?.number ?? '2';
        if (neg && c.pinNets[neg]) {
          g.add(c.pinNets[neg]);
          const net = b.nets.find((n) => n.id === c.pinNets[neg]);
          warnings.push(`${b.name}: no ground net found; using '${net?.name ?? c.pinNets[neg]}' (${c.ref} negative terminal) as ground`);
          break;
        }
      }
      if (!g.size) warnings.push(`${b.name}: no ground net found — node voltages are floating (referenced through 1 GΩ leaks)`);
    }
    groundNets.set(b.id, g);
  }

  // reference board (system): first board with a source, else first with a ground
  let refBoard = boards[0];
  if (system) {
    const hasSource = (b: Board) =>
      b.components.some((c) => {
        const p = project.parts[c.partId];
        return !c.dnp && p && (p.sim?.kind === 'vsource' || p.category === 'battery');
      });
    refBoard = boards.find(hasSource) ?? boards.find((b) => groundNets.get(b.id)!.size) ?? boards[0];
  }

  const netToNode: Record<string, string> = {};
  const netNames: Record<string, string> = {};
  const seenNet = new Set<string>();
  const nodeOrder: string[] = [];
  const boardNetNode = new Map<string, Map<string, string>>();
  for (const b of boards) {
    const m = new Map<string, string>();
    const gnds = groundNets.get(b.id)!;
    const gndKey = b === refBoard ? '0' : `gnd@${b.id}`;
    for (const net of b.nets) {
      let key: string;
      if (gnds.has(net.id)) key = gndKey;
      else {
        key = net.id;
        if (seenNet.has(net.id)) {
          key = `${b.id}/${net.id}`;
          warnings.push(`Net id '${net.id}' is used on several boards; keyed as '${key}'`);
        }
      }
      seenNet.add(net.id);
      m.set(net.id, key);
      const mapKey = key.includes('/') && !gnds.has(net.id) ? key : net.id;
      netToNode[mapKey] = key;
      netNames[mapKey] = system ? `${b.name}/${net.name}` : net.name;
      if (key !== '0' && !nodeOrder.includes(key)) nodeOrder.push(key);
    }
    boardNetNode.set(b.id, m);
  }

  const devices: CircuitDevice[] = [];
  const components: Record<string, CircuitComponent> = {};
  const overrides = opts.overrides ?? {};

  for (const b of boards) {
    const m = boardNetNode.get(b.id)!;
    const netNode = (netId: string): string => {
      let k = m.get(netId);
      if (k === undefined) {
        // pin references a net missing from board.nets: treat as its own node
        k = netId;
        m.set(netId, k);
        netToNode[netId] = k;
        netNames[netId] = system ? `${b.name}/${netId}` : netId;
        if (!nodeOrder.includes(k)) nodeOrder.push(k);
      }
      return k;
    };
    for (const c of b.components) {
      if (c.dnp) continue;
      const part = project.parts[c.partId];
      const label = system ? `${b.name}/${c.ref}` : c.ref;
      if (!part) {
        warnings.push(`${label}: part '${c.partId}' not found in project library — not simulated`);
        continue;
      }
      const ovRaw = { ...(c.simOverrides ?? {}), ...(overrides[c.id] ?? overrides[`${b.name}/${c.ref}`] ?? (system ? undefined : overrides[c.ref]) ?? {}) };
      const ctx: Ctx = { project, board: b, comp: c, part, ov: normalizeOverrides(ovRaw), netNode, warnings, label };
      let res: { devices: CircuitDevice[]; model: string; color?: string };
      try {
        res = componentDevices(ctx, vt);
      } catch (e) {
        warnings.push(`${label}: ${(e as Error).message} — not simulated`);
        res = { devices: [], model: 'none' };
      }
      if (res.model === 'none' || res.model === 'unknown') {
        if (!part.sim && !TRANSPARENT.has(part.category) && part.category !== 'other') {
          warnings.push(`${label} (${part.mpn || part.category}): no simulation model for category '${part.category}' — ignored`);
        }
      }
      devices.push(...res.devices);
      const pinNodes: Record<string, string> = {};
      for (const [pin, netId] of Object.entries(c.pinNets)) pinNodes[pin] = netNode(netId);
      let powerRating = part.ratings?.power;
      if (powerRating === undefined) {
        const pr = Object.entries(part.params ?? {}).find(([k]) => /^power/i.test(k))?.[1];
        powerRating = parsePower(pr);
      }
      components[c.id] = {
        id: c.id,
        ref: label,
        boardId: b.id,
        boardName: b.name,
        partId: part.id,
        category: part.category,
        pinNodes,
        pinNets: { ...c.pinNets },
        color: res.color,
        powerRating,
        model: res.model === 'unknown' ? 'none' : res.model,
      };
    }
  }

  // interconnect conductors (system)
  const conductors: CircuitConductor[] = [];
  if (system) {
    const sc = systemConnectivity(project);
    warnings.push(...sc.warnings);
    const netBoard = new Map<string, string>();
    for (const b of boards) for (const n of b.nets) netBoard.set(n.id, b.id);
    for (const l of sc.links) {
      const ba = netBoard.get(l.netA);
      const bb = netBoard.get(l.netB);
      const nodeA = ba ? boardNetNode.get(ba)!.get(l.netA) : undefined;
      const nodeB = bb ? boardNetNode.get(bb)!.get(l.netB) : undefined;
      if (nodeA === undefined || nodeB === undefined) {
        warnings.push(`Conductor ${l.conductorId}: net not found on its board — skipped`);
        continue;
      }
      conductors.push({ id: l.conductorId, interconnectId: l.interconnectId, nodeA, nodeB, resistance: l.resistance, currentRating: l.currentRating });
      if (nodeA === nodeB) continue;
      devices.push({
        id: `link:${l.conductorId}`,
        kind: 'resistor',
        role: 'link',
        conductorId: l.conductorId,
        nodes: { p: nodeA, n: nodeB },
        params: { R: Math.max(l.resistance, 1e-4) },
      });
    }
  }

  // floating-node detection (no DC path to ground) -> 1 GΩ leaks
  const used = new Set<string>();
  for (const d of devices) for (const n of Object.values(d.nodes)) if (n !== '0') used.add(n);
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    let c = a;
    while (parent.has(c) && parent.get(c) !== r) {
      const nx = parent.get(c)!;
      parent.set(c, r);
      c = nx;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const n of used) parent.set(n, n);
  parent.set('0', '0');
  for (const d of devices) {
    const nd = d.nodes;
    switch (d.kind) {
      case 'capacitor':
      case 'isource':
      case 'load':
        break;
      case 'mosfet':
        union(nd.d, nd.s);
        break;
      case 'opamp':
        union(nd.out, nd.vp);
        union(nd.out, nd.vn);
        break;
      default: {
        const vals = Object.values(nd);
        for (let i = 1; i < vals.length; i++) union(vals[0], vals[i]);
      }
    }
  }
  const root0 = find('0');
  const floating: string[] = [];
  for (const n of used) {
    if (find(n) !== root0) {
      floating.push(n);
      devices.push({ id: `leak:${n}`, kind: 'resistor', role: 'leak', nodes: { p: n, n: '0' }, params: { R: 1e9 } });
    }
  }
  if (floating.length) {
    const names = floating.map((n) => netNames[n] ?? n);
    warnings.push(
      `${floating.length} net(s) have no DC path to ground and were tied to ground through 1 GΩ: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}`,
    );
  }

  // nodes: only those touched by devices (in board/net order), then extra internal nodes
  const nodes = nodeOrder.filter((k) => used.has(k));
  for (const n of used) if (!nodes.includes(n)) nodes.push(n);

  return { target, nodes, netToNode, netNames, devices, components, conductors, temperatureC, warnings };
}
