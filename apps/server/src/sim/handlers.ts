/**
 * CPU-heavy engine tasks executed inside worker threads (see tasks.ts / worker.ts).
 * Each handler receives a structured-clone payload and returns a structured-clone result.
 */
import {
  effectiveMaterial,
  formatValue,
  mat4FromTransform,
  paramValue,
  transformPoint,
  type Board,
  type CircuitOpResult,
  type CircuitTransientResult,
  type FastenerSpec,
  type MechPart,
  type MixedSignalResult,
  type PartDef,
  type PcbThermalResult,
  type Project,
  type SimSummary,
  type Vec3,
  type BehaviorScript,
  type DesignIssue,
} from '@pcbcad/core';
import * as sim from '@pcbcad/sim';
import * as mech from '@pcbcad/mech';
import * as pcb from '@pcbcad/pcb';

type Progress = (fraction: number, message?: string) => void;
type Handler = (payload: any, progress: Progress) => Promise<unknown> | unknown;

export type CircuitTarget = { boardId: string } | { system: true };

/* -------------------------------------------- helpers -------------------------------------------- */

function refMap(project: Project): Map<string, { ref: string; board: Board; part?: PartDef }> {
  const m = new Map<string, { ref: string; board: Board; part?: PartDef }>();
  for (const b of project.boards) for (const c of b.components) m.set(c.id, { ref: project.boards.length > 1 ? `${b.name}/${c.ref}` : c.ref, board: b, part: project.parts[c.partId] });
  return m;
}

const PKG_POWER: Record<string, number> = { '0201': 0.05, '0402': 0.0625, '0603': 0.1, '0805': 0.125, '1206': 0.25, '1210': 0.5, '2010': 0.75, '2512': 1 };

/** Rated power for derating checks (W), when known. */
function powerRating(part: PartDef | undefined): number | undefined {
  if (!part) return undefined;
  if (part.ratings?.power) return part.ratings.power;
  if (part.category === 'resistor') {
    const fromParams = paramValue(part.params, /^power/i, /power\s*\(watts\)/i);
    if (fromParams) return fromParams;
    const size = part.packageSpec?.size ?? Object.keys(PKG_POWER).find((k) => part.package.includes(k));
    if (size && PKG_POWER[size]) return PKG_POWER[size];
  }
  return undefined;
}

function hasInterconnect(project: Project, boardId: string) {
  return project.interconnects.some((ic) => ic.a.boardId === boardId || ic.b.boardId === boardId);
}

/** Pick the right circuit scope for analysing one board (system when it is cabled to others). */
function scopeFor(project: Project, boardId: string): CircuitTarget {
  return hasInterconnect(project, boardId) ? { system: true } : { boardId };
}

export function describeOp(project: Project, r: CircuitOpResult): { summary: SimSummary; text: string } {
  const refs = refMap(project);
  const warnings = [...r.warnings];
  const comps = Object.entries(r.componentPower)
    .map(([id, p]) => ({ id, p, info: refs.get(id) }))
    .filter((x) => x.info)
    .sort((a, b) => b.p - a.p);
  const total = comps.reduce((s, c) => s + Math.max(0, c.p), 0);
  let worst: { label: string; ratio: number } | null = null;
  for (const c of comps) {
    const rating = powerRating(c.info!.part);
    if (rating && c.p > 0) {
      const ratio = c.p / rating;
      if (ratio > 1) warnings.push(`${c.info!.ref} dissipates ${formatValue(c.p, 'W')} > rating ${formatValue(rating, 'W')}`);
      else if (ratio > 0.5) warnings.push(`${c.info!.ref} at ${(ratio * 100).toFixed(0)}% of its ${formatValue(rating, 'W')} rating (derate to ≤50%)`);
      if (!worst || ratio > worst.ratio) worst = { label: c.info!.ref, ratio };
    }
  }
  const powerNets = new Set<string>();
  for (const b of project.boards) for (const n of b.nets) if (n.class === 'power' || n.class === 'ground') powerNets.add(n.id);
  const rails = Object.entries(r.nodeVoltages)
    .filter(([id]) => powerNets.has(id))
    .map(([id, v]) => `${r.netNames[id] ?? id}=${v.toFixed(3)}V`);
  const sources = Object.entries(r.sourcePower ?? {}).map(([id, p]) => `${refs.get(id)?.ref ?? id} delivers ${formatValue(p, 'W')}`);
  const metrics: SimSummary['metrics'] = [
    { label: 'Total dissipation', value: total, unit: 'W' },
    ...(comps[0] ? [{ label: `Hottest: ${comps[0].info!.ref}`, value: comps[0].p, unit: 'W' }] : []),
    ...(worst ? [{ label: `Max derating (${worst.label})`, value: worst.ratio * 100, unit: '%', status: (worst.ratio > 1 ? 'fail' : worst.ratio > 0.5 ? 'warn' : 'ok') as 'ok' | 'warn' | 'fail', limit: 50 }] : []),
  ];
  const summary: SimSummary = {
    headline: `${r.converged ? 'Converged' : 'DID NOT CONVERGE'} · ${formatValue(total, 'W')} dissipated${comps[0] ? ` · hottest ${comps[0].info!.ref} ${formatValue(comps[0].p, 'W')}` : ''}`,
    metrics,
    warnings,
    pass: r.converged && !warnings.some((w) => w.includes('> rating')),
  };
  const lines = [
    summary.headline,
    rails.length ? `Rails: ${rails.join(', ')}` : '',
    sources.length ? `Sources: ${sources.join('; ')}` : '',
    'Component power (top 12): ' +
      comps
        .slice(0, 12)
        .map((c) => `${c.info!.ref} ${formatValue(c.p, 'W')}`)
        .join(', '),
    'Node voltages: ' +
      Object.entries(r.nodeVoltages)
        .slice(0, 60)
        .map(([id, v]) => `${r.netNames[id] ?? id}=${v.toFixed(3)}`)
        .join(', '),
    warnings.length ? `Warnings:\n- ${warnings.join('\n- ')}` : 'No warnings.',
  ].filter(Boolean);
  return { summary, text: lines.join('\n') };
}

