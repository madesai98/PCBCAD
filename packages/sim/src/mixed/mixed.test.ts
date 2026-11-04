import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toFloat32, toNumbers } from '@pcbcad/core';
import type { BehaviorScript, PartDef } from '@pcbcad/core';
import { P, ProjectKit, makePart } from '../circuit/testkit';
import {
  ATMEGA328P_TQFP32_PINMAP,
  BUILTIN_BEHAVIORS,
  createFunctionSandbox,
  parseIntelHex,
  parseUf2,
  runMixedSignal,
  validateBehaviorScript,
} from './index';
import { createNodeSandbox } from './sandbox-node';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const hex = (name: string) => new Uint8Array(readFileSync(resolve(repo, 'examples/firmware', name)));

function atmega328p(): PartDef {
  const names: Record<string, string> = { '3': 'GND', '4': 'VCC', '5': 'GND', '6': 'VCC', '18': 'AVCC', '20': 'AREF', '21': 'GND' };
  for (const [port, pin] of Object.entries(ATMEGA328P_TQFP32_PINMAP)) if (!names[pin]) names[pin] = port;
  const pins: [string, string][] = [];
  for (let i = 1; i <= 32; i++) pins.push([String(i), names[String(i)] ?? `NC${i}`]);
  return makePart(
    'mcu',
    { kind: 'mcu', emulator: 'avr:atmega328p', clockHz: 16e6, supplyPins: ['4', '6', '18'], groundPins: ['3', '5', '21'], Icc: 0.008, pinMap: { ...ATMEGA328P_TQFP32_PINMAP } },
    pins,
    { mpn: 'ATMEGA328P-AU' },
  );
}

function bme280(): PartDef {
  return makePart(
    'sensor',
    { kind: 'ic', supplyPins: ['6', '8'], groundPins: ['1', '7'], Icc: 0.00036, behaviorId: 'builtin:bme280' },
    [
      ['1', 'GND'],
      ['2', 'CSB'],
      ['3', 'SDI'],
      ['4', 'SCK'],
      ['5', 'SDO'],
      ['6', 'VDDIO'],
      ['7', 'GND'],
      ['8', 'VDD'],
    ],
    { mpn: 'BME280' },
  );
}

/** Env-sensor board: 5 V in → 3.3 V LDO → ATmega328P + BME280 (I2C, pull-ups), LEDs on PB5/PD6. */
function envBoard(opts: { pullups?: boolean } = {}) {
  const pk = new ProjectKit('env');
  const b = pk.board();
  b.add('J1', P.vsource(5, 0.05), { 1: 'VBUS', 2: 'GND' });
  b.add('U3', P.ldo(3.3, 0.25, 0.0005, 0.5), { 3: 'VBUS', 2: '3V3', 1: 'GND' });
  b.add('C1', P.capacitor(10e-6), { 1: '3V3', 2: 'GND' });
  const mcuPins: Record<string, string> = { 4: '3V3', 6: '3V3', 18: '3V3', 3: 'GND', 5: 'GND', 21: 'GND', 27: 'SDA', 28: 'SCL', 17: 'LED1', 10: 'LED2', 31: 'TXD', 30: 'RXD' };
  const u1 = b.add('U1', atmega328p(), mcuPins);
  const u2 = b.add('U2', bme280(), { 1: 'GND', 7: 'GND', 6: '3V3', 8: '3V3', 2: '3V3', 3: 'SDA', 4: 'SCL', 5: 'GND' });
  if (opts.pullups !== false) {
    b.add('R1', P.resistor(4700), { 1: '3V3', 2: 'SDA' });
    b.add('R2', P.resistor(4700), { 1: '3V3', 2: 'SCL' });
  }
  b.add('R3', P.resistor(330), { 1: 'LED1', 2: 'LED1A' });
  const d1 = b.add('D1', P.led(2.0, 0.02, 'green'), { 2: 'LED1A', 1: 'GND' });
  b.add('R4', P.resistor(330), { 1: 'LED2', 2: 'LED2A' });
  const d2 = b.add('D2', P.led(2.0, 0.02, 'red'), { 2: 'LED2A', 1: 'GND' });
  return { pk, b, u1, u2, d1, d2 };
}

const sandboxes: { dispose?: () => void }[] = [];
afterAll(() => {
  for (const s of sandboxes) s.dispose?.();
});

describe('firmware parsing', () => {
  it('parses Intel HEX with checksums and UF2 blocks', () => {
    const h = parseIntelHex(hex('blink/blink.hex'));
    expect(h.segments[0].address).toBe(0);
    expect(h.segments[0].data.length).toBe(162);
    expect(() => parseIntelHex(':0100000000FE\n')).toThrow(/checksum/);
    // build a 2-block UF2 and read it back
    const data = new Uint8Array(600).map((_, i) => i & 0xff);
    const uf2 = makeUf2(data, 0x10000000);
    const u = parseUf2(uf2);
    expect(u.segments.length).toBe(1);
    expect(u.segments[0].address).toBe(0x10000000);
    expect(Array.from(u.segments[0].data.slice(0, 600))).toEqual(Array.from(data));
  });
});

