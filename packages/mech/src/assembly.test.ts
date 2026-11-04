import { beforeAll, describe, expect, it } from 'vitest';
import type { DesignIssue, EnclosureShell, Project, PurchasedPart } from '@pcbcad/core';
import { autoEnclosure, buildPartMesh, checkAssembly, estimateCost, initGeometry, voxelizeAssemblyForAirflow } from './index';
import { boardProject, fastenerPart } from './__fixtures__/project';

const codes = (l: DesignIssue[]) => l.map((i) => i.code);
const serious = (l: DesignIssue[]) => l.filter((i) => i.severity !== 'info');

function withSpecs(project: Project): void {
  project.parts['M3x8'] = fastenerPart('M3x8', { type: 'screw', thread: 'M3', diameter: 3, length: 8, head: 'pan', materialId: 'steel-zinc' });
  project.parts['M3x14'] = fastenerPart('M3x14', { type: 'screw', thread: 'M3', diameter: 3, length: 14, head: 'pan', materialId: 'steel-zinc' });
  project.parts['INS3'] = fastenerPart('INS3', { type: 'heat-set-insert', thread: 'M3', diameter: 3, length: 5, outerDiameter: 4.6, holeDiameter: 4.0, materialId: 'brass' });
}

/** autoEnclosure applied to the fixture project. */
function enclosed(opts: Parameters<typeof autoEnclosure>[2] = {}) {
  const { project, boardId } = boardProject();
  withSpecs(project);
  const r = autoEnclosure(project, [boardId], { fastenerPartIds: { screw: 'M3x8', caseScrew: 'M3x14', insert: 'INS3' }, ...opts });
  project.mechanical.push(r.base, r.cover);
  project.assembly = { instances: r.instances, fasteners: r.fasteners };
  return { project, boardId, r };
}

beforeAll(async () => {
  await initGeometry();
});

