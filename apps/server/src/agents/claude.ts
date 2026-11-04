import { randomUUID } from 'node:crypto';
import type { ProviderStatus } from '@pcbcad/core';
import { capture, findExecutable, runJsonLines } from './proc';
import { normaliseToolName, type AgentEvent, type ProviderAdapter, type TurnOutcome, type TurnRequest } from './types';

const MODELS = [
  { id: 'default', label: 'Default', description: 'Whatever your Claude Code is configured to use' },
  { id: 'opus', label: 'Opus', description: 'Most capable' },
  { id: 'sonnet', label: 'Sonnet', description: 'Fast and capable' },
  { id: 'haiku', label: 'Haiku', description: 'Fastest' },
  { id: 'fable', label: 'Fable' },
];

interface Caps {
  partial: boolean;
  tools: boolean;
  permissionPrompts: boolean;
}

/**
 * Claude Code CLI adapter: `claude -p --output-format stream-json` per turn, resumed with
 * --resume <session>. Design tools come from the PCBCAD MCP server (--mcp-config, strict);
 * built-in tools are restricted to research tools (web search/fetch, read attachments).
 */
export class ClaudeAdapter implements ProviderAdapter {
  id = 'claude' as const;
  name = 'Claude Code';
  reportsToolCalls = true;
  private caps: Caps | null = null;

  async detect(executable?: string): Promise<ProviderStatus> {
    const exe = findExecutable('claude', executable);
    if (!exe) return { id: this.id, name: this.name, available: false, models: MODELS, hint: 'Install Claude Code: npm i -g @anthropic-ai/claude-code, then run `claude` once to log in.' };
    const v = await capture(exe, ['--version']);
    if (v.code !== 0) return { id: this.id, name: this.name, available: false, path: exe, models: MODELS, hint: `claude --version failed: ${v.stderr.slice(0, 200)}` };
    const help = await capture(exe, ['--help']);
    this.caps = { partial: help.stdout.includes('--include-partial-messages'), tools: /--tools\b/.test(help.stdout), permissionPrompts: help.stdout.includes('--permission-prompts') };
    return { id: this.id, name: this.name, available: true, path: exe, version: v.stdout.trim().split(/\s/)[0], models: MODELS, defaultModel: 'default' };
  }

