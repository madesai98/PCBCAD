/**
 * Geometric multigrid for voxel elasticity, used as a preconditioner for conjugate gradients.
 *
 * Level 0 is the matrix-free element-by-element (EbE) operator of the voxel mesh. Coarse levels are
 * exact Galerkin operators A_{l+1} = Pᵀ A_l P with trilinear prolongation P on the voxel-node grid.
 * Because every fine element in a coarse cell (2×2×2 block) only touches the 8 corner nodes of that
 * cell, the Galerkin operator is itself element-by-element: each coarse cell stores a 24×24 matrix
 * Σ_children P_octᵀ M_child P_oct (one P_oct per octant). Identical cell matrices are de-duplicated,
 * which keeps memory small for the repetitive patterns of voxel models. Clamped fine DOFs are handled by
 * masking the prolongation (P := Z P); coarse nodes that only feed clamped/void DOFs become inactive.
 *
 * Smoother: Chebyshev polynomial (default degree 1, i.e. optimally damped Jacobi) in the 3×3-block-Jacobi-preconditioned operator
 * D⁻¹A, targeting [λmax/30, 1.1·λmax] with λmax from a power iteration on each level (damped block
 * Jacobi is available as an option). Pre- and post-smoothers are identical polynomials, so the V-cycle is
 * a symmetric positive definite preconditioner for PCG.
 * Coarsest level: dense Cholesky on the active DOFs (with a pivot guard for semi-definite blocks).
 *
 * Known limitation: for walls only 1–2 voxels thick the trilinear coarse spaces shear-lock in bending, so
 * iteration counts rise from ~12–20 (bulky parts) to ~60–100 (thin-walled enclosures). Counts stay
 * mesh-independent. A smoothed-aggregation coarse space with rotational modes would remove this.
 */

export interface FineInput {
  nNodes: number;
  /** 3 per node: local grid-node coordinates (≥ 0). */
  nodeCoord: Int32Array;
  nElem: number;
  /** 8 per element: node ids in corner order a = ix + 2·iy + 4·iz. */
  conn: Int32Array;
  /** 3 per element: local voxel coordinates (≥ 0). */
  elemCoord: Int32Array;
  /** Per element material slot. */
  elemSlot: Int32Array;
  /** 576 per slot: unit-cube stiffness K̂(ν) (E = 1, h = 1). */
  slotK: Float64Array;
  /** Per slot: E·h (N/mm). */
  slotScale: Float64Array;
  /** Per node: 1 = free, 0 = clamped. */
  free: Uint8Array;
}

interface Level {
  nNodes: number;
  nodeCoord: Int32Array;
  nCells: number;
  conn: Int32Array;
  cellCoord: Int32Array;
  pool: Float64Array;
  /** Per cell offset into pool (multiple of 576). */
  cellOff: Int32Array;
  cellScale: Float64Array;
  free: Uint8Array;
  diagInv: Float64Array;
  omega: number;
  /** Fine level only: per element bitmask of free corners (0xff when none clamped). */
  freeBits?: Uint8Array;
  /** Transfer to the next coarser level (8 entries per node). */
  parIdx?: Int32Array;
  parW?: Float64Array;
  x: Float64Array;
  b: Float64Array;
  r: Float64Array;
}

/** Octant transfer weights: for octant o, the 27 non-zero (childNode, parentNode, weight) triples. */
const OCT_TRIPLES: { a: Int8Array; p: Int8Array; w: Float64Array }[] = (() => {
  const w1 = (t: number, p: number) => (t === 0 ? (p === 0 ? 1 : 0) : t === 2 ? (p === 1 ? 1 : 0) : 0.5);
  const out: { a: Int8Array; p: Int8Array; w: Float64Array }[] = [];
  for (let o = 0; o < 8; o++) {
    const ox = o & 1;
    const oy = (o >> 1) & 1;
    const oz = (o >> 2) & 1;
    const A: number[] = [];
    const P: number[] = [];
    const W: number[] = [];
    for (let a = 0; a < 8; a++)
      for (let p = 0; p < 8; p++) {
        const w = w1(ox + (a & 1), p & 1) * w1(oy + ((a >> 1) & 1), (p >> 1) & 1) * w1(oz + ((a >> 2) & 1), (p >> 2) & 1);
        if (w !== 0) {
          A.push(a);
          P.push(p);
          W.push(w);
        }
      }
    out.push({ a: Int8Array.from(A), p: Int8Array.from(P), w: Float64Array.from(W) });
  }
  return out;
})();