describe('autoEnclosure', () => {
  it('encloses a 60×40 board with aligned bosses and a USB-C cutout and passes checkAssembly', () => {
    const { project, boardId, r } = enclosed();
    const board = project.boards[0];
    const inst = r.instances.find((i) => i.target.kind === 'board')!;
    // one boss per mounting hole, coaxial with the hole in the assembly
    for (const h of board.holes) {
      const x = h.x + inst.transform.position[0];
      const y = h.y + inst.transform.position[1];
      const b = r.base.bosses.find((b) => Math.hypot(b.x - x, b.y - y) < 1e-9);
      expect(b, `boss under ${h.id}`).toBeTruthy();
      expect(b!.kind).toBe('insert');
      // board bottom sits on the boss top
      expect(r.base.wall + b!.height).toBeCloseTo(inst.transform.position[2], 9);
    }
    // USB-C cutout linked to J1, centred on the connector, split across the parting plane
    const j1 = board.components.find((c) => c.ref === 'J1')!;
    const bc = r.base.cutouts.find((c) => c.linked?.componentId === j1.id)!;
    const cc = r.cover.cutouts.find((c) => c.linked?.componentId === j1.id)!;
    expect(bc.face).toBe('-y');
    expect(cc.face).toBe('+y'); // cover is rotated 180° about X
    expect(bc.u).toBeCloseTo(j1.x + inst.transform.position[0], 2);
    expect(bc.v).toBeCloseTo(inst.transform.position[2] + 1.6 + 1.63, 2);
    expect(bc.width).toBeGreaterThanOrEqual(9.2 + 0.3);
    expect(bc.v - bc.height / 2).toBeLessThan(r.base.outer.height);
    expect(cc.v - cc.height / 2).toBeLessThan(r.cover.outer.height);
    // lip / groove pair and corner case bosses
    expect(r.base.lip?.kind).toBe('lip');
    expect(r.cover.lip?.kind).toBe('groove');
    expect(r.cover.lip!.thickness).toBeGreaterThan(r.base.lip!.thickness);
    expect(r.cover.bosses.every((b) => b.throughFloor && b.kind === 'clearance')).toBe(true);
    expect(r.base.bosses.filter((b) => b.id.startsWith('case'))).toHaveLength(4);
    // cover sits on the base rim
    const cover = r.instances.find((i) => i.target.kind === 'mech' && i.target.partId === r.cover.id)!;
    expect(cover.transform.rotation).toEqual([180, 0, 0]);
    expect(cover.transform.position[2]).toBeCloseTo(r.base.outer.height + r.cover.outer.height, 9);
    expect(r.base.materialId).toBe('pc-abs');
    expect(r.base.wall).toBe(2);
    expect(r.base.draftDeg).toBe(1);
    // fasteners: 4 PCB screws + 4 case screws + 8 inserts, all resolved
    expect(r.fasteners).toHaveLength(16);
    expect(r.fasteners.every((f) => f.partId)).toBe(true);
    const issues = checkAssembly(project);
    expect(serious(issues)).toEqual([]);
    expect(r.notes.length).toBeGreaterThan(2);
  });

  it('leaves partId empty with a note when no fastener parts are given', () => {
    const { project, boardId } = boardProject();
    const r = autoEnclosure(project, [boardId]);
    expect(r.fasteners.every((f) => f.partId === '')).toBe(true);
    expect(r.notes.join('\n')).toMatch(/fastenerPartIds/);
    project.mechanical.push(r.base, r.cover);
    project.assembly = { instances: r.instances, fasteners: r.fasteners };
    const issues = checkAssembly(project);
    expect(serious(issues)).toEqual([]);
    expect(codes(issues)).toContain('fastener-spec-missing');
  });

  it('supports thread-forming bosses, custom walls and vent selection', () => {
    const { project, boardId } = boardProject();
    const r = autoEnclosure(project, [boardId], { insert: 'self-tapping', wall: 2.5, ventFaces: ['top', 'bottom'], materialId: 'abs' });
    expect(r.base.bosses.filter((b) => b.id.startsWith('pcb')).every((b) => b.kind === 'screw' && b.holeDiameter === 2.4)).toBe(true);
    expect(r.base.vents.map((v) => v.face)).toEqual(['floor']);
    expect(r.cover.vents.map((v) => v.face)).toEqual(['floor']);
    expect(r.base.wall).toBe(2.5);
    project.mechanical.push(r.base, r.cover);
    project.assembly = { instances: r.instances, fasteners: r.fasteners };
    expect(serious(checkAssembly(project))).toEqual([]);
  });

  it('stacks boards with matching hole patterns', () => {
    const { project, boardId } = boardProject();
    const top = structuredClone(project.boards[0]);
    top.id = 'brd_top';
    top.name = 'Top';
    top.components = [];
    project.boards.push(top);
    const r = autoEnclosure(project, [boardId, 'brd_top']);
    const zs = r.instances.filter((i) => i.target.kind === 'board').map((i) => i.transform.position[2]);
    expect(zs[1]).toBeGreaterThan(zs[0] + 5);
    expect(r.notes.join('\n')).toMatch(/stacked/);
    expect(r.fasteners.some((f) => f.note?.includes('standoff'))).toBe(true);
  });

  it('rejects unknown boards', () => {
    const { project } = boardProject();
    expect(() => autoEnclosure(project, ['nope'])).toThrow(/unknown board/);
  });
});

