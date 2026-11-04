import type { MeshData, MeshGroup, Vec3 } from '@pcbcad/core';
import { pack } from '@pcbcad/core';
import type { EasyEdaModelPlacement } from '../types';
import { rnd } from '../util/num';

/* --------------------------------------------------------------------------------------------- *
 * EasyEDA OBJ models: plain Wavefront OBJ (mm, Y-up footprint orientation, Z up) with inline
 * `newmtl … endmtl` material blocks. In these blocks `d` is a TRANSPARENCY (0 = opaque), as in
 * VRML — not the OBJ dissolve factor.
 * --------------------------------------------------------------------------------------------- */

interface Mtl {
  kd: [number, number, number];
  ks: [number, number, number];
  d: number;
}

function hex(c: [number, number, number]): string {
  const h = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

function rgb(parts: string[]): [number, number, number] | undefined {
  const v = parts.slice(1, 4).map((t) => parseFloat(t));
  if (v.length < 3 || v.some((n) => !Number.isFinite(n))) return undefined;
  return [v[0], v[1], v[2]];
}

/** Rotation matrix R = Rz·Ry·Rx for angles in degrees (X applied first, CCW positive). */
export function rotationMatrix(rot: Vec3): number[] {
  const [ax, ay, az] = rot.map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(ax);
  const sx = Math.sin(ax);
  const cy = Math.cos(ay);
  const sy = Math.sin(ay);
  const cz = Math.cos(az);
  const sz = Math.sin(az);
  // Rz * Ry * Rx (row-major 3x3)
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, -sy, cy * sx, cy * cx];
}

/**
 * Parse an EasyEDA OBJ model into MeshData: one group per material colour (positions as packed f32
 * xyz, indices as packed u16/u32), mm.
 *
 * With `placement`, EasyEDA placement semantics are applied so the mesh sits on the footprint:
 * rotate (extrinsic X→Y→Z, degrees CCW) → centre the XY bounding box on the origin and put the
 * lowest point at z = 0 → translate by `offset` (offset[2] = height of the lowest point, negative
 * for through-hole pins). Without `placement` the raw OBJ coordinates are kept.
 */