function describeTransient(project: Project, r: CircuitTransientResult): { summary: SimSummary; text: string } {
  const t = sim_toArray(r.time);
  const lines: string[] = [];
  for (const s of r.signals.slice(0, 24)) {
    const d = sim_toArray(s.data);
    let mn = Infinity;
    let mx = -Infinity;
    let sum = 0;
    for (const v of d) {
      mn = Math.min(mn, v);
      mx = Math.max(mx, v);
      sum += v;
    }
    lines.push(`${s.name}: min ${mn.toPrecision(4)} max ${mx.toPrecision(4)} avg ${(sum / Math.max(1, d.length)).toPrecision(4)} ${s.unit}`);
  }
  const total = Object.values(r.avgPower).reduce((a, b) => a + Math.max(0, b), 0);
  const summary: SimSummary = {
    headline: `Transient ${formatValue(t[t.length - 1] ?? 0, 's')} · ${t.length} points · ${formatValue(total, 'W')} avg dissipation`,
    metrics: [
      { label: 'Duration', value: t[t.length - 1] ?? 0, unit: 's' },
      { label: 'Avg dissipation', value: total, unit: 'W' },
    ],
    warnings: r.warnings,
    pass: true,
  };
  return { summary, text: [summary.headline, ...lines, r.warnings.length ? `Warnings: ${r.warnings.join('; ')}` : ''].filter(Boolean).join('\n') };
}

import { toNumbers } from '@pcbcad/core';
function sim_toArray(a: Parameters<typeof toNumbers>[0]): number[] {
  return Array.from(toNumbers(a));
}

function describeThermal(project: Project, r: PcbThermalResult): { summary: SimSummary; text: string } {
  const comps = [...r.components].sort((a, b) => b.tJunction - a.tJunction);
  const failing = comps.filter((c) => c.status === 'fail');
  const warnC = comps.filter((c) => c.status === 'warn');
  const badTraces = r.traces.filter((t) => t.status !== 'ok');
  const top = comps[0];
  const warnings: string[] = [...((r as PcbThermalResult & { warnings?: string[] }).warnings ?? [])];
  for (const c of failing) warnings.push(`${c.ref}: Tj ${c.tJunction.toFixed(1)} °C exceeds ${c.tjMax ?? 125} °C`);
  for (const c of warnC) warnings.push(`${c.ref}: Tj ${c.tJunction.toFixed(1)} °C close to limit ${c.tjMax ?? 125} °C`);
  for (const t of badTraces.slice(0, 10)) warnings.push(`Trace ${t.traceId} seg ${t.segment}: ${t.current.toFixed(2)} A (IPC 10 °C capacity ${t.ipcCapacity.toFixed(2)} A, est. rise ${t.tempRise.toFixed(1)} °C)`);
  const worstDrop = [...(r.netDrops ?? [])].sort((a, b) => b.maxDrop - a.maxDrop)[0];
  const summary: SimSummary = {
    headline: `Board max ${r.maxTemp.toFixed(1)} °C${top ? ` · hottest junction ${top.ref} ${top.tJunction.toFixed(1)} °C` : ''} · ${formatValue(r.totalPower, 'W')} total`,
    metrics: [
      { label: 'Max board temperature', value: r.maxTemp, unit: '°C', status: failing.length ? 'fail' : warnC.length ? 'warn' : 'ok' },
      ...(top ? [{ label: `Tj ${top.ref}`, value: top.tJunction, unit: '°C', limit: top.tjMax, status: top.status }] : []),
      { label: 'Total power', value: r.totalPower, unit: 'W' },
      { label: 'Ambient', value: r.ambient, unit: '°C' },
      { label: 'h (top)', value: r.convection.hTop, unit: 'W/m²K' },
      ...(worstDrop ? [{ label: `Worst IR drop (${worstDrop.name})`, value: worstDrop.maxDrop * 1000, unit: 'mV' }] : []),
      { label: 'Trace issues', value: badTraces.length, unit: '', status: (badTraces.some((t) => t.status === 'fail') ? 'fail' : badTraces.length ? 'warn' : 'ok') as 'ok' | 'warn' | 'fail' },
    ],
    warnings,
    pass: failing.length === 0 && !badTraces.some((t) => t.status === 'fail'),
  };
  const text = [
    summary.headline,
    `Convection: ${r.convection.mode}, h_top ${r.convection.hTop.toFixed(1)} W/m²K, h_bottom ${r.convection.hBottom.toFixed(1)} W/m²K`,
    'Components (Tj, P): ' + comps.slice(0, 15).map((c) => `${c.ref} ${c.tJunction.toFixed(1)}°C ${formatValue(c.power, 'W')}`).join(', '),
    r.netDrops?.length ? 'IR drops: ' + r.netDrops.slice(0, 10).map((d) => `${d.name} ${(d.maxDrop * 1000).toFixed(1)} mV @ ${d.current.toFixed(3)} A`).join(', ') : '',
    warnings.length ? `Warnings:\n- ${warnings.join('\n- ')}` : 'All components and traces within limits.',
  ].filter(Boolean);
  return { summary, text: text.join('\n') };
}

