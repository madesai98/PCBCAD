import type { Board, DesignRules, Stackup } from './types/board';
import type { Project } from './types/project';
import { newId, nowIso } from './ids';
import { roundedRectPolygon } from './geometry';

export const DEFAULT_STACKUP: Stackup = {
  layers: 2,
  thickness: 1.6,
  copperOz: { outer: 1, inner: 0.5 },
  dielectric: 'fr4',
  finish: 'LF-HASL',
  maskColor: 'green',
  silkColor: 'white',
};

/** Conservative rules that every mainstream fab (JLCPCB, PCBWay, OSH Park) can build. */
export const DEFAULT_RULES: DesignRules = {
  clearance: 0.2,
  traceWidth: 0.25,
  powerTraceWidth: 0.5,
  minTraceWidth: 0.15,
  viaDrill: 0.3,
  viaDiameter: 0.6,
  edgeClearance: 0.4,
  minDrill: 0.3,
  minAnnularRing: 0.13,
  routingGrid: 0.25,
};

export function createProject(name: string, description = ''): Project {
  const t = nowIso();
  return {
    schemaVersion: 1,
    id: newId('prj'),
    name,
    description,
    createdAt: t,
    updatedAt: t,
    revision: 0,
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
    settings: { ambientC: 25, currency: 'USD', buildQuantity: 100 },
  };
}

export function createBoard(
  name: string,
  width: number,
  height: number,
  opts: { cornerRadius?: number; layers?: 2 | 4 | 6; thickness?: number; description?: string } = {},
): Board {
  const cornerRadius = opts.cornerRadius ?? 1;
  return {
    id: newId('brd'),
    name,
    description: opts.description,
    outline: roundedRectPolygon(0, 0, width, height, cornerRadius, 6),
    outlineSpec: { kind: 'rect', width, height, cornerRadius },
    stackup: { ...DEFAULT_STACKUP, layers: opts.layers ?? 2, thickness: opts.thickness ?? 1.6, copperOz: { ...DEFAULT_STACKUP.copperOz } },
    rules: { ...DEFAULT_RULES },
    components: [],
    nets: [],
    traces: [],
    vias: [],
    zones: [],
    holes: [],
  };
}

/** Copper layer names present for a stackup, outer first. */
export function copperLayers(stackup: Stackup): ('top' | 'bottom' | 'in1' | 'in2' | 'in3' | 'in4')[] {
  if (stackup.layers === 6) return ['top', 'in1', 'in2', 'in3', 'in4', 'bottom'];
  if (stackup.layers === 4) return ['top', 'in1', 'in2', 'bottom'];
  return ['top', 'bottom'];
}
