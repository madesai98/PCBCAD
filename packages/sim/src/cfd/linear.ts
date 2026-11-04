/**
 * Sparse linear algebra for the CFD solver: CSR matrices, a geometric-aggregation algebraic multigrid
 * preconditioner and the Krylov solvers PCG (symmetric pressure equation) and BiCGSTAB (energy equation
 * with advection).
 *
 * Aggregation: unknowns live on voxel cells (i, j, k). Each level groups the unknowns of a 2×2×2 block
 * of cells into aggregates = connected components of the *strong* couplings inside the block
 * (|a_ij| ≥ θ·√(a_ii a_jj)); cells separated by a wall or by a large conductivity contrast are kept in
 * separate aggregates. Coarse operators are piecewise-constant Galerkin products Rᵀ A R. The aggregation
 * and the coarse sparsity patterns are built once; `refresh()` recomputes all coarse values from the
 * current fine values in O(nnz) through stored index maps, which suits SIMPLE iterations where the
 * matrices change every iteration but their pattern never does.
 * Smoother: Gauss–Seidel (forward before, backward after the coarse correction → symmetric V-cycle for
 * symmetric A). Coarsest level: dense LU with partial pivoting.
 */

export interface Csr {
  n: number;
  ptr: Int32Array;
  col: Int32Array;
  val: Float64Array;
  /** Position of the diagonal entry of each row. */
  diag: Int32Array;
}

/** Build a CSR pattern (values zero) from per-row column lists; the diagonal is always included. */
export function csrFromRows(n: number, rows: (row: number, push: (col: number) => void) => void): Csr {
  const ptr = new Int32Array(n + 1);
  const cols: number[] = [];
  const diag = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const start = cols.length;
    cols.push(i);
    rows(i, (c) => {
      for (let q = start; q < cols.length; q++) if (cols[q] === c) return;
      cols.push(c);
    });
    // keep columns sorted for cache-friendly GS
    const seg = cols.slice(start).sort((a, b) => a - b);
    for (let q = 0; q < seg.length; q++) {
      cols[start + q] = seg[q];
      if (seg[q] === i) diag[i] = start + q;
    }
    ptr[i + 1] = cols.length;
  }
  return { n, ptr, col: Int32Array.from(cols), val: new Float64Array(cols.length), diag };
}

/** y = A x */
export function csrMul(A: Csr, x: Float64Array, y: Float64Array): void {
  const { n, ptr, col, val } = A;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = ptr[i], e = ptr[i + 1]; k < e; k++) s += val[k] * x[col[k]];
    y[i] = s;
  }
}

interface AmgLevel {
  A: Csr;
  /** Fine → aggregate (coarse unknown) map; undefined on the coarsest level. */
  agg?: Int32Array;
  /** Fine nnz → coarse nnz position. */
  nzMap?: Int32Array;
  x: Float64Array;
  b: Float64Array;
  r: Float64Array;
}

export interface AmgOptions {
  /** Strength threshold θ (default 0.05). */
  theta?: number;
  /** Coarsest-level size for the dense direct solve (default 400). */
  coarseSize?: number;
  /** Gauss–Seidel sweeps before and after the coarse correction (default 1). */
  sweeps?: number;
  maxLevels?: number;
}

export class AggregationAmg {
  readonly levels: AmgLevel[] = [];
  private lu!: Float64Array;
  private piv!: Int32Array;
  private readonly sweeps: number;

  /**
   * @param A fine matrix (its values are read on every `refresh()`; pattern must not change)
   * @param coords 3 ints per unknown: cell coordinates (i, j, k)
   */
  constructor(A: Csr, coords: Int32Array, opts: AmgOptions = {}) {
    const theta = opts.theta ?? 0.05;
    const coarseSize = opts.coarseSize ?? 400;
    const maxLevels = opts.maxLevels ?? 16;
    this.sweeps = opts.sweeps ?? 1;
    let cur: AmgLevel = { A, x: new Float64Array(A.n), b: new Float64Array(A.n), r: new Float64Array(A.n) };
    this.levels.push(cur);
    let cc = coords;
    while (cur.A.n > coarseSize && this.levels.length < maxLevels) {
      const { agg, nc, coarseCoords } = aggregate(cur.A, cc, theta);
      if (nc > 0.85 * cur.A.n) break; // no useful coarsening left
      const { Ac, nzMap } = galerkinPattern(cur.A, agg, nc);
      cur.agg = agg;
      cur.nzMap = nzMap;
      cur = { A: Ac, x: new Float64Array(nc), b: new Float64Array(nc), r: new Float64Array(nc) };
      this.levels.push(cur);
      cc = coarseCoords;
    }
    this.refresh();
  }

