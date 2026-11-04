/**
 * Voxelisation for simulation.
 *
 * Grid convention (core VoxelGrid): cells[i + nx·(j + ny·k)] = material index (0 = empty/air),
 * materials[index − 1] = material id, origin = min corner of cell (0,0,0), cell size h (mm).
 * A cell is solid when its CENTRE is inside the geometry.
 *
 *  - voxelizeMesh(): ray casting along +Z through every column with three slightly jittered rays per
 *    column; each ray accumulates a winding number from triangle orientation (entering/exiting), the
 *    cell is solid when ≥ 2 of 3 rays report winding > 0. Robust to coincident/overlapping closed
 *    shells (union semantics), split vertices and isolated cracks.
 *  - voxelizePart() / voxelizeForStructural(): exact analytic point membership on the part's Solid IR
 *    (same polygons as the rendered mesh), no WASM needed.
 */
import type { BBox3, EffectiveMaterial, Mat4, MechPart, MeshData, Project, VoxelGrid } from '@pcbcad/core';
import { effectiveMaterial } from '@pcbcad/core';
import { mat4FromT } from './mat';
import { meshBBox, transformedArrays } from './meshutil';
import { partSolid } from './parts';
import { bbUnion, compileSolid, gridForBBox, rasterizeSolid, type GridSpec } from './solid';

const JITTER: [number, number][] = [
  [0.0131, 0.0277],
  [-0.0219, 0.0083],
  [0.0071, -0.0301],
];

/**
 * Rasterise closed triangle meshes into a 0/1 mask over `g` (optionally transformed by `m`).
 * Returns votes ≥ 2 of 3 jittered rays.
 */
export function rasterizeMesh(arrays: { positions: Float32Array; indices: Uint32Array }[], g: GridSpec, m?: Mat4): Uint8Array {
  const { nx, ny, nz, h } = g;
  const [ox, oy, oz] = g.origin;
  const nCols = nx * ny;
  const votes = new Uint8Array(nx * ny * nz);
  const tris: Float64Array[] = arrays.map(({ positions, indices }) => {
    const out = new Float64Array(Math.floor(indices.length / 3) * 9);
    for (let t = 0, o = 0; t + 2 < indices.length; t += 3) {
      for (let c = 0; c < 3; c++) {
        const v = indices[t + c] * 3;
        const x = positions[v], y = positions[v + 1], z = positions[v + 2];
        if (m) {
          out[o++] = m[0] * x + m[1] * y + m[2] * z + m[3];
          out[o++] = m[4] * x + m[5] * y + m[6] * z + m[7];
          out[o++] = m[8] * x + m[9] * y + m[10] * z + m[11];
        } else {
          out[o++] = x;
          out[o++] = y;
          out[o++] = z;
        }
      }
    }
    return out;
  });
  for (const [jx, jy] of JITTER) {
    const visit = (cb: (col: number, z: number, s: number) => void) => {
      for (const T of tris) {
        for (let o = 0; o + 8 < T.length; o += 9) {
          const x0 = T[o], y0 = T[o + 1], z0 = T[o + 2];
          const x1 = T[o + 3], y1 = T[o + 4], z1 = T[o + 5];
          const x2 = T[o + 6], y2 = T[o + 7], z2 = T[o + 8];
          const area2 = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
          if (Math.abs(area2) < 1e-14) continue;
          const sgn = area2 > 0 ? -1 : 1; // normal +Z → ray (+Z) exits
          const minx = Math.min(x0, x1, x2), maxx = Math.max(x0, x1, x2);
          const miny = Math.min(y0, y1, y2), maxy = Math.max(y0, y1, y2);
          const i0 = Math.max(0, Math.ceil((minx - ox) / h - 0.5 - jx));
          const i1 = Math.min(nx - 1, Math.floor((maxx - ox) / h - 0.5 - jx));
          const j0 = Math.max(0, Math.ceil((miny - oy) / h - 0.5 - jy));
          const j1 = Math.min(ny - 1, Math.floor((maxy - oy) / h - 0.5 - jy));
          if (i0 > i1 || j0 > j1) continue;
          const inv = 1 / area2;
          for (let j = j0; j <= j1; j++) {
            const py = oy + (j + 0.5 + jy) * h;
            for (let i = i0; i <= i1; i++) {
              const px = ox + (i + 0.5 + jx) * h;
              const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv;
              if (w0 < 0) continue;
              const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv;
              if (w1 < 0) continue;
              const w2 = 1 - w0 - w1;
              if (w2 < 0) continue;
              cb(i + nx * j, w0 * z0 + w1 * z1 + w2 * z2, sgn);
            }
          }
        }
      }
    };
    const counts = new Uint32Array(nCols + 1);
    visit((col) => counts[col + 1]++);
    for (let c = 0; c < nCols; c++) counts[c + 1] += counts[c];
    const total = counts[nCols];
    if (!total) continue;
    const zs = new Float64Array(total);
    const ss = new Int8Array(total);
    const fill = counts.slice(0, nCols);
    visit((col, z, s) => {
      const p = fill[col]++;
      zs[p] = z;
      ss[p] = s;
    });
    for (let col = 0; col < nCols; col++) {
      const a = counts[col], b = counts[col + 1];
      if (b - a < 2) continue;
      // insertion sort by z (columns hold few crossings)
      for (let p = a + 1; p < b; p++) {
        const z = zs[p], s = ss[p];
        let q = p - 1;
        while (q >= a && zs[q] > z) {
          zs[q + 1] = zs[q];
          ss[q + 1] = ss[q];
          q--;
        }
        zs[q + 1] = z;
        ss[q + 1] = s;
      }
      let wnd = 0;
      let p = a;
      for (let k = 0; k < nz; k++) {
        const zc = oz + (k + 0.5) * h;
        while (p < b && zs[p] < zc) wnd += ss[p++];
        if (wnd > 0) votes[col + nCols * k]++;
      }
    }
  }
  for (let q = 0; q < votes.length; q++) votes[q] = votes[q] >= 2 ? 1 : 0;
  return votes;
}

