/**
 * DC operating point and transient analyses on top of {@link MnaSystem}.
 */
import { pack } from '@pcbcad/core';
import type { CircuitOpResult, CircuitTransientResult, Waveform as WaveformSignal } from '@pcbcad/core';
import { DiodeModel, LdoModel } from './devices';
import { MnaSystem } from './mna';
import type { Circuit, OpOptions, TransientOptions } from './types';

/**
 * Evaluates terminal currents and per-component power for the current solution of an
 * {@link MnaSystem}. Reused by the mixed-signal engine (allocation-free `evaluate()`).
 */
export class CircuitProbe {
  readonly sys: MnaSystem;
  readonly compIds: string[];
  readonly compIndex = new Map<string, number>();
  /** model index -> component index (-1 = none / not accounted) */
  readonly modelComp: Int32Array;
  /** model index -> offset into `currents` */
  readonly termOffset: Int32Array;
  /** Flat terminal currents (into device) for every model. */
  readonly currents: Float64Array;
  /** Per-component dissipated power (W) for the last evaluate(). */
  readonly power: Float64Array;
  /** Per-component delivered power (W) for sources. */
  readonly sourcePower: Float64Array;
  readonly isSourceComp: Uint8Array;

  constructor(sys: MnaSystem) {
    this.sys = sys;
    this.compIds = Object.keys(sys.circuit.components);
    this.compIds.forEach((id, i) => this.compIndex.set(id, i));
    const nm = sys.models.length;
    this.modelComp = new Int32Array(nm);
    this.termOffset = new Int32Array(nm + 1);
    let off = 0;
    sys.models.forEach((m, i) => {
      const ci = m.dev.componentId !== undefined && m.dev.role !== 'rail' ? this.compIndex.get(m.dev.componentId) : undefined;
      this.modelComp[i] = ci ?? -1;
      this.termOffset[i] = off;
      off += m.terms.length;
    });
    this.termOffset[nm] = off;
    this.currents = new Float64Array(off);
    this.power = new Float64Array(this.compIds.length);
    this.sourcePower = new Float64Array(this.compIds.length);
    this.isSourceComp = new Uint8Array(this.compIds.length);
    sys.models.forEach((m, i) => {
      if (m.isSource && this.modelComp[i] >= 0) this.isSourceComp[this.modelComp[i]] = 1;
    });
  }

  private readonly tmp = new Float64Array(64);

  /** Compute terminal currents and component powers at the system's current solution. */
  evaluate(): void {
    const { sys, currents, power, sourcePower } = this;
    const x = sys.x;
    power.fill(0);
    sourcePower.fill(0);
    const models = sys.models;
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const off = this.termOffset[i];
      const nt = m.terms.length;
      const buf = nt <= 64 ? this.tmp : new Float64Array(nt);
      m.currents(x, buf, sys.ctx);
      let p = 0;
      for (let k = 0; k < nt; k++) {
        currents[off + k] = buf[k];
        p += x[m.N[k]] * buf[k];
      }
      const ci = this.modelComp[i];
      if (ci < 0) continue;
      const internal = m.internalPower(x, sys.ctx);
      if (internal !== undefined) {
        power[ci] += internal;
        sourcePower[ci] += -p;
      } else {
        power[ci] += p;
      }
    }
  }

  /** Current into terminal `k` of model `i` from the last evaluate(). */
  current(modelIndex: number, k: number): number {
    return this.currents[this.termOffset[modelIndex] + k];
  }

  /** component id -> pin -> current into the pin (A), for every connected pin. */
  pinCurrents(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    const comps = this.sys.circuit.components;
    for (const id of this.compIds) {
      const o: Record<string, number> = {};
      for (const pin of Object.keys(comps[id].pinNodes)) o[pin] = 0;
      out[id] = o;
    }
    this.sys.models.forEach((m, i) => {
      const cid = m.dev.componentId;
      if (!cid || !out[cid] || !m.dev.pins) return;
      m.terms.forEach((t, k) => {
        const pin = m.dev.pins![t];
        if (pin === undefined) return;
        out[cid][pin] = (out[cid][pin] ?? 0) + this.currents[this.termOffset[i] + k];
      });
    });
    for (const o of Object.values(out)) for (const k of Object.keys(o)) if (Math.abs(o[k]) < 1e-18) o[k] = 0;
    return out;
  }
}

