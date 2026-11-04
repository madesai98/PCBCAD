import type { Board, ComponentInstance, CopperLayer, Net, NetClass, PartDef, Trace, Vec2, Via, Zone } from '@pcbcad/core';
import { DEFAULT_RULES, DEFAULT_STACKUP, guessNetClass, placedPads, roundedRectPolygon } from '@pcbcad/core';
import { DemoRouter } from './router';

type Place = [ref: string, partId: string, x: number, y: number, rot: number, pinNets: Record<string, string>, value?: string];

/** Demo routing statistics (for the gallery's diagnostics). */
export const routeStats: Record<string, { failed: number; edges: number }> = {};

let idCounter = 0;
const id = (p: string) => `${p}_${(++idCounter).toString(36).padStart(4, '0')}`;

function makeNets(names: string[], classes: Record<string, NetClass> = {}): { nets: Net[]; byName: Map<string, string> } {
  const byName = new Map<string, string>();
  const nets: Net[] = names.map((name) => {
    const nid = `net_${name.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}`;
    byName.set(name, nid);
    return { id: nid, name, class: classes[name] ?? guessNetClass(name) };
  });
  return { nets, byName };
}

function components(places: Place[], byName: Map<string, string>, boardKey: string): ComponentInstance[] {
  return places.map(([ref, partId, x, y, rot, pn, value]) => ({
    id: `cmp_${boardKey}_${ref.toLowerCase()}`,
    ref,
    partId,
    value,
    x,
    y,
    rotation: rot,
    side: 'top',
    placed: true,
    pinNets: Object.fromEntries(Object.entries(pn).map(([pin, net]) => [pin, byName.get(net) ?? net])),
  }));
}

interface RouteOptions {
  wideNets: Set<string>;
  /** Also route the pour net with traces (default: pads connect through the pour). */
  routePour?: boolean;
  skipEdges?: { net: string; count: number }[];
  pourNet?: string;
  bottomPreferred?: Set<string>;
}