export interface VoxelizeMeshOptions {
  /** Empty cells added around the mesh bbox on every side (default 1). */
  padding?: number;
  /** Value written into solid cells (default 1). */
  materialIndex?: number;
  /** Material id recorded in grid.materials[materialIndex − 1] (default 'solid'). */
  materialId?: string;
}

function materialsFor(index: number, id: string): string[] {
  const m = new Array<string>(index).fill('');
  m[index - 1] = id;
  return m;
}

/** Voxelise a closed triangle mesh at cell size h (mm). */
export function voxelizeMesh(mesh: MeshData, h: number, opts: VoxelizeMeshOptions = {}): VoxelGrid {
  if (!(h > 0)) throw new Error('voxelizeMesh: h must be > 0');
  const pad = Math.max(0, Math.floor(opts.padding ?? 1));
  const mi = Math.max(1, Math.min(255, Math.floor(opts.materialIndex ?? 1)));
  const b = meshBBox(mesh, true);
  const g = gridForBBox(b, h, pad);
  const mask = rasterizeMesh(transformedArrays(mesh), g);
  const cells = new Uint8Array(mask.length);
  for (let q = 0; q < mask.length; q++) if (mask[q]) cells[q] = mi;
  return { ...g, cells, materials: materialsFor(mi, opts.materialId ?? 'solid') };
}

