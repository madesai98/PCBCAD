import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '@pcbcad/core';
import { Maximize, Minus, Plus } from 'lucide-react';
import { withAlpha } from '../common/color';
import { useElementSize, useLatest } from '../common/hooks';
import { fitView, PanZoom, type View2D } from '../common/panzoom';
import { useViewerTheme, type ViewerTheme } from '../common/theme';
import { cx, FloatPanel, ToolButton } from '../common/ui';
import { LABEL, layoutSchematic, REF_SIZE, VALUE_SIZE, type PlacedSymbol, type SchLayout, type Terminal } from './layout';
import { displayName, G, overlined, type Prim } from './symbols';

export interface SchematicViewProps {
  project: Project;
  boardId: string;
  selectedIds?: readonly string[];
  highlightNetId?: string | null;
  onSelectComponent?: (id: string | null) => void;
  onHoverNet?: (netId: string | null) => void;
  /** Show the sheet frame + title block (default true). */
  frame?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/* --------------------------------------------- text --------------------------------------------- */

const measureCache = new Map<string, number>();
let measureCtx: CanvasRenderingContext2D | null = null;

function makeMeasure(fontFamily: string) {
  return (text: string, size: number): number => {
    if (!text) return 0;
    const key = `${fontFamily}|${text}`;
    let w100 = measureCache.get(key);
    if (w100 === undefined) {
      if (!measureCtx && typeof document !== 'undefined') measureCtx = document.createElement('canvas').getContext('2d');
      if (measureCtx) {
        measureCtx.font = `500 100px ${fontFamily}`;
        w100 = measureCtx.measureText(text).width;
      } else w100 = text.length * 62;
      if (measureCache.size > 5000) measureCache.clear();
      measureCache.set(key, w100);
    }
    return (w100 * size) / 100;
  };
}

/* ------------------------------------------- rendering ------------------------------------------ */

const fillOf = (f: Prim extends { fill?: infer F } ? F : never) =>
  f === 'body' ? 'var(--sch-body)' : f === 'tint' ? 'var(--sch-tint)' : f === 'stroke' ? 'var(--sch-sym)' : f === 'bg' ? 'var(--sch-bg)' : 'none';

function PinName({ text, x, y, size, anchor, cls, rot }: { text: string; x: number; y: number; size: number; anchor: 'start' | 'middle' | 'end'; cls: string; rot?: number }) {
  const shown = displayName(text);
  const over = overlined(text);
  return (
    <text x={x} y={y} fontSize={size} textAnchor={anchor} dominantBaseline="central" className={cls} transform={rot ? `rotate(${rot} ${x} ${y})` : undefined}>
      {over ? <tspan textDecoration="overline">{shown}</tspan> : shown}
    </text>
  );
}

function SymbolBody({ s }: { s: PlacedSymbol }) {
  const rot = s.rot;
  const accent = s.geom.accent;
  return (
    <g data-comp={s.comp.id} className={cx('sym', s.comp.dnp && 'dnp')} transform={`translate(${s.x} ${s.y})`}>
      <rect className="sym-hit" x={s.body.x0 - s.x - 0.6} y={s.body.y0 - s.y - 0.6} width={s.body.x1 - s.body.x0 + 1.2} height={s.body.y1 - s.body.y0 + 1.2} rx={0.8} />
      <g transform={rot ? `rotate(${-rot})` : undefined} className="body-shape">
        {s.geom.prims.map((p, i) => {
          switch (p.t) {
            case 'path':
              return <path key={i} d={p.d} fill={accent && p.fill === 'tint' ? withAlpha(accent, 0.3) : fillOf(p.fill)} strokeWidth={p.w} style={p.accent && accent ? { stroke: accent } : undefined} />;
            case 'circle':
              return <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill={fillOf(p.fill)} strokeWidth={p.w} />;
            case 'rect':
              return <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} rx={p.rx} fill={fillOf(p.fill)} strokeWidth={p.sw} className={p.fill === 'body' ? 'ic-body' : undefined} />;
            case 'text': {
              // Keep text upright: rotate the anchor, not the glyphs (vertical for 90/270).
              const r = ((rot % 360) + 360) % 360;
              if (r === 0) return <PinName key={i} {...p} cls={p.cls} />;
              const [tx, ty] = r === 90 ? [p.y, -p.x] : r === 180 ? [-p.x, -p.y] : [-p.y, p.x];
              const anchor = r === 180 ? (p.anchor === 'start' ? 'end' : p.anchor === 'end' ? 'start' : 'middle') : p.anchor;
              return (
                <g key={i} transform={`rotate(${rot})`}>
                  <PinName text={p.text} x={tx} y={ty} size={p.size} anchor={anchor} cls={p.cls} rot={r === 90 || r === 270 ? -90 : 0} />
                </g>
              );
            }
          }
        })}
      </g>
      {s.pins.map((p, i) => {
        const lx = p.wx - s.x;
        const ly = p.wy - s.y;
        const d = p.wdir;
        const ex = d === 'left' ? lx + p.line : d === 'right' ? lx - p.line : lx;
        const ey = d === 'up' ? ly + p.line : d === 'down' ? ly - p.line : ly;
        return (
          <g key={i} data-net={p.netId} className="pin">
            {p.line > 0 && <line className="pinline" x1={lx} y1={ly} x2={ex} y2={ey} />}
            {p.showNumber && p.line > 0 && (
              <text
                className="pinnum"
                fontSize={0.95}
                x={(lx + ex) / 2 + (d === 'up' || d === 'down' ? -0.35 : 0)}
                y={(ly + ey) / 2 + (d === 'up' || d === 'down' ? 0 : -0.45)}
                textAnchor={d === 'up' || d === 'down' ? 'end' : 'middle'}
                dominantBaseline={d === 'up' || d === 'down' ? 'central' : 'auto'}
              >
                {p.numbers.length > 2 ? `${p.numbers[0]}…` : p.numbers.join(',')}
              </text>
            )}
          </g>
        );
      })}
      <text className="ref" x={s.ref.x - s.x} y={s.ref.y - s.y} fontSize={REF_SIZE} textAnchor={s.ref.anchor}>
        {s.comp.ref}
      </text>
      {s.value.text && (
        <text className="val" x={s.value.x - s.x} y={s.value.y - s.y} fontSize={VALUE_SIZE} textAnchor={s.value.anchor}>
          {s.value.text}
        </text>
      )}
      {s.comp.dnp && (
        <text className="dnp-tag" x={s.body.x1 - s.x} y={s.body.y0 - s.y - 0.4} fontSize={1.1} textAnchor="end">
          DNP
        </text>
      )}
    </g>
  );
}

