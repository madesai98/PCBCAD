import { useMemo, useState } from 'react';
import { Download, ExternalLink, Factory, FileDown, Loader2, ShieldCheck } from 'lucide-react';
import { effectiveMaterial, getMaterial, PROCESSES, type DesignIssue } from '@pcbcad/core';
import { useApp } from '../../store';
import { Section } from '../ui';

const CATS: DesignIssue['category'][] = ['drc', 'erc', 'dfm', 'assembly', 'interconnect', 'sim', 'part'];

export function ManufacturingTab() {
  const project = useApp((s) => s.project)!;
  const callTool = useApp((s) => s.callTool);
  const [cat, setCat] = useState<'all' | DesignIssue['category']>('all');
  const [sev, setSev] = useState<'all' | DesignIssue['severity']>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const issues = useMemo(() => project.issues.filter((i) => (cat === 'all' || i.category === cat) && (sev === 'all' || i.severity === sev)), [project.issues, cat, sev]);

  const run = async (name: string, args: Record<string, unknown> = {}) => {
    setBusy(name);
    try {
      const r = await callTool(name, args);
      if (name === 'export_manufacturing') {
        const m = /Download: (\S+)/.exec(r.text);
        if (m) setExportUrl(new URL(m[1]).pathname + new URL(m[1]).search);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1300px] flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-[16px] font-semibold">Manufacturing</h2>
          <button className="btn btn-sm" disabled={!!busy} onClick={() => void run('run_dfm')}>
            {busy === 'run_dfm' ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} Run DFM & assembly checks
          </button>
          <a className="btn btn-sm" href={`/api/projects/${project.id}/project.json`}>
            <FileDown size={12} /> Project file
          </a>
          <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void run('export_manufacturing')}>
            {busy === 'export_manufacturing' ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Generate manufacturing package
          </button>
        </div>
        {exportUrl && (
          <a href={exportUrl} className="card flex items-center gap-3 border-[color-mix(in_oklab,var(--ok)_40%,transparent)] px-4 py-3 text-[13px] hover:bg-[var(--bg-hover)]">
            <Download size={16} className="text-[var(--ok)]" />
            <span className="flex-1">Manufacturing package ready — Gerbers, drills, BOM, pick-and-place, STL and DXF.</span>
            <span className="text-[var(--accent)]">Download zip</span>
          </a>
        )}
        <Section title="Mechanical parts — material & process">
          {project.mechanical.length === 0 ? (
            <div className="px-4 py-5 text-[12.5px] dim">No mechanical parts yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Part</th>
                    <th>Material</th>
                    <th>Process</th>
                    <th>E (as made)</th>
                    <th>Yield</th>
                    <th>Weak plane</th>
                    <th>Max temp</th>
                    <th>DFM</th>
                  </tr>
                </thead>
                <tbody>
                  {project.mechanical.map((m) => {
                    let e: ReturnType<typeof effectiveMaterial> | null = null;
                    try {
                      e = effectiveMaterial(m.materialId, m.process, m.processOptions);
                    } catch {
                      e = null;
                    }
                    const its = project.issues.filter((i) => i.target?.partId === m.id);
                    const errs = its.filter((i) => i.severity === 'error').length;
                    return (
                      <tr key={m.id}>
                        <td>
                          <div className="font-medium">{m.name}</div>
                          <div className="text-[11.5px] dim">{m.kind.replace('-', ' ')}</div>
                        </td>
                        <td>{getMaterial(m.materialId)?.name ?? m.materialId}</td>
                        <td>
                          <div>{PROCESSES.find((p) => p.id === m.process)?.name ?? m.process}</div>
                          {m.processOptions && <div className="text-[11px] dim">{Object.entries(m.processOptions).map(([k, v]) => `${k}: ${v}`).join(', ')}</div>}
                        </td>
                        <td className="mono">{e ? `${(e.E / 1000).toFixed(1)} GPa` : '—'}</td>
                        <td className="mono">{e ? `${e.yieldStrength.toFixed(0)} MPa` : '—'}</td>
                        <td className="mono">{e ? `${e.weakPlaneStrength.toFixed(0)} MPa` : '—'}</td>
                        <td className="mono">{e ? `${e.maxServiceTemp} °C` : '—'}</td>
                        <td>{its.length ? <span className={`chip ${errs ? 'chip-err' : 'chip-warn'}`}>{its.length} issue{its.length > 1 ? 's' : ''}</span> : <span className="chip chip-ok">OK</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section
          title={`Issues (${issues.length})`}
          actions={
            <div className="flex gap-1.5">
              <select className="input !h-7 !w-auto !py-0 !text-[12px]" value={cat} onChange={(e) => setCat(e.target.value as typeof cat)}>
                <option value="all">All categories</option>
                {CATS.map((c) => (
                  <option key={c} value={c}>
                    {c.toUpperCase()}
                  </option>
                ))}
              </select>
              <select className="input !h-7 !w-auto !py-0 !text-[12px]" value={sev} onChange={(e) => setSev(e.target.value as typeof sev)}>
                <option value="all">All severities</option>
                <option value="error">Errors</option>
                <option value="warning">Warnings</option>
                <option value="info">Info</option>
              </select>
            </div>
          }
        >
          {issues.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-[12.5px] dim">
              <Factory size={20} />
              No issues in this view. Run DRC / ERC / DFM checks to verify the design.
            </div>
          ) : (
            <div className="max-h-[560px] overflow-y-auto">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Check</th>
                    <th>Issue</th>
                    <th>Suggestion</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <span className={`chip ${i.severity === 'error' ? 'chip-err' : i.severity === 'warning' ? 'chip-warn' : ''}`}>{i.severity}</span>
                      </td>
                      <td className="whitespace-nowrap text-[12px]">
                        {i.category.toUpperCase()} <span className="dim">· {i.code}</span>
                      </td>
                      <td className="text-[12.5px]">
                        {i.message}
                        {i.target?.boardId && <span className="ml-1 text-[11px] faint">({project.boards.find((b) => b.id === i.target!.boardId)?.name})</span>}
                      </td>
                      <td className="text-[12px] dim">{i.suggestion}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <p className="flex items-center gap-1 text-[11px] faint">
          <ExternalLink size={10} /> Gerbers are RS-274X with X2 attributes; drills are Excellon; BOM/CPL follow JLCPCB assembly format.
        </p>
      </div>
    </div>
  );
}
