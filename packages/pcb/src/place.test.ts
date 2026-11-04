import { describe, expect, it } from 'vitest';
import { placedPads, componentCourtyard, pointInPolygon, type Board, type PartDef } from '@pcbcad/core';
import { autoPlace } from './place';
import { convexOverlapDepth, runDrc } from './drc';
import { bigBoard, comp, emptyBoard, routingTestBoard, stdParts, wire } from './test-fixtures';
import { autoRoute } from './route';

function unplace(b: Board) {
  for (const c of b.components) {
    c.placed = false;
    c.x = 0;
    c.y = 0;
    c.rotation = 0;
  }
}

function assertLegal(b: Board, parts: Record<string, PartDef>, spacing: number) {
  const inset = b.rules.edgeClearance;
  const polys = b.components.map((c) => ({ c, poly: componentCourtyard(c, parts[c.partId].footprint!) }));
  for (const { c, poly } of polys) {
    expect(c.placed).toBe(true);
    expect([0, 90, 180, 270]).toContain(c.rotation);
    const part = parts[c.partId];
    if (part.category === 'connector' && part.connector?.matingDirection) {
      // edge connectors may overhang the edge with their body; their copper must keep edge clearance
      for (const pp of placedPads(c, part.footprint!))
        for (const p of pp.polygon) {
          expect(pointInPolygon(p, b.outline)).toBe(true);
          expect(p[0]).toBeGreaterThanOrEqual(inset - 1e-6);
          expect(p[1]).toBeGreaterThanOrEqual(inset - 1e-6);
        }
      continue;
    }
    for (const p of poly) {
      expect(pointInPolygon(p, b.outline)).toBe(true);
      expect(p[0]).toBeGreaterThanOrEqual(inset - 1e-6);
      expect(p[1]).toBeGreaterThanOrEqual(inset - 1e-6);
    }
  }
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      if (polys[i].c.side !== polys[j].c.side) continue;
      // inflate by spacing/2 each: must not overlap
      const grow = (poly: typeof polys[number]['poly']) => {
        const xs = poly.map((p) => p[0]);
        const ys = poly.map((p) => p[1]);
        const h = spacing / 2 - 1e-6;
        return [
          [Math.min(...xs) - h, Math.min(...ys) - h],
          [Math.max(...xs) + h, Math.min(...ys) - h],
          [Math.max(...xs) + h, Math.max(...ys) + h],
          [Math.min(...xs) - h, Math.max(...ys) + h],
        ] as [number, number][];
      };
      expect(convexOverlapDepth(grow(polys[i].poly), grow(polys[j].poly))).toBeLessThanOrEqual(1e-6);
    }
  }
}