/** Route every net (except the pour net) as a pad MST with the demo router (fan-out stubs on fine-pitch pads). */
function routeBoard(board: Board, parts: Record<string, PartDef>, opts: RouteOptions) {
  const bounds = { minX: 0, minY: 0, maxX: board.outlineSpec!.width, maxY: board.outlineSpec!.height };
  const rules = board.rules;
  const router = new DemoRouter(bounds, { res: 0.2, clearance: rules.clearance, edge: rules.edgeClearance, narrow: rules.traceWidth, wide: rules.powerTraceWidth });
  type Term = { x: number; y: number; layers: ('top' | 'bottom')[]; net: string };
  type PadInfo = { cx: number; cy: number; box: [number, number, number, number]; layers: ('top' | 'bottom')[]; net: string; smd: boolean; comp: { x: number; y: number } };
  const padInfos: PadInfo[] = [];
  for (const c of board.components) {
    const fp = parts[c.partId]?.footprint;
    if (!fp) continue;
    for (const pp of placedPads(c, fp)) {
      const xs = pp.polygon.map((p) => p[0]);
      const ys = pp.polygon.map((p) => p[1]);
      const box: PadInfo['box'] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const net = c.pinNets[pp.pad.number];
      const layers: ('top' | 'bottom')[] = pp.pad.kind === 'smd' ? [c.side] : ['top', 'bottom'];
      router.markRect(layers, box[0], box[1], box[2], box[3], pp.pad.kind === 'npth' ? null : (net ?? `__nc_${c.id}_${pp.pad.number}`));
      if (pp.pad.kind !== 'smd' && (pp.pad.drill || pp.pad.slot)) router.markCircle(['top', 'bottom'], pp.x, pp.y, (pp.pad.drill ?? pp.pad.slot!.w) / 2 + 0.1, pp.pad.kind === 'npth' ? null : (net ?? null));
      if (net && pp.pad.kind !== 'npth') padInfos.push({ cx: pp.x, cy: pp.y, box, layers, net, smd: pp.pad.kind === 'smd', comp: { x: c.x, y: c.y } });
    }
  }
  for (const h of board.holes) router.markCircle(['top', 'bottom'], h.x, h.y, (h.padDiameter ?? h.drill) / 2, h.netId ?? null);
  for (const p of padInfos) router.forceRect(p.layers, p.box[0], p.box[1], p.box[2], p.box[3], p.net);

  const traces: Trace[] = [];
  const vias: Via[] = [];
  const narrow = rules.traceWidth;
  // Fan-out stubs for fine-pitch SMD pads: straight out of the pad's far end, then route from the stub end.
  const terms = new Map<string, Term[]>();
  for (const p of padInfos) {
    if (p.net === opts.pourNet && !opts.routePour) continue;
    let tx = p.cx;
    let ty = p.cy;
    const w = p.box[2] - p.box[0];
    const h = p.box[3] - p.box[1];
    if (p.smd && Math.min(w, h) < 0.65) {
      const alongY = h >= w;
      const dir = alongY ? Math.sign(p.cy - p.comp.y) || 1 : Math.sign(p.cx - p.comp.x) || 1;
      const len = (alongY ? h : w) / 2 + 0.7;
      const ex = alongY ? p.cx : p.cx + dir * len;
      const ey = alongY ? p.cy + dir * len : p.cy;
      const hw = narrow / 2;
      const rx0 = Math.min(p.cx, ex) - (alongY ? hw : 0);
      const rx1 = Math.max(p.cx, ex) + (alongY ? hw : 0);
      const ry0 = Math.min(p.cy, ey) - (alongY ? 0 : hw);
      const ry1 = Math.max(p.cy, ey) + (alongY ? 0 : hw);
      router.forceRect(p.layers, rx0, ry0, rx1, ry1, p.net);
      if (router.isFree(p.layers[0], ex, ey, p.net)) {
        router.markSegment(p.layers[0], [p.cx, p.cy], [ex, ey], hw, p.net);
        router.forceRect(p.layers, rx0, ry0, rx1, ry1, p.net);
        traces.push({ id: id('trk'), netId: p.net, layer: p.layers[0], width: narrow, points: [[p.cx, p.cy], [ex, ey]] });
        tx = ex;
        ty = ey;
      }
    }
    let arr = terms.get(p.net);
    if (!arr) terms.set(p.net, (arr = []));
    if (!arr.some((q) => Math.hypot(q.x - tx, q.y - ty) < 0.01)) arr.push({ x: tx, y: ty, layers: p.layers, net: p.net });
  }

  // MST edges per net.
  const edges: { net: string; a: Term; b: Term; len: number; wide: boolean }[] = [];
  for (const [net, pads] of terms) {
    if (pads.length < 2) continue;
    const inTree = [0];
    const rest = pads.map((_, i) => i).slice(1);
    const netEdges: typeof edges = [];
    while (rest.length) {
      let best = { d: Infinity, i: -1, j: -1 };
      for (const i of inTree)
        for (const j of rest) {
          const d = Math.hypot(pads[i].x - pads[j].x, pads[i].y - pads[j].y);
          if (d < best.d) best = { d, i, j };
        }
      inTree.push(best.j);
      rest.splice(rest.indexOf(best.j), 1);
      netEdges.push({ net, a: pads[best.i], b: pads[best.j], len: best.d, wide: opts.wideNets.has(net) });
    }
    const skip = opts.skipEdges?.find((s) => s.net === net)?.count ?? 0;
    netEdges.sort((x, y) => x.len - y.len);
    edges.push(...netEdges.slice(0, netEdges.length - skip));
  }
  edges.sort((x, y) => Number(y.wide) - Number(x.wide) || x.len - y.len);

  let failed = 0;
  for (const e of edges) {
    const prefer = opts.bottomPreferred?.has(e.net) ? 'bottom' : 'top';
    let wide = e.wide;
    let path = router.route(e.net, e.a, e.b, wide, { preferLayer: prefer });
    if (!path && wide) {
      wide = false;
      path = router.route(e.net, e.a, e.b, false, { preferLayer: prefer });
    }
    if (!path) {
      failed++;
      continue;
    }
    const width = wide ? rules.powerTraceWidth : e.wide ? Math.max(narrow, 0.3) : narrow;
    router.commit(e.net, path, width, rules.viaDiameter);
    for (const r of path.runs) traces.push({ id: id('trk'), netId: e.net, layer: r.layer, width, points: r.points });
    for (const v of path.vias) vias.push({ id: id('via'), netId: e.net, x: v[0], y: v[1], drill: rules.viaDrill, diameter: rules.viaDiameter });
  }
  // Ground stitching vias on a staggered grid wherever both layers are free.
  if (opts.pourNet) {
    const W = bounds.maxX;
    const H = bounds.maxY;
    for (let y = 3, row = 0; y < H - 2; y += 4.2, row++)
      for (let x = 3 + (row % 2) * 2.1; x < W - 2; x += 4.2) {
        const nearPad = padInfos.some((p) => x > p.box[0] - 0.8 && x < p.box[2] + 0.8 && y > p.box[1] - 0.8 && y < p.box[3] + 0.8);
        if (!nearPad && router.viaFree(x, y, rules.viaDiameter / 2 + rules.clearance + 0.15, opts.pourNet)) {
          vias.push({ id: id('via'), netId: opts.pourNet, x, y, drill: rules.viaDrill, diameter: rules.viaDiameter });
          router.markCircle(['top', 'bottom'], x, y, rules.viaDiameter / 2, opts.pourNet);
        }
      }
  }
  board.traces = traces;
  board.vias = vias;
  return { failed, edges: edges.length };
}

