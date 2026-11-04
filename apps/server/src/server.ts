import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientRequest, FastenerSpec, MechPart, Project, ProviderId } from '@pcbcad/core';
import { AgentManager, info } from './agents/manager';
import { MCP_INSTRUCTIONS } from './agents/prompt';
import { VERSION, type ServerConfig, type Settings } from './config';
import { PartsService } from './design/parts-service';
import type { Services, ToolContext } from './design/registry';
import { SessionManager } from './design/session';
import { createRegistry } from './design/tools';
import { addFirmware } from './design/tools/firmware';
import { Hub, type ClientConn } from './hub';
import { TaskRunner } from './sim/tasks';
import { Store, summarize } from './store/store';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
  '.dxf': 'application/dxf',
  '.stl': 'model/stl',
  '.hex': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function isLocalOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const h = (host ?? '').split(':')[0];
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(o.hostname) || o.hostname === h;
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage, limit = 32 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

export interface RunningServer {
  url: string;
  port: number;
  services: Services;
  agents: AgentManager;
  close(): Promise<void>;
}

export async function startServer(cfg: ServerConfig): Promise<RunningServer> {
  const store = new Store(cfg.dataDir);
  const hub = new Hub();
  const sessions = new SessionManager(store, hub);
  const tasks = new TaskRunner();
  let settings: Settings = store.loadSettings();
  let port = cfg.port;
  const urlHost = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
  const services: Services = {
    store,
    sessions,
    hub,
    tasks,
    parts: new PartsService(store, () => settings),
    settings: () => settings,
    baseUrl: () => `http://${urlHost}:${port}`,
  };
  const registry = createRegistry();
  const agents = new AgentManager(services);
  const meshCache = new Map<string, Promise<unknown>>();

  const toolCtx = (projectId: string, actor: 'user' | 'agent', threadId?: string, signal?: AbortSignal): ToolContext => ({
    session: sessions.get(projectId),
    actor,
    threadId,
    services,
    signal,
  });

  /* ------------------------------------------- HTTP ----------------------------------------------- */

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (p === '/api/health') return sendJson(res, 200, { ok: true, version: VERSION }), true;

    // ---- MCP bridge (token-authenticated; used by agent CLIs through pcbcad-mcp.mjs) ----
    if (p.startsWith('/api/mcp/')) {
      const token = String(req.headers['x-pcbcad-token'] ?? '');
      const sess = agents.session(token);
      if (!sess) return sendJson(res, 401, { error: 'invalid or expired PCBCAD token' }), true;
      if (p === '/api/mcp/info') return sendJson(res, 200, { version: VERSION, instructions: MCP_INSTRUCTIONS }), true;
      if (p === '/api/mcp/tools') {
        return sendJson(res, 200, { tools: registry.list().map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })) }), true;
      }
      if (p === '/api/mcp/call' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const callId = sess.onCall?.(body.name, body.arguments);
        const r = await registry.call(body.name, toolCtx(sess.projectId, 'agent', sess.threadId || undefined, sess.controller.signal), body.arguments);
        if (callId) sess.onResult?.(callId, r.text, !!r.isError);
        return sendJson(res, 200, { text: r.text, isError: !!r.isError }), true;
      }
      return sendJson(res, 404, { error: 'unknown MCP endpoint' }), true;
    }

    // ---- browser API ----
    if (!isLocalOrigin(req.headers.origin, req.headers.host)) return sendJson(res, 403, { error: 'origin not allowed' }), true;
    const m = /^\/api\/projects\/([^/]+)\/(.+)$/.exec(p);
    if (!m) return false;
    const pid = decodeURIComponent(m[1]);
    const rest = m[2];
    if (!store.hasProject(pid)) return sendJson(res, 404, { error: 'project not found' }), true;

    let mm: RegExpExecArray | null;
    if ((mm = /^assets\/([^/]+)$/.exec(rest)) && req.method === 'GET') {
      const aid = decodeURIComponent(mm[1]);
      const data = store.getAsset(pid, aid);
      if (!data) return sendJson(res, 404, { error: 'asset not found' }), true;
      const ext = path.extname(aid).toLowerCase();
      const headers: Record<string, string> = { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'private, max-age=3600' };
      const dl = url.searchParams.get('download');
      if (dl) headers['content-disposition'] = `attachment; filename="${dl.replace(/[^A-Za-z0-9._-]/g, '_')}"`;
      res.writeHead(200, headers);
      res.end(data);
      return true;
    }
    if ((mm = /^mech\/([^/]+)\/mesh$/.exec(rest)) && req.method === 'GET') {
      const session = sessions.get(pid);
      const part = session.project.mechanical.find((x) => x.id === decodeURIComponent(mm![1]));
      if (!part) return sendJson(res, 404, { error: 'mechanical part not found' }), true;
      const key = createHash('sha1').update(JSON.stringify(part)).digest('hex');
      let pr = meshCache.get(key);
      if (!pr) {
        pr = tasks.run('mech.mesh', { part: part as MechPart, project: slimProject(session.project) });
        meshCache.set(key, pr);
        pr.catch(() => meshCache.delete(key));
        if (meshCache.size > 300) meshCache.delete(meshCache.keys().next().value!);
      }
      try {
        const mesh = await pr;
        res.writeHead(200, { 'content-type': 'application/json', etag: key, 'cache-control': 'private, max-age=86400' });
        res.end(JSON.stringify(mesh));
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if ((mm = /^fastener\/([^/]+)\/mesh$/.exec(rest)) && req.method === 'GET') {
      const session = sessions.get(pid);
      const part = session.project.parts[decodeURIComponent(mm[1])];
      if (!part?.fastener) return sendJson(res, 404, { error: 'fastener part not found' }), true;
      const key = `f:${createHash('sha1').update(JSON.stringify(part.fastener)).digest('hex')}`;
      let pr = meshCache.get(key);
      if (!pr) {
        pr = tasks.run('mech.fastenerMesh', { spec: part.fastener as FastenerSpec });
        meshCache.set(key, pr);
        pr.catch(() => meshCache.delete(key));
      }
      try {
        sendJson(res, 200, await pr);
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if (req.method === 'POST' && req.headers['x-pcbcad-client'] !== 'web') return sendJson(res, 403, { error: 'missing client header' }), true;
    if (rest === 'firmware' && req.method === 'POST') {
      const name = url.searchParams.get('name') ?? 'firmware.bin';
      const body = await readBody(req, 16 * 1024 * 1024);
      if (!body.length) return sendJson(res, 400, { error: 'empty file' }), true;
      const fw = addFirmware(toolCtx(pid, 'user'), name, body, url.searchParams.get('target') ?? undefined);
      return sendJson(res, 200, fw), true;
    }
    if (rest === 'upload' && req.method === 'POST') {
      const name = path.basename(url.searchParams.get('name') ?? 'upload.bin').replace(/[^A-Za-z0-9._ -]/g, '_');
      const body = await readBody(req);
      const dir = path.join(store.workspaceDir(pid), 'attachments');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), body);
      return sendJson(res, 200, { name, path: `attachments/${name}`, size: body.length }), true;
    }
    if (rest === 'project.json' && req.method === 'GET') {
      const prj = sessions.get(pid).project;
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${prj.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.pcbcad.json"` });
      res.end(JSON.stringify(prj, null, 2));
      return true;
    }
    return false;
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    if (!cfg.webDist) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>PCBCAD</title><body style="font-family:system-ui;padding:2rem;background:#0b0d10;color:#e6e9ef"><h1>PCBCAD bridge is running</h1><p>The web app is not built. Run <code>npm run build</code>, or in development open the Vite dev server (<code>npm run dev</code> → http://127.0.0.1:5173).</p>`);
      return;
    }
    let file = path.normalize(path.join(cfg.webDist, decodeURIComponent(url.pathname)));
    if (!file.startsWith(cfg.webDist)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(cfg.webDist, 'index.html');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!(await api(req, res, url))) sendJson(res, 404, { error: 'not found' });
        return;
      }
      serveStatic(req, res, url);
    } catch (e) {
      console.error('[http]', e);
      if (!res.headersSent) sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    }
  });

  /* -------------------------------------------- WebSocket ------------------------------------------ */

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || !isLocalOrigin(req.headers.origin, req.headers.host)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  async function handle(client: ClientConn, method: string, params: Record<string, any>): Promise<unknown> {
    switch (method) {
      case 'projects.list':
        return store.listProjects();
      case 'projects.create': {
        const s = sessions.create(String(params.name || 'Untitled product'), String(params.description ?? ''));
        return summarize(s.project);
      }
      case 'projects.delete':
        sessions.delete(params.projectId);
        return true;
      case 'projects.import': {
        const src = params.project as Project;
        if (!src || src.schemaVersion !== 1) throw new Error('Not a PCBCAD project file');
        const s = sessions.create(src.name, src.description);
        const id = s.project.id;
        s.project = { ...src, id, revision: 0, activity: [] };
        s.flush();
        return summarize(s.project);
      }
      case 'project.open': {
        const s = sessions.get(params.projectId);
        client.projectId = s.id;
        return { project: s.project, threads: agents.listThreads(s.id), checkpoints: store.listCheckpoints(s.id) };
      }
      case 'project.close':
        client.projectId = undefined;
        return true;
      case 'project.rename': {
        const s = sessions.get(params.projectId);
        s.mutate({ actor: 'user' }, 'rename', (p) => {
          p.name = String(params.name);
          return `Renamed project to ${p.name}`;
        });
        return true;
      }
      case 'checkpoints.list':
        return store.listCheckpoints(params.projectId);
      case 'project.restore': {
        const s = sessions.get(params.projectId);
        const snap = store.loadCheckpoint(s.id, Number(params.revision));
        s.checkpoint(`Before restoring revision ${params.revision}`);
        s.replaceProject(snap, { actor: 'user' }, `Restored checkpoint (revision ${params.revision})`);
        s.pushSnapshot();
        return { revision: s.project.revision };
      }
      case 'threads.list':
        return agents.listThreads(params.projectId);
      case 'threads.create': {
        const t = agents.createThread(params.projectId, (params.provider as ProviderId) ?? settings.defaultProvider, params.model, params.title);
        return info(t);
      }
      case 'threads.get':
        return agents.getThread(params.projectId, params.threadId);
      case 'threads.update':
        return agents.updateThread(params.projectId, params.threadId, { title: params.title, provider: params.provider, model: params.model });
      case 'threads.delete':
        agents.deleteThread(params.projectId, params.threadId);
        return true;
      case 'chat.send':
        await agents.send(params.projectId, params.threadId, String(params.text ?? ''), params.attachments);
        return true;
      case 'chat.interrupt':
        agents.interrupt(params.threadId);
        return true;
      case 'providers.list':
        return agents.providers(!!params.refresh);
      case 'settings.get':
        return { ...settings, mouserApiKey: settings.mouserApiKey ? '••••' : '' };
      case 'settings.set': {
        const patch = params.patch as Partial<Settings>;
        if (patch.mouserApiKey === '••••') delete patch.mouserApiKey;
        settings = { ...settings, ...patch };
        store.saveSettings(settings);
        return { ...settings, mouserApiKey: settings.mouserApiKey ? '••••' : '' };
      }
      case 'tools.list':
        return registry.list();
      case 'tools.call': {
        const r = await registry.call(String(params.name), toolCtx(params.projectId, 'user'), params.args ?? {});
        return r;
      }
      default:
        throw new Error(`Unknown method ${method}`);
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    const client = hub.add(ws);
    hub.send(client, { type: 'event', event: { kind: 'hello', version: VERSION, dataDir: cfg.dataDir } });
    ws.on('message', async (raw) => {
      let req: ClientRequest;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        const result = await handle(client, req.method, (req.params ?? {}) as Record<string, any>);
        hub.send(client, { type: 'response', id: req.id, ok: true, result });
      } catch (e) {
        hub.send(client, { type: 'response', id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
    ws.on('close', () => hub.remove(client));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE' && port < cfg.port + 20) {
        port += 1;
        server.listen(port, cfg.host);
      } else reject(e);
    };
    server.on('error', onError);
    server.listen(port, cfg.host, () => {
      server.off('error', onError);
      const addr = server.address();
      if (addr && typeof addr === 'object') port = addr.port;
      resolve();
    });
  });

  return {
    url: services.baseUrl(),
    port,
    services,
    agents,
    async close() {
      sessions.flushAll();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
      await tasks.close();
    },
  };
}

/** Projects sent to mesh workers only need geometry-relevant data. */
function slimProject(p: Project): Project {
  return { ...p, activity: [], simulations: [], notes: [], issues: [] };
}
