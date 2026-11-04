import type { ConnectorSpec, PackageSpec, PartDef, PinDef, PinType } from '@pcbcad/core';
import { inferThermal } from '../infer/thermal';
import { mcuPinMap } from '../infer/sim';
import { catalogPart, lcscOffers, pinList } from './common';

/* --------------------------------------------------------------------------------------------- *
 * Fully specified offline parts. Every LCSC code below was verified through the JLCPCB parts
 * search API and the LCSC product-detail API on 2026-11-04 (MPN, manufacturer, package, library
 * type and stock confirmed); descriptions / parameters are the distributor's. Pinouts are from the
 * manufacturers' datasheets (cross-checked against the EasyEDA library symbols). Footprints and
 * bodies are generated (IPC-7351B); prices are fetched live by importPart.
 * --------------------------------------------------------------------------------------------- */

const ds = (hash: string, code: string) => `https://datasheet.lcsc.com/datasheet/pdf/${hash}.pdf?productCode=${code}`;

function withThermal(p: PartDef, override?: PartDef['thermal']): PartDef {
  p.thermal = override ?? inferThermal(p);
  return p;
}

/* ------------------------------------------------------------------------------------ MCUs */

const ATMEGA_PINS: [string, string, PinType, string[]?][] = [
  ['1', 'PD3', 'bidirectional', ['INT1', 'OC2B', 'PCINT19']],
  ['2', 'PD4', 'bidirectional', ['XCK', 'T0', 'PCINT20']],
  ['3', 'GND', 'power_in'],
  ['4', 'VCC', 'power_in'],
  ['5', 'GND', 'power_in'],
  ['6', 'VCC', 'power_in'],
  ['7', 'PB6/XTAL1', 'bidirectional', ['XTAL1', 'TOSC1', 'PCINT6']],
  ['8', 'PB7/XTAL2', 'bidirectional', ['XTAL2', 'TOSC2', 'PCINT7']],
  ['9', 'PD5', 'bidirectional', ['OC0B', 'T1', 'PCINT21']],
  ['10', 'PD6', 'bidirectional', ['OC0A', 'AIN0', 'PCINT22']],
  ['11', 'PD7', 'bidirectional', ['AIN1', 'PCINT23']],
  ['12', 'PB0', 'bidirectional', ['ICP1', 'CLKO', 'PCINT0']],
  ['13', 'PB1', 'bidirectional', ['OC1A', 'PCINT1']],
  ['14', 'PB2', 'bidirectional', ['SS', 'OC1B', 'PCINT2']],
  ['15', 'PB3/MOSI', 'bidirectional', ['MOSI', 'OC2A', 'PCINT3']],
  ['16', 'PB4/MISO', 'bidirectional', ['MISO', 'PCINT4']],
  ['17', 'PB5/SCK', 'bidirectional', ['SCK', 'PCINT5']],
  ['18', 'AVCC', 'power_in'],
  ['19', 'ADC6', 'input'],
  ['20', 'AREF', 'passive'],
  ['21', 'GND', 'power_in'],
  ['22', 'ADC7', 'input'],
  ['23', 'PC0', 'bidirectional', ['ADC0', 'PCINT8']],
  ['24', 'PC1', 'bidirectional', ['ADC1', 'PCINT9']],
  ['25', 'PC2', 'bidirectional', ['ADC2', 'PCINT10']],
  ['26', 'PC3', 'bidirectional', ['ADC3', 'PCINT11']],
  ['27', 'PC4/SDA', 'bidirectional', ['SDA', 'ADC4', 'PCINT12']],
  ['28', 'PC5/SCL', 'bidirectional', ['SCL', 'ADC5', 'PCINT13']],
  ['29', 'PC6/RESET', 'input', ['RESET', 'PCINT14']],
  ['30', 'PD0/RXD', 'bidirectional', ['RXD', 'PCINT16']],
  ['31', 'PD1/TXD', 'bidirectional', ['TXD', 'PCINT17']],
  ['32', 'PD2', 'bidirectional', ['INT0', 'PCINT18']],
];

function pinsWithFunctions(rows: [string, string, PinType, string[]?][]): PinDef[] {
  return rows.map(([number, name, type, functions]) => (functions ? { number, name, type, functions } : { number, name, type }));
}

