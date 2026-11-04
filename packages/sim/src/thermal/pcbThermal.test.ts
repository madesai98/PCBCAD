import { describe, expect, it } from 'vitest';
import { copperOzToMm, toFloat32, toUint8 } from '@pcbcad/core';
import type { Board, PartDef } from '@pcbcad/core';
import { simulatePcbThermal, type PcbThermalReport } from './pcbThermal';
import { makeBoard, makePart, makeProject, pad, place, trace } from './testFixtures';
import { STEFAN_BOLTZMANN } from './convection';

const qfn = makePart('qfn', [pad('EP', 0, 0, 3, 3), pad('1', -2, 0, 0.3, 0.8), pad('2', 2, 0, 0.3, 0.8), pad('3', 0, -2, 0.8, 0.3), pad('4', 0, 2, 0.8, 0.3)]);

function fields(r: PcbThermalReport) {
  return {
    mask: toUint8(r.mask as never),
    top: toFloat32(r.layers.find((l) => l.layer === 'top')!.temperature),
    bot: toFloat32(r.layers.find((l) => l.layer === 'bottom')!.temperature),
  };
}

/** Board with a 1 W QFN in the centre. */
function qfnBoard(w = 40, h = 40, layers: 2 | 4 | 6 = 2): Board {
  const b = makeBoard(w, h, { layers });
  place(b, { id: 'u1', partId: 'qfn', x: w / 2, y: h / 2, pinNets: { EP: 'gnd', '1': 'a', '2': 'b', '3': 'c', '4': 'd' } });
  return b;
}

