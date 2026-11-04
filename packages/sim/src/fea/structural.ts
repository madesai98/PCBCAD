import { pack } from '@pcbcad/core';
import type { EffectiveMaterial, Vec3, VoxelGridSpec } from '@pcbcad/core';
import { STRESS_POINTS, hexElement, vonMises } from './element';
import { ElasticMultigrid, solvePcg } from './mg';
import { describeRegion, resolveRegion } from './regions';
import type { RegionGrid, ResolvedRegion } from './regions';
import type { StructuralMeta, StructuralResultDetail, StructuralSetup } from './types';

/** Safety factors are capped at this value (unloaded / near-zero-stress models). */
export const SAFETY_FACTOR_CAP = 1000;

/** Internal per-body solution, kept for post-processing. */
interface BodySolution {
  i0: number;
  j0: number;
  k0: number;
  NX: number;
  NY: number;
  NZ: number;
  /** Local grid node → node id (−1 unused). */
  nodeMap: Int32Array;
  /** 3 per node (mm). */
  u: Float64Array;
  /** Per node flag: 1 = clamped, 2 = concentrated load. */
  flag: Uint8Array;
}

/** Raw (unscaled, unpacked) output of a structural analysis. */
export interface StructuralAnalysis {
  grid: VoxelGridSpec;
  /** All usable solid voxels, ascending linear index. */
  solidIdx: Uint32Array;
  /** Voxel material index per solid voxel. */
  solidMat: Uint8Array;
  /** Body id per solid voxel. */
  solidBody: Int32Array;
  /** von Mises (MPa) per solid voxel: max of centroid and exposed/interface face-centre values. */
  vm: Float64Array;
  /** Stress-point index (see STRESS_POINTS) that produced vm. */
  vmPoint: Uint8Array;
  /** Mean nodal displacement per solid voxel, xyz (mm). */
  disp: Float64Array;
  /** 1 when the voxel touches a clamped node or a concentrated-load node. */
  singular: Uint8Array;
  /** 1 when the voxel belongs to an analysed body. */
  analysed: Uint8Array;
  /** Mass per solid voxel (g). */
  massG: Float64Array;
  maxNodeDisplacement: number;
  massGrams: number;
  stats: { iterations: number; residual: number; dofs: number; converged: boolean };
  warnings: string[];
  appliedForce: Vec3;
  bodies: { analysed: number; skipped: number };
  materials: EffectiveMaterial[];
  wallMs: number;
  /** Displacement (mm) of a grid node (i,j,k ∈ [0..n]) from the first analysed body containing it. */
  nodeDisplacement(i: number, j: number, k: number): Vec3 | undefined;
}

interface Body {
  voxels: Int32Array;
  i0: number;
  j0: number;
  k0: number;
  i1: number;
  j1: number;
  k1: number;
}

function validateSetup(setup: StructuralSetup): void {
  const g = setup.grid;
  if (!g) throw new Error('structural: setup.grid is required');
  for (const key of ['nx', 'ny', 'nz'] as const) {
    if (!Number.isInteger(g[key]) || g[key] <= 0) throw new Error(`structural: grid.${key} must be a positive integer`);
  }
  if (!(g.h > 0) || !Number.isFinite(g.h)) throw new Error('structural: grid.h must be a positive number (mm)');
  if (!g.cells || g.cells.length !== g.nx * g.ny * g.nz)
    throw new Error(`structural: grid.cells length ${g.cells?.length} != nx·ny·nz = ${g.nx * g.ny * g.nz}`);
  if (!Array.isArray(g.origin) || g.origin.length !== 3) throw new Error('structural: grid.origin must be a Vec3');
}

