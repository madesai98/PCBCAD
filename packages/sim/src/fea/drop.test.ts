import { describe, expect, it } from 'vitest';
import { toFloat32, toUint32 } from '@pcbcad/core';
import { FLOOR_STIFFNESS, halfSineShockFactor, solveDrop } from './drop';
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
      const mEff = r.effectiveMassGrams / 1000;
      expect(mEff).toBeLessThanOrEqual(m * (1 + 1e-9));
      expect(mEff / m).toBeGreaterThan(0.95); // centred face drop: (almost) no rotation
      expect(k).toBeCloseTo(1 / (1 / r.stiffness.structural + 1 / FLOOR_STIFFNESS.concrete), 3);
      expect(r.peakForceN).toBeCloseTo(r.impactVelocity * Math.sqrt(k * mEff), 6);
      expect(r.peakG).toBeCloseTo(r.peakForceN / m / 9.81, 6);
      expect(r.contactDurationMs).toBeCloseTo(Math.PI * Math.sqrt(mEff / k) * 1000, 6);
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
      // local rigid-body acceleration at the component (translation + rotation about the centre of mass)
      const gLocal = c.inertialForceN / (c.massGrams / 1000) / 9.81;
      const expected = c.inertialForceN > 40 || (c.massGrams > 2 && gLocal > 1500) ? 'high' : c.inertialForceN > 10 || gLocal > 500 ? 'medium' : 'low';
      expect(c.risk).toBe(expected);
      expect(gLocal / r.peakG).toBeGreaterThan(0.7);
      expect(gLocal / r.peakG).toBeLessThan(1.3);
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

