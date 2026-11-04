/**
 * Minimal 2-layer grid router used only to generate believable demo boards for the gallery
 * (octilinear A* with bend penalties, via cost, per-net ownership grids with clearance inflation).
 */
import type { Vec2 } from '@pcbcad/core';

type Layer = 0 | 1; // 0 = top, 1 = bottom

const DIRS: [number, number][] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

export interface RoutedPath {
  /** Polyline segments per layer run. */
  runs: { layer: 'top' | 'bottom'; points: Vec2[] }[];
  vias: Vec2[];
}

class Heap {
  private f: number[] = [];
  private v: number[] = [];
  get size() {
    return this.v.length;
  }
  push(f: number, v: number) {
    const a = this.f;
    const b = this.v;
    a.push(f);
    b.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] <= a[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      [b[p], b[i]] = [b[i], b[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.f;
    const b = this.v;
    const top = b[0];
    const lf = a.pop()!;
    const lv = b.pop()!;
    if (b.length) {
      a[0] = lf;
      b[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l] < a[m]) m = l;
        if (r < a.length && a[r] < a[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [b[m], b[i]] = [b[i], b[m]];
        i = m;
      }
    }
    return top;
  }
}

export class DemoRouter {
  readonly nx: number;
  readonly ny: number;
  readonly res: number;
  readonly x0: number;
  readonly y0: number;
  private clearance: number;
  /** Ownership grids for narrow (index 0) and wide (index 1) traces: -1 free, -2 blocked, >=0 net. */
  private grids: Int32Array[];
  private inflate = [0, 0];
  private widths: [number, number];
  private nets = new Map<string, number>();

  constructor(bounds: { minX: number; minY: number; maxX: number; maxY: number }, opts: { res?: number; clearance?: number; edge?: number; narrow?: number; wide?: number } = {}) {
    this.res = opts.res ?? 0.2;
    this.clearance = opts.clearance ?? 0.2;
    this.widths = [opts.narrow ?? 0.25, opts.wide ?? 0.5];
    this.inflate = [this.clearance + this.widths[0] / 2, this.clearance + this.widths[1] / 2];
    this.x0 = bounds.minX;
    this.y0 = bounds.minY;
    this.nx = Math.ceil((bounds.maxX - bounds.minX) / this.res);
    this.ny = Math.ceil((bounds.maxY - bounds.minY) / this.res);
    const n = this.nx * this.ny * 2;
    this.grids = [new Int32Array(n).fill(-1), new Int32Array(n).fill(-1)];
    const edge = opts.edge ?? 0.4;
    for (let g = 0; g < 2; g++) {
      const lim = edge + this.widths[g] / 2;
      for (let j = 0; j < this.ny; j++)
        for (let i = 0; i < this.nx; i++) {
          const [x, y] = this.center(i, j);
          if (x - bounds.minX < lim || bounds.maxX - x < lim || y - bounds.minY < lim || bounds.maxY - y < lim) {
            this.grids[g][j * this.nx + i] = -2;
            this.grids[g][this.nx * this.ny + j * this.nx + i] = -2;
          }
        }
    }
  }

  private center(i: number, j: number): Vec2 {
    return [this.x0 + (i + 0.5) * this.res, this.y0 + (j + 0.5) * this.res];
  }

  private netIndex(netId: string | null): number {
    if (netId === null) return -2;
    let n = this.nets.get(netId);
    if (n === undefined) this.nets.set(netId, (n = this.nets.size));
    return n;
  }

  /** Mark copper/obstacle described by a distance function (≤ 0 inside) over a bbox. */
  private mark(layers: Layer[], box: [number, number, number, number], dist: (x: number, y: number) => number, netId: string | null, extra = 0) {
    const owner = this.netIndex(netId);
    for (let g = 0; g < 2; g++) {
      const inf = this.inflate[g] + extra;
      const i0 = Math.max(0, Math.floor((box[0] - inf - this.x0) / this.res));
      const i1 = Math.min(this.nx - 1, Math.ceil((box[2] + inf - this.x0) / this.res));
      const j0 = Math.max(0, Math.floor((box[1] - inf - this.y0) / this.res));
      const j1 = Math.min(this.ny - 1, Math.ceil((box[3] + inf - this.y0) / this.res));
      for (const l of layers) {
        const base = l * this.nx * this.ny;
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const [x, y] = this.center(i, j);
            if (dist(x, y) > inf) continue;
            const k = base + j * this.nx + i;
            const cur = this.grids[g][k];
            if (owner === -2) this.grids[g][k] = -2;
            else if (cur === -1) this.grids[g][k] = owner;
            else if (cur !== owner) this.grids[g][k] = -2;
          }
      }
    }
  }

  markRect(layers: ('top' | 'bottom')[], minX: number, minY: number, maxX: number, maxY: number, netId: string | null) {
    const L = layers.map((l) => (l === 'top' ? 0 : 1) as Layer);
    this.mark(
      L,
      [minX, minY, maxX, maxY],
      (x, y) => {
        const dx = Math.max(minX - x, 0, x - maxX);
        const dy = Math.max(minY - y, 0, y - maxY);
        return Math.hypot(dx, dy);
      },
      netId,
    );
  }

  markCircle(layers: ('top' | 'bottom')[], cx: number, cy: number, r: number, netId: string | null) {
    const L = layers.map((l) => (l === 'top' ? 0 : 1) as Layer);
    this.mark(L, [cx - r, cy - r, cx + r, cy + r], (x, y) => Math.hypot(x - cx, y - cy) - r, netId);
  }

  markSegment(layer: 'top' | 'bottom', a: Vec2, b: Vec2, hw: number, netId: string) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy || 1e-12;
    this.mark(
      [layer === 'top' ? 0 : 1],
      [Math.min(a[0], b[0]) - hw, Math.min(a[1], b[1]) - hw, Math.max(a[0], b[0]) + hw, Math.max(a[1], b[1]) + hw],
      (x, y) => {
        let t = ((x - a[0]) * dx + (y - a[1]) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)) - hw;
      },
      netId,
    );
  }

  /** Is a via of radius r free for this net at (x, y) on both layers? */
  viaFree(x: number, y: number, r: number, netId: string): boolean {
    const own = this.netIndex(netId);
    const g = this.grids[1];
    const span = Math.ceil(Math.max(0, r - this.widths[1] / 2) / this.res) + 1;
    const ci = Math.floor((x - this.x0) / this.res);
    const cj = Math.floor((y - this.y0) / this.res);
    for (let l = 0; l < 2; l++)
      for (let j = cj - span; j <= cj + span; j++)
        for (let i = ci - span; i <= ci + span; i++) {
          if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return false;
          const v = g[l * this.nx * this.ny + j * this.nx + i];
          if (v !== -1 && v !== own) return false;
        }
    return true;
  }

  route(netId: string, from: { x: number; y: number; layers: ('top' | 'bottom')[] }, to: { x: number; y: number; layers: ('top' | 'bottom')[] }, wide: boolean, opts: { allowVias?: boolean; preferLayer?: 'top' | 'bottom' } = {}): RoutedPath | null {
    const g = this.grids[wide ? 1 : 0];
    const gv = this.grids[1];
    const own = this.netIndex(netId);
    const N = this.nx * this.ny;
    const cell = (x: number, y: number) => {
      const i = Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.x0) / this.res)));
      const j = Math.max(0, Math.min(this.ny - 1, Math.floor((y - this.y0) / this.res)));
      return j * this.nx + i;
    };
    const sCell = cell(from.x, from.y);
    const tCell = cell(to.x, to.y);
    const tI = tCell % this.nx;
    const tJ = (tCell - tI) / this.nx;
    const goalLayers = new Set(to.layers.map((l) => (l === 'top' ? 0 : 1)));
    const free = (k: number) => {
      const v = g[k];
      return v === -1 || v === own;
    };
    const gScore = new Float32Array(N * 2).fill(Infinity);
    const came = new Int32Array(N * 2).fill(-1);
    const dirAt = new Int8Array(N * 2).fill(-1);
    const closed = new Uint8Array(N * 2);
    const heap = new Heap();
    const h = (k: number) => {
      const c = k % N;
      const i = c % this.nx;
      const j = (c - i) / this.nx;
      const dx = Math.abs(i - tI);
      const dy = Math.abs(j - tJ);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    for (const l of from.layers) {
      const k = (l === 'top' ? 0 : 1) * N + sCell;
      gScore[k] = l === opts.preferLayer || !opts.preferLayer ? 0 : 3;
      heap.push(h(k) + gScore[k], k);
    }
    const allowVias = opts.allowVias ?? true;
    let found = -1;
    let iterations = 0;
    while (heap.size) {
      const k = heap.pop();
      if (closed[k]) continue;
      closed[k] = 1;
      if (++iterations > 600000) break;
      const layer = k >= N ? 1 : 0;
      const c = k - layer * N;
      if (c === tCell && goalLayers.has(layer)) {
        found = k;
        break;
      }
      const i = c % this.nx;
      const j = (c - i) / this.nx;
      const d0 = dirAt[k];
      for (let d = 0; d < 8; d++) {
        const ni = i + DIRS[d][0];
        const nj = j + DIRS[d][1];
        if (ni < 0 || nj < 0 || ni >= this.nx || nj >= this.ny) continue;
        const nc = nj * this.nx + ni;
        const nk = layer * N + nc;
        if (closed[nk] || !free(nk)) continue;
        if (d % 2 === 1) {
          // No corner cutting.
          if (!free(layer * N + j * this.nx + ni) || !free(layer * N + nj * this.nx + i)) continue;
        }
        let cost = d % 2 ? Math.SQRT2 : 1;
        if (d0 >= 0 && d0 !== d) {
          const turn = Math.min((d - d0 + 8) % 8, (d0 - d + 8) % 8);
          cost += turn === 1 ? 0.6 : turn === 2 ? 2.5 : 8;
        }
        if (opts.preferLayer && layer !== (opts.preferLayer === 'top' ? 0 : 1)) cost *= 1.6;
        const ng = gScore[k] + cost;
        if (ng < gScore[nk]) {
          gScore[nk] = ng;
          came[nk] = k;
          dirAt[nk] = d;
          heap.push(ng + h(nk), nk);
        }
      }
      if (allowVias) {
        const ok = (lk: number) => {
          const v = gv[lk];
          return v === -1 || v === own;
        };
        const other = 1 - layer;
        const ok3 = () => {
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++) {
              const ii = i + di;
              const jj = j + dj;
              if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.ny) return false;
              const cc = jj * this.nx + ii;
              if (!ok(cc) || !ok(N + cc)) return false;
            }
          return true;
        };
        const nk = other * N + c;
        if (!closed[nk] && free(nk) && ok3()) {
          const ng = gScore[k] + 14;
          if (ng < gScore[nk]) {
            gScore[nk] = ng;
            came[nk] = k;
            dirAt[nk] = -1;
            heap.push(ng + h(nk), nk);
          }
        }
      }
    }
    if (found < 0) return null;
    // Reconstruct.
    const states: number[] = [];
    for (let k = found; k >= 0; k = came[k]) states.push(k);
    states.reverse();
    const runs: RoutedPath['runs'] = [];
    const vias: Vec2[] = [];
    let cur: { layer: 'top' | 'bottom'; points: Vec2[] } | null = null;
    for (let s = 0; s < states.length; s++) {
      const k = states[s];
      const layer = k >= N ? 1 : 0;
      const c = k - layer * N;
      const i = c % this.nx;
      const j = (c - i) / this.nx;
      const p = this.center(i, j);
      const lname = layer === 0 ? 'top' : 'bottom';
      if (!cur || cur.layer !== lname) {
        if (cur) {
          vias.push(cur.points[cur.points.length - 1]);
          cur = { layer: lname, points: [cur.points[cur.points.length - 1]] };
        } else cur = { layer: lname, points: [p] };
        runs.push(cur);
        if (cur.points[0] !== p) cur.points.push(p);
      } else cur.points.push(p);
    }
    // Snap ends to pad centres and simplify collinear points.
    if (runs.length) {
      runs[0].points[0] = [from.x, from.y];
      const last = runs[runs.length - 1];
      last.points[last.points.length - 1] = [to.x, to.y];
    }
    for (const r of runs) r.points = simplify(r.points);
    return { runs: runs.filter((r) => r.points.length >= 2), vias };
  }

  /** Mark a routed path as owned copper. */
  commit(netId: string, path: RoutedPath, width: number, viaDiameter: number) {
    for (const r of path.runs) for (let i = 0; i + 1 < r.points.length; i++) this.markSegment(r.layer, r.points[i], r.points[i + 1], width / 2, netId);
    for (const v of path.vias) this.markCircle(['top', 'bottom'], v[0], v[1], viaDiameter / 2, netId);
  }
}

function simplify(pts: Vec2[]): Vec2[] {
  if (pts.length < 3) return pts;
  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-9) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out.map((p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000] as Vec2);
}