const TMP_MP = new Float64Array(576);

/**
 * out (24×24) += s · P_octᵀ M P_oct, where M is read from src at offset off and rows/columns of child
 * corners not in freeBits are treated as zero (masked prolongation).
 */
function addTransformed(out: Float64Array, src: Float64Array, off: number, s: number, oct: number, freeBits: number): void {
  const { a: TA, p: TP, w: TW } = OCT_TRIPLES[oct];
  const nt = TA.length;
  const MP = TMP_MP;
  MP.fill(0);
  // MP[r][3p+d] = Σ w · M[r][3a+d]
  for (let t = 0; t < nt; t++) {
    const a = TA[t];
    if (!(freeBits & (1 << a))) continue;
    const p3 = TP[t] * 3;
    const a3 = a * 3;
    const w = TW[t];
    for (let r = 0; r < 24; r++) {
      const ro = off + r * 24 + a3;
      const mo = r * 24 + p3;
      MP[mo] += w * src[ro];
      MP[mo + 1] += w * src[ro + 1];
      MP[mo + 2] += w * src[ro + 2];
    }
  }
  // out[3p+d][c] += s · Σ w · MP[3a+d][c]
  for (let t = 0; t < nt; t++) {
    const a = TA[t];
    if (!(freeBits & (1 << a))) continue;
    const ws = TW[t] * s;
    for (let d = 0; d < 3; d++) {
      const ro = (TP[t] * 3 + d) * 24;
      const mo = (a * 3 + d) * 24;
      for (let c = 0; c < 24; c++) out[ro + c] += ws * MP[mo + c];
    }
  }
}

/** y = A x (EbE), followed by zeroing of non-free DOFs. */
function applyLevel(L: Level, x: Float64Array, y: Float64Array): void {
  y.fill(0);
  const { conn, pool: K, cellOff, cellScale, nCells, free, nNodes } = L;
  for (let c = 0; c < nCells; c++) {
    const b = c * 8;
    const n0 = conn[b] * 3;
    const n1 = conn[b + 1] * 3;
    const n2 = conn[b + 2] * 3;
    const n3 = conn[b + 3] * 3;
    const n4 = conn[b + 4] * 3;
    const n5 = conn[b + 5] * 3;
    const n6 = conn[b + 6] * 3;
    const n7 = conn[b + 7] * 3;
    const u0 = x[n0], u1 = x[n0 + 1], u2 = x[n0 + 2];
    const u3 = x[n1], u4 = x[n1 + 1], u5 = x[n1 + 2];
    const u6 = x[n2], u7 = x[n2 + 1], u8 = x[n2 + 2];
    const u9 = x[n3], u10 = x[n3 + 1], u11 = x[n3 + 2];
    const u12 = x[n4], u13 = x[n4 + 1], u14 = x[n4 + 2];
    const u15 = x[n5], u16 = x[n5 + 1], u17 = x[n5 + 2];
    const u18 = x[n6], u19 = x[n6 + 1], u20 = x[n6 + 2];
    const u21 = x[n7], u22 = x[n7 + 1], u23 = x[n7 + 2];
    const s = cellScale[c];
    let o = cellOff[c];
    for (let a = 0; a < 8; a++) {
      const n = conn[b + a] * 3;
      for (let d = 0; d < 3; d++, o += 24) {
        y[n + d] +=
          s *
          (K[o] * u0 + K[o + 1] * u1 + K[o + 2] * u2 + K[o + 3] * u3 + K[o + 4] * u4 + K[o + 5] * u5 +
            K[o + 6] * u6 + K[o + 7] * u7 + K[o + 8] * u8 + K[o + 9] * u9 + K[o + 10] * u10 + K[o + 11] * u11 +
            K[o + 12] * u12 + K[o + 13] * u13 + K[o + 14] * u14 + K[o + 15] * u15 + K[o + 16] * u16 +
            K[o + 17] * u17 + K[o + 18] * u18 + K[o + 19] * u19 + K[o + 20] * u20 + K[o + 21] * u21 +
            K[o + 22] * u22 + K[o + 23] * u23);
      }
    }
  }
  for (let n = 0; n < nNodes; n++) {
    if (free[n]) continue;
    y[3 * n] = 0;
    y[3 * n + 1] = 0;
    y[3 * n + 2] = 0;
  }
}

