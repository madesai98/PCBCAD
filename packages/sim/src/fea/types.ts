import type { EffectiveMaterial, StructuralResult, Vec3, VoxelGrid } from '@pcbcad/core';

/**
 * Selection of solid voxels (and their nodes) in a voxel grid. All coordinates are grid-frame mm.
 *
 * - `box`: solid voxels whose centre lies inside [min, max] (inclusive). If no voxel centre is inside,
 *   the voxels that intersect the box are taken instead (so thin boxes around a surface still work).
 * - `plane`: the extreme face of the part on one axis side: solid voxels whose near face lies within
 *   `depth` (default h) of the extreme solid extent on that side. Its *nodes* are only the nodes of
 *   those voxels' exposed faces that face the plane side (a clamped / loaded surface, not a clamped
 *   block); pressure acts on those same faces.
 * - `cylinder`: solid voxels whose centre lies inside the cylinder centred at `center` (mm), with axis
 *   direction `axis` (normalised internally), `radius` (mm) and total `length` (mm, ±length/2 about the
 *   centre). If none, voxels whose centre is within half a voxel diagonal of the cylinder are taken.
 * - `cells`: explicit linear voxel indices (i + nx·(j + ny·k)); empty/out-of-range entries are ignored.
 *
 * Except for `plane`, a region's node set is all 8 nodes of every selected voxel, and pressure acts on
 * all exposed faces of the selected voxels.
 */
export type Region =
  | { kind: 'box'; min: Vec3; max: Vec3 }
  | { kind: 'plane'; axis: 'x' | 'y' | 'z'; side: 'min' | 'max'; depth?: number }
  | { kind: 'cylinder'; center: Vec3; axis: Vec3; radius: number; length: number }
  | { kind: 'cells'; indices: ArrayLike<number> };

/** A load applied to a region. Both parts may be given; they add. */
export interface StructuralLoad {
  region: Region;
  /** Total force (N, grid frame), distributed equally over the region's nodes. */
  force?: Vec3;
  /** Pressure (MPa = N/mm²) on the exposed faces of the region, acting inward (into the material). */
  pressure?: number;
}

export interface StructuralSetup {
  /** Voxel model; voxel material index idx ≥ 1 uses materials[idx - 1]. */
  grid: VoxelGrid;
  /** Effective (as-manufactured) materials, materials[idx - 1] for voxel material index idx. */
  materials: EffectiveMaterial[];
  /** Regions whose nodes are fully clamped (all three displacement components = 0). */
  fixtures: Region[];
  loads: StructuralLoad[];
  /**
   * Body-force acceleration field (m/s², grid frame), e.g. gravity [0, 0, -9.81]: every voxel receives
   * the force (density × volume) × a in the direction of `a`. For the d'Alembert load of a body that
   * accelerates with A, pass −A.
   */
  bodyAcceleration?: Vec3;
  /**
   * Advanced: per-voxel body-force acceleration (m/s², grid frame) replacing `bodyAcceleration`, e.g. the
   * rigid-body acceleration field of an impact (translation + rotation). Called once per solid voxel with
   * the voxel centre (mm) and its linear index.
   */
  bodyAccelerationField?: (x: number, y: number, z: number, voxel: number) => Vec3;
  /**
   * Where voxel stresses are sampled: 'surface' (default) = max of the centroid value and the values at
   * the centres of the voxel's exposed / material-interface faces (captures the bending surface stress of
   * thin walls); 'centroid' = centroid only (smoother, but under-reads the surface stress of a 2-voxel
   * wall in bending by ~50 %).
   */
  stressSampling?: 'surface' | 'centroid';
  /** PCG iteration limit per solid body (default 1000). */
  maxIterations?: number;
  /** Relative residual ‖r‖₂/‖f‖₂ to reach (default 1e-6). */
  tolerance?: number;
  /** Progress callback, fraction in [0, 1]. */
  onProgress?: (fraction: number) => void;
}

/** Human-readable descriptions copied into the result. */
export interface StructuralMeta {
  title: string;
  loads: string[];
  fixtures: string[];
}

/**
 * StructuralResult plus diagnostic fields that are not (yet) part of the core contract.
 * The primary metrics (maxVonMises, minSafetyFactor, maxStressAt) exclude the one-voxel layer around
 * fixtures and concentrated loads; `raw` holds the unfiltered values.
 */
export interface StructuralResultDetail extends StructuralResult {
  /** Unfiltered extreme values (include stress singularities at supports / point loads). */
  raw: { maxVonMises: number; minSafetyFactor: number; maxStressAt: Vec3 };
  /** Number of voxels excluded from the primary metrics as singularity-adjacent. */
  singularityExcludedVoxels: number;
  /** 99th percentile of the voxel von Mises stress over the analysed, non-excluded voxels (MPa). */
  vonMisesP99: number;
  /** Total applied load (N) — sum of forces, pressures and body forces actually applied. */
  appliedForce: Vec3;
  /** Number of solid bodies (face-connected voxel clusters) analysed / skipped. */
  bodies: { analysed: number; skipped: number };
  warnings: string[];
  /** Wall-clock solve time (ms). */
  wallMs: number;
}

export type DropOrientation = 'bottom' | 'top' | 'side-x' | 'side-y' | 'corner' | 'edge';
export type DropFloor = 'concrete' | 'wood' | 'carpet';

/**
 * A lumped mass (board, component, battery, …) carried by the structure during a drop.
 *
 * Its inertial force (m·a toward the floor) is applied to the solid voxels of `support` when given —
 * e.g. the boss/standoff cylinders a PCB rests on, so the board and component inertia flows through the
 * bosses. Otherwise it is applied where the mass would press on the structure: the first solid voxel met
 * from `position` along the drop direction (nearest solid voxel if none), spread over the face-connected
 * solid voxels within max(3h, 4 mm, ½·footprint of a ≈2 g/cm³ cube of that mass) of that point.
 */
export interface DropExtraMass {
  /** Centre of mass (grid frame, mm). */
  position: Vec3;
  massGrams: number;
  componentId?: string;
  ref?: string;
  /** Optional load path (regions are resolved once per distinct object, so share one object per board). */
  support?: Region;
}

export interface DropSetup extends Omit<StructuralSetup, 'loads' | 'bodyAcceleration' | 'bodyAccelerationField' | 'fixtures'> {
  /** Drop height (m). */
  heightM: number;
  orientation: DropOrientation;
  /** Floor type (default 'concrete'). */
  floor?: DropFloor;
  extraMasses?: DropExtraMass[];
  /**
   * Correct the equivalent-static load of each region with the half-sine shock-response spectrum at its
   * local natural frequency (default true). false = classic equivalent-static (dynamic factor 1).
   */
  dynamicCorrection?: boolean;
}
