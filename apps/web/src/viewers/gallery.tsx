import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, Box, CircuitBoard, Cpu, Gauge, Layers, Moon, Palette, Sun, Waypoints, Zap } from 'lucide-react';
import type { Assembly3DOverlay, Assembly3DSelection } from './three/types';
import { Assembly3D } from './three/Assembly3D';
import { PcbView } from './pcb/PcbView';
import type { PcbMode } from './pcb/draw';
import { SchematicView } from './schematic/SchematicView';
import { WaveformPlot } from './plot/WaveformPlot';
import { LogicAnalyzer } from './plot/LogicAnalyzer';
import { ColorLegend } from './ColorLegend';
import { MetricPill, SimSummaryCard } from './MetricPill';
import { ThermalSummaryCard } from './ThermalSummaryCard';
import { cx, Segmented } from './common/ui';
import { demoData } from './demo/project';

const THEME_KEY = 'pcbcad-gallery-theme';

function Card({ id, icon, title, subtitle, actions, children, className, bodyClassName }: { id?: string; icon: ReactNode; title: string; subtitle?: string; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section id={id} className={cx('flex min-w-0 scroll-mt-20 flex-col overflow-hidden rounded-xl border border-(--border) bg-(--bg-elev) shadow-[0_1px_2px_rgba(0,0,0,.04),0_12px_32px_-24px_rgba(0,0,0,.4)]', className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-(--border) px-3.5 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-500/10 text-accent-700 dark:text-accent-300">{icon}</span>
          <div className="min-w-0">
            <h2 className="truncate text-[13.5px] font-semibold text-(--text)">{title}</h2>
            {subtitle && <p className="truncate text-[11.5px] text-(--text-dim)">{subtitle}</p>}
          </div>
        </div>
        <div className="flex-1" />
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className={cx('relative min-w-0', bodyClassName)}>{children}</div>
    </section>
  );
}

function Toggle({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={cx(
        'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium transition-colors',
        on ? 'border-accent-500/40 bg-accent-500/12 text-accent-700 dark:text-accent-300' : 'border-(--border) text-(--text-dim) hover:text-(--text)',
      )}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', on ? 'bg-accent-500' : 'bg-(--border)')} />
      {children}
    </button>
  );
}

function Slider({ label, value, min, max, step, onChange, format, width = 'w-28' }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string; width?: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-[12px] text-(--text-dim)">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} className={cx('h-1 cursor-pointer accent-cyan-500', width)} />
      {format && <span className="w-12 font-mono text-[11px] text-(--text) tabular-nums">{format(value)}</span>}
    </label>
  );
}

function Chip({ children, tone = 'dim' }: { children: ReactNode; tone?: 'dim' | 'accent' }) {
  return (
    <span className={cx('inline-flex h-6 items-center gap-1.5 rounded-full border px-2 font-mono text-[11px]', tone === 'accent' ? 'border-accent-500/40 bg-accent-500/10 text-accent-700 dark:text-accent-300' : 'border-(--border) text-(--text-dim)')}>
      {children}
    </span>
  );
}

const SECTION_RANGE: Record<'x' | 'y' | 'z', [number, number]> = { x: [-38, 38], y: [-28, 28], z: [-3, 25] };

export function Gallery() {
  const demo = useMemo(() => demoData(), []);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as 'dark' | 'light') || (document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // Cross-probing state shared by every viewer.
  const [selected, setSelected] = useState<string | null>(null);
  const [hoverNet, setHoverNet] = useState<string | null>(null);
  const selIds = useMemo(() => (selected ? [selected] : []), [selected]);
  const selRef = useMemo(() => demo.main.components.find((c) => c.id === selected)?.ref ?? demo.sat.components.find((c) => c.id === selected)?.ref ?? null, [demo, selected]);
  const hoverNetName = demo.main.nets.find((n) => n.id === hoverNet)?.name;

  const [pcbMode, setPcbMode] = useState<PcbMode>('realistic');
  const [pcbOverlay, setPcbOverlay] = useState<'issues' | 'thermal' | 'currents' | 'none'>('issues');
  const [stressMs, setStressMs] = useState(0);
  const stressAcc = useRef({ n: 0, sum: 0, t: 0 });

  const [explode, setExplode] = useState(0);
  const [xray, setXray] = useState(false);
  const [sectionAxis, setSectionAxis] = useState<'off' | 'x' | 'y' | 'z'>('off');
  const [sectionOffset, setSectionOffset] = useState(0);
  const [overlay3d, setOverlay3d] = useState<'none' | 'structural' | 'airflow' | 'pcb'>('none');
  const [fasteners, setFasteners] = useState(true);

  const overlay: Assembly3DOverlay = useMemo(
    () => (overlay3d === 'structural' ? { structural: demo.structural } : overlay3d === 'airflow' ? { airflow: demo.airflow } : overlay3d === 'pcb' ? { pcbThermal: demo.thermal } : {}),
    [overlay3d, demo],
  );
  const section = useMemo(() => (sectionAxis === 'off' ? null : { axis: sectionAxis, offset: sectionOffset }), [sectionAxis, sectionOffset]);

  const onSelect3d = (s: Assembly3DSelection | null) => setSelected(s?.kind === 'component' ? s.componentId : s?.kind === 'mech' ? (s.instanceId ?? s.partId) : s?.kind === 'part' ? s.fastenerId : s?.kind === 'board' ? (s.instanceId ?? s.boardId) : null);

  const pcbOverlayObj = useMemo(
    () => ({
      issues: pcbOverlay === 'issues' ? demo.issues : undefined,
      thermal: pcbOverlay === 'thermal' ? demo.thermal : undefined,
      currents: pcbOverlay === 'currents' ? demo.thermal : undefined,
      traceCurrents: pcbOverlay === 'currents',
    }),
    [pcbOverlay, demo],
  );

  const nav = [
    ['schematic', 'Schematic'],
    ['pcb', 'PCB'],
    ['assembly', '3D'],
    ['plots', 'Plots'],
    ['firmware', 'Firmware'],
    ['bits', 'Bits'],
  ];

  return (
    <div className="min-h-full bg-(--bg) text-(--text)">
      <header className="sticky top-0 z-40 border-b border-(--border) bg-(--bg)/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-linear-to-br from-accent-400 to-accent-700 text-white shadow-[0_6px_16px_-8px_rgba(6,182,212,.8)]">
              <CircuitBoard className="h-4.5 w-4.5" />
            </span>
            <div className="leading-tight">
              <div className="text-[14px] font-semibold tracking-tight">PCBCAD viewers</div>
              <div className="hidden text-[11.5px] text-(--text-dim) sm:block">{demo.project.name} · rev {demo.project.revision}</div>
            </div>
          </div>
          <nav className="ml-4 hidden items-center gap-1 md:flex">
            {nav.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="rounded-md px-2.5 py-1.5 text-[12.5px] text-(--text-dim) transition-colors hover:bg-(--bg-sunken) hover:text-(--text)">
                {label}
              </a>
            ))}
          </nav>
          <div className="flex-1" />
          {selRef && (
            <button type="button" onClick={() => setSelected(null)} className="hidden sm:block" title="Clear selection">
              <Chip tone="accent">selected {selRef} ✕</Chip>
            </button>
          )}
          {hoverNetName && (
            <span className="hidden lg:inline">
              <Chip>net {hoverNetName}</Chip>
            </span>
          )}
          <button
            type="button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="inline-flex h-8 items-center gap-2 rounded-lg border border-(--border) bg-(--bg-elev) px-2.5 text-[12px] font-medium text-(--text-dim) transition-colors hover:text-(--text)"
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1440px] flex-col gap-5 px-3 py-5 sm:px-4 sm:py-6">
        <div className="flex flex-col gap-1 px-1">
          <h1 className="text-[20px] font-semibold tracking-tight sm:text-[22px]">Viewer gallery</h1>
          <p className="max-w-3xl text-[13px] text-(--text-dim)">
            Synthetic “{demo.project.name}” project: a 60×40 mm two-layer board with an ATmega328P, AMS1117 regulator, BME280 sensor and USB-C, a remote probe board on a JST cable, an injection-molded enclosure and a sheet-metal bracket. Selection and net
            hover are cross-probed between all viewers.
          </p>
        </div>

        <Card
          id="schematic"
          icon={<Waypoints className="h-4 w-4" />}
          title="Schematic"
          subtitle="Auto-laid out from the netlist · hover a label to trace a net, click a symbol to select"
          actions={
            <>
              <Chip>{demo.main.components.length} parts</Chip>
              <Chip>{demo.main.nets.length} nets</Chip>
            </>
          }
          bodyClassName="h-[420px] sm:h-[600px]"
        >
          <SchematicView project={demo.project} boardId={demo.main.id} selectedIds={selIds} highlightNetId={null} onSelectComponent={setSelected} onHoverNet={setHoverNet} />
        </Card>

        <Card
          id="pcb"
          icon={<CircuitBoard className="h-4 w-4" />}
          title="PCB — Main board"
          subtitle="Realistic ENIG render or KiCad-style layers · DRC markers, thermal map and trace currents"
          actions={
            <>
              <Segmented
                value={pcbOverlay}
                onChange={setPcbOverlay}
                options={[
                  { value: 'issues', label: 'Issues' },
                  { value: 'thermal', label: 'Thermal' },
                  { value: 'currents', label: 'Currents' },
                  { value: 'none', label: 'None' },
                ]}
              />
            </>
          }
          bodyClassName="h-[400px] sm:h-[560px]"
        >
          <PcbView board={demo.main} parts={demo.parts} mode={pcbMode} onModeChange={setPcbMode} overlay={pcbOverlayObj} selectedIds={selIds} highlightNetId={hoverNet} onSelectComponent={setSelected} />
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card icon={<Layers className="h-4 w-4" />} title="PCB — Remote probe" subtitle="Black ENIG · layers mode, not yet in the assembly" bodyClassName="h-[340px] sm:h-[400px]">
            <PcbView board={demo.sat} parts={demo.parts} mode="layers" layers={{ courtyard: true }} selectedIds={selIds} onSelectComponent={setSelected} />
          </Card>
          <Card
            icon={<Gauge className="h-4 w-4" />}
            title="PCB — Stress test"
            subtitle={`${demo.stress.components.length} parts · ${demo.stress.traces.length} traces · 4 layers`}
            actions={<Chip tone={stressMs > 0 ? 'accent' : 'dim'}>{stressMs > 0 ? `${stressMs.toFixed(1)} ms / frame` : 'draw –'}</Chip>}
            bodyClassName="h-[340px] sm:h-[400px]"
          >
            <PcbView
              board={demo.stress}
              parts={demo.parts}
              mode="layers"
              onDrawStats={(ms) => {
                const a = stressAcc.current;
                a.n++;
                a.sum += ms;
                const now = performance.now();
                if (now - a.t > 400) {
                  setStressMs(a.sum / a.n);
                  a.n = 0;
                  a.sum = 0;
                  a.t = now;
                }
              }}
            />
          </Card>
        </div>

        <Card
          id="assembly"
          icon={<Box className="h-4 w-4" />}
          title="Assembly"
          subtitle="Boards, components, enclosure, sheet metal and fasteners · click to select, drag to orbit"
          actions={
            <>
              <Slider label="Explode" value={explode} min={0} max={1} step={0.01} onChange={setExplode} width="w-20 sm:w-28" />
              <Toggle on={xray} onChange={setXray}>
                X-ray
              </Toggle>
              <Toggle on={fasteners} onChange={setFasteners}>
                Fasteners
              </Toggle>
              <Segmented
                size="xs"
                value={sectionAxis}
                onChange={(v) => {
                  setSectionAxis(v);
                  if (v !== 'off') setSectionOffset(v === 'z' ? 9 : 0);
                }}
                options={[
                  { value: 'off', label: 'No cut' },
                  { value: 'x', label: 'X' },
                  { value: 'y', label: 'Y' },
                  { value: 'z', label: 'Z' },
                ]}
              />
              {sectionAxis !== 'off' && <Slider label="" value={sectionOffset} min={SECTION_RANGE[sectionAxis][0]} max={SECTION_RANGE[sectionAxis][1]} step={0.25} onChange={setSectionOffset} format={(v) => `${v.toFixed(1)}`} width="w-24" />}
              <Segmented
                size="xs"
                value={overlay3d}
                onChange={setOverlay3d}
                options={[
                  { value: 'none', label: 'Model' },
                  { value: 'structural', label: 'Stress' },
                  { value: 'airflow', label: 'Airflow' },
                  { value: 'pcb', label: 'PCB heat' },
                ]}
              />
            </>
          }
          bodyClassName="h-[440px] sm:h-[620px]"
        >
          <Assembly3D
            project={demo.project}
            getMesh={demo.getMesh}
            explode={explode}
            xray={xray}
            section={section}
            overlay={overlay}
            showFasteners={fasteners}
            selectedId={selected}
            onSelect={onSelect3d}
          />
        </Card>

        <div id="plots" className="grid scroll-mt-20 gap-5 lg:grid-cols-[1.35fr_1fr]">
          <Card icon={<Activity className="h-4 w-4" />} title="Power-up transient" subtitle="USB plug-in → LDO regulation → firmware start · drag to zoom, double-click to reset" bodyClassName="p-3">
            <WaveformPlot time={demo.transient.time} signals={demo.transient.signals} height={260} />
          </Card>
          <ThermalSummaryCard result={demo.thermal} selectedId={selected} onSelectComponent={setSelected} />
        </div>

        <Card id="firmware" icon={<Cpu className="h-4 w-4" />} title="Firmware run" subtitle="Mixed-signal simulation · ATmega328P emulator, 2 s" bodyClassName="">
          <LogicAnalyzer result={demo.mixed} />
        </Card>

        <div id="bits" className="grid scroll-mt-20 gap-5 lg:grid-cols-2">
          <Card icon={<Palette className="h-4 w-4" />} title="Legends & metrics" subtitle="Reusable bits for simulation summaries" bodyClassName="flex flex-col gap-5 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorLegend min={25} max={demo.thermal.maxTemp} unit="°C" map="turbo" title="Turbo" />
              <ColorLegend min={0} max={18.6} unit="MPa" map="inferno" title="Inferno" marker={{ value: 12.4, label: 'Yield / SF 2' }} />
            </div>
            <div className="flex flex-wrap gap-2">
              <MetricPill label="Max temp" value={demo.thermal.maxTemp} unit="°C" status="ok" />
              <MetricPill label="Safety factor" value={demo.structural.minSafetyFactor} unit="" status={demo.structural.minSafetyFactor < 2 ? 'warn' : 'ok'} limit={2} />
              <MetricPill label="Inrush" value={0.94} unit="A" status="warn" />
              <MetricPill label="IR drop" value={0.0118} unit="V" />
              <MetricPill label="Unrouted" value={1} status="fail" />
            </div>
            <div className="flex items-start gap-5">
              <ColorLegend min={0} max={0.06} unit="m/s" map="turbo" title="Vertical" orientation="vertical" length={120} />
              <SimSummaryCard summary={demo.summary} title="PCB thermal · natural convection" className="min-w-0 flex-1" />
            </div>
          </Card>
          <Card icon={<Zap className="h-4 w-4" />} title="Symbol library" subtitle="Every symbol family, placed from explicit schematic positions" bodyClassName="h-[420px] sm:h-[520px]">
            <SchematicView project={demo.sampler} boardId="brd_sampler" />
          </Card>
        </div>

        <footer className="px-1 pb-6 text-[11.5px] text-(--text-dim)">Synthetic demo data generated in the browser — the real app streams projects, meshes and simulation results from the server.</footer>
      </main>
    </div>
  );
}