function netVoltages(sys: MnaSystem): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [netId, node] of Object.entries(sys.circuit.netToNode)) {
    if (node === '0') out[netId] = 0;
    else if (sys.nodeIndex.has(node)) out[netId] = sys.x[sys.nodeIndex.get(node)!];
  }
  return out;
}

function netNamesFor(circuit: Circuit, volts: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of Object.keys(volts)) out[id] = circuit.netNames[id] ?? id;
  return out;
}

const fmt = (v: number, unit: string): string => {
  const a = Math.abs(v);
  if (a >= 1) return `${v.toPrecision(3)} ${unit}`;
  if (a >= 1e-3) return `${(v * 1e3).toPrecision(3)} m${unit}`;
  return `${(v * 1e6).toPrecision(3)} µ${unit}`;
};

/** Post-solve design checks (ratings, regulator state, conductor ampacity). */
function opChecks(sys: MnaSystem, probe: CircuitProbe, warnings: string[]): void {
  const comps = sys.circuit.components;
  probe.compIds.forEach((id, i) => {
    const c = comps[id];
    const p = probe.power[i];
    if (c.powerRating && p > c.powerRating) warnings.push(`${c.ref} dissipates ${fmt(p, 'W')} — exceeds its ${fmt(c.powerRating, 'W')} rating`);
  });
  sys.models.forEach((m, i) => {
    const d = m.dev;
    const ref = d.componentId ? comps[d.componentId]?.ref ?? d.id : d.id;
    if (m instanceof LdoModel) {
      const s = m.state(sys.x);
      if (s.vin > 0.5 && s.dropout) warnings.push(`${ref}: LDO in dropout (Vin ${s.vin.toFixed(2)} V, Vout ${s.vout.toFixed(2)} V, needs ≥ ${(m.vreg + m.dropout).toFixed(2)} V)`);
      if (s.limited) warnings.push(`${ref}: LDO at its current limit (${fmt(s.iout, 'A')} ≥ ${fmt(m.imax, 'A')})`);
    } else if (d.role === 'fuse') {
      const ih = Number(d.params.Ihold ?? 0);
      const cur = Math.abs(probe.current(i, 0));
      if (ih > 0 && cur > ih) warnings.push(`${ref}: fuse current ${fmt(cur, 'A')} exceeds hold current ${fmt(ih, 'A')}`);
    } else if (d.role === 'led' && m instanceof DiodeModel) {
      const cur = probe.current(i, 0);
      const If = Number(d.params.If ?? 0.02);
      if (cur > 2 * If) warnings.push(`${ref}: LED current ${fmt(cur, 'A')} is more than twice its rated ${fmt(If, 'A')}`);
    }
  });
  for (const cd of sys.circuit.conductors) {
    const mi = sys.models.findIndex((m) => m.dev.conductorId === cd.id);
    if (mi < 0) continue;
    const cur = Math.abs(probe.current(mi, 0));
    if (cur > cd.currentRating) warnings.push(`Interconnect conductor ${cd.id}: ${fmt(cur, 'A')} exceeds its ${fmt(cd.currentRating, 'A')} rating`);
  }
}

/**
 * DC operating point (Modified Nodal Analysis, damped Newton–Raphson with pn-junction/FET
 * voltage limiting; gmin stepping, then source stepping when plain Newton fails).
 *
 * Reports node voltages (V) per net id, per-component dissipated power (W: I²R for resistors,
 * V·I for diodes/LEDs, Vds·Id for MOSFETs, (Vin−Vout)·Iout + Vin·Iq for LDOs, Pin−Pout for
 * switchers, Vsupply·Icc for ICs/MCUs; sources report internal I²·Rint loss in componentPower and
 * delivered power in sourcePower), currents into every connected pin, interconnect conductor
 * currents (from → to positive), and design warnings (ratings exceeded, LDO dropout/limit...).
 */
