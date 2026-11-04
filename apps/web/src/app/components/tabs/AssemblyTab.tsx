import { useMemo, useState } from 'react';
import { Box, Eye, Loader2, Scissors, Wrench } from 'lucide-react';
import type { AirflowResult, DropResult, PcbThermalResult, StructuralResult } from '@pcbcad/core';
import { Assembly3D } from '../../../viewers';
import { makeMeshLoader } from '../../api';
import { useLatestRun, useSimResult } from '../../hooks';
import { useApp } from '../../store';
import { EmptyState } from '../ui';

type Overlay = 'none' | 'airflow' | 'pcb-thermal';

export default function AssemblyTab() {
  const project = useApp((s) => s.project)!;
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const [explode, setExplode] = useState(0);
  const [xray, setXray] = useState(false);
  const [section, setSection] = useState<'off' | 'x' | 'y' | 'z'>('off');
  const [offset, setOffset] = useState(0);
  const [fasteners, setFasteners] = useState(true);
  const [overlay, setOverlay] = useState<Overlay>('none');
  const airRun = useLatestRun('airflow');
  const thermRun = useLatestRun('pcb-thermal');
  const air = useSimResult<AirflowResult>(overlay === 'airflow' ? airRun : null);
  const therm = useSimResult<PcbThermalResult>(overlay === 'pcb-thermal' ? thermRun : null);
  const getMesh = useMemo(() => makeMeshLoader(project), [project]);
  if (!project.boards.length && !project.mechanical.length) return <EmptyState icon={Box} title="Nothing to show in 3D yet" text="Boards, components, enclosures, sheet metal and fasteners appear here as the agent designs them." />;
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--border)] px-3 py-1.5 text-[12px]">
        <label className="flex items-center gap-2">
          <span className="dim">Explode</span>
          <input type="range" min={0} max={1} step={0.01} value={explode} onChange={(e) => setExplode(+e.target.value)} className="w-28 accent-[var(--accent)]" />
        </label>
        <button className={`btn btn-sm ${xray ? 'btn-primary' : ''}`} onClick={() => setXray((v) => !v)}>
          <Eye size={12} /> X-ray
        </button>
        <div className="flex items-center gap-1">
          <Scissors size={12} className="dim" />
          <select className="input !h-7 !w-auto !py-0 !text-[12px]" value={section} onChange={(e) => setSection(e.target.value as typeof section)}>
            <option value="off">No section</option>
            <option value="x">Section X</option>
            <option value="y">Section Y</option>
            <option value="z">Section Z</option>
          </select>
          {section !== 'off' && <input type="range" min={-80} max={80} step={0.5} value={offset} onChange={(e) => setOffset(+e.target.value)} className="w-24 accent-[var(--accent)]" />}
        </div>
        <button className={`btn btn-sm ${fasteners ? '' : 'opacity-60'}`} onClick={() => setFasteners((v) => !v)}>
          <Wrench size={12} /> Fasteners
        </button>
        <select className="input !h-7 !w-auto !py-0 !text-[12px]" value={overlay} onChange={(e) => setOverlay(e.target.value as Overlay)}>
          <option value="none">No overlay</option>
          <option value="airflow" disabled={!airRun}>
            Airflow & temperature{airRun ? '' : ' (not run)'}
          </option>
          <option value="pcb-thermal" disabled={!thermRun}>
            PCB thermal{thermRun ? '' : ' (not run)'}
          </option>
        </select>
        {(air.loading || therm.loading) && <Loader2 size={13} className="animate-spin" />}
        <span className="flex-1" />
        <span className="dim">
          {project.assembly.instances.length} instances · {project.assembly.fasteners.length} fasteners
        </span>
      </div>
      <div className="relative min-h-0 flex-1 bg-[var(--canvas)]">
        <Assembly3D
          project={project}
          getMesh={getMesh}
          explode={explode}
          xray={xray || overlay === 'airflow'}
          section={section === 'off' ? null : { axis: section, offset }}
          showFasteners={fasteners}
          selectedId={selection?.kind === 'mech' ? selection.partId : selection?.kind === 'component' ? selection.componentId : undefined}
          onSelect={(sel: { kind: 'mech'; partId: string } | { kind: 'component'; boardId: string; componentId: string } | null) => select(sel)}
          overlay={{ airflow: air.data ?? undefined, pcbThermal: therm.data ?? undefined }}
        />
      </div>
    </div>
  );
}

export type { DropResult, StructuralResult };
