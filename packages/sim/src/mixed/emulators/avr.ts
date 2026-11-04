/**
 * ATmega328P emulator on avr8js: CPU, GPIO ports B/C/D, timers 0/1/2, USART0, TWI, SPI, ADC,
 * EEPROM, watchdog and clock prescaler. Peripherals are bridged to the co-simulation host:
 * GPIO → pin drivers, TWI → transaction-level I2C bus (byte timing from TWBR/TWPS), SPI →
 * transaction-level SPI bus, USART0 ↔ UART text, ADC → analog node voltages.
 */
import {
  ADCMuxInputType,
  ADCReference,
  AVRADC,
  AVRClock,
  AVREEPROM,
  AVRIOPort,
  AVRSPI,
  AVRTWI,
  AVRTimer,
  AVRUSART,
  AVRWatchdog,
  CPU,
  EEPROMMemoryBackend,
  PinState,
  adcConfig,
  avrInstruction,
  clockConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  spiConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  twiConfig,
  usart0Config,
  watchdogConfig,
} from 'avr8js';
import type { ADCMuxInput } from 'avr8js';
import { decodeFirmware } from '../firmware';
import type { BusPorts, EmulatorContext, FirmwareInput, McuEmulator, McuHost, PinDrive } from '../types';

/** Default ATmega328P TQFP-32 pin map (port name → package pin number). */
export const ATMEGA328P_TQFP32_PINMAP: Readonly<Record<string, string>> = Object.freeze({
  PD3: '1',
  PD4: '2',
  PB6: '7',
  PB7: '8',
  PD5: '9',
  PD6: '10',
  PD7: '11',
  PB0: '12',
  PB1: '13',
  PB2: '14',
  PB3: '15',
  PB4: '16',
  PB5: '17',
  AVCC: '18',
  ADC6: '19',
  AREF: '20',
  ADC7: '22',
  PC0: '23',
  PC1: '24',
  PC2: '25',
  PC3: '26',
  PC4: '27',
  PC5: '28',
  PC6: '29',
  PD0: '30',
  PD1: '31',
  PD2: '32',
});
export const ATMEGA328P_TQFP32_SUPPLY = ['4', '6', '18'];
export const ATMEGA328P_TQFP32_GROUND = ['3', '5', '21'];

const FLASH_BYTES = 32 * 1024;

function stateToDrive(s: PinState): PinDrive {
  switch (s) {
    case PinState.High:
      return 'high';
    case PinState.Low:
      return 'low';
    case PinState.InputPullUp:
      return 'pullup';
    default:
      return 'z';
  }
}

class AvrEmulator implements McuEmulator {
  readonly clockHz: number;
  readonly ports: string[];
  readonly primaryUart = 'USART0';
  status = 'reset';
  private readonly host: McuHost;
  private readonly cpu: CPU;
  private readonly portObjs: { name: string; port: AVRIOPort; last: PinDrive[]; bits: number }[];
  private readonly usart: AVRUSART;
  private readonly twi: AVRTWI;
  private readonly spi: AVRSPI;
  private readonly adc: AVRADC;
  private limit = 0;
  private readonly rxQueue: number[] = [];

  constructor(ctx: EmulatorContext) {
    this.clockHz = ctx.clockHz || 16e6;
    this.host = ctx.host;
    const prog = new Uint16Array(FLASH_BYTES / 2);
    prog.fill(0xffff);
    this.cpu = new CPU(prog, 2048);
    const cpu = this.cpu;
    const clock = new AVRClock(cpu, this.clockHz, clockConfig);
    this.portObjs = [
      { name: 'PB', port: new AVRIOPort(cpu, portBConfig), last: [], bits: 8 },
      { name: 'PC', port: new AVRIOPort(cpu, portCConfig), last: [], bits: 7 },
      { name: 'PD', port: new AVRIOPort(cpu, portDConfig), last: [], bits: 8 },
    ];
    this.ports = [];
    for (const p of this.portObjs) {
      for (let i = 0; i < p.bits; i++) {
        p.last.push('z');
        this.ports.push(`${p.name}${i}`);
      }
      p.port.addListener(() => this.portChanged(p));
    }
    new AVRTimer(cpu, timer0Config);
    new AVRTimer(cpu, timer1Config);
    new AVRTimer(cpu, timer2Config);
    new AVREEPROM(cpu, new EEPROMMemoryBackend(1024));
    new AVRWatchdog(cpu, watchdogConfig, clock);
    this.usart = new AVRUSART(cpu, usart0Config, this.clockHz);
    this.usart.onByteTransmit = (b) => this.host.uartTx('USART0', b);
    this.usart.onRxComplete = () => this.feedRx();
    this.usart.onConfigurationChange = () => this.feedRx();
    this.twi = new AVRTWI(cpu, twiConfig, this.clockHz);
    const twi = this.twi;
    const bitCycles = () => Math.max(1, Math.round(this.clockHz / Math.max(1, twi.sclFrequency)));
    twi.eventHandler = {
      start: (repeated: boolean) => {
        this.host.i2cStart('TWI', repeated);
        cpu.addClockEvent(() => twi.completeStart(), bitCycles());
      },
      stop: () => {
        this.host.i2cStop('TWI');
        cpu.addClockEvent(() => twi.completeStop(), bitCycles());
      },
      connectToSlave: (addr: number, write: boolean) => {
        const ack = this.host.i2cAddress('TWI', addr, !write);
        cpu.addClockEvent(() => twi.completeConnect(ack), 9 * bitCycles());
      },
      writeByte: (value: number) => {
        const ack = this.host.i2cWrite('TWI', value);
        cpu.addClockEvent(() => twi.completeWrite(ack), 9 * bitCycles());
      },
      readByte: (ack: boolean) => {
        const v = this.host.i2cRead('TWI', ack) & 0xff;
        cpu.addClockEvent(() => twi.completeRead(v), 9 * bitCycles());
      },
    };
    this.spi = new AVRSPI(cpu, spiConfig, this.clockHz);
    const spi = this.spi;
    spi.onByte = (value: number) => {
      const r = spi.isMaster ? this.host.spiTransfer('SPI', value) & 0xff : 0xff;
      cpu.addClockEvent(() => spi.completeTransfer(r), spi.transferCycles);
    };
    this.adc = new AVRADC(cpu, adcConfig);
    const adc = this.adc;
    adc.onADCRead = (input: ADCMuxInput) => {
      cpu.addClockEvent(() => adc.completeADCRead(this.adcValue(input)), adc.sampleCycles);
    };
  }

