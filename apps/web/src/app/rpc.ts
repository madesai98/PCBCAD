import type { ClientRequest, ServerEvent, ServerMessage } from '@pcbcad/core';

type Listener = (e: ServerEvent) => void;

/** WebSocket RPC client with automatic reconnect. */
export class Rpc {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: 'connecting' | 'open' | 'closed') => void>();
  private queue: string[] = [];
  private retry = 0;
  status: 'connecting' | 'open' | 'closed' = 'connecting';

  constructor(private url: string) {
    this.connect();
  }

  private setStatus(s: 'connecting' | 'open' | 'closed') {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private connect() {
    this.setStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
      for (const m of this.queue) ws.send(m);
      this.queue = [];
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (msg.type === 'response') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
      } else for (const l of this.listeners) l(msg.event);
    };
    ws.onclose = () => {
      this.setStatus('closed');
      for (const p of this.pending.values()) p.reject(new Error('connection lost'));
      this.pending.clear();
      const delay = Math.min(8000, 400 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const msg: ClientRequest = { id, method, params };
    const s = JSON.stringify(msg);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
      else this.queue.push(s);
    });
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onStatus(l: (s: 'connecting' | 'open' | 'closed') => void) {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }
}

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
export const rpc = new Rpc(`${proto}://${location.host}/ws`);
