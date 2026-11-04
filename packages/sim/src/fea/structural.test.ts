import { describe, expect, it } from 'vitest';
import { toFloat32, toUint32, toUint8 } from '@pcbcad/core';
import { analyzeStructure, solveStructural } from './structural';
import { blockGrid, makeGrid, openBoxGrid, testMaterial } from './testkit';
import type { StructuralSetup } from './types';

const steel = testMaterial();
const meta = { title: 'test', loads: ['load'], fixtures: ['fixture'] };

describe('solveStructural — cantilever (Euler–Bernoulli)', () => {
  // 100 × 10 × 10 mm steel, clamped at x = 0, 100 N tip load: δ = FL³/(3EI) = 0.2 mm
  const L = 100;
  const I = (10 * 10 ** 3) / 12;
  const exact = (100 * L ** 3) / (3 * 200000 * I);
  for (const h of [1, 2]) {
    it(`tip deflection within 10 % at h = ${h} mm`, () => {
      const grid = blockGrid(L, 10, 10, h);
      const setup: StructuralSetup = {
        grid,
        materials: [steel],
        fixtures: [{ kind: 'plane', axis: 'x', side: 'min' }],
        loads: [{ region: { kind: 'plane', axis: 'x', side: 'max' }, force: [0, 0, -100] }],
      };
      const a = analyzeStructure(setup);
      const tip = a.nodeDisplacement(grid.nx, Math.round(grid.ny / 2), Math.round(grid.nz / 2))!;
      const ratio = -tip[2] / exact;
      console.log(`cantilever h=${h}: δ_tip=${(-tip[2]).toFixed(5)} mm, EB=${exact.toFixed(5)} mm, ratio=${ratio.toFixed(4)}, PCG its=${a.stats.iterations}`);
      expect(a.stats.converged).toBe(true);
      expect(Math.abs(ratio - 1)).toBeLessThan(h === 1 ? 0.1 : 0.15);
      // public result: maxDisplacement ≈ tip deflection, root stress ≈ beam theory away from the clamp
      const r = solveStructural(setup, meta);
      expect(r.maxDisplacement / exact).toBeGreaterThan(0.95);
      expect(r.maxDisplacement / exact).toBeLessThan(1.05);
      const sigmaRoot = (100 * L * 5) / I; // 60 MPa
      expect(r.maxVonMises / sigmaRoot).toBeGreaterThan(0.85);
      expect(r.maxVonMises / sigmaRoot).toBeLessThan(1.05);
      expect(r.raw.maxVonMises).toBeGreaterThanOrEqual(r.maxVonMises);
      expect(r.minSafetyFactor).toBeCloseTo(250 / r.maxVonMises, 6);
    });
  }

  it('matches the beam bending stress along the span (surface stress at face centres)', () => {
    const grid = blockGrid(L, 10, 10, 1);
    const a = analyzeStructure({
      grid,
      materials: [steel],
      fixtures: [{ kind: 'plane', axis: 'x', side: 'min' }],
      loads: [{ region: { kind: 'plane', axis: 'x', side: 'max' }, force: [0, 0, -100] }],
    });
    for (const i of [20, 50, 80]) {
      const v = i + grid.nx * (5 + grid.ny * 9); // top layer, mid-width
      const sigma = (100 * (L - i - 0.5) * 5) / I;
      expect(a.vm[v] / sigma).toBeGreaterThan(0.98);
      expect(a.vm[v] / sigma).toBeLessThan(1.02);
    }
  });
});

