/**
 * Device models for the MNA engine (DC operating point + transient companion models).
 *
 * Conventions:
 *  - Unknown vector x = [node voltages, internal nodes, branch currents]; ground is the extra
 *    index `G = size` with x[G] = 0 and a trash slot in A/b, so stamps never branch on ground.
 *  - Device "currents" are currents INTO each terminal (passive sign convention).
 *  - Nonlinear devices linearise around (limited) junction voltages: I ≈ I0 + Σ g·(u − u0).
 */
import type { CircuitDevice, DeviceParam } from './types';
import type { PatternBuilder } from './linalg';
import { makeWaveform, type Waveform } from './waveforms';

/** Thermal voltage kT/q at the given temperature (°C). */
export function thermalVoltage(tempC: number): number {
  return 8.617333262e-5 * (tempC + 273.15);
}

/** Context available to devices while stamping. */
export interface LoadCtx {
  x: Float64Array;
  A: Float64Array;
  b: Float64Array;
  /** DC analysis: capacitors open, inductors are DCR shorts. */
  dc: boolean;
  t: number;
  h: number;
  /** Trapezoidal integration (else backward Euler). */
  trap: boolean;
  /** Source-stepping factor 0..1 applied to independent sources. */
  srcScale: number;
  /** Conductance added across junctions (S). */
  gmin: number;
  /** Count of devices that limited junction voltages this iteration (prevents convergence). */
  noncon: number;
}

export interface AllocCtx {
  /** Node index for a node key ('0' = ground → -1). */
  node(key: string): number;
  /** New internal voltage node. */
  internal(name: string): number;
  /** New branch-current unknown. */
  branch(name: string): number;
}

/* ------------------------------------------------------------------------------------------ */
/* Smooth helper functions                                                                     */
/* ------------------------------------------------------------------------------------------ */

function softplus(z: number): number {
  if (z > 35) return z;
  if (z < -35) return Math.exp(z);
  return Math.log1p(Math.exp(z));
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Smooth saturation to [0,1]: ≈ clamp(u,0,1) with corner width 1/k. Returns [S, dS/du]. */
function satur(u: number, k: number, out: Float64Array): void {
  out[0] = (softplus(k * u) - softplus(k * (u - 1))) / k;
  out[1] = sigmoid(k * u) - sigmoid(k * (u - 1));
}

/** Smooth min; returns value and partial derivatives (da, db) in out[0..2]. */
function smin(a: number, b: number, eps: number, out: Float64Array): void {
  const d = a - b;
  const r = Math.sqrt(d * d + eps * eps);
  out[0] = (a + b - r) / 2;
  out[1] = (1 - d / r) / 2;
  out[2] = (1 + d / r) / 2;
}

/** Smooth max; returns value and partial derivatives (da, db) in out[0..2]. */
function smax(a: number, b: number, eps: number, out: Float64Array): void {
  const d = a - b;
  const r = Math.sqrt(d * d + eps * eps);
  out[0] = (a + b + r) / 2;
  out[1] = (1 + d / r) / 2;
  out[2] = (1 - d / r) / 2;
}

/** SPICE (ngspice) pn-junction voltage limiting. Returns [vlim, limitedFlag]. */
export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): [number, boolean] {
  if (vnew > vcrit && Math.abs(vnew - vold) > vt + vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      vnew = arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    } else {
      vnew = vt * Math.log(vnew / vt);
    }
    return [vnew, true];
  }
  if (vnew < 0) {
    const arg = vold > 0 ? -1 * vold - 1 : 2 * vold - 1;
    if (vnew < arg) return [arg, true];
  }
  return [vnew, false];
}

/** SPICE FET gate-voltage limiting (DEVfetlim). */
export function fetlim(vnew: number, vold: number, vto: number): number {
  const vtsthi = Math.abs(2 * (vold - vto)) + 2;
  const vtstlo = vtsthi / 2 + 2;
  const vtox = vto + 3.5;
  const delv = vnew - vold;
  if (vold >= vto) {
    if (vold >= vtox) {
      if (delv <= 0) {
        if (vnew >= vtox) {
          if (-delv > vtstlo) vnew = vold - vtstlo;
        } else {
          vnew = Math.max(vnew, vto + 2);
        }
      } else if (delv >= vtsthi) {
        vnew = vold + vtsthi;
      }
    } else if (delv <= 0) {
      vnew = Math.max(vnew, vto - 0.5);
    } else {
      vnew = Math.min(vnew, vto + 4);
    }
  } else if (delv <= 0) {
    if (-delv > vtsthi) vnew = vold - vtsthi;
  } else {
    const vtemp = vto + 0.5;
    if (vnew <= vtemp) {
      if (delv > vtstlo) vnew = vold + vtstlo;
    } else {
      vnew = vtemp;
    }
  }
  return vnew;
}

/** SPICE drain-source voltage limiting (DEVlimvds). */
export function limvds(vnew: number, vold: number): number {
  if (vold >= 3.5) {
    if (vnew > vold) vnew = Math.min(vnew, 3 * vold + 2);
    else if (vnew < 3.5) vnew = Math.max(vnew, 2);
  } else if (vnew > vold) {
    vnew = Math.min(vnew, 4);
  } else {
    vnew = Math.max(vnew, -0.5);
  }
  return vnew;
}

export function pnum(v: DeviceParam | undefined, dflt: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return dflt;
}

