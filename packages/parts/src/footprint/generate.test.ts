import { describe, expect, it } from 'vitest';
import type { FootprintDef, PackageFamily, PackageSpec, PadDef } from '@pcbcad/core';
import { padPolygonLocal } from '@pcbcad/core';
import { generateFootprint } from './generate';
import { clipSegmentOutside, padBox } from './builder';
import { ipcLand, FILLETS, range } from './ipc';

const pad = (fp: FootprintDef, n: string): PadDef => {
  const p = fp.pads.find((x) => x.number === n);
  if (!p) throw new Error(`pad ${n} missing in ${fp.name}`);
  return p;
};

/** Minimum copper gap between pads of different numbers (axis-aligned bbox approximation). */
function minGap(fp: FootprintDef): number {
  let best = Infinity;
  const boxes = fp.pads.filter((p) => p.kind !== 'npth').map((p) => ({ p, b: padBox(p) }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxes[i].p.number === boxes[j].p.number) continue;
      const a = boxes[i].b;
      const b = boxes[j].b;
      const dx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
      const dy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY));
      best = Math.min(best, Math.hypot(dx, dy));
    }
  }
  return best;
}

describe('IPC-7351B calculator', () => {
  it('reproduces the nominal 0805 land pattern', () => {
    const l = ipcLand({ L: range(2.0, 0.1), T: { min: 0.2, max: 0.5 }, W: range(1.25, 0.1), fillets: FILLETS.chip });
    expect(l.Z).toBeCloseTo(2.85, 6);
    expect(l.G).toBeCloseTo(0.95, 6);
    expect(l.X).toBeCloseTo(1.4, 6);
    expect(l.length).toBeCloseTo(0.95, 6);
    expect(l.center).toBeCloseTo(0.95, 6);
  });
  it('keeps gull-wing lands out from under the body (minGap)', () => {
    const l = ipcLand({ L: range(6.0, 0.2), T: { min: 0.4, max: 1.27 }, W: { min: 0.31, max: 0.51 }, fillets: FILLETS.gullWing, minGap: 3.85 });
    expect(l.G).toBeCloseTo(3.85, 6);
    expect(l.Z).toBeCloseTo(6.95, 6);
  });
});

