import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Layers2, Loader2, Maximize, MoveDown, MoveRight, Rotate3d } from 'lucide-react';
import { ColorLegend } from '../ColorLegend';
import { fmtQuantity } from '../common/format';
import { useElementSize, useLatest } from '../common/hooks';
import { useViewerTheme } from '../common/theme';
import { cx, FloatPanel, HoverCard, ToolButton, ToolDivider } from '../common/ui';
import { AssemblyScene, type HoverInfo, type OverlayInfo } from './scene';
import type { Assembly3DProps } from './types';

export default function Assembly3DImpl(props: Assembly3DProps) {
  const { project, getMesh, selectedId, explode = 0, xray = false, section = null, overlay, showFasteners = true, toolbar = true, className, style } = props;
  const [setContainer, size, containerRef] = useElementSize<HTMLDivElement>();
  const mountRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const theme = useViewerTheme(containerRef);
  const sceneRef = useRef<AssemblyScene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [pending, setPending] = useState(0);
  const [info, setInfo] = useState<OverlayInfo>({});
  const [slice, setSlice] = useState(0.5);
  const onSelectRef = useLatest(props.onSelect);
  const themeRef = useLatest(theme);

  useLayoutEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    let scene: AssemblyScene;
    try {
      scene = new AssemblyScene(el, themeRef.current, {
        onHover: setHover,
        onPick: (sel) => onSelectRef.current?.(sel),
        onLoading: setPending,
        onOverlayInfo: setInfo,
        onMarker: (x, y, visible) => {
          const m = markerRef.current;
          if (!m) return;
          m.style.display = visible ? 'block' : 'none';
          m.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'WebGL is not available');
      return;
    }
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, [onSelectRef, themeRef]);

  useEffect(() => sceneRef.current?.setTheme(theme), [theme]);
  useEffect(() => sceneRef.current?.resize(size.width, size.height), [size]);
  useEffect(() => sceneRef.current?.setProject(project, getMesh), [project, getMesh]);
  useEffect(() => sceneRef.current?.setExplode(explode), [explode]);
  useEffect(() => sceneRef.current?.setXray(xray), [xray]);
  const sectionKey = section ? `${section.axis}:${section.offset}` : '';
  useEffect(() => sceneRef.current?.setSection(section), [sectionKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => sceneRef.current?.setOverlay(overlay), [overlay?.structural, overlay?.airflow, overlay?.pcbThermal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => sceneRef.current?.setShowFasteners(showFasteners), [showFasteners]);
  useEffect(() => sceneRef.current?.setSelected(selectedId), [selectedId]);
  useEffect(() => sceneRef.current?.setAirflowSlice(slice), [slice]);

  const s = info.structural;
  const a = info.airflow;
  const t = info.pcbThermal;
  const structural = overlay?.structural;

  return (
    <div
      ref={setContainer}
      className={cx('relative h-full min-h-[240px] w-full overflow-hidden select-none', className)}
      style={{
        background: `radial-gradient(120% 90% at 50% 18%, color-mix(in srgb, ${theme.canvas} 82%, ${theme.dark ? '#5b6b80' : '#ffffff'}) 0%, ${theme.canvas} 62%)`,
        ...style,
      }}
    >
      <div ref={mountRef} className="absolute inset-0" />

      {error && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-[12.5px] text-(--text-dim)">
          <div>
            <Box className="mx-auto mb-2 h-6 w-6 opacity-60" />
            3D view unavailable — {error}
          </div>
        </div>
      )}

      {toolbar && !error && (
        <div className="pointer-events-none absolute top-2 right-2 flex items-center gap-1.5">
          <FloatPanel className="flex items-center gap-0.5 p-1">
            <ToolButton title="Isometric view" onClick={() => sceneRef.current?.view('iso')}>
              <Rotate3d className="h-4 w-4" />
            </ToolButton>
            <ToolButton title="Top view" onClick={() => sceneRef.current?.view('top')}>
              <MoveDown className="h-4 w-4" />
            </ToolButton>
            <ToolButton title="Front view" onClick={() => sceneRef.current?.view('front')}>
              <Layers2 className="h-4 w-4" />
            </ToolButton>
            <ToolButton title="Right view" onClick={() => sceneRef.current?.view('right')}>
              <MoveRight className="h-4 w-4" />
            </ToolButton>
            <ToolDivider />
            <ToolButton title="Fit to view" onClick={() => sceneRef.current?.fit(true)}>
              <Maximize className="h-4 w-4" />
            </ToolButton>
          </FloatPanel>
        </div>
      )}

      {pending > 0 && (
        <div className="pointer-events-none absolute top-2 left-2">
          <FloatPanel className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-(--text-dim)">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading {pending} mesh{pending === 1 ? '' : 'es'}…
          </FloatPanel>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex flex-wrap items-end gap-2">
        {s && structural && (
          <FloatPanel className="flex w-[250px] flex-col gap-2 px-2.5 py-2">
            <ColorLegend min={0} max={s.max} unit="MPa" map="turbo" title="von Mises stress" />
            <div className="grid grid-cols-3 gap-1 font-mono text-[10.5px] text-(--text-dim)">
              <span>
                σ<sub>max</sub> <span className="text-(--text)">{fmtQuantity(structural.maxVonMises, 'MPa', 3)}</span>
              </span>
              <span>
                SF <span className={structural.minSafetyFactor < 1.5 ? 'text-red-500' : structural.minSafetyFactor < 2 ? 'text-amber-500' : 'text-emerald-500'}>{structural.minSafetyFactor.toFixed(2)}</span>
              </span>
              <span>
                δ <span className="text-(--text)">{fmtQuantity(structural.maxDisplacement, 'mm', 3)}</span>
              </span>
            </div>
          </FloatPanel>
        )}
        {a && (
          <FloatPanel className="flex w-[250px] flex-col gap-2 px-2.5 py-2">
            <ColorLegend min={a.tMin} max={a.tMax} unit="°C" map="turbo" title="Air temperature" />
            <ColorLegend min={0} max={a.vMax} unit="m/s" map="turbo" title="Flow speed" />
            <label data-pz-ignore="" className="pointer-events-auto flex items-center gap-2 text-[11px] text-(--text-dim)">
              <span className="w-[54px] shrink-0">Slice z</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={slice}
                onChange={(e) => setSlice(+e.target.value)}
                className="h-1 min-w-0 flex-1 cursor-pointer accent-cyan-500"
                aria-label="Temperature slice height"
              />
              <span className="w-[52px] text-right font-mono text-(--text)">{a.sliceZ.toFixed(1)} mm</span>
            </label>
          </FloatPanel>
        )}
        {t && (
          <FloatPanel className="w-[230px] px-2.5 py-2">
            <ColorLegend min={t.min} max={t.max} unit="°C" map="turbo" title="Board temperature" />
          </FloatPanel>
        )}
      </div>

      <div ref={markerRef} className="pointer-events-none absolute top-0 left-0" style={{ display: 'none' }}>
        {s && (
          <div className="relative -translate-y-full">
            <div className="ml-3 -translate-y-2 rounded-md border border-red-500/40 bg-black/80 px-1.5 py-0.5 font-mono text-[10.5px] whitespace-nowrap text-white shadow-lg">
              max {fmtQuantity(s.max, 'MPa', 3)}
            </div>
          </div>
        )}
      </div>

      {hover && (
        <HoverCard x={hover.x} y={hover.y} containerW={size.width} containerH={size.height}>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[12.5px] font-semibold">{hover.title}</span>
            {hover.subtitle && <span className="text-(--text-dim)">{hover.subtitle}</span>}
            {hover.detail && <span className="text-[11px] text-(--text-dim) capitalize">{hover.detail}</span>}
          </div>
        </HoverCard>
      )}
    </div>
  );
}
