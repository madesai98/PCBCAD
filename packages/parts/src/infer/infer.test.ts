import { describe, expect, it } from 'vitest';
import type { PartCategory, PartDef, PinDef } from '@pcbcad/core';
import { generateFootprint } from '../footprint/generate';
import { completeSpec } from '../package/defaults';
import { categorize } from './categorize';
import { inferConnectorSpec } from './connector';
import { parseQuantity, parseTempRange } from './params';
import { inferPinTypes } from './pins';
import { inferSimModel, vOutFromMpn } from './sim';
import { inferThermal } from './thermal';

function part(p: Partial<PartDef> & { category: PartCategory }): PartDef {
  return {
    id: 'C1',
    mpn: 'X',
    manufacturer: 'M',
    description: '',
    package: '',
    params: {},
    offers: [],
    pins: [],
    provenance: { specs: 'fetched', symbol: 'fetched', footprint: 'fetched', model3d: 'fetched', sim: 'missing', source: 'test' },
    ...p,
  };
}

const pins = (rows: [string, string][]): PinDef[] => rows.map(([number, name]) => ({ number, name, type: 'unspecified' }));

describe('categorize', () => {
  const cases: [string, string | undefined, string | undefined, string | undefined, PartCategory][] = [
    ['Chip Resistor - Surface Mount', 'Resistors', '', '0805W8F1002T5E', 'resistor'],
    ['Multilayer Ceramic Capacitors MLCC - SMD/SMT', 'Capacitors', '', '', 'capacitor'],
    ['Aluminum Electrolytic Capacitors - SMD', 'Capacitors', '', '', 'capacitor-polarized'],
    ['Tantalum Capacitors', 'Capacitors', '', '', 'capacitor-polarized'],
    ['Ferrite Beads', 'Filters', '', '', 'ferrite'],
    ['Power Inductors', 'Inductors, Coils, Chokes', '', '', 'inductor'],
    ['Schottky Diodes', 'Diodes', '', 'SS34', 'schottky'],
    ['Zener Diodes', 'Diodes', '', '', 'zener'],
    ['Switching Diodes', 'Diodes', '', '1N4148W', 'diode'],
    ['ESD and Surge Protection (TVS/ESD)', 'Circuit Protection', '', '', 'tvs'],
    ['LED Indication - Discrete', 'Optoelectronics', '', '', 'led'],
    ['LED Drivers', 'LED Drivers', '', '', 'driver'],
    ['MOSFETs', 'Transistors/Thyristors', 'N-Channel SOT-23 MOSFETs', 'AO3400A', 'mosfet-n'],
    ['MOSFETs', 'Transistors/Thyristors', '-55℃~+150℃ 1 P-Channel SOT-23', 'AO3401A', 'mosfet-p'],
    ['Bipolar (BJT)', 'Transistors/Thyristors', 'PNP 40V', 'MMBT3906', 'bjt-pnp'],
    ['Bipolar (BJT)', 'Transistors/Thyristors', 'NPN 40V', 'MMBT3904', 'bjt-npn'],
    ['Voltage Regulators - Linear, Low Drop Out (LDO) Regulators', 'Power Management (PMIC)', '', 'AMS1117-3.3', 'ldo'],
    ['DC-DC Converters', 'Power Management (PMIC)', '', '', 'dc-dc'],
    ['Microcontrollers (MCU/MPU/SOC)', 'Embedded Processors & Controllers', '', 'ATMEGA328P-AU', 'mcu'],
    ['Microcontrollers', 'Embedded Processors & Controllers', '', 'RP2040', 'mcu'],
    ['Temperature and Humidity Sensor', 'Sensors', '', 'BME280', 'sensor'],
    ['USB Converters', 'Interface', '', 'CH340C', 'interface'],
    ['Crystals', 'Crystals, Oscillators, Resonators', '', '', 'crystal'],
    ['Oscillators', 'Crystals, Oscillators, Resonators', '', '', 'oscillator'],
    ['Tactile Switches', 'Switches', '', '', 'button'],
    ['Toggle Switches', 'Switches', '', '', 'switch'],
    ['USB Connectors', 'Connectors', '', '', 'connector'],
    ['Wire To Board Connector', 'Connectors', '', '', 'connector'],
    ['Housings (Wire To Board / Wire To Wire )', 'Connectors', '', 'PHR-4', 'connector'],
    ['Screw Terminal Blocks', 'Connectors', '', '', 'connector'],
    ['Female-Female Hex Standoff', 'Hardware Fasteners', '', '', 'fastener'],
    ['Cross slot pan head machine screw', 'Hardware Fasteners', '', '', 'fastener'],
    ['Cooling fan', 'Industrial control electrical', '', '', 'mechanical'],
    ['Dupont wire / terminal block wire / electronic wire', 'Wires and cables', '', '', 'cable'],
    ['electronic cable', 'other', '1 18AWG 2.1mm 300V UL1007', '', 'wire'],
    ['Clock Buffers, Drivers, Distributors', 'Clock/Timing', '', '', 'ic'],
    ['Gate Drivers', 'Motor Driver ICs', '', '', 'driver'],
    ['Battery Management', 'Power Management (PMIC)', '', 'TP4056', 'ic'],
    ['Resettable Fuses', 'Circuit Protection', '', '', 'fuse'],
    ['New Arrivals', 'Others', 'SMD New Arrivals', 'ESP32-WROOM-32E-N8', 'rf-module'],
    ['', undefined, 'Thick Film Resistors - SMD 10K 1%', undefined, 'resistor'],
    ['', undefined, '', 'LM358DR', 'opamp'],
  ];
  for (const [a, b, d, m, exp] of cases) {
    it(`${a || d || m} → ${exp}`, () => expect(categorize(a, b, d, m)).toBe(exp));
  }
});

