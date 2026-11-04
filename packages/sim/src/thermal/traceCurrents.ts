import type { Board, CopperLayer, PartDef, PcbThermalResult, Vec2 } from '@pcbcad/core';
import { ipc2221Capacity, ipc2221TempRise } from './ipc';
import { solveGroundedLaplacian } from './laplacian';
import { buildBoardNetwork, type BoardNetwork, type NetNetwork } from './network';
import { copperTempFactor, isOuterLayer, layerCopperOz } from './stackup';

/**
 * Trace current / IR-drop analysis: DC current distribution in the copper of every net that
 * carries pin current, from the per-net resistor networks of ./network.ts.
 */

/** Per-segment report: the contract fields plus geometry and electrical details. */
export type TraceSegmentReport = PcbThermalResult['traces'][number] & {
  layer: CopperLayer;
  /** Trace width (mm). */
  width: number;
  /** Segment length (mm). */
  length: number;
  /** Segment resistance at the analysis temperature (Ω). */
  resistance: number;
  /** Joule loss in the segment (W). */
  power: number;
  /** +1 when conventional current flows from points[segment] to points[segment+1], −1 reverse, 0 none. */
  direction: 1 | -1 | 0;
};

export interface SegmentPower {
  traceId: string;
  segment: number;
  /** Joule loss (W). */
  power: number;
  /** Segment midpoint (board frame, mm). */
  midpoint: Vec2;
  layer: CopperLayer;
  /** Segment end points (mm) and width (mm), for depositing the heat along the segment. */
  a: Vec2;
  b: Vec2;
  width: number;
}

export interface TraceCurrentResult {
  /** One entry per non-degenerate segment of every trace of a net that carries pin current. */
  traces: TraceSegmentReport[];
  /** Per-net IR drop (largest potential difference between current-carrying pins), worst first. */
  netDrops: NonNullable<PcbThermalResult['netDrops']>;
  /** Joule loss per trace segment. */
  segmentPower: SegmentPower[];
  /** Routing/consistency problems found while building or solving the networks. */
  warnings: string[];
}

export interface TraceCurrentOptions {
  /** Copper temperature (°C) for ρ(T) = ρ20·(1 + 0.00393·(T − 20)). Default 25 °C. */
  temperature?: number;
}

/** Joule heat of one network edge, for the thermal model (internal). */
export interface CopperLoss {
  layer: CopperLayer;
  /** Via barrels: heat is split equally between `layer` and `layer2`. */
  layer2?: CopperLayer;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** True for trace segments (deposit along the line), false for point sources. */
  line: boolean;
  power: number;
}

/** Copper temperature (°C) at a board location on a layer. */
export type CopperTemperatureFn = (layer: CopperLayer, x: number, y: number) => number;

/** Pin currents of a component, looked up by component id, then by reference designator. */
function componentCurrents(pinCurrents: Record<string, Record<string, number>>, id: string, ref: string): Record<string, number> | undefined {
  return pinCurrents[id] ?? pinCurrents[ref];
}

/** Ids of the nets on `board` with at least one pin carrying non-zero current. */
export function netsWithCurrent(board: Board, pinCurrents: Record<string, Record<string, number>>): Set<string> {
  const out = new Set<string>();
  for (const c of board.components) {
    const cur = componentCurrents(pinCurrents, c.id, c.ref);
    if (!cur) continue;
    for (const [pin, I] of Object.entries(cur)) {
      const net = c.pinNets[pin];
      if (net && Number.isFinite(I) && I !== 0) out.add(net);
    }
  }
  return out;
}

function fmtA(a: number): string {
  return Math.abs(a) >= 0.1 ? `${a.toFixed(2)} A` : `${(a * 1000).toFixed(1)} mA`;
}

/**
 * Solve every net of a prebuilt {@link BoardNetwork} for the given pin currents.
 * @param tempAt copper temperature (°C) used for each edge's resistance
 */
