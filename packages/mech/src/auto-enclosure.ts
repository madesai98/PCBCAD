/**
 * Automatic two-part injection-molded enclosure around one or more boards.
 *
 * Design rules applied (see README):
 *  - Boards sit on heat-set-insert (or thread-forming) bosses on the base floor under every mounting
 *    hole; boss height = bottomClearance (board bottom → inner floor); PCB screws from the top.
 *  - Inner pocket = board footprint + `clearance` (+ draft compensation) on every side; sides that
 *    carry edge connectors with ConnectorSpec.opening stay tight, the opposite pair of sides is
 *    extended to make room for the cover-to-base screw bosses in the corners (insert bosses on the
 *    base, counterbored through-floor clearance bosses on the cover, 0.2 mm gap between them).
 *  - Parting plane (split) at the centre height of the first edge connector, so connector cutouts
 *    are open notches in both halves (no side actions); otherwise 1 mm above the board.
 *  - Lip (0.4·wall × 1.5 mm) on the base rim, groove (+0.15 mm clearance) on the cover.
 *  - Vent slots: lower side walls (two opposite faces without connectors) and the top; slot 1.5 mm,
 *    web = wall.
 *  - Defaults: PC/ABS, injection molding, wall 2.0 mm, draft 1°, corner radius 2·wall.
 * Multiple boards: stacked on standoffs when every upper board's mounting holes coincide with holes
 * of the largest board (same footprint family), otherwise placed side by side along X.
 */
import type {
  AssemblyInstance,
  Board,
  ConnectorSpec,
  EnclosureShell,
  FastenerInstance,
  FastenerSpec,
  ManufacturingProcess,
  Project,
  ShellBoss,
  ShellCutout,
  ShellFace,
  Vec2,
  Vec3,
  VentPattern,
} from '@pcbcad/core';
import { getMaterial, newId } from '@pcbcad/core';
import { apply, applyDir } from './mat';
import { clearanceHole, insertTable, pilotHole } from './fastener';
import { polyBBox } from './poly';
import { counterboreFor } from './shell';
import { componentBodyBox, componentMatrix } from './world';

export interface AutoEnclosureOptions {
  /** Default 'pc-abs'. */
  materialId?: string;
  /** Default 'injection-molding'. */
  process?: ManufacturingProcess;
  /** Nominal wall (mm), default 2.0. */
  wall?: number;
  /** Board outline → inner wall (mm), default 1.0. */
  clearance?: number;
  /** Tallest top-side component → cover inner surface (mm), default 2.0. */
  topClearance?: number;
  /** Board bottom → base inner floor = standoff/boss height (mm); default from bottom components and screw engagement. */
  bottomClearance?: number;
  /** Outer vertical corner radius (mm), default 2·wall. */
  cornerRadius?: number;
  /** Parting plane height above the base's outer floor (mm) = base outer height. */
  split?: number;
  /** Vent faces: side faces (base lower walls), 'top' (cover floor), 'bottom'/'floor' (base floor). Default: two side faces + 'top'. [] = none. */
  ventFaces?: (ShellFace | 'top' | 'bottom')[];
  /** Board fixing: heat-set inserts (default) or thread-forming screws directly into bosses. */
  insert?: 'heat-set' | 'self-tapping';
  /** PartDef ids with FastenerSpecs. `screw` is used for PCB screws (and case screws unless `caseScrew`). */
  fastenerPartIds?: { screw?: string; caseScrew?: string; insert?: string; standoff?: string };
  /** Draft (deg), default 1. */
  draftDeg?: number;
  /** Force board arrangement for multiple boards. */
  arrangement?: 'auto' | 'side-by-side' | 'stack';
}

export interface AutoEnclosureResult {
  base: EnclosureShell;
  cover: EnclosureShell;
  instances: AssemblyInstance[];
  fasteners: FastenerInstance[];
  notes: string[];
}

const STD_SCREW = [3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35, 40, 45, 50];
const STD_STANDOFF = [5, 6, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40];
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const up1 = (v: number) => Math.ceil(v * 10 - 1e-6) / 10;
type Side = '+x' | '-x' | '+y' | '-y';
const SIDES: Side[] = ['+x', '-x', '+y', '-y'];

interface PlacedBoard {
  board: Board;
  /** Board-frame → group-frame translation (XY) and board-bottom z (base-local). */
  dx: number;
  dy: number;
  z: number;
  level: number;
  tb: number;
  hTop: number;
  hBottom: number;
}

function threadFromDrill(drill: number): number {
  if (drill >= 4.2) return 4;
  if (drill >= 3.1) return 3;
  if (drill >= 2.6) return 2.5;
  if (drill >= 2.1) return 2;
  return 3;
}

/** Component heights above/below the board (max top, max bottom). */
function boardHeights(project: Project, b: Board): { top: number; bottom: number } {
  let top = 0;
  let bottom = 0;
  for (const c of b.components ?? []) {
    if (c.dnp) continue;
    const box = componentBodyBox(project.parts?.[c.partId]);
    if (c.side === 'bottom') bottom = Math.max(bottom, box.max[2]);
    else top = Math.max(top, box.max[2]);
  }
  return { top, bottom };
}

