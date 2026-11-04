import {
  copperLayers,
  createBoard,
  guessNetClass,
  netMembers,
  newId,
  nextRef,
  parsePinRef,
  refPrefix,
  resolvePins,
  roundedRectPolygon,
  type Board,
  type ComponentInstance,
  type Net,
  type NetClass,
  type Project,
} from '@pcbcad/core';
import { runErc } from '@pcbcad/pcb';
import { partLabel, pinList, requireBoard, requireComponent, stagingPosition } from '../helpers';
import { S, ToolError, type ToolContext, type ToolDef } from '../registry';
import { ensurePart } from './parts';
import { formatIssues, setIssues } from './project';

const NET_CLASSES = ['signal', 'power', 'ground', 'high-speed', 'analog'] as const;

function getOrCreateNet(b: Board, name: string, cls?: NetClass): { net: Net; created: boolean } {
  const n = b.nets.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (n) {
    if (cls) n.class = cls;
    return { net: n, created: false };
  }
  const net: Net = { id: newId('net'), name, class: cls ?? guessNetClass(name) };
  b.nets.push(net);
  return { net, created: true };
}

/** Remove nets that have no pins, traces, vias or zones. */
export function pruneNets(b: Board) {
  const used = new Set<string>();
  for (const c of b.components) for (const n of Object.values(c.pinNets)) used.add(n);
  for (const t of b.traces) used.add(t.netId);
  for (const v of b.vias) used.add(v.netId);
  for (const z of b.zones) used.add(z.netId);
  b.nets = b.nets.filter((n) => used.has(n.id));
}

interface ConnectResult {
  connected: string[];
  moved: string[];
  errors: string[];
}

function connectPins(p: Project, b: Board, net: Net, pinRefs: string[]): ConnectResult {
  const out: ConnectResult = { connected: [], moved: [], errors: [] };
  for (const raw of pinRefs) {
    let ref: string, pin: string;
    try {
      ({ ref, pin } = parsePinRef(raw));
    } catch (e) {
      out.errors.push((e as Error).message);
      continue;
    }
    const c = b.components.find((x) => x.ref.toLowerCase() === ref.toLowerCase());
    if (!c) {
      out.errors.push(`${raw}: no component ${ref} on ${b.name}`);
      continue;
    }
    const part = p.parts[c.partId];
    if (!part) {
      out.errors.push(`${raw}: part ${c.partId} missing from library`);
      continue;
    }
    const nums = resolvePins(part, pin);
    if (!nums.length) {
      out.errors.push(`${raw}: ${part.mpn} has no pin '${pin}'. Pins: ${pinList(part, 64)}`);
      continue;
    }
    for (const num of nums) {
      const prev = c.pinNets[num];
      if (prev && prev !== net.id) {
        const pn = b.nets.find((n) => n.id === prev)?.name ?? prev;
        out.moved.push(`${c.ref}.${num} (${pn}→${net.name})`);
      }
      c.pinNets[num] = net.id;
      out.connected.push(`${c.ref}.${num}`);
    }
  }
  return out;
}

export function netlistText(p: Project, b: Board): string {
  const members = netMembers(b);
  const lines = [`Netlist of ${b.name} (${b.nets.length} nets):`];
  for (const n of b.nets) {
    const m = members.get(n.id) ?? [];
    lines.push(`${n.name} [${n.class}${n.traceWidth ? `, ${n.traceWidth} mm` : ''}]: ${m.map((x) => `${x.ref}.${x.pin}`).join(' ') || '(no pins)'}`);
  }
  const unconnected: string[] = [];
  for (const c of b.components) {
    const part = p.parts[c.partId];
    if (!part) continue;
    const free = part.pins.filter((pin) => !c.pinNets[pin.number] && pin.type !== 'nc').map((pin) => `${pin.number}:${pin.name}`);
    if (free.length) unconnected.push(`${c.ref}: ${free.join(', ')}`);
  }
  if (unconnected.length) lines.push(`Unconnected pins:\n  ${unconnected.join('\n  ')}`);
  return lines.join('\n');
}