  /** Recompute all coarse operators (and the coarsest factorisation) from the current fine values. */
  refresh(): void {
    for (let l = 0; l + 1 < this.levels.length; l++) {
      const F = this.levels[l];
      const C = this.levels[l + 1].A;
      C.val.fill(0);
      const map = F.nzMap!;
      const fv = F.A.val;
      for (let k = 0; k < fv.length; k++) C.val[map[k]] += fv[k];
    }
    this.factorCoarsest();
  }

  private factorCoarsest(): void {
    const A = this.levels[this.levels.length - 1].A;
    const n = A.n;
    const M = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let k = A.ptr[i]; k < A.ptr[i + 1]; k++) M[i * n + A.col[k]] += A.val[k];
    const piv = new Int32Array(n);
    let maxAbs = 0;
    for (let i = 0; i < n * n; i++) maxAbs = Math.max(maxAbs, Math.abs(M[i]));
    const tiny = 1e-14 * (maxAbs || 1);
    for (let c = 0; c < n; c++) {
      let p = c;
      let best = Math.abs(M[c * n + c]);
      for (let r = c + 1; r < n; r++) {
        const v = Math.abs(M[r * n + c]);
        if (v > best) {
          best = v;
          p = r;
        }
      }
      piv[c] = p;
      if (p !== c) for (let j = 0; j < n; j++) [M[c * n + j], M[p * n + j]] = [M[p * n + j], M[c * n + j]];
      if (Math.abs(M[c * n + c]) < tiny) M[c * n + c] = tiny; // singular direction (e.g. pure Neumann)
      const d = M[c * n + c];
      for (let r = c + 1; r < n; r++) {
        const f = (M[r * n + c] /= d);
        if (f === 0) continue;
        for (let j = c + 1; j < n; j++) M[r * n + j] -= f * M[c * n + j];
      }
    }
    this.lu = M;
    this.piv = piv;
  }

  private solveCoarsest(b: Float64Array, x: Float64Array): void {
    const n = b.length;
    const M = this.lu;
    x.set(b);
    for (let c = 0; c < n; c++) {
      const p = this.piv[c];
      if (p !== c) [x[c], x[p]] = [x[p], x[c]];
    }
    for (let r = 0; r < n; r++) {
      let s = x[r];
      for (let j = 0; j < r; j++) s -= M[r * n + j] * x[j];
      x[r] = s;
    }
    for (let r = n - 1; r >= 0; r--) {
      let s = x[r];
      for (let j = r + 1; j < n; j++) s -= M[r * n + j] * x[j];
      x[r] = s / M[r * n + r];
    }
  }

  /** z = M⁻¹ r (one V-cycle from a zero initial guess). */
  apply(r: Float64Array, z: Float64Array): void {
    this.vcycle(0, r, z);
  }

  private wr?: Float64Array;
  private wz?: Float64Array;

  /**
   * Stationary multigrid iteration x ← x + M⁻¹(b − A x), `cycles` times. Monotone and robust for the
   * diagonally dominant M-matrices of upwinded transport equations. Returns ‖b − A x‖/‖b‖ before the
   * last cycle.
   */
  iterate(b: Float64Array, x: Float64Array, cycles: number): number {
    const A = this.levels[0].A;
    const n = A.n;
    if (!this.wr || this.wr.length !== n) {
      this.wr = new Float64Array(n);
      this.wz = new Float64Array(n);
    }
    const r = this.wr;
    const z = this.wz!;
    let bn = 0;
    for (let i = 0; i < n; i++) bn += b[i] * b[i];
    bn = Math.sqrt(bn) || 1;
    let rel = 0;
    for (let c = 0; c < cycles; c++) {
      csrMul(A, x, r);
      let rn = 0;
      for (let i = 0; i < n; i++) {
        r[i] = b[i] - r[i];
        rn += r[i] * r[i];
      }
      rel = Math.sqrt(rn) / bn;
      this.vcycle(0, r, z);
      for (let i = 0; i < n; i++) x[i] += z[i];
    }
    return rel;
  }

  private vcycle(l: number, b: Float64Array, x: Float64Array): void {
    const L = this.levels[l];
    if (l === this.levels.length - 1) {
      this.solveCoarsest(b, x);
      return;
    }
    const A = L.A;
    const n = A.n;
    x.fill(0);
    for (let s = 0; s < this.sweeps; s++) gsForward(A, b, x);
    const r = L.r;
    csrMul(A, x, r);
    for (let i = 0; i < n; i++) r[i] = b[i] - r[i];
    const C = this.levels[l + 1];
    const bc = C.b;
    bc.fill(0);
    const agg = L.agg!;
    for (let i = 0; i < n; i++) bc[agg[i]] += r[i];
    this.vcycle(l + 1, bc, C.x);
    const xc = C.x;
    for (let i = 0; i < n; i++) x[i] += xc[agg[i]];
    for (let s = 0; s < this.sweeps; s++) gsBackward(A, b, x);
  }
}

