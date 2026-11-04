import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Project, SimMetric } from '@pcbcad/core';
import { useApp } from '../store';

export function Stat({ label, value, sub, icon: Icon, tone }: { label: string; value: ReactNode; sub?: ReactNode; icon?: LucideIcon; tone?: 'ok' | 'warn' | 'err' | 'accent' }) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'err' ? 'var(--err)' : tone === 'accent' ? 'var(--accent)' : 'var(--text)';
  return (
    <div className="card flex min-w-0 flex-col gap-1 px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[11.5px] dim">
        {Icon && <Icon size={12} />}
        {label}
      </div>
      <div className="truncate text-[20px] font-semibold tracking-tight" style={{ color }}>
        {value}
      </div>
      {sub && <div className="truncate text-[11px] faint">{sub}</div>}
    </div>
  );
}

export function Section({ title, actions, children, className = '' }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3.5 py-2.5">
        <h3 className="flex-1 text-[13px] font-semibold">{title}</h3>
        {actions}
      </div>
      <div>{children}</div>
    </section>
  );
}

export function EmptyState({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid h-full min-h-[240px] place-items-center p-8 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-3 grid size-11 place-items-center rounded-2xl bg-[var(--bg-sunken)] text-[var(--text-dim)]">
          <Icon size={20} />
        </div>
        <div className="text-[14px] font-semibold">{title}</div>
        {text && <div className="mt-1 text-[12.5px] dim">{text}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}

export function StatusChip({ status }: { status?: 'ok' | 'warn' | 'fail' | boolean }) {
  if (status === undefined) return null;
  const s = status === true ? 'ok' : status === false ? 'fail' : status;
  return <span className={`chip ${s === 'ok' ? 'chip-ok' : s === 'warn' ? 'chip-warn' : 'chip-err'}`}>{s === 'ok' ? 'Pass' : s === 'warn' ? 'Check' : 'Fail'}</span>;
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-sunken)]">
      <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300" style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function fmtNum(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.001 || a >= 1e6)) return v.toExponential(2);
  return String(+v.toPrecision(digits));
}

export function MetricTiles({ metrics }: { metrics: SimMetric[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
      {metrics.map((m) => (
        <div key={m.label} className="rounded-xl border border-[var(--border)] bg-[var(--bg-sunken)] px-3 py-2">
          <div className="truncate text-[11px] dim" title={m.label}>
            {m.label}
          </div>
          <div className="mt-0.5 flex items-baseline gap-1">
            <span className="text-[16px] font-semibold" style={{ color: m.status === 'fail' ? 'var(--err)' : m.status === 'warn' ? 'var(--warn)' : undefined }}>
              {fmtNum(m.value)}
            </span>
            <span className="text-[11px] faint">{m.unit}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function BoardPicker({ project }: { project: Project }) {
  const boardId = useApp((s) => s.boardId);
  const setBoard = useApp((s) => s.setBoard);
  if (project.boards.length <= 1) return project.boards[0] ? <span className="chip">{project.boards[0].name}</span> : null;
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg-sunken)] p-0.5">
      {project.boards.map((b) => (
        <button key={b.id} onClick={() => setBoard(b.id)} className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition ${b.id === boardId ? 'bg-[var(--bg-elev)] shadow-[var(--shadow)]' : 'dim hover:text-[var(--text)]'}`}>
          {b.name}
        </button>
      ))}
    </div>
  );
}

export function useBoard() {
  const project = useApp((s) => s.project);
  const boardId = useApp((s) => s.boardId);
  return project?.boards.find((b) => b.id === boardId) ?? project?.boards[0];
}
