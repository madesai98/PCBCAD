/**
 * Cubic 8-node hexahedron with Wilson–Taylor incompatible modes (QM6-style), statically condensed.
 *
 * All voxels of a grid are identical cubes, so the element stiffness only depends on the material:
 *     K_e = E · h · K̂(ν)          (E in MPa = N/mm², h in mm  →  K_e in N/mm)
 * where K̂(ν) is the dimensionless stiffness of a unit cube with E = 1.
 *
 * Formulation
 *  - Trilinear displacement interpolation (24 nodal DOFs) enriched with the 9 incompatible bubble modes
 *    (1-ξ²), (1-η²), (1-ζ²) for each displacement component. For a parallelepiped the Taylor patch-test
 *    correction is identically zero, so Wilson's and Taylor's elements coincide here.
 *  - 2×2×2 Gauss quadrature, which is exact for the cube.
 *  - Internal DOFs are condensed: K̂ = K_cc − K_ci K_ii⁻¹ K_ic. The enhancement removes the parasitic shear
 *    that makes plain trilinear hexes far too stiff in bending, so walls only 1–2 voxels thick bend correctly.
 *  - Stress recovery uses the full enhanced strain field: α = R·u with R = −K_ii⁻¹ K_ic, then
 *    σ(ξ) = (E/h) · D̂ · (B̂_c(ξ) u + B̂_i(ξ) α). At the centroid the enhanced strain vanishes.
 *
 * Local node numbering: node a = ix + 2·iy + 4·iz is at offset (ix, iy, iz) ∈ {0,1}³ from the voxel's min
 * corner. DOF ordering is [ux0, uy0, uz0, ux1, …]. Voigt strain/stress ordering is [xx, yy, zz, xy, yz, zx]
 * with engineering shear strains.
 */

/** Natural coordinates (±1) of the 8 local nodes. */
export const NODE_XI: ReadonlyArray<readonly [number, number, number]> = [0, 1, 2, 3, 4, 5, 6, 7].map(
  (a) => [((a & 1) << 1) - 1, (((a >> 1) & 1) << 1) - 1, (((a >> 2) & 1) << 1) - 1] as const,
);

/**
 * Stress sample points in natural coordinates: 0 = centroid, then the six face centres
 * 1 = −x, 2 = +x, 3 = −y, 4 = +y, 5 = −z, 6 = +z.
 */
export const STRESS_POINTS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
];

/** Precomputed, material-dependent (ν only) element data for a unit cube with E = 1. */
export interface HexElementData {
  nu: number;
  /** 24×24 condensed stiffness, row-major (multiply by E·h). */
  K: Float64Array;
  /** 6×6 constitutive matrix for E = 1, row-major. */
  D: Float64Array;
  /**
   * Stress operators, one 6×24 row-major block per STRESS_POINTS entry (7 blocks):
   * σ(point) = (E / h) · S[point] · u_e   (u in mm, σ in MPa).
   */
  S: Float64Array;
}

/** Isotropic linear-elastic D matrix (Voigt, engineering shear) for the given E and ν. */
export function elasticityMatrix(E: number, nu: number): Float64Array {
  const D = new Float64Array(36);
  const lam = (E * nu) / ((1 + nu) * (1 - 2 * nu));
  const mu = E / (2 * (1 + nu));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) D[i * 6 + j] = lam;
    D[i * 6 + i] = lam + 2 * mu;
    D[(i + 3) * 6 + (i + 3)] = mu;
  }
  return D;
}

/** Write the 6×3 B-block for a scalar function with gradient g into B (6 × ncol, row-major) at column col. */
function putB(B: Float64Array, ncol: number, col: number, gx: number, gy: number, gz: number): void {
  // ε_xx = ∂u/∂x, ε_yy = ∂v/∂y, ε_zz = ∂w/∂z, γ_xy = ∂u/∂y + ∂v/∂x, γ_yz = ∂v/∂z + ∂w/∂y, γ_zx = ∂w/∂x + ∂u/∂z
  B[0 * ncol + col] = gx;
  B[1 * ncol + col + 1] = gy;
  B[2 * ncol + col + 2] = gz;
  B[3 * ncol + col] = gy;
  B[3 * ncol + col + 1] = gx;
  B[4 * ncol + col + 1] = gz;
  B[4 * ncol + col + 2] = gy;
  B[5 * ncol + col] = gz;
  B[5 * ncol + col + 2] = gx;
}

/** Compatible (24 columns) and incompatible (9 columns) B matrices of the unit cube at (ξ, η, ζ). */
function bMatrices(xi: number, eta: number, zeta: number): { Bc: Float64Array; Bi: Float64Array } {
  const Bc = new Float64Array(6 * 24);
  const Bi = new Float64Array(6 * 9);
  // unit cube: x = (ξ+1)/2  →  ∂/∂x = 2 ∂/∂ξ
  for (let a = 0; a < 8; a++) {
    const [xa, ya, za] = NODE_XI[a];
    const gx = 2 * 0.125 * xa * (1 + ya * eta) * (1 + za * zeta);
    const gy = 2 * 0.125 * ya * (1 + xa * xi) * (1 + za * zeta);
    const gz = 2 * 0.125 * za * (1 + xa * xi) * (1 + ya * eta);
    putB(Bc, 24, 3 * a, gx, gy, gz);
  }
  // incompatible modes M1 = 1-ξ², M2 = 1-η², M3 = 1-ζ²: ∂M1/∂x = 2·(−2ξ) etc.
  putB(Bi, 9, 0, -4 * xi, 0, 0);
  putB(Bi, 9, 3, 0, -4 * eta, 0);
  putB(Bi, 9, 6, 0, 0, -4 * zeta);
  return { Bc, Bi };
}