function atmega328p(): PartDef {
  const pins = pinsWithFunctions(ATMEGA_PINS);
  return withThermal(
    catalogPart({
      id: 'C14877',
      mpn: 'ATMEGA328P-AU',
      manufacturer: 'Microchip Tech',
      description: 'ATmega328P 8-bit AVR MCU, 32 KB flash, 2 KB SRAM, 1 KB EEPROM, 20 MHz, 1.8–5.5 V, TQFP-32 (7x7)',
      category: 'mcu',
      package: 'TQFP-32(7x7)',
      params: {
        'CPU Core': 'AVR',
        'Core Size': '8 Bit',
        'CPU Maximum Speed': '20MHz',
        'Program Storage Size': '32KB',
        'RAM Size': '2KB',
        EEPROM: '1KB',
        'Number of I/O': '23',
        'ADC (Bit)': '10bit',
        'Voltage - Supply': '1.8V~5.5V',
        'Operating Temperature': '-40℃~+85℃',
      },
      offers: lcscOffers('C14877', 'preferred'),
      pins,
      spec: { family: 'qfp', pins: 32, bodyW: 7, bodyL: 7, bodyH: 1.2, pitch: 0.8, leadSpan: 9, extra: { variant: 'tqfp' } },
      datasheetUrl: ds('6a24f954cb8d4091a71a5b765a32cb3b', 'C14877'),
      massGrams: 0.1,
      extra: {
        sim: { kind: 'mcu', emulator: 'avr:atmega328p', clockHz: 16e6, supplyPins: ['4', '6', '18'], groundPins: ['3', '5', '21'], Icc: 0.009, pinMap: mcuPinMap(pins, 'avr:atmega328p') },
        ratings: { voltage: 5.5, tempMin: -40, tempMax: 85 },
      },
    }),
    { thetaJA: 70, thetaJC: 15, tjMax: 125 },
  );
}

const RP2040_NAMES: string[] = [
  'IOVDD', 'GPIO0', 'GPIO1', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO5', 'GPIO6', 'GPIO7', 'IOVDD',
  'GPIO8', 'GPIO9', 'GPIO10', 'GPIO11', 'GPIO12', 'GPIO13', 'GPIO14', 'GPIO15', 'TESTEN', 'XIN',
  'XOUT', 'IOVDD', 'DVDD', 'SWCLK', 'SWDIO', 'RUN', 'GPIO16', 'GPIO17', 'GPIO18', 'GPIO19',
  'GPIO20', 'GPIO21', 'IOVDD', 'GPIO22', 'GPIO23', 'GPIO24', 'GPIO25', 'GPIO26_ADC0', 'GPIO27_ADC1', 'GPIO28_ADC2',
  'GPIO29_ADC3', 'IOVDD', 'ADC_AVDD', 'VREG_IN', 'VREG_VOUT', 'USB_DM', 'USB_DP', 'USB_VDD', 'IOVDD', 'DVDD',
  'QSPI_SD3', 'QSPI_SCLK', 'QSPI_SD0', 'QSPI_SD2', 'QSPI_SD1', 'QSPI_SS', 'GND',
];

function rp2040Type(name: string): PinType {
  if (/^(IOVDD|DVDD|ADC_AVDD|VREG_IN|USB_VDD)$/.test(name)) return 'power_in';
  if (name === 'VREG_VOUT') return 'power_out';
  if (name === 'GND') return 'power_in';
  if (/^(TESTEN|XIN|SWCLK|RUN)$/.test(name)) return 'input';
  if (/^(XOUT|QSPI_SCLK)$/.test(name)) return 'output';
  return 'bidirectional';
}

function rp2040(): PartDef {
  const pins: PinDef[] = RP2040_NAMES.map((name, i) => {
    const p: PinDef = { number: String(i + 1), name, type: rp2040Type(name) };
    const adc = /^GPIO\d+_(ADC\d)$/.exec(name);
    if (adc) p.functions = [name.split('_')[0], adc[1]];
    return p;
  });
  const supply = pins.filter((p) => p.type === 'power_in' && p.name !== 'GND').map((p) => p.number);
  return withThermal(
    catalogPart({
      id: 'C2040',
      mpn: 'RP2040',
      manufacturer: 'Raspberry Pi',
      description: 'RP2040 dual ARM Cortex-M0+ MCU, 133 MHz, 264 KB SRAM, external QSPI flash, 30 GPIO, 12-bit ADC, USB 1.1, LQFN-56 (7x7)',
      category: 'mcu',
      package: 'LQFN-56(7x7)',
      params: {
        'CPU Core': 'ARM Cortex-M0+',
        'Core Size': '32 Bit',
        'CPU Maximum Speed': '133MHz',
        'RAM Size': '264KB',
        'Program Memory Type': 'External',
        'Number of I/O': '30',
        'ADC (Bit)': '12bit',
        'Voltage - Supply': '1.8V~3.3V',
        'Operating Temperature': '-20℃~+85℃',
      },
      offers: lcscOffers('C2040', 'extended'),
      pins,
      spec: { family: 'qfn', pins: 56, bodyW: 7, bodyL: 7, bodyH: 0.9, pitch: 0.4, exposedPad: { w: 3.2, h: 3.2 } },
      datasheetUrl: ds('3dad1d8f987a4e00bfc677055df1f959', 'C2040'),
      massGrams: 0.18,
      extra: {
        sim: { kind: 'mcu', emulator: 'rp2040', clockHz: 125e6, supplyPins: supply, groundPins: ['57'], Icc: 0.025, pinMap: mcuPinMap(pins, 'rp2040') },
        ratings: { voltage: 3.63, tempMin: -20, tempMax: 85 },
      },
    }),
    { thetaJA: 30, thetaJC: 5, tjMax: 125 },
  );
}

/* ------------------------------------------------------------------------- power / sensors */

