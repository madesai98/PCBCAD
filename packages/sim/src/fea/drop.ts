import type { DropResult, Vec3 } from '@pcbcad/core';
import { resolveRegion } from './regions';
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

  // ---- extra masses → force loads on their nearest solid voxels (unit 1 g case)
  const extra = setup.extraMasses ?? [];
  const solidList: number[] = [];
  for (let v = 0; v < N; v++) if (usable(grid.cells[v])) solidList.push(v);
  const extraCells: number[][] = [];
  const loads: StructuralLoad[] = [];
  let extraMassG = 0;
  extra.forEach((em, ei) => {
    if (!(em.massGrams >= 0) || !Number.isFinite(em.massGrams)) throw new Error(`drop: extraMasses[${ei}].massGrams must be ≥ 0`);
    if (!em.position || !em.position.every((c) => Number.isFinite(c))) throw new Error(`drop: extraMasses[${ei}].position must be a finite Vec3`);
    extraMassG += em.massGrams;
    let best = Infinity;
    const dist = new Float64Array(solidList.length);
    for (let q = 0; q < solidList.length; q++) {
      const v = solidList[q];
      const i = v % nx;
      const j = Math.floor(v / nx) % ny;
      const k = Math.floor(v / (nx * ny));
      const dd = Math.hypot(
        origin[0] + (i + 0.5) * h - em.position[0],
        origin[1] + (j + 0.5) * h - em.position[1],
        origin[2] + (k + 0.5) * h - em.position[2],
      );
      dist[q] = dd;
      if (dd < best) best = dd;
    }
    const cl: number[] = [];
    for (let q = 0; q < solidList.length; q++) if (dist[q] <= best + 1.01 * h) cl.push(solidList[q]);
    extraCells.push(cl);
    if (em.massGrams > 0 && cl.length > 0) {
      const f = (em.massGrams / 1000) * G0;
      loads.push({ region: { kind: 'cells', indices: cl }, force: [f * d[0], f * d[1], f * d[2]] });
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
  const warnings: string[] = [];
  if (fixture.kind === 'plane') {
    const solid = new Uint8Array(N);
    for (const v of solidList) solid[v] = grid.cells[v];
    patchVoxels = resolveRegion({ nx, ny, nz, h, origin, solid }, fixture).voxels.length;
  }

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
    warnings: structural.warnings,
  };
}
