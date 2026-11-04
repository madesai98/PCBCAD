/**
 * Assembly checks (category 'assembly'):
 *  - interference between assembly instances (boards include their component bodies), by sampling
 *    both solids on a fine voxel grid over the intersection of their bounding boxes; reports pairs,
 *    overlap volume, location and (for boards) the offending components;
 *  - board inside its enclosure interior with ≥ clearance (default 0.5 mm) to the drafted walls;
 *  - component bodies vs the inner floor/ceiling of each shell (≥ clearance);
 *  - board mounting holes coaxial (≤ 0.3 mm) with a boss or standoff, seated on it, and with a
 *    fastener on the axis;
 *  - edge connectors (ConnectorSpec.opening + matingDirection) aligned with a linked/covering cutout:
 *    centre within 0.5 mm, size ≥ opening + 0.3 mm (cutout halves of base and cover on the same
 *    assembly face are merged);
 *  - screw length vs clamp stack: thread engagement ≥ 1.5·d into the insert/boss, no bottoming out;
 *  - screw/insert bosses without a fastener.
 * Geometry comes from the analytic Solid IR (sync). `opts.meshes` (keyed by instance id or part id)
 * replaces the solid of a mechanical instance for interference checks (e.g. imported models).
 */
import type { BBox3, DesignIssue, EnclosureShell, FastenerSpec, Mat4, MeshData, Project, ShellBoss, ShellFace, Vec3 } from '@pcbcad/core';
import { apply, applyDir, mat4Invert, v3 } from './mat';
import { meshBBox, transformedArrays } from './meshutil';
import { fastenerDims, insertTable } from './fastener';
import { bossGeom, faceFrame, pocketAt, shellGeom, type BossGeom, type ShellGeom } from './shell';
import { bbInter, compileSolid, gridForBBox, rasterizeSolid, type CNode, type GridSpec } from './solid';
import { rasterizeMesh } from './voxel';
import { itemSolid, worldItems, type WorldComponent, type WorldItem } from './world';
import { sdRoundRect } from './poly';

export interface AssemblyCheckOptions {
  /** Meshes overriding the analytic geometry of mechanical instances (key: instance id or part id). */
  meshes?: Map<string, MeshData>;
  /** Interference sampling cell size (mm). Default: adaptive 0.1–0.5 mm per pair. */
  resolution?: number;
  /** Smallest overlap reported (mm³). Default max(0.5, 4 cells). */
  minOverlapMm3?: number;
  /** Required clearance board↔walls and components↔floors (mm). Default 0.5. */
  clearance?: number;
}

const fmt = (v: number, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toString();

interface ShellW {
  item: WorldItem;
  shell: EnclosureShell;
  g: ShellGeom;
  m: Mat4;
  inv: Mat4;
}

interface BossW {
  sw: ShellW;
  boss: ShellBoss;
  bg: BossGeom;
  /** Axis points (assembly frame) at the boss root (inner floor) and top. */
  root: Vec3;
  top: Vec3;
  /** Unit axis from root to top. */
  dir: Vec3;
}

interface Occupant {
  item: WorldItem;
  name: string;
  bb: BBox3;
  node: CNode | null;
  mesh?: { positions: Float32Array; indices: Uint32Array }[];
  parts: { name: string; node: CNode; componentId?: string }[];
}

/** Perpendicular distance from point p to the line (a, dir). */
function lateral(p: Vec3, a: Vec3, dir: Vec3): number {
  const d = v3.sub(p, a);
  const along = v3.dot(d, dir);
  return v3.len(v3.sub(d, v3.scale(dir, along)));
}

function bbVolume(b: BBox3): number {
  return Math.max(0, b.max[0] - b.min[0]) * Math.max(0, b.max[1] - b.min[1]) * Math.max(0, b.max[2] - b.min[2]);
}

function transformBB(b: BBox3, m: Mat4): BBox3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const p = apply(m, [c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]]);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}

const CLAMPING = new Set(['screw', 'self-tapping-screw', 'bolt', 'rivet', 'standoff', 'pem-standoff']);

const MATING: Record<string, Vec3> = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1] };

function faceBasis(n: Vec3): { s: Vec3; t: Vec3 } {
  const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const s = v3.norm(v3.cross(ref, n));
  return { s, t: v3.cross(n, s) };
}

