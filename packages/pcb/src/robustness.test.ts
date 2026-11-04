import { describe, expect, it } from 'vitest';
import { createProject, type Board, type PartDef } from '@pcbcad/core';
import * as pcb from './index';
import { comp, emptyBoard, footprint, makePart, smdPad, stdParts, wire } from './test-fixtures';

function runAll(b: Board, parts: Record<string, PartDef>) {
  const project = createProject('X');
  project.parts = parts;
  project.boards = [b];
  return {
    place: pcb.autoPlace(b, parts),
    route: pcb.autoRoute(b, parts, { maxTimeMs: 5000 }),
    fill: pcb.fillZones(b, parts),
    conn: pcb.connectivity(b, parts),
    rats: pcb.ratsnest(b, parts),
    drc: pcb.runDrc(b, parts),
    erc: pcb.runErc(b, parts),
    gerbers: pcb.exportGerbers(b, parts),
    bom: pcb.exportBom(project),
    cpl: pcb.exportCpl(b, parts),
    stats: pcb.boardStats(b, parts),
  };
}

describe('robustness', () => {
  it('handles an empty board', () => {
    const b = emptyBoard(10, 10);
    const r = runAll(b, {});
    expect(r.route.failed).toEqual([]);
    expect(r.stats.routedPct).toBe(100);
    expect(r.drc).toEqual([]);
  });

  it('handles a board without an outline', () => {
    const parts = stdParts();
    const b = emptyBoard(10, 10);
    b.outline = [];
    b.components.push(comp('r1', 'R1', 'res', 5, 5), comp('r2', 'R2', 'res', 8, 5));
    wire(b, 'N', ['R1.1', 'R2.1']);
    b.zones.push({ id: 'z', netId: 'net_N', layer: 'top', clearance: 0.3 });
    const r = runAll(b, parts);
    expect(r.place.report[0]).toMatch(/no outline/);
    expect(r.route.failed[0].reason).toMatch(/outline/);
    expect(r.fill.zones[0].fill ?? []).toEqual([]);
    expect(r.stats.areaMm2).toBe(0);
  });

  it('tolerates unknown parts, missing footprints, degenerate geometry and dangling net ids', () => {
    const parts: Record<string, PartDef> = {
      ...stdParts(),
      nofp: makePart('nofp', 'ic', undefined, [{ number: '1', name: 'VDD', type: 'power_in' }]),
      empty: makePart('empty', 'other', footprint('E', [], { minX: 0, minY: 0, maxX: 0, maxY: 0 })),
      zero: makePart('zero', 'resistor', footprint('Z', [smdPad('1', 0, 0, 0, 0), smdPad('2', 1, 0, 0.5, 0.5, 'polygon')])),
    };
    const b = emptyBoard(30, 20);
    b.components.push(
      comp('a', 'U1', 'nofp', 5, 5),
      comp('b', 'U2', 'missing-part', 10, 5),
      comp('c', 'X1', 'empty', 15, 5),
      comp('d', 'R1', 'zero', 20, 5),
      comp('e', 'R2', 'res', 25, 10),
    );
    b.components[0].pinNets['1'] = 'net_GHOST';
    b.components[3].pinNets['2'] = 'net_GHOST';
    b.components[4].pinNets['1'] = 'net_GHOST';
    b.traces.push(
      { id: 't0', netId: 'net_GHOST', layer: 'top', width: 0.2, points: [] },
      { id: 't1', netId: 'net_GHOST', layer: 'top', width: 0.2, points: [[3, 3]] },
      { id: 't2', netId: 'net_GHOST', layer: 'in1', width: 0.2, points: [[3, 3], [4, 4]] },
      { id: 't3', netId: '', layer: 'bottom', width: 0, points: [[3, 3], [3, 3], [6, 3]] },
    );
    b.vias.push({ id: 'v', netId: 'net_GHOST', x: 12, y: 12, drill: 0.3, diameter: 0.6, from: 'top', to: 'in2' });
    b.zones.push(
      { id: 'z1', netId: 'net_GHOST', layer: 'top', clearance: 0.3, outline: [[0, 0], [1, 1]] },
      { id: 'z2', netId: '', layer: 'bottom', clearance: 0.3 },
    );
    b.holes.push({ id: 'h', x: 2, y: 18, drill: 3, plated: true });
    const r = runAll(b, parts);
    expect(Array.isArray(r.drc)).toBe(true);
    expect(r.gerbers.files.length).toBeGreaterThan(8);
    expect(r.drc.some((i) => i.code === 'annular-ring')).toBe(true); // plated hole without pad
    expect(r.drc.some((i) => i.code === 'trace-width')).toBe(true);
    expect(r.erc.some((i) => i.code === 'missing-decoupling')).toBe(true);
    expect(r.cpl.split('\n')[0]).toBe('Designator,Mid X,Mid Y,Layer,Rotation');
  });

  it('works on 4-layer boards with inner-layer zones, bottom-side parts and rotations', () => {
    const parts = stdParts();
    const b = emptyBoard(40, 30, 4);
    b.components.push(comp('r1', 'R1', 'res', 8, 8, 45), { ...comp('r2', 'R2', 'res', 30, 20, 90), side: 'bottom' }, comp('j1', 'J1', 'hdr4', 20, 15));
    wire(b, 'A', ['R1.1', 'R2.1', 'J1.1']);
    wire(b, 'GND', ['R1.2', 'R2.2', 'J1.2']);
    b.zones.push({ id: 'g', netId: 'net_GND', layer: 'in1', clearance: 0.3, thermalRelief: true });
    const routed = pcb.autoRoute(b, parts, { skipNets: ['GND'] });
    expect(routed.failed).toEqual([]);
    const filled = pcb.fillZones(routed.board, parts);
    const drc = pcb.runDrc(filled, parts).filter((i) => ['clearance', 'short', 'hole-to-hole', 'edge-clearance'].includes(i.code));
    expect(drc).toEqual([]);
    const files = pcb.exportGerbers(filled, parts).files.map((f) => f.name);
    expect(files.some((n) => n.endsWith('In1_Cu.gbr'))).toBe(true);
    expect(files.some((n) => n.endsWith('In2_Cu.gbr'))).toBe(true);
    const inner = pcb.exportGerbers(filled, parts).files.find((f) => f.name.endsWith('In1_Cu.gbr'))!.content;
    expect(inner).toContain('%TF.FileFunction,Copper,L2,Inr*%');
  });

  it('never mutates its inputs', () => {
    const parts = stdParts();
    const b = emptyBoard(30, 20);
    b.components.push({ ...comp('r1', 'R1', 'res', 0, 0), placed: false }, { ...comp('r2', 'R2', 'res', 0, 0), placed: false });
    wire(b, 'N', ['R1.1', 'R2.1']);
    b.zones.push({ id: 'z', netId: 'net_N', layer: 'bottom', clearance: 0.3 });
    const snapshot = JSON.stringify(b);
    const partsSnap = JSON.stringify(parts);
    const placed = pcb.autoPlace(b, parts).board;
    runAll(placed, parts);
    runAll(b, parts);
    expect(JSON.stringify(b)).toBe(snapshot);
    expect(JSON.stringify(parts)).toBe(partsSnap);
  });
});
