/**
 * RP2040 emulator on rp2040js: Cortex-M0+ core, GPIO 0..29 (pin drivers), UART0/1, USB CDC
 * (as UART port 'USB'), I2C0/1 and SPI0/1 at transaction level (bus pins taken from the live GPIO
 * function select), ADC channels 0..3 (GPIO26..29) and the temperature sensor.
 *
 * BOOTROM: rp2040js does not ship the RP2040 mask ROM, and every pico-sdk / MicroPython image
 * needs it (boot2 is entered with the ROM's stack and the runtime calls ROM helper functions).
 * The ROM (raspberrypi/pico-bootrom, revision B1) contains code whose licence restricts use to
 * RP2040 devices, so it is NOT bundled. Supply it explicitly as 16 KB (Uint32Array of 4096 words
 * or Uint8Array of 16384 bytes) either globally with {@link setRp2040Bootrom} or per MCU via
 * `runMixedSignal(..., { emulatorOptions: { [componentId]: { bootrom } } })`. The rp2040js GitHub
 * repository has it as `demo/bootrom.ts` (`bootromB1`).
 * Without a bootrom only bare-metal images that start from a vector table at 0x10000000 and do
 * not call ROM functions can run; images containing a pico-sdk boot2 stage are rejected with a
 * clear error.
 */
import type { RP2040, Simulator, USBCDC as USBCDCType } from 'rp2040js';
import { decodeFirmware, parseUf2 } from '../firmware';
import type { BusPorts, EmulatorContext, FirmwareInput, McuEmulator, McuHost, PinDrive } from '../types';

let globalBootrom: Uint32Array | null = null;

/** Normalise a bootrom given as words or bytes to a 4096-word Uint32Array. */
export function normalizeBootrom(rom: Uint32Array | Uint8Array | ArrayLike<number>): Uint32Array {
  if (rom instanceof Uint32Array) {
    if (rom.length > 4096) throw new Error('RP2040 bootrom must be at most 16 KB');
    return rom;
  }
  if (rom instanceof Uint8Array) {
    if (rom.length > 16384) throw new Error('RP2040 bootrom must be at most 16 KB');
    const out = new Uint32Array(4096);
    new Uint8Array(out.buffer).set(rom);
    return out;
  }
  return Uint32Array.from(rom as ArrayLike<number>);
}

/** Register the RP2040 B1 bootrom used by every 'rp2040' emulator instance (null to clear). */
export function setRp2040Bootrom(rom: Uint32Array | Uint8Array | null): void {
  globalBootrom = rom ? normalizeBootrom(rom) : null;
}

const FLASH_BASE = 0x10000000;
const SRAM_BASE = 0x20000000;

function crc32Boot2(data: Uint8Array): number {
  // CRC-32/MPEG-2 (poly 0x04C11DB7, init 0xFFFFFFFF, not reflected, no final xor)
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 24;
    for (let b = 0; b < 8; b++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    crc >>>= 0;
  }
  return crc >>> 0;
}

/** True if flash starts with a valid pico-sdk boot2 stage (CRC at offset 252). */
export function hasBoot2(flash: Uint8Array): boolean {
  const dv = new DataView(flash.buffer, flash.byteOffset, 256);
  return crc32Boot2(flash.subarray(0, 252)) === dv.getUint32(252, true);
}

function stateToDrive(state: number): PinDrive {
  switch (state) {
    case 0:
      return 'low';
    case 1:
      return 'high';
    case 3:
      return 'pullup';
    case 4:
      return 'pulldown';
    default:
      return 'z';
  }
}

type Rp2040Module = typeof import('rp2040js');

class Rp2040Emulator implements McuEmulator {
  readonly clockHz: number;
  readonly ports: string[] = [];
  readonly primaryUart = 'UART0';
  status = 'reset';
  private readonly host: McuHost;
  private readonly sim: Simulator;
  private readonly mcu: RP2040;
  private readonly cdc: USBCDCType;
  private readonly bootrom: Uint32Array | null;
  private limitNs = 0;
  private cyc = 0;
  private cdcConnected = false;
  private readonly cdcPending: number[] = [];
  private readonly uartQueues: number[][] = [[], []];
  private readonly uartAlarms: { schedule(ns: number): void; cancel(): void }[];
  private logged = 0;