/* ---------------------------------------- region mapping ----------------------------------------- */

export type RegionSpec =
  | { kind: 'face'; face: '+x' | '-x' | '+y' | '-y' | '+z' | '-z'; depth?: number }
  | { kind: 'bosses' }
  | { kind: 'holes' }
  | { kind: 'box'; min: Vec3; max: Vec3 }
  | { kind: 'point'; at: Vec3; radius?: number };

export type LoadSpec =
  | { kind: 'force'; region: RegionSpec; vector: Vec3 }
  | { kind: 'pressure'; region: RegionSpec; value: number }
  | { kind: 'gravity'; g?: number; direction?: Vec3 }
  | { kind: 'acceleration'; vector: Vec3 };

function instanceMatrix(project: Project, partId: string, multi: boolean) {
  if (!multi) return null;
  const inst = project.assembly.instances.find((i) => i.target.kind === 'mech' && i.target.partId === partId);
  return inst ? mat4FromTransform(inst.transform) : null;
}

function mapRegion(spec: RegionSpec, project: Project, partIds: string[]): sim.Region[] {
  const multi = partIds.length > 1;
  switch (spec.kind) {
    case 'face': {
      const axis = spec.face[1] as 'x' | 'y' | 'z';
      return [{ kind: 'plane', axis, side: spec.face[0] === '+' ? 'max' : 'min', depth: spec.depth }];
    }
    case 'box':
      return [{ kind: 'box', min: spec.min, max: spec.max }];
    case 'point': {
      const r = spec.radius ?? 2;
      return [{ kind: 'box', min: [spec.at[0] - r, spec.at[1] - r, spec.at[2] - r], max: [spec.at[0] + r, spec.at[1] + r, spec.at[2] + r] }];
    }
    case 'bosses':
    case 'holes': {
      const out: sim.Region[] = [];
      for (const id of partIds) {
        const part = project.mechanical.find((m) => m.id === id);
        if (!part) continue;
        const m = instanceMatrix(project, id, multi);
        const tp = (p: Vec3): Vec3 => (m ? transformPoint(m, p) : p);
        const td = (d: Vec3): Vec3 => {
          if (!m) return d;
          const a = transformPoint(m, [0, 0, 0]);
          const b = transformPoint(m, d);
          return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        };
        if (part.kind === 'enclosure-shell') {
          for (const boss of part.bosses) {
            out.push({ kind: 'cylinder', center: tp([boss.x, boss.y, part.wall]), axis: td([0, 0, 1]), radius: boss.outerDiameter / 2 + 0.01, length: boss.height });
          }
        } else if (part.kind === 'sheet-metal') {
          for (const h of part.holes) {
            const r = (h.diameter ?? Math.max(h.width ?? 3, h.height ?? 3)) / 2 + 2 * part.thickness;
            out.push({ kind: 'cylinder', center: tp([h.x, h.y, 0]), axis: td([0, 0, 1]), radius: r, length: part.thickness });
          }
        }
      }
      if (!out.length) throw new Error(`Region '${spec.kind}' matched no features on ${partIds.join(', ')}`);
      return out;
    }
  }
}

function describeRegion(spec: RegionSpec): string {
  switch (spec.kind) {
    case 'face':
      return `face ${spec.face}`;
    case 'box':
      return `box [${spec.min.join(',')}]–[${spec.max.join(',')}]`;
    case 'point':
      return `point (${spec.at.join(',')})`;
    default:
      return spec.kind;
  }
}