/** Label 6-connected (face-connected) solid clusters. */
function labelBodies(nx: number, ny: number, nz: number, solid: Uint8Array): { label: Int32Array; bodies: Body[] } {
  const N = nx * ny * nz;
  const label = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  const bodies: Body[] = [];
  const nxy = nx * ny;
  for (let s = 0; s < N; s++) {
    if (solid[s] === 0 || label[s] >= 0) continue;
    const id = bodies.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    label[s] = id;
    let i0 = nx;
    let j0 = ny;
    let k0 = nz;
    let i1 = -1;
    let j1 = -1;
    let k1 = -1;
    while (head < tail) {
      const v = queue[head++];
      const i = v % nx;
      const j = ((v / nx) | 0) % ny;
      const k = (v / nxy) | 0;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
      if (k < k0) k0 = k;
      if (k > k1) k1 = k;
      if (i > 0 && solid[v - 1] && label[v - 1] < 0) (label[v - 1] = id), (queue[tail++] = v - 1);
      if (i < nx - 1 && solid[v + 1] && label[v + 1] < 0) (label[v + 1] = id), (queue[tail++] = v + 1);
      if (j > 0 && solid[v - nx] && label[v - nx] < 0) (label[v - nx] = id), (queue[tail++] = v - nx);
      if (j < ny - 1 && solid[v + nx] && label[v + nx] < 0) (label[v + nx] = id), (queue[tail++] = v + nx);
      if (k > 0 && solid[v - nxy] && label[v - nxy] < 0) (label[v - nxy] = id), (queue[tail++] = v - nxy);
      if (k < nz - 1 && solid[v + nxy] && label[v + nxy] < 0) (label[v + nxy] = id), (queue[tail++] = v + nxy);
    }
    const vox = queue.slice(0, tail).sort();
    bodies.push({ voxels: vox, i0, j0, k0, i1, j1, k1 });
  }
  return { label, bodies };
}

/** True when the points (3 per entry, any units) are all (nearly) on one line. */
function collinear(pts: number[], tol: number): boolean {
  const n = pts.length / 3;
  if (n < 3) return true;
  const ax = pts[0];
  const ay = pts[1];
  const az = pts[2];
  let far = 0;
  let bx = ax;
  let by = ay;
  let bz = az;
  for (let q = 1; q < n; q++) {
    const d = (pts[3 * q] - ax) ** 2 + (pts[3 * q + 1] - ay) ** 2 + (pts[3 * q + 2] - az) ** 2;
    if (d > far) {
      far = d;
      bx = pts[3 * q];
      by = pts[3 * q + 1];
      bz = pts[3 * q + 2];
    }
  }
  if (far <= tol * tol) return true;
  const L = Math.sqrt(far);
  const dx = (bx - ax) / L;
  const dy = (by - ay) / L;
  const dz = (bz - az) / L;
  for (let q = 1; q < n; q++) {
    const px = pts[3 * q] - ax;
    const py = pts[3 * q + 1] - ay;
    const pz = pts[3 * q + 2] - az;
    const t = px * dx + py * dy + pz * dz;
    if (px * px + py * py + pz * pz - t * t > tol * tol) return false;
  }
  return true;
}

/** Grid-node index of local corner a of voxel v. */
function cornerNode(v: number, a: number, nx: number, ny: number): number {
  const i = v % nx;
  const j = ((v / nx) | 0) % ny;
  const k = (v / (nx * ny)) | 0;
  return i + (a & 1) + (nx + 1) * (j + ((a >> 1) & 1) + (ny + 1) * (k + ((a >> 2) & 1)));
}

/**
 * Run a linear-elastic analysis and return raw fields (no packing / no scaling).
 * Throws on invalid input, missing fixtures and regions that select nothing.
 */
