import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toFloat32, toNumbers } from '@pcbcad/core';
import type { MeshData } from '@pcbcad/core';
import { convertEasyEdaComponent, EASYEDA_ATTRIBUTION } from './easyeda';
import { isJlcPlaceholder, normalisePriceBreaks, parseJlcSearch } from './jlc';
import { parseLcscDetail } from './lcsc';
import { parseMouserSearch, parsePriceString } from './mouser';
import { parseEasyEdaObj, rotationMatrix } from './obj';
import { svgArcToCenter, svgPathToPolylines } from './svgpath';

const fx = (name: string): string => readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf8');
const fxJson = (name: string): unknown => JSON.parse(fx(name));

function meshBounds(mesh: MeshData): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const g of mesh.groups) {
    const p = toFloat32(g.positions);
    for (let i = 0; i < p.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], p[i + c]);
        max[c] = Math.max(max[c], p[i + c]);
      }
    }
  }
  return { min, max };
}

describe('parseJlcSearch', () => {
  const hits = parseJlcSearch(fxJson('jlc_search_bme280.json'));
  it('parses every list item', () => {
    expect(hits).toHaveLength(5);
  });
  it('maps the BME280 hit', () => {
    const h = hits[0];
    expect(h).toMatchObject({
      lcsc: 'C92489',
      mpn: 'BME280',
      manufacturer: 'Bosch Sensortec',
      package: 'LGA-8(2.5x2.5)',
      category: 'sensor',
      stock: 3067,
      libraryType: 'extended',
      currency: 'USD',
      source: 'JLCPCB',
    });
    expect(h.attributes['Voltage - Supply']).toBe('1.71V~3.6V');
    expect(h.attributes['Interface']).toBe('I2C、SPI');
    expect(h.datasheetUrl).toMatch(/^https:\/\/www\.lcsc\.com\/datasheet\/.*C92489\.pdf$/);
    expect(h.url).toContain('C92489');
    expect(h.description).not.toMatch(/ROHS$/);
    // ladder 1/10/30/100 (102/104 repeat the 100+ price and are merged)
    expect(h.priceBreaks.map((b) => b.qty)).toEqual([1, 10, 30, 100]);
    expect(h.priceBreaks[0].price).toBeCloseTo(8.2345, 4);
  });
  it('flags JLCPCB consigned-library placeholders', () => {
    expect(isJlcPlaceholder(hits[0])).toBe(false);
    expect(hits.slice(1).every(isJlcPlaceholder)).toBe(true);
  });
  it('tolerates junk input', () => {
    expect(parseJlcSearch(undefined)).toEqual([]);
    expect(parseJlcSearch({ data: { componentPageInfo: { list: [null, 3, { componentCode: '' }] } } })).toEqual([]);
  });
  it('normalises price ladders', () => {
    expect(normalisePriceBreaks([{ qty: 10, price: 1 }, { qty: 1, price: 2 }, { qty: 20, price: 1 }, { qty: 0, price: 5 }])).toEqual([
      { qty: 1, price: 2 },
      { qty: 10, price: 1 },
    ]);
  });
  it('parses the C2040 search (MCU, extended, many unrelated hits)', () => {
    const r = parseJlcSearch(fxJson('c2040_jlc.json'));
    const rp = r.find((h) => h.lcsc === 'C2040');
    expect(rp?.mpn).toBe('RP2040');
    expect(rp?.category).toBe('mcu');
    expect(r).toHaveLength(5);
  });
});

