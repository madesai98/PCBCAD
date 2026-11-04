import { useMemo } from 'react';
import type { PcbThermalResult } from '@pcbcad/core';
import { Flame, Thermometer, Wind, Zap } from 'lucide-react';
import { ColorLegend } from './ColorLegend';
import { MetricPill } from './MetricPill';
import { colormapCss } from './common/colormaps';
import { fmtQuantity, fmtTemp } from './common/format';
import { cx } from './common/ui';

export interface ThermalSummaryCardProps {
  result: PcbThermalResult;
  title?: string;
  /** Max component rows (default 6). */
  maxRows?: number;
  selectedId?: string | null;
  onSelectComponent?: (componentId: string) => void;
  className?: string;
}

const STATUS_TEXT = { ok: 'text-emerald-500', warn: 'text-amber-500', fail: 'text-red-500' } as const;

/** Summary of a PCB thermal run: headline metrics, hottest components, trace current hot spots, IR drop. */
export function ThermalSummaryCard({ result, title = 'PCB thermal', maxRows = 6, selectedId, onSelectComponent, className }: ThermalSummaryCardProps) {
  const comps = useMemo(() => [...result.components].sort((a, b) => b.tJunction - a.tJunction), [result.components]);
  const worst = comps[0];
  const overall = comps.some((c) => c.status === 'fail') ? 'fail' : comps.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  const traceStats = useMemo(() => {
    let warn = 0;
    let fail = 0;
    let top = result.traces[0];
    for (const t of result.traces) {
      if (t.status === 'warn') warn++;
      if (t.status === 'fail') fail++;
      if (!top || t.currentDensity > top.currentDensity) top = t;
    }
    return { warn, fail, top };
  }, [result.traces]);
  const tMin = result.ambient;
  const tMax = Math.max(result.maxTemp, tMin + 1);

  return (
    <div className={cx('flex flex-col gap-4 rounded-xl border border-(--border) bg-(--bg-elev) p-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-orange-500/12 text-orange-500">
            <Flame className="h-4 w-4" />
          </span>
          <div>
            <div className="text-[13.5px] font-semibold text-(--text)">{title}</div>
            <div className="text-[11.5px] text-(--text-dim)">
              {worst ? (
                <>
                  Hottest <span className="font-medium text-(--text)">{worst.ref}</span> at{' '}
                  <span className={cx('font-medium', STATUS_TEXT[worst.status])}>{fmtTemp(worst.tJunction)}</span>
                </>
              ) : (
                'No powered components'
              )}
            </div>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-(--border) px-2 py-0.5 text-[11px] text-(--text-dim)">
          <Wind className="h-3 w-3" />
          {result.convection.mode === 'forced' ? `Forced ${result.convection.airVelocity ?? '?'} m/s` : 'Natural convection'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricPill label="Max temp" value={result.maxTemp} unit="°C" status={overall} />
        <MetricPill label="Total power" value={result.totalPower} unit="W" />
        <MetricPill label="Ambient" value={result.ambient} unit="°C" />
        <MetricPill
          label="Trace hot spots"
          value={traceStats.warn + traceStats.fail}
          status={traceStats.fail ? 'fail' : traceStats.warn ? 'warn' : 'ok'}
        />
      </div>

      <ColorLegend min={tMin} max={tMax} unit="°C" map="turbo" title="Board temperature" length={undefined} className="max-w-none" />

      {comps.length > 0 && (
        <div className="flex flex-col">
          <div className="mb-1 grid grid-cols-[52px_1fr_64px_70px] items-center gap-2 px-1 text-[10.5px] uppercase tracking-wide text-(--text-dim)">
            <span>Ref</span>
            <span>Junction vs limit</span>
            <span className="text-right">Power</span>
            <span className="text-right">T<sub>j</sub></span>
          </div>
          {comps.slice(0, maxRows).map((c) => {
            const limit = c.tjMax ?? 125;
            const frac = Math.max(0.02, Math.min(1, (c.tJunction - tMin) / Math.max(1, limit - tMin)));
            return (
              <button
                key={c.componentId}
                type="button"
                onClick={() => onSelectComponent?.(c.componentId)}
                className={cx(
                  'grid grid-cols-[52px_1fr_64px_70px] items-center gap-2 rounded-md px-1 py-1 text-left text-[12px] transition-colors hover:bg-(--bg-sunken)',
                  selectedId === c.componentId && 'bg-accent-500/10',
                )}
              >
                <span className="font-mono font-medium text-(--text)">{c.ref}</span>
                <span className="relative h-1.5 overflow-hidden rounded-full bg-(--bg-sunken)">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ width: `${frac * 100}%`, background: colormapCss('turbo', (c.tJunction - tMin) / (tMax - tMin)) }}
                  />
                </span>
                <span className="text-right font-mono tabular-nums text-(--text-dim)">{fmtQuantity(c.power, 'W', 2)}</span>
                <span className={cx('text-right font-mono tabular-nums', STATUS_TEXT[c.status])}>{c.tJunction.toFixed(1)}°</span>
              </button>
            );
          })}
        </div>
      )}

      {(traceStats.top || (result.netDrops && result.netDrops.length > 0)) && (
        <div className="grid gap-2 border-t border-(--border) pt-3 text-[12px] sm:grid-cols-2">
          {traceStats.top && (
            <div className="flex items-start gap-2">
              <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <div className="min-w-0 text-(--text-dim)">
                Peak density <span className="font-mono text-(--text)">{fmtQuantity(traceStats.top.currentDensity, 'A/mm²', 3)}</span>
                <br />
                {fmtQuantity(traceStats.top.current, 'A')} · ΔT {traceStats.top.tempRise.toFixed(1)} °C · cap {fmtQuantity(traceStats.top.ipcCapacity, 'A')}
              </div>
            </div>
          )}
          {result.netDrops && result.netDrops.length > 0 && (
            <div className="flex items-start gap-2">
              <Thermometer className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-500" />
              <div className="flex min-w-0 flex-col text-(--text-dim)">
                {result.netDrops.slice(0, 3).map((d) => (
                  <span key={d.netId} className="truncate">
                    <span className="font-medium text-(--text)">{d.name}</span> IR drop{' '}
                    <span className="font-mono text-(--text)">{fmtQuantity(d.maxDrop, 'V')}</span> @ {fmtQuantity(d.current, 'A')}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
