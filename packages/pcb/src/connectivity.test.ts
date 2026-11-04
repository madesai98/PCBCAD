import { describe, expect, it } from 'vitest';
import { connectivity, ratsnest } from './connectivity';
import { comp, emptyBoard, stdParts, wire } from './test-fixtures';

function threeResistors() {
  const parts = stdParts();
  const b = emptyBoard(30, 20);
  b.components.push(comp('r1', 'R1', 'res', 5, 10), comp('r2', 'R2', 'res', 15, 10), comp('r3', 'R3', 'res', 25, 10));
  const net = wire(b, 'SIG', ['R1.2', 'R2.1', 'R3.1']);
  return { b, parts, net };
}

describe('connectivity', () => {
  it('reports one island per pad when nothing is routed', () => {
    const { b, parts, net } = threeResistors();
    const islands = connectivity(b, parts).get(net)!;
    expect(islands).toHaveLength(3);
    expect(ratsnest(b, parts).filter((r) => r.netId === net)).toHaveLength(2);
  });

  it('joins pads through traces whose ends lie in pad copper and through touching traces', () => {
    const { b, parts, net } = threeResistors();
    b.traces.push({ id: 't1', netId: net, layer: 'top', width: 0.25, points: [[5.95, 10], [10, 10]] });
    b.traces.push({ id: 't2', netId: net, layer: 'top', width: 0.25, points: [[10, 10], [14.05, 10]] });
    const islands = connectivity(b, parts).get(net)!;
    expect(islands).toHaveLength(2);
    expect(islands[0]).toEqual(['r1:2', 'r2:1']);
    const rats = ratsnest(b, parts).filter((r) => r.netId === net);
    expect(rats).toHaveLength(1);
    // closest anchors: R2.1 (14.05) or trace end to R3.1 (24.05)
    expect(rats[0].to[0]).toBeCloseTo(24.05, 6);
  });

  it('does not connect copper of other nets or other layers, but vias bridge layers', () => {
    const { b, parts, net } = threeResistors();
    const other = wire(b, 'OTHER', ['R3.2']);
    b.traces.push({ id: 't1', netId: other, layer: 'top', width: 0.25, points: [[5.95, 10], [14.05, 10]] });
    expect(connectivity(b, parts).get(net)!).toHaveLength(3);
    b.traces = [
      { id: 't2', netId: net, layer: 'top', width: 0.25, points: [[5.95, 10], [8, 12]] },
      { id: 't3', netId: net, layer: 'bottom', width: 0.25, points: [[8, 12], [12, 12]] },
      { id: 't4', netId: net, layer: 'top', width: 0.25, points: [[12, 12], [14.05, 10]] },
    ];
    expect(connectivity(b, parts).get(net)!).toHaveLength(3);
    b.vias.push({ id: 'v1', netId: net, x: 8, y: 12, drill: 0.3, diameter: 0.6 }, { id: 'v2', netId: net, x: 12, y: 12, drill: 0.3, diameter: 0.6 });
    expect(connectivity(b, parts).get(net)!).toHaveLength(2);
  });

  it('counts zone fills as copper', () => {
    const { b, parts, net } = threeResistors();
    b.zones.push({
      id: 'z',
      netId: net,
      layer: 'top',
      clearance: 0.3,
      fill: [
        [
          [5.5, 9],
          [25.5, 9],
          [25.5, 11],
          [5.5, 11],
        ],
      ],
    });
    expect(connectivity(b, parts).get(net)!).toHaveLength(1);
    expect(ratsnest(b, parts)).toHaveLength(0);
  });

  it('keeps pads of unplaced components separate even when they overlap', () => {
    const { b, parts, net } = threeResistors();
    for (const c of b.components) {
      c.placed = false;
      c.x = 0;
      c.y = 0;
    }
    expect(connectivity(b, parts).get(net)!).toHaveLength(3);
  });
});
