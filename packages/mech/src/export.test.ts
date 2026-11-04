import { beforeAll, describe, expect, it } from 'vitest';
import type { CustomPart, FastenerSpec, PurchasedPart } from '@pcbcad/core';
import { toUint32 } from '@pcbcad/core';
import { buildPartMesh, export3mf, exportStl, fastenerMesh, fastenerPlacement, initGeometry, makeMesh, massProperties, triangleCount } from './index';

function custom(csg: CustomPart['csg']): CustomPart {
  return { id: 'c', name: 'Custom', kind: 'custom', materialId: 'abs', process: 'injection-molding', csg };
}

beforeAll(async () => {
  await initGeometry();
});

describe('mass properties', () => {
  it('unit cube: volume, mass, centroid, inertia', () => {
    // 10 mm cube from 0..10 as a triangle mesh
    const p = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10]);
    const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    const m = makeMesh(p, new Uint32Array(f), { color: '#888888' });
    const mp = massProperties(m, 1000);
    expect(mp.volumeMm3).toBeCloseTo(1000, 6);
    expect(mp.massGrams).toBeCloseTo(1, 9);
    expect(mp.centroid.map((v) => +v.toFixed(9))).toEqual([5, 5, 5]);
    expect(mp.areaMm2).toBeCloseTo(600, 6);
    // I = m (a² + a²) / 12 = 1 g · 200 / 12 mm²
    expect(mp.inertia[0]).toBeCloseTo(200 / 12, 6);
    expect(mp.inertia[3]).toBeCloseTo(0, 9);
  });

  it('custom CSG: box minus cylinder and a revolved ring', async () => {
    const part = custom({
      op: 'difference',
      children: [
        { shape: 'box', size: [20, 20, 10], center: true },
        { shape: 'cylinder', radius: 4, height: 12, center: true, segments: 128 },
      ],
    });
    const v = massProperties(await buildPartMesh(part), 1050).volumeMm3;
    expect(v / (4000 - Math.PI * 16 * 10)).toBeCloseTo(1, 2);
    const ring = custom({ shape: 'revolve', profile: [[3, 0], [5, 0], [5, 2], [3, 2]], segments: 128 });
    expect(massProperties(await buildPartMesh(ring), 1050).volumeMm3 / (Math.PI * (25 - 9) * 2)).toBeCloseTo(1, 2);
    const moved = custom({ shape: 'box', size: [2, 4, 6], transform: { position: [10, 0, 0], rotation: [0, 0, 90] } });
    const mb = await buildPartMesh(moved);
    expect(mb.bbox!.min[0]).toBeCloseTo(6, 5);
    expect(mb.bbox!.max[1]).toBeCloseTo(2, 5);
    const rounded = custom({ shape: 'box', size: [10, 10, 10], center: true, radius: 2 });
    const vr = massProperties(await buildPartMesh(rounded), 1).volumeMm3;
    // exact rounded-box volume: 1000 − (12·(4−π)·(10−4) + 8·(8 − 4/3·π)) for r = 2
    const exact = 1000 - (12 * (4 - Math.PI) * 4 * (10 - 4) / 4 + 8 * (8 - (4 / 3) * Math.PI * 8 / 8));
    expect(vr / exact).toBeCloseTo(1, 1);
  });

  it('purchased fan model and envelope', async () => {
    const fan: PurchasedPart = { id: 'fan', name: 'Fan 40', kind: 'purchased', materialId: 'pa66-gf30', process: 'purchased', partId: 'X', envelope: [40, 40, 10], fan: { maxFlowM3s: 0.003, maxPressurePa: 30, voltage: 5, current: 0.1 } };
    const m = await buildPartMesh(fan);
    expect(m.bbox!.max[2]).toBeCloseTo(10, 5);
    expect(massProperties(m, 1).volumeMm3).toBeLessThan(40 * 40 * 10 * 0.5);
    const box = await buildPartMesh({ ...fan, fan: undefined });
    expect(massProperties(box, 1).volumeMm3).toBeCloseTo(16000, 3);
  });
});