export function solveOp(circuit: Circuit, opts: OpOptions = {}): CircuitOpResult {
  const sys = new MnaSystem(circuit);
  const warnings = [...circuit.warnings];
  const r = sys.solveDc({ maxIter: opts.maxIter, reltol: opts.reltol, vntol: opts.vntol, abstol: opts.abstol, time: opts.time });
  if (!r.converged) warnings.push(`Operating point did not converge (${r.iterations} iterations${r.singular ? ', singular matrix — check for voltage-source loops or floating sources' : ''}); results are approximate`);
  else if (r.method !== 'newton') warnings.push(`Operating point converged using ${r.method}`);
  return opResultFromSystem(sys, r.converged, r.iterations, warnings);
}

/** Build a CircuitOpResult from a solved system (shared with the mixed-signal engine). */
export function opResultFromSystem(sys: MnaSystem, converged: boolean, iterations: number, warnings: string[]): CircuitOpResult {
  const probe = new CircuitProbe(sys);
  probe.evaluate();
  const nodeVoltages = netVoltages(sys);
  const componentPower: Record<string, number> = {};
  const sourcePower: Record<string, number> = {};
  probe.compIds.forEach((id, i) => {
    const c = sys.circuit.components[id];
    if (c.model === 'none' || c.model === 'connector' || c.model === 'crystal') return;
    componentPower[id] = probe.power[i];
    if (probe.isSourceComp[i]) sourcePower[id] = probe.sourcePower[i];
  });
  const conductorCurrents: Record<string, number> = {};
  sys.models.forEach((m, i) => {
    if (m.dev.conductorId) conductorCurrents[m.dev.conductorId] = probe.current(i, 0);
  });
  for (const cd of sys.circuit.conductors) if (conductorCurrents[cd.id] === undefined) conductorCurrents[cd.id] = 0;
  opChecks(sys, probe, warnings);
  return {
    kind: 'circuit-op',
    nodeVoltages,
    netNames: netNamesFor(sys.circuit, nodeVoltages),
    componentPower,
    pinCurrents: probe.pinCurrents(),
    conductorCurrents: sys.circuit.conductors.length ? conductorCurrents : undefined,
    sourcePower,
    converged,
    iterations,
    warnings: dedupe(warnings),
  };
}

function dedupe(a: string[]): string[] {
  return Array.from(new Set(a));
}

/* ------------------------------------------------------------------------------------------ */
/* Transient                                                                                   */
/* ------------------------------------------------------------------------------------------ */

interface SignalSpec {
  name: string;
  kind: 'voltage' | 'current';
  unit: string;
  netId?: string;
  componentId?: string;
  pin?: string;
  /** voltage: unknown index (or -1 = ground); current: model index + terminal + sign */
  index: number;
  model?: number;
  term?: number;
  sign?: number;
  data: number[];
}

function findComponent(circuit: Circuit, ref: string): string | undefined {
  if (circuit.components[ref]) return ref;
  const low = ref.toLowerCase();
  const hits = Object.values(circuit.components).filter((c) => c.ref.toLowerCase() === low || c.ref.toLowerCase().endsWith(`/${low}`));
  return hits.length === 1 ? hits[0].id : hits.find((c) => c.ref.toLowerCase() === low)?.id;
}

