import { useMemo } from 'react';
import { colormapGradient, type ColormapName } from './common/colormaps';
import { fmtQuantity, niceTicks } from './common/format';
import { cx } from './common/ui';

export interface ColorLegendProps {
  min: number;
  max: number;
  unit: string;
  map: ColormapName;
  /** Optional caption shown above the bar, e.g. "Temperature". */
  title?: string;
  /** Bar orientation (default horizontal). Vertical legends grow upward (max at the top). */
  orientation?: 'horizontal' | 'vertical';
  /** Approximate number of tick labels (default 4). */
  ticks?: number;
  /** Optional marker value (e.g. a limit) drawn as a notch on the bar. */
  marker?: { value: number; label?: string };
  className?: string;
  /** Pixel length of the bar (default: 100% of the container up to 260 px). */
  length?: number;
}

/** Continuous colour scale legend for heatmaps (turbo / inferno). */
export function ColorLegend({ min, max, unit, map, title, orientation = 'horizontal', ticks = 4, marker, className, length }: ColorLegendProps) {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) && max > lo ? max : lo + 1;
  const tickValues = useMemo(() => {
    // Interior nice ticks, kept clear of the end labels and of each other.
    const span = hi - lo;
    const inner: number[] = [];
    for (const v of niceTicks(lo, hi, ticks)) {
      const f = (v - lo) / span;
      if (f < 0.2 || f > 0.8) continue;
      if (inner.length && (v - inner[inner.length - 1]) / span < 0.18) continue;
      inner.push(v);
    }
    return [lo, ...inner, hi];
  }, [lo, hi, ticks]);
  const pos = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const label = (v: number) => fmtQuantity(v, unit, 3).replace(` ${unit}`, '');

  if (orientation === 'vertical') {
    return (
      <div className={cx('flex flex-col gap-1 text-(--text-dim)', className)}>
        {title && <div className="text-[11px] font-medium text-(--text)">{title}</div>}
        <div className="flex gap-1.5" style={{ height: length ?? 140 }}>
          <div className="relative w-2.5 rounded-full ring-1 ring-black/10 dark:ring-white/10" style={{ background: colormapGradient(map, 'to top') }}>
            {marker && Number.isFinite(marker.value) && (
              <div className="absolute -right-1 -left-1 h-0.5 bg-(--text)" style={{ bottom: `${Math.max(0, Math.min(100, pos(marker.value)))}%` }} />
            )}
          </div>
          <div className="relative w-12 font-mono text-[10px] leading-none tabular-nums">
            {tickValues.map((v, i) => (
              <span key={i} className="absolute left-0 whitespace-nowrap" style={{ bottom: `${pos(v)}%`, transform: i === 0 ? 'none' : i === tickValues.length - 1 ? 'translateY(100%)' : 'translateY(50%)' }}>
                {label(v)}
              </span>
            ))}
          </div>
        </div>
        <div className="font-mono text-[10px]">{unit}</div>
      </div>
    );
  }

  return (
    <div className={cx('flex flex-col gap-1 text-(--text-dim)', className)} style={{ width: length ?? '100%', maxWidth: length ?? 260 }}>
      {(title || unit) && (
        <div className="flex items-baseline justify-between gap-2 text-[11px]">
          <span className="font-medium text-(--text)">{title}</span>
          <span className="font-mono text-[10px]">{unit}</span>
        </div>
      )}
      <div className="relative h-2 rounded-full ring-1 ring-black/10 dark:ring-white/10" style={{ background: colormapGradient(map) }}>
        {marker && Number.isFinite(marker.value) && (
          <div
            className="absolute -top-1 -bottom-1 w-0.5 rounded bg-(--text)"
            title={marker.label}
            style={{ left: `${Math.max(0, Math.min(100, pos(marker.value)))}%` }}
          />
        )}
      </div>
      <div className="relative h-3 font-mono text-[10px] tabular-nums">
        {tickValues.map((v, i) => (
          <span
            key={i}
            className="absolute top-0 whitespace-nowrap"
            style={{
              left: `${pos(v)}%`,
              transform: i === 0 ? 'none' : i === tickValues.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            {label(v)}
          </span>
        ))}
      </div>
    </div>
  );
}
