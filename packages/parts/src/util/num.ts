/**
 * Small numeric helpers shared by the generators and parsers. All lengths are millimetres.
 */

const FP_EPS = 1e-9;

/** Round to a fixed number of decimals (default 4 → 0.1 µm), removing floating-point noise. */
export function rnd(v: number, decimals = 4): number {
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** Round up to a multiple of `step` (tolerant to floating-point noise). */
export function ceilTo(v: number, step: number): number {
  return rnd(Math.ceil(v / step - FP_EPS) * step, 6);
}

/** Round down to a multiple of `step` (tolerant to floating-point noise). */
export function floorTo(v: number, step: number): number {
  return rnd(Math.floor(v / step + FP_EPS) * step, 6);
}

/** Round to the nearest multiple of `step`. */
export function roundTo(v: number, step: number): number {
  return rnd(Math.round(v / step) * step, 6);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** True when |a - b| <= eps. */
export function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

/** Finite positive number or undefined. */
export function pos(v: number | undefined | null): number | undefined {
  return v != null && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Normalise an angle in degrees to (-180, 180]. */
export function normDeg(a: number): number {
  let r = a % 360;
  if (r <= -180) r += 360;
  if (r > 180) r -= 360;
  return rnd(r, 6);
}