describe('autoPlace', () => {
  it('produces a legal, routable placement with connectors at edges and decaps at supply pins', () => {
    const { board, parts } = routingTestBoard();
    board.holes.push({ id: 'h1', x: 4, y: 4, drill: 3.2, plated: false });
    unplace(board);
    const before = structuredClone(board);
    const { board: out, report } = autoPlace(board, parts, { seed: 7 });
    expect(board).toEqual(before);
    assertLegal(out, parts, 0.5);
    const drc = runDrc(out, parts);
    expect(drc.filter((i) => i.code === 'courtyard-overlap' || i.code === 'outside-board' || i.code === 'unplaced')).toEqual([]);
    // connectors on edges
    const j1 = out.components.find((c) => c.ref === 'J1')!;
    const j2 = out.components.find((c) => c.ref === 'J2')!;
    const edgeDist = (c: typeof j1) => Math.min(c.x, c.y, 50 - c.x, 40 - c.y);
    expect(edgeDist(j1)).toBeLessThan(3);
    expect(edgeDist(j2)).toBeLessThan(3);
    // mounting hole keep-out
    for (const c of out.components) expect(Math.hypot(c.x - 4, c.y - 4)).toBeGreaterThan(3);
    // decoupling caps within a few mm of their IC supply pin
    const u1 = out.components.find((c) => c.ref === 'U1')!;
    const decaps = report.filter((l) => /decoupling U1/.test(l));
    expect(decaps.length).toBeGreaterThan(0);
    for (const line of decaps) {
      const ref = line.split(' ')[0];
      const cap = out.components.find((c) => c.ref === ref)!;
      expect(Math.hypot(cap.x - u1.x, cap.y - u1.y)).toBeLessThan(9);
    }
    expect(report.some((l) => /J1 → \w+ edge/.test(l))).toBe(true);
    // and it routes
    const r = autoRoute(out, parts);
    expect(r.failed).toEqual([]);
  });

  it('honours explicit edges with offsets, locked parts and keepPlaced', () => {
    const { board, parts } = routingTestBoard();
    unplace(board);
    const u2 = board.components.find((c) => c.ref === 'U2')!;
    Object.assign(u2, { x: 12, y: 30, placed: true, locked: true });
    const r5 = board.components.find((c) => c.ref === 'R5')!;
    Object.assign(r5, { x: 40, y: 8, rotation: 90, placed: true });
    const j1 = board.components.find((c) => c.ref === 'J1')!;
    const { board: out } = autoPlace(board, parts, { keepPlaced: true, edges: [{ componentId: j1.id, edge: 'top', offset: 10 }] });
    const o = (ref: string) => out.components.find((c) => c.ref === ref)!;
    expect([o('U2').x, o('U2').y]).toEqual([12, 30]);
    expect([o('R5').x, o('R5').y, o('R5').rotation]).toEqual([40, 8, 90]);
    expect(o('J1').y).toBeGreaterThan(35);
    expect(Math.abs(o('J1').x - 35)).toBeLessThan(1.5);
    // long side along the edge
    expect(o('J1').rotation % 180).toBe(90);
    assertLegal(out, parts, 0.5);
  });

  it('puts crystals next to the MCU crystal pins and orients mating connectors outward', () => {
    const parts = stdParts();
    parts.usb = { ...parts.hdr4, id: 'usb', connector: { family: 'USB-C', gender: 'female', role: 'board', positions: 4, matesWith: [], contactResistance: 0.03, currentRating: 3, matingDirection: '+y' } };
    const b = emptyBoard(40, 30);
    b.components.push(comp('u1', 'U1', 'mcu', 0, 0), comp('y1', 'Y1', 'xtal', 0, 0), comp('j1', 'J1', 'usb', 0, 0), comp('c1', 'C1', 'cap', 0, 0), comp('c2', 'C2', 'cap', 0, 0));
    wire(b, 'XIN', ['U1.19', 'Y1.1', 'C1.1']);
    wire(b, 'XOUT', ['U1.20', 'Y1.2', 'C2.1']);
    wire(b, 'GND', ['U1.2', 'C1.2', 'C2.2', 'J1.2']);
    wire(b, 'VCC', ['U1.1', 'J1.1']);
    unplace(b);
    const { board: out, report } = autoPlace(b, parts, { edges: [{ componentId: 'j1', edge: 'left' }] });
    assertLegal(out, parts, 0.5);
    const u1 = out.components[0];
    const y1 = out.components[1];
    expect(Math.hypot(y1.x - u1.x, y1.y - u1.y)).toBeLessThan(10);
    expect(report.some((l) => /Y1 → next to U1/.test(l))).toBe(true);
    // mating direction +y rotated to face -x (left edge): rotation 90
    expect(out.components[2].rotation).toBe(90);
    // and slid to the edge: body overhangs, mating face just past x = 0
    expect(report.some((l) => /J1 slid .* to the board edge/.test(l))).toBe(true);
  });

  it('reports parts that do not fit and leaves them unplaced', () => {
    const parts = stdParts();
    const b = emptyBoard(8, 6);
    for (let k = 0; k < 12; k++) b.components.push({ ...comp(`r${k}`, `R${k}`, 'res', 0, 0), placed: false });
    const { board: out, report } = autoPlace(b, parts);
    const placed = out.components.filter((c) => c.placed);
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.length).toBeLessThan(12);
    expect(report.some((l) => /Could not place/.test(l))).toBe(true);
    const sub = { ...out, components: placed };
    assertLegal(sub, parts, 0.5);
  });

  it('places 150 components in under 2 s', () => {
    const { board, parts } = bigBoard(150);
    autoPlace(routingTestBoard().board, routingTestBoard().parts); // warm-up (JIT)
    const t0 = performance.now();
    const { board: out } = autoPlace(board, parts, { seed: 3 });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
    assertLegal(out, parts, 0.5);
  });
});
