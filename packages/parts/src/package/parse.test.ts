import { describe, expect, it } from 'vitest';
import type { PackageSpec } from '@pcbcad/core';
import { parsePackageName, type PackageContext } from './parse';

type Expect = Partial<Omit<PackageSpec, 'extra'>> & { extra?: Record<string, string | number | boolean> };

/** Real distributor / EasyEDA package strings → expected key fields. */
const CASES: [string, PackageContext, Expect][] = [
  ['0402', {}, { family: 'chip', size: '0402' }],
  ['0603', { category: 'capacitor' }, { family: 'chip', size: '0603' }],
  ['0805', { category: 'resistor' }, { family: 'chip', size: '0805', bodyW: 2.0, bodyL: 1.25 }],
  ['1206', {}, { family: 'chip', size: '1206' }],
  ['R0805', {}, { family: 'chip', size: '0805' }],
  ['C0603', {}, { family: 'chip', size: '0603' }],
  ['2012', { category: 'resistor' }, { family: 'chip', size: '0805' }],
  ['LED-SMD_L1.6-W0.8-R-RD', { category: 'led' }, { family: 'chip', size: '0603', extra: { polarized: true } }],
  ['SOT-23', {}, { family: 'sot23', pins: 3, pitch: 0.95 }],
  ['SOT-23-3', {}, { family: 'sot23', pins: 3 }],
  ['SOT-23-5', {}, { family: 'sot23', pins: 5 }],
  ['SOT-23-6', {}, { family: 'sot23', pins: 6 }],
  ['SOT-23-3_L2.9-W1.3-P1.90-LS2.4-BR', {}, { family: 'sot23', pins: 3, leadSpan: 2.4 }],
  ['SC-70-5', {}, { family: 'sot23', pins: 5, extra: { variant: 'sc70' } }],
  ['SOT-223', {}, { family: 'sot223', pins: 4 }],
  ['SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR', {}, { family: 'sot223', pins: 4, leadSpan: 7.0 }],
  ['SOT-89', {}, { family: 'sot89', pins: 3 }],
  ['SOD-123', { category: 'diode' }, { family: 'sod123', extra: { polarized: true } }],
  ['SOD-123F_L2.7-W1.6-LS3.8-RD', {}, { family: 'sod123', leadSpan: 3.8, bodyW: 2.7 }],
  ['SOD-323', {}, { family: 'sod323' }],
  ['SMA(DO-214AC)', { category: 'schottky' }, { family: 'sma' }],
  ['SMA', {}, { family: 'sma' }],
  ['SMB(DO-214AA)', {}, { family: 'smb' }],
  ['SMC', {}, { family: 'smc' }],
  ['SOIC-8', {}, { family: 'soic', pins: 8, pitch: 1.27, bodyW: 3.9, bodyL: 4.9 }],
  ['SOP-8', {}, { family: 'soic', pins: 8 }],
  ['SOP-16', {}, { family: 'soic', pins: 16, bodyL: 9.9 }],
  ['SOIC-16_3.9x9.9mm', {}, { family: 'soic', pins: 16, bodyW: 3.9, bodyL: 9.9 }],
  ['SOP-16_L10.0-W3.9-P1.27-LS6.0-BL', {}, { family: 'soic', pins: 16, bodyW: 3.9, bodyL: 10.0, leadSpan: 6.0 }],
  ['SOIC-16W', {}, { family: 'soic', pins: 16, bodyW: 7.5, extra: { variant: 'wide' } }],
  ['TSSOP-20', {}, { family: 'tssop', pins: 20, pitch: 0.65, bodyW: 4.4 }],
  ['MSOP-10', {}, { family: 'msop', pins: 10, pitch: 0.5 }],
  ['MSOP-8', {}, { family: 'msop', pins: 8, pitch: 0.65 }],
  ['SSOP-28', {}, { family: 'ssop', pins: 28 }],
  ['QFN-32(5x5)', {}, { family: 'qfn', pins: 32, bodyW: 5, bodyL: 5, pitch: 0.5 }],
  ['QFN-16-EP(3x3)', {}, { family: 'qfn', pins: 16, bodyW: 3, pitch: 0.5 }],
  ['LQFN-56_L7.0-W7.0-P0.4-EP', {}, { family: 'qfn', pins: 56, bodyW: 7, bodyL: 7, pitch: 0.4 }],
  ['LQFN-56(7x7)', {}, { family: 'qfn', pins: 56, pitch: 0.4 }],
  ['VQFN-16-EP(3x3)', {}, { family: 'qfn', pins: 16 }],
  ['DFN-8(3x3)', {}, { family: 'dfn', pins: 8, bodyW: 3, pitch: 0.65 }],
  ['DFN-6(2x2)', {}, { family: 'dfn', pins: 6, pitch: 0.65 }],
  ['LGA-8(2.5x2.5)', {}, { family: 'lga', pins: 8, bodyW: 2.5, bodyL: 2.5, pitch: 0.65 }],
  ['TQFP-32(7x7)', {}, { family: 'qfp', pins: 32, bodyW: 7, pitch: 0.8, leadSpan: 9 }],
  ['LQFP-48(7x7)', {}, { family: 'qfp', pins: 48, bodyW: 7, pitch: 0.5 }],
  ['LQFP-64(10x10)', {}, { family: 'qfp', pins: 64, bodyW: 10, pitch: 0.5 }],
  ['TQFP-32_L7.0-W7.0-P0.80-LS9.0-BL', {}, { family: 'qfp', pins: 32, pitch: 0.8, leadSpan: 9.0 }],
  ['BGA-64', {}, { family: 'bga', pins: 64 }],
  ['DIP-8', {}, { family: 'dip', pins: 8, pitch: 2.54 }],
  ['PDIP-28', {}, { family: 'dip', pins: 28 }],
  ['TO-92', {}, { family: 'to92', pins: 3 }],
  ['TO-220', {}, { family: 'to220', pins: 3 }],
  ['TO-220-5', {}, { family: 'to220', pins: 5 }],
  ['TO-252', {}, { family: 'to252' }],
  ['TO-252-2(DPAK)', {}, { family: 'to252', extra: { leads: 2 } }],
  ['Plugin,P=2mm', { mpn: 'B4B-PH-K-S(LF)(SN)', category: 'connector' }, { family: 'jst-ph', pins: 4, pitch: 2.0, orientation: 'vertical' }],
  ['Plugin,P=2mm', { mpn: 'S2B-PH-K-S(LF)(SN)', category: 'connector' }, { family: 'jst-ph', pins: 2, orientation: 'right-angle' }],
  ['Plugin,P=2.5mm', { mpn: 'B2B-XH-A(LF)(SN)', category: 'connector' }, { family: 'jst-xh', pins: 2, pitch: 2.5 }],
  ['SMD,P=1mm,Surface Mount，Right Angle', { mpn: 'SM04B-SRSS-TB(LF)(SN)', category: 'connector' }, { family: 'jst-sh', pins: 4, pitch: 1.0, orientation: 'right-angle' }],
  ['Plugin,P=2.54mm', { category: 'connector', description: '1x4P 2.54mm Pin Header Through Hole' }, { family: 'header', pins: 4, rows: 1, pitch: 2.54 }],
  ['Plugin,P=2.54mm', { category: 'connector', description: '2x5P 2.54mm Female Headers' }, { family: 'header', pins: 10, rows: 2, extra: { gender: 'female' } }],
  ['HDR-TH_4P-P2.54-V-M', {}, { family: 'header', pins: 4, pitch: 2.54 }],
  ['Plugin,P=5mm', { category: 'connector', description: '1x2P 5mm Green Through Hole Screw Terminal Blocks', pins: 2 }, { family: 'terminal-block', pins: 2, pitch: 5 }],
  ['SMD', { category: 'connector', mpn: 'TYPE-C-31-M-12', description: '16P Female Type-C USB Connectors' }, { family: 'usb-c', pins: 16 }],
  ['USB-C_SMD-TYPE-C-31-M-12_1', {}, { family: 'usb-c', pins: 16 }],
  ['MICRO-USB-SMD_5P-P0.65-H-F_C10418', {}, { family: 'usb-micro', pins: 5 }],
  ['HC-49US', { category: 'crystal' }, { family: 'hc49', extra: { variant: 'hc49s' } }],
  ['HC-49/U', { category: 'crystal' }, { family: 'hc49', extra: { variant: 'hc49u' } }],
  ['3225', { category: 'crystal' }, { family: 'crystal-smd', size: '3225', pins: 4 }],
  ['SMD3225-4P', {}, { family: 'crystal-smd', size: '3225', pins: 4, bodyW: 3.2, bodyL: 2.5 }],
  ['SMD2016-4P', {}, { family: 'crystal-smd', size: '2016', pins: 4 }],
  ['SMD5032-2P', {}, { family: 'crystal-smd', size: '5032', pins: 2 }],
  ['CRYSTAL-SMD_4P-L3.2-W2.5-BL', {}, { family: 'crystal-smd', pins: 4, bodyW: 3.2, bodyL: 2.5 }],
  ['SMD,D6.3xL7.7mm', { category: 'capacitor-polarized' }, { family: 'electrolytic-smd', bodyH: 7.7, extra: { diameter: 6.3 } }],
  ['Plugin,D5xL11mm', { category: 'capacitor-polarized' }, { family: 'electrolytic-tht', bodyH: 11, pitch: 2.0, extra: { diameter: 5 } }],
  ['SMD-4P,6x6mm', { category: 'button' }, { family: 'tactile-switch', bodyW: 6, bodyL: 6 }],
  ['SMD-4P,5.1x5.1mm', { category: 'button' }, { family: 'tactile-switch', bodyW: 5.1, bodyL: 5.1 }],
  ['KEY-SMD_4P-L6.0-W6.0-P4.50-LS9.5-BL', {}, { family: 'tactile-switch', bodyW: 6, pitch: 4.5, leadSpan: 9.5 }],
  ['SMD,4x4mm', { category: 'inductor' }, { family: 'inductor-smd', bodyW: 4, bodyL: 4 }],
  ['CD54', { category: 'inductor' }, { family: 'inductor-smd', bodyW: 5.8 }],
  ['Plugin,D5mm', { category: 'led' }, { family: 'led-tht', extra: { diameter: 5 } }],
  ['SMD', { category: 'battery', mpn: 'BS-6', description: 'CR2032 battery holder' }, { family: 'battery-holder', extra: { cell: 'CR2032' } }],
  ['SMD,18x25.5mm', { category: 'rf-module', mpn: 'ESP32-WROOM-32E-N4' }, { family: 'module', pins: 38, pitch: 1.27 }],
];

