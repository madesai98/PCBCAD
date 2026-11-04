import { beforeAll, describe, expect, it } from 'vitest';
import type { SheetMetalPart } from '@pcbcad/core';
import { bendAllowance, bendDeduction, buildPartMesh, buildSheetModel, exportDxf, flatPattern, initGeometry, massProperties, outsideSetback } from './index';

function sheet(extra: Partial<SheetMetalPart> = {}): SheetMetalPart {
  return {
    id: 'sm',
    name: 'Bracket',
    kind: 'sheet-metal',
    materialId: 'al-5052-h32',
    process: 'sheet-metal',
    thickness: 1.5,
    bendRadius: 1.5,
    kFactor: 0.44,
    base: { width: 50, length: 30 },
    holes: [],
    flanges: [],
    ...extra,
  };
}

beforeAll(async () => {
  await initGeometry();
});

describe('bend math', () => {
  it('BA, OSSB and BD follow the standard formulas', () => {
    expect(bendAllowance(90, 1.5, 1.5, 0.44)).toBeCloseTo((Math.PI / 2) * (1.5 + 0.44 * 1.5), 10);
    expect(outsideSetback(90, 1.5, 1.5)).toBeCloseTo(3, 10);
    expect(bendDeduction(90, 1.5, 1.5, 0.44)).toBeCloseTo(2 * 3 * Math.tan(Math.PI / 4) - bendAllowance(90, 1.5, 1.5, 0.44), 10);
    expect(outsideSetback(60, 1, 1)).toBeCloseTo(2 * Math.tan(Math.PI / 6), 10);
  });
});

describe('flat pattern', () => {
  it('L-bracket: flat length = a + b − BD = Σ straight + BA', () => {
    const a = 50, b = 20, t = 1.5, r = 1.5, k = 0.44;
    const p = sheet({ flanges: [{ id: 'f', edge: '+x', length: b, angle: 90 }] });
    const flat = flatPattern(p);
    const BD = 2 * (r + t) * Math.tan(Math.PI / 4) - (Math.PI / 180) * 90 * (r + k * t);
    expect(flat.size[0]).toBeCloseTo(a + b - BD, 9);
    expect(flat.size[1]).toBeCloseTo(30, 9);
    const sb = outsideSetback(90, r, t);
    expect(flat.size[0]).toBeCloseTo(a - sb + (b - sb) + bendAllowance(90, r, t, k), 9);
    expect(flat.bendLines).toHaveLength(1);
    const bl = flat.bendLines[0];
    expect(bl.direction).toBe('up');
    expect(bl.angle).toBe(90);
    expect(bl.radius).toBe(1.5);
    expect(bl.allowance).toBeCloseTo(bendAllowance(90, r, t, k), 12);
    // bend centre line at x = a/2 − OSSB + BA/2, spanning the full edge
    expect(bl.a[0]).toBeCloseTo(25 - sb + bl.allowance / 2, 9);
    expect(Math.abs(bl.a[1] - bl.b[1])).toBeCloseTo(30, 9);
    expect(flat.areaMm2).toBeCloseTo(flat.size[0] * 30, 6);
  });

  it('nested and negative flanges add their own allowances', () => {
    const p = sheet({ flanges: [{ id: 'f', edge: '+x', length: 20, angle: 90, flanges: [{ id: 'r', edge: 'far', length: 10, angle: 90 }] }] });
    const BD = bendDeduction(90, 1.5, 1.5, 0.44);
    expect(flatPattern(p).size[0]).toBeCloseTo(50 + 20 + 10 - 2 * BD, 9);
    const z = sheet({ flanges: [{ id: 'f', edge: '-y', length: 15, angle: -45 }] });
    const fz = flatPattern(z);
    expect(fz.size[1]).toBeCloseTo(30 + 15 - bendDeduction(45, 1.5, 1.5, 0.44), 9);
    expect(fz.bendLines[0].direction).toBe('down');
  });

  it('holes map onto the flat pattern (flange holes at v from the virtual sharp)', () => {
    const p = sheet({
      holes: [{ id: 'h0', x: 0, y: 0, shape: 'circle', diameter: 5 }],
      flanges: [{ id: 'f', edge: '+x', length: 20, angle: 90, holes: [{ id: 'h1', x: 4, y: 12, shape: 'circle', diameter: 3 }] }],
    });
    const flat = flatPattern(p);
    expect(flat.holes).toHaveLength(2);
    const c = flat.holeCircles.filter(Boolean) as { center: [number, number]; diameter: number }[];
    expect(c[0].center).toEqual([0, 0]);
    const sb = outsideSetback(90, 1.5, 1.5);
    const ba = bendAllowance(90, 1.5, 1.5, 0.44);
    expect(c[1].center[0]).toBeCloseTo(25 - sb + ba + (12 - sb), 9);
    expect(c[1].center[1]).toBeCloseTo(4, 9);
    expect(flat.areaMm2).toBeCloseTo(flat.size[0] * 30 - (Math.PI / 4) * (25 + 9), 0);
  });

  it('partial flanges get reliefs; adjacent flanges get corner notches', () => {
    const partial = sheet({ base: { width: 60, length: 40 }, flanges: [{ id: 'tab', edge: '+y', length: 12, angle: 90, width: 20, offset: 5 }] });
    const m = buildSheetModel(partial);
    expect(m.reliefCount).toBe(2);
    const flat = flatPattern(partial);
    // two relief slots notch the outline (rect: 4 extra vertices each beyond the tab)
    expect(flat.outline.length).toBeGreaterThan(8);
    const box = sheet({
      base: { width: 80, length: 50, cornerRadius: 3 },
      flanges: (['+x', '-x', '+y', '-y'] as const).map((e) => ({ id: e, edge: e, length: 15, angle: 90 })),
    });
    const bm = buildSheetModel(box);
    const base = bm.faces.find((f) => f.id === 'base')!;
    expect(base.removals.length).toBe(8); // 4 bend zones + 4 corner notches
    // flanges stop OSSB + gap short of the corners
    const fx = bm.faces.find((f) => f.id === '+x')!;
    const sb = outsideSetback(90, 1.5, 1.5);
    expect(fx.rect[1] - fx.rect[0]).toBeCloseTo(50 - 2 * (sb + bm.cornerGap), 9);
  });

  it('3D mesh: outer virtual-sharp dimensions and volume ≈ flat area × t for K = 0.5', async () => {
    const p = sheet({ kFactor: 0.5, flanges: [{ id: 'f', edge: '+x', length: 20, angle: 90 }, { id: 'g', edge: '-x', length: 12, angle: -90 }] });
    const m = await buildPartMesh(p);
    expect(m.bbox!.min[0]).toBeCloseTo(-25, 4);
    expect(m.bbox!.max[0]).toBeCloseTo(25, 4);
    expect(m.bbox!.max[2]).toBeCloseTo(20, 4);
    expect(m.bbox!.min[2]).toBeCloseTo(1.5 - 12, 4); // down flange measured from the top (outer) surface
    const flat = flatPattern(p);
    expect(massProperties(m, 2680).volumeMm3 / (flat.areaMm2 * 1.5)).toBeCloseTo(1, 2);
  });

  it('obround reliefs, nested returns and holes build a valid mesh', async () => {
    const p = sheet({
      base: { width: 80, length: 50, cornerRadius: 3 },
      reliefs: 'obround',
      holes: [{ id: 'h', x: 0, y: 0, shape: 'rect', width: 6, height: 3 }],
      flanges: [
        { id: 'a', edge: '+x', length: 20, angle: 90, flanges: [{ id: 'a2', edge: 'far', length: 8, angle: 90 }], holes: [{ id: 's', x: 0, y: 12, shape: 'slot', width: 8, height: 3 }] },
        { id: 'c', edge: '+y', length: 15, angle: -90, width: 30, offset: 5 },
        { id: 'd', edge: '-y', length: 20, angle: 120 },
      ],
    });
    const m = await buildPartMesh(p);
    const flat = flatPattern(p);
    expect(flat.bendLines).toHaveLength(4);
    expect(massProperties(m, 2680).volumeMm3).toBeGreaterThan(flat.areaMm2 * 1.5 * 0.97);
    expect(massProperties(m, 2680).volumeMm3).toBeLessThan(flat.areaMm2 * 1.5 * 1.03);
  });
});

