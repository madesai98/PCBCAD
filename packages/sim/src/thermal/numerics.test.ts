import { describe, expect, it } from 'vitest';
import type { Grid2 } from '@pcbcad/core';
import { CoverageRaster, centreMask, makeGrid } from './raster';
import { GridMultigrid, type GridSystem } from './gridSolver';
import { solveGroundedLaplacian } from './laplacian';
import { airProperties, forcedConvectionH, naturalConvectionH, radiationH } from './convection';

const grid: Grid2 = makeGrid({ minX: 0, minY: 0, maxX: 10, maxY: 8 }, 0.5);
const area = (f: Float64Array) => f.reduce((a, v) => a + v, 0) * grid.dx * grid.dy;

describe('CoverageRaster', () => {
  it('rasterises axis-aligned rectangles exactly, including partial cells', () => {
    const r = new CoverageRaster(grid, 4);
    r.addRect(1.13, 2.07, 3.91, 2.33); // thin, unaligned
    expect(area(r.finish())).toBeCloseTo(2.78 * 0.26, 10);
  });

  it('takes the union of overlapping shapes (no double counting) and clamps to 1', () => {
    const r = new CoverageRaster(grid, 8);
    r.addRect(1, 1, 5, 5);
    r.addRect(3, 3, 7, 7);
    r.addPolygon([
      [
        [2, 2],
        [4, 2],
        [4, 4],
        [2, 4],
      ],
    ]);
    const f = r.finish();
    expect(area(f)).toBeCloseTo(16 + 16 - 4, 6);
    expect(Math.max(...f)).toBeLessThanOrEqual(1);
  });

  it('even-odd polygons with holes, discs and oblique capsules are accurate', () => {
    const r = new CoverageRaster(grid, 16);
    r.addPolygon([
      [
        [0.5, 0.5],
        [9.5, 0.5],
        [9.5, 7.5],
        [0.5, 7.5],
      ],
      [
        [2, 2],
        [4, 2],
        [4, 4],
        [2, 4],
      ],
    ]);
    expect(area(r.finish())).toBeCloseTo(9 * 7 - 4, 6);
    const d = new CoverageRaster(grid, 16);
    d.addDisc(5, 4, 1.7);
    expect(Math.abs(area(d.finish()) / (Math.PI * 1.7 * 1.7) - 1)).toBeLessThan(0.005);
    const c = new CoverageRaster(grid, 16);
    c.addCapsule(1, 1, 8, 6.3, 0.2); // 30-ish degree trace, width 0.4
    const L = Math.hypot(7, 5.3);
    expect(Math.abs(area(c.finish()) / (L * 0.4 + Math.PI * 0.04) - 1)).toBeLessThan(0.01);
  });

  it('centre mask handles cutouts and holes', () => {
    const m = centreMask(
      grid,
      [
        [
          [0, 0],
          [10, 0],
          [10, 8],
          [0, 8],
        ],
        [
          [1, 1],
          [3, 1],
          [3, 3],
          [1, 3],
        ],
      ],
      [{ x: 7, y: 6, r: 1 }],
    );
    const count = m.reduce((a, v) => a + v, 0);
    expect(count).toBe(20 * 16 - 16 - 12); // 4×4 cutout cells, 12 hole cells (centres within r = 1)
  });
});

describe('GridMultigrid', () => {
  function laplace(nx: number, ny: number, M: number, h: number, holes = false): GridSystem {
    const cellOf = new Int32Array(nx * ny).fill(-1);
    let n = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (!holes || (i - nx / 2) ** 2 + (j - ny / 2) ** 2 > 25) cellOf[j * nx + i] = n++;
    const gE = new Float64Array(n * M);
    const gN = new Float64Array(n * M);
    const gZ = new Float64Array(n * (M - 1));
    const diag = new Float64Array(n * M);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = cellOf[j * nx + i];
        if (c < 0) continue;
        for (let m = 0; m < M; m++) {
          const k = (i * 7 + j * 3 + m) % 5 === 0 ? 30 : 1; // heterogeneous "copper"
          const e = i + 1 < nx ? cellOf[j * nx + i + 1] : -1;
          const t = j + 1 < ny ? cellOf[(j + 1) * nx + i] : -1;
          if (e >= 0) ((gE[c * M + m] = k), (diag[c * M + m] += k), (diag[e * M + m] += k));
          if (t >= 0) ((gN[c * M + m] = k), (diag[c * M + m] += k), (diag[t * M + m] += k));
          diag[c * M + m] += h;
        }
        for (let m = 0; m + 1 < M; m++) ((gZ[c * (M - 1) + m] = 0.5), (diag[c * M + m] += 0.5), (diag[c * M + m + 1] += 0.5));
      }
    return { nx, ny, M, cellOf, n, gE, gN, gZ, diag };
  }

  for (const M of [1, 2, 3]) {
    it(`solves a heterogeneous ${M}-node system to 1e-8 with few iterations`, () => {
      const sys = laplace(70, 50, M, 1e-3, true);
      const mg = new GridMultigrid(sys);
      const b = new Float64Array(mg.size);
      b[17] = 1;
      b[mg.size - 5] = -0.3;
      b[(mg.size / 2) | 0] = 2;
      const x = new Float64Array(mg.size);
      const st = mg.solve(b, x, { tol: 1e-8 });
      expect(st.converged).toBe(true);
      expect(st.iterations).toBeLessThan(60);
      const r = new Float64Array(mg.size);
      mg.multiply(x, r);
      let err = 0;
      let bn = 0;
      for (let i = 0; i < r.length; i++) ((err += (r[i] - b[i]) ** 2), (bn += b[i] ** 2));
      expect(Math.sqrt(err / bn)).toBeLessThan(1e-8);
    });
  }
});