export function analyzeStructure(setup: StructuralSetup): StructuralAnalysis {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  validateSetup(setup);
  const grid = setup.grid;
  const { nx, ny, nz, h } = grid;
  const origin: Vec3 = [grid.origin[0], grid.origin[1], grid.origin[2]];
  const N = nx * ny * nz;
  const warnings: string[] = [];
  const tol = setup.tolerance != null && setup.tolerance > 0 ? setup.tolerance : 1e-6;
  const maxIt = setup.maxIterations != null && setup.maxIterations > 0 ? Math.floor(setup.maxIterations) : 1000;

  // ---- materials & solid mask
  const mats = setup.materials ?? [];
  const usable = new Uint8Array(256);
  const used = new Uint8Array(256);
  for (let v = 0; v < N; v++) used[grid.cells[v]] = 1;
  for (let idx = 1; idx < 256; idx++) {
    if (!used[idx]) continue;
    const m = mats[idx - 1];
    if (!m) {
      throw new Error(
        `structural: voxels use material index ${idx} but materials[${idx - 1}] is missing ` +
          `(grid material '${grid.materials?.[idx - 1] ?? '?'}')`,
      );
    }
    if (!(m.E > 0) || !Number.isFinite(m.E)) {
      warnings.push(`Material ${idx} '${m.name}' has E = ${m.E} MPa; its voxels are treated as empty.`);
      continue;
    }
    if (!(m.nu >= 0 && m.nu < 0.5)) warnings.push(`Material '${m.name}': Poisson ratio ${m.nu} clamped to [0, 0.4999].`);
    else if (m.nu > 0.45)
      warnings.push(
        `Material '${m.name}' is nearly incompressible (ν = ${m.nu}); linear hexahedra may lock — treat stresses as indicative.`,
      );
    usable[idx] = 1;
  }
  const solid = new Uint8Array(N);
  let nSolid = 0;
  for (let v = 0; v < N; v++) {
    const c = grid.cells[v];
    if (c && usable[c]) {
      solid[v] = c;
      nSolid++;
    }
  }
  if (nSolid === 0) throw new Error('structural: the grid contains no solid voxels with a usable material');

  const rg: RegionGrid = { nx, ny, nz, h, origin, solid };
  const { label, bodies } = labelBodies(nx, ny, nz, solid);
  const nB = bodies.length;

  // ---- fixtures
  if (!setup.fixtures || setup.fixtures.length === 0) {
    throw new Error(
      'structural: no fixtures — the model is free to move as a rigid body. Add at least one fixture region ' +
        "(e.g. { kind: 'plane', axis: 'z', side: 'min' } or a cylinder around a screw boss).",
    );
  }
  const fixedKey = new Set<number>();
  setup.fixtures.forEach((reg, fi) => {
    const rr = resolveRegion(rg, reg);
    if (rr.voxels.length === 0)
      throw new Error(`structural: fixture ${fi} (${describeRegion(reg)}) selects no solid voxels`);
    if (rr.usedFallback)
      warnings.push(`Fixture ${fi} (${describeRegion(reg)}) contains no voxel centre; used intersecting voxels instead.`);
    for (let q = 0; q < rr.voxels.length; q++) {
      const v = rr.voxels[q];
      const m = rr.cornerMask[q];
      for (let a = 0; a < 8; a++) if (m & (1 << a)) fixedKey.add(cornerNode(v, a, nx, ny) * nB + label[v]);
    }
  });
  // per-body fixed node lists → analysed / skipped
  const fixedByBody: number[][] = bodies.map(() => []);
  for (const key of fixedKey) fixedByBody[key % nB].push(Math.floor(key / nB));
  const analysedBody = new Uint8Array(nB);
  let skippedVoxels = 0;
  let skippedBodies = 0;
  const NXg = nx + 1;
  const NYg = ny + 1;
  for (let b = 0; b < nB; b++) {
    const fl = fixedByBody[b];
    const pts: number[] = [];
    for (const g of fl) pts.push(g % NXg, Math.floor(g / NXg) % NYg, Math.floor(g / (NXg * NYg)));
    const ok = fl.length >= 3 && !collinear(pts, 0.25);
    analysedBody[b] = ok ? 1 : 0;
    if (!ok) {
      skippedBodies++;
      skippedVoxels += bodies[b].voxels.length;
      const bb = bodies[b];
      const c: Vec3 = [
        origin[0] + ((bb.i0 + bb.i1 + 1) / 2) * h,
        origin[1] + ((bb.j0 + bb.j1 + 1) / 2) * h,
        origin[2] + ((bb.k0 + bb.k1 + 1) / 2) * h,
      ];
      warnings.push(
        `Solid body ${b} (${bb.voxels.length} voxels, centred near [${c.map((x) => x.toFixed(1)).join(', ')}] mm) ` +
          (fl.length === 0
            ? 'has no fixture and is not face-connected to a fixed body'
            : 'is only fixed at a point/line and can rotate') +
          '; it was excluded from the analysis (zero stress shown).',
      );
    }
  }
  if (skippedBodies === nB) {
    throw new Error(
      'structural: no solid body is adequately fixed (each face-connected body needs a fixture touching ≥ 3 ' +
        'non-collinear nodes). ' +
        warnings.filter((w) => w.startsWith('Solid body')).join(' '),
    );
  }

  // ---- loads → nodal forces keyed by (grid node, body)
  const forceMap = new Map<number, [number, number, number]>();
  const concentratedKey = new Set<number>();
  const applied: Vec3 = [0, 0, 0];
  const addForce = (key: number, fx: number, fy: number, fz: number) => {
    const f = forceMap.get(key);
    if (f) {
      f[0] += fx;
      f[1] += fy;
      f[2] += fz;
    } else forceMap.set(key, [fx, fy, fz]);
    applied[0] += fx;
    applied[1] += fy;
    applied[2] += fz;
  };
  const loads = setup.loads ?? [];
  loads.forEach((load, li) => {
    if (!load || !load.region) throw new Error(`structural: load ${li} has no region`);
    const hasF = load.force != null && load.force.some((c) => c !== 0);
    const hasP = load.pressure != null && load.pressure !== 0;
    if (load.force != null && !load.force.every((c) => Number.isFinite(c)))
      throw new Error(`structural: load ${li} force must be finite`);
    if (load.pressure != null && !Number.isFinite(load.pressure)) throw new Error(`structural: load ${li} pressure must be finite`);
    const rr: ResolvedRegion = resolveRegion(rg, load.region);
    if (rr.voxels.length === 0)
      throw new Error(`structural: load ${li} (${describeRegion(load.region)}) selects no solid voxels`);
    if (rr.usedFallback)
      warnings.push(`Load ${li} (${describeRegion(load.region)}) contains no voxel centre; used intersecting voxels instead.`);
    if (!hasF && !hasP) {
      warnings.push(`Load ${li} (${describeRegion(load.region)}) has neither force nor pressure.`);
      return;
    }
    if (hasF) {
      const keys = new Set<number>();
      let lost = 0;
      for (let q = 0; q < rr.voxels.length; q++) {
        const v = rr.voxels[q];
        const b = label[v];
        const m = rr.cornerMask[q];
        if (!analysedBody[b]) {
          lost++;
          continue;
        }
        for (let a = 0; a < 8; a++) if (m & (1 << a)) keys.add(cornerNode(v, a, nx, ny) * nB + b);
      }
      if (keys.size === 0) {
        warnings.push(`Load ${li} (${describeRegion(load.region)}) acts only on excluded (unfixed) bodies and was ignored.`);
      } else {
        if (lost > 0)
          warnings.push(`Load ${li}: ${lost} selected voxels belong to excluded bodies; the full force was applied to the rest.`);
        const F = load.force!;
        const n = keys.size;
        // concentrated (point/line-like) loads produce stress singularities
        let mnx = Infinity;
        let mny = Infinity;
        let mnz = Infinity;
        let mxx = -Infinity;
        let mxy = -Infinity;
        let mxz = -Infinity;
        for (const key of keys) {
          const g = Math.floor(key / nB);
          const x = g % NXg;
          const y = Math.floor(g / NXg) % NYg;
          const z = Math.floor(g / (NXg * NYg));
          mnx = Math.min(mnx, x);
          mxx = Math.max(mxx, x);
          mny = Math.min(mny, y);
          mxy = Math.max(mxy, y);
          mnz = Math.min(mnz, z);
          mxz = Math.max(mxz, z);
        }
        const small = (mxx - mnx <= 2 ? 1 : 0) + (mxy - mny <= 2 ? 1 : 0) + (mxz - mnz <= 2 ? 1 : 0);
        const concentrated = small >= 2;
        for (const key of keys) {
          addForce(key, F[0] / n, F[1] / n, F[2] / n);
          if (concentrated) concentratedKey.add(key);
        }
      }
    }
    if (hasP) {
      const p = load.pressure!;
      const fFace = (p * h * h) / 4; // N per face corner
      let nf = 0;
      for (let q = 0; q < rr.faceVoxel.length; q++) {
        const v = rr.faceVoxel[q];
        const b = label[v];
        if (!analysedBody[b]) continue;
        const dir = rr.faceDir[q];
        const ax = dir >> 1;
        const sgn = dir & 1 ? 1 : -1; // outward normal sign
        const fv: Vec3 = [0, 0, 0];
        fv[ax] = -sgn * fFace; // inward
        const m = [0x55, 0xaa, 0x33, 0xcc, 0x0f, 0xf0][dir];
        for (let a = 0; a < 8; a++) if (m & (1 << a)) addForce(cornerNode(v, a, nx, ny) * nB + b, fv[0], fv[1], fv[2]);
        nf++;
      }
      if (nf === 0) warnings.push(`Load ${li} (${describeRegion(load.region)}): no exposed faces for pressure.`);
    }
  });
  const acc = setup.bodyAcceleration;
  if (acc && !acc.every((c) => Number.isFinite(c))) throw new Error('structural: bodyAcceleration must be finite');
  const hasAcc = !!acc && acc.some((c) => c !== 0);

  // ---- per-voxel bookkeeping
  const solidIdx = new Uint32Array(nSolid);
  const solidPos = new Int32Array(N).fill(-1);
  for (let v = 0, q = 0; v < N; v++)
    if (solid[v]) {
      solidPos[v] = q;
      solidIdx[q++] = v;
    }
  const solidMat = new Uint8Array(nSolid);
  const solidBody = new Int32Array(nSolid);
  const massG = new Float64Array(nSolid);
  const vol = h * h * h; // mm³
  let massGrams = 0;
  for (let q = 0; q < nSolid; q++) {
    const v = solidIdx[q];
    solidMat[q] = solid[v];
    solidBody[q] = label[v];
    const m = mats[solid[v] - 1].density * vol * 1e-6;
    massG[q] = m;
    massGrams += m;
  }

  // ---- material slots (one per used material index)
  const slotOf = new Int32Array(256).fill(-1);
  const slotIdx: number[] = [];
  for (let idx = 1; idx < 256; idx++)
    if (usable[idx]) {
      slotOf[idx] = slotIdx.length;
      slotIdx.push(idx);
    }
  const nSlots = slotIdx.length;
  const slotK = new Float64Array(nSlots * 576);
  const slotScale = new Float64Array(nSlots);
  const slotS: Float64Array[] = [];
  const slotEoverH = new Float64Array(nSlots);
  for (let s = 0; s < nSlots; s++) {
    const m = mats[slotIdx[s] - 1];
    const el = hexElement(m.nu);
    slotK.set(el.K, s * 576);
    slotScale[s] = m.E * h;
    slotS.push(el.S);
    slotEoverH[s] = m.E / h;
  }

  // ---- solve each analysed body
  const vm = new Float64Array(nSolid);
  const vmPoint = new Uint8Array(nSolid);
  const disp = new Float64Array(3 * nSolid);
  const singular = new Uint8Array(nSolid);
  const analysed = new Uint8Array(nSolid);
  const sols: (BodySolution | null)[] = new Array(nB).fill(null);
  let totalDofsEst = 0;
  for (let b = 0; b < nB; b++) if (analysedBody[b]) totalDofsEst += bodies[b].voxels.length;
  let doneDofs = 0;
  let maxIters = 0;
  let maxRes = 0;
  let dofs = 0;
  let allConverged = true;
  let maxNodeDisp = 0;
  const progress = setup.onProgress;
  const logTol = Math.log(tol);

  for (let b = 0; b < nB; b++) {
    if (!analysedBody[b]) continue;
    const body = bodies[b];
    const { i0, j0, k0 } = body;
    const NX = body.i1 - i0 + 2;
    const NY = body.j1 - j0 + 2;
    const NZ = body.k1 - k0 + 2;
    const nodeMap = new Int32Array(NX * NY * NZ).fill(-1);
    const nE = body.voxels.length;
    const conn = new Int32Array(nE * 8);
    const elemCoord = new Int32Array(nE * 3);
    const elemSlot = new Int32Array(nE);
    const nodeCoordArr: number[] = [];
    let nN = 0;
    for (let e = 0; e < nE; e++) {
      const v = body.voxels[e];
      const li = (v % nx) - i0;
      const lj = (((v / nx) | 0) % ny) - j0;
      const lk = ((v / (nx * ny)) | 0) - k0;
      elemCoord[3 * e] = li;
      elemCoord[3 * e + 1] = lj;
      elemCoord[3 * e + 2] = lk;
      elemSlot[e] = slotOf[solid[v]];
      for (let a = 0; a < 8; a++) {
        const gx = li + (a & 1);
        const gy = lj + ((a >> 1) & 1);
        const gz = lk + ((a >> 2) & 1);
        const key = gx + NX * (gy + NY * gz);
        let n = nodeMap[key];
        if (n < 0) {
          n = nodeMap[key] = nN++;
          nodeCoordArr.push(gx, gy, gz);
        }
        conn[e * 8 + a] = n;
      }
    }
    const localNode = (g: number): number => {
      const gx = (g % NXg) - i0;
      const gy = (Math.floor(g / NXg) % NYg) - j0;
      const gz = Math.floor(g / (NXg * NYg)) - k0;
      if (gx < 0 || gy < 0 || gz < 0 || gx >= NX || gy >= NY || gz >= NZ) return -1;
      return nodeMap[gx + NX * (gy + NY * gz)];
    };
    const free = new Uint8Array(nN).fill(1);
    const flag = new Uint8Array(nN);
    for (const g of fixedByBody[b]) {
      const n = localNode(g);
      if (n >= 0) {
        free[n] = 0;
        flag[n] |= 1;
      }
    }
    const f = new Float64Array(3 * nN);
    for (const [key, fv] of forceMap) {
      if (key % nB !== b) continue;
      const n = localNode(Math.floor(key / nB));
      if (n < 0) continue;
      f[3 * n] += fv[0];
      f[3 * n + 1] += fv[1];
      f[3 * n + 2] += fv[2];
      if (concentratedKey.has(key)) flag[n] |= 2;
    }
    if (hasAcc) {
      for (let e = 0; e < nE; e++) {
        const v = body.voxels[e];
        const mKg = mats[solid[v] - 1].density * vol * 1e-9;
        const fx = (mKg * acc![0]) / 8;
        const fy = (mKg * acc![1]) / 8;
        const fz = (mKg * acc![2]) / 8;
        for (let a = 0; a < 8; a++) {
          const n = conn[e * 8 + a];
          f[3 * n] += fx;
          f[3 * n + 1] += fy;
          f[3 * n + 2] += fz;
        }
        applied[0] += 8 * fx;
        applied[1] += 8 * fy;
        applied[2] += 8 * fz;
      }
    }
    for (let n = 0; n < nN; n++)
      if (!free[n]) {
        f[3 * n] = 0;
        f[3 * n + 1] = 0;
        f[3 * n + 2] = 0;
      }
    const mg = new ElasticMultigrid({
      nNodes: nN,
      nodeCoord: Int32Array.from(nodeCoordArr),
      nElem: nE,
      conn,
      elemCoord,
      elemSlot,
      slotK,
      slotScale,
      free,
    });
    const u = new Float64Array(3 * nN);
    const bodyDofs = mg.dofs;
    const res = solvePcg(mg, f, u, tol, maxIt, (_it, rel) => {
      if (!progress) return;
      const frac = Math.min(1, Math.max(0, Math.log(Math.max(rel, 1e-300)) / logTol));
      progress(Math.min(0.99, (0.05 + 0.9 * (doneDofs + frac * nE)) / Math.max(1, totalDofsEst)));
    });
    doneDofs += nE;
    maxIters = Math.max(maxIters, res.iterations);
    maxRes = Math.max(maxRes, res.residual);
    dofs += bodyDofs;
    if (!res.converged) {
      allConverged = false;
      warnings.push(
        res.breakdown
          ? `Body ${b}: solver breakdown (singular stiffness — a part may be connected only through an edge or vertex).`
          : `Body ${b}: PCG did not reach tolerance ${tol} in ${res.iterations} iterations (relative residual ${res.residual.toExponential(2)}).`,
      );
    }
    for (let n = 0; n < nN; n++) {
      const d = Math.hypot(u[3 * n], u[3 * n + 1], u[3 * n + 2]);
      if (d > maxNodeDisp) maxNodeDisp = d;
    }
    sols[b] = { i0, j0, k0, NX, NY, NZ, nodeMap, u, flag };

    // ---- stress recovery for this body's voxels
    const ue = new Float64Array(24);
    for (let e = 0; e < nE; e++) {
      const v = body.voxels[e];
      const q = solidPos[v];
      analysed[q] = 1;
      const i = v % nx;
      const j = ((v / nx) | 0) % ny;
      const k = (v / (nx * ny)) | 0;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let sing = 0;
      for (let a = 0; a < 8; a++) {
        const n = conn[e * 8 + a];
        ue[3 * a] = u[3 * n];
        ue[3 * a + 1] = u[3 * n + 1];
        ue[3 * a + 2] = u[3 * n + 2];
        sx += u[3 * n];
        sy += u[3 * n + 1];
        sz += u[3 * n + 2];
        sing |= flag[n];
      }
      disp[3 * q] = sx / 8;
      disp[3 * q + 1] = sy / 8;
      disp[3 * q + 2] = sz / 8;
      singular[q] = sing ? 1 : 0;
      const slot = elemSlot[e];
      const S = slotS[slot];
      const scale = slotEoverH[slot];
      const mat = solid[v];
      let best = -1;
      let bestP = 0;
      for (let p = 0; p < 7; p++) {
        if (p > 0) {
          // only faces on the surface or on a material interface
          const dir = p - 1;
          let nb = -1;
          if (dir === 0) nb = i > 0 ? v - 1 : -1;
          else if (dir === 1) nb = i < nx - 1 ? v + 1 : -1;
          else if (dir === 2) nb = j > 0 ? v - nx : -1;
          else if (dir === 3) nb = j < ny - 1 ? v + nx : -1;
          else if (dir === 4) nb = k > 0 ? v - nx * ny : -1;
          else nb = k < nz - 1 ? v + nx * ny : -1;
          if (nb >= 0 && solid[nb] === mat) continue;
        }
        const o = p * 144;
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        let s3 = 0;
        let s4 = 0;
        let s5 = 0;
        for (let c = 0; c < 24; c++) {
          const x = ue[c];
          s0 += S[o + c] * x;
          s1 += S[o + 24 + c] * x;
          s2 += S[o + 48 + c] * x;
          s3 += S[o + 72 + c] * x;
          s4 += S[o + 96 + c] * x;
          s5 += S[o + 120 + c] * x;
        }
        const val = scale * vonMises(s0, s1, s2, s3, s4, s5);
        if (val > best) {
          best = val;
          bestP = p;
        }
      }
      vm[q] = best;
      vmPoint[q] = bestP;
    }
  }
  if (skippedVoxels > 0 && nSolid > 0)
    warnings.push(`${skippedVoxels} of ${nSolid} solid voxels were not analysed (unfixed bodies).`);
  if (!loads.length && !hasAcc) warnings.push('No loads applied: all stresses are zero.');
  progress?.(1);

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    grid: { nx, ny, nz, h, origin },
    solidIdx,
    solidMat,
    solidBody,
    vm,
    vmPoint,
    disp,
    singular,
    analysed,
    massG,
    maxNodeDisplacement: maxNodeDisp,
    massGrams,
    stats: { iterations: maxIters, residual: maxRes, dofs, converged: allConverged },
    warnings,
    appliedForce: applied,
    bodies: { analysed: nB - skippedBodies, skipped: skippedBodies },
    materials: mats,
    wallMs: t1 - t0,
    nodeDisplacement(i: number, j: number, k: number): Vec3 | undefined {
      for (const s of sols) {
        if (!s) continue;
        const gx = i - s.i0;
        const gy = j - s.j0;
        const gz = k - s.k0;
        if (gx < 0 || gy < 0 || gz < 0 || gx >= s.NX || gy >= s.NY || gz >= s.NZ) continue;
        const n = s.nodeMap[gx + s.NX * (gy + s.NY * gz)];
        if (n >= 0) return [s.u[3 * n], s.u[3 * n + 1], s.u[3 * n + 2]];
      }
      return undefined;
    },
  };
}

