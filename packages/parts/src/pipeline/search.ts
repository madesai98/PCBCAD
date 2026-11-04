import { isJlcPlaceholder, jlcSearch } from '../sources/jlc';
import { mouserSearch } from '../sources/mouser';
import type { PartSearchHit, SearchPartsOptions } from '../types';
import { baseMpn, normMpn } from '../util/text';
import { searchCatalog } from './catalog';

/** 3 = LCSC code match, 2 = exact MPN, 1.5 = MPN without packaging suffix, 1 = MPN prefix, 0 = other. */
export function matchScore(hit: Pick<PartSearchHit, 'lcsc' | 'mpn'>, query: string): number {
  const q = query.trim();
  if (hit.lcsc && hit.lcsc.toUpperCase() === q.toUpperCase()) return 3;
  const nq = normMpn(q);
  const nm = normMpn(hit.mpn);
  if (nm === nq) return 2;
  if (baseMpn(hit.mpn) === baseMpn(q)) return 1.5;
  if (nq.length >= 3 && nm.startsWith(nq)) return 1;
  return 0;
}

const LIB_RANK: Record<string, number> = { basic: 2, preferred: 1 };

/**
 * Stable ranking: exact LCSC/MPN matches first, then in-stock before out-of-stock, then JLCPCB
 * basic / preferred library parts (no assembly setup fee), distributor relevance order otherwise.
 */
export function rankHits(hits: PartSearchHit[], query: string): PartSearchHit[] {
  return hits
    .map((h, i) => ({ h, i, m: matchScore(h, query), s: h.stock > 0 ? 1 : 0, l: LIB_RANK[h.libraryType ?? ''] ?? 0 }))
    .sort((a, b) => b.m - a.m || b.s - a.s || b.l - a.l || a.i - b.i)
    .map((x) => x.h);
}

/**
 * Search distributor inventory. JLCPCB/LCSC is the primary source; Mouser (Search API v1) is added
 * when `mouserApiKey` is given. Placeholder entries from JLCPCB's consigned-parts library are
 * dropped. When the network fails or finds nothing, the offline catalogs (builtin parts, fasteners,
 * wiring) are searched instead. Never throws.
 */
export async function searchParts(query: string, opts: SearchPartsOptions = {}): Promise<PartSearchHit[]> {
  const q = (query ?? '').trim();
  if (!q) return [];
  const limit = Math.max(1, Math.min(100, opts.limit ?? 10));
  const [jlc, mouser] = await Promise.all([
    jlcSearch(q, { pageSize: Math.min(100, limit * 2 + 10), fetch: opts.fetch, timeoutMs: opts.timeoutMs }),
    opts.mouserApiKey ? mouserSearch(q, opts.mouserApiKey, { records: Math.min(50, limit), fetch: opts.fetch, timeoutMs: opts.timeoutMs }) : Promise.resolve(undefined),
  ]);
  let hits: PartSearchHit[] = jlc.ok ? jlc.hits.filter((h) => !isJlcPlaceholder(h)) : [];
  if (mouser?.ok) hits.push(...mouser.hits);
  if (opts.inStockOnly) hits = hits.filter((h) => h.stock > 0);
  const seen = new Set<string>();
  hits = hits.filter((h) => {
    const k = `${h.source}|${h.lcsc || h.url || h.mpn}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!hits.length) hits = searchCatalog(q, limit);
  return rankHits(hits, q).slice(0, limit);
}
