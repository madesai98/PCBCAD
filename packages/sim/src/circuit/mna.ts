/**
 * Compiled Modified-Nodal-Analysis system for a {@link Circuit}: unknown allocation, fixed sparse
 * pattern, damped Newton–Raphson with junction limiting, gmin stepping and source stepping, plus
 * the transient step primitive (trapezoidal / backward Euler companion models).
 */
import { PatternBuilder, SparseLU } from './linalg';
import { createModel, type DriverModel, type LoadCtx, type Model } from './devices';
import type { Circuit, CircuitDevice } from './types';

export interface NewtonResult {
  converged: boolean;
  iterations: number;
  singular?: boolean;
}

export interface DcResult extends NewtonResult {
  /** 'newton' | 'gmin-stepping' | 'source-stepping' | 'failed' */
  method: string;
}

/** Minimum conductance from every voltage node to ground (S). */
const GMIN_FLOOR = 1e-12;

export class MnaSystem {
  readonly circuit: Circuit;
  readonly models: Model[];
  /** Node key -> unknown index (ground '0' is absent). */
  readonly nodeIndex = new Map<string, number>();
  /** Number of voltage unknowns among the first entries (nodes + internal nodes are mixed with branches; see isBranch). */
  readonly size: number;
  readonly ground: number;
  /** 1 for branch-current unknowns. */
  readonly isBranch: Uint8Array;
  readonly unknownNames: string[] = [];
  readonly x: Float64Array;
  private readonly xNew: Float64Array;
  private readonly A: Float64Array;
  private readonly b: Float64Array;
  private readonly lu: SparseLU;
  private readonly diagPos: Int32Array;
  readonly ctx: LoadCtx;
  readonly hasNonlinear: boolean;
  readonly hasTimeVarying: boolean;
  /** Total Newton iterations performed (diagnostics). */
  totalIterations = 0;

  constructor(circuit: Circuit, extraDevices: CircuitDevice[] = []) {
    this.circuit = circuit;
    const devices = extraDevices.length ? [...circuit.devices, ...extraDevices] : circuit.devices;
    this.models = devices.map((d) => createModel(d, circuit.temperatureC));
    const branchFlags: number[] = [];
    const names = this.unknownNames;
    const addUnknown = (name: string, branch: boolean): number => {
      names.push(name);
      branchFlags.push(branch ? 1 : 0);
      return names.length - 1;
    };
    for (const key of circuit.nodes) {
      if (key === '0' || this.nodeIndex.has(key)) continue;
      this.nodeIndex.set(key, addUnknown(key, false));
    }
    const alloc = {
      node: (key: string): number => {
        if (key === '0' || key === '' || key == null) return -1;
        let i = this.nodeIndex.get(key);
        if (i === undefined) {
          i = addUnknown(key, false);
          this.nodeIndex.set(key, i);
        }
        return i;
      },
      internal: (name: string): number => addUnknown(name, false),
      branch: (name: string): number => addUnknown(`I(${name})`, true),
    };
    for (const m of this.models) m.allocate(alloc);
    const n = names.length;
    this.size = n;
    this.ground = n;
    this.isBranch = Uint8Array.from(branchFlags);
    const pb = new PatternBuilder(Math.max(n, 1));
    const diagHandles: number[] = [];
    for (let i = 0; i < n; i++) diagHandles.push(this.isBranch[i] ? -1 : pb.slot(i, i));
    for (const m of this.models) m.pattern(pb);
    // make sure every branch row/col has at least a diagonal entry for structural sanity
    if (n === 0) pb.slot(0, 0);
    const pattern = pb.compile();
    const pos = (h: number) => pb.position(h);
    for (const m of this.models) m.finalize(n, pos);
    this.diagPos = Int32Array.from(diagHandles.map((h) => (h < 0 ? -1 : pb.position(h))));
    this.A = new Float64Array(pb.nnz + 1);
    this.b = new Float64Array(n + 1);
    this.x = new Float64Array(n + 1);
    this.xNew = new Float64Array(n + 1);
    this.lu = new SparseLU(pattern);
    this.ctx = { x: this.x, A: this.A, b: this.b, dc: true, t: 0, h: 1e-6, trap: false, srcScale: 1, gmin: GMIN_FLOOR, noncon: 0 };
    this.hasNonlinear = this.models.some((m) => m.nonlinear);
    this.hasTimeVarying = this.models.some((m) => m.timeVarying);
  }

