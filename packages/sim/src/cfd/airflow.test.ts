import { describe, expect, it } from 'vitest';
import { toFloat32, toUint8 } from '@pcbcad/core';
import type { EffectiveMaterial } from '@pcbcad/core';
import { airProperties, solveAirflow } from './airflow';
import { makeGrid, testMaterial } from '../fea/testkit';
import type { AirflowSetup } from './types';

const abs = testMaterial({ materialId: 'abs', name: 'ABS', thermalConductivity: 0.17, density: 1050 });
const alu = testMaterial({ materialId: 'al', name: 'Aluminium', thermalConductivity: 167, density: 2700 });
const pcb = testMaterial({ materialId: 'pcb', name: 'PCB (effective in-plane)', thermalConductivity: 15, density: 1850 });
const epoxy = testMaterial({ materialId: 'epoxy', name: 'Epoxy mold', thermalConductivity: 0.7, density: 1900 });
const MATS: EffectiveMaterial[] = [abs, alu, pcb, epoxy];

const cellsWhere = (g: { nx: number; ny: number; nz: number }, f: (i: number, j: number, k: number) => boolean) => {
  const out: number[] = [];
  for (let k = 0; k < g.nz; k++) for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) if (f(i, j, k)) out.push(i + g.nx * (j + g.ny * k));
  return out;
};

/** 100 mm sealed ABS cube (5 mm walls) with a 1 W aluminium block inside. */
function sealedBox(power = 1): AirflowSetup {
  const n = 20;
  const grid = makeGrid(n, n, n, 5, (i, j, k) =>
    i === 0 || j === 0 || k === 0 || i === n - 1 || j === n - 1 || k === n - 1 ? 1 : i >= 8 && i < 12 && j >= 8 && j < 12 && k >= 3 && k < 5 ? 2 : 0,
  );
  return {
    grid,
    materials: MATS,
    heatSources: [{ cells: cellsWhere(grid, (i, j, k) => i >= 8 && i < 12 && j >= 8 && j < 12 && k >= 3 && k < 5), power, componentId: 'U1', ref: 'U1' }],
    openings: [],
    ambient: 25,
  };
}

/** Vertical aluminium duct 40×40×200 mm (5 mm cells) with a heated block near the bottom, open at both ends. */
function chimney(power = 1): AirflowSetup {
  const nx = 8;
  const ny = 8;
  const nz = 40;
  const block = (i: number, j: number, k: number) => i >= 3 && i < 5 && j >= 3 && j < 5 && k >= 4 && k < 8;
  const grid = makeGrid(nx, ny, nz, 5, (i, j, k) => (i === 0 || j === 0 || i === nx - 1 || j === ny - 1 || block(i, j, k) ? 2 : 0));
  return {
    grid,
    materials: MATS,
    heatSources: [{ cells: cellsWhere(grid, block), power, componentId: 'R1', ref: 'R1' }],
    openings: [
      { name: 'bottom', cells: cellsWhere(grid, (i, j, k) => k === 0 && grid.cells[i + nx * (j + ny * k)] === 0) },
      { name: 'top', cells: cellsWhere(grid, (i, j, k) => k === nz - 1 && grid.cells[i + nx * (j + ny * k)] === 0) },
    ],
    ambient: 25,
  };
}

describe('airProperties', () => {
  it('matches dry-air tables at 25 °C', () => {
    const a = airProperties(25);
    expect(a.density).toBeCloseTo(1.184, 2);
    expect(Math.abs(a.viscosity / 1.845e-5 - 1)).toBeLessThan(0.01); // Sutherland vs tables
    expect(a.conductivity).toBeCloseTo(0.026, 3);
    expect(a.beta).toBeCloseTo(1 / 298.15, 8);
  });
});

