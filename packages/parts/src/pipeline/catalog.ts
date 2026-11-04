import type { PartDef } from '@pcbcad/core';
import { BUILTIN_PARTS } from '../catalog/builtin';
import { FASTENERS } from '../catalog/fasteners';
import { WIRING_PARTS } from '../catalog/wiring';
import type { PartSearchHit } from '../types';
import { baseMpn, normMpn, tokens } from '../util/text';

/** Every offline catalog part (builtin electronics, fasteners, wiring). */
export const ALL_CATALOG_PARTS: PartDef[] = [...BUILTIN_PARTS, ...FASTENERS, ...WIRING_PARTS];

/** Find a catalog part by id, distributor SKU or exact MPN (case-insensitive). */
export function findCatalogPart(idOrMpn: string): PartDef | undefined {
  const q = idOrMpn.trim();
  if (!q) return undefined;
  const lower = q.toLowerCase();
  const nm = normMpn(q);
  const bm = baseMpn(q);
  return (
    ALL_CATALOG_PARTS.find((p) => p.id.toLowerCase() === lower) ??
    ALL_CATALOG_PARTS.find((p) => p.offers.some((o) => o.sku.toLowerCase() === lower && o.distributor !== 'Other')) ??
    ALL_CATALOG_PARTS.find((p) => normMpn(p.mpn) === nm) ??
    ALL_CATALOG_PARTS.find((p) => baseMpn(p.mpn) === bm && bm.length >= 4)
  );
}

/** Convert a catalog part to a search hit (source 'builtin'). */
export function catalogHit(p: PartDef): PartSearchHit {
  const lcsc = p.offers.find((o) => o.distributor === 'LCSC' || o.distributor === 'JLCPCB')?.sku ?? '';
  const jlc = p.offers.find((o) => o.distributor === 'JLCPCB');
  const hit: PartSearchHit = {
    lcsc,
    mpn: p.mpn,
    manufacturer: p.manufacturer,
    package: p.package,
    description: p.description,
    category: p.category,
    stock: p.offers.reduce((m, o) => Math.max(m, o.stock ?? 0), 0),
    priceBreaks: p.offers.find((o) => o.priceBreaks?.length)?.priceBreaks ?? [],
    currency: 'USD',
    attributes: { ...p.params, 'Catalog id': p.id },
    source: 'builtin',
  };
  if (jlc?.libraryType) hit.libraryType = jlc.libraryType;
  if (p.datasheetUrl) hit.datasheetUrl = p.datasheetUrl;
  const url = p.offers.find((o) => o.url)?.url;
  if (url) hit.url = url;
  return hit;
}

function haystack(p: PartDef): string {
  return [
    p.id,
    p.mpn,
    p.manufacturer,
    p.description,
    p.package,
    p.value ?? '',
    p.category,
    p.fastener ? `${p.fastener.type} ${p.fastener.thread ?? ''} ${p.fastener.head ?? ''}` : '',
    p.connector ? `${p.connector.family} ${p.connector.gender}` : '',
    ...p.offers.map((o) => o.sku),
    ...Object.values(p.params),
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * Offline search over the builtin catalogs. All query tokens must match (as substrings of the part's
 * id / MPN / description / package / value / parameters); exact id / MPN / SKU matches rank first.
 */
export function searchCatalog(query: string, limit = 10): PartSearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const toks = tokens(q);
  const nm = normMpn(q);
  const scored: { p: PartDef; s: number }[] = [];
  for (const p of ALL_CATALOG_PARTS) {
    const h = haystack(p);
    let s = 0;
    if (p.id.toLowerCase() === q.toLowerCase() || normMpn(p.mpn) === nm || p.offers.some((o) => o.sku.toLowerCase() === q.toLowerCase())) s += 100;
    let all = true;
    for (const t of toks) {
      if (h.includes(t)) s += t.length >= 3 ? 2 : 1;
      else all = false;
    }
    if (s >= 100 || (all && toks.length)) scored.push({ p, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => catalogHit(x.p));
}