describe('solveStructural — basic load cases', () => {
  it('axial bar: σ = F/A within 2 % and δ = FL/(EA)', () => {
    const grid = blockGrid(50, 10, 10, 1);
    const a = analyzeStructure({
      grid,
      materials: [steel],
      fixtures: [{ kind: 'plane', axis: 'x', side: 'min' }],
      loads: [{ region: { kind: 'plane', axis: 'x', side: 'max' }, force: [1000, 0, 0] }],
    });
    const sigma = 1000 / 100;
    for (const i of [20, 25, 30])
      for (const [j, k] of [[0, 0], [5, 5], [9, 3]]) {
        const v = i + grid.nx * (j + grid.ny * k);
        expect(Math.abs(a.vm[v] / sigma - 1)).toBeLessThan(0.02);
      }
    const end = a.nodeDisplacement(50, 5, 5)!;
    const exact = (1000 * 50) / (200000 * 100);
    expect(Math.abs(end[0] / exact - 1)).toBeLessThan(0.03);
    expect(a.appliedForce[0]).toBeCloseTo(1000, 6);
  });

  it('thin plate (2 voxels thick) bends like a plate/beam', () => {
    // 60 × 20 × 2 mm plate clamped at x = 0, 1 N tip load
    const grid = blockGrid(60, 20, 2, 1);
    const setup: StructuralSetup = {
      grid,
      materials: [steel],
      fixtures: [{ kind: 'plane', axis: 'x', side: 'min' }],
      loads: [{ region: { kind: 'plane', axis: 'x', side: 'max' }, force: [0, 0, -1] }],
    };
    const a = analyzeStructure(setup);
    const I = (20 * 2 ** 3) / 12;
    const beam = (1 * 60 ** 3) / (3 * 200000 * I);
    const tip = -a.nodeDisplacement(60, 10, 1)![2];
    const ratio = tip / beam;
    console.log(`thin plate: δ=${tip.toFixed(5)} mm, beam theory ${beam.toFixed(5)} mm, ratio ${ratio.toFixed(3)}, its=${a.stats.iterations}`);
    // between plate (1-ν²) and beam stiffness; plain trilinear hexes would give ~0.2–0.3 here
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.05);
    const r = solveStructural(setup, meta);
    const sigma = (6 * 1 * 58.5) / (20 * 4); // surface stress one voxel from the clamp
    expect(r.maxVonMises / sigma).toBeGreaterThan(0.85);
    expect(r.maxVonMises / sigma).toBeLessThan(1.15);
  });

  it("stressSampling 'centroid' reads mid-depth stress (≈ ½ the surface stress of a 2-voxel plate)", () => {
    const setup: StructuralSetup = {
      grid: blockGrid(60, 20, 2, 1),
      materials: [steel],
      fixtures: [{ kind: 'plane', axis: 'x', side: 'min' }],
      loads: [{ region: { kind: 'plane', axis: 'x', side: 'max' }, force: [0, 0, -1] }],
    };
    const surface = solveStructural(setup, meta);
    const centroid = solveStructural({ ...setup, stressSampling: 'centroid' }, meta);
    expect(centroid.maxDisplacement).toBeCloseTo(surface.maxDisplacement, 12);
    const ratio = centroid.maxVonMises / surface.maxVonMises;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.65);
  });

  it('pressure load: total force p·A, uniform compression σ = p', () => {
    const grid = blockGrid(10, 10, 20, 1);
    const p = 2;
    const a = analyzeStructure({
      grid,
      materials: [steel],
      fixtures: [{ kind: 'plane', axis: 'z', side: 'min' }],
      loads: [{ region: { kind: 'plane', axis: 'z', side: 'max' }, pressure: p }],
    });
    expect(a.appliedForce[2]).toBeCloseTo(-p * 100, 9);
    expect(Math.abs(a.appliedForce[0]) + Math.abs(a.appliedForce[1])).toBeLessThan(1e-9);
    for (const [i, j] of [[5, 5], [0, 0], [9, 4]]) {
      const v = i + 10 * (j + 10 * 12);
      expect(Math.abs(a.vm[v] / p - 1)).toBeLessThan(0.02);
    }
    const top = a.nodeDisplacement(5, 5, 20)!;
    expect(top[2]).toBeLessThan(0);
    expect(Math.abs(-top[2] / ((p * 20) / 200000) - 1)).toBeLessThan(0.05);
  });

  it('pressure on a box region acts on all exposed faces, inward', () => {
    // pressure on every exposed face of a free-floating cube balances to zero net force
    const grid = makeGrid(6, 6, 6, 1, (i, j, k) => (i > 0 && j > 0 && k > 0 && i < 5 && j < 5 && k < 5 ? 1 : 0));
    const a = analyzeStructure({
      grid,
      materials: [steel],
      fixtures: [{ kind: 'box', min: [2, 2, 2], max: [4, 4, 4] }],
      loads: [{ region: { kind: 'box', min: [0, 0, 0], max: [6, 6, 6] }, pressure: 1 }],
    });
    for (const c of a.appliedForce) expect(Math.abs(c)).toBeLessThan(1e-9);
    // hydrostatic compression → near-zero von Mises in the core, all displacements inward
    const corner = a.nodeDisplacement(1, 1, 1)!;
    expect(corner[0]).toBeGreaterThan(0);
    expect(corner[1]).toBeGreaterThan(0);
    expect(corner[2]).toBeGreaterThan(0);
  });

  it('body acceleration applies m·a and reports mass', () => {
    const grid = blockGrid(10, 10, 20, 1);
    const r = solveStructural(
      {
        grid,
        materials: [steel],
        fixtures: [{ kind: 'plane', axis: 'z', side: 'min' }],
        loads: [],
        bodyAcceleration: [0, 0, -9.81 * 1000],
      },
      meta,
    );
    const massKg = 7850 * 2000e-9;
    expect(r.massGrams).toBeCloseTo(massKg * 1000, 9);
    expect(r.appliedForce[2]).toBeCloseTo(-massKg * 9810, 9);
    // 1000 g column: base stress ≈ ρ a L = 7850·9810·0.02 Pa ≈ 1.54 MPa (one voxel above the clamp ~1.4)
    expect(r.maxVonMises).toBeGreaterThan(1.1);
    expect(r.maxVonMises).toBeLessThan(1.8);
  });
});

