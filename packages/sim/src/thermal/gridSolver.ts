/**
 * Structured-grid sparse SPD solver for the PCB conduction model.
 *
 * The system has M nodes per active cell of an nx × ny grid (one node per lumped copper
 * layer group), coupled
 *   - in plane to the same node m of the 4 neighbouring cells (conductances gE / gN), and
 *   - through the board to node m±1 of the same cell (conductance gZ).
 * Every cell's diagonal additionally carries boundary terms (convection / radiation).
 *
 * Solver: conjugate gradients preconditioned with one symmetric multigrid V-cycle.
 *   - Coarsening: unsmoothed 2×2 aggregation of cells (each layer node aggregated separately),
 *     Galerkin coarse operators Pᵀ A P. With piecewise-constant P the coarse operator keeps the
 *     exact same 5-point-per-layer + column structure, so every level reuses the same kernels,
 *     and irregular board outlines (masked cells) are handled exactly.
 *   - Smoother: column-block Gauss–Seidel (each cell's M×M tridiagonal column solved exactly,
 *     which handles the strong through-plane coupling of vias and of coarse levels).
 *     Forward sweep before, backward sweep after the coarse correction, so the preconditioner
 *     is symmetric positive definite and plain PCG applies.
 *   - Coarsest level (≤ ~400 unknowns): dense Cholesky.
 *
 * Pure TypeScript, no Node built-ins (browser and worker safe).
 */

/** Structured SPD system description (all arrays indexed by active cell `c`, node `m`). */
export interface GridSystem {
  nx: number;
  ny: number;
  /** Nodes per cell (≥ 1). */
  M: number;
  /** Row-major grid cell (j*nx + i) → active cell index, or −1 when the cell is not an unknown. */
  cellOf: Int32Array;
  /** Number of active cells. */
  n: number;
  /** Coupling of node (c,m) to node (east(c),m); length n*M (0 when there is no east neighbour). */
  gE: Float64Array;
  /** Coupling of node (c,m) to node (north(c),m); length n*M. */
  gN: Float64Array;
  /** Coupling between nodes (c,m) and (c,m+1); length n*(M−1). */
  gZ: Float64Array;
  /** Full diagonal (sum of all couplings + boundary terms); length n*M. Must make the system SPD. */
  diag: Float64Array;
}

export interface GridSolveOptions {
  /** Relative residual target ‖b − Ax‖ / ‖b‖ (default 1e-8). */
  tol?: number;
  /** Maximum PCG iterations (default 500). */
  maxIter?: number;
}

export interface GridSolveStats {
  iterations: number;
  /** Final relative residual. */
  residual: number;
  converged: boolean;
  levels: number;
}

interface Level {
  nx: number;
  ny: number;
  M: number;
  n: number;
  cellOf: Int32Array;
  east: Int32Array;
  west: Int32Array;
  north: Int32Array;
  south: Int32Array;
  gE: Float64Array;
  gN: Float64Array;
  gZ: Float64Array;
  diag: Float64Array;
  /** Column Thomas factors: inverse pivots and multipliers (n*M each). */
  invPiv: Float64Array;
  mult: Float64Array;
  /** active cell -> parent active cell on the next coarser level. */
  parent?: Int32Array;
  /** Work vectors. */
  b: Float64Array;
  x: Float64Array;
  res: Float64Array;
  /** Dense Cholesky factor (lower, row-major) for the coarsest level. */
  chol?: Float64Array;
}

const COARSEST_UNKNOWNS = 400;

function neighbours(nx: number, ny: number, cellOf: Int32Array, n: number) {
  const east = new Int32Array(n).fill(-1);
  const west = new Int32Array(n).fill(-1);
  const north = new Int32Array(n).fill(-1);
  const south = new Int32Array(n).fill(-1);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = cellOf[j * nx + i];
      if (c < 0) continue;
      if (i + 1 < nx) {
        const e = cellOf[j * nx + i + 1];
        if (e >= 0) {
          east[c] = e;
          west[e] = c;
        }
      }
      if (j + 1 < ny) {
        const t = cellOf[(j + 1) * nx + i];
        if (t >= 0) {
          north[c] = t;
          south[t] = c;
        }
      }
    }
  }
  return { east, west, north, south };
}

