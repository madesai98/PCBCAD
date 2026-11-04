import type { DropResult, Vec3 } from '@pcbcad/core';
import { resolveRegion } from './regions';
import type { RegionGrid } from './regions';
import { analyzeStructure, buildStructuralResult } from './structural';
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

/** DropResult with diagnostic extras (not yet part of the core contract). */
export interface DropResultDetail extends DropResult {
  structural: StructuralResultDetail;
  /** Stiffnesses used by the spring-mass impact model (N/m). */
  stiffness: { structural: number; floor: number; effective: number };
  floor: DropFloor;
  /** Unit vector toward the floor (grid frame). */
  direction: Vec3;
  impactPatchVoxels: number;
  /** How each extra mass was attached: its support region, the drop path (ray along the drop direction) or the nearest solid. */
  massAttachments: { ref: string; method: 'support' | 'drop-path' | 'nearest'; voxels: number }[];
  warnings: string[];
}

/**
 * Drop / impact screening by the equivalent-static energy method.
 *
 * 1. v = √(2 g H). Total mass m = solid voxels + extra masses.
 * 2. Impact patch = solid voxels touching the floor plane for the orientation (faces: the extreme voxel
 *    layer; corner/edge: voxels within max(1.5 h, 2 mm) of the extreme point/edge along the drop
 *    direction). The patch is clamped.
 * 3. Unit solve: 1 g body load toward the floor (+ extra masses as forces on their nearest solid voxels).
 *    Structural stiffness k_s = m·g / (mass-weighted mean displacement along the drop direction).
 * 4. k_eff = 1/(1/k_s + 1/k_f) with the floor stiffness k_f (FLOOR_STIFFNESS); a linear spring-mass impact
 *    gives F = v√(k_eff m), a = F/m, contact time π√(m/k_eff), stop distance F/k_eff.
 * 5. The unit solve is scaled linearly by the peak deceleration (in g) to give the stress field.
 *
 * Component risks (solder-joint / connector-retention screening heuristic): inertial force F = m·a;
 * high if F > 40 N or (m > 2 g and peak > 1500 g); medium if F > 10 N or peak > 500 g; else low.
 *
 * Assumptions: linear elastic, no rebound/rotation, no local crushing or plasticity, rigid-body
 * deceleration uniform over the product. This is a screening estimate, typically within a factor of ~2
 * of a transient explicit analysis for compact products.
 */
