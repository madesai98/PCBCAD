import { categorize } from '../infer/categorize';
import type { PartSearchHit } from '../types';
import { httpJson, type FetchLike } from '../util/fetch';
import { asArray, asNumber, asString, asText, getPath, isRecord } from '../util/json';
import { clean } from '../util/text';
import { normalisePriceBreaks } from './jlc';

/** Mouser Search API v1 keyword endpoint (API key required). */
export const MOUSER_SEARCH_URL = 'https://api.mouser.com/api/v1/search/keyword';

/** '$1,234.56' / '0,12 €' → number (undefined when unparseable). */
export function parsePriceString(s: string): number | undefined {
  const t = s.replace(/[^\d.,-]/g, '');
  if (!t) return undefined;
  // decimal comma when the last separator is a comma followed by 1–4 digits
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  let norm = t;
  if (lastComma > lastDot && /,\d{1,4}$/.test(t)) norm = t.replace(/\./g, '').replace(',', '.');
  else norm = t.replace(/,/g, '');
  const v = parseFloat(norm);
  return Number.isFinite(v) ? v : undefined;
}

/** Parse a Mouser keyword-search response. Only USD price breaks are kept. */
export function parseMouserSearch(json: unknown): PartSearchHit[] {
  const parts = asArray(getPath(json, 'SearchResults', 'Parts'));
  const out: PartSearchHit[] = [];
  for (const p of parts) {
    if (!isRecord(p)) continue;
    const sku = asText(p.MouserPartNumber);
    const mpn = asText(p.ManufacturerPartNumber);
    if (!sku || !mpn || /^N\/A$/i.test(sku)) continue;
    const description = clean(asString(p.Description));
    const attributes: Record<string, string> = { 'Mouser Part Number': sku };
    for (const a of asArray(p.ProductAttributes)) {
      const k = asText(getPath(a, 'AttributeName'));
      const v = asText(getPath(a, 'AttributeValue'));
      if (k && v && !(k in attributes)) attributes[k] = v;
    }
    const breaks = normalisePriceBreaks(
      asArray(p.PriceBreaks)
        .filter((b) => !asText(getPath(b, 'Currency')) || asString(getPath(b, 'Currency')).toUpperCase() === 'USD')
        .map((b) => ({ qty: asNumber(getPath(b, 'Quantity')) ?? NaN, price: parsePriceString(asString(getPath(b, 'Price'))) ?? NaN })),
    );
    const stock = asNumber(p.AvailabilityInStock) ?? asNumber(/^([\d,]+)/.exec(asString(p.Availability))?.[1]?.replace(/,/g, '')) ?? 0;
    const pkg = attributes['Package / Case'] ?? attributes['Package/Case'] ?? '';
    const hit: PartSearchHit = {
      lcsc: '',
      mpn: clean(mpn),
      manufacturer: clean(asString(p.Manufacturer)),
      package: pkg,
      description,
      category: categorize(asString(p.Category), '', description, mpn),
      stock,
      priceBreaks: breaks,
      currency: 'USD',
      url: `https://www.mouser.com/ProductDetail/${encodeURIComponent(sku)}`,
      attributes,
      source: 'Mouser',
    };
    const ds = asText(p.DataSheetUrl);
    if (ds) hit.datasheetUrl = ds;
    const img = asText(p.ImagePath);
    if (img) hit.imageUrl = img;
    out.push(hit);
  }
  return out;
}

/** Query Mouser (never throws). */
export async function mouserSearch(keyword: string, apiKey: string, opts: { records?: number; fetch?: FetchLike; timeoutMs?: number } = {}): Promise<{ ok: boolean; hits: PartSearchHit[]; error?: string }> {
  const r = await httpJson(`${MOUSER_SEARCH_URL}?apiKey=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ SearchByKeywordRequest: { keyword, records: Math.max(1, Math.min(50, opts.records ?? 10)), startingRecord: 0 } }),
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs,
  });
  if (!r.ok) return { ok: false, hits: [], error: r.error };
  const errs = asArray(getPath(r.json, 'Errors'))
    .map((e) => asText(getPath(e, 'Message')))
    .filter(Boolean);
  if (errs.length) return { ok: false, hits: [], error: `Mouser: ${errs.join('; ')}` };
  return { ok: true, hits: parseMouserSearch(r.json) };
}