describe('parseLcscDetail', () => {
  const p = parseLcscDetail(fxJson('c2040_lcsc.json'));
  it('maps the C2040 product detail', () => {
    expect(p.id).toBe('C2040');
    expect(p.mpn).toBe('RP2040');
    expect(p.manufacturer).toBe('Raspberry Pi');
    expect(p.package).toBe('LQFN-56(7x7)');
    expect(p.category).toBe('mcu');
    expect(p.params?.['CPU Core']).toBe('ARM Cortex-M0+');
    expect(p.params?.['Program Memory Type']).toBe('External');
    expect(p.datasheetUrl).toContain('productCode=C2040');
    expect(p.imageUrl).toMatch(/C2040_front\.jpg$/);
    expect(p.massGrams).toBeCloseTo(0.18, 4);
    expect(p.ratings).toEqual({ tempMin: -20, tempMax: 85 });
  });
  it('builds an LCSC offer with USD price breaks', () => {
    const o = p.offers?.[0];
    expect(o).toMatchObject({ distributor: 'LCSC', sku: 'C2040', currency: 'USD', stock: 0, moq: 1 });
    expect(o?.url).toBe('https://www.lcsc.com/product-detail/C2040.html');
    expect(o?.priceBreaks?.map((b) => b.qty)).toEqual([1, 10, 30, 100, 500, 1000]);
    expect(o?.priceBreaks?.[0].price).toBeCloseTo(1.0969, 4);
  });
  it('returns {} for missing / invalid results', () => {
    expect(parseLcscDetail({ code: 200, result: null })).toEqual({});
    expect(parseLcscDetail('nope')).toEqual({});
  });
});

describe('convertEasyEdaComponent — RP2040 fixture', () => {
  const conv = convertEasyEdaComponent(fxJson('c2040_easyeda.json'));
  const fp = conv.footprint;
  it('reads 57 pins from the symbol with names and inferred types', () => {
    expect(conv.pins).toHaveLength(57);
    const pin = (n: string) => conv.pins.find((p) => p.number === n);
    expect(pin('1')?.name).toBe('IOVDD');
    expect(pin('1')?.type).toBe('power_in');
    expect(pin('2')?.name).toBe('GPIO0');
    expect(pin('2')?.type).toBe('bidirectional');
    expect(pin('45')?.name).toBe('VREG_VOUT');
    expect(pin('45')?.type).toBe('power_out');
    expect(pin('57')?.name).toBe('GND');
    expect(pin('2')?.side).toBe('right');
    expect(pin('56')?.side).toBe('left');
  });
  it('converts 57 pads (56 + exposed pad 3.1 mm) in mm with Y up', () => {
    expect(fp.pads).toHaveLength(57);
    expect(fp.source).toBe('fetched');
    expect(fp.name).toBe('LQFN-56_L7.0-W7.0-P0.4-EP');
    const ep = fp.pads.find((p) => p.number === '57');
    expect(ep?.w).toBeCloseTo(3.1, 2);
    expect(ep?.h).toBeCloseTo(3.1, 2);
    expect(ep?.x).toBeCloseTo(0, 3);
    expect(ep?.y).toBeCloseTo(0, 3);
    const p1 = fp.pads.find((p) => p.number === '1');
    // pin 1: left column, top (Y flipped from the canvas)
    expect(p1?.x).toBeCloseTo(-3.425, 2);
    expect(p1?.y).toBeCloseTo(2.6, 3);
    expect(p1?.w).toBeCloseTo(0.85, 2);
    expect(p1?.h).toBeCloseTo(0.2, 2);
    expect(p1?.kind).toBe('smd');
    // pin 14 at the bottom of the left column, pin 43 on the top row (rotated 270°)
    expect(fp.pads.find((p) => p.number === '14')?.y).toBeCloseTo(-2.6, 3);
    const p43 = fp.pads.find((p) => p.number === '43');
    expect(p43?.y).toBeCloseTo(3.425, 2);
    expect(Math.abs(p43?.rotation ?? 0)).toBe(90);
    // pad array centred on the footprint origin
    const xs = fp.pads.map((p) => p.x);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(0, 3);
  });
  it('keeps silk / fab graphics and a courtyard around pads and body', () => {
    expect(fp.graphics.some((g) => g.layer === 'silk')).toBe(true);
    expect(fp.graphics.some((g) => g.layer === 'fab')).toBe(true);
    expect(fp.courtyard.minX).toBeLessThan(-3.85);
    expect(fp.courtyard.maxY).toBeGreaterThan(3.85);
  });
  it('extracts the 3D model reference and metadata', () => {
    expect(conv.model3d?.uuid).toBe('76b360a9d4c54384a4e47d7e5af156df');
    expect(conv.model3d?.offset[0]).toBeCloseTo(0, 3);
    expect(conv.model3d?.offset[1]).toBeCloseTo(0, 3);
    expect(conv.model3d?.rotation).toEqual([0, 0, 0]);
    expect(conv.info.lcsc).toBe('C2040');
    expect(conv.info.mpn).toBe('RP2040');
    expect(conv.info.package).toBe('LQFN-56_L7.0-W7.0-P0.4-EP');
    expect(EASYEDA_ATTRIBUTION).toContain('easyeda.com');
  });
});