describe('checkAssembly', () => {
  it('flags a board colliding with a boss', () => {
    const { project } = enclosed();
    const inst = project.assembly.instances.find((i) => i.target.kind === 'board')!;
    inst.transform.position[2] -= 1; // board 1 mm into its bosses
    const issues = checkAssembly(project);
    const hit = issues.filter((i) => i.code === 'interference');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0].severity).toBe('error');
    expect(hit[0].target?.instanceIds).toContain(inst.id);
    expect(hit[0].message).toMatch(/mm³/);
    // ~4 bosses × annulus area × 1 mm
    const ov = Number(/: ([\d.]+) mm³/.exec(hit[0].message)![1]);
    expect(ov).toBeGreaterThan(100);
  });

  it('flags a misaligned connector cutout, an undersized one and a missing one', () => {
    const { project } = enclosed();
    const base = project.mechanical.find((p) => p.kind === 'enclosure-shell' && p.role === 'base') as EnclosureShell;
    const cover = project.mechanical.find((p) => p.kind === 'enclosure-shell' && p.role === 'cover') as EnclosureShell;
    base.cutouts[0].u += 2;
    cover.cutouts[0].u += 2;
    const mis = checkAssembly(project).filter((i) => i.code === 'connector-misaligned');
    expect(mis).toHaveLength(1);
    expect(mis[0].message).toMatch(/2 mm horizontally/);
    base.cutouts[0].u -= 2;
    cover.cutouts[0].u -= 2;
    base.cutouts[0].width = 9.3;
    cover.cutouts[0].width = 9.3;
    expect(codes(checkAssembly(project))).toContain('connector-cutout-small');
    base.cutouts = [];
    cover.cutouts = [];
    const blocked = checkAssembly(project);
    expect(codes(blocked)).toContain('connector-blocked');
    // the receptacle face sits flush with the inner wall: no body/wall interference
    expect(codes(blocked)).not.toContain('interference');
  });

  it('checks boss alignment, fasteners, clearances and screw lengths', () => {
    const { project } = enclosed();
    const base = project.mechanical.find((p) => p.kind === 'enclosure-shell' && p.role === 'base') as EnclosureShell;
    base.bosses[0].x += 0.6; // misaligned PCB boss
    const fa = project.assembly.fasteners;
    const pcbScrews = fa.filter((f) => f.partId === 'M3x8');
    pcbScrews[2].partId = 'M3x14'; // too long → bottoms out in the 7 mm boss
    fa.splice(fa.indexOf(pcbScrews[3]), 1); // drop one PCB screw
    const issues = checkAssembly(project);
    expect(codes(issues)).toContain('boss-misaligned');
    expect(codes(issues)).toContain('screw-bottoming');
    expect(codes(issues)).toContain('missing-fastener');
    expect(codes(issues)).toContain('boss-no-fastener');
    // short case screw → not enough engagement
    const { project: p2 } = enclosed();
    p2.parts['M3x10'] = fastenerPart('M3x10', { type: 'screw', thread: 'M3', diameter: 3, length: 10, head: 'pan', materialId: 'steel-zinc' });
    for (const f of p2.assembly.fasteners) if (f.partId === 'M3x14') f.partId = 'M3x10';
    expect(codes(checkAssembly(p2))).toContain('thread-engagement');
  });

  it('flags boards too close to walls and tall components', () => {
    const { project } = enclosed();
    const inst = project.assembly.instances.find((i) => i.target.kind === 'board')!;
    inst.transform.position[1] -= 1.5; // toward the tight USB-C wall
    expect(codes(checkAssembly(project))).toEqual(expect.arrayContaining(['board-outside-enclosure', 'interference']));
    inst.transform.position[1] += 0.8; // 0.7 mm toward the wall: inside, but < 0.5 mm clearance
    expect(codes(checkAssembly(project))).toContain('board-clearance');
    const { project: p2 } = enclosed();
    p2.parts['CAP'].body = { w: 6.6, l: 6.6, h: 9.6 }; // 1.9 mm taller than designed for
    const issues = checkAssembly(p2);
    expect(codes(issues)).toContain('component-clearance');
  });

  it('accepts external meshes for mechanical instances', async () => {
    const { project, r } = enclosed();
    const meshes = new Map([[r.base.id, await buildPartMesh(r.base, { project })]]);
    expect(serious(checkAssembly(project, { meshes }))).toEqual([]);
  });

  it('handles empty assemblies', () => {
    const { project } = boardProject();
    expect(codes(checkAssembly(project))).toEqual(['empty-assembly']);
  });
});

