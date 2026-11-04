import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newId, nowIso, type ChatItem, type ProviderId, type ProviderStatus, type Thread, type ThreadInfo } from '@pcbcad/core';
import { mcpProxyPath } from '../config';
import type { Services } from '../design/registry';
import { ClaudeAdapter } from './claude';
import { CodexAdapter } from './codex';
import { DemoAdapter } from './demo';
import { GeminiAdapter } from './gemini';
import { designAgentInstructions } from './prompt';
import { normaliseToolName, type AgentEvent, type ProviderAdapter } from './types';

export interface McpSession {
  token: string;
  projectId: string;
  threadId: string;
  controller: AbortController;
  /** When the adapter does not report tool calls itself, the bridge emits them. */
  reportCalls: boolean;
  onCall?: (name: string, args: unknown) => string;
  onResult?: (callId: string, text: string, isError: boolean) => void;
}

interface Running {
  controller: AbortController;
  thread: Thread;
  saveTimer: NodeJS.Timeout | null;
}

const MAX_TOOL_OUTPUT = 6000;

export class AgentManager {
  readonly adapters: Record<ProviderId, ProviderAdapter>;
  private statusCache: { at: number; list: ProviderStatus[] } | null = null;
  private running = new Map<string, Running>();
  private tokens = new Map<string, McpSession>();

  constructor(private services: Services) {
    this.adapters = { claude: new ClaudeAdapter(), codex: new CodexAdapter(), gemini: new GeminiAdapter(), demo: new DemoAdapter() };
  }

  /* -------------------------------------------- providers ------------------------------------------ */

  async providers(refresh = false): Promise<ProviderStatus[]> {
    if (!refresh && this.statusCache && Date.now() - this.statusCache.at < 60_000) return this.statusCache.list;
    const paths = this.services.settings().providerPaths;
    const list = await Promise.all(
      (Object.values(this.adapters) as ProviderAdapter[]).map((a) =>
        a.detect(paths[a.id]).catch((e): ProviderStatus => ({ id: a.id, name: a.name, available: false, models: [], hint: String(e) })),
      ),
    );
    this.statusCache = { at: Date.now(), list };
    return list;
  }

  /* ---------------------------------------------- tokens ------------------------------------------- */

  session(token: string | undefined): McpSession | undefined {
    return token ? this.tokens.get(token) : undefined;
  }

  issueToken(projectId: string, threadId: string, controller: AbortController, reportCalls: boolean): McpSession {
    const token = randomBytes(24).toString('base64url');
    const s: McpSession = { token, projectId, threadId, controller, reportCalls };
    this.tokens.set(token, s);
    return s;
  }

  revokeToken(token: string) {
    this.tokens.delete(token);
  }

  /** Token for manual/automation access (e.g. scripts): bound to a project, no thread. */
  issueProjectToken(projectId: string) {
    return this.issueToken(projectId, '', new AbortController(), false).token;
  }

  /* --------------------------------------------- threads ------------------------------------------- */

  listThreads(projectId: string): ThreadInfo[] {
    return this.services.store.listThreads(projectId).map((t) => (this.running.has(t.id) ? { ...t, status: 'running' as const } : t));
  }

  getThread(projectId: string, threadId: string): Thread | null {
    return this.running.get(threadId)?.thread ?? this.services.store.loadThread(projectId, threadId);
  }

