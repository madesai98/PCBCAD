/**
 * Behaviour-script runtime shared by all sandboxes.
 *
 * A script body (BehaviorScript.code) is compiled as `function (chip, mcu) { <code> }` and must
 * `return` its definition object (see README.md). The PRELUDE below runs INSIDE the sandbox realm:
 * it builds the `chip` API object on top of a single primitive-only host function and returns a
 * dispatcher used by the engine to call hooks. Only primitives cross the boundary; objects returned
 * by hooks are JSON-encoded inside the realm.
 *
 * Browser-safe module (no Node built-ins).
 */
import { ScriptError, type CompiledScript, type ScriptHost, type ScriptInstance, type ScriptSandbox, type ScriptShape, type ScriptValue } from './types';

/**
 * Source of the in-realm installer: evaluates to `install(host, paramsJson, metaJson, factory,
 * isolated)` which returns `[dispatch, shapeJson]` or an error string starting with "\u0000E".
 */
export const PRELUDE_SRC = String.raw`(function () {
'use strict';
return function install(host, paramsJson, metaJson, factory, isolated) {
  const params = Object.freeze(JSON.parse(paramsJson));
  const meta = JSON.parse(metaJson);
  let now = 0;
  const state = {};
  const fail = (r) => {
    if (typeof r === 'string' && r.length && r.charCodeAt(0) === 0) throw new Error(r.slice(1));
    return r;
  };
  const pinArg = (p) => {
    if (typeof p === 'number' && Number.isFinite(p)) return String(p);
    if (typeof p === 'string' && p.length) return p;
    throw new TypeError('pin must be a pin number or a pin name');
  };
  const str = (a) => {
    if (typeof a === 'string') return a;
    try { return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a); } catch (e) { return '[unprintable]'; }
  };
  const DRIVES = ['high', 'low', 'z', 'pullup', 'pulldown'];
  const api = {
    read(pin) { return fail(host('read', pinArg(pin))); },
    voltage(pin) { return fail(host('voltage', pinArg(pin))); },
    drive(pin, value) {
      let v = value;
      if (v === true) v = 'high';
      else if (v === false) v = 'low';
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw new TypeError('drive(): volts must be a finite number');
      } else if (DRIVES.indexOf(v) < 0) {
        throw new TypeError("drive(): value must be 'high', 'low', 'z', 'pullup', 'pulldown', a boolean or a voltage");
      }
      fail(host('drive', pinArg(pin), v));
    },
    uartSend(data) {
      if (typeof data === 'number') fail(host('uart', data & 0xff));
      else fail(host('uart', String(data)));
    },
    log(...args) { fail(host('log', args.map(str).join(' '))); },
    warn(...args) { fail(host('warn', args.map(str).join(' '))); },
    hasPin(pin) { return fail(host('hasPin', pinArg(pin))) === true; },
    supply() { return fail(host('supply')); },
    get time() { return now; },
    state: state,
    params: params,
    ref: meta.ref,
    id: meta.id,
    kind: meta.kind,
    clockHz: meta.clockHz,
    pins: Object.freeze((meta.pins || []).map((p) => Object.freeze({ number: p[0], name: p[1] }))),
  };
  Object.freeze(api);
  if (isolated) {
    let seed = (meta.seed >>> 0) || 0x9e3779b9;
    Math.random = function () {
      seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
      return seed / 4294967296;
    };
    const c = { log: (...a) => api.log(...a), info: (...a) => api.log(...a), warn: (...a) => api.warn(...a), error: (...a) => api.warn(...a), debug: () => {} };
    try { Object.defineProperty(globalThis, 'console', { value: Object.freeze(c), configurable: false, writable: false }); } catch (e) {}
  }
  let def;
  try {
    def = factory.call(undefined, api, api);
  } catch (e) {
    let m; try { m = e && e.stack ? String(e.stack) : String(e); } catch (x) { m = 'script error'; }
    return '\u0000E' + m;
  }
  if (!def || typeof def !== 'object') return '\u0000EThe script must return its definition object, e.g. return { setup(chip) {}, ... }';
  const isFn = (o, k) => !!o && typeof o === 'object' && typeof o[k] === 'function';
  const pinSpec = (v) => {
    if (typeof v === 'number' || typeof v === 'string') return v;
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'number' || typeof x === 'string');
    return undefined;
  };
  const hooks = [];
  for (const k of ['setup', 'step', 'onInput', 'load', 'run', 'reset']) if (isFn(def, k)) hooks.push(k);
  for (const k of ['start', 'write', 'read', 'stop']) if (isFn(def.i2c, k)) hooks.push('i2c.' + k);
  for (const k of ['select', 'transfer']) if (isFn(def.spi, k)) hooks.push('spi.' + k);
  if (isFn(def.uart, 'receive')) hooks.push('uart.receive');
  const i2c = def.i2c && typeof def.i2c === 'object' ? def.i2c : null;
  const spi = def.spi && typeof def.spi === 'object' ? def.spi : null;
  const uart = def.uart && typeof def.uart === 'object' ? def.uart : null;
  const shape = {
    hooks: hooks,
    name: typeof def.name === 'string' ? def.name : undefined,
    interval: typeof def.interval === 'number' && def.interval > 0 ? def.interval : undefined,
    inputs: Array.isArray(def.inputs) ? def.inputs.filter((x) => typeof x === 'number' || typeof x === 'string') : undefined,
    i2c: i2c ? { address: typeof i2c.address === 'number' ? i2c.address : undefined, dynamicAddress: typeof i2c.address === 'function', sda: pinSpec(i2c.sda), scl: pinSpec(i2c.scl) } : undefined,
    spi: spi ? { sck: pinSpec(spi.sck), mosi: pinSpec(spi.mosi), miso: pinSpec(spi.miso), cs: pinSpec(spi.cs), csActiveHigh: spi.csActiveHigh === true } : undefined,
    uart: uart ? { baud: typeof uart.baud === 'number' ? uart.baud : undefined, rx: pinSpec(uart.rx), tx: pinSpec(uart.tx) } : undefined,
  };
  const toBytes = (s) => {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
    return u;
  };
  const encode = (r) => {
    if (r === undefined || r === null || typeof r === 'number' || typeof r === 'boolean') return r;
    if (typeof r === 'string') return r.length && r.charCodeAt(0) === 0 ? '\u0000S' + r : r;
    if (typeof r === 'bigint') return Number(r);
    return '\u0000J' + JSON.stringify(r);
  };
  const dispatch = function (path, t, a0, a1, a2) {
    if (typeof t === 'number') now = t;
    try {
      let r;
      switch (path) {
        case 'setup': r = isFn(def, 'setup') ? def.setup(api) : undefined; break;
        case 'step': r = def.step(api, a0, a1); break;
        case 'onInput': r = def.onInput(api, a0, a1, a2); break;
        case 'i2c.address': r = typeof def.i2c.address === 'function' ? def.i2c.address(api) : def.i2c.address; break;
        case 'i2c.start': r = def.i2c.start(api, a0); break;
        case 'i2c.write': r = def.i2c.write(api, a0); break;
        case 'i2c.read': r = def.i2c.read(api, a0); break;
        case 'i2c.stop': r = def.i2c.stop(api); break;
        case 'spi.select': r = def.spi.select(api, a0); break;
        case 'spi.transfer': r = def.spi.transfer(api, a0); break;
        case 'uart.receive': r = def.uart.receive(api, a0); break;
        case 'load': r = def.load(api, toBytes(String(a0)), a1); break;
        case 'run': r = def.run(api, a0); break;
        case 'reset': r = def.reset(api); break;
        case 'state': return '\u0000J' + JSON.stringify(state);
        default: return '\u0000Eunknown hook ' + String(path);
      }
      return encode(r);
    } catch (e) {
      let m; try { m = e && e.stack ? String(e.stack) : String(e); } catch (x) { m = 'script error'; }
      return '\u0000E' + m;
    }
  };
  return [dispatch, JSON.stringify(shape)];
};
})()`;

