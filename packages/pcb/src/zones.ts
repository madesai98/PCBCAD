/**
 * Copper pour engine (clipper-lib).
 *
 * For every zone, highest priority first:
 *   fill = (zone outline ∩ board outline inset by edgeClearance, minus cutouts)
 *          − other-net copper on the layer inflated by max(zone.clearance, rules.clearance)
 *            (pads, traces, vias, plated holes, NPTH holes, already-filled higher-priority zones)
 *          − same-net pads inflated by the same gap when `thermalRelief` is true
 *   fill = open(fill, minWidth)                      (erode by w/2, dilate by w/2)
 *   fill ∪= thermal spokes (4 per pad, width max(0.3, net trace width)) that reach the fill
 *   drop islands that touch no same-net pad, via or trace.
 * Result rings are stored in zone.fill: outer rings CCW, holes CW (even-odd semantics).
 */
import { rotate2, type Board, type PartDef, type Vec2, type Zone } from '@pcbcad/core';
import { ARC_TOL, areaOf, ccw, difference, fromIPath, intersection, islands, offsetPaths, primPaths, toIPath, union, type IPath, type IPaths } from './clip';
import { bbInflate, makePrim, type Prim } from './geom';
import { collectPads, holeCopperPrim, layerBit, netTraceWidth, stackLayers, tracePrims, viaMask, type PadInfo } from './model';
import { Region } from './region';
import { GridIndex } from './spatial';

/**
 * Fill all copper zones of a board. Returns a new board (input is not mutated) whose zones carry
 * `fill` rings. Zones on layers missing from the stackup get an empty fill.
 */
export function fillZones(board: Board, parts: Record<string, PartDef>): Board {
  const out = structuredClone(board);
  fillZonesInPlace(out, parts);
  return out;
}

/** Board area available to copper: outline inset by edgeClearance minus inflated cutouts. */
export function boardCopperArea(board: Board): IPaths {
  if (!board.outline || board.outline.length < 3) return [];
  const ec = Math.max(0, board.rules.edgeClearance);
  let area = offsetPaths([ccw(toIPath(board.outline))], -(ec + ARC_TOL));
  const cut = (board.cutouts ?? []).filter((c) => c.length >= 3).map((c) => ccw(toIPath(c)));
  if (cut.length) area = difference(area, offsetPaths(cut, ec));
  return area;
}

/** Fill zones in place (optionally only the zones whose ids are listed). */
export function fillZonesInPlace(board: Board, parts: Record<string, PartDef>, only?: Set<string>): void {
  const zones = board.zones ?? [];
  if (!zones.length) return;
  const stack = stackLayers(board);
  const rules = board.rules;
  const pads = collectPads(board, parts, stack).filter((p) => p.placed);
  const area = boardCopperArea(board);
  const order = zones.map((z, i) => ({ z, i })).sort((a, b) => (b.z.priority ?? 0) - (a.z.priority ?? 0) || a.i - b.i);
  const done: { z: Zone; paths: IPaths }[] = [];
  for (const { z } of order) {
    if (only && !only.has(z.id)) {
      if (z.fill?.length) done.push({ z, paths: z.fill.map((r) => toIPath(r)) });
      continue;
    }
    const bit = layerBit(stack, z.layer);
    if (!bit || !area.length) {
      z.fill = [];
      continue;
    }
    const paths = fillOne(board, z, bit, pads, area, done, stack, rules.minTraceWidth);
    z.fill = paths.map((p) => fromIPath(p));
    done.push({ z, paths });
  }
}

