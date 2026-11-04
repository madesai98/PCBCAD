import * as THREE from 'three';
import type { AirflowResult, StructuralResult, Vec3 } from '@pcbcad/core';
import { toFloat32, toUint32, toUint8 } from '@pcbcad/core';
import { colormapLUT, turbo } from '../common/colormaps';

const LIGHT = new THREE.Vector3(0.38, -0.52, 0.76).normalize();

/** Baked diffuse shading so colormap hues stay true (no tone mapping / scene lights involved). */
function shade(n: THREE.Vector3, rgb: [number, number, number]): [number, number, number] {
  const k = 0.58 + 0.42 * Math.max(0, n.dot(LIGHT)) + (n.z > 0 ? 0.06 : 0);
  return [Math.min(1, rgb[0] * k), Math.min(1, rgb[1] * k), Math.min(1, rgb[2] * k)];
}

/* -------------------------------------------- structural ----------------------------------------- */

export interface StructuralOverlay {
  group: THREE.Group;
  box: THREE.Box3;
  maxAt: THREE.Vector3;
  min: number;
  max: number;
  dispose(): void;
}

const FACES: { n: [number, number, number]; base: [number, number, number]; u: [number, number, number]; v: [number, number, number] }[] = [
  { n: [1, 0, 0], base: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [-1, 0, 0], base: [0, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], base: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
  { n: [0, -1, 0], base: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], base: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], base: [0, 0, 0], u: [0, 1, 0], v: [1, 0, 0] },
];

/** Exposed voxel faces (solid next to empty) coloured by von Mises stress (turbo). */
export function buildStructuralOverlay(res: StructuralResult): StructuralOverlay | null {
  const { nx, ny, nz, h, origin } = res.grid;
  const N = nx * ny * nz;
  if (!(N > 0)) return null;
  const solid = toUint32(res.solid);
  const vm = toFloat32(res.vonMises);
  const occ = new Int32Array(N).fill(-1);
  for (let s = 0; s < solid.length; s++) if (solid[s] < N) occ[solid[s]] = s;
  let max = res.maxVonMises > 0 ? res.maxVonMises : 0;
  if (!max) for (let s = 0; s < vm.length; s++) max = Math.max(max, vm[s]);
  if (!(max > 0)) max = 1;
  const neighbor = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? -1 : occ[i + nx * (j + ny * k)]);
  // Count faces.
  let faces = 0;
  for (let s = 0; s < solid.length; s++) {
    const idx = solid[s];
    const i = idx % nx;
    const j = Math.floor(idx / nx) % ny;
    const k = Math.floor(idx / (nx * ny));
    for (const f of FACES) if (neighbor(i + f.n[0], j + f.n[1], k + f.n[2]) < 0) faces++;
  }
  const pos = new Float32Array(faces * 12);
  const col = new Float32Array(faces * 12);
  const index = new Uint32Array(faces * 6);
  const lut = colormapLUT('turbo', 256);
  const tmpN = new THREE.Vector3();
  const lin = new THREE.Color();
  let fi = 0;
  let maxIdx = 0;
  for (let s = 0; s < solid.length; s++) {
    const idx = solid[s];
    const i = idx % nx;
    const j = Math.floor(idx / nx) % ny;
    const k = Math.floor(idx / (nx * ny));
    const v = vm[s] ?? 0;
    if (v > (vm[maxIdx] ?? 0)) maxIdx = s;
    const li = Math.max(0, Math.min(255, Math.round((v / max) * 255)));
    const base: [number, number, number] = [lut[li * 3] / 255, lut[li * 3 + 1] / 255, lut[li * 3 + 2] / 255];
    for (const f of FACES) {
      if (neighbor(i + f.n[0], j + f.n[1], k + f.n[2]) >= 0) continue;
      tmpN.set(f.n[0], f.n[1], f.n[2]);
      const c = shade(tmpN, base);
      lin.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
      const bx = origin[0] + (i + f.base[0]) * h;
      const by = origin[1] + (j + f.base[1]) * h;
      const bz = origin[2] + (k + f.base[2]) * h;
      const corners = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      for (let q = 0; q < 4; q++) {
        const [a, b] = corners[q];
        const o = (fi * 4 + q) * 3;
        pos[o] = bx + (f.u[0] * a + f.v[0] * b) * h;
        pos[o + 1] = by + (f.u[1] * a + f.v[1] * b) * h;
        pos[o + 2] = bz + (f.u[2] * a + f.v[2] * b) * h;
        col[o] = lin.r;
        col[o + 1] = lin.g;
        col[o + 2] = lin.b;
      }
      const io = fi * 6;
      const vb = fi * 4;
      index[io] = vb;
      index[io + 1] = vb + 1;
      index[io + 2] = vb + 2;
      index[io + 3] = vb;
      index[io + 4] = vb + 2;
      index[io + 5] = vb + 3;
      fi++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'structural';
  const group = new THREE.Group();
  group.add(mesh);
  // Max marker: white ring + core at the max-stress location.
  const at: Vec3 =
    res.maxStressAt && res.maxStressAt.length === 3
      ? res.maxStressAt
      : (() => {
          const idx = solid[maxIdx] ?? 0;
          return [origin[0] + ((idx % nx) + 0.5) * h, origin[1] + ((Math.floor(idx / nx) % ny) + 0.5) * h, origin[2] + (Math.floor(idx / (nx * ny)) + 0.5) * h];
        })();
  const maxAt = new THREE.Vector3(at[0], at[1], at[2]);
  const r = Math.max(0.6, h * 0.9);
  const core = new THREE.Mesh(new THREE.SphereGeometry(r * 0.45, 20, 12), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, depthTest: false, transparent: true }));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.25, r * 0.16, 10, 40), new THREE.MeshBasicMaterial({ color: '#ff3b30', toneMapped: false, depthTest: false, transparent: true }));
  core.position.copy(maxAt);
  ring.position.copy(maxAt);
  core.renderOrder = 10;
  ring.renderOrder = 10;
  ring.userData.billboard = true;
  group.add(core, ring);
  return {
    group,
    box: geo.boundingBox!.clone(),
    maxAt,
    min: 0,
    max,
    dispose() {
      geo.dispose();
      mat.dispose();
      core.geometry.dispose();
      (core.material as THREE.Material).dispose();
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
    },
  };
}

