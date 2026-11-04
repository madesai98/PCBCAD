import { copperLayers, newId, type Board, type CopperLayer, type PartDef, type Project, type Vec2 } from '@pcbcad/core';
import { boardStats, runDrc } from '@pcbcad/pcb';
import { boardSize, requireBoard, requireComponent } from '../helpers';
import { S, ToolError, type ToolContext, type ToolDef } from '../registry';
import { formatIssues, setIssues } from './project';

const LAYERS = ['top', 'bottom', 'in1', 'in2', 'in3', 'in4'] as const;

export function partsFor(p: Project, b: Board): Record<string, PartDef> {
  const out: Record<string, PartDef> = {};
  for (const c of b.components) if (p.parts[c.partId]) out[c.partId] = p.parts[c.partId];
  return out;
}

function resolveNet(b: Board, net: string) {
  const n = b.nets.find((x) => x.id === net || x.name.toLowerCase() === net.toLowerCase());
  if (!n) throw new ToolError(`Net '${net}' not found on ${b.name}. Nets: ${b.nets.map((x) => x.name).join(', ')}`);
  return n;
}

export function runDrcFor(ctx: ToolContext, b: Board): string {
  const p = ctx.session.project;
  const issues = runDrc(b, partsFor(p, b)).map((i) => ({ ...i, target: { ...i.target, boardId: b.id } }));
  const stats = boardStats(b, partsFor(p, b));
  ctx.session.mutate(ctx, 'run_drc', (pr) => {
    setIssues(pr, ['drc'], issues, { boardId: b.id });
    return `DRC ${b.name}: ${issues.filter((i) => i.severity === 'error').length} errors, ${issues.filter((i) => i.severity === 'warning').length} warnings, routed ${stats.routedPct.toFixed(0)}%`;
  });
  return `DRC for ${b.name}: routed ${stats.routedPct.toFixed(0)}%, ${stats.viaCount} vias, ${stats.traceLengthMm.toFixed(0)} mm of trace.\n${formatIssues(issues)}`;
}

async function refillZones(ctx: ToolContext, b: Board) {
  if (!b.zones.length) return;
  const p = ctx.session.project;
  const filled = await ctx.services.tasks.run<Board>('pcb.zones', { board: b, parts: partsFor(p, b) }, { signal: ctx.signal });
  const fills = new Map(filled.zones.map((z) => [z.id, z.fill]));
  ctx.session.mutate(ctx, 'fill_zones', () => {
    for (const z of b.zones) z.fill = fills.get(z.id) ?? z.fill;
    return `Refilled ${b.zones.length} copper zone(s) on ${b.name}`;
  });
}