/** Assemble and invert the 3×3 diagonal blocks; marks singular blocks inactive. */
function buildDiag(L: Level, detectInactive: boolean): void {
  const { nNodes, conn, pool, cellOff, cellScale, nCells, free } = L;
  const blk = new Float64Array(9 * nNodes);
  for (let c = 0; c < nCells; c++) {
    const s = cellScale[c];
    const off = cellOff[c];
    for (let a = 0; a < 8; a++) {
      const n9 = conn[c * 8 + a] * 9;
      for (let r = 0; r < 3; r++)
        for (let q = 0; q < 3; q++) blk[n9 + r * 3 + q] += s * pool[off + (3 * a + r) * 24 + 3 * a + q];
    }
  }
  let maxTr = 0;
  for (let n = 0; n < nNodes; n++) maxTr = Math.max(maxTr, blk[9 * n] + blk[9 * n + 4] + blk[9 * n + 8]);
  const inv = new Float64Array(9 * nNodes);
  for (let n = 0; n < nNodes; n++) {
    const m = blk.subarray(9 * n, 9 * n + 9);
    const tr = m[0] + m[4] + m[8];
    const det =
      m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (detectInactive && (tr <= 1e-12 * maxTr || det <= 1e-12 * tr * tr * tr)) free[n] = 0;
    if (!free[n]) continue;
    const id = 1 / det;
    const o = 9 * n;
    inv[o] = (m[4] * m[8] - m[5] * m[7]) * id;
    inv[o + 1] = (m[2] * m[7] - m[1] * m[8]) * id;
    inv[o + 2] = (m[1] * m[5] - m[2] * m[4]) * id;
    inv[o + 3] = (m[5] * m[6] - m[3] * m[8]) * id;
    inv[o + 4] = (m[0] * m[8] - m[2] * m[6]) * id;
    inv[o + 5] = (m[2] * m[3] - m[0] * m[5]) * id;
    inv[o + 6] = (m[3] * m[7] - m[4] * m[6]) * id;
    inv[o + 7] = (m[1] * m[6] - m[0] * m[7]) * id;
    inv[o + 8] = (m[0] * m[4] - m[1] * m[3]) * id;
  }
  L.diagInv = inv;
}

/** y = D⁻¹ x (block). */
function applyDiagInv(L: Level, x: Float64Array, y: Float64Array, scale: number): void {
  const inv = L.diagInv;
  for (let n = 0, o = 0; n < L.nNodes; n++, o += 9) {
    const i = 3 * n;
    if (!L.free[n]) {
      y[i] = 0;
      y[i + 1] = 0;
      y[i + 2] = 0;
      continue;
    }
    const a = x[i];
    const b = x[i + 1];
    const c = x[i + 2];
    y[i] = scale * (inv[o] * a + inv[o + 1] * b + inv[o + 2] * c);
    y[i + 1] = scale * (inv[o + 3] * a + inv[o + 4] * b + inv[o + 5] * c);
    y[i + 2] = scale * (inv[o + 6] * a + inv[o + 7] * b + inv[o + 8] * c);
  }
}

/** Deterministic pseudo-random generator (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Power-iteration estimate of λmax(D⁻¹A). */
function estimateLambdaMax(L: Level, iters = 12): number {
  const n = 3 * L.nNodes;
  const v = new Float64Array(n);
  const w = new Float64Array(n);
  const rand = rng(12345 + L.nNodes);
  for (let i = 0; i < n; i++) v[i] = L.free[(i / 3) | 0] ? rand() - 0.5 : 0;
  let lam = 1;
  for (let it = 0; it < iters; it++) {
    let nv = 0;
    for (let i = 0; i < n; i++) nv += v[i] * v[i];
    nv = Math.sqrt(nv);
    if (!(nv > 0)) return 1;
    for (let i = 0; i < n; i++) v[i] /= nv;
    applyLevel(L, v, w);
    applyDiagInv(L, w, v, 1);
    let nw = 0;
    for (let i = 0; i < n; i++) nw += v[i] * v[i];
    lam = Math.sqrt(nw);
  }
  return lam;
}

function makeLevel(
  nNodes: number,
  nodeCoord: Int32Array,
  nCells: number,
  conn: Int32Array,
  cellCoord: Int32Array,
  pool: Float64Array,
  cellOff: Int32Array,
  cellScale: Float64Array,
  free: Uint8Array,
): Level {
  return {
    nNodes,
    nodeCoord,
    nCells,
    conn,
    cellCoord,
    pool,
    cellOff,
    cellScale,
    free,
    diagInv: new Float64Array(0),
    omega: 0.6,
    x: new Float64Array(3 * nNodes),
    b: new Float64Array(3 * nNodes),
    r: new Float64Array(3 * nNodes),
  };
}