describe('convertEasyEdaComponent — other library records', () => {
  it('USB-C: polygon pads, slotted THT shell legs, NPTH locating holes', () => {
    const c = convertEasyEdaComponent(fxJson('c165948_easyeda.json'));
    const pads = c.footprint.pads;
    const gnd = pads.find((p) => p.number === 'A1B12');
    expect(gnd?.shape).toBe('polygon');
    expect(gnd?.polygon?.length).toBeGreaterThanOrEqual(4);
    expect(gnd?.w).toBeCloseTo(0.6, 2);
    expect(gnd?.x).toBeCloseTo(-3.2, 2);
    const shell = pads.filter((p) => ['1', '2', '3', '4'].includes(p.number));
    expect(shell).toHaveLength(4);
    for (const s of shell) {
      expect(s.kind).toBe('tht');
      expect(s.drill).toBeCloseTo(0.8, 2);
      expect(s.slot?.w).toBeCloseTo(0.8, 2);
      expect(s.slot?.h).toBeGreaterThan(1.1);
    }
    const holes = pads.filter((p) => p.kind === 'npth');
    expect(holes).toHaveLength(2);
    expect(holes[0].drill).toBeCloseTo(0.6, 2);
    expect(c.model3d?.offset[1]).toBeCloseTo(-1.1, 2);
    expect(c.model3d?.offset[2]).toBeCloseTo(-0.85, 2);
    expect(c.pins.find((p) => p.number === 'A5')?.name).toBe('CC1');
  });
  it('micro-USB: slot direction from the slot outline', () => {
    const c = convertEasyEdaComponent(fxJson('c10418_easyeda.json'));
    const sh = c.footprint.pads.find((p) => p.number === 'SH1');
    expect(sh?.slot).toBeDefined();
    expect(sh?.slot?.h).toBeCloseTo(1.3, 2);
    expect(sh?.slot?.w).toBeCloseTo(0.5, 2);
  });
  it('ATmega328P: packed alternate-function pin names, arcs, rotated model', () => {
    const c = convertEasyEdaComponent(fxJson('c14877_easyeda.json'));
    expect(c.pins).toHaveLength(32);
    const p1 = c.pins.find((p) => p.number === '1');
    expect(p1?.name).toBe('(PCINT19/OC2B/INT1)PD3');
    expect(p1?.functions).toContain('PD3');
    expect(c.footprint.pads.find((p) => p.number === '1')?.y).toBeLessThan(-4); // library draws pin 1 on the bottom row
    expect(c.model3d?.rotation).toEqual([0, 0, 90]);
    expect(c.footprint.graphics.some((g) => g.kind === 'circle' || g.kind === 'arc')).toBe(true);
  });
  it('JST PH (THT): plated holes and a model below the board surface', () => {
    const c = convertEasyEdaComponent(fxJson('c131334_easyeda.json'));
    expect(c.footprint.pads.every((p) => p.kind === 'tht' && p.drill && p.drill > 0.9)).toBe(true);
    expect(c.model3d?.offset[2]).toBeCloseTo(-3, 3);
    expect(c.model3d?.rotation).toEqual([0, 0, 180]);
  });
  it('never throws on bad input', () => {
    const c = convertEasyEdaComponent({ success: false, message: 'not found' });
    expect(c.pins).toEqual([]);
    expect(c.footprint.pads).toEqual([]);
    expect(c.footprint.source).toBe('missing');
    expect(c.warnings[0]).toContain('not found');
    expect(convertEasyEdaComponent(null).warnings.length).toBeGreaterThan(0);
  });
});

