/**
 * Board statistics for dashboards and agent summaries.
 */
import type { Board, PartDef } from '@pcbcad/core';
import { areaOf, ccw, primPaths, toIPath, union, type IPaths } from './clip';
import { analyzeConnectivity } from './connectivity';
import { polylineLength, ringArea } from './geom';

export interface BoardStats {
  components: number;
  nets: number;
  /** Routed connections in percent: 100 × (1 − Σ(islands−1) / Σ(pins−1)) over nets with ≥ 2 pads. */
  routedPct: number;
  viaCount: number;
  /** Total centre-line length of all traces (mm). */
  traceLengthMm: number;
  /** Copper area summed over all copper layers (union per layer of pads, traces, vias, plated holes, zone fills), mm². */
  copperAreaMm2: number;
  /** Board area: outline minus cutouts (mm²). */
  areaMm2: number;
}

/** Summary statistics of a board. */
export function boardStats(board: Board, parts: Record<string, PartDef>): BoardStats {
  const conn = analyzeConnectivity(board, parts);
  let need = 0;
  let missing = 0;
  for (const islands of conn.nets.values()) {
    const pins = islands.reduce((s, i) => s + i.padKeys.length, 0);
    if (pins < 2) continue;
    need += pins - 1;
    missing += islands.length - 1;
  }
  const routedPct = need === 0 ? 100 : Math.round(100000 * (1 - missing / need)) / 1000;
  let traceLengthMm = 0;
  for (const t of board.traces ?? []) traceLengthMm += polylineLength(t.points ?? []);
  let areaMm2 = board.outline && board.outline.length >= 3 ? Math.abs(ringArea(board.outline)) : 0;
  for (const c of board.cutouts ?? []) if (c.length >= 3) areaMm2 -= Math.abs(ringArea(c));

  let copperAreaMm2 = 0;
  const nLayers = conn.model.stack.length;
  for (let s = 0; s < nLayers; s++) {
    const bit = 1 << s;
    const paths: IPaths = [];
    for (const it of conn.model.items) {
      if (!it.copper || !it.geometric || !(it.layers & bit)) continue;
      if (it.kind === 'zone' && it.region) {
        it.region.rings.forEach((r, i) => {
          const p = ccw(toIPath(r));
          paths.push(i === 0 ? p : p.slice().reverse());
        });
      } else if (it.prim) paths.push(...primPaths(it.prim, 0));
    }
    if (paths.length) copperAreaMm2 += areaOf(union(paths));
  }
  return {
    components: board.components.length,
    nets: board.nets.length,
    routedPct,
    viaCount: (board.vias ?? []).length,
    traceLengthMm: Math.round(traceLengthMm * 1000) / 1000,
    copperAreaMm2: Math.round(copperAreaMm2 * 1000) / 1000,
    areaMm2: Math.round(areaMm2 * 1000) / 1000,
  };
}
