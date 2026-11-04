/**
 * Regression tests from randomised (fuzz) runs: odd inputs must either build valid geometry or
 * fail with a descriptive error, and the analytic rasteriser must agree with the manifold mesh.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { CsgNode, CustomPart, EnclosureShell, SheetMetalPart } from '@pcbcad/core';
import { createBoard, createProject } from '@pcbcad/core';
import { autoEnclosure, buildPartMesh, checkAssembly, checkMoldability, checkSheetMetal, estimateCost, estimateSolidVolume, exportDxf, flatPattern, initGeometry, massProperties, partSolid } from './index';
import { USBC, partDef } from './__fixtures__/project';

function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

const custom = (csg: CsgNode): CustomPart => ({ id: 'c', name: 'c', kind: 'custom', materialId: 'abs', process: 'cnc-machining', csg });

beforeAll(async () => {
  await initGeometry();
});

describe('fuzz regressions', () => {
  it('low segment counts: rasteriser uses the same n-gon as the mesh', async () => {
    for (const csg of [
      { shape: 'cylinder', radius: 10, height: 5, segments: 6 },
      { shape: 'revolve', profile: [[2, 0], [10, 0], [10, 5], [2, 5]], segments: 5 },
    ] as CsgNode[]) {
      const p = custom(csg);
      const mesh = massProperties(await buildPartMesh(p), 1).volumeMm3;
      const est = estimateSolidVolume(partSolid(p)!, 2_000_000).volume;
      expect(est / mesh).toBeCloseTo(1, 1);
    }
    // a 6-segment cylinder is a hexagonal prism of circumradius r
    const hex = massProperties(await buildPartMesh(custom({ shape: 'cylinder', radius: 10, height: 1, segments: 6 })), 1).volumeMm3;
    expect(hex).toBeCloseTo(1.5 * Math.sqrt(3) * 100, 3);
  });

  it('self-intersecting extrude polygons use even-odd filling in both evaluators', async () => {
    const bowtie = custom({ shape: 'extrude', points: [[0, 0], [10, 10], [10, 0], [0, 10]], height: 2 });
    const mesh = massProperties(await buildPartMesh(bowtie), 1).volumeMm3;
    expect(mesh).toBeCloseTo(100, 3); // two triangles of 25 mm² each … × 2 mm
    expect(estimateSolidVolume(partSolid(bowtie)!, 1_000_000).volume / mesh).toBeCloseTo(1, 1);
  });

  it('tiny sheet bases with rejected flanges keep their base', () => {
    const p: SheetMetalPart = {
      id: 's',
      name: 's',
      kind: 'sheet-metal',
      materialId: 'spcc',
      process: 'sheet-metal',
      thickness: 2,
      bendRadius: 4,
      kFactor: 0.44,
      base: { width: 2, length: 4 },
      holes: [],
      flanges: [{ id: 'a', edge: '+x', length: 10, angle: 90 }, { id: 'b', edge: '+y', length: 10, angle: 90 }],
    };
    const flat = flatPattern(p);
    expect(flat.outline.length).toBeGreaterThanOrEqual(3);
    expect(checkSheetMetal(p).some((i) => i.severity === 'error')).toBe(true);
  });

  it('cost estimation never throws on invalid geometry', () => {
    const bad = { id: 'x', name: 'x', kind: 'enclosure-shell', role: 'base', materialId: 'abs', process: 'injection-molding', outer: { width: 10, depth: 10, height: 3 }, wall: 6, cornerRadius: 1, draftDeg: 1, bosses: [], ribs: [], cutouts: [], vents: [], snaps: [] } as EnclosureShell;
    const c = estimateCost(bad, 100);
    expect(c.unitUsd).toBe(0);
    expect(c.notes[0]).toMatch(/Cannot estimate/);
    expect(checkMoldability(bad).map((i) => i.code)).toContain('invalid-geometry');
  });

  it('random shells, sheets and CSG build or fail cleanly; meshes agree with the rasteriser', async () => {
    const rnd = lcg(4242);
    const R = (a: number, b: number) => a + (b - a) * rnd();
    for (let n = 0; n < 12; n++) {
      const W = R(30, 120), D = R(20, 90), H = R(8, 40);
      const s: EnclosureShell = {
        id: 's',
        name: 'fuzz',
        kind: 'enclosure-shell',
        role: 'base',
        materialId: 'pc-abs',
        process: 'injection-molding',
        outer: { width: W, depth: D, height: H },
        wall: R(1, 3),
        cornerRadius: R(0, 8),
        draftDeg: R(0, 3),
        processOptions: { innerFillet: R(0, 2) },
        lip: rnd() < 0.5 ? { kind: rnd() < 0.5 ? 'lip' : 'groove', height: R(0.5, 2), thickness: R(0.4, 1) } : undefined,
        bosses: [{ id: 'b', x: R(-W / 3, W / 3), y: R(-D / 3, D / 3), outerDiameter: R(4, 9), holeDiameter: R(0, 3.5), height: R(2, H), kind: 'insert', gussets: Math.floor(R(0, 5)), throughFloor: rnd() < 0.3 }],
        ribs: [{ id: 'r', from: [R(-W / 2, W / 2), R(-D / 2, D / 2)], to: [R(-W / 2, W / 2), R(-D / 2, D / 2)], height: R(1, H / 2), thickness: R(0.8, 2) }],
        cutouts: [{ id: 'c', face: (['+x', '-x', '+y', '-y', 'floor'] as const)[n % 5], shape: (['rect', 'rounded-rect', 'circle', 'slot'] as const)[n % 4], u: R(-10, 10), v: R(3, H), width: R(2, 12), height: R(2, 8) }],
        vents: [{ id: 'v', face: (['+y', 'floor'] as const)[n % 2], u: 0, v: n % 2 ? 0 : H / 2, slotWidth: 1.5, slotLength: R(3, 10), count: Math.floor(R(1, 8)), pitch: R(2.5, 5), orientation: rnd() < 0.5 ? 'u' : 'v' }],
        snaps: [{ id: 'k', face: '+x', u: 0, width: R(3, 8), length: R(4, 10), thickness: R(0.8, 2), overhang: R(0.3, 1.2), kind: rnd() < 0.5 ? 'hook' : 'catch' }],
      };
      checkMoldability(s);
      const m = await buildPartMesh(s);
      const v = massProperties(m, 1).volumeMm3;
      expect(v).toBeGreaterThan(0);
      expect(Math.abs(estimateSolidVolume(partSolid(s)!, 1_500_000).volume / v - 1)).toBeLessThan(0.06);
    }
    for (let n = 0; n < 12; n++) {
      const p: SheetMetalPart = {
        id: 'p',
        name: 'fuzz',
        kind: 'sheet-metal',
        materialId: 'al-5052-h32',
        process: 'sheet-metal',
        thickness: R(0.8, 3),
        bendRadius: R(0.5, 4),
        kFactor: R(0.3, 0.5),
        base: { width: R(20, 120), length: R(20, 100), cornerRadius: R(0, 5) },
        reliefs: (['rect', 'obround', 'none'] as const)[n % 3],
        holes: [{ id: 'h', x: R(-10, 10), y: R(-10, 10), shape: 'circle', diameter: R(2, 6) }],
        flanges: (['+x', '-x', '+y', '-y'] as const)
          .filter(() => rnd() < 0.6)
          .map((e, i) => ({ id: `f${i}`, edge: e, length: R(6, 30), angle: R(-150, 150) || 90, width: rnd() < 0.4 ? R(10, 40) : undefined, offset: rnd() < 0.4 ? R(-5, 5) : undefined, flanges: rnd() < 0.3 ? [{ id: `n${i}`, edge: 'far' as const, length: R(6, 15), angle: R(-120, 120) || 90 }] : undefined })),
      };
      checkSheetMetal(p);
      const flat = flatPattern(p);
      expect(flat.outline.length).toBeGreaterThanOrEqual(3);
      expect(exportDxf(flat)).toContain('EOF');
      const v = massProperties(await buildPartMesh(p), 1).volumeMm3;
      expect(v).toBeGreaterThan(0);
      // volume ≈ flat area × t within the K-factor / overlap tolerance
      expect(v / (flat.areaMm2 * p.thickness)).toBeGreaterThan(0.8);
    }
  });

  it('side-by-side connectors share one opening and still pass the assembly check', () => {
    const project = createProject('two');
    const b = createBoard('B', 70, 40);
    b.holes = [[4, 4], [66, 4], [66, 36], [4, 36]].map(([x, y], i) => ({ id: `H${i}`, x, y, drill: 3.2, plated: false }));
    project.parts = { [USBC.id]: USBC, U: partDef('U', { body: { w: 5, l: 5, h: 1 } }) };
    const conn = (id: string, x: number) => ({ id, ref: id, partId: USBC.id, x, y: 3.2, rotation: 0, side: 'top' as const, placed: true, pinNets: {} });
    b.components = [conn('J1', 30), conn('J2', 40), { id: 'U1', ref: 'U1', partId: 'U', x: 35, y: 25, rotation: 0, side: 'top', placed: true, pinNets: {} }];
    project.boards.push(b);
    const r = autoEnclosure(project, [b.id], { wall: 1.5 });
    expect(r.base.cutouts).toHaveLength(1);
    expect(r.base.cutouts[0].linked).toBeUndefined();
    expect(r.base.lip).toBeUndefined(); // 1.5 mm wall is too thin for lip + groove
    expect(r.notes.join('\n')).toMatch(/merged/);
    project.mechanical.push(r.base, r.cover);
    project.assembly = { instances: r.instances, fasteners: r.fasteners };
    expect(checkAssembly(project).filter((i) => i.severity === 'error')).toEqual([]);
    expect(checkMoldability(r.base).map((i) => i.code)).not.toContain('lip-wall');
  });
});
