/**
 * PurchasedPart geometry: envelope box (local frame centred in XY, z ∈ [0, envelope[2]]) or, when
 * `fan` data is present, a simple axial fan (square frame with a round bore and 4 corner mounting
 * holes, hub, struts and 7 pitched blades). Air flows along local +Z.
 */
import type { PurchasedPart, Vec3 } from '@pcbcad/core';
import { mat4FromBasis, mul } from './mat';
import { circlePoly, rectPoly } from './poly';
import { prism, union, type Solid } from './solid';

export interface FanGeom {
  /** Bore radius (mm). */
  boreRadius: number;
  hubRadius: number;
  /** Mounting hole centres (local XY) and diameter. */
  holes: [number, number][];
  holeDiameter: number;
}

export function fanGeom(env: Vec3): FanGeom {
  const s = Math.min(env[0], env[1]);
  const rb = 0.47 * s;
  return {
    boreRadius: rb,
    hubRadius: 0.32 * rb,
    holes: [
      [0.4 * env[0], 0.4 * env[1]],
      [-0.4 * env[0], 0.4 * env[1]],
      [-0.4 * env[0], -0.4 * env[1]],
      [0.4 * env[0], -0.4 * env[1]],
    ],
    holeDiameter: 0.085 * s,
  };
}

/**
 * @param detailed include hub, struts and blades (rendering); false = frame only (airflow domain,
 *        where the bore is a fan boundary condition rather than solid).
 */
export function purchasedSolid(p: PurchasedPart, detailed = true): Solid | null {
  const [w, d, h] = (p.envelope ?? [0, 0, 0]).map(Number) as Vec3;
  if (!(w > 0 && d > 0 && h > 0)) return null;
  if (!p.fan) return prism(rectPoly(0, 0, w, d), 0, h);
  const g = fanGeom([w, d, h]);
  const frame = prism(rectPoly(0, 0, w, d), 0, h, undefined, [circlePoly(0, 0, g.boreRadius), ...g.holes.map(([x, y]) => circlePoly(x, y, g.holeDiameter / 2))]);
  if (!detailed) return frame;
  const s = Math.min(w, d);
  const parts: Solid[] = [frame, prism(circlePoly(0, 0, g.hubRadius), 0.08 * h, 0.92 * h)];
  // struts on the outlet side
  const sw = Math.max(1, 0.05 * s);
  for (let k = 0; k < 4; k++) {
    const a = ((45 + 90 * k) * Math.PI) / 180;
    const ex: Vec3 = [Math.cos(a), Math.sin(a), 0];
    const ey: Vec3 = [-Math.sin(a), Math.cos(a), 0];
    parts.push(prism(rectPoly((g.hubRadius * 0.8 + g.boreRadius + 0.5) / 2, 0, g.boreRadius + 0.5 - g.hubRadius * 0.8, sw), 0.82 * h, h, mat4FromBasis([0, 0, 0], ex, ey, [0, 0, 1])));
  }
  // blades: thin plates pitched 35° about their radial axis
  const n = 7;
  const r0 = g.hubRadius * 0.9;
  const r1 = g.boreRadius - Math.max(0.4, 0.01 * s);
  const chord = 0.55 * h;
  const tb = Math.max(0.6, 0.012 * s);
  const pitch = (35 * Math.PI) / 180;
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    const rz = mul(mat4FromBasis([0, 0, h / 2], [Math.cos(a), Math.sin(a), 0], [-Math.sin(a), Math.cos(a), 0], [0, 0, 1]));
    const rx = mat4FromBasis([0, 0, 0], [1, 0, 0], [0, Math.cos(pitch), Math.sin(pitch)], [0, -Math.sin(pitch), Math.cos(pitch)]);
    parts.push(prism(rectPoly((r0 + r1) / 2, 0, r1 - r0, chord), -tb / 2, tb / 2, mul(rz, rx, mat4FromBasis([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0]))));
  }
  return union(parts);
}
