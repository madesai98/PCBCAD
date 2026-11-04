/**
 * Engineering-notation parsing/formatting for component values and distributor parameters.
 *   parseValue('10k') = 10000, parseValue('4k7') = 4700, parseValue('2R2') = 2.2,
 *   parseValue('100nF') = 1e-7, parseValue('4.7 µF') = 4.7e-6, parseValue('1M') = 1e6,
 *   parseValue('1MΩ') = 1e6, parseValue('3.3V') = 3.3, parseValue('500mA') = 0.5
 */

const PREFIX: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
};

const UNIT_WORDS = /(ohms?|Ω|Ω|ohm|F|H|V|A|W|Hz|s|R|°C|C|%)$/;

/** Parse a value with optional SI prefix and unit. Returns undefined when not parseable. */
export function parseValue(input: string | number | undefined | null): number | undefined {
  if (input == null) return undefined;
  if (typeof input === 'number') return Number.isFinite(input) ? input : undefined;
  let s = String(input).trim().replace(/\s+/g, '').replace(/,/g, '.');
  if (!s) return undefined;
  // RKM code: 4k7, 2R2, 1M5, 4n7, 0R
  const rkm = /^(\d+)([pnuµμmkKMGR])(\d+)([A-Za-zΩΩ]*)$/.exec(s);
  if (rkm) {
    const mult = rkm[2] === 'R' ? 1 : PREFIX[rkm[2]];
    if (mult !== undefined) return parseFloat(`${rkm[1]}.${rkm[3]}`) * mult;
  }
  if (/^\d+(\.\d+)?R$/.test(s)) return parseFloat(s);
  // strip known trailing unit words (one or two passes, e.g. "kΩ")
  for (let i = 0; i < 2; i++) {
    const m = UNIT_WORDS.exec(s);
    if (m && s.length > m[0].length) {
      const rest = s.slice(0, -m[0].length);
      // don't strip 'm' that is actually a prefix; UNIT_WORDS doesn't include m
      s = rest;
    }
  }
  const m = /^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)([pnuµμmkKMGT]?)$/.exec(s);
  if (!m) return undefined;
  const num = parseFloat(m[1]);
  const mult = m[2] ? PREFIX[m[2]] : 1;
  return num * (mult ?? 1);
}

const FORMAT_PREFIXES: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
  [1e-9, 'n'],
  [1e-12, 'p'],
];

/** Format with SI prefix: formatValue(4700, 'Ω') = '4.7 kΩ'. */
export function formatValue(value: number, unit = '', digits = 3): string {
  if (!Number.isFinite(value)) return `— ${unit}`.trim();
  if (value === 0) return `0 ${unit}`.trim();
  const abs = Math.abs(value);
  for (const [scale, prefix] of FORMAT_PREFIXES) {
    if (abs >= scale * 0.9999) {
      const v = value / scale;
      return `${trimNumber(v, digits)} ${prefix}${unit}`.trim();
    }
  }
  const [scale, prefix] = FORMAT_PREFIXES[FORMAT_PREFIXES.length - 1];
  return `${trimNumber(value / scale, digits)} ${prefix}${unit}`.trim();
}

function trimNumber(v: number, digits: number): string {
  const s = v.toPrecision(digits);
  if (s.includes('e')) return String(Number(s));
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Parse ranges like '1.71V~3.6V', '-40℃~+85℃', '2.7V to 5.5V' into [min, max]. */
export function parseRange(input: string | undefined): [number, number] | undefined {
  if (!input) return undefined;
  const parts = String(input)
    .replace(/℃|°C/g, '')
    .split(/~|\bto\b|…|\.\.\./i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length !== 2) return undefined;
  const a = parseValue(parts[0]);
  const b = parseValue(parts[1]);
  if (a === undefined || b === undefined) return undefined;
  return [Math.min(a, b), Math.max(a, b)];
}

/** Find the first parameter whose name matches any of the patterns and parse it. */
export function paramValue(params: Record<string, string>, ...patterns: RegExp[]): number | undefined {
  for (const pat of patterns) {
    for (const [k, v] of Object.entries(params)) {
      if (pat.test(k)) {
        const pv = parseValue(firstToken(v));
        if (pv !== undefined) return pv;
      }
    }
  }
  return undefined;
}

function firstToken(v: string): string {
  // "1.1V@(800mA)" -> "1.1V"; "±1%" -> "1%"
  return String(v).split(/[@(\s,;]/)[0].replace(/^±/, '');
}

/** Convert oz/ft² copper weight to thickness in mm (1 oz = 0.0347 mm). */
export function copperOzToMm(oz: number): number {
  return oz * 0.0347;
}

/** Resistivity of annealed copper at 20 °C (Ω·m) and its temperature coefficient (1/K). */
export const COPPER_RESISTIVITY = 1.72e-8;
export const COPPER_TEMPCO = 0.00393;

/** AWG wire diameter (mm). */
export function awgDiameterMm(awg: number): number {
  return 0.127 * Math.pow(92, (36 - awg) / 39);
}

/** Resistance per metre of solid copper wire of the given AWG (Ω/m). */
export function awgOhmPerMeter(awg: number): number {
  const d = awgDiameterMm(awg) / 1000;
  return COPPER_RESISTIVITY / (Math.PI * (d / 2) ** 2);
}