export function analyzeNetworks(
  board: Board,
  network: BoardNetwork,
  pinCurrents: Record<string, Record<string, number>>,
  tempAt: CopperTemperatureFn,
): { result: TraceCurrentResult; losses: CopperLoss[] } {
  const traces: TraceSegmentReport[] = [];
  const netDrops: TraceCurrentResult['netDrops'] = [];
  const segmentPower: SegmentPower[] = [];
  const warnings: string[] = [];
  const losses: CopperLoss[] = [];
  const stack = board.stackup;
  const byNet = pinCurrentsByNet(board, pinCurrents);

  for (const net of network.nets.values()) {
    const sol = solveNet(net, byNet.get(net.netId) ?? [], tempAt, warnings);
    const { v, cur, g } = sol;
    const root = net.root;
    // losses
    net.edges.forEach((e, k) => {
      const I = cur[k];
      if (I === 0) return;
      const p = (I * I) / g[k];
      if (!(p > 0)) return;
      losses.push({ layer: e.layer, layer2: e.layer2, ax: e.ax, ay: e.ay, bx: e.bx, by: e.by, line: e.kind === 'trace', power: p });
    });
    // segments
    for (const s of net.segs) {
      let maxAbs = 0;
      let dir: 1 | -1 | 0 = 0;
      let P = 0;
      let R = 0;
      for (const k of s.edges) {
        const I = cur[k];
        const r = 1 / g[k];
        P += I * I * r;
        R += r;
        if (Math.abs(I) > maxAbs) {
          maxAbs = Math.abs(I);
          dir = I > 0 ? 1 : -1;
        }
      }
      if (maxAbs < 1e-12) {
        maxAbs = 0;
        dir = 0;
      }
      const oz = layerCopperOz(stack, s.layer);
      const ext = isOuterLayer(s.layer);
      const cap10 = ipc2221Capacity(s.width, oz, 10, ext);
      const cap20 = ipc2221Capacity(s.width, oz, 20, ext);
      const area = s.width * s.thickness;
      traces.push({
        traceId: s.traceId,
        netId: net.netId,
        segment: s.seg,
        current: maxAbs,
        currentDensity: area > 0 ? maxAbs / area : 0,
        tempRise: ipc2221TempRise(maxAbs, s.width, oz, ext),
        ipcCapacity: cap10,
        voltageDrop: Math.abs(v[root[s.na]] - v[root[s.nb]]),
        status: maxAbs > cap20 ? 'fail' : maxAbs > cap10 ? 'warn' : 'ok',
        layer: s.layer,
        width: s.width,
        length: s.length,
        resistance: R,
        power: P,
        direction: dir,
      });
      segmentPower.push({
        traceId: s.traceId,
        segment: s.seg,
        power: P,
        midpoint: [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2],
        layer: s.layer,
        a: s.a,
        b: s.b,
        width: s.width,
      });
    }
    if (sol.netCurrent > 0 || sol.maxDrop > 0) netDrops.push({ netId: net.netId, name: net.netName, maxDrop: sol.maxDrop, current: sol.netCurrent });
  }
  netDrops.sort((a, b) => b.maxDrop - a.maxDrop);
  return { result: { traces, netDrops, segmentPower, warnings }, losses };
}

interface NetSolution {
  /** Potential per node (indexed by node id; equal for all nodes of a root). */
  v: Float64Array;
  /** Current per edge, a → b (A). */
  cur: Float64Array;
  /** Conductance per edge at temperature (S). */
  g: Float64Array;
  maxDrop: number;
  netCurrent: number;
}

interface PinCurrent {
  componentId: string;
  ref: string;
  pin: string;
  /** Current INTO the pin (A). */
  current: number;
}