  private adcValue(input: ADCMuxInput): number {
    let ref: number;
    switch (this.adc.referenceVoltageType) {
      case ADCReference.AREF:
        ref = this.safeVoltage('AREF', this.host.supply());
        break;
      case ADCReference.Internal1V1:
        ref = 1.1;
        break;
      default:
        ref = this.safeVoltage('AVCC', this.host.supply());
    }
    let v = 0;
    switch (input.type) {
      case ADCMuxInputType.SingleEnded:
        v = input.channel < 6 ? this.host.voltage(`PC${input.channel}`) : this.safeVoltage(`ADC${input.channel}`, 0);
        break;
      case ADCMuxInputType.Constant:
        v = input.voltage;
        break;
      case ADCMuxInputType.Temperature:
        v = 0.314 + (this.host.environment.temperatureC - 25) * 0.00106;
        break;
      default:
        v = 0;
    }
    if (!(ref > 0)) return 0;
    return Math.min(1023, Math.max(0, Math.floor((v / ref) * 1024)));
  }

  private safeVoltage(port: string, dflt: number): number {
    try {
      return this.host.voltage(port);
    } catch {
      return dflt;
    }
  }

  private portChanged(p: { name: string; port: AVRIOPort; last: PinDrive[]; bits: number }): void {
    for (let i = 0; i < p.bits; i++) {
      const d = stateToDrive(p.port.pinState(i));
      if (d !== p.last[i]) {
        p.last[i] = d;
        this.host.pinChanged(`${p.name}${i}`, d);
      }
    }
  }

  private feedRx(): void {
    const u = this.usart;
    if (!this.rxQueue.length || !u.rxEnable || u.rxBusy) return;
    const b = this.rxQueue.shift()!;
    u.writeByte(b);
  }

  get time(): number {
    return this.cpu.cycles / this.clockHz;
  }

  get cycles(): number {
    return this.cpu.cycles;
  }

  load(fw: FirmwareInput): void {
    if (fw.format === 'uf2') throw new Error('UF2 images are not supported by the AVR emulator (use .hex, .bin or .elf)');
    const segs = decodeFirmware(fw.bytes, fw.format, { binBase: 0 });
    const bytes = this.cpu.progBytes;
    let loaded = 0;
    let dropped = 0;
    for (const s of segs) {
      for (let i = 0; i < s.data.length; i++) {
        const a = s.address + i;
        if (a < FLASH_BYTES) {
          bytes[a] = s.data[i];
          loaded++;
        } else dropped++;
      }
    }
    if (!loaded) throw new Error('Firmware image contains no data inside the 32 KB flash');
    if (dropped) this.host.log('warn', `${dropped} firmware byte(s) outside the 32 KB flash were ignored`);
    this.cpu.reset();
    this.status = 'running';
  }

  run(untilTime: number): void {
    const cpu = this.cpu;
    this.limit = Math.ceil(untilTime * this.clockHz - 1e-6);
    while (cpu.cycles < this.limit) {
      avrInstruction(cpu);
      cpu.tick();
    }
  }

  stopAt(time: number): void {
    const c = Math.ceil(time * this.clockHz - 1e-6);
    if (c < this.limit) this.limit = c;
  }

  setInput(port: string, high: boolean): void {
    const p = this.portObjs.find((x) => port.startsWith(x.name));
    if (!p) return;
    const idx = Number(port.slice(2));
    if (idx >= 0 && idx < p.bits) p.port.setPin(idx, high);
  }

  uartReceive(port: string, bytes: number[]): void {
    if (port !== 'USART0') return;
    for (const b of bytes) this.rxQueue.push(b & 0xff);
    this.feedRx();
  }

  busPorts(bus: string): BusPorts | undefined {
    switch (bus) {
      case 'TWI':
        return { sda: 'PC4', scl: 'PC5' };
      case 'SPI':
        return { sck: 'PB5', mosi: 'PB3', miso: 'PB4' };
      case 'USART0':
        return { tx: 'PD1', rx: 'PD0' };
      default:
        return undefined;
    }
  }
}

/** Factory for 'avr:atmega328p' (clock from part sim clockHz, default 16 MHz). */
export function createAtmega328p(ctx: EmulatorContext): McuEmulator {
  return new AvrEmulator(ctx);
}