function applyOutline(b: Board, width: number, height: number, cornerRadius: number) {
  b.outline = roundedRectPolygon(0, 0, width, height, cornerRadius, 6);
  b.outlineSpec = { kind: 'rect', width, height, cornerRadius };
}

export const schematicTools: ToolDef[] = [
  {
    name: 'create_board',
    title: 'Create board',
    group: 'schematic',
    description:
      'Create a new PCB (rectangular outline with rounded corners; origin at the lower-left corner, X right, Y up, mm). A product may have several boards connected with connect_boards. Default stack-up: 2 layers, 1.6 mm FR-4, 1 oz copper, green mask, LF-HASL; default rules are JLCPCB-safe (0.2 mm clearance, 0.25 mm traces, 0.3/0.6 mm vias).',
    inputSchema: S.obj(
      {
        name: S.str(),
        width: S.num('mm (X)'),
        height: S.num('mm (Y)'),
        cornerRadius: S.num('mm, default 1'),
        layers: S.int('2, 4 or 6'),
        thickness: S.num('mm, default 1.6'),
        description: S.str(),
        maskColor: S.enum(['green', 'black', 'blue', 'red', 'white', 'purple', 'yellow']),
        finish: S.enum(['HASL', 'LF-HASL', 'ENIG', 'OSP']),
      },
      ['name', 'width', 'height'],
    ),
    handler: (ctx, a: { name: string; width: number; height: number; cornerRadius?: number; layers?: 2 | 4 | 6; thickness?: number; description?: string; maskColor?: Board['stackup']['maskColor']; finish?: Board['stackup']['finish'] }) => {
      if (a.width <= 2 || a.height <= 2 || a.width > 600 || a.height > 600) throw new ToolError('Board dimensions must be between 2 and 600 mm');
      const b = createBoard(a.name, a.width, a.height, { cornerRadius: a.cornerRadius, layers: a.layers, thickness: a.thickness, description: a.description });
      if (a.maskColor) b.stackup.maskColor = a.maskColor;
      if (a.finish) b.stackup.finish = a.finish;
      ctx.session.mutate(ctx, 'create_board', (p) => {
        p.boards.push(b);
        return `Created board ${b.name} ${a.width}×${a.height} mm, ${b.stackup.layers} layers`;
      });
      return { text: `Board created: ${b.name} [${b.id}] ${a.width}×${a.height} mm, ${b.stackup.layers}-layer, ${b.stackup.thickness} mm.`, data: { boardId: b.id } };
    },
  },
  {
    name: 'update_board',
    title: 'Update board',
    group: 'schematic',
    description: 'Change a board: name, rectangular size/corner radius or a custom outline polygon, stack-up (layers, thickness, copper weight, finish, colours) and design rules.',
    inputSchema: S.obj(
      {
        boardId: S.str(),
        name: S.str(),
        width: S.num(),
        height: S.num(),
        cornerRadius: S.num(),
        outline: S.arr(S.vec2(), 'Custom outline polygon (mm, CCW)'),
        layers: S.int(),
        thickness: S.num(),
        copperOzOuter: S.num(),
        copperOzInner: S.num(),
        finish: S.enum(['HASL', 'LF-HASL', 'ENIG', 'OSP']),
        maskColor: S.enum(['green', 'black', 'blue', 'red', 'white', 'purple', 'yellow']),
        silkColor: S.enum(['white', 'black']),
        rules: S.obj({ clearance: S.num(), traceWidth: S.num(), powerTraceWidth: S.num(), minTraceWidth: S.num(), viaDrill: S.num(), viaDiameter: S.num(), edgeClearance: S.num(), routingGrid: S.num() }),
      },
      ['boardId'],
    ),
    handler: (ctx, a: any) => {
      const b = requireBoard(ctx.session.project, a.boardId);
      ctx.session.mutate(ctx, 'update_board', () => {
        if (a.name) b.name = a.name;
        if (a.outline?.length >= 3) {
          b.outline = a.outline;
          b.outlineSpec = undefined;
        } else if (a.width || a.height || a.cornerRadius != null) {
          const spec = b.outlineSpec ?? { kind: 'rect' as const, width: 50, height: 50, cornerRadius: 1 };
          applyOutline(b, a.width ?? spec.width, a.height ?? spec.height, a.cornerRadius ?? spec.cornerRadius);
        }
        if (a.layers) b.stackup.layers = a.layers;
        if (a.thickness) b.stackup.thickness = a.thickness;
        if (a.copperOzOuter) b.stackup.copperOz.outer = a.copperOzOuter;
        if (a.copperOzInner) b.stackup.copperOz.inner = a.copperOzInner;
        if (a.finish) b.stackup.finish = a.finish;
        if (a.maskColor) b.stackup.maskColor = a.maskColor;
        if (a.silkColor) b.stackup.silkColor = a.silkColor;
        if (a.rules) Object.assign(b.rules, a.rules);
        return `Updated board ${b.name}`;
      });
      return `Board ${b.name} updated. Layers: ${copperLayers(b.stackup).join(', ')}. Rules: ${JSON.stringify(b.rules)}`;
    },
  },
  {
    name: 'add_components',
    title: 'Add components',
    group: 'schematic',
    description:
      'Place one or more parts on a board as components. `part` is an LCSC code, MPN or library part id — parts not yet in the library are imported automatically. Reference designators are assigned automatically (R1, C3, U2…) unless given. Components without x/y are left unplaced in the staging area beside the board (use auto_place later). Returns refs and pin lists.',
    inputSchema: S.obj(
      {
        boardId: S.str(),
        components: S.arr(
          S.obj(
            {
              part: S.str('LCSC code / MPN / part id'),
              ref: S.str(),
              value: S.str('Display value override, e.g. "10k"'),
              x: S.num('mm'),
              y: S.num('mm'),
              rotation: S.num('deg CCW'),
              side: S.enum(['top', 'bottom']),
              group: S.str('Schematic group / functional block name, e.g. "power", "mcu", "sensor"'),
            },
            ['part'],
          ),
        ),
      },
      ['boardId', 'components'],
    ),
    handler: async (ctx: ToolContext, a: { boardId: string; components: { part: string; ref?: string; value?: string; x?: number; y?: number; rotation?: number; side?: 'top' | 'bottom'; group?: string }[] }) => {
      const b0 = requireBoard(ctx.session.project, a.boardId);
      const lines: string[] = [];
      for (const spec of a.components) {
        const part = await ensurePart(ctx, spec.part);
        const b = requireBoard(ctx.session.project, b0.id);
        const ref = spec.ref ?? nextRef(b, refPrefix(part.category));
        if (b.components.some((c) => c.ref.toLowerCase() === ref.toLowerCase())) throw new ToolError(`Reference ${ref} already exists on ${b.name}`);
        const placed = spec.x != null && spec.y != null;
        const pos = placed ? { x: spec.x!, y: spec.y! } : stagingPosition(b);
        const comp: ComponentInstance = {
          id: newId('cmp'),
          ref,
          partId: part.id,
          value: spec.value ?? part.value,
          x: pos.x,
          y: pos.y,
          rotation: spec.rotation ?? 0,
          side: spec.side ?? 'top',
          placed,
          pinNets: {},
          // the functional group is a layout hint, not a schematic position (explicit positions
          // pin the symbol; leaving them unset lets the schematic auto-layout place it)
          fields: spec.group ? { group: spec.group } : undefined,
        };
        ctx.session.mutate(ctx, 'add_component', () => {
          b.components.push(comp);
          return `Added ${ref} ${partLabel(part)} to ${b.name}`;
        });
        lines.push(`${ref} = ${partLabel(part)} ${placed ? `at (${pos.x}, ${pos.y})` : '(unplaced)'} — pins: ${pinList(part, 64)}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'update_component',
    title: 'Update component',
    group: 'schematic',
    description: 'Modify a component instance: value, position/rotation/side, lock, DNP, reference, schematic position, free-form fields, or simulation overrides (e.g. {"closed":true} for a switch, {"V":3.7} for a battery, waveform {"waveform":"pulse",...}).',
    inputSchema: S.obj(
      {
        boardId: S.str(),
        ref: S.str(),
        newRef: S.str(),
        value: S.str(),
        part: S.str('Swap to another part (LCSC/MPN/id); pin numbers keep their nets'),
        x: S.num(),
        y: S.num(),
        rotation: S.num(),
        side: S.enum(['top', 'bottom']),
        locked: S.bool(),
        dnp: S.bool(),
        fields: S.any('{key: value}'),
        simOverrides: S.any('{param: value}'),
        schematic: S.obj({ x: S.num(), y: S.num(), rotation: S.num(), group: S.str() }),
      },
      ['boardId', 'ref'],
    ),
    handler: async (ctx, a: any) => {
      const b = requireBoard(ctx.session.project, a.boardId);
      const c = requireComponent(b, a.ref);
      const newPart = a.part ? await ensurePart(ctx, a.part) : null;
      ctx.session.mutate(ctx, 'update_component', () => {
        if (a.newRef) {
          if (b.components.some((x) => x !== c && x.ref.toLowerCase() === a.newRef.toLowerCase())) throw new ToolError(`Ref ${a.newRef} exists`);
          c.ref = a.newRef;
        }
        if (newPart) {
          c.partId = newPart.id;
          if (!a.value) c.value = newPart.value;
        }
        if (a.value != null) c.value = a.value;
        if (a.x != null) c.x = a.x;
        if (a.y != null) c.y = a.y;
        if (a.x != null && a.y != null) c.placed = true;
        if (a.rotation != null) c.rotation = a.rotation;
        if (a.side) c.side = a.side;
        if (a.locked != null) c.locked = a.locked;
        if (a.dnp != null) c.dnp = a.dnp;
        if (a.fields) c.fields = { ...c.fields, ...a.fields };
        if (a.simOverrides) c.simOverrides = { ...c.simOverrides, ...a.simOverrides };
        if (a.schematic) {
          const { group, ...pos } = a.schematic as { x?: number; y?: number; rotation?: number; group?: string };
          if (group) c.fields = { ...c.fields, group };
          if (pos.x != null && pos.y != null) c.schematic = { ...c.schematic, x: pos.x, y: pos.y, ...(pos.rotation != null ? { rotation: pos.rotation } : {}) };
        }
        return `Updated ${c.ref} on ${b.name}`;
      });
      return `Updated ${c.ref}: ${c.value ?? ''} at (${c.x.toFixed(2)}, ${c.y.toFixed(2)}) rot ${c.rotation}° ${c.side}${c.dnp ? ' DNP' : ''}${c.locked ? ' locked' : ''}.`;
    },
  },
  {
    name: 'set_external_supply',
    title: 'External power input',
    group: 'schematic',
    description:
      'Declare power that enters the product from outside through a component pin — a USB charger on a USB-C VBUS pin, a bench/wall supply on a barrel jack, a field supply on a terminal block, a battery on a JST connector. Circuit, thermal, airflow and firmware simulations use it as a voltage source with internal resistance. Without one, a board powered only through connectors has no source and simulates at 0 V. Pass an empty list to remove.',
    inputSchema: S.obj(
      {
        boardId: S.str(),
        ref: S.str('Component (usually a connector), e.g. J1'),
        supplies: S.arr(
          S.obj(
            {
              pin: S.str('Pin number or name, e.g. "VBUS"'),
              V: S.num('Open-circuit voltage'),
              Rint: S.num('Source resistance Ω (default 0.05)'),
              Imax: S.num('Source current limit A'),
              groundPin: S.str('Return pin (default board ground)'),
              name: S.str('e.g. "USB-C charger 5 V"'),
            },
            ['pin', 'V'],
          ),
        ),
      },
      ['boardId', 'ref', 'supplies'],
    ),
    handler: (ctx, a: { boardId: string; ref: string; supplies: { pin: string; V: number; Rint?: number; Imax?: number; groundPin?: string; name?: string }[] }) => {
      const p = ctx.session.project;
      const b = requireBoard(p, a.boardId);
      const c = requireComponent(b, a.ref);
      const part = p.parts[c.partId];
      for (const s of a.supplies) {
        const pins = part ? resolvePins(part, s.pin) : [];
        if (!pins.length) throw new ToolError(`${c.ref} has no pin '${s.pin}'. Pins: ${part ? pinList(part, 64) : '?'}`);
        if (!pins.some((pn) => c.pinNets[pn])) throw new ToolError(`${c.ref}.${s.pin} is not connected to a net yet — connect it first`);
      }
      ctx.session.mutate(ctx, 'set_external_supply', () => {
        c.supplies = a.supplies.length ? a.supplies : undefined;
        return a.supplies.length ? `${c.ref}: external supply ${a.supplies.map((s) => `${s.pin} = ${s.V} V`).join(', ')}` : `${c.ref}: external supply removed`;
      });
      return a.supplies.length
        ? `${b.name}:${c.ref} now supplies ${a.supplies.map((s) => `${s.name ? `${s.name}: ` : ''}${s.pin} = ${s.V} V (Rint ${s.Rint ?? 0.05} Ω${s.Imax ? `, ${s.Imax} A max` : ''})`).join('; ')}.`
        : `Removed external supplies from ${c.ref}.`;
    },
  },
  {
    name: 'remove_components',
    title: 'Remove components',
    group: 'schematic',
    description: 'Delete components from a board (their pin connections are removed; empty nets are pruned).',
    inputSchema: S.obj({ boardId: S.str(), refs: S.arr(S.str()) }, ['boardId', 'refs']),
    handler: (ctx, a: { boardId: string; refs: string[] }) => {
      const b = requireBoard(ctx.session.project, a.boardId);
      const ids = new Set(a.refs.map((r) => requireComponent(b, r).id));
      ctx.session.mutate(ctx, 'remove_components', (p) => {
        b.components = b.components.filter((c) => !ids.has(c.id));
        pruneNets(b);
        p.interconnects = p.interconnects.filter((ic) => !ids.has(ic.a.componentId) && !ids.has(ic.b.componentId));
        return `Removed ${a.refs.join(', ')} from ${b.name}`;
      });
      return `Removed ${a.refs.join(', ')}.`;
    },
  },
  {
    name: 'connect',
    title: 'Connect nets',
    group: 'schematic',
    description:
      'Wire the schematic: assign component pins to named nets. Pins are "REF.PIN" where PIN is a pin number or name (e.g. "U1.VCC" connects every pin named VCC, "R3.1", "J1.VBUS"). Nets are created on demand; class is inferred from the name (GND→ground, 3V3/5V/VBUS/VIN→power) unless given. A pin already on another net is moved. Batch many nets in one call.',
    inputSchema: S.obj(
      {
        boardId: S.str(),
        nets: S.arr(S.obj({ net: S.str('Net name, e.g. GND, 3V3, I2C_SDA'), pins: S.arr(S.str()), class: S.enum(NET_CLASSES), traceWidth: S.num('mm') }, ['net', 'pins'])),
      },
      ['boardId', 'nets'],
    ),
    handler: (ctx, a: { boardId: string; nets: { net: string; pins: string[]; class?: NetClass; traceWidth?: number }[] }) => {
      const p = ctx.session.project;
      const b = requireBoard(p, a.boardId);
      const lines: string[] = [];
      let errors = 0;
      ctx.session.mutate(ctx, 'connect', () => {
        const summary: string[] = [];
        for (const n of a.nets) {
          const { net, created } = getOrCreateNet(b, n.net, n.class);
          if (n.traceWidth) net.traceWidth = n.traceWidth;
          const r = connectPins(p, b, net, n.pins);
          errors += r.errors.length;
          lines.push(`${net.name}${created ? ' (new)' : ''}: ${r.connected.join(' ') || '—'}${r.moved.length ? ` | moved: ${r.moved.join(', ')}` : ''}${r.errors.length ? `\n  ✗ ${r.errors.join('\n  ✗ ')}` : ''}`);
          if (r.connected.length) summary.push(`${net.name}(${r.connected.length})`);
        }
        pruneNets(b);
        return summary.length ? `Connected ${summary.join(', ')} on ${b.name}` : null;
      });
      return { text: lines.join('\n'), isError: errors > 0 && lines.every((l) => l.includes('✗')) };
    },
  },
  {
    name: 'disconnect',
    title: 'Disconnect pins',
    group: 'schematic',
    description: 'Remove pins from their nets ("REF.PIN" list).',
    inputSchema: S.obj({ boardId: S.str(), pins: S.arr(S.str()) }, ['boardId', 'pins']),
    handler: (ctx, a: { boardId: string; pins: string[] }) => {
      const p = ctx.session.project;
      const b = requireBoard(p, a.boardId);
      const done: string[] = [];
      ctx.session.mutate(ctx, 'disconnect', () => {
        for (const raw of a.pins) {
          const { ref, pin } = parsePinRef(raw);
          const c = requireComponent(b, ref);
          const part = p.parts[c.partId];
          for (const num of part ? resolvePins(part, pin) : [pin]) {
            if (c.pinNets[num]) {
              delete c.pinNets[num];
              done.push(`${c.ref}.${num}`);
            }
          }
        }
        pruneNets(b);
        return done.length ? `Disconnected ${done.join(', ')}` : null;
      });
      return done.length ? `Disconnected ${done.join(', ')}.` : 'Nothing to disconnect.';
    },
  },
  {
    name: 'set_net',
    title: 'Set net properties',
    group: 'schematic',
    description: 'Rename a net or set its class (signal/power/ground/high-speed/analog) and trace width.',
    inputSchema: S.obj({ boardId: S.str(), net: S.str(), newName: S.str(), class: S.enum(NET_CLASSES), traceWidth: S.num() }, ['boardId', 'net']),
    handler: (ctx, a: { boardId: string; net: string; newName?: string; class?: NetClass; traceWidth?: number }) => {
      const b = requireBoard(ctx.session.project, a.boardId);
      const n = b.nets.find((x) => x.id === a.net || x.name.toLowerCase() === a.net.toLowerCase());
      if (!n) throw new ToolError(`Net ${a.net} not found. Nets: ${b.nets.map((x) => x.name).join(', ')}`);
      ctx.session.mutate(ctx, 'set_net', () => {
        if (a.newName) n.name = a.newName;
        if (a.class) n.class = a.class;
        if (a.traceWidth) n.traceWidth = a.traceWidth;
        return `Net ${n.name} updated`;
      });
      return `Net ${n.name}: class ${n.class}${n.traceWidth ? `, width ${n.traceWidth} mm` : ''}.`;
    },
  },
  {
    name: 'get_netlist',
    title: 'Netlist',
    group: 'schematic',
    description: 'List every net with its member pins, plus unconnected component pins.',
    inputSchema: S.obj({ boardId: S.str() }, ['boardId']),
    handler: (ctx, a: { boardId: string }) => netlistText(ctx.session.project, requireBoard(ctx.session.project, a.boardId)),
  },
  {
    name: 'run_erc',
    title: 'Electrical rules check',
    group: 'schematic',
    description: 'Electrical rule check: single-pin nets, unconnected power pins, output conflicts, power nets without a source, missing decoupling capacitors, floating inputs. Results are stored as issues.',
    inputSchema: S.obj({ boardId: S.str() }, ['boardId']),
    handler: (ctx, a: { boardId: string }) => {
      const b = requireBoard(ctx.session.project, a.boardId);
      const issues = runErc(b, ctx.session.project.parts).map((i) => ({ ...i, target: { ...i.target, boardId: b.id } }));
      ctx.session.mutate(ctx, 'run_erc', (p) => {
        setIssues(p, ['erc'], issues, { boardId: b.id });
        return `ERC ${b.name}: ${issues.filter((i) => i.severity === 'error').length} errors, ${issues.filter((i) => i.severity === 'warning').length} warnings`;
      });
      return `ERC for ${b.name}:\n${formatIssues(issues)}`;
    },
  },
];
