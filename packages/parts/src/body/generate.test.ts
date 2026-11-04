import { describe, expect, it } from 'vitest';
import type { BodyPrimitive, PackageSpec, PartCategory } from '@pcbcad/core';
import { generateFootprint } from '../footprint/generate';
import { generateBody } from './generate';
import { alignmentTurn, rotatePrimitivesZ } from './transform';

function zRange(p: BodyPrimitive): [number, number] {
  if (p.kind === 'box') return [p.center[2] - p.size[2] / 2, p.center[2] + p.size[2] / 2];
  if (p.kind === 'cylinder') return p.axis === 'z' ? [p.center[2] - p.height / 2, p.center[2] + p.height / 2] : [p.center[2] - p.radius, p.center[2] + p.radius];
  return [p.z0, p.z1];
}

function xyExtent(prims: BodyPrimitive[]): { minX: number; maxX: number; minY: number; maxY: number } {
  const e = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const add = (x: number, y: number) => {
    e.minX = Math.min(e.minX, x);
    e.maxX = Math.max(e.maxX, x);
    e.minY = Math.min(e.minY, y);
    e.maxY = Math.max(e.maxY, y);
  };
  for (const p of prims) {
    if (p.kind === 'box') {
      add(p.center[0] - p.size[0] / 2, p.center[1] - p.size[1] / 2);
      add(p.center[0] + p.size[0] / 2, p.center[1] + p.size[1] / 2);
    } else if (p.kind === 'cylinder') {
      const hx = p.axis === 'x' ? p.height / 2 : p.radius;
      const hy = p.axis === 'y' ? p.height / 2 : p.radius;
      add(p.center[0] - hx, p.center[1] - hy);
      add(p.center[0] + hx, p.center[1] + hy);
    } else for (const [x, y] of p.points) add(x, y);
  }
  return e;
}

const CASES: [PackageSpec, PartCategory?][] = [
  [{ family: 'chip', size: '0805' }, 'resistor'],
  [{ family: 'chip', size: '0805' }, 'capacitor'],
  [{ family: 'chip', size: '0603', extra: { polarized: true } }, 'led'],
  [{ family: 'chip', size: '1206' }, 'capacitor-polarized'],
  [{ family: 'sod123' }, 'diode'],
  [{ family: 'sma' }, 'schottky'],
  [{ family: 'melf' }, 'diode'],
  [{ family: 'sot23', pins: 3 }, 'mosfet-n'],
  [{ family: 'sot223' }, 'ldo'],
  [{ family: 'sot89' }, 'ldo'],
  [{ family: 'to252' }, 'mosfet-n'],
  [{ family: 'soic', pins: 8 }, 'ic'],
  [{ family: 'tssop', pins: 20 }, 'ic'],
  [{ family: 'qfp', pins: 32, bodyW: 7, bodyL: 7, pitch: 0.8 }, 'mcu'],
  [{ family: 'qfn', pins: 32 }, 'ic'],
  [{ family: 'dfn', pins: 8 }, 'ic'],
  [{ family: 'lga', pins: 8, bodyW: 2.5, bodyL: 2.5 }, 'sensor'],
  [{ family: 'bga', pins: 36 }, 'ic'],
  [{ family: 'dip', pins: 8 }, 'ic'],
  [{ family: 'to92' }, 'bjt-npn'],
  [{ family: 'to220' }, 'ldo'],
  [{ family: 'header', pins: 6, rows: 2 }, 'connector'],
  [{ family: 'header', pins: 4, orientation: 'right-angle' }, 'connector'],
  [{ family: 'header', pins: 4, extra: { gender: 'female' } }, 'connector'],
  [{ family: 'jst-ph', pins: 4 }, 'connector'],
  [{ family: 'jst-xh', pins: 3, orientation: 'right-angle' }, 'connector'],
  [{ family: 'jst-sh', pins: 4 }, 'connector'],
  [{ family: 'usb-c' }, 'connector'],
  [{ family: 'usb-micro' }, 'connector'],
  [{ family: 'crystal-smd', size: '3225' }, 'crystal'],
  [{ family: 'hc49' }, 'crystal'],
  [{ family: 'electrolytic-smd', extra: { diameter: 6.3 } }, 'capacitor-polarized'],
  [{ family: 'electrolytic-tht', extra: { diameter: 8 } }, 'capacitor-polarized'],
  [{ family: 'inductor-smd' }, 'inductor'],
  [{ family: 'tactile-switch' }, 'button'],
  [{ family: 'led-tht' }, 'led'],
  [{ family: 'terminal-block', pins: 2 }, 'connector'],
  [{ family: 'battery-holder' }, 'battery'],
  [{ family: 'module', pins: 16 }, 'module'],
];