function makeLevel(sys: GridSystem): Level {
  const { nx, ny, M, n } = sys;
  const nb = neighbours(nx, ny, sys.cellOf, n);
  // Zero couplings that point to non-existent neighbours (defensive).
  for (let c = 0; c < n; c++) {
    if (nb.east[c] < 0) for (let m = 0; m < M; m++) sys.gE[c * M + m] = 0;
    if (nb.north[c] < 0) for (let m = 0; m < M; m++) sys.gN[c * M + m] = 0;
  }
  const lvl: Level = {
    nx,
    ny,
    M,
    n,
    cellOf: sys.cellOf,
    ...nb,
    gE: sys.gE,
    gN: sys.gN,
    gZ: sys.gZ,
    diag: sys.diag,
    invPiv: new Float64Array(n * M),
    mult: new Float64Array(n * M),
    b: new Float64Array(n * M),
    x: new Float64Array(n * M),
    res: new Float64Array(n * M),
  };
  factorColumns(lvl);
  return lvl;
}

/** Thomas (LDLᵀ) factorisation of every cell's tridiagonal column block. */
function factorColumns(l: Level): void {
  const { n, M, diag, gZ, invPiv, mult } = l;
  const Mz = M - 1;
  for (let c = 0; c < n; c++) {
    const base = c * M;
    let piv = diag[base];
    if (!(piv > 0)) throw new Error('thermal solver: non-positive diagonal (system not SPD)');
    invPiv[base] = 1 / piv;
    mult[base] = 0;
    for (let m = 1; m < M; m++) {
      const e = -gZ[c * Mz + m - 1];
      const lm = e / piv;
      piv = diag[base + m] - lm * e;
      if (!(piv > 0)) throw new Error('thermal solver: column block not positive definite');
      mult[base + m] = lm;
      invPiv[base + m] = 1 / piv;
    }
  }
}

/** Galerkin coarsening by 2×2 cell aggregation. Returns the coarse system and the parent map. */
function coarsen(l: Level): { sys: GridSystem; parent: Int32Array } {
  const { nx, ny, M, n } = l;
  const fx = nx > 1 ? 2 : 1;
  const fy = ny > 1 ? 2 : 1;
  const ncx = Math.ceil(nx / fx);
  const ncy = Math.ceil(ny / fy);
  const cellOf = new Int32Array(ncx * ncy).fill(-1);
  const fineI = new Int32Array(n);
  const fineJ = new Int32Array(n);
  const fineCellOf = l.cellOf;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = fineCellOf[j * nx + i];
      if (c < 0) continue;
      fineI[c] = i;
      fineJ[c] = j;
      const k = ((j / fy) | 0) * ncx + ((i / fx) | 0);
      cellOf[k] = 0;
    }
  let nc = 0;
  for (let k = 0; k < ncx * ncy; k++) if (cellOf[k] === 0) cellOf[k] = nc++;
  const parent = new Int32Array(n);
  for (let c = 0; c < n; c++) parent[c] = cellOf[((fineJ[c] / fy) | 0) * ncx + ((fineI[c] / fx) | 0)];
  const Mz = M - 1;
  const gE = new Float64Array(nc * M);
  const gN = new Float64Array(nc * M);
  const gZ = new Float64Array(nc * Math.max(Mz, 0));
  const diag = new Float64Array(nc * M);
  for (let c = 0; c < n; c++) {
    const P = parent[c];
    const pb = P * M;
    const cb = c * M;
    for (let m = 0; m < M; m++) diag[pb + m] += l.diag[cb + m];
    for (let m = 0; m < Mz; m++) gZ[P * Mz + m] += l.gZ[c * Mz + m];
    const e = l.east[c];
    if (e >= 0) {
      if (parent[e] === P) for (let m = 0; m < M; m++) diag[pb + m] -= 2 * l.gE[cb + m];
      else for (let m = 0; m < M; m++) gE[pb + m] += l.gE[cb + m];
    }
    const t = l.north[c];
    if (t >= 0) {
      if (parent[t] === P) for (let m = 0; m < M; m++) diag[pb + m] -= 2 * l.gN[cb + m];
      else for (let m = 0; m < M; m++) gN[pb + m] += l.gN[cb + m];
    }
  }
  return { sys: { nx: ncx, ny: ncy, M, cellOf, n: nc, gE, gN, gZ, diag }, parent };
}