function pour(board: Board, netId: string, layer: CopperLayer, inset = 0.5): Zone {
  const w = board.outlineSpec!.width;
  const h = board.outlineSpec!.height;
  const ring = roundedRectPolygon(inset, inset, w - 2 * inset, h - 2 * inset, Math.max(0.2, board.outlineSpec!.cornerRadius - inset), 6);
  return { id: id('zone'), netId, layer, clearance: 0.3, minWidth: 0.25, thermalRelief: true, priority: 0, outline: ring, fill: [ring] };
}

function baseBoard(key: string, name: string, w: number, h: number, r: number, stackup: Partial<Board['stackup']>): Board {
  return {
    id: `brd_${key}`,
    name,
    outline: roundedRectPolygon(0, 0, w, h, r, 8),
    outlineSpec: { kind: 'rect', width: w, height: h, cornerRadius: r },
    stackup: { ...DEFAULT_STACKUP, copperOz: { ...DEFAULT_STACKUP.copperOz }, ...stackup },
    rules: { ...DEFAULT_RULES },
    components: [],
    nets: [],
    traces: [],
    vias: [],
    zones: [],
    holes: [],
  };
}

/* ------------------------------------------- main board ------------------------------------------ */

export function buildMainBoard(parts: Record<string, PartDef>): Board {
  const board = baseBoard('main', 'Main board', 60, 40, 2, { finish: 'ENIG', maskColor: 'green' });
  board.description = 'ATmega328P environmental sensor node with USB-C power, BME280 and I²C expansion.';
  const { nets, byName } = makeNets(
    ['GND', 'VBUS', 'VBUS_F', 'VIN', '+3V3', 'AVCC', 'XTAL1', 'XTAL2', 'RESET', 'SDA', 'SCL', 'UART_TX', 'UART_RX', 'LED', 'LED_A', 'BUZ_PWM', 'Q1_G', 'BUZ_N', 'CC1', 'CC2'],
    { AVCC: 'analog' },
  );
  board.nets = nets;
  const places: Place[] = [
    ['J1', 'C165948', 4.5, 20, -90, { A1B12: 'GND', A12B1: 'GND', S1: 'GND', A4B9: 'VBUS', A9B4: 'VBUS', A5: 'CC1', B5: 'CC2' }],
    ['R4', 'C25905', 11, 24.5, 90, { '1': 'CC1', '2': 'GND' }],
    ['R5', 'C25905', 11, 15.5, 90, { '1': 'GND', '2': 'CC2' }],
    ['F1', 'C369159', 12.5, 31, 0, { '1': 'VBUS', '2': 'VBUS_F' }],
    ['D1', 'C8678', 12.5, 36, 0, { '2': 'VBUS_F', '1': 'VIN' }],
    ['C1', 'C7171', 17, 25, 90, { '1': 'VIN', '2': 'GND' }],
    ['U2', 'C6186', 22, 33.5, 0, { '1': 'GND', '2': '+3V3', '3': 'VIN' }],
    ['C2', 'C15850', 27.5, 33, 90, { '1': '+3V3', '2': 'GND' }],
    [
      'U1',
      'C14877',
      37,
      18,
      0,
      { '3': 'GND', '5': 'GND', '21': 'GND', '4': '+3V3', '6': '+3V3', '18': 'AVCC', '7': 'XTAL1', '8': 'XTAL2', '29': 'RESET', '27': 'SDA', '28': 'SCL', '31': 'UART_TX', '30': 'UART_RX', '17': 'LED', '10': 'BUZ_PWM' },
    ],
    ['C3', 'C1525', 30, 21.5, 90, { '1': '+3V3', '2': 'GND' }],
    ['C4', 'C1525', 44, 21.5, 90, { '1': 'AVCC', '2': 'GND' }],
    ['FB1', 'C1015', 44, 25.5, 0, { '1': '+3V3', '2': 'AVCC' }],
    ['Y1', 'C13738', 28, 15, 90, { '1': 'XTAL2', '3': 'XTAL1', '2': 'GND', '4': 'GND' }],
    ['C6', 'C1555', 25, 17.5, 90, { '1': 'XTAL1', '2': 'GND' }],
    ['C7', 'C1555', 25, 12.5, 90, { '1': 'XTAL2', '2': 'GND' }],
    ['R1', 'C25744', 37, 26, 0, { '1': '+3V3', '2': 'RESET' }],
    ['SW1', 'C318884', 48, 5, 0, { '1': 'RESET', '2': 'RESET', '3': 'GND', '4': 'GND' }],
    ['R2', 'C25900', 49, 30.5, 90, { '1': 'SDA', '2': '+3V3' }],
    ['R3', 'C25900', 47.5, 30.5, 90, { '1': 'SCL', '2': '+3V3' }],
    ['U3', 'C92489', 54, 30.5, 0, { '1': 'GND', '7': 'GND', '5': 'GND', '6': '+3V3', '8': '+3V3', '2': '+3V3', '3': 'SDA', '4': 'SCL' }],
    ['C5', 'C1525', 54, 26.5, 0, { '1': '+3V3', '2': 'GND' }],
    ['J2', 'C131337', 56, 16, 90, { '1': '+3V3', '2': 'SCL', '3': 'SDA', '4': 'GND' }],
    ['J3', 'C2337', 31, 36.4, 0, { '1': 'UART_TX', '2': 'UART_RX', '3': 'GND' }],
    ['BZ1', 'C96446', 17, 7, 0, { '1': '+3V3', '2': 'BUZ_N' }],
    ['D4', 'C81598', 24.5, 7, 90, { '1': '+3V3', '2': 'BUZ_N' }],
    ['Q1', 'C8545', 29, 6.5, 0, { '1': 'Q1_G', '2': 'GND', '3': 'BUZ_N' }],
    ['R8', 'C25741', 29, 10.5, 0, { '1': 'Q1_G', '2': 'GND' }],
    ['R7', 'C25076', 32.5, 8.5, 0, { '1': 'BUZ_PWM', '2': 'Q1_G' }],
    ['R6', 'C25104', 36.5, 5.5, 0, { '1': 'LED', '2': 'LED_A' }],
    ['D2', 'C72043', 39.5, 5.5, 180, { '2': 'LED_A', '1': 'GND' }],
    ['LOGO1', 'custom:logo', 45, 37.1, 0, {}],
  ];
  board.components = components(places, byName, 'main');
  // The tactile switch and the buzzer go on in-house assembly: keep metadata realistic.
  board.components.find((c) => c.ref === 'BZ1')!.fields = { assembly: 'hand-solder' };
  const gnd = byName.get('GND')!;
  board.holes = [
    [3.5, 3.5],
    [56.5, 3.5],
    [3.5, 36.5],
    [56.5, 36.5],
  ].map(([x, y], i) => ({ id: `hole_main_${i + 1}`, x, y, drill: 3.2, plated: true, padDiameter: 6.0, netId: gnd, fastenerPartId: 'fst-m3-pan-6' }));
  const stats = routeBoard(board, parts, {
    wideNets: new Set(['VBUS', 'VBUS_F', 'VIN', '+3V3', 'AVCC'].map((n) => byName.get(n)!)),
    pourNet: gnd,
    skipEdges: [{ net: byName.get('BUZ_N')!, count: 1 }],
    bottomPreferred: new Set([byName.get('SDA')!, byName.get('SCL')!]),
  });
  board.zones = [pour(board, gnd, 'top'), pour(board, gnd, 'bottom')];
  routeStats.main = stats;
  return board;
}

