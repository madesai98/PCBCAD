import { describe, expect, it } from 'vitest';
import { toFloat32, toUint32 } from '@pcbcad/core';
import { FLOOR_STIFFNESS, solveDrop } from './drop';
import { makeGrid, testMaterial } from './testkit';
import type { DropSetup } from './types';

const abs = testMaterial({ materialId: 'abs', name: 'ABS', E: 2300, nu: 0.35, density: 1050, yieldStrength: 43 });

/** Closed 80 × 50 × 20 mm ABS box with 2 mm walls (h = 2 mm). */
function closedBox() {
  const h = 2;
  const nx = 40;
  const ny = 25;
  const nz = 10;
  return makeGrid(nx, ny, nz, h, (i, j, k) => (k === 0 || k === nz - 1 || i === 0 || j === 0 || i === nx - 1 || j === ny - 1 ? 1 : 0));
}

const base = (over: Partial<DropSetup> = {}): DropSetup => ({
  grid: closedBox(),
  materials: [abs],
  heightM: 1,
  orientation: 'top',
  extraMasses: [{ position: [40, 25, 2], massGrams: 20, componentId: 'c1', ref: 'BT1' }],
  ...over,
});

describe('solveDrop', () => {
  it('impact velocity and peak force scale with √H; fields are self-consistent', () => {
    const r1 = solveDrop(base({ heightM: 0.5 }));
    const r2 = solveDrop(base({ heightM: 2 }));
    expect(r1.impactVelocity).toBeCloseTo(Math.sqrt(2 * 9.81 * 0.5), 10);
    expect(r2.impactVelocity / r1.impactVelocity).toBeCloseTo(2, 10);
    expect(r2.peakForceN / r1.peakForceN).toBeCloseTo(2, 6);
    expect(r2.peakG / r1.peakG).toBeCloseTo(2, 6);
    for (const r of [r1, r2]) {
      const m = r.massGrams / 1000;
      const k = r.stiffness.effective;
      expect(k).toBeCloseTo(1 / (1 / r.stiffness.structural + 1 / FLOOR_STIFFNESS.concrete), 3);
      expect(r.peakForceN).toBeCloseTo(r.impactVelocity * Math.sqrt(k * m), 6);
      expect(r.peakG).toBeCloseTo(r.peakForceN / m / 9.81, 6);
      expect(r.contactDurationMs).toBeCloseTo(Math.PI * Math.sqrt(m / k) * 1000, 6);
      expect(r.stopDistanceMm).toBeCloseTo((r.peakForceN / k) * 1000, 6);
      expect(r.kind).toBe('drop');
      expect(r.structural.kind).toBe('structural');
      expect(r.structural.solver.converged).toBe(true);
      expect(r.impactPatchVoxels).toBeGreaterThan(0);
    }
    // stresses scale linearly with the deceleration
    expect(r2.structural.maxVonMises / r1.structural.maxVonMises).toBeCloseTo(2, 4);
    // mass = solid voxels + extra mass
    const solidCount = toUint32(r1.structural.solid).length;
    expect(r1.massGrams).toBeCloseTo(solidCount * 8 * 1050e-6 + 20, 9);
  });

  it('heavier carried mass gives a larger impact force and component load (stiff load path)', () => {
    // bottom drop: the mass sits on the floor plate right above the impact face
    const mk = (g: number) => base({ orientation: 'bottom', extraMasses: [{ position: [40, 25, 2], massGrams: g, componentId: 'c1' }] });
    const light = solveDrop(mk(10));
    const heavy = solveDrop(mk(60));
    expect(heavy.massGrams).toBeGreaterThan(light.massGrams);
    expect(heavy.peakForceN).toBeGreaterThan(light.peakForceN);
    expect(heavy.componentRisks[0].inertialForceN).toBeGreaterThan(light.componentRisks[0].inertialForceN);
  });

  it('a heavy mass on a compliant mount softens the equivalent spring (Rayleigh stiffness)', () => {
    // top drop: the floor plate carrying the mass hangs from the walls and bends
    const light = solveDrop(base({ extraMasses: [{ position: [40, 25, 2], massGrams: 10, componentId: 'c1' }] }));
    const heavy = solveDrop(base({ extraMasses: [{ position: [40, 25, 2], massGrams: 60, componentId: 'c1' }] }));
    expect(heavy.stiffness.structural).toBeLessThan(light.stiffness.structural);
    expect(heavy.contactDurationMs).toBeGreaterThan(light.contactDurationMs);
  });

  it('softer floors reduce peak deceleration and lengthen the pulse', () => {
    const concrete = solveDrop(base({ floor: 'concrete', orientation: 'bottom' }));
    const carpet = solveDrop(base({ floor: 'carpet', orientation: 'bottom' }));
    expect(carpet.peakG).toBeLessThan(concrete.peakG);
    expect(carpet.contactDurationMs).toBeGreaterThan(concrete.contactDurationMs);
  });

  it('classifies component risks with the documented heuristic', () => {
    const r = solveDrop(
      base({
        heightM: 1.5,
        orientation: 'bottom',
        extraMasses: [
          { position: [40, 25, 2], massGrams: 0.05, componentId: 'r1', ref: 'R1' },
          { position: [20, 25, 2], massGrams: 25, componentId: 'b1', ref: 'BT1' },
          { position: [60, 25, 2], massGrams: 3 },
        ],
      }),
    );
    expect(r.componentRisks.map((c) => c.ref)).toEqual(['R1', 'BT1']);
    for (const c of r.componentRisks) {
      const expected =
        c.inertialForceN > 40 || (c.massGrams > 2 && r.peakG > 1500) ? 'high' : c.inertialForceN > 10 || r.peakG > 500 ? 'medium' : 'low';
      expect(c.risk).toBe(expected);
      expect(c.inertialForceN).toBeCloseTo((c.massGrams / 1000) * r.peakG * 9.81, 6);
      expect(c.note.length).toBeGreaterThan(10);
    }
    expect(r.componentRisks[1].risk).toBe('high');
  });

  it('handles corner and edge drops with small impact patches', () => {
    for (const orientation of ['corner', 'edge', 'side-x', 'side-y'] as const) {
      const r = solveDrop(base({ orientation }));
      expect(r.impactPatchVoxels).toBeGreaterThan(0);
      expect(Number.isFinite(r.peakG) && r.peakG > 0).toBe(true);
      expect(r.structural.maxVonMises).toBeGreaterThan(0);
      const vm = toFloat32(r.structural.vonMises);
      expect(vm.length).toBe(toUint32(r.structural.solid).length);
    }
    const corner = solveDrop(base({ orientation: 'corner' }));
    const bottom = solveDrop(base({ orientation: 'bottom' }));
    // a corner contact is much more compliant than a flat face contact
    expect(corner.stiffness.structural).toBeLessThan(bottom.stiffness.structural);
    expect(corner.peakG).toBeLessThan(bottom.peakG);
  });

  it('zero height gives zero load', () => {
    const r = solveDrop(base({ heightM: 0 }));
    expect(r.peakForceN).toBe(0);
    expect(r.structural.maxVonMises).toBe(0);
  });
});