function structuralSummary(r: { maxVonMises: number; minSafetyFactor: number; maxDisplacement: number; massGrams: number; solver: { converged: boolean; iterations: number } }, extra: SimSummary['metrics'] = []): SimSummary {
  const sf = r.minSafetyFactor;
  const status = sf < 1 ? 'fail' : sf < 2 ? 'warn' : 'ok';
  return {
    headline: `σ_vm max ${r.maxVonMises.toFixed(2)} MPa · safety factor ${Number.isFinite(sf) ? sf.toFixed(2) : '∞'} · max deflection ${r.maxDisplacement.toFixed(3)} mm`,
    metrics: [
      { label: 'Max von Mises', value: r.maxVonMises, unit: 'MPa', status },
      { label: 'Min safety factor', value: sf, unit: '', status, limit: 2 },
      { label: 'Max displacement', value: r.maxDisplacement, unit: 'mm' },
      { label: 'Mass', value: r.massGrams, unit: 'g' },
      ...extra,
    ],
    warnings: [...(r.solver.converged ? [] : [`Solver did not fully converge (${r.solver.iterations} iterations)`]), ...(sf < 1 ? ['Yield exceeded — part will permanently deform or break'] : sf < 2 ? ['Safety factor below 2'] : [])],
    pass: sf >= 1,
  };
}

/* -------------------------------------------- masses -------------------------------------------- */

/** Component and board masses placed in the assembly frame (for drop tests). */
function boardMasses(project: Project): { position: Vec3; massGrams: number; componentId?: string; ref?: string }[] {
  const out: { position: Vec3; massGrams: number; componentId?: string; ref?: string }[] = [];
  for (const b of project.boards) {
    const inst = project.assembly.instances.find((i) => i.target.kind === 'board' && i.target.boardId === b.id);
    if (!inst) continue;
    const m = mat4FromTransform(inst.transform);
    const t = b.stackup.thickness;
    const xs = b.outline.map((p) => p[0]);
    const ys = b.outline.map((p) => p[1]);
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    out.push({ position: transformPoint(m, [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, t / 2]), massGrams: area * t * 1.85e-3, ref: `${b.name} PCB` });
    for (const c of b.components) {
      if (c.dnp || !c.placed) continue;
      const part = project.parts[c.partId];
      const body = part?.body ?? { w: 2, l: 2, h: 1 };
      const mass = part?.massGrams ?? Math.max(0.005, body.w * body.l * body.h * 1.6e-3);
      const z = c.side === 'top' ? t + body.h / 2 : -body.h / 2;
      out.push({ position: transformPoint(m, [c.x, c.y, z]), massGrams: mass, componentId: c.id, ref: c.ref });
    }
  }
  return out;
}

/* -------------------------------------------- handlers ------------------------------------------- */

async function circuitOp(p: { project: Project; target: CircuitTarget; overrides?: Record<string, Record<string, number | boolean | string>> }) {
  const circuit = sim.buildCircuit(p.project, p.target, { overrides: p.overrides });
  const result = sim.solveOp(circuit);
  return { result, ...describeOp(p.project, result) };
}

async function circuitTransient(p: { project: Project; target: CircuitTarget; tStop: number; tStep: number; probes?: string[]; overrides?: Record<string, Record<string, number | boolean | string>> }) {
  const circuit = sim.buildCircuit(p.project, p.target, { overrides: p.overrides });
  const result = sim.solveTransient(circuit, { tStop: p.tStop, tStep: p.tStep, probes: p.probes });
  return { result, ...describeTransient(p.project, result) };
}

async function pcbThermal(
  p: { project: Project; boardId: string; ambient?: number; convection?: { mode: 'natural' | 'forced'; airVelocity?: number }; power?: Record<string, number>; enclosureAirTemp?: number; orientation?: 'horizontal' | 'vertical' },
  progress: Progress,
) {
  let power = p.power;
  let pinCurrents: Record<string, Record<string, number>> | undefined;
  let opText = '';
  if (!power) {
    progress(0.05, 'Solving DC operating point for power dissipation');
    const circuit = sim.buildCircuit(p.project, scopeFor(p.project, p.boardId));
    const op = sim.solveOp(circuit);
    power = op.componentPower;
    pinCurrents = op.pinCurrents;
    opText = `Power from DC operating point (${op.converged ? 'converged' : 'not converged'}).`;
  }
  progress(0.3, 'Solving board conduction/convection');
  const result = sim.simulatePcbThermal(p.project, p.boardId, {
    power,
    pinCurrents,
    ambient: p.ambient ?? p.project.settings.ambientC,
    convection: p.convection,
    enclosureAirTemp: p.enclosureAirTemp,
    orientation: p.orientation,
  });
  const d = describeThermal(p.project, result);
  return { result, summary: d.summary, text: [opText, d.text].filter(Boolean).join('\n') };
}

async function partMesh(p: { part: MechPart; project?: Project }) {
  await mech.initGeometry();
  return mech.buildPartMesh(p.part, { project: p.project });
}

async function fastenerMeshTask(p: { spec: FastenerSpec }) {
  await mech.initGeometry();
  return mech.fastenerMesh(p.spec);
}

