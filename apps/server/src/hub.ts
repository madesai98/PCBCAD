import type { WebSocket } from 'ws';
import type { ServerEvent, ServerMessage } from '@pcbcad/core';

export interface ClientConn {
  id: number;
  ws: WebSocket;
  /** Project the client is currently viewing (receives its snapshots/events). */
  projectId?: string;
}

/** Fan-out of server events to connected browser clients. */
export class Hub {
  private clients = new Set<ClientConn>();
  private nextId = 1;

  add(ws: WebSocket): ClientConn {
    const c: ClientConn = { id: this.nextId++, ws };
    this.clients.add(c);
    return c;
  }

  remove(c: ClientConn) {
    this.clients.delete(c);
  }

  send(c: ClientConn, msg: ServerMessage) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  broadcast(event: ServerEvent) {
    const s = JSON.stringify({ type: 'event', event } satisfies ServerMessage);
    for (const c of this.clients) if (c.ws.readyState === 1) c.ws.send(s);
  }

  /** Send to clients viewing a project. */
  toProject(projectId: string, event: ServerEvent) {
    let s: string | null = null;
    for (const c of this.clients) {
      if (c.projectId !== projectId || c.ws.readyState !== 1) continue;
      s ??= JSON.stringify({ type: 'event', event } satisfies ServerMessage);
      c.ws.send(s);
    }
  }

  hasViewers(projectId: string) {
    for (const c of this.clients) if (c.projectId === projectId) return true;
    return false;
  }
}
