/**
 * Minimal helpers to build projects inline (tests, examples, agent tooling). Not a parts library:
 * parts are tiny PartDefs carrying just pins + a sim model.
 */
import { createBoard, createProject } from '@pcbcad/core';
import type { Board, ComponentInstance, NetClass, PartCategory, PartDef, PartSimModel, PinDef, Project } from '@pcbcad/core';

let seq = 0;
const uid = (p: string) => `${p}_${(++seq).toString(36)}`;

/** Create a PartDef with numbered pins ('1'..'n') or named pins. */
export function makePart(
  category: PartCategory,
  sim: PartSimModel | undefined,
  pins: (string | [string, string])[] = ['1', '2'],
  extra: Partial<PartDef> = {},
): PartDef {
  const pinDefs: PinDef[] = pins.map((p) => (Array.isArray(p) ? { number: p[0], name: p[1], type: 'passive' } : { number: p, name: p, type: 'passive' }));
  return {
    id: extra.id ?? uid(`part_${category}`),
    mpn: extra.mpn ?? category.toUpperCase(),
    manufacturer: 'test',
    description: extra.description ?? category,
    category,
    package: 'test',
    params: extra.params ?? {},
    offers: [],
    pins: pinDefs,
    sim,
    provenance: { specs: 'builtin', symbol: 'builtin', footprint: 'builtin', model3d: 'builtin', sim: 'builtin', source: 'test' },
    ...extra,
  };
}

export const P = {
  resistor: (R: number) => makePart('resistor', { kind: 'resistor', R }),
  capacitor: (C: number, esr?: number) => makePart('capacitor', { kind: 'capacitor', C, esr }),
  inductor: (L: number, dcr?: number) => makePart('inductor', { kind: 'inductor', L, dcr }),
  vsource: (V: number, Rint = 0) => makePart('battery', { kind: 'vsource', p: '1', n: '2', V, Rint }, [['1', '+'], ['2', '-']]),
  led: (Vf = 2.0, If = 0.02, color = 'red') => makePart('led', { kind: 'led', anode: '2', cathode: '1', Vf, If, color }, [['1', 'K'], ['2', 'A']]),
  diode: (Vf = 0.7, If = 0.01) => makePart('diode', { kind: 'diode', anode: '2', cathode: '1', Vf, If }, [['1', 'K'], ['2', 'A']]),
  zener: (Bv: number) => makePart('zener', { kind: 'diode', anode: '2', cathode: '1', Vf: 0.8, If: 0.01, Bv }, [['1', 'K'], ['2', 'A']]),
  nmos: (Vth = 2, Rds_on = 0.05, Vgs_rated = 10) =>
    makePart('mosfet-n', { kind: 'mosfet', polarity: 'n', g: '1', s: '2', d: '3', Vth, Rds_on, Vgs_rated }, [['1', 'G'], ['2', 'S'], ['3', 'D']]),
  pmos: (Vth = 2, Rds_on = 0.05, Vgs_rated = 10) =>
    makePart('mosfet-p', { kind: 'mosfet', polarity: 'p', g: '1', s: '2', d: '3', Vth, Rds_on, Vgs_rated }, [['1', 'G'], ['2', 'S'], ['3', 'D']]),
  npn: (beta = 100) => makePart('bjt-npn', { kind: 'bjt', polarity: 'npn', b: '1', e: '2', c: '3', beta }, [['1', 'B'], ['2', 'E'], ['3', 'C']]),
  pnp: (beta = 100) => makePart('bjt-pnp', { kind: 'bjt', polarity: 'pnp', b: '1', e: '2', c: '3', beta }, [['1', 'B'], ['2', 'E'], ['3', 'C']]),
  ldo: (Vout = 3.3, dropout = 0.3, Iq = 0.005, Imax = 1) =>
    makePart('ldo', { kind: 'ldo', gnd: '1', out: '2', in: '3', Vout, dropout, Iq, Imax }, [['1', 'GND'], ['2', 'VOUT'], ['3', 'VIN']]),
  buck: (Vout = 5, efficiency = 0.9, Iq = 0, Imax = 3) =>
    makePart('dc-dc', { kind: 'buck', in: '1', gnd: '2', out: '3', Vout, efficiency, Iq, Imax }, [['1', 'VIN'], ['2', 'GND'], ['3', 'VOUT']]),
  opamp: () =>
    makePart('opamp', { kind: 'opamp', out: '1', vn: '2', inp: '3', inn: '4', vp: '5' }, [['1', 'OUT'], ['2', 'V-'], ['3', '+IN'], ['4', '-IN'], ['5', 'V+']]),
  switch: (closed = false) => makePart('switch', { kind: 'switch', a: '1', b: '2', closed }),
  ic: (Icc: number) => makePart('ic', { kind: 'ic', supplyPins: ['1'], groundPins: ['2'], Icc }, [['1', 'VCC'], ['2', 'GND']]),
  connector: (n: number, contactResistance = 0.02, currentRating = 3) =>
    makePart('connector', { kind: 'connector' }, Array.from({ length: n }, (_, i) => String(i + 1)), {
      connector: { family: 'JST-PH', gender: 'male', role: 'board', positions: n, matesWith: ['JST-PH'], contactResistance, currentRating },
    }),
};

export class BoardKit {
  readonly board: Board;
  private readonly project: Project;
  constructor(project: Project, board: Board) {
    this.project = project;
    this.board = board;
  }
  /** Get or create a net by name (class guessed: GND → ground, VCC/3V3/... → power). */
  net(name: string, cls?: NetClass): string {
    const ex = this.board.nets.find((n) => n.name === name);
    if (ex) return ex.id;
    const c: NetClass = cls ?? (/^(GND|VSS|0V)$/i.test(name) ? 'ground' : /^(VCC|VDD|VIN|VBAT|VBUS|\+?\d+V\d*|3V3|5V)/i.test(name) ? 'power' : 'signal');
    const id = uid('net');
    this.board.nets.push({ id, name, class: c });
    return id;
  }
  /** Add a component; pins maps pin number → net name. */
  add(ref: string, part: PartDef, pins: Record<string, string>, extra: Partial<ComponentInstance> = {}): ComponentInstance {
    this.project.parts[part.id] = part;
    const pinNets: Record<string, string> = {};
    for (const [pin, net] of Object.entries(pins)) pinNets[pin] = this.net(net);
    const c: ComponentInstance = {
      id: uid(`cmp_${ref}`),
      ref,
      partId: part.id,
      x: 0,
      y: 0,
      rotation: 0,
      side: 'top',
      placed: true,
      pinNets,
      ...extra,
    };
    this.board.components.push(c);
    return c;
  }
}

export class ProjectKit {
  readonly project: Project;
  constructor(name = 'test') {
    this.project = createProject(name);
  }
  board(name = 'Main'): BoardKit {
    const b = createBoard(name, 50, 50);
    this.project.boards.push(b);
    return new BoardKit(this.project, b);
  }
}
