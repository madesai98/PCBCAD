/**
 * Electrical rule check on the board netlist (component pinNets + part pin types).
 */
import { parseValue, type Board, type ComponentInstance, type DesignIssue, type PartCategory, type PartDef, type PinType } from '@pcbcad/core';
import { isGroundNet } from './model';
import { UnionFind } from './spatial';

/** Part categories treated as ICs that need decoupling on their supply pins. */
export const IC_CATEGORIES: ReadonlySet<PartCategory> = new Set<PartCategory>([
  'mcu',
  'ic',
  'opamp',
  'comparator',
  'sensor',
  'memory',
  'logic',
  'driver',
  'interface',
  'rf-module',
  'ldo',
  'dc-dc',
]);

const CAP_CATEGORIES: ReadonlySet<PartCategory> = new Set<PartCategory>(['capacitor', 'capacitor-polarized']);
/** Parts whose pins can supply a net (any pin). */
const SOURCE_CATEGORIES: ReadonlySet<PartCategory> = new Set<PartCategory>(['connector', 'battery', 'cable', 'wire']);
/** Two-terminal parts that pass supply through (power reaches the other side). */
const PASS_CATEGORIES: ReadonlySet<PartCategory> = new Set<PartCategory>(['fuse', 'ferrite', 'inductor', 'switch', 'diode', 'schottky', 'relay', 'mosfet-p', 'mosfet-n']);

interface PinRef {
  comp: ComponentInstance;
  part?: PartDef;
  pin: string;
  type: PinType;
  name: string;
}

function pinInfo(part: PartDef | undefined, pin: string): { type: PinType; name: string } {
  const p = part?.pins?.find((x) => x.number === pin);
  return { type: p?.type ?? 'unspecified', name: p?.name ?? pin };
}