async function structural(
  p: { project: Project; partIds: string[]; fixtures: RegionSpec[]; loads: LoadSpec[]; resolution?: number; title?: string },
  progress: Progress,
) {
  await mech.initGeometry();
  const parts = p.partIds.map((id) => p.project.mechanical.find((m) => m.id === id)).filter(Boolean) as MechPart[];
  if (!parts.length) throw new Error('No mechanical parts found for structural analysis');
  progress(0.05, 'Voxelising geometry');
  const h = p.resolution ?? autoResolution(parts);
  const { grid, materials } = await mech.voxelizeForStructural(p.project, p.partIds, h);
  const fixtures = p.fixtures.flatMap((f) => mapRegion(f, p.project, p.partIds));
  const loads: sim.StructuralSetup['loads'] = [];
  let bodyAcceleration: Vec3 | undefined;
  for (const l of p.loads) {
    if (l.kind === 'force') for (const r of mapRegion(l.region, p.project, p.partIds)) loads.push({ region: r, force: l.vector.map((v) => v / Math.max(1, mapRegion(l.region, p.project, p.partIds).length)) as Vec3 });
    else if (l.kind === 'pressure') for (const r of mapRegion(l.region, p.project, p.partIds)) loads.push({ region: r, pressure: l.value });
    else if (l.kind === 'gravity') {
      const g = (l.g ?? 1) * 9.81;
      const d = l.direction ?? [0, 0, -1];
      bodyAcceleration = [d[0] * g, d[1] * g, d[2] * g];
    } else if (l.kind === 'acceleration') bodyAcceleration = l.vector;
  }
  progress(0.15, `Solving (${grid.nx}×${grid.ny}×${grid.nz} voxels @ ${h} mm)`);
  const title = p.title ?? `Static stress — ${parts.map((x) => x.name).join(' + ')}`;
  const result = sim.solveStructural(
    { grid, materials, fixtures, loads, bodyAcceleration, onProgress: (f: number) => progress(0.15 + 0.85 * f, 'Solving') },
    {
      title,
      loads: p.loads.map((l) => (l.kind === 'force' ? `${l.vector.join(', ')} N on ${describeRegion(l.region)}` : l.kind === 'pressure' ? `${l.value} MPa on ${describeRegion(l.region)}` : l.kind === 'gravity' ? `${l.g ?? 1} g gravity` : `acceleration ${l.vector.join(', ')} m/s²`)),
      fixtures: p.fixtures.map(describeRegion),
    },
  );
  const summary = structuralSummary(result);
  const mats = materials.map((m) => `${m.name} (${m.process}: E ${m.E.toFixed(0)} MPa, σy ${m.yieldStrength.toFixed(0)} MPa)`).join('; ');
  const text = [
    summary.headline,
    `Materials as manufactured: ${mats}`,
    `Max stress at (${result.maxStressAt.map((v) => v.toFixed(1)).join(', ')}) mm. Mass ${result.massGrams.toFixed(1)} g. ${result.solver.dofs} DOF, ${result.solver.iterations} CG iterations, residual ${result.solver.residual.toExponential(2)}.`,
    ...summary.warnings,
  ];
  return { result, summary, text: text.join('\n') };
}

function autoResolution(parts: MechPart[]): number {
  let minWall = Infinity;
  let maxDim = 0;
  for (const p of parts) {
    if (p.kind === 'enclosure-shell') {
      minWall = Math.min(minWall, p.wall);
      maxDim = Math.max(maxDim, p.outer.width, p.outer.depth, p.outer.height);
    } else if (p.kind === 'sheet-metal') {
      minWall = Math.min(minWall, p.thickness);
      maxDim = Math.max(maxDim, p.base.width, p.base.length);
    } else maxDim = Math.max(maxDim, 50);
  }
  // ≥ 2 voxels through the thinnest wall, but keep the model ≤ ~250 voxels across
  const h = Math.max(minWall / 2, maxDim / 220, 0.25);
  return Math.round(h * 100) / 100;
}

async function drop(p: { project: Project; partIds?: string[]; heightM: number; orientation: 'bottom' | 'top' | 'side-x' | 'side-y' | 'corner' | 'edge'; floor?: 'concrete' | 'wood' | 'carpet'; resolution?: number }, progress: Progress) {
  await mech.initGeometry();
  const ids = p.partIds?.length ? p.partIds : p.project.mechanical.filter((m) => m.kind !== 'purchased').map((m) => m.id);
  if (!ids.length) throw new Error('Drop test needs at least one mechanical part (enclosure/sheet metal) in the assembly');
  const parts = ids.map((id) => p.project.mechanical.find((m) => m.id === id)!).filter(Boolean);
  progress(0.05, 'Voxelising assembly');
  const h = p.resolution ?? autoResolution(parts) * 1.25;
  const { grid, materials } = await mech.voxelizeForStructural(p.project, ids, h);
  const extraMasses = ids.length > 1 || p.project.assembly.instances.length ? boardMasses(p.project) : [];
  progress(0.2, 'Computing impact stiffness');
  const result = sim.solveDrop({ grid, materials, heightM: p.heightM, orientation: p.orientation, floor: p.floor, extraMasses, onProgress: (f: number) => progress(0.2 + 0.8 * f, 'Solving') });
  const high = result.componentRisks.filter((c) => c.risk === 'high');
  const base = structuralSummary(result.structural, [
    { label: 'Peak deceleration', value: result.peakG, unit: 'g' },
    { label: 'Impact velocity', value: result.impactVelocity, unit: 'm/s' },
    { label: 'Contact time', value: result.contactDurationMs, unit: 'ms' },
    { label: 'High-risk components', value: high.length, unit: '', status: high.length ? 'warn' : 'ok' },
  ]);
  const summary: SimSummary = {
    ...base,
    headline: `${p.heightM} m drop on ${p.orientation}: ${result.peakG.toFixed(0)} g peak · ${base.headline}`,
    warnings: [...base.warnings, ...high.map((c) => `${c.ref}: ${c.note}`)],
  };
  const text = [
    summary.headline,
    `Method: ${result.method}. Mass ${result.massGrams.toFixed(0)} g, v = ${result.impactVelocity.toFixed(2)} m/s, F_peak ${result.peakForceN.toFixed(0)} N, stop distance ${result.stopDistanceMm.toFixed(2)} mm.`,
    result.componentRisks.length ? 'Component risk: ' + result.componentRisks.filter((c) => c.risk !== 'low').map((c) => `${c.ref} ${c.risk} (${c.inertialForceN.toFixed(1)} N)`).join(', ') || 'all low' : '',
    ...summary.warnings,
  ].filter(Boolean);
  return { result, summary, text: text.join('\n') };
}

