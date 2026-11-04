/**
 * Public interfaces of the mixed-signal co-simulation: MCU emulators, script sandboxes and
 * runMixedSignal options.
 */
import type { BehaviorScript, PartSimModel } from '@pcbcad/core';

/* ------------------------------------------------------------------------------------------ */
/* Firmware                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export type FirmwareFormat = 'hex' | 'bin' | 'uf2' | 'elf';

/** Firmware bytes as supplied to runMixedSignal (keyed by MCU component id). */
export interface FirmwareInput {
  bytes: Uint8Array;
  format: FirmwareFormat;
  name?: string;
}

/** A contiguous block of a memory image (absolute address). */
export interface MemorySegment {
  address: number;
  data: Uint8Array;
}

/* ------------------------------------------------------------------------------------------ */
/* Pins / emulators                                                                            */
/* ------------------------------------------------------------------------------------------ */

/** Electrical state of an MCU/chip pin output stage. */
export type PinDrive = 'z' | 'low' | 'high' | 'pullup' | 'pulldown';

/** Services the engine provides to an MCU emulator. All times are the emulator's own time. */
export interface McuHost {
  /** Report a change of a port pin's output stage (port = pinMap key, e.g. 'PB5', 'GPIO25'). */
  pinChanged(port: string, drive: PinDrive): void;
  /** Node voltage at a port pin relative to the MCU ground (V). Solves the circuit if stale. */
  voltage(port: string): number;
  /** Voltage at a package pin given by number or name (e.g. 'AREF'), relative to MCU ground (V). */
  pinVoltage(pin: string): number;
  /** MCU supply voltage (V). */
  supply(): number;
  /** Byte transmitted by a UART ('USART0', 'UART0', 'USB', ...). */
  uartTx(port: string, byte: number): void;
  /** Transaction-level I2C master bus (bus = 'TWI', 'I2C0', ...). */
  i2cStart(bus: string, repeated: boolean): void;
  /** Address phase; returns ACK. */
  i2cAddress(bus: string, address7: number, read: boolean): boolean;
  /** Master write; returns ACK. */
  i2cWrite(bus: string, byte: number): boolean;
  /** Master read; `ack` is the master's ACK for this byte. */
  i2cRead(bus: string, ack: boolean): number;
  i2cStop(bus: string): void;
  /** Full-duplex SPI master byte transfer; returns MISO byte (0xFF when nobody answers). */
  spiTransfer(bus: string, byte: number): number;
  /** Environment (sensors, internal temperature sensor). */
  environment: Required<MixedEnvironment>;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}

/** Pins used by an on-chip bus peripheral (port names). */
export interface BusPorts {
  sda?: string;
  scl?: string;
  sck?: string;
  mosi?: string;
  miso?: string;
  tx?: string;
  rx?: string;
}

/**
 * CPU emulator plugged into the co-simulation. Implementations run the firmware and report pin
 * changes through {@link McuHost.pinChanged}; the engine drives input levels via `setInput`.
 */
export interface McuEmulator {
  /** Seconds of simulated time executed so far. */
  readonly time: number;
  /** Executed CPU cycles (reporting). */
  readonly cycles: number;
  /** Nominal clock (Hz). */
  readonly clockHz: number;
  /** Port names this emulator understands (pinMap keys). */
  readonly ports: string[];
  /** Human-readable state: 'running', 'halted: …', 'error: …'. */
  status: string;
  /** Load a firmware image. Throws with a clear message on unsupported formats. */
  load(fw: FirmwareInput): void;
  /** Execute until `time` (s) or until `stopAt` lowered the limit. */
  run(untilTime: number): void;
  /** Lower the current run limit (called from inside callbacks for event coalescing). */
  stopAt(time: number): void;
  /** Digital input level seen by the CPU on a port pin. */
  setInput(port: string, high: boolean): void;
  /** Queue bytes for a UART receiver (paced at the configured baud rate). */
  uartReceive(port: string, bytes: number[]): void;
  /** Default UART used for `uartInput` (e.g. 'USART0'). */
  readonly primaryUart?: string;
  /** Pins of a bus peripheral (for wiring checks / chip matching); undefined if unknown. */
  busPorts(bus: string): BusPorts | undefined;
  dispose?(): void;
}

/** Context handed to an {@link EmulatorFactory}. */
export interface EmulatorContext {
  /** Full emulator name, e.g. 'avr:atmega328p', 'rp2040', 'script:my-cpu'. */
  name: string;
  clockHz: number;
  model: Extract<PartSimModel, { kind: 'mcu' }>;
  component: { id: string; ref: string };
  host: McuHost;
  /** Resolve a behaviour script by id (project, run options and built-ins). */
  behavior(id: string): BehaviorScript | undefined;
  sandbox(): ScriptSandbox;
  /** Extra options from runMixedSignal (`emulatorOptions[componentId]`). */
  options: Record<string, unknown>;
}

export type EmulatorFactory = (ctx: EmulatorContext) => McuEmulator | Promise<McuEmulator>;

