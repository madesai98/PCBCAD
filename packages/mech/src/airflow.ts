/**
 * Voxel domain for enclosure airflow / natural-convection simulation.
 *
 * Modelling choices (documented contract for the CFD solver):
 *  - Domain: union bbox of all enclosure shells in the assembly frame plus ONE cell of padding on
 *    every side (so the outer wall surfaces are resolved and every opening touches outside air);
 *    `ambientLayer: false` drops the padding so the walls form the domain boundary. Without shells
 *    the domain is the bbox of all instances (with a warning).
 *  - cells: 0 = air; v ≥ 1 solid with properties materials[v − 1] (EffectiveMaterial, i.e. already
 *    process-adjusted). Shell walls use effectiveMaterial(materialId, process, processOptions);
 *    boards are FR-4 slabs (stackup.dielectric) of their outline; component bodies are
 *    'epoxy-mold' blocks; other mechanical parts use their own material; fans contribute only their
 *    frame (the bore is air carrying the fan boundary condition).
 *  - openings[0] = 'ambient': every air cell OUTSIDE the enclosure envelope (padding layer and the
 *    region around rounded corners). Treat these as fixed ambient temperature/pressure cells.
 *    Following entries: one per vent pattern / cutout / snap window, containing the air cells of that
 *    feature's hole (inside the envelope) that are face-adjacent to ambient cells — i.e. the
 *    boundary faces through which air enters/leaves. `openAreaMm2` is the true geometric open area,
 *    `porosity` = true area / resolved area (≤ 1): features narrower than a voxel are carved one
 *    voxel wide so they are never lost — scale their flow by `porosity`.
 *  - inside: 1 for cells within the enclosure envelope (walls + interior air), 0 outside.
 *  - componentCells: cells of each component body (≥ 1 cell guaranteed so no heat source is lost).
 *  - fans: air cells in each fan bore, direction = fan local +Z in the assembly frame, flowM3s =
 *    free-air flow (apply the fan curve with maxPressurePa).
 *  - h defaults to max(1, maxDim/60) mm.
 */
import type { EffectiveMaterial, EnclosureShell, Project, Vec2, Vec3, VoxelGrid } from '@pcbcad/core';
import { effectiveMaterial } from '@pcbcad/core';
import { applyDir, v3 } from './mat';
import { fanGeom } from './purchased';
import { boxPoly, circlePoly, polyArea } from './poly';
import { cutoutProfile, faceCutter, outerLoft, shellGeom, shellSolid, snapCatchExtents, ventSlots } from './shell';
import { bbUnion, compileSolid, gridForBBox, placed, prism, rasterizeSolid, type GridSpec, type Solid } from './solid';
import { materialKey } from './voxel';
import { worldItems, type WorldItem } from './world';

export interface AirflowOpening {
  name: string;
  cells: number[];
  kind: 'ambient' | 'vent' | 'cutout' | 'snap';
  /** Assembly-frame outward normal of the face carrying the feature (features only). */
  normal?: Vec3;
  /** True geometric open area (mm², features only). */
  openAreaMm2?: number;
  /** openAreaMm2 / resolved area (≤ 1). */
  porosity?: number;
  shellId?: string;
  featureId?: string;
}

export interface AirflowDomain {
  grid: VoxelGrid;
  materials: EffectiveMaterial[];
  componentCells: { componentId: string; ref: string; boardId: string; cells: number[] }[];
  openings: AirflowOpening[];
  fans: { name: string; cells: number[]; direction: Vec3; flowM3s: number; maxPressurePa?: number; instanceId?: string }[];
  warnings: string[];
  /** 1 = inside the enclosure envelope. */
  inside: Uint8Array;
}

export interface AirflowOptions {
  /** Voxel size (mm). Default max(1, maxDim/60). */
  h?: number;
  /**
   * Represent boards as FR-4 slabs and components as epoxy blocks from the board data (default
   * true). false = enclosure and mechanical parts only (empty-enclosure studies).
   */
  boardMeshesFallback?: boolean;
  /**
   * true (default): one cell of ambient air around the shells (walls exchange heat with the
   * 'ambient' opening cells). false: domain = shell bbox exactly, so wall cells form the domain
   * boundary (use the solver's external convection coefficient); only the dead air around rounded
   * corners is listed as 'ambient'.
   */
  ambientLayer?: boolean;
}

function stadiumArea(w: number, l: number): number {
  const a = Math.min(w, l);
  const b = Math.max(w, l);
  return (b - a) * a + (Math.PI * a * a) / 4;
}

/** Shell copy with sub-voxel openings widened to ≥ 1.01·h so they survive centre sampling. */
function dilatedShell(s: EnclosureShell, h: number): EnclosureShell {
  const m = 1.01 * h;
  return {
    ...s,
    cutouts: (s.cutouts ?? []).map((c) => ({ ...c, width: Math.max(c.width, m), height: Math.max(c.height, m) })),
    vents: (s.vents ?? []).map((v) => ({ ...v, slotWidth: Math.max(v.slotWidth, m), slotLength: Math.max(v.slotLength, m) })),
  };
}