function TerminalView({ t, theme }: { t: Terminal; theme: ViewerTheme }) {
  const color = theme.netClass[t.cls];
  const style = { ['--net' as string]: color } as React.CSSProperties;
  if (t.kind === 'nc')
    return (
      <g className="nc">
        <path d={`M${t.x - 0.6} ${t.y - 0.6}L${t.x + 0.6} ${t.y + 0.6}M${t.x + 0.6} ${t.y - 0.6}L${t.x - 0.6} ${t.y + 0.6}`} />
      </g>
    );
  if (t.kind === 'ground')
    return (
      <g data-net={t.netId} className="term" style={style}>
        <path className="term-line" d={`M${t.x} ${t.y}V${t.y + 1.1}M${t.x - 1.3} ${t.y + 1.1}H${t.x + 1.3}M${t.x - 0.82} ${t.y + 1.68}H${t.x + 0.82}M${t.x - 0.36} ${t.y + 2.26}H${t.x + 0.36}`} />
        {t.name.toUpperCase() !== 'GND' && (
          <text className="lbl-txt" x={t.x} y={t.y + 3.6} fontSize={1.0} textAnchor="middle">
            {t.name}
          </text>
        )}
      </g>
    );
  if (t.kind === 'power')
    return (
      <g data-net={t.netId} className="term" style={style}>
        <path className="term-line" d={`M${t.x} ${t.y}V${t.y - 1.35}`} />
        <path className="term-bar" d={`M${t.x - 1.27} ${t.y - 1.35}H${t.x + 1.27}`} />
        <text className="lbl-txt pwr" x={t.x} y={t.y - 2.05} fontSize={LABEL.size} textAnchor="middle">
          {t.name}
        </text>
      </g>
    );
  // label
  const h = LABEL.h;
  let x0: number;
  let y0: number;
  let lx1 = t.x;
  let ly1 = t.y;
  if (t.dir === 'left') {
    x0 = t.x - t.width;
    y0 = t.y - h / 2;
  } else if (t.dir === 'right') {
    x0 = t.x;
    y0 = t.y - h / 2;
  } else if (t.dir === 'up') {
    x0 = t.x - t.width / 2;
    y0 = t.y - LABEL.stub - h;
    ly1 = t.y - LABEL.stub;
  } else {
    x0 = t.x - t.width / 2;
    y0 = t.y + LABEL.stub;
    ly1 = t.y + LABEL.stub;
  }
  const w = t.width;
  // Flag shape: pointed toward the connection for horizontal labels.
  const p = 0.7;
  const d =
    t.dir === 'left'
      ? `M${x0 + 0.5} ${y0}H${x0 + w - p}L${x0 + w} ${y0 + h / 2}L${x0 + w - p} ${y0 + h}H${x0 + 0.5}Q${x0} ${y0 + h} ${x0} ${y0 + h - 0.5}V${y0 + 0.5}Q${x0} ${y0} ${x0 + 0.5} ${y0}Z`
      : t.dir === 'right'
        ? `M${x0} ${y0 + h / 2}L${x0 + p} ${y0}H${x0 + w - 0.5}Q${x0 + w} ${y0} ${x0 + w} ${y0 + 0.5}V${y0 + h - 0.5}Q${x0 + w} ${y0 + h} ${x0 + w - 0.5} ${y0 + h}H${x0 + p}Z`
        : `M${x0 + 0.5} ${y0}H${x0 + w - 0.5}Q${x0 + w} ${y0} ${x0 + w} ${y0 + 0.5}V${y0 + h - 0.5}Q${x0 + w} ${y0 + h} ${x0 + w - 0.5} ${y0 + h}H${x0 + 0.5}Q${x0} ${y0 + h} ${x0} ${y0 + h - 0.5}V${y0 + 0.5}Q${x0} ${y0} ${x0 + 0.5} ${y0}Z`;
  const tx = t.dir === 'left' ? x0 + (w - p) / 2 : t.dir === 'right' ? x0 + p + (w - p) / 2 : t.x;
  return (
    <g data-net={t.netId} className="term" style={style}>
      {(t.dir === 'up' || t.dir === 'down') && <line className="term-line" x1={t.x} y1={t.y} x2={lx1} y2={ly1} />}
      <path className="lbl-bg" d={d} />
      <PinName text={t.name} x={tx} y={y0 + h / 2 + 0.05} size={LABEL.size} anchor="middle" cls="lbl-txt" />
    </g>
  );
}