describe('solveGroundedLaplacian', () => {
  it('solves resistor networks exactly (series, parallel, bridge)', () => {
    // 0 —1Ω— 1 —2Ω— 2, plus 0 —3Ω— 2 ; inject 1 A at node 0, ground node 2
    const v = solveGroundedLaplacian(3, { a: [0, 1, 0], b: [1, 2, 2], g: [1, 0.5, 1 / 3] }, [1, 0, 0], 2);
    expect(v[0]).toBeCloseTo(1 / (1 / 3 + 1 / 3), 12); // 3 Ω ∥ 3 Ω = 1.5 Ω
    expect(v[1]).toBeCloseTo(v[0] * (2 / 3), 12);
    // Wheatstone bridge, balanced: no current through the bridge resistor
    const w = solveGroundedLaplacian(4, { a: [0, 0, 1, 2, 1], b: [1, 2, 3, 3, 2], g: [1, 0.5, 1, 0.5, 7] }, [1, 0, 0, -1], 3);
    expect(w[1]).toBeCloseTo(w[2], 12);
  });

  it('handles long chains with extreme conductance ratios', () => {
    const n = 2000;
    const a: number[] = [];
    const b: number[] = [];
    const g: number[] = [];
    let R = 0;
    for (let i = 0; i + 1 < n; i++) {
      const gi = i % 3 === 0 ? 1e7 : 0.5;
      a.push(i);
      b.push(i + 1);
      g.push(gi);
      R += 1 / gi;
    }
    const J = new Float64Array(n);
    J[0] = 2;
    const v = solveGroundedLaplacian(n, { a, b, g }, J, n - 1);
    expect(v[0] / (2 * R) - 1).toBeLessThan(1e-12);
  });
});

describe('convection correlations', () => {
  it('air properties match tables at 25 °C within 2 %', () => {
    const a = airProperties(25);
    expect(a.k / 0.0261 - 1).toBeLessThan(0.02);
    expect(Math.abs(a.nu / 1.562e-5 - 1)).toBeLessThan(0.02);
    expect(Math.abs(a.pr / 0.707 - 1)).toBeLessThan(0.02);
  });

  it('hot face up > vertical > hot face down; values in the PCB range', () => {
    const up = naturalConvectionH('horizontal', 'top', 30, 25, 0.0125);
    const down = naturalConvectionH('horizontal', 'bottom', 30, 25, 0.0125);
    const vert = naturalConvectionH('vertical', 'top', 30, 25, 0.05);
    expect(up).toBeGreaterThan(vert);
    expect(vert).toBeGreaterThan(down);
    expect(up).toBeGreaterThan(6);
    expect(up).toBeLessThan(15);
    expect(down).toBeGreaterThan(2);
    // a cold plate swaps the correlations
    expect(naturalConvectionH('horizontal', 'bottom', -30, 25, 0.0125)).toBeCloseTo(naturalConvectionH('horizontal', 'top', 30, 25 - 30, 0.0125), 0);
  });

  it('forced convection: laminar flat plate at 2 m/s over 50–100 mm is 15–35 W/m²K and scales with √V', () => {
    for (const L of [0.05, 0.1]) {
      const h = forcedConvectionH(2, L, 30);
      expect(h).toBeGreaterThan(15);
      expect(h).toBeLessThan(35);
      expect(forcedConvectionH(8, L, 30) / h).toBeCloseTo(2, 6);
    }
    // above Re = 5e5 the mixed laminar/turbulent correlation exceeds the laminar one
    const a = airProperties(30);
    const Re = (30 * 1) / a.nu;
    expect(Re).toBeGreaterThan(5e5);
    const hLam = (0.664 * Math.sqrt(Re) * Math.cbrt(a.pr) * a.k) / 1;
    expect(forcedConvectionH(30, 1, 30)).toBeGreaterThan(hLam);
  });

  it('linearised radiation coefficient ≈ 4εσT³', () => {
    const T = 298.15;
    expect(radiationH(0.9, 25, 25)).toBeCloseTo(4 * 0.9 * 5.670374419e-8 * T ** 3, 10);
    expect(radiationH(0.9, 75, 25)).toBeGreaterThan(radiationH(0.9, 25, 25));
  });
});
