import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export interface TaskOptions {
  onProgress?: (fraction: number, message?: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface Pending {
  id: number;
  task: string;
  payload: unknown;
  opts: TaskOptions;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  busy: Pending | null;
  timer: NodeJS.Timeout | null;
}

function workerUrl(): URL {
  const ts = new URL('./worker.ts', import.meta.url);
  const js = new URL('./worker.js', import.meta.url);
  // bundled production build places worker.js next to cli.js
  const bundled = new URL('./sim-worker.js', import.meta.url);
  if (fs.existsSync(fileURLToPath(bundled))) return bundled;
  if (fs.existsSync(fileURLToPath(js))) return js;
  return ts;
}

/**
 * Pool of worker threads for CPU-heavy engine work (routing, meshing, FEA, CFD, thermal,
 * firmware emulation) so the bridge stays responsive while agents and the UI interact.
 */
export class TaskRunner {
  private slots: Slot[] = [];
  private queue: Pending[] = [];
  private nextId = 1;

  constructor(private size = Math.max(2, Math.min(4, os.cpus().length - 1))) {}

  run<T>(task: string, payload: unknown, opts: TaskOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new Error('aborted'));
      const p: Pending = { id: this.nextId++, task, payload, opts, resolve, reject };
      this.queue.push(p);
      opts.signal?.addEventListener('abort', () => this.abort(p), { once: true });
      this.pump();
    });
  }

  private spawn(): Slot {
    const worker = new Worker(workerUrl(), { stdout: false, stderr: false });
    const slot: Slot = { worker, busy: null, timer: null };
    worker.on('message', (m: { id: number; type: string; result?: unknown; error?: string; progress?: number; message?: string }) => {
      const p = slot.busy;
      if (!p || p.id !== m.id) return;
      if (m.type === 'progress') {
        p.opts.onProgress?.(m.progress ?? 0, m.message);
        return;
      }
      this.finish(slot);
      if (m.type === 'result') p.resolve(m.result);
      else p.reject(new Error(m.error ?? 'task failed'));
    });
    worker.on('error', (e) => {
      const p = slot.busy;
      this.replace(slot);
      p?.reject(e instanceof Error ? e : new Error(String(e)));
    });
    worker.on('exit', (code) => {
      if (slot.busy) {
        const p = slot.busy;
        this.replace(slot);
        p.reject(new Error(`worker exited (${code})`));
      }
    });
    this.slots.push(slot);
    return slot;
  }

  private finish(slot: Slot) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.busy = null;
    setImmediate(() => this.pump());
  }

  private replace(slot: Slot) {
    if (slot.timer) clearTimeout(slot.timer);
    this.slots = this.slots.filter((s) => s !== slot);
    slot.busy = null;
    slot.worker.removeAllListeners();
    void slot.worker.terminate().catch(() => {});
    setImmediate(() => this.pump());
  }

  private abort(p: Pending) {
    const qi = this.queue.indexOf(p);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      p.reject(new Error('aborted'));
      return;
    }
    const slot = this.slots.find((s) => s.busy === p);
    if (slot) {
      this.replace(slot);
      p.reject(new Error('aborted'));
    }
  }

  private pump() {
    while (this.queue.length) {
      let slot = this.slots.find((s) => !s.busy);
      if (!slot) {
        if (this.slots.length >= this.size) return;
        slot = this.spawn();
      }
      const p = this.queue.shift()!;
      slot.busy = p;
      const timeout = p.opts.timeoutMs ?? 15 * 60_000;
      const s = slot;
      slot.timer = setTimeout(() => {
        if (s.busy === p) {
          this.replace(s);
          p.reject(new Error(`task ${p.task} timed out after ${Math.round(timeout / 1000)} s`));
        }
      }, timeout);
      slot.worker.postMessage({ id: p.id, task: p.task, payload: p.payload });
    }
  }

  async close() {
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
    this.slots = [];
  }
}
