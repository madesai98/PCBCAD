import {
  effectiveMaterial,
  getMaterial,
  MATERIALS,
  newId,
  PROCESSES,
  type AssemblyInstance,
  type CsgNode,
  type EnclosureShell,
  type FastenerInstance,
  type ManufacturingProcess,
  type MechPart,
  type SheetFlange,
  type SheetHole,
  type SheetMetalPart,
  type ShellFace,
  type Vec3,
} from '@pcbcad/core';
import { requireBoard, requireMech } from '../helpers';
import { S, ToolError, type ToolContext, type ToolDef } from '../registry';
import { ensurePart } from './parts';
import { formatIssues, setIssues } from './project';

const PROCESS_IDS = PROCESSES.map((p) => p.id);
const FACES = ['floor', '+x', '-x', '+y', '-y'] as const;

function checkMaterialProcess(materialId: string, process: ManufacturingProcess) {
  const m = getMaterial(materialId);
  if (!m) throw new ToolError(`Unknown material '${materialId}'. Use list_materials.`);
  if (m.processes.length && !m.processes.includes(process)) {
    throw new ToolError(`${m.name} is not normally processed by ${process}. Suitable: ${m.processes.join(', ')}`);
  }
  return m;
}

function materialSummary(materialId: string, process: ManufacturingProcess, opts?: Record<string, string | number | boolean>) {
  const e = effectiveMaterial(materialId, process, opts);
  return `${e.name} via ${process}: E ${e.E.toFixed(0)} MPa, σy ${e.yieldStrength.toFixed(0)} MPa, ρ ${e.density.toFixed(0)} kg/m³, k ${e.thermalConductivity} W/mK, max service ${e.maxServiceTemp} °C${e.adjustments.length ? ` [${e.adjustments.join('; ')}]` : ''}`;
}

/**
 * Mechanical part meshes are cached content-addressed (hash of the part definition) by the
 * server and the browser, so edits automatically produce new meshes; nothing to invalidate.
 */
export function invalidateMesh(_ctx: ToolContext, _partId: string) {}

async function runMechChecks(ctx: ToolContext) {
  const issues = await ctx.services.tasks.run<import('@pcbcad/core').DesignIssue[]>('mech.checks', { project: ctx.session.project }, { signal: ctx.signal });
  ctx.session.mutate(ctx, 'run_dfm', (p) => {
    setIssues(p, ['dfm', 'assembly'], issues);
    return `DFM/assembly check: ${issues.filter((i) => i.severity === 'error').length} errors, ${issues.filter((i) => i.severity === 'warning').length} warnings`;
  });
  return issues;
}