/** Build the next coarser level (Galerkin, de-duplicated cell matrices) and the transfer from C. */
function coarsen(C: Level, fineSlotG: Float64Array | null): Level {
  const nC = C.nCells;
  let PX = 0;
  let PY = 0;
  let PZ = 0;
  for (let c = 0; c < nC; c++) {
    PX = Math.max(PX, (C.cellCoord[3 * c] >> 1) + 1);
    PY = Math.max(PY, (C.cellCoord[3 * c + 1] >> 1) + 1);
    PZ = Math.max(PZ, (C.cellCoord[3 * c + 2] >> 1) + 1);
  }
  const cellMap = new Int32Array(PX * PY * PZ).fill(-1);
  const childOf: number[] = [];
  const pCoord: number[] = [];
  let nP = 0;
  for (let c = 0; c < nC; c++) {
    const cx = C.cellCoord[3 * c];
    const cy = C.cellCoord[3 * c + 1];
    const cz = C.cellCoord[3 * c + 2];
    const px = cx >> 1;
    const py = cy >> 1;
    const pz = cz >> 1;
    const key = px + PX * (py + PY * pz);
    let p = cellMap[key];
    if (p < 0) {
      p = cellMap[key] = nP++;
      pCoord.push(px, py, pz);
      for (let o = 0; o < 8; o++) childOf.push(-1);
    }
    childOf[p * 8 + ((cx & 1) | ((cy & 1) << 1) | ((cz & 1) << 2))] = c;
  }
  // nodes
  const NX = PX + 1;
  const NY = PY + 1;
  const nodeMap = new Int32Array(NX * NY * (PZ + 1)).fill(-1);
  const conn = new Int32Array(nP * 8);
  const nCoord: number[] = [];
  let nN = 0;
  for (let p = 0; p < nP; p++) {
    for (let a = 0; a < 8; a++) {
      const gx = pCoord[3 * p] + (a & 1);
      const gy = pCoord[3 * p + 1] + ((a >> 1) & 1);
      const gz = pCoord[3 * p + 2] + ((a >> 2) & 1);
      const key = gx + NX * (gy + NY * gz);
      let n = nodeMap[key];
      if (n < 0) {
        n = nodeMap[key] = nN++;
        nCoord.push(gx, gy, gz);
      }
      conn[p * 8 + a] = n;
    }
  }
  // de-duplicated cell matrices
  const isFine = fineSlotG !== null;
  const keyMap = new Map<string, number>();
  const rep: number[] = [];
  const cellId = new Int32Array(nP);
  const codes: number[] = new Array(8);
  for (let p = 0; p < nP; p++) {
    let unique = false;
    for (let o = 0; o < 8; o++) {
      const c = childOf[p * 8 + o];
      if (c < 0) codes[o] = -1;
      else if (isFine) {
        if (C.freeBits![c] !== 0xff) unique = true;
        codes[o] = C.cellOff[c] / 576;
      } else codes[o] = C.cellOff[c] / 576;
    }
    const key = unique ? `u${p}` : codes.join(',');
    let id = keyMap.get(key);
    if (id === undefined) {
      id = rep.length;
      keyMap.set(key, id);
      rep.push(p);
    }
    cellId[p] = id;
  }
  const pool = new Float64Array(rep.length * 576);
  for (let id = 0; id < rep.length; id++) {
    const p = rep[id];
    const out = pool.subarray(id * 576, id * 576 + 576);
    for (let o = 0; o < 8; o++) {
      const c = childOf[p * 8 + o];
      if (c < 0) continue;
      const s = C.cellScale[c];
      if (isFine && C.freeBits![c] === 0xff) {
        const slot = C.cellOff[c] / 576;
        const g = (slot * 8 + o) * 576;
        for (let q = 0; q < 576; q++) out[q] += s * fineSlotG![g + q];
      } else {
        addTransformed(out, C.pool, C.cellOff[c], s, o, isFine ? C.freeBits![c] : 0xff);
      }
    }
    // symmetrise (round-off)
    for (let r = 0; r < 24; r++)
      for (let q = r + 1; q < 24; q++) {
        const v = 0.5 * (out[r * 24 + q] + out[q * 24 + r]);
        out[r * 24 + q] = v;
        out[q * 24 + r] = v;
      }
  }
  const cellOff = new Int32Array(nP);
  for (let p = 0; p < nP; p++) cellOff[p] = cellId[p] * 576;
  const P = makeLevel(
    nN,
    Int32Array.from(nCoord),
    nP,
    conn,
    Int32Array.from(pCoord),
    pool,
    cellOff,
    new Float64Array(nP).fill(1),
    new Uint8Array(nN).fill(1),
  );
  // transfer C → P
  const parIdx = new Int32Array(C.nNodes * 8).fill(-1);
  const parW = new Float64Array(C.nNodes * 8);
  for (let n = 0; n < C.nNodes; n++) {
    const gx = C.nodeCoord[3 * n];
    const gy = C.nodeCoord[3 * n + 1];
    const gz = C.nodeCoord[3 * n + 2];
    const xs = gx & 1 ? [(gx - 1) >> 1, (gx + 1) >> 1] : [gx >> 1];
    const ys = gy & 1 ? [(gy - 1) >> 1, (gy + 1) >> 1] : [gy >> 1];
    const zs = gz & 1 ? [(gz - 1) >> 1, (gz + 1) >> 1] : [gz >> 1];
    const w = 1 / (xs.length * ys.length * zs.length);
    let q = 0;
    for (const z of zs)
      for (const y of ys)
        for (const x of xs) {
          const id = nodeMap[x + NX * (y + NY * z)];
          if (id < 0) throw new Error('mg: missing parent node (internal error)');
          parIdx[n * 8 + q] = id;
          parW[n * 8 + q] = w;
          q++;
        }
  }
  C.parIdx = parIdx;
  C.parW = parW;
  return P;
}