  async runTurn(req: TurnRequest, emit: (e: AgentEvent) => void): Promise<TurnOutcome> {
    const exe = findExecutable('claude', req.executable);
    if (!exe) return { status: 'failed', error: 'Claude Code CLI (claude) not found on PATH' };
    if (!this.caps) await this.detect(req.executable);
    const caps = this.caps ?? { partial: true, tools: true, permissionPrompts: false };
    const mcpConfig = JSON.stringify({ mcpServers: { pcbcad: { type: 'stdio', command: req.mcp.command, args: req.mcp.args, env: req.mcp.env } } });
    const research = req.allowWebResearch ? ['WebSearch', 'WebFetch'] : [];
    const builtins = [...research, 'Read', 'Glob', 'Grep'];
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--mcp-config', mcpConfig, '--strict-mcp-config', '--allowedTools', ['mcp__pcbcad', ...builtins].join(','), '--append-system-prompt', req.systemPrompt];
    if (caps.partial) args.push('--include-partial-messages');
    if (caps.tools) args.push('--tools', builtins.join(','));
    if (caps.permissionPrompts) args.push('--permission-prompts', 'none');
    if (req.model && req.model !== 'default') args.push('--model', req.model);
    if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
    else {
      const sid = randomUUID();
      args.push('--session-id', sid);
      emit({ type: 'session', sessionId: sid });
    }

    const streamed = new Set<string>();
    const seenTools = new Set<string>();
    let curMsg = '';
    const blocks = new Map<number, { kind: 'text' | 'thinking' | 'tool'; id: string; text: string }>();
    let resultSeen = false;
    let error: string | undefined;

    const onJson = (o: any) => {
      if (o?.parent_tool_use_id) return; // sub-agent chatter
      switch (o?.type) {
        case 'system':
          if (o.subtype === 'init') {
            if (o.session_id) emit({ type: 'session', sessionId: o.session_id });
            const s = (o.mcp_servers ?? []).find((x: any) => x.name === 'pcbcad');
            if (s && s.status !== 'connected') emit({ type: 'notice', level: 'warn', text: `PCBCAD MCP server status: ${s.status}` });
          }
          break;
        case 'stream_event': {
          const ev = o.event;
          if (ev?.type === 'message_start') {
            curMsg = ev.message?.id ?? randomUUID();
            streamed.add(curMsg);
            blocks.clear();
          } else if (ev?.type === 'content_block_start') {
            const cb = ev.content_block ?? {};
            const id = `${curMsg}:${ev.index}`;
            if (cb.type === 'text') blocks.set(ev.index, { kind: 'text', id, text: '' });
            else if (cb.type === 'thinking') blocks.set(ev.index, { kind: 'thinking', id, text: '' });
            else if (cb.type === 'tool_use') blocks.set(ev.index, { kind: 'tool', id: cb.id, text: '' });
          } else if (ev?.type === 'content_block_delta') {
            const b = blocks.get(ev.index);
            if (!b) break;
            if (ev.delta?.type === 'text_delta' && b.kind === 'text') {
              b.text += ev.delta.text;
              emit({ type: 'text.delta', id: b.id, delta: ev.delta.text });
            } else if (ev.delta?.type === 'thinking_delta' && b.kind === 'thinking') {
              b.text += ev.delta.thinking ?? '';
              emit({ type: 'reasoning', id: b.id, text: b.text, done: false });
            }
          } else if (ev?.type === 'content_block_stop') {
            const b = blocks.get(ev.index);
            if (b?.kind === 'text') emit({ type: 'text.done', id: b.id, text: b.text });
            if (b?.kind === 'thinking') emit({ type: 'reasoning', id: b.id, text: b.text, done: true });
          }
          break;
        }
        case 'assistant': {
          const msg = o.message ?? {};
          const content: any[] = Array.isArray(msg.content) ? msg.content : [];
          content.forEach((block, i) => {
            if (block.type === 'text' && !streamed.has(msg.id) && block.text) emit({ type: 'text.done', id: `${msg.id ?? randomUUID()}:f${i}`, text: block.text });
            else if (block.type === 'thinking' && !streamed.has(msg.id) && block.thinking) emit({ type: 'reasoning', id: `${msg.id}:t${i}`, text: block.thinking, done: true });
            else if (block.type === 'tool_use' && !seenTools.has(block.id)) {
              seenTools.add(block.id);
              emit({ type: 'tool.start', callId: block.id, name: block.name, input: block.input });
            }
          });
          break;
        }
        case 'user': {
          const content = o.message?.content;
          if (!Array.isArray(content)) break;
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const out =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c: any) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n')
                  : '';
            emit({ type: 'tool.done', callId: block.tool_use_id, output: out, isError: !!block.is_error });
          }
          break;
        }
        case 'result': {
          resultSeen = true;
          const u = o.usage ?? {};
          emit({ type: 'usage', costUsd: o.total_cost_usd, inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens });
          if (o.is_error || (o.subtype && o.subtype !== 'success')) error = typeof o.result === 'string' && o.result ? o.result : `Claude Code ended with ${o.subtype}`;
          if (o.permission_denials?.length) emit({ type: 'notice', level: 'warn', text: `Tools denied: ${o.permission_denials.map((d: any) => d.tool_name).join(', ')}` });
          break;
        }
      }
    };

    const r = await runJsonLines(exe, args, {
      cwd: req.cwd,
      env: { ...req.mcp.env, MCP_TOOL_TIMEOUT: '900000', MAX_MCP_OUTPUT_TOKENS: '60000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdin: req.prompt,
      signal: req.signal,
      onJson,
    });
    if (r.aborted) return { status: 'interrupted' };
    if (error) return { status: 'failed', error };
    if (!resultSeen && r.code !== 0) return { status: 'failed', error: `claude exited with code ${r.code}: ${r.stderr.trim().slice(-1500)}` };
    return { status: 'completed' };
  }
}

export { normaliseToolName };