  constructor(mod: Rp2040Module, ctx: EmulatorContext) {
    this.host = ctx.host;
    this.clockHz = ctx.clockHz || 125e6;
    const opt = ctx.options?.bootrom as Uint32Array | Uint8Array | undefined;
    this.bootrom = opt ? normalizeBootrom(opt) : globalBootrom;
    this.sim = new mod.Simulator();
    this.mcu = this.sim.rp2040;
    const mcu = this.mcu;
    const host = this.host;
    mcu.logger = {
      debug: () => {},
      info: () => {},
      warn: (c: string, m: string) => this.logLimited('warn', `${c}: ${m}`),
      error: (c: string, m: string) => this.logLimited('error', `${c}: ${m}`),
    };
    if (this.bootrom) mcu.loadBootrom(this.bootrom);
    for (let i = 0; i < mcu.gpio.length; i++) {
      const port = `GPIO${i}`;
      this.ports.push(port);
      mcu.gpio[i].addListener((state: number) => host.pinChanged(port, stateToDrive(state)));
    }
    mcu.uart[0].onByte = (b: number) => host.uartTx('UART0', b);
    mcu.uart[1].onByte = (b: number) => host.uartTx('UART1', b);
    this.uartAlarms = [0, 1].map((n) => {
      const alarm = mcu.clock.createAlarm(() => {
        const q = this.uartQueues[n];
        if (!q.length) return;
        mcu.uart[n].feedByte(q.shift()!);
        if (q.length) alarm.schedule(this.byteNanos(n));
      });
      return alarm;
    });
    mcu.i2c.forEach((i2c, n) => {
      const bus = `I2C${n}`;
      i2c.onStart = (repeated: boolean) => {
        host.i2cStart(bus, repeated);
        i2c.completeStart();
      };
      i2c.onConnect = (address: number, mode: number) => {
        i2c.completeConnect(host.i2cAddress(bus, address, mode === 1));
      };
      i2c.onWriteByte = (v: number) => i2c.completeWrite(host.i2cWrite(bus, v));
      i2c.onReadByte = (ack: boolean) => i2c.completeRead(host.i2cRead(bus, ack) & 0xff);
      i2c.onStop = () => {
        host.i2cStop(bus);
        i2c.completeStop();
      };
    });
    mcu.spi.forEach((spi, n) => {
      const bus = `SPI${n}`;
      spi.onTransmit = (v: number) => spi.completeTransmit(host.spiTransfer(bus, v) & 0xff);
    });
    const adc = mcu.adc;
    adc.onADCRead = (channel: number) => {
      adc.channelValues[channel] = this.adcCode(channel);
      adc.currentChannel = channel;
      adc.sampleAlarm.schedule(adc.sampleTime * 1000);
    };
    this.cdc = new mod.USBCDC(mcu.usbCtrl);
    this.cdc.onDeviceConnected = () => {
      this.cdcConnected = true;
      for (const b of this.cdcPending.splice(0)) this.cdc.sendSerialByte(b);
    };
    this.cdc.onSerialData = (buf: Uint8Array) => {
      for (const b of buf) host.uartTx('USB', b);
    };
  }

  private logLimited(level: 'warn' | 'error', msg: string): void {
    if (this.logged++ < 50) this.host.log(level, msg);
  }

  private byteNanos(n: number): number {
    const baud = this.mcu.uart[n].baudRate || 115200;
    return (10 / baud) * 1e9;
  }

  private adcCode(channel: number): number {
    const vref = this.host.supply() || 3.3;
    let v: number;
    if (channel < 4) v = this.host.voltage(`GPIO${26 + channel}`);
    else v = 0.706 - (this.host.environment.temperatureC - 27) * 0.001721;
    return Math.max(0, Math.min(4095, Math.floor((v / vref) * 4096)));
  }

  get time(): number {
    return this.sim.clock.nanos / 1e9;
  }

  get cycles(): number {
    return Math.round(this.cyc);
  }

  load(fw: FirmwareInput): void {
    const mcu = this.mcu;
    const segs =
      fw.format === 'uf2'
        ? (() => {
            const r = parseUf2(fw.bytes);
            return r.segments;
          })()
        : decodeFirmware(fw.bytes, fw.format, { binBase: FLASH_BASE });
    let flashBytes = 0;
    for (const s of segs) {
      if (s.address >= FLASH_BASE && s.address + s.data.length <= FLASH_BASE + mcu.flash.length) {
        mcu.flash.set(s.data, s.address - FLASH_BASE);
        flashBytes += s.data.length;
      } else if (s.address >= SRAM_BASE && s.address + s.data.length <= SRAM_BASE + mcu.sram.length) {
        mcu.sram.set(s.data, s.address - SRAM_BASE);
      } else if (s.address < 0x4000 && fw.format === 'bin') {
        mcu.flash.set(s.data, s.address);
        flashBytes += s.data.length;
      } else {
        throw new Error(`Firmware segment at 0x${s.address.toString(16)} is outside RP2040 flash/SRAM`);
      }
    }
    if (!flashBytes) throw new Error('Firmware image has no data in flash (0x10000000…)');
    const core = mcu.core;
    if (hasBoot2(mcu.flash)) {
      if (!this.bootrom)
        throw new Error(
          'This RP2040 image starts with a pico-sdk boot2 stage and needs the RP2040 bootrom, which is not bundled. Provide the B1 bootrom (16 KB) via setRp2040Bootrom() or emulatorOptions[componentId].bootrom — see packages/sim/src/mixed/README.md.',
        );
      // Like the rp2040js demos: enter boot2 from flash with the ROM's initial SP and LR = 0.
      core.PC = FLASH_BASE;
    } else {
      // bare vector table at the start of flash
      const sp = mcu.flashView.getUint32(0, true);
      const pc = mcu.flashView.getUint32(4, true);
      if ((pc & ~1) < FLASH_BASE || (pc & ~1) >= FLASH_BASE + mcu.flash.length) throw new Error('No boot2 stage and no valid vector table at the start of flash');
      core.VTOR = FLASH_BASE;
      core.SP = sp;
      core.PC = pc & ~1;
      if (!this.bootrom) this.host.log('warn', 'RP2040: no bootrom loaded — running a bare-metal image; ROM function calls would fault');
    }
    this.status = 'running';
  }

