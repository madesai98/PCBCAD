/**
 * Voxel structural FEA and drop/impact screening.
 * See README.md in this folder for methods, assumptions and accuracy limits.
 */
export { solveStructural, analyzeStructure, buildStructuralResult, SAFETY_FACTOR_CAP } from './structural';
export type { StructuralAnalysis } from './structural';
export { solveDrop, dropDirection, FLOOR_STIFFNESS } from './drop';
export type { DropResultDetail } from './drop';
export { resolveRegion as resolveVoxelRegion, describeRegion as describeVoxelRegion } from './regions';
export type {
  Region,
  StructuralLoad,
  StructuralSetup,
  StructuralMeta,
  StructuralResultDetail,
  DropSetup,
  DropExtraMass,
  DropOrientation,
  DropFloor,
} from './types';
