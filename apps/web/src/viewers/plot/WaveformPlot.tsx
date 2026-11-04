import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '../viewers.css';
import type { NumArray, Waveform } from '@pcbcad/core';
import { formatValue, toFloat32, toNumbers } from '@pcbcad/core';
import { withAlpha } from '../common/color';
import { fmtTime } from '../common/format';
import { useElementSize } from '../common/hooks';
import { useViewerTheme, type ViewerTheme } from '../common/theme';
import { cx } from '../common/ui';

export interface WaveformPlotProps {
  time: NumArray | ArrayLike<number>;
  signals: Waveform[];
  /** Height of the analog chart in px (digital lanes add ~24 px per signal). Default 280. */
  height?: number;
  title?: string;
  /** Cursor/zoom sync group shared with other plots. */
  syncKey?: string;
  className?: string;
}

function toTyped(a: NumArray | ArrayLike<number>): ArrayLike<number> {
  if (Array.isArray(a) || ArrayBuffer.isView(a)) return a as ArrayLike<number>;
  if (a && typeof a === 'object' && 'b64' in (a as object)) return toNumbers(a as NumArray);
  return a as ArrayLike<number>;
}

const axisFont = (theme: ViewerTheme) => `11px ${theme.fontSans}`;

/** "~RESET" → R̅E̅S̅E̅T̅ (combining overline) for canvas-rendered labels. */
export function overbar(name: string): string {
  return name.replace(/~\{([^}]*)\}|~([^\s/·,]+)/g, (_m, a: string | undefined, b: string | undefined) => [...(a ?? b ?? '')].map((c) => c + '\u0305').join(''));
}

let syncSeq = 0;

/**
 * Time-domain plot (uPlot): analog signals grouped into one y-axis per unit (left/right),
 * digital signals as stepped lanes in a second, cursor- and zoom-synchronised chart.
 * Drag to zoom, double-click to reset.
 */
