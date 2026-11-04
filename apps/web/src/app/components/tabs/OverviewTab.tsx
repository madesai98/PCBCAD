import { useMemo } from 'react';
import {
  Activity,
  ArrowDownToLine,
  Bot,
  Boxes,
  Cable,
  CircuitBoard,
  CircleAlert,
  Cpu,
  DollarSign,
  Hammer,
  Loader2,
  ShieldCheck,
  StickyNote,
  Terminal,
  Thermometer,
  User,
  Wind,
} from 'lucide-react';
import { buildBom, getMaterial, interconnectLabel, type SimKind, type SimulationRun } from '@pcbcad/core';
import { useApp } from '../../store';
import { timeAgo } from '../Sidebar';
import { EmptyState, Progress, Section, Stat, StatusChip } from '../ui';
import { Markdown } from '../Markdown';

export const SIM_META: Record<SimKind, { label: string; icon: typeof Activity }> = {
  'circuit-op': { label: 'DC operating point', icon: Activity },
  'circuit-transient': { label: 'Transient', icon: Activity },
  'mixed-signal': { label: 'Firmware in the loop', icon: Terminal },
  'pcb-thermal': { label: 'PCB thermal', icon: Thermometer },
  structural: { label: 'Stress', icon: Hammer },
  drop: { label: 'Drop test', icon: ArrowDownToLine },
  airflow: { label: 'Airflow & heat', icon: Wind },
};

