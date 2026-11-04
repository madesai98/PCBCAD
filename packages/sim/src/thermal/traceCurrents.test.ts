import { describe, expect, it } from 'vitest';
import { COPPER_RESISTIVITY, COPPER_TEMPCO, copperOzToMm } from '@pcbcad/core';
import type { Board, PartDef } from '@pcbcad/core';
import { computeTraceCurrents } from './traceCurrents';
import { ipc2221Capacity } from './ipc';
import { makeBoard, makePart, pad, place, trace } from './testFixtures';

const T = 25;
const rho = COPPER_RESISTIVITY * (1 + COPPER_TEMPCO * (T - 20));
const t1oz = copperOzToMm(1);
/** Analytic resistance (Ω) of a trace of length L, width w (mm), 1 oz copper. */
const Rtrace = (L: number, w: number, tMm = t1oz) => (rho * L * 1e-3) / (w * 1e-3 * tMm * 1e-3);

const tp = makePart('tp', [pad('1', 0, 0, 1.5, 1.5)]);
const parts: Record<string, PartDef> = { tp };

/** Board with a source test point J1 at (5,15) and load test points on net 'vcc'. */
function setup(loads: [string, number, number][] = [['r1', 45, 15]]): Board {
  const b = makeBoard(50, 30);
  place(b, { id: 'j1', partId: 'tp', x: 5, y: 15, pinNets: { '1': 'vcc' } });
  for (const [id, x, y] of loads) place(b, { id, partId: 'tp', x, y, pinNets: { '1': 'vcc' } });
  return b;
}

