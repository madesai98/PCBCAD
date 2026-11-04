import type { PartDef } from './types/part';
import type { Project } from './types/project';

export interface BomLine {
  partId: string;
  mpn: string;
  manufacturer: string;
  description: string;
  package: string;
  value?: string;
  refs: string[];
  qty: number;
  unitPrice?: number;
  extPrice?: number;
  stock?: number;
  sku?: string;
  distributor?: string;
  kind: 'electronic' | 'fastener' | 'cable';
}

export function unitPrice(part: PartDef, qty: number): { price?: number; stock?: number; sku?: string; distributor?: string } {
  const offers = part.offers.filter((o) => o.priceBreaks?.length);
  let best: { price?: number; stock?: number; sku?: string; distributor?: string } = { sku: part.offers[0]?.sku, distributor: part.offers[0]?.distributor, stock: part.offers[0]?.stock };
  for (const o of offers) {
    const breaks = [...(o.priceBreaks ?? [])].sort((a, b) => a.qty - b.qty);
    let price = breaks[0]?.price;
    for (const b of breaks) if (qty >= b.qty) price = b.price;
    if (price != null && (best.price == null || price < best.price)) best = { price, stock: o.stock, sku: o.sku, distributor: o.distributor };
  }
  return best;
}

/** Bill of materials for the whole product (all boards + interconnect parts + fasteners), per unit. */
export function buildBom(project: Project): { lines: BomLine[]; total: number; unpriced: number } {
  const qty = project.settings.buildQuantity || 1;
  const map = new Map<string, BomLine>();
  const add = (partId: string, ref: string, n: number, kind: BomLine['kind']) => {
    const part = project.parts[partId];
    if (!part) return;
    let line = map.get(partId);
    if (!line) {
      const pr = unitPrice(part, qty * n);
      line = {
        partId,
        mpn: part.mpn,
        manufacturer: part.manufacturer,
        description: part.description,
        package: part.package,
        value: part.value,
        refs: [],
        qty: 0,
        unitPrice: pr.price,
        stock: pr.stock,
        sku: pr.sku,
        distributor: pr.distributor,
        kind,
      };
      map.set(partId, line);
    }
    line.refs.push(ref);
    line.qty += n;
  };
  for (const b of project.boards) {
    for (const c of b.components) if (!c.dnp) add(c.partId, project.boards.length > 1 ? `${b.name}:${c.ref}` : c.ref, 1, 'electronic');
  }
  for (const ic of project.interconnects) for (const cp of ic.cableParts ?? []) add(cp.partId, ic.name, cp.qty, 'cable');
  for (const f of project.assembly.fasteners) add(f.partId, 'fastener', 1, 'fastener');
  let total = 0;
  let unpriced = 0;
  const lines = [...map.values()];
  for (const l of lines) {
    if (l.unitPrice != null) {
      l.extPrice = l.unitPrice * l.qty;
      total += l.extPrice;
    } else unpriced++;
  }
  lines.sort((a, b) => a.refs[0].localeCompare(b.refs[0], undefined, { numeric: true }));
  return { lines, total, unpriced };
}