export interface MgOptions {
  /** Stop coarsening once the active DOF count is at most this (default 900). */
  maxCoarseDofs?: number;
  maxLevels?: number;
  /** Smoothing steps (Jacobi) or polynomial degree (Chebyshev) per side (default 1: fastest overall). */
  smoothSteps?: number;
  /** Smoother type (default 'chebyshev'). */
  smoother?: 'jacobi' | 'chebyshev';
  /** Damped Jacobi: ω = omegaFactor / λmax (default 1.3). */
  omegaFactor?: number;
  /** Chebyshev: lower bound of the smoothed spectrum = λmax / ratio (default 30). */
  chebyRatio?: number;
}

/** Process-wide default options (tuning hook; per-call options take precedence). */
export const mgDefaults: MgOptions = {};

/** Multigrid hierarchy for one solid body. */
export class ElasticMultigrid {
  readonly levels: Level[] = [];
  private coarseDof!: Int32Array;
  private coarseN = 0;
  private coarseL!: Float64Array;
  private coarseNull!: Uint8Array;
  private coarseY!: Float64Array;
  private readonly smooth: number;
  private readonly cheby: boolean;
  private readonly chebyRatio: number;
  private readonly lamMax: number[] = [];
  private dWork: Float64Array[] = [];
  private qWork: Float64Array[] = [];

  constructor(fine: FineInput, options: MgOptions = {}) {
    const opts: MgOptions = { ...mgDefaults, ...options };
    const maxCoarse = opts.maxCoarseDofs ?? 900;
    const maxLevels = opts.maxLevels ?? 12;
    this.smooth = Math.max(1, opts.smoothSteps ?? 1);
    this.cheby = (opts.smoother ?? 'chebyshev') === 'chebyshev';
    this.chebyRatio = opts.chebyRatio ?? 30;
    const omegaFactor = opts.omegaFactor ?? 1.3;
    const cellOff = new Int32Array(fine.nElem);
    const cellScale = new Float64Array(fine.nElem);
    const freeBits = new Uint8Array(fine.nElem);
    for (let e = 0; e < fine.nElem; e++) {
      const s = fine.elemSlot[e];
      cellOff[e] = s * 576;
      cellScale[e] = fine.slotScale[s];
      let bits = 0;
      for (let a = 0; a < 8; a++) if (fine.free[fine.conn[e * 8 + a]]) bits |= 1 << a;
      freeBits[e] = bits;
    }
    const L0 = makeLevel(
      fine.nNodes,
      fine.nodeCoord,
      fine.nElem,
      fine.conn,
      fine.elemCoord,
      fine.slotK,
      cellOff,
      cellScale,
      fine.free,
    );
    L0.freeBits = freeBits;
    buildDiag(L0, false);
    this.levels.push(L0);
    // unit-scale transformed slot matrices for unmasked fine elements
    const nSlots = fine.slotScale.length;
    const slotG = new Float64Array(nSlots * 8 * 576);
    for (let s = 0; s < nSlots; s++)
      for (let o = 0; o < 8; o++) {
        const out = slotG.subarray((s * 8 + o) * 576, (s * 8 + o + 1) * 576);
        addTransformed(out, fine.slotK, s * 576, 1, o, 0xff);
      }
    while (this.levels.length < maxLevels) {
      const L = this.levels[this.levels.length - 1];
      if (activeDofs(L) <= maxCoarse || L.nCells <= 1) break;
      const P = coarsen(L, this.levels.length === 1 ? slotG : null);
      buildDiag(P, true);
      this.levels.push(P);
    }
    for (let l = 0; l < this.levels.length - 1; l++) {
      const L = this.levels[l];
      const lam = Math.max(estimateLambdaMax(L), 1e-12);
      L.omega = omegaFactor / lam;
      this.lamMax[l] = lam;
      this.dWork[l] = new Float64Array(3 * L.nNodes);
      this.qWork[l] = new Float64Array(3 * L.nNodes);
    }
    this.factorCoarsest();
  }