function SheetFrame({ layout, project, boardName }: { layout: SchLayout; project: Project; boardName: string }) {
  const s = layout.sheet;
  const inset = 4;
  const inner = { x0: s.x0 + inset, y0: s.y0 + inset, x1: s.x1 - inset, y1: s.y1 - inset };
  const w = s.x1 - s.x0;
  const h = s.y1 - s.y0;
  const cols = Math.max(2, Math.round(w / 50));
  const rows = Math.max(2, Math.round(h / 50));
  const tb = layout.titleBlock;
  const tbw = tb.x1 - tb.x0;
  const tbh = tb.y1 - tb.y0;
  const date = (project.updatedAt || project.createdAt || '').slice(0, 10);
  return (
    <g className="frame">
      <rect className="sheet" x={s.x0} y={s.y0} width={w} height={h} rx={1.2} />
      <rect className="frame-line" x={inner.x0} y={inner.y0} width={inner.x1 - inner.x0} height={inner.y1 - inner.y0} />
      {Array.from({ length: cols }, (_, i) => {
        const x = s.x0 + ((i + 0.5) * w) / cols;
        const xb = s.x0 + ((i + 1) * w) / cols;
        return (
          <g key={`c${i}`}>
            {i < cols - 1 && <path className="frame-tick" d={`M${xb} ${s.y0}V${inner.y0}M${xb} ${inner.y1}V${s.y1}`} />}
            <text className="frame-txt" x={x} y={s.y0 + inset / 2} fontSize={1.6} textAnchor="middle" dominantBaseline="central">
              {i + 1}
            </text>
            <text className="frame-txt" x={x} y={s.y1 - inset / 2} fontSize={1.6} textAnchor="middle" dominantBaseline="central">
              {i + 1}
            </text>
          </g>
        );
      })}
      {Array.from({ length: rows }, (_, i) => {
        const y = s.y0 + ((i + 0.5) * h) / rows;
        const yb = s.y0 + ((i + 1) * h) / rows;
        const L = String.fromCharCode(65 + (i % 26));
        return (
          <g key={`r${i}`}>
            {i < rows - 1 && <path className="frame-tick" d={`M${s.x0} ${yb}H${inner.x0}M${inner.x1} ${yb}H${s.x1}`} />}
            <text className="frame-txt" x={s.x0 + inset / 2} y={y} fontSize={1.6} textAnchor="middle" dominantBaseline="central">
              {L}
            </text>
            <text className="frame-txt" x={s.x1 - inset / 2} y={y} fontSize={1.6} textAnchor="middle" dominantBaseline="central">
              {L}
            </text>
          </g>
        );
      })}
      <g className="title-block">
        <rect x={tb.x0} y={tb.y0} width={tbw} height={tbh} className="tb-bg" />
        <path className="frame-line" d={`M${tb.x0} ${tb.y0 + 10}H${tb.x1}M${tb.x0} ${tb.y0 + 16}H${tb.x1}M${tb.x0 + 62} ${tb.y0 + 10}V${tb.y1}M${tb.x0 + 84} ${tb.y0 + 16}V${tb.y1}`} />
        <text className="tb-label" x={tb.x0 + 2} y={tb.y0 + 2.8} fontSize={1.3}>
          TITLE
        </text>
        <text className="tb-title" x={tb.x0 + 2} y={tb.y0 + 8} fontSize={3.4}>
          {project.name}
        </text>
        <text className="tb-label" x={tb.x0 + 2} y={tb.y0 + 12.3} fontSize={1.3}>
          BOARD
        </text>
        <text className="tb-value" x={tb.x0 + 2} y={tb.y0 + 15} fontSize={1.8}>
          {boardName}
        </text>
        <text className="tb-label" x={tb.x0 + 64} y={tb.y0 + 12.3} fontSize={1.3}>
          REV
        </text>
        <text className="tb-value" x={tb.x0 + 64} y={tb.y0 + 15} fontSize={1.8}>
          r{project.revision}
        </text>
        <text className="tb-label" x={tb.x0 + 2} y={tb.y0 + 18.3} fontSize={1.3}>
          DATE
        </text>
        <text className="tb-value" x={tb.x0 + 12} y={tb.y0 + 18.4} fontSize={1.6}>
          {date}
        </text>
        <text className="tb-label" x={tb.x0 + 64} y={tb.y0 + 18.3} fontSize={1.3}>
          SHEET
        </text>
        <text className="tb-value" x={tb.x0 + 74} y={tb.y0 + 18.4} fontSize={1.6}>
          1 / 1
        </text>
        <text className="tb-brand" x={tb.x0 + 86} y={tb.y0 + 19.6} fontSize={2.0}>
          PCBCAD
        </text>
      </g>
    </g>
  );
}