function currentSignal(sys: MnaSystem, compId: string, pin: string | undefined, name: string): SignalSpec | null {
  for (let i = 0; i < sys.models.length; i++) {
    const m = sys.models[i];
    if (m.dev.componentId !== compId || m.dev.role === 'rail' || m.dev.role === 'body-diode') continue;
    if (pin !== undefined) {
      const k = m.terms.findIndex((t) => m.dev.pins?.[t] === pin);
      if (k >= 0) return { name, kind: 'current', unit: 'A', componentId: compId, pin, index: -1, model: i, term: k, sign: 1, data: [] };
      continue;
    }
    // sources: current delivered out of + terminal; others: current into the first terminal
    const sign = m.isSource ? -1 : 1;
    return { name, kind: 'current', unit: 'A', componentId: compId, pin: m.dev.pins?.[m.terms[0]], index: -1, model: i, term: 0, sign, data: [] };
  }
  return null;
}

function buildSignals(sys: MnaSystem, probes: string[] | undefined, warnings: string[]): SignalSpec[] {
  const circuit = sys.circuit;
  const sigs: SignalSpec[] = [];
  const voltageSig = (netId: string): SignalSpec | null => {
    const node = circuit.netToNode[netId];
    if (node === undefined) return null;
    const idx = node === '0' ? -1 : sys.nodeIndex.get(node);
    if (idx === undefined) return null;
    return { name: circuit.netNames[netId] ?? netId, kind: 'voltage', unit: 'V', netId, index: idx, data: [] };
  };
  if (!probes || !probes.length) {
    for (const netId of Object.keys(circuit.netToNode)) {
      const s = voltageSig(netId);
      if (s && s.index >= 0) sigs.push(s);
    }
    sys.models.forEach((m) => {
      if ((m.dev.kind === 'vsource' || m.dev.kind === 'inductor') && m.dev.componentId && m.dev.role !== 'rail') {
        const ref = circuit.components[m.dev.componentId]?.ref ?? m.dev.componentId;
        const s = currentSignal(sys, m.dev.componentId, undefined, `I(${ref})`);
        if (s) sigs.push(s);
      }
    });
    return sigs;
  }
  for (const p of probes) {
    const cm = /^\s*I\(\s*([^).]+?)(?:\.([^)]+))?\s*\)\s*$/i.exec(p);
    if (cm) {
      const cid = findComponent(circuit, cm[1]);
      const s = cid ? currentSignal(sys, cid, cm[2], p) : null;
      if (s) sigs.push(s);
      else warnings.push(`Probe '${p}': component/pin not found or not simulated`);
      continue;
    }
    let netId: string | undefined = circuit.netToNode[p] !== undefined ? p : undefined;
    if (!netId) {
      const low = p.toLowerCase();
      const matches = Object.entries(circuit.netNames).filter(([, n]) => n.toLowerCase() === low || n.toLowerCase().endsWith(`/${low}`));
      netId = matches.find(([, n]) => n.toLowerCase() === low)?.[0] ?? (matches.length === 1 ? matches[0][0] : undefined);
    }
    const s = netId ? voltageSig(netId) : null;
    if (s) sigs.push(s);
    else warnings.push(`Probe '${p}': net not found or not simulated`);
  }
  return sigs;
}

/**
 * Transient analysis. Trapezoidal integration with backward-Euler steps at t = 0 and after every
 * source breakpoint (PULSE corners, PWL points); companion models for C (with ESR) and L (with
 * DCR); Newton iteration at each time point (step halved on non-convergence).
 *
 * Starts from the DC operating point at t = 0. The internal step is min(tStep, maxStep) and is
 * shortened to land exactly on breakpoints; there is no LTE step control, so choose tStep to
 * resolve the fastest dynamics of interest (e.g. ≤ τ/20).
 *
 * Signals: node voltages for all nets (or `probes`), plus source currents (I(V1) = current
 * delivered out of the + terminal) and inductor currents (p → n). avgPower per component is the
 * time-average of the dissipated power over [0, tStop].
 */
