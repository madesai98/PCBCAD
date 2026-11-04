import { beforeAll, describe, expect, it } from 'vitest';
import type { CustomPart, EnclosureShell, MeshData, SheetMetalPart } from '@pcbcad/core';
import { createProject } from '@pcbcad/core';
import { buildPartMesh, initGeometry, massProperties, voxelizeForStructural, voxelizeMesh, voxelizePart } from './index';

const count = (cells: Uint8Array, v?: number) => cells.reduce((n, c) => n + (v === undefined ? (c ? 1 : 0) : c === v ? 1 : 0), 0);

const shell: EnclosureShell = {
  id: 'shell',
  name: 'Shell',
  kind: 'enclosure-shell',
  role: 'base',
  materialId: 'pc-abs',
  process: 'injection-molding',
  outer: { width: 80, depth: 50, height: 25 },
  wall: 2.5,
  cornerRadius: 5,
  draftDeg: 1,
  bosses: [{ id: 'b', x: 20, y: 10, outerDiameter: 8, holeDiameter: 3.5, height: 8, kind: 'insert' }],
  ribs: [{ id: 'r', from: [-30, 0], to: [10, 0], height: 6, thickness: 1.5 }],
  cutouts: [{ id: 'c', face: '+x', shape: 'rect', u: 0, v: 12, width: 12, height: 6 }],
  vents: [],
  snaps: [],
};

const bracket: SheetMetalPart = {
  id: 'br',
  name: 'Bracket',
  kind: 'sheet-metal',
  materialId: 'spcc',
  process: 'sheet-metal',
  thickness: 1.5,
  bendRadius: 1.5,
  kFactor: 0.44,
  base: { width: 40, length: 30 },
  holes: [{ id: 'h', x: 0, y: 0, shape: 'circle', diameter: 6 }],
  flanges: [{ id: 'f', edge: '+x', length: 25, angle: 90 }],
};

let shellMesh: MeshData;
beforeAll(async () => {
  await initGeometry();
  shellMesh = await buildPartMesh(shell);
});

describe('voxelizeMesh', () => {
  it('voxel volume is within 5 % of the mesh volume', () => {
    const exact = massProperties(shellMesh, 1).volumeMm3;
    const h = 0.5;
    const g = voxelizeMesh(shellMesh, h, { materialId: 'pc-abs' });
    expect(g.materials).toEqual(['pc-abs']);
    expect(g.cells.length).toBe(g.nx * g.ny * g.nz);
    const v = count(g.cells) * h ** 3;
    expect(Math.abs(v / exact - 1)).toBeLessThan(0.05);
  });

  it('pads the grid and honours materialIndex', () => {
    const g = voxelizeMesh(shellMesh, 1, { padding: 2, materialIndex: 3, materialId: 'x' });
    expect(g.materials[2]).toBe('x');
    expect(count(g.cells, 3)).toBe(count(g.cells));
    // two empty layers below the part
    for (let q = 0; q < g.nx * g.ny * 2; q++) expect(g.cells[q]).toBe(0);
    expect(g.origin[2]).toBeLessThan(-1.9);
  });

  it('is robust to overlapping closed shells (union semantics)', async () => {
    const two: CustomPart = { id: 'u', name: 'u', kind: 'custom', materialId: 'abs', process: 'cnc-machining', csg: { shape: 'box', size: [10, 10, 10] } };
    const a = await buildPartMesh(two);
    // duplicate the same closed mesh twice in one MeshData (overlap) → still one solid
    const both: MeshData = { groups: [a.groups[0], a.groups[0]] };
    const g = voxelizeMesh(both, 1, { padding: 0 });
    expect(count(g.cells)).toBe(1000);
  });
});

describe('voxelizePart / structural', () => {
  it('voxelizePart agrees with the mesh volume', async () => {
    const h = 0.5;
    const g = await voxelizePart(shell, h);
    const v = count(g.cells) * h ** 3;
    expect(Math.abs(v / massProperties(shellMesh, 1).volumeMm3 - 1)).toBeLessThan(0.05);
    const sg = await voxelizePart(bracket, 0.3);
    const sv = count(sg.cells) * 0.3 ** 3;
    expect(Math.abs(sv / massProperties(await buildPartMesh(bracket), 1).volumeMm3 - 1)).toBeLessThan(0.08);
    expect(sg.materials).toEqual(['spcc']);
  });

  it('voxelizeForStructural places several parts by their assembly instances', async () => {
    const project = createProject('s');
    project.mechanical.push(shell, bracket);
    project.assembly.instances.push(
      { id: 'i1', name: 'shell', target: { kind: 'mech', partId: 'shell' }, transform: { position: [0, 0, 0], rotation: [0, 0, 0] } },
      { id: 'i2', name: 'bracket', target: { kind: 'mech', partId: 'br' }, transform: { position: [0, 0, 26], rotation: [0, 0, 0] } },
    );
    const { grid, materials, warnings } = await voxelizeForStructural(project, ['shell', 'br'], 1);
    expect(materials.map((m) => m.materialId)).toEqual(['pc-abs', 'spcc']);
    expect(materials[0].process).toBe('injection-molding');
    expect(grid.tagNames).toEqual(['shell', 'bracket']);
    expect(count(grid.cells, 1)).toBeGreaterThan(0);
    expect(count(grid.cells, 2)).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
    // overlapping placement is reported
    project.assembly.instances[1].transform.position = [0, 0, 2.5];
    const clash = await voxelizeForStructural(project, ['shell', 'br'], 1);
    expect(clash.warnings.join()).toMatch(/overlaps/);
    // single part: local frame
    const one = await voxelizeForStructural(project, ['br'], 1);
    expect(one.grid.tagNames).toEqual(['Bracket']);
    await expect(voxelizeForStructural(project, ['nope'], 1)).rejects.toThrow(/unknown/);
  });
});
