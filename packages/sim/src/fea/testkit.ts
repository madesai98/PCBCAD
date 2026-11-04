/** Helpers for building voxel grids and materials in FEA/CFD tests (not part of the public API). */
import type { EffectiveMaterial, VoxelGrid } from '@pcbcad/core';

/** Isotropic test material with the given E (MPa) and ν; steel-like defaults. */
export function testMaterial(over: Partial<EffectiveMaterial> = {}): EffectiveMaterial {
  return {
    materialId: 'test-steel',
    name: 'Test steel',
    process: 'cnc-machining',
    density: 7850,
    E: 200000,
    nu: 0.3,
    yieldStrength: 250,
    tensileStrength: 400,
    elongation: 20,
    thermalConductivity: 50,
    specificHeat: 480,
    cte: 12e-6,
    maxServiceTemp: 400,
    emissivity: 0.3,
    weakPlaneStrength: 250,
    adjustments: [],
    ...over,
  };
}

/** Grid of size (nx, ny, nz) with voxels set to `fill(i, j, k)` (material index, 0 = empty). */
export function makeGrid(
  nx: number,
  ny: number,
  nz: number,
  h: number,
  fill: (i: number, j: number, k: number) => number,
  materials: string[] = ['test'],
): VoxelGrid {
  const cells = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) cells[i + nx * (j + ny * k)] = fill(i, j, k);
  return { nx, ny, nz, h, origin: [0, 0, 0], cells, materials };
}

/** Solid rectangular block L×B×T (mm) at voxel size h, origin at 0. */
export function blockGrid(L: number, B: number, T: number, h: number): VoxelGrid {
  return makeGrid(Math.round(L / h), Math.round(B / h), Math.round(T / h), h, () => 1);
}

/** Open-top box (enclosure base) W×D×H with wall thickness `wall` (mm). */
export function openBoxGrid(W: number, D: number, H: number, wall: number, h: number): VoxelGrid {
  const nx = Math.round(W / h);
  const ny = Math.round(D / h);
  const nz = Math.round(H / h);
  const w = Math.max(1, Math.round(wall / h));
  return makeGrid(nx, ny, nz, h, (i, j, k) => (k < w || i < w || j < w || i >= nx - w || j >= ny - w ? 1 : 0));
}
