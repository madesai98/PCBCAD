import { describe, expect, it } from 'vitest';
import { autoRoute } from './route';
import { connectivity } from './connectivity';
import { runDrc } from './drc';
import { fillZones } from './zones';
import { comp, emptyBoard, routingTestBoard, stdParts, wire } from './test-fixtures';

const copperErrors = (issues: ReturnType<typeof runDrc>) =>
  issues.filter((i) => ['clearance', 'short', 'edge-clearance', 'outside-board', 'hole-to-hole', 'trace-width'].includes(i.code));

describe('autoRoute', () => {
  it('routes a 50×40 mm 2-layer board (25 parts, 30 nets) fully, DRC-clean and fast', () => {
    const { board, parts } = routingTestBoard();
    expect(board.components).toHaveLength(25);
    expect(board.nets).toHaveLength(30);
    const before = structuredClone(board);
    const t0 = performance.now();
    const r = autoRoute(board, parts);
    const ms = performance.now() - t0;
    expect(board).toEqual(before); // input untouched
    expect(ms).toBeLessThan(5000);
    expect(r.failed).toEqual([]);
    expect(r.routed).toHaveLength(30);
    expect(r.stats.segments).toBeGreaterThan(30);
    expect(r.stats.lengthMm).toBeGreaterThan(100);
    expect(r.board.vias).toHaveLength(r.stats.vias);
    for (const islands of connectivity(r.board, parts).values()) expect(islands).toHaveLength(1);
    const drc = runDrc(r.board, parts);
    expect(copperErrors(drc)).toEqual([]);
    expect(drc.filter((i) => i.code === 'unrouted')).toEqual([]);
    // traces only at 0°/45°/90°
    for (const t of r.board.traces) {
      for (let i = 1; i < t.points.length; i++) {
        const dx = Math.abs(t.points[i][0] - t.points[i - 1][0]);
        const dy = Math.abs(t.points[i][1] - t.points[i - 1][1]);
        const ok = dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6 || i === 1 || i === t.points.length - 1;
        expect(ok).toBe(true);
      }
    }
    // power nets use the power width where it fits
    const vcc = r.board.traces.filter((t) => t.netId === 'net_VCC');
    expect(vcc.some((t) => t.width === board.rules.powerTraceWidth)).toBe(true);
  });

  it('skips nets, limits to nets and to layers', () => {
    const { board, parts } = routingTestBoard();
    const r = autoRoute(board, parts, { skipNets: ['GND'], nets: ['VCC', 'GND', 'SL1', 'net_SR2'] });
    expect(r.routed.sort()).toEqual(['net_SL1', 'net_SR2', 'net_VCC']);
    expect(r.board.traces.every((t) => t.netId !== 'net_GND')).toBe(true);
    const single = autoRoute(board, parts, { nets: ['SL1', 'SL2', 'SR1'], layers: ['top'] });
    expect(single.failed).toEqual([]);
    expect(single.board.traces.every((t) => t.layer === 'top')).toBe(true);
    expect(single.board.vias).toHaveLength(0);
  });

  it('reuses existing traces, skips connected nets and reports unreachable pads', () => {
    const parts = stdParts();
    const b = emptyBoard(30, 20);
    b.components.push(comp('r1', 'R1', 'res', 5, 10), comp('r2', 'R2', 'res', 15, 10), comp('r3', 'R3', 'res', 25, 10));
    const n = wire(b, 'N', ['R1.2', 'R2.1', 'R3.1']);
    b.traces.push({ id: 'pre', netId: n, layer: 'top', width: 0.25, points: [[5.95, 10], [14.05, 10]] });
    const r = autoRoute(b, parts);
    expect(r.routed).toEqual([n]);
    expect(r.board.traces.find((t) => t.id === 'pre')).toBeTruthy();
    expect(r.stats.lengthMm).toBeLessThan(12);
    // second run: nothing to do
    const again = autoRoute(r.board, parts);
    expect(again.routed).toEqual([]);
    expect(again.stats.segments).toBe(0);
    // a pad on a layer that is not routed
    const c = structuredClone(b);
    c.traces = [];
    c.components[2].side = 'bottom';
    const top = autoRoute(c, parts, { layers: ['top'] });
    expect(top.failed).toHaveLength(1);
    expect(top.failed[0].reason).toMatch(/not on a routing layer/);
  });

  it('keeps zones consistent: refills poured zones after routing', () => {
    const { board, parts } = routingTestBoard();
    board.zones.push({ id: 'z', netId: 'net_GND', layer: 'bottom', clearance: 0.3, thermalRelief: true });
    const poured = fillZones(board, parts);
    const r = autoRoute(poured, parts, { skipNets: ['GND'] });
    expect(r.failed).toEqual([]);
    expect(copperErrors(runDrc(r.board, parts))).toEqual([]);
  });

  it('routes fine-pitch pads by necking down', () => {
    const parts = stdParts();
    const b = emptyBoard(30, 30);
    b.rules.clearance = 0.25; // a 0.5 mm power trace cannot enter a 0.4 mm pad at 0.65 mm pitch
    b.components.push(comp('u1', 'U1', 'mcu', 15, 15), comp('j1', 'J1', 'hdr6', 3, 15));
    // shift the IC off-grid so its 0.65 mm pitch pads do not line up with the 0.25 mm grid
    b.components[0].y = 15.13;
    for (let k = 0; k < 4; k++) wire(b, `S${k}`, [`U1.${k + 3}`, `J1.${k + 3}`]);
    wire(b, 'VCC', ['U1.8', 'J1.1'], 'power'); // a mid-row pin: neighbours on both sides
    const r = autoRoute(b, parts);
    expect(r.failed).toEqual([]);
    expect(copperErrors(runDrc(r.board, parts))).toEqual([]);
    // a 0.4 mm wide mid-row pad cannot take a 0.5 mm power trace: it was necked down
    const vcc = r.board.traces.filter((t) => t.netId === 'net_VCC');
    expect(vcc.length).toBeGreaterThan(0);
    expect(vcc.every((t) => t.width < b.rules.powerTraceWidth)).toBe(true);
  });
});