function ams1117(): PartDef {
  return withThermal(
    catalogPart({
      id: 'C6186',
      mpn: 'AMS1117-3.3',
      manufacturer: 'Advanced Monolithic Systems',
      description: '1 A low-dropout linear regulator, fixed 3.3 V, dropout 1.1 V @ 800 mA, input up to 15 V, SOT-223',
      category: 'ldo',
      package: 'SOT-223',
      value: '3.3V',
      params: {
        'Output Voltage': '3.3V',
        'Output Type': 'Fixed',
        'Output Current': '1A',
        'Voltage Dropout': '1.1V@(800mA)',
        'Voltage - Supply': '15V',
        'standby current': '5mA',
        'Power Supply Rejection Ratio (PSRR)': '72dB@(120Hz)',
        'Operating Temperature': '-40℃~+125℃',
      },
      offers: lcscOffers('C6186', 'basic'),
      pins: [
        { number: '1', name: 'GND', type: 'power_in', functions: ['ADJ'] },
        { number: '2', name: 'VOUT', type: 'power_out' },
        { number: '3', name: 'VIN', type: 'power_in' },
        { number: '4', name: 'VOUT', type: 'power_out' },
      ],
      spec: { family: 'sot223', pins: 4 },
      datasheetUrl: ds('e6935943fc6b1bbf350a1a0f3e90dc4a', 'C6186'),
      massGrams: 0.284,
      notes: ['Pin 4 is the tab (connected to VOUT).'],
      extra: {
        sim: { kind: 'ldo', in: '3', out: '2', gnd: '1', Vout: 3.3, dropout: 1.1, Iq: 0.005, Imax: 1.0 },
        ratings: { voltage: 15, current: 1, tempMin: -40, tempMax: 125 },
      },
    }),
    { thetaJA: 90, thetaJC: 15, tjMax: 125 },
  );
}

function bme280(): PartDef {
  return withThermal(
    catalogPart({
      id: 'C92489',
      mpn: 'BME280',
      manufacturer: 'Bosch Sensortec',
      description: 'Combined humidity, pressure and temperature sensor, I²C / SPI, 1.71–3.6 V, LGA-8 (2.5x2.5)',
      category: 'sensor',
      package: 'LGA-8(2.5x2.5)',
      params: {
        'Voltage - Supply': '1.71V~3.6V',
        'Current - Supply': '1.8uA',
        Interface: 'I2C、SPI',
        Resolution: '16bit',
        Humidity: '0%RH~100%RH',
        'Humidity Tolerance': '±3%RH',
        'Temperature Tolerance': '±0.5℃',
        'Temperature Range': '-40℃~+85℃',
      },
      offers: lcscOffers('C92489', 'extended'),
      pins: pinList([
        ['1', 'GND', 'power_in'],
        ['2', 'CSB', 'input'],
        ['3', 'SDI', 'bidirectional'],
        ['4', 'SCK', 'input'],
        ['5', 'SDO', 'bidirectional'],
        ['6', 'VDDIO', 'power_in'],
        ['7', 'GND', 'power_in'],
        ['8', 'VDD', 'power_in'],
      ]),
      // Bosch numbers the pins clockwise in top view (pin 1 top-right); lands after the datasheet's
      // recommended landing pattern (0.35 × 0.775 mm, 0.65 mm pitch).
      spec: { family: 'lga', pins: 8, bodyW: 2.5, bodyL: 2.5, bodyH: 0.93, pitch: 0.65, padW: 0.775, padH: 0.35, extra: { sides: 2, numbering: 'cw', padCenter: 1.2625, lid: true } },
      datasheetUrl: ds('ad76ddf396e919f95af704854cf6feea', 'C92489'),
      massGrams: 0.35,
      notes: ['I²C address 0x76 (SDO = GND) or 0x77 (SDO = VDDIO); CSB = VDDIO selects I²C.'],
      extra: {
        sim: { kind: 'ic', supplyPins: ['6', '8'], groundPins: ['1', '7'], Icc: 3.6e-6 },
        ratings: { voltage: 3.6, tempMin: -40, tempMax: 85 },
      },
    }),
    { thetaJA: 150, thetaJC: 40, tjMax: 125 },
  );
}

/* -------------------------------------------------------------------------------- passives */

const R0805 = (id: string, mpn: string, value: string, ohms: number, resistance: string): PartDef =>
  withThermal(
    catalogPart({
      id,
      mpn,
      manufacturer: 'UNI-ROYAL(Uniroyal Elec)',
      description: `${resistance} ±1% 125 mW 150 V thick-film chip resistor, ±100 ppm/℃, 0805`,
      category: 'resistor',
      package: '0805',
      value,
      params: { Resistance: resistance, Tolerance: '±1%', 'Power(Watts)': '125mW', 'Voltage-Supply(Max)': '150V', Type: 'Thick Film Resistor', 'Temperature Coefficient': '±100ppm/℃', 'Operating Temperature': '-55℃~+155℃' },
      offers: lcscOffers(id, 'basic'),
      pins: pinList([
        ['1', '1'],
        ['2', '2'],
      ]),
      spec: { family: 'chip', size: '0805', bodyH: 0.5 },
      datasheetUrl: ds('0a975aaa49b7c97f38a963127be4a823', id),
      massGrams: 0.03,
      extra: { sim: { kind: 'resistor', R: ohms, pins: ['1', '2'] }, ratings: { power: 0.125, voltage: 150, tempMin: -55, tempMax: 155 } },
    }),
  );