describe('solveAirflow — validation cases', () => {
  it('pure conduction: solid cube with external h matches the lumped balance', () => {
    const n = 10;
    const grid = makeGrid(n, n, n, 5, () => 2); // 50 mm aluminium cube
    const all = cellsWhere(grid, () => true);
    const r = solveAirflow({ grid, materials: MATS, heatSources: [{ cells: all, power: 2 }], openings: [], ambient: 20, externalH: 12 });
    const area = 6 * 0.05 * 0.05;
    const expected = 20 + 2 / (12 * area);
    expect(r.maxSolidTemp / expected).toBeGreaterThan(0.99);
    expect(r.maxSolidTemp / expected).toBeLessThan(1.02);
    expect(r.heatBalance.walls).toBeCloseTo(2, 6);
    expect(r.streamlines.length).toBe(0);
    expect(r.converged).toBe(true);
  });

  it('sealed box: heat input leaves through the walls (balance within 5 %)', () => {
    const r = solveAirflow(sealedBox(1));
    console.log(`sealed box: ${r.iterations} its, converged=${r.converged}, Tsrc=${r.components[0].temperature.toFixed(1)} °C, vmax=${r.maxVelocity.toFixed(3)} m/s, walls=${r.heatBalance.walls.toFixed(4)} W`);
    expect(r.mode).toBe('natural');
    expect(r.vents).toEqual([]);
    expect(r.heatBalance.input).toBe(1);
    expect(Math.abs(r.heatBalance.walls - 1)).toBeLessThan(0.05);
    expect(r.heatBalance.vents).toBe(0);
    expect(r.converged).toBe(true);
    expect(r.components[0].temperature).toBeGreaterThan(r.maxAirTemp);
    expect(r.maxAirTemp).toBeGreaterThan(r.meanAirTemp);
    expect(r.meanAirTemp).toBeGreaterThan(25);
    expect(r.maxVelocity).toBeGreaterThan(0.01); // buoyant plume above the block
    // plume rises: air right above the block moves up
    const n = 20;
    const vel = toFloat32(r.velocity);
    const above = 10 + n * (10 + n * 7);
    expect(vel[3 * above + 2]).toBeGreaterThan(0);
  });

  it('chimney: upward through-flow, mass in = out within 5 %, energy balance closes', () => {
    const s = chimney(1);
    const r = solveAirflow(s);
    const bottom = r.vents.find((v) => v.name === 'bottom')!;
    const top = r.vents.find((v) => v.name === 'top')!;
    console.log(`chimney: ${r.iterations} its, converged=${r.converged}, Q=${(top.flowM3s * 1e6).toFixed(1)} cm³/s, Tsrc=${r.components[0].temperature.toFixed(1)} °C, vents ${r.heatBalance.vents.toFixed(3)} W + walls ${r.heatBalance.walls.toFixed(3)} W`);
    expect(bottom.direction).toBe('in');
    expect(top.direction).toBe('out');
    expect(top.flowM3s).toBeGreaterThan(1e-6);
    expect(Math.abs(bottom.flowM3s - top.flowM3s) / top.flowM3s).toBeLessThan(0.05);
    const { input, vents, walls } = r.heatBalance;
    expect(Math.abs(input - vents - walls) / input).toBeLessThan(0.05);
    expect(vents).toBeGreaterThan(walls); // most heat leaves with the air
    // upward velocity in the top opening layer
    const vel = toFloat32(r.velocity);
    let wSum = 0;
    for (const c of s.openings[1].cells as number[]) wSum += vel[3 * c + 2];
    expect(wSum).toBeGreaterThan(0);
    expect(r.streamlines.length).toBeGreaterThan(5);
    for (const line of r.streamlines)
      for (const p of line) {
        expect(p[0]).toBeGreaterThanOrEqual(-1e-6);
        expect(p[2]).toBeLessThanOrEqual(200 + 1e-6);
      }
    expect(r.mode).toBe('natural');
  });

  it('fan duct: through-flow equals the fan flow within 5 %', () => {
    const nx = 40;
    const ny = 8;
    const nz = 8;
    const wall = (j: number, k: number) => j === 0 || k === 0 || j === ny - 1 || k === nz - 1;
    const chip = (i: number, j: number, k: number) => i >= 25 && i < 29 && j >= 3 && j < 5 && k >= 1 && k < 3;
    const grid = makeGrid(nx, ny, nz, 5, (i, j, k) => (wall(j, k) ? 1 : chip(i, j, k) ? 4 : 0));
    const flow = 1e-4;
    const r = solveAirflow({
      grid,
      materials: MATS,
      heatSources: [{ cells: cellsWhere(grid, chip), power: 2, componentId: 'Q1', ref: 'Q1' }],
      openings: [
        { name: 'inlet', cells: cellsWhere(grid, (i, j, k) => i === 0 && !wall(j, k)) },
        { name: 'outlet', cells: cellsWhere(grid, (i, j, k) => i === nx - 1 && !wall(j, k)) },
      ],
      fans: [{ name: 'F1', cells: cellsWhere(grid, (i, j, k) => i === 10 && !wall(j, k)), direction: [1, 0, 0], flowM3s: flow }],
      ambient: 25,
    });
    expect(r.mode).toBe('forced');
    const inlet = r.vents.find((v) => v.name === 'inlet')!;
    const outlet = r.vents.find((v) => v.name === 'outlet')!;
    expect(inlet.direction).toBe('in');
    expect(outlet.direction).toBe('out');
    expect(Math.abs(inlet.flowM3s - flow) / flow).toBeLessThan(0.05);
    expect(Math.abs(outlet.flowM3s - flow) / flow).toBeLessThan(0.05);
    // the air leaving carries the chip power: ΔT_air = P / (ρ c_p Q)
    const air = r.air;
    expect(r.heatBalance.vents + r.heatBalance.walls).toBeCloseTo(2, 3);
    expect(r.components[0].temperature).toBeGreaterThan(25 + r.heatBalance.vents / (air.density * air.specificHeat * flow) * 0.5);
    expect(r.converged).toBe(true);
  });

  it('packs consistent result arrays', () => {
    const s = sealedBox(0.5);
    const r = solveAirflow({ ...s, maxIterations: 30 });
    const N = 20 * 20 * 20;
    expect(toUint8(r.cells).length).toBe(N);
    expect(toFloat32(r.temperature).length).toBe(N);
    expect(toFloat32(r.velocity).length).toBe(3 * N);
    expect(r.components[0]).toMatchObject({ componentId: 'U1', ref: 'U1', power: 0.5 });
    expect(r.iterations).toBeLessThanOrEqual(30);
    expect(r.grid).toEqual({ nx: 20, ny: 20, nz: 20, h: 5, origin: [0, 0, 0] });
    // energy balance holds even when the flow is not converged (final conservative energy solve)
    expect(Math.abs(r.heatBalance.walls - 0.5)).toBeLessThan(0.005);
  });

  it('openings alone provide a heat path (conduction + advection to ambient)', () => {
    // free-standing heated cube in air; the −x boundary layer is open to ambient, no boundary solids
    const n = 6;
    const grid = makeGrid(n, n, n, 5, (i, j, k) => (i >= 2 && i < 4 && j >= 2 && j < 4 && k >= 1 && k < 3 ? 1 : 0));
    const r = solveAirflow({
      grid,
      materials: MATS,
      heatSources: [{ cells: cellsWhere(grid, (i, j, k) => grid.cells[i + n * (j + n * k)] === 1), power: 0.2 }],
      openings: [{ name: 'side', cells: cellsWhere(grid, (i) => i === 0) }],
      ambient: 20,
    });
    expect(r.converged).toBe(true);
    expect(r.heatBalance.walls).toBe(0);
    expect(r.heatBalance.vents).toBeCloseTo(0.2, 6);
    expect(r.components[0].temperature).toBeGreaterThan(20);
    expect(r.components[0].temperature).toBeLessThan(400);
  });

  it('rejects invalid setups with clear errors', () => {
    const grid = makeGrid(4, 4, 4, 5, () => 0);
    expect(() => solveAirflow({ grid, materials: [], heatSources: [{ cells: [5], power: 1 }], openings: [], ambient: 25 })).toThrow(
      /no heat path/,
    );
    const g2 = makeGrid(4, 4, 4, 5, () => 3);
    expect(() => solveAirflow({ grid: g2, materials: [abs], heatSources: [], openings: [], ambient: 25 })).toThrow(/materials\[2\]/);
  });
});