describe('solveDrop — load paths, rigid-body loading and shock response', () => {
  const pcabs = testMaterial({ materialId: 'pc-abs', name: 'PC/ABS', E: 2300, nu: 0.36, density: 1140, yieldStrength: 53 });
  /** Closed 56 × 64 × 24 mm PC/ABS shell (2 mm walls, h = 2 mm) with four Ø6 mm bosses up to z = 8 mm. */
  function shell() {
    const nx = 28;
    const ny = 32;
    const nz = 12;
    const bosses: [number, number][] = [[8, 8], [48, 8], [8, 56], [48, 56]];
    const grid = makeGrid(nx, ny, nz, 2, (i, j, k) => {
      const x = 2 * i + 1;
      const y = 2 * j + 1;
      const z = 2 * k + 1;
      if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) return 1;
      return z < 8 && bosses.some(([bx, by]) => Math.hypot(x - bx, y - by) < 3.2) ? 1 : 0;
    });
    const bossCells: number[] = [];
    for (let v = 0; v < grid.cells.length; v++) {
      const k = Math.floor(v / (nx * ny));
      if (grid.cells[v] && k >= 1 && k <= 3 && bosses.some(([bx, by]) => Math.hypot(2 * (v % nx) + 1 - bx, 2 * (Math.floor(v / nx) % ny) + 1 - by) < 3.2)) bossCells.push(v);
    }
    // a PCB at z ≈ 9 mm with components floating in the cavity (the board itself is not voxelised)
    const masses = [
      { position: [28, 32, 9] as [number, number, number], massGrams: 5.2, ref: 'PCB' },
      { position: [20, 25, 11] as [number, number, number], massGrams: 8, componentId: 'bt1', ref: 'BT1' },
      { position: [36, 40, 10.5] as [number, number, number], massGrams: 2, componentId: 'u1', ref: 'U1' },
      { position: [15, 45, 10.5] as [number, number, number], massGrams: 1.2, componentId: 'j1', ref: 'J1' },
      { position: [40, 20, 10] as [number, number, number], massGrams: 0.3, componentId: 'c1', ref: 'C1' },
    ];
    return { grid, masses, bossCells };
  }

  it('masses floating in a cavity load the structure where they press, without point-load artefacts', () => {
    const { grid, masses } = shell();
    const r = solveDrop({ grid, materials: [pcabs], heightM: 1, orientation: 'bottom', extraMasses: masses });
    console.log(
      `shell drop 1 m bottom: m=${r.massGrams.toFixed(1)} g, ${r.peakG.toFixed(0)} g, σmax=${r.structural.maxVonMises.toFixed(1)} MPa ` +
        `(raw ${r.structural.raw.maxVonMises.toFixed(1)}, p99 ${r.structural.vonMisesP99.toFixed(1)}), SF ${r.structural.minSafetyFactor.toFixed(2)}, ` +
        `δmax=${r.structural.maxDisplacement.toFixed(2)} mm, dyn ${r.dynamics.factorMin.toFixed(2)}–${r.dynamics.factorMax.toFixed(2)}`,
    );
    expect(r.massAttachments.every((a) => a.method === 'drop-path' && a.voxels >= 9)).toBe(true);
    expect(r.massGrams).toBeGreaterThan(40);
    expect(r.massGrams).toBeLessThan(70);
    expect(r.structural.maxVonMises).toBeLessThan(53); // a 1 m flat drop of a ~55 g plastic box is survivable
    expect(r.structural.minSafetyFactor).toBeGreaterThan(1);
    expect(r.structural.raw.maxVonMises).toBeLessThan(2 * r.structural.vonMisesP99 + 1e-9);
    expect(r.structural.maxDisplacement).toBeLessThan(3);
    expect(r.dynamics.applied).toBe(true);
  });

  it('support regions carry the board and component inertia through the bosses', () => {
    const { grid, masses, bossCells } = shell();
    // union of the four boss cylinders (one shared array for the whole board)
    const support = [[8, 8], [48, 8], [8, 56], [48, 56]].map(([bx, by]) => ({ kind: 'cylinder' as const, center: [bx, by, 5] as [number, number, number], axis: [0, 0, 1] as [number, number, number], radius: 3.2, length: 6 }));
    const r = solveDrop({ grid, materials: [pcabs], heightM: 1, orientation: 'side-x', extraMasses: masses.map((m) => ({ ...m, support })) });
    expect(r.massAttachments.every((a) => a.method === 'support' && a.voxels === bossCells.length)).toBe(true);
    // the highest stress sits in or at the root of a boss (z < 10 mm, within 6 mm of a boss axis)
    const [x, y, z] = r.structural.maxStressAt;
    const nearBoss = [[8, 8], [48, 8], [8, 56], [48, 56]].some(([bx, by]) => Math.hypot(x - bx, y - by) < 6);
    expect(nearBoss && z < 10).toBe(true);
    expect(Number.isFinite(r.structural.maxVonMises)).toBe(true);
  });

  it('uses rigid-body (inertia-relief) loading: no rotation for a centred face drop, reduced effective mass at a corner', () => {
    const { grid } = shell();
    const flat = solveDrop({ grid, materials: [pcabs], heightM: 1, orientation: 'bottom' });
    expect(Math.hypot(...flat.angularAcceleration)).toBeLessThan(1e-6 * flat.peakG * 9.81 * 1000);
    expect(flat.effectiveMassGrams / flat.massGrams).toBeGreaterThan(0.999);
    const corner = solveDrop({ grid, materials: [pcabs], heightM: 1, orientation: 'corner' });
    expect(corner.effectiveMassGrams).toBeLessThan(0.9 * corner.massGrams);
    expect(Math.hypot(...corner.angularAcceleration)).toBeGreaterThan(1e3);
    expect(corner.structural.maxDisplacement).toBeLessThan(5);
  });

  it('half-sine shock-response factor has the textbook shape', () => {
    expect(halfSineShockFactor(0.1)).toBeCloseTo(0.396, 2);
    expect(halfSineShockFactor(0.01)).toBeCloseTo(0.04, 3);
    let peak = 0;
    for (let r = 0.3; r < 2; r += 0.01) peak = Math.max(peak, halfSineShockFactor(r));
    expect(peak).toBeCloseTo(1.77, 1);
    expect(halfSineShockFactor(50)).toBeCloseTo(1, 1);
    const { grid } = shell();
    const off = solveDrop({ grid, materials: [pcabs], heightM: 1, orientation: 'bottom', dynamicCorrection: false });
    expect(off.dynamics).toMatchObject({ applied: false, factorMin: 1, factorMax: 1 });
  });
});