describe('generateBody', () => {
  for (const [spec, category] of CASES) {
    it(`${spec.family}${spec.pins ? `-${spec.pins}` : ''} (${category})`, () => {
      const prims = generateBody(spec, { category });
      expect(prims.length).toBeGreaterThan(0);
      for (const p of prims) {
        const [z0, z1] = zRange(p);
        expect(Number.isFinite(z0) && Number.isFinite(z1)).toBe(true);
        expect(z0).toBeGreaterThanOrEqual(-3.0001); // THT leads stop 3 mm below the board surface
        expect(z1).toBeGreaterThan(z0 - 1e-9);
        expect(p.color).toMatch(/^#[0-9a-f]{6}$/i);
      }
      // something sits on / above the board
      expect(Math.max(...prims.map((p) => zRange(p)[1]))).toBeGreaterThan(0.1);
      // the body stays within the footprint courtyard (plus mating pins for headers)
      const fp = generateFootprint(spec);
      const e = xyExtent(prims);
      const slack = spec.family === 'header' || spec.family === 'jst-sh' ? 7 : 0.6;
      expect(e.minX).toBeGreaterThanOrEqual(fp.courtyard.minX - slack);
      expect(e.maxX).toBeLessThanOrEqual(fp.courtyard.maxX + slack);
      expect(e.minY).toBeGreaterThanOrEqual(fp.courtyard.minY - slack);
      expect(e.maxY).toBeLessThanOrEqual(fp.courtyard.maxY + slack);
    });
  }

  it('chip resistor: white substrate, black top, tinned end caps', () => {
    const prims = generateBody({ family: 'chip', size: '0805' }, { category: 'resistor' });
    expect(prims.some((p) => p.kind === 'box' && p.color === '#161616')).toBe(true);
    expect(prims.filter((p) => p.metal).length).toBe(2);
  });
  it('ceramic capacitor is tan; LED lens takes the requested colour', () => {
    expect(generateBody({ family: 'chip', size: '0603' }, { category: 'capacitor' }).some((p) => p.color === '#c9a777')).toBe(true);
    const led = generateBody({ family: 'chip', size: '0603', extra: { polarized: true } }, { category: 'led', color: 'red' });
    expect(led.some((p) => p.color === '#ff3b30')).toBe(true);
  });
  it('USB-C shell is metal; JST housing is natural white; header pins are gold', () => {
    expect(generateBody({ family: 'usb-c' })[0].metal).toBe(true);
    expect(generateBody({ family: 'jst-ph', pins: 2 })[0].color).toBe('#efe8d4');
    expect(generateBody({ family: 'header', pins: 2 }).some((p) => p.color === '#d2a83e' && p.metal)).toBe(true);
  });
  it('gull-wing leads land on their pads', () => {
    const spec: PackageSpec = { family: 'soic', pins: 8 };
    const fp = generateFootprint(spec);
    const prims = generateBody(spec);
    // every pad has a metal box touching the board (z0 = 0) whose centre lies inside the pad
    for (const pad of fp.pads) {
      const hit = prims.some(
        (p) => p.kind === 'box' && p.metal && Math.abs(p.center[2] - p.size[2] / 2) < 1e-6 && Math.abs(p.center[0] - pad.x) < pad.w / 2 + 0.3 && Math.abs(p.center[1] - pad.y) < pad.h / 2,
      );
      expect(hit, `lead on pad ${pad.number}`).toBe(true);
    }
  });
});

describe('primitive alignment', () => {
  it('rotates primitives by quarter turns', () => {
    const r = rotatePrimitivesZ([{ kind: 'box', center: [1, 0, 0.5], size: [2, 1, 1], color: '#000000' }], 90);
    expect(r[0].kind === 'box' && r[0].center[0]).toBeCloseTo(0, 6);
    expect(r[0].kind === 'box' && r[0].center[1]).toBeCloseTo(1, 6);
    expect(r[0].kind === 'box' && r[0].size[0]).toBe(1);
  });
  it('finds the quarter turn between footprints from pad 1', () => {
    const gen = generateFootprint({ family: 'qfp', pins: 32, bodyW: 7, bodyL: 7, pitch: 0.8 });
    const rotated = { ...gen, pads: gen.pads.map((p) => ({ ...p, x: -p.y, y: p.x })) };
    expect(alignmentTurn(rotated, gen)).toBe(90);
    expect(alignmentTurn(gen, gen)).toBe(0);
  });
});
