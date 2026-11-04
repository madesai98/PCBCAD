import type { MetricStatus, SimSummary } from '@pcbcad/core';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { fmtQuantity } from './common/format';
import { cx } from './common/ui';

export interface MetricPillProps {
  label: string;
  value: number | string;
  unit?: string;
  status?: MetricStatus;
  /** Limit the value was compared against (shown as "/ limit"). */
  limit?: number;
  digits?: number;
  size?: 'sm' | 'md';
  className?: string;
  title?: string;
}

const STATUS_DOT: Record<MetricStatus, string> = {
  ok: 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,.18)]',
  warn: 'bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,.2)]',
  fail: 'bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,.2)]',
};

/** Compact label/value chip. Spread a SimMetric straight into it: <MetricPill {...metric} />. */
export function MetricPill({ label, value, unit = '', status, limit, digits = 3, size = 'sm', className, title }: MetricPillProps) {
  const text = typeof value === 'number' ? fmtQuantity(value, unit, digits) : unit ? `${value} ${unit}` : value;
  return (
    <div
      title={title ?? (limit !== undefined ? `${label}: ${text} (limit ${fmtQuantity(limit, unit, digits)})` : `${label}: ${text}`)}
      className={cx(
        'inline-flex min-w-0 items-center gap-2 rounded-lg border border-(--border) bg-(--bg-elev)',
        size === 'md' ? 'px-3 py-2' : 'px-2.5 py-1.5',
        className,
      )}
    >
      {status && <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[status])} />}
      <div className="flex min-w-0 flex-col leading-tight">
        <span className={cx('truncate text-(--text-dim)', size === 'md' ? 'text-[11px]' : 'text-[10px] uppercase tracking-wide')}>{label}</span>
        <span className={cx('truncate font-mono tabular-nums text-(--text)', size === 'md' ? 'text-[15px] font-semibold' : 'text-[12.5px] font-medium')}>
          {text}
          {limit !== undefined && <span className="ml-1 text-[10.5px] font-normal text-(--text-dim)">/ {fmtQuantity(limit, unit, digits)}</span>}
        </span>
      </div>
    </div>
  );
}

export interface SimSummaryCardProps {
  summary: SimSummary;
  title?: string;
  className?: string;
}

/** Headline + metric pills + warnings for any SimulationRun.summary. */
export function SimSummaryCard({ summary, title, className }: SimSummaryCardProps) {
  const Icon = summary.pass === false ? XCircle : summary.warnings.length ? AlertTriangle : CheckCircle2;
  const tone = summary.pass === false ? 'text-red-500' : summary.warnings.length ? 'text-amber-500' : 'text-emerald-500';
  return (
    <div className={cx('flex flex-col gap-3 rounded-xl border border-(--border) bg-(--bg-elev) p-4', className)}>
      <div className="flex items-start gap-2.5">
        <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', tone)} />
        <div className="min-w-0">
          {title && <div className="text-[11px] font-medium uppercase tracking-wide text-(--text-dim)">{title}</div>}
          <div className="text-[13.5px] font-medium text-(--text)">{summary.headline}</div>
        </div>
      </div>
      {summary.metrics.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2">
          {summary.metrics.map((m, i) => (
            <MetricPill key={i} {...m} />
          ))}
        </div>
      )}
      {summary.warnings.length > 0 && (
        <ul className="flex flex-col gap-1">
          {summary.warnings.map((w, i) => (
            <li key={i} className="flex gap-2 text-[12px] text-(--text-dim)">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