describe('STL / 3MF', () => {
  it('binary STL: header, triangle count, size', async () => {
    const m = await buildPartMesh(custom({ shape: 'box', size: [10, 10, 10] }));
    const stl = exportStl(m, 'cube');
    const n = triangleCount(m);
    expect(n).toBe(12);
    const header = new TextDecoder().decode(stl.slice(0, 80));
    expect(header.startsWith('PCBCAD STL: cube')).toBe(true);
    expect(header.startsWith('solid')).toBe(false);
    const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
    expect(dv.getUint32(80, true)).toBe(n);
    expect(stl.length).toBe(84 + 50 * n);
    // first triangle normal is unit length
    expect(Math.hypot(dv.getFloat32(84, true), dv.getFloat32(88, true), dv.getFloat32(92, true))).toBeCloseTo(1, 5);
  });

  it('3MF is a zip with the model, content types and relationships', async () => {
    const m = await buildPartMesh(custom({ shape: 'cylinder', radius: 5, height: 3 }));
    const zip = export3mf(m, 'disc');
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(zip);
    expect(text).toContain('[Content_Types].xml');
    expect(text).toContain('3D/3dmodel.model');
    expect(text).toContain('unit="millimeter"');
    expect(text).toMatch(/<triangle v1="\d+" v2="\d+" v3="\d+"\/>/);
  });
});

describe('fastener meshes', () => {
  const specs: FastenerSpec[] = [
    { type: 'screw', diameter: 3, length: 10, head: 'pan', materialId: 'steel-zinc' },
    { type: 'screw', diameter: 3, length: 10, head: 'socket', drive: 'hex', materialId: 'ss-a2' },
    { type: 'screw', diameter: 3, length: 10, head: 'flat', materialId: 'steel-zinc' },
    { type: 'screw', diameter: 3, length: 10, head: 'button', materialId: 'ss-a2' },
    { type: 'bolt', diameter: 4, length: 12, head: 'hex', materialId: 'steel-zinc' },
    { type: 'self-tapping-screw', diameter: 3, length: 10, materialId: 'steel-zinc' },
    { type: 'nut', diameter: 3, materialId: 'steel-zinc' },
    { type: 'washer', diameter: 3, materialId: 'steel-zinc' },
    { type: 'standoff', diameter: 3, length: 10, ends: 'male-female', materialId: 'brass' },
    { type: 'heat-set-insert', diameter: 3, materialId: 'brass' },
    { type: 'pem-nut', diameter: 3, materialId: 'steel-zinc' },
    { type: 'pem-standoff', diameter: 3, length: 8, materialId: 'steel-zinc' },
    { type: 'rivet', diameter: 3, length: 6, materialId: 'al-5052-h32' },
  ];
  it.each(specs.map((s) => [`${s.type}/${s.head ?? '-'}`, s] as const))('%s is closed with positive volume', (_n, spec) => {
    const m = fastenerMesh(spec);
    const mp = massProperties(m, 7850);
    expect(mp.volumeMm3).toBeGreaterThan(1);
    // closed: every directed edge has its reverse
    const e = new Map<string, number>();
    const g = m.groups[0];
    const idx = Array.from(toUint32(g.indices));
    for (let t = 0; t < idx.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const a = idx[t + k], b = idx[t + ((k + 1) % 3)];
        e.set(`${a},${b}`, (e.get(`${a},${b}`) ?? 0) + 1);
      }
    for (const [key, c] of e) {
      const [a, b] = key.split(',');
      expect(e.get(`${b},${a}`)).toBe(c);
    }
  });
  it('screw frame: head at z ≤ 0, shank to +length', () => {
    const m = fastenerMesh({ type: 'screw', diameter: 3, length: 8, head: 'pan', materialId: 'steel-zinc' });
    expect(m.bbox!.min[2]).toBeCloseTo(-1.8, 5);
    expect(m.bbox!.max[2]).toBeCloseTo(8, 5);
    expect(m.groups[0].metal).toBe(true);
  });
  it('placement maps +Z to the insertion direction (and centres nuts)', () => {
    const fi = { id: 'f', partId: 'p', position: [1, 2, 3] as [number, number, number], direction: [0, 0, -1] as [number, number, number], joins: [] };
    const m = fastenerPlacement(fi, { type: 'screw', diameter: 3, length: 8, materialId: 'steel-zinc' });
    expect([m[2], m[6], m[10]]).toEqual([0, 0, -1]);
    expect([m[3], m[7], m[11]]).toEqual([1, 2, 3]);
    const n = fastenerPlacement(fi, { type: 'nut', diameter: 3, length: 2.4, materialId: 'steel-zinc' });
    expect(n[11]).toBeCloseTo(3 + 1.2, 9);
  });
});
