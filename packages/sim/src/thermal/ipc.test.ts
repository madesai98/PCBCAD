import { describe, expect, it } from 'vitest';
import { ipc2221AreaMil2, ipc2221Capacity, ipc2221TempRise } from './ipc';

describe('IPC-2221', () => {
  it('10 mil, 1 oz external at 10 °C rise carries ≈ 0.88 A', () => {
    const I = ipc2221Capacity(0.254, 1, 10, true);
    expect(I).toBeGreaterThan(0.86);
    expect(I).toBeLessThan(0.9);
  });

  it('matches published chart points', () => {
    // 100 mil, 1 oz, 10 °C external ≈ 4.7 A (IPC-2221 chart / common calculators)
    expect(ipc2221Capacity(2.54, 1, 10, true)).toBeCloseTo(4.67, 0);
    // 20 °C rise is (2)^0.44 = 1.357× the 10 °C capacity
    expect(ipc2221Capacity(0.5, 1, 20, true) / ipc2221Capacity(0.5, 1, 10, true)).toBeCloseTo(Math.pow(2, 0.44), 6);
  });

  it('internal conductors carry half the current of external ones', () => {
    expect(ipc2221Capacity(0.3, 0.5, 10, false)).toBeCloseTo(ipc2221Capacity(0.3, 0.5, 10, true) / 2, 10);
  });

  it('temperature rise is the inverse of the capacity formula', () => {
    for (const [w, oz, dT, ext] of [
      [0.2, 1, 5, true],
      [1.5, 2, 30, false],
      [0.15, 0.5, 60, true],
    ] as const) {
      const I = ipc2221Capacity(w, oz, dT, ext);
      expect(ipc2221TempRise(I, w, oz, ext)).toBeCloseTo(dT, 8);
      expect(ipc2221TempRise(-I, w, oz, ext)).toBeCloseTo(dT, 8);
    }
  });

  it('handles degenerate inputs', () => {
    expect(ipc2221AreaMil2(0, 1)).toBe(0);
    expect(ipc2221Capacity(0, 1, 10, true)).toBe(0);
    expect(ipc2221Capacity(1, 1, 0, true)).toBe(0);
    expect(ipc2221TempRise(0, 1, 1, true)).toBe(0);
    expect(ipc2221TempRise(1, 0, 1, true)).toBe(Infinity);
  });
});