/** Location (mm) of the stress sample point p of voxel v. */
function samplePoint(spec: VoxelGridSpec, v: number, p: number): Vec3 {
  const { nx, ny, h, origin } = spec;
  const i = v % nx;
  const j = Math.floor(v / nx) % ny;
  const k = Math.floor(v / (nx * ny));
  const sp = STRESS_POINTS[p];
  return [
    origin[0] + (i + 0.5 + 0.5 * sp[0]) * h,
    origin[1] + (j + 0.5 + 0.5 * sp[1]) * h,
    origin[2] + (k + 0.5 + 0.5 * sp[2]) * h,
  ];
}

/**
 * Package an analysis as a StructuralResult. All stresses and displacements are multiplied by `scale`
 * (used by the drop analysis, which solves a unit load case and scales it linearly).
 */
export function buildStructuralResult(
  a: StructuralAnalysis,
  meta: StructuralMeta,
  scale = 1,
  extraWarnings: string[] = [],
): StructuralResultDetail {
  const n = a.solidIdx.length;
  const vm32 = new Float32Array(n);
  const d32 = new Float32Array(3 * n);
  const s = Math.abs(scale);
  let rawMax = 0;
  let rawAt = -1;
  let rawSF = Infinity;
  let smMax = 0;
  let smAt = -1;
  let smSF = Infinity;
  let maxDispVoxel = 0;
  let excluded = 0;
  let anyIncluded = false;
  for (let q = 0; q < n; q++) {
    const val = a.vm[q] * s;
    vm32[q] = val;
    d32[3 * q] = a.disp[3 * q] * scale;
    d32[3 * q + 1] = a.disp[3 * q + 1] * scale;
    d32[3 * q + 2] = a.disp[3 * q + 2] * scale;
    maxDispVoxel = Math.max(maxDispVoxel, Math.hypot(d32[3 * q], d32[3 * q + 1], d32[3 * q + 2]));
    if (!a.analysed[q]) continue;
    const ys = a.materials[a.solidMat[q] - 1].yieldStrength;
    const sf = val > 0 && ys > 0 ? ys / val : Infinity;
    if (val > rawMax || rawAt < 0) {
      rawMax = val;
      rawAt = q;
    }
    if (sf < rawSF) rawSF = sf;
    if (a.singular[q]) {
      excluded++;
      continue;
    }
    anyIncluded = true;
    if (val > smMax || smAt < 0) {
      smMax = val;
      smAt = q;
    }
    if (sf < smSF) smSF = sf;
  }
  if (!anyIncluded) {
    smMax = rawMax;
    smAt = rawAt;
    smSF = rawSF;
  }
  const at = (q: number): Vec3 => (q >= 0 ? samplePoint(a.grid, a.solidIdx[q], a.vmPoint[q]) : [0, 0, 0]);
  const cap = (v: number) => (Number.isFinite(v) ? Math.min(v, SAFETY_FACTOR_CAP) : SAFETY_FACTOR_CAP);
  const usedIdx = new Set<number>();
  for (let q = 0; q < n; q++) usedIdx.add(a.solidMat[q]);
  const materials = [...usedIdx]
    .sort((x, y) => x - y)
    .map((idx) => {
      const m = a.materials[idx - 1];
      return { id: m.materialId, name: m.name, E: m.E, yieldStrength: m.yieldStrength };
    });
  const warnings = [...a.warnings, ...extraWarnings];
  if (!anyIncluded && n > 0)
    warnings.push('Every analysed voxel touches a fixture or concentrated load; reported maxima include singularities.');
  return {
    kind: 'structural',
    title: meta.title,
    grid: { nx: a.grid.nx, ny: a.grid.ny, nz: a.grid.nz, h: a.grid.h, origin: [...a.grid.origin] as Vec3 },
    solid: pack(a.solidIdx, 'u32'),
    solidMaterial: pack(a.solidMat, 'u8'),
    vonMises: pack(vm32, 'f32'),
    displacement: pack(d32, 'f32'),
    maxVonMises: smMax,
    maxDisplacement: Math.max(a.maxNodeDisplacement * s, maxDispVoxel),
    minSafetyFactor: cap(smSF),
    maxStressAt: at(smAt),
    loads: [...meta.loads],
    fixtures: [...meta.fixtures],
    massGrams: a.massGrams,
    solver: { ...a.stats },
    materials,
    raw: { maxVonMises: rawMax, minSafetyFactor: cap(rawSF), maxStressAt: at(rawAt) },
    singularityExcludedVoxels: anyIncluded ? excluded : 0,
    appliedForce: [a.appliedForce[0] * scale, a.appliedForce[1] * scale, a.appliedForce[2] * scale],
    bodies: { ...a.bodies },
    warnings,
    wallMs: a.wallMs,
  };
}

/**
 * Linear-elastic static analysis of a voxel model.
 *
 * Method: 8-node hexahedra with Wilson–Taylor incompatible modes (statically condensed), matrix-free
 * element-by-element operator, conjugate gradients preconditioned by a geometric multigrid V-cycle with
 * exact Galerkin coarse operators. Each face-connected solid body is solved independently; bodies with no
 * (or only point/line) fixtures are skipped with a warning. Units: mm, N, MPa.
 *
 * Stress per voxel = max von Mises over the centroid and the centres of its exposed / material-interface
 * faces (surface stress of thin walls). maxVonMises / minSafetyFactor / maxStressAt exclude voxels that
 * touch clamped nodes or concentrated (point/line) load nodes; unfiltered values are in `raw`.
 *
 * @throws Error when there are no fixtures, a fixture/load region selects no solid voxel, the grid is
 *   malformed, or no body is adequately fixed.
 */
export function solveStructural(setup: StructuralSetup, meta: StructuralMeta): StructuralResultDetail {
  return buildStructuralResult(analyzeStructure(setup), meta, 1);
}
