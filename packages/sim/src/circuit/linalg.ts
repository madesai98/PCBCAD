/**
 * Sparse direct solver for MNA systems.
 *
 * Left-looking Gilbert–Peierls LU with threshold partial pivoting (diagonal preferred),
 * adapted from Tim Davis' CSparse (`cs_lu`, `cs_spsolve`, `cs_reach`, `cs_dfs`), with a
 * fill-reducing minimum-degree column ordering computed on the pattern of A + Aᵀ.
 *
 * The matrix pattern is fixed when the solver is created (MNA stamps are known up front); only
 * values change between Newton iterations / time steps. After the first successful factorisation
 * the pivot sequence and the L/U patterns are reused (`refactor`), which avoids the symbolic
 * work (DFS, pivot search) — the solver falls back to a full pivoting factorisation whenever a
 * reused pivot becomes too small.
 *
 * Browser-safe, allocation-free after warm-up.
 */

/** Compressed-sparse-column pattern. Row indices within a column need not be sorted. */
export interface CscPattern {
  n: number;
  colPtr: Int32Array;
  rowIdx: Int32Array;
}

/**
 * Minimum-degree ordering on the symmetric pattern of A + Aᵀ (explicit elimination graph).
 * Adequate for circuit matrices (a few thousand unknowns at most).
 */
export function minimumDegreeOrder(p: CscPattern): Int32Array {
  const { n, colPtr, rowIdx } = p;
  const adj: Set<number>[] = new Array(n);
  for (let i = 0; i < n; i++) adj[i] = new Set<number>();
  for (let j = 0; j < n; j++) {
    for (let q = colPtr[j]; q < colPtr[j + 1]; q++) {
      const i = rowIdx[q];
      if (i !== j) {
        adj[i].add(j);
        adj[j].add(i);
      }
    }
  }
  const order = new Int32Array(n);
  const done = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    let best = -1;
    let bestDeg = Infinity;
    for (let v = 0; v < n; v++) {
      if (!done[v]) {
        const d = adj[v].size;
        if (d < bestDeg) {
          bestDeg = d;
          best = v;
          if (d === 0) break;
        }
      }
    }
    order[k] = best;
    done[best] = 1;
    const nb = Array.from(adj[best]);
    for (const u of nb) adj[u].delete(best);
    for (let a = 0; a < nb.length; a++) {
      const sa = adj[nb[a]];
      for (let b = a + 1; b < nb.length; b++) {
        sa.add(nb[b]);
        adj[nb[b]].add(nb[a]);
      }
    }
    adj[best].clear();
  }
  return order;
}

/**
 * Sparse LU factorisation P·A·Q = L·U for a fixed pattern.
 * Usage: `const lu = new SparseLU(pattern); if (lu.factor(values)) lu.solve(b, x);`
 */
export class SparseLU {
  readonly n: number;
  private readonly Ap: Int32Array;
  private readonly Ai: Int32Array;
  /** Column permutation (fill-reducing). */
  private readonly q: Int32Array;
  /** Threshold for preferring the diagonal pivot (KLU default 1e-3). */
  private readonly tol: number;

  private Lp: Int32Array;
  private Li: Int32Array;
  private Lx: Float64Array;
  private Up: Int32Array;
  private Ui: Int32Array;
  private Ux: Float64Array;
  /** pinv[originalRow] = pivot step k. */
  private readonly pinv: Int32Array;
  /** Original row chosen as pivot at step k (inverse of pinv). */
  private readonly prow: Int32Array;

  private readonly x: Float64Array;
  private readonly xi: Int32Array;
  private readonly stack: Int32Array;
  private readonly pstack: Int32Array;
  private readonly mark: Int32Array;
  private gen = 0;
  private readonly work: Float64Array;

  /** True once a full factorisation succeeded and its pivot sequence can be reused. */
  private haveSymbolic = false;
  /** Per column: [start,end) into `reachList` holding the topological reach (original row ids). */
  private reachPtr: Int32Array;
  private reachList: Int32Array;

  /** Number of full (pivoting) factorisations performed (diagnostics). */
  fullFactorizations = 0;
  /** Number of fast refactorisations performed (diagnostics). */
  refactorizations = 0;