export const mechTools: ToolDef[] = [
  {
    name: 'list_materials',
    title: 'Materials',
    group: 'mechanical',
    description: 'List engineering materials with key properties and the manufacturing processes they suit (injection-molding resins, sheet metals, printing materials, die-cast alloys). Properties used in simulation are adjusted for the chosen process (knit lines, fibre orientation, layer adhesion, porosity, finish emissivity).',
    inputSchema: S.obj({ process: S.enum(PROCESS_IDS) }),
    handler: (_ctx, a: { process?: ManufacturingProcess }) => {
      const list = MATERIALS.filter((m) => m.family !== 'gas' && (!a.process || m.processes.includes(a.process)));
      return list
        .map((m) => {
          const mold = m.molding ? ` | wall ${m.molding.minWall}–${m.molding.maxWall} (nom ${m.molding.nominalWall}) mm, draft ≥${m.molding.minDraft}°, shrink ${m.molding.shrinkage}%` : '';
          const sheet = m.sheet ? ` | bend r ≥ ${m.sheet.minBendRadiusFactor}t, K ${m.sheet.kFactor}, gauges ${m.sheet.gauges.join('/')}` : '';
          return `${m.id} | ${m.name} | E ${m.E} MPa, σy ${m.yieldStrength} MPa, ρ ${m.density}, k ${m.thermalConductivity}, Tmax ${m.hdt ?? m.maxServiceTemp} °C | ${m.processes.join(', ')}${mold}${sheet}`;
        })
        .join('\n');
    },
  },
  {
    name: 'create_enclosure',
    title: 'Generate enclosure',
    group: 'mechanical',
    description:
      'Design an injection-molded two-part enclosure (base + cover) around one or more boards: sized to the boards with clearances, heat-set-insert or thread-forming bosses under every board mounting hole, case screw bosses, lip/groove seal, cut-outs aligned with edge connectors (from their connector opening spec), vent slots, and assembly placement of boards/shells/fasteners. Material default PC/ABS, 2.0 mm wall, 1° draft. Edit afterwards with update_mech_part / add_shell_feature.',
    inputSchema: S.obj(
      {
        boardIds: S.arr(S.str(), 'Boards to enclose (default all)'),
        materialId: S.str('e.g. pc-abs, abs, pc, pa66-gf30, asa'),
        process: S.enum(PROCESS_IDS),
        wall: S.num('mm'),
        clearance: S.num('side clearance board→wall mm (default 1.5)'),
        topClearance: S.num('mm above tallest component'),
        bottomClearance: S.num('standoff height under the board mm'),
        cornerRadius: S.num(),
        ventFaces: S.arr(S.enum(['top', 'bottom', '+x', '-x', '+y', '-y']), 'Vent slot faces. top/bottom (cover/base floors) mold without slides and form a natural-convection chimney; side faces need side actions.'),
        insert: S.enum(['heat-set', 'self-tapping']),
        screwPart: S.str('Fastener part id for PCB/case screws'),
        insertPart: S.str('Heat-set insert part id'),
        color: S.str('#rrggbb'),
      },
    ),
    slow: true,
    handler: async (ctx, a: any) => {
      const p = ctx.session.project;
      const boardIds = (a.boardIds?.length ? a.boardIds : p.boards.map((b) => b.id)).map((id: string) => requireBoard(p, id).id);
      if (!boardIds.length) throw new ToolError('No boards to enclose');
      const process: ManufacturingProcess = a.process ?? 'injection-molding';
      const materialId = a.materialId ?? 'pc-abs';
      checkMaterialProcess(materialId, process);
      const screw = a.screwPart ? await ensurePart(ctx, a.screwPart) : undefined;
      const insert = a.insertPart ? await ensurePart(ctx, a.insertPart) : undefined;
      const r = await ctx.services.tasks.run<{ base: EnclosureShell; cover: EnclosureShell; instances: AssemblyInstance[]; fasteners: FastenerInstance[]; notes: string[] }>(
        'mech.enclosure',
        {
          project: ctx.session.project,
          boardIds,
          opts: {
            materialId,
            process,
            wall: a.wall,
            clearance: a.clearance,
            topClearance: a.topClearance,
            bottomClearance: a.bottomClearance,
            cornerRadius: a.cornerRadius,
            ventFaces: a.ventFaces,
            insert: a.insert,
            fastenerPartIds: { screw: screw?.id, insert: insert?.id },
          },
        },
        { signal: ctx.signal },
      );
      if (a.color) {
        r.base.color = a.color;
        r.cover.color = a.color;
      }
      // fasteners without a part id: try the catalog defaults
      for (const f of r.fasteners) if (!f.partId && screw) f.partId = screw.id;
      const fasteners = r.fasteners.filter((f) => f.partId);
      ctx.session.mutate(ctx, 'create_enclosure', (pr) => {
        pr.mechanical = pr.mechanical.filter((m) => m.id !== r.base.id && m.id !== r.cover.id);
        pr.mechanical.push(r.base, r.cover);
        const touched = new Set(r.instances.map((i) => (i.target.kind === 'board' ? `b:${i.target.boardId}` : `m:${i.target.partId}`)));
        pr.assembly.instances = pr.assembly.instances.filter((i) => !touched.has(i.target.kind === 'board' ? `b:${i.target.boardId}` : `m:${i.target.partId}`));
        pr.assembly.instances.push(...r.instances);
        pr.assembly.fasteners.push(...fasteners);
        return `Generated enclosure ${r.base.outer.width}×${r.base.outer.depth}×${(r.base.outer.height + r.cover.outer.height).toFixed(1)} mm (${getMaterial(materialId)?.name}, ${process})`;
      });
      const shell = (s: EnclosureShell) =>
        `${s.name} [${s.id}] ${s.role}: ${s.outer.width}×${s.outer.depth}×${s.outer.height} mm, wall ${s.wall}, draft ${s.draftDeg}°, bosses ${s.bosses.length}, cutouts ${s.cutouts.map((c) => `${c.face}${c.linked ? `→${c.purpose}` : ''}`).join(',') || 'none'}, vents ${s.vents.length}`;
      return [
        'Enclosure created:',
        shell(r.base),
        shell(r.cover),
        `Material: ${materialSummary(materialId, process)}`,
        `Assembly: ${r.instances.length} instances placed; ${fasteners.length} fasteners${r.fasteners.length > fasteners.length ? ` (${r.fasteners.length - fasteners.length} fastener positions need a part: pass screwPart/insertPart or add_fastener)` : ''}.`,
        ...r.notes,
        'Next: run_dfm, then simulate_drop / simulate_airflow.',
      ].join('\n');
    },
  },
  {
    name: 'add_enclosure_shell',
    title: 'Add enclosure shell',
    group: 'mechanical',
    description: 'Create a single molded shell manually (frame: XY centred, z=0 outer floor surface, open face at z=height). Prefer create_enclosure for complete enclosures.',
    inputSchema: S.obj(
      {
        name: S.str(),
        role: S.enum(['base', 'cover', 'single']),
        width: S.num(),
        depth: S.num(),
        height: S.num(),
        wall: S.num(),
        cornerRadius: S.num(),
        draftDeg: S.num(),
        materialId: S.str(),
        process: S.enum(PROCESS_IDS),
        color: S.str(),
        lip: S.obj({ kind: S.enum(['lip', 'groove']), height: S.num(), thickness: S.num() }),
      },
      ['name', 'width', 'depth', 'height'],
    ),
    handler: (ctx, a: any) => {
      const process = a.process ?? 'injection-molding';
      const materialId = a.materialId ?? 'pc-abs';
      const mat = checkMaterialProcess(materialId, process);
      const shell: EnclosureShell = {
        id: newId('mech'),
        kind: 'enclosure-shell',
        name: a.name,
        role: a.role ?? 'single',
        materialId,
        process,
        color: a.color ?? mat.color,
        outer: { width: a.width, depth: a.depth, height: a.height },
        wall: a.wall ?? mat.molding?.nominalWall ?? 2,
        cornerRadius: a.cornerRadius ?? 3,
        draftDeg: a.draftDeg ?? Math.max(1, mat.molding?.minDraft ?? 1),
        lip: a.lip,
        bosses: [],
        ribs: [],
        cutouts: [],
        vents: [],
        snaps: [],
      };
      ctx.session.mutate(ctx, 'add_enclosure_shell', (p) => {
        p.mechanical.push(shell);
        p.assembly.instances.push({ id: newId('inst'), name: shell.name, target: { kind: 'mech', partId: shell.id }, transform: { position: [0, 0, 0], rotation: [0, 0, 0] } });
        return `Added shell ${shell.name}`;
      });
      return `Shell ${shell.name} [${shell.id}] created. ${materialSummary(materialId, process)}`;
    },
  },
  {
    name: 'update_mech_part',
    title: 'Update mechanical part',
    group: 'mechanical',
    description:
      'Change a mechanical part: name, material, manufacturing process (+ options such as {"texture":"MT-11010"}, {"finish":"anodized-black"}, {"infill":0.4}), colour, and geometry parameters (shell: outer {width,depth,height}, wall, cornerRadius, draftDeg, lip; sheet metal: thickness, bendRadius, kFactor, base, flanges, holes; custom: csg). Changing process re-derives material properties used in simulation.',
    inputSchema: S.obj(
      {
        partId: S.str(),
        name: S.str(),
        materialId: S.str(),
        process: S.enum(PROCESS_IDS),
        processOptions: S.any(),
        color: S.str(),
        params: S.any('Part-kind specific fields to replace, e.g. {"wall":2.5,"draftDeg":1.5} or {"thickness":1.2,"flanges":[...]}'),
      },
      ['partId'],
    ),
    handler: (ctx, a: any) => {
      const m = requireMech(ctx.session.project, a.partId);
      const process = a.process ?? m.process;
      const materialId = a.materialId ?? m.materialId;
      checkMaterialProcess(materialId, process);
      const forbidden = new Set(['id', 'kind']);
      ctx.session.mutate(ctx, 'update_mech_part', () => {
        if (a.name) m.name = a.name;
        m.materialId = materialId;
        m.process = process;
        if (a.processOptions) m.processOptions = { ...m.processOptions, ...a.processOptions };
        if (a.color) m.color = a.color;
        if (a.params && typeof a.params === 'object') for (const [k, v] of Object.entries(a.params)) if (!forbidden.has(k)) (m as any)[k] = v;
        return `Updated ${m.name}`;
      });
      invalidateMesh(ctx, m.id);
      return `Updated ${m.name}. ${materialSummary(materialId, process, m.processOptions)}`;
    },
  },
  {
    name: 'add_shell_feature',
    title: 'Add shell feature',
    group: 'mechanical',
    description:
      'Add a feature to an enclosure shell (shell frame: XY centred, z=0 outer floor surface). boss {x,y,outerDiameter,holeDiameter,height,kind:screw|insert|clearance|pin|standoff,gussets?}; rib {from:[x,y],to:[x,y],height,thickness}; cutout {face:floor|+x|-x|+y|-y, shape:rect|rounded-rect|circle|slot, u,v,width,height,radius?,purpose?} where for side faces u is along the face (Y for ±x, X for ±y) and v is height z; vent {face,u,v,slotWidth,slotLength,count,pitch,orientation:u|v}; snap {face,u,width,length,thickness,overhang,kind:hook|catch}.',
    inputSchema: S.obj({ partId: S.str(), type: S.enum(['boss', 'rib', 'cutout', 'vent', 'snap']), params: S.any('Feature fields (see description)') }, ['partId', 'type', 'params']),
    handler: (ctx, a: { partId: string; type: 'boss' | 'rib' | 'cutout' | 'vent' | 'snap'; params: any }) => {
      const m = requireMech(ctx.session.project, a.partId);
      if (m.kind !== 'enclosure-shell') throw new ToolError('Shell features apply to enclosure shells only');
      const f = { id: newId(a.type), ...a.params };
      if ((a.type === 'cutout' || a.type === 'vent' || a.type === 'snap') && !FACES.includes(f.face)) throw new ToolError(`face must be one of ${FACES.join(', ')}`);
      ctx.session.mutate(ctx, 'add_shell_feature', () => {
        if (a.type === 'boss') m.bosses.push({ kind: 'screw', gussets: 0, ...f });
        else if (a.type === 'rib') m.ribs.push(f);
        else if (a.type === 'cutout') m.cutouts.push({ shape: 'rect', ...f });
        else if (a.type === 'vent') m.vents.push({ orientation: 'v', ...f });
        else m.snaps.push(f);
        return `Added ${a.type} to ${m.name}`;
      });
      invalidateMesh(ctx, m.id);
      return `Added ${a.type} [${f.id}] to ${m.name}.`;
    },
  },
  {
    name: 'remove_shell_feature',
    title: 'Remove shell feature',
    group: 'mechanical',
    description: 'Remove a boss/rib/cutout/vent/snap from a shell by feature id.',
    inputSchema: S.obj({ partId: S.str(), featureId: S.str() }, ['partId', 'featureId']),
    handler: (ctx, a: { partId: string; featureId: string }) => {
      const m = requireMech(ctx.session.project, a.partId);
      if (m.kind !== 'enclosure-shell') throw new ToolError('Not a shell');
      let found = false;
      ctx.session.mutate(ctx, 'remove_shell_feature', () => {
        for (const key of ['bosses', 'ribs', 'cutouts', 'vents', 'snaps'] as const) {
          const arr = m[key] as { id: string }[];
          const i = arr.findIndex((x) => x.id === a.featureId);
          if (i >= 0) {
            arr.splice(i, 1);
            found = true;
          }
        }
        return found ? `Removed feature ${a.featureId}` : null;
      });
      if (!found) throw new ToolError(`Feature ${a.featureId} not found`);
      invalidateMesh(ctx, m.id);
      return 'Removed.';
    },
  },
  {
    name: 'create_sheet_metal_part',
    title: 'Create sheet-metal part',
    group: 'mechanical',
    description:
      'Create a sheet-metal part (brackets, chassis, shields, heat spreaders): base rectangle centred at origin (z from 0 to thickness) plus flanges on edges +x/-x/+y/-y (length = outer length from the base outer surface, angle deg, +ve bends up; nested flanges use edge "far"), holes on base (x,y) or on flanges (x = along edge, y = distance from base surface), optional PEM hardware. Bend radius defaults to the material minimum; K-factor from the material. Gives a flat pattern (DXF) for laser cutting + press brake.',
    inputSchema: S.obj(
      {
        name: S.str(),
        materialId: S.str('e.g. al-5052-h32, spcc, sgcc, ss-304'),
        thickness: S.num('mm (prefer a stocked gauge)'),
        bendRadius: S.num(),
        kFactor: S.num(),
        base: S.obj({ width: S.num(), length: S.num(), cornerRadius: S.num() }, ['width', 'length']),
        flanges: S.arr(S.any('SheetFlange {edge,length,angle,width?,offset?,bendRadius?,holes?,flanges?}')),
        holes: S.arr(S.obj({ x: S.num(), y: S.num(), shape: S.enum(['circle', 'rect', 'slot']), diameter: S.num(), width: S.num(), height: S.num(), pemPart: S.str() }, ['x', 'y'])),
        finish: S.str('anodized-black | anodized-clear | powder-coat | zinc-plated | bare | brushed'),
        color: S.str(),
        position: S.vec3('Assembly position mm'),
        rotation: S.vec3('Assembly rotation deg'),
      },
      ['name', 'materialId', 'thickness', 'base'],
    ),
    handler: async (ctx, a: any) => {
      const mat = checkMaterialProcess(a.materialId, 'sheet-metal');
      if (mat.sheet && !mat.sheet.gauges.some((g) => Math.abs(g - a.thickness) < 1e-6)) {
        /* allowed but flagged by DFM */
      }
      const holes: SheetHole[] = [];
      for (const h of a.holes ?? []) {
        const pem = h.pemPart ? await ensurePart(ctx, h.pemPart) : undefined;
        holes.push({ id: newId('hole'), x: h.x, y: h.y, shape: h.shape ?? 'circle', diameter: h.diameter ?? 3.2, width: h.width, height: h.height, pemPartId: pem?.id });
      }
      const withIds = (fl: any[]): SheetFlange[] =>
        (fl ?? []).map((f) => ({
          id: newId('fl'),
          edge: f.edge,
          length: f.length,
          angle: f.angle ?? 90,
          width: f.width,
          offset: f.offset,
          bendRadius: f.bendRadius,
          holes: (f.holes ?? []).map((h: any) => ({ id: newId('hole'), shape: 'circle', diameter: 3.2, ...h })),
          flanges: withIds(f.flanges),
        }));
      const part: SheetMetalPart = {
        id: newId('mech'),
        kind: 'sheet-metal',
        name: a.name,
        materialId: a.materialId,
        process: 'sheet-metal',
        processOptions: a.finish ? { finish: a.finish } : undefined,
        color: a.color ?? (a.finish?.includes('black') ? '#2b2e33' : mat.color),
        thickness: a.thickness,
        bendRadius: a.bendRadius ?? Math.max(0.5, (mat.sheet?.minBendRadiusFactor ?? 1) * a.thickness),
        kFactor: a.kFactor ?? mat.sheet?.kFactor ?? 0.44,
        base: a.base,
        holes,
        flanges: withIds(a.flanges),
        reliefs: 'rect',
      };
      ctx.session.mutate(ctx, 'create_sheet_metal_part', (p) => {
        p.mechanical.push(part);
        p.assembly.instances.push({ id: newId('inst'), name: part.name, target: { kind: 'mech', partId: part.id }, transform: { position: (a.position as Vec3) ?? [0, 0, 0], rotation: (a.rotation as Vec3) ?? [0, 0, 0] } });
        return `Created sheet-metal ${part.name} (${mat.name} ${part.thickness} mm)`;
      });
      const flat = await ctx.services.tasks.run<{ flat: { size: [number, number]; bendLines: unknown[]; areaMm2: number } }>('mech.flat', { part }, { signal: ctx.signal }).catch(() => null);
      return `Sheet-metal part ${part.name} [${part.id}]: ${part.thickness} mm ${mat.name}, r=${part.bendRadius} mm, K=${part.kFactor}, ${part.flanges.length} flange(s), ${holes.length} hole(s).${flat ? ` Flat blank ${flat.flat.size[0].toFixed(1)}×${flat.flat.size[1].toFixed(1)} mm, ${flat.flat.bendLines.length} bend(s).` : ''} ${materialSummary(part.materialId, 'sheet-metal', part.processOptions)}`;
    },
  },
  {
    name: 'create_custom_part',
    title: 'Create custom part',
    group: 'mechanical',
    description:
      'Create a part from CSG (knobs, light pipes, buttons, spacers, machined blocks): nodes {shape:"box",size:[x,y,z],center?}, {shape:"cylinder",radius,height,radiusTop?}, {shape:"sphere",radius}, {shape:"extrude",points:[[x,y]...],height}, {shape:"revolve",profile:[[r,z]...]}, combined with {op:"union"|"difference"|"intersection",children:[...]}; any node may have transform {position:[x,y,z],rotation:[rx,ry,rz]}.',
    inputSchema: S.obj({ name: S.str(), materialId: S.str(), process: S.enum(PROCESS_IDS), csg: S.any('CsgNode'), color: S.str(), position: S.vec3(), rotation: S.vec3() }, ['name', 'materialId', 'process', 'csg']),
    handler: (ctx, a: any) => {
      checkMaterialProcess(a.materialId, a.process);
      const part: MechPart = { id: newId('mech'), kind: 'custom', name: a.name, materialId: a.materialId, process: a.process, csg: a.csg as CsgNode, color: a.color };
      ctx.session.mutate(ctx, 'create_custom_part', (p) => {
        p.mechanical.push(part);
        p.assembly.instances.push({ id: newId('inst'), name: part.name, target: { kind: 'mech', partId: part.id }, transform: { position: a.position ?? [0, 0, 0], rotation: a.rotation ?? [0, 0, 0] } });
        return `Created custom part ${part.name}`;
      });
      return `Custom part ${part.name} [${part.id}] created. ${materialSummary(a.materialId, a.process)}`;
    },
  },
  {
    name: 'place_in_assembly',
    title: 'Place in assembly',
    group: 'assembly',
    description: 'Position a board or mechanical part in the product assembly (mm, Euler XYZ degrees). Boards: board frame origin = lower-left corner of the outline, bottom copper at z=0. Also sets the exploded-view offset.',
    inputSchema: S.obj({ boardId: S.str(), partId: S.str(), position: S.vec3(), rotation: S.vec3(), explode: S.vec3('Exploded-view offset mm'), name: S.str() }, ['position']),
    handler: (ctx, a: { boardId?: string; partId?: string; position: Vec3; rotation?: Vec3; explode?: Vec3; name?: string }) => {
      const p = ctx.session.project;
      let target: AssemblyInstance['target'];
      let name: string;
      if (a.boardId) {
        const b = requireBoard(p, a.boardId);
        target = { kind: 'board', boardId: b.id };
        name = b.name;
      } else if (a.partId) {
        const m = requireMech(p, a.partId);
        target = { kind: 'mech', partId: m.id };
        name = m.name;
      } else throw new ToolError('Give boardId or partId');
      ctx.session.mutate(ctx, 'place_in_assembly', (pr) => {
        let inst = pr.assembly.instances.find((i) => (i.target.kind === 'board' && target.kind === 'board' && i.target.boardId === target.boardId) || (i.target.kind === 'mech' && target.kind === 'mech' && i.target.partId === target.partId));
        if (!inst) {
          inst = { id: newId('inst'), name: a.name ?? name, target, transform: { position: a.position, rotation: a.rotation ?? [0, 0, 0] } };
          pr.assembly.instances.push(inst);
        }
        inst.transform = { position: a.position, rotation: a.rotation ?? inst.transform.rotation };
        if (a.explode) inst.explode = a.explode;
        if (a.name) inst.name = a.name;
        return `Placed ${name} at (${a.position.join(', ')})`;
      });
      return `Placed ${name}.`;
    },
  },
  {
    name: 'add_fastener',
    title: 'Add fastener',
    group: 'assembly',
    description: 'Add a fastener (screw, insert, nut, standoff, washer) to the assembly at a position with an insertion direction (head → tip). `part` is a catalog id (list_fasteners) or LCSC/MPN. `joins` lists assembly instance ids clamped together.',
    inputSchema: S.obj({ part: S.str(), position: S.vec3(), direction: S.vec3(), joins: S.arr(S.str()), note: S.str(), count: S.int('Duplicate at extra positions given in `positions`'), positions: S.arr(S.vec3()) }, ['part', 'position']),
    handler: async (ctx, a: { part: string; position: Vec3; direction?: Vec3; joins?: string[]; note?: string; positions?: Vec3[] }) => {
      const part = await ensurePart(ctx, a.part);
      if (!part.fastener) throw new ToolError(`${part.mpn} has no fastener spec; define it with define_part {fastener: …}`);
      const all = [a.position, ...(a.positions ?? [])];
      ctx.session.mutate(ctx, 'add_fastener', (p) => {
        for (const pos of all) p.assembly.fasteners.push({ id: newId('fst'), partId: part.id, position: pos, direction: a.direction ?? [0, 0, -1], joins: a.joins ?? [], note: a.note });
        return `Added ${all.length}× ${part.mpn}`;
      });
      return `Added ${all.length}× ${part.mpn} (${part.fastener.type} ${part.fastener.thread ?? ''}).`;
    },
  },
  {
    name: 'run_dfm',
    title: 'DFM & assembly check',
    group: 'mechanical',
    description: 'Manufacturability checks for every mechanical part (injection molding: wall thickness, draft, ribs, bosses, undercuts, flow length, snap strain; sheet metal: bend radius, flange length, hole-to-edge/bend distances, reliefs, gauges) plus assembly checks (interference, boards inside enclosure, mounting holes on bosses, connector cut-out alignment, component height clearance, fastener engagement). Results are stored as issues.',
    inputSchema: S.obj({}),
    slow: true,
    handler: async (ctx) => {
      const issues = await runMechChecks(ctx);
      return `DFM/assembly results:\n${formatIssues(issues, 60)}`;
    },
  },
  {
    name: 'get_flat_pattern',
    title: 'Flat pattern',
    group: 'mechanical',
    description: 'Compute the sheet-metal flat pattern (blank size, bend lines with allowances) and save it as a DXF asset.',
    inputSchema: S.obj({ partId: S.str() }, ['partId']),
    handler: async (ctx, a: { partId: string }) => {
      const m = requireMech(ctx.session.project, a.partId);
      const r = await ctx.services.tasks.run<{ flat: { size: [number, number]; areaMm2: number; bendLines: { angle: number; radius: number; allowance: number; direction: string }[] }; dxf: string }>('mech.flat', { part: m }, { signal: ctx.signal });
      const assetId = `flat_${m.id}.dxf`;
      ctx.services.store.putAsset(ctx.session.id, assetId, r.dxf);
      return `Flat pattern of ${m.name}: ${r.flat.size[0].toFixed(2)} × ${r.flat.size[1].toFixed(2)} mm, area ${r.flat.areaMm2.toFixed(0)} mm². Bends: ${r.flat.bendLines.map((b) => `${b.angle}° ${b.direction} r${b.radius} BA ${b.allowance.toFixed(3)}`).join('; ')}. DXF: ${ctx.services.baseUrl()}/api/projects/${ctx.session.id}/assets/${assetId}`;
    },
  },
  {
    name: 'estimate_cost',
    title: 'Cost estimate',
    group: 'mechanical',
    description: 'Estimate product cost at the build quantity: electronic BOM (distributor price breaks), PCB fabrication rough cost, mechanical tooling (molds) and per-unit part cost, fasteners.',
    inputSchema: S.obj({ quantity: S.int() }),
    handler: async (ctx, a: { quantity?: number }) => {
      const { buildBom } = await import('../bom');
      const p = ctx.session.project;
      const qty = a.quantity ?? p.settings.buildQuantity;
      const bom = buildBom({ ...p, settings: { ...p.settings, buildQuantity: qty } });
      const mech = await ctx.services.tasks.run<{ name: string; toolingUsd: number; unitUsd: number; notes: string[] }[]>('mech.costs', { project: p, qty }, { signal: ctx.signal });
      const pcbArea = p.boards.reduce((s, b) => {
        const xs = b.outline.map((v) => v[0]);
        const ys = b.outline.map((v) => v[1]);
        return s + (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
      }, 0);
      const pcbUnit = p.boards.length ? 0.4 * p.boards.length + (pcbArea / 100) * 0.012 * (qty < 50 ? 3 : 1) : 0;
      const tooling = mech.reduce((s, m) => s + m.toolingUsd, 0);
      const mechUnit = mech.reduce((s, m) => s + m.unitUsd, 0);
      const unit = bom.total + pcbUnit + mechUnit;
      return [
        `Cost estimate @ ${qty} units:`,
        `Electronics BOM: $${bom.total.toFixed(2)}/unit (${bom.lines.length} lines${bom.unpriced ? `, ${bom.unpriced} unpriced` : ''})`,
        `PCB fabrication (rough): $${pcbUnit.toFixed(2)}/unit for ${pcbArea.toFixed(0)} mm² total`,
        ...mech.map((m) => `${m.name}: tooling $${m.toolingUsd.toFixed(0)}, $${m.unitUsd.toFixed(2)}/unit${m.notes.length ? ` (${m.notes.join('; ')})` : ''}`),
        `Total ≈ $${unit.toFixed(2)}/unit + $${tooling.toFixed(0)} one-time tooling ($${(unit + tooling / qty).toFixed(2)}/unit amortised).`,
        'Assembly labour, packaging and certification are not included.',
      ].join('\n');
    },
  },
];

export { runMechChecks };