/* ----------------------------------------- satellite board ---------------------------------------- */

export function buildSatelliteBoard(parts: Record<string, PartDef>): Board {
  const board = baseBoard('sat', 'Remote probe', 30, 20, 1.5, { finish: 'ENIG', maskColor: 'black' });
  board.description = 'TMP102 remote temperature probe on a JST-PH cable.';
  const { nets, byName } = makeNets(['GND', '+3V3', 'SDA', 'SCL', 'LED_A']);
  board.nets = nets;
  const places: Place[] = [
    ['J1', 'C131337', 5, 10, 90, { '1': '+3V3', '2': 'SCL', '3': 'SDA', '4': 'GND' }],
    ['U1', 'C1000182', 15.5, 10.5, 0, { '1': 'SCL', '2': 'GND', '4': 'GND', '5': '+3V3', '6': 'SDA' }],
    ['C1', 'C1525', 15.5, 14, 0, { '1': '+3V3', '2': 'GND' }],
    ['R1', 'C11702', 20.5, 6, 0, { '1': '+3V3', '2': 'LED_A' }],
    ['D1', 'C2286', 20.5, 3.6, 180, { '2': 'LED_A', '1': 'GND' }],
  ];
  board.components = components(places, byName, 'sat');
  const gnd = byName.get('GND')!;
  board.holes = [
    [26.5, 16.5],
    [26.5, 3.5],
  ].map(([x, y], i) => ({ id: `hole_sat_${i + 1}`, x, y, drill: 2.7, plated: false, fastenerPartId: 'fst-standoff-m25' }));
  routeStats.sat = routeBoard(board, parts, { wideNets: new Set([byName.get('+3V3')!]), pourNet: gnd });
  board.zones = [pour(board, gnd, 'top'), pour(board, gnd, 'bottom')];
  return board;
}

