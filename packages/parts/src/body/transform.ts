import type { BodyPrimitive, FootprintDef, Vec2, Vec3 } from '@pcbcad/core';
import { rnd } from '../util/num';

export type QuarterTurn = 0 | 90 | 180 | 270;

function rot2(x: number, y: number, deg: QuarterTurn): [number, number] {
  switch (deg) {
    case 90:
      return [-y, x];
    case 180:
      return [-x, -y];
    case 270:
      return [y, -x];
    default:
      return [x, y];
  }
}

/** Rotate primitives about the Z axis by a multiple of 90° (CCW). */
export function rotatePrimitivesZ(prims: BodyPrimitive[], deg: QuarterTurn): BodyPrimitive[] {
  if (deg === 0) return prims.map((p) => ({ ...p }));
  const swap = deg === 90 || deg === 270;
  return prims.map((p) => {
    if (p.kind === 'box') {
      const [x, y] = rot2(p.center[0], p.center[1], deg);
      const size: Vec3 = swap ? [p.size[1], p.size[0], p.size[2]] : [...p.size];
      const out: BodyPrimitive = { ...p, center: [rnd(x), rnd(y), p.center[2]], size };
      if (p.rotation) out.rotation = [p.rotation[0], p.rotation[1], p.rotation[2] + deg];
      return out;
    }
    if (p.kind === 'cylinder') {
      const [x, y] = rot2(p.center[0], p.center[1], deg);
      const axis = swap && p.axis !== 'z' ? (p.axis === 'x' ? 'y' : 'x') : p.axis;
      return { ...p, center: [rnd(x), rnd(y), p.center[2]], axis };
    }
    return { ...p, points: p.points.map(([x, y]) => rot2(x, y, deg).map((v) => rnd(v)) as Vec2) };
  });
}

function padCentroid(fp: FootprintDef, number: string): Vec2 | undefined {
  const pads = fp.pads.filter((p) => p.number === number);
  if (!pads.length) return undefined;
  return [pads.reduce((a, p) => a + p.x, 0) / pads.length, pads.reduce((a, p) => a + p.y, 0) / pads.length];
}

function extents(fp: FootprintDef): [number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of fp.pads) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return [maxX - minX, maxY - minY];
}

/**
 * Quarter turn that maps the `generated` footprint onto the `target` footprint (e.g. a distributor
 * footprint drawn in another orientation), judged by the position of pad 1 relative to the origin,
 * falling back to the aspect ratio of the pad array.
 */
export function alignmentTurn(target: FootprintDef, generated: FootprintDef): QuarterTurn {
  const a = padCentroid(target, '1');
  const b = padCentroid(generated, '1');
  if (a && b && Math.hypot(a[0], a[1]) > 0.2 && Math.hypot(b[0], b[1]) > 0.2) {
    const d = ((Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0])) * 180) / Math.PI;
    const q = (((Math.round(d / 90) * 90) % 360) + 360) % 360;
    return q as QuarterTurn;
  }
  const [tw, tl] = extents(target);
  const [gw, gl] = extents(generated);
  if (Math.abs(tw - tl) > 0.3 && Math.abs(gw - gl) > 0.3 && tw > tl !== gw > gl) return 90;
  return 0;
}
