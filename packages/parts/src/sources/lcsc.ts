import type { DistributorOffer, PartDef } from '@pcbcad/core';
import { categorize } from '../infer/categorize';
import { parseTempRange } from '../infer/params';
import { httpJson, type FetchLike } from '../util/fetch';
import { asArray, asNumber, asString, asText, getPath, isRecord } from '../util/json';
import { clean } from '../util/text';
import { normalisePriceBreaks } from './jlc';

/** LCSC product-detail endpoint (GET, no auth). */
export function lcscDetailUrl(code: string): string {
  return `https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=${encodeURIComponent(code)}`;
}

export function lcscProductUrl(code: string): string {
  return `https://www.lcsc.com/product-detail/${encodeURIComponent(code)}.html`;
}

/**
 * Parse an LCSC product-detail response into the PartDef fields it can provide: id, mpn,
 * manufacturer, description, category, package, params (paramVOList), an LCSC offer (USD price
 * ladder, stock, MOQ), datasheet, image, mass (g) and temperature ratings. Missing fields are
 * omitted; returns {} for an empty / invalid response.
 */
export function parseLcscDetail(json: unknown): Partial<PartDef> {
  const r = isRecord(json) && 'result' in json ? json.result : json;
  if (!isRecord(r)) return {};
  const code = asText(r.productCode);
  if (!code) return {};
  const out: Partial<PartDef> = { id: code };
  const mpn = asText(r.productModel);
  if (mpn) out.mpn = clean(mpn);
  const brand = asText(r.brandNameEn);
  if (brand) out.manufacturer = clean(brand);
  const desc = asText(r.productIntroEn) ?? asText(r.productDescEn) ?? asText(r.productNameEn);
  if (desc) out.description = clean(desc);
  const pkg = asText(r.encapStandard);
  if (pkg) out.package = clean(pkg);
  const params: Record<string, string> = {};
  for (const p of asArray(r.paramVOList)) {
    const k = asText(getPath(p, 'paramNameEn'));
    const v = asText(getPath(p, 'paramValueEn'));
    if (k && v) params[k] = v;
  }
  out.params = params;
  out.category = categorize(asString(r.catalogName), asString(r.parentCatalogName), desc ?? '', mpn ?? '');
  const breaks = normalisePriceBreaks(
    asArray(r.productPriceList).map((p) => ({
      qty: asNumber(getPath(p, 'ladder')) ?? NaN,
      price: asNumber(getPath(p, 'usdPrice')) ?? asNumber(getPath(p, 'currencyPrice')) ?? asNumber(getPath(p, 'productPrice')) ?? NaN,
    })),
  );
  const offer: DistributorOffer = { distributor: 'LCSC', sku: code, url: lcscProductUrl(code), currency: 'USD', priceBreaks: breaks, fetchedAt: new Date().toISOString() };
  const stock = asNumber(r.stockNumber);
  if (stock !== undefined) offer.stock = Math.max(0, stock);
  const moq = asNumber(r.minBuyNumber);
  if (moq !== undefined && moq > 0) offer.moq = moq;
  out.offers = [offer];
  const pdf = asText(r.pdfUrl);
  if (pdf) out.datasheetUrl = pdf;
  const img = asArray(r.productImages).map((x) => asText(x)).find(Boolean);
  if (img) out.imageUrl = img;
  // 'weight' is grams; 'productWeight' is kilograms
  const grams = asNumber(r.weight) ?? (asNumber(r.productWeight) !== undefined ? (asNumber(r.productWeight) as number) * 1000 : undefined);
  if (grams !== undefined && grams > 0) out.massGrams = Math.round(grams * 1e4) / 1e4;
  const temp = parseTempRange(params['Operating Temperature']);
  if (temp) out.ratings = { tempMin: temp[0], tempMax: temp[1] };
  return out;
}

export interface LcscDetailResult {
  ok: boolean;
  part?: Partial<PartDef>;
  /** True when LCSC answered but does not know the code. */
  notFound?: boolean;
  catalog?: [string, string];
  error?: string;
}

/** Fetch and parse an LCSC product detail (never throws). */
export async function fetchLcscDetail(code: string, opts: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<LcscDetailResult> {
  const r = await httpJson(lcscDetailUrl(code), { fetch: opts.fetch, timeoutMs: opts.timeoutMs, headers: { Accept: 'application/json' } });
  if (!r.ok) return { ok: false, error: r.error };
  const result = getPath(r.json, 'result');
  if (!isRecord(result)) return { ok: true, notFound: true };
  const part = parseLcscDetail(r.json);
  if (!part.id) return { ok: true, notFound: true };
  return { ok: true, part, catalog: [asString(result.catalogName), asString(result.parentCatalogName)] };
}
