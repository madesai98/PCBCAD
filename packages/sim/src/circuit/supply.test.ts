import { describe, expect, it } from 'vitest';
import { buildCircuit } from './build';
import { solveOp } from './analysis';
import { P, ProjectKit } from './testkit';

describe('external supplies on connectors', () => {
  it('powers the board through a connector pin (USB VBUS)', () => {
    const k = new ProjectKit();
    const b = k.board('Main');
    const j1 = b.add('J1', P.connector(2), { '1': 'VBUS', '2': 'GND' }, { supplies: [{ pin: '1', V: 5, Rint: 0.05, name: 'USB charger' }] });
    const r1 = b.add('R1', P.resistor(1000), { '1': 'VBUS', '2': 'GND' });
    const op = solveOp(buildCircuit(k.project, { boardId: b.board.id }));
    expect(op.converged).toBe(true);
    const vbus = b.board.nets.find((n) => n.name === 'VBUS')!.id;
    expect(op.nodeVoltages[vbus]).toBeCloseTo(5, 3);
    expect(op.componentPower[r1.id]).toBeCloseTo(0.025, 4);
    expect(op.sourcePower![j1.id]).toBeCloseTo(0.025, 4);
  });

  it('feeds a second board through a cable in system mode', () => {
    const k = new ProjectKit();
    const a = k.board('Main');
    const j1 = a.add('J1', P.connector(2), { '1': '5V', '2': 'GND' }, { supplies: [{ pin: '1', V: 5 }] });
    const ldo = a.add('U1', P.ldo(3.3, 0.3), { '1': 'GND', '2': '3V3', '3': '5V' });
    const op = solveOp(buildCircuit(k.project, { system: true }));
    expect(op.converged).toBe(true);
    const v33 = a.board.nets.find((n) => n.name === '3V3')!.id;
    expect(op.nodeVoltages[v33]).toBeCloseTo(3.3, 2);
    expect(j1.supplies?.length).toBe(1);
    expect(ldo.id).toBeTruthy();
  });

  it('warns when the supply pin is unconnected', () => {
    const k = new ProjectKit();
    const b = k.board('Main');
    b.add('J1', P.connector(2), { '2': 'GND' }, { supplies: [{ pin: '1', V: 5 }] });
    const c = buildCircuit(k.project, { boardId: b.board.id });
    expect(c.warnings.join('\n')).toMatch(/external supply pin '1' is not connected/);
  });
});