describe('computeTraceCurrents', () => {
  it('single trace: every segment carries the injected current, drop = I·R', () => {
    const b = setup();
    const pts: [number, number][] = [
      [5, 15],
      [15, 15],
      [25, 22],
      [45, 15],
    ];
    b.traces.push(trace('t1', 'vcc', pts, 0.5));
    const I = 1.25;
    const res = computeTraceCurrents(b, parts, { j1: { '1': -I }, r1: { '1': I } }, { temperature: T });
    expect(res.traces).toHaveLength(3);
    let total = 0;
    res.traces.forEach((s, k) => {
      const L = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
      expect(s.current).toBeCloseTo(I, 9);
      expect(s.direction).toBe(1);
      expect(Math.abs(s.voltageDrop / (I * Rtrace(L, 0.5)) - 1)).toBeLessThan(0.005);
      expect(s.currentDensity).toBeCloseTo(I / (0.5 * t1oz), 6);
      expect(s.ipcCapacity).toBeCloseTo(ipc2221Capacity(0.5, 1, 10, true), 9);
      total += s.voltageDrop;
    });
    expect(res.netDrops).toHaveLength(1);
    expect(res.netDrops[0].current).toBeCloseTo(I, 12);
    expect(res.netDrops[0].maxDrop).toBeCloseTo(total, 12);
    const P = res.segmentPower.reduce((a, s) => a + s.power, 0);
    expect(P).toBeCloseTo(I * total, 12);
    expect(res.warnings).toEqual([]);
  });

  it('reversing the current flips the direction, not the magnitude', () => {
    const b = setup();
    b.traces.push(trace('t1', 'vcc', [[5, 15], [45, 15]], 0.3));
    const res = computeTraceCurrents(b, parts, { j1: { '1': 0.5 }, r1: { '1': -0.5 } });
    expect(res.traces[0].current).toBeCloseTo(0.5, 12);
    expect(res.traces[0].direction).toBe(-1);
  });

  it('two parallel traces split the current in proportion to their conductance', () => {
    const b = setup();
    // equal length (60 mm) paths, widths 0.5 and 1.0 mm
    b.traces.push(trace('narrow', 'vcc', [[5, 15], [5, 25], [45, 25], [45, 15]], 0.5));
    b.traces.push(trace('wide', 'vcc', [[5, 15], [5, 5], [45, 5], [45, 15]], 1.0));
    const res = computeTraceCurrents(b, parts, { j1: { '1': -1 }, r1: { '1': 1 } }, { temperature: T });
    const narrow = res.traces.filter((s) => s.traceId === 'narrow');
    const wide = res.traces.filter((s) => s.traceId === 'wide');
    for (const s of narrow) expect(s.current).toBeCloseTo(1 / 3, 9);
    for (const s of wide) expect(s.current).toBeCloseTo(2 / 3, 9);
    expect(Math.abs(res.netDrops[0].maxDrop / ((1 / 3) * Rtrace(60, 0.5)) - 1)).toBeLessThan(0.005);
  });

  it('includes via barrel resistance between layers', () => {
    const b = setup();
    b.traces.push(trace('a', 'vcc', [[5, 15], [20, 15]], 0.5, 'top'));
    b.traces.push(trace('b', 'vcc', [[20, 15], [30, 15]], 0.5, 'bottom'));
    b.traces.push(trace('c', 'vcc', [[30, 15], [45, 15]], 0.5, 'top'));
    b.vias.push({ id: 'v1', netId: 'vcc', x: 20, y: 15, drill: 0.3, diameter: 0.6 });
    b.vias.push({ id: 'v2', netId: 'vcc', x: 30, y: 15, drill: 0.3, diameter: 0.6 });
    const I = 2;
    const res = computeTraceCurrents(b, parts, { j1: { '1': -I }, r1: { '1': I } }, { temperature: T });
    for (const s of res.traces) expect(s.current).toBeCloseTo(I, 9);
    const Rvia = (rho * 1.6e-3) / (Math.PI * 25e-6 * (0.3e-3 + 25e-6));
    const expected = I * (Rtrace(40, 0.5) + 2 * Rvia);
    expect(Math.abs(res.netDrops[0].maxDrop / expected - 1)).toBeLessThan(0.005);
  });

  it('T-junction mid-segment: branch and trunk currents obey KCL', () => {
    const b = setup([
      ['r1', 45, 15],
      ['r2', 25, 5],
    ]);
    b.traces.push(trace('trunk', 'vcc', [[5, 15], [45, 15]], 0.5));
    b.traces.push(trace('branch', 'vcc', [[25, 5], [25, 15]], 0.5));
    const res = computeTraceCurrents(b, parts, { j1: { '1': -1.5 }, r1: { '1': 1 }, r2: { '1': 0.5 } }, { temperature: T });
    const trunk = res.traces.find((s) => s.traceId === 'trunk')!;
    const branch = res.traces.find((s) => s.traceId === 'branch')!;
    expect(trunk.current).toBeCloseTo(1.5, 9); // worst sub-segment
    expect(branch.current).toBeCloseTo(0.5, 9);
    expect(Math.abs(trunk.voltageDrop / (1.5 * Rtrace(20, 0.5) + 1.0 * Rtrace(20, 0.5)) - 1)).toBeLessThan(1e-6);
    expect(trunk.power).toBeCloseTo(1.5 ** 2 * Rtrace(20, 0.5) + 1 ** 2 * Rtrace(20, 0.5), 9);
  });

  it('zone fill acts as a low-impedance hub with spreading resistance', () => {
    const b = setup();
    b.zones.push({ id: 'z', netId: 'vcc', layer: 'top', clearance: 0.3 });
    const I = 3;
    const res = computeTraceCurrents(b, parts, { j1: { '1': -I }, r1: { '1': I } }, { temperature: T });
    const Rs = rho / (t1oz * 1e-3);
    const Lc = Math.sqrt(1500 / Math.PI);
    const a = Math.sqrt(2.25 / Math.PI);
    const Rspread = (Rs / (2 * Math.PI)) * Math.log(Lc / a);
    expect(Math.abs(res.netDrops[0].maxDrop / (I * 2 * Rspread) - 1)).toBeLessThan(1e-6);
    expect(res.traces).toEqual([]);
  });

  it('trace inside a zone of its own net: trace ∥ plane, each copper blob attached once', () => {
    const b = setup();
    b.zones.push({ id: 'z', netId: 'vcc', layer: 'top', clearance: 0.3 });
    b.traces.push(trace('t', 'vcc', [[5, 15], [45, 15]], 0.5));
    const I = 2;
    const res = computeTraceCurrents(b, parts, { j1: { '1': -I }, r1: { '1': I } }, { temperature: T });
    const Rs = rho / (t1oz * 1e-3);
    const Rspread = (Rs / (2 * Math.PI)) * Math.log(Math.sqrt(1500 / Math.PI) / Math.sqrt(2.25 / Math.PI));
    const Rt = Rtrace(40, 0.5);
    const Req = 1 / (1 / Rt + 1 / (2 * Rspread));
    expect(Math.abs(res.netDrops[0].maxDrop / (I * Req) - 1)).toBeLessThan(1e-6);
    expect(res.traces[0].current).toBeCloseTo((I * Req) / Rt, 9);
  });

  it('via-in-pad connects a bottom-layer trace to top-side pads', () => {
    const b = setup();
    b.vias.push({ id: 'v1', netId: 'vcc', x: 5, y: 15, drill: 0.3, diameter: 0.6 });
    b.vias.push({ id: 'v2', netId: 'vcc', x: 45, y: 15, drill: 0.3, diameter: 0.6 });
    b.traces.push(trace('t', 'vcc', [[5, 15], [45, 15]], 0.5, 'bottom'));
    const res = computeTraceCurrents(b, parts, { j1: { '1': -1 }, r1: { '1': 1 } }, { temperature: T });
    const Rvia = (rho * 1.6e-3) / (Math.PI * 25e-6 * (0.3e-3 + 25e-6));
    expect(res.traces[0].current).toBeCloseTo(1, 9);
    expect(Math.abs(res.netDrops[0].maxDrop / (Rtrace(40, 0.5) + 2 * Rvia) - 1)).toBeLessThan(1e-6);
  });

  it('partially routed net: only routed loads are analysed, with a warning', () => {
    const b = setup([
      ['r1', 45, 15],
      ['r2', 25, 5],
    ]);
    b.traces.push(trace('t', 'vcc', [[5, 15], [45, 15]], 0.5));
    const res = computeTraceCurrents(b, parts, { j1: { '1': -1 }, r1: { '1': 0.6 }, r2: { '1': 0.4 } });
    expect(res.traces[0].current).toBeCloseTo(0.6, 9);
    expect(res.netDrops[0].current).toBeCloseTo(1, 12);
    expect(res.warnings.some((w) => /0\.40 A of pin current .*incomplete routing/.test(w))).toBe(true);
  });

  it('unrouted net: no segments, the missing current is counted once', () => {
    const b = setup();
    const res = computeTraceCurrents(b, parts, { j1: { '1': -1 }, R1: { '1': 1 } }); // second key by ref
    expect(res.traces).toEqual([]);
    expect(res.netDrops).toEqual([{ netId: 'vcc', name: 'VCC', maxDrop: 0, current: 1 }]);
    expect(res.warnings).toEqual(['Net VCC: 1.00 A of pin current has no complete copper path (incomplete routing?); only the routed part was analysed']);
  });

  it('flags overloaded traces against IPC-2221', () => {
    const b = setup();
    b.traces.push(trace('t', 'vcc', [[5, 15], [45, 15]], 0.25));
    const cap10 = ipc2221Capacity(0.25, 1, 10, true);
    const cap20 = ipc2221Capacity(0.25, 1, 20, true);
    const at = (I: number) => computeTraceCurrents(b, parts, { j1: { '1': -I }, r1: { '1': I } }).traces[0];
    expect(at(0.9 * cap10).status).toBe('ok');
    expect(at(0.5 * (cap10 + cap20)).status).toBe('warn');
    const f = at(1.2 * cap20);
    expect(f.status).toBe('fail');
    expect(f.tempRise).toBeGreaterThan(20);
  });

  it('resistance follows the copper temperature coefficient', () => {
    const b = setup();
    b.traces.push(trace('t', 'vcc', [[5, 15], [45, 15]], 0.5));
    const pc = { j1: { '1': -1 }, r1: { '1': 1 } };
    const d20 = computeTraceCurrents(b, parts, pc, { temperature: 20 }).traces[0].voltageDrop;
    const d70 = computeTraceCurrents(b, parts, pc, { temperature: 70 }).traces[0].voltageDrop;
    expect(d70 / d20).toBeCloseTo(1 + COPPER_TEMPCO * 50, 9);
  });

  it('pads with several pins and multi-pad pins: currents enter at the right pads', () => {
    // A 2-pin part bridging two nets: current flows J1 → trace → U1.1, U1.2 → trace → J2
    const b = makeBoard(40, 20);
    const two = makePart('two', [pad('1', -2, 0, 1, 1), pad('2', 2, 0, 1, 1), pad('2', 2, 2, 1, 1)]);
    const p = { tp, two };
    place(b, { id: 'j1', partId: 'tp', x: 5, y: 10, pinNets: { '1': 'a' } });
    place(b, { id: 'u1', partId: 'two', x: 20, y: 10, pinNets: { '1': 'a', '2': 'b' } });
    place(b, { id: 'j2', partId: 'tp', x: 35, y: 12, pinNets: { '1': 'b' } });
    b.traces.push(trace('ta', 'a', [[5, 10], [18, 10]], 0.4));
    b.traces.push(trace('tb', 'b', [[22, 12], [35, 12]], 0.4)); // lands on the second pad "2"
    const res = computeTraceCurrents(b, p, { j1: { '1': -0.7 }, u1: { '1': 0.7, '2': -0.7 }, j2: { '1': 0.7 } });
    expect(res.traces.find((s) => s.traceId === 'ta')!.current).toBeCloseTo(0.7, 9);
    expect(res.traces.find((s) => s.traceId === 'tb')!.current).toBeCloseTo(0.7, 9);
    expect(res.netDrops.map((d) => d.netId).sort()).toEqual(['a', 'b']);
  });
});
