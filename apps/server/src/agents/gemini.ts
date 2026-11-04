import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderStatus } from '@pcbcad/core';
import { capture, findExecutable, runJsonLines } from './proc';
import type { AgentEvent, ProviderAdapter, TurnOutcome, TurnRequest } from './types';

const MODELS = [
  { id: 'default', label: 'Default' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
];

/**
 * Google Gemini CLI adapter: `gemini -p … --output-format stream-json`. The PCBCAD MCP server is
 * registered (trusted, so its tools run without confirmation) in <workspace>/.gemini/settings.json;
 * instructions come from GEMINI.md in the workspace.
 */
export class GeminiAdapter implements ProviderAdapter {
  id = 'gemini' as const;
  name = 'Gemini CLI';
  reportsToolCalls = true;
  private canResume = false;

  async detect(executable?: string): Promise<ProviderStatus> {
    const exe = findExecutable('gemini', executable);
    if (!exe) return { id: this.id, name: this.name, available: false, models: MODELS, hint: 'Install Gemini CLI: npm i -g @google/gemini-cli, then run `gemini` once to authenticate.' };
    const v = await capture(exe, ['--version']);
    if (v.code !== 0) return { id: this.id, name: this.name, available: false, path: exe, models: MODELS, hint: v.stderr.slice(0, 200) };
    const help = await capture(exe, ['--help']);
    this.canResume = /--resume\b/.test(help.stdout);
    return { id: this.id, name: this.name, available: true, path: exe, version: v.stdout.trim(), models: MODELS, defaultModel: 'default' };
  }

  async runTurn(req: TurnRequest, emit: (e: AgentEvent) => void): Promise<TurnOutcome> {
    const exe = findExecutable('gemini', req.executable);
    if (!exe) return { status: 'failed', error: 'Gemini CLI (gemini) not found on PATH' };
    const dir = path.join(req.cwd, '.gemini');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ mcpServers: { pcbcad: { command: req.mcp.command, args: req.mcp.args, env: req.mcp.env, trust: true, timeout: 900000 } } }, null, 2),
    );
    const args = ['--output-format', 'stream-json'];
    if (req.model && req.model !== 'default') args.push('-m', req.model);
    if (req.resumeSessionId && this.canResume) args.push('--resume', req.resumeSessionId);
    args.push('-p', req.prompt);

    let error: string | undefined;
    let textId = randomUUID();
    let text = '';
    const flush = () => {
      if (text) emit({ type: 'text.done', id: textId, text });
      text = '';
      textId = randomUUID();
    };
    const onJson = (o: any) => {
      switch (o?.type) {
        case 'init':
          if (o.session_id) emit({ type: 'session', sessionId: o.session_id });
          break;
        case 'message':
          if (o.role === 'assistant' && typeof o.content === 'string') {
            if (o.delta) {
              text += o.content;
              emit({ type: 'text.delta', id: textId, delta: o.content });
            } else {
              text = o.content;
              flush();
            }
          }
          break;
        case 'tool_use':
          flush();
          emit({ type: 'tool.start', callId: o.tool_id ?? randomUUID(), name: String(o.tool_name ?? 'tool').replace(/^pcbcad__/, 'mcp__pcbcad__'), input: o.parameters ?? {} });
          break;
        case 'tool_result':
          emit({ type: 'tool.done', callId: o.tool_id, output: typeof o.output === 'string' ? o.output : JSON.stringify(o.output ?? o.error ?? ''), isError: o.status === 'error' });
          break;
        case 'error':
          if (o.severity === 'error') error = o.message;
          else emit({ type: 'notice', level: 'warn', text: o.message });
          break;
        case 'result':
          flush();
          if (o.stats) emit({ type: 'usage', inputTokens: o.stats.input_tokens, outputTokens: o.stats.output_tokens });
          if (o.status === 'error') error = o.error?.message ?? 'Gemini turn failed';
          break;
      }
    };
    const r = await runJsonLines(exe, args, { cwd: req.cwd, env: req.mcp.env, signal: req.signal, onJson, onText: (l) => (text ? null : emit({ type: 'notice', level: 'info', text: l.slice(0, 300) })) });
    flush();
    if (r.aborted) return { status: 'interrupted' };
    if (error) return { status: 'failed', error };
    if (r.code !== 0) return { status: 'failed', error: `gemini exited with code ${r.code}: ${r.stderr.trim().slice(-1500)}` };
    return { status: 'completed' };
  }
}