describe('parameter parsing', () => {
  it('reads distributor quantities', () => {
    expect(parseQuantity('1.1V@(800mA)')).toBeCloseTo(1.1);
    expect(parseQuantity('550mV@3A')).toBeCloseTo(0.55);
    expect(parseQuantity('48mΩ@2.5V')).toBeCloseTo(0.048);
    expect(parseQuantity('5.2mΩ@15A,10V')).toBeCloseTo(0.0052);
    expect(parseQuantity('±12V')).toBe(12);
    expect(parseQuantity('15A、18A', 'max')).toBe(18);
    expect(parseQuantity('1.6V~2.6V', 'mid')).toBeCloseTo(2.1);
    expect(parseQuantity('100,000 cycles')).toBe(100000);
    expect(parseQuantity('-')).toBeUndefined();
    expect(parseQuantity('2.54mm')).toBeCloseTo(2.54);
    expect(parseQuantity('6mm')).toBe(6);
    expect(parseTempRange('-40℃~+85℃')).toEqual([-40, 85]);
  });
});

describe('inferPinTypes', () => {
  it('passive categories get passive pins', () => {
    const p = inferPinTypes(pins([['1', '1'], ['2', '2']]), 'resistor');
    expect(p.map((x) => x.type)).toEqual(['passive', 'passive']);
  });
  it('classifies IC pins by name and keeps order', () => {
    const p = inferPinTypes(
      pins([
        ['1', 'GND'],
        ['2', 'VDD'],
        ['3', 'SDA'],
        ['4', 'SCL'],
        ['5', 'TXD'],
        ['6', 'NC'],
        ['7', 'VREG_VOUT'],
        ['8', '(PCINT19/OC2B/INT1)PD3'],
        ['9', 'PC6(RESET#/PCINT14)'],
        ['10', 'GPIO26_ADC0'],
        ['11', '~RESET'],
      ]),
      'mcu',
    );
    expect(p.map((x) => x.type)).toEqual(['power_in', 'power_in', 'bidirectional', 'input', 'output', 'nc', 'power_out', 'bidirectional', 'bidirectional', 'bidirectional', 'input']);
  });
  it('regulator pins', () => {
    const p = inferPinTypes(pins([['1', 'GND/ADJ'], ['2', 'VOUT'], ['3', 'VIN'], ['4', 'EN']]), 'ldo');
    expect(p.map((x) => x.type)).toEqual(['power_in', 'power_out', 'power_in', 'input']);
  });
  it('power names override a wrong library type; other library types are kept', () => {
    const p = inferPinTypes([{ number: '1', name: 'IOVDD', type: 'bidirectional' }, { number: '2', name: 'XYZ', type: 'output' }], 'ic');
    expect(p[0].type).toBe('power_in');
    expect(p[1].type).toBe('output');
  });
});