  /** Voltage of a node key (0 for ground / unknown keys). */
  voltage(key: string): number {
    const i = this.nodeIndex.get(key);
    return i === undefined ? 0 : this.x[i];
  }

  /** Find the driver model for a device id (mixed-signal). */
  driver(deviceId: string): DriverModel | undefined {
    return this.models.find((m) => m.dev.id === deviceId && m.dev.kind === 'driver') as DriverModel | undefined;
  }

  initIter(): void {
    for (const m of this.models) m.initIter(this.x);
  }

  /**
   * Newton–Raphson from the current x. `gminDiag` adds conductance from every node to ground
   * (gmin stepping); `srcScale` scales independent sources (source stepping).
   */
  newton(opts: { maxIter: number; reltol: number; vntol: number; abstol: number; gminDiag?: number; srcScale?: number }): NewtonResult {
    const { A, b, x, xNew, ctx, diagPos, isBranch } = this;
    const n = this.size;
    if (n === 0) return { converged: true, iterations: 0 };
    const gd = (opts.gminDiag ?? 0) + GMIN_FLOOR;
    ctx.srcScale = opts.srcScale ?? 1;
    ctx.gmin = GMIN_FLOOR + (opts.gminDiag ?? 0);
    let lastMaxDelta = Infinity;
    for (let iter = 1; iter <= opts.maxIter; iter++) {
      this.totalIterations++;
      A.fill(0);
      b.fill(0);
      ctx.noncon = 0;
      ctx.x = x;
      for (let k = 0; k < this.models.length; k++) this.models[k].load(ctx);
      for (let i = 0; i < n; i++) if (diagPos[i] >= 0) A[diagPos[i]] += gd;
      if (!this.lu.factor(A)) {
        this.lu.resetPivots();
        if (!this.lu.factor(A)) return { converged: false, iterations: iter, singular: true };
      }
      this.lu.solve(b, xNew);
      let finite = true;
      let conv = ctx.noncon === 0;
      let maxDelta = 0;
      for (let i = 0; i < n; i++) {
        const xn = xNew[i];
        if (!Number.isFinite(xn)) {
          finite = false;
          break;
        }
        const d = Math.abs(xn - x[i]);
        if (!isBranch[i] && d > maxDelta) maxDelta = d;
        if (conv) {
          const tol = opts.reltol * Math.max(Math.abs(xn), Math.abs(x[i])) + (isBranch[i] ? opts.abstol : opts.vntol);
          if (d > tol) conv = false;
        }
      }
      if (!finite) return { converged: false, iterations: iter };
      // Damping: when the update keeps growing on a nonlinear circuit, take a partial step.
      let alpha = 1;
      if (this.hasNonlinear && iter > 8 && maxDelta > 1 && maxDelta >= lastMaxDelta * 0.9) alpha = 0.5;
      if (this.hasNonlinear && maxDelta > 25) alpha = Math.min(alpha, 25 / maxDelta);
      lastMaxDelta = maxDelta;
      if (alpha === 1) {
        for (let i = 0; i < n; i++) x[i] = xNew[i];
      } else {
        conv = false;
        for (let i = 0; i < n; i++) x[i] += alpha * (xNew[i] - x[i]);
      }
      x[n] = 0;
      if (conv) return { converged: true, iterations: iter };
    }
    return { converged: false, iterations: opts.maxIter };
  }

