/**
 * Fastener render meshes (pure JS, synchronous) and fastener dimension defaults.
 *
 * Local frame of fastenerMesh(spec): axis = Z, origin on the axis.
 *  - screws / bolts / self-tapping / rivets: z = 0 is the bearing face under the head; the head
 *    occupies z ∈ [−headHeight, 0] and the shank runs toward +Z to z = length (insertion direction
 *    head → tip = +Z). For 'flat' (countersunk) heads the cone occupies z ∈ [−headHeight, 0].
 *  - nuts, washers, standoffs, heat-set inserts, PEM nuts/standoffs: body from z = 0 to z = length
 *    (+Z); male standoff studs extend beyond (z > length, and z < 0 for male-male); PEM clinch shanks
 *    sit at z ∈ [−shank, 0].
 * FastenerInstance.position is the bearing point for screws and the CENTRE for nuts/inserts/etc.;
 * fastenerPlacement() returns the matrix that maps this local frame into the assembly accordingly.
 */
import type { FastenerInstance, FastenerSpec, Mat4, MeshData, Vec2, Vec3 } from '@pcbcad/core';
import { getMaterial } from '@pcbcad/core';
import { mat4FromBasis, v3 } from './mat';
import { makeMesh } from './meshutil';
import { circlePoly, circleSegments } from './poly';
import { defaultHeadDiameter } from './shell';

export interface FastenerDims {
  d: number;
  length: number;
  head: NonNullable<FastenerSpec['head']>;
  headDiameter: number;
  headHeight: number;
  /** Outer diameter (round) or across-flats (hex) of nut/standoff/insert bodies. */
  outer: number;
  /** Hole / bore diameter. */
  hole: number;
  isScrew: boolean;
}

const SCREW_TYPES = new Set(['screw', 'self-tapping-screw', 'bolt', 'rivet']);

/** Resolve missing fastener dimensions with ISO-typical proportions of the nominal diameter d. */
export function fastenerDims(spec: FastenerSpec): FastenerDims {
  const d = spec.diameter > 0 ? spec.diameter : 3;
  const isScrew = SCREW_TYPES.has(spec.type);
  const head = spec.head ?? (spec.type === 'bolt' ? 'hex' : spec.type === 'rivet' ? 'button' : isScrew ? 'pan' : 'none');
  const hd = spec.headDiameter ?? defaultHeadDiameter({ ...spec, head });
  const hhDefault: Record<string, number> = { pan: 0.6 * d, socket: d, button: 0.55 * d, flat: Math.max(0.3 * d, (hd - d) / 2), hex: 0.65 * d, none: 0 };
  const hh = spec.headHeight ?? hhDefault[head] ?? 0.6 * d;
  let length = spec.length ?? 0;
  let outer = spec.outerDiameter ?? 0;
  let hole = spec.holeDiameter ?? 0;
  switch (spec.type) {
    case 'nut':
    case 'pem-nut':
      length ||= 0.8 * d;
      outer ||= spec.type === 'nut' ? 1.6 * d + 0.7 : 1.45 * d + 1.2;
      hole = d;
      break;
    case 'washer':
      length ||= Math.max(0.3, 0.17 * d);
      outer ||= 2.1 * d + 0.7;
      hole ||= d + 0.2;
      break;
    case 'standoff':
    case 'pem-standoff':
      length ||= 10;
      outer ||= d <= 2.5 ? d + 1.5 : d <= 3 ? 5 : 1.6 * d;
      hole = d;
      break;
    case 'heat-set-insert':
      length ||= insertTable(d).length;
      outer ||= insertTable(d).od;
      hole = d;
      break;
    default:
      length ||= 3 * d;
      outer ||= d;
      hole ||= clearanceHole(d);
  }
  return { d, length, head, headDiameter: hd, headHeight: head === 'none' ? 0 : hh, outer, hole, isScrew };
}

/** ISO 273 "medium" clearance hole for metric screws. */
export function clearanceHole(d: number): number {
  const t: [number, number][] = [
    [1.6, 1.8], [2, 2.4], [2.5, 2.9], [3, 3.4], [3.5, 3.9], [4, 4.5], [5, 5.5], [6, 6.6], [8, 9], [10, 11],
  ];
  for (const [n, h] of t) if (Math.abs(n - d) < 0.05) return h;
  return Math.round((d * 1.1 + 0.15) * 10) / 10;
}