function fillOne(
  board: Board,
  z: Zone,
  bit: number,
  pads: PadInfo[],
  area: IPaths,
  done: { z: Zone; paths: IPaths }[],
  stack: ReturnType<typeof stackLayers>,
  defaultMinWidth: number,
): IPaths {
  const rules = board.rules;
  const net = z.netId ?? '';
  const clr = Math.max(z.clearance ?? 0, rules.clearance);
  let base = area;
  if (z.outline && z.outline.length >= 3) base = intersection([ccw(toIPath(z.outline))], area);
  if (!base.length) return [];

  const obstacles: IPaths = [];
  const samePads: PadInfo[] = [];
  const sameCopper: Prim[] = [];
  for (const p of pads) {
    if (p.prim && p.layers & bit) {
      if (net && p.netId === net) {
        samePads.push(p);
        sameCopper.push(p.prim);
      } else obstacles.push(...primPaths(p.prim, clr));
    } else if (!p.prim && p.hole) obstacles.push(...primPaths(p.hole, clr));
  }
  for (const t of board.traces ?? []) {
    if (layerBit(stack, t.layer) !== bit) continue;
    const prims = tracePrims(t);
    if (net && t.netId === net) sameCopper.push(...prims);
    else for (const pr of prims) obstacles.push(...primPaths(pr, clr));
  }
  for (const v of board.vias ?? []) {
    if (!(viaMask(stack, v) & bit)) continue;
    const pr = makePrim([[v.x, v.y]], Math.max(v.diameter, v.drill) / 2);
    if (net && v.netId === net) sameCopper.push(pr);
    else obstacles.push(...primPaths(pr, clr));
  }
  for (const h of board.holes ?? []) {
    const cu = holeCopperPrim(h);
    if (cu && net && h.netId === net) sameCopper.push(cu);
    else obstacles.push(...primPaths(cu ?? makePrim([[h.x, h.y]], h.drill / 2), clr));
  }
  for (const d of done) {
    if (d.z.layer !== z.layer || (net && d.z.netId === net) || !d.paths.length) continue;
    obstacles.push(...offsetPaths(d.paths, clr));
  }
  const obstacleUnion = union(obstacles);
  let fill = difference(base, obstacleUnion);
  const thermal = z.thermalRelief === true;
  if (thermal && samePads.length) fill = difference(fill, union(samePads.flatMap((p) => primPaths(p.prim!, clr))));

  const mw = z.minWidth ?? defaultMinWidth;
  if (mw > 0 && fill.length) {
    const opened = offsetPaths(offsetPaths(fill, -mw / 2), mw / 2);
    fill = intersection(opened, fill);
  }

  if (thermal && samePads.length && fill.length) {
    const sw = Math.max(0.3, netTraceWidth(board, net));
    const spokes: IPaths = [];
    for (const p of samePads) {
      const prim = p.prim!;
      for (const k of [0, 90, 180, 270]) {
        const u = rotate2([1, 0], (p.pp.rotation || 0) + k);
        const ext = halfExtent(prim, [p.pp.x, p.pp.y], u);
        const reach = ext + clr + Math.max(mw, sw / 2) + 0.05;
        const spoke = rectAlong([p.pp.x, p.pp.y], u, 0, reach, sw);
        const clipped = difference(intersection([spoke], base), obstacleUnion);
        if (!clipped.length) continue;
        const tip = rectAlong([p.pp.x, p.pp.y], u, ext + clr, reach, sw);
        if (areaOf(intersection([tip], fill)) < sw * Math.max(mw, 0.05) * 0.25) continue;
        spokes.push(...clipped);
      }
    }
    if (spokes.length) fill = union([...fill, ...spokes]);
  }
  if (!fill.length) return [];

  // island removal: keep islands touching same-net copper
  const isl = islands(fill);
  const out: IPaths = [];
  const index = net && sameCopper.length ? buildIndex(sameCopper) : null;
  const cand: number[] = [];
  for (const island of isl) {
    if (Math.abs(areaOf([island.outer])) < 1e-6) continue;
    let keep = !net;
    if (!keep && index) {
      const region = new Region([fromIPath(island.outer), ...island.holes.map((h) => fromIPath(h))]);
      index.idx.query(bbInflate(region.bb, 0.01), cand);
      for (const id of cand) {
        if (region.gapTo(sameCopper[id], 0.01) <= 0.001) {
          keep = true;
          break;
        }
      }
    }
    if (!keep) continue;
    out.push(island.outer, ...island.holes);
  }
  return out;
}

function buildIndex(prims: Prim[]): { idx: GridIndex } {
  let ext = prims[0].bb;
  for (const p of prims) ext = { minX: Math.min(ext.minX, p.bb.minX), minY: Math.min(ext.minY, p.bb.minY), maxX: Math.max(ext.maxX, p.bb.maxX), maxY: Math.max(ext.maxY, p.bb.maxY) };
  const idx = new GridIndex(ext, 2, prims.length);
  prims.forEach((p, i) => idx.insert(i, p.bb));
  return { idx };
}

/** Distance from centre to the far edge of a prim's copper along unit direction u. */
function halfExtent(p: Prim, c: Vec2, u: Vec2): number {
  let m = 0;
  for (const q of p.pts) m = Math.max(m, (q[0] - c[0]) * u[0] + (q[1] - c[1]) * u[1]);
  return m + p.r;
}

/** Rectangle along direction u from distance d0 to d1 (from c), width w. */
function rectAlong(c: Vec2, u: Vec2, d0: number, d1: number, w: number): IPath {
  const n: Vec2 = [-u[1] * (w / 2), u[0] * (w / 2)];
  const a: Vec2 = [c[0] + u[0] * d0, c[1] + u[1] * d0];
  const b: Vec2 = [c[0] + u[0] * d1, c[1] + u[1] * d1];
  return ccw(
    toIPath([
      [a[0] - n[0], a[1] - n[1]],
      [b[0] - n[0], b[1] - n[1]],
      [b[0] + n[0], b[1] + n[1]],
      [a[0] + n[0], a[1] + n[1]],
    ]),
  );
}
