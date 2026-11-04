/**
 * Minimal inline board / part builders for the thermal tests (deliberately independent of
 * @pcbcad/parts). Not exported from the package index.
 */
import type { Board, ComponentInstance, PadDef, PartDef, Project, Stackup, Trace, Vec2 } from '@pcbcad/core';

export function rectOutline(w: number, h: number, x0 = 0, y0 = 0): Vec2[] {
  return [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
  ];
}

export function makeBoard(w: number, h: number, opts: { layers?: 2 | 4 | 6; thickness?: number; outer?: number; inner?: number; id?: string } = {}): Board {
  const stackup: Stackup = {
    layers: opts.layers ?? 2,
    thickness: opts.thickness ?? 1.6,
    copperOz: { outer: opts.outer ?? 1, inner: opts.inner ?? 0.5 },
    dielectric: 'fr4',
    finish: 'ENIG',
    maskColor: 'green',
    silkColor: 'white',
  };
  return {
    id: opts.id ?? 'brd_test',
    name: 'Test board',
    outline: rectOutline(w, h),
    stackup,
    rules: {
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
    },
    components: [],
    nets: [],
    traces: [],
    vias: [],
    zones: [],
    holes: [],
  };
}

export function pad(number: string, x: number, y: number, w: number, h: number, extra: Partial<PadDef> = {}): PadDef {
  return { number, shape: 'rect', x, y, w, h, kind: 'smd', ...extra };
}

export function makePart(id: string, pads: PadDef[], extra: Partial<PartDef> = {}): PartDef {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pads) {
    minX = Math.min(minX, p.x - p.w / 2);
    maxX = Math.max(maxX, p.x + p.w / 2);
    minY = Math.min(minY, p.y - p.h / 2);
    maxY = Math.max(maxY, p.y + p.h / 2);
  }
  if (!pads.length) [minX, minY, maxX, maxY] = [-1, -1, 1, 1];
  const pins = [...new Set(pads.map((p) => p.number))].map((n) => ({ number: n, name: `P${n}`, type: 'passive' as const }));
  return {
    id,
    mpn: id.toUpperCase(),
    manufacturer: 'Test',
    description: 'test part',
    category: 'ic',
    package: 'custom',
    params: {},
    offers: [],
    pins,
    footprint: { name: id, pads, graphics: [], courtyard: { minX: minX - 0.25, minY: minY - 0.25, maxX: maxX + 0.25, maxY: maxY + 0.25 }, source: 'builtin' },
    provenance: { specs: 'builtin', symbol: 'builtin', footprint: 'builtin', model3d: 'missing', sim: 'missing', source: 'test' },
    ...extra,
  };
}

/** Two-terminal part with pads "1" (left) and "2" (right). */
export function twoPadPart(id: string, pitch = 3, padW = 1.2, padH = 1.6, extra: Partial<PartDef> = {}): PartDef {
  return makePart(id, [pad('1', -pitch / 2, 0, padW, padH), pad('2', pitch / 2, 0, padW, padH)], extra);
}

export function place(
  board: Board,
  c: Partial<ComponentInstance> & Pick<ComponentInstance, 'id' | 'partId' | 'x' | 'y'>,
): ComponentInstance {
  const inst: ComponentInstance = { ref: c.id.toUpperCase(), rotation: 0, side: 'top', placed: true, pinNets: {}, ...c };
  board.components.push(inst);
  for (const net of new Set(Object.values(inst.pinNets))) if (!board.nets.some((n) => n.id === net)) board.nets.push({ id: net, name: net.toUpperCase(), class: 'power' });
  return inst;
}

export function trace(id: string, netId: string, points: Vec2[], width: number, layer: Trace['layer'] = 'top'): Trace {
  return { id, netId, layer, width, points };
}

export function makeProject(boards: Board[], parts: PartDef[], ambientC = 25): Project {
  return {
    schemaVersion: 1,
    id: 'prj_test',
    name: 'test',
    description: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    revision: 0,
    requirements: [],
    parts: Object.fromEntries(parts.map((p) => [p.id, p])),
    boards,
    interconnects: [],
    mechanical: [],
    assembly: { instances: [], fasteners: [] },
    firmware: [],
    behaviors: [],
    simulations: [],
    issues: [],
    notes: [],
    activity: [],
    settings: { ambientC, currency: 'USD', buildQuantity: 1 },
  };
}