describe('generateFootprint — IPC dimensions', () => {
  it('0805 chip: ~1.0 × 1.4 lands at ±0.95', () => {
    const fp = generateFootprint({ family: 'chip', size: '0805' });
    expect(fp.pads).toHaveLength(2);
    const p1 = pad(fp, '1');
    const p2 = pad(fp, '2');
    expect(p1.x).toBeCloseTo(-0.95, 3);
    expect(p2.x).toBeCloseTo(0.95, 3);
    expect(p1.w).toBeGreaterThanOrEqual(0.9);
    expect(p1.w).toBeLessThanOrEqual(1.1);
    expect(p1.h).toBeGreaterThanOrEqual(1.25);
    expect(p1.h).toBeLessThanOrEqual(1.45);
    expect(p1.shape).toBe('roundrect');
    expect(fp.source).toBe('generated');
    expect(fp.generator?.size).toBe('0805');
  });
  it('0402 and 1206 scale sensibly', () => {
    const a = generateFootprint({ family: 'chip', size: '0402' });
    const b = generateFootprint({ family: 'chip', size: '1206' });
    expect(pad(a, '2').x).toBeGreaterThan(0.4);
    expect(pad(a, '2').x).toBeLessThan(0.6);
    expect(pad(b, '2').x).toBeGreaterThan(1.3);
    expect(pad(b, '2').x).toBeLessThan(1.7);
  });
  it('SOIC-8: 1.27 pitch, 5.4 mm pad-centre span, pin 1 top-left, CCW', () => {
    const fp = generateFootprint({ family: 'soic', pins: 8 });
    expect(fp.pads).toHaveLength(8);
    const p1 = pad(fp, '1');
    const p2 = pad(fp, '2');
    const p8 = pad(fp, '8');
    const p4 = pad(fp, '4');
    const p5 = pad(fp, '5');
    expect(p1.y - p2.y).toBeCloseTo(1.27, 6);
    expect(p8.x - p1.x).toBeCloseTo(5.4, 2);
    expect(p1.x).toBeLessThan(0);
    expect(p1.y).toBeGreaterThan(0);
    expect(p4.y).toBeLessThan(0);
    expect(p5.x).toBeGreaterThan(0);
    expect(p5.y).toBeCloseTo(p4.y, 6);
    expect(p8.y).toBeCloseTo(p1.y, 6);
    expect(p1.w).toBeCloseTo(1.55, 2);
    expect(p1.h).toBeCloseTo(0.6, 2);
  });
  it('QFN-32 5×5 with exposed pad, corner clearance and pin order', () => {
    const fp = generateFootprint({ family: 'qfn', pins: 32, bodyW: 5, bodyL: 5, exposedPad: { w: 3.45, h: 3.45 } });
    expect(fp.pads).toHaveLength(33);
    const ep = pad(fp, '33');
    expect(ep.w).toBeCloseTo(3.45, 3);
    expect(ep.x).toBe(0);
    expect(ep.pasteRatio).toBeLessThan(1);
    const p1 = pad(fp, '1');
    expect(p1.x).toBeLessThan(-2);
    expect(p1.y).toBeCloseTo(1.75, 3);
    expect(pad(fp, '9').y).toBeLessThan(-2); // bottom row starts at pin 9
    expect(pad(fp, '17').x).toBeGreaterThan(2); // right column
    expect(pad(fp, '25').y).toBeGreaterThan(2); // top row
    expect(pad(fp, '2').y - pad(fp, '3').y).toBeCloseTo(0.5, 3);
    expect(minGap(fp)).toBeGreaterThanOrEqual(0.15);
  });
  it('QFN default exposed pad when the string gave none', () => {
    const fp = generateFootprint({ family: 'qfn', pins: 16, bodyW: 3, bodyL: 3 });
    expect(fp.pads).toHaveLength(17);
    const ep = pad(fp, '17');
    expect(ep.w).toBeGreaterThan(1);
    expect(ep.w).toBeLessThan(2);
  });
  it('TQFP-32 7×7 0.8: 1.5 × 0.55 lands on 8.45 mm', () => {
    const fp = generateFootprint({ family: 'qfp', pins: 32, bodyW: 7, bodyL: 7, pitch: 0.8 });
    const p1 = pad(fp, '1');
    expect(pad(fp, '17').x - p1.x).toBeCloseTo(8.45, 2);
    expect(p1.w).toBeCloseTo(1.5, 2);
    expect(p1.h).toBeCloseTo(0.55, 2);
    expect(p1.y).toBeCloseTo(2.8, 3);
  });
  it('SOT-23 pinout: 1 and 2 on the left, 3 on the right', () => {
    const fp = generateFootprint({ family: 'sot23', pins: 3 });
    expect(pad(fp, '1').x).toBeLessThan(0);
    expect(pad(fp, '2').x).toBeLessThan(0);
    expect(pad(fp, '3').x).toBeGreaterThan(0);
    expect(pad(fp, '1').y - pad(fp, '2').y).toBeCloseTo(1.9, 3);
  });
  it('SOT-223: three leads + wide tab numbered 4', () => {
    const fp = generateFootprint({ family: 'sot223' });
    expect(fp.pads.map((p) => p.number)).toEqual(['1', '2', '3', '4']);
    expect(pad(fp, '4').h).toBeGreaterThan(3);
    expect(pad(fp, '1').y - pad(fp, '3').y).toBeCloseTo(4.6, 3);
  });
  it('2-row header uses odd/even zig-zag numbering', () => {
    const fp = generateFootprint({ family: 'header', pins: 10, rows: 2, pitch: 2.54 });
    expect(fp.pads).toHaveLength(10);
    expect(pad(fp, '1').x).toBeCloseTo(pad(fp, '2').x, 6);
    expect(pad(fp, '1').y - pad(fp, '2').y).toBeCloseTo(2.54, 6);
    expect(pad(fp, '3').x - pad(fp, '1').x).toBeCloseTo(2.54, 6);
    expect(pad(fp, '1').shape).toBe('rect');
    expect(pad(fp, '1').kind).toBe('tht');
    expect(pad(fp, '1').drill).toBeCloseTo(1.0, 3);
    expect(fp.courtyard.maxX - fp.courtyard.minX).toBeGreaterThan(5 * 2.54);
  });
  it('JST PH 4P vertical: 2.0 mm pitch THT, connector courtyard margin', () => {
    const fp = generateFootprint({ family: 'jst-ph', pins: 4 });
    expect(fp.pads).toHaveLength(4);
    expect(pad(fp, '2').x - pad(fp, '1').x).toBeCloseTo(2.0, 6);
    expect(pad(fp, '1').drill).toBeCloseTo(0.75, 3);
    const body = 3 * 2 + 3.9;
    expect(fp.courtyard.maxX - fp.courtyard.minX).toBeGreaterThanOrEqual(body + 1.0 - 1e-6);
  });
  it('USB-C 16P receptacle: 12 signal pads, slotted shell tabs, locating holes', () => {
    const fp = generateFootprint({ family: 'usb-c', pins: 16 });
    const smd = fp.pads.filter((p) => p.kind === 'smd');
    expect(smd).toHaveLength(12);
    expect(new Set(smd.map((p) => p.number)).size).toBe(12);
    const shell = fp.pads.filter((p) => p.number === 'S1');
    expect(shell).toHaveLength(4);
    expect(shell.every((p) => p.slot && p.slot.h > p.slot.w)).toBe(true);
    expect(fp.pads.filter((p) => p.kind === 'npth')).toHaveLength(2);
    expect(pad(fp, 'A5').x).toBeCloseTo(-1.25, 3);
    expect(pad(fp, 'B5').x).toBeCloseTo(1.75, 3);
    expect(fp.courtyard.minY).toBeLessThan(-4.5); // body extends toward the mating face (−Y)
  });
  it('BGA uses JEDEC row letters', () => {
    const fp = generateFootprint({ family: 'bga', pins: 25, pitch: 0.8 });
    const nums = fp.pads.map((p) => p.number);
    expect(nums).toContain('A1');
    expect(nums).toContain('E5');
    expect(nums).not.toContain('I1');
    expect(pad(fp, 'A1').x).toBeLessThan(0);
    expect(pad(fp, 'A1').y).toBeGreaterThan(0);
  });
  it('LGA with clockwise numbering (Bosch) puts pin 1 top-right', () => {
    const fp = generateFootprint({ family: 'lga', pins: 8, bodyW: 2.5, bodyL: 2.5, pitch: 0.65, padW: 0.775, padH: 0.35, extra: { numbering: 'cw', padCenter: 1.2625 } });
    expect(pad(fp, '1').x).toBeCloseTo(1.2625, 4);
    expect(pad(fp, '1').y).toBeCloseTo(0.975, 4);
    expect(pad(fp, '4').y).toBeCloseTo(-0.975, 4);
    expect(pad(fp, '5').x).toBeCloseTo(-1.2625, 4);
    expect(pad(fp, '8').y).toBeCloseTo(0.975, 4);
    expect(pad(fp, '1').w).toBeCloseTo(0.775, 4);
  });
});

