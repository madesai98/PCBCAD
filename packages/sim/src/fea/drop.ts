import type { DropResult, Vec3 } from '@pcbcad/core';
import { resolveRegion } from './regions';
import type { RegionGrid } from './regions';
import { analyzeStructure, buildStructuralResult } from './structural';
import type { StructuralAnalysis } from './structural';
import type { StructuralResultDetail, DropFloor, DropOrientation, DropSetup, Region, StructuralLoad } from './types';

/** Standard gravity (m/s²). */
export const G0 = 9.81;

/**
 * Lumped floor contact stiffness (N/m) placed in series with the structure. Assumed values for a
 * hand-held product (local surface compliance of the floor + its support): concrete/tile 5e7,
 * wooden floor 1e7, carpet over underlay 1e6. They dominate the result for stiff products.
 */
export const FLOOR_STIFFNESS: Record<DropFloor, number> = {
  concrete: 5e7,
  wood: 1e7,
  carpet: 1e6,
};

/** Unit vector pointing from the product toward the floor (grid frame) for each orientation. */
export function dropDirection(o: DropOrientation): Vec3 {
  const r2 = Math.SQRT1_2;
  const r3 = 1 / Math.sqrt(3);
  switch (o) {
    case 'bottom':
      return [0, 0, -1];
    case 'top':
      return [0, 0, 1];
    case 'side-x':
      return [-1, 0, 0];
    case 'side-y':
      return [0, -1, 0];
    case 'corner':
      return [-r3, -r3, -r3];
    case 'edge':
      return [0, -r2, -r2];
    default:
      throw new Error(`drop: unknown orientation '${String(o)}'`);
  }
}

/**
 * Maximax shock-response factor of an undamped single-DOF oscillator to a half-sine base acceleration
 * pulse, as a function of r = pulse duration / natural period: ≈ 4r for short pulses (impulse regime),
 * peak ≈ 1.77 near r ≈ 0.8, → 1 for long (quasi-static) pulses.
 */
export function halfSineShockFactor(r: number): number {
  if (!(r > 0)) return 0;
  if (r > 200) return 1;
  // nondimensional: natural period 1 → ω = 2π, pulse 0 ≤ t ≤ r with Ω = π / r
  let rr = r;
  if (Math.abs(rr - 0.5) < 1e-6) rr = 0.5 + 1e-6; // resonance singularity of the closed form
  const w = 2 * Math.PI;
  const W = Math.PI / rr;
  const c = 1 / (w * w - W * W);
  const z = (t: number) => -c * (Math.sin(W * t) - (W / w) * Math.sin(w * t));
  const zd = (t: number) => -c * W * (Math.cos(W * t) - Math.cos(w * t));
  let best = 0;
  const n = 400;
  for (let q = 0; q <= n; q++) best = Math.max(best, Math.abs(z((rr * q) / n)));
  const residual = Math.hypot(z(rr), zd(rr) / w);
  return w * w * Math.max(best, residual);
}

let srsTable: { lo: number; hi: number; n: number; vals: Float64Array } | null = null;

/** Interpolated halfSineShockFactor (log-spaced table, built on first use). */
function shockFactor(r: number): number {
  if (!(r > 0)) return 0;
  if (!srsTable) {
    const lo = Math.log(1e-3);
    const hi = Math.log(200);
    const n = 600;
    const vals = new Float64Array(n + 1);
    for (let q = 0; q <= n; q++) vals[q] = halfSineShockFactor(Math.exp(lo + ((hi - lo) * q) / n));
    srsTable = { lo, hi, n, vals };
  }
  const { lo, hi, n, vals } = srsTable;
  const x = Math.log(r);
  if (x <= lo) return 4 * r;
  if (x >= hi) return 1;
  const t = ((x - lo) / (hi - lo)) * n;
  const q = Math.min(n - 1, Math.floor(t));
  const f = t - q;
  return vals[q] * (1 - f) + vals[q + 1] * f;
}

