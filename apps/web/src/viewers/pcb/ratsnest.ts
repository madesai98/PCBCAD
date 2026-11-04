import type { CopperLayer, Vec2 } from '@pcbcad/core';
import { pointInPolygon, pointSegmentDistance } from '@pcbcad/core';
import type { PcbScene, ScenePad } from './scene';

export interface RatsnestEdge {
  netId: string;
  from: Vec2;
  to: Vec2;
}

/**
 * Fallback ratsnest used when the app does not supply one: per net, union pads / traces / vias /
 * zone fills that touch on a shared copper layer, then connect the remaining islands with a
 * minimum spanning tree over pad-to-pad distances. Nets larger than `maxPads` are skipped.
 */
export function computeRatsnest(scene: PcbScene, maxPads = 400): RatsnestEdge[] {
  const board = scene.board;
  const out: RatsnestEdge[] = [];
  const padsByNet = new Map<string, ScenePad[]>();
  for (const p of scene.pads) {
    if (!p.netId || p.side === 'npth' || scene.comps[p.comp].staged) continue;
    let arr = padsByNet.get(p.netId);
    if (!arr) padsByNet.set(p.netId, (arr = []));
    arr.push(p);
  }
  const tracesByNet = new Map<string, number[]>();
  board.traces.forEach((t, i) => {
    if (t.points.length < 2) return;
    let arr = tracesByNet.get(t.netId);
    if (!arr) tracesByNet.set(t.netId, (arr = []));
    arr.push(i);
  });
  const viasByNet = new Map<string, number[]>();
  board.vias.forEach((v, i) => {
    let arr = viasByNet.get(v.netId);
    if (!arr) viasByNet.set(v.netId, (arr = []));
    arr.push(i);
  });

  const padLayers = (p: ScenePad): (CopperLayer | '*')[] => (p.side === 'through' ? ['*'] : [p.side as CopperLayer]);
  const sameLayer = (a: (CopperLayer | '*')[], l: CopperLayer) => a.includes('*') || a.includes(l);

  for (const [netId, pads] of padsByNet) {
    if (pads.length < 2 || pads.length > maxPads) continue;
    const traces = tracesByNet.get(netId) ?? [];
    const vias = viasByNet.get(netId) ?? [];
    const zones: { layer: CopperLayer; rings: Vec2[][] }[] = [];
    for (const z of board.zones) if (z.netId === netId && z.fill?.length) zones.push({ layer: z.layer, rings: z.fill });

    // Item indices: pads [0, P), traces [P, P+T), vias [P+T, P+T+V), zones after.
    const P = pads.length;
    const T = traces.length;
    const V = vias.length;
    const parent = Array.from({ length: P + T + V + zones.length }, (_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    const touchesTrace = (pt: Vec2, ti: number, extra: number) => {
      const t = board.traces[ti];
      for (let s = 0; s + 1 < t.points.length; s++) if (pointSegmentDistance(pt, t.points[s], t.points[s + 1]) <= t.width / 2 + extra) return true;
      return false;
    };
    const inZone = (pt: Vec2, z: { rings: Vec2[][] }) => {
      let inside = false;
      for (const r of z.rings) if (r.length >= 3 && pointInPolygon(pt, r)) inside = !inside;
      return inside;
    };

    traces.forEach((ti, k) => {
      const t = board.traces[ti];
      const ends = [t.points[0], t.points[t.points.length - 1]];
      // trace ↔ pad
      pads.forEach((p, pi) => {
        if (!sameLayer(padLayers(p), t.layer)) return;
        for (const e of ends) {
          if (pointInPolygon(e, p.poly) || Math.hypot(e[0] - p.x, e[1] - p.y) <= Math.min(p.bbox.maxX - p.bbox.minX, p.bbox.maxY - p.bbox.minY) / 2 + t.width / 2) {
            union(pi, P + k);
            return;
          }
        }
      });
      // trace ↔ trace (endpoint on the other's centreline)
      for (let k2 = k + 1; k2 < T; k2++) {
        const t2 = board.traces[traces[k2]];
        if (t2.layer !== t.layer) continue;
        const ends2 = [t2.points[0], t2.points[t2.points.length - 1]];
        if (ends.some((e) => touchesTrace(e, traces[k2], 0.01)) || ends2.some((e) => touchesTrace(e, ti, 0.01))) union(P + k, P + k2);
      }
      // trace ↔ via
      vias.forEach((vi, j) => {
        const v = board.vias[vi];
        for (const e of ends) if (Math.hypot(e[0] - v.x, e[1] - v.y) <= v.diameter / 2 + t.width / 2) union(P + k, P + T + j);
      });
      // trace ↔ zone
      zones.forEach((z, zi) => {
        if (z.layer === t.layer && ends.some((e) => inZone(e, z))) union(P + k, P + T + V + zi);
      });
    });
    vias.forEach((vi, j) => {
      const v = board.vias[vi];
      const pt: Vec2 = [v.x, v.y];
      pads.forEach((p, pi) => {
        if (pointInPolygon(pt, p.poly)) union(pi, P + T + j);
      });
      zones.forEach((z, zi) => {
        if (inZone(pt, z)) union(P + T + j, P + T + V + zi);
      });
    });
    pads.forEach((p, pi) => {
      zones.forEach((z, zi) => {
        if (sameLayer(padLayers(p), z.layer) && inZone([p.x, p.y], z)) union(pi, P + T + V + zi);
      });
    });

    // Group pads into islands and connect with Prim's MST over closest pad pairs.
    const islands = new Map<number, ScenePad[]>();
    pads.forEach((p, pi) => {
      const r = find(pi);
      let arr = islands.get(r);
      if (!arr) islands.set(r, (arr = []));
      arr.push(p);
    });
    const groups = [...islands.values()];
    if (groups.length < 2) continue;
    const inTree = new Array(groups.length).fill(false);
    inTree[0] = true;
    for (let added = 1; added < groups.length; added++) {
      let best = { d: Infinity, a: null as ScenePad | null, b: null as ScenePad | null, g: -1 };
      for (let gi = 0; gi < groups.length; gi++) {
        if (!inTree[gi]) continue;
        for (let gj = 0; gj < groups.length; gj++) {
          if (inTree[gj]) continue;
          for (const a of groups[gi])
            for (const b of groups[gj]) {
              const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
              if (d < best.d) best = { d, a, b, g: gj };
            }
        }
      }
      if (best.g < 0 || !best.a || !best.b) break;
      inTree[best.g] = true;
      out.push({ netId, from: [best.a.x, best.a.y], to: [best.b.x, best.b.y] });
    }
  }
  return out;
}