export function WaveformPlot({ time, signals, height = 280, title, syncKey, className }: WaveformPlotProps) {
  const [setRef, size, ref] = useElementSize<HTMLDivElement>();
  const theme = useViewerTheme(ref);
  const analogRef = useRef<HTMLDivElement>(null);
  const digitalRef = useRef<HTMLDivElement>(null);
  const plots = useRef<uPlot[]>([]);
  const key = useMemo(() => syncKey ?? `pv-wave-${++syncSeq}`, [syncKey]);

  const data = useMemo(() => {
    const t = toTyped(time);
    const analog = signals.filter((s) => s.kind !== 'digital');
    const digital = signals.filter((s) => s.kind === 'digital');
    const units = [...new Set(analog.map((s) => s.unit || ''))];
    const xs = Array.from(t);
    const aData: uPlot.AlignedData = [xs, ...analog.map((s) => Array.from(toFloat32(s.data)) as (number | null)[])] as uPlot.AlignedData;
    const lanes = digital.length;
    const dData: uPlot.AlignedData = [
      xs,
      ...digital.map((s, i) => {
        const base = lanes - 1 - i;
        return Array.from(toFloat32(s.data), (v) => (Number.isFinite(v) ? base + 0.18 + (v > 0.5 ? 0.6 : v < 0 ? 0.3 : 0) : null));
      }),
    ] as uPlot.AlignedData;
    return { analog, digital, units, aData, dData, lanes };
  }, [time, signals]);

  useEffect(() => {
    const width = size.width;
    if (width < 50) return;
    for (const p of plots.current) p.destroy();
    plots.current = [];
    const grid = theme.dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.07)';
    const axisStroke = theme.textDim;
    const colorOf = (i: number) => theme.series[i % theme.series.length];
    const xAxis: uPlot.Axis = {
      scale: 'x',
      stroke: axisStroke,
      font: axisFont(theme),
      grid: { stroke: grid, width: 1 },
      ticks: { stroke: grid, width: 1, size: 4 },
      size: 28,
      values: (_u, splits) => splits.map((v) => fmtTime(v, 3)),
    };
    let syncing = false;
    const syncScale = (u: uPlot) => {
      if (syncing) return;
      syncing = true;
      const { min, max } = u.scales.x;
      for (const p of plots.current) if (p !== u && min != null && max != null) p.setScale('x', { min, max });
      syncing = false;
    };
    const created: uPlot[] = [];
    if (data.analog.length && analogRef.current) {
      const opts: uPlot.Options = {
        width,
        height,
        padding: [12, 10, 2, 2],
        cursor: { sync: { key, setSeries: false }, drag: { x: true, y: false, setScale: true }, points: { size: 7 }, focus: { prox: 24 } },
        focus: { alpha: 0.35 },
        legend: { show: true, live: true },
        scales: { x: { time: false }, ...Object.fromEntries(data.units.map((u) => [u || '_', { auto: true }])) },
        axes: [
          xAxis,
          ...data.units.map(
            (unit, i): uPlot.Axis => ({
              scale: unit || '_',
              side: i % 2 === 0 ? 3 : 1,
              // Narrow layouts keep the first two unit axes; the rest stay in the legend.
              show: i < 2 || width >= 560,
              stroke: data.units.length > 1 ? colorOf(data.analog.findIndex((s) => (s.unit || '') === unit)) : axisStroke,
              font: axisFont(theme),
              size: (self, values) => {
                if (!values?.length) return 40;
                const longest = values.reduce((m, v) => Math.max(m, String(v).length), 0);
                return Math.max(36, Math.min(80, 14 + longest * 6.6));
              },
              gap: 4,
              grid: { show: i === 0, stroke: grid, width: 1 },
              ticks: { stroke: grid, width: 1, size: 4 },
              values: (_u, splits) => splits.map((v) => formatValue(v, unit, 3)),
            }),
          ),
        ],
        series: [
          { label: 't', value: (_u, v) => (v == null ? '—' : fmtTime(v, 4)) },
          ...data.analog.map(
            (s, i): uPlot.Series => ({
              label: overbar(s.name),
              scale: s.unit || '_',
              stroke: colorOf(i),
              width: 1.6,
              points: { show: false },
              value: (_u, v) => (v == null ? '—' : formatValue(v, s.unit, 4)),
            }),
          ),
        ],
        hooks: { setScale: [(u, k) => k === 'x' && syncScale(u)] },
      };
      created.push(new uPlot(opts, data.aData, analogRef.current));
    }
    if (data.digital.length && digitalRef.current) {
      const lanes = data.lanes;
      const stepped = uPlot.paths.stepped!({ align: 1 });
      const opts: uPlot.Options = {
        width,
        height: lanes * 24 + 34,
        padding: [6, 10, 2, 2],
        cursor: { sync: { key, setSeries: false }, drag: { x: true, y: false, setScale: true }, points: { show: false } },
        legend: { show: false },
        scales: { x: { time: false }, d: { range: [0, lanes] } },
        axes: [
          xAxis,
          {
            scale: 'd',
            side: 3,
            stroke: axisStroke,
            font: `500 11px ${theme.fontMono}`,
            size: Math.min(150, 14 + Math.max(...data.digital.map((s) => s.name.length)) * 7),
            gap: 6,
            grid: { show: false },
            ticks: { show: false },
            splits: () => data.digital.map((_, i) => lanes - 1 - i + 0.48),
            values: (_u, splits) => splits.map((v) => overbar(data.digital[lanes - 1 - Math.floor(v)]?.name ?? '')),
          },
        ],
        series: [
          {},
          ...data.digital.map(
            (s, i): uPlot.Series => ({
              label: s.name,
              scale: 'd',
              stroke: colorOf(i + data.analog.length),
              width: 1.5,
              paths: stepped,
              points: { show: false },
              fill: withAlpha(colorOf(i + data.analog.length), 0.12),
              fillTo: () => lanes - 1 - i + 0.18,
            }),
          ),
        ],
        hooks: {
          setScale: [(u, k) => k === 'x' && syncScale(u)],
          drawClear: [
            (u) => {
              // Lane separators.
              const ctx = u.ctx;
              ctx.save();
              ctx.strokeStyle = grid;
              ctx.lineWidth = 1;
              for (let i = 1; i < lanes; i++) {
                const y = Math.round(u.valToPos(i, 'd', true)) + 0.5;
                ctx.beginPath();
                ctx.moveTo(u.bbox.left, y);
                ctx.lineTo(u.bbox.left + u.bbox.width, y);
                ctx.stroke();
              }
              ctx.restore();
            },
          ],
        },
      };
      created.push(new uPlot(opts, data.dData, digitalRef.current));
    }
    plots.current = created;
    return () => {
      for (const p of created) p.destroy();
      plots.current = [];
    };
    // Re-create on data / theme / height; width changes are handled by setSize below.
  }, [data, theme, height, key, size.width > 50]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    for (const p of plots.current) if (size.width > 50) p.setSize({ width: size.width, height: p.height });
  }, [size.width]);

  return (
    <div ref={setRef} className={cx('pv-plot w-full min-w-0', className)}>
      {title && <div className="mb-1 text-[12px] font-medium text-(--text)">{title}</div>}
      {data.analog.length > 0 && <div ref={analogRef} />}
      {data.digital.length > 0 && <div ref={digitalRef} className={data.analog.length ? 'mt-2' : ''} />}
      {!signals.length && <div className="grid h-24 place-items-center text-[12px] text-(--text-dim)">No signals</div>}
    </div>
  );
}
