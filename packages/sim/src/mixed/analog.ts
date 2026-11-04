/**
 * Analog side of the co-simulation: an MnaSystem with digital pin drivers, re-solved on demand.
 *
 *  - quasi-static: DC operating point re-solved lazily when a driver changed (event-driven) or at
 *    sample points when waveform sources exist. Solutions are cached by driver state (exact
 *    repeats such as PWM or blinking cost a hash lookup).
 *  - transient: the transient solver is stepped between events (driver changes are breakpoints,
 *    followed by a backward-Euler step), so RC filters, supply ramps etc. evolve in time.
 *
 * Per-component energy and LED on-time/charge are integrated piecewise between solutions.
 */
import { CircuitProbe } from '../circuit/analysis';
import type { DriveMode, DriverModel } from '../circuit/devices';
import type { MnaSystem } from '../circuit/mna';

interface CacheEntry {
  x: Float64Array;
  power: Float64Array;
  led: Float64Array;
}

export interface AnalogOptions {
  mode: 'quasi-static' | 'transient';
  /** Max transient step (s). */
  maxStep: number;
  /** Indices (into sys.models) of LED diode models. */
  ledModels: number[];
  /** LED "on" current thresholds (A), parallel to ledModels. */
  ledThreshold: number[];
}

export class AnalogBridge {
  readonly sys: MnaSystem;
  readonly probe: CircuitProbe;
  readonly mode: 'quasi-static' | 'transient';
  /** Time of the current analog state (s). */
  t = 0;
  /** Number of DC solves / transient steps performed. */
  solves = 0;
  cacheHits = 0;
  failures = 0;
  readonly energy: Float64Array;
  readonly ledOn: Float64Array;
  readonly ledCharge: Float64Array;
  private readonly ledModels: number[];
  private readonly ledThreshold: number[];
  private readonly drivers: DriverModel[];
  private dirty = true;
  private dirtySince = 0;
  private segStart = 0;
  private curPower: Float64Array;
  private curLed: Float64Array;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheable: boolean;
  private pending: { t: number; d: DriverModel; mode: DriveMode; volts: number }[] = [];
  private readonly maxStep: number;
  private trapOk = false;
  /** Listener invoked after every new solution (input propagation). */
  onSolved: (() => void) | null = null;
  private inSolve = false;

  constructor(sys: MnaSystem, opts: AnalogOptions) {
    this.sys = sys;
    this.probe = new CircuitProbe(sys);
    this.mode = opts.mode;
    this.maxStep = opts.maxStep;
    this.ledModels = opts.ledModels;
    this.ledThreshold = opts.ledThreshold;
    this.drivers = sys.models.filter((m) => m.dev.kind === 'driver') as DriverModel[];
    const nc = this.probe.compIds.length;
    this.energy = new Float64Array(nc);
    this.curPower = new Float64Array(nc);
    this.ledOn = new Float64Array(this.ledModels.length);
    this.ledCharge = new Float64Array(this.ledModels.length);
    this.curLed = new Float64Array(this.ledModels.length);
    this.cacheable = !sys.hasTimeVarying;
  }

  /** Initial DC solution at t = 0 (all drivers in their initial state). */
  init(): { converged: boolean; iterations: number } {
    this.sys.x.fill(0);
    const r = this.sys.solveDc({ time: 0 });
    if (!r.converged) this.failures++;
    this.solves++;
    this.capture();
    if (this.mode === 'transient') {
      this.sys.initTran();
      this.trapOk = false;
    }
    this.dirty = false;
    this.segStart = 0;
    return r;
  }

  private capture(): void {
    this.probe.evaluate();
    this.curPower.set(this.probe.power);
    for (let i = 0; i < this.ledModels.length; i++) this.curLed[i] = this.probe.current(this.ledModels[i], 0);
  }

  /** Change a driver at time t (s). */
  setDriver(d: DriverModel, mode: DriveMode, volts: number, t: number): void {
    if (this.mode === 'transient') {
      const last = this.pendingState(d);
      if (last.mode === mode && (mode !== 'analog' || last.volts === volts)) return;
      this.pending.push({ t: Math.max(t, this.t), d, mode, volts });
      if (!this.dirty) {
        this.dirty = true;
        this.dirtySince = t;
      }
      return;
    }
    if (d.mode === mode && (mode !== 'analog' || d.volts === volts)) return;
    d.mode = mode;
    d.volts = volts;
    if (!this.dirty) {
      this.dirty = true;
      this.dirtySince = Math.max(t, this.segStart);
    }
  }