/** C (m×n) += alpha · Aᵀ (k×m) · B (k×n), all row-major. */
function addAtB(C: Float64Array, A: Float64Array, B: Float64Array, k: number, m: number, n: number, alpha: number): void {
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let l = 0; l < k; l++) s += A[l * m + i] * B[l * n + j];
      C[i * n + j] += alpha * s;
    }
  }
}

/** Plain matrix product (m×k)·(k×n). */
function matMul(A: Float64Array, B: Float64Array, m: number, k: number, n: number): Float64Array {
  const C = new Float64Array(m * n);
  for (let i = 0; i < m; i++) {
    for (let l = 0; l < k; l++) {
      const a = A[i * k + l];
      if (a === 0) continue;
      for (let j = 0; j < n; j++) C[i * n + j] += a * B[l * n + j];
    }
  }
  return C;
}

/** Solve A X = B for small dense SPD A (n×n) with multiple right-hand sides (n×m); Gauss–Jordan with pivoting. */
function solveDense(A: Float64Array, B: Float64Array, n: number, m: number): Float64Array {
  const a = Float64Array.from(A);
  const b = Float64Array.from(B);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r * n + c]) > Math.abs(a[p * n + c])) p = r;
    if (p !== c) {
      for (let j = 0; j < n; j++) [a[c * n + j], a[p * n + j]] = [a[p * n + j], a[c * n + j]];
      for (let j = 0; j < m; j++) [b[c * m + j], b[p * m + j]] = [b[p * m + j], b[c * m + j]];
    }
    const piv = a[c * n + c];
    if (Math.abs(piv) < 1e-300) throw new Error('element: singular internal-mode matrix');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r * n + c] / piv;
      if (f === 0) continue;
      for (let j = c; j < n; j++) a[r * n + j] -= f * a[c * n + j];
      for (let j = 0; j < m; j++) b[r * m + j] -= f * b[c * m + j];
    }
  }
  for (let r = 0; r < n; r++) {
    const piv = a[r * n + r];
    for (let j = 0; j < m; j++) b[r * m + j] /= piv;
  }
  return b;
}

const CACHE = new Map<number, HexElementData>();

/**
 * Element data for Poisson ratio ν (cached). ν must be in [0, 0.5); values ≥ 0.4999 are clamped.
 * Valid for any E and h via the scalings documented on {@link HexElementData}.
 */
export function hexElement(nu: number): HexElementData {
  const v = Math.min(Math.max(Number.isFinite(nu) ? nu : 0.3, -0.99), 0.4999);
  const cached = CACHE.get(v);
  if (cached) return cached;
  const D = elasticityMatrix(1, v);
  const Kcc = new Float64Array(24 * 24);
  const Kci = new Float64Array(24 * 9);
  const Kii = new Float64Array(9 * 9);
  const g = 1 / Math.sqrt(3);
  // unit cube: detJ = 1/8, Gauss weights = 1
  const w = 1 / 8;
  for (const xi of [-g, g])
    for (const eta of [-g, g])
      for (const zeta of [-g, g]) {
        const { Bc, Bi } = bMatrices(xi, eta, zeta);
        const DBc = matMul(D, Bc, 6, 6, 24);
        const DBi = matMul(D, Bi, 6, 6, 9);
        addAtB(Kcc, Bc, DBc, 6, 24, 24, w);
        addAtB(Kci, Bc, DBi, 6, 24, 9, w);
        addAtB(Kii, Bi, DBi, 6, 9, 9, w);
      }
  // R = −Kii⁻¹ Kic  (9×24)
  const Kic = new Float64Array(9 * 24);
  for (let i = 0; i < 24; i++) for (let j = 0; j < 9; j++) Kic[j * 24 + i] = Kci[i * 9 + j];
  const X = solveDense(Kii, Kic, 9, 24);
  const R = new Float64Array(9 * 24);
  for (let i = 0; i < R.length; i++) R[i] = -X[i];
  // K = Kcc + Kci R
  const K = Float64Array.from(Kcc);
  const KciR = matMul(Kci, R, 24, 9, 24);
  for (let i = 0; i < K.length; i++) K[i] += KciR[i];
  // exact symmetrisation (removes round-off asymmetry)
  for (let i = 0; i < 24; i++)
    for (let j = i + 1; j < 24; j++) {
      const s = 0.5 * (K[i * 24 + j] + K[j * 24 + i]);
      K[i * 24 + j] = s;
      K[j * 24 + i] = s;
    }
  // stress operators at the sample points: S = D (Bc + Bi R)
  const S = new Float64Array(STRESS_POINTS.length * 6 * 24);
  STRESS_POINTS.forEach(([xi, eta, zeta], p) => {
    const { Bc, Bi } = bMatrices(xi, eta, zeta);
    const BiR = matMul(Bi, R, 6, 9, 24);
    for (let i = 0; i < Bc.length; i++) Bc[i] += BiR[i];
    S.set(matMul(D, Bc, 6, 6, 24), p * 144);
  });
  const data: HexElementData = { nu: v, K, D, S };
  CACHE.set(v, data);
  return data;
}

/** von Mises equivalent stress of a Voigt stress vector [xx, yy, zz, xy, yz, zx]. */
export function vonMises(sxx: number, syy: number, szz: number, sxy: number, syz: number, szx: number): number {
  const a = sxx - syy;
  const b = syy - szz;
  const c = szz - sxx;
  return Math.sqrt(0.5 * (a * a + b * b + c * c) + 3 * (sxy * sxy + syz * syz + szx * szx));
}