/** Run electrical rule checks on a board. */
export function runErc(board: Board, parts: Record<string, PartDef>): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const counters = new Map<string, number>();
  const add = (severity: DesignIssue['severity'], code: string, message: string, target: DesignIssue['target'], suggestion?: string) => {
    const n = (counters.get(code) ?? 0) + 1;
    counters.set(code, n);
    const issue: DesignIssue = { id: `erc-${code}-${n}`, severity, category: 'erc', code, message, target: { boardId: board.id, ...target } };
    if (suggestion) issue.suggestion = suggestion;
    issues.push(issue);
  };
  const netById = new Map(board.nets.map((n) => [n.id, n]));
  const netName = (id: string) => netById.get(id)?.name ?? id;
  const isGnd = (id: string) => isGroundNet(netById.get(id));

  // net -> member pins
  const members = new Map<string, PinRef[]>();
  for (const n of board.nets) members.set(n.id, []);
  for (const comp of board.components) {
    const part = parts[comp.partId];
    for (const [pin, netId] of Object.entries(comp.pinNets ?? {})) {
      if (!netId) continue;
      const info = pinInfo(part, pin);
      const list = members.get(netId) ?? [];
      list.push({ comp, part, pin, type: info.type, name: info.name });
      members.set(netId, list);
    }
  }

  /* ------------------------------------------ per-pin checks ------------------------------------------ */
  for (const comp of board.components) {
    const part = parts[comp.partId];
    if (!part) continue;
    for (const p of part.pins ?? []) {
      const netId = comp.pinNets?.[p.number];
      if (!netId) {
        if (p.type === 'power_in')
          add('error', 'unconnected-power-pin', `${comp.ref} power pin ${p.number} (${p.name}) is not connected`, { componentIds: [comp.id] }, 'Connect it to its supply or ground net.');
        else if (p.type === 'input')
          add('warning', 'floating-input', `${comp.ref} input pin ${p.number} (${p.name}) is not connected`, { componentIds: [comp.id] }, 'Tie unused inputs to a defined level (pull-up/down or supply).');
      } else if (p.type === 'nc') {
        add('warning', 'nc-connected', `${comp.ref} pin ${p.number} (${p.name}) is marked no-connect but is wired to ${netName(netId)}`, { componentIds: [comp.id], netIds: [netId] });
      }
    }
  }

  /* ------------------------------------------ per-net checks ------------------------------------------ */
  // supply propagation groups: nets joined through pass-through parts
  const netIds = [...members.keys()];
  const netIndex = new Map(netIds.map((id, i) => [id, i]));
  const uf = new UnionFind(netIds.length);
  for (const comp of board.components) {
    const part = parts[comp.partId];
    if (!part) continue;
    const nets = [...new Set(Object.values(comp.pinNets ?? {}).filter(Boolean))];
    if (nets.length !== 2) continue;
    let pass = PASS_CATEGORIES.has(part.category);
    if (!pass && part.category === 'resistor') {
      const ohms = parseValue(comp.value ?? part.value);
      pass = ohms !== undefined && ohms <= 1;
    }
    // never join a supply with ground (e.g. a clamp diode); ground-to-ground (ferrite to AGND) is fine
    if (pass && isGnd(nets[0]) === isGnd(nets[1]) && netIndex.has(nets[0]) && netIndex.has(nets[1])) uf.union(netIndex.get(nets[0])!, netIndex.get(nets[1])!);
  }
  const sourced = new Set<number>();
  for (const [netId, pins] of members) {
    if (pins.some((p) => isSourcePin(p))) sourced.add(uf.find(netIndex.get(netId)!));
  }

  for (const [netId, pins] of members) {
    const name = netName(netId);
    if (pins.length === 1) {
      const p = pins[0];
      add('warning', 'single-pin-net', `Net ${name} has only one pin (${p.comp.ref}.${p.pin})`, { netIds: [netId], componentIds: [p.comp.id] }, 'Connect it to something or remove the net.');
    }
    const drivers = pins.filter((p) => p.type === 'output' || p.type === 'power_out');
    if (drivers.length >= 2) {
      add(
        'error',
        'output-conflict',
        `Net ${name} is driven by ${drivers.length} outputs: ${drivers.map((d) => `${d.comp.ref}.${d.pin} (${d.name})`).join(', ')}`,
        { netIds: [netId], componentIds: [...new Set(drivers.map((d) => d.comp.id))] },
        'Only one push-pull or power output may drive a net; use open-drain outputs, a mux or separate nets.',
      );
    }
    const powerIn = pins.filter((p) => p.type === 'power_in');
    if (powerIn.length && !sourced.has(uf.find(netIndex.get(netId)!))) {
      add(
        'warning',
        'no-power-source',
        `Net ${name} feeds ${powerIn.length} power input pin(s) but has no power source (regulator output, connector, battery)`,
        { netIds: [netId], componentIds: [...new Set(powerIn.map((p) => p.comp.id))] },
        'Add a supply: connector, battery or regulator output on this net.',
      );
    }
    const inputs = pins.filter((p) => p.type === 'input');
    if (inputs.length >= 1 && inputs.length === pins.length && pins.length >= 2) {
      add('warning', 'floating-input', `Net ${name} connects only inputs (${inputs.map((p) => `${p.comp.ref}.${p.pin}`).join(', ')}); nothing drives it`, {
        netIds: [netId],
        componentIds: [...new Set(inputs.map((p) => p.comp.id))],
      });
    }
  }

  /* ---------------------------------------- decoupling capacitors ---------------------------------------- */
  const decoupled = new Set<string>();
  for (const comp of board.components) {
    const part = parts[comp.partId];
    if (!part || !CAP_CATEGORIES.has(part.category) || comp.dnp) continue;
    const nets = [...new Set(Object.values(comp.pinNets ?? {}).filter(Boolean))];
    if (nets.length < 2 || !nets.some(isGnd)) continue;
    for (const n of nets) if (!isGnd(n)) decoupled.add(n);
  }
  for (const comp of board.components) {
    const part = parts[comp.partId];
    if (!part || !IC_CATEGORIES.has(part.category)) continue;
    const missing = new Map<string, string[]>();
    for (const p of part.pins ?? []) {
      if (p.type !== 'power_in') continue;
      const netId = comp.pinNets?.[p.number];
      if (!netId || isGnd(netId) || decoupled.has(netId)) continue;
      const list = missing.get(netId) ?? [];
      list.push(`${p.number} (${p.name})`);
      missing.set(netId, list);
    }
    for (const [netId, list] of missing) {
      add(
        'warning',
        'missing-decoupling',
        `${comp.ref} supply pin${list.length > 1 ? 's' : ''} ${list.join(', ')} on ${netName(netId)} ha${list.length > 1 ? 've' : 's'} no decoupling capacitor to ground`,
        { componentIds: [comp.id], netIds: [netId] },
        'Add a 100 nF capacitor from this supply to GND next to the pin (plus bulk capacitance per datasheet).',
      );
    }
  }
  return issues;
}

function isSourcePin(p: PinRef): boolean {
  if (p.type === 'power_out') return true;
  const part = p.part;
  if (!part) return false;
  if (SOURCE_CATEGORIES.has(part.category)) return true;
  const sim = part.sim;
  if (sim) {
    if (sim.kind === 'vsource') return p.pin === sim.p || p.pin === sim.n;
    if (sim.kind === 'ldo' || sim.kind === 'buck') return p.pin === sim.out || p.pin === sim.gnd;
  }
  if ((part.category === 'ldo' || part.category === 'dc-dc') && /^(V?OUT|VO|SW|GND|VSS|PGND)\d*$/i.test(p.name.replace(/[^A-Za-z0-9]/g, ''))) return true;
  return false;
}
