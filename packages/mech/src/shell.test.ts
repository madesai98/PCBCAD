import { beforeAll, describe, expect, it } from 'vitest';
import type { EnclosureShell, MeshData } from '@pcbcad/core';
import { isPacked, toFloat32 } from '@pcbcad/core';
import { buildPartMesh, initGeometry, massProperties, partSolid, compileSolid, solidContains, estimateSolidVolume, shellGeom, pocketAt } from './index';

function shell(extra: Partial<EnclosureShell> = {}): EnclosureShell {
  return {
    id: 'shell',
    name: 'Test shell',
    kind: 'enclosure-shell',
    role: 'base',
    materialId: 'pc-abs',
    process: 'injection-molding',
    outer: { width: 100, depth: 60, height: 30 },
    wall: 2,
    cornerRadius: 4,
    draftDeg: 0,
    bosses: [],
    ribs: [],
    cutouts: [],
    vents: [],
    snaps: [],
    ...extra,
  };
}

const rrArea = (w: number, d: number, r: number) => w * d - (4 - Math.PI) * r * r;
const vol = (m: MeshData) => massProperties(m, 1000).volumeMm3;

beforeAll(async () => {
  await initGeometry();
});

describe('enclosure shell geometry', () => {
  it('plain box shell volume matches the analytic value within 2 %', async () => {
    const m = await buildPartMesh(shell());
    const analytic = rrArea(100, 60, 4) * 30 - rrArea(96, 56, 2) * 28;
    expect(Math.abs(vol(m) / analytic - 1)).toBeLessThan(0.02);
    expect(m.bbox!.min).toEqual([-50, -30, 0]);
    expect(m.bbox!.max).toEqual([50, 30, 30]);
  });

  it('returns one indexed group with packed f32 positions, u32 indices, normals and the material colour', async () => {
    const m = await buildPartMesh(shell());
    expect(m.groups).toHaveLength(1);
    const g = m.groups[0];
    expect(isPacked(g.positions) && g.positions.dtype).toBe('f32');
    expect(g.indices && isPacked(g.indices) && g.indices.dtype).toBe('u32');
    expect(g.normals && isPacked(g.normals)).toBe(true);
    expect(g.color).toBe('#33363b'); // PC/ABS library colour
    expect(toFloat32(g.positions).length % 3).toBe(0);
    const coloured = await buildPartMesh(shell({ color: '#ff0000' }));
    expect(coloured.groups[0].color).toBe('#ff0000');
  });

  it('boss, cutout and vent change the volume by the expected amounts', async () => {
    const base = vol(await buildPartMesh(shell()));
    const boss = vol(await buildPartMesh(shell({ bosses: [{ id: 'b', x: 10, y: 5, outerDiameter: 8, holeDiameter: 4, height: 6, kind: 'insert' }] })));
    expect((boss - base) / ((Math.PI / 4) * (64 - 16) * 6)).toBeCloseTo(1, 1);
    const cut = vol(await buildPartMesh(shell({ cutouts: [{ id: 'c', face: '-y', shape: 'rect', u: 0, v: 15, width: 10, height: 5 }] })));
    expect((base - cut) / (10 * 5 * 2)).toBeCloseTo(1, 1);
    const vent = vol(await buildPartMesh(shell({ vents: [{ id: 'v', face: '+x', u: 0, v: 15, slotWidth: 1.5, slotLength: 8, count: 6, pitch: 3.5, orientation: 'v' }] })));
    const slot = (8 - 1.5) * 1.5 + (Math.PI * 1.5 * 1.5) / 4;
    expect((base - vent) / (6 * slot * 2)).toBeCloseTo(1, 1);
  });

  it('through-floor counterbored boss opens the floor; blind boss keeps it closed', async () => {
    const s = shell({
      bosses: [
        { id: 'through', x: -20, y: 0, outerDiameter: 9, holeDiameter: 3.4, height: 8, kind: 'clearance', throughFloor: true },
        { id: 'blind', x: 20, y: 0, outerDiameter: 8, holeDiameter: 4, height: 6, kind: 'insert' },
      ],
    });
    const node = compileSolid(partSolid(s)!);
    expect(solidContains(node, [-20, 0, 1])).toBe(false); // hole through the floor
    expect(solidContains(node, [-20 + 3.3, 0, 1])).toBe(false); // counterbore Ø6.8 from outside
    expect(solidContains(node, [-20 + 4.2, 0, 5])).toBe(true); // boss wall
    expect(solidContains(node, [20, 0, 1])).toBe(true); // floor under the blind boss
    expect(solidContains(node, [20, 0, 5])).toBe(false); // insert hole
    const m = await buildPartMesh(s);
    expect(vol(m)).toBeGreaterThan(0);
  });

  it('applies draft so walls stay uniform and the nominal outline is at the rim', async () => {
    const s = shell({ draftDeg: 2 });
    const m = await buildPartMesh(s);
    expect(m.bbox!.max[0]).toBeCloseTo(50, 5);
    const g = shellGeom(s);
    const atFloor = pocketAt(g, g.t);
    expect(atFloor.hx).toBeCloseTo(48 - Math.tan((2 * Math.PI) / 180) * 28, 6);
    expect(vol(m)).toBeLessThan(vol(await buildPartMesh(shell())));
    const node = compileSolid(partSolid(s)!);
    // outer surface at mid-height is inside the nominal outline
    expect(solidContains(node, [49.9, 0, 1])).toBe(false);
    expect(solidContains(node, [49.9, 0, 29.9])).toBe(true);
  });

  it('lip raises the rim; groove removes rim material', async () => {
    const lip = await buildPartMesh(shell({ lip: { kind: 'lip', height: 1.5, thickness: 0.8 } }));
    expect(lip.bbox!.max[2]).toBeCloseTo(31.5, 5);
    const plain = vol(await buildPartMesh(shell()));
    const groove = vol(await buildPartMesh(shell({ lip: { kind: 'groove', height: 1.6, thickness: 1 } })));
    expect(groove).toBeLessThan(plain);
    expect(vol(lip)).toBeGreaterThan(plain);
  });

  it('builds ribs, gussets, snaps and side cutouts; rim cutouts become notches', async () => {
    const s = shell({
      draftDeg: 1,
      processOptions: { innerFillet: 1 },
      lip: { kind: 'lip', height: 1.5, thickness: 0.8 },
      bosses: [{ id: 'b', x: 30, y: 10, outerDiameter: 8, holeDiameter: 4, height: 10, kind: 'insert', gussets: 4 }],
      ribs: [{ id: 'r', from: [-40, 0], to: [40, 0], height: 5, thickness: 1.2 }],
      cutouts: [{ id: 'notch', face: '-y', shape: 'rounded-rect', u: 10, v: 30, width: 10, height: 4, radius: 1 }],
      snaps: [
        { id: 'hook', face: '+x', u: 10, width: 6, length: 8, thickness: 1.2, overhang: 0.8, kind: 'hook' },
        { id: 'catch', face: '-x', u: 10, width: 6, length: 8, thickness: 1.2, overhang: 0.8, kind: 'catch' },
      ],
    });
    const m = await buildPartMesh(s);
    expect(m.bbox!.max[2]).toBeCloseTo(38, 5); // hook rises 8 mm above the rim
    const node = compileSolid(partSolid(s)!);
    expect(solidContains(node, [10, -29, 29.5])).toBe(false); // notch through the rim
    expect(solidContains(node, [0, 0, 4])).toBe(true); // rib
    expect(solidContains(node, [-49, 10, 22.5])).toBe(false); // catch window (v ∈ [21.7, 23.9])
    expect(solidContains(node, [48 - 0.6, 10, 37])).toBe(true); // beam
    expect(solidContains(node, [48.3, 10, 36.6])).toBe(true); // hook protrudes outward past the inner wall face
  });

  it('rejects impossible shells with a clear error', async () => {
    await expect(buildPartMesh(shell({ wall: 40 }))).rejects.toThrow(/no interior/);
    await expect(buildPartMesh(shell({ outer: { width: 0, depth: 10, height: 10 } }))).rejects.toThrow(/positive/);
  });

  it('analytic rasterised volume agrees with the mesh', async () => {
    const s = shell({ bosses: [{ id: 'b', x: 10, y: 5, outerDiameter: 8, holeDiameter: 4, height: 6, kind: 'insert' }] });
    const est = estimateSolidVolume(partSolid(s)!, 2_000_000).volume;
    expect(Math.abs(est / vol(await buildPartMesh(s)) - 1)).toBeLessThan(0.03);
  });
});