  /** Number of free DOFs on the fine level. */
  get dofs(): number {
    return activeDofs(this.levels[0]);
  }

  /** y = K x on the fine level (clamped DOFs zeroed). */
  apply(x: Float64Array, y: Float64Array): void {
    applyLevel(this.levels[0], x, y);
  }

  /** z = M⁻¹ r (one symmetric V-cycle). */
  precondition(r: Float64Array, z: Float64Array): void {
    this.vcycle(0, r, z);
  }

  private vcycle(l: number, b: Float64Array, x: Float64Array): void {
    const L = this.levels[l];
    if (l === this.levels.length - 1) {
      this.solveCoarsest(b, x);
      return;
    }
    const r = L.r;
    const n = 3 * L.nNodes;
    // pre-smoothing from x = 0
    if (this.cheby) {
      x.fill(0);
      this.chebyshev(l, b, x, true);
    } else {
      applyDiagInv(L, b, x, L.omega);
      for (let s = 1; s < this.smooth; s++) this.jacobiStep(L, b, x);
    }
    // residual
    applyLevel(L, x, r);
    for (let i = 0; i < n; i++) r[i] = b[i] - r[i];
    // restrict
    const P = this.levels[l + 1];
    const bc = P.b;
    bc.fill(0);
    const { parIdx, parW, free } = L;
    for (let nd = 0; nd < L.nNodes; nd++) {
      if (!free[nd]) continue;
      const r0 = r[3 * nd];
      const r1 = r[3 * nd + 1];
      const r2 = r[3 * nd + 2];
      for (let q = nd * 8, qe = q + 8; q < qe; q++) {
        const p = parIdx![q];
        if (p < 0) break;
        const w = parW![q];
        bc[3 * p] += w * r0;
        bc[3 * p + 1] += w * r1;
        bc[3 * p + 2] += w * r2;
      }
    }
    for (let p = 0; p < P.nNodes; p++)
      if (!P.free[p]) {
        bc[3 * p] = 0;
        bc[3 * p + 1] = 0;
        bc[3 * p + 2] = 0;
      }
    const xc = P.x;
    this.vcycle(l + 1, bc, xc);
    // prolongate
    for (let nd = 0; nd < L.nNodes; nd++) {
      if (!free[nd]) continue;
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      for (let q = nd * 8, qe = q + 8; q < qe; q++) {
        const p = parIdx![q];
        if (p < 0) break;
        const w = parW![q];
        a0 += w * xc[3 * p];
        a1 += w * xc[3 * p + 1];
        a2 += w * xc[3 * p + 2];
      }
      x[3 * nd] += a0;
      x[3 * nd + 1] += a1;
      x[3 * nd + 2] += a2;
    }
    if (this.cheby) this.chebyshev(l, b, x, false);
    else for (let s = 0; s < this.smooth; s++) this.jacobiStep(L, b, x);
  }