/** DropResult with diagnostic extras (not yet part of the core contract). */
export interface DropResultDetail extends DropResult {
  structural: StructuralResultDetail;
  /** Stiffnesses used by the spring-mass impact model (N/m). */
  stiffness: { structural: number; floor: number; effective: number };
  /** Effective mass at the contact point along the contact normal (g); < massGrams for corner/edge hits. */
  effectiveMassGrams: number;
  /** Rigid-body angular acceleration at the peak (rad/s², grid frame). */
  angularAcceleration: Vec3;
  /** Shock-response correction: lowest local natural frequency (Hz) and the range of factors applied. */
  dynamics: { applied: boolean; minLocalFrequencyHz: number; factorMin: number; factorMax: number };
  floor: DropFloor;
  /** Unit vector toward the floor (grid frame). */
  direction: Vec3;
  impactPatchVoxels: number;
  /** How each extra mass was attached (support region, solid it sits on, drop path, nearest solid). */
  massAttachments: { ref: string; method: 'support' | 'attached' | 'drop-path' | 'nearest'; voxels: number }[];
  warnings: string[];
}

/**
 * Drop / impact screening by an equivalent-static energy method with rigid-body (inertia-relief) loading.
 *
 * 1. v = √(2 g H). Mass m, centre of mass and inertia tensor from the solid voxels and `extraMasses`.
 * 2. Impact patch = solid voxels touching the floor plane for the orientation (faces: the extreme voxel
 *    layer; corner/edge: voxels within max(1.5 h, 2 mm) of the extreme point/edge along the drop
 *    direction); it is clamped and its centroid is the contact point P.
 * 3. Unit solve: a 1 N contact force at P along the contact normal n = −d accelerates the free body by
 *    a(x) = n/m + α × (x − x_cm) with α = I⁻¹ (r_P × n); every voxel and extra mass is loaded with its
 *    d'Alembert force −m·a(x) (uniform for a centred face drop, with rotation for corner/edge hits).
 *    Structural stiffness k_s = 1 / (work of these loads per N²) — the spec's m·g / (mass-weighted mean
 *    displacement) when there is no rotation.
 * 4. Floor stiffness k_f in series (FLOOR_STIFFNESS); effective mass at P along n
 *    m_eff = 1/(1/m + (r_P×n)·I⁻¹(r_P×n)); F = v√(k_eff m_eff); pulse duration π√(m_eff/k_eff);
 *    stop distance F/k_eff; peakG = F/(m g) (deceleration of the centre of mass).
 * 5. Dynamic correction (default on): each voxel's equivalent-static load is multiplied by the half-sine
 *    shock-response factor at its local natural frequency ω = √(|a|/δ) (local acceleration over local
 *    static deflection in the unit solve). Compliant regions (lids, overhangs) whose period is long
 *    compared with the pulse see less than the peak g; regions near resonance up to 1.77×. The stress
 *    field comes from a second static solve with these loads, scaled by F.
 *
 * Extra masses: inertial force on `support` when given; otherwise on the solid they sit on (nearest
 * solid voxel within h + 0.5 mm) or, for masses floating in a cavity, where they press along the drop
 * direction — spread over the face-connected solid within max(3h, 4 mm, ½·footprint), never one voxel.
 *
 * Component risks (solder-joint / connector screening heuristic): inertial force F = m·a_local;
 * high if F > 40 N or (m > 2 g and a_local > 1500 g); medium if F > 10 N or a_local > 500 g; else low.
 *
 * Assumptions: linear elastic, single impact, no rebound, friction, plasticity or local crushing;
 * flat drops idealise a perfectly flat rigid floor contact (real peaks are usually lower).
 */