interface CapRow {
  id: string;
  mpn: string;
  manufacturer: string;
  value: string;
  farads: number;
  size: '0603' | '0805';
  volts: number;
  dielectric: string;
  tol: string;
  height: number;
  dsHash: string;
}

const CAP = (c: CapRow): PartDef =>
  withThermal(
    catalogPart({
      id: c.id,
      mpn: c.mpn,
      manufacturer: c.manufacturer,
      description: `${c.value} ${c.volts} V ${c.dielectric} ${c.tol} MLCC, ${c.size}`,
      category: 'capacitor',
      package: c.size,
      value: c.value,
      params: { Capacitance: c.value, 'Voltage Rating': `${c.volts}V`, 'Temperature Coefficient': c.dielectric, Tolerance: c.tol },
      offers: lcscOffers(c.id, 'basic'),
      pins: pinList([
        ['1', '1'],
        ['2', '2'],
      ]),
      spec: { family: 'chip', size: c.size, bodyH: c.height },
      datasheetUrl: ds(c.dsHash, c.id),
      massGrams: c.size === '0805' ? 0.04 : 0.036,
      extra: { sim: { kind: 'capacitor', C: c.farads, pins: ['1', '2'] }, ratings: { voltage: c.volts, tempMin: -55, tempMax: c.dielectric === 'X5R' ? 85 : 125 } },
    }),
  );

const LED0603 = (id: string, mpn: string, color: string, colorName: string, vf: number, ifA: number, lib: 'basic' | 'extended', params: Record<string, string>, dsHash: string): PartDef =>
  withThermal(
    catalogPart({
      id,
      mpn,
      manufacturer: 'Hubei KENTO Elec',
      description: `${colorName} LED, 0603 (1.6 × 0.8 mm), water-clear lens`,
      category: 'led',
      package: '0603',
      value: colorName,
      params,
      offers: lcscOffers(id, lib),
      pins: pinList([
        ['1', 'K'],
        ['2', 'A'],
      ]),
      spec: { family: 'chip', size: '0603', bodyH: 0.6, extra: { polarized: true } },
      bodyColor: color,
      datasheetUrl: ds(dsHash, id),
      massGrams: 0.023,
      notes: ['Footprint pin 1 = cathode (K).'],
      extra: { sim: { kind: 'led', anode: '2', cathode: '1', Vf: vf, If: ifA, color: colorName.toLowerCase() }, ratings: { current: 0.02, tempMin: -40, tempMax: 85 } },
    }),
    { thetaJA: 500, tjMax: 100 },
  );

/* ------------------------------------------------------------------------------- discretes */

function ao3400a(): PartDef {
  return withThermal(
    catalogPart({
      id: 'C20917',
      mpn: 'AO3400A',
      manufacturer: 'Alpha & Omega Semicon',
      description: '30 V 5.7 A N-channel MOSFET, RDS(on) 32 mΩ @ 4.5 V / 48 mΩ @ 2.5 V, Vgs(th) 1.05 V typ, SOT-23',
      category: 'mosfet-n',
      package: 'SOT-23',
      params: {
        Type: 'N-Channel',
        'Drain to Source Voltage': '30V',
        'Current - Continuous Drain(Id)': '5.7A',
        'RDS(on)': '48mΩ@2.5V',
        'Gate Threshold Voltage (Vgs(th))': '1.45V',
        Vgs: '±12V',
        'Input Capacitance(Ciss)': '630pF',
        'Gate Charge(Qg)': '7nC@10V',
        'Pd - Power Dissipation': '1.4W',
        'Operating Temperature': '-55℃~+150℃',
      },
      offers: lcscOffers('C20917', 'basic'),
      pins: pinList([
        ['1', 'G'],
        ['2', 'S'],
        ['3', 'D'],
      ]),
      spec: { family: 'sot23', pins: 3 },
      datasheetUrl: ds('130876b936da464599428c58fd8de8f6', 'C20917'),
      massGrams: 0.068,
      extra: { sim: { kind: 'mosfet', polarity: 'n', g: '1', d: '3', s: '2', Vth: 1.05, Rds_on: 0.032, Vgs_rated: 12 }, ratings: { voltage: 30, current: 5.7, power: 1.4, tempMin: -55, tempMax: 150 } },
    }),
    { thetaJA: 125, thetaJC: 60, tjMax: 150 },
  );
}

