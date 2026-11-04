import { toNumbers, type Board, type MixedSignalResult, type Project, type SimSummary } from '@pcbcad/core';
import type { LoadSpec, RegionSpec } from '../../sim/handlers';
import { runSimulation } from '../../sim/service';
import { requireBoard, requireMech } from '../helpers';
import { S, ToolError, type ToolContext, type ToolDef } from '../registry';

type Target = { boardId: string } | { system: true };

function resolveTarget(p: Project, target?: string): { target: Target; label: string; note?: string } {
  if (!target || target === 'system') {
    if (target === 'system' || p.boards.length > 1) return { target: { system: true }, label: 'system (all boards + interconnects)' };
  }
  const b = requireBoard(p, target);
  const linked = p.interconnects.some((ic) => ic.a.boardId === b.id || ic.b.boardId === b.id);
  return { target: { boardId: b.id }, label: b.name, note: linked ? `Note: ${b.name} is cabled to other boards; target "system" includes them.` : undefined };
}

function componentIdByRef(p: Project, ref: string, preferBoard?: string): string {
  const [boardName, r] = ref.includes(':') ? ref.split(':') : ref.includes('/') ? ref.split('/') : [undefined, ref];
  const boards: Board[] = boardName ? [requireBoard(p, boardName)] : preferBoard ? [requireBoard(p, preferBoard), ...p.boards] : p.boards;
  for (const b of boards) {
    const c = b.components.find((x) => x.ref.toLowerCase() === r.toLowerCase());
    if (c) return c.id;
  }
  throw new ToolError(`Component ${ref} not found`);
}

function mapOverrides(p: Project, overrides: Record<string, Record<string, number | boolean | string>> | undefined, preferBoard?: string) {
  if (!overrides) return undefined;
  const out: Record<string, Record<string, number | boolean | string>> = {};
  for (const [ref, v] of Object.entries(overrides)) out[componentIdByRef(p, ref, preferBoard)] = v;
  return out;
}

function summaryLine(s?: SimSummary) {
  return s ? `${s.headline}${s.pass === false ? ' — FAIL' : ''}` : '';
}

