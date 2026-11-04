import { describe, expect, it } from 'vitest';
import { awgOhmPerMeter, toFloat32, toNumbers } from '@pcbcad/core';
import type { Interconnect } from '@pcbcad/core';
import { buildCircuit, solveOp, solveTransient } from './index';
import { P, ProjectKit, makePart } from './testkit';

const near = (a: number, b: number, rel: number) => Math.abs(a - b) <= rel * Math.abs(b);

describe('solveOp — basics', () => {
  it('resistor divider: voltages, pin currents, power, source power', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    const v = b.add('V1', P.vsource(10), { 1: 'VIN', 2: 'GND' });
    const r1 = b.add('R1', P.resistor(10e3), { 1: 'VIN', 2: 'MID' });
    const r2 = b.add('R2', P.resistor(10e3), { 1: 'MID', 2: 'GND' });
    const c = buildCircuit(pk.project, { boardId: b.board.id });
    const op = solveOp(c);
    expect(op.converged).toBe(true);
    expect(op.nodeVoltages[b.net('MID')]).toBeCloseTo(5, 6);
    expect(op.nodeVoltages[b.net('VIN')]).toBeCloseTo(10, 6);
    expect(op.nodeVoltages[b.net('GND')]).toBe(0);
    expect(op.netNames[b.net('MID')]).toBe('MID');
    expect(op.pinCurrents[r1.id]['1']).toBeCloseTo(0.5e-3, 9);
    expect(op.pinCurrents[r1.id]['2']).toBeCloseTo(-0.5e-3, 9);
    expect(op.pinCurrents[v.id]['1']).toBeCloseTo(-0.5e-3, 9); // current INTO + pin is negative (delivering)
    expect(op.componentPower[r2.id]).toBeCloseTo(2.5e-3, 8);
    expect(op.sourcePower![v.id]).toBeCloseTo(5e-3, 8);
    expect(op.componentPower[v.id]).toBeCloseTo(0, 10);
  });

  it('LED + resistor current ≈ (Vs − Vf)/R within 3%', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    b.add('V1', P.vsource(5), { 1: 'VCC', 2: 'GND' });
    b.add('R1', P.resistor(150), { 1: 'VCC', 2: 'A' });
    const d = b.add('D1', P.led(2.0, 0.02, 'red'), { 2: 'A', 1: 'GND' });
    const op = solveOp(buildCircuit(pk.project, { boardId: b.board.id }));
    const i = op.pinCurrents[d.id]['2'];
    expect(near(i, (5 - 2.0) / 150, 0.03)).toBe(true);
    expect(op.componentPower[d.id]).toBeGreaterThan(0.035);
    expect(op.componentPower[d.id]).toBeLessThan(0.045);
  });

  it('LDO: regulation, dissipation (Vin−Vout)·Iout + Vin·Iq, dropout warning', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    b.add('V1', P.vsource(5), { 1: 'VIN', 2: 'GND' });
    const u = b.add('U1', P.ldo(3.3, 0.3, 0.005, 1), { 3: 'VIN', 2: '3V3', 1: 'GND' });
    b.add('RL', P.resistor(33), { 1: '3V3', 2: 'GND' });
    const op = solveOp(buildCircuit(pk.project, { boardId: b.board.id }));
    expect(op.converged).toBe(true);
    const vout = op.nodeVoltages[b.net('3V3')];
    expect(Math.abs(vout - 3.3)).toBeLessThan(0.005);
    const iout = vout / 33;
    const expected = (5 - vout) * iout + 5 * 0.005;
    expect(near(op.componentPower[u.id], expected, 0.01)).toBe(true);
    expect(op.pinCurrents[u.id]['1']).toBeCloseTo(-0.005, 4); // Iq leaves through GND
    // dropout
    const pk2 = new ProjectKit();
    const b2 = pk2.board();
    b2.add('V1', P.vsource(3.4), { 1: 'VIN', 2: 'GND' });
    b2.add('U1', P.ldo(3.3, 0.3, 0, 1), { 3: 'VIN', 2: '3V3', 1: 'GND' });
    b2.add('RL', P.resistor(100), { 1: '3V3', 2: 'GND' });
    const op2 = solveOp(buildCircuit(pk2.project, { boardId: b2.board.id }));
    expect(op2.nodeVoltages[b2.net('3V3')]).toBeGreaterThan(3.05);
    expect(op2.nodeVoltages[b2.net('3V3')]).toBeLessThan(3.12);
    expect(op2.warnings.some((w) => /dropout/.test(w))).toBe(true);
  });

  it('LDO current limit', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    b.add('V1', P.vsource(5), { 1: 'VIN', 2: 'GND' });
    b.add('U1', P.ldo(3.3, 0.3, 0, 0.1), { 3: 'VIN', 2: 'OUT', 1: 'GND' });
    b.add('RL', P.resistor(10), { 1: 'OUT', 2: 'GND' });
    const op = solveOp(buildCircuit(pk.project, { boardId: b.board.id }));
    expect(op.converged).toBe(true);
    expect(op.nodeVoltages[b.net('OUT')]).toBeCloseTo(1.0, 1);
    expect(op.warnings.some((w) => /current limit/.test(w))).toBe(true);
  });

  it('diode clamp to a rail and zener clamp', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    b.add('V1', P.vsource(10), { 1: 'HV', 2: 'GND' });
    b.add('V2', P.vsource(3.3), { 1: '3V3', 2: 'GND' });
    b.add('R1', P.resistor(1000), { 1: 'HV', 2: 'IN' });
    const d = b.add('D1', P.diode(0.7, 0.01), { 2: 'IN', 1: '3V3' });
    b.add('R2', P.resistor(1000), { 1: 'HV', 2: 'Z' });
    const z = b.add('D2', P.zener(5.1), { 1: 'Z', 2: 'GND' });
    const op = solveOp(buildCircuit(pk.project, { boardId: b.board.id }));
    expect(op.converged).toBe(true);
    const vin = op.nodeVoltages[b.net('IN')];
    expect(vin).toBeGreaterThan(3.3 + 0.55);
    expect(vin).toBeLessThan(3.3 + 0.8);
    expect(op.pinCurrents[d.id]['2']).toBeCloseTo((10 - vin) / 1000, 6);
    const vz = op.nodeVoltages[b.net('Z')];
    expect(vz).toBeGreaterThan(5.0);
    expect(vz).toBeLessThan(5.3);
    expect(op.pinCurrents[z.id]['1']).toBeCloseTo((10 - vz) / 1000, 6);
  });

  it('MOSFET low-side switch on/off with Vds·Id power', () => {
    for (const vg of [5, 0]) {
      const pk = new ProjectKit();
      const b = pk.board();
      b.add('V1', P.vsource(12), { 1: '12V', 2: 'GND' });
      b.add('VG', P.vsource(vg), { 1: 'G', 2: 'GND' });
      b.add('RL', P.resistor(12), { 1: '12V', 2: 'D' });
      const q = b.add('Q1', P.nmos(2, 0.05, 10), { 1: 'G', 2: 'GND', 3: 'D' });
      const op = solveOp(buildCircuit(pk.project, { boardId: b.board.id }));
      expect(op.converged).toBe(true);
      const vd = op.nodeVoltages[b.net('D')];
      if (vg === 5) {
        // K = 1/(0.05·8) = 2.5 A/V², Rds(5 V) = 1/(2.5·3) ≈ 0.133 Ω
        const id = op.pinCurrents[q.id]['3'];
        expect(near(id, 12 / (12 + 0.1333), 0.01)).toBe(true);
        expect(vd).toBeLessThan(0.2);
        expect(near(op.componentPower[q.id], vd * id, 0.02)).toBe(true);
      } else {
        expect(vd).toBeGreaterThan(11.99);
        expect(Math.abs(op.pinCurrents[q.id]['3'])).toBeLessThan(1e-6);
      }
    }
  });

  it('P-MOSFET high-side switch', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    b.add('V1', P.vsource(5), { 1: '5V', 2: 'GND' });
    b.add('VG', P.vsource(0), { 1: 'G', 2: 'GND' });
    b.add('Q1', P.pmos(1.5, 0.05, 4.5), { 1: 'G', 2: '5V', 3: 'LOAD' });
    b.add('RL', P.resistor(10), { 1: 'LOAD', 2: 'GND' });
    const op = solveOp(buildCircuit(pk.project, { boardId: b.board.id }));
    expect(op.converged).toBe(true);
    expect(op.nodeVoltages[b.net('LOAD')]).toBeGreaterThan(4.9);
  });

  it('NPN saturated switch and PNP', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    b.add('V1', P.vsource(5), { 1: '5V', 2: 'GND' });
    b.add('RB', P.resistor(10e3), { 1: '5V', 2: 'B' });
    b.add('RC', P.resistor(1e3), { 1: '5V', 2: 'C' });
    const q = b.add('Q1', P.npn(100), { 1: 'B', 2: 'GND', 3: 'C' });
    // active-region PNP: emitter at 5V via 1k, base held at 4V via divider
    b.add('RE2', P.resistor(1e3), { 1: '5V', 2: 'E2' });
    b.add('VB2', P.vsource(4), { 1: 'B2', 2: 'GND' });
    const q2 = b.add('Q2', P.pnp(100), { 1: 'B2', 2: 'E2', 3: 'C2' });
    b.add('RC2', P.resistor(1e3), { 1: 'C2', 2: 'GND' });
    const op = solveOp(buildCircuit(pk.project, { boardId: b.board.id }));
    expect(op.converged).toBe(true);
    expect(op.nodeVoltages[b.net('C')]).toBeLessThan(0.3);
    expect(op.nodeVoltages[b.net('B')]).toBeGreaterThan(0.6);
    expect(op.nodeVoltages[b.net('B')]).toBeLessThan(0.85);
    expect(op.pinCurrents[q.id]['1']).toBeCloseTo((5 - op.nodeVoltages[b.net('B')]) / 10e3, 7);
    // PNP: Ve ≈ 4 + 0.6..0.7, Ie ≈ (5 − Ve)/1k, Ic ≈ β/(β+1)·Ie
    const ve = op.nodeVoltages[b.net('E2')];
    expect(ve).toBeGreaterThan(4.5);
    expect(ve).toBeLessThan(4.8);
    const ie = (5 - ve) / 1e3;
    expect(near(-op.pinCurrents[q2.id]['3'], (ie * 100) / 101, 0.01)).toBe(true);
  });

  it('op-amp non-inverting amplifier and rail clamping', () => {
    for (const [vin, expected] of [
      [1, 2],
      [3, 5],
    ]) {
      const pk = new ProjectKit();
      const b = pk.board();
      b.add('V1', P.vsource(5), { 1: '5V', 2: 'GND' });
      b.add('VS', P.vsource(vin), { 1: 'IN', 2: 'GND' });
      b.add('U1', P.opamp(), { 1: 'OUT', 2: 'GND', 3: 'IN', 4: 'FB', 5: '5V' });
      b.add('RF', P.resistor(10e3), { 1: 'OUT', 2: 'FB' });
      b.add('RG', P.resistor(10e3), { 1: 'FB', 2: 'GND' });
      b.add('RL', P.resistor(2e3), { 1: 'OUT', 2: 'GND' });
      const op = solveOp(buildCircuit(pk.project, { boardId: b.board.id }));
      expect(op.converged).toBe(true);
      const vout = op.nodeVoltages[b.net('OUT')];
      if (expected === 2) expect(vout).toBeCloseTo(2, 3);
      else {
        // clamped at the 5 V rail, minus the drop across Rout (25 Ω) into 2k‖20k
        expect(vout).toBeCloseTo(5 * 1818.18 / (1818.18 + 25), 2);
      }
    }
  });

  it('buck converter: input current = Pout/(η·Vin), loss = Pin − Pout', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    const v = b.add('V1', P.vsource(12), { 1: '12V', 2: 'GND' });
    const u = b.add('U1', P.buck(5, 0.9, 0, 3), { 1: '12V', 2: 'GND', 3: '5V' });
    b.add('RL', P.resistor(10), { 1: '5V', 2: 'GND' });
    const op = solveOp(buildCircuit(pk.project, { boardId: b.board.id }));
    expect(op.converged).toBe(true);
    const vout = op.nodeVoltages[b.net('5V')];
    expect(Math.abs(vout - 5)).toBeLessThan(0.01);
    const pout = (vout * vout) / 10;
    expect(near(op.pinCurrents[u.id]['1'], pout / (0.9 * 12), 0.005)).toBe(true);
    expect(near(op.componentPower[u.id], pout / 0.9 - pout, 0.01)).toBe(true);
    expect(near(op.sourcePower![v.id], pout / 0.9, 0.005)).toBe(true);
  });

  it('IC supply current only above 1 V; switch override; inferred passives; DNP excluded', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    b.add('V1', P.vsource(3.3), { 1: '3V3', 2: 'GND' });
    const sw = b.add('SW1', P.switch(false), { 1: '3V3', 2: 'SWOUT' }, { simOverrides: { closed: true } });
    const u = b.add('U1', P.ic(0.01), { 1: 'SWOUT', 2: 'GND' });
    // inferred from category + instance value (no sim model)
    const rInf = makePart('resistor', undefined);
    const r = b.add('R5', rInf, { 1: '3V3', 2: 'X' }, { value: '4k7' });
    b.add('C5', makePart('capacitor', undefined, ['1', '2'], { value: '100nF' }), { 1: 'X', 2: 'GND' });
    b.add('R6', P.resistor(4700), { 1: 'X', 2: 'GND' });
    b.add('R7', P.resistor(1), { 1: '3V3', 2: 'GND' }, { dnp: true });
    const c = buildCircuit(pk.project, { boardId: b.board.id });
    const op = solveOp(c);
    expect(op.nodeVoltages[b.net('X')]).toBeCloseTo(1.65, 4);
    expect(op.componentPower[u.id]).toBeCloseTo(0.033, 3);
    expect(op.pinCurrents[sw.id]['1']).toBeCloseTo(0.01, 4);
    expect(op.componentPower[r.id]).toBeCloseTo(1.65 ** 2 / 4700, 6);
    expect(c.devices.some((d) => d.componentId && pk.project.boards[0].components.find((x) => x.ref === 'R7')?.id === d.componentId)).toBe(false);
    // supply below 1 V: no Icc
    const op2 = solveOp(buildCircuit(pk.project, { boardId: b.board.id }, { overrides: { V1: { V: 0.5 } } }));
    expect(op2.componentPower[u.id]).toBeLessThan(1e-6);
  });

  it('warns about floating nets and ties them through 1 GΩ', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    b.add('V1', P.vsource(5), { 1: '5V', 2: 'GND' });
    b.add('C1', P.capacitor(1e-6), { 1: '5V', 2: 'FLOAT' });
    b.add('C2', P.capacitor(1e-6), { 1: 'FLOAT', 2: 'GND' });
    const c = buildCircuit(pk.project, { boardId: b.board.id });
    expect(c.warnings.some((w) => /no DC path/.test(w) && /FLOAT/.test(w))).toBe(true);
    const op = solveOp(c);
    expect(op.converged).toBe(true);
    expect(Math.abs(op.nodeVoltages[b.net('FLOAT')])).toBeLessThan(1e-3);
  });

  it('warns when a resistor exceeds its power rating', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    b.add('V1', P.vsource(12), { 1: '12V', 2: 'GND' });
    const part = P.resistor(100);
    part.ratings = { power: 0.25 };
    b.add('R1', part, { 1: '12V', 2: 'GND' });
    const op = solveOp(buildCircuit(pk.project, { boardId: b.board.id }));
    expect(op.warnings.some((w) => /R1 dissipates/.test(w))).toBe(true);
  });
});

