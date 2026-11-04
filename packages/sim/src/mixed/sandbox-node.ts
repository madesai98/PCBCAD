/**
 * Node.js script sandbox for agent-authored behaviour scripts.
 *
 *  - Each script instance runs in its own `node:vm` context (null-prototype global, string code
 *    generation and WebAssembly disabled), inside a dedicated worker thread (separate V8 isolate
 *    with heap limits).
 *  - Only primitives cross the boundary: the chip API object is built inside the context by the
 *    shared prelude; host values are JSON-encoded through a SharedArrayBuffer. No host object or
 *    function ever enters the context (no require / process / host globalThis).
 *  - Calls are synchronous (Atomics spin-then-wait RPC, ~5 µs per call). Each hook call has a
 *    wall-clock budget (default 50 ms, host callback time excluded); on overrun the script's worker
 *    is terminated and its instances fail with a timeout ScriptError.
 *  - One worker per compiled script, started on demand and stopped when idle (no thread leaks
 *    even if the caller never calls dispose()).
 *
 * Node-only module: never import it from browser code. Import path:
 *   import { createNodeSandbox } from '@pcbcad/sim/mixed/sandbox-node';
 *
 * Note: node:vm is not a hardened security boundary on its own; the worker isolate, the
 * primitive-only bridge and disabled code generation are defence in depth. Run fully hostile code
 * under OS-level isolation as well.
 */
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { PRELUDE_SRC, cleanStack, sourceName } from './script-api';
import { ScriptError, type CompiledScript, type ScriptHost, type ScriptInstance, type ScriptSandbox, type ScriptShape, type ScriptValue } from './types';

export interface NodeSandboxOptions {
  /** Wall-clock budget per hook call (ms, default 50). */
  timeoutMs?: number;
  /** Budget for compiling + instantiating a script (ms, default 3000). */
  setupTimeoutMs?: number;
  /** Worker heap limit (MB, default 128). */
  maxHeapMb?: number;
  /** Message buffer size per worker in UTF-16 code units (default 2M ≈ 4 MB). */
  bufferChars?: number;
  /** Stop a script's worker this long after its last instance is disposed (ms, default 1000). */
  idleShutdownMs?: number;
}

const SPIN = 20000;

