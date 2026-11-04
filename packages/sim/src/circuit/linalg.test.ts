import { describe, expect, it } from 'vitest';
import { PatternBuilder, SparseLU, minimumDegreeOrder } from './linalg';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

function denseSolve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]];
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / M[k][k];
      for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

describe('SparseLU', () => {
  it('solves random sparse systems with zero diagonals (MNA-like) and refactors', () => {
    const r = rng(42);
    for (let trial = 0; trial < 20; trial++) {
      const n = 5 + Math.floor(r() * 40);
      const pb = new PatternBuilder(n);
      const entries: [number, number][] = [];
      const dense: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
      // conductance-like part on first n-2 rows, branch-like rows with zero diagonal on the last 2
      const nb = 2;
      for (let i = 0; i < n - nb; i++) entries.push([i, i]);
      for (let k = 0; k < 2 * n; k++) {
        const i = Math.floor(r() * (n - nb));
        const j = Math.floor(r() * (n - nb));
        if (i !== j) {
          entries.push([i, j]);
          entries.push([j, i]);
        }
      }
      for (let b = 0; b < nb; b++) {
        // distinct nodes per branch -> independent branch rows (like separate voltage sources)
        const br = n - nb + b;
        const node = b * Math.floor((n - nb) / nb) + Math.floor(r() * Math.floor((n - nb) / nb));
        entries.push([br, node], [node, br]);
      }
      const handles = entries.map(([i, j]) => pb.slot(i, j));
      const pat = pb.compile();
      const lu = new SparseLU(pat);
      for (let rep = 0; rep < 3; rep++) {
        const vals = new Float64Array(pb.nnz + 1);
        for (const row of dense) row.fill(0);
        entries.forEach(([i, j], e) => {
          let v: number;
          if (i === j) v = 5 + r() * 10;
          else if (i >= n - nb || j >= n - nb) v = 1;
          else v = -r();
          vals[pb.position(handles[e])] += v;
          dense[i][j] += v;
        });
        const b = Array.from({ length: n }, () => r() * 2 - 1);
        expect(lu.factor(vals)).toBe(true);
        const x = new Float64Array(n);
        lu.solve(b, x);
        const ref = denseSolve(dense, b);
        for (let i = 0; i < n; i++) expect(x[i]).toBeCloseTo(ref[i], 8);
      }
      expect(lu.refactorizations + lu.fullFactorizations).toBe(3);
    }
  });

  it('detects singular matrices', () => {
    const pb = new PatternBuilder(2);
    const h = [pb.slot(0, 0), pb.slot(0, 1), pb.slot(1, 0), pb.slot(1, 1)];
    const pat = pb.compile();
    const lu = new SparseLU(pat);
    const v = new Float64Array(5);
    v[pb.position(h[0])] = 1;
    v[pb.position(h[1])] = 2;
    v[pb.position(h[2])] = 2;
    v[pb.position(h[3])] = 4;
    expect(lu.factor(v)).toBe(false);
  });

  it('orders a star graph centre last', () => {
    const n = 6;
    const pb = new PatternBuilder(n);
    for (let i = 0; i < n; i++) pb.slot(i, i);
    for (let i = 1; i < n; i++) {
      pb.slot(0, i);
      pb.slot(i, 0);
    }
    const order = minimumDegreeOrder(pb.compile());
    expect(order[n - 1] === 0 || order[n - 2] === 0).toBe(true);
  });
});