/* ------------------------------------------- stress board ----------------------------------------- */

/** ~200 components / ~2k traces for the performance check (unrouted-but-plausible geometry). */
export function buildStressBoard(parts: Record<string, PartDef>): Board {
  const board = baseBoard('stress', 'Stress test 200 parts / 2k traces', 160, 100, 3, { layers: 4, maskColor: 'blue', finish: 'LF-HASL' });
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const netCount = 160;
  const { nets, byName } = makeNets(['GND', '+3V3', ...Array.from({ length: netCount }, (_, i) => `N${i}`)]);
  board.nets = nets;
  const comps: ComponentInstance[] = [];
  const netIds = nets.map((n) => n.id);
  const pick = () => netIds[2 + Math.floor(rnd() * netCount)];
  // 8 MCUs in a row with passives around them.
  for (let m = 0; m < 8; m++) {
    const cx = 14 + (m % 4) * 38;
    const cy = 28 + Math.floor(m / 4) * 44;
    const pn: Record<string, string> = {};
    for (let p = 1; p <= 32; p++) pn[String(p)] = p % 8 === 3 ? netIds[0] : p % 8 === 4 ? netIds[1] : pick();
    comps.push({ id: `cmp_st_u${m}`, ref: `U${m + 1}`, partId: 'C14877', x: cx, y: cy, rotation: (m % 4) * 90, side: 'top', placed: true, pinNets: pn });
  }
  let r = 1;
  let c = 1;
  for (let i = 0; i < 192; i++) {
    const col = i % 24;
    const row = Math.floor(i / 24);
    const x = 6 + col * 6.3 + (row % 2) * 1.5;
    const y = 6 + row * 11.5 + (row >= 4 ? 4 : 0);
    const isR = i % 3 !== 0;
    const ref = isR ? `R${r++}` : `C${c++}`;
    comps.push({
      id: `cmp_st_${ref.toLowerCase()}`,
      ref,
      partId: isR ? 'C25744' : 'C1525',
      x,
      y,
      rotation: (i % 4) * 90,
      side: i % 7 === 0 ? 'bottom' : 'top',
      placed: true,
      pinNets: { '1': pick(), '2': i % 2 ? netIds[0] : pick() },
    });
  }
  board.components = comps.filter((cc) => {
    // keep passives off the MCU footprints
    if (cc.partId === 'C14877') return true;
    return !comps.some((m) => m.partId === 'C14877' && Math.abs(m.x - cc.x) < 7.5 && Math.abs(m.y - cc.y) < 7.5);
  });
  const layers: Trace['layer'][] = ['top', 'bottom', 'in1', 'in2'];
  const traces: Trace[] = [];
  const vias: Via[] = [];
  for (let t = 0; t < 2000; t++) {
    const layer = layers[t % 4];
    const x0 = 3 + rnd() * 154;
    const y0 = 3 + rnd() * 94;
    const pts: Vec2[] = [[x0, y0]];
    let x = x0;
    let y = y0;
    const segs = 2 + Math.floor(rnd() * 3);
    for (let s = 0; s < segs; s++) {
      const len = 2 + rnd() * 12;
      const dir = Math.floor(rnd() * 8);
      const ang = (dir * Math.PI) / 4;
      x = Math.max(2, Math.min(158, x + Math.cos(ang) * len));
      y = Math.max(2, Math.min(98, y + Math.sin(ang) * len));
      pts.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
    }
    const netId = pick();
    traces.push({ id: `trk_st_${t}`, netId, layer, width: t % 9 === 0 ? 0.5 : 0.2, points: pts });
    if (t % 5 === 0) vias.push({ id: `via_st_${t}`, netId, x: pts[pts.length - 1][0], y: pts[pts.length - 1][1], drill: 0.3, diameter: 0.6 });
  }
  board.traces = traces;
  board.vias = vias;
  board.zones = [pour(board, byName.get('GND')!, 'in1', 1)];
  void parts;
  return board;
}