export function solveDrop(setup: DropSetup): DropResultDetail {
  const { grid } = setup;
  if (!(Number.isFinite(setup.heightM) && setup.heightM >= 0)) throw new Error('drop: heightM must be a finite number ≥ 0 (m)');
  const floor: DropFloor = setup.floor ?? 'concrete';
  const kf = FLOOR_STIFFNESS[floor];
  if (kf === undefined) throw new Error(`drop: unknown floor '${String(setup.floor)}'`);
  const d = dropDirection(setup.orientation);
  const { nx, ny, nz, h } = grid;
  const origin = grid.origin;
  if (!grid.cells || grid.cells.length !== nx * ny * nz) throw new Error('drop: grid.cells length must equal nx·ny·nz');
  const mats = setup.materials ?? [];
  const usable = (idx: number) => idx > 0 && !!mats[idx - 1] && mats[idx - 1].E > 0;
  const preWarnings: string[] = [];

  // ---- impact patch (fixture)
  let fixture: Region;
  let patchVoxels = 0;
  const N = nx * ny * nz;
  if (setup.orientation === 'corner' || setup.orientation === 'edge') {
    const reach = 0.5 * h * (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]));
    let sMax = -Infinity;
    const s = new Float64Array(N).fill(-Infinity);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const v = i + nx * (j + ny * k);
          if (!usable(grid.cells[v])) continue;
          const val =
            d[0] * (origin[0] + (i + 0.5) * h) + d[1] * (origin[1] + (j + 0.5) * h) + d[2] * (origin[2] + (k + 0.5) * h) + reach;
          s[v] = val;
          if (val > sMax) sMax = val;
        }
    if (!Number.isFinite(sMax)) throw new Error('drop: the grid contains no solid voxels with a usable material');
    const delta = Math.max(1.5 * h, 2);
    const cells: number[] = [];
    for (let v = 0; v < N; v++) if (s[v] >= sMax - delta) cells.push(v);
    fixture = { kind: 'cells', indices: cells };
    patchVoxels = cells.length;
  } else {
    const map: Record<string, Region> = {
      bottom: { kind: 'plane', axis: 'z', side: 'min', depth: 0.5 * h },
      top: { kind: 'plane', axis: 'z', side: 'max', depth: 0.5 * h },
      'side-x': { kind: 'plane', axis: 'x', side: 'min', depth: 0.5 * h },
      'side-y': { kind: 'plane', axis: 'y', side: 'min', depth: 0.5 * h },
    };
    fixture = map[setup.orientation];
  }

  // ---- extra masses → inertial force on their load path (unit 1 g case)
  const extra = setup.extraMasses ?? [];
  const solidMask = new Uint8Array(N);
  const solidList: number[] = [];
  for (let v = 0; v < N; v++)
    if (usable(grid.cells[v])) {
      solidMask[v] = grid.cells[v];
      solidList.push(v);
    }
  const rg: RegionGrid = { nx, ny, nz, h, origin, solid: solidMask };
  const centre = (v: number): Vec3 => [
    origin[0] + ((v % nx) + 0.5) * h,
    origin[1] + ((Math.floor(v / nx) % ny) + 0.5) * h,
    origin[2] + (Math.floor(v / (nx * ny)) + 0.5) * h,
  ];
  /** First solid voxel met when moving from p along the drop direction (where the mass presses), −1 if none. */
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
  const nearestSolid = (p: Vec3): number => {
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
    return bv;
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
  const loads: StructuralLoad[] = [];
  let extraMassG = 0;
  extra.forEach((em, ei) => {
    if (!(em.massGrams >= 0) || !Number.isFinite(em.massGrams)) throw new Error(`drop: extraMasses[${ei}].massGrams must be ≥ 0`);
    if (!em.position || !em.position.every((c) => Number.isFinite(c))) throw new Error(`drop: extraMasses[${ei}].position must be a finite Vec3`);
    extraMassG += em.massGrams;
    const label = em.ref ?? em.componentId ?? `mass ${ei}`;
    let cells: number[] = [];
    let method: 'support' | 'drop-path' | 'nearest' = 'drop-path';
    if (em.support) {
      let sc = supportCache.get(em.support);
      if (!sc) {
        sc = Array.from(resolveRegion(rg, em.support).voxels);
        supportCache.set(em.support, sc);
        if (!sc.length) preWarnings.push(`Support region of ${label} selects no solid voxels; its load is applied along the drop path instead.`);
      }
      if (sc.length) {
        cells = sc;
        method = 'support';
      }
    }
    if (!cells.length && solidList.length) {
      // footprint radius of a compact part (cube of density ≈ 2 g/cm³), at least 3 voxels / 4 mm
      const R = Math.max(3 * h, 4, 5 * Math.cbrt(Math.max(em.massGrams, 0) / 2));
      let v0 = rayHit(em.position);
      if (v0 < 0) {
        v0 = nearestSolid(em.position);
        method = 'nearest';
      }
      if (v0 >= 0) cells = patchAround(v0, R);
    }
    extraCells.push(cells);
    attachments.push({ ref: label, method, voxels: cells.length });
    if (em.massGrams > 0 && cells.length > 0) {
      const f = (em.massGrams / 1000) * G0;
      loads.push({ region: { kind: 'cells', indices: cells }, force: [f * d[0], f * d[1], f * d[2]] });
    }
  });

  const a = analyzeStructure({
    grid,
    materials: mats,
    fixtures: [fixture],
    loads,
    bodyAcceleration: [G0 * d[0], G0 * d[1], G0 * d[2]],
    maxIterations: setup.maxIterations,
    tolerance: setup.tolerance,
    onProgress: setup.onProgress,
  });
  const warnings: string[] = [...preWarnings];
  if (fixture.kind === 'plane') patchVoxels = resolveRegion(rg, fixture).voxels.length;

  // ---- structural stiffness from the unit (1 g) solve
  let mA = 0; // analysed mass (g)
  let work = 0; // Σ m (u·d)   (g·mm)
  for (let q = 0; q < a.solidIdx.length; q++) {
    if (!a.analysed[q]) continue;
    const m = a.massG[q];
    mA += m;
    work += m * (a.disp[3 * q] * d[0] + a.disp[3 * q + 1] * d[1] + a.disp[3 * q + 2] * d[2]);
  }
  const posIndex = new Map<number, number>();
  for (let q = 0; q < a.solidIdx.length; q++) posIndex.set(a.solidIdx[q], q);
  extra.forEach((em, ei) => {
    const cl = extraCells[ei];
    if (!cl.length || !(em.massGrams > 0)) return;
    let ux = 0;
    let n = 0;
    let ok = true;
    for (const v of cl) {
      const q = posIndex.get(v);
      if (q === undefined || !a.analysed[q]) {
        ok = false;
        continue;
      }
      ux += a.disp[3 * q] * d[0] + a.disp[3 * q + 1] * d[1] + a.disp[3 * q + 2] * d[2];
      n++;
    }
    if (n > 0) {
      mA += em.massGrams;
      work += em.massGrams * (ux / n);
    }
    if (!ok) warnings.push(`Extra mass ${em.ref ?? em.componentId ?? ei} is attached to an unfixed body; its load is incomplete.`);
  });
  const meanDisp = mA > 0 ? work / mA : 0; // mm
  const ks = meanDisp > 0 ? ((mA / 1000) * G0) / (meanDisp / 1000) : Infinity; // N/m
  const keff = Number.isFinite(ks) ? 1 / (1 / ks + 1 / kf) : kf;
  const massGrams = a.massGrams + extraMassG;
  const mKg = massGrams / 1000;
  const v = Math.sqrt(2 * G0 * setup.heightM);
  const F = mKg > 0 ? v * Math.sqrt(keff * mKg) : 0;
  const acc = mKg > 0 ? F / mKg : 0;
  const peakG = acc / G0;
  const contactMs = mKg > 0 ? Math.PI * Math.sqrt(mKg / keff) * 1000 : 0;
  const stopMm = keff > 0 ? (F / keff) * 1000 : 0;
  if (a.bodies.skipped > 0)
    warnings.push('Some solid bodies are not connected to the impact patch; they were excluded from the stress analysis.');

  const orientationText = setup.orientation;
  const structural = buildStructuralResult(
    a,
    {
      title: `Drop ${setup.heightM} m, ${orientationText} onto ${floor}`,
      loads: [
        `Equivalent static inertial load ${peakG.toFixed(0)} g toward the floor (${orientationText} impact)`,
        ...extra
          .filter((em) => em.massGrams > 0)
          .map((em) => `${em.ref ?? em.componentId ?? 'mass'}: ${em.massGrams} g × ${peakG.toFixed(0)} g`),
      ],
      fixtures: [`Impact patch at the ${orientationText} (${patchVoxels} voxels clamped by the floor)`],
    },
    peakG,
    warnings,
  );

  const componentRisks: DropResult['componentRisks'] = [];
  for (const em of extra) {
    if (!em.componentId) continue;
    const Fc = (em.massGrams / 1000) * acc;
    let risk: 'low' | 'medium' | 'high' = 'low';
    if (Fc > 40 || (em.massGrams > 2 && peakG > 1500)) risk = 'high';
    else if (Fc > 10 || peakG > 500) risk = 'medium';
    const note =
      `${Fc.toFixed(1)} N inertial load (${em.massGrams} g at ${peakG.toFixed(0)} g). ` +
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
    contactDurationMs: contactMs,
    stopDistanceMm: stopMm,
    massGrams,
    method:
      'Equivalent-static energy method: linear spring-mass impact with structural stiffness from a 1 g voxel FEA ' +
      `solve (clamped impact patch) in series with a ${floor} floor stiffness of ${kf.toExponential(0)} N/m; ` +
      'stresses = 1 g solution × peak deceleration. Screening accuracy only (no rebound, rotation, plasticity or local crushing).',
    structural,
    componentRisks,
    stiffness: { structural: ks, floor: kf, effective: keff },
    floor,
    direction: d,
    impactPatchVoxels: patchVoxels,
    massAttachments: attachments,
    warnings: structural.warnings,
  };
}