function ss34(): PartDef {
  return withThermal(
    catalogPart({
      id: 'C8678',
      mpn: 'SS34',
      manufacturer: 'MDD(Microdiode Semiconductor)',
      description: '40 V 3 A Schottky barrier rectifier, Vf 550 mV @ 3 A, SMA (DO-214AC)',
      category: 'schottky',
      package: 'SMA(DO-214AC)',
      params: { 'Voltage - Forward(Vf@If)': '550mV@3A', 'Voltage - DC Reverse(Vr)': '40V', 'Current - Rectified': '3A', 'Reverse Leakage Current (Ir)': '500uA@40V', 'Non-Repetitive Peak Forward Surge Current': '80A', 'Operating Junction Temperature Range': '-55℃~+125℃' },
      offers: lcscOffers('C8678', 'basic'),
      pins: pinList([
        ['1', 'K'],
        ['2', 'A'],
      ]),
      spec: { family: 'sma', extra: { polarized: true } },
      datasheetUrl: ds('dfa1ff67dea875d0135103ba9ada713a', 'C8678'),
      massGrams: 0.121,
      extra: { sim: { kind: 'diode', anode: '2', cathode: '1', Vf: 0.55, If: 3, Bv: 40, n: 1.05 }, ratings: { voltage: 40, current: 3, tempMin: -55, tempMax: 125 } },
    }),
    { thetaJA: 90, thetaJC: 20, tjMax: 125 },
  );
}

function d1n4148w(): PartDef {
  return withThermal(
    catalogPart({
      id: 'C81598',
      mpn: '1N4148W',
      manufacturer: 'ST(Semtech)',
      description: '75 V 150 mA fast switching diode, trr 4 ns, Vf 1 V @ 50 mA, SOD-123',
      category: 'diode',
      package: 'SOD-123',
      params: { 'Voltage - Forward(Vf@If)': '1V@50mA', 'Voltage - DC Reverse(Vr)': '75V', 'Current - Rectified': '150mA', 'Reverse Recovery Time (trr)': '4ns', 'Pd - Power Dissipation': '400mW', 'Reverse Leakage Current (Ir)': '1uA@75V' },
      offers: lcscOffers('C81598', 'basic'),
      pins: pinList([
        ['1', 'K'],
        ['2', 'A'],
      ]),
      spec: { family: 'sod123', extra: { polarized: true } },
      datasheetUrl: ds('8abd7fc00ebe41ffb03ad1383c10753b', 'C81598'),
      massGrams: 0.029,
      extra: { sim: { kind: 'diode', anode: '2', cathode: '1', Vf: 1.0, If: 0.05, Bv: 100, Is: 2.52e-9, n: 1.752, Rs: 0.568 }, ratings: { voltage: 75, current: 0.15, power: 0.4, tempMax: 150 } },
    }),
    { thetaJA: 350, thetaJC: 120, tjMax: 150 },
  );
}

function crystal16m(): PartDef {
  return catalogPart({
    id: 'C13738',
    mpn: 'X322516MLB4SI',
    manufacturer: 'YXC Crystal Oscillators',
    description: '16 MHz SMD crystal, 9 pF load, ±10 ppm tolerance, ±20 ppm stability, ESR 50 Ω, 3225 4-pad',
    category: 'crystal',
    package: 'SMD3225-4P',
    value: '16MHz',
    params: { Frequency: '16MHz', 'Load Capacitance': '9pF', 'Normal temperature Frequency Tolerance': '±10ppm', 'Frequency Stability': '±20ppm', 'Equivalent Series Resistance(ESR)': '50Ω', 'Operating Temperature': '-40℃~+85℃' },
    offers: lcscOffers('C13738', 'basic'),
    pins: pinList([
      ['1', 'OSC1'],
      ['2', 'GND'],
      ['3', 'OSC2'],
      ['4', 'GND'],
    ]),
    spec: { family: 'crystal-smd', size: '3225', pins: 4, bodyH: 0.75 },
    datasheetUrl: ds('a84bd8d530dd46e4b0f6d0ee59d8a89c', 'C13738'),
    massGrams: 0.048,
    notes: ['Load capacitors for CL = 9 pF: ≈ 2 × (9 − ~3 pF stray) ≈ 12 pF each.'],
    extra: { sim: { kind: 'crystal', a: '1', b: '3', freq: 16e6 } },
  });
}

/* ------------------------------------------------------------------------- electromechanical */

function tact6x6(): PartDef {
  return catalogPart({
    id: 'C127509',
    mpn: 'K2-1102SP-C4SC-04',
    manufacturer: 'Korean Hroparts Elec',
    description: 'Tactile switch SPST-NO 6 × 6 × 5 mm, SMD, 2.5 N, 50 mA 12 V, 100k cycles',
    category: 'button',
    package: 'SMD-4P,6x6mm',
    params: { Circuit: 'SPST', 'Operating Force': '2.5N', 'Contact Current': '50mA', 'Voltage Rating': '12V', Life: '100,000 cycles', 'Switch Height': '5mm', Length: '6mm', Width: '6mm', 'Mounting Type': 'Surface Mount,Vertical' },
    offers: lcscOffers('C127509', 'extended'),
    pins: pinList([
      ['1', '1'],
      ['2', '2'],
      ['3', '3'],
      ['4', '4'],
    ]),
    spec: { family: 'tactile-switch', bodyW: 6, bodyL: 6, bodyH: 5, pitch: 4.5, leadSpan: 9.5, extra: { smd: true } },
    datasheetUrl: ds('589dd2ef62f00627174145540e3f61b7', 'C127509'),
    massGrams: 0.575,
    notes: ['Pins 1–2 and 3–4 are internally connected; pressing connects 1/2 to 3/4.'],
    extra: { sim: { kind: 'switch', a: '1', b: '3', closed: false, Ron: 0.1 }, ratings: { voltage: 12, current: 0.05, tempMin: -25, tempMax: 85 } },
  });
}