/* ------------------------------------------------------------------------------------------ */
/* Base class                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export abstract class Model {
  readonly dev: CircuitDevice;
  /** Terminal names in order (keys of dev.nodes). */
  readonly terms: string[];
  /** Node/branch indices: terminals first, then model-specific unknowns (ground → G). */
  N: Int32Array = new Int32Array(0);
  /** Matrix value positions (ground entries → trash). */
  S: Int32Array = new Int32Array(0);
  protected idx: number[] = [];
  protected handles: number[] = [];
  /** True if load() depends non-linearly on x. */
  nonlinear = false;
  /** Independent source (reports sourcePower). */
  isSource = false;
  /** Value changes with time (forces re-evaluation each transient step / sample). */
  timeVarying = false;

  constructor(dev: CircuitDevice, terms: string[]) {
    this.dev = dev;
    this.terms = terms;
  }

  /** Allocate unknowns. Default: resolve terminal nodes only. */
  allocate(a: AllocCtx): void {
    for (const t of this.terms) this.idx.push(a.node(this.dev.nodes[t] ?? '0'));
  }

  /** Register matrix entries (row, col indices refer to this.idx entries). */
  abstract pattern(pb: PatternBuilder): void;

  protected reg(pb: PatternBuilder, r: number, c: number): void {
    this.handles.push(pb.slot(this.idx[r], this.idx[c]));
  }

  /** Register a 2×2 conductance block between idx entries a and b (order aa, ab, ba, bb). */
  protected regG(pb: PatternBuilder, a: number, b: number): void {
    this.reg(pb, a, a);
    this.reg(pb, a, b);
    this.reg(pb, b, a);
    this.reg(pb, b, b);
  }

  /** Register a full nt×nt grid over the first nt idx entries (row-major). */
  protected regGrid(pb: PatternBuilder, nt: number): void {
    for (let r = 0; r < nt; r++) for (let c = 0; c < nt; c++) this.reg(pb, r, c);
  }

  finalize(ground: number, position: (h: number) => number): void {
    this.N = Int32Array.from(this.idx.map((i) => (i < 0 ? ground : i)));
    this.S = Int32Array.from(this.handles.map(position));
  }

  /** Initialise iteration memory (limiting) from a solution vector. */
  initIter(_x: Float64Array): void {}

  abstract load(c: LoadCtx): void;

  /** Currents into each terminal at solution x (same order as `terms`). */
  abstract currents(x: Float64Array, out: Float64Array, c: LoadCtx): void;

  /** Transient: initialise dynamic state from the DC solution. */
  initTran(_x: Float64Array): void {}

  /** Transient: commit the converged time point. */
  accept(_x: Float64Array, _c: LoadCtx): void {}

  /** Source breakpoints in [t0, t1]. */
  breakpoints(_t0: number, _t1: number): number[] {
    return [];
  }

  /** Internal power dissipation (W) for sources; undefined = Σ V·I over terminals. */
  internalPower(_x: Float64Array, _c: LoadCtx): number | undefined {
    return undefined;
  }
}

function stampG(A: Float64Array, S: Int32Array, o: number, g: number): void {
  A[S[o]] += g;
  A[S[o + 1]] -= g;
  A[S[o + 2]] -= g;
  A[S[o + 3]] += g;
}

/* ------------------------------------------------------------------------------------------ */
/* Linear devices                                                                              */
/* ------------------------------------------------------------------------------------------ */

export class ResistorModel extends Model {
  /** Conductance (S); may be changed between solves (switches). */
  g: number;
  constructor(dev: CircuitDevice) {
    super(dev, ['p', 'n']);
    const R = Math.max(pnum(dev.params.R, 1e3), 1e-6);
    this.g = 1 / R;
  }
  pattern(pb: PatternBuilder): void {
    this.regG(pb, 0, 1);
  }
  load(c: LoadCtx): void {
    stampG(c.A, this.S, 0, this.g);
  }
  currents(x: Float64Array, out: Float64Array): void {
    const i = this.g * (x[this.N[0]] - x[this.N[1]]);
    out[0] = i;
    out[1] = -i;
  }
}

export class CapacitorModel extends Model {
  readonly C: number;
  readonly esr: number;
  vc = 0;
  ic = 0;
  private geq = 0;
  private jeq = 0;
  constructor(dev: CircuitDevice) {
    super(dev, ['p', 'n']);
    this.C = Math.max(pnum(dev.params.C, 1e-6), 1e-18);
    this.esr = Math.max(pnum(dev.params.esr, 0), 0);
  }
  pattern(pb: PatternBuilder): void {
    this.regG(pb, 0, 1);
  }
  load(c: LoadCtx): void {
    if (c.dc) {
      this.geq = 0;
      this.jeq = 0;
      return;
    }
    if (c.trap) {
      const k = c.h / (2 * this.C);
      this.geq = 1 / (k + this.esr);
      this.jeq = this.geq * (this.vc + k * this.ic);
    } else {
      this.geq = 1 / (c.h / this.C + this.esr);
      this.jeq = this.geq * this.vc;
    }
    stampG(c.A, this.S, 0, this.geq);
    c.b[this.N[0]] += this.jeq;
    c.b[this.N[1]] -= this.jeq;
  }
  currents(x: Float64Array, out: Float64Array, c: LoadCtx): void {
    const i = c.dc ? 0 : this.geq * (x[this.N[0]] - x[this.N[1]]) - this.jeq;
    out[0] = i;
    out[1] = -i;
  }
  override initTran(x: Float64Array): void {
    this.vc = x[this.N[0]] - x[this.N[1]];
    this.ic = 0;
  }
  override accept(x: Float64Array, c: LoadCtx): void {
    if (c.dc) return;
    const v = x[this.N[0]] - x[this.N[1]];
    const i = this.geq * v - this.jeq;
    this.ic = i;
    this.vc = v - this.esr * i;
  }
}