/** y = A x for M = 2. */
function matvec2(l: Level, x: Float64Array, y: Float64Array): void {
  const { n, diag, gE, gN, gZ, east, west, north, south } = l;
  for (let c = 0; c < n; c++) {
    const base = c << 1;
    const x0 = x[base];
    const x1 = x[base + 1];
    const gz = gZ[c];
    let y0 = diag[base] * x0 - gz * x1;
    let y1 = diag[base + 1] * x1 - gz * x0;
    let k = east[c];
    if (k >= 0) {
      y0 -= gE[base] * x[k << 1];
      y1 -= gE[base + 1] * x[(k << 1) + 1];
    }
    k = west[c];
    if (k >= 0) {
      const kb = k << 1;
      y0 -= gE[kb] * x[kb];
      y1 -= gE[kb + 1] * x[kb + 1];
    }
    k = north[c];
    if (k >= 0) {
      y0 -= gN[base] * x[k << 1];
      y1 -= gN[base + 1] * x[(k << 1) + 1];
    }
    k = south[c];
    if (k >= 0) {
      const kb = k << 1;
      y0 -= gN[kb] * x[kb];
      y1 -= gN[kb + 1] * x[kb + 1];
    }
    y[base] = y0;
    y[base + 1] = y1;
  }
}

/** y = A x on one level. */
function matvec(l: Level, x: Float64Array, y: Float64Array): void {
  if (l.M === 2) {
    matvec2(l, x, y);
    return;
  }
  const { n, M, diag, gE, gN, gZ, east, north } = l;
  const Mz = M - 1;
  for (let c = 0; c < n; c++) {
    const base = c * M;
    for (let m = 0; m < M; m++) y[base + m] = diag[base + m] * x[base + m];
    for (let m = 0; m < Mz; m++) {
      const g = gZ[c * Mz + m];
      y[base + m] -= g * x[base + m + 1];
      y[base + m + 1] -= g * x[base + m];
    }
  }
  for (let c = 0; c < n; c++) {
    const base = c * M;
    const e = east[c];
    if (e >= 0) {
      const eb = e * M;
      for (let m = 0; m < M; m++) {
        const g = gE[base + m];
        y[base + m] -= g * x[eb + m];
        y[eb + m] -= g * x[base + m];
      }
    }
    const t = north[c];
    if (t >= 0) {
      const tb = t * M;
      for (let m = 0; m < M; m++) {
        const g = gN[base + m];
        y[base + m] -= g * x[tb + m];
        y[tb + m] -= g * x[base + m];
      }
    }
  }
}

/** One column-block Gauss–Seidel relaxation of cell c (in place). */
function relaxCell(l: Level, c: number, b: Float64Array, x: Float64Array, t: Float64Array): void {
  const { M, gE, gN, gZ, east, west, north, south, invPiv, mult } = l;
  const base = c * M;
  for (let m = 0; m < M; m++) t[m] = b[base + m];
  const e = east[c];
  if (e >= 0) for (let m = 0; m < M; m++) t[m] += gE[base + m] * x[e * M + m];
  const w = west[c];
  if (w >= 0) for (let m = 0; m < M; m++) t[m] += gE[w * M + m] * x[w * M + m];
  const nn = north[c];
  if (nn >= 0) for (let m = 0; m < M; m++) t[m] += gN[base + m] * x[nn * M + m];
  const s = south[c];
  if (s >= 0) for (let m = 0; m < M; m++) t[m] += gN[s * M + m] * x[s * M + m];
  if (M === 1) {
    x[base] = t[0] * invPiv[base];
    return;
  }
  // Thomas solve: forward elimination (multipliers), back substitution.
  const Mz = M - 1;
  for (let m = 1; m < M; m++) t[m] -= mult[base + m] * t[m - 1];
  let xm = t[M - 1] * invPiv[base + M - 1];
  x[base + M - 1] = xm;
  for (let m = M - 2; m >= 0; m--) {
    // e_m = −gZ(m, m+1)
    xm = (t[m] + gZ[c * Mz + m] * xm) * invPiv[base + m];
    x[base + m] = xm;
  }
}

