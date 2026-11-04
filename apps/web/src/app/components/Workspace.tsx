import { lazy, Suspense } from 'react';
import { Activity, Binary, Box, CircuitBoard, Factory, LayoutDashboard, Loader2, Package, Waypoints } from 'lucide-react';
import { useApp, type WorkspaceTab } from '../store';
import { OverviewTab } from './tabs/OverviewTab';
import { PartsTab } from './tabs/PartsTab';
import { ManufacturingTab } from './tabs/ManufacturingTab';
import { FirmwareTab } from './tabs/FirmwareTab';
import { Inspector } from './Inspector';

const SchematicTab = lazy(() => import('./tabs/SchematicTab'));
const PcbTab = lazy(() => import('./tabs/PcbTab'));
const AssemblyTab = lazy(() => import('./tabs/AssemblyTab'));
const SimulationTab = lazy(() => import('./tabs/SimulationTab'));

const TABS: { id: WorkspaceTab; label: string; icon: typeof Box }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'schematic', label: 'Schematic', icon: Waypoints },
  { id: 'pcb', label: 'PCB', icon: CircuitBoard },
  { id: 'assembly', label: '3D', icon: Box },
  { id: 'parts', label: 'Parts & BOM', icon: Package },
  { id: 'simulation', label: 'Simulations', icon: Activity },
  { id: 'firmware', label: 'Firmware', icon: Binary },
  { id: 'manufacturing', label: 'Manufacturing', icon: Factory },
];

export function Workspace() {
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const project = useApp((s) => s.project);
  const selection = useApp((s) => s.selection);
  const running = useApp((s) => s.project?.simulations.filter((x) => x.status === 'running').length ?? 0);
  const issues = useApp((s) => s.project?.issues.filter((i) => i.severity === 'error').length ?? 0);
  if (!project) return null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="tabbar flex h-12 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-[var(--border)] px-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`mb-1.5 flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition ${active ? 'bg-[var(--bg-elev)] text-[var(--text)] shadow-[var(--shadow)] ring-1 ring-[var(--border)]' : 'dim hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'}`}
            >
              <Icon size={14} className={active ? 'text-[var(--accent)]' : ''} />
              {t.label}
              {t.id === 'simulation' && running > 0 && <Loader2 size={11} className="animate-spin text-[var(--accent)]" />}
              {t.id === 'manufacturing' && issues > 0 && <span className="chip chip-err !h-4 !px-1.5 !text-[10px]">{issues}</span>}
            </button>
          );
        })}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <Suspense
            fallback={
              <div className="grid h-full place-items-center">
                <Loader2 className="animate-spin opacity-50" />
              </div>
            }
          >
            {tab === 'overview' && <OverviewTab />}
            {tab === 'schematic' && <SchematicTab />}
            {tab === 'pcb' && <PcbTab />}
            {tab === 'assembly' && <AssemblyTab />}
            {tab === 'parts' && <PartsTab />}
            {tab === 'simulation' && <SimulationTab />}
            {tab === 'firmware' && <FirmwareTab />}
            {tab === 'manufacturing' && <ManufacturingTab />}
          </Suspense>
        </div>
        {selection && (selection.kind === 'component' || selection.kind === 'part' || selection.kind === 'mech') && <Inspector />}
      </div>
    </div>
  );
}
