/**
 * Mass properties of closed triangle meshes (divergence theorem). Works on any closed, consistently
 * oriented mesh — split (crease) vertices and multiple disjoint/overlapping groups are fine; overlaps
 * between separate closed groups are counted twice.
 */
import type { BBox3, MeshData, Vec3 } from '@pcbcad/core';
import { meshArrays } from './meshutil';

export interface MassProperties {
  /** Enclosed volume (mm³). */
  volumeMm3: number;
  /** Mass (g) = volume · density. */
  massGrams: number;
  /** Centre of volume / mass (mm, mesh frame). */
  centroid: Vec3;
  bbox: BBox3;
  /** Surface area (mm²). */
  areaMm2: number;
  /** Inertia tensor about the centroid (g·mm²) [Ixx, Iyy, Izz, Ixy, Iyz, Ixz]. */
  inertia: [number, number, number, number, number, number];
}

/**
 * @param densityKgM3 material density (kg/m³); mass g = mm³ · 1e-9 m³/mm³ · ρ · 1000 g/kg.
 * Inverted meshes (negative signed volume) are handled by taking the absolute value.
 */
export function massProperties(mesh: MeshData, densityKgM3: number): MassProperties {
  let V = 0, cx = 0, cy = 0, cz = 0, area = 0;
  let xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, xz = 0;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const { positions: p, indices: ix } of meshArrays(mesh)) {
    for (let i = 0; i + 2 < p.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < min[k]) min[k] = p[i + k];
        if (p[i + k] > max[k]) max[k] = p[i + k];
      }
    for (let t = 0; t + 2 < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      const x0 = p[a], y0 = p[a + 1], z0 = p[a + 2];
      const x1 = p[b], y1 = p[b + 1], z1 = p[b + 2];
      const x2 = p[c], y2 = p[c + 1], z2 = p[c + 2];
      // signed tetra volume with the origin ×6
      const d = x0 * (y1 * z2 - z1 * y2) - y0 * (x1 * z2 - z1 * x2) + z0 * (x1 * y2 - y1 * x2);
      V += d;
      cx += d * (x0 + x1 + x2);
      cy += d * (y0 + y1 + y2);
      cz += d * (z0 + z1 + z2);
      // second moments (canonical tetrahedron integrals)
      xx += d * (x0 * x0 + x1 * x1 + x2 * x2 + x0 * x1 + x1 * x2 + x0 * x2);
      yy += d * (y0 * y0 + y1 * y1 + y2 * y2 + y0 * y1 + y1 * y2 + y0 * y2);
      zz += d * (z0 * z0 + z1 * z1 + z2 * z2 + z0 * z1 + z1 * z2 + z0 * z2);
      xy += d * (2 * (x0 * y0 + x1 * y1 + x2 * y2) + x0 * y1 + x1 * y0 + x1 * y2 + x2 * y1 + x0 * y2 + x2 * y0);
      yz += d * (2 * (y0 * z0 + y1 * z1 + y2 * z2) + y0 * z1 + y1 * z0 + y1 * z2 + y2 * z1 + y0 * z2 + y2 * z0);
      xz += d * (2 * (x0 * z0 + x1 * z1 + x2 * z2) + x0 * z1 + x1 * z0 + x1 * z2 + x2 * z1 + x0 * z2 + x2 * z0);
      const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0, vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
      area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
  }
  const sign = V < 0 ? -1 : 1;
  const vol = (V * sign) / 6;
  const centroid: Vec3 = V !== 0 ? [cx / (4 * V), cy / (4 * V), cz / (4 * V)] : [0, 0, 0];
  const rho = densityKgM3 * 1e-6; // g/mm³
  // ∫x² dV = Σ d/60 · (...) ; products ∫xy dV = Σ d/120 · (...)
  const Sxx = (sign * xx) / 60, Syy = (sign * yy) / 60, Szz = (sign * zz) / 60;
  const Sxy = (sign * xy) / 120, Syz = (sign * yz) / 120, Sxz = (sign * xz) / 120;
  const [gx, gy, gz] = centroid;
  const Ixx = rho * (Syy + Szz - vol * (gy * gy + gz * gz));
  const Iyy = rho * (Sxx + Szz - vol * (gx * gx + gz * gz));
  const Izz = rho * (Sxx + Syy - vol * (gx * gx + gy * gy));
  const Ixy = -rho * (Sxy - vol * gx * gy);
  const Iyz = -rho * (Syz - vol * gy * gz);
  const Ixz = -rho * (Sxz - vol * gx * gz);
  return {
    volumeMm3: vol,
    massGrams: vol * rho,
    centroid,
    bbox: Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] },
    areaMm2: area,
    inertia: [Ixx, Iyy, Izz, Ixy, Iyz, Ixz],
  };
}