/** Specialised column relaxation for M = 2 (the default top/bottom model). */
function relaxCell2(l: Level, c: number, b: Float64Array, x: Float64Array): void {
  const { gE, gN, gZ, east, west, north, south, invPiv, mult } = l;
  const base = c << 1;
  let t0 = b[base];
  let t1 = b[base + 1];
  let k = east[c];
  if (k >= 0) {
    t0 += gE[base] * x[k << 1];
    t1 += gE[base + 1] * x[(k << 1) + 1];
  }
  k = west[c];
  if (k >= 0) {
    const kb = k << 1;
    t0 += gE[kb] * x[kb];
    t1 += gE[kb + 1] * x[kb + 1];
  }
  k = north[c];
  if (k >= 0) {
    t0 += gN[base] * x[k << 1];
    t1 += gN[base + 1] * x[(k << 1) + 1];
  }
  k = south[c];
  if (k >= 0) {
    const kb = k << 1;
    t0 += gN[kb] * x[kb];
    t1 += gN[kb + 1] * x[kb + 1];
  }
  t1 -= mult[base + 1] * t0;
  const x1 = t1 * invPiv[base + 1];
  x[base + 1] = x1;
  x[base] = (t0 + gZ[c] * x1) * invPiv[base];
}

function gsForward(l: Level, b: Float64Array, x: Float64Array, t: Float64Array): void {
  if (l.M === 2) for (let c = 0; c < l.n; c++) relaxCell2(l, c, b, x);
  else for (let c = 0; c < l.n; c++) relaxCell(l, c, b, x, t);
}

function gsBackward(l: Level, b: Float64Array, x: Float64Array, t: Float64Array): void {
  if (l.M === 2) for (let c = l.n - 1; c >= 0; c--) relaxCell2(l, c, b, x);
  else for (let c = l.n - 1; c >= 0; c--) relaxCell(l, c, b, x, t);
}

function denseCholesky(l: Level): Float64Array {
  const { n, M, diag, gE, gN, gZ, east, north } = l;
  const N = n * M;
  const A = new Float64Array(N * N);
  const Mz = M - 1;
  for (let c = 0; c < n; c++) {
    const base = c * M;
    for (let m = 0; m < M; m++) A[(base + m) * N + base + m] = diag[base + m];
    for (let m = 0; m < Mz; m++) {
      const g = gZ[c * Mz + m];
      A[(base + m) * N + base + m + 1] -= g;
      A[(base + m + 1) * N + base + m] -= g;
    }
    const e = east[c];
    if (e >= 0)
      for (let m = 0; m < M; m++) {
        A[(base + m) * N + e * M + m] -= gE[base + m];
        A[(e * M + m) * N + base + m] -= gE[base + m];
      }
    const t = north[c];
    if (t >= 0)
      for (let m = 0; m < M; m++) {
        A[(base + m) * N + t * M + m] -= gN[base + m];
        A[(t * M + m) * N + base + m] -= gN[base + m];
      }
  }
  // In-place Cholesky (lower triangle).
  for (let j = 0; j < N; j++) {
    let s = A[j * N + j];
    for (let k = 0; k < j; k++) s -= A[j * N + k] * A[j * N + k];
    if (!(s > 0)) throw new Error('thermal solver: coarse operator not positive definite');
    const d = Math.sqrt(s);
    A[j * N + j] = d;
    for (let i = j + 1; i < N; i++) {
      let v = A[i * N + j];
      for (let k = 0; k < j; k++) v -= A[i * N + k] * A[j * N + k];
      A[i * N + j] = v / d;
    }
  }
  return A;
}

function choleskySolve(L: Float64Array, N: number, b: Float64Array, x: Float64Array): void {
  for (let i = 0; i < N; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * N + k] * x[k];
    x[i] = s / L[i * N + i];
  }
  for (let i = N - 1; i >= 0; i--) {
    let s = x[i];
    for (let k = i + 1; k < N; k++) s -= L[k * N + i] * x[k];
    x[i] = s / L[i * N + i];
  }
}

/**
 * Multigrid hierarchy + PCG for a {@link GridSystem}. Build once per matrix; `solve` may be called
 * repeatedly with different right-hand sides / initial guesses.
 */
export class GridMultigrid {
  readonly levels: Level[] = [];
  private readonly colTmp: Float64Array;

  constructor(sys: GridSystem) {
    if (sys.M < 1) throw new Error('thermal solver: M must be ≥ 1');
    let lvl = makeLevel(sys);
    this.levels.push(lvl);
    while (lvl.n * lvl.M > COARSEST_UNKNOWNS && (lvl.nx > 1 || lvl.ny > 1)) {
      const { sys: cs, parent } = coarsen(lvl);
      lvl.parent = parent;
      const next = makeLevel(cs);
      this.levels.push(next);
      lvl = next;
    }
    lvl.chol = denseCholesky(lvl);
    this.colTmp = new Float64Array(sys.M);
  }

