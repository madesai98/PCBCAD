/**
 * @pcbcad/mech — parametric mechanical geometry for PCBCAD.
 *
 * Injection-molded enclosure shells, sheet-metal parts (3D + flat patterns + DXF), custom CSG parts,
 * purchased envelopes/fans and fasteners; mass properties; STL/3MF export; voxelisation for
 * structural and airflow simulation; DFM (molding, sheet metal) and assembly checks; automatic
 * enclosure design around boards; rough cost models.
 *
 * Geometry runs in Node and the browser. Meshes use manifold-3d (WASM, loaded lazily by
 * initGeometry()/buildPartMesh()); everything else (flat patterns, DFM, voxels, assembly checks,
 * autoEnclosure, cost) is pure JS on the shared Solid IR. See README.md for frames and conventions.
 */
export { initGeometry, geometryReady } from './wasm';
export { buildPartMesh, buildPartMeshes, partSolid, partStyle, type PartContext } from './parts';
export { fastenerMesh, fastenerDims, fastenerPlacement, clearanceHole, insertTable, pilotHole, type FastenerDims } from './fastener';
export {
  flatPattern,
  buildSheetModel,
  sheetSolid,
  bendAllowance,
  bendDeduction,
  outsideSetback,
  type FlatPattern,
  type SheetModel,
  type SheetFaceModel,
  type SheetBendModel,
  type SheetIssue,
} from './sheet';
export { exportStl, export3mf, exportDxf, zipStore, crc32, type DxfOptions } from './export';
export { massProperties, type MassProperties } from './massprops';
export { voxelizeMesh, voxelizePart, voxelizeForStructural, rasterizeMesh, type VoxelizeMeshOptions } from './voxel';
export { voxelizeAssemblyForAirflow, type AirflowDomain, type AirflowOpening, type AirflowOptions } from './airflow';
export { checkMoldability, textureDepthMm, requiredDraftDeg, allowableSnapStrain, snapStrain } from './dfm-mold';
export { checkSheetMetal, pemLookup } from './dfm-sheet';
export { checkAssembly, type AssemblyCheckOptions } from './assembly';
export { autoEnclosure, type AutoEnclosureOptions, type AutoEnclosureResult } from './auto-enclosure';
export { estimateCost, type CostEstimate } from './cost';
export {
  shellSolid,
  shellGeom,
  validateShell,
  pocketAt,
  outerAt,
  faceFrame,
  cutoutProfile,
  cutoutExtents,
  ventSlots,
  ventExtents,
  bossGeom,
  counterboreFor,
  snapHookHeight,
  type ShellGeom,
  type FaceFrame,
  type BossGeom,
} from './shell';
export { csgToSolid } from './csg';
export { purchasedSolid, fanGeom } from './purchased';
export {
  compileSolid,
  rasterizeSolid,
  solidContains,
  solidBBox,
  solidToManifold,
  estimateSolidVolume,
  gridForBBox,
  prism,
  union,
  difference,
  intersection,
  placed,
  type Solid,
  type GridSpec,
} from './solid';
export { worldItems, componentBodyBox, componentMatrix, boardSlabSolid, type WorldItem, type WorldComponent } from './world';
export { meshArrays, meshBBox, makeMesh, triangleCount } from './meshutil';