const SchematicContent = memo(function SchematicContent({ layout, theme, project, boardName, frame }: { layout: SchLayout; theme: ViewerTheme; project: Project; boardName: string; frame: boolean }) {
  return (
    <>
      {frame && <SheetFrame layout={layout} project={project} boardName={boardName} />}
      <g className="terms">
        {layout.terminals.map((t, i) => (
          <TerminalView key={i} t={t} theme={theme} />
        ))}
      </g>
      <g className="syms">
        {layout.symbols.map((s) => (
          <SymbolBody key={s.comp.id} s={s} />
        ))}
      </g>
      {layout.notes.map((n, i) => (
        <text key={i} className="note" x={n.x} y={n.y} fontSize={1.5}>
          {n.text}
        </text>
      ))}
    </>
  );
});

function baseCss(theme: ViewerTheme): string {
  return `
.sch-root{--sch-bg:${theme.canvas};--sch-sheet:${theme.dark ? '#0f1318' : '#ffffff'};--sch-sym:${theme.dark ? '#c3ccd8' : '#334155'};--sch-pin:${theme.dark ? '#8a95a6' : '#64748b'};--sch-body:${theme.dark ? '#161b22' : '#fbfaf5'};--sch-tint:${theme.dark ? 'rgba(148,163,184,.14)' : 'rgba(51,65,85,.08)'};--sch-text:${theme.text};--sch-dim:${theme.textDim};--sch-hl:${theme.accent};--sch-frame:${theme.dark ? '#2a313b' : '#d5dbe3'};}
.sch-root text{font-family:${theme.fontSans};fill:var(--sch-text);stroke:none;}
.sch-root .sheet{fill:var(--sch-sheet);stroke:var(--sch-frame);stroke-width:.35;}
.sch-root .frame-line{fill:none;stroke:var(--sch-frame);stroke-width:.3;}
.sch-root .frame-tick{stroke:var(--sch-frame);stroke-width:.25;}
.sch-root .frame-txt{fill:var(--sch-dim);font-weight:500;}
.sch-root .tb-bg{fill:${theme.dark ? 'rgba(255,255,255,.015)' : 'rgba(15,23,42,.015)'};stroke:var(--sch-frame);stroke-width:.35;}
.sch-root .tb-label{fill:var(--sch-dim);letter-spacing:.12px;font-weight:600;}
.sch-root .tb-title{font-weight:650;}
.sch-root .tb-value{font-weight:500;}
.sch-root .tb-brand{fill:${theme.accent};font-weight:800;letter-spacing:.3px;}
.sch-root .body-shape path,.sch-root .body-shape circle,.sch-root .body-shape rect{stroke:var(--sch-sym);stroke-width:.25;stroke-linecap:round;stroke-linejoin:round;}
.sch-root .body-shape .ic-body{stroke-width:.3;}
.sch-root .pinline{stroke:var(--sch-pin);stroke-width:.22;stroke-linecap:round;}
.sch-root .pinname{fill:var(--sch-text);font-weight:500;}
.sch-root .pinnum{fill:var(--sch-dim);font-weight:500;}
.sch-root .ref{font-weight:700;fill:var(--sch-text);}
.sch-root .val{fill:var(--sch-dim);font-weight:500;}
.sch-root .dnp-tag{fill:${theme.fail};font-weight:800;}
.sch-root .sym.dnp .body-shape{opacity:.45;}
.sch-root .sym-hit{fill:transparent;stroke:none;}
.sch-root .sym{cursor:pointer;}
.sch-root .sym:hover .sym-hit{fill:${withAlpha(theme.accent, theme.dark ? 0.06 : 0.07)};}
.sch-root .term .term-line,.sch-root .term .term-bar{stroke:var(--net);stroke-width:.25;fill:none;stroke-linecap:round;}
.sch-root .term .term-bar{stroke-width:.42;}
.sch-root .term .lbl-bg{fill:color-mix(in srgb,var(--net) 13%,transparent);stroke:var(--net);stroke-width:.2;}
.sch-root .term .lbl-txt{fill:var(--net);font-weight:600;}
.sch-root .term .lbl-txt.pwr{font-weight:700;}
.sch-root .nc path{stroke:${theme.fail};stroke-width:.25;stroke-linecap:round;opacity:.85;}
.sch-root .note{fill:var(--sch-dim);font-style:italic;}
.sch-root .sel-box{fill:${withAlpha(theme.accent, 0.1)};stroke:${theme.accent};stroke-width:.3;}
`;
}