  private pendingState(d: DriverModel): { mode: DriveMode; volts: number } {
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i].d === d) return this.pending[i];
    return { mode: d.mode, volts: d.volts };
  }

  /** True if a driver change is waiting to be solved. */
  get isDirty(): boolean {
    return this.dirty;
  }

  private integrate(until: number): void {
    const dt = until - this.segStart;
    if (dt > 0) {
      const e = this.energy;
      const p = this.curPower;
      for (let i = 0; i < e.length; i++) e[i] += p[i] * dt;
      for (let i = 0; i < this.curLed.length; i++) {
        const c = this.curLed[i];
        this.ledCharge[i] += c * dt;
        if (c >= this.ledThreshold[i]) this.ledOn[i] += dt;
      }
      this.segStart = until;
    }
  }

  private key(): string {
    let k = '';
    for (const d of this.drivers) {
      k += d.mode[0] + (d.mode === 'pulldown' ? 'd' : '');
      if (d.mode === 'analog') k += d.volts.toFixed(4);
    }
    return k;
  }

  /**
   * Bring the analog state up to time t. In quasi-static mode this solves only if something
   * changed (or `force` with time-varying sources). Returns true if a new solution was produced.
   */
  ensure(t: number, force = false): boolean {
    if (this.inSolve) return false;
    if (this.mode === 'transient') return this.advance(t);
    if (!this.dirty && !(force && this.sys.hasTimeVarying)) return false;
    this.inSolve = true;
    try {
      const tChange = this.dirty ? Math.min(this.dirtySince, t) : t;
      this.integrate(tChange);
      let entry: CacheEntry | undefined;
      let k = '';
      if (this.cacheable) {
        k = this.key();
        entry = this.cache.get(k);
      }
      if (entry) {
        this.cacheHits++;
        this.sys.x.set(entry.x);
        this.curPower.set(entry.power);
        this.curLed.set(entry.led);
        // refresh LRU order
        this.cache.delete(k);
        this.cache.set(k, entry);
      } else {
        const r = this.sys.solveDc({ time: t, maxIter: 100 });
        this.solves++;
        if (!r.converged) this.failures++;
        this.capture();
        if (this.cacheable && r.converged) {
          if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value as string);
          this.cache.set(k, { x: Float64Array.from(this.sys.x), power: Float64Array.from(this.curPower), led: Float64Array.from(this.curLed) });
        }
      }
      this.t = Math.max(this.t, t);
      this.dirty = false;
    } finally {
      this.inSolve = false;
    }
    this.onSolved?.();
    return true;
  }

  /** Transient mode: step from this.t to t, applying pending driver changes at their times. */
  private advance(t: number): boolean {
    if (t <= this.t + 1e-15 && !this.pending.length) return false;
    this.inSolve = true;
    try {
      this.pending.sort((a, b) => a.t - b.t);
      const pend = this.pending;
      this.pending = [];
      for (const p of pend) {
        this.stepTo(Math.min(p.t, t));
        if (p.d.mode !== p.mode || p.d.volts !== p.volts) {
          p.d.mode = p.mode;
          p.d.volts = p.volts;
          this.trapOk = false; // discontinuity → backward Euler next step
        }
      }
      this.stepTo(t);
      this.dirty = false;
    } finally {
      this.inSolve = false;
    }
    this.onSolved?.();
    return true;
  }

  private stepTo(t: number): void {
    const sys = this.sys;
    let guard = 0;
    while (this.t < t - 1e-15 && guard++ < 1_000_000) {
      let h = Math.min(this.maxStep, t - this.t);
      let ok = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const r = sys.stepTran(this.t + h, h, this.trapOk);
        if (r.converged) {
          ok = true;
          break;
        }
        h /= 4;
        this.trapOk = false;
      }
      if (!ok) {
        // give up on this step: fall back to a DC solve at the target time
        this.failures++;
        sys.solveDc({ time: this.t + h });
        sys.initTran();
      } else {
        sys.acceptTran();
      }
      this.solves++;
      const prevPower = Float64Array.from(this.curPower);
      const prevLed = Float64Array.from(this.curLed);
      this.capture();
      // trapezoidal integration of power/LED current over the step
      for (let i = 0; i < this.energy.length; i++) this.energy[i] += 0.5 * (prevPower[i] + this.curPower[i]) * h;
      for (let i = 0; i < this.curLed.length; i++) {
        const avg = 0.5 * (prevLed[i] + this.curLed[i]);
        this.ledCharge[i] += avg * h;
        if (avg >= this.ledThreshold[i]) this.ledOn[i] += h;
      }
      this.t += h;
      this.segStart = this.t;
      this.trapOk = true;
    }
  }

  /** Close the accounting at the end of the run. */
  finish(tEnd: number): void {
    if (this.mode === 'transient') this.advance(tEnd);
    else {
      this.ensure(tEnd);
      this.integrate(tEnd);
    }
  }

  /** Node voltage (V) for a node key. */
  voltage(node: string | null | undefined): number {
    if (!node || node === '0') return 0;
    return this.sys.voltage(node);
  }
}
