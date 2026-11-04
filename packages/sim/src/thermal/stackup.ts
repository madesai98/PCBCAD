import type { CopperLayer, Stackup } from '@pcbcad/core';
import { COPPER_RESISTIVITY, COPPER_TEMPCO, copperOzToMm, getMaterial } from '@pcbcad/core';

/**
 * Stackup helpers shared by the electrical (trace current) and thermal models.
 *
 * Layer heights: the contract only stores the layer count and total thickness, so a standard
 * build is assumed:
 *  - 2 layers: top at z = t, bottom at z = 0.
 *  - 4 layers: thin prepreg (12.5 % of t, 0.2 mm on a 1.6 mm board) between each outer layer and
 *    its inner neighbour, thick core in the middle (the common JLC/PCBWay 4-layer build).
 *  - 6 layers: equally spaced copper layers.
 * Copper thickness itself is neglected in the z positions.
 */

/** Through-hole / via barrel plating thickness (mm), IPC-6012 class 2 average. */
export const PLATING_THICKNESS_MM = 0.025;

/** Copper layers of a stackup ordered from top to bottom. */
export function stackLayers(stackup: Stackup): CopperLayer[] {
  if (stackup.layers === 6) return ['top', 'in1', 'in2', 'in3', 'in4', 'bottom'];
  if (stackup.layers === 4) return ['top', 'in1', 'in2', 'bottom'];
  return ['top', 'bottom'];
}

export function isOuterLayer(layer: CopperLayer): boolean {
  return layer === 'top' || layer === 'bottom';
}

/** Copper weight (oz/ft²) of a layer. */
export function layerCopperOz(stackup: Stackup, layer: CopperLayer): number {
  return isOuterLayer(layer) ? stackup.copperOz.outer : stackup.copperOz.inner;
}

/** Copper thickness (mm) of a layer. */
export function layerCopperMm(stackup: Stackup, layer: CopperLayer): number {
  return copperOzToMm(layerCopperOz(stackup, layer));
}

/** Height (mm) of each copper layer above the bottom copper (bottom = 0, top = thickness). */
export function layerZ(stackup: Stackup): Partial<Record<CopperLayer, number>> {
  const t = stackup.thickness;
  const layers = stackLayers(stackup);
  const z: Partial<Record<CopperLayer, number>> = {};
  if (layers.length === 4) {
    const p = 0.125 * t;
    z.top = t;
    z.in1 = t - p;
    z.in2 = p;
    z.bottom = 0;
  } else {
    const n = layers.length - 1;
    layers.forEach((l, i) => (z[l] = t * (1 - i / n)));
  }
  return z;
}

/**
 * Layers spanned by a via (inclusive), in stack order. Unknown/absent `from`/`to` default to a
 * through via (top..bottom).
 */
export function viaSpan(stackup: Stackup, from?: CopperLayer, to?: CopperLayer): CopperLayer[] {
  const layers = stackLayers(stackup);
  let a = from ? layers.indexOf(from) : 0;
  let b = to ? layers.indexOf(to) : layers.length - 1;
  if (a < 0) a = 0;
  if (b < 0) b = layers.length - 1;
  if (a > b) [a, b] = [b, a];
  if (a === b) {
    // Degenerate span: treat as through via.
    a = 0;
    b = layers.length - 1;
  }
  return layers.slice(a, b + 1);
}

/** Barrel copper cross-section (mm²) of a plated hole with finished diameter `drillMm`. */
export function barrelAreaMm2(drillMm: number, plating = PLATING_THICKNESS_MM): number {
  const d = drillMm > 0 ? drillMm : 0.3;
  return Math.PI * plating * (d + plating);
}

/** Copper resistivity (Ω·m) at temperature `tC` (°C), linear tempco about 20 °C. */
export function copperResistivity(tC: number): number {
  return COPPER_RESISTIVITY * (1 + COPPER_TEMPCO * (tC - 20));
}

/** Resistance multiplier relative to 20 °C. */
export function copperTempFactor(tC: number): number {
  return 1 + COPPER_TEMPCO * (tC - 20);
}

/** Thermal conductivity of copper (W/m·K) from the materials library. */
export function copperConductivity(): number {
  return getMaterial('copper')?.thermalConductivity ?? 388;
}

/** In-plane / through-plane conductivity (W/m·K) of the dielectric (FR-4 fallback). */
export function dielectricConductivity(stackup: Stackup): { kIn: number; kZ: number; emissivity: number } {
  const m = getMaterial(stackup.dielectric) ?? getMaterial('fr4');
  const k = m?.thermalConductivity ?? 0.3;
  return { kIn: m?.kInPlane ?? k, kZ: m?.kThroughPlane ?? k, emissivity: m?.emissivity ?? 0.9 };
}
