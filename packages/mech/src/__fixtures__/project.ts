/** Test fixtures: a 60×40 board with four M3 holes, a USB-C receptacle on the −Y edge and a few parts. */
import type { FastenerSpec, PartDef, Project } from '@pcbcad/core';
import { createBoard, createProject } from '@pcbcad/core';

const prov = { specs: 'builtin', symbol: 'builtin', footprint: 'builtin', model3d: 'builtin', sim: 'builtin', source: 'test' } as const;

export function partDef(id: string, extra: Partial<PartDef>): PartDef {
  return { id, mpn: id, manufacturer: 'test', description: id, category: 'other', package: '', params: {}, offers: [], pins: [], provenance: { ...prov }, ...extra };
}

export const USBC = partDef('C165948', {
  category: 'connector',
  description: 'USB-C receptacle',
  body: { w: 8.94, l: 7.3, h: 3.26 },
  connector: {
    family: 'USB-C',
    gender: 'female',
    role: 'board',
    positions: 16,
    matesWith: ['USB-C:male'],
    contactResistance: 0.04,
    currentRating: 3,
    matingDirection: '-y',
    opening: { width: 9.2, height: 3.6, zCenter: 1.63 },
  },
});

export const fastenerPart = (id: string, spec: FastenerSpec) => partDef(id, { category: 'fastener', fastener: spec });

/** Project with one board 'Main' (60 × 40 mm). Returns the project and the board id. */
export function boardProject(): { project: Project; boardId: string } {
  const project = createProject('fixture');
  const board = createBoard('Main', 60, 40, { cornerRadius: 1 });
  board.holes = [
    [3.5, 3.5],
    [56.5, 3.5],
    [56.5, 36.5],
    [3.5, 36.5],
  ].map(([x, y], i) => ({ id: `H${i + 1}`, x, y, drill: 3.2, plated: false }));
  const mcu = partDef('MCU', { category: 'mcu', body: { w: 7, l: 7, h: 1.0 } });
  const cap = partDef('CAP', { category: 'capacitor-polarized', body: { w: 6.6, l: 6.6, h: 7.7 } });
  const res = partDef('R0603', { category: 'resistor', body: { w: 1.6, l: 0.8, h: 0.45 } });
  project.parts = { [USBC.id]: USBC, MCU: mcu, CAP: cap, R0603: res };
  const comp = (id: string, ref: string, partId: string, x: number, y: number, rotation = 0, side: 'top' | 'bottom' = 'top') => ({ id, ref, partId, x, y, rotation, side, placed: true, pinNets: {} });
  board.components = [comp('c-j1', 'J1', USBC.id, 30, 2.5), comp('c-u1', 'U1', 'MCU', 30, 22), comp('c-c1', 'C1', 'CAP', 14, 26), comp('c-r1', 'R1', 'R0603', 45, 20)];
  project.boards.push(board);
  return { project, boardId: board.id };
}