  createThread(projectId: string, provider: ProviderId, model?: string, title?: string): Thread {
    const t: Thread = {
      id: newId('thr'),
      projectId,
      title: title ?? 'New conversation',
      provider,
      model,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'idle',
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 },
      items: [],
    };
    this.services.store.saveThread(t);
    this.broadcastThreads(projectId);
    return t;
  }

  updateThread(projectId: string, threadId: string, patch: { title?: string; provider?: ProviderId; model?: string }) {
    const t = this.getThread(projectId, threadId);
    if (!t) throw new Error('thread not found');
    if (patch.provider && patch.provider !== t.provider) {
      t.provider = patch.provider;
      t.providerSessionId = undefined; // sessions are provider-specific
    }
    if (patch.model !== undefined) t.model = patch.model;
    if (patch.title) t.title = patch.title;
    t.updatedAt = nowIso();
    this.services.store.saveThread(t);
    this.services.hub.toProject(projectId, { kind: 'thread.updated', thread: info(t) });
    return info(t);
  }

  deleteThread(projectId: string, threadId: string) {
    this.interrupt(threadId);
    this.services.store.deleteThread(projectId, threadId);
    this.broadcastThreads(projectId);
  }

  private broadcastThreads(projectId: string) {
    this.services.hub.toProject(projectId, { kind: 'threads.changed', projectId, threads: this.listThreads(projectId) });
  }

  interrupt(threadId: string) {
    this.running.get(threadId)?.controller.abort();
  }

  isRunning(threadId: string) {
    return this.running.has(threadId);
  }

  /* ---------------------------------------------- turns -------------------------------------------- */

  async send(projectId: string, threadId: string, text: string, attachments?: { name: string; assetId?: string; firmwareId?: string }[]): Promise<void> {
    if (this.running.has(threadId)) throw new Error('This conversation is already running — wait or interrupt it.');
    const thread = this.services.store.loadThread(projectId, threadId);
    if (!thread) throw new Error('thread not found');
    const adapter = this.adapters[thread.provider];
    if (!adapter) throw new Error(`Unknown provider ${thread.provider}`);
    const session = this.services.sessions.get(projectId);
    const hub = this.services.hub;
    const controller = new AbortController();
    const run: Running = { controller, thread, saveTimer: null };
    this.running.set(threadId, run);

    const save = () => {
      if (run.saveTimer) return;
      run.saveTimer = setTimeout(() => {
        run.saveTimer = null;
        this.services.store.saveThread(thread);
      }, 600);
    };
    const putItem = (item: ChatItem) => {
      const i = thread.items.findIndex((x) => x.id === item.id);
      if (i >= 0) thread.items[i] = item;
      else thread.items.push(item);
      thread.updatedAt = nowIso();
      hub.toProject(projectId, { kind: 'thread.item', threadId, item });
      save();
    };

    // user message + checkpoint
    if (thread.items.length === 0 && thread.title === 'New conversation') thread.title = text.replace(/\s+/g, ' ').slice(0, 60);
    putItem({ kind: 'user', id: newId('msg'), at: nowIso(), text, attachments });
    const checkpointRevision = session.checkpoint(`Before: ${text.replace(/\s+/g, ' ').slice(0, 80)}`);
    const turnItem: ChatItem & { kind: 'turn' } = { kind: 'turn', id: newId('turn'), at: nowIso(), status: 'started', checkpointRevision };
    putItem(turnItem);
    thread.status = 'running';
    thread.lastError = undefined;
    hub.toProject(projectId, { kind: 'thread.updated', thread: info(thread) });

    // workspace + MCP wiring
    const cwd = this.services.store.workspaceDir(projectId);
    const instructions = designAgentInstructions({ projectName: session.project.name, webResearch: this.services.settings().allowWebResearch });
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), instructions);
    fs.writeFileSync(path.join(cwd, 'GEMINI.md'), instructions);
    const mcp = this.issueToken(projectId, threadId, controller, !adapter.reportsToolCalls);
    const url = this.services.baseUrl();

    // item bookkeeping for events
    const textItems = new Map<string, ChatItem & { kind: 'assistant' }>();
    const reasoningItems = new Map<string, ChatItem & { kind: 'reasoning' }>();
    const toolItems = new Map<string, ChatItem & { kind: 'tool' }>();
    const toolStarted = new Map<string, number>();
    let lastDeltaFlush = 0;

    const emit = (e: AgentEvent) => {
      switch (e.type) {
        case 'session':
          thread.providerSessionId = e.sessionId;
          save();
          break;
        case 'text.delta': {
          let it = textItems.get(e.id);
          if (!it) {
            it = { kind: 'assistant', id: newId('msg'), at: nowIso(), text: '', streaming: true };
            textItems.set(e.id, it);
            putItem(it);
          }
          it.text += e.delta;
          hub.toProject(projectId, { kind: 'thread.delta', threadId, itemId: it.id, delta: e.delta });
          if (Date.now() - lastDeltaFlush > 1500) {
            lastDeltaFlush = Date.now();
            save();
          }
          break;
        }
        case 'text.done': {
          let it = textItems.get(e.id);
          if (!it) {
            it = { kind: 'assistant', id: newId('msg'), at: nowIso(), text: e.text };
            textItems.set(e.id, it);
          }
          it.text = e.text;
          it.streaming = false;
          putItem(it);
          break;
        }
        case 'reasoning': {
          let it = reasoningItems.get(e.id);
          if (!it) {
            it = { kind: 'reasoning', id: newId('rsn'), at: nowIso(), text: e.text, streaming: !e.done };
            reasoningItems.set(e.id, it);
          }
          it.text = e.text;
          it.streaming = !e.done;
          if (e.done || it.text.length % 400 < 40) putItem(it);
          break;
        }
        case 'tool.start': {
          const n = normaliseToolName(e.name);
          const it: ChatItem & { kind: 'tool' } = { kind: 'tool', id: newId('tool'), at: nowIso(), callId: e.callId, name: n.name, design: n.design, input: e.input, status: 'running' };
          toolItems.set(e.callId, it);
          toolStarted.set(e.callId, Date.now());
          putItem(it);
          break;
        }
        case 'tool.done': {
          const it = toolItems.get(e.callId);
          if (!it) break;
          it.status = e.isError ? 'error' : 'done';
          it.output = e.output.length > MAX_TOOL_OUTPUT ? `${e.output.slice(0, MAX_TOOL_OUTPUT)}\n… (${e.output.length - MAX_TOOL_OUTPUT} more chars)` : e.output;
          it.durationMs = Date.now() - (toolStarted.get(e.callId) ?? Date.now());
          putItem(it);
          break;
        }
        case 'usage':
          if (e.costUsd) turnItem.costUsd = (turnItem.costUsd ?? 0) + e.costUsd;
          if (e.inputTokens) turnItem.inputTokens = e.inputTokens;
          if (e.outputTokens) turnItem.outputTokens = e.outputTokens;
          break;
        case 'notice':
          putItem({ kind: 'system', id: newId('sys'), at: nowIso(), level: e.level, text: e.text });
          break;
      }
    };

    // bridge-side tool reporting for adapters that don't report calls
    if (mcp.reportCalls) {
      mcp.onCall = (name, args) => {
        const callId = newId('call');
        emit({ type: 'tool.start', callId, name: `mcp__pcbcad__${name}`, input: args });
        return callId;
      };
      mcp.onResult = (callId, textOut, isError) => emit({ type: 'tool.done', callId, output: textOut, isError });
    }

    const started = Date.now();
    void (async () => {
      let outcome: { status: 'completed' | 'failed' | 'interrupted'; error?: string };
      try {
        outcome = await adapter.runTurn(
          {
            threadId,
            projectId,
            prompt: text + attachmentNote(attachments),
            model: thread.model,
            resumeSessionId: thread.providerSessionId,
            systemPrompt: instructions,
            cwd,
            mcp: { command: process.execPath, args: [mcpProxyPath(), '--url', url, '--token', mcp.token], env: { PCBCAD_URL: url, PCBCAD_TOKEN: mcp.token }, url, token: mcp.token },
            allowWebResearch: this.services.settings().allowWebResearch,
            executable: this.services.settings().providerPaths[thread.provider],
            signal: controller.signal,
          },
          emit,
        );
      } catch (e) {
        outcome = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
      }
      // finalise dangling items
      for (const it of textItems.values())
        if (it.streaming) {
          it.streaming = false;
          putItem(it);
        }
      for (const it of toolItems.values())
        if (it.status === 'running') {
          it.status = outcome.status === 'interrupted' ? 'error' : 'done';
          it.output ??= outcome.status === 'interrupted' ? 'Interrupted' : '';
          putItem(it);
        }
      turnItem.status = outcome.status;
      turnItem.durationMs = Date.now() - started;
      turnItem.error = outcome.error;
      putItem({ ...turnItem });
      if (outcome.error) putItem({ kind: 'system', id: newId('sys'), at: nowIso(), level: 'error', text: outcome.error });
      thread.status = outcome.status === 'failed' ? 'error' : 'idle';
      thread.lastError = outcome.error;
      thread.usage.turns += 1;
      thread.usage.costUsd += turnItem.costUsd ?? 0;
      thread.usage.inputTokens += turnItem.inputTokens ?? 0;
      thread.usage.outputTokens += turnItem.outputTokens ?? 0;
      thread.updatedAt = nowIso();
      if (run.saveTimer) clearTimeout(run.saveTimer);
      this.services.store.saveThread(thread);
      this.running.delete(threadId);
      this.revokeToken(mcp.token);
      session.flush();
      hub.toProject(projectId, { kind: 'thread.updated', thread: info(thread) });
      this.broadcastThreads(projectId);
    })();
  }
}

function attachmentNote(att?: { name: string; assetId?: string; firmwareId?: string }[]) {
  if (!att?.length) return '';
  return `\n\n[Attached: ${att.map((a) => (a.firmwareId ? `firmware ${a.name} (id ${a.firmwareId})` : `${a.name} (in your working directory)`)).join(', ')}]`;
}

export function info(t: Thread): ThreadInfo {
  const { items: _i, ...rest } = t;
  return rest;
}