async function airflow(p: { project: Project; ambient?: number; resolution?: number; power?: Record<string, number> }, progress: Progress) {
  await mech.initGeometry();
  progress(0.02, 'Voxelising enclosure, boards and components');
  const domain = await mech.voxelizeAssemblyForAirflow(p.project, { h: p.resolution });
  // The voxel model has no copper: boards are plain dielectric slabs and IC bodies plain epoxy,
  // which hugely under-predicts heat spreading. Use effective conductivities instead: board =
  // in-plane FR-4 + copper layers at ~50 % coverage; package = epoxy with lead frame (~3 W/mK).
  const modelNotes: string[] = [];
  const kBoard = Math.max(
    1,
    ...p.project.boards.map((b) => {
      const t = b.stackup.thickness;
      const outer = 2 * b.stackup.copperOz.outer * 0.0347;
      const inner = Math.max(0, b.stackup.layers - 2) * b.stackup.copperOz.inner * 0.0347;
      return (0.8 * Math.max(0.2, t - outer - inner) + 385 * 0.5 * (outer + inner)) / t;
    }),
  );
  domain.materials.forEach((m, i) => {
    if (m.materialId === 'fr4' || /fr-?4/i.test(m.name)) {
      domain.materials[i] = { ...m, thermalConductivity: kBoard };
      modelNotes.push(`PCB modelled with effective k ${kBoard.toFixed(1)} W/mK (copper layers)`);
    } else if (m.materialId === 'epoxy-mold') {
      domain.materials[i] = { ...m, thermalConductivity: 3 };
      modelNotes.push('IC bodies modelled with effective k 3 W/mK (lead frame)');
    }
  });
  let power = p.power;
  if (!power) {
    progress(0.08, 'Solving circuits for power dissipation');
    power = {};
    if (p.project.interconnects.length) Object.assign(power, sim.solveOp(sim.buildCircuit(p.project, { system: true })).componentPower);
    else for (const b of p.project.boards) Object.assign(power, sim.solveOp(sim.buildCircuit(p.project, { boardId: b.id })).componentPower);
  }
  const heatSources = domain.componentCells
    .filter((c) => (power![c.componentId] ?? 0) > 0 && c.cells.length)
    .map((c) => ({ cells: c.cells, power: power![c.componentId], componentId: c.componentId, ref: c.ref }));
  progress(0.12, `Solving flow + heat (${domain.grid.nx}×${domain.grid.ny}×${domain.grid.nz})`);
  const result = sim.solveAirflow({
    grid: domain.grid,
    materials: domain.materials,
    heatSources,
    openings: domain.openings,
    fans: domain.fans,
    ambient: p.ambient ?? p.project.settings.ambientC,
    onProgress: (f: number) => progress(0.12 + 0.88 * f, 'Iterating'),
  });
  const hottest = [...result.components].sort((a, b) => b.temperature - a.temperature)[0];
  const totalIn = result.vents.filter((v) => v.direction === 'in').reduce((s, v) => s + v.flowM3s, 0);
  const summary: SimSummary = {
    headline: `${result.mode === 'forced' ? 'Forced' : 'Natural'} convection: air max ${result.maxAirTemp.toFixed(1)} °C, mean ${result.meanAirTemp.toFixed(1)} °C${hottest ? ` · hottest ${hottest.ref} ${hottest.temperature.toFixed(1)} °C` : ''}`,
    metrics: [
      { label: 'Max air temperature', value: result.maxAirTemp, unit: '°C' },
      { label: 'Mean air temperature', value: result.meanAirTemp, unit: '°C' },
      { label: 'Max solid temperature', value: result.maxSolidTemp, unit: '°C', status: result.maxSolidTemp > 85 ? 'warn' : 'ok' },
      { label: 'Vent inflow', value: totalIn * 1000 * 60, unit: 'L/min' },
      { label: 'Heat out via vents', value: result.heatBalance.vents, unit: 'W' },
      { label: 'Heat out via walls', value: result.heatBalance.walls, unit: 'W' },
    ],
    warnings: [...domain.warnings, ...(result.converged ? [] : ['Flow solver did not fully converge'])],
    pass: result.maxSolidTemp < 100,
  };
  const text = [
    summary.headline,
    ...modelNotes,
    `Heat: input ${result.heatBalance.input.toFixed(2)} W, vents ${result.heatBalance.vents.toFixed(2)} W, walls ${result.heatBalance.walls.toFixed(2)} W.`,
    'Vents: ' + result.vents.map((v) => `${v.name} ${v.direction} ${(v.flowM3s * 60000).toFixed(2)} L/min`).join(', '),
    'Components: ' + result.components.map((c) => `${c.ref} ${c.temperature.toFixed(1)}°C (${formatValue(c.power, 'W')})`).join(', '),
    ...summary.warnings,
  ];
  return { result, summary, text: text.join('\n') };
}