/** Finite pin currents of the board's components grouped by net id. */
function pinCurrentsByNet(board: Board, pinCurrents: Record<string, Record<string, number>>): Map<string, PinCurrent[]> {
  const out = new Map<string, PinCurrent[]>();
  for (const c of board.components) {
    const cur = componentCurrents(pinCurrents, c.id, c.ref);
    if (!cur) continue;
    for (const [pin, netId] of Object.entries(c.pinNets)) {
      const I = cur[pin];
      if (I === undefined || !Number.isFinite(I)) continue;
      let l = out.get(netId);
      if (!l) out.set(netId, (l = []));
      l.push({ componentId: c.id, ref: c.ref, pin, current: I });
    }
  }
  return out;
}

function solveNet(net: NetNetwork, pinCurrents: PinCurrent[], tempAt: CopperTemperatureFn, warnings: string[]): NetSolution {
  const N = net.nodeCount;
  const root = net.root;
  const E = net.edges.length;
  // Injections: current leaving the copper into a pin is −I_pin.
  const J = new Float64Array(N);
  let netCurrent = 0;
  const nodeOfPin = new Map(net.pins.map((p) => [`${p.componentId}\u0000${p.pin}`, p.node]));
  for (const pc of pinCurrents) {
    if (-pc.current > 0) netCurrent += -pc.current;
    const node = nodeOfPin.get(`${pc.componentId}\u0000${pc.pin}`);
    if (node !== undefined) J[root[node]] += -pc.current;
    else if (pc.current !== 0)
      warnings.push(`Net ${net.netName}: ${pc.ref}.${pc.pin} carries ${fmtA(pc.current)} but has no pad on the board (unplaced or missing footprint pad)`);
  }

  const g = new Float64Array(E);
  net.edges.forEach((e, k) => {
    const T = tempAt(e.layer, (e.ax + e.bx) / 2, (e.ay + e.by) / 2);
    const r = e.r20 * copperTempFactor(Number.isFinite(T) ? T : 25);
    g[k] = r > 0 ? 1 / r : 1e12;
  });

  // Islands over roots.
  const comp = new Int32Array(N);
  for (let i = 0; i < N; i++) comp[i] = i;
  const find = (i: number): number => {
    while (comp[i] !== i) {
      comp[i] = comp[comp[i]];
      i = comp[i];
    }
    return i;
  };
  for (const e of net.edges) {
    const a = find(root[e.a]);
    const b = find(root[e.b]);
    if (a !== b) comp[b] = a;
  }
  const islands = new Map<number, number[]>();
  for (let i = 0; i < N; i++) {
    if (root[i] !== i) continue; // only representatives
    const c = find(i);
    let l = islands.get(c);
    if (!l) islands.set(c, (l = []));
    l.push(i);
  }
  const edgesOf = new Map<number, number[]>();
  net.edges.forEach((e, k) => {
    const c = find(root[e.a]);
    let l = edgesOf.get(c);
    if (!l) edgesOf.set(c, (l = []));
    l.push(k);
  });

  const v = new Float64Array(N);
  let maxDrop = 0;
  let surplus = 0; // Σ of island imbalances that must leave through missing copper
  let deficit = 0; // Σ of island imbalances that must arrive through missing copper
  const local = new Int32Array(N).fill(-1);
  for (const [c, nodes] of islands) {
    let pos = 0;
    let neg = 0;
    for (const i of nodes) {
      if (J[i] > 0) pos += J[i];
      else neg -= J[i];
    }
    if (pos + neg <= 1e-15) continue;
    const imbalance = pos - neg;
    if (Math.abs(imbalance) > 1e-9 + 1e-6 * Math.max(pos, neg)) {
      if (imbalance > 0) surplus += imbalance;
      else deficit -= imbalance;
      // Scale down the over-represented side so the island balances: the routed copper then
      // carries exactly the current of the routed loads/sources.
      if (pos > neg) {
        const f = pos > 0 ? neg / pos : 0;
        for (const i of nodes) if (J[i] > 0) J[i] *= f;
      } else {
        const f = neg > 0 ? pos / neg : 0;
        for (const i of nodes) if (J[i] < 0) J[i] *= f;
      }
    }
    const el = edgesOf.get(c) ?? [];
    if (!el.length) continue;
    let jmax = 0;
    let ground = nodes[0];
    for (const i of nodes) if (Math.abs(J[i]) > jmax) ((jmax = Math.abs(J[i])), (ground = i));
    if (jmax <= 1e-15) continue;
    nodes.forEach((i, k) => (local[i] = k));
    const ea = new Int32Array(el.length);
    const eb = new Int32Array(el.length);
    const eg = new Float64Array(el.length);
    el.forEach((k, q) => {
      ea[q] = local[root[net.edges[k].a]];
      eb[q] = local[root[net.edges[k].b]];
      eg[q] = g[k];
    });
    const jl = new Float64Array(nodes.length);
    nodes.forEach((i, k) => (jl[k] = J[i]));
    const vl = solveGroundedLaplacian(nodes.length, { a: ea, b: eb, g: eg }, jl, local[ground]);
    nodes.forEach((i, k) => (v[i] = vl[k]));
    // IR drop between current-carrying pins of this island
    const thr = 1e-9 + 1e-6 * jmax;
    let vmin = Infinity;
    let vmax = -Infinity;
    for (const p of net.pins) {
      const r = root[p.node];
      if (find(r) !== c || Math.abs(J[r]) <= thr) continue;
      if (v[r] < vmin) vmin = v[r];
      if (v[r] > vmax) vmax = v[r];
    }
    if (vmax > vmin) maxDrop = Math.max(maxDrop, vmax - vmin);
  }
  const unrouted = Math.max(surplus, deficit);
  if (unrouted > 1e-9) warnings.push(`Net ${net.netName}: ${fmtA(unrouted)} of pin current has no complete copper path (incomplete routing?); only the routed part was analysed`);
  // node potentials for all nodes (non-representatives take their root's value)
  for (let i = 0; i < N; i++) if (root[i] !== i) v[i] = v[root[i]];
  const cur = new Float64Array(E);
  net.edges.forEach((e, k) => {
    const I = (v[root[e.a]] - v[root[e.b]]) * g[k];
    cur[k] = Math.abs(I) < 1e-15 ? 0 : I;
  });
  return { v, cur, g, maxDrop, netCurrent };
}