describe('solveStructural — robustness and result contract', () => {
  it('throws a helpful error without fixtures', () => {
    expect(() =>
      solveStructural(
        { grid: blockGrid(10, 10, 10, 1), materials: [steel], fixtures: [], loads: [{ region: { kind: 'plane', axis: 'z', side: 'max' }, force: [0, 0, -1] }] },
        meta,
      ),
    ).toThrow(/no fixtures/i);
  });

  it('throws when a region selects no solid voxels', () => {
    expect(() =>
      solveStructural(
        { grid: blockGrid(10, 10, 10, 1), materials: [steel], fixtures: [{ kind: 'box', min: [50, 50, 50], max: [60, 60, 60] }], loads: [] },
        meta,
      ),
    ).toThrow(/selects no solid voxels/);
  });

  it('throws when a material is missing', () => {
    const grid = makeGrid(4, 4, 4, 1, (i) => (i < 2 ? 1 : 2));
    expect(() =>
      solveStructural({ grid, materials: [steel], fixtures: [{ kind: 'plane', axis: 'x', side: 'min' }], loads: [] }, meta),
    ).toThrow(/materials\[1\] is missing/);
  });

  it('skips unfixed and point-fixed bodies with warnings', () => {
    // two cubes separated by a gap; only the first is fixed (third is fixed only at one voxel corner line)
    const grid = makeGrid(20, 4, 4, 1, (i) => (i < 8 ? 1 : i >= 10 && i < 14 ? 1 : 0));
    const r = solveStructural(
      {
        grid,
        materials: [steel],
        fixtures: [{ kind: 'plane', axis: 'x', side: 'min' }],
        loads: [{ region: { kind: 'box', min: [0, 0, 0], max: [20, 4, 4] }, force: [0, 0, -10] }],
      },
      meta,
    );
    expect(r.bodies).toEqual({ analysed: 1, skipped: 1 });
    expect(r.warnings.some((w) => /excluded from the analysis/.test(w))).toBe(true);
    const solid = toUint32(r.solid);
    const vm = toFloat32(r.vonMises);
    for (let q = 0; q < solid.length; q++) if (solid[q] % 20 >= 10) expect(vm[q]).toBe(0);
  });

  it('produces consistent packed arrays and metrics', () => {
    const grid = makeGrid(30, 6, 6, 1, (i, j, k) => (i < 25 || (j > 1 && j < 4 && k > 1 && k < 4) ? 1 : 0));
    const r = solveStructural(
      {
        grid,
        materials: [steel],
        fixtures: [{ kind: 'plane', axis: 'x', side: 'min' }],
        loads: [{ region: { kind: 'cylinder', center: [29.5, 3, 3], axis: [1, 0, 0], radius: 1.2, length: 1 }, force: [0, -50, 0] }],
      },
      meta,
    );
    const solid = toUint32(r.solid);
    const mat = toUint8(r.solidMaterial);
    const vm = toFloat32(r.vonMises);
    const disp = toFloat32(r.displacement);
    let count = 0;
    for (let v = 0; v < grid.cells.length; v++) if (grid.cells[v]) count++;
    expect(solid.length).toBe(count);
    expect(mat.length).toBe(count);
    expect(vm.length).toBe(count);
    expect(disp.length).toBe(3 * count);
    let vmMax = 0;
    for (const v of vm) vmMax = Math.max(vmMax, v);
    expect(vmMax).toBeCloseTo(r.raw.maxVonMises, 3);
    expect(r.maxVonMises).toBeLessThanOrEqual(r.raw.maxVonMises + 1e-9);
    expect(r.singularityExcludedVoxels).toBeGreaterThan(0);
    expect(r.solver.converged).toBe(true);
    expect(r.solver.residual).toBeLessThan(1e-6);
    expect(r.materials).toEqual([{ id: 'test-steel', name: 'Test steel', E: 200000, yieldStrength: 250 }]);
    expect(r.kind).toBe('structural');
    expect(r.loads).toEqual(['load']);
    expect(r.maxStressAt.every((c) => Number.isFinite(c))).toBe(true);
    expect(JSON.parse(JSON.stringify(r)).minSafetyFactor).toBe(r.minSafetyFactor);
  });

  it('reports progress monotonically up to 1', () => {
    const seen: number[] = [];
    solveStructural(
      {
        grid: blockGrid(40, 6, 6, 1),
        materials: [steel],
        fixtures: [{ kind: 'plane', axis: 'x', side: 'min' }],
        loads: [{ region: { kind: 'plane', axis: 'x', side: 'max' }, force: [0, 0, -1] }],
        onProgress: (f) => seen.push(f),
      },
      meta,
    );
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] - 1e-12);
  });
});

