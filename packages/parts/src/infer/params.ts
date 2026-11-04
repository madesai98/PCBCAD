import { parseValue } from '@pcbcad/core';

/**
 * Helpers for reading distributor parameters such as
 *   'Voltage Dropout' = '1.1V@(800mA)', 'Voltage - Forward(Vf)' = '1.6V~2.6V',
 *   'RDS(on)' = '5.2mΩ@15A,10V', 'Vgs' = '±12V', 'Current - Continuous Drain(Id)' = '15A、18A'.
 * All results are SI numbers (V, A, Ω, F, H, Hz, W, °C).
 */

export type QuantityMode = 'first' | 'min' | 'max' | 'mid';

function normalise(v: string): string {
  return v
    .replace(/℃/g, '°C')
    .replace(/[、，；]/g, ',')
    .replace(/ /g, ' ')
    .replace(/(\d)\s+(?=[pnuµμmkKMG]?(Ω|ohm|F|H|V|A|W|Hz)\b)/g, '$1')
    .trim();
}

/** Round to 9 significant digits to remove binary floating-point noise (0.14200000000000002 → 0.142). */
function sig(v: number | undefined): number | undefined {
  return v === undefined || !Number.isFinite(v) || v === 0 ? v : Number(v.toPrecision(9));
}

/** Parse one scalar token ('±12V', '+85°C', '100,000', '≤5mA') with core parseValue. */
export function parseScalar(token: string): number | undefined {
  return sig(parseScalarRaw(token));
}

function parseScalarRaw(token: string): number | undefined {
  let t = token.trim().replace(/^[±+≤≥<>~≈]+/, '').replace(/^\(|\)$/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?/.test(t)) t = t.replace(/,(?=\d{3})/g, '');
  if (!t) return undefined;
  // lengths are millimetres: '2.54mm' → 2.54 (not 2.54 milli-units)
  const mm = /^([-+]?\d*\.?\d+)\s*mm$/i.exec(t);
  if (mm) return parseFloat(mm[1]);
  const v = parseValue(t);
  if (v !== undefined) return v;
  // tolerate trailing words: '3.3V Fixed' → '3.3V'
  const m = /^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?\s*[pnuµμmkKMGT]?(?:Ω|ohms?|F|H|V|A|W|Hz|°C|%)?/.exec(t);
  return m && m[0] !== t ? parseValue(m[0].replace(/\s+/g, '')) : undefined;
}

/**
 * Parse the leading quantity of a parameter value. The test condition after '@' is ignored.
 * Ranges ('1.6V~2.6V', '2.7V to 5.5V') resolve according to `mode` (default 'first').
 */
export function parseQuantity(value: string | undefined, mode: QuantityMode = 'first'): number | undefined {
  if (!value) return undefined;
  const v = normalise(value);
  if (!v || v === '-') return undefined;
  const main = v.split('@')[0];
  const range = main.split(/~|\bto\b|…/i).map((s) => s.trim()).filter(Boolean);
  if (range.length === 2) {
    const a = parseScalar(firstToken(range[0]));
    const b = parseScalar(firstToken(range[1]));
    if (a !== undefined && b !== undefined) {
      if (mode === 'min') return Math.min(a, b);
      if (mode === 'max') return Math.max(a, b);
      if (mode === 'mid') return sig((a + b) / 2);
      return a;
    }
    return a ?? b;
  }
  // list of alternatives '15A,18A' → first (or min/max)
  const parts = main
    .split(/,(?!\d{3}\b)/)
    .map((s) => parseScalar(firstToken(s)))
    .filter((x): x is number => x !== undefined);
  if (!parts.length) return undefined;
  if (mode === 'min') return Math.min(...parts);
  if (mode === 'max') return Math.max(...parts);
  return parts[0];
}

function firstToken(s: string): string {
  const t = s.trim();
  // keep '100,000' together; split at whitespace / '(' / ';'
  return t.split(/[\s(;]/)[0] ?? t;
}

/** Quantities in the test condition: '1.1V@(800mA)' → [0.8]; '5.2mΩ@15A,10V' → [15, 10]. */
export function parseCondition(value: string | undefined): number[] {
  if (!value) return [];
  const v = normalise(value);
  const at = v.indexOf('@');
  if (at < 0) return [];
  return v
    .slice(at + 1)
    .replace(/[()]/g, '')
    .split(/[,\s]+/)
    .map((s) => parseScalar(s))
    .filter((x): x is number => x !== undefined);
}

/** First parameter whose key matches any pattern (patterns are tried in order of priority). */
export function findParam(params: Record<string, string> | undefined, ...patterns: RegExp[]): { key: string; value: string } | undefined {
  if (!params) return undefined;
  const entries = Object.entries(params).filter(([, v]) => v != null && String(v).trim() !== '' && String(v).trim() !== '-');
  for (const re of patterns) {
    for (const [key, value] of entries) if (re.test(key)) return { key, value: String(value) };
  }
  return undefined;
}

/** Numeric value of the first matching parameter that parses. */
export function paramNumber(params: Record<string, string> | undefined, patterns: RegExp[], mode: QuantityMode = 'first'): number | undefined {
  if (!params) return undefined;
  const entries = Object.entries(params);
  for (const re of patterns) {
    for (const [key, value] of entries) {
      if (!re.test(key)) continue;
      const n = parseQuantity(String(value), mode);
      if (n !== undefined && Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/** Text value of the first matching parameter. */
export function paramText(params: Record<string, string> | undefined, ...patterns: RegExp[]): string | undefined {
  return findParam(params, ...patterns)?.value.trim();
}

/** Temperature range from a value like '-40℃~+85℃' → [-40, 85]. */
export function parseTempRange(value: string | undefined): [number, number] | undefined {
  if (!value) return undefined;
  const v = normalise(value).split('@')[0];
  const parts = v.split(/~|\bto\b/i).map((s) => s.trim());
  if (parts.length !== 2) return undefined;
  const a = parseScalar(parts[0]);
  const b = parseScalar(parts[1]);
  if (a === undefined || b === undefined) return undefined;
  const sa = parts[0].startsWith('-') ? -Math.abs(a) : a;
  return [Math.min(sa, b), Math.max(sa, b)];
}

/**
 * Compact engineering string for passive values: 10000 → '10k', 1e-7 → '100n', 4.7e-6 → '4.7u'.
 * Append the unit yourself ('100nF'); resistors conventionally omit it ('10k').
 */
export function engString(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  const prefixes: [number, string][] = [
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
    [1, ''],
    [1e-3, 'm'],
    [1e-6, 'u'],
    [1e-9, 'n'],
    [1e-12, 'p'],
  ];
  const abs = Math.abs(v);
  for (const [s, p] of prefixes) {
    if (abs >= s * 0.99999) {
      const n = Math.round((v / s) * 1000) / 1000;
      return `${n}${p}`;
    }
  }
  return `${Math.round((v / 1e-12) * 1000) / 1000}p`;
}