/** Voxelise a mechanical part in its local frame (material index 1 = part.materialId). */
export async function voxelizePart(part: MechPart, h: number, opts: { padding?: number; project?: Project } = {}): Promise<VoxelGrid> {
  if (!(h > 0)) throw new Error('voxelizePart: h must be > 0');
  const node = compileSolid(partSolid(part, { project: opts.project }) ?? { kind: 'union', children: [] });
  if (!node) return { nx: 1, ny: 1, nz: 1, h, origin: [0, 0, 0], cells: new Uint8Array(1), materials: [part.materialId] };
  const g = gridForBBox(node.bb, h, Math.max(0, Math.floor(opts.padding ?? 1)));
  const mask = rasterizeSolid(node, g);
  return { ...g, cells: mask, materials: [part.materialId] };
}

/** Key for de-duplicating effective materials. */
export function materialKey(materialId: string, process: string, options?: Record<string, unknown>): string {
  return `${materialId}|${process}|${JSON.stringify(options ?? {})}`;
}

/**
 * Voxel model for structural / drop simulation of one part (local frame) or several parts placed by
 * their assembly instances (all instances of each listed part). grid.tags/tagNames identify the
 * instance (or part) each solid cell belongs to; materials[i] describes cell value i + 1.
 */
export async function voxelizeForStructural(project: Project, partIds: string[], h: number): Promise<{ grid: VoxelGrid; materials: EffectiveMaterial[]; warnings: string[] }> {
  if (!(h > 0)) throw new Error('voxelizeForStructural: h must be > 0');
  const warnings: string[] = [];
  const placements: { part: MechPart; m?: Mat4; tag: string }[] = [];
  for (const id of partIds) {
    const part = project.mechanical.find((p) => p.id === id);
    if (!part) throw new Error(`voxelizeForStructural: unknown mechanical part '${id}'`);
    if (partIds.length === 1) {
      placements.push({ part, tag: part.name ?? part.id });
      continue;
    }
    const insts = project.assembly.instances.filter((i) => i.target.kind === 'mech' && i.target.partId === id);
    if (!insts.length) {
      warnings.push(`Part '${part.name}' has no assembly instance — placed at the origin`);
      placements.push({ part, tag: part.name ?? part.id });
    } else for (const inst of insts) placements.push({ part, m: mat4FromT(inst.transform), tag: inst.name || inst.id });
  }
  const compiled = placements.map((p) => ({ ...p, node: compileSolid(partSolid(p.part, { project }) ?? { kind: 'union', children: [] }, p.m) }));
  const bbs = compiled.filter((c) => c.node).map((c) => c.node!.bb);
  const bb: BBox3 = bbs.length ? bbUnion(bbs) : { min: [0, 0, 0], max: [h, h, h] };
  const g = gridForBBox(bb, h, 1);
  const cells = new Uint8Array(g.nx * g.ny * g.nz);
  const tags = new Uint16Array(cells.length);
  const tagNames: string[] = [];
  const ids: string[] = [];
  const mats: EffectiveMaterial[] = [];
  const index = new Map<string, number>();
  for (const c of compiled) {
    if (!c.node) {
      warnings.push(`Part '${c.part.name}' has no solid geometry`);
      continue;
    }
    const key = materialKey(c.part.materialId, c.part.process, c.part.processOptions);
    let mi = index.get(key);
    if (mi === undefined) {
      mats.push(effectiveMaterial(c.part.materialId, c.part.process, c.part.processOptions ?? {}));
      ids.push(c.part.materialId);
      mi = mats.length;
      index.set(key, mi);
    }
    tagNames.push(c.tag);
    const tag = tagNames.length;
    const mask = rasterizeSolid(c.node, g);
    let overlap = 0;
    for (let q = 0; q < mask.length; q++) {
      if (!mask[q]) continue;
      if (cells[q]) overlap++;
      cells[q] = mi;
      tags[q] = tag;
    }
    if (overlap) warnings.push(`'${c.tag}' overlaps previously voxelised parts in ${overlap} cells (${(overlap * h ** 3).toFixed(1)} mm³)`);
  }
  if (mats.length > 255) throw new Error('voxelizeForStructural: more than 255 distinct materials');
  return { grid: { ...g, cells, materials: ids, tags, tagNames }, materials: mats, warnings };
}