  /**
   * DC operating point with gmin-stepping and source-stepping fallbacks. Starts from the current
   * x (warm start); call `x.fill(0)` first for a cold start.
   */
  solveDc(opts: { maxIter?: number; reltol?: number; vntol?: number; abstol?: number; time?: number } = {}): DcResult {
    const base = {
      maxIter: opts.maxIter ?? 150,
      reltol: opts.reltol ?? 1e-6,
      vntol: opts.vntol ?? 1e-6,
      abstol: opts.abstol ?? 1e-12,
    };
    const ctx = this.ctx;
    ctx.dc = true;
    ctx.t = opts.time ?? 0;
    this.initIter();
    const start = Float64Array.from(this.x);
    let total = 0;
    let r = this.newton(base);
    total += r.iterations;
    if (r.converged) return { ...r, iterations: total, method: 'newton' };
    if (!this.hasNonlinear && r.singular) return { ...r, iterations: total, method: 'failed' };

    // gmin stepping
    this.x.set(start);
    this.initIter();
    let ok = true;
    for (let g = 1e-2; g >= 1e-11; g /= 10) {
      r = this.newton({ ...base, gminDiag: g });
      total += r.iterations;
      if (!r.converged) {
        ok = false;
        break;
      }
    }
    if (ok) {
      r = this.newton(base);
      total += r.iterations;
      if (r.converged) return { ...r, iterations: total, method: 'gmin-stepping' };
    }

    // source stepping
    this.x.fill(0);
    this.initIter();
    let s = 0;
    let ds = 0.05;
    let saved = Float64Array.from(this.x);
    let guard = 0;
    while (s < 1 && guard++ < 400) {
      const sn = Math.min(1, s + ds);
      r = this.newton({ ...base, srcScale: sn });
      total += r.iterations;
      if (r.converged) {
        s = sn;
        saved = Float64Array.from(this.x);
        ds = Math.min(ds * 2, 0.25);
      } else {
        this.x.set(saved);
        this.initIter();
        ds /= 4;
        if (ds < 1e-5) break;
      }
    }
    if (s >= 1) {
      r = this.newton(base);
      total += r.iterations;
      if (r.converged) return { ...r, iterations: total, method: 'source-stepping' };
    }
    return { converged: false, iterations: total, method: 'failed' };
  }

  /** Initialise transient state of dynamic devices from the current (DC) solution. */
  initTran(): void {
    for (const m of this.models) m.initTran(this.x);
  }

  /**
   * Solve one transient time point at time t with step h. On failure x is restored to the
   * previous accepted point. Call {@link acceptTran} after success.
   */
  stepTran(t: number, h: number, trap: boolean, opts: { maxIter?: number; reltol?: number } = {}): NewtonResult {
    const ctx = this.ctx;
    ctx.dc = false;
    ctx.t = t;
    ctx.h = h;
    ctx.trap = trap;
    const prev = this.prevX ?? (this.prevX = new Float64Array(this.x.length));
    prev.set(this.x);
    this.initIter();
    const r = this.newton({ maxIter: opts.maxIter ?? 50, reltol: opts.reltol ?? 1e-6, vntol: 1e-6, abstol: 1e-12 });
    if (!r.converged) this.x.set(prev);
    return r;
  }
  private prevX: Float64Array | null = null;

  acceptTran(): void {
    for (const m of this.models) m.accept(this.x, this.ctx);
  }

  /** Union of source breakpoints in [t0, t1]. */
  breakpoints(t0: number, t1: number): number[] {
    const all: number[] = [];
    for (const m of this.models) if (m.timeVarying) for (const t of m.breakpoints(t0, t1)) all.push(t);
    all.sort((a, b) => a - b);
    const out: number[] = [];
    for (const t of all) if (!out.length || t - out[out.length - 1] > 1e-15) out.push(t);
    return out;
  }

  /** LU statistics (diagnostics). */
  get luStats(): { n: number; lnz: number; unz: number; full: number; refactor: number } {
    return { ...this.lu.stats, full: this.lu.fullFactorizations, refactor: this.lu.refactorizations };
  }
}