describe('inferSimModel', () => {
  it('resistor from value / params', () => {
    expect(inferSimModel(part({ category: 'resistor', value: '4k7', pins: pins([['1', '1'], ['2', '2']]) }))).toEqual({ kind: 'resistor', R: 4700, pins: ['1', '2'] });
    const m = inferSimModel(part({ category: 'resistor', params: { Resistance: '10kΩ' }, pins: pins([['1', '1'], ['2', '2']]) }));
    expect(m?.kind === 'resistor' && m.R).toBe(10000);
  });
  it('capacitor and inductor from params', () => {
    const c = inferSimModel(part({ category: 'capacitor', params: { Capacitance: '100nF' }, pins: pins([['1', '1'], ['2', '2']]) }));
    expect(c?.kind === 'capacitor' && c.C).toBeCloseTo(1e-7);
    const l = inferSimModel(part({ category: 'inductor', params: { Inductance: '4.7uH', 'DC Resistance (DCR)': '45mΩ' }, pins: pins([['1', '1'], ['2', '2']]) }));
    expect(l?.kind === 'inductor' && l.L).toBeCloseTo(4.7e-6);
    expect(l?.kind === 'inductor' && l.dcr).toBeCloseTo(0.045);
  });
  it('LED: Vf range midpoint, test current, colour, pins by name', () => {
    const m = inferSimModel(
      part({ category: 'led', params: { 'Voltage - Forward(Vf)': '1.8V~2.4V', 'Test Current': '20mA', 'Illumination Color': 'Red' }, pins: pins([['1', 'A'], ['2', 'K']]) }),
    );
    expect(m).toEqual({ kind: 'led', anode: '1', cathode: '2', Vf: 2.1, If: 0.02, color: 'red' });
  });
  it('LED without parameters falls back to colour defaults and pin-1 cathode', () => {
    const m = inferSimModel(part({ category: 'led', description: 'Blue LED 0603', pins: pins([['1', '1'], ['2', '2']]) }));
    expect(m?.kind === 'led' && m.cathode).toBe('1');
    expect(m?.kind === 'led' && m.Vf).toBeCloseTo(3.1);
  });
  it('schottky / zener / tvs', () => {
    const d = inferSimModel(part({ category: 'schottky', params: { 'Voltage - Forward(Vf@If)': '550mV@3A', 'Voltage - DC Reverse(Vr)': '40V' }, pins: pins([['1', 'K'], ['2', 'A']]) }));
    expect(d).toMatchObject({ kind: 'diode', anode: '2', cathode: '1', Vf: 0.55, If: 3, Bv: 40 });
    const z = inferSimModel(part({ category: 'zener', mpn: 'BZT52C3V3', pins: pins([['1', 'K'], ['2', 'A']]) }));
    expect(z?.kind === 'diode' && z.Bv).toBeCloseTo(3.3);
  });
  it('MOSFET: Vth, RDS(on), Vgs and pins by name', () => {
    const m = inferSimModel(
      part({
        category: 'mosfet-n',
        params: { 'Gate Threshold Voltage (Vgs(th))': '1.45V', 'RDS(on)': '48mΩ@2.5V', Vgs: '±12V' },
        pins: pins([['1', 'G'], ['2', 'S'], ['3', 'D']]),
      }),
    );
    expect(m).toEqual({ kind: 'mosfet', polarity: 'n', g: '1', d: '3', s: '2', Vth: 1.45, Rds_on: 0.048, Vgs_rated: 12 });
    const p = inferSimModel(part({ category: 'mosfet-p', params: { 'Gate Threshold Voltage (Vgs(th))': '1V~2.5V' }, pins: pins([['1', 'S'], ['2', 'S'], ['3', 'S'], ['4', 'G'], ['5', 'D']]) }));
    expect(p).toMatchObject({ polarity: 'p', g: '4', s: '1', d: '5', Vth: 1.75 });
  });
  it('BJT', () => {
    const m = inferSimModel(part({ category: 'bjt-npn', params: { 'DC Current Gain (hFE@Ic,Vce)': '100@10mA,1V' }, pins: pins([['1', 'B'], ['2', 'E'], ['3', 'C']]) }));
    expect(m).toEqual({ kind: 'bjt', polarity: 'npn', b: '1', c: '3', e: '2', beta: 100 });
  });
  it('LDO: AMS1117 pin roles, Vout, dropout, Iq', () => {
    const m = inferSimModel(
      part({
        category: 'ldo',
        mpn: 'AMS1117-3.3',
        params: { 'Output Voltage': '3.3V', 'Voltage Dropout': '1.1V@(800mA)', 'standby current': '5mA', 'Output Current': '1A' },
        pins: pins([['1', 'GND'], ['2', 'VOUT'], ['3', 'VIN'], ['4', 'VOUT']]),
      }),
    );
    expect(m).toEqual({ kind: 'ldo', in: '3', out: '2', gnd: '1', Vout: 3.3, dropout: 1.1, Iq: 0.005, Imax: 1 });
  });
  it('LDO: Vout from MPN; adjustable → undefined', () => {
    expect(vOutFromMpn('XC6206P332MR')).toBeCloseTo(3.3);
    expect(vOutFromMpn('HT7333-A')).toBeCloseTo(3.3);
    expect(vOutFromMpn('AP2112K-1.8TRG1')).toBeCloseTo(1.8);
    const fixed = inferSimModel(part({ category: 'ldo', mpn: 'XC6206P332MR', pins: pins([['1', 'VSS'], ['2', 'VOUT'], ['3', 'VIN']]) }));
    expect(fixed?.kind === 'ldo' && fixed.Vout).toBeCloseTo(3.3);
    const adj = inferSimModel(part({ category: 'ldo', mpn: 'LM317', params: { 'Output Voltage': '1.25V~37V', 'Output Type': 'Adjustable' }, pins: pins([['1', 'ADJ'], ['2', 'VOUT'], ['3', 'VIN']]) }));
    expect(adj).toBeUndefined();
  });
  it('buck converter averaged model', () => {
    const m = inferSimModel(part({ category: 'dc-dc', params: { 'Output Voltage': '5V', Efficiency: '92%', 'Output Current': '2A' }, pins: pins([['1', 'VIN'], ['2', 'SW'], ['3', 'GND'], ['4', 'FB']]) }));
    expect(m).toMatchObject({ kind: 'buck', in: '1', out: '2', gnd: '3', Vout: 5, efficiency: 0.92, Imax: 2 });
  });
  it('MCUs: emulator only for ATmega328P and RP2040', () => {
    const avr = inferSimModel(
      part({
        category: 'mcu',
        mpn: 'ATMEGA328P-AU',
        pins: pins([
          ['3', 'GND'],
          ['4', 'VCC'],
          ['17', 'PB5(SCK/PCINT5)'],
          ['1', '(PCINT19/OC2B/INT1)PD3'],
        ]),
      }),
    );
    expect(avr).toMatchObject({ kind: 'mcu', emulator: 'avr:atmega328p', supplyPins: ['4'], groundPins: ['3'], pinMap: { PB5: '17', PD3: '1' } });
    const rp = inferSimModel(part({ category: 'mcu', mpn: 'RP2040', pins: pins([['1', 'IOVDD'], ['38', 'GPIO26_ADC0'], ['57', 'GND']]) }));
    expect(rp).toMatchObject({ emulator: 'rp2040', pinMap: { GPIO26: '38' }, groundPins: ['57'] });
    expect(inferSimModel(part({ category: 'mcu', mpn: 'STM32F103C8T6', pins: pins([['1', 'VBAT'], ['8', 'VSS']]) }))).toBeUndefined();
  });
  it('generic IC: supply/ground by name, Icc from params', () => {
    const m = inferSimModel(part({ category: 'sensor', params: { 'Current - Supply': '1.8uA' }, pins: pins([['1', 'GND'], ['6', 'VDDIO'], ['7', 'GND'], ['8', 'VDD'], ['2', 'CSB']]) }));
    expect(m).toEqual({ kind: 'ic', supplyPins: ['6', '8'], groundPins: ['1', '7'], Icc: 1.8e-6 });
  });
  it('connectors, crystals, switches', () => {
    expect(inferSimModel(part({ category: 'connector' }))).toEqual({ kind: 'connector' });
    expect(inferSimModel(part({ category: 'crystal', params: { Frequency: '16MHz' }, pins: pins([['1', 'OSC1'], ['2', 'GND'], ['3', 'OSC2'], ['4', 'GND']]) }))).toEqual({ kind: 'crystal', a: '1', b: '3', freq: 16e6 });
    expect(inferSimModel(part({ category: 'button', pins: pins([['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']]) }))).toMatchObject({ kind: 'switch', a: '1', b: '3', closed: false });
  });
});