  constructor(pattern: CscPattern, opts: { tol?: number; order?: Int32Array } = {}) {
    const n = pattern.n;
    this.n = n;
    this.Ap = pattern.colPtr;
    this.Ai = pattern.rowIdx;
    this.tol = opts.tol ?? 1e-3;
    this.q = opts.order ?? minimumDegreeOrder(pattern);
    const nnz = pattern.colPtr[n];
    const est = Math.max(4 * nnz + n, 16);
    this.Lp = new Int32Array(n + 1);
    this.Li = new Int32Array(est);
    this.Lx = new Float64Array(est);
    this.Up = new Int32Array(n + 1);
    this.Ui = new Int32Array(est);
    this.Ux = new Float64Array(est);
    this.pinv = new Int32Array(n);
    this.prow = new Int32Array(n);
    this.x = new Float64Array(n);
    this.xi = new Int32Array(n);
    this.stack = new Int32Array(n);
    this.pstack = new Int32Array(n);
    this.mark = new Int32Array(n);
    this.work = new Float64Array(n);
    this.reachPtr = new Int32Array(n + 1);
    this.reachList = new Int32Array(est);
  }

  /**
   * Factorise with the given values (same order as the pattern's row indices).
   * Tries a fast refactorisation with the previous pivot sequence first.
   * @returns false when the matrix is (numerically) singular.
   */
  factor(values: Float64Array): boolean {
    if (this.haveSymbolic && this.refactor(values)) {
      this.refactorizations++;
      return true;
    }
    this.fullFactorizations++;
    return this.fullFactor(values);
  }

  /** Forget the stored pivot sequence (next factor() does full pivoting). */
  resetPivots(): void {
    this.haveSymbolic = false;
  }

  private growL(need: number): void {
    if (need <= this.Li.length) return;
    const size = Math.max(need, this.Li.length * 2);
    const li = new Int32Array(size);
    li.set(this.Li);
    const lx = new Float64Array(size);
    lx.set(this.Lx);
    this.Li = li;
    this.Lx = lx;
  }

  private growU(need: number): void {
    if (need <= this.Ui.length) return;
    const size = Math.max(need, this.Ui.length * 2);
    const ui = new Int32Array(size);
    ui.set(this.Ui);
    const ux = new Float64Array(size);
    ux.set(this.Ux);
    this.Ui = ui;
    this.Ux = ux;
  }

  private growReach(need: number): void {
    if (need <= this.reachList.length) return;
    const r = new Int32Array(Math.max(need, this.reachList.length * 2));
    r.set(this.reachList);
    this.reachList = r;
  }

  /** Depth-first search from original row j in the graph of L (columns already pivoted). */
  private dfs(j0: number, top: number): number {
    const { stack, pstack, mark, pinv, xi } = this;
    const Lp = this.Lp;
    const Li = this.Li;
    const gen = this.gen;
    let head = 0;
    stack[0] = j0;
    while (head >= 0) {
      const j = stack[head];
      const jnew = pinv[j];
      if (mark[j] !== gen) {
        mark[j] = gen;
        pstack[head] = jnew < 0 ? 0 : Lp[jnew];
      }
      let done = true;
      const p2 = jnew < 0 ? 0 : Lp[jnew + 1];
      for (let p = pstack[head]; p < p2; p++) {
        const i = Li[p];
        if (mark[i] === gen) continue;
        pstack[head] = p;
        stack[++head] = i;
        done = false;
        break;
      }
      if (done) {
        head--;
        xi[--top] = j;
      }
    }
    return top;
  }

