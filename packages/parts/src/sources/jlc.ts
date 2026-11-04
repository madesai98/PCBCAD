import type { PriceBreak } from '@pcbcad/core';
import { categorize } from '../infer/categorize';
import type { PartSearchHit } from '../types';
import { httpJson, type FetchLike } from '../util/fetch';
import { asArray, asNumber, asString, asText, getPath, isRecord } from '../util/json';
import { clean } from '../util/text';

/** JLCPCB assembly parts search endpoint (POST JSON, no auth). */
export const JLC_SEARCH_URL = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';

/** Normalise a price ladder: sorted by quantity, consecutive equal prices merged. */
export function normalisePriceBreaks(breaks: PriceBreak[]): PriceBreak[] {
  const sorted = breaks.filter((b) => Number.isFinite(b.qty) && b.qty > 0 && Number.isFinite(b.price) && b.price >= 0).sort((a, b) => a.qty - b.qty);
  const out: PriceBreak[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && (last.qty === b.qty || Math.abs(last.price - b.price) < 1e-9)) continue;
    out.push({ qty: b.qty, price: b.price });
  }
  return out;
}

/** JLC 'componentLibraryType' → our library type. */
export function jlcLibraryType(type: string, preferred: boolean): PartSearchHit['libraryType'] {
  const t = type.toLowerCase();
  if (t === 'base' || t === 'basic') return 'basic';
  if (preferred || t === 'preferred') return 'preferred';
  if (t === 'expand' || t === 'extended') return 'extended';
  return undefined;
}

function parseItem(it: unknown): PartSearchHit | undefined {
  if (!isRecord(it)) return undefined;
  const lcsc = asText(it.componentCode);
  if (!lcsc) return undefined;
  const mpn = clean(asString(it.componentModelEn) || asString(it.componentName) || lcsc);
  const describe = clean(asString(it.describe)).replace(/\s+ROHS$/i, '');
  const attributes: Record<string, string> = {};
  for (const a of asArray(it.attributes)) {
    const k = asText(getPath(a, 'attribute_name_en'));
    const v = asText(getPath(a, 'attribute_value_name'));
    if (k && v) attributes[k] = v;
  }
  const priceBreaks = normalisePriceBreaks(
    asArray(it.componentPrices).map((p) => ({ qty: asNumber(getPath(p, 'startNumber')) ?? NaN, price: asNumber(getPath(p, 'productPrice')) ?? NaN })),
  );
  const hit: PartSearchHit = {
    lcsc,
    mpn,
    manufacturer: clean(asString(it.componentBrandEn)),
    package: clean(asString(it.componentSpecificationEn)),
    description: describe,
    category: categorize(asString(it.firstSortName), asString(it.secondSortName), describe, mpn),
    stock: Math.max(0, asNumber(it.stockCount) ?? 0),
    priceBreaks,
    currency: 'USD',
    attributes,
    source: 'JLCPCB',
  };
  const lib = jlcLibraryType(asString(it.componentLibraryType), it.preferredComponentFlag === true);
  if (lib) hit.libraryType = lib;
  const ds = asText(it.dataManualUrl);
  if (ds) hit.datasheetUrl = ds;
  const img = asText(it.componentImageUrl) ?? asText(it.minImage);
  if (img) hit.imageUrl = img;
  const url = asText(it.lcscGoodsUrl) ?? (asText(it.urlSuffix) ? `https://jlcpcb.com/partdetail/${asString(it.urlSuffix)}` : undefined);
  if (url) hit.url = url;
  return hit;
}

/** Parse a JLCPCB selectSmtComponentList response into search hits (invalid items are skipped). */
export function parseJlcSearch(json: unknown): PartSearchHit[] {
  const list = asArray(getPath(json, 'data', 'componentPageInfo', 'list'));
  const out: PartSearchHit[] = [];
  for (const it of list) {
    const h = parseItem(it);
    if (h) out.push(h);
  }
  return out;
}

/** JLC's first/second sort names of a raw list item (specific, parent). */
export function jlcCategoryNames(json: unknown, lcsc: string): [string, string] | undefined {
  for (const it of asArray(getPath(json, 'data', 'componentPageInfo', 'list'))) {
    if (isRecord(it) && asString(it.componentCode) === lcsc) return [asString(it.firstSortName), asString(it.secondSortName)];
  }
  return undefined;
}

/**
 * Placeholder entries that JLCPCB's customer-consigned library returns for free-text searches
 * (codes C99xxxxxxx, brand 'JLCPCB Assembly', no stock / data).
 */
export function isJlcPlaceholder(h: PartSearchHit): boolean {
  return /^C99\d{8,}$/.test(h.lcsc) || (/^JLCPCB Assembly$/i.test(h.manufacturer) && h.stock === 0);
}

export interface JlcSearchResult {
  ok: boolean;
  hits: PartSearchHit[];
  total: number;
  raw?: unknown;
  error?: string;
}

/** Query the JLCPCB parts search (never throws). */
export async function jlcSearch(keyword: string, opts: { pageSize?: number; fetch?: FetchLike; timeoutMs?: number } = {}): Promise<JlcSearchResult> {
  const r = await httpJson(JLC_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ currentPage: 1, pageSize: Math.max(1, Math.min(100, opts.pageSize ?? 25)), keyword, searchSource: 'search' }),
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs,
  });
  if (!r.ok) return { ok: false, hits: [], total: 0, error: r.error };
  const code = asNumber(getPath(r.json, 'code'));
  if (code !== undefined && code !== 200) return { ok: false, hits: [], total: 0, raw: r.json, error: `JLCPCB API code ${code}: ${asString(getPath(r.json, 'message'))}` };
  return { ok: true, hits: parseJlcSearch(r.json), total: asNumber(getPath(r.json, 'data', 'componentPageInfo', 'total')) ?? 0, raw: r.json };
}