/** Decode a dispatcher result (see PRELUDE_SRC encoding). */
export function decodeScriptResult(script: string, r: unknown): unknown {
  if (typeof r !== 'string' || r.length === 0 || r.charCodeAt(0) !== 0) return r;
  const tag = r[1];
  const body = r.slice(2);
  if (tag === 'J') return body === 'undefined' || body === '' ? undefined : JSON.parse(body);
  if (tag === 'S') return body;
  if (tag === 'E') throw new ScriptError(script, cleanStack(body));
  return r.slice(1);
}

/** Trim host-internal frames from a script error stack. */
export function cleanStack(msg: string): string {
  const lines = msg.split('\n');
  const keep = [lines[0]];
  for (const l of lines.slice(1)) {
    if (/install|dispatch|PRELUDE|node:|worker|sandbox-node|script-api/.test(l)) continue;
    keep.push(l);
    if (keep.length > 4) break;
  }
  return keep.join('\n');
}

/** Safe text for a `//# sourceURL` pragma. */
export function sourceName(name: string): string {
  return name.replace(/[^\w.:-]+/g, '_').slice(0, 80) || 'script';
}

type Dispatch = (path: string, t: number, a0?: ScriptValue, a1?: ScriptValue, a2?: ScriptValue) => unknown;
type Install = (host: (op: string, a?: ScriptValue, b?: ScriptValue) => ScriptValue, paramsJson: string, metaJson: string, factory: unknown, isolated: boolean) => [Dispatch, string] | string;