const WORKER_SRC = String.raw`
'use strict';
const { workerData } = require('node:worker_threads');
const vm = require('node:vm');
const ctl = new Int32Array(workerData.sab, 0, 16);
const data = new Uint16Array(workerData.sab, 64);
const CAP = data.length;
const SPIN = ${SPIN};
const prelude = new vm.Script(workerData.prelude, { filename: 'pcbcad:prelude' });
const scripts = new Map();
const insts = new Map();

function readMsg() {
  const n = ctl[2];
  let s = '';
  for (let i = 0; i < n; i += 8192) s += String.fromCharCode.apply(null, data.subarray(i, Math.min(n, i + 8192)));
  return s;
}
function writeMsg(s) {
  if (s.length > CAP) s = JSON.stringify(['err', 'message too large for the sandbox buffer']);
  for (let i = 0; i < s.length; i++) data[i] = s.charCodeAt(i);
  ctl[2] = s.length;
}
function waitNonZero(idx) {
  for (let i = 0; i < SPIN; i++) if (Atomics.load(ctl, idx) !== 0) return;
  while (Atomics.load(ctl, idx) === 0) Atomics.wait(ctl, idx, 0);
}
function send(msg, state) {
  writeMsg(JSON.stringify(msg));
  Atomics.store(ctl, 1, state);
  Atomics.notify(ctl, 1);
}
function prim(v) {
  const t = typeof v;
  if (v === null || t === 'number' || t === 'string' || t === 'boolean') return v;
  return undefined;
}
function hostCall(iid, op, a, b) {
  send(['cb', iid, String(op), prim(a), prim(b)], 2);
  waitNonZero(0);
  const m = JSON.parse(readMsg());
  Atomics.store(ctl, 0, 0);
  return m.length > 1 ? m[1] : undefined;
}
function errText(r) {
  return typeof r === 'string' ? r.slice(2) : 'script error';
}
send(['ready'], 1);
for (;;) {
  waitNonZero(0);
  let msg;
  try { msg = JSON.parse(readMsg()); } catch (e) { msg = ['bad']; }
  Atomics.store(ctl, 0, 0);
  let out;
  try {
    switch (msg[0]) {
      case 'compile': {
        const sid = msg[1], code = msg[2], name = msg[3];
        try {
          const script = new vm.Script('(function (chip, mcu) {\n' + code + '\n})', { filename: 'behavior:' + name, lineOffset: -1 });
          scripts.set(sid, { script, name });
          out = ['ok'];
        } catch (e) {
          out = ['err', 'Syntax error in ' + name + ': ' + (e && e.message)];
        }
        break;
      }
      case 'inst': {
        const sid = msg[1], iid = msg[2];
        const s = scripts.get(sid);
        if (!s) { out = ['err', 'unknown script']; break; }
        const ctx = vm.createContext(Object.create(null), { name: 'pcbcad:' + s.name, codeGeneration: { strings: false, wasm: false } });
        const install = prelude.runInContext(ctx);
        const factory = s.script.runInContext(ctx);
        const res = install(function (op, a, b) { return hostCall(iid, op, a, b); }, String(msg[3]), String(msg[4]), factory, true);
        if (typeof res === 'string') { out = ['err', errText(res)]; break; }
        const dispatch = res[0];
        const shape = res[1];
        if (typeof dispatch !== 'function' || typeof shape !== 'string') { out = ['err', 'invalid script definition']; break; }
        insts.set(iid, dispatch);
        out = ['ok', shape];
        break;
      }
      case 'call': {
        const dispatch = insts.get(msg[1]);
        if (!dispatch) { out = ['err', 'unknown instance']; break; }
        const r = dispatch(String(msg[2]), msg[3], msg[4], msg[5], msg[6]);
        const p = prim(r);
        if (typeof p === 'string' && p.length > 1 && p.charCodeAt(0) === 0 && p[1] === 'E') out = ['err', p.slice(2)];
        else out = p === undefined ? ['ok'] : ['ok', p];
        break;
      }
      case 'dispose':
        insts.delete(msg[1]);
        out = ['ok'];
        break;
      default:
        out = ['err', 'bad request'];
    }
  } catch (e) {
    let m; try { m = e && e.stack ? String(e.stack) : String(e); } catch (x) { m = 'script error'; }
    out = ['err', m];
  }
  send(out, 1);
}
`;

