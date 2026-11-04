import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpStdioClient } from '../agents/mcp-client';
import { coerce, validate, S } from '../design/registry';

const proxy = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'mcp', 'pcbcad-mcp.mjs');

describe('pcbcad-mcp stdio proxy', () => {
  let server: http.Server;
  let url = '';
  const calls: { token: string; body: any }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const token = String(req.headers['x-pcbcad-token'] ?? '');
      if (token !== 'tok') {
        res.writeHead(401).end('{"error":"bad token"}');
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/mcp/info') res.end(JSON.stringify({ version: '9.9.9', instructions: 'hello' }));
        else if (req.url === '/api/mcp/tools') res.end(JSON.stringify({ tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] }));
        else if (req.url === '/api/mcp/call') {
          const b = JSON.parse(body);
          calls.push({ token, body: b });
          res.end(JSON.stringify({ text: `echo:${JSON.stringify(b.arguments)}`, isError: b.name !== 'echo' }));
        } else res.writeHead(404).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    url = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('initialises, lists tools and forwards calls', async () => {
    const c = new McpStdioClient(process.execPath, [proxy, '--url', url, '--token', 'tok'], {});
    const init = await c.initialize();
    expect(init.serverInfo.name).toBe('pcbcad');
    expect(init.serverInfo.version).toBe('9.9.9');
    expect(init.protocolVersion).toBe('2025-06-18');
    expect(init.capabilities.tools).toBeTruthy();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    const r = await c.call('echo', { a: 1 });
    expect(r).toEqual({ text: 'echo:{"a":1}', isError: false });
    const bad = await c.call('nope', {});
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(2);
    await expect(c.request('does/not/exist')).rejects.toThrow(/Method not found/);
    c.close();
  });

  it('reports bridge auth failures as tool errors', async () => {
    const c = new McpStdioClient(process.execPath, [proxy, '--url', url, '--token', 'wrong'], {});
    await c.initialize();
    const r = await c.call('echo', {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/401/);
    c.close();
  });
});

describe('tool argument validation', () => {
  const schema = S.obj({ boardId: S.str(), width: S.num(), pins: S.arr(S.str()), side: S.enum(['top', 'bottom']) }, ['boardId']);
  it('coerces LLM-style strings', () => {
    const v = coerce(schema, { boardId: 'b', width: '12.5', pins: '["U1.1"]' }) as any;
    expect(v.width).toBe(12.5);
    expect(v.pins).toEqual(['U1.1']);
    expect(validate(schema, v)).toEqual([]);
  });
  it('reports missing and wrong fields', () => {
    expect(validate(schema, { width: 'x' })).toEqual(expect.arrayContaining(['args.boardId: required', 'args.width: expected number, got string']));
    expect(validate(schema, { boardId: 'b', side: 'left' })[0]).toMatch(/must be one of/);
  });
});