export const layoutTools: ToolDef[] = [
  {
    name: 'auto_place',
    title: 'Auto-place components',
    group: 'layout',
    description:
      'Automatically place components inside the board outline: connectors to edges (override with `edges`), decoupling caps next to their IC power pins, crystals by the MCU, the rest grouped by connectivity, with no courtyard overlaps. Locked components (and already placed ones with keepPlaced) stay.',
    inputSchema: S.obj(
      {
        boardId: S.str(),
        keepPlaced: S.bool('Keep components that already have positions (default false)'),
        edges: S.arr(S.obj({ ref: S.str(), edge: S.enum(['left', 'right', 'top', 'bottom']), offset: S.num('position along the edge from its centre, mm') }, ['ref', 'edge'])),
        spacing: S.num('min courtyard spacing mm (default 0.5)'),
      },
      ['boardId'],
    ),
    handler: async (ctx, a: { boardId: string; keepPlaced?: boolean; edges?: { ref: string; edge: 'left' | 'right' | 'top' | 'bottom'; offset?: number }[]; spacing?: number }) => {
      const p = ctx.session.project;
      const b = requireBoard(p, a.boardId);
      const edges = (a.edges ?? []).map((e) => ({ componentId: requireComponent(b, e.ref).id, edge: e.edge, offset: e.offset }));
      const r = await ctx.services.tasks.run<{ board: Board; report: string[] }>('pcb.place', { board: b, parts: partsFor(p, b), opts: { keepPlaced: a.keepPlaced, edges, spacing: a.spacing } }, { signal: ctx.signal });
      const byId = new Map(r.board.components.map((c) => [c.id, c]));
      ctx.session.mutate(ctx, 'auto_place', () => {
        for (const c of b.components) {
          const n = byId.get(c.id);
          if (!n) continue;
          c.x = n.x;
          c.y = n.y;
          c.rotation = n.rotation;
          c.side = n.side;
          c.placed = n.placed;
        }
        return `Auto-placed ${b.components.length} components on ${b.name}`;
      });
      const pos = b.components.map((c) => `${c.ref}(${c.x.toFixed(1)},${c.y.toFixed(1)},${c.rotation}°${c.side === 'bottom' ? ',B' : ''})`).join(' ');
      return `Placed components on ${b.name}.\n${r.report.join('\n')}\nPositions: ${pos}`;
    },
  },
  {
    name: 'move_components',
    title: 'Move components',
    group: 'layout',
    description: 'Set exact positions (mm, board frame, origin lower-left), rotations (deg CCW) and sides for components. Use for connectors at edges, mounting-sensitive parts, or manual refinements.',
    inputSchema: S.obj(
      { boardId: S.str(), moves: S.arr(S.obj({ ref: S.str(), x: S.num(), y: S.num(), rotation: S.num(), side: S.enum(['top', 'bottom']), lock: S.bool() }, ['ref', 'x', 'y'])) },
      ['boardId', 'moves'],
    ),
    handler: (ctx, a: { boardId: string; moves: { ref: string; x: number; y: number; rotation?: number; side?: 'top' | 'bottom'; lock?: boolean }[] }) => {
      const b = requireBoard(ctx.session.project, a.boardId);
      const comps = a.moves.map((m) => ({ m, c: requireComponent(b, m.ref) }));
      ctx.session.mutate(ctx, 'move_components', () => {
        for (const { m, c } of comps) {
          c.x = m.x;
          c.y = m.y;
          if (m.rotation != null) c.rotation = m.rotation;
          if (m.side) c.side = m.side;
          if (m.lock != null) c.locked = m.lock;
          c.placed = true;
        }
        return `Moved ${comps.map((x) => x.c.ref).join(', ')} on ${b.name}`;
      });
      return `Moved ${comps.length} component(s).`;
    },
  },
  {
    name: 'add_mounting_holes',
    title: 'Add mounting holes',
    group: 'layout',
    description: 'Add mounting holes: preset "corners" (inset from each corner) or explicit positions. Default drill 3.2 mm (M3 clearance); use 2.7 for M2.5, 2.2 for M2. Enclosure generation puts bosses under these holes.',
    inputSchema: S.obj(
      {
        boardId: S.str(),
        preset: S.enum(['corners']),
        inset: S.num('mm from board edges for corners preset (default 3.5)'),
        drill: S.num('mm'),
        plated: S.bool(),
        holes: S.arr(S.obj({ x: S.num(), y: S.num(), drill: S.num() }, ['x', 'y'])),
      },
      ['boardId'],
    ),
    handler: (ctx, a: { boardId: string; preset?: 'corners'; inset?: number; drill?: number; plated?: boolean; holes?: { x: number; y: number; drill?: number }[] }) => {
      const b = requireBoard(ctx.session.project, a.boardId);
      const drill = a.drill ?? 3.2;
      const pts: { x: number; y: number; drill: number }[] = [...(a.holes ?? []).map((h) => ({ ...h, drill: h.drill ?? drill }))];
      if (a.preset === 'corners') {
        const { w, h } = boardSize(b);
        const i = a.inset ?? 3.5;
        pts.push({ x: i, y: i, drill }, { x: w - i, y: i, drill }, { x: w - i, y: h - i, drill }, { x: i, y: h - i, drill });
      }
      if (!pts.length) throw new ToolError('Give preset "corners" or explicit holes');
      ctx.session.mutate(ctx, 'add_mounting_holes', () => {
        for (const pt of pts) b.holes.push({ id: newId('hole'), x: pt.x, y: pt.y, drill: pt.drill, plated: a.plated ?? false, padDiameter: a.plated ? pt.drill + 1.6 : undefined });
        return `Added ${pts.length} mounting hole(s) to ${b.name}`;
      });
      return `Added holes: ${pts.map((h) => `(${h.x.toFixed(1)}, ${h.y.toFixed(1)}) Ø${h.drill}`).join(', ')}. Keep components ≥ ${(drill / 2 + 2.5).toFixed(1)} mm from hole centres for screw heads.`;
    },
  },
  {
    name: 'auto_route',
    title: 'Auto-route',
    group: 'layout',
    description:
      'Route unrouted connections with the grid maze router (45°, vias, per-net-class widths, DRC-aware). Optionally limit to nets or skip nets (e.g. skip GND when a ground pour will connect it). Copper zones are refilled and DRC is run afterwards.',
    inputSchema: S.obj(
      { boardId: S.str(), nets: S.arr(S.str()), skipNets: S.arr(S.str()), grid: S.num('routing grid mm (default board rule)'), maxTimeMs: S.int() },
      ['boardId'],
    ),
    slow: true,
    handler: async (ctx, a: { boardId: string; nets?: string[]; skipNets?: string[]; grid?: number; maxTimeMs?: number }) => {
      const p = ctx.session.project;
      const b = requireBoard(p, a.boardId);
      const unplaced = b.components.filter((c) => !c.placed && !c.dnp);
      if (unplaced.length) throw new ToolError(`Place all components first (unplaced: ${unplaced.map((c) => c.ref).join(', ')}). Use auto_place or move_components.`);
      const nets = a.nets?.map((n) => resolveNet(b, n).id);
      const skip = a.skipNets?.map((n) => resolveNet(b, n).id);
      const r = await ctx.services.tasks.run<{ board: Board; routed: string[]; failed: { netId: string; name: string; reason: string }[]; stats: { segments: number; vias: number; lengthMm: number; timeMs: number } }>(
        'pcb.route',
        { board: b, parts: partsFor(p, b), opts: { nets, skipNets: skip, grid: a.grid, maxTimeMs: a.maxTimeMs ?? 60_000, layers: copperLayers(b.stackup) } },
        { signal: ctx.signal, timeoutMs: 5 * 60_000 },
      );
      ctx.session.mutate(ctx, 'auto_route', () => {
        b.traces = r.board.traces;
        b.vias = r.board.vias;
        return `Routed ${r.routed.length} nets on ${b.name} (${r.stats.vias} vias, ${r.stats.lengthMm.toFixed(0)} mm)${r.failed.length ? `, ${r.failed.length} failed` : ''}`;
      });
      await refillZones(ctx, b);
      const drc = runDrcFor(ctx, b);
      return `Routed ${r.routed.length} net(s) in ${(r.stats.timeMs / 1000).toFixed(1)} s: ${r.stats.segments} segments, ${r.stats.vias} vias, ${r.stats.lengthMm.toFixed(0)} mm.${r.failed.length ? `\nFailed: ${r.failed.map((f) => `${f.name} (${f.reason})`).join('; ')}\nTips: move parts apart, add a GND pour, use 4 layers, or route manually with add_trace.` : ''}\n${drc}`;
    },
  },
  {
    name: 'add_trace',
    title: 'Add trace',
    group: 'layout',
    description: 'Add a manual copper trace (polyline, mm, board frame) on a layer for a net. Width defaults to the net/class rule.',
    inputSchema: S.obj({ boardId: S.str(), net: S.str(), layer: S.enum(LAYERS), width: S.num(), points: S.arr(S.vec2(), undefined, { minItems: 2 }) }, ['boardId', 'net', 'layer', 'points']),
    handler: (ctx, a: { boardId: string; net: string; layer: CopperLayer; width?: number; points: Vec2[] }) => {
      const b = requireBoard(ctx.session.project, a.boardId);
      const n = resolveNet(b, a.net);
      if (!copperLayers(b.stackup).includes(a.layer as never)) throw new ToolError(`Layer ${a.layer} not in ${b.stackup.layers}-layer stack-up`);
      const width = a.width ?? n.traceWidth ?? (n.class === 'power' || n.class === 'ground' ? b.rules.powerTraceWidth : b.rules.traceWidth);
      ctx.session.mutate(ctx, 'add_trace', () => {
        b.traces.push({ id: newId('trk'), netId: n.id, layer: a.layer, width, points: a.points });
        return `Added ${n.name} trace on ${a.layer} (${a.points.length} points)`;
      });
      return `Trace added on ${a.layer}, width ${width} mm.`;
    },
  },
  {
    name: 'add_via',
    title: 'Add via',
    group: 'layout',
    description: 'Add a through via for a net at (x, y). Defaults to the board via rule.',
    inputSchema: S.obj({ boardId: S.str(), net: S.str(), x: S.num(), y: S.num(), drill: S.num(), diameter: S.num() }, ['boardId', 'net', 'x', 'y']),
    handler: (ctx, a: { boardId: string; net: string; x: number; y: number; drill?: number; diameter?: number }) => {
      const b = requireBoard(ctx.session.project, a.boardId);
      const n = resolveNet(b, a.net);
      ctx.session.mutate(ctx, 'add_via', () => {
        b.vias.push({ id: newId('via'), netId: n.id, x: a.x, y: a.y, drill: a.drill ?? b.rules.viaDrill, diameter: a.diameter ?? b.rules.viaDiameter });
        return `Added ${n.name} via at (${a.x}, ${a.y})`;
      });
      return 'Via added.';
    },
  },
  {
    name: 'clear_routing',
    title: 'Clear routing',
    group: 'layout',
    description: 'Delete traces and vias (all, or only for the listed nets). Locked traces are kept.',
    inputSchema: S.obj({ boardId: S.str(), nets: S.arr(S.str()) }, ['boardId']),
    handler: (ctx, a: { boardId: string; nets?: string[] }) => {
      const b = requireBoard(ctx.session.project, a.boardId);
      const ids = a.nets ? new Set(a.nets.map((n) => resolveNet(b, n).id)) : null;
      let removed = 0;
      ctx.session.mutate(ctx, 'clear_routing', () => {
        const before = b.traces.length + b.vias.length;
        b.traces = b.traces.filter((t) => t.locked || (ids && !ids.has(t.netId)));
        b.vias = b.vias.filter((v) => ids && !ids.has(v.netId));
        removed = before - b.traces.length - b.vias.length;
        return removed ? `Cleared ${removed} traces/vias on ${b.name}` : null;
      });
      return `Removed ${removed} traces/vias.`;
    },
  },
  {
    name: 'add_zone',
    title: 'Add copper pour',
    group: 'layout',
    description: 'Add a copper pour (zone) for a net on a layer — typically GND on bottom (and top) for return paths, heat spreading and fewer routes. Fills around other nets with clearance and thermal reliefs.',
    inputSchema: S.obj(
      { boardId: S.str(), net: S.str(), layer: S.enum(LAYERS), clearance: S.num('mm (default 0.3)'), thermalRelief: S.bool(), priority: S.int(), outline: S.arr(S.vec2()) },
      ['boardId', 'net', 'layer'],
    ),
    slow: true,
    handler: async (ctx, a: { boardId: string; net: string; layer: CopperLayer; clearance?: number; thermalRelief?: boolean; priority?: number; outline?: Vec2[] }) => {
      const b = requireBoard(ctx.session.project, a.boardId);
      const n = resolveNet(b, a.net);
      ctx.session.mutate(ctx, 'add_zone', () => {
        b.zones = b.zones.filter((z) => !(z.netId === n.id && z.layer === a.layer && !a.outline));
        b.zones.push({ id: newId('zone'), netId: n.id, layer: a.layer, clearance: a.clearance ?? 0.3, thermalRelief: a.thermalRelief ?? true, priority: a.priority ?? 0, outline: a.outline, minWidth: 0.25 });
        return `Added ${n.name} pour on ${a.layer} (${b.name})`;
      });
      await refillZones(ctx, b);
      const z = b.zones[b.zones.length - 1];
      return `Zone filled: ${z.fill?.length ?? 0} polygon ring(s).`;
    },
  },
  {
    name: 'run_drc',
    title: 'Design rules check',
    group: 'layout',
    description: 'Run the PCB design-rule check (clearances, shorts, unrouted nets, widths, drills, annular rings, edge clearance, courtyard overlaps, unplaced parts). Results are stored as issues.',
    inputSchema: S.obj({ boardId: S.str() }, ['boardId']),
    handler: (ctx, a: { boardId: string }) => runDrcFor(ctx, requireBoard(ctx.session.project, a.boardId)),
  },
];
