import { ExternalLink, FileText, X } from 'lucide-react';
import { effectiveMaterial, getMaterial, unitPrice, type FacetStatus, type PartDef } from '@pcbcad/core';
import { useApp } from '../store';
import { facetChip } from './tabs/PartsTab';

function PartBody({ part }: { part: PartDef }) {
  const project = useApp((s) => s.project)!;
  const price = unitPrice(part, project.settings.buildQuantity);
  return (
    <>
      <div className="flex flex-wrap gap-1">
        {(['specs', 'symbol', 'footprint', 'model3d', 'sim'] as const).map((k) => {
          const s = part.provenance[k] as FacetStatus;
          const c = facetChip(s);
          return (
            <span key={k} className={`chip ${c.cls}`} title={c.title}>
              {k === 'model3d' ? '3D' : k} · {s}
            </span>
          );
        })}
      </div>
      {part.provenance.attribution && <div className="text-[10.5px] faint">{part.provenance.attribution}</div>}
      <div className="flex flex-col gap-1 text-[12.5px]">
        {part.offers.map((o) => (
          <a key={o.distributor + o.sku} href={o.url ?? (o.distributor === 'LCSC' || o.distributor === 'JLCPCB' ? `https://www.lcsc.com/product-detail/${o.sku}.html` : undefined)} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] px-2.5 py-1.5 hover:bg-[var(--bg-hover)]">
            <span>
              {o.distributor} <span className="mono">{o.sku}</span>
              {o.libraryType && <span className="ml-1 chip">{o.libraryType}</span>}
            </span>
            <span className="dim">{o.stock != null ? `${o.stock.toLocaleString()} in stock` : ''}</span>
          </a>
        ))}
        {price.price != null && (
          <div className="text-[12px] dim">
            ${price.price.toFixed(4)} each @ {project.settings.buildQuantity}
          </div>
        )}
        {part.datasheetUrl && (
          <a href={part.datasheetUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-[var(--accent)] hover:underline">
            <FileText size={12} /> Datasheet <ExternalLink size={10} />
          </a>
        )}
      </div>
      {part.sim && (
        <div>
          <div className="label mb-1">Simulation model</div>
          <pre className="mono max-h-32 overflow-auto rounded-lg bg-[var(--bg-sunken)] p-2 text-[11px]">{JSON.stringify(part.sim, null, 1)}</pre>
        </div>
      )}
      {part.connector && (
        <div className="text-[12px]">
          <div className="label mb-1">Functional connector</div>
          {part.connector.family} {part.connector.gender} {part.connector.positions}P · {part.connector.currentRating} A/contact · {part.connector.contactResistance * 1000} mΩ · mates {part.connector.matesWith.join(', ')}
        </div>
      )}
      {Object.keys(part.params).length > 0 && (
        <div>
          <div className="label mb-1">Parameters</div>
          <div className="flex flex-col text-[12px]">
            {Object.entries(part.params)
              .slice(0, 40)
              .map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 border-b border-[var(--border)] py-1">
                  <span className="dim">{k}</span>
                  <span className="text-right">{v}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </>
  );
}

export function Inspector() {
  const project = useApp((s) => s.project)!;
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  let title = '';
  let subtitle = '';
  let body: React.ReactNode = null;

  if (selection?.kind === 'component') {
    const b = project.boards.find((x) => x.id === selection.boardId);
    const c = b?.components.find((x) => x.id === selection.componentId);
    const part = c ? project.parts[c.partId] : undefined;
    if (!b || !c) return null;
    title = `${c.ref} · ${part?.mpn ?? c.partId}`;
    subtitle = `${part?.manufacturer ?? ''} ${c.value ?? part?.value ?? ''}`;
    const netName = (id?: string) => b.nets.find((n) => n.id === id)?.name;
    body = (
      <>
        <div className="grid grid-cols-2 gap-1.5 text-[12px]">
          <div className="rounded-lg bg-[var(--bg-sunken)] px-2 py-1.5">
            <div className="faint">Position</div>
            {c.placed ? `${c.x.toFixed(2)}, ${c.y.toFixed(2)} mm` : 'unplaced'}
          </div>
          <div className="rounded-lg bg-[var(--bg-sunken)] px-2 py-1.5">
            <div className="faint">Rotation / side</div>
            {c.rotation}° · {c.side}
          </div>
        </div>
        {part && (
          <div>
            <div className="label mb-1">Pins</div>
            <div className="flex max-h-64 flex-col overflow-y-auto text-[12px]">
              {part.pins.map((p) => (
                <div key={p.number} className="flex justify-between gap-2 border-b border-[var(--border)] py-1">
                  <span>
                    <span className="mono faint">{p.number}</span> {p.name}
                  </span>
                  <span className={netName(c.pinNets[p.number]) ? 'text-[var(--accent)]' : 'faint'}>{netName(c.pinNets[p.number]) ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {part && <PartBody part={part} />}
      </>
    );
  } else if (selection?.kind === 'part') {
    const part = project.parts[selection.partId];
    if (!part) return null;
    title = part.mpn;
    subtitle = `${part.manufacturer} · ${part.package}`;
    body = <PartBody part={part} />;
  } else if (selection?.kind === 'mech') {
    const m = project.mechanical.find((x) => x.id === selection.partId);
    if (!m) return null;
    const mat = getMaterial(m.materialId);
    let e: ReturnType<typeof effectiveMaterial> | null = null;
    try {
      e = effectiveMaterial(m.materialId, m.process, m.processOptions);
    } catch {
      /* unknown */
    }
    title = m.name;
    subtitle = `${mat?.name ?? m.materialId} · ${m.process}`;
    body = (
      <>
        {e && (
          <div className="grid grid-cols-2 gap-1.5 text-[12px]">
            {[
              ['E (as made)', `${(e.E / 1000).toFixed(2)} GPa`],
              ['Yield', `${e.yieldStrength.toFixed(0)} MPa`],
              ['Density', `${e.density.toFixed(0)} kg/m³`],
              ['Conductivity', `${e.thermalConductivity} W/mK`],
              ['Max temp', `${e.maxServiceTemp} °C`],
              ['Emissivity', `${e.emissivity}`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-[var(--bg-sunken)] px-2 py-1.5">
                <div className="faint">{k}</div>
                {v}
              </div>
            ))}
          </div>
        )}
        {e?.adjustments.length ? <div className="text-[11.5px] dim">{e.adjustments.join(' · ')}</div> : null}
        <pre className="mono max-h-80 overflow-auto rounded-lg bg-[var(--bg-sunken)] p-2 text-[11px]">{JSON.stringify({ ...m, id: undefined }, null, 1)}</pre>
      </>
    );
  } else return null;

  return (
    <aside className="hidden w-[320px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-elev)] lg:flex">
      <div className="flex items-start gap-2 border-b border-[var(--border)] px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold">{title}</div>
          <div className="truncate text-[11.5px] dim">{subtitle}</div>
        </div>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => select(null)}>
          <X size={14} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">{body}</div>
    </aside>
  );
}