export function checkAssembly(project: Project, opts: AssemblyCheckOptions = {}): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const seen = new Map<string, number>();
  const add = (code: string, severity: DesignIssue['severity'], message: string, extra: Partial<DesignIssue> = {}, key?: string) => {
    const base = `asm:${code}${key ? ':' + key : ''}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    issues.push({ id: n ? `${base}:${n}` : base, severity, category: 'assembly', code, message, ...extra });
  };
  const clearance = opts.clearance ?? 0.5;
  const { items, warnings } = worldItems(project);
  for (const w of warnings) add('model', 'warning', w);
  if (!items.length) {
    add('empty-assembly', 'info', 'The assembly has no instances — nothing to check', { suggestion: 'Place boards and mechanical parts (or run autoEnclosure).' });
    return issues;
  }
  const specOf = (partId: string): FastenerSpec | undefined => project.parts?.[partId]?.fastener;

  // shells and bosses in the assembly frame
  const shells: ShellW[] = [];
  for (const it of items) {
    if (it.part?.kind !== 'enclosure-shell') continue;
    try {
      shells.push({ item: it, shell: it.part, g: shellGeom(it.part), m: it.m, inv: mat4Invert(it.m) });
    } catch (e) {
      add('invalid-shell', 'error', `Shell '${it.part.name}': ${e instanceof Error ? e.message : String(e)}`, { target: { partId: it.part.id, instanceIds: [it.instance.id] } });
    }
  }
  const bosses: BossW[] = [];
  for (const sw of shells)
    for (const b of sw.shell.bosses ?? []) {
      const bg = bossGeom(sw.g, b, b.fastenerPartId ? specOf(b.fastenerPartId) : undefined);
      if (!bg) continue;
      const root = apply(sw.m, [b.x, b.y, bg.z0]);
      const top = apply(sw.m, [b.x, b.y, bg.z1]);
      bosses.push({ sw, boss: b, bg, root, top, dir: v3.norm(v3.sub(top, root)) });
    }

  /* ------------------------------------------ interference ------------------------------------- */
  const occ: Occupant[] = [];
  for (const it of items) {
    const name = it.instance.name || it.part?.name || it.board?.name || it.instance.id;
    const mesh = it.kind === 'mech' ? opts.meshes?.get(it.instance.id) ?? (it.part ? opts.meshes?.get(it.part.id) : undefined) : undefined;
    if (mesh) {
      occ.push({ item: it, name, bb: transformBB(meshBBox(mesh, true), it.m), node: null, mesh: transformedArrays(mesh, it.m), parts: [] });
      continue;
    }
    const s = itemSolid(it);
    const node = s ? compileSolid(s) : null;
    if (!node) continue;
    const parts: Occupant['parts'] = [];
    if (it.kind === 'board') {
      const slab = it.solid ? compileSolid(it.solid) : null;
      if (slab) parts.push({ name: `board ${it.board?.name ?? ''}`.trim(), node: slab });
      for (const c of it.components) {
        const cn = compileSolid(c.solid);
        if (cn) parts.push({ name: `${c.ref}${c.part ? ` (${c.part.mpn || c.part.description || c.part.id})` : ''}`, node: cn, componentId: c.componentId });
      }
    }
    occ.push({ item: it, name, bb: node.bb, node, parts });
  }
  const maskOf = (o: { node: CNode | null; mesh?: Occupant['mesh'] }, g: GridSpec) => (o.mesh ? rasterizeMesh(o.mesh, g) : rasterizeSolid(o.node, g));
  for (let i = 0; i < occ.length; i++)
    for (let j = i + 1; j < occ.length; j++) {
      const A = occ[i], B = occ[j];
      const region = bbInter(A.bb, B.bb);
      if (!region || bbVolume(region) < 1e-6) continue;
      const vol = bbVolume(region);
      const h = opts.resolution ?? Math.max(0.1, Math.min(0.5, Math.cbrt(vol / 1.2e6)));
      const g0 = gridForBBox(region, h);
      const g: GridSpec = { ...g0, origin: [g0.origin[0] + 0.0137 * h, g0.origin[1] + 0.0291 * h, g0.origin[2] + 0.0173 * h] };
      const ma = maskOf(A, g);
      const mb = maskOf(B, g);
      let n = 0, cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < g.nz; k++)
        for (let jj = 0; jj < g.ny; jj++)
          for (let ii = 0; ii < g.nx; ii++) {
            const q = ii + g.nx * (jj + g.ny * k);
            if (!ma[q] || !mb[q]) continue;
            n++;
            cx += ii;
            cy += jj;
            cz += k;
          }
      const ov = n * h * h * h;
      const minOv = opts.minOverlapMm3 ?? Math.max(0.5, 4 * h * h * h);
      if (ov < minOv) continue;
      const at: Vec3 = [g.origin[0] + (cx / n + 0.5) * h, g.origin[1] + (cy / n + 0.5) * h, g.origin[2] + (cz / n + 0.5) * h];
      // attribute to board sub-parts
      const culprits: string[] = [];
      const componentIds: string[] = [];
      for (const [X, other] of [
        [A, mb],
        [B, ma],
      ] as const) {
        for (const p of X.parts) {
          if (!bbInter(p.node.bb, region)) continue;
          const pm = rasterizeSolid(p.node, g);
          let c = 0;
          for (let q = 0; q < pm.length; q++) if (pm[q] && other[q]) c++;
          if (c * h ** 3 >= minOv) {
            culprits.push(`${p.name} ${fmt(c * h ** 3, 1)} mm³`);
            if (p.componentId) componentIds.push(p.componentId);
          }
        }
      }
      const boardIds = [A, B].filter((o) => o.item.board).map((o) => o.item.board!.id);
      add(
        'interference',
        'error',
        `'${A.name}' and '${B.name}' intersect: ${fmt(ov, 1)} mm³ overlap around (${at.map((v) => fmt(v, 1)).join(', ')})${culprits.length ? ` — ${culprits.join('; ')}` : ''}`,
        {
          target: { instanceIds: [A.item.instance.id, B.item.instance.id], ...(componentIds.length ? { componentIds } : {}), ...(boardIds.length ? { boardId: boardIds[0] } : {}) },
          at,
          suggestion: 'Move/resize one of the parts (or the offending components) so the bodies do not overlap; for boards on bosses make the board bottom coincide with the boss tops.',
        },
        `${A.item.instance.id}-${B.item.instance.id}`,
      );
    }

  /* ---------------------------------- boards inside enclosures --------------------------------- */
  const boardsItems = items.filter((it) => it.kind === 'board' && it.board);
  for (const it of boardsItems) {
    const b = it.board!;
    const tb = b.stackup?.thickness ?? 1.6;
    if (!shells.length) continue;
    const samples: Vec3[] = [];
    const outline = b.outline ?? [];
    for (let k = 0; k < outline.length; k++) {
      const p = outline[k];
      const q = outline[(k + 1) % outline.length];
      for (const z of [0, tb]) {
        samples.push(apply(it.m, [p[0], p[1], z]));
        samples.push(apply(it.m, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, z]));
      }
    }
    let worst = Infinity;
    let worstAt: Vec3 | undefined;
    let enclosed = 0;
    for (const p of samples) {
      let best = -Infinity;
      for (const sw of shells) {
        const l = apply(sw.inv, p);
        if (l[2] < sw.g.t - 1e-6 || l[2] > sw.g.H + 1e-6) continue;
        const pk = pocketAt(sw.g, l[2]);
        const c = -sdRoundRect(l[0], l[1], pk.hx, pk.hy, pk.r);
        best = Math.max(best, c);
      }
      if (best === -Infinity) continue;
      enclosed++;
      if (best < worst) {
        worst = best;
        worstAt = p;
      }
    }
    if (!enclosed) {
      add('board-not-enclosed', 'warning', `Board '${b.name}' is not inside any enclosure shell's interior`, { target: { boardId: b.id, instanceIds: [it.instance.id] }, suggestion: 'Place the board inside the base shell (above its inner floor) or regenerate the enclosure.' }, b.id);
      continue;
    }
    if (worst < 0)
      add('board-outside-enclosure', 'error', `Board '${b.name}' crosses the enclosure wall by ${fmt(-worst)} mm`, { target: { boardId: b.id, instanceIds: [it.instance.id] }, at: worstAt, suggestion: 'Enlarge the enclosure or move the board inward.' }, b.id);
    else if (worst < clearance)
      add('board-clearance', 'warning', `Board '${b.name}' edge is only ${fmt(worst)} mm from the inner wall (< ${clearance} mm)`, { target: { boardId: b.id, instanceIds: [it.instance.id] }, at: worstAt, suggestion: `Keep ≥ ${clearance} mm (≥ 1 mm recommended for tolerances and draft).` }, b.id);
  }

  /* ------------------------------ component heights vs floors ---------------------------------- */
  for (const it of boardsItems) {
    for (const sw of shells) {
      let worst = Infinity;
      let who: WorldComponent | undefined;
      for (const c of it.components) {
        const corners: Vec3[] = [];
        for (let k = 0; k < 8; k++) corners.push(apply(sw.inv, apply(c.m, [k & 1 ? c.box.max[0] : c.box.min[0], k & 2 ? c.box.max[1] : c.box.min[1], k & 4 ? c.box.max[2] : c.box.min[2]])));
        const ctr = corners.reduce((s, p) => v3.add(s, v3.scale(p, 1 / 8)), [0, 0, 0] as Vec3);
        if (ctr[2] < sw.g.t || ctr[2] > sw.g.H + 50) continue;
        const pk = pocketAt(sw.g, Math.min(sw.g.H, Math.max(sw.g.t, ctr[2])));
        if (sdRoundRect(ctr[0], ctr[1], pk.hx, pk.hy, pk.r) > 0) continue;
        const gap = Math.min(...corners.map((p) => p[2])) - sw.g.t;
        if (gap < worst) {
          worst = gap;
          who = c;
        }
      }
      if (!who || worst >= clearance) continue;
      const sev = worst < 0 ? 'error' : 'warning';
      add('component-clearance', sev, `${who.ref} on board '${it.board!.name}' is ${worst < 0 ? `${fmt(-worst)} mm into` : `only ${fmt(worst)} mm from`} the inner floor of '${sw.shell.name}' (< ${clearance} mm)`, {
        target: { boardId: it.board!.id, componentIds: [who.componentId], instanceIds: [it.instance.id, sw.item.instance.id] },
        suggestion: `Increase the enclosure height (top/bottom clearance) or use a lower-profile part; keep ≥ ${clearance} mm.`,
      }, `${it.instance.id}-${sw.item.instance.id}`);
    }
  }

  /* ---------------------------- mounting holes, bosses, fasteners ------------------------------ */
  const fasteners = project.assembly?.fasteners ?? [];
  const fastAxis = fasteners.map((f) => ({ f, p: f.position, dir: v3.norm(f.direction ?? [0, 0, -1]), spec: specOf(f.partId) }));
  for (const it of boardsItems) {
    const b = it.board!;
    const tb = b.stackup?.thickness ?? 1.6;
    const nrm = v3.norm(applyDir(it.m, [0, 0, 1]));
    for (const hole of b.holes ?? []) {
      const p = apply(it.m, [hole.x, hole.y, 0]);
      const pTop = apply(it.m, [hole.x, hole.y, tb]);
      let best: { bw: BossW; lat: number } | undefined;
      for (const bw of bosses) {
        if (Math.abs(v3.dot(bw.dir, nrm)) < 0.999) continue;
        const lat = lateral(p, bw.root, bw.dir);
        if (lat > bw.bg.od / 2 + hole.drill / 2) continue;
        if (!best || lat < best.lat) best = { bw, lat };
      }
      const label = `mounting hole ${hole.id} of '${b.name}'`;
      const tgt = { boardId: b.id, instanceIds: [it.instance.id] };
      let supported = false;
      if (best) {
        if (best.lat > 0.3) {
          add('boss-misaligned', 'error', `Boss ${best.bw.boss.id} of '${best.bw.sw.shell.name}' is ${fmt(best.lat)} mm off-axis from ${label} (> 0.3 mm)`, { target: { ...tgt, partId: best.bw.sw.shell.id }, at: p, suggestion: 'Move the boss (or the board) so the axes coincide.' }, `${b.id}-${hole.id}`);
        } else {
          supported = true;
          // seating: boss end face vs nearest board face
          const gaps = [best.bw.top, best.bw.root].flatMap((e) => [p, pTop].map((q) => Math.abs(v3.dot(v3.sub(q, e), best!.bw.dir))));
          const seat = Math.min(...gaps);
          if (seat > 0.5)
            add('boss-gap', 'warning', `${label} is ${fmt(seat)} mm away from the face of boss ${best.bw.boss.id} — the board is not seated`, { target: tgt, at: p, suggestion: `Set the boss height so its top meets the board (adjust by ${fmt(seat)} mm).` }, `${b.id}-${hole.id}`);
        }
      }
      if (!supported) {
        const so = fastAxis.find((fa) => (fa.spec?.type === 'standoff' || fa.spec?.type === 'pem-standoff') && Math.abs(v3.dot(fa.dir, nrm)) > 0.98 && lateral(fa.p, p, nrm) <= 0.3);
        if (so) supported = true;
        else if (!best) add('hole-unsupported', 'warning', `${label} has no coaxial boss or standoff`, { target: tgt, at: p, suggestion: 'Add a boss/standoff under the hole (autoEnclosure does this) or remove the hole.' }, `${b.id}-${hole.id}`);
      }
      // a fastener that actually clamps the board: joins its instance, or is a screw/bolt/rivet/standoff
      const clamps = (fa: (typeof fastAxis)[number]) => (fa.f.joins ?? []).includes(it.instance.id) || (!!fa.spec && CLAMPING.has(fa.spec.type));
      const f = fastAxis.find((fa) => clamps(fa) && Math.abs(v3.dot(fa.dir, nrm)) > 0.98 && lateral(fa.p, p, nrm) <= Math.max(0.3, hole.drill / 2) && Math.abs(v3.dot(v3.sub(fa.p, p), nrm)) < 60);
      if (!f) add('missing-fastener', 'warning', `${label} has no fastener on its axis`, { target: tgt, at: p, suggestion: 'Add a FastenerInstance (screw) at the hole: position = bearing point on the board, direction = into the boss.' }, `${b.id}-${hole.id}`);
    }
  }

  /* --------------------------------- connectors vs cutouts ------------------------------------- */
  interface CutW {
    sw: ShellW;
    id: string;
    n: Vec3;
    plane: number;
    c: Vec3;
    eu: Vec3;
    ev: Vec3;
    w: number;
    h: number;
    linked?: { boardId: string; componentId: string };
  }
  const cuts: CutW[] = [];
  for (const sw of shells)
    for (const c of sw.shell.cutouts ?? []) {
      const fr = faceFrame(sw.g, c.face as ShellFace);
      const local = v3.add(v3.add(fr.o, v3.scale(fr.eu, c.u)), v3.scale(fr.ev, c.v));
      const cw = apply(sw.m, local);
      const n = v3.norm(applyDir(sw.m, fr.nOut));
      cuts.push({ sw, id: c.id, n, plane: v3.dot(apply(sw.m, fr.o), n), c: cw, eu: applyDir(sw.m, fr.eu), ev: applyDir(sw.m, fr.ev), w: c.width, h: c.shape === 'circle' ? c.width : c.height, linked: c.linked });
    }
  for (const it of boardsItems) {
    for (const comp of it.components) {
      const spec = comp.part?.connector;
      if (!spec?.opening || !spec.matingDirection || spec.matingDirection === '+z') continue;
      const md = v3.norm(applyDir(comp.m, MATING[spec.matingDirection]));
      const latFp: Vec3 = spec.matingDirection.endsWith('x') ? [0, 1, 0] : [1, 0, 0];
      const lat = v3.norm(applyDir(comp.m, latFp));
      const nb = v3.norm(applyDir(comp.m, [0, 0, 1]));
      const p = apply(comp.m, [0, 0, spec.opening.zCenter]);
      const { s, t } = faceBasis(md);
      const needS = Math.abs(v3.dot(lat, s)) * spec.opening.width + Math.abs(v3.dot(nb, s)) * spec.opening.height;
      const needT = Math.abs(v3.dot(lat, t)) * spec.opening.width + Math.abs(v3.dot(nb, t)) * spec.opening.height;
      const ps = v3.dot(p, s), pt = v3.dot(p, t);
      const tgt = { boardId: it.board!.id, componentIds: [comp.componentId], instanceIds: [it.instance.id] };
      const label = `${comp.ref} (${spec.family})`;
      const onFace = cuts.filter((c) => v3.dot(c.n, md) > 0.95 && c.plane - v3.dot(p, md) > -8 && c.plane - v3.dot(p, md) < 30);
      const rect = (c: CutW) => {
        const hs = (Math.abs(v3.dot(c.eu, s)) * c.w + Math.abs(v3.dot(c.ev, s)) * c.h) / 2;
        const ht = (Math.abs(v3.dot(c.eu, t)) * c.w + Math.abs(v3.dot(c.ev, t)) * c.h) / 2;
        const cs = v3.dot(c.c, s), ct = v3.dot(c.c, t);
        return { s0: cs - hs, s1: cs + hs, t0: ct - ht, t1: ct + ht };
      };
      const linked = cuts.filter((c) => c.linked?.componentId === comp.componentId && (!c.linked.boardId || c.linked.boardId === it.board!.id));
      if (linked.length && !linked.some((c) => onFace.includes(c))) {
        add('connector-cutout-face', 'error', `Cutout(s) linked to ${label} are not on the wall it faces`, { target: tgt, at: p, suggestion: 'Move the cutout to the face the connector mates through (or rotate the board).' }, comp.componentId);
        continue;
      }
      let seeds = linked.filter((c) => onFace.includes(c));
      if (!seeds.length) {
        const near = onFace
          .map((c) => {
            const r = rect(c);
            const ds = Math.max(r.s0 - ps, ps - r.s1, 0);
            const dt = Math.max(r.t0 - pt, pt - r.t1, 0);
            return { c, d: Math.hypot(ds, dt) };
          })
          .filter((x) => x.d <= 2)
          .sort((a, b) => a.d - b.d);
        if (near.length) seeds = [near[0].c];
      }
      if (!seeds.length) {
        add('connector-blocked', 'error', `Edge connector ${label} has no cutout in the wall it faces`, { target: tgt, at: p, suggestion: `Add a ${fmt(spec.opening.width + 0.5, 1)} × ${fmt(spec.opening.height + 0.5, 1)} mm cutout centred on the connector (linked to it).` }, comp.componentId);
        continue;
      }
      // merge touching cutouts on the same face plane (e.g. base + cover halves)
      const group = new Set(seeds);
      let u = seeds.map(rect).reduce((a, r) => ({ s0: Math.min(a.s0, r.s0), s1: Math.max(a.s1, r.s1), t0: Math.min(a.t0, r.t0), t1: Math.max(a.t1, r.t1) }));
      let grown = true;
      while (grown) {
        grown = false;
        for (const c of onFace) {
          if (group.has(c) || Math.abs(c.plane - seeds[0].plane) > 3) continue;
          const r = rect(c);
          if (r.s0 > u.s1 + 0.3 || r.s1 < u.s0 - 0.3 || r.t0 > u.t1 + 0.3 || r.t1 < u.t0 - 0.3) continue;
          group.add(c);
          u = { s0: Math.min(u.s0, r.s0), s1: Math.max(u.s1, r.s1), t0: Math.min(u.t0, r.t0), t1: Math.max(u.t1, r.t1) };
          grown = true;
        }
      }
      const offS = (u.s0 + u.s1) / 2 - ps;
      const offT = (u.t0 + u.t1) / 2 - pt;
      const names = [...group].map((c) => `${c.sw.shell.name}/${c.id}`).join(' + ');
      if (Math.abs(offS) > 0.5 || Math.abs(offT) > 0.5)
        add('connector-misaligned', 'error', `Cutout ${names} is offset from ${label} by ${fmt(offS)} mm horizontally and ${fmt(offT)} mm vertically (> 0.5 mm)`, { target: tgt, at: p, suggestion: 'Move the cutout so its centre matches the connector opening centre.' }, comp.componentId);
      const ws = u.s1 - u.s0, wt = u.t1 - u.t0;
      if (ws + 1e-6 < needS + 0.3 || wt + 1e-6 < needT + 0.3)
        add('connector-cutout-small', 'error', `Cutout ${names} is ${fmt(ws)} × ${fmt(wt)} mm but ${label} needs ≥ ${fmt(needS + 0.3)} × ${fmt(needT + 0.3)} mm (opening + 0.3 mm)`, { target: tgt, at: p, suggestion: `Enlarge the cutout to at least ${fmt(needS + 0.5, 1)} × ${fmt(needT + 0.5, 1)} mm.` }, comp.componentId);
      const bodyFace = Math.max(...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => v3.dot(apply(comp.m, [k & 1 ? comp.box.max[0] : comp.box.min[0], k & 2 ? comp.box.max[1] : comp.box.min[1], k & 4 ? comp.box.max[2] : comp.box.min[2]]), md)));
      const recess = seeds[0].plane - bodyFace;
      if (recess > 3) add('connector-recessed', 'warning', `${label} mating face is ${fmt(recess)} mm behind the outer wall surface — plugs may not seat`, { target: tgt, at: p, suggestion: 'Move the connector (or the board) toward the wall; ≤ 1–2 mm recess is typical.' }, comp.componentId);
    }
  }

  /* ----------------------------------- fastener lengths ---------------------------------------- */
  let unspecified = 0;
  for (const fa of fastAxis) {
    if (!fa.spec) {
      unspecified++;
      continue;
    }
    const isScrew = ['screw', 'self-tapping-screw', 'bolt'].includes(fa.spec.type);
    if (!isScrew) continue;
    const dims = fastenerDims(fa.spec);
    const L = fa.spec.length ?? dims.length;
    const d = dims.d;
    let target: { bw: BossW; entry: number } | undefined;
    for (const bw of bosses) {
      if (bw.boss.kind !== 'insert' && bw.boss.kind !== 'screw') continue;
      if (v3.dot(bw.dir, fa.dir) > -0.98) continue; // screw must point into the boss opening
      if (lateral(fa.p, bw.root, bw.dir) > 0.5) continue;
      const entry = v3.dot(v3.sub(bw.top, fa.p), fa.dir);
      if (entry < -0.5 || entry > L + 10) continue;
      if (!target || entry < target.entry) target = { bw, entry };
    }
    const tgt = { instanceIds: fa.f.joins ?? [] };
    const label = `Fastener ${fa.f.id} (${fa.spec.thread ?? `M${d}`} × ${L})`;
    if (!target) continue;
    const engage = L - target.entry;
    const boss = target.bw.boss;
    if (engage <= 0) {
      add('screw-too-short', 'error', `${label} ends ${fmt(-engage)} mm before boss ${boss.id} — no thread engagement`, { target: tgt, at: fa.p, suggestion: `Use a screw ≥ ${fmt(target.entry + 1.5 * d, 1)} mm long.` }, fa.f.id);
      continue;
    }
    let effective = engage;
    if (boss.kind === 'insert') {
      const ins = fastAxis.find((x) => x.spec?.type === 'heat-set-insert' && lateral(x.p, target!.bw.root, target!.bw.dir) <= 0.5);
      const insLen = ins?.spec?.length ?? insertTable(d).length;
      effective = Math.min(engage, insLen);
    }
    if (effective + 1e-9 < 1.5 * d)
      add('thread-engagement', 'warning', `${label}: ${fmt(effective)} mm of thread engagement in boss ${boss.id} (< 1.5 × d = ${fmt(1.5 * d)} mm)`, { target: tgt, at: fa.p, suggestion: `Use a ${fmt(target.entry + 1.5 * d, 1)}+ mm screw${boss.kind === 'insert' ? ' and an insert ≥ 1.5·d long' : ''}.` }, fa.f.id);
    const depth = boss.throughFloor ? Infinity : target.bw.bg.z1 - target.bw.bg.z0;
    if (engage > depth - 0.3)
      add('screw-bottoming', 'error', `${label} protrudes ${fmt(engage)} mm into boss ${boss.id} whose hole is only ${fmt(depth)} mm deep — it will bottom out`, { target: tgt, at: fa.p, suggestion: `Use a screw ≤ ${fmt(target.entry + depth - 0.5, 1)} mm long or deepen the boss.` }, fa.f.id);
  }
  if (unspecified) add('fastener-spec-missing', 'info', `${unspecified} fastener instance(s) reference no part with a FastenerSpec — lengths and engagement not checked`, { suggestion: 'Assign fastener PartDefs (with FastenerSpec) to the fastener instances.' });

  for (const bw of bosses) {
    if (bw.boss.kind !== 'screw' && bw.boss.kind !== 'insert') continue;
    const has = fastAxis.some((fa) => Math.abs(v3.dot(fa.dir, bw.dir)) > 0.98 && lateral(fa.p, bw.root, bw.dir) <= 0.5);
    if (!has)
      add('boss-no-fastener', 'warning', `${bw.boss.kind === 'insert' ? 'Insert' : 'Screw'} boss ${bw.boss.id} of '${bw.sw.shell.name}' has no fastener`, { target: { partId: bw.sw.shell.id, instanceIds: [bw.sw.item.instance.id] }, at: bw.top, suggestion: 'Add a FastenerInstance on the boss axis or remove the boss.' }, `${bw.sw.shell.id}-${bw.boss.id}`);
  }
  return issues;
}