/** Two-terminal element with a branch current unknown (inductor / voltage source). */
abstract class BranchModel extends Model {
  override allocate(a: AllocCtx): void {
    super.allocate(a);
    this.idx.push(a.branch(this.dev.id));
  }
  pattern(pb: PatternBuilder): void {
    this.reg(pb, 0, 2); // p,k
    this.reg(pb, 1, 2); // n,k
    this.reg(pb, 2, 0); // k,p
    this.reg(pb, 2, 1); // k,n
    this.reg(pb, 2, 2); // k,k
  }
  protected stampIncidence(A: Float64Array): void {
    const S = this.S;
    A[S[0]] += 1;
    A[S[1]] -= 1;
    A[S[2]] += 1;
    A[S[3]] -= 1;
  }
  currents(x: Float64Array, out: Float64Array): void {
    const i = x[this.N[2]];
    out[0] = i;
    out[1] = -i;
  }
}

export class InductorModel extends BranchModel {
  readonly L: number;
  readonly dcr: number;
  il = 0;
  vl = 0;
  constructor(dev: CircuitDevice) {
    super(dev, ['p', 'n']);
    this.L = Math.max(pnum(dev.params.L, 1e-6), 1e-15);
    this.dcr = Math.max(pnum(dev.params.dcr, 0), 1e-6);
  }
  load(c: LoadCtx): void {
    this.stampIncidence(c.A);
    const kk = this.S[4];
    const k = this.N[2];
    if (c.dc) {
      c.A[kk] -= this.dcr;
    } else if (c.trap) {
      const r = (2 * this.L) / c.h;
      c.A[kk] -= this.dcr + r;
      c.b[k] += -r * this.il - this.vl;
    } else {
      const r = this.L / c.h;
      c.A[kk] -= this.dcr + r;
      c.b[k] += -r * this.il;
    }
  }
  override initTran(x: Float64Array): void {
    this.il = x[this.N[2]];
    this.vl = 0;
  }
  override accept(x: Float64Array, c: LoadCtx): void {
    if (c.dc) return;
    this.il = x[this.N[2]];
    this.vl = x[this.N[0]] - x[this.N[1]] - this.dcr * this.il;
  }
}

export class VSourceModel extends BranchModel {
  readonly wave: Waveform;
  readonly Rint: number;
  /** Optional override of the DC value (mixed-signal). */
  constructor(dev: CircuitDevice) {
    super(dev, ['p', 'n']);
    this.isSource = true;
    this.Rint = Math.max(pnum(dev.params.Rint, 0), 0);
    this.wave = makeWaveform(dev.params, pnum(dev.params.V, 0));
    this.timeVarying = !this.wave.constant;
  }
  load(c: LoadCtx): void {
    this.stampIncidence(c.A);
    c.A[this.S[4]] -= this.Rint;
    c.b[this.N[2]] += this.wave.value(c.t) * c.srcScale;
  }
  override breakpoints(t0: number, t1: number): number[] {
    return this.wave.breakpoints(t0, t1);
  }
  override internalPower(x: Float64Array): number {
    const i = x[this.N[2]];
    return i * i * this.Rint;
  }
}

