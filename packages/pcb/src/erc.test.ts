import { describe, expect, it } from 'vitest';
import { runErc } from './erc';
import { comp, emptyBoard, makePart, stdParts, wire } from './test-fixtures';

function mcuBoard() {
  const parts = stdParts();
  parts.reg = makePart('reg', 'ldo', undefined, [
    { number: '1', name: 'GND', type: 'power_in' },
    { number: '2', name: 'VOUT', type: 'power_out' },
    { number: '3', name: 'VIN', type: 'power_in' },
  ]);
  const b = emptyBoard(40, 30);
  b.components.push(comp('u1', 'U1', 'mcu', 20, 15), comp('j1', 'J1', 'hdr4', 3, 15), comp('c1', 'C1', 'cap', 20, 22));
  wire(b, 'VCC', ['U1.1', 'J1.1', 'C1.1']);
  wire(b, 'GND', ['U1.2', 'J1.2', 'C1.2']);
  wire(b, 'XIN', ['U1.19', 'J1.3']);
  return { b, parts };
}

describe('runErc', () => {
  it('is quiet on a sane design', () => {
    const { b, parts } = mcuBoard();
    const issues = runErc(b, parts);
    expect(issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('reports missing decoupling capacitors', () => {
    const { b, parts } = mcuBoard();
    b.components = b.components.filter((c) => c.id !== 'c1');
    const issues = runErc(b, parts).filter((i) => i.code === 'missing-decoupling');
    expect(issues).toHaveLength(1);
    expect(issues[0].target?.componentIds).toEqual(['u1']);
    expect(issues[0].category).toBe('erc');
    // a capacitor between VCC and a signal net does not count
    b.components.push(comp('c2', 'C2', 'cap', 0, 0));
    wire(b, 'X', ['C2.2']);
    b.components[b.components.length - 1].pinNets['1'] = 'net_VCC';
    expect(runErc(b, parts).some((i) => i.code === 'missing-decoupling')).toBe(true);
  });

  it('reports single-pin nets', () => {
    const { b, parts } = mcuBoard();
    const id = wire(b, 'LONELY', ['U1.5']);
    const issues = runErc(b, parts).filter((i) => i.code === 'single-pin-net');
    expect(issues.map((i) => i.target?.netIds?.[0])).toEqual([id]);
  });

  it('reports unconnected power pins, output conflicts, nc pins and floating inputs', () => {
    const parts = stdParts();
    parts.drv = makePart('drv', 'logic', undefined, [
      { number: '1', name: 'Y', type: 'output' },
      { number: '2', name: 'VCC', type: 'power_in' },
      { number: '3', name: 'NC', type: 'nc' },
      { number: '4', name: 'A', type: 'input' },
    ]);
    const b = emptyBoard(20, 20);
    b.components.push(comp('a', 'U1', 'drv', 5, 5), comp('b', 'U2', 'drv', 10, 5));
    wire(b, 'OUT', ['U1.1', 'U2.1']);
    wire(b, 'X', ['U1.3', 'U2.4']);
    const codes = runErc(b, parts).map((i) => i.code);
    expect(codes).toContain('output-conflict');
    expect(codes).toContain('unconnected-power-pin');
    expect(codes).toContain('nc-connected');
    expect(codes).toContain('floating-input'); // U1.4 unconnected
  });

  it('warns when a power net has no source, honouring pass-through parts', () => {
    const parts = stdParts();
    parts.fuse = makePart('fuse', 'fuse', undefined, [
      { number: '1', name: '1' },
      { number: '2', name: '2' },
    ]);
    const b = emptyBoard(40, 30);
    b.components.push(comp('u1', 'U1', 'mcu', 20, 15), comp('c1', 'C1', 'cap', 20, 22));
    wire(b, 'VCC', ['U1.1', 'C1.1']);
    wire(b, 'GND', ['U1.2', 'C1.2']);
    let issues = runErc(b, parts).filter((i) => i.code === 'no-power-source');
    expect(issues.map((i) => i.target?.netIds?.[0]).sort()).toEqual(['net_GND', 'net_VCC']);
    // supply arrives through a fuse from a connector
    b.components.push(comp('j1', 'J1', 'hdr4', 3, 15), comp('f1', 'F1', 'fuse', 8, 15));
    wire(b, 'VIN', ['J1.1', 'F1.1']);
    wire(b, 'VCC', ['F1.2']);
    wire(b, 'GND', ['J1.2']);
    issues = runErc(b, parts).filter((i) => i.code === 'no-power-source');
    expect(issues).toEqual([]);
  });
});

describe('runErc — same-component outputs', () => {
  it('does not flag two output pins of one regulator (VOUT + tab) as a conflict', async () => {
    const { createBoard } = await import('@pcbcad/core');
    const b = createBoard('t', 20, 20);
    const part: any = {
      id: 'ldo', mpn: 'AMS1117-3.3', manufacturer: 'x', description: '', category: 'ldo', package: 'SOT-223', params: {}, offers: [],
      pins: [
        { number: '1', name: 'GND', type: 'power_in' },
        { number: '2', name: 'VOUT', type: 'power_out' },
        { number: '3', name: 'VIN', type: 'power_in' },
        { number: '4', name: 'VOUT', type: 'power_out' },
      ],
      provenance: { specs: 'builtin', symbol: 'builtin', footprint: 'builtin', model3d: 'builtin', sim: 'builtin', source: 't' },
    };
    b.nets.push({ id: 'n33', name: '3V3', class: 'power' }, { id: 'ngnd', name: 'GND', class: 'ground' });
    b.components.push({ id: 'u1', ref: 'U1', partId: 'ldo', x: 5, y: 5, rotation: 0, side: 'top', placed: true, pinNets: { '1': 'ngnd', '2': 'n33', '4': 'n33' } });
    const codes = runErc(b, { ldo: part }).map((i) => i.code);
    expect(codes).not.toContain('output-conflict');
  });
});
