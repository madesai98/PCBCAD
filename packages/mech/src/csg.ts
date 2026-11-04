/**
 * CustomPart CsgNode → Solid IR (core CsgNode semantics):
 *  - box: size [x,y,z], corner at the origin unless center; `radius` rounds all edges (hull of spheres)
 *  - cylinder: along +Z from 0 to height (or centred), radiusTop for cones
 *  - sphere, extrude (XY polygon along +Z, either winding), revolve ((r, z) profile about Z)
 *  - union / difference (first child minus the rest) / intersection
 *  - transform: Euler XYZ degrees (three.js order) + translation, applied to the node.
 */
import type { CsgNode, Vec2 } from '@pcbcad/core';
import { mat4FromT } from './mat';
import { prism, type Solid } from './solid';

export function csgToSolid(node: CsgNode, path = 'csg'): Solid {
  if (!node || typeof node !== 'object') throw new Error(`${path}: CSG node must be an object`);
  const m = 'transform' in node && node.transform ? mat4FromT(node.transform) : undefined;
  if ('op' in node) {
    const ops = ['union', 'difference', 'intersection'];
    if (!ops.includes(node.op)) throw new Error(`${path}: unknown op '${String(node.op)}'`);
    const kids = (node.children ?? []).map((c, i) => csgToSolid(c, `${path}.${node.op}[${i}]`));
    return { kind: node.op, children: kids, m };
  }
  switch (node.shape) {
    case 'box':
      return { kind: 'box', size: [Number(node.size?.[0]), Number(node.size?.[1]), Number(node.size?.[2])], center: !!node.center, radius: node.radius, m };
    case 'cylinder':
      return {
        kind: 'cylinder',
        r0: Number(node.radius),
        r1: node.radiusTop != null ? Number(node.radiusTop) : Number(node.radius),
        h: Number(node.height),
        center: !!node.center,
        segments: node.segments,
        m,
      };
    case 'sphere':
      return { kind: 'sphere', r: Number(node.radius), m };
    case 'extrude':
      return prism((node.points ?? []).map((p) => [Number(p[0]), Number(p[1])] as Vec2), 0, Number(node.height), m);
    case 'revolve':
      return { kind: 'revolve', profile: (node.profile ?? []).map((p) => [Math.max(0, Number(p[0])), Number(p[1])] as Vec2), segments: node.segments, m };
    default:
      throw new Error(`${path}: unknown shape '${String((node as { shape?: string }).shape)}'`);
  }
}