describe('parsePackageName', () => {
  it(`covers ${CASES.length} real package strings`, () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });
  for (const [pkg, ctx, exp] of CASES) {
    it(`${pkg}${ctx.mpn ? ` (${ctx.mpn})` : ''}${ctx.description ? ` — ${ctx.description.slice(0, 24)}` : ''}`, () => {
      const s = parsePackageName(pkg, ctx);
      expect(s, `no spec for ${pkg}`).toBeDefined();
      const { extra, ...rest } = exp;
      for (const [k, v] of Object.entries(rest)) {
        const got = (s as unknown as Record<string, unknown>)[k];
        if (typeof v === 'number') expect(got, k).toBeCloseTo(v, 3);
        else expect(got, k).toEqual(v);
      }
      for (const [k, v] of Object.entries(extra ?? {})) expect(s?.extra?.[k], `extra.${k}`).toEqual(v);
      // completed specs always carry body dimensions for the generators
      expect(s?.bodyW).toBeGreaterThan(0);
      expect(s?.bodyL).toBeGreaterThan(0);
      expect(s?.bodyH).toBeGreaterThan(0);
    });
  }

  it('returns undefined for unrecognisable strings', () => {
    expect(parsePackageName('')).toBeUndefined();
    expect(parsePackageName('-')).toBeUndefined();
    expect(parsePackageName('SMD')).toBeUndefined();
    expect(parsePackageName('Plugin')).toBeUndefined();
    expect(parsePackageName(undefined as unknown as string)).toBeUndefined();
  });

  it('uses the pin count to detect an exposed pad', () => {
    const s = parsePackageName('QFN-20(4x4)', { pins: 21 });
    expect(s?.exposedPad).toBeDefined();
    const lga = parsePackageName('LGA-8(2.5x2.5)', { pins: 8 });
    expect(lga?.exposedPad).toBeUndefined();
  });
});
