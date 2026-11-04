import { useMemo } from 'react';
import { Activity, Loader2 } from 'lucide-react';
import {
  formatValue,
  toFloat32,
  type AirflowResult,
  type CircuitOpResult,
  type CircuitTransientResult,
  type DropResult,
  type MixedSignalResult,
  type PcbThermalResult,
  type Project,
  type SimulationRun,
  type StructuralResult,
} from '@pcbcad/core';
import { Assembly3D, LogicAnalyzer, PcbView, WaveformPlot } from '../../../viewers';
import { makeMeshLoader } from '../../api';
import { useSimResult } from '../../hooks';
import { useApp } from '../../store';
import { timeAgo } from '../Sidebar';
import { EmptyState, MetricTiles, Progress, StatusChip } from '../ui';
import { SIM_META } from './OverviewTab';

export default function SimulationTab() {
  const project = useApp((s) => s.project)!;
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const progress = useApp((s) => s.simProgress);
  const runs = useMemo(() => [...project.simulations].reverse(), [project.simulations]);
  const selected = runs.find((r) => selection?.kind === 'sim' && r.id === selection.runId) ?? runs[0];
  if (!runs.length) return <EmptyState icon={Activity} title="No simulations yet" text="Circuit, thermal, firmware, stress, drop and airflow results appear here when the agent (or you) runs them." />;
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="max-h-56 shrink-0 overflow-y-auto border-b border-[var(--border)] md:max-h-none md:w-72 md:border-b-0 md:border-r">
        {runs.map((r) => {
          const meta = SIM_META[r.kind];
          const Icon = meta.icon;
          const live = progress[r.id];
          return (
            <button key={r.id} onClick={() => select({ kind: 'sim', runId: r.id })} className={`flex w-full flex-col gap-1 border-b border-[var(--border)] px-3 py-2.5 text-left transition ${selected?.id === r.id ? 'bg-[var(--bg-elev)]' : 'hover:bg-[var(--bg-hover)]'}`}>
              <div className="flex items-center gap-2">
                <Icon size={13} className="shrink-0 text-[var(--accent)]" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{r.title}</span>
                {r.status === 'running' ? <Loader2 size={12} className="animate-spin" /> : r.status === 'error' ? <span className="chip chip-err">Error</span> : <StatusChip status={r.summary?.pass} />}
              </div>
              <div className="line-clamp-2 pl-5 text-[11.5px] dim">{r.status === 'running' ? (live?.message ?? 'Running…') : (r.summary?.headline ?? r.error)}</div>
              {r.status === 'running' && (
                <div className="pl-5">
                  <Progress value={live?.progress ?? 0} />
                </div>
              )}
              <div className="pl-5 text-[10.5px] faint">
                {timeAgo(r.createdAt)}
                {r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(1)} s` : ''}
              </div>
            </button>
          );
        })}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{selected && <RunDetail key={selected.id} run={selected} project={project} />}</div>
    </div>
  );
}

function RunDetail({ run, project }: { run: SimulationRun; project: Project }) {
  const { data, loading, error } = useSimResult(run);
  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-[16px] font-semibold">{run.title}</h2>
          <StatusChip status={run.summary?.pass} />
        </div>
        {run.summary && <div className="mt-1 text-[13px] dim">{run.summary.headline}</div>}
        {run.error && <div className="mt-2 rounded-lg border border-[var(--border)] p-2 text-[12.5px] text-[var(--err)]">{run.error}</div>}
      </div>
      {run.summary && <MetricTiles metrics={run.summary.metrics} />}
      {run.summary?.warnings.length ? (
        <div className="rounded-xl border border-[color-mix(in_oklab,var(--warn)_35%,transparent)] bg-[color-mix(in_oklab,var(--warn)_6%,transparent)] px-3 py-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--warn)]">Warnings</div>
          <ul className="list-disc pl-4 text-[12.5px]">
            {run.summary.warnings.slice(0, 30).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {loading && (
        <div className="flex items-center gap-2 text-[12px] dim">
          <Loader2 size={13} className="animate-spin" /> Loading result…
        </div>
      )}
      {error && <div className="text-[12px] text-[var(--err)]">{error}</div>}
      {data && <ResultView run={run} result={data} project={project} />}
    </div>
  );
}

function ResultView({ run, result, project }: { run: SimulationRun; result: unknown; project: Project }) {
  const getMesh = useMemo(() => makeMeshLoader(project), [project]);
  switch (run.kind) {
    case 'circuit-op':
      return <OpView r={result as CircuitOpResult} project={project} />;
    case 'circuit-transient': {
      const r = result as CircuitTransientResult;
      return (
        <div className="card p-3">
          <WaveformPlot time={r.time} signals={r.signals} height={360} />
        </div>
      );
    }
    case 'mixed-signal':
      return (
        <div className="card overflow-hidden">
          <LogicAnalyzer result={result as MixedSignalResult} />
        </div>
      );
    case 'pcb-thermal': {
      const r = result as PcbThermalResult;
      const board = project.boards.find((b) => b.id === r.boardId);
      return (
        <div className="flex flex-col gap-3">
          {board && (
            <div className="card relative h-[420px] overflow-hidden">
              <PcbView board={board} parts={project.parts} mode="realistic" overlay={{ thermal: r }} />
            </div>
          )}
          <table className="grid-table card overflow-hidden">
            <thead>
              <tr>
                <th>Component</th>
                <th>Power</th>
                <th>T board</th>
                <th>T junction</th>
                <th>Limit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...r.components]
                .sort((a, b) => b.tJunction - a.tJunction)
                .map((c) => (
                  <tr key={c.componentId}>
                    <td className="font-medium">{c.ref}</td>
                    <td>{formatValue(c.power, 'W')}</td>
                    <td>{c.tBoard.toFixed(1)} °C</td>
                    <td>{c.tJunction.toFixed(1)} °C</td>
                    <td className="dim">{c.tjMax ?? 125} °C</td>
                    <td>
                      <StatusChip status={c.status} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'structural':
    case 'drop': {
      const s = run.kind === 'drop' ? (result as DropResult).structural : (result as StructuralResult);
      const empty: Project = { ...project, boards: [], mechanical: [], assembly: { instances: [], fasteners: [] }, interconnects: [] };
      return (
        <div className="flex flex-col gap-3">
          <div className="card relative h-[460px] overflow-hidden">
            <Assembly3D project={empty} getMesh={getMesh} overlay={{ structural: s }} />
          </div>
          {run.kind === 'drop' && <DropTable r={result as DropResult} />}
          <div className="text-[12px] dim">
            Loads: {s.loads.join('; ') || '—'} · Fixtures: {s.fixtures.join('; ') || '—'} · {s.solver.dofs.toLocaleString()} DOF, {s.solver.iterations} iterations
          </div>
        </div>
      );
    }
    case 'airflow': {
      const r = result as AirflowResult;
      return (
        <div className="flex flex-col gap-3">
          <div className="card relative h-[460px] overflow-hidden">
            <Assembly3D project={project} getMesh={getMesh} xray overlay={{ airflow: r }} showFasteners={false} />
          </div>
          <table className="grid-table card overflow-hidden">
            <thead>
              <tr>
                <th>Component</th>
                <th>Power</th>
                <th>Temperature</th>
              </tr>
            </thead>
            <tbody>
              {r.components.map((c) => (
                <tr key={c.componentId}>
                  <td className="font-medium">{c.ref}</td>
                  <td>{formatValue(c.power, 'W')}</td>
                  <td>{c.temperature.toFixed(1)} °C</td>
                </tr>
              ))}
              {r.vents.map((v) => (
                <tr key={v.name}>
                  <td className="dim">Vent {v.name}</td>
                  <td className="dim">{v.direction}</td>
                  <td className="dim">{(v.flowM3s * 60000).toFixed(2)} L/min</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
}

function OpView({ r, project }: { r: CircuitOpResult; project: Project }) {
  const refs = new Map<string, string>();
  for (const b of project.boards) for (const c of b.components) refs.set(c.id, project.boards.length > 1 ? `${b.name}/${c.ref}` : c.ref);
  const power = Object.entries(r.componentPower)
    .filter(([, p]) => p > 1e-7)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24);
  const max = power[0]?.[1] ?? 1;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="card p-3">
        <div className="label mb-2">Node voltages</div>
        <div className="grid max-h-96 grid-cols-2 gap-x-4 gap-y-1 overflow-y-auto text-[12.5px]">
          {Object.entries(r.nodeVoltages)
            .sort((a, b) => (r.netNames[a[0]] ?? '').localeCompare(r.netNames[b[0]] ?? ''))
            .map(([id, v]) => (
              <div key={id} className="flex justify-between gap-2 border-b border-[var(--border)] py-0.5">
                <span className="truncate dim">{r.netNames[id] ?? id}</span>
                <span className="mono">{v.toFixed(3)} V</span>
              </div>
            ))}
        </div>
      </div>
      <div className="card p-3">
        <div className="label mb-2">Power dissipation</div>
        <div className="flex flex-col gap-1.5">
          {power.map(([id, p]) => (
            <div key={id} className="flex items-center gap-2 text-[12px]">
              <span className="w-20 shrink-0 truncate font-medium">{refs.get(id) ?? id}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--bg-sunken)]">
                <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(2, (p / max) * 100)}%` }} />
              </div>
              <span className="mono w-20 shrink-0 text-right">{formatValue(p, 'W')}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DropTable({ r }: { r: DropResult }) {
  const rows = r.componentRisks.filter((c) => c.risk !== 'low').slice(0, 20);
  return (
    <div className="card p-3 text-[12.5px]">
      <div className="mb-2 flex flex-wrap gap-3">
        <span>
          Impact <b>{r.impactVelocity.toFixed(2)} m/s</b>
        </span>
        <span>
          Peak <b>{r.peakG.toFixed(0)} g</b>
        </span>
        <span>
          Force <b>{r.peakForceN.toFixed(0)} N</b>
        </span>
        <span>
          Contact <b>{r.contactDurationMs.toFixed(2)} ms</b>
        </span>
        <span className="dim">{r.method}</span>
      </div>
      {rows.length ? (
        <table className="grid-table">
          <thead>
            <tr>
              <th>Component</th>
              <th>Mass</th>
              <th>Inertial force</th>
              <th>Risk</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.componentId}>
                <td className="font-medium">{c.ref}</td>
                <td>{c.massGrams.toFixed(2)} g</td>
                <td>{c.inertialForceN.toFixed(1)} N</td>
                <td>
                  <span className={`chip ${c.risk === 'high' ? 'chip-err' : 'chip-warn'}`}>{c.risk}</span>
                </td>
                <td className="dim">{c.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="dim">All components low risk.</div>
      )}
    </div>
  );
}

export { toFloat32 };