function withFootprint(p: PartDef): PartDef {
  if (p.packageSpec) {
    p.packageSpec = completeSpec(p.packageSpec);
    p.footprint = generateFootprint(p.packageSpec);
  }
  return p;
}

describe('inferConnectorSpec', () => {
  it('JST PH board header (vertical)', () => {
    const c = inferConnectorSpec(withFootprint(part({ category: 'connector', mpn: 'B4B-PH-K-S(LF)(SN)', packageSpec: { family: 'jst-ph', pins: 4 }, pins: pins([['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']]) })));
    expect(c).toMatchObject({ family: 'JST-PH', gender: 'male', role: 'board', positions: 4, pitch: 2, currentRating: 2, voltageRating: 100, matingDirection: '+z' });
    expect(c?.matesWith).toContain('PHR-4');
  });
  it('JST XH / SH and crimp housings', () => {
    expect(inferConnectorSpec(part({ category: 'connector', mpn: 'B2B-XH-A(LF)(SN)' }))).toMatchObject({ family: 'JST-XH', currentRating: 3, voltageRating: 250 });
    const sh = inferConnectorSpec(withFootprint(part({ category: 'connector', mpn: 'SM04B-SRSS-TB(LF)(SN)', packageSpec: { family: 'jst-sh', pins: 4, orientation: 'right-angle', bodyH: 2.95 }, body: { w: 6, l: 4.25, h: 2.95 } })));
    expect(sh).toMatchObject({ family: 'JST-SH', currentRating: 1, voltageRating: 50, matingDirection: '-y' });
    expect(sh?.opening?.zCenter).toBeCloseTo(1.475, 3);
    const housing = inferConnectorSpec(part({ category: 'connector', mpn: 'PHR-4', description: 'Housings' }));
    expect(housing).toMatchObject({ family: 'JST-PH', gender: 'female', role: 'cable', positions: 4, awgRange: [24, 32] });
  });
  it('USB-C receptacle: 3 A VBUS, 0.04 Ω, opening on the mating face', () => {
    const c = inferConnectorSpec(
      withFootprint(
        part({
          category: 'connector',
          mpn: 'TYPE-C-31-M-12',
          description: 'Female Type-C SMD USB Connectors',
          params: { 'Current Rating-Power': '5A' },
          packageSpec: { family: 'usb-c', pins: 16 },
          body: { w: 8.94, l: 7.35, h: 3.26 },
        }),
      ),
    );
    expect(c).toMatchObject({ family: 'USB-C', gender: 'female', currentRating: 3, contactResistance: 0.04, matingDirection: '-y' });
    expect(c?.opening?.width).toBeCloseTo(9.54, 2);
    expect(c?.opening?.height).toBeCloseTo(3.86, 2);
  });
  it('pin headers, sockets and terminal blocks', () => {
    expect(inferConnectorSpec(part({ category: 'connector', description: '1x4P 2.54mm Pin Header', params: { Pitch: '2.54mm' } }))).toMatchObject({ family: 'Header-2.54', gender: 'male' });
    expect(inferConnectorSpec(part({ category: 'connector', description: 'Female Headers 2.54mm', params: { Pitch: '2.54mm' } }))).toMatchObject({ gender: 'female' });
    expect(inferConnectorSpec(part({ category: 'connector', description: 'Screw Terminal Blocks 5mm 2P', params: { Pitch: '5mm', 'Current Rating': '15A' } }))).toMatchObject({
      family: 'TerminalBlock-5',
      gender: 'genderless',
      currentRating: 15,
      matesWith: ['wire'],
    });
  });
  it('non-connectors return undefined', () => {
    expect(inferConnectorSpec(part({ category: 'resistor' }))).toBeUndefined();
  });
});