/* --------------------------------------------- airflow ------------------------------------------- */

export interface AirflowOverlay {
  group: THREE.Group;
  box: THREE.Box3;
  tMin: number;
  tMax: number;
  vMax: number;
  nz: number;
  setSlice(frac: number): number;
  dispose(): void;
}

export function buildAirflowOverlay(res: AirflowResult): AirflowOverlay | null {
  const { nx, ny, nz, h, origin } = res.grid;
  const N = nx * ny * nz;
  if (!(N > 0)) return null;
  const temp = toFloat32(res.temperature);
  const cells = toUint8(res.cells);
  const vel = toFloat32(res.velocity);
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let i = 0; i < Math.min(N, temp.length); i++) {
    const t = temp[i];
    if (!Number.isFinite(t)) continue;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  if (!Number.isFinite(tMin)) {
    tMin = res.ambient;
    tMax = res.ambient + 1;
  }
  if (tMax - tMin < 0.1) tMax = tMin + 0.1;
  let vMax = 0;
  for (let i = 0; i + 2 < vel.length; i += 3) vMax = Math.max(vMax, Math.hypot(vel[i], vel[i + 1], vel[i + 2]));
  if (!(vMax > 0)) vMax = 1;

  const group = new THREE.Group();
  group.name = 'airflow';
  // Temperature slice (bilinear DataTexture), movable along z.
  const data = new Uint8Array(nx * ny * 4);
  const tex = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const sliceMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, toneMapped: false, depthWrite: false });
  const sliceGeo = new THREE.PlaneGeometry(nx * h, ny * h);
  const slice = new THREE.Mesh(sliceGeo, sliceMat);
  slice.position.set(origin[0] + (nx * h) / 2, origin[1] + (ny * h) / 2, origin[2]);
  slice.renderOrder = 5;
  const frame = new THREE.LineSegments(new THREE.EdgesGeometry(sliceGeo), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, toneMapped: false }));
  slice.add(frame);
  group.add(slice);
  const lut = colormapLUT('turbo', 256);
  const setSlice = (frac: number) => {
    const k = Math.max(0, Math.min(nz - 1, Math.round(frac * (nz - 1))));
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        const t = temp[c];
        const li = Math.max(0, Math.min(255, Math.round(((t - tMin) / (tMax - tMin)) * 255)));
        const o = (j * nx + i) * 4;
        const isSolid = cells[c] > 0;
        data[o] = lut[li * 3];
        data[o + 1] = lut[li * 3 + 1];
        data[o + 2] = lut[li * 3 + 2];
        data[o + 3] = isSolid ? 120 : 215;
      }
    tex.needsUpdate = true;
    slice.position.z = origin[2] + (k + 0.5) * h;
    return slice.position.z;
  };
  setSlice(0.5);

  // Streamlines as tubes coloured by local speed.
  const speedAt = (p: Vec3) => {
    const i = Math.floor((p[0] - origin[0]) / h);
    const j = Math.floor((p[1] - origin[1]) / h);
    const k = Math.floor((p[2] - origin[2]) / h);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 0;
    const c = (i + nx * (j + ny * k)) * 3;
    return Math.hypot(vel[c] ?? 0, vel[c + 1] ?? 0, vel[c + 2] ?? 0);
  };
  const radius = Math.max(0.22, h * 0.09);
  const RS = 6;
  const lines = res.streamlines.filter((l) => l.length >= 2);
  let vertCount = 0;
  let idxCount = 0;
  for (const l of lines) {
    vertCount += l.length * RS;
    idxCount += (l.length - 1) * RS * 6;
  }
  let tubes: THREE.Mesh | null = null;
  if (vertCount) {
    const pos = new Float32Array(vertCount * 3);
    const col = new Float32Array(vertCount * 3);
    const idx = new Uint32Array(idxCount);
    let vo = 0;
    let io = 0;
    const T = new THREE.Vector3();
    const Nrm = new THREE.Vector3();
    const B = new THREE.Vector3();
    const P = new THREE.Vector3();
    const prevT = new THREE.Vector3();
    const dirV = new THREE.Vector3();
    const lin = new THREE.Color();
    for (const l of lines) {
      const base = vo;
      for (let p = 0; p < l.length; p++) {
        const a = l[Math.max(0, p - 1)];
        const b = l[Math.min(l.length - 1, p + 1)];
        T.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
        if (p === 0) {
          Nrm.set(0, 0, 1);
          if (Math.abs(T.dot(Nrm)) > 0.9) Nrm.set(1, 0, 0);
          Nrm.sub(T.clone().multiplyScalar(T.dot(Nrm))).normalize();
        } else {
          // Parallel transport of the frame.
          const axis = new THREE.Vector3().crossVectors(prevT, T);
          const s = axis.length();
          if (s > 1e-6) Nrm.applyAxisAngle(axis.normalize(), Math.asin(Math.min(1, s)));
          Nrm.sub(T.clone().multiplyScalar(T.dot(Nrm))).normalize();
        }
        prevT.copy(T);
        B.crossVectors(T, Nrm);
        const sp = speedAt(l[p]) / vMax;
        const rgb = turbo(0.12 + 0.88 * sp);
        for (let r = 0; r < RS; r++) {
          const ang = (r / RS) * Math.PI * 2;
          dirV.copy(Nrm).multiplyScalar(Math.cos(ang)).addScaledVector(B, Math.sin(ang));
          P.set(l[p][0], l[p][1], l[p][2]).addScaledVector(dirV, radius);
          const o = vo * 3;
          pos[o] = P.x;
          pos[o + 1] = P.y;
          pos[o + 2] = P.z;
          const c = shade(dirV, rgb);
          lin.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
          col[o] = lin.r;
          col[o + 1] = lin.g;
          col[o + 2] = lin.b;
          vo++;
        }
      }
      for (let p = 0; p + 1 < l.length; p++)
        for (let r = 0; r < RS; r++) {
          const a = base + p * RS + r;
          const b2 = base + p * RS + ((r + 1) % RS);
          const c = a + RS;
          const d = b2 + RS;
          idx[io++] = a;
          idx[io++] = c;
          idx[io++] = b2;
          idx[io++] = b2;
          idx[io++] = c;
          idx[io++] = d;
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    tubes = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
    tubes.name = 'streamlines';
    group.add(tubes);
  }
  const box = new THREE.Box3(new THREE.Vector3(origin[0], origin[1], origin[2]), new THREE.Vector3(origin[0] + nx * h, origin[1] + ny * h, origin[2] + nz * h));
  return {
    group,
    box,
    tMin,
    tMax,
    vMax,
    nz,
    setSlice,
    dispose() {
      tex.dispose();
      sliceMat.dispose();
      sliceGeo.dispose();
      frame.geometry.dispose();
      (frame.material as THREE.Material).dispose();
      if (tubes) {
        tubes.geometry.dispose();
        (tubes.material as THREE.Material).dispose();
      }
    },
  };
}