export function solveDrop(setup: DropSetup): DropResultDetail {
  const { grid } = setup;
  if (!grid) throw new Error('drop: setup.grid is required');
  if (!(Number.isFinite(setup.heightM) && setup.heightM >= 0)) throw new Error('drop: heightM must be a finite number ≥ 0 (m)');
  const floor: DropFloor = setup.floor ?? 'concrete';
  const kf = FLOOR_STIFFNESS[floor];
  if (kf === undefined) throw new Error(`drop: unknown floor '${String(setup.floor)}'`);
  const d = dropDirection(setup.orientation);
  const nrm: Vec3 = [-d[0], -d[1], -d[2]]; // contact normal: the floor pushes the product along nrm
  const { nx, ny, nz, h } = grid;
  const origin = grid.origin;
  const N = nx * ny * nz;
  if (!grid.cells || grid.cells.length !== N) throw new Error('drop: grid.cells length must equal nx·ny·nz');
  const mats = setup.materials ?? [];
  const usable = (idx: number) => idx > 0 && !!mats[idx - 1] && mats[idx - 1].E > 0;
  const preWarnings: string[] = [];

  const solidMask = new Uint8Array(N);
  const solidList: number[] = [];
  for (let v = 0; v < N; v++)
    if (usable(grid.cells[v])) {
      solidMask[v] = grid.cells[v];
      solidList.push(v);
    }
  if (!solidList.length) throw new Error('drop: the grid contains no solid voxels with a usable material');
  const rg: RegionGrid = { nx, ny, nz, h, origin, solid: solidMask };
  const centre = (v: number): Vec3 => [
    origin[0] + ((v % nx) + 0.5) * h,
    origin[1] + ((Math.floor(v / nx) % ny) + 0.5) * h,
    origin[2] + (Math.floor(v / (nx * ny)) + 0.5) * h,
  ];

  // ---- impact patch (fixture)
  let fixture: Region;
  let patch: number[];
  if (setup.orientation === 'corner' || setup.orientation === 'edge') {
    const reach = 0.5 * h * (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]));
    let sMax = -Infinity;
    const s = new Float64Array(solidList.length);
    solidList.forEach((v, q) => {
      const c = centre(v);
      s[q] = d[0] * c[0] + d[1] * c[1] + d[2] * c[2] + reach;
      if (s[q] > sMax) sMax = s[q];
    });
    const delta = Math.max(1.5 * h, 2);
    patch = solidList.filter((_, q) => s[q] >= sMax - delta);
    fixture = { kind: 'cells', indices: patch };
  } else {
    const map: Record<string, Region> = {
      bottom: { kind: 'plane', axis: 'z', side: 'min', depth: 0.5 * h },
      top: { kind: 'plane', axis: 'z', side: 'max', depth: 0.5 * h },
      'side-x': { kind: 'plane', axis: 'x', side: 'min', depth: 0.5 * h },
      'side-y': { kind: 'plane', axis: 'y', side: 'min', depth: 0.5 * h },
    };
    fixture = map[setup.orientation];
    patch = Array.from(resolveRegion(rg, fixture).voxels);
  }

  // ---- extra masses → attachment voxels
  const extra = setup.extraMasses ?? [];
  const rayHit = (p: Vec3): number => {
    let reach = 0;
    for (const cx of [origin[0], origin[0] + nx * h])
      for (const cy of [origin[1], origin[1] + ny * h])
        for (const cz of [origin[2], origin[2] + nz * h]) reach = Math.max(reach, Math.hypot(cx - p[0], cy - p[1], cz - p[2]));
    const step = 0.25 * h;
    for (let t = 0; t <= reach + h; t += step) {
      const i = Math.floor((p[0] + t * d[0] - origin[0]) / h);
      const j = Math.floor((p[1] + t * d[1] - origin[1]) / h);
      const k = Math.floor((p[2] + t * d[2] - origin[2]) / h);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
      const v = i + nx * (j + ny * k);
      if (solidMask[v]) return v;
    }
    return -1;
  };
  const nearestSolid = (p: Vec3): { v: number; dist: number } => {
    let best = Infinity;
    let bv = -1;
    for (const v of solidList) {
      const c = centre(v);
      const dd = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
      if (dd < best) {
        best = dd;
        bv = v;
      }
    }
    return { v: bv, dist: Math.sqrt(best) };
  };
  const seen = new Uint8Array(N);
  /** Face-connected solid voxels within radius R (mm) of the centre of voxel v0. */
  const patchAround = (v0: number, R: number): number[] => {
    const c0 = centre(v0);
    const out: number[] = [v0];
    seen[v0] = 1;
    for (let q = 0; q < out.length; q++) {
      const v = out[q];
      const i = v % nx;
      const j = Math.floor(v / nx) % ny;
      const k = Math.floor(v / (nx * ny));
      const nbs = [i > 0 ? v - 1 : -1, i < nx - 1 ? v + 1 : -1, j > 0 ? v - nx : -1, j < ny - 1 ? v + nx : -1, k > 0 ? v - nx * ny : -1, k < nz - 1 ? v + nx * ny : -1];
      for (const nb of nbs) {
        if (nb < 0 || seen[nb] || !solidMask[nb]) continue;
        const c = centre(nb);
        if (Math.hypot(c[0] - c0[0], c[1] - c0[1], c[2] - c0[2]) > R) continue;
        seen[nb] = 1;
        out.push(nb);
      }
    }
    for (const v of out) seen[v] = 0;
    return out.sort((x, y) => x - y);
  };
  const supportCache = new Map<Region, number[]>();
  const extraCells: number[][] = [];
  const attachments: DropResultDetail['massAttachments'] = [];
  extra.forEach((em, ei) => {
    if (!(em.massGrams >= 0) || !Number.isFinite(em.massGrams)) throw new Error(`drop: extraMasses[${ei}].massGrams must be ≥ 0`);
    if (!em.position || !em.position.every((c) => Number.isFinite(c))) throw new Error(`drop: extraMasses[${ei}].position must be a finite Vec3`);
    const label = em.ref ?? em.componentId ?? `mass ${ei}`;
    let cells: number[] = [];
    let method: 'support' | 'attached' | 'drop-path' | 'nearest' = 'drop-path';
    if (em.support) {
      let sc = supportCache.get(em.support);
      if (!sc) {
        sc = Array.from(resolveRegion(rg, em.support).voxels);
        supportCache.set(em.support, sc);
        if (!sc.length) preWarnings.push(`Support region of ${label} selects no solid voxels; its load follows the drop path instead.`);
      }
      if (sc.length) {
        cells = sc;
        method = 'support';
      }
    }
    if (!cells.length) {
      // footprint radius of a compact part (cube of density ≈ 2 g/cm³), at least 3 voxels / 4 mm
      const R = Math.max(3 * h, 4, 5 * Math.cbrt(Math.max(em.massGrams, 0) / 2));
      const near = nearestSolid(em.position);
      let v0: number;
      if (near.dist <= h + 0.5) {
        v0 = near.v; // sits on / in that solid
        method = 'attached';
      } else {
        v0 = rayHit(em.position); // floating in a cavity: presses where it lands along the drop direction
        method = 'drop-path';
        if (v0 < 0) {
          v0 = near.v;
          method = 'nearest';
        }
      }
      cells = patchAround(v0, R);
    }
    extraCells.push(cells);
    attachments.push({ ref: label, method, voxels: cells.length });
  });

  // ---- rigid-body properties (SI units; positions in mm are converted where needed).
  // Each extra mass is represented at its load point (centroid of its attachment voxels) and voxels as
  // point masses, so the d'Alembert loads below are exactly in equilibrium with the contact force at P
  // (no spurious moment for the clamped patch to react).
  const loadPoint: Vec3[] = extra.map((em, ei) => {
    const cells = extraCells[ei];
    if (!cells.length) return em.position;
    const c: Vec3 = [0, 0, 0];
    for (const vx of cells) {
      const q = centre(vx);
      c[0] += q[0] / cells.length;
      c[1] += q[1] / cells.length;
      c[2] += q[2] / cells.length;
    }
    return c;
  });
  const vol = h * h * h * 1e-9; // m³
  const mVox = new Float64Array(N);
  let m = 0;
  const cm = [0, 0, 0];
  for (const v of solidList) {
    const mv = mats[solidMask[v] - 1].density * vol;
    mVox[v] = mv;
    const c = centre(v);
    m += mv;
    cm[0] += mv * c[0];
    cm[1] += mv * c[1];
    cm[2] += mv * c[2];
  }
  extra.forEach((em, ei) => {
    const mx = em.massGrams / 1000;
    m += mx;
    cm[0] += mx * loadPoint[ei][0];
    cm[1] += mx * loadPoint[ei][1];
    cm[2] += mx * loadPoint[ei][2];
  });
  for (let a = 0; a < 3; a++) cm[a] /= m;
  const I = [0, 0, 0, 0, 0, 0, 0, 0, 0]; // kg·m² about the centre of mass
  const addInertia = (mx: number, p: Vec3) => {
    const r = [(p[0] - cm[0]) * 1e-3, (p[1] - cm[1]) * 1e-3, (p[2] - cm[2]) * 1e-3];
    const r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) I[3 * a + b] += mx * ((a === b ? r2 : 0) - r[a] * r[b]);
  };
  for (const v of solidList) addInertia(mVox[v], centre(v));
  extra.forEach((em, ei) => addInertia(em.massGrams / 1000, loadPoint[ei]));
  const Iinv = invert3(I);
  const P = [0, 0, 0]; // contact point = centroid of the impact patch (mm)
  for (const v of patch) {
    const c = centre(v);
    P[0] += c[0] / patch.length;
    P[1] += c[1] / patch.length;
    P[2] += c[2] / patch.length;
  }
  const rP: Vec3 = [(P[0] - cm[0]) * 1e-3, (P[1] - cm[1]) * 1e-3, (P[2] - cm[2]) * 1e-3];
  const rxn = cross(rP, nrm);
  const alphaU = mul3(Iinv, rxn); // rad/s² per N of contact force
  const mEff = 1 / (1 / m + dot(rxn, alphaU));
  /** Rigid-body acceleration (m/s² per N of contact force) at point (x, y, z) in mm. */
  const accAt = (x: number, y: number, z: number): Vec3 => {
    const w = cross(alphaU, [(x - cm[0]) * 1e-3, (y - cm[1]) * 1e-3, (z - cm[2]) * 1e-3]);
    return [nrm[0] / m + w[0], nrm[1] / m + w[1], nrm[2] / m + w[2]];
  };

  // ---- unit solve: 1 N contact force, d'Alembert loads −m·a(x)
  const extraLoads = (scaleOf: (ei: number) => number): StructuralLoad[] => {
    const out: StructuralLoad[] = [];
    extra.forEach((em, ei) => {
      const cells = extraCells[ei];
      if (!(em.massGrams > 0) || !cells.length) return;
      const lp = loadPoint[ei];
      const a = accAt(lp[0], lp[1], lp[2]);
      const f = (em.massGrams / 1000) * scaleOf(ei);
      out.push({ region: { kind: 'cells', indices: cells }, force: [-f * a[0], -f * a[1], -f * a[2]] });
    });
    return out;
  };
  const common = { grid, materials: mats, fixtures: [fixture], maxIterations: setup.maxIterations, tolerance: setup.tolerance };
  const dyn = setup.dynamicCorrection !== false;
  const progress = setup.onProgress;
  const a1 = analyzeStructure({
    ...common,
    loads: extraLoads(() => 1),
    bodyAccelerationField: (x, y, z) => {
      const a = accAt(x, y, z);
      return [-a[0], -a[1], -a[2]];
    },
    onProgress: progress ? (f) => progress((dyn ? 0.5 : 1) * f) : undefined,
  });
  const warnings: string[] = [...preWarnings];
  const posIndex = new Int32Array(N).fill(-1);
  for (let q = 0; q < a1.solidIdx.length; q++) posIndex[a1.solidIdx[q]] = q;
  // compliance = work of the unit loads on their displacements (mm per N)
  let work = 0;
  for (let q = 0; q < a1.solidIdx.length; q++) {
    if (!a1.analysed[q]) continue;
    const vx = a1.solidIdx[q];
    const c = centre(vx);
    const a = accAt(c[0], c[1], c[2]);
    work -= mVox[vx] * (a[0] * a1.disp[3 * q] + a[1] * a1.disp[3 * q + 1] + a[2] * a1.disp[3 * q + 2]);
  }
  const extraDisp = (ei: number, an: StructuralAnalysis): Vec3 | null => {
    const u: Vec3 = [0, 0, 0];
    let n = 0;
    for (const vx of extraCells[ei]) {
      const q = posIndex[vx];
      if (q < 0 || !an.analysed[q]) continue;
      u[0] += an.disp[3 * q];
      u[1] += an.disp[3 * q + 1];
      u[2] += an.disp[3 * q + 2];
      n++;
    }
    return n ? [u[0] / n, u[1] / n, u[2] / n] : null;
  };
  extra.forEach((em, ei) => {
    if (!(em.massGrams > 0) || !extraCells[ei].length) return;
    const u = extraDisp(ei, a1);
    if (!u) {
      warnings.push(`Extra mass ${attachments[ei].ref} is attached to an unfixed body; its load is not carried.`);
      return;
    }
    const lp = loadPoint[ei];
    work -= (em.massGrams / 1000) * dot(accAt(lp[0], lp[1], lp[2]), u);
  });
  const ks = work > 0 ? 1000 / work : Infinity; // N/m
  const keff = Number.isFinite(ks) ? 1 / (1 / ks + 1 / kf) : kf;
  const v = Math.sqrt(2 * G0 * setup.heightM);
  const F = v * Math.sqrt(keff * mEff);
  const peakG = F / m / G0;
  const contactS = Math.PI * Math.sqrt(mEff / keff);
  const stopMm = (F / keff) * 1000;
  if (a1.bodies.skipped > 0)
    warnings.push('Some solid bodies are not connected to the impact patch; they were excluded from the stress analysis.');

  // ---- shock-response correction per voxel / extra mass, second solve
  let final = a1;
  let fMinLocal = Infinity;
  let dMin = 1;
  let dMax = 1;
  if (dyn && F > 0) {
    const factor = new Float32Array(N).fill(1);
    const local = (a: Vec3, u: Vec3): number => {
      const am = Math.hypot(a[0], a[1], a[2]);
      if (!(am > 0)) return 1;
      const delta = (Math.abs(dot(u, a)) / am) * 1e-3; // static deflection along a, m per N
      if (!(delta > 0)) return 1;
      const w = Math.sqrt(am / delta);
      fMinLocal = Math.min(fMinLocal, w / (2 * Math.PI));
      return shockFactor((contactS * w) / (2 * Math.PI));
    };
    dMin = Infinity;
    dMax = 0;
    for (let q = 0; q < a1.solidIdx.length; q++) {
      if (!a1.analysed[q]) continue;
      const vx = a1.solidIdx[q];
      const c = centre(vx);
      const fct = local(accAt(c[0], c[1], c[2]), [a1.disp[3 * q], a1.disp[3 * q + 1], a1.disp[3 * q + 2]]);
      factor[vx] = fct;
      if (fct < dMin) dMin = fct;
      if (fct > dMax) dMax = fct;
    }
    const exFactor = extra.map((_, ei) => {
      const u = extraDisp(ei, a1);
      const lp = loadPoint[ei];
      return u ? local(accAt(lp[0], lp[1], lp[2]), u) : 1;
    });
    if (!Number.isFinite(dMin)) dMin = dMax = 1;
    final = analyzeStructure({
      ...common,
      loads: extraLoads((ei) => exFactor[ei]),
      bodyAccelerationField: (x, y, z, vx) => {
        const a = accAt(x, y, z);
        const fct = factor[vx];
        return [-a[0] * fct, -a[1] * fct, -a[2] * fct];
      },
      onProgress: progress ? (f) => progress(0.5 + 0.5 * f) : undefined,
    });
  }
  const orientationText = setup.orientation;
  const structural = buildStructuralResult(
    final,
    {
      title: `Drop ${setup.heightM} m, ${orientationText} onto ${floor}`,
      loads: [
        `Rigid-body inertial load at impact: ${peakG.toFixed(0)} g at the centre of mass (${orientationText} impact, contact force ${F.toFixed(0)} N)` +
          (dyn ? ', shock-response corrected' : ''),
        ...extra.filter((em) => em.massGrams > 0).map((em, i) => `${em.ref ?? em.componentId ?? `mass ${i}`}: ${em.massGrams} g`),
      ],
      fixtures: [`Impact patch at the ${orientationText} (${patch.length} voxels clamped by the floor)`],
    },
    F,
    warnings,
  );

  const componentRisks: DropResult['componentRisks'] = [];
  for (const em of extra) {
    if (!em.componentId) continue;
    const a = accAt(em.position[0], em.position[1], em.position[2]);
    const aLocal = Math.hypot(a[0], a[1], a[2]) * F; // m/s²
    const gLocal = aLocal / G0;
    const Fc = (em.massGrams / 1000) * aLocal;
    let risk: 'low' | 'medium' | 'high' = 'low';
    if (Fc > 40 || (em.massGrams > 2 && gLocal > 1500)) risk = 'high';
    else if (Fc > 10 || gLocal > 500) risk = 'medium';
    const note =
      `${Fc.toFixed(1)} N inertial load (${em.massGrams} g at ${gLocal.toFixed(0)} g). ` +
      (risk === 'high'
        ? 'High risk of solder-joint cracking or connector/socket release: add mechanical retention (screws, clips, adhesive/staking, underfill) or local support.'
        : risk === 'medium'
          ? 'Moderate risk: check solder-joint area, consider staking or corner glue for tall/heavy parts.'
          : 'Low risk for standard SMT/THT joints.');
    componentRisks.push({ componentId: em.componentId, ref: em.ref ?? em.componentId, massGrams: em.massGrams, inertialForceN: Fc, risk, note });
  }

  return {
    kind: 'drop',
    heightM: setup.heightM,
    orientation: setup.orientation,
    impactVelocity: v,
    peakG,
    peakForceN: F,
    contactDurationMs: contactS * 1000,
    stopDistanceMm: stopMm,
    massGrams: m * 1000,
    method:
      'Equivalent-static energy method with rigid-body (inertia-relief) loading: linear spring-mass impact at the contact ' +
      `point (effective mass ${(mEff * 1000).toFixed(1)} g), structural stiffness from a voxel FEA unit solve in series ` +
      `with a ${floor} floor stiffness of ${kf.toExponential(0)} N/m` +
      (dyn ? '; loads corrected by the half-sine shock-response factor at each region’s local natural frequency' : '') +
      '. Screening accuracy only (no rebound, friction, plasticity or local crushing).',
    structural,
    componentRisks,
    stiffness: { structural: ks, floor: kf, effective: keff },
    effectiveMassGrams: mEff * 1000,
    angularAcceleration: [alphaU[0] * F, alphaU[1] * F, alphaU[2] * F],
    dynamics: { applied: dyn && F > 0, minLocalFrequencyHz: Number.isFinite(fMinLocal) ? fMinLocal : 0, factorMin: dMin, factorMax: dMax },
    floor,
    direction: d,
    impactPatchVoxels: patch.length,
    massAttachments: attachments,
    warnings: structural.warnings,
  };
}

function cross(a: ArrayLike<number>, b: ArrayLike<number>): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function mul3(M: number[], v: ArrayLike<number>): Vec3 {
  return [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
}

/** Inverse of a symmetric positive 3×3 matrix (row-major); a tiny regularisation guards degenerate bodies. */
function invert3(M: number[]): number[] {
  const tr = M[0] + M[4] + M[8];
  const a = M.slice();
  for (const q of [0, 4, 8]) a[q] += 1e-12 * tr + 1e-30;
  const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  const id = 1 / det;
  return [
    (a[4] * a[8] - a[5] * a[7]) * id,
    (a[2] * a[7] - a[1] * a[8]) * id,
    (a[1] * a[5] - a[2] * a[4]) * id,
    (a[5] * a[6] - a[3] * a[8]) * id,
    (a[0] * a[8] - a[2] * a[6]) * id,
    (a[2] * a[3] - a[0] * a[5]) * id,
    (a[3] * a[7] - a[4] * a[6]) * id,
    (a[1] * a[6] - a[0] * a[7]) * id,
    (a[0] * a[4] - a[1] * a[3]) * id,
  ];
}