const FAMILY_SPECS: PackageSpec[] = [
  { family: 'chip', size: '0603', extra: { polarized: true } },
  { family: 'sod123', extra: { polarized: true } },
  { family: 'sod323' },
  { family: 'sma' },
  { family: 'smb' },
  { family: 'smc' },
  { family: 'melf' },
  { family: 'sot23', pins: 5 },
  { family: 'sot23', pins: 6 },
  { family: 'sot23', pins: 6, extra: { variant: 'sc70' } },
  { family: 'sot223' },
  { family: 'sot89' },
  { family: 'to252' },
  { family: 'to252', extra: { variant: 'd2pak' } },
  { family: 'soic', pins: 16, extra: { variant: 'wide' } },
  { family: 'ssop', pins: 20 },
  { family: 'tssop', pins: 20 },
  { family: 'msop', pins: 10 },
  { family: 'qfn', pins: 56, bodyW: 7, bodyL: 7, pitch: 0.4 },
  { family: 'qfn', pins: 20, bodyW: 3, bodyL: 4 },
  { family: 'dfn', pins: 8, bodyW: 3, bodyL: 3 },
  { family: 'qfp', pins: 48 },
  { family: 'qfp', pins: 100 },
  { family: 'lga', pins: 14, bodyW: 3, bodyL: 2.5 },
  { family: 'bga', pins: 64 },
  { family: 'dip', pins: 8 },
  { family: 'dip', pins: 40 },
  { family: 'to92' },
  { family: 'to220' },
  { family: 'header', pins: 4 },
  { family: 'header', pins: 6, rows: 2, pitch: 2.0, orientation: 'right-angle' },
  { family: 'header', pins: 8, pitch: 1.27, extra: { gender: 'female' } },
  { family: 'jst-ph', pins: 2, orientation: 'right-angle' },
  { family: 'jst-ph', pins: 3, orientation: 'right-angle', extra: { smd: true } },
  { family: 'jst-xh', pins: 4 },
  { family: 'jst-sh', pins: 4 },
  { family: 'jst-sh', pins: 6, orientation: 'vertical' },
  { family: 'usb-c', pins: 6 },
  { family: 'usb-micro' },
  { family: 'crystal-smd', size: '3225' },
  { family: 'crystal-smd', size: '2016' },
  { family: 'crystal-smd', size: '5032', pins: 2 },
  { family: 'hc49' },
  { family: 'electrolytic-smd', extra: { diameter: 6.3 } },
  { family: 'electrolytic-tht', extra: { diameter: 8 } },
  { family: 'inductor-smd', bodyW: 4, bodyL: 4 },
  { family: 'tactile-switch' },
  { family: 'tactile-switch', extra: { smd: false } },
  { family: 'led-tht' },
  { family: 'terminal-block', pins: 3, pitch: 5.08 },
  { family: 'battery-holder' },
  { family: 'module', pins: 38, pitch: 1.27, bodyW: 18, bodyL: 25.5, extra: { pinsLeft: 14, pinsBottom: 10, pinsRight: 14 } },
];