describe('multi-board system', () => {
  it('ties boards through interconnect conductor resistance', () => {
    const pk = new ProjectKit();
    const a = pk.board('Power');
    const bb = pk.board('Load');
    a.add('BT1', P.vsource(5), { 1: 'VBAT', 2: 'GND' });
    const j1 = a.add('J1', P.connector(2), { 1: 'VBAT', 2: 'GND' });
    const j2 = bb.add('J2', P.connector(2), { 1: 'VIN', 2: 'GND' });
    const rl = bb.add('RL', P.resistor(50), { 1: 'VIN', 2: 'GND' });
    const ic: Interconnect = {
      id: 'ic1',
      name: 'Harness',
      kind: 'cable',
      a: { boardId: a.board.id, componentId: j1.id },
      b: { boardId: bb.board.id, componentId: j2.id },
      conductors: [
        { id: 'w1', from: { boardId: a.board.id, componentId: j1.id, pin: '1' }, to: { boardId: bb.board.id, componentId: j2.id, pin: '1' } },
        { id: 'w2', from: { boardId: a.board.id, componentId: j1.id, pin: '2' }, to: { boardId: bb.board.id, componentId: j2.id, pin: '2' } },
      ],
      length: 500,
      awg: 26,
    };
    pk.project.interconnects.push(ic);
    const c = buildCircuit(pk.project, { system: true });
    const op = solveOp(c);
    expect(op.converged).toBe(true);
    const rw = 0.02 + 0.02 + awgOhmPerMeter(26) * 0.5;
    const i = 5 / (50 + 2 * rw);
    expect(op.conductorCurrents!.w1).toBeCloseTo(i, 6);
    expect(op.conductorCurrents!.w2).toBeCloseTo(-i, 6);
    const vin = op.nodeVoltages[bb.net('VIN')];
    const gndB = op.nodeVoltages[bb.net('GND')];
    expect(vin - gndB).toBeCloseTo(i * 50, 5);
    expect(gndB).toBeCloseTo(i * rw, 6);
    expect(op.netNames[bb.net('VIN')]).toBe('Load/VIN');
    expect(op.componentPower[rl.id]).toBeCloseTo(i * i * 50, 6);
    // board-only run of the load board: no source → everything at 0 V
    const solo = solveOp(buildCircuit(pk.project, { boardId: bb.board.id }));
    expect(solo.nodeVoltages[bb.net('VIN')]).toBeCloseTo(0, 9);
  });
});

