import { randomUUID } from 'node:crypto';
import type { ProviderStatus } from '@pcbcad/core';
import { capture, findExecutable, runJsonLines } from './proc';
import type { AgentEvent, ProviderAdapter, TurnOutcome, TurnRequest } from './types';

const MODELS = [
  { id: 'default', label: 'Default', description: 'Your Codex configuration' },
  { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { id: 'gpt-5', label: 'GPT-5' },
  { id: 'o4-mini', label: 'o4-mini' },
];

function tomlString(s: string) {
  return JSON.stringify(s);
}

/**
 * OpenAI Codex CLI adapter: `codex exec --json` per turn (resumed via `exec resume <thread>`),
 * with the PCBCAD MCP server injected through -c config overrides. Instructions are provided
 * through AGENTS.md in the workspace (written by the runner).
 */
export class CodexAdapter implements ProviderAdapter {
  id = 'codex' as const;
  name = 'Codex';
  reportsToolCalls = true;

  async detect(executable?: string): Promise<ProviderStatus> {
    const exe = findExecutable('codex', executable);
    if (!exe) return { id: this.id, name: this.name, available: false, models: MODELS, hint: 'Install Codex CLI: npm i -g @openai/codex, then `codex login`.' };
    const v = await capture(exe, ['--version']);
    if (v.code !== 0) return { id: this.id, name: this.name, available: false, path: exe, models: MODELS, hint: v.stderr.slice(0, 200) };
    return { id: this.id, name: this.name, available: true, path: exe, version: v.stdout.trim().replace(/^codex-cli\s*/, ''), models: MODELS, defaultModel: 'default' };
  }

  async runTurn(req: TurnRequest, emit: (e: AgentEvent) => void): Promise<TurnOutcome> {
    const exe = findExecutable('codex', req.executable);
    if (!exe) return { status: 'failed', error: 'Codex CLI (codex) not found on PATH' };
    const cfg = [
      `mcp_servers.pcbcad.command=${tomlString(req.mcp.command)}`,
      `mcp_servers.pcbcad.args=[${req.mcp.args.map(tomlString).join(',')}]`,
      `mcp_servers.pcbcad.env={${Object.entries(req.mcp.env)
        .map(([k, v]) => `${k}=${tomlString(v)}`)
        .join(',')}}`,
      'mcp_servers.pcbcad.startup_timeout_sec=30',
      'mcp_servers.pcbcad.tool_timeout_sec=900',
    ];
    const common = ['--json', '--skip-git-repo-check', '--sandbox', 'read-only', ...cfg.flatMap((c) => ['-c', c])];
    if (req.model && req.model !== 'default') common.push('-m', req.model);
    const args = req.resumeSessionId ? ['exec', ...common, 'resume', req.resumeSessionId, '-'] : ['exec', ...common, '-'];

    let error: string | undefined;
    const started = new Set<string>();
    const textIds = new Map<string, string>();

    const toolStart = (id: string, name: string, input: unknown) => {
      if (started.has(id)) return;
      started.add(id);
      emit({ type: 'tool.start', callId: id, name, input });
    };

    const onJson = (o: any) => {
      // ---- current format (thread/turn/item events) ----
      switch (o?.type) {
        case 'thread.started':
          if (o.thread_id) emit({ type: 'session', sessionId: o.thread_id });
          return;
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const it = o.item ?? {};
          const done = o.type === 'item.completed';
          if (it.type === 'agent_message' && done && it.text) emit({ type: 'text.done', id: it.id ?? randomUUID(), text: it.text });
          else if (it.type === 'reasoning' && it.text) emit({ type: 'reasoning', id: it.id ?? 'r', text: it.text, done });
          else if (it.type === 'mcp_tool_call') {
            const name = it.server === 'pcbcad' ? `mcp__pcbcad__${it.tool}` : `${it.server}:${it.tool}`;
            toolStart(it.id, name, it.arguments ?? {});
            if (done) {
              const out = it.result?.content ? it.result.content.map((c: any) => c.text ?? '').join('\n') : (it.error?.message ?? JSON.stringify(it.result ?? ''));
              emit({ type: 'tool.done', callId: it.id, output: out, isError: !!it.error || it.status === 'failed' });
            }
          } else if (it.type === 'command_execution') {
            toolStart(it.id, 'shell', { command: it.command });
            if (done) emit({ type: 'tool.done', callId: it.id, output: String(it.aggregated_output ?? '').slice(-4000), isError: it.exit_code !== 0 });
          } else if (it.type === 'web_search') {
            toolStart(it.id, 'web_search', { query: it.query });
            if (done) emit({ type: 'tool.done', callId: it.id, output: '', isError: false });
          } else if (it.type === 'error' && it.message) emit({ type: 'notice', level: 'warn', text: it.message });
          return;
        }
        case 'turn.completed': {
          const u = o.usage ?? {};
          emit({ type: 'usage', inputTokens: (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0), outputTokens: u.output_tokens });
          return;
        }
        case 'turn.failed':
          error = o.error?.message ?? 'Codex turn failed';
          return;
        case 'error':
          error = o.message ?? 'Codex error';
          return;
      }
      // ---- legacy format ({id, msg:{type,...}}) ----
      const m = o?.msg;
      if (!m) return;
      switch (m.type) {
        case 'session_configured':
          if (m.session_id) emit({ type: 'session', sessionId: m.session_id });
          break;
        case 'agent_message': {
          const id = textIds.get(o.id) ?? randomUUID();
          textIds.set(o.id, id);
          emit({ type: 'text.done', id, text: m.message });
          break;
        }
        case 'agent_reasoning':
          emit({ type: 'reasoning', id: `r${o.id}`, text: m.text ?? '', done: true });
          break;
        case 'mcp_tool_call_begin':
          toolStart(m.call_id, `mcp__${m.invocation?.server}__${m.invocation?.tool}`, m.invocation?.arguments ?? {});
          break;
        case 'mcp_tool_call_end': {
          const r = m.result?.Ok ?? m.result;
          const out = r?.content ? r.content.map((c: any) => c.text ?? '').join('\n') : JSON.stringify(m.result ?? '');
          emit({ type: 'tool.done', callId: m.call_id, output: out, isError: !!m.result?.Err || !!r?.isError });
          break;
        }
        case 'token_count':
          if (m.info?.total_token_usage) emit({ type: 'usage', inputTokens: m.info.total_token_usage.input_tokens, outputTokens: m.info.total_token_usage.output_tokens });
          break;
        case 'error':
          error = m.message;
          break;
      }
    };

    const r = await runJsonLines(exe, args, { cwd: req.cwd, env: req.mcp.env, stdin: req.prompt, signal: req.signal, onJson });
    if (r.aborted) return { status: 'interrupted' };
    if (error) return { status: 'failed', error };
    if (r.code !== 0) return { status: 'failed', error: `codex exited with code ${r.code}: ${r.stderr.trim().slice(-1500)}` };
    return { status: 'completed' };
  }
}