  /** Number of unknowns on the finest level. */
  get size(): number {
    return this.levels[0].n * this.levels[0].M;
  }

  /** y = A x (finest level). */
  multiply(x: Float64Array, y: Float64Array): void {
    matvec(this.levels[0], x, y);
  }

  /** z = B r: one symmetric V-cycle with zero initial guess. */
  precondition(r: Float64Array, z: Float64Array): void {
    this.vcycle(0, r, z);
  }

  private vcycle(k: number, b: Float64Array, x: Float64Array): void {
    const l = this.levels[k];
    x.fill(0);
    if (l.chol) {
      choleskySolve(l.chol, l.n * l.M, b, x);
      return;
    }
    const t = this.colTmp;
    gsForward(l, b, x, t);
    // residual
    const res = l.res;
    matvec(l, x, res);
    for (let i = 0; i < res.length; i++) res[i] = b[i] - res[i];
    const c = this.levels[k + 1];
    const M = l.M;
    const parent = l.parent!;
    const cb = c.b;
    cb.fill(0);
    for (let i = 0; i < l.n; i++) {
      const P = parent[i] * M;
      const base = i * M;
      for (let m = 0; m < M; m++) cb[P + m] += res[base + m];
    }
    this.vcycle(k + 1, cb, c.x);
    const cx = c.x;
    for (let i = 0; i < l.n; i++) {
      const P = parent[i] * M;
      const base = i * M;
      for (let m = 0; m < M; m++) x[base + m] += cx[P + m];
    }
    gsBackward(l, b, x, t);
  }

  /**
   * Solve A x = b with MG-preconditioned conjugate gradients. `x` holds the initial guess on entry
   * (warm start) and the solution on exit.
   */
  solve(b: Float64Array, x: Float64Array, opts: GridSolveOptions = {}): GridSolveStats {
    const tol = opts.tol ?? 1e-8;
    const maxIter = opts.maxIter ?? 500;
    const N = this.size;
    const r = new Float64Array(N);
    const z = new Float64Array(N);
    const p = new Float64Array(N);
    const Ap = new Float64Array(N);
    let bn = 0;
    for (let i = 0; i < N; i++) bn += b[i] * b[i];
    bn = Math.sqrt(bn);
    if (bn === 0) {
      x.fill(0);
      return { iterations: 0, residual: 0, converged: true, levels: this.levels.length };
    }
    this.multiply(x, r);
    let rn = 0;
    for (let i = 0; i < N; i++) {
      r[i] = b[i] - r[i];
      rn += r[i] * r[i];
    }
    rn = Math.sqrt(rn);
    if (rn <= tol * bn) return { iterations: 0, residual: rn / bn, converged: true, levels: this.levels.length };
    this.precondition(r, z);
    p.set(z);
    let rz = 0;
    for (let i = 0; i < N; i++) rz += r[i] * z[i];
    let it = 0;
    let rel = rn / bn;
    while (it < maxIter) {
      it++;
      this.multiply(p, Ap);
      let pAp = 0;
      for (let i = 0; i < N; i++) pAp += p[i] * Ap[i];
      if (!(pAp > 0)) break;
      const alpha = rz / pAp;
      rn = 0;
      for (let i = 0; i < N; i++) {
        x[i] += alpha * p[i];
        r[i] -= alpha * Ap[i];
        rn += r[i] * r[i];
      }
      rel = Math.sqrt(rn) / bn;
      if (rel <= tol) break;
      this.precondition(r, z);
      let rzNew = 0;
      for (let i = 0; i < N; i++) rzNew += r[i] * z[i];
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < N; i++) p[i] = z[i] + beta * p[i];
    }
    // True residual (guards against drift in the recurrence).
    this.multiply(x, Ap);
    let tn = 0;
    for (let i = 0; i < N; i++) {
      const d = b[i] - Ap[i];
      tn += d * d;
    }
    rel = Math.sqrt(tn) / bn;
    return { iterations: it, residual: rel, converged: rel <= tol * 10, levels: this.levels.length };
  }
}