  private fullFactor(values: Float64Array): boolean {
    const n = this.n;
    const { Ap, Ai, q, pinv, prow, x, xi, tol } = this;
    pinv.fill(-1);
    x.fill(0);
    let lnz = 0;
    let unz = 0;
    let rnz = 0;
    for (let k = 0; k < n; k++) {
      this.Lp[k] = lnz;
      this.Up[k] = unz;
      this.reachPtr[k] = rnz;
      this.growL(lnz + n);
      this.growU(unz + n);
      this.growReach(rnz + n);
      const Li = this.Li;
      const Lx = this.Lx;
      const Ui = this.Ui;
      const Ux = this.Ux;
      const Lp = this.Lp;
      const col = q[k];
      // reach: pattern of x = L \ A(:,col)
      this.gen++;
      if (this.gen > 0x3fffffff) {
        this.mark.fill(0);
        this.gen = 1;
      }
      let top = n;
      for (let p = Ap[col]; p < Ap[col + 1]; p++) {
        const i = Ai[p];
        if (this.mark[i] !== this.gen) top = this.dfs(i, top);
      }
      // record reach (topological order) for refactorisation
      const reach = this.reachList;
      for (let p = top; p < n; p++) reach[rnz++] = xi[p];
      // scatter A(:,col)
      for (let p = Ap[col]; p < Ap[col + 1]; p++) x[Ai[p]] += values[p];
      // sparse triangular solve
      for (let px = top; px < n; px++) {
        const j = xi[px];
        const J = pinv[j];
        if (J < 0) continue;
        const xj = x[j];
        if (xj === 0) continue;
        for (let p = Lp[J] + 1; p < Lp[J + 1]; p++) x[Li[p]] -= Lx[p] * xj;
      }
      // pivot search
      let ipiv = -1;
      let a = -1;
      for (let p = top; p < n; p++) {
        const i = xi[p];
        if (pinv[i] < 0) {
          const t = Math.abs(x[i]);
          if (t > a) {
            a = t;
            ipiv = i;
          }
        } else {
          Ui[unz] = pinv[i];
          Ux[unz++] = x[i];
        }
      }
      if (ipiv === -1 || !(a > 0) || !Number.isFinite(a)) {
        // clean workspace
        for (let p = top; p < n; p++) x[xi[p]] = 0;
        this.haveSymbolic = false;
        return false;
      }
      if (pinv[col] < 0 && Math.abs(x[col]) >= a * tol) ipiv = col;
      const pivot = x[ipiv];
      Ui[unz] = k;
      Ux[unz++] = pivot;
      pinv[ipiv] = k;
      prow[k] = ipiv;
      Li[lnz] = ipiv;
      Lx[lnz++] = 1;
      for (let p = top; p < n; p++) {
        const i = xi[p];
        if (pinv[i] < 0) {
          Li[lnz] = i;
          Lx[lnz++] = x[i] / pivot;
        }
        x[i] = 0;
      }
    }
    this.Lp[n] = lnz;
    this.Up[n] = unz;
    this.reachPtr[n] = rnz;
    // L row indices stay in ORIGINAL numbering here (needed by refactor); solve() maps through pinv.
    this.haveSymbolic = true;
    return true;
  }

  /**
   * Numeric-only refactorisation using the stored pivot sequence and reach sets.
   * Returns false if a pivot became too small relative to its column (caller falls back).
   */
  private refactor(values: Float64Array): boolean {
    const n = this.n;
    const { Ap, Ai, q, pinv, prow, x, Lp, Li, Lx, Up, Ux, reachPtr, reachList } = this;
    for (let k = 0; k < n; k++) {
      const col = q[k];
      const r0 = reachPtr[k];
      const r1 = reachPtr[k + 1];
      for (let p = Ap[col]; p < Ap[col + 1]; p++) x[Ai[p]] += values[p];
      for (let r = r0; r < r1; r++) {
        const j = reachList[r];
        const J = pinv[j];
        if (J >= k) continue; // not yet pivotal at step k
        const xj = x[j];
        if (xj === 0) continue;
        for (let p = Lp[J] + 1; p < Lp[J + 1]; p++) x[Li[p]] -= Lx[p] * xj;
      }
      // U(:,k): rows pivotal before k, in stored order; last entry is the diagonal
      let unz = Up[k];
      let maxAbs = 0;
      for (let r = r0; r < r1; r++) {
        const j = reachList[r];
        const J = pinv[j];
        const v = Math.abs(x[j]);
        if (v > maxAbs && J >= k) maxAbs = v;
        if (J < k) Ux[unz++] = x[j];
      }
      const ipiv = prow[k];
      const pivot = x[ipiv];
      if (!(Math.abs(pivot) > 0) || Math.abs(pivot) < maxAbs * this.tol * 0.1 || !Number.isFinite(pivot)) {
        for (let r = r0; r < r1; r++) x[reachList[r]] = 0;
        return false;
      }
      Ux[unz] = pivot;
      // L(:,k)
      for (let p = Lp[k] + 1; p < Lp[k + 1]; p++) Lx[p] = x[Li[p]] / pivot;
      for (let r = r0; r < r1; r++) x[reachList[r]] = 0;
    }
    return true;
  }