export function solveTransient(circuit: Circuit, opts: TransientOptions): CircuitTransientResult {
  const warnings = [...circuit.warnings];
  if (!(opts.tStop > 0) || !(opts.tStep > 0)) throw new Error('solveTransient: tStop and tStep must be > 0');
  const sys = new MnaSystem(circuit);
  const dc = sys.solveDc({ time: 0 });
  if (!dc.converged) warnings.push('Initial operating point did not converge; transient starts from an approximate state');
  sys.initTran();
  const probe = new CircuitProbe(sys);
  const sigs = buildSignals(sys, opts.probes, warnings);
  const hMax = Math.min(opts.maxStep ?? opts.tStep, opts.tStep);
  const tStop = opts.tStop;
  const maxPoints = 2_000_000;
  const estPoints = tStop / hMax;
  const stride = estPoints > maxPoints ? Math.ceil(estPoints / maxPoints) : 1;
  if (stride > 1) warnings.push(`Transient produces ~${Math.round(estPoints)} points; recording every ${stride}th step`);
  const time: number[] = [];
  const energy = new Float64Array(probe.compIds.length);
  const lastPower = new Float64Array(probe.compIds.length);
  const record = (t: number) => {
    time.push(t);
    for (const s of sigs) {
      if (s.kind === 'voltage') s.data.push(s.index < 0 ? 0 : sys.x[s.index]);
      else s.data.push((s.sign ?? 1) * probe.current(s.model!, s.term!));
    }
  };
  probe.evaluate();
  lastPower.set(probe.power);
  record(0);
  const bps = sys.breakpoints(0, tStop);
  bps.push(tStop);
  let bi = 0;
  let t = 0;
  let h = hMax;
  const hMin = hMax * 1e-9;
  let useBE = true;
  let steps = 0;
  let failed = false;
  const opt = { maxIter: opts.maxIter ?? 50, reltol: opts.reltol ?? 1e-6 };
  while (t < tStop * (1 - 1e-12) && !failed) {
    while (bi < bps.length && bps[bi] <= t * (1 + 1e-12) + 1e-18) bi++;
    const nextBp = bi < bps.length ? bps[bi] : tStop;
    let hTry = Math.min(h, nextBp - t);
    // avoid leaving a sliver before the breakpoint
    if (nextBp - (t + hTry) < 0.01 * hTry) hTry = nextBp - t;
    const r = sys.stepTran(t + hTry, hTry, !useBE, opt);
    if (!r.converged) {
      h = hTry / 8;
      useBE = true;
      if (h < hMin) {
        warnings.push(`Transient failed to converge at t = ${t.toExponential(3)} s; stopping early`);
        failed = true;
      }
      continue;
    }
    sys.acceptTran();
    const tNew = t + hTry;
    probe.evaluate();
    for (let i = 0; i < energy.length; i++) {
      energy[i] += 0.5 * (lastPower[i] + probe.power[i]) * hTry;
      lastPower[i] = probe.power[i];
    }
    t = tNew;
    steps++;
    if (steps % stride === 0 || t >= tStop * (1 - 1e-12)) record(t);
    useBE = Math.abs(t - nextBp) <= 1e-12 * Math.max(1e-9, Math.abs(t)) + 1e-18;
    if (h < hMax) h = Math.min(hMax, h * 2);
  }
  const avgPower: Record<string, number> = {};
  const tEnd = Math.max(t, 1e-30);
  probe.compIds.forEach((id, i) => {
    const c = circuit.components[id];
    if (c.model === 'none' || c.model === 'connector' || c.model === 'crystal') return;
    avgPower[id] = energy[i] / tEnd;
  });
  const signals: WaveformSignal[] = sigs.map((s) => ({
    name: s.name,
    kind: s.kind,
    unit: s.unit,
    netId: s.netId,
    componentId: s.componentId,
    pin: s.pin,
    data: pack(new Float32Array(s.data)),
  }));
  const netNames: Record<string, string> = {};
  for (const s of sigs) if (s.netId) netNames[s.netId] = circuit.netNames[s.netId] ?? s.netId;
  return { kind: 'circuit-transient', time: pack(new Float64Array(time)), signals, avgPower, netNames, warnings: dedupe(warnings) };
}
