/**
 * Wire protocol between the PCBCAD bridge server and the browser app (WebSocket JSON messages),
 * plus the persisted chat-thread model.
 */
import type { ActivityEntry, Project, ProjectSummary } from './types/project';

export type ProviderId = 'claude' | 'codex' | 'gemini' | 'demo';

export interface ProviderModel {
  id: string;
  label: string;
  description?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  /** CLI executable detected and runnable. */
  available: boolean;
  version?: string;
  path?: string;
  models: ProviderModel[];
  defaultModel?: string;
  /** Human-readable install / login hint when unavailable. */
  hint?: string;
}

export interface ThreadUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
}

export interface ThreadInfo {
  id: string;
  projectId: string;
  title: string;
  provider: ProviderId;
  model?: string;
  createdAt: string;
  updatedAt: string;
  /** Provider-side session id used to resume the conversation (Claude session id, Codex thread id…). */
  providerSessionId?: string;
  status: 'idle' | 'running' | 'error';
  lastError?: string;
  usage: ThreadUsage;
}

export type ChatItem =
  | { kind: 'user'; id: string; at: string; text: string; attachments?: { name: string; assetId?: string; firmwareId?: string }[] }
  | { kind: 'assistant'; id: string; at: string; text: string; streaming?: boolean }
  | { kind: 'reasoning'; id: string; at: string; text: string; streaming?: boolean }
  | {
      kind: 'tool';
      id: string;
      at: string;
      callId: string;
      /** Tool name without provider prefixes (e.g. 'add_component'). */
      name: string;
      /** True for PCBCAD design tools, false for provider built-ins (web search, file read…). */
      design: boolean;
      input: unknown;
      status: 'running' | 'done' | 'error';
      output?: string;
      durationMs?: number;
    }
  | { kind: 'system'; id: string; at: string; level: 'info' | 'warn' | 'error'; text: string }
  | {
      kind: 'turn';
      id: string;
      at: string;
      status: 'started' | 'completed' | 'failed' | 'interrupted';
      /** Project revision captured before the turn (restore point). */
      checkpointRevision?: number;
      durationMs?: number;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      error?: string;
    };

export interface Thread extends ThreadInfo {
  items: ChatItem[];
}

export interface CheckpointInfo {
  revision: number;
  at: string;
  label: string;
}

/* ------------------------------------------ messages ------------------------------------------- */

export interface ClientRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export type ServerEvent =
  | { kind: 'hello'; version: string; dataDir: string }
  | { kind: 'projects.changed'; projects: ProjectSummary[] }
  | { kind: 'project.snapshot'; project: Project }
  | { kind: 'project.activity'; projectId: string; entry: ActivityEntry }
  | { kind: 'threads.changed'; projectId: string; threads: ThreadInfo[] }
  | { kind: 'thread.updated'; thread: ThreadInfo }
  | { kind: 'thread.item'; threadId: string; item: ChatItem }
  | { kind: 'thread.delta'; threadId: string; itemId: string; delta: string }
  | { kind: 'sim.progress'; projectId: string; runId: string; progress: number; status: string; message?: string }
  | { kind: 'toast'; level: 'info' | 'success' | 'warn' | 'error'; message: string };

export type ServerMessage =
  | { type: 'response'; id: number; ok: true; result: unknown }
  | { type: 'response'; id: number; ok: false; error: string }
  | { type: 'event'; event: ServerEvent };

/** Design tool descriptor (MCP-compatible). */
export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** UI grouping. */
  group: 'project' | 'parts' | 'schematic' | 'layout' | 'interconnect' | 'mechanical' | 'assembly' | 'simulation' | 'firmware' | 'export';
  /** Long-running tools report progress and may take minutes. */
  slow?: boolean;
}
