/**
 * Assembly world model: every AssemblyInstance as a Solid IR placed in the assembly frame.
 *  - Boards: outline polygon (board frame: origin at the outline bbox lower-left, bottom copper at
 *    z = 0) extruded by stackup.thickness, minus internal cutouts and mounting holes.
 *  - Components: box envelope in the footprint frame — bbox of model3d primitives (with the model's
 *    offset/rotation) when available, else PartDef.body (centred on the placement origin), else the
 *    footprint courtyard × (packageSpec.bodyH ?? 1 mm). Top-side bodies sit on z = thickness;
 *    bottom-side bodies are mirrored (footprint X and Z flipped) below z = 0.
 *  - Mechanical parts: partSolid() placed by the instance transform (explode offsets ignored).
 */
import type { AssemblyInstance, Board, BBox3, ComponentInstance, Mat4, MechPart, PartDef, Project, Vec2, Vec3 } from '@pcbcad/core';
import { mat4FromEuler } from '@pcbcad/core';
import { apply, mat4FromT, mat4RotZ, mat4Translation, mul } from './mat';
import { circlePoly } from './poly';
import { partSolid } from './parts';
import { purchasedSolid } from './purchased';
import { compileSolid, placed, prism, union, type CNode, type Solid } from './solid';

export interface BodyBox {
  min: Vec3;
  max: Vec3;
  source: 'model' | 'body' | 'courtyard' | 'default';
}

/** Component body envelope in the footprint frame (z = 0 at the board surface, +z away from it). */
export function componentBodyBox(part: PartDef | undefined): BodyBox {
  const prims = part?.model3d?.kind === 'primitives' ? part.model3d.primitives ?? [] : [];
  if (prims.length) {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const add = (p: Vec3) => {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    };
    const extra = part!.model3d!.rotation || part!.model3d!.offset ? mul(mat4Translation(part!.model3d!.offset ?? [0, 0, 0]), mat4FromEuler(part!.model3d!.rotation ?? [0, 0, 0])) : null;
    const corners = (lo: Vec3, hi: Vec3, m?: Mat4) => {
      for (let c = 0; c < 8; c++) {
        let p: Vec3 = [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]];
        if (m) p = apply(m, p);
        if (extra) p = apply(extra, p);
        add(p);
      }
    };
    for (const pr of prims) {
      if (pr.kind === 'box') {
        const h: Vec3 = [pr.size[0] / 2, pr.size[1] / 2, pr.size[2] / 2];
        const m = pr.rotation ? mul(mat4Translation(pr.center), mat4FromEuler(pr.rotation)) : mat4Translation(pr.center);
        corners([-h[0], -h[1], -h[2]], h, m);
      } else if (pr.kind === 'cylinder') {
        const r = pr.radius;
        const hh = pr.height / 2;
        const e: Vec3 = pr.axis === 'x' ? [hh, r, r] : pr.axis === 'y' ? [r, hh, r] : [r, r, hh];
        corners([pr.center[0] - e[0], pr.center[1] - e[1], pr.center[2] - e[2]], [pr.center[0] + e[0], pr.center[1] + e[1], pr.center[2] + e[2]]);
      } else if (pr.kind === 'extrusion' && pr.points.length) {
        const xs = pr.points.map((p) => p[0]);
        const ys = pr.points.map((p) => p[1]);
        corners([Math.min(...xs), Math.min(...ys), Math.min(pr.z0, pr.z1)], [Math.max(...xs), Math.max(...ys), Math.max(pr.z0, pr.z1)]);
      }
    }
    if (Number.isFinite(min[0]) && max[2] > min[2]) return { min: [min[0], min[1], Math.max(0, min[2])], max, source: 'model' };
  }
  if (part?.body && part.body.w > 0 && part.body.l > 0 && part.body.h > 0) {
    // Connector footprints are rarely centred on the housing (USB-C shells sit forward of their
    // pads, right-angle headers overhang the board edge), so a body box centred on the origin
    // misplaces the mating face. The courtyard (IPC margin ≈ 0.25 mm) tracks the housing.
    const cyc = part.footprint?.courtyard;
    if (part.category === 'connector' && cyc && cyc.maxX - cyc.minX > 0.6 && cyc.maxY - cyc.minY > 0.6) {
      const m = 0.25;
      return { min: [cyc.minX + m, cyc.minY + m, 0], max: [cyc.maxX - m, cyc.maxY - m, part.body.h], source: 'body' };
    }
    return { min: [-part.body.w / 2, -part.body.l / 2, 0], max: [part.body.w / 2, part.body.l / 2, part.body.h], source: 'body' };
  }
  const cy = part?.footprint?.courtyard;
  if (cy && cy.maxX > cy.minX && cy.maxY > cy.minY) {
    const h = part?.packageSpec?.bodyH && part.packageSpec.bodyH > 0 ? part.packageSpec.bodyH : 1;
    return { min: [cy.minX, cy.minY, 0], max: [cy.maxX, cy.maxY, h], source: 'courtyard' };
  }
  return { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 1], source: 'default' };
}

