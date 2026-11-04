import { describe, expect, it } from 'vitest';
import { convexHull, makePrim, primGap, primPtDist, segSegDist } from './geom';
import { regionsFromRings } from './region';
import { GridIndex, UnionFind } from './spatial';
import { padPrim } from './model';
import { placedPads } from '@pcbcad/core';
import { comp, footprint, smdPad } from './test-fixtures';

describe('geometry primitives', () => {
  it('computes exact gaps between discs, capsules and polygons', () => {
    const disc = makePrim([[0, 0]], 1);
    const disc2 = makePrim([[3, 0]], 0.5);
    expect(primGap(disc, disc2)).toBeCloseTo(1.5, 9);
    const seg = makePrim([[0, 2], [10, 2]], 0.25);
    expect(primGap(disc, seg)).toBeCloseTo(0.75, 9);
    const rect = makePrim([[2, -1], [4, -1], [4, 1], [2, 1]], 0);
    expect(primGap(disc, rect)).toBeCloseTo(1, 9);
    expect(primGap(disc2, rect)).toBeLessThan(0); // centre inside polygon
    const rr = makePrim([[0, 0], [1, 0], [1, 1], [0, 1]], 0.2);
    expect(primGap(rr, makePrim([[2, 2]], 0))).toBeCloseTo(Math.SQRT2 - 0.2, 9);
  });

  it('segment distance handles crossing, touching and parallel cases', () => {
    expect(segSegDist(0, 0, 2, 2, 0, 2, 2, 0)).toBe(0);
    expect(segSegDist(0, 0, 1, 0, 1, 0, 2, 0)).toBe(0);
    expect(segSegDist(0, 0, 1, 0, 0, 1, 1, 1)).toBeCloseTo(1, 12);
    expect(segSegDist(0, 0, 0, 0, 3, 4, 3, 4)).toBeCloseTo(5, 12);
  });

  it('point distance is negative inside copper', () => {
    const r = makePrim([[0, 0], [2, 0], [2, 1], [0, 1]], 0.1);
    expect(primPtDist(r, 1, 0.5)).toBeCloseTo(-0.1, 12);
    expect(primPtDist(r, 3, 0.5)).toBeCloseTo(0.9, 12);
  });

  it('pad prims are exact for all pad shapes, including rotation and bottom side', () => {
    const fp = footprint('t', [
      smdPad('1', 0, 0, 2, 1, 'rect'),
      smdPad('2', 3, 0, 2, 1, 'oval'),
      smdPad('3', 6, 0, 2, 1, 'roundrect'),
      { ...smdPad('4', 9, 0, 1.2, 1.2), shape: 'circle' },
    ]);
    for (const side of ['top', 'bottom'] as const) {
      const c = { ...comp('c', 'U1', 'p', 10, 10, 90), side };
      const pps = placedPads(c, fp);
      for (const pp of pps) {
        const prim = padPrim(pp);
        // the pad centre is inside, a point just beyond its half-extent outside
        expect(primPtDist(prim, pp.x, pp.y)).toBeLessThanOrEqual(0);
        const halfH = pp.pad.shape === 'circle' ? pp.pad.w / 2 : pp.pad.h / 2;
        // rotated 90°: local y becomes board -x (top) / ±x
        expect(Math.abs(primPtDist(prim, pp.x + halfH + 0.05, pp.y) - 0.05)).toBeLessThan(1e-6);
      }
    }
  });

  it('regroups even-odd rings into islands by nesting depth', () => {
    const sq = (x: number, y: number, s: number) =>
      [
        [x, y],
        [x + s, y],
        [x + s, y + s],
        [x, y + s],
      ] as [number, number][];
    const regions = regionsFromRings([sq(0, 0, 10), sq(2, 2, 6), sq(4, 4, 2), sq(20, 0, 3)]);
    expect(regions).toHaveLength(3);
    const big = regions.find((r) => r.rings[0].length && r.area() > 50)!;
    expect(big.rings).toHaveLength(2);
    expect(big.area()).toBeCloseTo(100 - 36, 9);
    expect(big.contains(1, 1)).toBe(true);
    expect(big.contains(3, 3)).toBe(false);
    const gap = big.gapTo(makePrim([[5, 5]], 0.5), 5);
    expect(gap).toBeCloseTo(2.5, 9); // disc sits in the hole, 3 mm from its edge
  });

  it('convex hull, spatial index and union-find', () => {
    const h = convexHull([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0.5, 0.5],
    ]);
    expect(h).toHaveLength(4);
    const idx = new GridIndex({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 1);
    idx.insert(0, { minX: 1, minY: 1, maxX: 2, maxY: 2 });
    idx.insert(1, { minX: 8, minY: 8, maxX: 9, maxY: 9 });
    idx.insert(2, { minX: -50, minY: -50, maxX: -40, maxY: -40 }); // clamped into the border bucket
    expect(idx.query({ minX: 0, minY: 0, maxX: 3, maxY: 3 }).sort()).toEqual([0, 2]);
    idx.remove(0, { minX: 1, minY: 1, maxX: 2, maxY: 2 });
    expect(idx.query({ minX: 0, minY: 0, maxX: 3, maxY: 3 })).toEqual([2]);
    const uf = new UnionFind(4);
    uf.union(0, 1);
    uf.union(2, 3);
    expect(uf.find(0)).toBe(uf.find(1));
    expect(uf.find(1)).not.toBe(uf.find(2));
  });
});
