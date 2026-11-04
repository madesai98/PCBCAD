#!/usr/bin/env node
/**
 * PCBCAD MCP server (stdio transport).
 *
 * Agent CLIs (Claude Code, Codex, Gemini CLI, …) spawn this tiny, dependency-free process as an
 * MCP server. It exposes the PCBCAD design tools and forwards every call to the local PCBCAD
 * bridge over HTTP, authenticated with a per-session token. The design itself lives in the
 * bridge, so the browser UI updates live as the agent works.
 *
 * Usage: node pcbcad-mcp.mjs --url http://127.0.0.1:4321 --token <token>
 *        (or env PCBCAD_URL / PCBCAD_TOKEN)
 */
import process from 'node:process';
import readline from 'node:readline';

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const BASE = (arg('url') ?? process.env.PCBCAD_URL ?? 'http://127.0.0.1:4321').replace(/\/$/, '');
const TOKEN = arg('token') ?? process.env.PCBCAD_TOKEN ?? '';
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function log(...a) {
  process.stderr.write(`[pcbcad-mcp] ${a.join(' ')}\n`);
}

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-pcbcad-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PCBCAD bridge ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

let toolsCache = null;

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const info = await api('/api/mcp/info').catch(() => ({ instructions: '' }));
        return isRequest &&
          send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[1],
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'pcbcad', title: 'PCBCAD design tools', version: info.version ?? '0.1.0' },
              instructions: info.instructions ?? '',
            },
          });
      }
      case 'ping':
        return isRequest && send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list': {
        toolsCache ??= (await api('/api/mcp/tools')).tools;
        return send({ jsonrpc: '2.0', id, result: { tools: toolsCache } });
      }
      case 'tools/call': {
        const r = await api('/api/mcp/call', { name: params?.name, arguments: params?.arguments ?? {} });
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text ?? '' }], isError: !!r.isError } });
      }
      case 'resources/list':
        return send({ jsonrpc: '2.0', id, result: { resources: [] } });
      case 'prompts/list':
        return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      default:
        if (!isRequest) return; // notifications (initialized, cancelled, …)
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    log('error', method, e?.message ?? e);
    if (!isRequest) return;
    if (method === 'tools/call') return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `PCBCAD bridge error: ${e?.message ?? e}` }], isError: true } });
    return send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (Array.isArray(msg)) for (const m of msg) void handle(m);
  else void handle(msg);
});
rl.on('close', () => process.exit(0));
