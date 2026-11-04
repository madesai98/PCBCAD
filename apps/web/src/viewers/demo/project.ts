import type { Board, PartDef, Project } from '@pcbcad/core';
import { buildMainBoard, buildSatelliteBoard, buildStressBoard } from './boards';
import { demoParts } from './parts';

export interface DemoBoards {
  parts: Record<string, PartDef>;
  main: Board;
  sat: Board;
  stress: Board;
}

let cached: DemoBoards | null = null;

export function demoBoards(): DemoBoards {
  if (cached) return cached;
  const parts = demoParts();
  const main = buildMainBoard(parts);
  const sat = buildSatelliteBoard(parts);
  const stress = buildStressBoard(parts);
  cached = { parts, main, sat, stress };
  return cached;
}

export function emptyProject(): Project {
  const t = '2026-11-04T09:30:00.000Z';
  return {
    schemaVersion: 1,
    id: 'prj_demo',
    name: 'Env Node',
    description: '',
    createdAt: t,
    updatedAt: t,
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