  run(untilTime: number): void {
    const clock = this.sim.clock;
    const core = this.mcu.core;
    const mcu = this.mcu;
    this.limitNs = untilTime * 1e9;
    let guard = 0;
    while (clock.nanos < this.limitNs) {
      if (core.waiting) {
        const hasAlarm = (clock as unknown as { nextAlarm: unknown }).nextAlarm != null;
        const left = this.limitNs - clock.nanos;
        const toAlarm = hasAlarm ? clock.nanosToNextAlarm : Infinity;
        if (toAlarm > left) {
          clock.tick(left);
          this.cyc += (left * mcu.clkSys) / 1e9;
          break;
        }
        clock.tick(Math.max(0, toAlarm));
        this.cyc += (Math.max(0, toAlarm) * mcu.clkSys) / 1e9;
        if (toAlarm <= 0 && ++guard > 1_000_000) break;
      } else {
        const cycles = core.executeInstruction();
        this.cyc += cycles;
        clock.tick((cycles * 1e9) / mcu.clkSys);
      }
    }
  }

  stopAt(time: number): void {
    const ns = time * 1e9;
    if (ns < this.limitNs) this.limitNs = ns;
  }

  setInput(port: string, high: boolean): void {
    const i = Number(port.replace(/^GPIO/i, ''));
    if (Number.isInteger(i) && this.mcu.gpio[i]) this.mcu.gpio[i].setInputValue(high);
  }

  uartReceive(port: string, bytes: number[]): void {
    if (port === 'USB') {
      if (this.cdcConnected) for (const b of bytes) this.cdc.sendSerialByte(b);
      else this.cdcPending.push(...bytes);
      return;
    }
    const n = port === 'UART1' ? 1 : 0;
    const q = this.uartQueues[n];
    const wasEmpty = q.length === 0;
    q.push(...bytes);
    if (wasEmpty) this.uartAlarms[n].schedule(this.byteNanos(n));
  }

  busPorts(bus: string): BusPorts | undefined {
    const gpio = this.mcu.gpio;
    const find = (func: number, pred: (i: number) => boolean): string | undefined => {
      for (let i = 0; i < gpio.length; i++) if (gpio[i].functionSelect === func && pred(i)) return `GPIO${i}`;
      return undefined;
    };
    let m = /^I2C([01])$/.exec(bus);
    if (m) {
      const n = Number(m[1]);
      return { sda: find(3, (i) => i % 4 === 2 * n), scl: find(3, (i) => i % 4 === 2 * n + 1) };
    }
    m = /^SPI([01])$/.exec(bus);
    if (m) {
      const n = Number(m[1]);
      const isN = (i: number) => ((i >> 3) & 1) === n;
      return { miso: find(1, (i) => isN(i) && i % 4 === 0), sck: find(1, (i) => isN(i) && i % 4 === 2), mosi: find(1, (i) => isN(i) && i % 4 === 3) };
    }
    m = /^UART([01])$/.exec(bus);
    if (m) {
      const n = Number(m[1]);
      const isN = (i: number) => (((i + 4) >> 3) & 1) === n;
      return { tx: find(2, (i) => isN(i) && i % 4 === 0), rx: find(2, (i) => isN(i) && i % 4 === 1) };
    }
    return undefined;
  }
}

/** Factory for 'rp2040' (lazy-loads rp2040js). */
export async function createRp2040(ctx: EmulatorContext): Promise<McuEmulator> {
  const mod = await import('rp2040js');
  return new Rp2040Emulator(mod, ctx);
}
