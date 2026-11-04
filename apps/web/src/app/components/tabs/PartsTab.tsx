import { useMemo, useState } from 'react';
import { ExternalLink, FileText, Package, Search } from 'lucide-react';
import { buildBom, type FacetStatus, type PartDef } from '@pcbcad/core';
import { useApp } from '../../store';
import { EmptyState } from '../ui';

const FACETS: { key: keyof PartDef['provenance']; label: string }[] = [
  { key: 'specs', label: 'Specs' },
  { key: 'symbol', label: 'Pins' },
  { key: 'footprint', label: 'Footprint' },
  { key: 'model3d', label: '3D' },
  { key: 'sim', label: 'Sim' },
];

export function facetChip(s: FacetStatus) {
  const cls = s === 'fetched' || s === 'builtin' ? 'chip-ok' : s === 'generated' ? 'chip-accent' : s === 'agent' ? 'chip-warn' : 'chip-err';
  const title = s === 'fetched' ? 'Fetched from distributor/EDA library' : s === 'generated' ? 'Generated parametrically' : s === 'agent' ? 'Provided by the agent (review)' : s === 'builtin' ? 'Built-in catalog' : 'Missing';
  return { cls, title };
}

export function PartsTab() {
  const project = useApp((s) => s.project)!;
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const [q, setQ] = useState('');
  const bom = useMemo(() => buildBom(project), [project]);
  const lines = bom.lines.filter((l) => !q || `${l.mpn} ${l.manufacturer} ${l.description} ${l.refs.join(' ')} ${l.sku ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  if (!Object.keys(project.parts).length) return <EmptyState icon={Package} title="No parts yet" text="Parts imported from distributors (with specs, pinouts, footprints and 3D models) are listed here with live pricing and stock." />;
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-1.5">
        <div className="relative w-64">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 opacity-50" />
          <input className="input !h-8 !pl-8" placeholder="Filter parts…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="flex-1" />
        <span className="text-[12px] dim">
          {bom.lines.length} lines · <b className="text-[var(--text)]">${bom.total.toFixed(2)}</b> per unit @ {project.settings.buildQuantity}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Refs</th>
              <th>Qty</th>
              <th>Part</th>
              <th>Package</th>
              <th>Distributor</th>
              <th className="text-right">Stock</th>
              <th className="text-right">Unit</th>
              <th className="text-right">Ext.</th>
              <th>Data</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const part = project.parts[l.partId];
              const active = selection?.kind === 'part' && selection.partId === l.partId;
              return (
                <tr key={l.partId} onClick={() => select({ kind: 'part', partId: l.partId })} className={`cursor-pointer ${active ? '[&>td]:bg-[var(--accent-soft)]' : ''}`}>
                  <td className="max-w-40">
                    <div className="line-clamp-2 text-[12px]">{l.refs.join(', ')}</div>
                  </td>
                  <td>{l.qty}</td>
                  <td className="min-w-56">
                    <div className="font-medium">
                      {l.mpn}
                      {l.value && <span className="ml-1.5 chip">{l.value}</span>}
                    </div>
                    <div className="line-clamp-1 text-[11.5px] dim">
                      {l.manufacturer} · {part?.description || part?.category}
                    </div>
                  </td>
                  <td className="text-[12px]">{l.package}</td>
                  <td className="text-[12px]">
                    {l.sku ? (
                      <a className="inline-flex items-center gap-1 hover:underline" href={part?.offers.find((o) => o.sku === l.sku)?.url ?? (l.distributor === 'LCSC' || l.distributor === 'JLCPCB' ? `https://www.lcsc.com/product-detail/${l.sku}.html` : '#')} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        {l.distributor} {l.sku} <ExternalLink size={10} />
                      </a>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td className="text-right">{l.stock != null ? l.stock.toLocaleString() : '—'}</td>
                  <td className="text-right mono">{l.unitPrice != null ? `$${l.unitPrice.toFixed(4)}` : '—'}</td>
                  <td className="text-right mono">{l.extPrice != null ? `$${l.extPrice.toFixed(3)}` : '—'}</td>
                  <td>
                    {part && (
                      <div className="flex flex-wrap gap-1">
                        {FACETS.map((f) => {
                          const s = part.provenance[f.key] as FacetStatus;
                          const c = facetChip(s);
                          return (
                            <span key={f.key} className={`chip ${c.cls}`} title={`${f.label}: ${c.title}`}>
                              {f.label}
                            </span>
                          );
                        })}
                        {part.datasheetUrl && (
                          <a href={part.datasheetUrl} target="_blank" rel="noreferrer" className="chip hover:underline" onClick={(e) => e.stopPropagation()}>
                            <FileText size={10} /> PDF
                          </a>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="px-4 py-3 text-[11px] faint">Prices and stock are distributor snapshots at import time. Symbols, footprints and 3D models marked “fetched” come from the JLCEDA/EasyEDA official library (easyeda.com · lceda.cn); “generated” facets are parametric IPC-7351 models; “agent” facets were supplied by the AI agent and should be reviewed.</p>
      </div>
    </div>
  );
}
