import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PartDef } from '@pcbcad/core';
import { BUILTIN_PARTS } from '../catalog/builtin';
import { FASTENERS } from '../catalog/fasteners';
import { WIRING_PARTS } from '../catalog/wiring';
import { easyedaComponentUrl, EASYEDA_ATTRIBUTION } from '../sources/easyeda';
import { JLC_SEARCH_URL } from '../sources/jlc';
import { lcscDetailUrl } from '../sources/lcsc';
import type { FetchLike } from '../util/fetch';
import { ALL_CATALOG_PARTS, findCatalogPart, searchCatalog } from './catalog';
import { importPart, pickBestHit } from './import';
import { matchScore, searchParts } from './search';

const fx = (name: string): string => readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf8');

const EMPTY_JLC = JSON.stringify({ code: 200, data: { componentPageInfo: { total: 0, list: [] } } });

/** Fixture-backed fetch: routes the JLC search by keyword and the LCSC / EasyEDA endpoints by URL. */
function mockFetch(opts: { jlc?: Record<string, string>; urls?: Record<string, string>; calls?: string[] } = {}): FetchLike {
  const impl = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const url = String(input);
    opts.calls?.push(url);
    if (url === JLC_SEARCH_URL) {
      const kw = String(JSON.parse(String(init?.body ?? '{}')).keyword ?? '');
      return new Response(opts.jlc?.[kw] ?? EMPTY_JLC, { status: 200 });
    }
    const body = opts.urls?.[url];
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 });
  };
  return impl as FetchLike;
}

const failingFetch = (async () => {
  throw new TypeError('fetch failed: getaddrinfo ENOTFOUND');
}) as FetchLike;

const hangingFetch = ((_: unknown, init?: { signal?: AbortSignal }) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })) as FetchLike;

const C2040_URLS = {
  [lcscDetailUrl('C2040')]: fx('c2040_lcsc.json'),
  [easyedaComponentUrl('C2040')]: fx('c2040_easyeda.json'),
  'https://modules.easyeda.com/3dmodel/76b360a9d4c54384a4e47d7e5af156df': fx('c2040_model.obj'),
};

describe('searchParts', () => {
  it('drops JLCPCB placeholder entries and ranks the exact MPN first', async () => {
    const hits = await searchParts('BME280', { fetch: mockFetch({ jlc: { BME280: fx('jlc_search_bme280.json') } }) });
    expect(hits).toHaveLength(1);
    expect(hits[0].lcsc).toBe('C92489');
  });
  it('falls back to the offline catalog when the network is down', async () => {
    const hits = await searchParts('ATmega328P', { fetch: failingFetch });
    expect(hits[0].lcsc).toBe('C14877');
    expect(hits[0].source).toBe('builtin');
    const screws = await searchParts('ISO 7380 M3', { fetch: failingFetch, limit: 20 });
    expect(screws.map((h) => h.mpn)).toContain('ISO 7380-1 M3x8 A2-70');
  });
  it('scores exact codes / MPNs above prefix matches', () => {
    expect(matchScore({ lcsc: 'C92489', mpn: 'BME280' }, 'c92489')).toBeGreaterThan(matchScore({ lcsc: 'C1', mpn: 'BME280X' }, 'BME280'));
  });
});

