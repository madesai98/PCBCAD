import { useMemo, useState } from 'react';
import { CircuitBoard, Loader2, Route, ShieldCheck, Thermometer } from 'lucide-react';
import type { PcbThermalResult } from '@pcbcad/core';
import { PcbView } from '../../../viewers';
import { useLatestRun, useSimResult } from '../../hooks';
import { useApp } from '../../store';
import { BoardPicker, EmptyState, useBoard } from '../ui';

type Overlay = 'none' | 'thermal' | 'currents' | 'issues';

export default function PcbTab() {
  const project = useApp((s) => s.project)!;
  const board = useBoard();
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const callTool = useApp((s) => s.callTool);
  const [mode, setMode] = useState<'realistic' | 'layers'>('realistic');
  const [overlay, setOverlay] = useState<Overlay>('issues');
  const [busy, setBusy] = useState<string | null>(null);
  const thermalRun = useLatestRun('pcb-thermal', board?.id);
  const thermal = useSimResult<PcbThermalResult>(overlay === 'thermal' || overlay === 'currents' ? thermalRun : null);
  const issues = useMemo(() => project.issues.filter((i) => i.target?.boardId === board?.id && (i.category === 'drc' || i.category === 'erc')), [project.issues, board?.id]);
  if (!board) return <EmptyState icon={CircuitBoard} title="No boards yet" text="Board layouts appear here as the agent places and routes them." />;
  const xs = board.outline.map((p) => p[0]);
  const ys = board.outline.map((p) => p[1]);
  const run = async (name: string, args: Record<string, unknown>) => {
    setBusy(name);
    try {
      await callTool(name, args);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-1.5">
        <BoardPicker project={project} />
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg-sunken)] p-0.5">
          {(['realistic', 'layers'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`rounded-md px-2 py-1 text-[11.5px] font-medium capitalize ${mode === m ? 'bg-[var(--bg-elev)] shadow-[var(--shadow)]' : 'dim'}`}>
              {m}
            </button>
          ))}
        </div>
        <select className="input !h-7 !w-auto !py-0 !text-[12px]" value={overlay} onChange={(e) => setOverlay(e.target.value as Overlay)}>
          <option value="none">No overlay</option>
          <option value="issues">DRC / ERC markers ({issues.length})</option>
          <option value="thermal" disabled={!thermalRun}>
            Thermal map{thermalRun ? '' : ' (run thermal sim)'}
          </option>
          <option value="currents" disabled={!thermalRun}>
            Trace currents
          </option>
        </select>
        {overlay === 'thermal' && thermal.loading && <Loader2 size={13} className="animate-spin" />}
        <span className="flex-1" />
        <span className="hidden text-[11.5px] dim md:inline">
          {(Math.max(...xs) - Math.min(...xs)).toFixed(1)}×{(Math.max(...ys) - Math.min(...ys)).toFixed(1)} mm · {board.stackup.layers}L · {board.traces.length} traces · {board.vias.length} vias
        </span>
        <button className="btn btn-sm" disabled={!!busy} onClick={() => void run('run_drc', { boardId: board.id })}>
          {busy === 'run_drc' ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} DRC
        </button>
        <button className="btn btn-sm" disabled={!!busy} onClick={() => void run('auto_route', { boardId: board.id, skipNets: board.zones.some((z) => board.nets.find((n) => n.id === z.netId)?.class === 'ground') ? board.nets.filter((n) => n.class === 'ground').map((n) => n.name) : undefined })}>
          {busy === 'auto_route' ? <Loader2 size={12} className="animate-spin" /> : <Route size={12} />} Route
        </button>
        <button className="btn btn-sm" disabled={!!busy} onClick={() => void run('simulate_pcb_thermal', { boardId: board.id })}>
          {busy === 'simulate_pcb_thermal' ? <Loader2 size={12} className="animate-spin" /> : <Thermometer size={12} />} Thermal
        </button>
      </div>
      <div className="relative min-h-0 flex-1 bg-[var(--canvas)]">
        <PcbView
          board={board}
          parts={project.parts}
          mode={mode}
          overlay={{
            thermal: overlay === 'thermal' ? (thermal.data ?? undefined) : undefined,
            issues: overlay === 'issues' ? issues : undefined,
            traceCurrents: overlay === 'currents' ? true : undefined,
            ...(overlay === 'currents' && thermal.data ? { thermal: undefined, currents: thermal.data } : {}),
          }}
          selectedIds={selection?.kind === 'component' ? [selection.componentId] : []}
          onSelectComponent={(id: string | null) => select(id ? { kind: 'component', boardId: board.id, componentId: id } : null)}
        />
      </div>
    </div>
  );
}