describe('generateFootprint — every family', () => {
  for (const spec of FAMILY_SPECS) {
    it(`${spec.family}${spec.pins ? `-${spec.pins}` : ''}${spec.extra ? ` ${JSON.stringify(spec.extra)}` : ''}`, () => {
      const fp = generateFootprint(spec);
      expect(fp.pads.length).toBeGreaterThan(0);
      expect(fp.source).toBe('generated');
      expect(fp.generator?.family).toBe(spec.family);
      // pads inside the courtyard; numeric values finite
      for (const p of fp.pads) {
        for (const [x, y] of padPolygonLocal(p, 8)) {
          expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
          expect(x).toBeGreaterThanOrEqual(fp.courtyard.minX - 1e-6);
          expect(x).toBeLessThanOrEqual(fp.courtyard.maxX + 1e-6);
          expect(y).toBeGreaterThanOrEqual(fp.courtyard.minY - 1e-6);
          expect(y).toBeLessThanOrEqual(fp.courtyard.maxY + 1e-6);
        }
        if (p.kind !== 'smd') expect(p.drill).toBeGreaterThan(0);
      }
      // no shorts between different pads
      expect(minGap(fp)).toBeGreaterThanOrEqual(0.1);
      // silkscreen clears copper by ≥ 0.15 mm
      const boxes = fp.pads.map(padBox);
      for (const g of fp.graphics) {
        if (g.layer !== 'silk' || g.kind !== 'line') continue;
        const grown = boxes.map((b) => ({ minX: b.minX - 0.15, minY: b.minY - 0.15, maxX: b.maxX + 0.15, maxY: b.maxY + 0.15 }));
        const kept = clipSegmentOutside(g.a, g.b, grown);
        const len = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]);
        const keptLen = kept.reduce((s, [a, b]) => s + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
        expect(keptLen).toBeCloseTo(len, 3);
      }
      // a courtyard outline and a fab outline exist
      expect(fp.graphics.some((g) => g.layer === 'courtyard')).toBe(true);
      expect(fp.graphics.some((g) => g.layer === 'fab')).toBe(true);
    });
  }

  it('falls back to a body-only footprint for custom specs', () => {
    const fp = generateFootprint({ family: 'custom' as PackageFamily, bodyW: 3, bodyL: 2 });
    expect(fp.pads).toHaveLength(0);
    expect(fp.courtyard.maxX).toBeGreaterThan(1.5);
  });
});