/** Typical brass heat-set insert dimensions (install hole tapered; values are the nominal hole). */
export function insertTable(d: number): { od: number; hole: number; length: number } {
  if (d <= 2.05) return { od: 3.6, hole: 3.2, length: 4.0 };
  if (d <= 2.55) return { od: 4.0, hole: 3.6, length: 4.5 };
  if (d <= 3.05) return { od: 4.6, hole: 4.0, length: 5.0 };
  if (d <= 4.05) return { od: 5.6, hole: 5.0, length: 6.0 };
  return { od: 1.3 * d + 1.0, hole: 1.15 * d + 0.6, length: 1.6 * d };
}

/** Pilot hole for thread-forming screws in thermoplastics (≈ 0.8·d, e.g. EJOT PT/DELTA PT guidance). */
export function pilotHole(d: number): number {
  return Math.round(0.8 * d * 10) / 10;
}

/* ------------------------------------------ mesh builder ---------------------------------------- */

class MeshBuilder {
  pos: number[] = [];
  idx: number[] = [];
  private start = 0;
  begin(): void {
    this.start = this.idx.length;
  }
  /** Ensure the part added since begin() has positive signed volume (flip otherwise). */
  end(): void {
    let v = 0;
    const p = this.pos;
    for (let t = this.start; t + 2 < this.idx.length; t += 3) {
      const a = this.idx[t] * 3, b = this.idx[t + 1] * 3, c = this.idx[t + 2] * 3;
      v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    if (v < 0) for (let t = this.start; t + 2 < this.idx.length; t += 3) [this.idx[t + 1], this.idx[t + 2]] = [this.idx[t + 2], this.idx[t + 1]];
  }
  v(x: number, y: number, z: number): number {
    this.pos.push(x, y, z);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  /** Surface of revolution about Z; profile (r, z) must start and end on the axis (r = 0). */
  lathe(profile: Vec2[], seg: number): void {
    this.begin();
    const n = profile.length;
    const rings: number[][] = [];
    const poles: number[] = [];
    for (let i = 0; i < n; i++) {
      const [r, z] = profile[i];
      if (i === 0 || i === n - 1) {
        poles[i] = this.v(0, 0, z);
        continue;
      }
      const ring: number[] = [];
      for (let k = 0; k < seg; k++) {
        const a = (2 * Math.PI * k) / seg;
        ring.push(this.v(r * Math.cos(a), r * Math.sin(a), z));
      }
      rings[i] = ring;
    }
    for (let k = 0; k < seg; k++) {
      const k1 = (k + 1) % seg;
      this.tri(poles[0], rings[1][k1], rings[1][k]);
      for (let i = 1; i < n - 2; i++) {
        const A = rings[i], B = rings[i + 1];
        this.tri(A[k], B[k1], B[k]);
        this.tri(A[k], A[k1], B[k1]);
      }
      this.tri(poles[n - 1], rings[n - 2][k], rings[n - 2][k1]);
    }
    this.end();
  }
  /** Prism of a polygon that is star-shaped about the origin. */
  prism(poly: Vec2[], z0: number, z1: number): void {
    this.begin();
    const n = poly.length;
    const c0 = this.v(0, 0, z0);
    const c1 = this.v(0, 0, z1);
    const b = poly.map(([x, y]) => this.v(x, y, z0));
    const t = poly.map(([x, y]) => this.v(x, y, z1));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.tri(b[i], b[j], t[j]);
      this.tri(b[i], t[j], t[i]);
      this.tri(c1, t[i], t[j]);
      this.tri(c0, b[j], b[i]);
    }
    this.end();
  }
  /** Tube between two concentric star-shaped loops (both CCW about the origin). */
  ring(outer: Vec2[], inner: Vec2[], z0: number, z1: number): void {
    this.begin();
    const ang = (p: Vec2) => {
      const a = Math.atan2(p[1], p[0]);
      return a < 0 ? a + 2 * Math.PI : a;
    };
    const sortLoop = (l: Vec2[]) => {
      let s = 0;
      for (let i = 1; i < l.length; i++) if (ang(l[i]) < ang(l[s])) s = i;
      return [...l.slice(s), ...l.slice(0, s)];
    };
    const O = sortLoop(outer);
    const I = sortLoop(inner);
    const angs = (l: Vec2[]) => {
      const a = l.map(ang);
      for (let i = 1; i < a.length; i++) while (a[i] < a[i - 1]) a[i] += 2 * Math.PI;
      a.push(a[0] + 2 * Math.PI);
      return a;
    };
    const aO = angs(O);
    const aI = angs(I);
    const ob = O.map(([x, y]) => this.v(x, y, z0));
    const ot = O.map(([x, y]) => this.v(x, y, z1));
    const ib = I.map(([x, y]) => this.v(x, y, z0));
    const it = I.map(([x, y]) => this.v(x, y, z1));
    const nO = O.length, nI = I.length;
    for (let i = 0; i < nO; i++) {
      const j = (i + 1) % nO;
      this.tri(ob[i], ob[j], ot[j]);
      this.tri(ob[i], ot[j], ot[i]);
    }
    for (let i = 0; i < nI; i++) {
      const j = (i + 1) % nI;
      this.tri(ib[i], it[j], ib[j]);
      this.tri(ib[i], it[i], it[j]);
    }
    let i = 0, j = 0;
    while (i < nO || j < nI) {
      const oi = i % nO, oi1 = (i + 1) % nO, ij = j % nI, ij1 = (j + 1) % nI;
      if (j >= nI || (i < nO && aO[i + 1] <= aI[j + 1])) {
        this.tri(ot[oi], ot[oi1], it[ij]);
        this.tri(ob[oi], ib[ij], ob[oi1]);
        i++;
      } else {
        this.tri(ot[oi], it[ij1], it[ij]);
        this.tri(ob[oi], ib[ij], ib[ij1]);
        j++;
      }
    }
    this.end();
  }
}

function hexPoly(acrossFlats: number): Vec2[] {
  const R = acrossFlats / Math.sqrt(3);
  const p: Vec2[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k + Math.PI / 6;
    p.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  return p;
}

function knurlPoly(od: number, depth: number): Vec2[] {
  const n = Math.max(8, Math.round((Math.PI * od) / 0.9));
  const p: Vec2[] = [];
  for (let k = 0; k < 2 * n; k++) {
    const a = (Math.PI * k) / n;
    const r = k % 2 ? od / 2 - depth : od / 2;
    p.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return p;
}

/** Screw/bolt shank profile from the bearing face (z = 0) to the tip (closing on the axis). */
function shankProfile(d: number, L: number, pointed: boolean): Vec2[] {
  const r = d / 2;
  if (pointed) {
    const tip = Math.min(0.9 * d, 0.5 * L);
    return [[r, 0], [r, L - tip], [0.18 * d, L], [0, L]];
  }
  const ch = Math.min(0.12 * d, 0.2 * L);
  return [[r, 0], [r, L - ch], [r - ch, L], [0, L]];
}

/**
 * Render mesh for a fastener (single group, coloured by material). See the module comment for the
 * local frame. Threads are not modelled; drive recesses are modelled for hex/torx drives.
 */
export function fastenerMesh(spec: FastenerSpec): MeshData {
  const dm = fastenerDims(spec);
  const { d, length: L, headDiameter: dh, headHeight: hh } = dm;
  const mb = new MeshBuilder();
  const seg = Math.max(24, circleSegments(Math.max(dh, dm.outer, d) / 2));
  const circ = (r: number) => circlePoly(0, 0, r, seg);
  switch (spec.type) {
    case 'nut':
      mb.ring(hexPoly(dm.outer), circ(d / 2), 0, L);
      break;
    case 'washer':
      mb.ring(circ(dm.outer / 2), circ(dm.hole / 2), 0, L);
      break;
    case 'standoff': {
      mb.ring(hexPoly(dm.outer), circ(d / 2), 0, L);
      const stud = Math.min(2 * d, 6);
      const studProfile = (z0: number, z1: number): Vec2[] => [[0, z0], [d / 2 - 0.1 * d, z0], [d / 2, z0 + 0.1 * d], [d / 2, z1 - 0.1 * d], [d / 2 - 0.1 * d, z1], [0, z1]];
      if (spec.ends === 'male-female' || spec.ends === 'male-male') mb.lathe(studProfile(L, L + stud), seg);
      if (spec.ends === 'male-male') mb.lathe(studProfile(-stud, 0), seg);
      break;
    }
    case 'pem-standoff':
      mb.ring(circ(dm.outer / 2), circ(d / 2), 0, L);
      mb.ring(circ(dm.outer / 2 + 0.6), circ(d / 2), -1.0, 0);
      break;
    case 'pem-nut':
      mb.ring(circ(dm.outer / 2), circ(d / 2), 0, L);
      mb.ring(circ(Math.max(d / 2 + 0.5, dm.outer / 2 - 0.9)), circ(d / 2), -1.0, 0);
      break;
    case 'heat-set-insert': {
      const kd = Math.min(0.25, 0.06 * dm.outer);
      mb.ring(knurlPoly(dm.outer, kd), circ(d / 2), 0, 0.42 * L);
      mb.ring(circ(dm.outer / 2 - kd * 1.5), circ(d / 2), 0.42 * L, 0.58 * L);
      mb.ring(knurlPoly(dm.outer, kd), circ(d / 2), 0.58 * L, L);
      break;
    }
    default: {
      // screws, bolts, rivets
      const pointed = spec.type === 'self-tapping-screw';
      const shank = shankProfile(d, Math.max(0.1, L), pointed);
      const r = dh / 2;
      const head = dm.head;
      if (head === 'hex') {
        mb.prism(hexPoly(dh), -hh, 0);
        mb.lathe([[0, 0], ...shank], seg);
      } else if (head === 'socket' && hh > 0) {
        const recess = Math.min(0.6 * hh, hh - 0.2);
        const key = Math.min(0.5 * dh, 0.8 * d + 0.2);
        mb.ring(circ(r), hexPoly(key), -hh, -hh + recess);
        const f = 0.08 * hh;
        mb.lathe([[0, -hh + recess], [r, -hh + recess], [r, -f], [r - f, 0], ...shank], seg);
      } else if (head === 'flat') {
        mb.lathe([[0, -hh], [r, -hh], [r, -hh + 0.06 * hh], [d / 2, 0], ...shank], seg);
      } else if (head === 'button' || head === 'pan') {
        const prof: Vec2[] = [[0, -hh]];
        const n = 8;
        if (head === 'button') {
          for (let k = 1; k <= n; k++) {
            const a = ((k / n) * Math.PI) / 2;
            prof.push([r * Math.sin(a), -hh * Math.cos(a) * 0.9 - 0.1 * hh]);
          }
        } else {
          const f = 0.35 * hh;
          for (let k = 0; k <= n; k++) {
            const a = ((k / n) * Math.PI) / 2;
            prof.push([r - f + f * Math.sin(a), -hh + f - f * Math.cos(a)]);
          }
        }
        prof.push([r, 0], ...shank);
        mb.lathe(prof, seg);
      } else {
        mb.lathe([[0, 0], ...shank], seg);
      }
    }
  }
  const mat = getMaterial(spec.materialId);
  return makeMesh(new Float32Array(mb.pos), new Uint32Array(mb.idx), {
    name: `${spec.thread ?? `M${d}`} ${spec.type}${dm.isScrew ? ` × ${L}` : ''}`,
    color: mat?.color ?? '#a3a8ae',
    metal: (mat?.family ?? 'metal') === 'metal',
  });
}

/**
 * Matrix placing fastenerMesh(spec) at a FastenerInstance: local +Z → instance direction; origin →
 * position for screws (bearing point), position − direction·length/2 for centred items.
 */
export function fastenerPlacement(fi: FastenerInstance, spec?: FastenerSpec): Mat4 {
  const z = v3.norm(fi.direction ?? [0, 0, 1]);
  const ref: Vec3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = v3.norm(v3.cross(ref, z));
  const y = v3.cross(z, x);
  let o = fi.position;
  if (spec && !SCREW_TYPES.has(spec.type)) o = v3.madd(fi.position, z, -fastenerDims(spec).length / 2);
  return mat4FromBasis(o, x, y, z);
}
