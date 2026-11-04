import type {
  AirflowResult,
  Board,
  CircuitTransientResult,
  ComponentInstance,
  DesignIssue,
  MeshData,
  MixedSignalResult,
  Net,
  PartDef,
  PcbThermalResult,
  Project,
  SimSummary,
  StructuralResult,
} from '@pcbcad/core';
import { DEFAULT_RULES, DEFAULT_STACKUP, roundedRectPolygon } from '@pcbcad/core';
import { buildMainBoard, buildSatelliteBoard, buildStressBoard } from './boards';
import { demoAssembly, demoFastenerParts, demoMech, makeDemoMeshLoader } from './mech';
import { demoParts, symbolSamplerParts } from './parts';
import { demoAirflow, demoIssues, demoMixed, demoStructural, demoSummary, demoThermal, demoTransient } from './sims';

export interface DemoData {
  project: Project;
  parts: Record<string, PartDef>;
  main: Board;
  sat: Board;
  stress: Board;
  thermal: PcbThermalResult;
  structural: StructuralResult;
  airflow: AirflowResult;
  transient: CircuitTransientResult;
  mixed: MixedSignalResult;
  issues: DesignIssue[];
  summary: SimSummary;
  getMesh: (key: string) => Promise<MeshData | null>;
  sampler: Project;
}

let cached: DemoData | null = null;

const T0 = '2026-11-04T09:30:00.000Z';

export function emptyProject(name = 'Env Node'): Project {
  return {
    schemaVersion: 1,
    id: 'prj_demo',
    name,
    description: '',
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
    requirements: [],
    parts: {},
    boards: [],
    interconnects: [],
    mechanical: [],
    assembly: { instances: [], fasteners: [] },
    firmware: [],
    behaviors: [],
    simulations: [],
    issues: [],
    notes: [],
    activity: [],
    settings: { ambientC: 25, currency: 'USD', buildQuantity: 500 },
  };
}

function samplerProject(): Project {
  const parts = symbolSamplerParts();
  const nets: Net[] = [
    { id: 's_vcc', name: 'VCC', class: 'power' },
    { id: 's_gnd', name: 'GND', class: 'ground' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `s_n${i}`, name: `N${i + 1}`, class: (i % 7 === 3 ? 'analog' : i % 9 === 5 ? 'high-speed' : 'signal') as Net['class'] })),
  ];
  const comps: ComponentInstance[] = [];
  const cols = 8;
  parts.forEach((p, i) => {
    const pinNets: Record<string, string> = {};
    const n = (k: number) => `s_n${(i * 2 + k) % 30}`;
    if (p.pins.length === 2) {
      pinNets['1'] = i % 4 === 0 ? 's_vcc' : n(0);
      pinNets['2'] = i % 3 === 0 ? 's_gnd' : n(1);
    } else if (p.pins.length === 3) {
      pinNets['1'] = n(0);
      pinNets['2'] = p.category.endsWith('p') || p.category === 'bjt-pnp' ? 's_vcc' : 's_gnd';
      pinNets['3'] = n(1);
    } else {
      for (const pin of p.pins) pinNets[pin.number] = /VDD|VCC/.test(pin.name) ? 's_vcc' : /VSS|GND/.test(pin.name) ? 's_gnd' : n(Number(pin.number));
    }
    const prefix = p.category === 'connector' ? 'J' : p.category.startsWith('bjt') || p.category.startsWith('mosfet') ? 'Q' : p.category === 'opamp' ? 'U' : p.category === 'resistor' ? 'R' : p.category.startsWith('capacitor') ? 'C' : p.category === 'inductor' ? 'L' : p.category === 'ferrite' ? 'FB' : p.category === 'crystal' ? 'Y' : p.category === 'fuse' ? 'F' : p.category === 'battery' ? 'BT' : p.category === 'buzzer' ? 'BZ' : p.category === 'switch' || p.category === 'button' ? 'SW' : 'D';
    const col = i % cols;
    const row = Math.floor(i / cols);
    comps.push({
      id: `s_c${i}`,
      ref: `${prefix}${i + 1}`,
      partId: p.id,
      x: 0,
      y: 0,
      rotation: 0,
      side: 'top',
      placed: false,
      pinNets,
      schematic: { x: col * 30.48, y: row * 33.02 + (p.pins.length > 3 ? 5.08 : 0) },
    });
  });
  const board: Board = {
    id: 'brd_sampler',
    name: 'Symbol library',
    outline: roundedRectPolygon(0, 0, 50, 30, 1, 4),
    stackup: { ...DEFAULT_STACKUP, copperOz: { ...DEFAULT_STACKUP.copperOz } },
    rules: { ...DEFAULT_RULES },
    components: comps,
    nets,
    traces: [],
    vias: [],
    zones: [],
    holes: [],
  };
  return { ...emptyProject('Symbol library'), id: 'prj_sampler', parts: Object.fromEntries(parts.map((p) => [p.id, p])), boards: [board] };
}

export function demoData(): DemoData {
  if (cached) return cached;
  const parts = demoParts();
  for (const f of demoFastenerParts()) parts[f.id] = f;
  const main = buildMainBoard(parts);
  const sat = buildSatelliteBoard(parts);
  const stress = buildStressBoard(parts);
  const mech = demoMech();
  const thermal = demoThermal(main);
  const issues = demoIssues(main);
  const project: Project = {
    ...emptyProject(),
    description: 'Battery-free USB-C environmental sensor node with remote temperature probe.',
    revision: 42,
    requirements: ['USB-C powered (5 V, ≤ 500 mA)', 'Temperature / humidity / pressure logging', 'Wall-mountable enclosure, IP30'],
    parts,
    boards: [main, sat],
    interconnects: [
      {
        id: 'ic_probe',
        name: 'Probe cable',
        kind: 'cable',
        a: { boardId: main.id, componentId: 'cmp_main_j2' },
        b: { boardId: sat.id, componentId: 'cmp_sat_j1' },
        length: 150,
        awg: 28,
        conductors: ['1', '2', '3', '4'].map((pin) => ({ id: `cd_${pin}`, from: { boardId: main.id, componentId: 'cmp_main_j2', pin }, to: { boardId: sat.id, componentId: 'cmp_sat_j1', pin } })),
      },
    ],
    mechanical: mech,
    assembly: demoAssembly(),
    issues,
  };
  cached = {
    project,
    parts,
    main,
    sat,
    stress,
    thermal,
    structural: demoStructural(),
    airflow: demoAirflow(),
    transient: demoTransient(main),
    mixed: demoMixed(main),
    issues,
    summary: demoSummary(thermal),
    getMesh: makeDemoMeshLoader(mech),
    sampler: samplerProject(),
  };
  return cached;
}
