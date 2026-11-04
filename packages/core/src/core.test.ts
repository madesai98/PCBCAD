import { describe, expect, it } from 'vitest';
import { parseValue, formatValue, parseRange, awgOhmPerMeter } from './units';
import { effectiveMaterial } from './materials';
import { footprintToBoard, boardToFootprint, mat4FromEuler, transformPoint, polygonArea, roundedRectPolygon } from './geometry';
import { pack, unpack, toFloat32 } from './packed';
import { createProject, createBoard } from './factory';
import { parsePinRef, resolvePins } from './netlist';

describe('units', () => {
  it('parses engineering notation', () => {
    expect(parseValue('10k')).toBe(10000);
    expect(parseValue('4k7')).toBeCloseTo(4700);
    expect(parseValue('2R2')).toBeCloseTo(2.2);
    expect(parseValue('100nF')).toBeCloseTo(1e-7);
    expect(parseValue('4.7 µF')).toBeCloseTo(4.7e-6);
    expect(parseValue('1MΩ')).toBe(1e6);
    expect(parseValue('500mA')).toBeCloseTo(0.5);
    expect(parseValue('16MHz')).toBe(16e6);
    expect(parseValue('0R')).toBe(0);
    expect(parseValue('3.3V')).toBeCloseTo(3.3);
    expect(parseValue('abc')).toBeUndefined();
  });
  it('formats values', () => {
    expect(formatValue(4700, 'Ω')).toBe('4.7 kΩ');
    expect(formatValue(1e-7, 'F')).toBe('100 nF');
  });
  it('parses ranges', () => {
    expect(parseRange('1.71V~3.6V')).toEqual([1.71, 3.6]);
    expect(parseRange('-40℃~+85℃')).toEqual([-40, 85]);
  });
  it('awg resistance', () => {
    expect(awgOhmPerMeter(24)).toBeGreaterThan(0.08);
    expect(awgOhmPerMeter(24)).toBeLessThan(0.09);
  });
});

describe('materials', () => {
  it('applies process adjustments', () => {
    const molded = effectiveMaterial('pa66-gf30', 'injection-molding');
    expect(molded.E).toBeCloseTo(9500 * 0.75);
    const printed = effectiveMaterial('abs', 'fdm-printing', { infill: 0.2 });
    expect(printed.yieldStrength).toBeLessThan(43);
    const anod = effectiveMaterial('al-5052-h32', 'sheet-metal', { finish: 'anodized-black' });
    expect(anod.emissivity).toBe(0.88);
  });
});

describe('geometry', () => {
  it('round-trips footprint transforms incl. bottom side', () => {
    for (const side of ['top', 'bottom'] as const) {
      const c = { x: 10, y: 5, rotation: 90, side };
      const p = footprintToBoard(c, [1, 2]);
      const q = boardToFootprint(c, p);
      expect(q[0]).toBeCloseTo(1);
      expect(q[1]).toBeCloseTo(2);
    }
    expect(footprintToBoard({ x: 0, y: 0, rotation: 90, side: 'top' }, [1, 0])[1]).toBeCloseTo(1);
  });
  it('euler matrix matches 90deg about Z', () => {
    const p = transformPoint(mat4FromEuler([0, 0, 90]), [1, 0, 0]);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(1);
  });
  it('rounded rect is CCW with ~ correct area', () => {
    const poly = roundedRectPolygon(0, 0, 50, 30, 2);
    expect(polygonArea(poly)).toBeGreaterThan(50 * 30 - 4 * 4 + 0.5);
    expect(polygonArea(poly)).toBeLessThan(50 * 30);
  });
});

describe('packed arrays', () => {
  it('round-trips', () => {
    const a = new Float32Array([1.5, -2, 3.25]);
    const p = pack(a);
    expect(Array.from(unpack(p) as Float32Array)).toEqual([1.5, -2, 3.25]);
    expect(Array.from(toFloat32([1, 2]))).toEqual([1, 2]);
  });
});

describe('factory/netlist', () => {
  it('creates a project and board', () => {
    const p = createProject('x');
    const b = createBoard('Main', 50, 30);
    p.boards.push(b);
    expect(b.outline.length).toBeGreaterThan(4);
    expect(parsePinRef('U1.VDD')).toEqual({ ref: 'U1', pin: 'VDD' });
    expect(parsePinRef('R10:2')).toEqual({ ref: 'R10', pin: '2' });
    const part: any = { pins: [{ number: '1', name: 'GND', type: 'power_in' }, { number: '2', name: 'VDD', type: 'power_in' }, { number: '9', name: 'GND', type: 'power_in' }] };
    expect(resolvePins(part, 'gnd')).toEqual(['1', '9']);
    expect(resolvePins(part, '2')).toEqual(['2']);
  });
});