describe('AVR ATmega328P co-simulation', () => {
  it('blink: PB5 toggles every 500 ms and drives the LED', async () => {
    const pk = new ProjectKit('blink');
    const b = pk.board();
    b.add('V1', P.vsource(5), { 1: 'VCC', 2: 'GND' });
    const u1 = b.add('U1', atmega328p(), { 4: 'VCC', 6: 'VCC', 18: 'VCC', 3: 'GND', 5: 'GND', 21: 'GND', 17: 'PB5' });
    b.add('R1', P.resistor(330), { 1: 'PB5', 2: 'A' });
    const d1 = b.add('D1', P.led(2.0, 0.02, 'red'), { 2: 'A', 1: 'GND' });
    const res = await runMixedSignal(pk.project, { boardId: b.board.id }, { duration: 2.2, firmware: { [u1.id]: { bytes: hex('blink/blink.hex'), format: 'hex', name: 'blink.hex' } } });
    const tr = res.digital.find((d) => d.name === 'U1.PB5')!;
    expect(tr).toBeDefined();
    const highs = tr.transitions.filter(([, l]) => l === 1).map(([t]) => t);
    const lows = tr.transitions.filter(([t, l]) => l === 0 && t > 0).map(([t]) => t);
    expect(highs.length).toBeGreaterThanOrEqual(3);
    // period between rising edges ≈ 1 s (500 ms on / 500 ms off)
    for (let i = 1; i < highs.length; i++) expect(Math.abs(highs[i] - highs[i - 1] - 1.0)).toBeLessThan(0.005);
    expect(lows.length).toBeGreaterThan(0);
    const led = res.indicators.find((x) => x.componentId === d1.id)!;
    expect(led.onFraction).toBeGreaterThan(0.5);
    expect(led.onFraction).toBeLessThan(0.6);
    const iOn = (5 - 2.0) / (330 + 25);
    expect(led.meanCurrent / led.onFraction).toBeGreaterThan(iOn * 0.9);
    expect(led.meanCurrent / led.onFraction).toBeLessThan(iOn * 1.1);
    expect(res.mcus[0].status).toBe('ok');
    expect(res.mcus[0].cycles).toBeGreaterThan(2.2 * 16e6 - 100);
    expect(res.avgPower[u1.id]).toBeGreaterThan(5 * 0.008);
  });

  it('env-sensor firmware + builtin BME280 over I2C: banner, id=0x60, T/P/H match the environment', async () => {
    const { pk, b, u1, u2, d1 } = envBoard();
    const env = { temperatureC: 23.4, pressurePa: 98765, humidityPct: 41.3 };
    const t0 = performance.now();
    const res = await runMixedSignal(pk.project, { boardId: b.board.id }, {
      duration: 1.2,
      firmware: { [u1.id]: { bytes: hex('env-sensor/env-sensor.hex'), format: 'hex', name: 'env-sensor.hex' } },
      environment: env,
    });
    const wall = performance.now() - t0;
    const text = res.uart.find((u) => u.componentId === u1.id && u.port === 'USART0')?.text ?? '';
    // eslint-disable-next-line no-console
    console.log(`[perf] env-sensor 1.2 s simulated in ${wall.toFixed(0)} ms wall; solves=${res.stats.analogSolves} cacheHits=${res.stats.cacheHits}\n${text}`);
    expect(text).toContain('env-sensor 1.0');
    expect(text).toContain('id=0x60');
    const lines = [...text.matchAll(/T=(-?\d+\.\d+)C P=(\d+\.\d)hPa H=(\d+\.\d)%/g)];
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const m of lines) {
      expect(Math.abs(Number(m[1]) - env.temperatureC)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(Number(m[2]) - env.pressurePa / 100)).toBeLessThanOrEqual(0.2);
      expect(Math.abs(Number(m[3]) - env.humidityPct)).toBeLessThanOrEqual(0.2);
    }
    expect(res.warnings.some((w) => /pull-up/.test(w))).toBe(false);
    const state = res.chipStates[u2.id] as { measurements: number };
    expect(state.measurements).toBeGreaterThanOrEqual(2);
    // status LED toggles once per loop
    const led1 = res.digital.find((d) => d.name === 'U1.PB5')!;
    expect(led1.transitions.filter(([, l]) => l === 1).length).toBeGreaterThanOrEqual(1);
    expect(res.indicators.find((i) => i.componentId === d1.id)!.color).toBe('green');
    // PWM LED on PD6 produces many transitions (976 Hz fast PWM) once the duty is non-zero
    const pd6 = res.digital.find((d) => d.name === 'U1.PD6')!;
    expect(pd6.transitions.length).toBeGreaterThan(100);
    // analog samples of the 3V3 rail
    const rail = res.analog.signals.find((s) => s.name === '3V3')!;
    const v = toFloat32(rail.data);
    expect(v[v.length - 1]).toBeGreaterThan(3.25);
    expect(toNumbers(res.analog.time).length).toBe(v.length);
    expect(wall).toBeLessThan(10_000 * 1.2);
  });

  it('missing I2C pull-ups: NACK + explanatory warning', async () => {
    const { pk, b, u1 } = envBoard({ pullups: false });
    const res = await runMixedSignal(pk.project, { boardId: b.board.id }, {
      duration: 0.05,
      firmware: { [u1.id]: { bytes: hex('env-sensor/env-sensor.hex'), format: 'hex' } },
    });
    const text = res.uart[0]?.text ?? '';
    expect(text).toMatch(/no ACK/);
    expect(res.warnings.some((w) => /no pull-up resistors/.test(w))).toBe(true);
  });

  it('transient analog mode: RC on a GPIO charges with its time constant', async () => {
    const pk = new ProjectKit('rc');
    const b = pk.board();
    b.add('V1', P.vsource(5), { 1: 'VCC', 2: 'GND' });
    const u1 = b.add('U1', atmega328p(), { 4: 'VCC', 6: 'VCC', 18: 'VCC', 3: 'GND', 5: 'GND', 21: 'GND', 17: 'PB5' });
    b.add('R1', P.resistor(10e3), { 1: 'PB5', 2: 'FILT' });
    b.add('C1', P.capacitor(1e-6), { 1: 'FILT', 2: 'GND' });
    b.add('R2', P.resistor(1e6), { 1: 'FILT', 2: 'GND' });
    pk.project.boards[0].nets.find((n) => n.name === 'FILT')!.class = 'power'; // sample it
    const fw = { [u1.id]: { bytes: hex('blink/blink.hex'), format: 'hex' as const } };
    const tr = await runMixedSignal(pk.project, { boardId: b.board.id }, { duration: 0.03, firmware: fw, analogMode: 'transient', sampleInterval: 1e-4 });
    const qs = await runMixedSignal(pk.project, { boardId: b.board.id }, { duration: 0.03, firmware: fw, sampleInterval: 1e-4 });
    const at = (r: typeof tr, tq: number) => {
      const t = toNumbers(r.analog.time);
      const s = toFloat32(r.analog.signals.find((x) => x.name === 'FILT')!.data);
      const i = Array.from(t).findIndex((x) => x >= tq - 1e-9);
      return s[i];
    };
    // τ = 10k·1µF = 10 ms (‖1 MΩ → 9.9 ms); final value 5·(1M/1.01M)·(10k path incl. 25 Ω rout)
    const vInf = 5 * (1e6 / (1e6 + 10025));
    const tau = ((10025 * 1e6) / (1e6 + 10025)) * 1e-6;
    expect(at(tr, 0.01)).toBeGreaterThan(vInf * (1 - Math.exp(-0.01 / tau)) * 0.97);
    expect(at(tr, 0.01)).toBeLessThan(vInf * (1 - Math.exp(-0.01 / tau)) * 1.03);
    expect(at(qs, 0.01)).toBeCloseTo(vInf, 2); // quasi-static: instantly settled
  });
});

