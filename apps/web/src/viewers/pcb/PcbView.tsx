import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Board, DesignIssue, PartDef, PcbThermalResult, Vec2 } from '@pcbcad/core';
import { formatValue } from '@pcbcad/core';
import { AlertTriangle, FlipHorizontal2, Layers as LayersIcon, Maximize, Minus, Plus, Sparkles } from 'lucide-react';
import { ColorLegend } from '../ColorLegend';
import { fmtQuantity } from '../common/format';
import { useElementSize, useLatest, useRafCallback } from '../common/hooks';
import { fitView, PanZoom, type View2D } from '../common/panzoom';
import { useViewerTheme } from '../common/theme';
import { cx, FloatPanel, HoverCard, Popover, Segmented, SwatchToggle, ToolButton, ToolDivider } from '../common/ui';
import {
  buildCurrentOverlay,
  buildIssueMarkers,
  buildThermalImage,
  DEFAULT_PCB_LAYERS,
  drawPcb,
  layersPalette,
  realisticPalette,
  thermalLabelsFor,
  type PcbDrawState,
  type PcbLayerKey,
  type PcbLayerVisibility,
  type PcbMode,
  type PcbViewport,
} from './draw';
import { computeRatsnest, type RatsnestEdge } from './ratsnest';
import { buildPcbScene, pickPcb, type PcbHit, type PcbScene } from './scene';

export interface PcbOverlay {
  thermal?: PcbThermalResult;
  issues?: DesignIssue[];
  /** Unrouted connections. When omitted the view computes its own ratsnest from copper connectivity. */
  ratsnest?: RatsnestEdge[];
  /** Colour traces by current density (uses `currents`, else `thermal`, for the per-trace results). */
  traceCurrents?: boolean;
  /** Thermal result used only for trace currents (lets the heatmap stay off while currents are shown). */
  currents?: PcbThermalResult;
}

export interface PcbHoverInfo {
  kind: 'pad' | 'trace' | 'via' | 'component' | 'zone' | 'hole' | 'issue';
  /** Board-frame cursor position (mm). */
  at: Vec2;
  componentId?: string;
  ref?: string;
  value?: string;
  pin?: string;
  pinName?: string;
  netId?: string;
  netName?: string;
  layer?: string;
  traceId?: string;
  viaId?: string;
  issue?: DesignIssue;
}