describe('inferThermal', () => {
  const t = (category: PartCategory, spec: PartDef['packageSpec'], params: Record<string, string> = {}) => inferThermal(part({ category, packageSpec: spec, params }));
  it('package defaults', () => {
    expect(t('mosfet-n', { family: 'sot23', pins: 3 })?.thetaJA).toBe(250);
    expect(t('ldo', { family: 'sot223' })).toMatchObject({ thetaJA: 90, thetaJC: 15 });
    expect(t('ic', { family: 'soic', pins: 8 })?.thetaJA).toBe(125);
    const qfn = t('ic', { family: 'qfn', pins: 32, bodyW: 5, bodyL: 5 })?.thetaJA ?? 0;
    expect(qfn).toBeGreaterThanOrEqual(35);
    expect(qfn).toBeLessThanOrEqual(45);
    expect(t('mcu', { family: 'qfp', pins: 32 })?.thetaJA).toBe(70);
    expect(t('sensor', { family: 'lga', pins: 8, bodyW: 2.5, bodyL: 2.5 })?.thetaJA).toBe(150);
  });
  it('0805 resistor: 125 mW rating to 155 °C', () => {
    const r = t('resistor', { family: 'chip', size: '0805' }, { 'Power(Watts)': '125mW' });
    expect(r).toEqual({ thetaJA: 680, tjMax: 155 });
  });
  it('tjMax from params, else 150 (discretes) / 125 (ICs)', () => {
    expect(t('schottky', { family: 'sma' }, { 'Operating Junction Temperature Range': '-55℃~+125℃' })?.tjMax).toBe(125);
    expect(t('mosfet-n', { family: 'sot23', pins: 3 })?.tjMax).toBe(150);
    expect(t('ic', { family: 'soic', pins: 8 })?.tjMax).toBe(125);
    expect(t('mosfet-n', { family: 'sot23', pins: 3 }, { 'Operating Temperature': '-55℃~+175℃' })?.tjMax).toBe(175);
  });
  it('no thermal model for connectors', () => {
    expect(t('connector', { family: 'jst-ph', pins: 2 })).toBeUndefined();
  });
});