/** One worker thread + shared-memory RPC channel (hosts every instance of one compiled script). */
class WorkerChannel {
  private readonly worker: Worker;
  private readonly ctl: Int32Array;
  private readonly data: Uint16Array;
  dead: string | null = null;
  nextId = 1;
  live = 0;
  readonly hosts = new Map<number, ScriptHost>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: Required<Pick<NodeSandboxOptions, 'maxHeapMb' | 'bufferChars'>>) {
    const sab = new SharedArrayBuffer(64 + opts.bufferChars * 2);
    this.ctl = new Int32Array(sab, 0, 16);
    this.data = new Uint16Array(sab, 64);
    const heap = opts.maxHeapMb;
    this.worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { sab, prelude: PRELUDE_SRC },
      resourceLimits: { maxOldGenerationSizeMb: heap, maxYoungGenerationSizeMb: Math.max(8, Math.round(heap / 4)) },
      env: {},
      argv: [],
      execArgv: [],
    });
    this.worker.unref();
    this.worker.on('error', (e) => {
      if (!this.dead) this.dead = `sandbox worker crashed: ${e.message}`;
    });
    this.worker.on('exit', () => {
      if (!this.dead) this.dead = 'sandbox worker exited';
    });
    const deadline = Date.now() + 15000;
    while (Atomics.load(this.ctl, 1) === 0) {
      const left = deadline - Date.now();
      if (left <= 0) {
        this.kill('sandbox worker did not start');
        throw new ScriptError('sandbox', 'Script sandbox worker did not start');
      }
      Atomics.wait(this.ctl, 1, 0, Math.min(left, 100));
      if (this.dead) throw new ScriptError('sandbox', `Script sandbox worker failed to start (${this.dead})`);
    }
    Atomics.store(this.ctl, 1, 0);
  }

  private write(s: string): void {
    if (s.length > this.data.length) throw new ScriptError('sandbox', 'message too large for the sandbox buffer (raise bufferChars)');
    const d = this.data;
    for (let i = 0; i < s.length; i++) d[i] = s.charCodeAt(i);
    this.ctl[2] = s.length;
  }

  private read(): string {
    const n = this.ctl[2];
    let s = '';
    for (let i = 0; i < n; i += 8192) s += String.fromCharCode.apply(null, Array.from(this.data.subarray(i, Math.min(n, i + 8192))));
    return s;
  }

  kill(reason: string): void {
    if (!this.dead) this.dead = reason;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    void this.worker.terminate();
  }

  /** Stop the worker shortly after its last instance was disposed (it restarts on demand). */
  scheduleIdleShutdown(ms: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.live === 0) this.kill('idle');
    }, ms);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  cancelIdleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Block until ctl[1] != 0 or the deadline passes. */
  private waitHost(deadline: number): boolean {
    const ctl = this.ctl;
    for (let i = 0; i < SPIN; i++) if (Atomics.load(ctl, 1) !== 0) return true;
    while (Atomics.load(ctl, 1) === 0) {
      const left = deadline - performance.now();
      if (left <= 0) return Atomics.load(ctl, 1) !== 0;
      Atomics.wait(ctl, 1, 0, Math.max(1, Math.min(left, 50)));
      if (this.dead && Atomics.load(ctl, 1) === 0) return false;
    }
    return true;
  }

  request(script: string, msg: unknown[], budgetMs: number): unknown {
    if (this.dead) throw new ScriptError(script, `Script sandbox unavailable (${this.dead})`, /timed out/.test(this.dead));
    const ctl = this.ctl;
    this.write(JSON.stringify(msg));
    Atomics.store(ctl, 1, 0);
    Atomics.store(ctl, 0, 1);
    Atomics.notify(ctl, 0);
    let deadline = performance.now() + budgetMs;
    const hardDeadline = performance.now() + Math.max(budgetMs * 40, 2000);
    let callbacks = 0;
    for (;;) {
      if (!this.waitHost(Math.min(deadline, hardDeadline))) {
        const why = this.dead && !/timed out|idle/.test(this.dead) ? this.dead : `timed out after ${budgetMs} ms`;
        this.kill(`script '${script}' ${why}`);
        throw new ScriptError(script, `Script '${script}' ${why} (sandbox terminated)`, true);
      }
      const state = Atomics.load(ctl, 1);
      const m = JSON.parse(this.read()) as unknown[];
      Atomics.store(ctl, 1, 0);
      if (state === 1) {
        if (m[0] === 'err') throw new ScriptError(script, cleanStack(String(m[1])));
        return m.length > 1 ? m[1] : undefined;
      }
      // host callback from the script
      const t0 = performance.now();
      const host = this.hosts.get(m[1] as number);
      let reply: ScriptValue;
      try {
        const r = host ? host.call(String(m[2]), m[3] as ScriptValue, m[4] as ScriptValue) : undefined;
        reply = r === undefined || r === null || typeof r === 'number' || typeof r === 'boolean' || typeof r === 'string' ? r : undefined;
      } catch (e) {
        reply = `\u0000${(e as Error)?.message ?? String(e)}`;
      }
      if (++callbacks > 2_000_000) {
        this.kill(`script '${script}' made too many host calls`);
        throw new ScriptError(script, `Script '${script}' made too many host calls in one hook (sandbox terminated)`, true);
      }
      deadline += performance.now() - t0; // host time does not count against the script
      this.write(JSON.stringify(reply === undefined ? ['r'] : ['r', reply]));
      Atomics.store(ctl, 0, 2);
      Atomics.notify(ctl, 0);
    }
  }
}

class NodeSandbox implements ScriptSandbox {
  readonly isolated = true;
  private readonly timeoutMs: number;
  private readonly setupTimeoutMs: number;
  private readonly idleMs: number;
  private readonly channelOpts: Required<Pick<NodeSandboxOptions, 'maxHeapMb' | 'bufferChars'>>;
  private readonly channels = new Set<WorkerChannel>();