async function mixed(
  p: {
    project: Project;
    target: CircuitTarget;
    duration: number;
    firmware: Record<string, { bytes: Uint8Array; format: 'hex' | 'bin' | 'uf2' | 'elf'; name?: string }>;
    behaviors: BehaviorScript[];
    uartInput?: Record<string, string>;
    environment?: { temperatureC?: number; pressurePa?: number; humidityPct?: number };
    /** User-supplied RP2040 bootrom (not bundled for licensing reasons). */
    rp2040Bootrom?: Uint8Array;
  },
  progress: Progress,
) {
  const { createNodeSandbox } = await import('@pcbcad/sim/mixed/sandbox-node');
  if (p.rp2040Bootrom?.length) sim.setRp2040Bootrom(p.rp2040Bootrom);
  const result: MixedSignalResult = await sim.runMixedSignal(p.project, p.target, {
    duration: p.duration,
    firmware: p.firmware,
    behaviors: p.behaviors,
    sandbox: createNodeSandbox(),
    uartInput: p.uartInput,
    environment: p.environment,
    onProgress: (f: number) => progress(f, 'Emulating'),
  });
  const uartChars = result.uart.reduce((n, u) => n + u.text.length, 0);
  const errors = result.log.filter((l) => l.level === 'error');
  const summary: SimSummary = {
    headline: `${formatValue(result.duration, 's')} simulated in ${(result.wallMs / 1000).toFixed(1)} s · ${result.mcus.length} MCU(s) · UART ${uartChars} chars`,
    metrics: [
      { label: 'Simulated time', value: result.duration, unit: 's' },
      { label: 'Wall time', value: result.wallMs / 1000, unit: 's' },
      ...result.indicators.map((i) => ({ label: `${i.ref} on`, value: i.onFraction * 100, unit: '%' })),
    ],
    warnings: [...result.warnings, ...errors.map((e) => `${e.source}: ${e.msg}`)],
    pass: errors.length === 0,
  };
  const text = [
    summary.headline,
    ...result.mcus.map((m) => `${m.ref}: ${m.emulator}${m.firmware ? ` running ${m.firmware}` : ''}, ${m.cycles} cycles @ ${formatValue(m.clockHz, 'Hz')} — ${m.status}`),
    ...result.uart.map((u) => `UART ${u.ref}/${u.port}:\n${u.text.slice(-1500)}`),
    result.indicators.length ? 'Indicators: ' + result.indicators.map((i) => `${i.ref} ${(i.onFraction * 100).toFixed(0)}% on, ${formatValue(i.meanCurrent, 'A')}`).join(', ') : '',
    result.digital.length ? 'Digital activity: ' + result.digital.slice(0, 20).map((d) => `${d.name} ${d.transitions.length} edges`).join(', ') : '',
    ...result.log.filter((l) => l.level !== 'info').slice(0, 20).map((l) => `[${l.level}] ${l.t.toFixed(4)}s ${l.source}: ${l.msg}`),
    ...result.warnings,
  ].filter(Boolean);
  return { result, summary, text: text.join('\n') };
}

/* ----------------------------------------- PCB tasks --------------------------------------------- */

function place(p: { board: Board; parts: Record<string, PartDef>; opts?: Parameters<typeof pcb.autoPlace>[2] }) {
  return pcb.autoPlace(p.board, p.parts, p.opts);
}

function route(p: { board: Board; parts: Record<string, PartDef>; opts?: Parameters<typeof pcb.autoRoute>[2] }) {
  return pcb.autoRoute(p.board, p.parts, p.opts);
}

function zones(p: { board: Board; parts: Record<string, PartDef> }) {
  return pcb.fillZones(p.board, p.parts);
}

function checks(p: { board: Board; parts: Record<string, PartDef> }) {
  return { drc: pcb.runDrc(p.board, p.parts), erc: pcb.runErc(p.board, p.parts), ratsnest: pcb.ratsnest(p.board, p.parts), stats: pcb.boardStats(p.board, p.parts) };
}

async function mechChecks(p: { project: Project }) {
  await mech.initGeometry();
  const issues: DesignIssue[] = [];
  for (const part of p.project.mechanical) {
    if (part.kind === 'enclosure-shell' || (part.kind === 'custom' && part.process === 'injection-molding')) issues.push(...mech.checkMoldability(part).map((i) => ({ ...i, target: { ...i.target, partId: part.id } })));
    if (part.kind === 'sheet-metal') issues.push(...mech.checkSheetMetal(part).map((i) => ({ ...i, target: { ...i.target, partId: part.id } })));
  }
  if (p.project.assembly.instances.length) issues.push(...mech.checkAssembly(p.project));
  return issues;
}