let installFn: Install | null = null;

function getInstall(): Install {
  if (!installFn) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    installFn = new Function(`return ${PRELUDE_SRC};`)() as Install;
  }
  return installFn;
}

/** Wrap a host into the primitive-only function used by the prelude (errors become "\0msg"). */
export function hostFunction(host: ScriptHost): (op: string, a?: ScriptValue, b?: ScriptValue) => ScriptValue {
  return (op, a, b) => {
    try {
      const r = host.call(String(op), a, b);
      if (r === undefined || r === null || typeof r === 'number' || typeof r === 'boolean' || typeof r === 'string') return r;
      return undefined;
    } catch (e) {
      return `\u0000${(e as Error)?.message ?? String(e)}`;
    }
  };
}

/**
 * Browser-safe sandbox that runs scripts with `new Function` in the CURRENT realm.
 * NOT a security boundary and no timeouts: use only for built-in/trusted scripts.
 * In Node, prefer `createNodeSandbox()` from '@pcbcad/sim/mixed/sandbox-node'.
 */
export function createFunctionSandbox(): ScriptSandbox {
  return {
    isolated: false,
    compile(code: string, name: string): CompiledScript {
      let factory: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        factory = new Function('chip', 'mcu', `${code}\n//# sourceURL=behavior:${sourceName(name)}`);
      } catch (e) {
        throw new ScriptError(name, `Syntax error in ${name}: ${(e as Error).message}`);
      }
      return {
        name,
        instantiate({ host, params, meta }): ScriptInstance {
          const res = getInstall()(hostFunction(host), JSON.stringify(params ?? {}), JSON.stringify(meta ?? {}), factory, false);
          if (typeof res === 'string') {
            decodeScriptResult(name, res);
            throw new ScriptError(name, `Script ${name} failed to initialise`);
          }
          const [dispatch, shapeJson] = res;
          const shape = JSON.parse(shapeJson) as ScriptShape;
          return {
            shape,
            invoke(path: string, t: number, args: ScriptValue[] = []): unknown {
              return decodeScriptResult(name, dispatch(path, t, args[0], args[1], args[2]));
            },
            snapshot(): unknown {
              return decodeScriptResult(name, dispatch('state', NaN));
            },
            dispose(): void {},
          };
        },
      };
    },
  };
}