describe('solveTransient', () => {
  it('RC step response: τ within 2%', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    const v = b.add('V1', P.vsource(5), { 1: 'IN', 2: 'GND' }, { simOverrides: { waveform: 'pulse', v1: 0, v2: 5, td: 1e-4, tr: 1e-7, tf: 1e-7, pw: 1, per: 2 } });
    b.add('R1', P.resistor(1e3), { 1: 'IN', 2: 'OUT' });
    b.add('C1', P.capacitor(1e-6), { 1: 'OUT', 2: 'GND' });
    const res = solveTransient(buildCircuit(pk.project, { boardId: b.board.id }), { tStop: 6e-3, tStep: 2e-5 });
    const t = toNumbers(res.time);
    const out = toFloat32(res.signals.find((s) => s.netId === b.net('OUT'))!.data);
    const target = 5 * (1 - Math.exp(-1));
    let tau = NaN;
    for (let i = 1; i < t.length; i++) {
      if (out[i - 1] < target && out[i] >= target) {
        tau = t[i - 1] + ((target - out[i - 1]) / (out[i] - out[i - 1])) * (t[i] - t[i - 1]) - 1e-4;
        break;
      }
    }
    expect(Math.abs(tau - 1e-3) / 1e-3).toBeLessThan(0.02);
    expect(out[out.length - 1]).toBeGreaterThan(4.95);
    const iSig = res.signals.find((s) => s.componentId === v.id && s.kind === 'current');
    expect(iSig).toBeDefined();
    expect(Object.keys(res.avgPower).length).toBeGreaterThan(0);
  });

  it('RL current rise with τ = L/R, sine and PWL sources', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    b.add('V1', P.vsource(1), { 1: 'IN', 2: 'GND' }, { simOverrides: { waveform: 'pwl', points: '0,0;1e-6,1;1,1' } });
    b.add('R1', P.resistor(10), { 1: 'IN', 2: 'X' });
    const l = b.add('L1', P.inductor(10e-3, 0), { 1: 'X', 2: 'GND' });
    b.add('V2', P.vsource(0), { 1: 'S', 2: 'GND' }, { simOverrides: { waveform: 'sin', vo: 1, va: 2, freq: 1000 } });
    b.add('R2', P.resistor(1e3), { 1: 'S', 2: 'GND' });
    const res = solveTransient(buildCircuit(pk.project, { boardId: b.board.id }), { tStop: 5e-3, tStep: 1e-5, probes: ['I(L1)', 'S', 'X'] });
    const t = toNumbers(res.time);
    const il = toFloat32(res.signals.find((s) => s.name === 'I(L1)')!.data);
    const idx = Array.from(t).findIndex((tt) => tt >= 1e-3 + 1e-6);
    expect(il[idx]).toBeGreaterThan(0.1 * (1 - Math.exp(-1)) * 0.97);
    expect(il[idx]).toBeLessThan(0.1 * (1 - Math.exp(-1)) * 1.03);
    const s = toFloat32(res.signals.find((x) => x.name === 'S')!.data);
    const i25 = Array.from(t).findIndex((tt) => tt >= 2.5e-4 - 1e-9);
    expect(s[i25]).toBeCloseTo(3, 1);
    expect(res.signals.length).toBe(3);
    expect(l.id).toBeTruthy();
  });
});

describe('performance', () => {
  it('200-node nonlinear circuit OP < 200 ms', () => {
    const pk = new ProjectKit();
    const b = pk.board();
    b.add('V1', P.vsource(5), { 1: 'N0', 2: 'GND' });
    for (let i = 0; i < 200; i++) {
      b.add(`R${i}`, P.resistor(100 + (i % 7) * 10), { 1: `N${i}`, 2: `N${i + 1}` });
      b.add(`RG${i}`, P.resistor(10e3), { 1: `N${i + 1}`, 2: 'GND' });
      if (i % 10 === 0) b.add(`D${i}`, P.led(2, 0.02), { 2: `N${i + 1}`, 1: 'GND' });
      if (i % 25 === 0) b.add(`C${i}`, P.capacitor(1e-6), { 1: `N${i + 1}`, 2: 'GND' });
    }
    const c = buildCircuit(pk.project, { boardId: b.board.id });
    expect(c.nodes.length).toBeGreaterThanOrEqual(200);
    const t0 = performance.now();
    const op = solveOp(c);
    const dt = performance.now() - t0;
    expect(op.converged).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`[perf] 200-node OP: ${dt.toFixed(1)} ms, ${op.iterations} iterations`);
    expect(dt).toBeLessThan(200);
  });
});