function connectorPart(base: Omit<Parameters<typeof catalogPart>[0], 'category'>, connector: ConnectorSpec): PartDef {
  return catalogPart({ ...base, category: 'connector', extra: { ...(base.extra ?? {}), connector, sim: { kind: 'connector' } } });
}

function usbC(): PartDef {
  return connectorPart(
    {
      id: 'C165948',
      mpn: 'TYPE-C-31-M-12',
      manufacturer: 'Korean Hroparts Elec',
      description: 'USB Type-C receptacle, 16 contacts (USB 2.0), SMD right angle, 5 A / 20 V, 10,000 cycles',
      package: 'SMD',
      params: { 'Connector Type': 'Type-C', 'Number of Contacts': '16P', Gender: 'Female', 'Current Rating-Power': '5A', 'Voltage Rating': '20V', 'Connect-Disconnect Life': '10,000 cycles', 'Mounting Type': 'Surface Mount, Right Angle', Length: '7.35mm' },
      offers: lcscOffers('C165948', 'extended'),
      pins: pinList([
        ['A1B12', 'GND', 'passive'],
        ['A4B9', 'VBUS', 'passive'],
        ['B8', 'SBU2'],
        ['A5', 'CC1'],
        ['B7', 'DN2'],
        ['A6', 'DP1'],
        ['A7', 'DN1'],
        ['B6', 'DP2'],
        ['A8', 'SBU1'],
        ['B5', 'CC2'],
        ['B4A9', 'VBUS'],
        ['B1A12', 'GND'],
        ['S1', 'SHIELD'],
      ]),
      spec: { family: 'usb-c', pins: 16 },
      datasheetUrl: ds('9e56b777c022540fcce7c7f67825f55e', 'C165948'),
      massGrams: 0.809,
      notes: ['USB 2.0 receptacle: tie DP1/DP2 and DN1/DN2; 5.1 kΩ pull-downs on CC1/CC2 for a sink. VBUS rated 3 A per spec (5 A only with e-marked cables).'],
    },
    {
      family: 'USB-C',
      gender: 'female',
      role: 'board',
      positions: 16,
      matesWith: ['USB-C:male'],
      contactResistance: 0.04,
      currentRating: 3,
      voltageRating: 20,
      matingCycles: 10000,
      matingDirection: '-y',
      opening: { width: 9.54, height: 3.86, zCenter: 1.63 },
      configuredBy: 'builtin',
    },
  );
}

function jstPh(id: string, mpn: string, n: number, mass: number): PartDef {
  return connectorPart(
    {
      id,
      mpn,
      manufacturer: 'JST',
      description: `JST PH ${n}-position wire-to-board header, 2.0 mm pitch, top entry, through hole (mates PHR-${n})`,
      package: 'Plugin,P=2mm',
      params: { 'Reference Series': 'PH', Pitch: '2mm', 'Number of Pins': `${n}P`, 'Pins Structure': `1x${n}P`, 'Current Rating': '2A', 'Voltage Rating': '100V', 'Mounting Type': 'Through Hole', 'Z-Height of the Board': '6mm' },
      offers: lcscOffers(id, 'extended'),
      pins: Array.from({ length: n }, (_, i) => ({ number: String(i + 1), name: String(i + 1), type: 'passive' as const })),
      spec: { family: 'jst-ph', pins: n, pitch: 2.0, orientation: 'vertical' },
      datasheetUrl: ds('6324c8615b21464c92f0a46fe6f6545c', id),
      massGrams: mass,
    },
    { family: 'JST-PH', gender: 'male', role: 'board', positions: n, pitch: 2.0, matesWith: ['JST-PH:female', `PHR-${n}`], contactResistance: 0.02, currentRating: 2, voltageRating: 100, matingCycles: 30, matingDirection: '+z', configuredBy: 'builtin' },
  );
}

function jstXh(id: string, mpn: string, n: number, mass: number): PartDef {
  return connectorPart(
    {
      id,
      mpn,
      manufacturer: 'JST',
      description: `JST XH ${n}-position wire-to-board header, 2.5 mm pitch, top entry, through hole (mates XHP-${n})`,
      package: 'Plugin,P=2.5mm',
      params: { 'Reference Series': 'XH', Pitch: '2.5mm', 'Number of Pins': `${n}P`, 'Pins Structure': `1x${n}P`, 'Current Rating': '3A', 'Voltage Rating': '250V', 'Mounting Type': 'Through Hole', 'Z-Height of the Board': '7mm' },
      offers: lcscOffers(id, 'extended'),
      pins: Array.from({ length: n }, (_, i) => ({ number: String(i + 1), name: String(i + 1), type: 'passive' as const })),
      spec: { family: 'jst-xh', pins: n, pitch: 2.5, orientation: 'vertical' },
      datasheetUrl: ds('51bbcb0476af7caf7f697437212da775', id),
      massGrams: mass,
    },
    { family: 'JST-XH', gender: 'male', role: 'board', positions: n, pitch: 2.5, matesWith: ['JST-XH:female', `XHP-${n}`], contactResistance: 0.01, currentRating: 3, voltageRating: 250, matingCycles: 30, matingDirection: '+z', configuredBy: 'builtin' },
  );
}