export class ISourceModel extends Model {
  readonly wave: Waveform;
  constructor(dev: CircuitDevice) {
    super(dev, ['p', 'n']);
    this.isSource = true;
    this.wave = makeWaveform(dev.params, pnum(dev.params.I, 0));
    this.timeVarying = !this.wave.constant;
  }
  pattern(): void {}
  load(c: LoadCtx): void {
    const i = this.wave.value(c.t) * c.srcScale;
    c.b[this.N[0]] -= i;
    c.b[this.N[1]] += i;
  }
  currents(_x: Float64Array, out: Float64Array, c: LoadCtx): void {
    const i = this.wave.value(c.t) * c.srcScale;
    out[0] = i;
    out[1] = -i;
  }
  override breakpoints(t0: number, t1: number): number[] {
    return this.wave.breakpoints(t0, t1);
  }
  override internalPower(): number {
    return 0;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Diode (Shockley + series resistance + reverse breakdown)                                    */
/* ------------------------------------------------------------------------------------------ */

export class DiodeModel extends Model {
  readonly Is: number;
  readonly nVt: number;
  readonly Rs: number;
  readonly Bv: number;
  readonly Ibv: number;
  readonly vcrit: number;
  private readonly vtBv: number;
  private vdOld = 0;
  private hasInternal: boolean;

  constructor(dev: CircuitDevice, tempC: number) {
    super(dev, ['a', 'k']);
    this.nonlinear = true;
    const vt = thermalVoltage(tempC);
    this.Is = Math.max(pnum(dev.params.Is, 1e-14), 1e-30);
    this.nVt = Math.max(pnum(dev.params.n, 1), 0.3) * vt;
    this.Rs = Math.max(pnum(dev.params.Rs, 0), 0);
    this.Bv = Math.max(pnum(dev.params.Bv, 0), 0);
    this.Ibv = Math.max(pnum(dev.params.Ibv, 1e-3), 1e-12);
    this.vtBv = vt;
    this.vcrit = this.nVt * Math.log(this.nVt / (Math.SQRT2 * this.Is));
    this.hasInternal = this.Rs > 1e-6;
  }

  override allocate(a: AllocCtx): void {
    super.allocate(a);
    // junction anode node (internal when Rs > 0)
    this.idx.push(this.hasInternal ? a.internal(`${this.dev.id}#ai`) : this.idx[0]);
  }

  pattern(pb: PatternBuilder): void {
    this.regG(pb, 2, 1); // junction ai-k (slots 0..3)
    if (this.hasInternal) this.regG(pb, 0, 2); // Rs a-ai (slots 4..7)
  }

  /** Junction current and conductance at vd (without gmin). */
  evalJ(vd: number, out: Float64Array): void {
    const nVt = this.nVt;
    let arg = vd / nVt;
    let id: number;
    let gd: number;
    if (arg > 80) {
      const e = Math.exp(80);
      id = this.Is * (e * (1 + (arg - 80)) - 1);
      gd = (this.Is * e) / nVt;
    } else {
      if (arg < -80) arg = -80;
      const e = Math.exp(arg);
      id = this.Is * (e - 1);
      gd = (this.Is * e) / nVt;
    }
    if (this.Bv > 0) {
      let a2 = -(vd + this.Bv) / this.vtBv;
      let lin = 0;
      if (a2 > 80) {
        lin = a2 - 80;
        a2 = 80;
      }
      if (a2 > -80) {
        const e = Math.exp(a2);
        id -= this.Ibv * e * (1 + lin);
        gd += (this.Ibv * e) / this.vtBv;
      }
    }
    out[0] = id;
    out[1] = gd;
  }

  override initIter(x: Float64Array): void {
    this.vdOld = x[this.N[2]] - x[this.N[1]];
  }

  private readonly tmp = new Float64Array(2);

  load(c: LoadCtx): void {
    const x = c.x;
    let vd = x[this.N[2]] - x[this.N[1]];
    let limited = false;
    if (this.Bv > 0 && vd < Math.min(0, -this.Bv + 10 * this.vtBv)) {
      const vcritBv = this.vtBv * Math.log(this.vtBv / (Math.SQRT2 * this.Ibv));
      const [v, l] = pnjlim(-(vd + this.Bv), -(this.vdOld + this.Bv), this.vtBv, vcritBv);
      vd = -(v + this.Bv);
      limited = l;
    } else {
      const [v, l] = pnjlim(vd, this.vdOld, this.nVt, this.vcrit);
      vd = v;
      limited = l;
    }
    if (limited) c.noncon++;
    this.vdOld = vd;
    this.evalJ(vd, this.tmp);
    const gd = this.tmp[1] + c.gmin;
    const id = this.tmp[0] + c.gmin * vd;
    const ieq = id - gd * vd;
    stampG(c.A, this.S, 0, gd);
    c.b[this.N[2]] -= ieq;
    c.b[this.N[1]] += ieq;
    if (this.hasInternal) stampG(c.A, this.S, 4, 1 / this.Rs);
  }

  currents(x: Float64Array, out: Float64Array, c: LoadCtx): void {
    let i: number;
    if (this.hasInternal) {
      i = (x[this.N[0]] - x[this.N[2]]) / this.Rs;
    } else {
      const vd = x[this.N[0]] - x[this.N[1]];
      this.evalJ(vd, this.tmp);
      i = this.tmp[0] + c.gmin * vd;
    }
    out[0] = i;
    out[1] = -i;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Generic multi-terminal nonlinear device                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Nonlinear device described by control voltages u_c = V(ta_c) - V(tb_c) over its terminals.
 * Subclasses implement `evaluate(u, I, g, limit)` filling terminal currents I (into the device)
 * and conductances g[k*nc + c] = dI_k/du_c; `limit` allows junction limiting of u in place.
 */
abstract class MultiTerminalModel extends Model {
  protected nt: number;
  protected nc: number;
  protected ctrl: Int32Array;
  protected u: Float64Array;
  protected I: Float64Array;
  protected G: Float64Array;

  constructor(dev: CircuitDevice, terms: string[], controls: [number, number][]) {
    super(dev, terms);
    this.nonlinear = true;
    this.nt = terms.length;
    this.nc = controls.length;
    this.ctrl = Int32Array.from(controls.flat());
    this.u = new Float64Array(this.nc);
    this.I = new Float64Array(this.nt);
    this.G = new Float64Array(this.nt * this.nc);
  }

  pattern(pb: PatternBuilder): void {
    this.regGrid(pb, this.nt);
  }

  protected computeControls(x: Float64Array, ctrl: Int32Array, u: Float64Array): void {
    const N = this.N;
    for (let c = 0; c < this.nc; c++) u[c] = x[N[ctrl[2 * c]]] - x[N[ctrl[2 * c + 1]]];
  }

  /** Fill I and G for controls u. `limit` = true during Newton (apply junction limiting to u). */
  protected abstract evaluate(u: Float64Array, I: Float64Array, G: Float64Array, c: LoadCtx | null): void;

  /** Controls used for this iteration (subclasses may swap terminals, e.g. MOSFET reverse mode). */
  protected activeCtrl(): Int32Array {
    return this.ctrl;
  }

  load(c: LoadCtx): void {
    const ctrl = this.activeCtrlFor(c.x);
    this.computeControls(c.x, ctrl, this.u);
    this.evaluate(this.u, this.I, this.G, c);
    const { A, b } = c;
    const { S, N, nt, nc, I, G, u } = this;
    for (let k = 0; k < nt; k++) {
      let rhs = -I[k];
      for (let ci = 0; ci < nc; ci++) {
        const g = G[k * nc + ci];
        if (g === 0) continue;
        const ta = ctrl[2 * ci];
        const tb = ctrl[2 * ci + 1];
        A[S[k * nt + ta]] += g;
        A[S[k * nt + tb]] -= g;
        rhs += g * u[ci];
      }
      b[N[k]] += rhs;
    }
  }

  /** Hook to pick control orientation from the current iterate (default: fixed). */
  protected activeCtrlFor(_x: Float64Array): Int32Array {
    return this.ctrl;
  }

  private readonly uTmp = new Float64Array(8);
  private readonly ITmp = new Float64Array(16);
  private readonly GTmp = new Float64Array(64);

  currents(x: Float64Array, out: Float64Array): void {
    const ctrl = this.activeCtrlFor(x);
    const u = this.nc <= 8 ? this.uTmp : new Float64Array(this.nc);
    const I = this.nt <= 16 ? this.ITmp : new Float64Array(this.nt);
    const G = this.nt * this.nc <= 64 ? this.GTmp : new Float64Array(this.nt * this.nc);
    this.computeControls(x, ctrl, u);
    this.evaluate(u, I, G, null);
    for (let k = 0; k < this.nt; k++) out[k] = I[k];
  }
}

/* ------------------------------------------------------------------------------------------ */
/* BJT — Ebers–Moll transport model                                                            */
/* ------------------------------------------------------------------------------------------ */

export class BjtModel extends MultiTerminalModel {
  readonly pol: number;
  readonly Is: number;
  readonly bf: number;
  readonly br: number;
  readonly vt: number;
  readonly vcrit: number;
  private vbeOld = 0;
  private vbcOld = 0;

  constructor(dev: CircuitDevice, tempC: number) {
    // terminals c=0, b=1, e=2; controls vbe=(b,e), vbc=(b,c)
    super(dev, ['c', 'b', 'e'], [
      [1, 2],
      [1, 0],
    ]);
    this.pol = pnum(dev.params.polarity, 1) < 0 ? -1 : 1;
    this.Is = Math.max(pnum(dev.params.Is, 1e-14), 1e-30);
    this.bf = Math.max(pnum(dev.params.betaF, 100), 1e-3);
    this.br = Math.max(pnum(dev.params.betaR, 1), 1e-3);
    this.vt = thermalVoltage(tempC);
    this.vcrit = this.vt * Math.log(this.vt / (Math.SQRT2 * this.Is));
  }

  override initIter(x: Float64Array): void {
    const N = this.N;
    this.vbeOld = this.pol * (x[N[1]] - x[N[2]]);
    this.vbcOld = this.pol * (x[N[1]] - x[N[0]]);
  }

  private jn(v: number): [number, number] {
    let a = v / this.vt;
    if (a > 80) {
      const e = Math.exp(80);
      return [this.Is * (e * (1 + a - 80) - 1), (this.Is * e) / this.vt];
    }
    if (a < -80) a = -80;
    const e = Math.exp(a);
    return [this.Is * (e - 1), (this.Is * e) / this.vt];
  }

  protected evaluate(u: Float64Array, I: Float64Array, G: Float64Array, c: LoadCtx | null): void {
    const p = this.pol;
    let vbe = p * u[0];
    let vbc = p * u[1];
    if (c) {
      const [v1, l1] = pnjlim(vbe, this.vbeOld, this.vt, this.vcrit);
      const [v2, l2] = pnjlim(vbc, this.vbcOld, this.vt, this.vcrit);
      vbe = v1;
      vbc = v2;
      if (l1 || l2) c.noncon++;
      this.vbeOld = vbe;
      this.vbcOld = vbc;
      u[0] = p * vbe;
      u[1] = p * vbc;
    }
    const gmin = c ? c.gmin : 1e-12;
    let [iF, gF] = this.jn(vbe);
    let [iR, gR] = this.jn(vbc);
    iF += gmin * vbe;
    gF += gmin;
    iR += gmin * vbc;
    gR += gmin;
    const ic = iF - iR * (1 + 1 / this.br);
    const ib = iF / this.bf + iR / this.br;
    const dIc_dvbe = gF;
    const dIc_dvbc = -gR * (1 + 1 / this.br);
    const dIb_dvbe = gF / this.bf;
    const dIb_dvbc = gR / this.br;
    // into-terminal currents (polarity applied); d(p·I)/d(u) with u = p·v → p·p = 1
    I[0] = p * ic;
    I[1] = p * ib;
    I[2] = -p * (ic + ib);
    G[0] = dIc_dvbe;
    G[1] = dIc_dvbc;
    G[2] = dIb_dvbe;
    G[3] = dIb_dvbc;
    G[4] = -(dIc_dvbe + dIb_dvbe);
    G[5] = -(dIc_dvbc + dIb_dvbc);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* MOSFET — level-1 square law with smooth turn-on (body diode is a separate DiodeModel)       */
/* ------------------------------------------------------------------------------------------ */

export class MosfetModel extends MultiTerminalModel {
  readonly pol: number;
  readonly vth: number;
  readonly K: number;
  readonly lambda: number;
  /** Turn-on smoothing (V); also gives a tiny sub-threshold current. */
  private readonly sv = 0.03;
  private readonly ctrlRev: Int32Array;
  private vgsOld = 0;
  private vdsOld = 0;

  constructor(dev: CircuitDevice) {
    // terminals d=0, g=1, s=2; forward controls vgs=(g,s), vds=(d,s); reverse: vgd=(g,d), vsd=(s,d)
    super(dev, ['d', 'g', 's'], [
      [1, 2],
      [0, 2],
    ]);
    this.ctrlRev = Int32Array.from([1, 0, 2, 0]);
    this.pol = pnum(dev.params.polarity, 1) < 0 ? -1 : 1;
    this.vth = Math.abs(pnum(dev.params.Vth, 2));
    this.K = Math.max(pnum(dev.params.K, 1), 1e-9);
    this.lambda = Math.max(pnum(dev.params.lambda, 0.01), 0);
  }

  private reversed = false;

  protected override activeCtrlFor(x: Float64Array): Int32Array {
    const N = this.N;
    const vds = this.pol * (x[N[0]] - x[N[2]]);
    this.reversed = vds < 0;
    return this.reversed ? this.ctrlRev : this.ctrl;
  }

  override initIter(x: Float64Array): void {
    const N = this.N;
    this.vgsOld = this.pol * (x[N[1]] - x[N[2]]);
    this.vdsOld = this.pol * (x[N[0]] - x[N[2]]);
  }

  protected evaluate(u: Float64Array, I: Float64Array, G: Float64Array, c: LoadCtx | null): void {
    const p = this.pol;
    let vgs = p * u[0];
    let vds = p * u[1];
    if (c) {
      const vgsL = fetlim(vgs, this.vgsOld, this.vth);
      const vdsL = limvds(vds, Math.abs(this.vdsOld));
      if (Math.abs(vgsL - vgs) > 1e-12 || Math.abs(vdsL - vds) > 1e-12) c.noncon++;
      vgs = vgsL;
      vds = Math.max(vdsL, 0);
      this.vgsOld = vgs;
      this.vdsOld = vds;
      u[0] = p * vgs;
      u[1] = p * vds;
    }
    if (vds < 0) vds = 0;
    const s = this.sv;
    const z = (vgs - this.vth) / s;
    const vov = s * softplus(z);
    const dvov = sigmoid(z);
    const K = this.K;
    const lam = this.lambda;
    let id: number;
    let gm: number;
    let gds: number;
    if (vds < vov) {
      const base = vov * vds - (vds * vds) / 2;
      id = K * base * (1 + lam * vds);
      gm = K * vds * (1 + lam * vds) * dvov;
      gds = K * ((vov - vds) * (1 + lam * vds) + base * lam);
    } else {
      const base = (vov * vov) / 2;
      id = K * base * (1 + lam * vds);
      gm = K * vov * (1 + lam * vds) * dvov;
      gds = K * base * lam;
    }
    const gmin = c ? c.gmin : 1e-12;
    id += gmin * vds;
    gds += gmin;
    // terminal order d,g,s; with reversal the "drain" role is played by s
    const dIdx = this.reversed ? 2 : 0;
    const sIdx = this.reversed ? 0 : 2;
    I[dIdx] = p * id;
    I[1] = 0;
    I[sIdx] = -p * id;
    G.fill(0);
    G[dIdx * 2 + 0] = gm;
    G[dIdx * 2 + 1] = gds;
    G[sIdx * 2 + 0] = -gm;
    G[sIdx * 2 + 1] = -gds;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Behavioural regulators                                                                      */
/* ------------------------------------------------------------------------------------------ */

const REG_GM = 200; // S, error-amp transconductance (≈0.5 mV / 100 mA load regulation)
const REG_K = 50; // saturation sharpness

/** Linear regulator: pass current IN→OUT regulating OUT to min(Vout, Vin − dropout), Iq IN→GND. */
export class LdoModel extends MultiTerminalModel {
  readonly vreg: number;
  readonly dropout: number;
  readonly iq: number;
  readonly imax: number;
  private readonly t3 = new Float64Array(3);
  private readonly t2 = new Float64Array(2);

  constructor(dev: CircuitDevice) {
    // terminals in=0, out=1, gnd=2; controls u_in=(in,gnd), u_out=(out,gnd)
    super(dev, ['in', 'out', 'gnd'], [
      [0, 2],
      [1, 2],
    ]);
    this.vreg = pnum(dev.params.Vout, 3.3);
    this.dropout = Math.max(pnum(dev.params.dropout, 0.3), 0);
    this.iq = Math.max(pnum(dev.params.Iq, 0), 0);
    this.imax = Math.max(pnum(dev.params.Imax, 1), 1e-6);
  }

  protected evaluate(u: Float64Array, I: Float64Array, G: Float64Array): void {
    const uin = u[0];
    const uout = u[1];
    smin(this.vreg, uin - this.dropout, 0.005, this.t3);
    const vt = this.t3[0];
    const dvt = this.t3[2];
    const z = (REG_GM * (vt - uout)) / this.imax;
    satur(z, REG_K, this.t2);
    const ip = this.imax * this.t2[0];
    const dip_dz = this.imax * this.t2[1];
    const dip_din = (dip_dz * REG_GM * dvt) / this.imax;
    const dip_dout = (-dip_dz * REG_GM) / this.imax;
    const sq = sigmoid((uin - 1) / 0.1);
    const iq = this.iq * sq;
    const diq = (this.iq * sq * (1 - sq)) / 0.1;
    I[0] = ip + iq;
    I[1] = -ip;
    I[2] = -iq;
    G[0] = dip_din + diq;
    G[1] = dip_dout;
    G[2] = -dip_din;
    G[3] = -dip_dout;
    G[4] = -diq;
    G[5] = 0;
  }

  /** Operating state for warnings. */
  state(x: Float64Array): { vin: number; vout: number; iout: number; dropout: boolean; limited: boolean } {
    const N = this.N;
    const vin = x[N[0]] - x[N[2]];
    const vout = x[N[1]] - x[N[2]];
    const out = new Float64Array(3);
    this.currents(x, out);
    const iout = -out[1];
    return { vin, vout, iout, dropout: vin - this.dropout < this.vreg - 0.01, limited: iout > 0.98 * this.imax };
  }
}

/** Averaged switching regulator: P_in = P_out / η (+ Iq). Modes: buck, boost, buck-boost. */
export class BuckModel extends MultiTerminalModel {
  readonly vreg: number;
  readonly eff: number;
  readonly iq: number;
  readonly imax: number;
  readonly mode: string;
  readonly uvlo: number;
  private readonly t3 = new Float64Array(3);
  private readonly t2 = new Float64Array(2);

  constructor(dev: CircuitDevice) {
    super(dev, ['in', 'out', 'gnd'], [
      [0, 2],
      [1, 2],
    ]);
    this.vreg = pnum(dev.params.Vout, 3.3);
    this.eff = Math.min(Math.max(pnum(dev.params.efficiency, 0.9), 0.05), 1);
    this.iq = Math.max(pnum(dev.params.Iq, 0), 0);
    this.imax = Math.max(pnum(dev.params.Imax, 2), 1e-6);
    this.mode = String(dev.params.mode ?? 'buck');
    this.uvlo = pnum(dev.params.uvlo, this.mode === 'buck' ? 0 : 0.7);
  }

  protected evaluate(u: Float64Array, I: Float64Array, G: Float64Array): void {
    const uin = u[0];
    const uout = u[1];
    let vt: number;
    let dvt: number;
    if (this.mode === 'boost') {
      smax(this.vreg, uin - 0.3, 0.005, this.t3);
      vt = this.t3[0];
      dvt = this.t3[2];
    } else if (this.mode === 'buck-boost') {
      vt = this.vreg;
      dvt = 0;
    } else {
      smin(this.vreg, 0.98 * uin, 0.005, this.t3);
      vt = this.t3[0];
      dvt = 0.98 * this.t3[2];
    }
    const en = sigmoid((uin - this.uvlo) / 0.05);
    const den = (en * (1 - en)) / 0.05;
    const z = (REG_GM * (vt - uout)) / this.imax;
    satur(z, REG_K, this.t2);
    const s = this.t2[0];
    const ds = this.t2[1];
    const iout = en * this.imax * s;
    const diout_din = den * this.imax * s + en * ds * REG_GM * dvt;
    const diout_dout = -en * ds * REG_GM;
    smax(uin, 0.2, 0.01, this.t3);
    const vinEff = this.t3[0];
    const dvinEff = this.t3[1];
    const ev = this.eff * vinEff;
    const pout = uout * iout;
    const iin = pout / ev + this.iq * en;
    const diin_din = (uout * diout_din) / ev - (pout / (ev * ev)) * this.eff * dvinEff + this.iq * den;
    const diin_dout = (iout + uout * diout_dout) / ev;
    I[0] = iin;
    I[1] = -iout;
    I[2] = -(iin - iout);
    G[0] = diin_din;
    G[1] = diin_dout;
    G[2] = -diout_din;
    G[3] = -diout_dout;
    G[4] = -(diin_din - diout_din);
    G[5] = -(diin_dout - diout_dout);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Op-amp: VCVS (gain A) clamped to the rails, output resistance, output current from rails    */
/* ------------------------------------------------------------------------------------------ */

export class OpampModel extends MultiTerminalModel {
  readonly gain: number;
  readonly rout: number;
  readonly iq: number;
  private readonly t3 = new Float64Array(3);
  private readonly t3b = new Float64Array(3);

  constructor(dev: CircuitDevice) {
    // terminals inp=0, inn=1, out=2, vp=3, vn=4; controls c1=(inp,inn), c2=(vp,vn), c3=(out,vn)
    super(dev, ['inp', 'inn', 'out', 'vp', 'vn'], [
      [0, 1],
      [3, 4],
      [2, 4],
    ]);
    this.gain = Math.max(pnum(dev.params.gain, 1e5), 1);
    this.rout = Math.max(pnum(dev.params.Rout, 25), 1e-3);
    this.iq = Math.max(pnum(dev.params.Iq, 0), 0);
  }

  protected evaluate(u: Float64Array, I: Float64Array, G: Float64Array): void {
    const [c1, c2, c3] = [u[0], u[1], u[2]];
    const vlin = c2 / 2 + this.gain * c1;
    smax(vlin, 0, 0.001, this.t3);
    const m = this.t3[0];
    const dm = this.t3[1];
    smin(m, c2, 0.001, this.t3b);
    const vint = this.t3b[0];
    const dv_dm = this.t3b[1];
    const dv_dc2direct = this.t3b[2];
    const dv_dc1 = dv_dm * dm * this.gain;
    const dv_dc2 = dv_dm * dm * 0.5 + dv_dc2direct;
    const i = (vint - c3) / this.rout;
    const di = [dv_dc1 / this.rout, dv_dc2 / this.rout, -1 / this.rout];
    smax(i, 0, 1e-6, this.t3);
    const isrc = this.t3[0];
    const disrc = this.t3[1];
    const isnk = isrc - i; // = smax(-i, 0) with the same smoothing
    const disnk = disrc - 1;
    const sq = sigmoid((c2 - 0.5) / 0.05);
    const iq = this.iq * sq;
    const diq = (this.iq * sq * (1 - sq)) / 0.05;
    I[0] = 0;
    I[1] = 0;
    I[2] = -i;
    I[3] = isrc + iq;
    I[4] = -isnk - iq;
    G.fill(0);
    for (let k = 0; k < 3; k++) {
      G[2 * 3 + k] = -di[k];
      G[3 * 3 + k] = disrc * di[k];
      G[4 * 3 + k] = -disnk * di[k];
    }
    G[3 * 3 + 1] += diq;
    G[4 * 3 + 1] -= diq;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* IC / MCU supply current                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** Constant supply current Icc from the supply pins to the ground pins, enabled above `von`. */
export class LoadModel extends MultiTerminalModel {
  readonly icc: number;
  readonly von: number;
  readonly nv: number;
  readonly ng: number;

  constructor(dev: CircuitDevice) {
    const vcc = Object.keys(dev.nodes)
      .filter((k) => k.startsWith('vcc'))
      .sort();
    const gnd = Object.keys(dev.nodes)
      .filter((k) => k.startsWith('gnd'))
      .sort();
    super(dev, [...vcc, ...gnd], [[0, vcc.length]]);
    this.nv = vcc.length;
    this.ng = gnd.length;
    this.icc = Math.max(pnum(dev.params.Icc, 0), 0);
    this.von = pnum(dev.params.von, 1);
  }

  protected evaluate(u: Float64Array, I: Float64Array, G: Float64Array): void {
    const s = sigmoid((u[0] - this.von) / 0.05);
    const it = this.icc * s;
    const dit = (this.icc * s * (1 - s)) / 0.05;
    for (let k = 0; k < this.nv; k++) {
      I[k] = it / this.nv;
      G[k] = dit / this.nv;
    }
    for (let k = 0; k < this.ng; k++) {
      I[this.nv + k] = -it / this.ng;
      G[this.nv + k] = -dit / this.ng;
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Digital pin driver (mixed-signal)                                                           */
/* ------------------------------------------------------------------------------------------ */

/** Pin output state for {@link DriverModel}. */
export type DriveMode = 'z' | 'low' | 'high' | 'pullup' | 'pulldown' | 'analog';

const G_Z = 1e-9; // high-Z: 1 GΩ to the device ground

/**
 * Push-pull output stage of a digital pin: 'high' connects the pin to the device supply through
 * `rout`, 'low' to the device ground; 'z' leaves 1 GΩ to ground; 'pullup'/'pulldown' use `rpull`;
 * 'analog' is a Thevenin source of `volts` (relative to the device ground) through `rout`.
 * When `sup` is unconnected the supply is the fixed voltage `vfix`.
 */
export class DriverModel extends Model {
  mode: DriveMode = 'z';
  volts = 0;
  readonly gout: number;
  readonly gpull: number;
  readonly vfix: number;
  readonly hasSup: boolean;

  constructor(dev: CircuitDevice) {
    super(dev, ['pin', 'sup', 'gnd']);
    this.gout = 1 / Math.max(pnum(dev.params.rout, 25), 1e-3);
    this.gpull = 1 / Math.max(pnum(dev.params.rpull, 35e3), 1);
    this.vfix = pnum(dev.params.vfix, 3.3);
    this.hasSup = dev.nodes.sup !== undefined && dev.nodes.sup !== '';
    const m = String(dev.params.mode ?? 'z') as DriveMode;
    this.mode = m;
    this.volts = pnum(dev.params.volts, 0);
  }

  override allocate(a: AllocCtx): void {
    this.idx.push(a.node(this.dev.nodes.pin ?? '0'));
    this.idx.push(this.hasSup ? a.node(this.dev.nodes.sup) : -1);
    this.idx.push(a.node(this.dev.nodes.gnd ?? '0'));
  }

  pattern(pb: PatternBuilder): void {
    this.regG(pb, 0, 1); // pin-sup 0..3
    this.regG(pb, 0, 2); // pin-gnd 4..7
  }

  /** Returns [g to sup, g to gnd, source volts (Norton to gnd, relative to gnd), source g]. */
  private conf(): [number, number, number, number] {
    switch (this.mode) {
      case 'high':
        return this.hasSup ? [this.gout, G_Z * 1e-3, 0, 0] : [0, 0, this.vfix, this.gout];
      case 'low':
        return [0, this.gout, 0, 0];
      case 'pullup':
        return this.hasSup ? [this.gpull, G_Z, 0, 0] : [0, G_Z, this.vfix, this.gpull];
      case 'pulldown':
        return [0, this.gpull, 0, 0];
      case 'analog':
        return [0, 0, this.volts, this.gout];
      default:
        return [0, G_Z, 0, 0];
    }
  }

  load(c: LoadCtx): void {
    const [gs, gg, v, gv] = this.conf();
    if (gs) stampG(c.A, this.S, 0, gs);
    if (gg + gv) stampG(c.A, this.S, 4, gg + gv);
    if (gv) {
      c.b[this.N[0]] += v * gv;
      c.b[this.N[2]] -= v * gv;
    }
  }

  currents(x: Float64Array, out: Float64Array): void {
    const [gs, gg, v, gv] = this.conf();
    const vp = x[this.N[0]];
    const ivs = gs * (vp - x[this.N[1]]);
    const ivg = (gg + gv) * (vp - x[this.N[2]]) - v * gv;
    out[0] = ivs + ivg;
    out[1] = -ivs;
    out[2] = -ivg;
  }
}

/* ------------------------------------------------------------------------------------------ */

/** Instantiate the model for a device. */
export function createModel(dev: CircuitDevice, tempC: number): Model {
  switch (dev.kind) {
    case 'resistor':
      return new ResistorModel(dev);
    case 'capacitor':
      return new CapacitorModel(dev);
    case 'inductor':
      return new InductorModel(dev);
    case 'vsource':
      return new VSourceModel(dev);
    case 'isource':
      return new ISourceModel(dev);
    case 'diode':
      return new DiodeModel(dev, tempC);
    case 'bjt':
      return new BjtModel(dev, tempC);
    case 'mosfet':
      return new MosfetModel(dev);
    case 'ldo':
      return new LdoModel(dev);
    case 'buck':
      return new BuckModel(dev);
    case 'opamp':
      return new OpampModel(dev);
    case 'load':
      return new LoadModel(dev);
    case 'driver':
      return new DriverModel(dev);
    default:
      throw new Error(`Unknown device kind '${(dev as CircuitDevice).kind}'`);
  }
}