describe('simulatePcbThermal', () => {
  it('conserves energy: convective + radiative loss recomputed from the output fields equals input within 1 %', () => {
    const b = makeBoard(60, 40);
    const res2 = makePart('r2512', [pad('1', -3, 0, 1.5, 3), pad('2', 3, 0, 1.5, 3)]);
    place(b, { id: 'u1', partId: 'qfn', x: 20, y: 20, pinNets: { EP: 'gnd' } });
    place(b, { id: 'r1', partId: 'r2512', x: 45, y: 25, pinNets: { '1': 'vin', '2': 'gnd' } });
    place(b, { id: 'r2', partId: 'r2512', x: 45, y: 10, side: 'bottom', pinNets: { '1': 'vin', '2': 'gnd' } });
    b.zones.push({ id: 'zg', netId: 'gnd', layer: 'bottom', clearance: 0.3 });
    b.traces.push(trace('t1', 'vin', [[42, 25], [42, 35], [5, 35]], 0.3));
    const tp = makePart('tp', [pad('1', 0, 0, 2, 2)]);
    place(b, { id: 'j1', partId: 'tp', x: 5, y: 35, pinNets: { '1': 'vin' } });
    const r = simulatePcbThermal(makeProject([b], [qfn, res2, tp]), b.id, {
      power: { u1: 0.8, r1: 0.4, r2: 0.3 },
      pinCurrents: { j1: { '1': -2 }, r1: { '1': 2 } },
      resolution: 0.5,
    });
    const { mask, top, bot } = fields(r);
    const { nx, ny, dx, dy } = r.grid;
    const A = dx * dy * 1e-6;
    const Ta = r.airTemp + 273.15;
    const eps = 0.9;
    const rad = (T: number) => eps * STEFAN_BOLTZMANN * ((T + 273.15) ** 4 - Ta ** 4);
    const hE = (r.convection.hTop + r.convection.hBottom) / 2;
    let loss = 0;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!mask[k]) continue;
        const tt = top[k];
        const tb = bot[k];
        loss += A * (r.convection.hTop * (tt - r.airTemp) + r.convection.hBottom * (tb - r.airTemp) + rad(tt) + rad(tb));
        const open = (ii: number, jj: number) => ii < 0 || jj < 0 || ii >= nx || jj >= ny || !mask[jj * nx + ii];
        const side = (open(i + 1, j) ? dy : 0) + (open(i - 1, j) ? dy : 0) + (open(i, j + 1) ? dx : 0) + (open(i, j - 1) ? dx : 0);
        const ae = (side * 1.6 * 1e-6) / 2;
        loss += ae * (hE * (tt - r.airTemp) + rad(tt) + hE * (tb - r.airTemp) + rad(tb));
      }
    const joule = r.traces.reduce((s, t) => s + t.power, 0);
    expect(joule).toBeGreaterThan(0);
    expect(r.totalPower).toBeCloseTo(1.5 + joule, 3);
    expect(Math.abs(loss / r.totalPower - 1)).toBeLessThan(0.01);
    expect(Math.abs(r.heatBalance.relativeError)).toBeLessThan(0.01);
    expect(r.solver.converged).toBe(true);
  });

  it('symmetric source on a symmetric board gives a mirror- and rotation-symmetric field', () => {
    const b = qfnBoard(40, 40);
    const r = simulatePcbThermal(makeProject([b], [qfn]), b.id, { power: { u1: 1 }, resolution: 0.5 });
    const { top, bot } = fields(r);
    const { nx, ny } = r.grid;
    expect(nx).toBe(ny);
    let worst = 0;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const t = top[j * nx + i];
        worst = Math.max(
          worst,
          Math.abs(t - top[j * nx + (nx - 1 - i)]),
          Math.abs(t - top[(ny - 1 - j) * nx + i]),
          Math.abs(t - top[i * nx + j]), // 90° (transpose) symmetry of the square pattern
          Math.abs(bot[j * nx + i] - bot[j * nx + (nx - 1 - i)]),
        );
      }
    expect(worst).toBeLessThan(1e-3);
    // peak is at the source and the field decays monotonically from it along the axis
    const mid = (ny / 2) | 0;
    for (let i = nx / 2; i < nx - 1; i++) expect(top[mid * nx + i + 1]).toBeLessThanOrEqual(top[mid * nx + i] + 1e-6);
  });

  it('matches the exact 1-D through-plane solution for uniform heating', () => {
    const b = makeBoard(40, 40);
    const heater = makePart('heater', [pad('1', 0, 0, 40, 40)]);
    place(b, { id: 'h1', partId: 'heater', x: 20, y: 20, pinNets: { '1': 'n' } });
    const h = 15;
    const P = 2;
    const r = simulatePcbThermal(makeProject([b], [heater]), b.id, {
      power: { h1: P },
      convection: { mode: 'natural', hTop: h, hBottom: h },
      emissivity: 0,
      edges: 'adiabatic',
      resolution: 1,
    });
    const q = P / 1.6e-3;
    const t = 1.6e-3;
    const kz = 0.3;
    const qb = q / (2 + (h * t) / kz); // flux reaching the bottom face
    const { top, bot } = fields(r);
    for (let k = 0; k < top.length; k += 97) {
      expect(top[k] - 25).toBeCloseTo(qb / h + (qb * t) / kz, 3);
      expect(bot[k] - 25).toBeCloseTo(qb / h, 3);
    }
  });

  it('matches the analytic two-layer fin solution along a heated strip', () => {
    const L = 100;
    const Wd = 10;
    const b = makeBoard(L, Wd);
    const heater = makePart('heater', [pad('1', 0, 0, 2, Wd)]);
    place(b, { id: 'h1', partId: 'heater', x: 1, y: Wd / 2, pinNets: { '1': 'n' } });
    b.zones.push({ id: 'z', netId: 'n', layer: 'top', clearance: 0.3 });
    const hT = 12;
    const hB = 6;
    const r = simulatePcbThermal(makeProject([b], [heater]), b.id, {
      power: { h1: 1 },
      convection: { mode: 'natural', hTop: hT, hBottom: hB },
      emissivity: 0,
      edges: 'adiabatic',
      resolution: 0.25,
    });
    const { top } = fields(r);
    const g = r.grid;
    const j = (g.ny / 2) | 0;
    const at = (x: number) => {
      const i = Math.floor((x - g.x0) / g.dx);
      return { th: top[j * g.nx + i] - 25, xc: (i + 0.5) * g.dx };
    };
    // slow eigenmode of K θ'' = [[hT+G, −G], [−G, hB+G]] θ (per unit area), insulated tip
    const t = 1.6e-3;
    const KT = (0.8 * t) / 2 + 388 * copperOzToMm(1) * 1e-3;
    const KB = (0.8 * t) / 2;
    const G = 0.3 / t;
    const qa = KT * KB;
    const qb = -((hT + G) * KB + (hB + G) * KT);
    const qc = (hT + G) * (hB + G) - G * G;
    const m = Math.sqrt((-qb - Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa)) * 1e-3; // 1/mm
    for (const [x1, x2] of [
      [30, 60],
      [40, 80],
      [50, 95],
    ]) {
      const a = at(x1);
      const c = at(x2);
      const expected = Math.cosh(m * (L - a.xc)) / Math.cosh(m * (L - c.xc));
      expect(Math.abs(a.th / c.th / expected - 1)).toBeLessThan(1e-3);
    }
  });

  it('copper pour lowers the peak temperature compared to bare FR4', () => {
    const bare = qfnBoard();
    const poured = qfnBoard();
    poured.zones.push({ id: 'z1', netId: 'gnd', layer: 'top', clearance: 0.3 });
    const viad = qfnBoard();
    viad.zones.push({ id: 'z1', netId: 'gnd', layer: 'top', clearance: 0.3 }, { id: 'z2', netId: 'gnd', layer: 'bottom', clearance: 0.3 });
    for (let i = -1; i <= 1; i++) for (let k = -1; k <= 1; k++) viad.vias.push({ id: `v${i}${k}`, netId: 'gnd', x: 20 + i, y: 20 + k, drill: 0.3, diameter: 0.6 });
    const run = (b: Board) => simulatePcbThermal(makeProject([b], [qfn]), b.id, { power: { u1: 1 } });
    const r0 = run(bare);
    const r1 = run(poured);
    const r2 = run(viad);
    expect(r1.maxTemp).toBeLessThan(r0.maxTemp - 50);
    expect(r2.maxTemp).toBeLessThan(r1.maxTemp);
    expect(r2.components[0].tJunction).toBeLessThan(r1.components[0].tJunction);
    // a hot 1 W QFN on bare FR4 must be flagged, with pours it is fine
    expect(r0.components[0].status).toBe('fail');
    expect(r2.components[0].status).toBe('ok');
  });

  it('4-layer vs 2-layer: same copper ⇒ same result; inner planes cool; thermal vias into the planes cool more', () => {
    const pour = (b: Board) => {
      b.zones.push({ id: 'zt', netId: 'gnd', layer: 'top', clearance: 0.3 });
      b.zones.push({ id: 'zb', netId: 'gnd', layer: 'bottom', clearance: 0.3 });
    };
    const run = (b: Board, innerLayers?: 'lumped' | 'resolved') =>
      simulatePcbThermal(makeProject([b], [qfn]), b.id, { power: { u1: 1 }, innerLayers }).components[0].tBoard - 25;
    const b2 = qfnBoard(40, 40, 2);
    pour(b2);
    const b4 = qfnBoard(40, 40, 4);
    pour(b4);
    const r2 = run(b2);
    expect(Math.abs(run(b4) / r2 - 1)).toBeLessThan(0.01); // resolved: no inner copper → same board
    expect(run(b4, 'lumped')).toBeCloseTo(r2, 6); // lumped: identical discretisation
    // inner GND planes, no vias
    const p4 = qfnBoard(40, 40, 4);
    p4.zones.push({ id: 'z1', netId: 'gnd', layer: 'in1', clearance: 0.3 }, { id: 'z2', netId: 'gnd', layer: 'in2', clearance: 0.3 });
    const bare2 = run(qfnBoard(40, 40, 2));
    const planes = run(p4);
    expect(planes).toBeLessThan(0.6 * bare2);
    // the lumped model ignores the prepreg between the pads and in1: it must be optimistic
    expect(run(p4, 'lumped')).toBeLessThan(planes);
    // thermal vias from the exposed pad into the planes
    for (let i = -1; i <= 1; i++) for (let k = -1; k <= 1; k++) p4.vias.push({ id: `v${i}${k}`, netId: 'gnd', x: 20 + i, y: 20 + k, drill: 0.3, diameter: 0.6 });
    expect(run(p4)).toBeLessThan(0.75 * planes);
  });

  it('natural and forced convection coefficients are in the expected ranges', () => {
    for (const [w, h] of [
      [30, 30],
      [50, 50],
      [100, 80],
    ]) {
      const b = qfnBoard(w, h);
      b.zones.push({ id: 'z1', netId: 'gnd', layer: 'top', clearance: 0.3 });
      const nat = simulatePcbThermal(makeProject([b], [qfn]), b.id, { power: { u1: 1 } });
      expect(nat.convection.mode).toBe('natural');
      for (const hv of [nat.convection.hTop, nat.convection.hBottom]) {
        expect(hv).toBeGreaterThanOrEqual(4 * (hv === nat.convection.hBottom ? 0.5 : 1));
        expect(hv).toBeLessThanOrEqual(15);
      }
      expect(nat.convection.hTop).toBeGreaterThan(nat.convection.hBottom); // hot face up convects better
      expect(nat.convection.hRadTop).toBeGreaterThan(5);
      expect(nat.convection.hRadTop).toBeLessThan(9);
      const forced = simulatePcbThermal(makeProject([b], [qfn]), b.id, { power: { u1: 1 }, convection: { mode: 'forced', airVelocity: 2 } });
      expect(forced.convection.hTop).toBeGreaterThan(15);
      expect(forced.convection.hTop).toBeLessThan(35);
      expect(forced.convection.airVelocity).toBe(2);
      expect(forced.maxTemp).toBeLessThan(nat.maxTemp);
    }
    // vertical boards: both faces equal
    const v = qfnBoard(50, 50);
    const rv = simulatePcbThermal(makeProject([v], [qfn]), v.id, { power: { u1: 0.5 }, orientation: 'vertical' });
    expect(Math.abs(rv.convection.hTop / rv.convection.hBottom - 1)).toBeLessThan(0.05);
    expect(rv.convection.hTop).toBeGreaterThan(3);
    expect(rv.convection.hTop).toBeLessThan(12);
  });

  it('honours explicit h overrides and the enclosure air temperature', () => {
    const b = qfnBoard();
    const base = { power: { u1: 0.5 }, convection: { mode: 'natural' as const, hTop: 10, hBottom: 7 }, emissivity: 0 };
    const r1 = simulatePcbThermal(makeProject([b], [qfn]), b.id, { ...base, ambient: 25 });
    const r2 = simulatePcbThermal(makeProject([b], [qfn]), b.id, { ...base, ambient: 25, enclosureAirTemp: 45 });
    expect(r1.convection.hTop).toBe(10);
    expect(r1.convection.hBottom).toBe(7);
    expect(r2.airTemp).toBe(45);
    expect(r2.ambient).toBe(25);
    const a = fields(r1).top;
    const c = fields(r2).top;
    for (let k = 0; k < a.length; k += 53) expect(c[k] - a[k]).toBeCloseTo(20, 3);
  });

  it('component junction chain, Tj,max status and θJA cross-check', () => {
    const hot = makePart('hot', [pad('1', -1, 0, 1, 1), pad('2', 1, 0, 1, 1)], { thermal: { thetaJC: 40, tjMax: 100, thetaJA: 20 } });
    const b = makeBoard(40, 40);
    place(b, { id: 'u1', partId: 'hot', x: 20, y: 20, pinNets: { '1': 'a', '2': 'b' } });
    place(b, { id: 'c1', partId: 'qfn', x: 8, y: 8, pinNets: {} });
    const r = simulatePcbThermal(makeProject([b], [hot, qfn]), b.id, { power: { u1: 0.5 } });
    const u1 = r.components.find((c) => c.ref === 'U1')!;
    expect(u1.thetaJC).toBe(40);
    expect(u1.tCase).toBeCloseTo(u1.tBoard + 0.5 * u1.thetaCB, 9);
    expect(u1.tJunction).toBeCloseTo(u1.tCase + 0.5 * 40, 9);
    expect(u1.tjMax).toBe(100);
    expect(u1.status).toBe('fail');
    expect(u1.tJunctionThetaJA).toBeCloseTo(25 + 0.5 * 20, 9);
    expect(r.warnings.some((w) => /U1: board model .* differ by more than 2×/.test(w))).toBe(true);
    // unpowered component still gets its board temperature, at ≥ ambient
    const c1 = r.components.find((c) => c.ref === 'C1')!;
    expect(c1.power).toBe(0);
    expect(c1.tJunction).toBeCloseTo(c1.tBoard, 9);
    expect(c1.tBoard).toBeGreaterThan(25);
    expect(c1.status).toBe('ok');
  });

  it('warn status above 85 % of the allowed junction rise', () => {
    const p = makePart('p', [pad('1', 0, 0, 2, 2)], { thermal: { thetaJC: 0, tjMax: 125 } });
    const b = makeBoard(40, 40);
    b.zones.push({ id: 'z', netId: 'n', layer: 'top', clearance: 0.3 });
    place(b, { id: 'u1', partId: 'p', x: 20, y: 20, pinNets: { '1': 'n' } });
    const prj = makeProject([b], [p]);
    const probe = simulatePcbThermal(prj, b.id, { power: { u1: 1 }, convection: { mode: 'natural', hTop: 10, hBottom: 10 }, emissivity: 0 });
    const perW = probe.components[0].tJunction - 25; // linear model: rise per watt
    const at = (frac: number) =>
      simulatePcbThermal(prj, b.id, { power: { u1: (frac * 100) / perW }, convection: { mode: 'natural', hTop: 10, hBottom: 10 }, emissivity: 0 }).components[0].status;
    expect(at(0.8)).toBe('ok');
    expect(at(0.9)).toBe('warn');
    expect(at(1.05)).toBe('fail');
  });

  it('bottom-side components heat the bottom face; cutouts and holes are masked', () => {
    const b = makeBoard(40, 30);
    b.cutouts = [
      [
        [2, 2],
        [8, 2],
        [8, 8],
        [2, 8],
      ],
    ];
    b.holes.push({ id: 'h', x: 35, y: 25, drill: 3.2, plated: false });
    place(b, { id: 'u1', partId: 'qfn', x: 20, y: 15, side: 'bottom', pinNets: { EP: 'gnd' } });
    const r = simulatePcbThermal(makeProject([b], [qfn]), b.id, { power: { u1: 0.5 }, resolution: 0.5 });
    const { mask, top, bot } = fields(r);
    const { nx, dx, dy, x0, y0 } = r.grid;
    const idx = (x: number, y: number) => Math.floor((y - y0) / dy) * nx + Math.floor((x - x0) / dx);
    expect(mask[idx(5, 5)]).toBe(0);
    expect(mask[idx(35, 25)]).toBe(0);
    expect(mask[idx(20, 15)]).toBe(1);
    expect(bot[idx(20, 15)]).toBeGreaterThan(top[idx(20, 15)]);
    expect(top[idx(5, 5)]).toBe(r.airTemp);
    expect(r.mask).toMatchObject({ dtype: 'u8', length: r.grid.nx * r.grid.ny });
    expect(r.layers[0].temperature).toMatchObject({ dtype: 'f32', length: r.grid.nx * r.grid.ny });
  });

  it('trace Joule heating is deposited along the trace and reported', () => {
    const b = makeBoard(60, 20);
    const tp = makePart('tp', [pad('1', 0, 0, 2, 2)]);
    place(b, { id: 'j1', partId: 'tp', x: 5, y: 10, pinNets: { '1': 'p' } });
    place(b, { id: 'j2', partId: 'tp', x: 55, y: 10, pinNets: { '1': 'p' } });
    b.traces.push(trace('t', 'p', [[5, 10], [55, 10]], 0.2));
    const prj = makeProject([b], [tp]);
    const cold = simulatePcbThermal(prj, b.id, { power: {} });
    expect(cold.maxTemp).toBeCloseTo(25, 6);
    expect(cold.traces).toEqual([]);
    const hot = simulatePcbThermal(prj, b.id, { power: {}, pinCurrents: { j1: { '1': -3 }, j2: { '1': 3 } } });
    const seg = hot.traces[0];
    expect(seg.current).toBeCloseTo(3, 9);
    expect(seg.status).toBe('fail'); // 3 A in 0.2 mm / 1 oz exceeds the IPC 20 °C capacity
    expect(hot.totalPower).toBeCloseTo(seg.power, 2);
    expect(hot.maxTemp).toBeGreaterThan(30);
    // resistance evaluated at the local copper temperature (> ambient) ⇒ more loss than at 25 °C
    const r25 = seg.voltageDrop / seg.current;
    expect(r25).toBeGreaterThan((1.72e-8 * (1 + 0.00393 * 5) * 50e-3) / (0.2e-3 * copperOzToMm(1) * 1e-3));
    expect(hot.netDrops?.[0].netId).toBe('p');
    // hottest cell lies on the trace
    const { top } = fields(hot);
    const g = hot.grid;
    let km = 0;
    for (let k = 0; k < top.length; k++) if (top[k] > top[km]) km = k;
    expect(Math.abs(g.y0 + (Math.floor(km / g.nx) + 0.5) * g.dy - 10)).toBeLessThan(1);
  });

  it('reports problems instead of failing on imperfect input', () => {
    const b = qfnBoard();
    place(b, { id: 'u9', partId: 'qfn', x: 0, y: 0, placed: false, pinNets: {} });
    place(b, { id: 'u8', partId: 'missing', x: 10, y: 10, pinNets: {} });
    const r = simulatePcbThermal(makeProject([b], [qfn]), b.id, { power: { u1: 0.3, u9: 1, u8: 0.1, nope: 2, u2: -1 } });
    expect(r.warnings.some((w) => /U9: .*not placed/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /unknown component/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /U8: part 'missing'/.test(w))).toBe(true);
    expect(r.components.find((c) => c.ref === 'U8')!.tBoard).toBeGreaterThan(25);
    expect(() => simulatePcbThermal(makeProject([b], [qfn]), 'nope', { power: {} })).toThrow(/not found/);
  });

  it('performance: 100×80 mm board at 0.5 mm grid (2 × 32k unknowns) solves in < 2 s', () => {
    const b = makeBoard(100, 80);
    const r2512 = makePart('r2512', [pad('1', -3, 0, 1.5, 3), pad('2', 3, 0, 1.5, 3)]);
    const sot = makePart('sot23', [pad('1', -0.95, -1, 0.6, 0.8), pad('2', 0.95, -1, 0.6, 0.8), pad('3', 0, 1, 0.6, 0.8)]);
    const parts: PartDef[] = [qfn, r2512, sot];
    place(b, { id: 'u1', partId: 'qfn', x: 30, y: 40, pinNets: { EP: 'gnd', '1': 'vin', '2': 'vout' } });
    place(b, { id: 'u2', partId: 'qfn', x: 70, y: 40, pinNets: { EP: 'gnd' } });
    for (let k = 0; k < 6; k++) place(b, { id: `r${k}`, partId: 'r2512', x: 15 + k * 14, y: 15, pinNets: { '1': 'vout', '2': 'gnd' } });
    for (let k = 0; k < 6; k++) place(b, { id: `q${k}`, partId: 'sot23', x: 15 + k * 14, y: 65, side: k % 2 ? 'bottom' : 'top', pinNets: { '1': 'gnd' } });
    b.zones.push({ id: 'zt', netId: 'gnd', layer: 'top', clearance: 0.3 }, { id: 'zb', netId: 'gnd', layer: 'bottom', clearance: 0.3 });
    for (let x = 5; x < 100; x += 10) for (let y = 5; y < 80; y += 10) b.vias.push({ id: `v${x}_${y}`, netId: 'gnd', x, y, drill: 0.3, diameter: 0.6 });
    b.traces.push(trace('tv', 'vout', [[32, 40], [32, 15], [15 - 3, 15]], 1.0));
    for (let k = 1; k < 6; k++) b.traces.push(trace(`tv${k}`, 'vout', [[15 + (k - 1) * 14 - 3, 15], [15 + k * 14 - 3, 15]], 0.5));
    const power: Record<string, number> = { u1: 1.2, u2: 0.6 };
    for (let k = 0; k < 6; k++) power[`r${k}`] = 0.25;
    for (let k = 0; k < 6; k++) power[`q${k}`] = 0.15;
    const pinCurrents: Record<string, Record<string, number>> = { u1: { '2': -1.2 } };
    for (let k = 0; k < 6; k++) pinCurrents[`r${k}`] = { '1': 0.2 };
    const prj = makeProject([b], parts);
    const t0 = performance.now();
    const r = simulatePcbThermal(prj, b.id, { power, pinCurrents, resolution: 0.5 });
    const ms = performance.now() - t0;
    expect(r.grid.nx * r.grid.ny).toBe(200 * 160);
    expect(r.solver.unknowns).toBe(2 * 200 * 160);
    expect(r.solver.converged).toBe(true);
    expect(Math.abs(r.heatBalance.relativeError)).toBeLessThan(0.01);
    expect(r.traces.length).toBeGreaterThan(5);
    expect(ms).toBeLessThan(2000);
  });
});