export function parseEasyEdaObj(text: string, placement?: EasyEdaModelPlacement): MeshData {
  const verts: number[] = [];
  const mtls = new Map<string, Mtl>();
  const faces = new Map<string, number[]>();
  let cur = '__default__';
  let mtlName: string | undefined;
  let mtl: Mtl | undefined;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v') {
      const x = parseFloat(parts[1]);
      const y = parseFloat(parts[2]);
      const z = parseFloat(parts[3]);
      verts.push(Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, Number.isFinite(z) ? z : 0);
    } else if (tag === 'f') {
      const idx: number[] = [];
      const nv = verts.length / 3;
      for (let i = 1; i < parts.length; i++) {
        const v = parseInt(parts[i].split('/')[0], 10);
        if (!Number.isFinite(v) || v === 0) continue;
        const k = v > 0 ? v - 1 : nv + v;
        if (k >= 0) idx.push(k);
      }
      if (idx.length < 3) continue;
      let list = faces.get(cur);
      if (!list) {
        list = [];
        faces.set(cur, list);
      }
      for (let i = 1; i + 1 < idx.length; i++) list.push(idx[0], idx[i], idx[i + 1]);
    } else if (tag === 'usemtl') {
      cur = parts.slice(1).join(' ') || '__default__';
    } else if (tag === 'newmtl') {
      mtlName = parts.slice(1).join(' ');
      mtl = { kd: [0.5, 0.5, 0.5], ks: [0, 0, 0], d: 0 };
      mtls.set(mtlName, mtl);
    } else if (tag === 'endmtl') {
      mtlName = undefined;
      mtl = undefined;
    } else if (mtl && mtlName !== undefined) {
      if (tag === 'Kd') mtl.kd = rgb(parts) ?? mtl.kd;
      else if (tag === 'Ks') mtl.ks = rgb(parts) ?? mtl.ks;
      else if (tag === 'd') {
        const d = parseFloat(parts[1]);
        if (Number.isFinite(d)) mtl.d = d;
      } else if (tag === 'Tr') {
        const t = parseFloat(parts[1]);
        if (Number.isFinite(t)) mtl.d = t;
      }
    }
  }
  const nv = verts.length / 3;
  // validate indices
  for (const [k, list] of faces) {
    const ok = list.every((i) => i >= 0 && i < nv);
    if (!ok) {
      const clean: number[] = [];
      for (let i = 0; i + 2 < list.length; i += 3) if (list[i] < nv && list[i + 1] < nv && list[i + 2] < nv) clean.push(list[i], list[i + 1], list[i + 2]);
      faces.set(k, clean);
    }
  }
  const pos = new Float64Array(verts);
  if (placement) applyPlacement(pos, faces, placement);
  // group by appearance
  const groups = new Map<string, { color: string; opacity: number; metal: boolean; name: string; tris: number[] }>();
  for (const [name, list] of faces) {
    if (!list.length) continue;
    const m = mtls.get(name);
    const color = m ? hex(m.kd) : '#9a9a9a';
    const opacity = m ? Math.max(0.1, Math.min(1, 1 - m.d)) : 1;
    const kdAvg = m ? (m.kd[0] + m.kd[1] + m.kd[2]) / 3 : 0.5;
    const ksAvg = m ? (m.ks[0] + m.ks[1] + m.ks[2]) / 3 : 0;
    const metal = ksAvg >= 0.35 && ksAvg >= 0.4 * kdAvg;
    const key = `${color}|${rnd(opacity, 2)}|${metal}`;
    const g = groups.get(key);
    if (g) g.tris.push(...list);
    else groups.set(key, { color, opacity, metal, name, tris: [...list] });
  }
  const out: MeshGroup[] = [];
  const bmin: Vec3 = [Infinity, Infinity, Infinity];
  const bmax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const g of groups.values()) {
    const remap = new Map<number, number>();
    const p: number[] = [];
    const ind = new Array<number>(g.tris.length);
    for (let i = 0; i < g.tris.length; i++) {
      const v = g.tris[i];
      let k = remap.get(v);
      if (k === undefined) {
        k = remap.size;
        remap.set(v, k);
        for (let c = 0; c < 3; c++) {
          const val = pos[v * 3 + c];
          p.push(val);
          if (val < bmin[c]) bmin[c] = val;
          if (val > bmax[c]) bmax[c] = val;
        }
      }
      ind[i] = k;
    }
    const group: MeshGroup = {
      name: g.name,
      color: g.color,
      positions: pack(new Float32Array(p)),
      indices: pack(remap.size <= 65535 ? new Uint16Array(ind) : new Uint32Array(ind)),
    };
    if (g.opacity < 0.999) group.opacity = rnd(g.opacity, 3);
    if (g.metal) group.metal = true;
    out.push(group);
  }
  const mesh: MeshData = { groups: out };
  if (Number.isFinite(bmin[0])) mesh.bbox = { min: bmin.map((v) => rnd(v, 4)) as Vec3, max: bmax.map((v) => rnd(v, 4)) as Vec3 };
  return mesh;
}

function applyPlacement(pos: Float64Array, faces: Map<string, number[]>, placement: EasyEdaModelPlacement): void {
  const rot = placement.rotation ?? [0, 0, 0];
  const off = placement.offset ?? [0, 0, 0];
  const n = pos.length / 3;
  if (rot.some((r) => Math.abs(r) > 1e-9)) {
    const m = rotationMatrix(rot);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      pos[i * 3] = m[0] * x + m[1] * y + m[2] * z;
      pos[i * 3 + 1] = m[3] * x + m[4] * y + m[5] * z;
      pos[i * 3 + 2] = m[6] * x + m[7] * y + m[8] * z;
    }
  }
  // bounding box of referenced vertices
  const used = new Uint8Array(n);
  for (const list of faces.values()) for (const i of list) used[i] = 1;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    if (!used[i]) continue;
    for (let c = 0; c < 3; c++) {
      const v = pos[i * 3 + c];
      if (v < lo[c]) lo[c] = v;
      if (v > hi[c]) hi[c] = v;
    }
  }
  if (!Number.isFinite(lo[0])) return;
  const tx = off[0] - (lo[0] + hi[0]) / 2;
  const ty = off[1] - (lo[1] + hi[1]) / 2;
  const tz = off[2] - lo[2];
  for (let i = 0; i < n; i++) {
    pos[i * 3] += tx;
    pos[i * 3 + 1] += ty;
    pos[i * 3 + 2] += tz;
  }
}
