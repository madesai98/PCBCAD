/**
 * Direct solver for grounded weighted graph Laplacians (resistor networks):
 *
 *   L v = J,   L_ii = Σ_j g_ij,  L_ij = −g_ij,   v[ground] = 0
 *
 * Gaussian elimination (star–mesh / Schur complement node elimination) with a greedy
 * minimum-degree ordering on a hash-map adjacency structure. For a connected graph with one
 * grounded node the reduced matrix is SPD, so elimination is stable in any order without
 * pivoting. Copper nets are near-planar, sparse graphs (chains, trees, star-like zone hubs), for
 * which minimum degree produces very little fill; this is exact (no iteration tolerance) and
 * robust against the huge conductance ratios that occur between tiny segments and long traces.
 */

export interface LaplacianEdges {
  a: ArrayLike<number>;
  b: ArrayLike<number>;
  /** Conductance (S), > 0. Parallel edges are summed; self-loops are ignored. */
  g: ArrayLike<number>;
}

/** Binary min-heap of (key, value) pairs with lazy deletion handled by the caller. */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** Pops the minimum; returns [key, value]. */
  pop(): [number, number] {
    const { keys, vals } = this;
    const topK = keys[0];
    const topV = vals[0];
    const lastK = keys.pop()!;
    const lastV = vals.pop()!;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastK) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = lastK;
      vals[i] = lastV;
    }
    return [topK, topV];
  }
}

/**
 * Solve a grounded Laplacian system on nodes 0..n−1. All nodes are expected to be connected to
 * `ground` (one island); a node with no path to ground (zero pivot) is assigned 0 V.
 *
 * @param n       number of nodes
 * @param edges   conductances between node pairs (S)
 * @param J       current injected INTO each node (A); J[ground] is ignored (ground absorbs Σ J)
 * @param ground  index of the 0 V reference node
 * @returns node potentials (V)
 */
export function solveGroundedLaplacian(n: number, edges: LaplacianEdges, J: ArrayLike<number>, ground: number): Float64Array {
  const adj: Map<number, number>[] = new Array(n);
  for (let i = 0; i < n; i++) adj[i] = new Map();
  const diag = new Float64Array(n);
  const m = edges.a.length;
  for (let e = 0; e < m; e++) {
    const a = edges.a[e];
    const b = edges.b[e];
    const g = edges.g[e];
    if (a === b || !(g > 0) || !Number.isFinite(g)) continue;
    diag[a] += g;
    diag[b] += g;
    adj[a].set(b, (adj[a].get(b) ?? 0) + g);
    adj[b].set(a, (adj[b].get(a) ?? 0) + g);
  }
  const rhs = new Float64Array(n);
  for (let i = 0; i < n; i++) rhs[i] = J[i] ?? 0;

  const eliminated = new Uint8Array(n);
  // Remove the ground node: its neighbours keep the coupling in their diagonal (v_ground = 0).
  for (const k of adj[ground].keys()) adj[k].delete(ground);
  adj[ground].clear();
  eliminated[ground] = 1;

  const heap = new MinHeap();
  for (let i = 0; i < n; i++) if (!eliminated[i]) heap.push(adj[i].size, i);

  // Elimination record for back substitution.
  const order: number[] = [];
  const recNbr: Int32Array[] = new Array(n);
  const recG: Float64Array[] = new Array(n);
  const recD = new Float64Array(n);
  const recB = new Float64Array(n);

  while (heap.size > 0) {
    const [deg, k] = heap.pop();
    if (eliminated[k] || deg !== adj[k].size) continue; // stale entry
    eliminated[k] = 1;
    const nb = adj[k];
    const cnt = nb.size;
    const ids = new Int32Array(cnt);
    const gs = new Float64Array(cnt);
    let p = 0;
    for (const [id, g] of nb) {
      ids[p] = id;
      gs[p] = g;
      p++;
    }
    const d = diag[k];
    const bk = rhs[k];
    order.push(k);
    recNbr[k] = ids;
    recG[k] = gs;
    recD[k] = d;
    recB[k] = bk;
    nb.clear();
    if (!(d > 0)) continue; // isolated node: 0 V
    for (let i = 0; i < cnt; i++) adj[ids[i]].delete(k);
    for (let i = 0; i < cnt; i++) {
      const ni = ids[i];
      const gi = gs[i];
      const f = gi / d;
      diag[ni] -= gi * f;
      rhs[ni] += f * bk;
      const ai = adj[ni];
      for (let j = i + 1; j < cnt; j++) {
        const nj = ids[j];
        const add = f * gs[j];
        ai.set(nj, (ai.get(nj) ?? 0) + add);
        const aj = adj[nj];
        aj.set(ni, (aj.get(ni) ?? 0) + add);
      }
    }
    for (let i = 0; i < cnt; i++) heap.push(adj[ids[i]].size, ids[i]);
  }

  const v = new Float64Array(n);
  for (let q = order.length - 1; q >= 0; q--) {
    const k = order[q];
    const d = recD[k];
    if (!(d > 0)) {
      v[k] = 0;
      continue;
    }
    const ids = recNbr[k];
    const gs = recG[k];
    let s = recB[k];
    for (let i = 0; i < ids.length; i++) s += gs[i] * v[ids[i]];
    v[k] = s / d;
  }
  v[ground] = 0;
  return v;
}
