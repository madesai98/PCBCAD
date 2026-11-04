import { formatValue } from '@pcbcad/core';

/** Units that must never get an SI prefix (°C → "m°C" would be silly). */
const NO_PREFIX = new Set(['°C', 'C', 'K', '%', 'dB', '', 'x', '×', '°', 'g', 'A/mm²', 'MPa', 'mm', 'W/m²']);

/** Format a measured quantity for display: SI prefixes where they make sense, fixed decimals otherwise. */
export function fmtQuantity(value: number, unit: string, digits = 3): string {
  if (!Number.isFinite(value)) return `— ${unit}`.trim();
  if (value === 0) return unit ? `0 ${unit}` : '0';
  if (!unit && Number.isInteger(value)) return String(value);
  if (NO_PREFIX.has(unit)) {
    const abs = Math.abs(value);
    const d = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 1 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
    const s = value.toFixed(Math.max(0, Math.min(d, digits)));
    return unit ? `${s} ${unit}` : s;
  }
  return formatValue(value, unit, digits);
}

export function fmtTemp(v: number): string {
  return `${Number.isFinite(v) ? v.toFixed(1) : '—'} °C`;
}

export function fmtTime(seconds: number, digits = 3): string {
  if (seconds === 0) return '0 s';
  return formatValue(seconds, 's', digits);
}

/** 1-2-5 "nice" step covering `range` with roughly `target` ticks. */
export function niceStep(range: number, target: number): number {
  if (!(range > 0) || !(target > 0)) return 1;
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const m = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return m * mag;
}

/** Evenly spaced nice tick values in [min, max]. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!(max > min)) return [min];
  const step = niceStep(max - min, target);
  const out: number[] = [];
  const start = Math.ceil(min / step - 1e-9) * step;
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** Natural sort comparator ("PB2" < "PB10", "R2" < "R10"). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