export function OverviewTab() {
  const project = useApp((s) => s.project)!;
  const progress = useApp((s) => s.simProgress);
  const setTab = useApp((s) => s.setTab);
  const setBoard = useApp((s) => s.setBoard);
  const select = useApp((s) => s.select);
  const bom = useMemo(() => buildBom(project), [project]);
  const comps = project.boards.reduce((n, b) => n + b.components.length, 0);
  const errors = project.issues.filter((i) => i.severity === 'error');
  const warnings = project.issues.filter((i) => i.severity === 'warning');
  const latest = useMemo(() => {
    const m = new Map<SimKind, SimulationRun>();
    for (const s of project.simulations) m.set(s.kind, s);
    return [...m.values()];
  }, [project.simulations]);
  const passed = latest.filter((s) => s.summary?.pass).length;

  if (!project.boards.length && !project.mechanical.length && !project.activity.length)
    return (
      <EmptyState
        icon={Bot}
        title="Nothing designed yet"
        text="Describe your product in the chat. The agent's work — parts, schematics, boards, enclosures, simulations — appears here live as it happens."
      />
    );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-4 lg:p-5">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">{project.name}</h1>
          {project.description && <p className="mt-0.5 text-[13px] dim">{project.description}</p>}
          <div className="mt-1 text-[11px] faint">
            Revision {project.revision} · updated {timeAgo(project.updatedAt)}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Boards" icon={CircuitBoard} value={project.boards.length} sub={`${project.interconnects.length} interconnect${project.interconnects.length === 1 ? '' : 's'}`} />
          <Stat label="Components" icon={Cpu} value={comps} sub={`${Object.keys(project.parts).length} unique parts`} />
          <Stat label="BOM / unit" icon={DollarSign} value={`$${bom.total.toFixed(2)}`} sub={`@ ${project.settings.buildQuantity} pcs${bom.unpriced ? ` · ${bom.unpriced} unpriced` : ''}`} />
          <Stat label="Mechanical" icon={Boxes} value={project.mechanical.length} sub={`${project.assembly.fasteners.length} fasteners`} />
          <Stat label="Simulations" icon={Activity} value={`${passed}/${latest.length}`} sub="latest per type passing" tone={latest.length && passed === latest.length ? 'ok' : latest.some((s) => s.summary?.pass === false) ? 'warn' : undefined} />
          <Stat label="Issues" icon={ShieldCheck} value={errors.length} sub={`${warnings.length} warnings`} tone={errors.length ? 'err' : warnings.length ? 'warn' : 'ok'} />
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <div className="flex min-w-0 flex-col gap-4">
            {project.requirements.length > 0 && (
              <Section title="Requirements">
                <ul className="flex flex-col gap-1 px-4 py-3 text-[13px]">
                  {project.requirements.map((r) => (
                    <li key={r} className="flex gap-2">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                      {r}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            <Section title="Verification">
              {latest.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12.5px] dim">No simulations yet.</div>
              ) : (
                <div className="grid gap-2 p-3 sm:grid-cols-2">
                  {latest.map((s) => {
                    const meta = SIM_META[s.kind];
                    const Icon = meta.icon;
                    const live = progress[s.id];
                    return (
                      <button
                        key={s.id}
                        className="flex flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg-sunken)] p-3 text-left transition hover:border-[var(--border-strong)]"
                        onClick={() => {
                          select({ kind: 'sim', runId: s.id });
                          setTab('simulation');
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <Icon size={14} className="text-[var(--accent)]" />
                          <span className="flex-1 text-[12.5px] font-medium">{meta.label}</span>
                          {s.status === 'running' ? <Loader2 size={13} className="animate-spin" /> : s.status === 'error' ? <span className="chip chip-err">Error</span> : <StatusChip status={s.summary?.pass} />}
                        </div>
                        <div className="line-clamp-2 text-[12px] dim">{s.status === 'running' ? (live?.message ?? 'Running…') : (s.summary?.headline ?? s.error ?? '')}</div>
                        {s.status === 'running' && <Progress value={live?.progress ?? s.progress ?? 0} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </Section>
            <Section title="Hardware">
              <div className="flex flex-col divide-y divide-[var(--border)]">
                {project.boards.map((b) => {
                  const xs = b.outline.map((p) => p[0]);
                  const ys = b.outline.map((p) => p[1]);
                  const routed = b.traces.length > 0;
                  return (
                    <button
                      key={b.id}
                      className="flex items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--bg-hover)]"
                      onClick={() => {
                        setBoard(b.id);
                        setTab('pcb');
                      }}
                    >
                      <span className="grid size-8 place-items-center rounded-lg" style={{ background: maskColor(b.stackup.maskColor), color: '#e9e2c8' }}>
                        <CircuitBoard size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium">{b.name}</span>
                        <span className="block truncate text-[11.5px] dim">
                          {(Math.max(...xs) - Math.min(...xs)).toFixed(1)} × {(Math.max(...ys) - Math.min(...ys)).toFixed(1)} mm · {b.stackup.layers}-layer · {b.components.length} parts · {b.nets.length} nets
                        </span>
                      </span>
                      <span className={`chip ${routed ? 'chip-ok' : ''}`}>{routed ? `${b.traces.length} traces` : 'unrouted'}</span>
                    </button>
                  );
                })}
                {project.interconnects.map((ic) => (
                  <div key={ic.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="grid size-8 place-items-center rounded-lg bg-[var(--bg-sunken)] text-[var(--accent)]">
                      <Cable size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium">{ic.name}</span>
                      <span className="block truncate text-[11.5px] dim">
                        {interconnectLabel(project, ic)} · {ic.kind} · {ic.conductors.length} conductors{ic.length ? ` · ${ic.length} mm` : ''}
                        {ic.awg ? ` AWG${ic.awg}` : ''}
                      </span>
                    </span>
                  </div>
                ))}
                {project.mechanical.map((m) => (
                  <button
                    key={m.id}
                    className="flex items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--bg-hover)]"
                    onClick={() => {
                      select({ kind: 'mech', partId: m.id });
                      setTab('assembly');
                    }}
                  >
                    <span className="grid size-8 place-items-center rounded-lg border border-[var(--border)]" style={{ background: m.color ?? getMaterial(m.materialId)?.color }}>
                      <Boxes size={15} className="text-black/50" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium">{m.name}</span>
                      <span className="block truncate text-[11.5px] dim">
                        {getMaterial(m.materialId)?.name ?? m.materialId} · {m.process.replace(/-/g, ' ')}
                        {m.kind === 'enclosure-shell' ? ` · ${m.outer.width}×${m.outer.depth}×${m.outer.height} mm, ${m.wall} mm wall` : m.kind === 'sheet-metal' ? ` · ${m.thickness} mm, ${m.flanges.length} bends` : ''}
                      </span>
                    </span>
                  </button>
                ))}
                {!project.boards.length && !project.mechanical.length && <div className="px-4 py-6 text-center text-[12.5px] dim">No hardware yet.</div>}
              </div>
            </Section>
            {project.notes.length > 0 && (
              <Section title={<span className="flex items-center gap-1.5"><StickyNote size={13} /> Design decisions</span>}>
                <div className="flex flex-col divide-y divide-[var(--border)]">
                  {[...project.notes].reverse().map((n) => (
                    <div key={n.id} className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="flex-1 text-[13px] font-medium">{n.title}</span>
                        <span className="text-[11px] faint">{timeAgo(n.at)}</span>
                      </div>
                      <div className="mt-1 text-[12.5px] dim">
                        <Markdown text={n.text} />
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <Section title={<span className="flex items-center gap-1.5"><CircleAlert size={13} /> Open issues</span>} actions={<button className="btn btn-ghost btn-sm" onClick={() => setTab('manufacturing')}>All</button>}>
              {project.issues.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12.5px] dim">No issues recorded. Run checks to verify.</div>
              ) : (
                <div className="flex max-h-72 flex-col divide-y divide-[var(--border)] overflow-y-auto">
                  {[...errors, ...warnings].slice(0, 30).map((i) => (
                    <div key={i.id} className="flex gap-2 px-4 py-2 text-[12px]">
                      <span className={`chip ${i.severity === 'error' ? 'chip-err' : 'chip-warn'} shrink-0`}>{i.category}</span>
                      <span className="min-w-0 flex-1">{i.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </Section>
            <Section title="Activity">
              <div className="flex max-h-[560px] flex-col overflow-y-auto py-1">
                {[...project.activity]
                  .reverse()
                  .slice(0, 80)
                  .map((a) => (
                    <div key={a.id} className="flex items-start gap-2.5 px-4 py-1.5 text-[12px]">
                      <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-md ${a.actor === 'agent' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-[var(--bg-sunken)] dim'}`}>
                        {a.actor === 'agent' ? <Bot size={11} /> : a.actor === 'user' ? <User size={11} /> : <Activity size={11} />}
                      </span>
                      <span className="min-w-0 flex-1 leading-snug">{a.summary}</span>
                      <span className="shrink-0 text-[10.5px] faint">{timeAgo(a.at)}</span>
                    </div>
                  ))}
              </div>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

export function maskColor(c: string): string {
  return ({ green: '#1f5f3a', black: '#16181b', blue: '#1d3f7a', red: '#7a1f24', white: '#e8e8e8', purple: '#4b2a6b', yellow: '#b59a1c' } as Record<string, string>)[c] ?? '#1f5f3a';
}
