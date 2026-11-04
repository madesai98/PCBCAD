import { pack } from '@pcbcad/core';
import type { Vec3 } from '@pcbcad/core';
import { AggregationAmg, KrylovWork, bicgstab, csrFromRows, pcg } from './linear';
import type { Csr } from './linear';
import { traceStreamlines } from './streamlines';
import type { AirflowResultDetail, AirflowSetup } from './types';

/* Cell types */
const FLUID = 0;
const OPEN = 1;
const SOLID = 2;
/* Face states */
const WALL = 0;
const ACTIVE = 1;
const FIXED = 2;
const FREE = 3;
/* Momentum neighbour kinds */
const NB_UNKNOWN = 0;
const NB_KNOWN = 1;
const NB_TWALL = 2;
const NB_FREE = 3;

/**
 * Solver controls (module defaults; exposed for tuning and tests, not part of the public API).
 * alphaU: SIMPLEC momentum under-relaxation; alphaP: pressure-correction relaxation; alphaT: relaxation
 * of the per-iteration energy update; energyCycles: stationary AMG cycles per energy update;
 * pressureTol / pressureMaxIt: inner PCG accuracy of the pressure correction per outer iteration.
 */
export const airflowTuning: {
  alphaU: number;
  alphaP: number;
  alphaT: number;
  energyCycles: number;
  pressureTol: number;
  pressureMaxIt: number;
  /** Per-iteration energy solve when energyCycles = 0: BiCGSTAB relative tolerance / iteration cap. */
  energyTol: number;
  energyMaxIt: number;
  /** Estimated remaining relative temperature drift accepted at convergence. */
  driftTol: number;
  /** Normalised momentum and continuity residuals accepted at convergence. */
  momTol: number;
  massTol: number;
  trace?: (it: Record<string, number>) => void;
} = {
  alphaU: 0.7,
  alphaP: 1.0,
  alphaT: 0.5,
  energyCycles: 0,
  pressureTol: 0.1,
  pressureMaxIt: 10,
  energyTol: 3e-4,
  energyMaxIt: 60,
  driftTol: 1e-3,
  momTol: 1e-4,
  massTol: 1e-4,
};

/** Dry-air properties at 1 atm and temperature Tc (°C): kg/m³, Pa·s, W/mK, J/kgK, 1/K. */
export function airProperties(Tc: number): { density: number; viscosity: number; conductivity: number; specificHeat: number; beta: number } {
  const T = Tc + 273.15;
  return {
    density: 101325 / (287.05 * T),
    viscosity: (1.458e-6 * T ** 1.5) / (T + 110.4), // Sutherland
    conductivity: 0.0241 + 7.7e-5 * Tc,
    specificHeat: 1007,
    beta: 1 / T,
  };
}