async function enclosure(p: { project: Project; boardIds: string[]; opts: Parameters<typeof mech.autoEnclosure>[2] }) {
  await mech.initGeometry();
  return mech.autoEnclosure(p.project, p.boardIds, p.opts);
}

async function flat(p: { part: MechPart }) {
  if (p.part.kind !== 'sheet-metal') throw new Error('Flat patterns exist only for sheet-metal parts');
  const f = mech.flatPattern(p.part);
  return { flat: f, dxf: mech.exportDxf(f) };
}

async function costs(p: { project: Project; qty: number }) {
  await mech.initGeometry();
  return p.project.mechanical.map((m) => ({ partId: m.id, name: m.name, ...mech.estimateCost(m, p.qty) }));
}

async function exportManufacturing(p: { project: Project; boardIds?: string[]; include?: string[] }, progress: Progress) {
  await mech.initGeometry();
  const include = new Set(p.include?.length ? p.include : ['gerber', 'drill', 'bom', 'cpl', 'stl', 'dxf', 'project']);
  const files: { name: string; content: string | Uint8Array }[] = [];
  const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_');
  const boards = p.project.boards.filter((b) => !p.boardIds?.length || p.boardIds.includes(b.id));
  boards.forEach((b, i) => {
    progress((i / Math.max(1, boards.length)) * 0.5, `Gerbers for ${b.name}`);
    if (include.has('gerber') || include.has('drill')) {
      const g = pcb.exportGerbers(b, p.project.parts, { projectName: p.project.name });
      for (const f of g.files) files.push({ name: `pcb/${slug(b.name)}/${f.name}`, content: f.content });
    }
    if (include.has('cpl')) files.push({ name: `pcb/${slug(b.name)}/${slug(b.name)}-CPL.csv`, content: pcb.exportCpl(b, p.project.parts) });
    if (include.has('bom')) files.push({ name: `pcb/${slug(b.name)}/${slug(b.name)}-BOM.csv`, content: pcb.exportBom(p.project, { boardId: b.id, quantity: p.project.settings.buildQuantity }) });
  });
  if (include.has('bom')) files.push({ name: 'BOM-all-boards.csv', content: pcb.exportBom(p.project, { quantity: p.project.settings.buildQuantity }) });
  let i = 0;
  for (const m of p.project.mechanical) {
    progress(0.5 + (i++ / Math.max(1, p.project.mechanical.length)) * 0.45, `Mechanical: ${m.name}`);
    if (include.has('stl')) {
      const mesh = await mech.buildPartMesh(m, { project: p.project });
      files.push({ name: `mechanical/${slug(m.name)}.stl`, content: mech.exportStl(mesh, m.name) });
    }
    if (include.has('dxf') && m.kind === 'sheet-metal') files.push({ name: `mechanical/${slug(m.name)}-flat.dxf`, content: mech.exportDxf(mech.flatPattern(m)) });
  }
  if (include.has('project')) files.push({ name: `${slug(p.project.name)}.pcbcad.json`, content: JSON.stringify(p.project, null, 2) });
  const steps = Object.values(p.project.parts)
    .filter((pt) => pt.model3d?.stepUrl)
    .map((pt) => `${pt.mpn}\t${pt.model3d!.stepUrl}`);
  const readme = [
    `${p.project.name} — manufacturing package generated by PCBCAD ${new Date().toISOString()}`,
    '',
    'pcb/<board>/ : RS-274X Gerbers + Excellon drills (upload the folder zipped to your PCB fab), BOM and CPL (JLCPCB assembly format).',
    'mechanical/ : STL meshes of molded/sheet-metal parts (for quoting/prototyping); DXF flat patterns for sheet metal.',
    '',
    'Component STEP models (EasyEDA library):',
    ...steps,
  ].join('\n');
  files.push({ name: 'README.txt', content: readme });
  progress(0.97, 'Zipping');
  const zip = pcb.zipFiles(files);
  return { zip, files: files.map((f) => ({ name: f.name, size: typeof f.content === 'string' ? f.content.length : f.content.byteLength })) };
}

export const HANDLERS: Record<string, Handler> = {
  'circuit.op': circuitOp,
  'circuit.transient': circuitTransient,
  'pcb.thermal': pcbThermal,
  'pcb.place': place,
  'pcb.route': route,
  'pcb.zones': zones,
  'pcb.checks': checks,
  'mech.mesh': partMesh,
  'mech.fastenerMesh': fastenerMeshTask,
  'mech.structural': structural,
  'mech.drop': drop,
  'mech.airflow': airflow,
  'mech.checks': mechChecks,
  'mech.enclosure': enclosure,
  'mech.flat': flat,
  'mech.costs': costs,
  mixed,
  'export.manufacturing': exportManufacturing,
};

// exported for tools that want an effective-material description without a worker hop
export { effectiveMaterial };
