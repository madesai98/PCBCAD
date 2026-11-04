import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { MixedSignalResult } from '@pcbcad/core';
import { formatValue } from '@pcbcad/core';
import { AlertTriangle, Cpu, Info, Maximize2, OctagonAlert, Terminal } from 'lucide-react';
import { withAlpha } from '../common/color';
import { fmtTime, niceStep } from '../common/format';
import { useElementSize, useLatest, useRafCallback } from '../common/hooks';
import { PanZoom, type View2D } from '../common/panzoom';
import { useViewerTheme } from '../common/theme';
import { cx, ToolButton } from '../common/ui';
import { WaveformPlot } from './WaveformPlot';

export interface LogicAnalyzerProps {
  result: MixedSignalResult;
  /** Show the sampled analog nodes under the digital lanes (default true). */
  showAnalog?: boolean;
  className?: string;
}

const RULER = 26;
const ROW = 30;

function levelAt(tr: [number, number][], t: number): number {
  // Binary search: last transition with time <= t.
  let lo = 0;
  let hi = tr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tr[mid][0] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans < 0 ? (tr[0]?.[1] ?? 0) : tr[ans][1];
}

function firstIndexAfter(tr: [number, number][], t: number): number {
  let lo = 0;
  let hi = tr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tr[mid][0] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Firmware run viewer: digital lanes, UART consoles, LED indicators, MCU status and log. */
export function LogicAnalyzer({ result, showAnalog = true, className }: LogicAnalyzerProps) {
  const [setRef, size, ref] = useElementSize<HTMLDivElement>();
  const theme = useViewerTheme(ref);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View2D>({ k: 1, x: 0, y: 0 });
  const cursorRef = useRef<number | null>(null);
  const pzRef = useRef<PanZoom | null>(null);
  const lanes = useMemo(() => result.digital.map((d) => ({ ...d, transitions: [...d.transitions].sort((a, b) => a[0] - b[0]) })), [result.digital]);
  const narrow = size.width < 560;
  const LW = narrow ? 104 : 168;
  const height = RULER + lanes.length * ROW + 6;
  const sizeRef = useLatest(size);
  const stateRef = useLatest({ lanes, theme, LW, duration: result.duration });

  const fitView = useCallback(() => {
    const w = Math.max(10, sizeRef.current.width - stateRef.current.LW - 12);
    const k = w / Math.max(1e-9, stateRef.current.duration);
    return { k, x: stateRef.current.LW + 4, y: 0 };
  }, [sizeRef, stateRef]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const { width } = sizeRef.current;
    if (!canvas || width < 20) return;
    const { lanes: L, theme: th, LW: lw } = stateRef.current;
    const dpr = window.devicePixelRatio || 1;
    const H = RULER + L.length * ROW + 6;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.height = `${H}px`;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, H);
    const v = viewRef.current;
    const t0 = (lw - v.x) / v.k;
    const t1 = (width - v.x) / v.k;
    const tx = (t: number) => v.x + v.k * t;
    const grid = th.dark ? 'rgba(255,255,255,0.055)' : 'rgba(15,23,42,0.06)';
    // Ruler + grid.
    const step = niceStep(t1 - t0, Math.max(2, Math.floor((width - lw) / 110)));
    ctx.font = `500 10.5px ${th.fontMono}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round(tx(t)) + 0.5;
      if (x < lw) continue;
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(x, RULER - 6);
      ctx.lineTo(x, H);
      ctx.stroke();
      const label = fmtTime(Math.abs(t) < step * 1e-6 ? 0 : t, 3);
      const w = ctx.measureText(label).width;
      // Keep tick labels inside the waveform area.
      const lx = Math.min(width - w / 2 - 4, Math.max(lw + w / 2 + 4, x));
      ctx.fillStyle = th.textDim;
      ctx.fillText(label, lx, RULER / 2 - 1);
    }
    ctx.strokeStyle = th.border;
    ctx.beginPath();
    ctx.moveTo(0, RULER + 0.5);
    ctx.lineTo(width, RULER + 0.5);
    ctx.stroke();
    // Lanes.
    const cursorT = cursorRef.current;
    L.forEach((lane, li) => {
      const top = RULER + li * ROW;
      const yH = top + 7;
      const yL = top + ROW - 7;
      const yM = (yH + yL) / 2;
      const col = th.series[li % th.series.length];
      if (li % 2 === 1) {
        ctx.fillStyle = th.dark ? 'rgba(255,255,255,0.018)' : 'rgba(15,23,42,0.022)';
        ctx.fillRect(0, top, width, ROW);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(lw, top, width - lw, ROW);
      ctx.clip();
      const tr = lane.transitions;
      let level = levelAt(tr, t0);
      let x = Math.max(lw, tx(t0));
      const line = new Path2D();
      const hiZ = new Path2D();
      const fills: [number, number][] = [];
      const busy: [number, number][] = [];
      let busyStart = -1;
      let lastX = x;
      const yOf = (l: number) => (l > 0 ? yH : l < 0 ? yM : yL);
      line.moveTo(x, yOf(level));
      let segStart = x;
      for (let i = firstIndexAfter(tr, t0); i < tr.length && tr[i][0] <= t1; i++) {
        const nx = tx(tr[i][0]);
        const nl = tr[i][1];
        if (nx - lastX < 1.2) {
          if (busyStart < 0) busyStart = lastX;
          lastX = nx;
          level = nl;
          continue;
        }
        if (busyStart >= 0) {
          busy.push([busyStart, lastX]);
          busyStart = -1;
          line.moveTo(lastX, yOf(level));
          segStart = lastX;
        }
        if (level > 0) fills.push([segStart, nx]);
        if (level < 0) {
          hiZ.moveTo(segStart, yM);
          hiZ.lineTo(nx, yM);
          line.moveTo(nx, yOf(level));
        } else line.lineTo(nx, yOf(level));
        line.lineTo(nx, yOf(nl));
        level = nl;
        lastX = nx;
        segStart = nx;
      }
      const xe = Math.min(width, tx(t1));
      if (busyStart >= 0) {
        busy.push([busyStart, Math.max(busyStart + 1.5, lastX)]);
        line.moveTo(lastX, yOf(level));
        segStart = lastX;
      }
      if (level > 0) fills.push([segStart, xe]);
      if (level < 0) {
        hiZ.moveTo(segStart, yM);
        hiZ.lineTo(xe, yM);
      } else line.lineTo(xe, yOf(level));
      ctx.fillStyle = withAlpha(col, 0.11);
      for (const [a, b] of fills) ctx.fillRect(a, yH, b - a, yL - yH);
      ctx.fillStyle = withAlpha(col, 0.55);
      for (const [a, b] of busy) ctx.fillRect(a, yH, Math.max(1.5, b - a), yL - yH);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'miter';
      ctx.stroke(line);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = withAlpha(col, 0.7);
      ctx.stroke(hiZ);
      ctx.setLineDash([]);
      ctx.restore();
      // Label column.
      ctx.fillStyle = th.text;
      ctx.textAlign = 'left';
      ctx.font = `600 11.5px ${th.fontMono}`;
      const name = lane.name.replace(/^~/, '');
      ctx.fillText(name.length > (narrow ? 11 : 18) ? name.slice(0, narrow ? 10 : 17) + '…' : name, 10, top + ROW / 2 - (narrow ? 0 : 5));
      if (lane.name.startsWith('~')) {
        const w = ctx.measureText(name).width;
        ctx.strokeStyle = th.text;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(10, top + ROW / 2 - (narrow ? 0 : 5) - 7.5);
        ctx.lineTo(10 + w, top + ROW / 2 - (narrow ? 0 : 5) - 7.5);
        ctx.stroke();
      }
      if (!narrow) {
        ctx.fillStyle = th.textDim;
        ctx.font = `500 10px ${th.fontSans}`;
        ctx.fillText(`pin ${lane.pin}`, 10, top + ROW / 2 + 7);
      }
      ctx.fillStyle = col;
      ctx.fillRect(2, top + 7, 3, ROW - 14);
      if (cursorT !== null) {
        const lv = levelAt(tr, cursorT);
        ctx.textAlign = 'right';
        ctx.font = `700 11px ${th.fontMono}`;
        ctx.fillStyle = lv < 0 ? th.textDim : lv > 0 ? col : th.textDim;
        ctx.fillText(lv < 0 ? 'Z' : String(lv), lw - 8, top + ROW / 2);
      }
    });
    // Column divider.
    ctx.strokeStyle = th.border;
    ctx.beginPath();
    ctx.moveTo(lw + 0.5, 0);
    ctx.lineTo(lw + 0.5, H);
    ctx.stroke();
    // Cursor.
    if (cursorT !== null) {
      const x = Math.round(tx(cursorT)) + 0.5;
      if (x >= lw) {
        ctx.strokeStyle = th.accent;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, RULER);
        ctx.lineTo(x, H);
        ctx.stroke();
        const label = fmtTime(cursorT, 5);
        ctx.font = `600 10.5px ${th.fontMono}`;
        const w = ctx.measureText(label).width + 12;
        const bx = Math.min(width - w - 2, Math.max(lw + 2, x - w / 2));
        ctx.fillStyle = th.accent;
        ctx.beginPath();
        ctx.roundRect(bx, 3, w, RULER - 8, 4);
        ctx.fill();
        ctx.fillStyle = th.dark ? '#041014' : '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(label, bx + w / 2, RULER / 2 - 1);
      }
    }
  }, [narrow, sizeRef, stateRef]);
  const requestDraw = useRafCallback(draw);

  useLayoutEffect(() => {
    const el = laneRef.current;
    if (!el) return;
    const pz = new PanZoom(el, {
      onChange: (v) => {
        viewRef.current = { ...v, y: 0 };
        requestDraw();
      },
      minK: () => fitView().k * 0.5,
      maxK: () => fitView().k * 2e6,
      onHover: (sx) => {
        const v = viewRef.current;
        cursorRef.current = sx >= stateRef.current.LW ? (sx - v.x) / v.k : null;
        requestDraw();
      },
      onLeave: () => {
        cursorRef.current = null;
        requestDraw();
      },
      onDoubleClick: () => pz.animateTo(fitView()),
    });
    pzRef.current = pz;
    // Vertical wheel should scroll the page when not over lanes: PanZoom captures wheel; that's intended here.
    return () => {
      pz.destroy();
      pzRef.current = null;
    };
  }, [fitView, requestDraw, stateRef]);

  const fittedFor = useRef<MixedSignalResult | null>(null);
  const lastW = useRef(0);
  useEffect(() => {
    if (size.width < 20) return;
    if (fittedFor.current !== result || lastW.current !== size.width) {
      fittedFor.current = result;
      lastW.current = size.width;
      const v = fitView();
      viewRef.current = v;
      pzRef.current?.set(v, false);
    }
    requestDraw();
  }, [size.width, result, fitView, requestDraw, theme, LW]);

  const realtime = result.wallMs > 0 ? result.duration / (result.wallMs / 1000) : 0;
  const uartGroups = result.uart;

  return (
    <div ref={setRef} className={cx('flex w-full min-w-0 flex-col gap-3', className)}>
      {/* Status strip */}
      <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
        {result.mcus.map((m) => (
          <div key={m.componentId} className="flex items-center gap-2 rounded-lg border border-(--border) bg-(--bg-elev) px-2.5 py-1.5 text-[12px]">
            <Cpu className="h-3.5 w-3.5 text-accent-600 dark:text-accent-400" />
            <span className="font-mono font-semibold text-(--text)">{m.ref}</span>
            <span className="text-(--text-dim)">{m.emulator}</span>
            <span className="hidden font-mono text-[11px] text-(--text-dim) sm:inline">
              {formatValue(m.cycles, '', 3)} cyc · {formatValue(m.clockHz, 'Hz')}
            </span>
            <span
              className={cx(
                'rounded-full px-1.5 py-px text-[10.5px] font-semibold uppercase',
                /run|ok|done/i.test(m.status) ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' : /err|fault|crash/i.test(m.status) ? 'bg-red-500/12 text-red-500' : 'bg-(--bg-sunken) text-(--text-dim)',
              )}
            >
              {m.status}
            </span>
          </div>
        ))}
        {result.indicators.map((ind) => {
          const c = ind.color ?? theme.ok;
          const f = Math.max(0, Math.min(1, ind.onFraction));
          return (
            <div key={ind.componentId} className="flex items-center gap-2 rounded-lg border border-(--border) bg-(--bg-elev) px-2.5 py-1.5 text-[12px]" title={`${ind.ref}: on ${(f * 100).toFixed(0)}% of the time, mean ${formatValue(ind.meanCurrent, 'A')}`}>
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: c, opacity: 0.35 + 0.65 * f, boxShadow: `0 0 ${3 + 12 * f}px ${1 + 4 * f}px ${withAlpha(c, 0.25 + 0.45 * f)}` }}
              />
              <span className="font-mono font-semibold text-(--text)">{ind.ref}</span>
              <span className="font-mono text-[11px] text-(--text-dim)">
                {(f * 100).toFixed(0)}% · {formatValue(ind.meanCurrent, 'A', 2)}
              </span>
            </div>
          );
        })}
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-(--text-dim)">
          {fmtTime(result.duration)} simulated · {(result.wallMs / 1000).toFixed(2)} s wall{realtime ? ` · ${realtime.toFixed(2)}× real-time` : ''}
        </span>
      </div>

      {/* Lanes */}
      {lanes.length > 0 && (
        <div className="relative mx-3 overflow-hidden rounded-lg border border-(--border) bg-(--bg-elev)">
          <div ref={laneRef} className="relative cursor-crosshair" style={{ height }}>
            <canvas ref={canvasRef} className="block w-full" style={{ height }} />
          </div>
          <div className="absolute top-0 left-1 flex h-[26px] items-center" data-pz-ignore="">
            <ToolButton title="Fit time range (double-click)" onClick={() => pzRef.current?.animateTo(fitView())} className="h-6 min-w-6">
              <Maximize2 className="h-3.5 w-3.5" />
            </ToolButton>
            <span className="ml-1 text-[10.5px] font-medium tracking-wide text-(--text-dim) uppercase">{lanes.length} signals</span>
          </div>
        </div>
      )}

      {showAnalog && result.analog.signals.length > 0 && (
        <div className="mx-3 rounded-lg border border-(--border) bg-(--bg-elev) px-2 pt-2 pb-1">
          <WaveformPlot time={result.analog.time} signals={result.analog.signals} height={150} />
        </div>
      )}

      {/* Consoles + log */}
      <div className="grid gap-3 px-3 pb-3 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          {uartGroups.length === 0 && <div className="rounded-lg border border-dashed border-(--border) p-4 text-[12px] text-(--text-dim)">No UART output</div>}
          {uartGroups.map((u, i) => {
            const lines = u.text.replace(/\r/g, '').split('\n');
            if (lines[lines.length - 1] === '') lines.pop();
            return (
              <div key={i} className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-(--border) bg-(--bg-sunken)">
                <div className="flex items-center gap-2 border-b border-(--border) px-2.5 py-1.5 text-[11.5px]">
                  <Terminal className="h-3.5 w-3.5 text-(--text-dim)" />
                  <span className="font-mono font-semibold text-(--text)">{u.ref}</span>
                  <span className="truncate text-(--text-dim)">{u.port}</span>
                  <span className="flex-1" />
                  <span className="font-mono text-[10.5px] text-(--text-dim)">{u.text.length} B</span>
                </div>
                <pre className="max-h-48 min-h-24 overflow-auto px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] text-(--text)">
                  {lines.map((l, k) => (
                    <div key={k} className="flex gap-3">
                      <span className="w-5 shrink-0 text-right text-(--text-dim) select-none">{k + 1}</span>
                      <span className="whitespace-pre-wrap break-all">{l}</span>
                    </div>
                  ))}
                  <div className="flex gap-3">
                    <span className="w-5 shrink-0" />
                    <span className="pv-caret inline-block h-3.5 w-1.5 translate-y-0.5 bg-accent-500" />
                  </div>
                </pre>
              </div>
            );
          })}
        </div>
        <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-(--border) bg-(--bg-elev)">
          <div className="flex items-center gap-2 border-b border-(--border) px-2.5 py-1.5 text-[11.5px] font-medium text-(--text)">
            Event log
            <span className="font-mono text-[10.5px] font-normal text-(--text-dim)">{result.log.length}</span>
          </div>
          <div className="max-h-56 overflow-auto">
            {result.warnings.map((w, i) => (
              <div key={`w${i}`} className="flex gap-2 border-b border-(--border) bg-amber-500/6 px-2.5 py-1.5 text-[11.5px]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span className="text-(--text)">{w}</span>
              </div>
            ))}
            {result.log.map((l, i) => {
              const Icon = l.level === 'error' ? OctagonAlert : l.level === 'warn' ? AlertTriangle : Info;
              return (
                <div key={i} className="flex gap-2 border-b border-(--border) px-2.5 py-1.5 text-[11.5px] last:border-b-0">
                  <span className="w-14 shrink-0 text-right font-mono text-[10.5px] leading-5 text-(--text-dim)">{fmtTime(l.t, 3)}</span>
                  <Icon className={cx('mt-0.5 h-3.5 w-3.5 shrink-0', l.level === 'error' ? 'text-red-500' : l.level === 'warn' ? 'text-amber-500' : 'text-sky-500')} />
                  <span className="shrink-0 font-mono text-[10.5px] leading-5 font-semibold text-(--text-dim)">{l.source}</span>
                  <span className="min-w-0 text-(--text)">{l.msg}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