describe('solveAirflow — performance', () => {
  it('60×40×25 vented enclosure (natural convection) reaches steady state in < 30 s', () => {
    // 120 × 80 × 50 mm ABS enclosure (2 mm cells), PCB with effective in-plane k, three ICs (3 W),
    // low vent slots on −x, high vent slots on +x
    const nx = 60;
    const ny = 40;
    const nz = 25;
    const grid = makeGrid(nx, ny, nz, 2, (i, j, k) => {
      if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) return 1;
      if (k === 8 && i >= 4 && i < nx - 4 && j >= 4 && j < ny - 4) return 3;
      if (k === 7 && (i % 25 === 5 || i % 25 === 6) && (j === 5 || j === 6 || j === ny - 6 || j === ny - 7)) return 1;
      if (k >= 9 && k < 11 && i >= 10 && i < 16 && j >= 10 && j < 16) return 4;
      if (k === 9 && i >= 30 && i < 36 && j >= 20 && j < 26) return 4;
      if (k >= 9 && k < 12 && i >= 44 && i < 48 && j >= 8 && j < 14) return 4;
      return 0;
    });
    const box = (i0: number, i1: number, j0: number, j1: number, k0: number, k1: number) =>
      cellsWhere(grid, (i, j, k) => i >= i0 && i < i1 && j >= j0 && j < j1 && k >= k0 && k < k1);
    const ventLow = box(0, 1, 8, 32, 2, 6);
    const ventHigh = box(nx - 1, nx, 8, 32, 18, 23);
    for (const c of [...ventLow, ...ventHigh]) grid.cells[c] = 0;
    const t0 = performance.now();
    const r = solveAirflow({
      grid,
      materials: MATS,
      heatSources: [
        { cells: box(10, 16, 10, 16, 9, 11), power: 1.5, componentId: 'U1', ref: 'U1' },
        { cells: box(30, 36, 20, 26, 9, 10), power: 0.5, componentId: 'U2', ref: 'U2' },
        { cells: box(44, 48, 8, 14, 9, 12), power: 1.0, componentId: 'U3', ref: 'U3' },
      ],
      openings: [
        { name: 'vent-low', cells: ventLow },
        { name: 'vent-high', cells: ventHigh },
      ],
      ambient: 25,
    });
    const s = (performance.now() - t0) / 1000;
    const low = r.vents[0];
    const high = r.vents[1];
    console.log(
      `perf: 60k cells, ${r.iterations} its, ${s.toFixed(1)} s, converged=${r.converged}, ` +
        `T=${r.components.map((c) => c.temperature.toFixed(1)).join('/')} °C, vents ${low.direction} ${(low.flowM3s * 1e6).toFixed(1)} / ${high.direction} ${(high.flowM3s * 1e6).toFixed(1)} cm³/s, ` +
        `heat vents ${r.heatBalance.vents.toFixed(2)} W + walls ${r.heatBalance.walls.toFixed(2)} W`,
    );
    expect(r.converged).toBe(true);
    expect(s).toBeLessThan(30);
    expect(low.direction).toBe('in'); // cool air enters low …
    expect(high.direction).toBe('out'); // … and leaves high (chimney effect)
    expect(Math.abs(low.flowM3s - high.flowM3s) / high.flowM3s).toBeLessThan(0.05);
    expect(Math.abs(r.heatBalance.input - r.heatBalance.vents - r.heatBalance.walls)).toBeLessThan(0.05 * r.heatBalance.input);
    expect(r.streamlines.length).toBeGreaterThan(10);
  });
});