export interface PcbViewProps {
  board: Board;
  parts: Record<string, PartDef>;
  mode?: PcbMode;
  layers?: Partial<PcbLayerVisibility>;
  overlay?: PcbOverlay;
  selectedIds?: readonly string[];
  highlightNetId?: string | null;
  onSelectComponent?: (id: string | null) => void;
  onHover?: (info: PcbHoverInfo | null) => void;
  /** Called when the user switches mode / toggles layers in the built-in toolbar. */
  onModeChange?: (mode: PcbMode) => void;
  onLayersChange?: (layers: PcbLayerVisibility) => void;
  /** Initial side facing the viewer (toolbar can flip). */
  side?: 'top' | 'bottom';
  /** Show the built-in toolbar (default true). */
  toolbar?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const LAYER_LABELS: { key: PcbLayerKey; label: string; hint?: string }[] = [
  { key: 'top', label: 'Top copper' },
  { key: 'bottom', label: 'Bottom copper' },
  { key: 'inner', label: 'Inner copper' },
  { key: 'zones', label: 'Zones / pours' },
  { key: 'silk', label: 'Silkscreen' },
  { key: 'mask', label: 'Solder mask' },
  { key: 'courtyard', label: 'Courtyards' },
  { key: 'holes', label: 'Drills & holes' },
  { key: 'ratsnest', label: 'Ratsnest' },
];

function hoverKey(h: PcbHoverInfo | null) {
  if (!h) return '';
  return `${h.kind}|${h.componentId ?? ''}|${h.pin ?? ''}|${h.traceId ?? ''}|${h.viaId ?? ''}|${h.netId ?? ''}|${h.issue?.id ?? ''}`;
}

/**
 * Interactive Canvas2D PCB viewer: realistic (mask/finish/silk) or KiCad-like layer view,
 * pan/zoom/pinch, hover tooltips, net highlight, thermal / current / issue / ratsnest overlays.
 */
export function PcbView(props: PcbViewProps) {
  const { board, parts, overlay, selectedIds, highlightNetId, toolbar = true, className, style } = props;
  const [setContainer, size, containerRef] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const zoomRef = useRef<HTMLSpanElement>(null);
  const theme = useViewerTheme(containerRef);

  const [mode, setModeState] = useState<PcbMode>(props.mode ?? 'realistic');
  useEffect(() => {
    if (props.mode) setModeState(props.mode);
  }, [props.mode]);
  const layersKey = JSON.stringify(props.layers ?? {});
  const [layers, setLayersState] = useState<PcbLayerVisibility>(() => ({ ...DEFAULT_PCB_LAYERS, ...props.layers }));
  useEffect(() => {
    setLayersState((s) => ({ ...s, ...(JSON.parse(layersKey) as Partial<PcbLayerVisibility>) }));
  }, [layersKey]);
  const [side, setSide] = useState<'top' | 'bottom'>(props.side ?? 'top');
  useEffect(() => {
    if (props.side) setSide(props.side);
  }, [props.side]);

  const setMode = (m: PcbMode) => {
    setModeState(m);
    props.onModeChange?.(m);
  };
  const setLayer = (k: PcbLayerKey, v: boolean) => {
    setLayersState((s) => {
      const n = { ...s, [k]: v };
      props.onLayersChange?.(n);
      return n;
    });
  };

  /* ------------------------------------------- derived ------------------------------------------- */

  const scene = useMemo<PcbScene>(() => buildPcbScene(board, parts), [board, parts]);
  const thermal = overlay?.thermal && overlay.thermal.boardId === board.id ? overlay.thermal : undefined;
  const currentSrc = overlay?.currents && overlay.currents.boardId === board.id ? overlay.currents : thermal;
  const showHeat = !!thermal && !overlay?.traceCurrents;
  const thermalImg = useMemo(() => (thermal ? buildThermalImage(thermal, side) : null), [thermal, side]);
  const thermalLabels = useMemo(() => (thermal && thermalImg ? thermalLabelsFor(scene, thermal, thermalImg) : []), [scene, thermal, thermalImg]);
  const currents = useMemo(() => (overlay?.traceCurrents && currentSrc ? buildCurrentOverlay(scene, currentSrc) : null), [overlay?.traceCurrents, currentSrc, scene]);
  const issueMarkers = useMemo(() => buildIssueMarkers(scene, overlay?.issues), [scene, overlay?.issues]);
  const providedRats = overlay?.ratsnest;
  const ratsnest = useMemo(() => (providedRats ? providedRats : layers.ratsnest ? computeRatsnest(scene) : null), [providedRats, layers.ratsnest, scene]);
  const selectedKey = (selectedIds ?? []).join('|');
  const selected = useMemo(() => new Set(selectedKey ? selectedKey.split('|') : []), [selectedKey]);

  const [hover, setHover] = useState<{ info: PcbHoverInfo; sx: number; sy: number } | null>(null);

  /* -------------------------------------------- render ------------------------------------------- */

  const viewRef = useRef<View2D>({ k: 1, x: 0, y: 0 });
  const fitKRef = useRef(1);
  const bufferRef = useRef<CanvasRenderingContext2D | null>(null);
  const pzRef = useRef<PanZoom | null>(null);
  const sizeRef = useLatest(size);

  const drawState = useLatest<Omit<PcbDrawState, 'buffer'>>({
    mode,
    layers,
    side,
    theme,
    background: true,
    selected,
    highlightNet: highlightNetId ?? null,
    hoverNet: hover?.info.netId && hover.info.kind !== 'issue' && hover.info.kind !== 'component' ? hover.info.netId : null,
    hoverComp: hover?.info.kind === 'component' ? (hover.info.componentId ?? null) : null,
    thermal: showHeat ? thermalImg : null,
    thermalLabels: showHeat ? thermalLabels : [],
    currents,
    issues: issueMarkers,
    hoverIssue: hover?.info.kind === 'issue' ? (hover.info.issue?.id ?? null) : null,
    ratsnest,
  });
  const sceneRef = useLatest(scene);

  const viewport = useCallback((): PcbViewport | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const dpr = window.devicePixelRatio || 1;
    const v = viewRef.current;
    const mirror = drawState.current.side === 'bottom' ? -1 : 1;
    return { a: mirror * v.k * dpr, d: -v.k * dpr, e: v.x * dpr, f: v.y * dpr, width: canvas.width, height: canvas.height, dpr };
  }, [drawState]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const { width, height } = sizeRef.current;
    if (!canvas || width < 2 || height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(width * dpr);
    const H = Math.round(height * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const ctx = canvas.getContext('2d');
    const vp = viewport();
    if (!ctx || !vp) return;
    drawPcb(ctx, sceneRef.current, vp, {
      ...drawState.current,
      buffer: () => {
        let b = bufferRef.current;
        if (!b) {
          const c = document.createElement('canvas');
          b = bufferRef.current = c.getContext('2d');
        }
        if (b && (b.canvas.width !== W || b.canvas.height !== H)) {
          b.canvas.width = W;
          b.canvas.height = H;
        }
        return b;
      },
    });
    if (zoomRef.current) zoomRef.current.textContent = `${Math.round((viewRef.current.k / fitKRef.current) * 100)}%`;
  }, [drawState, sceneRef, sizeRef, viewport]);
  const requestDraw = useRafCallback(draw);

  // Redraw whenever anything visual changes.
  useEffect(requestDraw, [requestDraw, scene, mode, layers, side, theme, selected, highlightNetId, hover, thermalImg, currents, issueMarkers, ratsnest, size]);

  /* ------------------------------------------- fitting ------------------------------------------- */

  const fitBox = useCallback(() => {
    const s = sceneRef.current;
    const b = s.contentBox;
    const pad = 1.5;
    return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
  }, [sceneRef]);

  const fit = useCallback(
    (animate = true) => {
      const { width, height } = sizeRef.current;
      if (width < 2 || height < 2) return;
      const v = fitView(fitBox(), width, height, { padding: Math.min(36, Math.max(12, Math.min(width, height) * 0.06)), flipY: true, mirrorX: drawState.current.side === 'bottom' });
      fitKRef.current = v.k;
      if (animate && pzRef.current) pzRef.current.animateTo(v);
      else {
        viewRef.current = v;
        pzRef.current?.set(v, false);
        requestDraw();
      }
    },
    [drawState, fitBox, requestDraw, sizeRef],
  );

  const fittedFor = useRef<string | null>(null);
  const lastSize = useRef(size);
  useLayoutEffect(() => {
    if (size.width < 2 || size.height < 2) return;
    if (fittedFor.current !== board.id) {
      fittedFor.current = board.id;
      fit(false);
    } else if (lastSize.current.width !== size.width || lastSize.current.height !== size.height) {
      // Keep the centre fixed on resize.
      const v = viewRef.current;
      const nv = { k: v.k, x: v.x + (size.width - lastSize.current.width) / 2, y: v.y + (size.height - lastSize.current.height) / 2 };
      viewRef.current = nv;
      pzRef.current?.set(nv, false);
      const fv = fitView(fitBox(), size.width, size.height, { padding: 24, flipY: true });
      fitKRef.current = fv.k;
    }
    lastSize.current = size;
    requestDraw();
  }, [size, board.id, fit, fitBox, requestDraw]);

  // Flipping mirrors X around the current screen centre.
  const flip = useCallback(() => {
    const { width } = sizeRef.current;
    const v = viewRef.current;
    const nv = { ...v, x: width - v.x };
    viewRef.current = nv;
    pzRef.current?.set(nv, false);
    setSide((s) => (s === 'top' ? 'bottom' : 'top'));
  }, [sizeRef]);

  /* ------------------------------------------- picking ------------------------------------------- */

  const toBoard = useCallback(
    (sx: number, sy: number): Vec2 => {
      const v = viewRef.current;
      const mirror = drawState.current.side === 'bottom' ? -1 : 1;
      return [(sx - v.x) / (mirror * v.k), (v.y - sy) / v.k];
    },
    [drawState],
  );

  const pickAt = useCallback(
    (sx: number, sy: number): PcbHoverInfo | null => {
      const st = drawState.current;
      const s = sceneRef.current;
      const at = toBoard(sx, sy);
      const v = viewRef.current;
      const mirror = st.side === 'bottom' ? -1 : 1;
      // Issue markers first (screen space).
      for (const m of st.issues ?? []) {
        const mx = v.x + mirror * v.k * m.x;
        const my = v.y - v.k * m.y;
        if (Math.hypot(mx - sx, my - sy) <= 13) return { kind: 'issue', at, issue: m.issue };
      }
      const L = st.layers;
      const hit: PcbHit | null = pickPcb(s, at[0], at[1], {
        tol: 4 / v.k,
        side: st.side,
        layerVisible: (l) => (l === 'top' ? L.top : l === 'bottom' ? L.bottom : L.inner),
        padsOtherSide: st.mode === 'layers',
        zones: L.zones,
      });
      if (!hit) return null;
      const netName = (id?: string) => (id ? (s.nets.get(id)?.net.name ?? id) : undefined);
      switch (hit.kind) {
        case 'pad': {
          const c = hit.comp.comp;
          return {
            kind: 'pad',
            at,
            componentId: c.id,
            ref: c.ref,
            value: c.value ?? hit.comp.part?.value ?? hit.comp.part?.mpn,
            pin: hit.pad.number,
            pinName: hit.pad.pinName,
            netId: hit.pad.netId,
            netName: netName(hit.pad.netId),
            layer: hit.pad.side,
          };
        }
        case 'trace':
          return { kind: 'trace', at, traceId: hit.trace.id, netId: hit.trace.netId, netName: netName(hit.trace.netId), layer: hit.trace.layer };
        case 'via':
          return { kind: 'via', at, viaId: hit.via.id, netId: hit.via.netId, netName: netName(hit.via.netId) };
        case 'hole':
          return { kind: 'hole', at, netId: hit.hole.netId, netName: netName(hit.hole.netId) };
        case 'zone':
          return { kind: 'zone', at, netId: hit.zone.netId, netName: netName(hit.zone.netId), layer: hit.layer };
        case 'comp': {
          const c = hit.comp.comp;
          return { kind: 'component', at, componentId: c.id, ref: c.ref, value: c.value ?? hit.comp.part?.value ?? hit.comp.part?.mpn };
        }
      }
    },
    [drawState, sceneRef, toBoard],
  );

  const onHoverRef = useLatest(props.onHover);
  const onSelectRef = useLatest(props.onSelectComponent);
  const lastHoverKey = useRef('');

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const pz = new PanZoom(el, {
      onChange: (v) => {
        viewRef.current = v;
        requestDraw();
      },
      minK: () => fitKRef.current * 0.2,
      maxK: () => Math.max(fitKRef.current * 80, 400),
      onHover: (sx, sy, _e, dragging) => {
        const at = toBoard(sx, sy);
        if (statusRef.current) statusRef.current.textContent = `X ${at[0].toFixed(2)}  Y ${at[1].toFixed(2)} mm`;
        const info = dragging ? null : pickAt(sx, sy);
        const key = hoverKey(info);
        if (info) setHover({ info, sx, sy });
        else setHover(null);
        if (key !== lastHoverKey.current) {
          lastHoverKey.current = key;
          onHoverRef.current?.(info);
        }
      },
      onLeave: () => {
        setHover(null);
        if (lastHoverKey.current) {
          lastHoverKey.current = '';
          onHoverRef.current?.(null);
        }
      },
      onClick: (sx, sy) => {
        const info = pickAt(sx, sy);
        onSelectRef.current?.(info?.componentId && (info.kind === 'pad' || info.kind === 'component') ? info.componentId : null);
      },
      onDoubleClick: () => fit(true),
    });
    pz.set(viewRef.current, false);
    pzRef.current = pz;
    return () => {
      pz.destroy();
      pzRef.current = null;
    };
  }, [containerRef, fit, onHoverRef, onSelectRef, pickAt, requestDraw, toBoard]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const { width, height } = sizeRef.current;
    if (e.key === 'f' || e.key === 'F') fit(true);
    else if (e.key === 'b' || e.key === 'B') flip();
    else if (e.key === 'm' || e.key === 'M') setMode(mode === 'realistic' ? 'layers' : 'realistic');
    else if (e.key === '+' || e.key === '=') pzRef.current?.zoomAt(width / 2, height / 2, 1.4);
    else if (e.key === '-' || e.key === '_') pzRef.current?.zoomAt(width / 2, height / 2, 1 / 1.4);
    else return;
    e.preventDefault();
  };

  /* --------------------------------------------- UI ---------------------------------------------- */

  const lp = layersPalette(theme);
  const rp = realisticPalette(board.stackup);
  const swatch: Record<PcbLayerKey, string> = {
    top: mode === 'layers' ? lp.copper.top : rp.copperUnderMask,
    bottom: mode === 'layers' ? lp.copper.bottom : rp.copperUnderMask,
    inner: lp.copper.in1,
    zones: mode === 'layers' ? lp.copper.top : rp.copperUnderMask,
    silk: mode === 'layers' ? lp.silkTop : rp.silk === '#151515' ? '#151515' : '#d6d6d0',
    mask: mode === 'layers' ? lp.mask : rp.mask,
    courtyard: lp.courtTop,
    holes: theme.textDim,
    ratsnest: theme.text,
  };
  const layerRows = LAYER_LABELS.filter((l) => l.key !== 'inner' || (board.stackup?.layers ?? 2) > 2);
  const errors = issueMarkers.filter((m) => m.severity === 'error').length;
  const warnings = issueMarkers.filter((m) => m.severity === 'warning').length;

  return (
    <div
      ref={setContainer}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cx('relative h-full min-h-[220px] w-full overflow-hidden outline-none select-none', className)}
      style={{ background: theme.canvas, cursor: hover?.info.kind === 'component' || hover?.info.kind === 'pad' ? 'pointer' : 'default', ...style }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {toolbar && (
        <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap items-start gap-1.5">
          <FloatPanel className="flex items-center gap-0.5 p-1">
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: 'realistic', label: <><Sparkles className="h-3.5 w-3.5" /><span className="hidden sm:inline">Realistic</span></>, title: 'Realistic render (M)' },
                { value: 'layers', label: <><LayersIcon className="h-3.5 w-3.5" /><span className="hidden sm:inline">Layers</span></>, title: 'Layer view (M)' },
              ]}
            />
            <ToolDivider />
            <Popover
              trigger={(open, toggle) => (
                <ToolButton title="Layer visibility" active={open} onClick={toggle}>
                  <LayersIcon className="h-4 w-4" />
                </ToolButton>
              )}
            >
              <div className="px-2 pt-1 pb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-(--text-dim)">Layers</div>
              {layerRows.map((l) => (
                <SwatchToggle key={l.key} label={l.label} color={swatch[l.key]} checked={layers[l.key]} onChange={(v) => setLayer(l.key, v)} />
              ))}
            </Popover>
            <ToolButton title={side === 'top' ? 'View from bottom (B)' : 'View from top (B)'} active={side === 'bottom'} onClick={flip}>
              <FlipHorizontal2 className="h-4 w-4" />
            </ToolButton>
            <ToolDivider />
            <ToolButton title="Zoom out (−)" onClick={() => pzRef.current?.zoomAt(size.width / 2, size.height / 2, 1 / 1.4)}>
              <Minus className="h-4 w-4" />
            </ToolButton>
            <ToolButton title="Zoom in (+)" onClick={() => pzRef.current?.zoomAt(size.width / 2, size.height / 2, 1.4)}>
              <Plus className="h-4 w-4" />
            </ToolButton>
            <ToolButton title="Fit board (F)" onClick={() => fit(true)}>
              <Maximize className="h-4 w-4" />
            </ToolButton>
          </FloatPanel>
          {side === 'bottom' && (
            <FloatPanel className="px-2 py-1.5 text-[11px] font-medium text-(--text-dim)">Bottom view · mirrored</FloatPanel>
          )}
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2">
        <FloatPanel className="pointer-events-none hidden items-center gap-2 px-2 py-1 font-mono text-[10.5px] text-(--text-dim) tabular-nums sm:flex">
          <span ref={statusRef}>{board.name}</span>
          <span className="h-3 w-px bg-(--border)" />
          <span ref={zoomRef}>100%</span>
        </FloatPanel>
        <div className="flex flex-col items-end gap-1.5">
          {(errors > 0 || warnings > 0) && (
            <FloatPanel className="flex items-center gap-2 px-2 py-1 text-[11px]">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
              {errors > 0 && <span className="font-medium text-red-500">{errors} error{errors > 1 ? 's' : ''}</span>}
              {warnings > 0 && <span className="font-medium text-amber-500">{warnings} warning{warnings > 1 ? 's' : ''}</span>}
            </FloatPanel>
          )}
          {showHeat && thermalImg && (
            <FloatPanel className="w-[220px] px-2.5 pt-2 pb-1.5">
              <ColorLegend min={thermalImg.min} max={thermalImg.max} unit="°C" map="turbo" title={`Temperature · ${side}`} />
            </FloatPanel>
          )}
          {currents && (
            <FloatPanel className="w-[220px] px-2.5 pt-2 pb-1.5">
              <ColorLegend min={0} max={currents.maxDensity} unit="A/mm²" map="turbo" title="Current density" />
            </FloatPanel>
          )}
        </div>
      </div>

      {hover && <PcbTooltip info={hover.info} sx={hover.sx} sy={hover.sy} w={size.width} h={size.height} thermal={currentSrc} />}
    </div>
  );
}

