/**
 * Network helper used by every distributor request: injectable fetch, hard timeout, never throws.
 * Browser-safe (uses only the global fetch / AbortController APIs).
 */

import { tryParseJson } from './json';

export type FetchLike = typeof fetch;

/** Default per-request timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpResult {
  ok: boolean;
  status: number;
  text: string;
  /** Network / timeout error message (status is 0 then). */
  error?: string;
  ms: number;
}

export interface HttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Perform an HTTP request with a hard timeout. Resolves with ok=false (and `error`) on network
 * failure, timeout or non-2xx status; never rejects.
 */
export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: FetchLike | undefined = opts.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch) return { ok: false, status: 0, text: '', error: 'fetch is not available', ms: 0 };
  const ctl = typeof AbortController === 'function' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      ctl?.abort();
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    const run = (async (): Promise<HttpResult> => {
      const res = await doFetch(url, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: opts.body,
        signal: ctl?.signal,
      });
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        text,
        error: res.ok ? undefined : `HTTP ${res.status}`,
        ms: Date.now() - t0,
      };
    })();
    const r = await Promise.race([run, timeout]);
    if (r === 'timeout') {
      run.catch(() => undefined); // swallow the abort rejection
      return { ok: false, status: 0, text: '', error: `timeout after ${timeoutMs} ms`, ms: Date.now() - t0 };
    }
    return r;
  } catch (e) {
    return { ok: false, status: 0, text: '', error: errorMessage(e), ms: Date.now() - t0 };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface JsonResult {
  ok: boolean;
  status: number;
  json?: unknown;
  error?: string;
  ms: number;
}

/** httpRequest + JSON parse. ok=false when the body is not valid JSON. */
export async function httpJson(url: string, opts: HttpOptions = {}): Promise<JsonResult> {
  const r = await httpRequest(url, opts);
  if (!r.ok) return { ok: false, status: r.status, error: r.error, ms: r.ms };
  const json = tryParseJson(r.text);
  if (json === undefined) return { ok: false, status: r.status, error: 'invalid JSON response', ms: r.ms };
  return { ok: true, status: r.status, json, ms: r.ms };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${e.message} (${cause.message})` : e.message;
  }
  return String(e);
}