  /** Solve A·out = b using the last successful factorisation. `b` is not modified. */
  solve(b: ArrayLike<number>, out: Float64Array): void {
    const n = this.n;
    const { pinv, q, Lp, Li, Lx, Up, Ui, Ux } = this;
    const w = this.work;
    for (let i = 0; i < n; i++) w[pinv[i]] = b[i];
    // L solve (unit diagonal); L row indices are original rows -> map via pinv
    for (let j = 0; j < n; j++) {
      const wj = w[j];
      if (wj === 0) continue;
      for (let p = Lp[j] + 1; p < Lp[j + 1]; p++) w[pinv[Li[p]]] -= Lx[p] * wj;
    }
    // U solve
    for (let j = n - 1; j >= 0; j--) {
      const d = Ux[Up[j + 1] - 1];
      const wj = (w[j] /= d);
      if (wj === 0) continue;
      for (let p = Up[j]; p < Up[j + 1] - 1; p++) w[Ui[p]] -= Ux[p] * wj;
    }
    for (let k = 0; k < n; k++) out[q[k]] = w[k];
  }

  /** Fill-in statistics (diagnostics). */
  get stats(): { n: number; lnz: number; unz: number } {
    return { n: this.n, lnz: this.Lp[this.n], unz: this.Up[this.n] };
  }
}

/**
 * Builds a fixed CSC pattern from (row, col) pairs registered during device setup.
 * `slot()` returns a stable handle; after `compile()`, `position(handle)` is the index into the
 * CSC values array. Entries touching ground (index < 0) map to the trash position `nnz`.
 */
export class PatternBuilder {
  readonly n: number;
  private readonly map = new Map<number, number>();
  private readonly rows: number[] = [];
  private readonly cols: number[] = [];
  /** handle -> CSC position (after compile) */
  positions: Int32Array = new Int32Array(0);
  pattern: CscPattern | null = null;

  constructor(n: number) {
    this.n = n;
  }

  /** Register entry (row, col); negative indices denote ground and return -1. */
  slot(row: number, col: number): number {
    if (row < 0 || col < 0) return -1;
    if (row >= this.n || col >= this.n) throw new Error(`matrix entry (${row},${col}) out of range ${this.n}`);
    const key = row * this.n + col;
    let h = this.map.get(key);
    if (h === undefined) {
      h = this.rows.length;
      this.map.set(key, h);
      this.rows.push(row);
      this.cols.push(col);
    }
    return h;
  }

  /** Build the CSC pattern. Handle -1 maps to the trash position (nnz). */
  compile(): CscPattern {
    const n = this.n;
    const nnz = this.rows.length;
    const colPtr = new Int32Array(n + 1);
    for (let h = 0; h < nnz; h++) colPtr[this.cols[h] + 1]++;
    for (let j = 0; j < n; j++) colPtr[j + 1] += colPtr[j];
    const next = colPtr.slice(0, n);
    const rowIdx = new Int32Array(nnz);
    const positions = new Int32Array(nnz);
    for (let h = 0; h < nnz; h++) {
      const pos = next[this.cols[h]]++;
      rowIdx[pos] = this.rows[h];
      positions[h] = pos;
    }
    this.positions = positions;
    this.pattern = { n, colPtr, rowIdx };
    return this.pattern;
  }

  /** CSC position for a handle (trash = nnz for ground handles). */
  position(handle: number): number {
    if (handle < 0) return this.rows.length;
    return this.positions[handle];
  }

  get nnz(): number {
    return this.rows.length;
  }
}
