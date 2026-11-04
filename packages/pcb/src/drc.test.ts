import { describe, expect, it } from 'vitest';
import type { Board } from '@pcbcad/core';
import { runDrc } from './drc';
import { comp, emptyBoard, stdParts, thtPad, footprint, makePart, wire } from './test-fixtures';

const codes = (b: Board, parts = stdParts()) => runDrc(b, parts).map((i) => i.code);

function base() {
  const parts = stdParts();
  const b = emptyBoard(40, 30);
  b.components.push(comp('r1', 'R1', 'res', 10, 15), comp('r2', 'R2', 'res', 20, 15));
  const a = wire(b, 'A', ['R1.2', 'R2.1']);
  const n = wire(b, 'B', ['R1.1']);
  return { b, parts, a, n };
}

describe('runDrc', () => {
  it('passes a clean routed board', () => {
    const { b, parts, a } = base();
    b.traces.push({ id: 't', netId: a, layer: 'top', width: 0.25, points: [[10.95, 15], [19.05, 15]] });
    const issues = runDrc(b, parts).filter((i) => i.code !== 'single-pin-net');
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('detects unrouted nets with a location', () => {
    const { b, parts, a } = base();
    const un = runDrc(b, parts).filter((i) => i.code === 'unrouted');
    expect(un).toHaveLength(1);
    expect(un[0].target?.netIds).toEqual([a]);
    expect(un[0].at?.[0]).toBeCloseTo(15, 6);
    expect(un[0].category).toBe('drc');
  });

  it('detects clearance violations and shorts between different nets', () => {
    const { b, parts, a, n } = base();
    b.traces.push({ id: 't', netId: a, layer: 'top', width: 0.25, points: [[10.95, 15], [19.05, 15]] });
    // trace of net B passing 0.1 mm from the A trace
    b.traces.push({ id: 'tb', netId: n, layer: 'top', width: 0.25, points: [[12, 15.35], [18, 15.35]] });
    let issues = runDrc(b, parts);
    const clr = issues.filter((i) => i.code === 'clearance');
    expect(clr).toHaveLength(1);
    expect(clr[0].message).toMatch(/0\.1 mm/);
    expect(clr[0].target?.traceIds?.sort()).toEqual(['t', 'tb']);
    expect(clr[0].at?.[1]).toBeCloseTo(15.175, 3);
    // overlap -> short
    b.traces[1].points = [
      [12, 15.1],
      [18, 15.1],
    ];
    issues = runDrc(b, parts);
    expect(issues.filter((i) => i.code === 'short')).toHaveLength(1);
    expect(issues.filter((i) => i.code === 'clearance')).toHaveLength(0);
    // on another layer: fine
    b.traces[1].layer = 'bottom';
    expect(runDrc(b, parts).filter((i) => i.code === 'short' || i.code === 'clearance')).toHaveLength(0);
  });

  it('detects edge clearance and copper outside the board', () => {
    const { b, parts, a } = base();
    b.traces.push({ id: 't', netId: a, layer: 'top', width: 0.25, points: [[10.95, 15], [10.95, 30.5]] });
    expect(codes(b, parts)).toContain('outside-board'); // crosses the edge
    b.traces[0].points = [
      [10.95, 15],
      [10.95, 29.5],
    ];
    const issues = runDrc(b, parts).filter((i) => i.code === 'edge-clearance');
    expect(issues).toHaveLength(1);
    expect(issues[0].at?.[1]).toBeGreaterThan(29);
    b.vias.push({ id: 'v', netId: a, x: 50, y: 50, drill: 0.3, diameter: 0.6 });
    expect(runDrc(b, parts).some((i) => i.code === 'outside-board' && /via/i.test(i.message))).toBe(true);
  });

  it('detects courtyard overlaps only on the same side', () => {
    const { b, parts } = base();
    b.components[1].x = 12;
    expect(codes(b, parts)).toContain('courtyard-overlap');
    b.components[1].side = 'bottom';
    expect(codes(b, parts)).not.toContain('courtyard-overlap');
  });

  it('flags unplaced parts, thin traces, small drills, annular rings and hole-to-hole', () => {
    const parts = stdParts();
    parts.tht = makePart('tht', 'connector', footprint('THT', [thtPad('1', 0, 0, 1.0, 0.9), thtPad('2', 1.0, 0, 1.7, 0.2)]));
    const b = emptyBoard(40, 30);
    b.components.push(comp('j', 'J1', 'tht', 10, 10), { ...comp('u', 'R9', 'res', 0, 0), placed: false });
    const n = wire(b, 'N', ['J1.1']);
    b.traces.push({ id: 't', netId: n, layer: 'top', width: 0.1, points: [[10, 10], [10, 14]] });
    b.vias.push({ id: 'v1', netId: n, x: 20, y: 20, drill: 0.2, diameter: 0.3 }, { id: 'v2', netId: n, x: 20.4, y: 20, drill: 0.3, diameter: 0.6 });
    const c = codes(b, parts);
    for (const code of ['unplaced', 'trace-width', 'drill', 'annular-ring', 'hole-to-hole']) expect(c).toContain(code);
  });

  it('flags silkscreen over pads', () => {
    const { b, parts } = base();
    parts.res.footprint!.graphics.push({ kind: 'line', layer: 'silk', a: [-1.5, 0], b: [1.5, 0], width: 0.15 });
    expect(codes(b, parts)).toContain('silk-over-pad');
  });

  it('checks zone fills against other copper', () => {
    const { b, parts, n } = base();
    b.zones.push({ id: 'z', netId: n, layer: 'top', clearance: 0.3, fill: [[[18.5, 14], [22, 14], [22, 16], [18.5, 16]]] });
    const issues = runDrc(b, parts);
    expect(issues.some((i) => i.code === 'short' && /zone/.test(i.message))).toBe(true);
  });

  it('runs 2000+ objects in well under a second', () => {
    const parts = stdParts();
    const b = emptyBoard(120, 100);
    let k = 0;
    for (let i = 0; i < 25; i++) {
      for (let j = 0; j < 30; j++) {
        b.components.push(comp(`r${k}`, `R${k}`, 'res', 5 + i * 4.5, 4 + j * 3.1));
        wire(b, `N${k}`, [`R${k}.1`]);
        k++;
      }
    }
    for (let t = 0; t < 600; t++) {
      const y = 5.6 + (t % 30) * 3.1;
      const x = 3 + Math.floor(t / 30) * 5;
      b.traces.push({ id: `t${t}`, netId: `net_N${t}`, layer: t % 2 ? 'top' : 'bottom', width: 0.2, points: [[x, y], [x + 4, y], [x + 4.5, y + 0.4]] });
    }
    for (let v = 0; v < 200; v++) b.vias.push({ id: `v${v}`, netId: `net_N${v}`, x: 4 + (v % 25) * 4.5, y: 5.5 + Math.floor(v / 25) * 11, drill: 0.3, diameter: 0.6 });
    const objects = b.components.length * 2 + 600 * 2 + 200;
    expect(objects).toBeGreaterThanOrEqual(2000);
    runDrc(b, parts); // warm-up (JIT)
    const t0 = performance.now();
    const issues = runDrc(b, parts);
    const ms = performance.now() - t0;
    expect(issues.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1000);
  });
});