function highlightCss(netId: string | null | undefined, strong: boolean): string {
  if (!netId) return '';
  const sel = `.sch-root [data-net="${CSS.escape(netId)}"]`;
  return `
${sel} .pinline{stroke:var(--sch-hl);stroke-width:${strong ? 0.36 : 0.3};}
${sel} .term-line,${sel} .term-bar{stroke:var(--sch-hl)!important;stroke-width:${strong ? 0.38 : 0.32};}
${sel} .lbl-bg{fill:color-mix(in srgb,var(--sch-hl) 28%,transparent);stroke:var(--sch-hl);stroke-width:.28;}
${sel} .lbl-txt{fill:var(--sch-hl);}
${sel} .pinnum{fill:var(--sch-hl);}
${sel}{filter:drop-shadow(0 0 .5px var(--sch-hl));}
`;
}

/**
 * Auto-generated schematic for one board (SVG). Components without explicit schematic positions
 * are auto-laid out; nets are shown as stub + label / rail symbols. Hover a pin or label to
 * highlight the whole net; click a symbol to select it.
 */
export function SchematicView({ project, boardId, selectedIds, highlightNetId, onSelectComponent, onHoverNet, frame = true, className, style }: SchematicViewProps) {
  const [setContainer, size, containerRef] = useElementSize<HTMLDivElement>();
  const theme = useViewerTheme(containerRef);
  const gRef = useRef<SVGGElement>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);
  const board = project.boards.find((b) => b.id === boardId);

  const measure = useMemo(() => makeMeasure(theme.fontSans), [theme.fontSans]);
  const layout = useMemo(() => (board ? layoutSchematic(project, board, measure) : null), [project, board, measure]);
  const [hoverNet, setHoverNet] = useState<string | null>(null);

  const viewRef = useRef<View2D>({ k: 1, x: 0, y: 0 });
  const fitKRef = useRef(1);
  const pzRef = useRef<PanZoom | null>(null);
  const sizeRef = useLatest(size);
  const layoutRef = useLatest(layout);

  const apply = useCallback((v: View2D) => {
    viewRef.current = v;
    gRef.current?.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.k})`);
    if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round((v.k / fitKRef.current) * 100)}%`;
  }, []);

  const fit = useCallback(
    (animate: boolean) => {
      const l = layoutRef.current;
      const { width, height } = sizeRef.current;
      if (!l || width < 2 || height < 2) return;
      const b = frame ? l.sheet : l.content;
      const v = fitView({ minX: b.x0, minY: b.y0, maxX: b.x1, maxY: b.y1 }, width, height, { padding: Math.min(28, Math.max(10, Math.min(width, height) * 0.04)) });
      fitKRef.current = v.k;
      if (animate && pzRef.current) pzRef.current.animateTo(v);
      else {
        pzRef.current?.set(v, false);
        apply(v);
      }
    },
    [apply, frame, layoutRef, sizeRef],
  );

  const onHoverRef = useLatest(onHoverNet);
  const onSelectRef = useLatest(onSelectComponent);
  const hoverRef = useRef<string | null>(null);
  const setHover = useCallback(
    (net: string | null) => {
      if (hoverRef.current === net) return;
      hoverRef.current = net;
      setHoverNet(net);
      onHoverRef.current?.(net);
    },
    [onHoverRef],
  );

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const pz = new PanZoom(el, {
      onChange: apply,
      minK: () => fitKRef.current * 0.25,
      maxK: () => fitKRef.current * 60,
      onHover: (_sx, _sy, e, dragging) => {
        if (dragging) return;
        const t = e.target as Element | null;
        const netEl = t?.closest?.('[data-net]');
        setHover(netEl?.getAttribute('data-net') || null);
      },
      onLeave: () => setHover(null),
      onClick: (_sx, _sy, e) => {
        const t = document.elementFromPoint(e.clientX, e.clientY);
        const comp = t?.closest?.('[data-comp]')?.getAttribute('data-comp') ?? null;
        onSelectRef.current?.(comp);
      },
      onDoubleClick: () => fit(true),
    });
    pz.set(viewRef.current, false);
    pzRef.current = pz;
    return () => {
      pz.destroy();
      pzRef.current = null;
    };
  }, [apply, containerRef, fit, onSelectRef, setHover]);

  // Fit on first size / board change; keep the view (centre) on resizes and project edits.
  const fittedFor = useRef<string | null>(null);
  const lastSize = useRef(size);
  useLayoutEffect(() => {
    if (size.width < 2 || size.height < 2 || !layout) return;
    if (fittedFor.current !== boardId) {
      fittedFor.current = boardId;
      fit(false);
    } else if (lastSize.current.width !== size.width || lastSize.current.height !== size.height) {
      const v = viewRef.current;
      const nv = { k: v.k, x: v.x + (size.width - lastSize.current.width) / 2, y: v.y + (size.height - lastSize.current.height) / 2 };
      pzRef.current?.set(nv, false);
      apply(nv);
    }
    lastSize.current = size;
  }, [size, boardId, layout, fit, apply]);

  const selected = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);
  const css = useMemo(() => baseCss(theme), [theme]);
  const dynCss = highlightCss(highlightNetId, true) + (hoverNet !== highlightNetId ? highlightCss(hoverNet, false) : '');

  const content = useMemo(
    () => (layout && board ? <SchematicContent layout={layout} theme={theme} project={project} boardName={board.name} frame={frame} /> : null),
    [layout, theme, project, board, frame],
  );

  if (!board || !layout) {
    return (
      <div ref={setContainer} className={cx('grid h-full w-full place-items-center text-[12px] text-(--text-dim)', className)} style={style}>
        Board not found
      </div>
    );
  }

  const v0 = viewRef.current;
  return (
    <div ref={setContainer} className={cx('sch-root relative h-full min-h-[220px] w-full overflow-hidden select-none', className)} style={{ background: theme.canvas, ...style }}>
      <svg className="absolute inset-0 h-full w-full" style={{ shapeRendering: 'geometricPrecision' }}>
        <style>{css}</style>
        <style>{dynCss}</style>
        <g ref={gRef} transform={`translate(${v0.x} ${v0.y}) scale(${v0.k})`}>
          {content}
          {layout.symbols
            .filter((s) => selected.has(s.comp.id))
            .map((s) => (
              <rect key={s.comp.id} className="sel-box" pointerEvents="none" x={s.body.x0 - 1} y={s.body.y0 - 1} width={s.body.x1 - s.body.x0 + 2} height={s.body.y1 - s.body.y0 + 2} rx={1} />
            ))}
        </g>
      </svg>
      <div className="pointer-events-none absolute top-2 right-2 flex items-center gap-1.5">
        <FloatPanel className="flex items-center gap-0.5 p-1">
          <ToolButton title="Zoom out" onClick={() => pzRef.current?.zoomAt(size.width / 2, size.height / 2, 1 / 1.4)}>
            <Minus className="h-4 w-4" />
          </ToolButton>
          <span ref={zoomLabel} className="w-10 text-center font-mono text-[10.5px] text-(--text-dim) tabular-nums">
            100%
          </span>
          <ToolButton title="Zoom in" onClick={() => pzRef.current?.zoomAt(size.width / 2, size.height / 2, 1.4)}>
            <Plus className="h-4 w-4" />
          </ToolButton>
          <ToolButton title="Fit sheet (double-click)" onClick={() => fit(true)}>
            <Maximize className="h-4 w-4" />
          </ToolButton>
        </FloatPanel>
      </div>
      {hoverNet && (
        <div className="pointer-events-none absolute bottom-2 left-2">
          <FloatPanel className="flex items-center gap-2 px-2 py-1 text-[11.5px]">
            <span className="h-2 w-2 rounded-full" style={{ background: theme.netClass[board.nets.find((n) => n.id === hoverNet)?.class ?? 'signal'] }} />
            <span className="font-mono font-medium text-(--text)">{board.nets.find((n) => n.id === hoverNet)?.name ?? hoverNet}</span>
            <span className="text-(--text-dim)">{layout.terminals.filter((t) => t.netId === hoverNet).length} connections</span>
          </FloatPanel>
        </div>
      )}
    </div>
  );
}

export { G as SCHEMATIC_GRID };