function jstSh4(): PartDef {
  const spec: PackageSpec = { family: 'jst-sh', pins: 4, pitch: 1.0, orientation: 'right-angle', bodyW: 6.0, bodyL: 4.25, bodyH: 2.95, extra: { smd: true } };
  return connectorPart(
    {
      id: 'C160404',
      mpn: 'SM04B-SRSS-TB(LF)(SN)',
      manufacturer: 'JST',
      description: 'JST SH 4-position header, 1.0 mm pitch, side entry, SMD with solder tabs (mates SHR-04V-S-B)',
      package: 'SMD,P=1mm,Surface Mount，Right Angle',
      params: { 'Reference Series': 'SH', Pitch: '1mm', 'Number of Pins': '4P', 'Pins Structure': '1x4P', 'Current Rating': '1A', 'Voltage Rating': '50V', 'Mounting Type': 'Surface Mount, Right Angle', 'Z-Height of the Board': '2.9mm' },
      offers: lcscOffers('C160404', 'extended'),
      pins: [...Array.from({ length: 4 }, (_, i) => ({ number: String(i + 1), name: String(i + 1), type: 'passive' as const })), { number: 'MP', name: 'MP', type: 'passive' as const }],
      spec,
      datasheetUrl: ds('40c649e22fa9bda892cfec952005fd51', 'C160404'),
      massGrams: 0.201,
    },
    { family: 'JST-SH', gender: 'male', role: 'board', positions: 4, pitch: 1.0, matesWith: ['JST-SH:female', 'SHR-04V-S-B'], contactResistance: 0.02, currentRating: 1, voltageRating: 50, matingCycles: 20, matingDirection: '-y', opening: { width: 6.6, height: 3.55, zCenter: 1.475 }, configuredBy: 'builtin' },
  );
}

function header1x4(): PartDef {
  return connectorPart(
    {
      id: 'C124378',
      mpn: 'B-2100S04P-A110',
      manufacturer: 'Ckmtw(Shenzhen Cankemeng)',
      description: '1×4 pin header, 2.54 mm pitch, straight, through hole, black, 6 mm mating pins',
      package: 'Plugin,P=2.54mm',
      params: { Pitch: '2.54mm', 'Number of Pins': '4P', 'Pin Structure': '1x4P', 'Current Rating': '3A', 'Insulation Height': '2.54mm', 'Length of Mating Pin': '6mm', 'Length of End Connection Pin': '3mm', 'Mounting Type': 'Through Hole' },
      offers: lcscOffers('C124378', 'extended'),
      pins: Array.from({ length: 4 }, (_, i) => ({ number: String(i + 1), name: String(i + 1), type: 'passive' as const })),
      spec: { family: 'header', pins: 4, rows: 1, pitch: 2.54, orientation: 'vertical', extra: { gender: 'male' } },
      datasheetUrl: ds('219f7e7eb5f34457895b2c164313179f', 'C124378'),
      massGrams: 0.25,
    },
    { family: 'Header-2.54', gender: 'male', role: 'board', positions: 4, pitch: 2.54, matesWith: ['Header-2.54:female', 'Dupont'], contactResistance: 0.02, currentRating: 3, voltageRating: 250, matingCycles: 100, matingDirection: '+z', configuredBy: 'builtin' },
  );
}

/* ---------------------------------------------------------------------------------- interface */

function ch340c(): PartDef {
  return withThermal(
    catalogPart({
      id: 'C84681',
      mpn: 'CH340C',
      manufacturer: 'WCH(Jiangsu Qin Heng)',
      description: 'USB 2.0 full-speed to UART bridge with built-in clock (no crystal), 3.3 V / 5 V, up to 2 Mbps, SOP-16',
      category: 'interface',
      package: 'SOP-16',
      params: { 'USB Protocol': 'USB 2.0', 'Data Rate': '2Mbps', 'Voltage - Supply': '3.3V、5V', 'Current - Supply': '7mA', 'Quiescent Supply Current': '50uA', 'Operating Temperature': '-20℃~+70℃' },
      offers: lcscOffers('C84681', 'extended'),
      pins: pinList([
        ['1', 'GND', 'power_in'],
        ['2', 'TXD', 'output'],
        ['3', 'RXD', 'input'],
        ['4', 'V3', 'passive'],
        ['5', 'UD+', 'bidirectional'],
        ['6', 'UD-', 'bidirectional'],
        ['7', 'NC', 'nc'],
        ['8', 'OUT#', 'output'],
        ['9', 'CTS#', 'input'],
        ['10', 'DSR#', 'input'],
        ['11', 'RI#', 'input'],
        ['12', 'DCD#', 'input'],
        ['13', 'DTR#', 'output'],
        ['14', 'RTS#', 'output'],
        ['15', 'R232', 'input'],
        ['16', 'VCC', 'power_in'],
      ]),
      spec: { family: 'soic', pins: 16, bodyW: 3.9, bodyL: 9.9, pitch: 1.27 },
      datasheetUrl: ds('e2f14e51aaa60c793f1f0cbc8a5d5faa', 'C84681'),
      massGrams: 0.28,
      notes: ['V3: 100 nF to GND at VCC = 5 V; tie to VCC at 3.3 V.'],
      extra: { sim: { kind: 'ic', supplyPins: ['16'], groundPins: ['1'], Icc: 0.007 }, ratings: { voltage: 5.5, tempMin: -20, tempMax: 70 } },
    }),
  );
}

