/**
 * Assembly outputs: BOM (CSV), JLCPCB pick-and-place (CPL) and zip packaging.
 */
import { strToU8, zipSync } from 'fflate';
import type { Board, ComponentInstance, DistributorOffer, PartDef, Project } from '@pcbcad/core';
import { compareRefs } from './geom';

/** RFC 4180 CSV field. */
function csv(v: string | number | undefined | null): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Preferred offer: LCSC, then JLCPCB, then any offer with price breaks, then the first. */
function preferredOffer(part: PartDef | undefined): DistributorOffer | undefined {
  const offers = part?.offers ?? [];
  return (
    offers.find((o) => o.distributor === 'LCSC' && o.priceBreaks?.length) ??
    offers.find((o) => o.distributor === 'JLCPCB' && o.priceBreaks?.length) ??
    offers.find((o) => o.priceBreaks?.length) ??
    offers[0]
  );
}

/** Unit price at an order quantity: the break with the largest qty ≤ needed (smallest break if below all). */
export function unitPriceAt(offer: DistributorOffer | undefined, qty: number): number | undefined {
  const breaks = (offer?.priceBreaks ?? []).filter((b) => b.qty > 0 && Number.isFinite(b.price)).sort((a, b) => a.qty - b.qty);
  if (!breaks.length) return undefined;
  let price = breaks[0].price;
  for (const b of breaks) if (b.qty <= qty) price = b.price;
  return price;
}

function lcscCode(part: PartDef | undefined): string {
  const o = part?.offers?.find((x) => x.distributor === 'LCSC' || x.distributor === 'JLCPCB');
  if (o?.sku) return o.sku;
  return part && /^C\d+$/.test(part.id) ? part.id : '';
}

function money(v: number | undefined): string {
  if (v === undefined) return '';
  return v >= 1 ? v.toFixed(2) : v.toFixed(4);
}

/**
 * Bill of materials as CSV with columns
 * `Designator,Qty,Value,MPN,Manufacturer,Package,LCSC,Unit Price,Ext Price,Stock`.
 * Identical parts (same part and value) are grouped; DNP parts are excluded. `Qty` is per board
 * (summed over boards when several are included); the unit price comes from the price break for the
 * build quantity (`opts.quantity`, default project.settings.buildQuantity) × Qty; `Ext Price` =
 * Unit Price × Qty (cost per assembled board set). Designators get a `Board:` prefix when more than one
 * board is included.
 */
export function exportBom(project: Project, opts: { boardId?: string; quantity?: number } = {}): string {
  const boards = project.boards.filter((b) => !opts.boardId || b.id === opts.boardId);
  const build = Math.max(1, Math.round(opts.quantity ?? project.settings?.buildQuantity ?? 1));
  const multi = boards.length > 1;
  const groups = new Map<string, { part?: PartDef; value: string; refs: string[] }>();
  for (const b of boards) {
    for (const c of b.components) {
      if (c.dnp) continue;
      const part = project.parts[c.partId];
      if (part && (part.category === 'fastener' || part.category === 'mechanical')) continue;
      const value = c.value ?? part?.value ?? '';
      const key = `${c.partId}|${value}`;
      const g = groups.get(key) ?? { part, value, refs: [] };
      g.refs.push(multi ? `${b.name}:${c.ref}` : c.ref);
      groups.set(key, g);
    }
  }
  const rows = [...groups.values()].map((g) => ({ ...g, refs: g.refs.sort(compareRefs) }));
  rows.sort((a, b) => compareRefs(a.refs[0], b.refs[0]));
  const lines = ['Designator,Qty,Value,MPN,Manufacturer,Package,LCSC,Unit Price,Ext Price,Stock'];
  for (const r of rows) {
    const qty = r.refs.length;
    const offer = preferredOffer(r.part);
    const unit = unitPriceAt(offer, qty * build);
    const stock = offer?.stock;
    lines.push(
      [
        csv(r.refs.join(',')),
        csv(qty),
        csv(r.value || r.part?.value || ''),
        csv(r.part?.mpn ?? ''),
        csv(r.part?.manufacturer ?? ''),
        csv(r.part?.package ?? r.part?.footprint?.name ?? ''),
        csv(lcscCode(r.part)),
        csv(money(unit)),
        csv(unit === undefined ? '' : money(unit * qty)),
        csv(stock ?? ''),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function cplIncluded(c: ComponentInstance, part: PartDef | undefined): boolean {
  if (c.dnp || !c.placed || !part?.footprint?.pads?.length) return false;
  return !(part.category === 'fastener' || part.category === 'mechanical' || part.category === 'testpoint');
}

/**
 * JLCPCB pick-and-place file: `Designator,Mid X,Mid Y,Layer,Rotation` with positions in mm
 * (component placement origin, board frame) and rotation in degrees CCW, normalised to [0, 360).
 * DNP, unplaced, mechanical and test-point parts are excluded.
 */
export function exportCpl(board: Board, parts: Record<string, PartDef>): string {
  const rows = board.components.filter((c) => cplIncluded(c, parts[c.partId])).sort((a, b) => compareRefs(a.ref, b.ref));
  const lines = ['Designator,Mid X,Mid Y,Layer,Rotation'];
  for (const c of rows) {
    let rot = ((c.rotation % 360) + 360) % 360;
    rot = Math.round(rot * 100) / 100;
    if (rot >= 360) rot -= 360;
    lines.push([csv(c.ref), `${c.x.toFixed(4)}mm`, `${c.y.toFixed(4)}mm`, c.side === 'bottom' ? 'Bottom' : 'Top', String(rot)].join(','));
  }
  return lines.join('\n') + '\n';
}

/** Zip files (deflate) with fflate. Later duplicates of a name replace earlier ones. */
export function zipFiles(files: { name: string; content: string | Uint8Array }[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) {
    const name = f.name.replace(/^\/+/, '').replace(/\\/g, '/');
    entries[name] = typeof f.content === 'string' ? strToU8(f.content) : f.content;
  }
  return zipSync(entries, { level: 6 });
}