export const simTools: ToolDef[] = [
  {
    name: 'simulate_circuit',
    title: 'Circuit simulation',
    group: 'simulation',
    description:
      'SPICE-class circuit simulation (modified nodal analysis, Newton–Raphson) of a board or the whole multi-board system (interconnect wire + contact resistance included). "op" = DC operating point: rail voltages, currents, per-component power and derating checks. "transient" = time-domain (tStop, tStep). Parts simulate from their sim models (R/C/L, diodes/LEDs, BJTs, MOSFETs, LDO/buck regulators, op-amps, ICs as supply loads, MCUs as loads). Use overrides keyed by ref (e.g. {"SW1":{"closed":true},"BT1":{"V":3.7},"J1":{"waveform":"pulse",...}}).',
    inputSchema: S.obj(
      {
        target: S.str('Board id/name or "system" (default: system when several boards)'),
        analysis: S.enum(['op', 'transient']),
        tStop: S.num('s (transient)'),
        tStep: S.num('s (transient)'),
        probes: S.arr(S.str(), 'Net names to record (transient)'),
        overrides: S.any('{ref: {param: value}}'),
      },
    ),
    slow: true,
    handler: async (ctx, a: { target?: string; analysis?: 'op' | 'transient'; tStop?: number; tStep?: number; probes?: string[]; overrides?: Record<string, Record<string, number | boolean | string>> }) => {
      const p = ctx.session.project;
      const t = resolveTarget(p, a.target);
      const overrides = mapOverrides(p, a.overrides, 'boardId' in t.target ? t.target.boardId : undefined);
      if ((a.analysis ?? 'op') === 'op') {
        const { out } = await runSimulation(ctx, { kind: 'circuit-op', title: `DC operating point — ${t.label}`, target: 'system' in t.target ? { system: true } : { boardId: t.target.boardId }, params: { overrides: a.overrides }, task: 'circuit.op', payload: { project: p, target: t.target, overrides } });
        return [out.text, t.note].filter(Boolean).join('\n');
      }
      if (!a.tStop || !a.tStep) throw new ToolError('transient needs tStop and tStep (seconds)');
      if (a.tStop / a.tStep > 200_000) throw new ToolError('Too many time steps (> 200k); increase tStep');
      const probes = a.probes?.flatMap((n) => p.boards.flatMap((b) => b.nets.filter((x) => x.name.toLowerCase() === n.toLowerCase()).map((x) => x.id)));
      const { out } = await runSimulation(ctx, {
        kind: 'circuit-transient',
        title: `Transient ${a.tStop}s — ${t.label}`,
        target: 'system' in t.target ? { system: true } : { boardId: t.target.boardId },
        params: { tStop: a.tStop, tStep: a.tStep, probes: a.probes, overrides: a.overrides },
        task: 'circuit.transient',
        payload: { project: p, target: t.target, tStop: a.tStop, tStep: a.tStep, probes, overrides },
      });
      return [out.text, t.note].filter(Boolean).join('\n');
    },
  },
  {
    name: 'simulate_pcb_thermal',
    title: 'PCB thermal simulation',
    group: 'simulation',
    description:
      'Steady-state board thermal simulation: in-plane conduction through copper (traces, pours, pads) and FR-4, vias, natural or forced convection + radiation from both faces, heat from component dissipation (taken from a DC operating point automatically) and trace Joule heating (from simulated pin currents, with IPC-2221 trace capacity checks and IR drop per net). Reports junction temperatures vs limits.',
    inputSchema: S.obj(
      {
        boardId: S.str(),
        ambient: S.num('°C (default project ambient)'),
        airflow: S.enum(['natural', 'forced']),
        airVelocity: S.num('m/s for forced'),
        orientation: S.enum(['horizontal', 'vertical']),
        enclosureAirTemp: S.num('Use this air temperature (°C) as the convection sink, e.g. from simulate_airflow'),
        power: S.any('Optional manual power map {ref: watts} instead of the circuit solution'),
      },
      ['boardId'],
    ),
    slow: true,
    handler: async (ctx, a: { boardId: string; ambient?: number; airflow?: 'natural' | 'forced'; airVelocity?: number; orientation?: 'horizontal' | 'vertical'; enclosureAirTemp?: number; power?: Record<string, number> }) => {
      const p = ctx.session.project;
      const b = requireBoard(p, a.boardId);
      if (b.components.some((c) => !c.placed && !c.dnp)) throw new ToolError('Place all components before thermal simulation');
      const power = a.power ? Object.fromEntries(Object.entries(a.power).map(([ref, w]) => [componentIdByRef(p, ref, b.id), w])) : undefined;
      const { out } = await runSimulation(ctx, {
        kind: 'pcb-thermal',
        title: `PCB thermal — ${b.name}`,
        target: { boardId: b.id },
        params: { ambient: a.ambient, airflow: a.airflow, airVelocity: a.airVelocity, enclosureAirTemp: a.enclosureAirTemp },
        task: 'pcb.thermal',
        payload: { project: p, boardId: b.id, ambient: a.ambient, convection: a.airflow ? { mode: a.airflow, airVelocity: a.airVelocity } : undefined, power, enclosureAirTemp: a.enclosureAirTemp, orientation: a.orientation },
      });
      return out.text;
    },
  },
  {
    name: 'simulate_structural',
    title: 'Structural (stress) simulation',
    group: 'simulation',
    description:
      'Linear static stress analysis (voxel FEA with incompatible-mode hexahedra) of one or more mechanical parts using as-manufactured material properties. Regions: {"kind":"face","face":"-z"|"+z"|"-x"|"+x"|"-y"|"+y"} (extreme face of the solid), {"kind":"bosses"} (all screw bosses / sheet-metal holes), {"kind":"box","min":[x,y,z],"max":[x,y,z]}, {"kind":"point","at":[x,y,z],"radius":2}. Loads: {"kind":"force","region":R,"vector":[Fx,Fy,Fz] N}, {"kind":"pressure","region":R,"value":MPa}, {"kind":"gravity","g":1}, {"kind":"acceleration","vector":[ax,ay,az] m/s²}. Coordinates are the part frame (single part) or assembly frame (several parts).',
    inputSchema: S.obj(
      {
        partIds: S.arr(S.str()),
        fixtures: S.arr(S.any('Region')),
        loads: S.arr(S.any('Load')),
        resolution: S.num('Voxel size mm (default auto: ≥2 voxels through the thinnest wall)'),
        title: S.str(),
      },
      ['partIds', 'fixtures', 'loads'],
    ),
    slow: true,
    handler: async (ctx, a: { partIds: string[]; fixtures: RegionSpec[]; loads: LoadSpec[]; resolution?: number; title?: string }) => {
      const p = ctx.session.project;
      const ids = a.partIds.map((id) => requireMech(p, id).id);
      if (!a.fixtures.length) throw new ToolError('At least one fixture region is required (otherwise the part is free to fly away).');
      const { out } = await runSimulation(ctx, {
        kind: 'structural',
        title: a.title ?? `Stress — ${ids.map((id) => requireMech(p, id).name).join(' + ')}`,
        target: { partIds: ids },
        params: { fixtures: a.fixtures, loads: a.loads, resolution: a.resolution },
        task: 'mech.structural',
        payload: { project: p, partIds: ids, fixtures: a.fixtures, loads: a.loads, resolution: a.resolution, title: a.title },
        timeoutMs: 10 * 60_000,
      });
      return out.text;
    },
  },
  {
    name: 'simulate_drop',
    title: 'Drop / impact test',
    group: 'simulation',
    description:
      'Drop test of the assembled product (or given parts) from a height onto a floor: impact velocity, contact stiffness (structure + floor) → peak force and g-level (energy method), stresses in the housing at peak deceleration, and per-component inertial loads on the PCBs (solder joint / connector retention risk).',
    inputSchema: S.obj(
      {
        heightM: S.num('Drop height in metres (consumer electronics: 1.0–1.5)'),
        orientation: S.enum(['bottom', 'top', 'side-x', 'side-y', 'corner', 'edge']),
        floor: S.enum(['concrete', 'wood', 'carpet']),
        partIds: S.arr(S.str(), 'Default: all mechanical parts in the assembly'),
        resolution: S.num(),
      },
      ['heightM', 'orientation'],
    ),
    slow: true,
    handler: async (ctx, a: { heightM: number; orientation: 'bottom' | 'top' | 'side-x' | 'side-y' | 'corner' | 'edge'; floor?: 'concrete' | 'wood' | 'carpet'; partIds?: string[]; resolution?: number }) => {
      const p = ctx.session.project;
      const ids = a.partIds?.map((id) => requireMech(p, id).id);
      const { out } = await runSimulation(ctx, {
        kind: 'drop',
        title: `Drop ${a.heightM} m on ${a.orientation}${a.floor ? ` (${a.floor})` : ''}`,
        target: { assembly: !ids, partIds: ids },
        params: { heightM: a.heightM, orientation: a.orientation, floor: a.floor },
        task: 'mech.drop',
        payload: { project: p, partIds: ids, heightM: a.heightM, orientation: a.orientation, floor: a.floor, resolution: a.resolution },
        timeoutMs: 10 * 60_000,
      });
      return out.text;
    },
  },
  {
    name: 'simulate_airflow',
    title: 'Airflow & enclosure thermal',
    group: 'simulation',
    description:
      'Conjugate heat transfer CFD of the assembled product: air inside the enclosure (laminar, buoyancy-driven or fan-driven through vents/openings), conduction through walls, PCBs and component bodies, heat from component dissipation (auto from circuit solution). Reports air/component temperatures, vent flow rates and where the heat leaves.',
    inputSchema: S.obj({ ambient: S.num('°C'), resolution: S.num('Voxel size mm (default auto)'), power: S.any('Optional {ref: watts}') }),
    slow: true,
    handler: async (ctx, a: { ambient?: number; resolution?: number; power?: Record<string, number> }) => {
      const p = ctx.session.project;
      if (!p.mechanical.some((m) => m.kind === 'enclosure-shell')) throw new ToolError('Airflow simulation needs an enclosure (create_enclosure).');
      const power = a.power ? Object.fromEntries(Object.entries(a.power).map(([ref, w]) => [componentIdByRef(p, ref), w])) : undefined;
      const { out } = await runSimulation(ctx, {
        kind: 'airflow',
        title: 'Enclosure airflow & thermal',
        target: { assembly: true },
        params: { ambient: a.ambient, resolution: a.resolution },
        task: 'mech.airflow',
        payload: { project: p, ambient: a.ambient, resolution: a.resolution, power },
        timeoutMs: 15 * 60_000,
      });
      return out.text;
    },
  },
  {
    name: 'list_simulations',
    title: 'List simulations',
    group: 'simulation',
    description: 'List simulation runs with status and headline results.',
    inputSchema: S.obj({ kind: S.str() }),
    handler: (ctx, a: { kind?: string }) => {
      const runs = ctx.session.project.simulations.filter((s) => !a.kind || s.kind === a.kind);
      if (!runs.length) return 'No simulations yet.';
      return runs
        .slice(-30)
        .map((s) => `${s.id} | ${s.kind} | ${s.status} | ${s.title} | ${summaryLine(s.summary) || s.error || ''}`)
        .join('\n');
    },
  },
  {
    name: 'get_simulation',
    title: 'Simulation details',
    group: 'simulation',
    description: 'Details of a simulation run: parameters, metrics, warnings; for firmware runs also the UART console output.',
    inputSchema: S.obj({ runId: S.str() }, ['runId']),
    handler: (ctx, a: { runId: string }) => {
      const run = ctx.session.project.simulations.find((s) => s.id === a.runId);
      if (!run) throw new ToolError(`Run ${a.runId} not found`);
      const lines = [`${run.title} [${run.kind}] — ${run.status}${run.durationMs ? ` in ${(run.durationMs / 1000).toFixed(1)} s` : ''}`, `Params: ${JSON.stringify(run.params)}`];
      if (run.summary) {
        lines.push(run.summary.headline);
        lines.push(...run.summary.metrics.map((m) => `- ${m.label}: ${Number.isFinite(m.value) ? +m.value.toPrecision(4) : m.value} ${m.unit}${m.status && m.status !== 'ok' ? ` (${m.status})` : ''}`));
        if (run.summary.warnings.length) lines.push(`Warnings:\n- ${run.summary.warnings.join('\n- ')}`);
      }
      if (run.error) lines.push(`Error: ${run.error}`);
      if (run.kind === 'mixed-signal' && run.resultAssetId) {
        const r = ctx.services.store.getJsonAsset<MixedSignalResult>(ctx.session.id, run.resultAssetId);
        if (r) for (const u of r.uart) lines.push(`UART ${u.ref}:\n${u.text.slice(-3000)}`);
      }
      if (run.kind === 'circuit-transient' && run.resultAssetId) {
        const r = ctx.services.store.getJsonAsset<{ time: number[]; signals: { name: string; data: number[] }[] }>(ctx.session.id, run.resultAssetId);
        if (r) lines.push(`Signals: ${r.signals.map((s) => s.name).join(', ')} (${Array.from(toNumbers(r.time as never)).length} points)`);
      }
      return lines.join('\n');
    },
  },
];

export { componentIdByRef, resolveTarget, type Target };
export type { ToolContext };