describe('script sandbox + custom behaviours', () => {
  it('node sandbox: no process/require/globalThis leaks, per-call timeout', () => {
    const sb = createNodeSandbox({ timeoutMs: 40 });
    sandboxes.push(sb);
    const probe = sb.compile(
      `return { step(chip) { return [typeof process, typeof require, typeof globalThis.process, typeof module, (() => { try { return Function('return process')(); } catch (e) { return 'blocked'; } })(), (() => { try { return chip.read.constructor('return process')(); } catch (e) { return 'blocked'; } })()].join(','); } };`,
      'probe',
    );
    const inst = probe.instantiate({ host: { call: () => 0 }, params: {}, meta: {} });
    expect(inst.invoke('step', 0, [])).toBe('undefined,undefined,undefined,undefined,blocked,blocked');
    const loop = sb.compile('return { step() { for (;;) {} } };', 'loop').instantiate({ host: { call: () => 0 }, params: {}, meta: {} });
    const t0 = performance.now();
    expect(() => loop.invoke('step', 0, [])).toThrow(/timed out/);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('node sandbox lifecycle: per-script workers, timeout isolation, idle shutdown and restart', async () => {
    const sb = createNodeSandbox({ timeoutMs: 30, idleShutdownMs: 20 });
    sandboxes.push(sb);
    const good = sb.compile('let n = 0; return { step() { return ++n; } };', 'good');
    const bad = sb.compile('return { step() { for (;;) {} } };', 'bad');
    const g1 = good.instantiate({ host: { call: () => 0 }, params: {}, meta: {} });
    const b1 = bad.instantiate({ host: { call: () => 0 }, params: {}, meta: {} });
    expect(g1.invoke('step', 0)).toBe(1);
    expect(() => b1.invoke('step', 0)).toThrow(/timed out/);
    expect(g1.invoke('step', 0)).toBe(2); // other script unaffected
    g1.dispose();
    await new Promise((r) => setTimeout(r, 60)); // idle worker stops
    const g2 = good.instantiate({ host: { call: () => 0 }, params: {}, meta: {} }); // restarts on demand
    expect(g2.invoke('step', 0)).toBe(1);
    const b2 = bad.instantiate({ host: { call: () => 0 }, params: {}, meta: {} }); // fresh worker after the kill
    expect(b2.shape.hooks).toEqual(['step']);
    g2.dispose();
    b2.dispose();
    expect(() => sb.compile('return { step( };', 'syntax')).toThrow(/Syntax error/);
  });

  it('non-builtin scripts require an explicit sandbox; node sandbox runs a custom I2C chip with the env-sensor firmware', async () => {
    const custom: BehaviorScript = { ...BUILTIN_BEHAVIORS.find((x) => x.id === 'builtin:bme280')!, id: 'agent:bme280-copy', author: 'agent' };
    const { pk, b, u1, u2 } = envBoard();
    u2.behaviorId = custom.id;
    const fw = { [u1.id]: { bytes: hex('env-sensor/env-sensor.hex'), format: 'hex' as const } };
    const noSb = await runMixedSignal(pk.project, { boardId: b.board.id }, { duration: 0.05, firmware: fw, behaviors: [custom] });
    expect(noSb.warnings.some((w) => /needs an isolated sandbox/.test(w))).toBe(true);
    const sb = createNodeSandbox();
    sandboxes.push(sb);
    const res = await runMixedSignal(pk.project, { boardId: b.board.id }, { duration: 0.6, firmware: fw, behaviors: [custom], sandbox: sb, environment: { temperatureC: -12.25 } });
    const text = res.uart[0].text;
    expect(text).toContain('id=0x60');
    expect(text).toMatch(/T=-12\.2[45]C/);
  });

  it('validateBehaviorScript', () => {
    expect(validateBehaviorScript('return { i2c: { address: 0x40, write() { return true }, read() { return 0 } } };', 'chip').ok).toBe(true);
    const bad = validateBehaviorScript('return { i2c: { address: 0x40, write( } };', 'chip');
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatch(/Syntax error/);
    const fs = createFunctionSandbox();
    const noRead = validateBehaviorScript('return { i2c: { address: 0x40, write() { return true } } };', 'chip', fs);
    expect(noRead.ok).toBe(false);
    expect(noRead.errors.join()).toMatch(/i2c.read/);
    const emu = validateBehaviorScript('return { load() {}, run(m, n) { return n; } };', 'mcu-emulator', fs);
    expect(emu.ok).toBe(true);
    for (const bh of BUILTIN_BEHAVIORS) expect(validateBehaviorScript(bh.code, bh.kind, fs).errors).toEqual([]);
  });

  it("'script:' MCU emulator bit-bangs a builtin 74HC595 that lights LEDs", async () => {
    const emuScript: BehaviorScript = {
      id: 'agent:bitbang',
      name: 'bit-bang test CPU',
      kind: 'mcu-emulator',
      author: 'agent',
      updatedAt: '',
      code: `
        // Shifts out the first firmware byte to a 74HC595 (DATA, CLK, LATCH), one edge per run() slice.
        let seq = [];
        return {
          load(mcu, bytes) {
            const v = bytes[0];
            for (let i = 7; i >= 0; i--) {
              const bit = (v >> i) & 1 ? 'high' : 'low';
              seq.push(['DATA', bit], ['CLK', 'high'], ['CLK', 'low']);
            }
            seq.push(['LATCH', 'high'], ['LATCH', 'low']);
          },
          run(mcu, cycles) {
            const step = seq.shift();
            if (step) mcu.drive(step[0], step[1]);
            return cycles;
          },
        };`,
    };
    const pk = new ProjectKit('595');
    const b = pk.board();
    b.add('V1', P.vsource(5), { 1: 'VCC', 2: 'GND' });
    const cpu = makePart('mcu', { kind: 'mcu', emulator: 'script:agent:bitbang', clockHz: 1e6, supplyPins: ['1'], groundPins: ['2'], Icc: 0.001, pinMap: { DATA: '3', CLK: '4', LATCH: '5' } }, ['1', '2', '3', '4', '5']);
    const u1 = b.add('U1', cpu, { 1: 'VCC', 2: 'GND', 3: 'SER', 4: 'SRCLK', 5: 'RCLK' });
    const sr = makePart('logic', { kind: 'ic', supplyPins: ['16'], groundPins: ['8'], Icc: 0.0001, behaviorId: 'builtin:74hc595' }, Array.from({ length: 16 }, (_, i) => String(i + 1)));
    const pins: Record<string, string> = { 16: 'VCC', 8: 'GND', 14: 'SER', 11: 'SRCLK', 12: 'RCLK', 10: 'VCC', 13: 'GND' };
    const qPins = ['15', '1', '2', '3', '4', '5', '6', '7'];
    qPins.forEach((p, i) => (pins[p] = `Q${i}`));
    const u2 = b.add('U2', sr, pins);
    const leds = qPins.map((_, i) => {
      b.add(`R${i}`, P.resistor(470), { 1: `Q${i}`, 2: `QA${i}` });
      return b.add(`D${i}`, P.led(2, 0.02, 'red'), { 2: `QA${i}`, 1: 'GND' });
    });
    const sb = createNodeSandbox();
    sandboxes.push(sb);
    const res = await runMixedSignal(pk.project, { boardId: b.board.id }, {
      duration: 0.01,
      firmware: { [u1.id]: { bytes: new Uint8Array([0b10100101]), format: 'bin' } },
      behaviors: [emuScript],
      sandbox: sb,
    });
    expect(res.mcus[0].status).toBe('ok');
    const lit = leds.map((d) => (res.indicators.find((x) => x.componentId === d.id)!.onFraction > 0.5 ? 1 : 0));
    // QA = bit 0 ... QH = bit 7 of the shifted byte
    expect(lit).toEqual([1, 0, 1, 0, 0, 1, 0, 1]);
    expect((res.chipStates[u2.id] as { latch: number }).latch).toBe(0b10100101);
  });
});

describe('built-in chip scripts (unit)', () => {
  const fs = createFunctionSandbox();
  const mk = (id: string, params: Record<string, unknown> = {}, pinsHigh: string[] = []) => {
    const bh = BUILTIN_BEHAVIORS.find((x) => x.id === id)!;
    const logs: string[] = [];
    const inst = fs.compile(bh.code, id).instantiate({
      host: {
        call: (op, a) => {
          if (op === 'read') return pinsHigh.includes(String(a)) ? 1 : 0;
          if (op === 'hasPin') return true;
          if (op === 'log') logs.push(String(a));
          return undefined;
        },
      },
      params,
      meta: { ref: 'U1' },
    });
    inst.invoke('setup', 0);
    return { inst, logs };
  };

  it('BME280 inverse compensation round-trips through the Bosch formulas', () => {
    for (const env of [
      { temperatureC: -35.5, pressurePa: 70000, humidityPct: 5 },
      { temperatureC: 0, pressurePa: 101325, humidityPct: 50 },
      { temperatureC: 61.27, pressurePa: 110000, humidityPct: 99.5 },
    ]) {
      const { inst } = mk('builtin:bme280', env);
      const w = (reg: number, v: number, t: number) => {
        inst.invoke('i2c.start', t, [false]);
        inst.invoke('i2c.write', t, [reg]);
        inst.invoke('i2c.write', t, [v]);
        inst.invoke('i2c.stop', t);
      };
      const r = (reg: number, n: number, t: number) => {
        inst.invoke('i2c.start', t, [false]);
        inst.invoke('i2c.write', t, [reg]);
        inst.invoke('i2c.start', t, [true]);
        const out: number[] = [];
        for (let i = 0; i < n; i++) out.push(inst.invoke('i2c.read', t, [i + 1 < n]) as number);
        inst.invoke('i2c.stop', t);
        return out;
      };
      expect(inst.invoke('i2c.address', 0)).toBe(0x76);
      expect(r(0xd0, 1, 0)[0]).toBe(0x60);
      w(0xf2, 0x01, 0);
      w(0xf4, 0x25, 0.001);
      expect(r(0xf3, 1, 0.002)[0] & 0x08).toBe(0x08); // measuring
      expect(r(0xf3, 1, 0.02)[0] & 0x08).toBe(0);
      const c = r(0x88, 26, 0.02);
      const h = r(0xe1, 7, 0.02);
      const d = r(0xf7, 8, 0.02);
      const res = boschCompensate(c, h, d);
      expect(Math.abs(res.t - env.temperatureC)).toBeLessThanOrEqual(0.006);
      expect(Math.abs(res.p - env.pressurePa)).toBeLessThan(0.5);
      expect(Math.abs(res.h - env.humidityPct)).toBeLessThan(0.01);
    }
  });

  it('24C02: page write, write-cycle NACK, sequential read', () => {
    const { inst } = mk('builtin:24c02');
    expect(inst.invoke('i2c.address', 0)).toBe(0x50);
    expect(inst.invoke('i2c.start', 0, [false])).toBe(true);
    inst.invoke('i2c.write', 0, [0x06]);
    for (const v of [1, 2, 3, 4]) inst.invoke('i2c.write', 0, [v]);
    inst.invoke('i2c.stop', 0);
    expect(inst.invoke('i2c.start', 0.001, [false])).toBe(false); // busy
    expect(inst.invoke('i2c.start', 0.006, [false])).toBe(true);
    inst.invoke('i2c.write', 0.006, [0x06]);
    inst.invoke('i2c.start', 0.006, [true]);
    const out = [0, 1, 2, 3].map(() => inst.invoke('i2c.read', 0.006, [true]));
    // page wrap: bytes 3,4 landed at 0x00/0x01 of the page (0x06,0x07,0x00,0x01)
    expect(out).toEqual([1, 2, 0xff, 0xff]);
    const s = inst.snapshot() as { mem: number[] };
    expect(s.mem.slice(0, 2)).toEqual([3, 4]);
  });

  it('SSD1306: init sequence + framebuffer data + ASCII render', () => {
    const { inst, logs } = mk('builtin:ssd1306');
    const send = (ctrl: number, bytes: number[], t: number) => {
      inst.invoke('i2c.start', t, [false]);
      inst.invoke('i2c.write', t, [ctrl]);
      for (const x of bytes) inst.invoke('i2c.write', t, [x]);
      inst.invoke('i2c.stop', t);
    };
    send(0x00, [0xae, 0xd5, 0x80, 0xa8, 0x3f, 0xd3, 0x00, 0x40, 0x8d, 0x14, 0x20, 0x00, 0xa1, 0xc8, 0xda, 0x12, 0x81, 0xcf, 0xa4, 0xa6, 0xaf], 0);
    send(0x00, [0x21, 0, 127, 0x22, 0, 7], 0.01);
    const data = new Array(1024).fill(0);
    for (let col = 0; col < 32; col++) data[col] = 0xff; // top-left 32x8 block lit
    send(0x40, data, 0.2);
    const s = inst.snapshot() as { fb: number[]; on: boolean; remap: boolean; ascii: string };
    expect(s.on).toBe(true);
    expect(s.remap).toBe(true);
    expect(s.fb.slice(0, 32).every((v) => v === 0xff)).toBe(true);
    expect(s.ascii.split('\n').length).toBe(16);
    expect(logs.some((l) => /SSD1306 display update/.test(l))).toBe(true);
    // remap (0xA1) + COM scan reversed (0xC8): page 0 cols 0..31 appear at the bottom-right
    const lines = s.ascii.split('\n');
    expect(lines[15].trimEnd().endsWith('#'.repeat(16))).toBe(true);
  });
});

describe('RP2040 (rp2040js)', () => {
  it('bare-metal UF2: GPIO25 toggles through SIO and drives an LED', async () => {
    const DELAY = 31250;
    const bin = rp2040BlinkBin(DELAY);
    const part = makePart(
      'mcu',
      { kind: 'mcu', emulator: 'rp2040', clockHz: 125e6, supplyPins: ['1'], groundPins: ['2'], Icc: 0.02, pinMap: { GPIO25: '3' } },
      [
        ['1', 'IOVDD'],
        ['2', 'GND'],
        ['3', 'GPIO25'],
      ],
    );
    const pk = new ProjectKit('pico');
    const b = pk.board();
    b.add('V1', P.vsource(3.3), { 1: '3V3', 2: 'GND' });
    const u1 = b.add('U1', part, { 1: '3V3', 2: 'GND', 3: 'LED' });
    b.add('R1', P.resistor(220), { 1: 'LED', 2: 'A' });
    const d1 = b.add('D1', P.led(2.0, 0.02, 'green'), { 2: 'A', 1: 'GND' });
    const res = await runMixedSignal(pk.project, { boardId: b.board.id }, { duration: 0.01, firmware: { [u1.id]: { bytes: makeUf2(bin, 0x10000000), format: 'uf2' } } });
    expect(res.mcus[0].status).toBe('ok');
    const tr = res.digital.find((d) => d.name === 'U1.GPIO25')!;
    const edges = tr.transitions.filter(([t]) => t > 0).map(([t]) => t);
    expect(edges.length).toBeGreaterThan(6);
    const periods = edges.slice(2).map((t, i) => t - edges[i + 1]);
    const mean = periods.reduce((a, x) => a + x, 0) / periods.length;
    for (const p of periods) expect(Math.abs(p - mean) / mean).toBeLessThan(0.01);
    expect(mean).toBeGreaterThan((DELAY * 2) / 125e6);
    expect(mean).toBeLessThan((DELAY * 5) / 125e6);
    const led = res.indicators.find((x) => x.componentId === d1.id)!;
    expect(led.onFraction).toBeGreaterThan(0.4);
    expect(led.onFraction).toBeLessThan(0.6);
  });

  it('pico-sdk style images without a bootrom fail with a clear error', async () => {
    const part = makePart('mcu', { kind: 'mcu', emulator: 'rp2040', clockHz: 125e6, supplyPins: ['1'], groundPins: ['2'], Icc: 0.02, pinMap: { GPIO25: '3' } }, ['1', '2', '3']);
    const pk = new ProjectKit('pico2');
    const b = pk.board();
    b.add('V1', P.vsource(3.3), { 1: '3V3', 2: 'GND' });
    const u1 = b.add('U1', part, { 1: '3V3', 2: 'GND' });
    const img = new Uint8Array(512).fill(0);
    // valid boot2 CRC over 252 zero bytes
    const crc = crc32mpeg2(img.subarray(0, 252));
    new DataView(img.buffer).setUint32(252, crc, true);
    const res = await runMixedSignal(pk.project, { boardId: b.board.id }, { duration: 0.001, firmware: { [u1.id]: { bytes: img, format: 'bin' } } });
    expect(res.mcus[0].status).toMatch(/needs the RP2040 bootrom/);
  });

  const mpUf2 = process.env.PCBCAD_MICROPYTHON_UF2;
  const bootromPath = process.env.PCBCAD_RP2040_BOOTROM;
  it.skipIf(!mpUf2 || !bootromPath || !existsSync(mpUf2 ?? '') || !existsSync(bootromPath ?? ''))('MicroPython UF2 boots and answers on USB CDC (needs PCBCAD_MICROPYTHON_UF2 + PCBCAD_RP2040_BOOTROM)', async () => {
    const words = (readFileSync(bootromPath!, 'utf8').match(/0x[0-9a-fA-F]{8}/g) ?? []).map((x) => parseInt(x, 16) >>> 0);
    const bootrom = Uint32Array.from(words);
    const part = makePart('mcu', { kind: 'mcu', emulator: 'rp2040', clockHz: 125e6, supplyPins: ['1'], groundPins: ['2'], Icc: 0.02, pinMap: { GPIO25: '3' } }, ['1', '2', '3']);
    const pk = new ProjectKit('mp');
    const b = pk.board();
    b.add('V1', P.vsource(3.3), { 1: '3V3', 2: 'GND' });
    const u1 = b.add('U1', part, { 1: '3V3', 2: 'GND', 3: 'LED' });
    b.add('R1', P.resistor(1000), { 1: 'LED', 2: 'GND' });
    const t0 = performance.now();
    const res = await runMixedSignal(pk.project, { boardId: b.board.id }, {
      duration: Number(process.env.PCBCAD_MP_SECONDS ?? 2),
      firmware: { [u1.id]: { bytes: new Uint8Array(readFileSync(mpUf2!)), format: 'uf2' } },
      emulatorOptions: { [u1.id]: { bootrom } },
      // Ctrl-B prints the banner; then drive GPIO25 from Python and evaluate an expression
      uartInput: { [`${u1.id}:USB`]: '\x02from machine import Pin\r\nPin(25, Pin.OUT).on()\r\nprint(6*7)\r\n' },
      sampleInterval: 1e-3,
    });
    const usb = res.uart.find((u) => u.port === 'USB')?.text ?? '';
    // eslint-disable-next-line no-console
    console.log(`[micropython] ${(performance.now() - t0).toFixed(0)} ms wall, status ${res.mcus[0].status}, cycles ${res.mcus[0].cycles}\n${usb}`);
    expect(usb).toMatch(/MicroPython v1\.\d+/);
    expect(usb).toMatch(/\r\n42\r\n/);
    const gp = res.digital.find((d) => d.name === 'U1.GPIO25')!;
    expect(gp.transitions[gp.transitions.length - 1][1]).toBe(1);
  });
});

/* ------------------------------------------------------------------------------------------ */

function makeUf2(data: Uint8Array, base: number): Uint8Array {
  const n = Math.ceil(data.length / 256);
  const out = new Uint8Array(n * 512);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const o = i * 512;
    dv.setUint32(o, 0x0a324655, true);
    dv.setUint32(o + 4, 0x9e5d5157, true);
    dv.setUint32(o + 8, 0x00002000, true);
    dv.setUint32(o + 12, base + i * 256, true);
    dv.setUint32(o + 16, 256, true);
    dv.setUint32(o + 20, i, true);
    dv.setUint32(o + 24, n, true);
    dv.setUint32(o + 28, 0xe48bff56, true);
    out.set(data.subarray(i * 256, i * 256 + 256), o + 32);
    dv.setUint32(o + 508, 0x0ab16f30, true);
  }
  return out;
}

function crc32mpeg2(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b << 24;
    for (let k = 0; k < 8; k++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    crc >>>= 0;
  }
  return crc >>> 0;
}

/** Hand-assembled Thumb blink for GPIO25 (vector table at flash start, no boot2). */
function rp2040BlinkBin(delay: number): Uint8Array {
  const img = new Uint8Array(0x100);
  const dv = new DataView(img.buffer);
  dv.setUint32(0, 0x20042000, true); // initial SP
  dv.setUint32(4, 0x10000041, true); // reset → 0x40 (thumb)
  for (let v = 2; v < 16; v++) dv.setUint32(v * 4, 0x10000057, true); // other vectors → 'b .' at 0x56
  const code = [
    0x4805, // 0x40 ldr r0, [pc, #20]   ; IO_BANK0 GPIO25_CTRL
    0x2105, // 0x42 movs r1, #5         ; FUNCSEL = SIO
    0x6001, // 0x44 str r1, [r0]
    0x4805, // 0x46 ldr r0, [pc, #20]   ; SIO base
    0x4905, // 0x48 ldr r1, [pc, #20]   ; 1 << 25
    0x6241, // 0x4a str r1, [r0, #0x24] ; GPIO_OE_SET
    0x61c1, // 0x4c loop: str r1, [r0, #0x1c] ; GPIO_OUT_XOR
    0x4a05, // 0x4e ldr r2, [pc, #20]   ; delay count
    0x3a01, // 0x50 subs r2, #1
    0xd1fd, // 0x52 bne 0x50
    0xe7fa, // 0x54 b 0x4c
    0xe7fe, // 0x56 b .
  ];
  code.forEach((op, i) => dv.setUint16(0x40 + i * 2, op, true));
  dv.setUint32(0x58, 0x400140cc, true);
  dv.setUint32(0x5c, 0xd0000000, true);
  dv.setUint32(0x60, 0x02000000, true);
  dv.setUint32(0x64, delay, true);
  return img;
}

/** Reference Bosch BME280 integer compensation (datasheet), used to check the chip model. */
function boschCompensate(c: number[], h: number[], d: number[]): { t: number; p: number; h: number } {
  const u16 = (i: number) => c[i] | (c[i + 1] << 8);
  const s16 = (i: number) => (u16(i) << 16) >> 16;
  const T1 = u16(0), T2 = s16(2), T3 = s16(4);
  const P1 = u16(6), P2 = s16(8), P3 = s16(10), P4 = s16(12), P5 = s16(14), P6 = s16(16), P7 = s16(18), P8 = s16(20), P9 = s16(22);
  const H1 = c[25];
  const H2 = ((h[0] | (h[1] << 8)) << 16) >> 16;
  const H3 = h[2];
  const H4 = (((h[3] << 24) >> 24) * 16) | (h[4] & 0x0f);
  const H5 = (((h[5] << 24) >> 24) * 16) | (h[4] >> 4);
  const H6 = (h[6] << 24) >> 24;
  const adcP = (d[0] << 12) | (d[1] << 4) | (d[2] >> 4);
  const adcT = (d[3] << 12) | (d[4] << 4) | (d[5] >> 4);
  const adcH = (d[6] << 8) | d[7];
  const var1 = Math.imul(((adcT >> 3) - (T1 << 1)) | 0, T2) >> 11;
  const bb = ((adcT >> 4) - T1) | 0;
  const var2 = Math.imul(Math.imul(bb, bb) >> 12, T3) >> 14;
  const tf = (var1 + var2) | 0;
  const T = (Math.imul(tf, 5) + 128) >> 8;
  let v1 = BigInt(tf) - 128000n;
  let v2 = v1 * v1 * BigInt(P6);
  v2 = v2 + ((v1 * BigInt(P5)) << 17n);
  v2 = v2 + (BigInt(P4) << 35n);
  v1 = ((v1 * v1 * BigInt(P3)) >> 8n) + ((v1 * BigInt(P2)) << 12n);
  v1 = (((1n << 47n) + v1) * BigInt(P1)) >> 33n;
  let p = 1048576n - BigInt(adcP);
  p = (((p << 31n) - v2) * 3125n) / v1;
  v1 = (BigInt(P9) * (p >> 13n) * (p >> 13n)) >> 25n;
  v2 = (BigInt(P8) * p) >> 19n;
  p = ((p + v1 + v2) >> 8n) + (BigInt(P7) << 4n);
  let x = (tf - 76800) | 0;
  x = Math.imul(
    (((((adcH << 14) - (H4 << 20) - Math.imul(H5, x)) | 0) + 16384) | 0) >> 15,
    (Math.imul((((Math.imul(Math.imul(x, H6) >> 10, ((Math.imul(x, H3) >> 11) + 32768) | 0) >> 10) + 2097152) | 0), H2) + 8192) >> 14,
  );
  x = (x - (Math.imul(Math.imul(x >> 15, x >> 15) >> 7, H1) >> 4)) | 0;
  x = Math.min(Math.max(x, 0), 419430400);
  return { t: T / 100, p: Number(p) / 256, h: (x >> 12) / 1024 };
}

describe('README examples and engine edge cases', () => {
  const readme = readFileSync(resolve(here, 'README.md'), 'utf8');
  const block = (heading: string) => {
    const i = readme.indexOf(heading);
    const start = readme.indexOf('```js\n', i) + 6;
    return readme.slice(start, readme.indexOf('```', start));
  };

  it('README example 1 (TMP102-style I2C sensor) validates and works', () => {
    const code = block('## Example 1');
    const fs = createFunctionSandbox();
    expect(validateBehaviorScript(code, 'chip', fs)).toMatchObject({ ok: true, errors: [] });
    const inst = fs.compile(code, 'tmp102').instantiate({ host: { call: (op) => (op === 'hasPin' ? false : 0) }, params: { temperatureC: 26.5 }, meta: {} });
    inst.invoke('setup', 0);
    expect(inst.invoke('i2c.address', 0)).toBe(0x48);
    inst.invoke('i2c.start', 0, [false]);
    inst.invoke('i2c.write', 0, [0]);
    inst.invoke('i2c.start', 0, [true]);
    const msb = inst.invoke('i2c.read', 0, [true]) as number;
    const lsb = inst.invoke('i2c.read', 0, [false]) as number;
    expect((((msb << 8) | lsb) >> 4) * 0.0625).toBeCloseTo(26.5, 4);
  });

  it('README example 2 (bytecode CPU emulator) runs as script:<id>', async () => {
    const script: BehaviorScript = { id: 'readme:cpu', name: 'toy cpu', kind: 'mcu-emulator', code: block('## Example 2'), updatedAt: '', author: 'agent' };
    const fs = createFunctionSandbox();
    expect(validateBehaviorScript(script.code, 'mcu-emulator', fs).ok).toBe(true);
    const pk = new ProjectKit('toy');
    const b = pk.board();
    b.add('V1', P.vsource(3.3), { 1: 'VCC', 2: 'GND' });
    const cpu = makePart('mcu', { kind: 'mcu', emulator: 'script:readme:cpu', clockHz: 1e6, supplyPins: ['1'], groundPins: ['2'], Icc: 0.001, pinMap: { P0: '3' } }, ['1', '2', '3']);
    const u1 = b.add('U1', cpu, { 1: 'VCC', 2: 'GND', 3: 'OUT' });
    b.add('R1', P.resistor(1000), { 1: 'OUT', 2: 'GND' });
    // print 'H'; loop: P0 high, wait 5 ms, P0 low, wait 5 ms, jump 1
    const fw = new Uint8Array([5, 72, 1, 0, 3, 5, 2, 0, 3, 5, 4, 1]);
    const res = await runMixedSignal(pk.project, { boardId: b.board.id }, { duration: 0.05, firmware: { [u1.id]: { bytes: fw, format: 'bin' } }, behaviors: [script], sandbox: fs });
    expect(res.uart.find((u) => u.componentId === u1.id)?.text).toBe('H');
    const rises = res.digital.find((d) => d.name === 'U1.P0')!.transitions.filter(([, l]) => l === 1).map(([t]) => t);
    expect(rises.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < rises.length; i++) expect(Math.abs(rises[i] - rises[i - 1] - 0.01)).toBeLessThan(2e-4);
  });

  it('two MCUs run concurrently; abort signal stops a run', async () => {
    const pk = new ProjectKit('two');
    const b = pk.board();
    b.add('V1', P.vsource(5), { 1: 'VCC', 2: 'GND' });
    const fw: Record<string, { bytes: Uint8Array; format: 'hex' }> = {};
    for (const ref of ['U1', 'U2']) {
      const u = b.add(ref, atmega328p(), { 4: 'VCC', 6: 'VCC', 18: 'VCC', 3: 'GND', 5: 'GND', 21: 'GND', 17: `${ref}_LED` });
      b.add(`R${ref}`, P.resistor(1000), { 1: `${ref}_LED`, 2: 'GND' });
      fw[u.id] = { bytes: hex('blink/blink.hex'), format: 'hex' };
    }
    const res = await runMixedSignal(pk.project, { boardId: b.board.id }, { duration: 1.1, firmware: fw });
    for (const ref of ['U1', 'U2']) {
      const tr = res.digital.find((d) => d.name === `${ref}.PB5`)!;
      expect(tr.transitions.filter(([, l]) => l === 1).length).toBe(2);
    }
    const ac = new AbortController();
    const p = runMixedSignal(pk.project, { boardId: b.board.id }, { duration: 50, firmware: fw, signal: ac.signal, onProgress: (f) => f > 0.002 && ac.abort() });
    await expect(p).rejects.toThrow(/aborted/);
  });

  it('chip-to-chip: step() edges, onInput counting, analog drive read back with voltage()', async () => {
    const gen: BehaviorScript = {
      id: 'agent:gen',
      name: 'gen',
      kind: 'chip',
      updatedAt: '',
      author: 'agent',
      code: `return { interval: 0.001, setup(chip) { chip.state.on = false; chip.drive('AOUT', 1.25); },
        step(chip) { chip.state.on = !chip.state.on; chip.drive('OUT', chip.state.on); } };`,
    };
    const cnt: BehaviorScript = {
      id: 'agent:cnt',
      name: 'cnt',
      kind: 'chip',
      updatedAt: '',
      author: 'agent',
      code: `return { inputs: ['IN'], setup(chip) { chip.state.edges = 0; },
        onInput(chip, pin, level) { if (pin === 'IN' && level) { chip.state.edges++; chip.state.v = chip.voltage('AIN'); } } };`,
    };
    const pk = new ProjectKit('chips');
    const b = pk.board();
    b.add('V1', P.vsource(3.3), { 1: 'VCC', 2: 'GND' });
    const g = makePart('ic', { kind: 'ic', supplyPins: ['1'], groundPins: ['2'], Icc: 0.001, behaviorId: 'agent:gen' }, [['1', 'VCC'], ['2', 'GND'], ['3', 'OUT'], ['4', 'AOUT']]);
    const c = makePart('ic', { kind: 'ic', supplyPins: ['1'], groundPins: ['2'], Icc: 0.001, behaviorId: 'agent:cnt' }, [['1', 'VCC'], ['2', 'GND'], ['3', 'IN'], ['4', 'AIN']]);
    b.add('U1', g, { 1: 'VCC', 2: 'GND', 3: 'SIG', 4: 'ANA' });
    const u2 = b.add('U2', c, { 1: 'VCC', 2: 'GND', 3: 'SIG', 4: 'ANA' });
    b.add('RL', P.resistor(10e3), { 1: 'ANA', 2: 'GND' });
    const sb = createNodeSandbox();
    sandboxes.push(sb);
    const res = await runMixedSignal(pk.project, { boardId: b.board.id }, { duration: 0.0205, firmware: {}, behaviors: [gen, cnt], sandbox: sb });
    const st = res.chipStates[u2.id] as { edges: number; v: number };
    expect(st.edges).toBe(10);
    // 1.25 V through 25 Ω into 10 kΩ
    expect(st.v).toBeCloseTo(1.25 * (10e3 / (10e3 + 25)), 4);
  });
});