interface EdgeConn {
  board: PlacedBoard;
  componentId: string;
  ref: string;
  spec: ConnectorSpec;
  side: Side;
  /** Opening centre in the group frame (x, y) and base-local z. */
  p: Vec3;
  /** Mating-direction extent of the body beyond the board bbox edge (mm, + = overhang). */
  overhang: number;
}

function sideOf(d: Vec3): Side {
  return Math.abs(d[0]) >= Math.abs(d[1]) ? (d[0] >= 0 ? '+x' : '-x') : d[1] >= 0 ? '+y' : '-y';
}

export function autoEnclosure(project: Project, boardIds: string[], opts: AutoEnclosureOptions = {}): AutoEnclosureResult {
  const notes: string[] = [];
  const boards = boardIds.map((id) => {
    const b = project.boards.find((x) => x.id === id);
    if (!b) throw new Error(`autoEnclosure: unknown board '${id}'`);
    if (!b.outline || b.outline.length < 3) throw new Error(`autoEnclosure: board '${b.name}' has no outline`);
    return b;
  });
  if (!boards.length) throw new Error('autoEnclosure: no boards given');
  const wall = opts.wall && opts.wall > 0 ? opts.wall : 2.0;
  const clearance = opts.clearance != null && opts.clearance >= 0 ? opts.clearance : 1.0;
  const topClear = opts.topClearance != null && opts.topClearance >= 0 ? opts.topClearance : 2.0;
  const materialId = opts.materialId ?? 'pc-abs';
  const process = opts.process ?? 'injection-molding';
  const draftDeg = opts.draftDeg ?? 1.0;
  const slope = Math.tan((draftDeg * Math.PI) / 180);
  const cornerRadius = opts.cornerRadius ?? 2 * wall;
  const insertMode = opts.insert ?? 'heat-set';
  const ids = opts.fastenerPartIds ?? {};
  const spec = (id?: string): FastenerSpec | undefined => (id ? project.parts?.[id]?.fastener : undefined);
  const screwSpec = spec(ids.screw);
  const caseScrewSpec = spec(ids.caseScrew) ?? screwSpec;
  const insertSpec = spec(ids.insert);
  for (const [k, id] of Object.entries(ids)) if (id && !spec(id)) notes.push(`fastenerPartIds.${k} '${id}' has no FastenerSpec in project.parts — sizes use defaults`);

  // ---------------------------------------------------------------- fastener sizing
  const allHoles = boards.flatMap((b) => b.holes ?? []);
  const d = screwSpec?.diameter ?? (allHoles.length ? threadFromDrill(Math.min(...allHoles.map((h) => h.drill))) : 3);
  const dCase = caseScrewSpec?.diameter ?? d;
  const ins = insertSpec ? { od: insertSpec.outerDiameter ?? insertTable(d).od, hole: insertSpec.holeDiameter ?? insertTable(d).hole, length: insertSpec.length ?? insertTable(d).length } : insertTable(d);
  const insCase = dCase === d ? ins : insertTable(dCase);
  const bossFor = (dd: number, it: { od: number; hole: number }) =>
    insertMode === 'heat-set' ? { hole: it.hole, od: r1(Math.max(2.2 * it.hole, it.od + 3.0)) } : { hole: pilotHole(dd), od: r1(Math.max(2.5 * pilotHole(dd), 2 * dd)) };
  const pcbBoss = bossFor(d, ins);
  const caseBossBase = bossFor(dCase, insCase);
  const caseClear = caseScrewSpec?.holeDiameter ?? clearanceHole(dCase);
  const cb = counterboreFor(caseClear, caseScrewSpec);
  const coverBossOD = r1(Math.max(cb.d + 2.4, caseBossBase.od));
  const Rcase = Math.max(caseBossBase.od, coverBossOD) / 2;
  const gWall = Math.max(1.0, 0.5 * wall);
  const engageMin = 1.5 * d;

  // ---------------------------------------------------------------- board arrangement
  const info = boards.map((b) => {
    const bb = polyBBox(b.outline);
    const hh = boardHeights(project, b);
    return { b, bb, tb: b.stackup?.thickness ?? 1.6, ...hh };
  });
  const sorted = [...info].sort((a, b) => (b.bb.maxX - b.bb.minX) * (b.bb.maxY - b.bb.minY) - (a.bb.maxX - a.bb.minX) * (a.bb.maxY - a.bb.minY));
  const ref = sorted[0];
  const holesRel = (x: (typeof info)[number]) => (x.b.holes ?? []).map((h) => [h.x - x.bb.minX, h.y - x.bb.minY] as Vec2);
  const refHoles = holesRel(ref);
  const canStack =
    sorted.length > 1 &&
    sorted.slice(1).every((x) => {
      const hs = holesRel(x);
      return hs.length >= 2 && hs.every((p) => refHoles.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= 0.3)) && x.bb.maxX - x.bb.minX <= ref.bb.maxX - ref.bb.minX + 0.5 && x.bb.maxY - x.bb.minY <= ref.bb.maxY - ref.bb.minY + 0.5;
    });
  const arrangement = opts.arrangement === 'stack' ? 'stack' : opts.arrangement === 'side-by-side' || !canStack ? 'side-by-side' : 'stack';
  if (opts.arrangement === 'stack' && !canStack) notes.push('Stacking requested but the boards’ mounting holes do not line up — stacking anyway on the largest board’s hole pattern; check standoff positions');
  const placedBoards: PlacedBoard[] = [];
  if (arrangement === 'stack') {
    sorted.forEach((x, i) => placedBoards.push({ board: x.b, dx: -x.bb.minX, dy: -x.bb.minY, z: 0, level: i, tb: x.tb, hTop: x.top, hBottom: x.bottom }));
    notes.push(`Boards stacked (${sorted.map((x) => x.b.name).join(' → ')}) on standoffs at the common mounting holes`);
  } else {
    let x0 = 0;
    const gap = Math.max(2 * clearance, 4);
    const maxDepth = Math.max(...info.map((x) => x.bb.maxY - x.bb.minY));
    for (const x of info) {
      const depth = x.bb.maxY - x.bb.minY;
      placedBoards.push({ board: x.b, dx: x0 - x.bb.minX, dy: (maxDepth - depth) / 2 - x.bb.minY, z: 0, level: 0, tb: x.tb, hTop: x.top, hBottom: x.bottom });
      x0 += x.bb.maxX - x.bb.minX + gap;
    }
    if (info.length > 1) notes.push(`Boards placed side by side along X (${info.map((x) => x.b.name).join(', ')}), ${gap} mm apart`);
  }

  // ---------------------------------------------------------------- heights
  const level0 = placedBoards.filter((p) => p.level === 0);
  const tb0 = Math.max(...level0.map((p) => p.tb));
  const hBottom = Math.max(0, ...level0.map((p) => p.hBottom));
  const pcbScrewLen = (bc: number) => {
    const maxLen = tb0 + bc - 0.5;
    const ok = STD_SCREW.filter((L) => L - tb0 >= engageMin && L <= maxLen);
    return ok.length ? ok[0] : undefined;
  };
  let bottomClear = opts.bottomClearance;
  if (bottomClear == null) {
    const minBoss = Math.max(hBottom + 1.5, insertMode === 'heat-set' ? ins.length + 0.5 : 0, 3);
    const Lneed = STD_SCREW.find((L) => L - tb0 >= engageMin)!;
    bottomClear = Math.ceil(Math.max(minBoss, Lneed - tb0 + 0.5) * 2) / 2;
  }
  if (bottomClear < hBottom + 0.5) notes.push(`bottomClearance ${bottomClear} mm leaves < 0.5 mm under the tallest bottom-side component (${r1(hBottom)} mm)`);
  const zb = wall + bottomClear;
  // stacked levels
  let zLevel = zb;
  const levels = [...new Set(placedBoards.map((p) => p.level))].sort((a, b) => a - b);
  const standoffs: { lower: PlacedBoard; upper: PlacedBoard; length: number }[] = [];
  for (const lv of levels) {
    const here = placedBoards.filter((p) => p.level === lv);
    if (lv > 0) {
      const below = placedBoards.filter((p) => p.level === lv - 1);
      const need = Math.max(...below.map((p) => p.hTop), ...here.map((p) => p.hBottom)) + 2;
      const len = STD_STANDOFF.find((L) => L >= need) ?? Math.ceil(need);
      zLevel = Math.max(...below.map((p) => p.z + p.tb)) + len;
      for (const u of here) standoffs.push({ lower: below[0], upper: u, length: len });
    }
    for (const p of here) p.z = zLevel;
  }
  const topMost = Math.max(...placedBoards.map((p) => p.z + p.tb + p.hTop));
  // connector openings (centre height above the board surface) need ≥ 1 wall of bridge below the top
  let openTop = 0;
  for (const p of placedBoards)
    for (const c of p.board.components ?? []) {
      const sp = project.parts?.[c.partId]?.connector;
      if (c.dnp || !sp?.opening || !sp.matingDirection || sp.matingDirection === '+z' || c.side === 'bottom') continue;
      openTop = Math.max(openTop, p.z + p.tb + sp.opening.zCenter + (sp.opening.height + 0.5) / 2 + wall);
    }
  const ceiling = Math.max(topMost + topClear, openTop);
  const Htot = up1(ceiling + wall);

  // ---------------------------------------------------------------- footprint & connectors
  let K = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = (x: number, y: number) => {
    K = { x0: Math.min(K.x0, x), y0: Math.min(K.y0, y), x1: Math.max(K.x1, x), y1: Math.max(K.y1, y) };
  };
  for (const p of placedBoards) for (const q of p.board.outline) grow(q[0] + p.dx, q[1] + p.dy);
  const conns: EdgeConn[] = [];
  for (const p of placedBoards) {
    for (const c of p.board.components ?? []) {
      if (c.dnp) continue;
      const part = project.parts?.[c.partId];
      const box = componentBodyBox(part);
      const cm = componentMatrix(c, p.tb);
      const corners: Vec3[] = [];
      for (let k = 0; k < 8; k++) corners.push(apply(cm, [k & 1 ? box.max[0] : box.min[0], k & 2 ? box.max[1] : box.min[1], k & 4 ? box.max[2] : box.min[2]]));
      const spec = part?.connector;
      if (spec?.opening && spec.matingDirection && spec.matingDirection !== '+z') {
        const md: Vec3 = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0] }[spec.matingDirection] as Vec3;
        const dir = applyDir(cm, md);
        const side = sideOf(dir);
        if (Math.abs(Math.abs(dir[0]) - Math.abs(dir[1])) < 0.2) notes.push(`${c.ref}: mating direction is not aligned with an enclosure wall (rotation ${c.rotation}°) — using face ${side}`);
        const oc = apply(cm, [0, 0, spec.opening.zCenter]);
        const reach = Math.max(...corners.map((q) => (side === '+x' ? q[0] : side === '-x' ? -q[0] : side === '+y' ? q[1] : -q[1])));
        const bbEdge = side === '+x' ? p.board.outline.reduce((m, q) => Math.max(m, q[0]), -Infinity) : side === '-x' ? -p.board.outline.reduce((m, q) => Math.min(m, q[0]), Infinity) : side === '+y' ? p.board.outline.reduce((m, q) => Math.max(m, q[1]), -Infinity) : -p.board.outline.reduce((m, q) => Math.min(m, q[1]), Infinity);
        conns.push({ board: p, componentId: c.id, ref: c.ref, spec, side, p: [oc[0] + p.dx, oc[1] + p.dy, p.z + oc[2]], overhang: reach - bbEdge });
        // the body part inside the board outline still counts for the keep-in box
        for (const q of corners) {
          const along = side === '+x' ? q[0] : side === '-x' ? -q[0] : side === '+y' ? q[1] : -q[1];
          if (along <= bbEdge) grow(q[0] + p.dx, q[1] + p.dy);
        }
        continue;
      }
      for (const q of corners) grow(q[0] + p.dx, q[1] + p.dy);
    }
  }
  const tight = new Set<Side>(conns.map((c) => c.side));
  // corner case-screw bosses: extend one opposite pair of sides (vertex cover avoiding tight sides)
  const ext = clearance + 2 * Rcase + gWall;
  const kw = K.x1 - K.x0;
  const kd = K.y1 - K.y0;
  const options: { sides: Side[]; area: number }[] = [];
  if (!tight.has('+x') && !tight.has('-x')) options.push({ sides: ['+x', '-x'], area: (kw + 2 * ext) * (kd + 2 * clearance) });
  if (!tight.has('+y') && !tight.has('-y')) options.push({ sides: ['+y', '-y'], area: (kw + 2 * clearance) * (kd + 2 * ext) });
  let extSides: Side[];
  let caseCorners: [number, number][];
  if (options.length) {
    options.sort((a, b) => a.area - b.area);
    extSides = options[0].sides;
    caseCorners = [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ];
  } else {
    extSides = SIDES.filter((s) => !tight.has(s));
    caseCorners = (
      [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ] as [number, number][]
    ).filter(([sx, sy]) => extSides.includes(sx > 0 ? '+x' : '-x') || extSides.includes(sy > 0 ? '+y' : '-y'));
    notes.push(`Edge connectors on ${[...tight].join(', ')} leave room for only ${caseCorners.length} corner case screw(s)`);
  }
  const drafted = slope * Math.max(Htot, 10);
  // PCB bosses must stay ≥ gWall from the walls (no boss/wall merge): gap ≥ R + gWall − hole-to-edge distance
  const holeDist: Record<Side, number> = { '+x': Infinity, '-x': Infinity, '+y': Infinity, '-y': Infinity };
  for (const p of level0)
    for (const h of p.board.holes ?? []) {
      const x = h.x + p.dx;
      const y = h.y + p.dy;
      holeDist['+x'] = Math.min(holeDist['+x'], K.x1 - x);
      holeDist['-x'] = Math.min(holeDist['-x'], x - K.x0);
      holeDist['+y'] = Math.min(holeDist['+y'], K.y1 - y);
      holeDist['-y'] = Math.min(holeDist['-y'], y - K.y0);
    }
  // Connector sides: put the inner wall at the receptacle face (flush) so plugs can mate, but keep
  // ≥ 0.6 mm board clearance; there the connector wins over the boss-to-wall gap.
  const gapOf = (s: Side) => {
    if (tight.has(s)) {
      const ov = Math.min(...conns.filter((c) => c.side === s).map((c) => c.overhang));
      return Math.max(0.6 + drafted, Math.min(clearance + drafted, ov));
    }
    return Math.max(clearance, pcbBoss.od / 2 + gWall - holeDist[s]) + drafted + (extSides.includes(s) ? 2 * Rcase + gWall : 0);
  };
  for (const s of SIDES) {
    const need = pcbBoss.od / 2 + gWall - holeDist[s] + drafted;
    if (need > gapOf(s) + 1e-6 && tight.has(s))
      notes.push(`Mounting holes ${r1(holeDist[s])} mm from the ${s} board edge: their bosses touch the ${s} wall (kept tight for the edge connector) — DFM will flag boss/wall merge; move holes ≥ ${r1(pcbBoss.od / 2 + gWall)} mm from that edge to avoid it`);
    else if (need > clearance + drafted + 1e-6 && !tight.has(s))
      notes.push(`Mounting holes ${r1(holeDist[s])} mm from the ${s} board edge: ${s} wall${extSides.includes(s) ? ' and case bosses' : ''} moved out so the Ø${pcbBoss.od} bosses keep ≥ ${gWall} mm clearance`);
  }
  const px0 = K.x0 - gapOf('-x');
  const px1 = K.x1 + gapOf('+x');
  const py0 = K.y0 - gapOf('-y');
  const py1 = K.y1 + gapOf('+y');
  const W = up1(px1 - px0 + 2 * wall);
  const D = up1(py1 - py0 + 2 * wall);
  const cx = (px0 + px1) / 2;
  const cy = (py0 + py1) / 2;
  const hx = W / 2 - wall;
  const hy = D / 2 - wall;
  // group → base-local
  const toBase = (x: number, y: number): Vec2 => [x - cx, y - cy];

  // split height
  const firstTop = conns.find((c) => c.p[2] >= zb);
  let Hb = opts.split ?? (conns.length ? (firstTop ?? conns[0]).p[2] : zb + tb0 + 1.0);
  const HbMin = wall + 3;
  const HbMax = Htot - wall - 3;
  if (Hb < HbMin || Hb > HbMax) {
    notes.push(`Split ${r1(Hb)} mm clamped to [${r1(HbMin)}, ${r1(HbMax)}] mm`);
    Hb = Math.min(Math.max(Hb, HbMin), HbMax);
  }
  Hb = r1(Hb);
  const Hc = r1(Htot - Hb);

  // ---------------------------------------------------------------- shells
  const baseId = newId('mech');
  const coverId = newId('mech');
  // lip/groove must leave ≥ minWall beside the groove (groove = lip + 0.15 mm)
  const minWall = getMaterial(materialId)?.molding?.minWall ?? 1.0;
  const lipT = r1(Math.min(Math.max(0.6, 0.4 * wall), wall - minWall - 0.15));
  const useLip = lipT >= 0.6 - 1e-9;
  if (!useLip) notes.push(`Wall ${wall} mm is too thin for a lip/groove (needs ≥ ${r1(minWall + 0.75)} mm); halves butt-join — consider wall ≥ ${r1(minWall + 1)} mm`);
  const base: EnclosureShell = {
    id: baseId,
    name: 'Enclosure base',
    kind: 'enclosure-shell',
    role: 'base',
    materialId,
    process,
    processOptions: { innerFillet: r1(0.5 * wall), gate: 'center' },
    outer: { width: W, depth: D, height: Hb },
    wall,
    cornerRadius,
    draftDeg,
    ...(useLip ? { lip: { kind: 'lip' as const, height: 1.5, thickness: lipT } } : {}),
    bosses: [],
    ribs: [],
    cutouts: [],
    vents: [],
    snaps: [],
    matesWith: coverId,
  };
  const cover: EnclosureShell = {
    ...base,
    id: coverId,
    name: 'Enclosure cover',
    role: 'cover',
    processOptions: { ...base.processOptions },
    outer: { width: W, depth: D, height: Hc },
    ...(useLip ? { lip: { kind: 'groove' as const, height: 1.65, thickness: r1(lipT + 0.15) } } : { lip: undefined }),
    bosses: [],
    cutouts: [],
    vents: [],
    snaps: [],
    ribs: [],
    matesWith: baseId,
  };
  const toCover = (x: number, y: number): Vec2 => [x, -y];
  const zToCover = (z: number) => Hb + Hc - z;
  const coverFace = (f: ShellFace): ShellFace => (f === '+y' ? '-y' : f === '-y' ? '+y' : f);

  // PCB bosses (level 0 boards)
  const baseInstId = newId('inst');
  const coverInstId = newId('inst');
  const fasteners: FastenerInstance[] = [];
  const pcbLen = pcbScrewLen(bottomClear) ?? STD_SCREW.find((L) => L - tb0 >= engageMin)!;
  if (!pcbScrewLen(bottomClear)) notes.push(`PCB screws: no standard length gives ≥ ${r1(engageMin)} mm engagement within a ${bottomClear} mm boss — increase bottomClearance`);
  const boardInst = new Map<string, string>();
  for (const p of placedBoards) boardInst.set(p.board.id, newId('inst'));
  let nb = 0;
  let nPcb = 0;
  for (const p of level0) {
    for (const h of p.board.holes ?? []) {
      const [x, y] = toBase(h.x + p.dx, h.y + p.dy);
      nb++;
      const fid = insertMode === 'heat-set' ? ids.insert : ids.screw;
      const boss: ShellBoss = {
        id: `pcb${nb}`,
        x,
        y,
        outerDiameter: pcbBoss.od,
        holeDiameter: pcbBoss.hole,
        height: bottomClear,
        kind: insertMode === 'heat-set' ? 'insert' : 'screw',
        gussets: bottomClear > 2.5 * pcbBoss.od ? 3 : 0,
        ...(fid ? { fastenerPartId: fid } : {}),
      };
      base.bosses.push(boss);
      const top: Vec3 = [x, y, zb];
      const stacked = standoffs.some((s) => s.lower === p);
      if (insertMode === 'heat-set')
        fasteners.push({ id: newId('fst'), partId: ids.insert ?? '', position: [x, y, zb - ins.length / 2], direction: [0, 0, -1], joins: [baseInstId], note: `M${d} heat-set insert Ø${ins.od} × ${ins.length} in boss ${boss.id}` });
      if (!stacked) {
        nPcb++;
        const screwOk = screwSpec?.length == null || (screwSpec.length - p.tb >= engageMin && screwSpec.length <= p.tb + bottomClear - 0.5);
        fasteners.push({
          id: newId('fst'),
          partId: ids.screw && screwOk ? ids.screw : '',
          position: [top[0], top[1], zb + p.tb],
          direction: [0, 0, -1],
          joins: [boardInst.get(p.board.id)!, baseInstId],
          note: `M${d} × ${pcbLen} pan-head screw: board '${p.board.name}' hole ${h.id} → ${insertMode === 'heat-set' ? 'insert' : 'boss'}`,
        });
      }
    }
  }
  // stacked boards: male-female standoffs into the inserts, screws on top
  for (const s of standoffs) {
    for (const h of s.upper.board.holes ?? []) {
      const [x, y] = toBase(h.x + s.upper.dx, h.y + s.upper.dy);
      const zLowTop = s.lower.z + s.lower.tb;
      fasteners.push({ id: newId('fst'), partId: ids.standoff ?? '', position: [x, y, zLowTop + s.length / 2], direction: [0, 0, -1], joins: [boardInst.get(s.lower.board.id)!, boardInst.get(s.upper.board.id)!, baseInstId], note: `M${d} hex standoff, male-female, ${s.length} mm (male end through '${s.lower.board.name}' into the insert)` });
      fasteners.push({ id: newId('fst'), partId: '', position: [x, y, s.upper.z + s.upper.tb], direction: [0, 0, -1], joins: [boardInst.get(s.upper.board.id)!], note: `M${d} × 6 pan-head screw into the standoff` });
    }
  }
  if (!level0.some((p) => (p.board.holes ?? []).length)) notes.push('Boards have no mounting holes — add holes (or ribs/clips to retain the board); no PCB bosses were created');

  // case screw bosses
  const cbDepth = Math.min(cb.depth, Hc - 1.2); // same clamp as bossGeom (z1 − 1)
  const caseEntry = Hc - cbDepth; // bearing (counterbore floor) → base boss top
  const caseHoleDepth = Hb - wall;
  const caseLen = STD_SCREW.find((L) => L - caseEntry >= 1.5 * dCase && L - caseEntry <= caseHoleDepth - 0.3);
  if (!caseLen) notes.push(`Case screws: no standard length engages ≥ ${r1(1.5 * dCase)} mm without bottoming in the ${r1(caseHoleDepth)} mm base boss — adjust split/height`);
  const caseL = caseLen ?? STD_SCREW.find((L) => L - caseEntry >= 1.5 * dCase) ?? 20;
  caseCorners.forEach(([sx, sy], i) => {
    const x = sx * (hx - gWall - Rcase);
    const y = sy * (hy - gWall - Rcase);
    base.bosses.push({ id: `case${i + 1}`, x, y, outerDiameter: caseBossBase.od, holeDiameter: caseBossBase.hole, height: r1(Hb - wall), kind: insertMode === 'heat-set' ? 'insert' : 'screw', gussets: 4, ...(insertMode === 'heat-set' && ids.insert ? { fastenerPartId: ids.insert } : {}) });
    const [ux, uy] = toCover(x, y);
    cover.bosses.push({ id: `case${i + 1}`, x: ux, y: uy, outerDiameter: coverBossOD, holeDiameter: caseClear, height: r1(Hc - wall - 0.2), kind: 'clearance', throughFloor: true, gussets: 4, ...(ids.caseScrew ?? ids.screw ? { fastenerPartId: ids.caseScrew ?? ids.screw } : {}) });
    if (insertMode === 'heat-set')
      fasteners.push({ id: newId('fst'), partId: ids.insert ?? '', position: [x, y, Hb - insCase.length / 2], direction: [0, 0, -1], joins: [baseInstId], note: `M${dCase} heat-set insert in case boss case${i + 1}` });
    const caseSpecOk = caseScrewSpec?.length == null || (caseScrewSpec.length - caseEntry >= 1.5 * dCase && caseScrewSpec.length - caseEntry <= caseHoleDepth - 0.3);
    const caseId = ids.caseScrew ?? ids.screw;
    fasteners.push({ id: newId('fst'), partId: caseId && caseSpecOk ? caseId : '', position: [x, y, Hb + Hc - cbDepth], direction: [0, 0, -1], joins: [coverInstId, baseInstId], note: `M${dCase} × ${caseL} pan-head case screw (counterbore Ø${r2(cb.d)} × ${r2(cbDepth)})` });
  });

  // connector cutouts
  const notchedSplit: string[] = [];
  conns.forEach((c, i) => {
    const w = r1(c.spec.opening!.width + 0.5);
    const h = r1(c.spec.opening!.height + 0.5);
    const [bx, by] = toBase(c.p[0], c.p[1]);
    const face: ShellFace = c.side;
    const u = face === '+x' || face === '-x' ? by : bx;
    const z = c.p[2];
    const shape: ShellCutout['shape'] = 'rounded-rect';
    const radius = r1(Math.min(1.0, h / 2 - 0.05));
    const linked = { boardId: c.board.board.id, componentId: c.componentId };
    const inBase = z - h / 2 < Hb;
    const inCover = z + h / 2 > Hb;
    if (inBase) base.cutouts.push({ id: `conn${i + 1}`, face, shape, u: r2(u), v: r2(z), width: w, height: h, radius, purpose: 'connector', linked });
    if (inCover) {
      const [cxu, cyu] = toCover(bx, by);
      const cf = coverFace(face);
      cover.cutouts.push({ id: `conn${i + 1}`, face: cf, shape, u: r2(cf === '+x' || cf === '-x' ? cyu : cxu), v: r2(zToCover(z)), width: w, height: h, radius, purpose: 'connector', linked });
    }
    if (inBase && inCover) notchedSplit.push(c.ref);
    else notes.push(`${c.ref}: cutout is a closed window in the ${inBase ? 'base' : 'cover'} side wall (needs a slide); set split ≈ ${r1(z)} mm to make it an open notch`);
    const recess = gapOf(c.side) - c.overhang;
    if (recess > 1) notes.push(`${c.ref} mating face is ${r1(recess)} mm inside the inner wall (${r1(recess + wall)} mm from the outside) — move it to the board edge so the plug reaches`);
    else notes.push(`${c.ref}: mating face ${r1(Math.max(0, recess) + wall)} mm behind the outer surface; a ${wall} mm wall at the opening suits plugs with ≥ ${r1(wall + 6.5)} mm exposed shell — thin the wall locally (outside spot-face) for short plugs`);
  });
  for (const shell of [base, cover]) {
    const merged: ShellCutout[] = [];
    for (const c of shell.cutouts) {
      const near = merged.find((m) => m.face === c.face && c.u - c.width / 2 < m.u + m.width / 2 + wall && c.u + c.width / 2 > m.u - m.width / 2 - wall && Math.abs(c.v - m.v) < (c.height + m.height) / 2 + wall);
      if (!near) {
        merged.push({ ...c });
        continue;
      }
      const u0 = Math.min(near.u - near.width / 2, c.u - c.width / 2), u1 = Math.max(near.u + near.width / 2, c.u + c.width / 2);
      const v0 = Math.min(near.v - near.height / 2, c.v - c.height / 2), v1 = Math.max(near.v + near.height / 2, c.v + c.height / 2);
      Object.assign(near, { u: r2((u0 + u1) / 2), v: r2((v0 + v1) / 2), width: r2(u1 - u0), height: r2(v1 - v0) });
      delete near.linked; // shared opening (checkAssembly verifies it clears every connector)
      notes.push(`${shell.name}: connector openings ${near.id} and ${c.id} merged into one ${r1(near.width)} × ${r1(near.height)} mm cutout (too close for separate openings)`);
    }
    shell.cutouts = merged;
  }
  if (notchedSplit.length) notes.push(`Connector cutouts ${notchedSplit.join(', ')} straddle the parting plane (open notches in both halves, no side actions)`);

  // vents
  const faceHasConn = (f: Side) => tight.has(f);
  let ventFaces = opts.ventFaces;
  if (!ventFaces) {
    const pairs: Side[][] = W >= D ? [['+y', '-y'], ['+x', '-x']] : [['+x', '-x'], ['+y', '-y']];
    const pair = pairs.find((p) => !p.some(faceHasConn)) ?? [SIDES.find((s) => !faceHasConn(s))].filter(Boolean);
    ventFaces = [...(pair as Side[]), 'top'];
  }
  const slotW = 1.5;
  const sideVents: string[] = [];
  const pitch = r1(slotW + Math.max(wall, 1.0));
  for (const vf of ventFaces) {
    if (vf === 'top' || vf === 'bottom' || vf === 'floor') {
      const target = vf === 'top' ? cover : base;
      const len = r1(Math.min(0.5 * W, 40));
      const count = Math.max(2, Math.min(10, Math.floor((0.45 * D) / pitch)));
      const [gx, gy] = toBase((K.x0 + K.x1) / 2, (K.y0 + K.y1) / 2);
      const [vx, vy] = vf === 'top' ? toCover(gx, gy) : [gx, gy];
      const vent: VentPattern = { id: `vent-${vf}`, face: 'floor', u: r1(vx), v: r1(vy), slotWidth: slotW, slotLength: len, count, pitch, orientation: 'u' };
      // keep clear of bosses
      const bosses = target.bosses;
      const span = ((count - 1) * pitch + slotW) / 2;
      const hit = bosses.some((b) => Math.abs(b.x - vent.u) < len / 2 + b.outerDiameter / 2 + wall && Math.abs(b.y - vent.v) < span + b.outerDiameter / 2 + wall);
      if (hit) {
        notes.push(`${vf} vents skipped: they would cut through bosses`);
        continue;
      }
      target.vents.push(vent);
      continue;
    }
    const side = vf as Side;
    if (faceHasConn(side)) notes.push(`Vents on ${side} share the wall with connector cutouts`);
    const halfU = side === '+x' || side === '-x' ? D / 2 : W / 2;
    const uLim = halfU - Math.max(cornerRadius, wall) - wall - (extSides.includes(side) ? 0 : Rcase * 2 + gWall);
    // base lower wall if tall enough, else the cover
    const v0 = 2 * wall + 0.2;
    const v1b = Hb - wall - 0.5;
    const useBase = v1b - v0 >= 4;
    const target = useBase ? base : cover;
    const vv0 = useBase ? v0 : Math.max(v0, Hc - wall - 0.5 - 10);
    const vv1 = useBase ? Math.min(v1b, v0 + 10) : Hc - wall - 0.5;
    if (vv1 - vv0 < 3 || uLim < 4) {
      notes.push(`No room for vents on ${side}`);
      continue;
    }
    const count = Math.max(2, Math.min(12, Math.floor((2 * uLim - slotW) / pitch) + 1));
    target.vents.push({ id: `vent${side}`, face: useBase ? side : coverFace(side), u: 0, v: r1((vv0 + vv1) / 2), slotWidth: slotW, slotLength: r1(vv1 - vv0), count, pitch, orientation: 'v' });
    sideVents.push(`${side} (${useBase ? 'base' : 'cover'})`);
  }

  // ---------------------------------------------------------------- instances
  const instances: AssemblyInstance[] = [
    { id: baseInstId, name: 'Enclosure base', target: { kind: 'mech', partId: baseId }, transform: { position: [0, 0, 0], rotation: [0, 0, 0] } },
    { id: coverInstId, name: 'Enclosure cover', target: { kind: 'mech', partId: coverId }, transform: { position: [0, 0, r1(Hb + Hc)], rotation: [180, 0, 0] }, explode: [0, 0, Math.max(20, Hc)] },
  ];
  for (const p of placedBoards) {
    const [x, y] = toBase(p.dx, p.dy);
    instances.push({ id: boardInst.get(p.board.id)!, name: p.board.name, target: { kind: 'board', boardId: p.board.id }, transform: { position: [x, y, p.z], rotation: [0, 0, 0] } });
  }

  // ---------------------------------------------------------------- notes / BOM
  notes.unshift(
    `Enclosure ${W} × ${D} × ${r1(Hb + Hc)} mm outside (${materialId}, ${process}, wall ${wall} mm, draft ${draftDeg}°, corner R${cornerRadius}); split at ${Hb} mm (base ${Hb} mm + cover ${Hc} mm)`,
    `Board(s) on ${level0.reduce((n, p) => n + (p.board.holes?.length ?? 0), 0)} ${insertMode === 'heat-set' ? 'heat-set insert' : 'thread-forming'} bosses Ø${pcbBoss.od}/Ø${pcbBoss.hole} × ${bottomClear} mm; ${clearance} mm edge clearance, ${topClear} mm above the tallest component`,
    `Fasteners: ${nPcb} × M${d}×${pcbLen} PCB screws, ${caseCorners.length} × M${dCase}×${caseL} case screws (cover counterbore Ø${r2(cb.d)} × ${r2(cbDepth)}), ${insertMode === 'heat-set' ? `${fasteners.filter((f) => f.note?.includes('insert')).length} × M${d} heat-set inserts (Ø${ins.od} × ${ins.length})` : 'no inserts'}`,
  );
  if (sideVents.length) notes.push(`Side-wall vents on ${sideVents.join(', ')} are closed slots → one slide per face in the mold (≈ $1.5k–5k each); pass ventFaces: ['top', 'bottom'] to avoid side actions`);
  if (fasteners.some((f) => !f.partId)) notes.push('Some fastener instances have partId \'\' — pass fastenerPartIds (screw/caseScrew/insert/standoff PartDefs with FastenerSpec) to resolve them');
  if (Hb < zb + tb0) notes.push('The parting plane is below the board top surface — the board sits partly in the cover');
  return { base, cover, instances, fasteners, notes };
}