/* ------------------------------------------------------------------------------------------ */
/* Script sandbox                                                                              */
/* ------------------------------------------------------------------------------------------ */

/** Values that cross the sandbox boundary (never objects or functions). */
export type ScriptValue = number | string | boolean | null | undefined;

/** Host side of the chip/MCU API: receives primitive-only calls from the script. */
export interface ScriptHost {
  /**
   * op: 'read' | 'voltage' | 'drive' | 'uart' | 'log' | 'supply' | 'hasPin' | 'warn'.
   * Return a primitive; throw (host-side) to raise an Error inside the script.
   */
  call(op: string, a?: ScriptValue, b?: ScriptValue): ScriptValue;
}

/** Description of a script's definition object, computed inside the sandbox. */
export interface ScriptShape {
  /** Hooks present: 'setup','step','onInput','i2c.start','i2c.write','i2c.read','i2c.stop','spi.select','spi.transfer','uart.receive','load','run','reset'. */
  hooks: string[];
  name?: string;
  interval?: number;
  inputs?: (string | number)[];
  i2c?: { address?: number; dynamicAddress: boolean; sda?: PinSpec; scl?: PinSpec };
  spi?: { sck?: PinSpec; mosi?: PinSpec; miso?: PinSpec; cs?: PinSpec; csActiveHigh?: boolean };
  uart?: { baud?: number; rx?: PinSpec; tx?: PinSpec };
}

/** Pin reference(s): a number/name or a list of candidates (first that exists wins). */
export type PinSpec = string | number | (string | number)[];

/** One running instance of a script (own realm/state). */
export interface ScriptInstance {
  readonly shape: ScriptShape;
  /**
   * Call a hook ('setup', 'step', 'i2c.write', 'i2c.address', 'run', 'state', ...). `t` is the
   * simulation time exposed as chip.time. Returns the hook's result (primitives; objects are
   * returned JSON-decoded). Throws {@link ScriptError} on script exceptions or timeouts.
   */
  invoke(path: string, t: number, args?: ScriptValue[]): unknown;
  /** JSON snapshot of chip.state. */
  snapshot(): unknown;
  dispose(): void;
}

export interface CompiledScript {
  readonly name: string;
  instantiate(opts: { host: ScriptHost; params: Record<string, unknown>; meta: Record<string, unknown> }): ScriptInstance;
}

/**
 * Executes behaviour scripts. `createFunctionSandbox()` (browser-safe, NOT isolated — trusted code
 * only) and `createNodeSandbox()` from '@pcbcad/sim/mixed/sandbox-node' (worker thread + node:vm,
 * per-call timeout) implement it.
 */
export interface ScriptSandbox {
  /** Compile a script; throws ScriptError with a readable message on syntax errors. */
  compile(code: string, name: string): CompiledScript;
  /** True when scripts run isolated from the host (safe for untrusted code). */
  readonly isolated: boolean;
  dispose?(): void;
}

/** Error raised by a script (exception, timeout, invalid API use). */
export class ScriptError extends Error {
  readonly script: string;
  readonly timeout: boolean;
  constructor(script: string, message: string, timeout = false) {
    super(message);
    this.name = 'ScriptError';
    this.script = script;
    this.timeout = timeout;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* runMixedSignal                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface MixedEnvironment {
  /** Ambient temperature (°C, default project ambient or 25). */
  temperatureC?: number;
  /** Barometric pressure (Pa, default 101325). */
  pressurePa?: number;
  /** Relative humidity (%, default 50). */
  humidityPct?: number;
}

export interface MixedSignalOptions {
  /** Simulated duration (s). */
  duration: number;
  /** Firmware per MCU component id. */
  firmware: Record<string, FirmwareInput>;
  /** Extra behaviour scripts (override project.behaviors and built-ins with the same id). */
  behaviors?: BehaviorScript[];
  /**
   * Script sandbox. Built-in scripts run in `createFunctionSandbox()` when omitted; any other
   * script REQUIRES a sandbox (pass `createNodeSandbox()` on the server, or explicitly
   * `createFunctionSandbox()` to run trusted code unisolated).
   */
  sandbox?: ScriptSandbox;
  /** 'quasi-static' (default): event-driven DC solves; 'transient': steps the transient solver. */
  analogMode?: 'quasi-static' | 'transient';
  /** Analog sampling / minimum re-solve interval (s, default 1e-3). */
  sampleInterval?: number;
  /** Text fed into UART receivers, keyed by component id (primary UART) or 'componentId:PORT'. */
  uartInput?: Record<string, string>;
  environment?: MixedEnvironment;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Per-MCU emulator options keyed by component id (e.g. { bootrom: Uint32Array } for rp2040). */
  emulatorOptions?: Record<string, Record<string, unknown>>;
  /** Minimum interval between event-driven analog re-solves (s, default 1e-6). */
  coalesce?: number;
  /** Max transitions recorded per digital pin (default 100000). */
  maxTransitions?: number;
}
