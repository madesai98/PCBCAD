/**
 * MeshData helpers: conversion from manifold meshes, decoding of NumArray/PackedArray groups,
 * bounding boxes, transforms.
 */
import type { BBox3, Mat4, MeshData, MeshGroup, Vec3 } from '@pcbcad/core';
import { pack, toFloat32, toUint32 } from '@pcbcad/core';
import type { Manifold } from 'manifold-3d';

export interface MeshArrays {
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
  group: MeshGroup;
}

/** Decode every group to typed arrays (triangle soups get sequential indices). */
export function meshArrays(mesh: MeshData): MeshArrays[] {
  return (mesh.groups ?? []).map((g) => {
    const positions = toFloat32(g.positions);
    let indices = g.indices ? toUint32(g.indices) : null;
    if (!indices || indices.length === 0) {
      const n = Math.floor(positions.length / 3);
      indices = new Uint32Array(n - (n % 3));
      for (let i = 0; i < indices.length; i++) indices[i] = i;
    }
    const normals = g.normals ? toFloat32(g.normals) : undefined;
    return { positions, indices, normals, group: g };
  });
}

export function bboxOfPositions(p: Float32Array | number[], into?: BBox3): BBox3 {
  const b: BBox3 = into ?? { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < b.min[k]) b.min[k] = v;
      if (v > b.max[k]) b.max[k] = v;
    }
  }
  return b;
}

/** Bounding box of all groups (uses mesh.bbox when present unless `recompute`). */
export function meshBBox(mesh: MeshData, recompute = false): BBox3 {
  if (mesh.bbox && !recompute) return { min: [...mesh.bbox.min] as Vec3, max: [...mesh.bbox.max] as Vec3 };
  const b: BBox3 = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const a of meshArrays(mesh)) bboxOfPositions(a.positions, b);
  if (!Number.isFinite(b.min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return b;
}

export interface GroupStyle {
  name?: string;
  color: string;
  metal?: boolean;
  opacity?: number;
}

/** Build a single-group MeshData from typed arrays (positions/indices packed as f32/u32). */
export function makeMesh(positions: Float32Array, indices: Uint32Array, style: GroupStyle, normals?: Float32Array): MeshData {
  const group: MeshGroup = {
    name: style.name,
    color: style.color,
    positions: pack(positions, 'f32'),
    indices: pack(indices, 'u32'),
  };
  if (style.metal) group.metal = true;
  if (style.opacity != null) group.opacity = style.opacity;
  if (normals) group.normals = pack(normals, 'f32');
  const bbox = bboxOfPositions(positions);
  return { groups: [group], bbox: Number.isFinite(bbox.min[0]) ? bbox : { min: [0, 0, 0], max: [0, 0, 0] } };
}

/**
 * Convert a manifold to MeshData. With `normals` (default) vertices are split along edges sharper
 * than `creaseDeg` and per-vertex normals are attached so renderers shade flat faces flat.
 */
export function manifoldToMesh(man: Manifold | null, style: GroupStyle, normals = true, creaseDeg = 35): MeshData {
  if (!man || man.isEmpty()) return makeMesh(new Float32Array(0), new Uint32Array(0), style);
  let src = man;
  let tmp: Manifold | null = null;
  if (normals) {
    tmp = man.calculateNormals(0, creaseDeg);
    src = tmp;
  }
  try {
    const mesh = src.getMesh();
    const np = mesh.numProp;
    const nv = mesh.vertProperties.length / np;
    const pos = new Float32Array(nv * 3);
    const nrm = normals && np >= 6 ? new Float32Array(nv * 3) : undefined;
    for (let v = 0; v < nv; v++) {
      pos[v * 3] = mesh.vertProperties[v * np];
      pos[v * 3 + 1] = mesh.vertProperties[v * np + 1];
      pos[v * 3 + 2] = mesh.vertProperties[v * np + 2];
      if (nrm) {
        nrm[v * 3] = mesh.vertProperties[v * np + 3];
        nrm[v * 3 + 1] = mesh.vertProperties[v * np + 4];
        nrm[v * 3 + 2] = mesh.vertProperties[v * np + 5];
      }
    }
    return makeMesh(pos, new Uint32Array(mesh.triVerts), style, nrm);
  } finally {
    tmp?.delete();
  }
}

/** Apply a (row-major) transform to every group; returns plain typed arrays (not packed). */
export function transformedArrays(mesh: MeshData, m?: Mat4): { positions: Float32Array; indices: Uint32Array }[] {
  return meshArrays(mesh).map((a) => {
    if (!m) return { positions: a.positions, indices: a.indices };
    const p = new Float32Array(a.positions.length);
    for (let i = 0; i < p.length; i += 3) {
      const x = a.positions[i], y = a.positions[i + 1], z = a.positions[i + 2];
      p[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
      p[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
      p[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
    }
    return { positions: p, indices: a.indices };
  });
}

/** Total triangle count over all groups. */
export function triangleCount(mesh: MeshData): number {
  return meshArrays(mesh).reduce((n, a) => n + Math.floor(a.indices.length / 3), 0);
}