/** Fully specified offline parts (verified LCSC codes, datasheet pinouts, generated footprints/bodies). */
export const BUILTIN_PARTS: PartDef[] = [
  atmega328p(),
  rp2040(),
  ams1117(),
  bme280(),
  R0805('C17414', '0805W8F1002T5E', '10k', 10e3, '10kΩ'),
  R0805('C17513', '0805W8F1001T5E', '1k', 1e3, '1kΩ'),
  R0805('C17673', '0805W8F4701T5E', '4.7k', 4.7e3, '4.7kΩ'),
  R0805('C27834', '0805W8F5101T5E', '5.1k', 5.1e3, '5.1kΩ'),
  R0805('C17630', '0805W8F3300T5E', '330', 330, '330Ω'),
  CAP({ id: 'C49678', mpn: 'CC0805KRX7R9BB104', manufacturer: 'YAGEO', value: '100nF', farads: 100e-9, size: '0805', volts: 50, dielectric: 'X7R', tol: '±10%', height: 0.85, dsHash: '23ccee80ee542e7cf156a772bb589942' }),
  CAP({ id: 'C28323', mpn: 'CL21B105KBFNNNE', manufacturer: 'Samsung Electro-Mechanics', value: '1uF', farads: 1e-6, size: '0805', volts: 50, dielectric: 'X7R', tol: '±10%', height: 1.25, dsHash: '02336ea48ea44ca18c72517dd3cb7b47' }),
  CAP({ id: 'C15850', mpn: 'CL21A106KAYNNNE', manufacturer: 'Samsung Electro-Mechanics', value: '10uF', farads: 10e-6, size: '0805', volts: 25, dielectric: 'X5R', tol: '±10%', height: 1.25, dsHash: '02336ea48ea44ca18c72517dd3cb7b47' }),
  CAP({ id: 'C1653', mpn: 'CL10C220JB8NNNC', manufacturer: 'Samsung Electro-Mechanics', value: '22pF', farads: 22e-12, size: '0603', volts: 50, dielectric: 'C0G', tol: '±5%', height: 0.8, dsHash: '02336ea48ea44ca18c72517dd3cb7b47' }),
  CAP({ id: 'C14663', mpn: 'CC0603KRX7R9BB104', manufacturer: 'YAGEO', value: '100nF', farads: 100e-9, size: '0603', volts: 50, dielectric: 'X7R', tol: '±10%', height: 0.8, dsHash: '23ccee80ee542e7cf156a772bb589942' }),
  LED0603('C2286', 'KT-0603R', '#ff3b30', 'Red', 2.0, 0.02, 'basic', { 'Illumination Color': 'Red', 'Voltage - Forward(Vf)': '1.8V~2.4V', 'Test Current': '20mA', 'Luminous Intensity': '300mcd', 'Wavelength - Dominant': '615nm~630nm', 'Viewing Angle': '120°', 'Operating Temperature': '-40℃~+85℃' }, '011ec3e8cb1e825f6961d29bc4db4c7a'),
  LED0603('C12624', 'KT-0603G', '#1fd17a', 'Green', 2.9, 0.005, 'extended', { 'Illumination Color': 'Emerald Green', 'Voltage - Forward(Vf)': '3.1V', 'Test Current': '5mA', 'Luminous Intensity': '430mcd', 'Wavelength - Dominant': '513nm~528nm', 'Viewing Angle': '120°', 'Operating Temperature': '-40℃~+85℃' }, '69e84a3abd84e5ab5856c47a2d0334ce'),
  crystal16m(),
  ao3400a(),
  ss34(),
  d1n4148w(),
  tact6x6(),
  usbC(),
  jstPh('C131334', 'B4B-PH-K-S(LF)(SN)', 4, 0.238),
  jstPh('C131337', 'B2B-PH-K-S(LF)(SN)', 2, 0.166),
  jstXh('C158012', 'B2B-XH-A(LF)(SN)', 2, 0.24),
  jstXh('C144395', 'B4B-XH-A(LF)(SN)', 4, 0.508),
  jstSh4(),
  header1x4(),
  ch340c(),
];