/** Staggered velocity component on the faces normal to one axis. */
interface FaceAxis {
  ax: number;
  /** Face-grid dimensions. */
  FD: [number, number, number];
  n: number;
  state: Uint8Array;
  vel: Float64Array;
  /** Faces carrying flow (ACTIVE or FIXED) and their lower/upper cells. */
  live: Int32Array;
  liveL: Int32Array;
  liveU: Int32Array;
  /** ACTIVE faces (momentum unknowns). */
  act: Int32Array;
  cellL: Int32Array;
  cellU: Int32Array;
  /** 6 per active face: neighbour face along (−x, +x, −y, +y, −z, +z), −1 outside. */
  nbIdx: Int32Array;
  nbType: Uint8Array;
  /** 8 per active face: tangential axis slot (0/1) × side (−/+) × (lower, upper cell) → face on that axis. */
  fluxIdx: Int32Array;
  aNb: Float64Array;
  aP: Float64Array;
  b: Float64Array;
  d: Float64Array;
  /** Pressure-matrix positions per active face (−1 when not applicable). */
  pLL: Int32Array;
  pUU: Int32Array;
  pLU: Int32Array;
  pUL: Int32Array;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Steady laminar airflow with Boussinesq buoyancy and conjugate heat transfer on a voxel grid.
 *
 * Method (details in README.md): SIMPLEC pressure–velocity coupling on a staggered (MAC) grid, upwind
 * convection with full physical diffusion for momentum, no-slip at solid faces, openings as
 * fixed-pressure reservoirs (p = 0 = ambient hydrostatic pressure; inflow at ambient temperature,
 * zero-gradient outflow), fans as fixed face velocities (flow / cross-section) on the fan cells'
 * downstream faces. Energy (advection with hybrid differencing + conduction in air, conduction in solids
 * with harmonic-mean interface conductances, volumetric sources, external h on solid boundary faces) is
 * solved implicitly in conservative form for all cells. Linear systems use geometric-aggregation AMG:
 * preconditioned CG for the pressure correction, stationary AMG cycles for the per-iteration energy
 * update and BiCGSTAB for the final energy solve. After convergence an exact projection makes the face
 * fluxes divergence-free and a final tight energy solve makes the heat balance and vent flows conservative.
 *
 * @throws Error for malformed grids/materials or when heat input has no path to ambient.
 */
export function solveAirflow(setup: AirflowSetup): AirflowResultDetail {
  const t0 = now();
  const tun = airflowTuning;
  const warnings: string[] = [];
  const grid = setup.grid;
  if (!grid) throw new Error('airflow: setup.grid is required');
  const { nx, ny, nz, h } = grid;
  for (const [k, v] of [['nx', nx], ['ny', ny], ['nz', nz]] as const)
    if (!Number.isInteger(v) || v <= 0) throw new Error(`airflow: grid.${k} must be a positive integer`);
  if (!(h > 0)) throw new Error('airflow: grid.h must be > 0 (mm)');
  const N = nx * ny * nz;
  const NXY = nx * ny;
  if (!grid.cells || grid.cells.length !== N) throw new Error(`airflow: grid.cells length must be nx·ny·nz = ${N}`);
  if (!Number.isFinite(setup.ambient)) throw new Error('airflow: ambient temperature must be finite (°C)');
  const Tamb = setup.ambient;
  const gvec: Vec3 = setup.gravity ?? [0, 0, -9.81];
  if (!gvec.every((x) => Number.isFinite(x))) throw new Error('airflow: gravity must be a finite Vec3');
  const hExt = setup.externalH ?? 10;
  if (!(hExt >= 0)) throw new Error('airflow: externalH must be ≥ 0');
  const maxIt = Math.max(1, Math.floor(setup.maxIterations ?? 1500));
  const air = airProperties(Tamb);
  const rho = air.density;
  const cp = air.specificHeat;
  const kAir = air.conductivity;
  const hm = h * 1e-3;
  const A = hm * hm;
  const V = hm * hm * hm;
  const rhoA = rho * A;
  const Dvisc = (air.viscosity * A) / hm;
  const rcpA = rho * cp * A;

  /* ------------------------------------------------ cells ------------------------------------------------ */
  const type = new Uint8Array(N);
  const kCell = new Float64Array(N);
  const mats = setup.materials ?? [];
  const badMat = new Set<number>();
  for (let c = 0; c < N; c++) {
    const m = grid.cells[c];
    if (m === 0) {
      type[c] = FLUID;
      kCell[c] = kAir;
      continue;
    }
    type[c] = SOLID;
    const mat = mats[m - 1];
    if (!mat) throw new Error(`airflow: cells use material index ${m} but materials[${m - 1}] is missing`);
    let k = mat.thermalConductivity;
    if (!(k > 0)) {
      if (!badMat.has(m)) warnings.push(`Material '${mat.name}' has no thermal conductivity; using 0.1 W/mK.`);
      badMat.add(m);
      k = 0.1;
    }
    kCell[c] = k;
  }
  const openings = setup.openings ?? [];
  const openOf = new Int16Array(N).fill(-1);
  openings.forEach((o, oi) => {
    let used = 0;
    let bad = 0;
    for (let q = 0; q < o.cells.length; q++) {
      const c = o.cells[q];
      if (!Number.isInteger(c) || c < 0 || c >= N || type[c] === SOLID) {
        bad++;
        continue;
      }
      if (openOf[c] >= 0) continue;
      type[c] = OPEN;
      openOf[c] = oi;
      used++;
    }
    if (bad) warnings.push(`Opening '${o.name}': ${bad} cells are solid or out of range and were ignored.`);
    if (!used) warnings.push(`Opening '${o.name}' has no usable air cells.`);
  });
  const qCell = new Float64Array(N);
  let input = 0;
  const sources = setup.heatSources ?? [];
  sources.forEach((s, si) => {
    if (!Number.isFinite(s.power)) throw new Error(`airflow: heatSources[${si}].power must be finite (W)`);
    const cells: number[] = [];
    for (let q = 0; q < s.cells.length; q++) {
      const c = s.cells[q];
      if (Number.isInteger(c) && c >= 0 && c < N) cells.push(c);
    }
    const label = s.ref ?? s.componentId ?? String(si);
    if (!cells.length) {
      warnings.push(`Heat source ${label} has no valid cells; its ${s.power} W were ignored.`);
      return;
    }
    let airCells = 0;
    for (const c of cells) {
      qCell[c] += s.power / cells.length;
      if (type[c] !== SOLID) airCells++;
    }
    if (airCells) warnings.push(`Heat source ${label}: ${airCells} of ${cells.length} cells are air (heat goes directly into the air).`);
    input += s.power;
  });

  /* ------------------------------------------------ faces ------------------------------------------------ */
  const CD = [nx, ny, nz];
  const CS = [1, nx, NXY];
  const axes: FaceAxis[] = [0, 1, 2].map((ax) => {
    const FD: [number, number, number] = [nx + (ax === 0 ? 1 : 0), ny + (ax === 1 ? 1 : 0), nz + (ax === 2 ? 1 : 0)];
    const n = FD[0] * FD[1] * FD[2];
    const state = new Uint8Array(n);
    const lim = CD[ax];
    for (let k = 0, f = 0; k < FD[2]; k++)
      for (let j = 0; j < FD[1]; j++)
        for (let i = 0; i < FD[0]; i++, f++) {
          const ca = ax === 0 ? i : ax === 1 ? j : k;
          const hasL = ca >= 1;
          const hasU = ca < lim;
          const cU = i + nx * (j + ny * k);
          const tL = hasL ? type[cU - CS[ax]] : -1;
          const tU = hasU ? type[cU] : -1;
          if (tL === SOLID || tU === SOLID) state[f] = WALL;
          else if (hasL && hasU) state[f] = tL === OPEN && tU === OPEN ? FREE : ACTIVE;
          else state[f] = (hasL ? tL : tU) === OPEN ? FREE : WALL;
        }
    return { ax, FD, n, state, vel: new Float64Array(n) } as FaceAxis;
  });
  const faceIndex = (ax: number, i: number, j: number, k: number): number => {
    const FD = axes[ax].FD;
    if (i < 0 || j < 0 || k < 0 || i >= FD[0] || j >= FD[1] || k >= FD[2]) return -1;
    return i + FD[0] * (j + FD[1] * k);
  };
  const cellIJK = (c: number): [number, number, number] => [c % nx, Math.floor(c / nx) % ny, Math.floor(c / NXY)];

  // fans → fixed face velocities
  const fans = setup.fans ?? [];
  let fanFlow = 0;
  const fanSeeds: number[] = [];
  for (const fan of fans) {
    const dir = fan.direction ?? [0, 0, 1];
    if (!Number.isFinite(fan.flowM3s)) throw new Error(`airflow: fan '${fan.name}' flowM3s must be finite`);
    const absd = dir.map((x) => Math.abs(x));
    const a = absd[0] >= absd[1] && absd[0] >= absd[2] ? 0 : absd[1] >= absd[2] ? 1 : 2;
    if (!(absd[a] > 0)) throw new Error(`airflow: fan '${fan.name}' direction must be non-zero`);
    const sgn = dir[a] > 0 ? 1 : -1;
    const cells: number[] = [];
    for (let q = 0; q < fan.cells.length; q++) {
      const c = fan.cells[q];
      if (Number.isInteger(c) && c >= 0 && c < N && type[c] !== SOLID) cells.push(c);
    }
    if (!cells.length) {
      warnings.push(`Fan '${fan.name}' has no air cells and was ignored.`);
      continue;
    }
    const proj = new Set<number>();
    for (const c of cells) {
      const co = cellIJK(c);
      proj.add(a === 0 ? co[1] + ny * co[2] : a === 1 ? co[0] + nx * co[2] : co[0] + nx * co[1]);
    }
    const U = fan.flowM3s / (proj.size * A);
    const F = axes[a];
    let fixed = 0;
    for (const c of cells) {
      const co = cellIJK(c);
      const down: [number, number, number] = [co[0], co[1], co[2]];
      const up: [number, number, number] = [co[0], co[1], co[2]];
      if (sgn > 0) down[a] += 1;
      else up[a] += 1;
      let f = faceIndex(a, down[0], down[1], down[2]);
      if (f < 0 || (F.state[f] !== ACTIVE && F.state[f] !== FIXED)) f = faceIndex(a, up[0], up[1], up[2]);
      if (f < 0 || (F.state[f] !== ACTIVE && F.state[f] !== FIXED)) continue;
      F.state[f] = FIXED;
      F.vel[f] = sgn * U;
      fixed++;
      fanSeeds.push(c);
    }
    if (!fixed) warnings.push(`Fan '${fan.name}': no open face in the blowing direction; ignored.`);
    else if (fan.flowM3s !== 0) fanFlow += Math.abs(fan.flowM3s);
  }
  const mode: 'natural' | 'forced' = fanFlow > 0 ? 'forced' : 'natural';

  /* --------------------------------------- momentum topology --------------------------------------- */
  for (const F of axes) {
    const ax = F.ax;
    const live: number[] = [];
    const act: number[] = [];
    for (let f = 0; f < F.n; f++) {
      const s = F.state[f];
      if (s === ACTIVE || s === FIXED) live.push(f);
      if (s === ACTIVE) act.push(f);
    }
    const toCell = (f: number) => {
      const i = f % F.FD[0];
      const j = Math.floor(f / F.FD[0]) % F.FD[1];
      const k = Math.floor(f / (F.FD[0] * F.FD[1]));
      return i + nx * (j + ny * k);
    };
    F.live = Int32Array.from(live);
    F.liveU = Int32Array.from(live, toCell);
    F.liveL = Int32Array.from(F.liveU, (c) => c - CS[ax]);
    const nA = act.length;
    F.act = Int32Array.from(act);
    F.cellU = Int32Array.from(act, toCell);
    F.cellL = Int32Array.from(F.cellU, (c) => c - CS[ax]);
    F.nbIdx = new Int32Array(6 * nA).fill(-1);
    F.nbType = new Uint8Array(6 * nA);
    F.fluxIdx = new Int32Array(8 * nA).fill(-1);
    F.aNb = new Float64Array(6 * nA);
    F.aP = new Float64Array(nA);
    F.b = new Float64Array(nA);
    F.d = new Float64Array(nA);
    const t0ax = ax === 0 ? 1 : 0;
    const t1ax = ax === 2 ? 1 : 2;
    for (let q = 0; q < nA; q++) {
      const f = F.act[q];
      const co = [f % F.FD[0], Math.floor(f / F.FD[0]) % F.FD[1], Math.floor(f / (F.FD[0] * F.FD[1]))];
      for (let dir = 0; dir < 6; dir++) {
        const d = dir >> 1;
        const s = dir & 1 ? 1 : -1;
        const nf = faceIndex(ax, co[0] + (d === 0 ? s : 0), co[1] + (d === 1 ? s : 0), co[2] + (d === 2 ? s : 0));
        F.nbIdx[q * 6 + dir] = nf;
        const st = nf >= 0 ? F.state[nf] : WALL;
        let t: number;
        if (d === ax) t = st === ACTIVE ? NB_UNKNOWN : st === FREE ? NB_FREE : NB_KNOWN;
        else if (nf < 0 || st === WALL) t = NB_TWALL;
        else t = st === ACTIVE ? NB_UNKNOWN : st === FREE ? NB_FREE : NB_KNOWN;
        F.nbType[q * 6 + dir] = t;
      }
      const cl = [co[0], co[1], co[2]];
      cl[ax] -= 1;
      [t0ax, t1ax].forEach((d, slot) => {
        for (let side = 0; side < 2; side++) {
          const o = q * 8 + slot * 4 + side * 2;
          F.fluxIdx[o] = faceIndex(d, cl[0] + (d === 0 ? side : 0), cl[1] + (d === 1 ? side : 0), cl[2] + (d === 2 ? side : 0));
          F.fluxIdx[o + 1] = faceIndex(d, co[0] + (d === 0 ? side : 0), co[1] + (d === 1 ? side : 0), co[2] + (d === 2 ? side : 0));
        }
      });
    }
  }

  /* ---------------------------------------- pressure system ---------------------------------------- */
  // FLUID cells connected through ACTIVE faces; regions without an opening get one reference (pinned) cell
  const pid = new Int32Array(N).fill(-1);
  {
    const comp = new Int32Array(N).fill(-1);
    const hasDirichlet: boolean[] = [];
    const stack: number[] = [];
    let nc = 0;
    for (let s = 0; s < N; s++) {
      if (type[s] !== FLUID || comp[s] >= 0) continue;
      comp[s] = nc;
      stack.push(s);
      let dir = false;
      while (stack.length) {
        const c = stack.pop()!;
        const [i, j, k] = cellIJK(c);
        for (let ax = 0; ax < 3; ax++)
          for (let side = 0; side < 2; side++) {
            const f = faceIndex(ax, i + (ax === 0 ? side : 0), j + (ax === 1 ? side : 0), k + (ax === 2 ? side : 0));
            if (f < 0 || axes[ax].state[f] !== ACTIVE) continue;
            const nb = side ? c + CS[ax] : c - CS[ax];
            if (type[nb] === OPEN) dir = true;
            else if (type[nb] === FLUID && comp[nb] < 0) {
              comp[nb] = nc;
              stack.push(nb);
            }
          }
      }
      hasDirichlet.push(dir);
      nc++;
    }
    const pinned = new Uint8Array(nc);
    let np = 0;
    for (let c = 0; c < N; c++) {
      if (type[c] !== FLUID) continue;
      const cc = comp[c];
      if (!hasDirichlet[cc] && !pinned[cc]) {
        pinned[cc] = 1;
        continue;
      }
      pid[c] = np++;
    }
  }
  let nP = 0;
  for (let c = 0; c < N; c++) if (pid[c] >= 0) nP++;
  const pCoords = new Int32Array(3 * nP);
  const pCell = new Int32Array(nP);
  for (let c = 0; c < N; c++)
    if (pid[c] >= 0) {
      const r = pid[c];
      const [i, j, k] = cellIJK(c);
      pCell[r] = c;
      pCoords[3 * r] = i;
      pCoords[3 * r + 1] = j;
      pCoords[3 * r + 2] = k;
    }
  const Ap: Csr = csrFromRows(nP, (r, push) => {
    const c = pCell[r];
    const [i, j, k] = cellIJK(c);
    for (let ax = 0; ax < 3; ax++)
      for (let side = 0; side < 2; side++) {
        const f = faceIndex(ax, i + (ax === 0 ? side : 0), j + (ax === 1 ? side : 0), k + (ax === 2 ? side : 0));
        if (f < 0 || axes[ax].state[f] !== ACTIVE) continue;
        const nb = side ? c + CS[ax] : c - CS[ax];
        if (pid[nb] >= 0) push(pid[nb]);
      }
  });
  const findPos = (M: Csr, r: number, c: number) => {
    for (let k = M.ptr[r]; k < M.ptr[r + 1]; k++) if (M.col[k] === c) return k;
    return -1;
  };
  for (const F of axes) {
    const nA = F.act.length;
    F.pLL = new Int32Array(nA).fill(-1);
    F.pUU = new Int32Array(nA).fill(-1);
    F.pLU = new Int32Array(nA).fill(-1);
    F.pUL = new Int32Array(nA).fill(-1);
    for (let q = 0; q < nA; q++) {
      const rl = pid[F.cellL[q]];
      const ru = pid[F.cellU[q]];
      if (rl >= 0) F.pLL[q] = Ap.diag[rl];
      if (ru >= 0) F.pUU[q] = Ap.diag[ru];
      if (rl >= 0 && ru >= 0) {
        F.pLU[q] = findPos(Ap, rl, ru);
        F.pUL[q] = findPos(Ap, ru, rl);
      }
    }
  }

  /* ----------------------------------------- energy system ----------------------------------------- */
  const cellCoords = new Int32Array(3 * N);
  for (let c = 0; c < N; c++) {
    cellCoords[3 * c] = c % nx;
    cellCoords[3 * c + 1] = Math.floor(c / nx) % ny;
    cellCoords[3 * c + 2] = Math.floor(c / NXY);
  }
  const Ae: Csr = csrFromRows(N, (c, push) => {
    const i = cellCoords[3 * c];
    const j = cellCoords[3 * c + 1];
    const k = cellCoords[3 * c + 2];
    if (i > 0) push(c - 1);
    if (i < nx - 1) push(c + 1);
    if (j > 0) push(c - nx);
    if (j < ny - 1) push(c + nx);
    if (k > 0) push(c - NXY);
    if (k < nz - 1) push(c + NXY);
  });
  const eFaceCount = (nx - 1) * ny * nz + nx * (ny - 1) * nz + nx * ny * (nz - 1);
  const eAx = new Uint8Array(eFaceCount);
  const eF = new Int32Array(eFaceCount);
  const eG = new Float64Array(eFaceCount);
  const ePos = new Int32Array(4 * eFaceCount);
  {
    let q = 0;
    for (const F of axes) {
      const ax = F.ax;
      for (let k = 0, f = 0; k < F.FD[2]; k++)
        for (let j = 0; j < F.FD[1]; j++)
          for (let i = 0; i < F.FD[0]; i++, f++) {
            const ca = ax === 0 ? i : ax === 1 ? j : k;
            if (ca < 1 || ca >= CD[ax]) continue;
            const cN = i + nx * (j + ny * k);
            const cP = cN - CS[ax];
            eAx[q] = ax;
            eF[q] = f;
            const kp = kCell[cP];
            const kn = kCell[cN];
            eG[q] = (A * 2 * kp * kn) / ((kp + kn) * hm);
            ePos[4 * q] = Ae.diag[cP];
            ePos[4 * q + 1] = Ae.diag[cN];
            ePos[4 * q + 2] = findPos(Ae, cP, cN);
            ePos[4 * q + 3] = findPos(Ae, cN, cP);
            q++;
          }
    }
  }
  // external loss of solid cells on the domain boundary: half-cell conduction and h_ext in series
  const gExt = new Float64Array(N);
  let boundarySolid = 0;
  if (hExt > 0)
    for (let c = 0; c < N; c++) {
      if (type[c] !== SOLID) continue;
      const i = cellCoords[3 * c];
      const j = cellCoords[3 * c + 1];
      const k = cellCoords[3 * c + 2];
      const nb = (i === 0 ? 1 : 0) + (i === nx - 1 ? 1 : 0) + (j === 0 ? 1 : 0) + (j === ny - 1 ? 1 : 0) + (k === 0 ? 1 : 0) + (k === nz - 1 ? 1 : 0);
      if (!nb) continue;
      gExt[c] = (nb * A) / (1 / hExt + hm / 2 / kCell[c]);
      boundarySolid++;
    }
  let hasOpen = false;
  for (let c = 0; c < N && !hasOpen; c++) if (type[c] === OPEN) hasOpen = true;
  if (input !== 0 && boundarySolid === 0 && !hasOpen)
    throw new Error(
      'airflow: no heat path to ambient — the model needs openings or solid cells on the domain boundary (with externalH > 0).',
    );

  /* ------------------------------------------- state ------------------------------------------- */
  const T = new Float64Array(N).fill(Tamb);
  const Tprev = new Float64Array(N);
  const p = new Float64Array(N);
  const imb = new Float64Array(N); // net mass outflow of each cell through its flow faces (kg/s)
  const be = new Float64Array(N);
  const rp = new Float64Array(nP);
  const xp = new Float64Array(nP);
  const kwP = new KrylovWork();
  const kwE = new KrylovWork();
  let nFluid = 0;
  for (let c = 0; c < N; c++) if (type[c] !== SOLID) nFluid++;
  const hasFlow = nFluid > 0 && axes.some((F) => F.live.length > 0);
  const amgP = nP > 0 ? new AggregationAmg(Ap, pCoords, { theta: 0 }) : null;
  assembleEnergy(false); // conduction-only operator → aggregation by conductance contrast
  const amgE = new AggregationAmg(Ae, cellCoords, { theta: 0.02 });

  function computeImbalance(): void {
    imb.fill(0);
    for (const F of axes) {
      const { live, liveL, liveU, vel } = F;
      for (let q = 0; q < live.length; q++) {
        const m = rhoA * vel[live[q]];
        imb[liveL[q]] += m;
        imb[liveU[q]] -= m;
      }
    }
  }

  function assembleEnergy(withFlow: boolean): void {
    const val = Ae.val;
    val.fill(0);
    for (let q = 0; q < eFaceCount; q++) {
      const G = eG[q];
      let Fh = 0;
      if (withFlow) {
        const F = axes[eAx[q]];
        const s = F.state[eF[q]];
        if (s === ACTIVE || s === FIXED) Fh = rcpA * F.vel[eF[q]];
      }
      // hybrid differencing; face flux P→N = (a + Fh)·T_P − a·T_N
      const a = Math.max(-Fh, G - 0.5 * Fh, 0);
      const o = 4 * q;
      val[ePos[o]] += a + Fh;
      val[ePos[o + 1]] += a;
      val[ePos[o + 2]] -= a;
      val[ePos[o + 3]] -= a + Fh;
    }
    for (let c = 0; c < N; c++) {
      let d = gExt[c];
      let rhs = qCell[c] + gExt[c] * Tamb;
      if (withFlow) {
        const out = imb[c] * cp; // W/K of net advective outflow through the cell's faces
        if (type[c] === OPEN) {
          if (out < 0) d -= out; // air from the interior leaves to ambient at T_cell
          else rhs += out * Tamb; // ambient air enters at T_amb
        } else if (type[c] === FLUID && out < 0) d -= out; // stabilise an unconverged continuity error
      }
      const di = Ae.diag[c];
      val[di] += d;
      if (val[di] === 0) val[di] = 1e-12;
      be[c] = rhs;
    }
  }

  /** Energy update for the current flow; cycles > 0: stationary AMG cycles, else BiCGSTAB to `tol`. */
  function solveEnergy(tol: number, maxIter: number, cycles: number, alpha: number): number {
    computeImbalance();
    assembleEnergy(hasFlow);
    amgE.refresh();
    Tprev.set(T);
    if (cycles > 0) amgE.iterate(be, T, cycles);
    else {
      const r = bicgstab(Ae, be, T, amgE, tol, maxIter, kwE);
      if (!r.converged) amgE.iterate(be, T, maxIter);
    }
    let dTmax = 0;
    for (let c = 0; c < N; c++) {
      const tn = alpha === 1 ? T[c] : Tprev[c] + alpha * (T[c] - Tprev[c]);
      T[c] = tn;
      const dd = Math.abs(tn - Tprev[c]);
      if (dd > dTmax) dTmax = dd;
    }
    return dTmax;
  }

  function heatBalance(): { vents: number; walls: number; ventByOpening: Float64Array; inM: Float64Array; outM: Float64Array } {
    computeImbalance();
    let walls = 0;
    let vents = 0;
    const nO = openings.length;
    const ventByOpening = new Float64Array(nO);
    const inM = new Float64Array(nO);
    const outM = new Float64Array(nO);
    for (let c = 0; c < N; c++) {
      if (gExt[c] > 0) walls += gExt[c] * (T[c] - Tamb);
      if (type[c] !== OPEN) continue;
      const mIn = -imb[c]; // kg/s arriving from the interior (leaves to ambient)
      const o = openOf[c];
      if (mIn > 0) {
        const qv = mIn * cp * (T[c] - Tamb);
        vents += qv;
        ventByOpening[o] += qv;
        outM[o] += mIn / rho;
      } else inM[o] += -mIn / rho;
    }
    return { vents, walls, ventByOpening, inM, outM };
  }

  /* -------------------------------------------- momentum -------------------------------------------- */
  const alphaU = tun.alphaU;
  let pcgIts = 0;
  let momRes = 0;
  let momNorm = 0;

  function assembleMomentum(F: FaceAxis): void {
    const ax = F.ax;
    const { act, cellL, cellU, nbIdx, nbType, fluxIdx, aNb, aP, b, d, vel } = F;
    const v0 = axes[ax === 0 ? 1 : 0].vel;
    const v1 = axes[ax === 2 ? 1 : 2].vel;
    const dirT0 = 2 * (ax === 0 ? 1 : 0);
    const dirT1 = 2 * (ax === 2 ? 1 : 2);
    const gb = -rho * air.beta * gvec[ax] * V;
    const dNormLo = 2 * ax;
    const nA = act.length;
    const D = Dvisc;
    const halfRhoA = 0.5 * rhoA;
    for (let q = 0; q < nA; q++) {
      const uP = vel[act[q]];
      let apSum = 0;
      let bSum = 0;
      let unk = 0;
      let nbSum = 0;
      const o6 = q * 6;
      const o8 = q * 8;
      // upwind convection + full physical diffusion (aP ≥ ΣD > 0 even next to openings)
      for (let side = 0; side < 2; side++) {
        const o = o6 + dNormLo + side;
        const t = nbType[o];
        if (t === NB_FREE) {
          aNb[o] = 0;
          continue;
        }
        const vn = vel[nbIdx[o]];
        const Fl = halfRhoA * (uP + vn);
        const a = D + (side ? (Fl < 0 ? -Fl : 0) : Fl > 0 ? Fl : 0);
        apSum += a;
        if (t === NB_UNKNOWN) {
          aNb[o] = a;
          unk += a;
          nbSum += a * vn;
        } else {
          aNb[o] = 0;
          bSum += a * vn; // known neighbour: fixed fan face or wall-normal face (0)
        }
      }
      for (let slot = 0; slot < 2; slot++) {
        const vv = slot ? v1 : v0;
        const dbase = slot ? dirT1 : dirT0;
        for (let side = 0; side < 2; side++) {
          const o = o6 + dbase + side;
          const t = nbType[o];
          if (t === NB_FREE) {
            aNb[o] = 0;
            continue;
          }
          if (t === NB_TWALL) {
            aNb[o] = 0;
            apSum += 2 * D; // no-slip wall at half a cell
            continue;
          }
          const fo = o8 + slot * 4 + side * 2;
          const Fl = halfRhoA * (vv[fluxIdx[fo]] + vv[fluxIdx[fo + 1]]);
          const a = D + (side ? (Fl < 0 ? -Fl : 0) : Fl > 0 ? Fl : 0);
          const vn = vel[nbIdx[o]];
          apSum += a;
          if (t === NB_UNKNOWN) {
            aNb[o] = a;
            unk += a;
            nbSum += a * vn;
          } else {
            aNb[o] = 0;
            bSum += a * vn;
          }
        }
      }
      const cl = cellL[q];
      const cu = cellU[q];
      bSum += (p[cl] - p[cu]) * A + gb * (0.5 * (T[cl] + T[cu]) - Tamb);
      momRes += Math.abs(apSum * uP - nbSum - bSum);
      momNorm += Math.abs(apSum * uP);
      const apr = apSum / alphaU;
      aP[q] = apr;
      b[q] = bSum + (1 - alphaU) * apr * uP;
      d[q] = A / (apr - unk); // SIMPLEC
    }
  }

  function sweepMomentum(F: FaceAxis, forward: boolean): void {
    const { act, nbIdx, aNb, aP, b, vel } = F;
    const nA = act.length;
    for (let s = 0; s < nA; s++) {
      const q = forward ? s : nA - 1 - s;
      const o = q * 6;
      let acc = b[q];
      for (let dir = 0; dir < 6; dir++) {
        const a = aNb[o + dir];
        if (a !== 0) acc += a * vel[nbIdx[o + dir]];
      }
      vel[act[q]] = acc / aP[q];
    }
  }

  /** SIMPLEC pressure correction; returns Σ|mass imbalance| of the pressure cells before correction (kg/s). */
  function pressureCorrection(tol: number, maxIter: number): number {
    computeImbalance();
    let res = 0;
    for (let r = 0; r < nP; r++) {
      const m = imb[pCell[r]];
      rp[r] = -m;
      res += Math.abs(m);
    }
    if (!amgP) return res;
    const val = Ap.val;
    val.fill(0);
    for (const F of axes) {
      const nA = F.act.length;
      const { pLL, pUU, pLU, pUL, d } = F;
      for (let q = 0; q < nA; q++) {
        const cf = rhoA * d[q];
        if (pLL[q] >= 0) val[pLL[q]] += cf;
        if (pUU[q] >= 0) val[pUU[q]] += cf;
        if (pLU[q] >= 0) val[pLU[q]] -= cf;
        if (pUL[q] >= 0) val[pUL[q]] -= cf;
      }
    }
    for (let r = 0; r < nP; r++) if (val[Ap.diag[r]] === 0) val[Ap.diag[r]] = 1;
    amgP.refresh();
    xp.fill(0);
    const pr = pcg(Ap, rp, xp, amgP, tol, maxIter, kwP);
    pcgIts += pr.iterations;
    for (const F of axes) {
      const { act, cellL, cellU, d, vel } = F;
      for (let q = 0; q < act.length; q++) {
        const rl = pid[cellL[q]];
        const ru = pid[cellU[q]];
        vel[act[q]] += d[q] * ((rl >= 0 ? xp[rl] : 0) - (ru >= 0 ? xp[ru] : 0));
      }
    }
    const alphaP = tun.alphaP;
    for (let r = 0; r < nP; r++) p[pCell[r]] += alphaP * xp[r];
    return res;
  }

  /* --------------------------------------------- iterate --------------------------------------------- */
  solveEnergy(1e-8, 200, 0, 1);
  let iterations = 0;
  let converged = !hasFlow;
  let resMom = 0;
  let resMass = 0;
  let calm = 0;
  const dTHist: number[] = [];
  const progress = setup.onProgress;
  if (hasFlow) {
    for (let it = 1; it <= maxIt; it++) {
      iterations = it;
      momRes = 0;
      momNorm = 0;
      for (const F of axes) assembleMomentum(F);
      for (const F of axes) {
        sweepMomentum(F, true);
        sweepMomentum(F, false);
      }
      const massRes = pressureCorrection(tun.pressureTol, tun.pressureMaxIt);
      let flux = 0;
      for (const F of axes) {
        const { live, vel } = F;
        for (let q = 0; q < live.length; q++) flux += Math.abs(vel[live[q]]);
      }
      const massScale = rhoA * flux;
      resMass = massScale > 0 ? massRes / massScale : 0;
      resMom = momNorm > 0 ? momRes / momNorm : 0;
      const dT = solveEnergy(tun.energyTol, tun.energyMaxIt, tun.energyCycles, it <= 3 ? 1 : tun.alphaT);
      let Tmax = Tamb;
      for (let c = 0; c < N; c++) if (T[c] > Tmax) Tmax = T[c];
      const dTrel = dT / Math.max(Tmax - Tamb, 1);
      // remaining drift estimated from the geometric decay of the temperature updates
      dTHist.push(dTrel);
      let drift = Infinity;
      const W = 20;
      if (dTHist.length > W) {
        const prev = dTHist[dTHist.length - 1 - W];
        const rate = prev > 0 ? Math.pow(Math.max(dTrel, 1e-300) / prev, 1 / W) : 0;
        drift = rate < 0.999 ? (dTrel * rate) / (1 - rate) : Infinity;
        if (dTrel < 1e-7) drift = dTrel;
      }
      const tinyFlow = massScale < 1e-14;
      const ok = (tinyFlow || (resMom < tun.momTol && resMass < tun.massTol)) && drift < tun.driftTol;
      calm = ok ? calm + 1 : 0;
      tun.trace?.({ it, resMom, resMass, dTrel, drift, Tmax, pcgIts });
      if (progress && it % 5 === 0) progress(Math.min(0.95, Math.max(it / maxIt, Math.min(1, -Math.log10(Math.max(drift, 1e-12)) / 3))));
      if (calm >= 3 && it >= 10) {
        converged = true;
        break;
      }
    }
    // exact projection (divergence-free face fluxes)
    momRes = 0;
    momNorm = 0;
    for (const F of axes) assembleMomentum(F);
    resMom = momNorm > 0 ? momRes / momNorm : 0;
    pressureCorrection(1e-10, 500);
  }
  solveEnergy(1e-10, 400, 0, 1);
  computeImbalance();
  let finalMass = 0;
  let finalFlux = 0;
  for (let c = 0; c < N; c++) if (type[c] === FLUID) finalMass += Math.abs(imb[c]);
  for (const F of axes) for (let q = 0; q < F.live.length; q++) finalFlux += rhoA * Math.abs(F.vel[F.live[q]]);
  const hb = heatBalance();
  const balErr = Math.abs(input - hb.vents - hb.walls) / Math.max(Math.abs(input), 1e-9);
  progress?.(1);

  /* --------------------------------------------- outputs --------------------------------------------- */
  const temperature = new Float32Array(N);
  const velocity = new Float32Array(3 * N);
  let maxAir = -Infinity;
  let sumAir = 0;
  let nAir = 0;
  let maxSolid = -Infinity;
  let maxVel = 0;
  const centre = (F: FaceAxis, i: number, j: number, k: number): number => {
    const ax = F.ax;
    const f0 = faceIndex(ax, i, j, k);
    const f1 = faceIndex(ax, i + (ax === 0 ? 1 : 0), j + (ax === 1 ? 1 : 0), k + (ax === 2 ? 1 : 0));
    const s0 = F.state[f0];
    const s1 = F.state[f1];
    const l0 = s0 === ACTIVE || s0 === FIXED;
    const l1 = s1 === ACTIVE || s1 === FIXED;
    if (l0 && l1) return 0.5 * (F.vel[f0] + F.vel[f1]);
    if (l0) return s1 === FREE ? F.vel[f0] : 0.5 * F.vel[f0];
    if (l1) return s0 === FREE ? F.vel[f1] : 0.5 * F.vel[f1];
    return 0;
  };
  for (let c = 0; c < N; c++) {
    temperature[c] = T[c];
    if (type[c] === SOLID) {
      if (T[c] > maxSolid) maxSolid = T[c];
      continue;
    }
    if (T[c] > maxAir) maxAir = T[c];
    sumAir += T[c];
    nAir++;
    const i = cellCoords[3 * c];
    const j = cellCoords[3 * c + 1];
    const k = cellCoords[3 * c + 2];
    const u = centre(axes[0], i, j, k);
    const v = centre(axes[1], i, j, k);
    const w = centre(axes[2], i, j, k);
    velocity[3 * c] = u;
    velocity[3 * c + 1] = v;
    velocity[3 * c + 2] = w;
    maxVel = Math.max(maxVel, Math.hypot(u, v, w));
  }
  if (!nAir) {
    maxAir = Tamb;
    sumAir = Tamb;
    nAir = 1;
  }
  if (!Number.isFinite(maxSolid)) maxSolid = Tamb;

  const components = sources.map((s, si) => {
    let tmax = -Infinity;
    for (let q = 0; q < s.cells.length; q++) {
      const c = s.cells[q];
      if (Number.isInteger(c) && c >= 0 && c < N && T[c] > tmax) tmax = T[c];
    }
    return {
      componentId: s.componentId ?? `source-${si}`,
      ref: s.ref ?? s.componentId ?? `Q${si + 1}`,
      power: s.power,
      temperature: Number.isFinite(tmax) ? tmax : Tamb,
    };
  });
  const vents = openings.map((o, oi) => {
    const net = hb.outM[oi] - hb.inM[oi];
    return {
      name: o.name,
      flowM3s: Math.abs(net),
      direction: (net >= 0 ? 'out' : 'in') as 'in' | 'out',
      inM3s: hb.inM[oi],
      outM3s: hb.outM[oi],
      heatW: hb.ventByOpening[oi],
    };
  });

  // streamlines (mm): seeds at inflowing opening cells, fans and the hottest air next to heat sources
  const inflow: { c: number; m: number }[] = [];
  for (let c = 0; c < N; c++) if (type[c] === OPEN && imb[c] > 0) inflow.push({ c, m: imb[c] });
  inflow.sort((a, b) => b.m - a.m);
  const hot: { c: number; t: number }[] = [];
  for (let c = 0; c < N; c++) {
    if (type[c] === SOLID) continue;
    const i = cellCoords[3 * c];
    const j = cellCoords[3 * c + 1];
    const k = cellCoords[3 * c + 2];
    if (
      (i > 0 && qCell[c - 1] > 0) ||
      (i < nx - 1 && qCell[c + 1] > 0) ||
      (j > 0 && qCell[c - nx] > 0) ||
      (j < ny - 1 && qCell[c + nx] > 0) ||
      (k > 0 && qCell[c - NXY] > 0) ||
      (k < nz - 1 && qCell[c + NXY] > 0)
    )
      hot.push({ c, t: T[c] });
  }
  hot.sort((a, b) => b.t - a.t);
  const streamlines =
    hasFlow && maxVel > 0
      ? traceStreamlines(
          { nx, ny, nz, h, origin: grid.origin, solid: (c) => type[c] === SOLID, u: axes[0].vel, v: axes[1].vel, w: axes[2].vel },
          { inflow: inflow.map((x) => x.c), fans: fanSeeds, hot: hot.map((x) => x.c) },
          40,
          maxVel,
        )
      : [];

  if (!converged && hasFlow)
    warnings.push(
      `Airflow did not fully converge in ${iterations} iterations (momentum residual ${resMom.toExponential(1)}, ` +
        `continuity ${resMass.toExponential(1)}); buoyant flows can be genuinely unsteady — treat results as approximate.`,
    );

  return {
    kind: 'airflow',
    mode,
    ambient: Tamb,
    grid: { nx, ny, nz, h, origin: [grid.origin[0], grid.origin[1], grid.origin[2]] },
    cells: pack(Uint8Array.from(grid.cells), 'u8'),
    temperature: pack(temperature, 'f32'),
    velocity: pack(velocity, 'f32'),
    streamlines,
    components,
    vents,
    maxAirTemp: maxAir,
    meanAirTemp: sumAir / nAir,
    maxSolidTemp: maxSolid,
    heatBalance: { input, vents: hb.vents, walls: hb.walls },
    iterations,
    converged,
    residuals: { continuity: finalFlux > 0 ? finalMass / finalFlux : 0, momentum: resMom, energyBalance: balErr },
    air: { ...air },
    maxVelocity: maxVel,
    warnings,
    wallMs: now() - t0,
  };
}
