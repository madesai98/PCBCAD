import { copperOzToMm } from '@pcbcad/core';

/**
 * IPC-2221 (formerly IPC-D-275) conductor current capacity:
 *
 *   I = k · ΔT^0.44 · A^0.725
 *
 * with I in A, ΔT the conductor temperature rise in °C, A the conductor cross-section in mil²,
 * k = 0.048 for external (outer-layer) and 0.024 for internal conductors.
 *
 * The curves were fitted to 1950s data for isolated traces on a board in still air; they are
 * conservative for internal layers and for boards with copper planes (IPC-2152 gives higher
 * capacities in most practical cases) and are intended for widths up to ~10 mm, currents up to
 * ~35 A and rises of 10–100 °C. Cross-section uses `copperOzToMm` (1 oz = 34.7 µm).
 */

/** IPC-2221 constant for external (outer layer) conductors. */
export const IPC2221_K_EXTERNAL = 0.048;
/** IPC-2221 constant for internal conductors. */
export const IPC2221_K_INTERNAL = 0.024;

const MM_PER_MIL = 0.0254;

/** Trace cross-section in mil² for the IPC-2221 formula. */
export function ipc2221AreaMil2(widthMm: number, copperOz: number): number {
  if (!(widthMm > 0) || !(copperOz > 0)) return 0;
  return (widthMm / MM_PER_MIL) * (copperOzToMm(copperOz) / MM_PER_MIL);
}

/**
 * Current (A) that raises a trace by `deltaT` °C according to IPC-2221.
 * @param widthMm   trace width (mm)
 * @param copperOz  copper weight (oz/ft²; 1 oz ≈ 35 µm)
 * @param deltaT    allowed temperature rise (°C)
 * @param external  true for outer layers (top/bottom), false for inner layers
 * @returns capacity in A (0 for non-positive inputs)
 */
export function ipc2221Capacity(widthMm: number, copperOz: number, deltaT: number, external: boolean): number {
  const A = ipc2221AreaMil2(widthMm, copperOz);
  if (A <= 0 || !(deltaT > 0)) return 0;
  const k = external ? IPC2221_K_EXTERNAL : IPC2221_K_INTERNAL;
  return k * Math.pow(deltaT, 0.44) * Math.pow(A, 0.725);
}

/**
 * Temperature rise (°C) of a trace carrying `current` A according to IPC-2221:
 * ΔT = (|I| / (k·A^0.725))^(1/0.44).
 * @param current   conductor current (A); the sign is ignored
 * @param widthMm   trace width (mm)
 * @param copperOz  copper weight (oz/ft²)
 * @param external  true for outer layers, false for inner layers
 * @returns rise in °C (0 for zero current, Infinity for a zero cross-section carrying current)
 */
export function ipc2221TempRise(current: number, widthMm: number, copperOz: number, external: boolean): number {
  const I = Math.abs(current);
  if (!(I > 0)) return 0;
  const A = ipc2221AreaMil2(widthMm, copperOz);
  if (A <= 0) return Infinity;
  const k = external ? IPC2221_K_EXTERNAL : IPC2221_K_INTERNAL;
  return Math.pow(I / (k * Math.pow(A, 0.725)), 1 / 0.44);
}