/**
 * DC current distribution, IR drop and IPC-2221 loading of every trace segment.
 *
 * For each net with pin current a resistor network is built from its traces, pads, vias and zone
 * fills (see ./network.ts); the current INTO each component pin (`pinCurrents`, A, keyed by
 * component id or ref, then pin number — as produced by the circuit solver) leaves the copper
 * at that pin's pads. Each connected copper island is solved independently with one grounded
 * node (direct sparse elimination). Islands whose pin currents do not sum to zero (incomplete
 * routing) are balanced by scaling down the over-represented side, i.e. only the current of the
 * routed pins is analysed, and a warning is emitted.
 *
 * Per segment: |I| (largest sub-segment current when a T-junction splits it), current density
 * (A/mm²), IPC-2221 rise and 10 °C capacity, voltage drop between its end vertices; status
 * 'fail' above the 20 °C IPC capacity, 'warn' above the 10 °C capacity.
 *
 * @param board        board with traces/vias/zones and placed components
 * @param parts        part library (footprints) keyed by PartDef.id
 * @param pinCurrents  component id → pin number → current INTO the pin (A)
 * @param opts.temperature copper temperature for the resistivity (°C, default 25)
 */
export function computeTraceCurrents(
  board: Board,
  parts: Record<string, PartDef>,
  pinCurrents: Record<string, Record<string, number>>,
  opts: TraceCurrentOptions = {},
): TraceCurrentResult {
  const T = opts.temperature ?? 25;
  const nets = netsWithCurrent(board, pinCurrents);
  const network = buildBoardNetwork(board, parts, nets);
  const { result } = analyzeNetworks(board, network, pinCurrents, () => T);
  result.warnings.unshift(...network.warnings);
  return result;
}
