/**
 * Part-level entry points: MechPart → Solid IR → manifold mesh.
 */
import type { FastenerSpec, MechPart, MeshData, Project } from '@pcbcad/core';
import { getMaterial } from '@pcbcad/core';
import { csgToSolid } from './csg';
import { manifoldToMesh, type GroupStyle } from './meshutil';
import { purchasedSolid } from './purchased';
import { buildSheetModel, sheetSolid } from './sheet';
import { shellSolid } from './shell';
import { solidToManifold, type Solid } from './solid';
import { Arena, getWasm, initGeometry } from './wasm';

export interface PartContext {
  /** Used to resolve fastener specs (boss counterbores) from Project.parts. */
  project?: Project;
}

export function fastenerResolver(project?: Project): (id: string) => FastenerSpec | undefined {
  return (id: string) => project?.parts?.[id]?.fastener;
}

/** Solid IR of any mechanical part in its local frame. Throws on invalid base geometry. */
export function partSolid(part: MechPart, ctx: PartContext = {}): Solid | null {
  switch (part.kind) {
    case 'enclosure-shell':
      return shellSolid(part, { fastener: fastenerResolver(ctx.project) });
    case 'sheet-metal':
      return sheetSolid(buildSheetModel(part));
    case 'custom':
      return csgToSolid(part.csg, `part '${part.name ?? part.id}'.csg`);
    case 'purchased':
      return purchasedSolid(part, true);
    default:
      throw new Error(`Unknown mechanical part kind '${(part as { kind?: string }).kind}'`);
  }
}

/** Render style: part.color, else the material colour; metals flagged for PBR. */
export function partStyle(part: MechPart): GroupStyle {
  const mat = getMaterial(part.materialId);
  return { name: part.name ?? part.id, color: part.color ?? mat?.color ?? '#9aa0a6', metal: mat?.family === 'metal' || undefined };
}

/**
 * Build the render/analysis mesh of a part (single group, packed f32 positions + u32 indices +
 * crease-split normals, bbox). Initialises the geometry kernel on first use.
 */
export async function buildPartMesh(part: MechPart, ctx: PartContext = {}): Promise<MeshData> {
  await initGeometry();
  const solid = partSolid(part, ctx);
  const w = getWasm();
  const arena = new Arena();
  try {
    const man = solid ? solidToManifold(solid, w, arena) : null;
    if (man) {
      const st = man.status();
      if (st !== 'NoError') throw new Error(`Geometry kernel error for part '${part.name ?? part.id}': ${st}`);
    }
    return manifoldToMesh(man, partStyle(part));
  } finally {
    arena.dispose();
  }
}

/** Meshes for every mechanical part of a project, keyed by part id (failures are skipped and reported). */
export async function buildPartMeshes(project: Project): Promise<{ meshes: Map<string, MeshData>; errors: { partId: string; error: string }[] }> {
  const meshes = new Map<string, MeshData>();
  const errors: { partId: string; error: string }[] = [];
  for (const p of project.mechanical ?? []) {
    try {
      meshes.set(p.id, await buildPartMesh(p, { project }));
    } catch (e) {
      errors.push({ partId: p.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { meshes, errors };
}
