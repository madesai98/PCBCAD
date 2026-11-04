/**
 * Defensive accessors for untyped JSON returned by distributor APIs. Everything here accepts
 * `unknown` and never throws.
 */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Walk a path of object keys / array indices; returns undefined on any miss. */
export function getPath(v: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = v;
  for (const k of path) {
    if (typeof k === 'number') {
      if (!Array.isArray(cur) || k < 0 || k >= cur.length) return undefined;
      cur = cur[k];
    } else {
      if (!isRecord(cur)) return undefined;
      cur = cur[k];
    }
  }
  return cur;
}

/** String value (numbers/booleans are stringified); `fallback` for null/undefined/objects. */
export function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return fallback;
}

/** Trimmed string, or undefined when empty / placeholder ('-', 'null'). */
export function asText(v: unknown): string | undefined {
  const s = asString(v).trim();
  if (!s || s === '-' || s.toLowerCase() === 'null' || s.toLowerCase() === 'undefined') return undefined;
  return s;
}

/** Number from a number or numeric string; undefined otherwise. */
export function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Parse JSON text without throwing. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
