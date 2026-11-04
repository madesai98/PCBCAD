import type { AirflowResult, EffectiveMaterial, Vec3, VoxelGrid } from '@pcbcad/core';

export interface AirflowHeatSource {
  /** Linear cell indices (i + nx·(j + ny·k)), normally solid cells of the component body. */
  cells: ArrayLike<number>;
  /** Total dissipated power (W), spread uniformly over the cells. */
  power: number;
  componentId?: string;
  ref?: string;
}

export interface AirflowOpening {
  name: string;
  /**
   * Air cells connected to the ambient (on the domain boundary or in wall cut-outs). They are
   * fixed-pressure reservoirs (p = 0, i.e. ambient hydrostatic pressure): inflow enters at ambient
   * temperature, outflow leaves with the cell temperature (zero-gradient).
   */
  cells: ArrayLike<number>;
}

export interface AirflowFan {
  name: string;
  /** Air cells of the fan disc/volume. */
  cells: ArrayLike<number>;
  /** Blowing direction (grid frame); the dominant axis is used. */
  direction: Vec3;
  /** Volumetric flow (m³/s) through the fan cross-section. */
  flowM3s: number;
}

export interface AirflowSetup {
  /** 0 = air; ≥ 1 = solid material index (materials[idx - 1]). Lengths in mm. */
  grid: VoxelGrid;
  materials: EffectiveMaterial[];
  heatSources: AirflowHeatSource[];
  openings: AirflowOpening[];
  fans?: AirflowFan[];
  /** Ambient temperature (°C). */
  ambient: number;
  /** Gravity (m/s², grid frame), default [0, 0, -9.81]. */
  gravity?: Vec3;
  /**
   * Heat-transfer coefficient (W/m²K, convection + radiation) from solid cells on the outer domain
   * boundary to ambient. Default 10.
   */
  externalH?: number;
  /** Outer SIMPLEC iteration limit (default 1000; converged cases typically need 40–400). */
  maxIterations?: number;
  onProgress?: (fraction: number) => void;
}

/** AirflowResult plus diagnostics (not yet part of the core contract). */
export interface AirflowResultDetail extends AirflowResult {
  vents: { name: string; flowM3s: number; direction: 'in' | 'out'; inM3s: number; outM3s: number; heatW: number }[];
  /** Mass-conservation and energy-balance diagnostics of the final fields. */
  residuals: { continuity: number; momentum: number; energyBalance: number };
  /** Air properties used (at ambient). */
  air: { density: number; viscosity: number; conductivity: number; specificHeat: number; beta: number };
  maxVelocity: number;
  warnings: string[];
  wallMs: number;
}
