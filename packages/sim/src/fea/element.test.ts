import { describe, expect, it } from 'vitest';
import { NODE_XI, STRESS_POINTS, elasticityMatrix, hexElement, vonMises } from './element';

/** Nodal displacement vector for u(x) = G·x on the unit cube (x ∈ [0,1]³). */
function linearField(G: number[][]): Float64Array {
  const u = new Float64Array(24);
  for (let a = 0; a < 8; a++) {
    const x = NODE_XI[a].map((c) => (c + 1) / 2);
    for (let r = 0; r < 3; r++) u[3 * a + r] = G[r][0] * x[0] + G[r][1] * x[1] + G[r][2] * x[2];
  }
  return u;
}

function matVec(K: Float64Array, u: Float64Array): Float64Array {
  const out = new Float64Array(24);
  for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) out[i] += K[i * 24 + j] * u[j];
  return out;
}

describe('hex8 incompatible-mode element', () => {
  for (const nu of [0, 0.3, 0.45]) {
    it(`is symmetric and annihilates rigid-body motion (ν=${nu})`, () => {
      const { K } = hexElement(nu);
      for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) expect(K[i * 24 + j]).toBeCloseTo(K[j * 24 + i], 14);
      const rigid = [
        [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
        [[0, -1, 0], [1, 0, 0], [0, 0, 0]],
        [[0, 0, 1], [0, 0, 0], [-1, 0, 0]],
        [[0, 0, 0], [0, 0, -1], [0, 1, 0]],
      ];
      for (const G of rigid) {
        const f = matVec(K, linearField(G));
        for (const v of f) expect(Math.abs(v)).toBeLessThan(1e-12);
      }
      const t = new Float64Array(24);
      for (let a = 0; a < 8; a++) t[3 * a + 1] = 1;
      for (const v of matVec(K, t)) expect(Math.abs(v)).toBeLessThan(1e-12);
    });
  }

  it('passes the constant-strain patch test at every stress point', () => {
    const nu = 0.3;
    const { S } = hexElement(nu);
    const D = elasticityMatrix(1, nu);
    // arbitrary constant strain via displacement gradient
    const G = [
      [1e-3, 2e-4, -3e-4],
      [5e-4, -2e-3, 1e-4],
      [0, 4e-4, 7e-4],
    ];
    const eps = [G[0][0], G[1][1], G[2][2], G[0][1] + G[1][0], G[1][2] + G[2][1], G[2][0] + G[0][2]];
    const sigma = new Array(6).fill(0);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) sigma[i] += D[i * 6 + j] * eps[j];
    const u = linearField(G);
    for (let p = 0; p < STRESS_POINTS.length; p++) {
      for (let r = 0; r < 6; r++) {
        let s = 0;
        for (let c = 0; c < 24; c++) s += S[p * 144 + r * 24 + c] * u[c];
        expect(s).toBeCloseTo(sigma[r], 12);
      }
    }
  });

  it('represents pure bending without parasitic shear (incompatible modes)', () => {
    // u = −κ x z, w = κ x²/2 (beam bending about y); nodal values only carry the bilinear part,
    // the incompatible modes must absorb the quadratic part so that the bending energy is exact.
    const nu = 0;
    const { K } = hexElement(nu);
    const kappa = 1e-3;
    const u = new Float64Array(24);
    for (let a = 0; a < 8; a++) {
      const x = (NODE_XI[a][0] + 1) / 2 - 0.5;
      const z = (NODE_XI[a][2] + 1) / 2 - 0.5;
      u[3 * a] = -kappa * x * z;
      u[3 * a + 2] = (kappa * x * x) / 2;
    }
    const f = matVec(K, u);
    let energy = 0;
    for (let i = 0; i < 24; i++) energy += 0.5 * u[i] * f[i];
    // exact: ½ ∫ E κ² z² dV = ½ κ² / 12 for the unit cube with E = 1, ν = 0
    expect(energy).toBeCloseTo((0.5 * kappa * kappa) / 12, 12);
  });

  it('computes von Mises correctly', () => {
    expect(vonMises(100, 0, 0, 0, 0, 0)).toBeCloseTo(100, 10);
    expect(vonMises(0, 0, 0, 10, 0, 0)).toBeCloseTo(10 * Math.sqrt(3), 10);
    expect(vonMises(-5, -5, -5, 0, 0, 0)).toBeCloseTo(0, 10);
  });
});
