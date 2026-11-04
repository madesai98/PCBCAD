import type { ToolDescriptor } from '@pcbcad/core';
import type { Settings } from '../config';
import type { Hub } from '../hub';
import type { Store } from '../store/store';
import type { Actor, ProjectSession, SessionManager } from './session';
import type { TaskRunner } from '../sim/tasks';
import type { PartsService } from './parts-service';

export interface Services {
  store: Store;
  sessions: SessionManager;
  hub: Hub;
  tasks: TaskRunner;
  parts: PartsService;
  settings: () => Settings;
  /** Base URL of this server (for download links handed to agents/users). */
  baseUrl: () => string;
}

export interface ToolContext {
  session: ProjectSession;
  actor: Actor;
  threadId?: string;
  services: Services;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** Concise, information-dense text for the LLM (and shown in the UI tool card). */
  text: string;
  /** Optional structured payload for the UI. */
  data?: unknown;
  isError?: boolean;
}

export interface ToolDef<A = any> extends ToolDescriptor {
  handler: (ctx: ToolContext, args: A) => Promise<ToolResult | string> | ToolResult | string;
}

export class ToolError extends Error {}

/* ----------------------------------------- schema helpers ---------------------------------------- */

type Schema = Record<string, unknown>;

export const S = {
  str: (description?: string, extra: Schema = {}): Schema => ({ type: 'string', ...(description ? { description } : {}), ...extra }),
  num: (description?: string, extra: Schema = {}): Schema => ({ type: 'number', ...(description ? { description } : {}), ...extra }),
  int: (description?: string, extra: Schema = {}): Schema => ({ type: 'integer', ...(description ? { description } : {}), ...extra }),
  bool: (description?: string): Schema => ({ type: 'boolean', ...(description ? { description } : {}) }),
  enum: (values: readonly string[], description?: string): Schema => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) }),
  arr: (items: Schema, description?: string, extra: Schema = {}): Schema => ({ type: 'array', items, ...(description ? { description } : {}), ...extra }),
  obj: (properties: Record<string, Schema>, required: string[] = [], description?: string): Schema => ({
    type: 'object',
    properties,
    required,
    ...(description ? { description } : {}),
  }),
  any: (description?: string): Schema => ({ ...(description ? { description } : {}) }),
  vec2: (description?: string): Schema => ({ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, ...(description ? { description } : {}) }),
  vec3: (description?: string): Schema => ({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, ...(description ? { description } : {}) }),
};

/* ---------------------------------------- minimal validation -------------------------------------- */

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Validates the subset of JSON Schema used by our tools; coerces numeric strings. Returns errors. */
export function validate(schema: Schema, value: unknown, path = 'args'): string[] {
  const errs: string[] = [];
  const t = schema.type as string | undefined;
  if (t) {
    const vt = typeOf(value);
    const ok =
      t === vt ||
      (t === 'integer' && vt === 'number' && Number.isInteger(value)) ||
      (t === 'number' && vt === 'number');
    if (!ok) {
      errs.push(`${path}: expected ${t}, got ${vt}`);
      return errs;
    }
  }
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) errs.push(`${path}: must be one of ${(schema.enum as unknown[]).join(', ')}`);
  if (t === 'object' && value && typeof value === 'object') {
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[]) {
      if ((value as Record<string, unknown>)[r] === undefined) errs.push(`${path}.${r}: required`);
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (props[k] && v !== undefined && v !== null) errs.push(...validate(props[k], v, `${path}.${k}`));
    }
  }
  if (t === 'array' && Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errs.push(`${path}: at least ${schema.minItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items as Schema, v, `${path}[${i}]`)));
  }
  return errs;
}

/** Coerce common LLM mistakes: numeric strings for numbers, JSON strings for objects/arrays. */
export function coerce(schema: Schema, value: unknown): unknown {
  const t = schema.type as string | undefined;
  if ((t === 'number' || t === 'integer') && typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) return Number(value);
  if (t === 'boolean' && typeof value === 'string') return value === 'true' ? true : value === 'false' ? false : value;
  if ((t === 'object' || t === 'array') && typeof value === 'string') {
    try {
      return coerce(schema, JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (t === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = props[k] ? coerce(props[k], v) : v;
    return out;
  }
  if (t === 'array' && Array.isArray(value) && schema.items) return value.map((v) => coerce(schema.items as Schema, v));
  return value;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(...defs: ToolDef[]) {
    for (const d of defs) {
      if (this.tools.has(d.name)) throw new Error(`Duplicate tool ${d.name}`);
      this.tools.set(d.name, d);
    }
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map(({ handler: _h, ...d }) => d);
  }

  has(name: string) {
    return this.tools.has(name);
  }

  get(name: string) {
    return this.tools.get(name);
  }

  async call(name: string, ctx: ToolContext, rawArgs: unknown): Promise<ToolResult> {
    const def = this.tools.get(name);
    if (!def) return { text: `Unknown tool '${name}'. Call get_design_overview or list tools.`, isError: true };
    const args = coerce(def.inputSchema, rawArgs ?? {});
    const errs = validate(def.inputSchema, args);
    if (errs.length) return { text: `Invalid arguments for ${name}:\n- ${errs.join('\n- ')}`, isError: true };
    try {
      const r = await def.handler(ctx, args);
      return typeof r === 'string' ? { text: r } : r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e instanceof ToolError)) console.error(`[tool ${name}]`, e);
      return { text: `Error in ${name}: ${msg}`, isError: true };
    }
  }
}