function gsForward(A: Csr, b: Float64Array, x: Float64Array): void {
  const { n, ptr, col, val, diag } = A;
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = ptr[i], e = ptr[i + 1]; k < e; k++) s -= val[k] * x[col[k]];
    const d = val[diag[i]];
    if (d !== 0) x[i] += s / d;
  }
}

function gsBackward(A: Csr, b: Float64Array, x: Float64Array): void {
  const { n, ptr, col, val, diag } = A;
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let k = ptr[i], e = ptr[i + 1]; k < e; k++) s -= val[k] * x[col[k]];
    const d = val[diag[i]];
    if (d !== 0) x[i] += s / d;
  }
}

/** Connected components of strong couplings inside 2×2×2 cell blocks. */
function aggregate(A: Csr, coords: Int32Array, theta: number): { agg: Int32Array; nc: number; coarseCoords: Int32Array } {
  const n = A.n;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const { ptr, col, val, diag } = A;
  const blockOf = (i: number) => [coords[3 * i] >> 1, coords[3 * i + 1] >> 1, coords[3 * i + 2] >> 1];
  for (let i = 0; i < n; i++) {
    const bi = blockOf(i);
    const aii = Math.abs(val[diag[i]]);
    for (let k = ptr[i]; k < ptr[i + 1]; k++) {
      const j = col[k];
      if (j <= i) continue;
      const bj = blockOf(j);
      if (bi[0] !== bj[0] || bi[1] !== bj[1] || bi[2] !== bj[2]) continue;
      // symmetric strength using max(|a_ij|, |a_ji|)
      let aji = 0;
      for (let q = ptr[j]; q < ptr[j + 1]; q++)
        if (col[q] === i) {
          aji = val[q];
          break;
        }
      const s = Math.max(Math.abs(val[k]), Math.abs(aji));
      const ajj = Math.abs(val[diag[j]]);
      if (s >= theta * Math.sqrt(aii * ajj) || (aii === 0 && ajj === 0)) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const agg = new Int32Array(n).fill(-1);
  const rootId = new Int32Array(n).fill(-1);
  const cc: number[] = [];
  let nc = 0;
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (rootId[r] < 0) {
      rootId[r] = nc++;
      const b = blockOf(i);
      cc.push(b[0], b[1], b[2]);
    }
    agg[i] = rootId[r];
  }
  return { agg, nc, coarseCoords: Int32Array.from(cc) };
}

/** Coarse pattern of Rᵀ A R for a piecewise-constant aggregation, plus the fine-nnz → coarse-nnz map. */
function galerkinPattern(A: Csr, agg: Int32Array, nc: number): { Ac: Csr; nzMap: Int32Array } {
  const n = A.n;
  // rows grouped by aggregate
  const cnt = new Int32Array(nc + 1);
  for (let i = 0; i < n; i++) cnt[agg[i] + 1]++;
  for (let c = 0; c < nc; c++) cnt[c + 1] += cnt[c];
  const rows = new Int32Array(n);
  const fill = cnt.slice(0, nc);
  for (let i = 0; i < n; i++) rows[fill[agg[i]]++] = i;
  const marker = new Int32Array(nc).fill(-1);
  const ptr = new Int32Array(nc + 1);
  const cols: number[] = [];
  const nzMap = new Int32Array(A.col.length);
  const diag = new Int32Array(nc);
  for (let I = 0; I < nc; I++) {
    const start = cols.length;
    for (let q = cnt[I]; q < cnt[I + 1]; q++) {
      const i = rows[q];
      for (let k = A.ptr[i]; k < A.ptr[i + 1]; k++) {
        const J = agg[A.col[k]];
        if (marker[J] < start) {
          marker[J] = cols.length;
          cols.push(J);
        }
        nzMap[k] = marker[J];
      }
    }
    if (marker[I] < start) {
      marker[I] = cols.length;
      cols.push(I);
    }
    diag[I] = marker[I];
    ptr[I + 1] = cols.length;
  }
  return { Ac: { n: nc, ptr, col: Int32Array.from(cols), val: new Float64Array(cols.length), diag }, nzMap };
}

export interface KrylovResult {
  iterations: number;
  /** ‖b − A x‖₂ / ‖b‖₂ at exit. */
  residual: number;
  converged: boolean;
}

/** Reusable work vectors for the Krylov solvers (avoids per-call allocation in outer loops). */
export class KrylovWork {
  private bufs: Float64Array[] = [];
  get(k: number, n: number): Float64Array {
    let b = this.bufs[k];
    if (!b || b.length !== n) b = this.bufs[k] = new Float64Array(n);
    return b;
  }
}

/** Preconditioned CG for symmetric positive (semi-)definite A; x is the initial guess. */
export function pcg(
  A: Csr,
  b: Float64Array,
  x: Float64Array,
  M: AggregationAmg | null,
  tol: number,
  maxIt: number,
  work: KrylovWork = new KrylovWork(),
): KrylovResult {
  const n = A.n;
  const r = work.get(0, n);
  const z = work.get(1, n);
  const p = work.get(2, n);
  const q = work.get(3, n);
  let bn = 0;
  for (let i = 0; i < n; i++) bn += b[i] * b[i];
  bn = Math.sqrt(bn);
  if (!(bn > 0)) {
    x.fill(0);
    return { iterations: 0, residual: 0, converged: true };
  }
  csrMul(A, x, q);
  let rn = 0;
  for (let i = 0; i < n; i++) {
    r[i] = b[i] - q[i];
    rn += r[i] * r[i];
  }
  let rel = Math.sqrt(rn) / bn;
  if (rel <= tol) return { iterations: 0, residual: rel, converged: true };
  if (M) M.apply(r, z);
  else z.set(r);
  let rz = 0;
  for (let i = 0; i < n; i++) {
    p[i] = z[i];
    rz += r[i] * z[i];
  }
  let it = 0;
  while (it < maxIt) {
    it++;
    csrMul(A, p, q);
    let pq = 0;
    for (let i = 0; i < n; i++) pq += p[i] * q[i];
    if (!(pq > 0)) break;
    const alpha = rz / pq;
    rn = 0;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * q[i];
      rn += r[i] * r[i];
    }
    rel = Math.sqrt(rn) / bn;
    if (rel <= tol) break;
    if (M) M.apply(r, z);
    else z.set(r);
    let rzn = 0;
    for (let i = 0; i < n; i++) rzn += r[i] * z[i];
    const beta = rzn / rz;
    rz = rzn;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return { iterations: it, residual: rel, converged: rel <= tol };
}

/** Right-preconditioned BiCGSTAB for general A; x is the initial guess. */
export function bicgstab(
  A: Csr,
  b: Float64Array,
  x: Float64Array,
  M: AggregationAmg | null,
  tol: number,
  maxIt: number,
  work: KrylovWork = new KrylovWork(),
): KrylovResult {
  const n = A.n;
  const r = work.get(0, n);
  const r0 = work.get(1, n);
  const p = work.get(2, n);
  const v = work.get(3, n);
  const s = work.get(4, n);
  const t = work.get(5, n);
  const ph = work.get(6, n);
  const sh = work.get(7, n);
  let bn = 0;
  for (let i = 0; i < n; i++) bn += b[i] * b[i];
  bn = Math.sqrt(bn);
  if (!(bn > 0)) {
    x.fill(0);
    return { iterations: 0, residual: 0, converged: true };
  }
  csrMul(A, x, v);
  let rn = 0;
  for (let i = 0; i < n; i++) {
    r[i] = b[i] - v[i];
    r0[i] = r[i];
    rn += r[i] * r[i];
  }
  let rel = Math.sqrt(rn) / bn;
  if (rel <= tol) return { iterations: 0, residual: rel, converged: true };
  let rho = 1;
  let alpha = 1;
  let omega = 1;
  v.fill(0);
  p.fill(0);
  let it = 0;
  while (it < maxIt) {
    it++;
    let rhoN = 0;
    for (let i = 0; i < n; i++) rhoN += r0[i] * r[i];
    if (rhoN === 0) break;
    const beta = (rhoN / rho) * (alpha / omega);
    rho = rhoN;
    for (let i = 0; i < n; i++) p[i] = r[i] + beta * (p[i] - omega * v[i]);
    if (M) M.apply(p, ph);
    else ph.set(p);
    csrMul(A, ph, v);
    let r0v = 0;
    for (let i = 0; i < n; i++) r0v += r0[i] * v[i];
    if (r0v === 0) break;
    alpha = rho / r0v;
    let sn = 0;
    for (let i = 0; i < n; i++) {
      s[i] = r[i] - alpha * v[i];
      sn += s[i] * s[i];
    }
    if (Math.sqrt(sn) / bn <= tol) {
      for (let i = 0; i < n; i++) x[i] += alpha * ph[i];
      rel = Math.sqrt(sn) / bn;
      break;
    }
    if (M) M.apply(s, sh);
    else sh.set(s);
    csrMul(A, sh, t);
    let tt = 0;
    let ts = 0;
    for (let i = 0; i < n; i++) {
      tt += t[i] * t[i];
      ts += t[i] * s[i];
    }
    omega = tt > 0 ? ts / tt : 0;
    rn = 0;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * ph[i] + omega * sh[i];
      r[i] = s[i] - omega * t[i];
      rn += r[i] * r[i];
    }
    rel = Math.sqrt(rn) / bn;
    if (rel <= tol || omega === 0) break;
  }
  return { iterations: it, residual: rel, converged: rel <= tol };
}