describe('voxelizeAssemblyForAirflow', () => {
  it('builds the enclosure air domain with openings, components and fans', async () => {
    const { project } = enclosed();
    const fan: PurchasedPart = { id: 'fan', name: 'Fan', kind: 'purchased', materialId: 'pa66-gf30', process: 'purchased', partId: 'F', envelope: [25, 25, 6], fan: { maxFlowM3s: 0.0015, maxPressurePa: 25, voltage: 5, current: 0.08 } };
    project.mechanical.push(fan);
    project.assembly.instances.push({ id: 'fan1', name: 'Fan', target: { kind: 'mech', partId: 'fan' }, transform: { position: [30, 0, 13], rotation: [0, 90, 0] } });
    const d = await voxelizeAssemblyForAirflow(project, { h: 1 });
    const g = d.grid;
    expect(g.h).toBe(1);
    expect(g.cells.length).toBe(g.nx * g.ny * g.nz);
    expect(d.materials.map((m) => m.materialId)).toEqual(expect.arrayContaining(['pc-abs', 'fr4', 'epoxy-mold', 'pa66-gf30']));
    expect(d.materials.length).toBe(g.materials.length);
    expect(d.openings[0].name).toBe('ambient');
    const names = d.openings.map((o) => o.name);
    expect(names.some((n) => n.endsWith('/conn1'))).toBe(true);
    expect(names.some((n) => n.includes('vent'))).toBe(true);
    for (const o of d.openings) expect(o.cells.length, o.name).toBeGreaterThan(0);
    for (const o of d.openings.slice(1)) for (const q of o.cells) expect(g.cells[q]).toBe(0);
    expect(d.componentCells.map((c) => c.ref).sort()).toEqual(['C1', 'J1', 'R1', 'U1']);
    for (const c of d.componentCells) {
      expect(c.cells.length).toBeGreaterThan(0);
      for (const q of c.cells) expect(d.materials[g.cells[q] - 1].materialId).toBe('epoxy-mold');
    }
    expect(d.fans).toHaveLength(1);
    expect(d.fans[0].direction[0]).toBeCloseTo(1, 6);
    expect(d.fans[0].cells.length).toBeGreaterThan(100);
    expect(d.inside.length).toBe(g.cells.length);
    // walls as the domain boundary
    const tight = await voxelizeAssemblyForAirflow(project, { h: 1, ambientLayer: false });
    expect(tight.grid.nx).toBe(g.nx - 2);
    expect(tight.openings.slice(1).every((o) => o.cells.length > 0)).toBe(true);
    // default resolution
    const d2 = await voxelizeAssemblyForAirflow(project);
    expect(d2.grid.h).toBeCloseTo(Math.max(1, 89 / 60), 0);
  });
});

describe('estimateCost', () => {
  it('molding cost: tooling grows with side actions; unit falls with quantity', () => {
    const { r } = enclosed();
    const c1 = estimateCost(r.cover, 1000);
    const c2 = estimateCost(r.cover, 100_000);
    expect(c1.toolingUsd).toBeGreaterThan(2000);
    expect(c2.toolingUsd).toBeGreaterThan(c1.toolingUsd); // steel tool for volume
    expect(c2.unitUsd).toBeLessThan(c1.unitUsd);
    const base = estimateCost(r.base, 10_000);
    const noSides = estimateCost({ ...r.base, vents: [] }, 10_000);
    expect(base.toolingUsd).toBeGreaterThan(noSides.toolingUsd);
    expect(base.notes.join('\n')).toMatch(/slide/);
  });
  it('sheet metal, printing and purchased parts', () => {
    const sm = estimateCost({ id: 's', name: 's', kind: 'sheet-metal', materialId: 'spcc', process: 'sheet-metal', thickness: 1, bendRadius: 1, kFactor: 0.44, base: { width: 100, length: 60 }, holes: [], flanges: [{ id: 'f', edge: '+x', length: 20, angle: 90 }], processOptions: { finish: 'powder-coat' } }, 100);
    expect(sm.toolingUsd).toBe(0);
    expect(sm.unitUsd).toBeGreaterThan(0.5);
    expect(sm.breakdown.finish).toBeGreaterThan(0);
    const pr = estimateCost({ id: 'c', name: 'c', kind: 'custom', materialId: 'pla', process: 'fdm-printing', csg: { shape: 'box', size: [20, 20, 20] } }, 10);
    expect(pr.unitUsd).toBeGreaterThan(3);
    const { project } = boardProject();
    project.parts['FAN'] = { ...project.parts['MCU'], id: 'FAN', offers: [{ distributor: 'LCSC', sku: 'x', priceBreaks: [{ qty: 1, price: 2.5 }, { qty: 100, price: 1.9 }] }] };
    const pp = estimateCost({ id: 'f', name: 'f', kind: 'purchased', materialId: 'abs', process: 'purchased', partId: 'FAN', envelope: [10, 10, 10] }, 500, { project });
    expect(pp.unitUsd).toBe(1.9);
  });
});