function PcbTooltip({ info, sx, sy, w, h, thermal }: { info: PcbHoverInfo; sx: number; sy: number; w: number; h: number; thermal?: PcbThermalResult }) {
  const comp = info.componentId ? thermal?.components.find((c) => c.componentId === info.componentId) : undefined;
  const traceRes = info.traceId ? thermal?.traces.filter((t) => t.traceId === info.traceId) : undefined;
  const worstTrace = traceRes?.length ? traceRes.reduce((a, b) => (b.currentDensity > a.currentDensity ? b : a)) : undefined;
  const sevColor = info.issue?.severity === 'error' ? 'text-red-500' : info.issue?.severity === 'warning' ? 'text-amber-500' : 'text-sky-500';
  return (
    <HoverCard x={sx} y={sy} containerW={w} containerH={h}>
      {info.kind === 'issue' && info.issue ? (
        <div className="flex flex-col gap-1">
          <div className={cx('text-[10.5px] font-semibold uppercase tracking-wide', sevColor)}>
            {info.issue.severity} · {info.issue.category} · {info.issue.code}
          </div>
          <div className="font-medium">{info.issue.message}</div>
          {info.issue.suggestion && <div className="text-(--text-dim)">{info.issue.suggestion}</div>}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-baseline gap-2">
            {info.ref && <span className="font-mono text-[12.5px] font-semibold">{info.ref}</span>}
            {info.pin && (
              <span className="font-mono text-(--text-dim)">
                pin {info.pin}
                {info.pinName && info.pinName !== info.pin ? ` · ${info.pinName}` : ''}
              </span>
            )}
            {!info.ref && <span className="text-[10.5px] font-semibold uppercase tracking-wide text-(--text-dim)">{info.kind}</span>}
          </div>
          {info.value && <div className="text-(--text-dim)">{info.value}</div>}
          {info.netName && (
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-500" />
              <span className="font-mono">{info.netName}</span>
              {info.layer && <span className="text-(--text-dim)">· {info.layer}</span>}
            </div>
          )}
          {comp && (
            <div className="mt-1 font-mono text-[11px] text-(--text-dim)">
              {fmtQuantity(comp.power, 'W', 2)} · T<sub>j</sub> {comp.tJunction.toFixed(1)} °C{comp.tjMax ? ` / ${comp.tjMax}` : ''}
            </div>
          )}
          {worstTrace && (
            <div className="mt-1 font-mono text-[11px] text-(--text-dim)">
              {formatValue(worstTrace.current, 'A')} · {worstTrace.currentDensity.toFixed(1)} A/mm² · ΔT {worstTrace.tempRise.toFixed(1)} °C
            </div>
          )}
        </div>
      )}
    </HoverCard>
  );
}
