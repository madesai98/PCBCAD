import type { MeshData, PartDef } from '@pcbcad/core';
import { BUILTIN_PARTS, FASTENERS, importPart, searchParts, type PartImportResult, type PartSearchHit } from '@pcbcad/parts';
import type { Settings } from '../config';
import type { Store } from '../store/store';

interface CacheEntry extends PartImportResult {
  cachedAt: string;
}

const CACHE_TTL_MS = 3 * 24 * 3600 * 1000;

/**
 * Distributor-backed part library with a local cache shared by all projects.
 * Deterministic pipeline lives in @pcbcad/parts (JLCPCB/LCSC + EasyEDA, optional Mouser).
 */
export class PartsService {
  constructor(
    private store: Store,
    private settings: () => Settings,
  ) {}

  builtin(id: string): PartDef | undefined {
    const q = id.trim().toLowerCase();
    const all = [...BUILTIN_PARTS, ...FASTENERS];
    return (
      all.find((p) => p.id.toLowerCase() === q) ??
      all.find((p) => p.offers.some((o) => o.sku.toLowerCase() === q)) ??
      all.find((p) => p.mpn.toLowerCase() === q)
    );
  }

  async search(query: string, opts: { limit?: number; inStockOnly?: boolean } = {}): Promise<PartSearchHit[]> {
    return searchParts(query, { limit: opts.limit ?? 10, inStockOnly: opts.inStockOnly, mouserApiKey: this.settings().mouserApiKey || undefined });
  }

  /**
   * Import a part by LCSC code or MPN. Results are cached; builtin parts are used directly when
   * the network import fails.
   */
  async import(idOrMpn: string, opts: { refresh?: boolean; with3d?: boolean } = {}): Promise<PartImportResult & { fromCache: boolean }> {
    const key = idOrMpn.trim();
    if (!opts.refresh) {
      const c = await this.store.readPartsCache<CacheEntry>(key);
      if (c && Date.now() - Date.parse(c.cachedAt) < CACHE_TTL_MS) return { ...c, fromCache: true };
    }
    try {
      const r = await importPart(key, { with3d: opts.with3d ?? true });
      const entry: CacheEntry = { ...r, cachedAt: new Date().toISOString() };
      this.store.writePartsCache(key, entry);
      if (r.part.id !== key) this.store.writePartsCache(r.part.id, entry);
      return { ...r, fromCache: false };
    } catch (e) {
      const b = this.builtin(key);
      if (b) {
        return {
          part: structuredClone(b),
          meshes: [] as { assetId: string; mesh: MeshData }[],
          log: [`Network import failed (${e instanceof Error ? e.message : e}); using builtin catalog entry.`],
          needsAgent: [],
          fromCache: false,
        };
      }
      throw e;
    }
  }
}