/** Result of {@link validateBehaviorScript}. */
export interface BehaviorValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  shape?: ScriptShape;
}

/**
 * Validate a behaviour script. Always checks syntax (compile only, nothing executes). When a
 * `sandbox` is given the script is also instantiated there against a dummy chip (all pins read 0)
 * to check the definition object (required hooks for the kind) and run `setup()`.
 */
export function validateBehaviorScript(code: string, kind: 'chip' | 'mcu-emulator', sandbox?: ScriptSandbox): BehaviorValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof code !== 'string' || !code.trim()) return { ok: false, errors: ['Script is empty'], warnings };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('chip', 'mcu', code);
  } catch (e) {
    const msg = (e as Error).message;
    if (/Code generation from strings disallowed|unsafe-eval|EvalError/i.test(`${(e as Error).name} ${msg}`)) warnings.push('Syntax check skipped (code generation disabled in this environment)');
    else return { ok: false, errors: [`Syntax error: ${msg}`], warnings };
  }
  if (!/\breturn\b/.test(code)) errors.push('The script body must `return` its definition object, e.g. `return { i2c: { address: 0x48, write(chip, b) { … }, read(chip) { … } } };`');
  if (!sandbox) {
    if (kind === 'mcu-emulator' && !(/\bload\b/.test(code) && /\brun\b/.test(code))) errors.push("An 'mcu-emulator' script must define load(mcu, bytes, format) and run(mcu, cycles)");
    return { ok: errors.length === 0, errors, warnings };
  }
  let inst: ScriptInstance | undefined;
  try {
    const compiled = sandbox.compile(code, 'validate');
    inst = compiled.instantiate({
      host: {
        call: (op) => {
          switch (op) {
            case 'read':
              return 0;
            case 'voltage':
              return 0;
            case 'supply':
              return 3.3;
            case 'hasPin':
              return true;
            default:
              return undefined;
          }
        },
      },
      params: { temperatureC: 25, pressurePa: 101325, humidityPct: 50 },
      meta: { ref: 'U?', id: 'validate', kind, clockHz: 16e6, pins: [], seed: 1 },
    });
    const s = inst.shape;
    const has = (h: string) => s.hooks.includes(h);
    if (kind === 'mcu-emulator') {
      if (!has('load')) errors.push("Missing load(mcu, bytes, format) — an 'mcu-emulator' script must define it");
      if (!has('run')) errors.push("Missing run(mcu, cycles) — an 'mcu-emulator' script must define it");
    } else {
      const any = s.hooks.length > 0;
      if (!any) errors.push('The definition object has no hooks (setup/step/onInput/i2c/spi/uart)');
      if (s.i2c) {
        if (s.i2c.address === undefined && !s.i2c.dynamicAddress) errors.push('i2c.address must be a 7-bit number or a function (chip) => number');
        if (s.i2c.address !== undefined && (s.i2c.address < 0x03 || s.i2c.address > 0x77)) warnings.push(`i2c.address 0x${s.i2c.address.toString(16)} is outside the usual 7-bit range 0x03..0x77`);
        if (!has('i2c.write')) errors.push('i2c.write(chip, byte) is required');
        if (!has('i2c.read')) errors.push('i2c.read(chip) is required');
      }
      if (s.spi && !has('spi.transfer')) errors.push('spi.transfer(chip, byteIn) is required');
      if (s.uart && !has('uart.receive')) warnings.push('uart.receive(chip, byte) is not defined; received bytes are dropped');
      if (has('onInput') && !s.inputs?.length) warnings.push('onInput is defined but `inputs` (pins to watch) is empty');
      if (has('setup')) inst.invoke('setup', 0);
    }
    return { ok: errors.length === 0, errors, warnings, shape: s };
  } catch (e) {
    errors.push((e as Error).message);
    return { ok: false, errors, warnings };
  } finally {
    try {
      inst?.dispose();
    } catch {
      /* ignore */
    }
  }
}
