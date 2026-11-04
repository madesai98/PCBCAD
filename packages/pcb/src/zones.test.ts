import { describe, expect, it } from 'vitest';
import { connectivity } from './connectivity';
import { areaOf, ccw, difference, intersection, primPaths, toIPath, union } from './clip';
import { runDrc } from './drc';
import { makePrim, ringArea } from './geom';
import { boardCopperArea, fillZones } from './zones';
import { comp, emptyBoard, header, makePart, stdParts, wire } from './test-fixtures';
import type { Vec2 } from '@pcbcad/core';

const fillArea = (rings: Vec2[][] | undefined) => (rings ?? []).reduce((s, r) => s + ringArea(r), 0);

describe('fillZones', () => {
  it('fills the board minus inflated other-net copper; area matches the analytic estimate', () => {
    const parts = stdParts();
    const b = emptyBoard(40, 30);
    b.components.push(comp('r1', 'R1', 'res', 10, 15), comp('r2', 'R2', 'res', 30, 15));
    const sig = wire(b, 'SIG', ['R1.2', 'R2.1']);
    const gnd = wire(b, 'GND', ['R1.1', 'R2.2']);
    b.traces.push({ id: 't', netId: sig, layer: 'top', width: 0.25, points: [[10.95, 15], [29.05, 15]] });
    b.zones.push({ id: 'z', netId: gnd, layer: 'top', clearance: 0.3, minWidth: 0.2 });
    const before = structuredClone(b);
    const out = fillZones(b, parts);
    expect(b).toEqual(before); // input untouched
    const z = out.zones[0];
    expect(z.fill!.length).toBeGreaterThan(0);
    // outer rings CCW (positive area), holes CW
    expect(z.fill!.some((r) => ringArea(r) > 0)).toBe(true);
    expect(z.fill!.some((r) => ringArea(r) < 0)).toBe(true);
    const area = fillArea(z.fill);
    // expected: board inset − (signal copper inflated by 0.3); GND pads are solid-connected (no relief)
    const board = areaOf(boardCopperArea(b));
    const obstacles = union([
      ...primPaths(makePrim([[10.95, 15], [29.05, 15]], 0.125), 0.3),
      ...primPaths(makePrim([[10.45, 14.35], [11.45, 14.35], [11.45, 15.65], [10.45, 15.65]], 0), 0.3),
      ...primPaths(makePrim([[28.55, 14.35], [29.55, 14.35], [29.55, 15.65], [28.55, 15.65]], 0), 0.3),
    ]);
    const expected = areaOf(difference(boardCopperArea(b), obstacles));
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.01);
    expect(area).toBeLessThan(board);
    // the fill keeps clearance: DRC finds no copper violations
    const drc = runDrc(out, parts).filter((i) => i.code === 'clearance' || i.code === 'short' || i.code === 'edge-clearance');
    expect(drc).toEqual([]);
    // GND pads are connected through the pour
    expect(connectivity(out, parts).get(gnd)).toHaveLength(1);
  });

  it('connects THT pads through thermal reliefs and removes unconnected islands', () => {
    const parts = stdParts();
    parts.hdr2 = makePart('hdr2', 'connector', header(2));
    const b = emptyBoard(30, 20);
    b.components.push(comp('j1', 'J1', 'hdr2', 5, 10), comp('j2', 'J2', 'hdr2', 25, 10));
    const gnd = wire(b, 'GND', ['J1.1', 'J2.1']);
    const sig = wire(b, 'SIG', ['J1.2', 'J2.2']);
    // a signal wall splitting the board into two halves on the bottom layer
    b.traces.push({ id: 'wall', netId: sig, layer: 'bottom', width: 0.5, points: [[15, -1], [15, 21]] });
    b.zones.push({ id: 'z', netId: gnd, layer: 'bottom', clearance: 0.3, thermalRelief: true });
    const out = fillZones(b, parts);
    const fill = out.zones[0].fill!;
    expect(fill.length).toBeGreaterThan(0);
    // two islands (one per header) — each touching a GND pad
    expect(fill.filter((r) => ringArea(r) > 0)).toHaveLength(2);
    const isl = connectivity(out, parts).get(gnd)!;
    expect(isl).toHaveLength(2);
    // thermal relief: the GND pad is surrounded by a gap but connected (pad is in its own island)
    expect(isl.every((i) => i.length === 1)).toBe(true);
    // remove J2's GND connection: its half becomes an orphan island and is dropped
    delete out.components[1].pinNets['1'];
    const out2 = fillZones(out, parts);
    expect(out2.zones[0].fill!.filter((r) => ringArea(r) > 0)).toHaveLength(1);
  });

  it('honours priority and outlines; zones on missing layers are emptied', () => {
    const parts = stdParts();
    const b = emptyBoard(30, 20);
    b.components.push(comp('r1', 'R1', 'res', 5, 10));
    const a = wire(b, 'A', ['R1.1']);
    const c = wire(b, 'C', ['R1.2']);
    b.zones.push({ id: 'low', netId: a, layer: 'top', clearance: 0.3, priority: 0 });
    b.zones.push({
      id: 'high',
      netId: c,
      layer: 'top',
      clearance: 0.3,
      priority: 5,
      outline: [
        [2, 2],
        [15, 2],
        [15, 18],
        [2, 18],
      ],
    });
    b.zones.push({ id: 'inner', netId: a, layer: 'in1', clearance: 0.3 });
    const out = fillZones(b, parts);
    const hi = fillArea(out.zones[1].fill);
    const lo = fillArea(out.zones[0].fill);
    expect(hi).toBeGreaterThan(150);
    expect(hi).toBeLessThan(13 * 16 + 1e-6);
    expect(lo).toBeLessThan(28.2 * 18.2 - hi);
    expect(out.zones[2].fill).toEqual([]);
    expect(runDrc(out, parts).filter((i) => i.code === 'short' || i.code === 'clearance')).toEqual([]);
  });

  it('enforces minimum width by opening', () => {
    const parts = stdParts();
    const b = emptyBoard(30, 20);
    const g = 'net_GND';
    b.nets.push({ id: g, name: 'GND', class: 'ground' }, { id: 'net_S', name: 'S', class: 'signal' });
    // two signal traces 0.7 mm apart: after 0.3 mm clearance on each side a 0.1 mm sliver remains
    b.traces.push({ id: 'a', netId: 'net_S', layer: 'top', width: 0.2, points: [[5, 2], [5, 18]] });
    b.traces.push({ id: 'b', netId: 'net_S', layer: 'top', width: 0.2, points: [[5.9, 2], [5.9, 18]] });
    b.vias.push({ id: 'v', netId: g, x: 20, y: 10, drill: 0.3, diameter: 0.6 });
    const sliver = [ccw(toIPath([[5.15, 3], [5.75, 3], [5.75, 17], [5.15, 17]]))];
    const copperIn = (minWidth: number) => {
      const z = { id: 'z', netId: g, layer: 'top' as const, clearance: 0.3, minWidth };
      const out = fillZones({ ...b, zones: [z] }, parts);
      return areaOf(intersection(union(out.zones[0].fill!.map((r) => toIPath(r))), sliver));
    };
    expect(copperIn(0.05)).toBeGreaterThan(0.5); // thin sliver kept with a tiny min width
    expect(copperIn(0.5)).toBeLessThan(1e-3); // removed by the opening
  });
});
