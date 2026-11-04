/**
 * Live integration test against JLCPCB / LCSC / EasyEDA. Skipped unless PCBCAD_NET_TESTS=1:
 *   PCBCAD_NET_TESTS=1 npx vitest run packages/parts/src/pipeline/net.test.ts
 */
import { describe, expect, it } from 'vitest';
import { importPart } from './import';
import { searchParts } from './search';

const NET = process.env.PCBCAD_NET_TESTS === '1';
const T = 90_000;

describe.skipIf(!NET)('live parts pipeline (PCBCAD_NET_TESTS=1)', () => {
  it(
    'imports C92489 (Bosch BME280, LGA-8) with symbol, footprint, mesh and offers',
    async () => {
      const r = await importPart('C92489');
      const p = r.part;
      expect(p.id).toBe('C92489');
      expect(p.mpn).toBe('BME280');
      expect(p.category).toBe('sensor');
      expect(p.pins).toHaveLength(8);
      expect(p.pins.find((x) => x.number === '8')?.name).toMatch(/VDD/);
      expect(p.footprint?.pads).toHaveLength(8);
      expect(p.provenance.footprint).toBe('fetched');
      expect(p.model3d?.kind).toBe('mesh');
      expect(r.meshes[0]?.assetId).toBe('mesh_C92489');
      const lcsc = p.offers.find((o) => o.distributor === 'LCSC');
      expect(lcsc?.priceBreaks?.length).toBeGreaterThan(0);
      expect(p.offers.some((o) => o.distributor === 'JLCPCB')).toBe(true);
      expect(p.datasheetUrl).toMatch(/^https?:\/\//);
      expect(p.sim?.kind).toBe('ic');
      expect(p.provenance.attribution).toContain('EasyEDA');
    },
    T,
  );

  it(
    'imports C6186 (AMS1117-3.3, SOT-223) with an LDO sim model and thermal data',
    async () => {
      const r = await importPart('C6186');
      const p = r.part;
      expect(p.mpn).toMatch(/AMS1117-3\.3/);
      expect(p.category).toBe('ldo');
      expect(p.footprint?.pads).toHaveLength(4);
      expect(p.sim).toMatchObject({ kind: 'ldo', Vout: 3.3 });
      expect(p.thermal?.thetaJA).toBeGreaterThan(0);
      expect(p.model3d).toBeDefined();
      expect(p.offers.find((o) => o.distributor === 'LCSC')?.stock).toBeGreaterThan(0);
    },
    T,
  );

  it(
    'searches ATMEGA328P-AU and ranks C14877 first',
    async () => {
      const hits = await searchParts('ATMEGA328P-AU');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].lcsc).toBe('C14877');
      expect(hits[0].mpn).toBe('ATMEGA328P-AU');
      expect(hits[0].source).toBe('JLCPCB');
      expect(hits[0].priceBreaks.length).toBeGreaterThan(0);
    },
    T,
  );

  it(
    'imports C14877 (ATmega328P-AU) with the emulator sim model and a mesh aligned to pin 1',
    async () => {
      const r = await importPart('C14877');
      const p = r.part;
      expect(p.pins).toHaveLength(32);
      expect(p.sim?.kind).toBe('mcu');
      expect(p.model3d?.kind).toBe('mesh');
      const bbox = r.meshes[0]?.mesh.bbox;
      expect(bbox).toBeDefined();
      if (bbox) {
        // 7×7 mm body + leads ≈ 9 mm square, bottom on the board
        expect(bbox.max[0] - bbox.min[0]).toBeCloseTo(9, 0);
        expect(bbox.max[1] - bbox.min[1]).toBeCloseTo(9, 0);
        expect(Math.abs(bbox.min[2])).toBeLessThan(0.05);
      }
    },
    T,
  );
});