export async function voxelizeAssemblyForAirflow(project: Project, opts: AirflowOptions = {}): Promise<AirflowDomain> {
  const warnings: string[] = [];
  const withBoards = opts.boardMeshesFallback !== false;
  const { items, warnings: w0 } = worldItems(project, { fanFrameOnly: true });
  warnings.push(...w0);
  const shells = items.filter((it) => it.part?.kind === 'enclosure-shell');
  const others = items.filter((it) => !shells.includes(it) && (it.kind === 'mech' || withBoards));
  const bbOf = (list: WorldItem[]) =>
    list
      .map((it) => {
        const nodes = [it.solid, ...it.components.map((c) => c.solid)].filter((s): s is Solid => !!s).map((s) => compileSolid(s));
        return nodes.filter((n) => !!n).map((n) => n!.bb);
      })
      .flat();
  let bbs = bbOf(shells);
  if (!bbs.length) {
    warnings.push('No enclosure shells in the assembly — domain = bbox of all instances, no openings');
    bbs = bbOf(items);
  }
  if (!bbs.length) throw new Error('voxelizeAssemblyForAirflow: assembly is empty');
  const bb = bbUnion(bbs);
  const maxDim = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
  const h = opts.h && opts.h > 0 ? opts.h : Math.max(1, maxDim / 60);
  const g: GridSpec = gridForBBox(bb, h, opts.ambientLayer === false ? 0 : 1);
  const N = g.nx * g.ny * g.nz;
  if (N > 60_000_000) throw new Error(`voxelizeAssemblyForAirflow: ${N} cells — increase h`);
  const cells = new Uint8Array(N);
  const mats: EffectiveMaterial[] = [];
  const ids: string[] = [];
  const index = new Map<string, number>();
  const matIndex = (materialId: string, process: Parameters<typeof effectiveMaterial>[1], options?: Record<string, string | number | boolean>) => {
    const key = materialKey(materialId, process, options);
    let mi = index.get(key);
    if (mi === undefined) {
      let em: EffectiveMaterial;
      try {
        em = effectiveMaterial(materialId, process, options ?? {});
      } catch {
        warnings.push(`Unknown material '${materialId}' — using ABS properties`);
        em = effectiveMaterial('abs', process, options ?? {});
      }
      mats.push(em);
      ids.push(materialId);
      mi = mats.length;
      index.set(key, mi);
      if (mi > 255) throw new Error('voxelizeAssemblyForAirflow: more than 255 materials');
    }
    return mi;
  };
  const paint = (s: Solid | null, mi: number) => {
    if (!s) return 0;
    const mask = rasterizeSolid(s, g);
    let n = 0;
    for (let q = 0; q < N; q++)
      if (mask[q]) {
        cells[q] = mi;
        n++;
      }
    return n;
  };

  // enclosure envelope + walls (sub-voxel openings dilated)
  const inside = new Uint8Array(N);
  for (const it of shells) {
    const shell = it.part as EnclosureShell;
    const sg = shellGeom(shell);
    const env = rasterizeSolid(placed(outerLoft(sg), it.m), g);
    for (let q = 0; q < N; q++) if (env[q]) inside[q] = 1;
    const ds = dilatedShell(shell, h);
    paint(placed(shellSolid(ds), it.m), matIndex(shell.materialId, shell.process, shell.processOptions));
  }
  // other mechanical parts and boards
  const fans: AirflowDomain['fans'] = [];
  for (const it of others) {
    if (it.kind === 'mech' && it.part) {
      if (!paint(it.solid, matIndex(it.part.materialId, it.part.process, it.part.processOptions))) warnings.push(`Part '${it.part.name}' is smaller than a voxel (h = ${h.toFixed(2)} mm)`);
      if (it.part.kind === 'purchased' && it.part.fan) {
        const fg = fanGeom(it.part.envelope);
        const bore = placed(prism(circlePoly(0, 0, fg.boreRadius), 0, it.part.envelope[2]), it.m);
        const mask = rasterizeSolid(bore, g);
        const fc: number[] = [];
        for (let q = 0; q < N; q++) if (mask[q] && !cells[q]) fc.push(q);
        if (!fc.length) warnings.push(`Fan '${it.instance.name}' bore not resolved at h = ${h.toFixed(2)} mm`);
        fans.push({ name: it.instance.name || it.part.name, cells: fc, direction: v3.norm(applyDir(it.m, [0, 0, 1])), flowM3s: it.part.fan.maxFlowM3s, maxPressurePa: it.part.fan.maxPressurePa, instanceId: it.instance.id });
      }
    } else if (it.kind === 'board' && it.board) {
      paint(it.solid, matIndex(it.board.stackup?.dielectric || 'fr4', 'purchased'));
    }
  }
  // components (last, so heat sources are never overwritten)
  const componentCells: AirflowDomain['componentCells'] = [];
  if (withBoards) {
    const epoxy = matIndex('epoxy-mold', 'purchased');
    const owner = new Int32Array(N).fill(-1);
    const comps = others.flatMap((it) => it.components);
    comps.forEach((c, ci) => {
      const node = compileSolid(c.solid);
      if (!node) return;
      const mask = rasterizeSolid(node, g);
      let n = 0;
      for (let q = 0; q < N; q++)
        if (mask[q]) {
          cells[q] = epoxy;
          owner[q] = ci;
          n++;
        }
      if (!n) {
        // sub-voxel body: claim the cell containing its centre
        const ctr: Vec3 = [(node.bb.min[0] + node.bb.max[0]) / 2, (node.bb.min[1] + node.bb.max[1]) / 2, (node.bb.min[2] + node.bb.max[2]) / 2];
        const i = Math.floor((ctr[0] - g.origin[0]) / h), j = Math.floor((ctr[1] - g.origin[1]) / h), k = Math.floor((ctr[2] - g.origin[2]) / h);
        if (i >= 0 && j >= 0 && k >= 0 && i < g.nx && j < g.ny && k < g.nz) {
          const q = i + g.nx * (j + g.ny * k);
          if (owner[q] < 0) {
            cells[q] = epoxy;
            owner[q] = ci;
          }
        }
      }
    });
    const lists: number[][] = comps.map(() => []);
    for (let q = 0; q < N; q++) if (owner[q] >= 0) lists[owner[q]].push(q);
    comps.forEach((c, ci) => {
      if (!lists[ci].length) warnings.push(`Component ${c.ref} lies outside the domain or shares its only voxel`);
      componentCells.push({ componentId: c.componentId, ref: c.ref, boardId: c.boardId, cells: lists[ci] });
    });
  }

  // openings
  const ambient: number[] = [];
  for (let q = 0; q < N; q++) if (!inside[q] && !cells[q]) ambient.push(q);
  const openings: AirflowOpening[] = [{ name: 'ambient', cells: ambient, kind: 'ambient' }];
  const isAmbient = (i: number, j: number, k: number) => {
    if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) return true;
    const q = i + g.nx * (j + g.ny * k);
    return !inside[q] && !cells[q];
  };
  for (const it of shells) {
    const shell = it.part as EnclosureShell;
    const ds = dilatedShell(shell, h);
    const sg = shellGeom(ds);
    const feats: { id: string; kind: AirflowOpening['kind']; face: EnclosureShell['cutouts'][number]['face']; polys: Vec2[][]; area: number }[] = [];
    ds.cutouts.forEach((c, i) => feats.push({ id: c.id, kind: 'cutout', face: c.face, polys: [cutoutProfile(c)], area: Math.abs(polyArea(cutoutProfile(shell.cutouts[i]))) }));
    ds.vents.forEach((v, i) => feats.push({ id: v.id, kind: 'vent', face: v.face, polys: ventSlots(v), area: ventSlots(shell.vents[i]).length * stadiumArea(shell.vents[i].slotWidth, shell.vents[i].slotLength) }));
    for (const s of ds.snaps ?? []) {
      if (s.kind !== 'catch') continue;
      const e = snapCatchExtents(s, sg.H);
      feats.push({ id: s.id, kind: 'snap', face: s.face, polys: [boxPoly(e.u0, e.v0, e.u1, e.v1)], area: (e.u1 - e.u0) * (e.v1 - e.v0) });
    }
    for (const f of feats) {
      const mask = rasterizeSolid(placed({ kind: 'union', children: f.polys.map((p) => faceCutter(sg, f.face, p)) }, it.m), g);
      const oc: number[] = [];
      for (let k = 0; k < g.nz; k++)
        for (let j = 0; j < g.ny; j++)
          for (let i = 0; i < g.nx; i++) {
            const q = i + g.nx * (j + g.ny * k);
            if (!mask[q] || cells[q] || !inside[q]) continue;
            if (isAmbient(i + 1, j, k) || isAmbient(i - 1, j, k) || isAmbient(i, j + 1, k) || isAmbient(i, j - 1, k) || isAmbient(i, j, k + 1) || isAmbient(i, j, k - 1)) oc.push(q);
          }
      const nOut: Vec3 = f.face === 'floor' ? [0, 0, -1] : f.face === '+x' ? [1, 0, 0] : f.face === '-x' ? [-1, 0, 0] : f.face === '+y' ? [0, 1, 0] : [0, -1, 0];
      const name = `${shell.name || shell.id}/${f.id}`;
      if (!oc.length) warnings.push(`Opening '${name}' is blocked or not resolved at h = ${h.toFixed(2)} mm`);
      const resolved = oc.length * h * h;
      openings.push({ name, cells: oc, kind: f.kind, normal: v3.norm(applyDir(it.m, nOut)), openAreaMm2: f.area, porosity: resolved > 0 ? Math.min(1, f.area / resolved) : 0, shellId: shell.id, featureId: f.id });
    }
  }
  return {
    grid: { ...g, cells, materials: ids },
    materials: mats,
    componentCells,
    openings,
    fans,
    warnings,
    inside,
  };
}
