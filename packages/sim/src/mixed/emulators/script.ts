/**
 * 'script:<behaviorId>' — agent-authored CPU emulator (BehaviorScript of kind 'mcu-emulator').
 *
 * The script returns { load(mcu, bytes, format), run(mcu, cycles) → cyclesExecuted?, reset?(mcu),
 * onInput?(mcu, port, level, t), uart?: { receive(mcu, byte) } } and uses the same pin API as chip
 * scripts (mcu.read / drive / voltage / uartSend / log / state / params / time), with pins named by
 * pinMap port ('GPIO3'), package pin number or pin name. run() is called in slices of at most
 * 100 µs; pin changes made inside run() are time-stamped at the start of the slice.
 */
import type { EmulatorContext, FirmwareInput, McuEmulator, PinDrive, ScriptInstance, ScriptValue } from '../types';

const SLICE = 100e-6;

function binaryString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
  return s;
}

class ScriptEmulator implements McuEmulator {
  readonly clockHz: number;
  readonly ports: string[];
  readonly primaryUart = 'UART0';
  status = 'reset';
  time = 0;
  cycles = 0;
  private limit = 0;
  private readonly inputs = new Map<string, boolean>();
  private readonly inst: ScriptInstance;
  private readonly portOfPin = new Map<string, string>();
  private readonly ctx: EmulatorContext;

  constructor(ctx: EmulatorContext, scriptId: string) {
    this.ctx = ctx;
    this.clockHz = ctx.clockHz || 1e6;
    this.ports = Object.keys(ctx.model.pinMap ?? {});
    for (const [port, pin] of Object.entries(ctx.model.pinMap ?? {})) this.portOfPin.set(String(pin), port);
    const script = ctx.behavior(scriptId);
    if (!script) throw new Error(`Emulator script '${scriptId}' not found (project behaviours or opts.behaviors)`);
    if (script.kind !== 'mcu-emulator') throw new Error(`Behaviour '${scriptId}' is a '${script.kind}' script, not an 'mcu-emulator'`);
    const compiled = ctx.sandbox().compile(script.code, script.id);
    const host = ctx.host;
    this.inst = compiled.instantiate({
      host: {
        call: (op: string, a?: ScriptValue, b?: ScriptValue): ScriptValue => {
          switch (op) {
            case 'read': {
              const port = this.port(a);
              const v = this.inputs.get(port);
              if (v !== undefined) return v ? 1 : 0;
              return host.voltage(port) > 0.5 * host.supply() ? 1 : 0;
            }
            case 'voltage':
              return host.voltage(this.port(a));
            case 'drive': {
              if (typeof b === 'number') throw new Error('MCU pins cannot output an analog voltage; use high/low/z/pullup/pulldown');
              host.pinChanged(this.port(a), b as PinDrive);
              return undefined;
            }
            case 'uart': {
              const bytes = typeof a === 'number' ? [a & 0xff] : Array.from(String(a), (c) => c.charCodeAt(0) & 0xff);
              for (const x of bytes) host.uartTx('UART0', x);
              return undefined;
            }
            case 'log':
              host.log('info', String(a));
              return undefined;
            case 'warn':
              host.log('warn', String(a));
              return undefined;
            case 'supply':
              return host.supply();
            case 'hasPin':
              try {
                this.port(a);
                return true;
              } catch {
                return false;
              }
            default:
              throw new Error(`unknown mcu API call '${op}'`);
          }
        },
      },
      params: { ...(ctx.options ?? {}), temperatureC: host.environment.temperatureC },
      meta: { ref: ctx.component.ref, id: ctx.component.id, kind: 'mcu-emulator', clockHz: this.clockHz, pins: this.ports.map((p) => [ctx.model.pinMap[p], p]), seed: 1 },
    });
    if (!this.inst.shape.hooks.includes('run') || !this.inst.shape.hooks.includes('load')) throw new Error(`Emulator script '${scriptId}' must define load(mcu, bytes, format) and run(mcu, cycles)`);
  }

  private port(ref: ScriptValue): string {
    const s = String(ref);
    if (this.ctx.model.pinMap?.[s] !== undefined) return s;
    const byPin = this.portOfPin.get(s);
    if (byPin) return byPin;
    const up = s.toUpperCase();
    const hit = this.ports.find((p) => p.toUpperCase() === up);
    if (hit) return hit;
    throw new Error(`unknown pin '${s}' (use a pinMap port such as '${this.ports[0] ?? 'GPIO0'}' or a pin number)`);
  }

  load(fw: FirmwareInput): void {
    this.inst.invoke('load', 0, [binaryString(fw.bytes), fw.format]);
    this.status = 'running';
  }

  run(untilTime: number): void {
    this.limit = untilTime;
    while (this.time < this.limit - 1e-15) {
      const slice = Math.min(SLICE, this.limit - this.time);
      const n = Math.max(1, Math.round(slice * this.clockHz));
      const r = this.inst.invoke('run', this.time, [n]);
      const done = typeof r === 'number' && r > 0 ? r : n;
      this.cycles += done;
      this.time += done / this.clockHz;
    }
  }

  stopAt(time: number): void {
    if (time < this.limit) this.limit = Math.max(time, this.time);
  }

  setInput(port: string, high: boolean): void {
    if (this.inputs.get(port) === high) return;
    this.inputs.set(port, high);
    if (this.inst.shape.hooks.includes('onInput')) this.inst.invoke('onInput', this.time, [port, high ? 1 : 0, this.time]);
  }

  uartReceive(_port: string, bytes: number[]): void {
    if (!this.inst.shape.hooks.includes('uart.receive')) return;
    for (const b of bytes) this.inst.invoke('uart.receive', this.time, [b]);
  }

  busPorts(): undefined {
    return undefined;
  }

  dispose(): void {
    this.inst.dispose();
  }
}

/** Factory for 'script:<behaviorId>'. */
export function createScriptEmulator(ctx: EmulatorContext): McuEmulator {
  const id = ctx.name.slice(ctx.name.indexOf(':') + 1);
  return new ScriptEmulator(ctx, id);
}
