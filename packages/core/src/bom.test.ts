import { describe, expect, it } from 'vitest';
import { buildBom, unitPrice } from './bom';
import { createBoard, createProject } from './factory';

describe('bom', () => {
  it('groups parts and prices by build quantity', () => {
    const p = createProject('x');
    p.settings.buildQuantity = 100;
    const b = createBoard('Main', 20, 20);
    p.boards.push(b);
    p.parts['C17414'] = {
      id: 'C17414', mpn: '0805W8F1002T5E', manufacturer: 'UNI-ROYAL', description: '10k', category: 'resistor', package: '0805', params: {},
      offers: [{ distributor: 'LCSC', sku: 'C17414', priceBreaks: [{ qty: 1, price: 0.01 }, { qty: 100, price: 0.002 }] }],
      pins: [], provenance: { specs: 'fetched', symbol: 'fetched', footprint: 'fetched', model3d: 'fetched', sim: 'generated', source: 'test' },
    };
    for (const ref of ['R1', 'R2', 'R3']) b.components.push({ id: ref, ref, partId: 'C17414', x: 0, y: 0, rotation: 0, side: 'top', placed: true, pinNets: {} });
    b.components.push({ id: 'R4', ref: 'R4', partId: 'C17414', x: 0, y: 0, rotation: 0, side: 'top', placed: true, pinNets: {}, dnp: true });
    const bom = buildBom(p);
    expect(bom.lines).toHaveLength(1);
    expect(bom.lines[0].qty).toBe(3);
    expect(bom.lines[0].refs).toEqual(['R1', 'R2', 'R3']);
    expect(unitPrice(p.parts['C17414'], 300).price).toBe(0.002);
    expect(bom.total).toBeCloseTo(0.006);
  });
});
