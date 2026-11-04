import type { ProviderId, ProviderStatus } from '@pcbcad/core';

/** Normalised events emitted by every provider adapter during a turn. */
export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text.delta'; id: string; delta: string }
  | { type: 'text.done'; id: string; text: string }
  | { type: 'reasoning'; id: string; text: string; done: boolean }
  | { type: 'tool.start'; callId: string; name: string; input: unknown }
  | { type: 'tool.done'; callId: string; output: string; isError: boolean }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Bridge URL + token (for in-process clients such as the demo agent). */
  url: string;
  token: string;
}

export interface TurnRequest {
  threadId: string;
  projectId: string;
  prompt: string;
  model?: string;
  /** Provider session to resume (from a previous turn). */
  resumeSessionId?: string;
  systemPrompt: string;
  /** Working directory for the CLI (project workspace with attachments + instruction files). */
  cwd: string;
  mcp: McpLaunch;
  allowWebResearch: boolean;
  executable?: string;
  signal: AbortSignal;
}

export interface TurnOutcome {
  status: 'completed' | 'failed' | 'interrupted';
  error?: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  /** Whether the adapter reports tool calls itself (else the bridge reports MCP calls it serves). */
  reportsToolCalls: boolean;
  detect(executable?: string): Promise<ProviderStatus>;
  runTurn(req: TurnRequest, emit: (e: AgentEvent) => void): Promise<TurnOutcome>;
}

/** Strip provider/MCP prefixes: "mcp__pcbcad__add_components" → "add_components". */
export function normaliseToolName(name: string): { name: string; design: boolean } {
  const m = /^(?:mcp__)?pcbcad(?:__|\.|:|\/)(.+)$/.exec(name);
  if (m) return { name: m[1], design: true };
  return { name, design: false };
}