  /**
   * Chebyshev polynomial smoother (degree = smoothSteps) on D⁻¹A for eigenvalues in
   * [λmax/ratio, 1.1·λmax]. With x = 0 on entry (`zeroStart`) the initial residual needs no matvec.
   */
  private chebyshev(l: number, b: Float64Array, x: Float64Array, zeroStart: boolean): void {
    const L = this.levels[l];
    const n = 3 * L.nNodes;
    const r = L.r;
    const d = this.dWork[l];
    const hi = 1.1 * this.lamMax[l];
    const lo = this.lamMax[l] / this.chebyRatio;
    const theta = 0.5 * (hi + lo);
    const delta = 0.5 * (hi - lo);
    const sigma = theta / delta;
    let rho = 1 / sigma;
    if (zeroStart) r.set(b);
    else {
      applyLevel(L, x, r);
      for (let i = 0; i < n; i++) r[i] = b[i] - r[i];
    }
    applyDiagInv(L, r, d, 1 / theta);
    const q = this.qWork[l];
    const inv = L.diagInv;
    const free = L.free;
    for (let k = 0; k < this.smooth; k++) {
      for (let i = 0; i < n; i++) x[i] += d[i];
      if (k === this.smooth - 1) break;
      applyLevel(L, d, q);
      for (let i = 0; i < n; i++) r[i] -= q[i];
      const rhoNew = 1 / (2 * sigma - rho);
      const c1 = rhoNew * rho;
      const c2 = (2 * rhoNew) / delta;
      rho = rhoNew;
      for (let nd = 0, o = 0; nd < L.nNodes; nd++, o += 9) {
        const i = 3 * nd;
        if (!free[nd]) {
          d[i] = 0;
          d[i + 1] = 0;
          d[i + 2] = 0;
          continue;
        }
        const a0 = r[i];
        const a1 = r[i + 1];
        const a2 = r[i + 2];
        d[i] = c1 * d[i] + c2 * (inv[o] * a0 + inv[o + 1] * a1 + inv[o + 2] * a2);
        d[i + 1] = c1 * d[i + 1] + c2 * (inv[o + 3] * a0 + inv[o + 4] * a1 + inv[o + 5] * a2);
        d[i + 2] = c1 * d[i + 2] + c2 * (inv[o + 6] * a0 + inv[o + 7] * a1 + inv[o + 8] * a2);
      }
    }
  }

  private jacobiStep(L: Level, b: Float64Array, x: Float64Array): void {
    const r = L.r;
    const n = 3 * L.nNodes;
    applyLevel(L, x, r);
    for (let i = 0; i < n; i++) r[i] = b[i] - r[i];
    const inv = L.diagInv;
    const om = L.omega;
    for (let nd = 0, o = 0; nd < L.nNodes; nd++, o += 9) {
      if (!L.free[nd]) continue;
      const i = 3 * nd;
      const a = r[i];
      const bb = r[i + 1];
      const c = r[i + 2];
      x[i] += om * (inv[o] * a + inv[o + 1] * bb + inv[o + 2] * c);
      x[i + 1] += om * (inv[o + 3] * a + inv[o + 4] * bb + inv[o + 5] * c);
      x[i + 2] += om * (inv[o + 6] * a + inv[o + 7] * bb + inv[o + 8] * c);
    }
  }

  private factorCoarsest(): void {
    const L = this.levels[this.levels.length - 1];
    const dof = new Int32Array(L.nNodes).fill(-1);
    let n = 0;
    for (let nd = 0; nd < L.nNodes; nd++) if (L.free[nd]) dof[nd] = 3 * n++;
    const N = 3 * n;
    const A = new Float64Array(N * N);
    for (let c = 0; c < L.nCells; c++) {
      const s = L.cellScale[c];
      const off = L.cellOff[c];
      for (let a = 0; a < 8; a++) {
        const ia = dof[L.conn[c * 8 + a]];
        if (ia < 0) continue;
        for (let bnode = 0; bnode < 8; bnode++) {
          const ib = dof[L.conn[c * 8 + bnode]];
          if (ib < 0) continue;
          for (let r = 0; r < 3; r++)
            for (let q = 0; q < 3; q++) A[(ia + r) * N + ib + q] += s * L.pool[off + (3 * a + r) * 24 + 3 * bnode + q];
        }
      }
    }
    // Cholesky (lower, in place) with pivot guard for semi-definite directions
    let maxD = 0;
    for (let i = 0; i < N; i++) maxD = Math.max(maxD, A[i * N + i]);
    const nul = new Uint8Array(N);
    for (let j = 0; j < N; j++) {
      let d = A[j * N + j];
      for (let k = 0; k < j; k++) d -= A[j * N + k] * A[j * N + k];
      if (!(d > 1e-13 * maxD)) {
        nul[j] = 1;
        A[j * N + j] = 1;
        for (let i = j + 1; i < N; i++) A[i * N + j] = 0;
        for (let k = 0; k < j; k++) A[j * N + k] = 0;
        continue;
      }
      const ljj = Math.sqrt(d);
      A[j * N + j] = ljj;
      for (let i = j + 1; i < N; i++) {
        let s = A[i * N + j];
        for (let k = 0; k < j; k++) s -= A[i * N + k] * A[j * N + k];
        A[i * N + j] = s / ljj;
      }
    }
    this.coarseDof = dof;
    this.coarseN = N;
    this.coarseL = A;
    this.coarseNull = nul;
    this.coarseY = new Float64Array(N);
  }