describe('importPart (mocked sources)', () => {
  it('imports C2040 from the JLC, LCSC and EasyEDA fixtures with a placed mesh', async () => {
    const calls: string[] = [];
    const r = await importPart('C2040', { fetch: mockFetch({ jlc: { C2040: fx('c2040_jlc.json') }, urls: C2040_URLS, calls }) });
    const p = r.part;
    expect(p.id).toBe('C2040');
    expect(p.mpn).toBe('RP2040');
    expect(p.category).toBe('mcu');
    expect(p.pins).toHaveLength(57);
    expect(p.pins.find((x) => x.number === '1')?.name).toBe('IOVDD');
    expect(p.footprint?.pads).toHaveLength(57);
    expect(p.footprint?.source).toBe('fetched');
    expect(p.provenance.footprint).toBe('fetched');
    expect(p.provenance.attribution).toBe(EASYEDA_ATTRIBUTION);
    expect(p.model3d?.kind).toBe('mesh');
    expect(p.model3d?.meshAssetId).toBe('mesh_C2040');
    expect(r.meshes.map((m) => m.assetId)).toEqual(['mesh_C2040']);
    expect(r.meshes[0].mesh.groups.length).toBeGreaterThan(0);
    // RP2040 simulates through the emulator (builtin overlay)
    expect(p.sim?.kind).toBe('mcu');
    // LCSC + JLCPCB offers with live price ladders
    const lcsc = p.offers.find((o) => o.distributor === 'LCSC');
    expect(lcsc?.priceBreaks?.length).toBeGreaterThan(0);
    expect(p.offers.some((o) => o.distributor === 'JLCPCB')).toBe(true);
    expect(p.datasheetUrl).toBeTruthy();
    expect(p.thermal?.thetaJA).toBeGreaterThan(0);
    expect(calls.some((u) => u.includes('3dmodel'))).toBe(true);
    expect(r.log.join('\n')).toContain('EasyEDA ok');
  });
  it('resolves an MPN through the JLC search, skipping placeholder hits', async () => {
    const r = await importPart('BME280', { fetch: mockFetch({ jlc: { BME280: fx('jlc_search_bme280.json') } }) });
    expect(r.part.id).toBe('C92489');
    expect(r.log[0]).toContain('C92489');
    expect(r.part.manufacturer).toBe('Bosch Sensortec');
    expect(r.part.footprint?.pads).toHaveLength(8);
    expect(r.part.pins.find((p) => p.number === '8')?.name).toBe('VDD');
  });
  it('falls back to the builtin catalog when every source is unreachable', async () => {
    const r = await importPart('C6186', { fetch: failingFetch });
    expect(r.part.id).toBe('C6186');
    expect(r.part.provenance.specs).toBe('builtin');
    expect(r.log.join('\n')).toMatch(/catalog/i);
  });
  it('throws when nothing is reachable and the part is not in the catalog', async () => {
    await expect(importPart('C123456789', { fetch: failingFetch })).rejects.toThrow(/no source reachable/);
    await expect(importPart('', { fetch: failingFetch })).rejects.toThrow();
  });
  it('returns a needsAgent stub when the sources answer but do not know the part', async () => {
    const r = await importPart('C999999999', { fetch: mockFetch() });
    expect(r.part.provenance.footprint).toBe('missing');
    expect(r.needsAgent.map((n) => n.facet)).toEqual(expect.arrayContaining(['specs', 'pins', 'footprint']));
  });
  it('honours the per-request timeout', async () => {
    const t0 = Date.now();
    const r = await importPart('C14877', { fetch: hangingFetch, timeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.part.mpn).toBe('ATMEGA328P-AU');
  });
  it('serves catalog ids offline', async () => {
    const r = await importPart('fastener:iso7380-m3x8', { fetch: failingFetch });
    expect(r.part.fastener?.thread).toBe('M3');
    expect(r.part.fastener?.length).toBe(8);
  });
});

describe('catalogs', () => {
  const all: PartDef[] = ALL_CATALOG_PARTS;
  it('has unique ids', () => {
    const ids = all.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(all.length).toBe(BUILTIN_PARTS.length + FASTENERS.length + WIRING_PARTS.length);
  });
  it('builtin parts have pins, a footprint covering every pin and LCSC offers', () => {
    for (const p of BUILTIN_PARTS) {
      expect(p.pins.length, p.id).toBeGreaterThan(0);
      const pads = new Set((p.footprint?.pads ?? []).map((x) => x.number));
      for (const pin of p.pins) expect(pads.has(pin.number), `${p.id} pin ${pin.number}`).toBe(true);
      expect(p.offers.some((o) => o.distributor === 'LCSC' && o.sku === p.id), p.id).toBe(true);
      expect(p.provenance.specs, p.id).toBe('builtin');
      expect(p.model3d, p.id).toBeDefined();
    }
  });
  it('every fastener carries a FastenerSpec and a body', () => {
    for (const f of FASTENERS) {
      expect(f.category, f.id).toBe('fastener');
      expect(f.fastener, f.id).toBeDefined();
      expect(f.model3d, f.id).toBeDefined();
    }
  });
  it('exposes the demo fasteners by id', () => {
    const screw = findCatalogPart('fastener:iso7380-m3x8');
    expect(screw?.fastener).toMatchObject({ type: 'screw', head: 'button', thread: 'M3', length: 8 });
    const insert = findCatalogPart('fastener:insert-m3x5.7-od4.6');
    expect(insert?.fastener).toMatchObject({ type: 'heat-set-insert', thread: 'M3', materialId: 'brass' });
    expect(searchCatalog('heat-set insert M3', 50).some((h) => h.mpn.includes('M3'))).toBe(true);
  });
});