describe('parseEasyEdaObj', () => {
  it('groups by material colour and packs positions / indices', () => {
    const mesh = parseEasyEdaObj(fx('c2040_model.obj'));
    expect(mesh.groups).toHaveLength(4);
    const colors = mesh.groups.map((g) => g.color).sort();
    expect(colors).toEqual(['#000000', '#404040', '#ffff00', '#ffffff']);
    const tris = mesh.groups.reduce((n, g) => n + toNumbers(g.indices).length / 3, 0);
    expect(tris).toBe(5062);
    expect(mesh.groups.find((g) => g.color === '#ffff00')?.metal).toBe(true);
    expect(mesh.groups.find((g) => g.color === '#ffffff')?.metal).toBe(true);
    expect(mesh.groups.find((g) => g.color === '#404040')?.metal).toBeUndefined();
    expect(mesh.bbox?.max[0]).toBeCloseTo(3.51, 3);
  });
  it('RP2040: placed mesh is centred on the pad array with its bottom on the board', () => {
    const conv = convertEasyEdaComponent(fxJson('c2040_easyeda.json'));
    const mesh = parseEasyEdaObj(fx('c2040_model.obj'), conv.model3d);
    const b = meshBounds(mesh);
    const pads = conv.footprint.pads;
    const cx = (Math.min(...pads.map((p) => p.x)) + Math.max(...pads.map((p) => p.x))) / 2;
    const cy = (Math.min(...pads.map((p) => p.y)) + Math.max(...pads.map((p) => p.y))) / 2;
    expect(Math.abs((b.min[0] + b.max[0]) / 2 - cx)).toBeLessThan(0.1);
    expect(Math.abs((b.min[1] + b.max[1]) / 2 - cy)).toBeLessThan(0.1);
    expect(Math.abs(b.min[2])).toBeLessThan(0.02);
    expect(b.max[2]).toBeCloseTo(0.87, 2);
    expect(mesh.bbox?.min[2]).toBeCloseTo(0, 3);
  });
  it('JST PH: 180° rotation puts pin 1 on the footprint pin 1 and the pins through the board', () => {
    const conv = convertEasyEdaComponent(fxJson('c131334_easyeda.json'));
    const mesh = parseEasyEdaObj(fx('c131334_model.obj'), conv.model3d);
    const b = meshBounds(mesh);
    expect(b.min[2]).toBeCloseTo(-3, 2);
    expect(b.max[2]).toBeCloseTo(6, 2);
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(0, 2);
    expect((b.min[1] + b.max[1]) / 2).toBeCloseTo(0.65, 2);
    // the housing (white) spans the 4 pins along X
    expect(b.max[0] - b.min[0]).toBeCloseTo(9.9, 1);
  });
  it('rotation is counter-clockwise about Z (applied X → Y → Z)', () => {
    const obj = ['newmtl a', 'Kd 1 0 0', 'd 0.0', 'endmtl', 'v 2 1 0', 'v 3 1 0', 'v 3 2 1', 'usemtl a', 'f 1 2 3'].join('\n');
    const raw = parseEasyEdaObj(obj);
    expect(raw.bbox?.min).toEqual([2, 1, 0]);
    const m = parseEasyEdaObj(obj, { rotation: [0, 0, 90], offset: [10, 0, 0.5] });
    // centred on (10, 0), bottom at z = 0.5; a +X extent of 1 becomes a +Y extent of 1
    expect(m.bbox?.min[2]).toBeCloseTo(0.5, 6);
    expect((m.bbox!.min[0] + m.bbox!.max[0]) / 2).toBeCloseTo(10, 6);
    expect(m.bbox!.max[1] - m.bbox!.min[1]).toBeCloseTo(1, 6);
    const r = rotationMatrix([0, 0, 90]);
    expect(r[0] * 1 + r[1] * 0).toBeCloseTo(0, 9);
    expect(r[3] * 1 + r[4] * 0).toBeCloseTo(1, 9); // (1,0,0) → (0,1,0)
  });
  it('treats EasyEDA "d" as transparency and survives junk', () => {
    const obj = ['newmtl glass', 'Kd 0.9 0.9 1', 'd 0.6', 'endmtl', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 0 0 1', 'usemtl glass', 'f 1/1/1 2/2/2 3/3/3 4', 'f 1 2 99', 'garbage line'].join('\n');
    const m = parseEasyEdaObj(obj);
    expect(m.groups[0].opacity).toBeCloseTo(0.4, 3);
    expect(toNumbers(m.groups[0].indices).length).toBe(6); // quad → 2 triangles; out-of-range face dropped
    expect(parseEasyEdaObj('').groups).toEqual([]);
  });
});

describe('SVG path helpers', () => {
  it('converts a semicircle arc to centre parameters', () => {
    const a = svgArcToCenter(0, 0, 1, 1, 0, false, true, 2, 0);
    expect(a?.cx).toBeCloseTo(1, 9);
    expect(a?.cy).toBeCloseTo(0, 9);
    expect(Math.abs(a?.dtheta ?? 0)).toBeCloseTo(Math.PI, 9);
  });
  it('tessellates closed paths', () => {
    const p = svgPathToPolylines('M 0 0 L 10 0 L 10 10 Z M 20 20 h 5 v 5 h -5 z');
    expect(p).toHaveLength(2);
    expect(p[0].closed).toBe(true);
    expect(p[1].points[2]).toEqual([25, 25]);
  });
});

describe('parseMouserSearch', () => {
  const json = {
    Errors: [],
    SearchResults: {
      NumberOfResult: 1,
      Parts: [
        {
          MouserPartNumber: '262-BME280',
          ManufacturerPartNumber: 'BME280',
          Manufacturer: 'Bosch Sensortec',
          Description: 'Board Mount Humidity Sensors Humidity, pressure, temperature sensor',
          Category: 'Board Mount Humidity Sensors',
          DataSheetUrl: 'https://www.mouser.com/datasheet/2/783/BST-BME280-DS002-1509607.pdf',
          ImagePath: 'https://www.mouser.com/images/bosch/images/BME280.jpg',
          ProductDetailUrl: 'https://www.mouser.com/ProductDetail/Bosch-Sensortec/BME280?qs=abc',
          Availability: '12,345 In Stock',
          PriceBreaks: [
            { Quantity: 1, Price: '$6.48', Currency: 'USD' },
            { Quantity: 10, Price: '$5.83', Currency: 'USD' },
            { Quantity: 100, Price: '$1,234.00', Currency: 'USD' },
          ],
          ProductAttributes: [{ AttributeName: 'Packaging', AttributeValue: 'Cut Tape' }],
        },
        { MouserPartNumber: 'N/A', ManufacturerPartNumber: 'X' },
      ],
    },
  };
  it('maps hits with the SKU in the url and USD price breaks', () => {
    const hits = parseMouserSearch(json);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ lcsc: '', mpn: 'BME280', source: 'Mouser', stock: 12345, category: 'sensor', url: 'https://www.mouser.com/ProductDetail/262-BME280' });
    expect(hits[0].attributes['Mouser Part Number']).toBe('262-BME280');
    expect(hits[0].priceBreaks).toEqual([
      { qty: 1, price: 6.48 },
      { qty: 10, price: 5.83 },
      { qty: 100, price: 1234 },
    ]);
  });
  it('parses localised price strings', () => {
    expect(parsePriceString('$1,234.56')).toBeCloseTo(1234.56);
    expect(parsePriceString('0,12 €')).toBeCloseTo(0.12);
    expect(parsePriceString('n/a')).toBeUndefined();
  });
});
