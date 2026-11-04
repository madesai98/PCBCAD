/**
 * Independent-source waveforms (SPICE semantics) and their breakpoints.
 *
 *  - dc:    V
 *  - pulse: v1, v2, td, tr, tf, pw, per   (PULSE(v1 v2 td tr tf pw per))
 *  - sin:   vo, va, freq, td, theta, phase(deg)  (SIN(vo va freq td theta phase))
 *  - pwl:   points 't1,v1;t2,v2;...' (linear interpolation, held constant outside)
 */
import { parseValue } from '@pcbcad/core';
import type { DeviceParam } from './types';

export interface Waveform {
  /** Value at time t (s). */
  value(t: number): number;
  /** Discontinuity times (derivative jumps) within [t0, t1]. */
  breakpoints(t0: number, t1: number): number[];
  /** True when the value never changes. */
  readonly constant: boolean;
}

function num(v: DeviceParam | undefined, dflt: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const p = parseValue(v);
    if (p !== undefined) return p;
  }
  return dflt;
}

/** Parse 't1,v1;t2,v2' (also accepts whitespace separated pairs). Times must be non-decreasing. */
export function parsePwl(points: string): [number, number][] {
  const out: [number, number][] = [];
  const pairs = String(points)
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of pairs) {
    const [a, b] = p.split(/[,\s]+/);
    const t = parseValue(a);
    const v = parseValue(b);
    if (t === undefined || v === undefined) throw new Error(`Bad PWL point '${p}' (expected 't,v')`);
    if (out.length && t < out[out.length - 1][0]) throw new Error(`PWL times must be non-decreasing ('${points}')`);
    out.push([t, v]);
  }
  if (!out.length) throw new Error('PWL waveform needs at least one point');
  return out;
}

/** Create a waveform from device params; `dcValue` is used for 'dc' (and as fallback). */
export function makeWaveform(params: Record<string, DeviceParam>, dcValue: number): Waveform {
  const kind = String(params.waveform ?? 'dc').toLowerCase();
  if (kind === 'pulse') {
    const v1 = num(params.v1, 0);
    const v2 = num(params.v2, dcValue);
    const td = Math.max(0, num(params.td, 0));
    const tr = Math.max(1e-12, num(params.tr, 1e-9));
    const tf = Math.max(1e-12, num(params.tf, 1e-9));
    const pw = Math.max(0, num(params.pw, 1e-3));
    let per = num(params.per, 0);
    if (!(per > 0)) per = Infinity;
    if (per < tr + pw + tf) per = tr + pw + tf;
    const value = (t: number): number => {
      if (t < td) return v1;
      let tt = t - td;
      if (Number.isFinite(per)) tt = tt % per;
      if (tt < tr) return v1 + ((v2 - v1) * tt) / tr;
      if (tt < tr + pw) return v2;
      if (tt < tr + pw + tf) return v2 + ((v1 - v2) * (tt - tr - pw)) / tf;
      return v1;
    };
    const breakpoints = (t0: number, t1: number): number[] => {
      const out: number[] = [];
      const offs = [0, tr, tr + pw, tr + pw + tf];
      if (!Number.isFinite(per)) {
        for (const o of offs) if (td + o >= t0 && td + o <= t1) out.push(td + o);
        return out;
      }
      const kStart = Math.max(0, Math.floor((t0 - td) / per) - 1);
      for (let k = kStart; ; k++) {
        const base = td + k * per;
        if (base > t1) break;
        for (const o of offs) {
          const t = base + o;
          if (t >= t0 && t <= t1) out.push(t);
        }
        if (out.length > 1e6) break;
      }
      return out;
    };
    return { value, breakpoints, constant: false };
  }
  if (kind === 'sin' || kind === 'sine') {
    const vo = num(params.vo, 0);
    const va = num(params.va, dcValue);
    const freq = num(params.freq, 1e3);
    const td = num(params.td, 0);
    const theta = num(params.theta, 0);
    const phase = (num(params.phase, 0) * Math.PI) / 180;
    const value = (t: number): number => {
      if (t < td) return vo + va * Math.sin(phase);
      const tt = t - td;
      return vo + va * Math.exp(-tt * theta) * Math.sin(2 * Math.PI * freq * tt + phase);
    };
    return { value, breakpoints: (t0, t1) => (td > t0 && td <= t1 ? [td] : []), constant: false };
  }
  if (kind === 'pwl') {
    const pts = parsePwl(String(params.points ?? ''));
    const value = (t: number): number => {
      if (t <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) {
        if (t <= pts[i][0]) {
          const [ta, va] = pts[i - 1];
          const [tb, vb] = pts[i];
          return tb === ta ? vb : va + ((vb - va) * (t - ta)) / (tb - ta);
        }
      }
      return pts[pts.length - 1][1];
    };
    return {
      value,
      breakpoints: (t0, t1) => pts.map((p) => p[0]).filter((t) => t >= t0 && t <= t1),
      constant: pts.every((p) => p[1] === pts[0][1]),
    };
  }
  return { value: () => dcValue, breakpoints: () => [], constant: true };
}