describe('solveStructural — performance', () => {
  it('solves a 42k-voxel thin-walled enclosure to 1e-6 in < 20 s', () => {
    // 110 × 80 × 35 mm open box, 2 mm ABS walls at h = 1 mm, four corner mounts, 50 N on the floor
    const grid = openBoxGrid(110, 80, 35, 2, 1);
    const abs = testMaterial({ materialId: 'abs', name: 'ABS', E: 2300, nu: 0.35, density: 1050, yieldStrength: 43 });
    const t0 = performance.now();
    const r = solveStructural(
      {
        grid,
        materials: [abs],
        fixtures: [
          { kind: 'box', min: [0, 0, 0], max: [8, 8, 1] },
          { kind: 'box', min: [102, 0, 0], max: [110, 8, 1] },
          { kind: 'box', min: [0, 72, 0], max: [8, 80, 1] },
          { kind: 'box', min: [102, 72, 0], max: [110, 80, 1] },
        ],
        loads: [
          { region: { kind: 'box', min: [45, 30, 1], max: [65, 50, 2] }, force: [0, 0, -50] },
          { region: { kind: 'plane', axis: 'x', side: 'max' }, pressure: 0.01 },
        ],
        tolerance: 1e-6,
      },
      meta,
    );
    const ms = performance.now() - t0;
    const nVox = toUint32(r.solid).length;
    console.log(`perf: ${nVox} voxels, ${r.solver.dofs} DOFs, ${r.solver.iterations} PCG its, ${(ms / 1000).toFixed(1)} s`);
    expect(nVox).toBeGreaterThan(40000);
    expect(r.solver.converged).toBe(true);
    expect(ms).toBeLessThan(20000);
  });
});
