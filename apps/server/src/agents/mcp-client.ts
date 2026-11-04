import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

/**
 * Minimal MCP client over stdio (used by the demo agent and tests to drive the exact same
 * pcbcad-mcp proxy that real agent CLIs spawn).
 */
export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(command: string, args: string[], env: Record<string, string>) {
    this.child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    this.child.stderr.on('data', () => {});
    this.child.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('MCP server exited'));
      this.pending.clear();
    });
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('MCP server closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pcbcad-demo-agent', version: '0.1.0' } });
    this.notify('notifications/initialized');
    return r;
  }

  async listTools(): Promise<{ name: string; description: string; inputSchema: unknown }[]> {
    return (await this.request('tools/list', {})).tools;
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const r = await this.request('tools/call', { name, arguments: args });
    return { text: (r.content ?? []).map((c: any) => c.text ?? '').join('\n'), isError: !!r.isError };
  }

  close() {
    if (!this.closed) this.child.stdin.end();
    setTimeout(() => this.child.kill(), 500).unref();
  }
}