/** Footprint frame → board 3D frame for a placed component. */
export function componentMatrix(c: Pick<ComponentInstance, 'x' | 'y' | 'rotation' | 'side'>, boardThickness: number): Mat4 {
  if (c.side === 'bottom') return mul(mat4Translation([c.x, c.y, 0]), mat4RotZ(c.rotation || 0), [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);
  return mul(mat4Translation([c.x, c.y, boardThickness]), mat4RotZ(c.rotation || 0));
}

/** Board slab (board frame). */
export function boardSlabSolid(b: Board): Solid | null {
  if (!b.outline || b.outline.length < 3) return null;
  const t = b.stackup?.thickness ?? 1.6;
  const holes: Vec2[][] = [...(b.cutouts ?? []).filter((c) => c.length >= 3), ...(b.holes ?? []).filter((h) => h.drill > 0).map((h) => circlePoly(h.x, h.y, h.drill / 2, 24))];
  return prism(b.outline, 0, t, undefined, holes);
}

export interface WorldComponent {
  componentId: string;
  ref: string;
  boardId: string;
  instanceId: string;
  side: 'top' | 'bottom';
  part?: PartDef;
  box: BodyBox;
  /** Footprint frame → assembly frame. */
  m: Mat4;
  solid: Solid;
}

export interface WorldItem {
  instance: AssemblyInstance;
  kind: 'board' | 'mech';
  /** Instance (local) → assembly. */
  m: Mat4;
  part?: MechPart;
  board?: Board;
  /** Placed solid (mech part, or board slab only). */
  solid: Solid | null;
  components: WorldComponent[];
}

export interface WorldOptions {
  /** Fans as frame only (airflow) instead of hub + blades. */
  fanFrameOnly?: boolean;
}

export function instanceMatrix(inst: AssemblyInstance): Mat4 {
  return mat4FromT(inst.transform);
}

/** Build the world model of all assembly instances. Unknown targets are reported in `warnings`. */
export function worldItems(project: Project, opts: WorldOptions = {}): { items: WorldItem[]; warnings: string[] } {
  const items: WorldItem[] = [];
  const warnings: string[] = [];
  for (const inst of project.assembly?.instances ?? []) {
    const m = instanceMatrix(inst);
    if (inst.target.kind === 'board') {
      const boardId = inst.target.boardId;
      const board = project.boards.find((b) => b.id === boardId);
      if (!board) {
        warnings.push(`Instance '${inst.name}' references unknown board '${boardId}'`);
        continue;
      }
      const slab = boardSlabSolid(board);
      const t = board.stackup?.thickness ?? 1.6;
      const components: WorldComponent[] = [];
      for (const c of board.components ?? []) {
        if (c.dnp) continue;
        const part = project.parts?.[c.partId];
        const box = componentBodyBox(part);
        const cm = mul(m, componentMatrix(c, t));
        const solid: Solid = { kind: 'box', size: [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]], m: mul(cm, mat4Translation(box.min)) };
        components.push({ componentId: c.id, ref: c.ref, boardId: board.id, instanceId: inst.id, side: c.side, part, box, m: cm, solid });
      }
      items.push({ instance: inst, kind: 'board', m, board, solid: slab && placed(slab, m), components });
    } else {
      const partId = inst.target.partId;
      const part = project.mechanical.find((p) => p.id === partId);
      if (!part) {
        warnings.push(`Instance '${inst.name}' references unknown mechanical part '${partId}'`);
        continue;
      }
      let s: Solid | null;
      try {
        s = part.kind === 'purchased' && opts.fanFrameOnly ? purchasedSolid(part, false) : partSolid(part, { project });
      } catch (e) {
        warnings.push(`Part '${part.name}': ${e instanceof Error ? e.message : String(e)}`);
        s = null;
      }
      items.push({ instance: inst, kind: 'mech', m, part, solid: s && placed(s, m), components: [] });
    }
  }
  return { items, warnings };
}

/** Compiled solid of a whole item (board: slab ∪ components). */
export function itemSolid(it: WorldItem): Solid | null {
  if (it.kind === 'board') return union([it.solid, ...it.components.map((c) => c.solid)]);
  return it.solid;
}

export function compileItem(it: WorldItem): CNode | null {
  const s = itemSolid(it);
  return s ? compileSolid(s) : null;
}

/** World AABB of a component body. */
export function componentWorldBBox(c: WorldComponent): BBox3 {
  return compileSolid(c.solid)!.bb;
}