describe('DXF export', () => {
  const p = sheet({
    holes: [
      { id: 'h0', x: 0, y: 0, shape: 'circle', diameter: 5 },
      { id: 'h1', x: 10, y: 5, shape: 'slot', width: 6, height: 2.5 },
    ],
    flanges: [{ id: 'f', edge: '+x', length: 20, angle: 90 }],
  });
  it('writes an R12 ASCII DXF with OUTLINE / HOLES / BEND layers', () => {
    const dxf = exportDxf(flatPattern(p));
    expect(dxf).toContain('AC1009');
    for (const layer of ['OUTLINE', 'HOLES', 'BEND']) expect(dxf).toMatch(new RegExp(`\\n  2\\n${layer}\\n`));
    expect(dxf.match(/\nLWPOLYLINE\n/g)?.length).toBe(2); // outline + slot
    expect(dxf.match(/\nCIRCLE\n/g)?.length).toBe(1);
    expect(dxf.match(/\nLINE\n/g)?.length).toBe(1);
    expect(dxf).toContain(`UP 90%%d R1.5 BA${bendAllowance(90, 1.5, 1.5, 0.44).toFixed(3)}`);
    expect(dxf).toMatch(/\nTEXT\n/);
    expect(dxf.trim().endsWith('EOF')).toBe(true);
    // group codes and values alternate
    const lines = dxf.trim().split('\n');
    expect(lines.length % 2).toBe(0);
  });
  it('strict R12 polylines on request', () => {
    const dxf = exportDxf(flatPattern(p), { polyline: 'r12' });
    expect(dxf).not.toContain('LWPOLYLINE');
    expect(dxf).toContain('\nPOLYLINE\n');
    expect(dxf).toContain('\nVERTEX\n');
    expect(dxf).toContain('\nSEQEND\n');
  });
});