  private solveCoarsest(b: Float64Array, x: Float64Array): void {
    const L = this.levels[this.levels.length - 1];
    const N = this.coarseN;
    const A = this.coarseL;
    const y = this.coarseY;
    for (let nd = 0; nd < L.nNodes; nd++) {
      const i = this.coarseDof[nd];
      if (i < 0) continue;
      y[i] = b[3 * nd];
      y[i + 1] = b[3 * nd + 1];
      y[i + 2] = b[3 * nd + 2];
    }
    for (let i = 0; i < N; i++) {
      if (this.coarseNull[i]) {
        y[i] = 0;
        continue;
      }
      let s = y[i];
      for (let k = 0; k < i; k++) s -= A[i * N + k] * y[k];
      y[i] = s / A[i * N + i];
    }
    for (let i = N - 1; i >= 0; i--) {
      if (this.coarseNull[i]) {
        y[i] = 0;
        continue;
      }
      let s = y[i];
      for (let k = i + 1; k < N; k++) s -= A[k * N + i] * y[k];
      y[i] = s / A[i * N + i];
    }
    x.fill(0);
    for (let nd = 0; nd < L.nNodes; nd++) {
      const i = this.coarseDof[nd];
      if (i < 0) continue;
      x[3 * nd] = y[i];
      x[3 * nd + 1] = y[i + 1];
      x[3 * nd + 2] = y[i + 2];
    }
  }
}

function activeDofs(L: Level): number {
  let n = 0;
  for (let i = 0; i < L.nNodes; i++) if (L.free[i]) n++;
  return 3 * n;
}

export interface PcgResult {
  iterations: number;
  /** Final relative residual ‖r‖₂/‖f‖₂ (recursive residual). */
  residual: number;
  converged: boolean;
  /** True if the operator was found indefinite (pᵀAp ≤ 0), i.e. an unconstrained mechanism. */
  breakdown: boolean;
}

/**
 * Preconditioned conjugate gradients for K u = f with the multigrid V-cycle as preconditioner.
 * `u` is used as the initial guess and overwritten with the solution.
 */
export function solvePcg(
  mg: ElasticMultigrid,
  f: Float64Array,
  u: Float64Array,
  tol: number,
  maxIt: number,
  onIter?: (it: number, rel: number) => void,
): PcgResult {
  const n = f.length;
  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const q = new Float64Array(n);
  let fn = 0;
  for (let i = 0; i < n; i++) fn += f[i] * f[i];
  fn = Math.sqrt(fn);
  if (!(fn > 0)) {
    u.fill(0);
    return { iterations: 0, residual: 0, converged: true, breakdown: false };
  }
  mg.apply(u, q);
  let rn = 0;
  for (let i = 0; i < n; i++) {
    r[i] = f[i] - q[i];
    rn += r[i] * r[i];
  }
  let rel = Math.sqrt(rn) / fn;
  if (rel <= tol) return { iterations: 0, residual: rel, converged: true, breakdown: false };
  mg.precondition(r, z);
  let rz = 0;
  for (let i = 0; i < n; i++) {
    p[i] = z[i];
    rz += r[i] * z[i];
  }
  let it = 0;
  let breakdown = false;
  while (it < maxIt) {
    it++;
    mg.apply(p, q);
    let pq = 0;
    for (let i = 0; i < n; i++) pq += p[i] * q[i];
    if (!(pq > 0)) {
      breakdown = true;
      break;
    }
    const alpha = rz / pq;
    rn = 0;
    for (let i = 0; i < n; i++) {
      u[i] += alpha * p[i];
      r[i] -= alpha * q[i];
      rn += r[i] * r[i];
    }
    rel = Math.sqrt(rn) / fn;
    onIter?.(it, rel);
    if (rel <= tol) break;
    mg.precondition(r, z);
    let rzNew = 0;
    for (let i = 0; i < n; i++) rzNew += r[i] * z[i];
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return { iterations: it, residual: rel, converged: rel <= tol, breakdown };
}