  constructor(opts: NodeSandboxOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 50;
    this.setupTimeoutMs = opts.setupTimeoutMs ?? 3000;
    this.idleMs = opts.idleShutdownMs ?? 1000;
    this.channelOpts = { maxHeapMb: opts.maxHeapMb ?? 128, bufferChars: opts.bufferChars ?? 2 * 1024 * 1024 };
  }

  compile(code: string, name: string): CompiledScript {
    // syntax check in the host: compiling a vm.Script does not execute anything
    try {
      new vm.Script(`(function (chip, mcu) {\n${code}\n})`, { filename: `behavior:${sourceName(name)}`, lineOffset: -1 });
    } catch (e) {
      throw new ScriptError(name, `Syntax error in ${name}: ${(e as Error).message}`);
    }
    let channel: WorkerChannel | null = null;
    const ensureChannel = (): WorkerChannel => {
      if (channel && !channel.dead) return channel;
      const ch = new WorkerChannel(this.channelOpts);
      this.channels.add(ch);
      ch.request(name, ['compile', 1, String(code), sourceName(name)], this.setupTimeoutMs);
      channel = ch;
      return ch;
    };
    return {
      name,
      instantiate: ({ host, params, meta }): ScriptInstance => {
        const ch = ensureChannel();
        ch.cancelIdleShutdown();
        const iid = ch.nextId++;
        ch.hosts.set(iid, host);
        ch.live++;
        let shapeJson: unknown;
        try {
          shapeJson = ch.request(name, ['inst', 1, iid, JSON.stringify(params ?? {}), JSON.stringify(meta ?? {})], this.setupTimeoutMs);
        } catch (e) {
          ch.hosts.delete(iid);
          ch.live--;
          if (ch.live === 0 && !ch.dead) ch.scheduleIdleShutdown(this.idleMs);
          throw e;
        }
        const shape = JSON.parse(String(shapeJson)) as ScriptShape;
        const decode = (r: unknown): unknown => {
          if (typeof r === 'string' && r.length && r.charCodeAt(0) === 0) {
            if (r[1] === 'J') return JSON.parse(r.slice(2));
            if (r[1] === 'S') return r.slice(2);
            return r.slice(1);
          }
          return r === null ? undefined : r;
        };
        let disposed = false;
        return {
          shape,
          invoke: (path: string, t: number, args: ScriptValue[] = []): unknown => {
            const msg: unknown[] = ['call', iid, path, t];
            let last = args.length;
            while (last > 0 && args[last - 1] === undefined) last--;
            for (let i = 0; i < last; i++) msg.push(args[i] === undefined ? null : args[i]);
            return decode(ch.request(name, msg, this.timeoutMs));
          },
          snapshot: (): unknown => decode(ch.request(name, ['call', iid, 'state', null], this.timeoutMs)),
          dispose: (): void => {
            if (disposed) return;
            disposed = true;
            ch.hosts.delete(iid);
            ch.live--;
            if (!ch.dead) {
              try {
                ch.request(name, ['dispose', iid], this.timeoutMs);
              } catch {
                /* ignore */
              }
              if (ch.live === 0) ch.scheduleIdleShutdown(this.idleMs);
            }
          },
        };
      },
    };
  }

  dispose(): void {
    for (const ch of this.channels) ch.kill('disposed');
    this.channels.clear();
  }
}

/**
 * Create an isolated script sandbox (node:vm contexts in worker threads, per-call timeout).
 * Each compiled script gets its own worker, started on first instantiate() and stopped
 * automatically `idleShutdownMs` after its last instance is disposed (runMixedSignal disposes its
 * instances at the end of a run), so a sandbox can be reused or simply dropped without leaking
 * threads. A timeout kills only the offending script's worker; later runs start a fresh one.
 * `dispose()` stops everything immediately.
 */
export function createNodeSandbox(opts: NodeSandboxOptions = {}): ScriptSandbox {
  return new NodeSandbox(opts);
}
