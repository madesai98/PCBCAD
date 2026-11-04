import type {
  BBox2,
  Board,
  ComponentInstance,
  CopperLayer,
  FootprintDef,
  Graphic,
  MountingHole,
  Net,
  NetClass,
  PadDef,
  PartDef,
  Trace,
  Vec2,
  Via,
  Zone,
} from '@pcbcad/core';
import { DEG, componentCourtyard, footprintToBoard, guessNetClass, placedPads, pointInPolygon, pointSegmentDistance, polygonBBox, rotate2 } from '@pcbcad/core';

/* ------------------------------------------------------------------------------------------------
 * PcbScene: everything the 2D renderer needs, precomputed once per (board, parts) pair:
 * Path2D geometry grouped so a frame is ~a few dozen fill/stroke calls even for 2k traces,
 * plus a uniform-grid spatial index for hover/click picking.
 * ---------------------------------------------------------------------------------------------- */

export type PadSide = 'top' | 'bottom' | 'through' | 'npth';

export interface ScenePad {
  i: number;
  comp: number;
  number: string;
  pinName?: string;
  pinType?: string;
  netId?: string;
  side: PadSide;
  poly: Vec2[];
  path: Path2D;
  x: number;
  y: number;
  bbox: BBox2;
  /** Drill in board frame; w === h for round holes, otherwise a slot rotated by rot (deg). */
  drill: { x: number; y: number; w: number; h: number; rot: number } | null;
}

export interface SilkText {
  x: number;
  y: number;
  /** Glyph (cap) height, mm. */
  size: number;
  /** Baseline direction in board frame (deg CCW). */
  rot: number;
  /** Glyphs mirrored (bottom-side text seen from the top). */
  mirror: boolean;
  text: string;
  /** Component this text belongs to (for dimming unplaced parts). */
  comp: number;
}

export interface SilkData {
  /** Stroked silk graphics grouped by line width. */
  strokes: { width: number; path: Path2D }[];
  fills: Path2D;
  texts: SilkText[];
}

export interface SceneComp {
  i: number;
  comp: ComponentInstance;
  /** Instance used for geometry (staged position for unplaced parts). */
  placedAs: ComponentInstance;
  part?: PartDef;
  fp?: FootprintDef;
  courtyard: Vec2[];
  courtyardPath: Path2D;
  bbox: BBox2;
  center: Vec2;
  /** Refdes for the centred "fab" label in layers mode. */
  fabRef: { x: number; y: number; size: number; rot: number };
  staged: boolean;
  pads: number[];
}

export interface TraceGroup {
  width: number;
  path: Path2D;
}

export interface CopperLayerData {
  layer: CopperLayer;
  traceGroups: TraceGroup[];
  traces: number[];
  zones: { zone: Zone; fill: Path2D | null; outline: Path2D | null }[];
}

export interface SceneNet {
  net: Net;
  cls: NetClass;
}

export interface NetGeometry {
  traces: { layer: CopperLayer; width: number; path: Path2D }[];
  pads: Partial<Record<PadSide, Path2D>>;
  vias: Path2D;
  zones: { layer: CopperLayer; path: Path2D }[];
  hasVias: boolean;
}

export interface HaloGeometry {
  traces: TraceGroup[];
  pads: Path2D;
  vias: Path2D;
}

export interface PcbScene {
  board: Board;
  parts: Record<string, PartDef>;
  /** Bbox of the outline (falls back to content). */
  bbox: BBox2;
  /** Bbox including staged (unplaced) components. */
  contentBox: BBox2;
  outlinePath: Path2D;
  outlineRing: Vec2[];
  hasOutline: boolean;
  copperLayers: CopperLayer[];
  copper: Partial<Record<CopperLayer, CopperLayerData>>;
  pads: ScenePad[];
  padPaths: Record<PadSide, Path2D>;
  padDrills: Path2D;
  /** Pads / courtyards of unplaced components shown in the staging area below the board. */
  staged: { pads: Path2D; courtyards: Path2D; drills: Path2D };
  vias: Via[];
  viaRings: Path2D;
  viaDrills: Path2D;
  holes: MountingHole[];
  holeRings: Path2D;
  holeDrills: Path2D;
  silk: { top: SilkData; bottom: SilkData };
  courtyard: { top: Path2D; bottom: Path2D };
  comps: SceneComp[];
  compById: Map<string, SceneComp>;
  traceById: Map<string, number>;
  nets: Map<string, SceneNet>;
  stagedBox: BBox2 | null;
  hit: HitGrid;
  netGeometry(netId: string): NetGeometry;
  haloGeometry(layer: CopperLayer, netId: string, clearance: number): HaloGeometry;
}

/* ------------------------------------------- helpers ------------------------------------------- */

export function polyPath(poly: Vec2[], path = new Path2D()): Path2D {
  if (poly.length < 2) return path;
  path.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) path.lineTo(poly[i][0], poly[i][1]);
  path.closePath();
  return path;
}

function addCircle(path: Path2D, x: number, y: number, r: number) {
  path.moveTo(x + r, y);
  path.arc(x, y, r, 0, Math.PI * 2);
  path.closePath();
}

/** Stadium (slot) outline centred at (x, y), size w×h rotated by rot degrees. */
function addSlot(path: Path2D, x: number, y: number, w: number, h: number, rot: number) {
  if (Math.abs(w - h) < 1e-6) {
    addCircle(path, x, y, w / 2);
    return;
  }
  const long = Math.max(w, h);
  const r = Math.min(w, h) / 2;
  const a = (rot + (h > w ? 90 : 0)) * DEG;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const half = long / 2 - r;
  const x1 = x - ux * half;
  const y1 = y - uy * half;
  const x2 = x + ux * half;
  const y2 = y + uy * half;
  path.moveTo(x1 - uy * r, y1 + ux * r);
  path.arc(x1, y1, r, a + Math.PI / 2, a + (Math.PI * 3) / 2);
  path.lineTo(x2 + uy * r, y2 - ux * r);
  path.arc(x2, y2, r, a - Math.PI / 2, a + Math.PI / 2);
  path.closePath();
}

function emptyBox(): BBox2 {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function growBox(b: BBox2, x: number, y: number, pad = 0) {
  if (x - pad < b.minX) b.minX = x - pad;
  if (y - pad < b.minY) b.minY = y - pad;
  if (x + pad > b.maxX) b.maxX = x + pad;
  if (y + pad > b.maxY) b.maxY = y + pad;
}

function unionBox(a: BBox2, b: BBox2): BBox2 {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

function validBox(b: BBox2) {
  return Number.isFinite(b.minX) && b.maxX >= b.minX && b.maxY >= b.minY;
}

const REF_PLACEHOLDER = /^(REF\*\*|\$\{REFERENCE\}|%R|\{ref\}|REF|\$REF)$/i;
const VALUE_PLACEHOLDER = /^(VAL\*\*|\$\{VALUE\}|%V|\{value\}|VALUE)$/i;

export function copperLayersOf(board: Board): CopperLayer[] {
  const n = board.stackup?.layers ?? 2;
  if (n >= 6) return ['top', 'in1', 'in2', 'in3', 'in4', 'bottom'];
  if (n >= 4) return ['top', 'in1', 'in2', 'bottom'];
  return ['top', 'bottom'];
}

/* -------------------------------------------- hit grid ------------------------------------------ */

export type HitKind = 'pad' | 'via' | 'trace' | 'comp' | 'hole';

export interface HitEntry {
  kind: HitKind;
  i: number;
  seg: number;
  box: BBox2;
}

export class HitGrid {
  readonly cell: number;
  readonly x0: number;
  readonly y0: number;
  readonly nx: number;
  readonly ny: number;
  private cells: HitEntry[][];

  constructor(box: BBox2, approxCells = 4096) {
    const w = Math.max(1, box.maxX - box.minX);
    const h = Math.max(1, box.maxY - box.minY);
    this.cell = Math.max(0.5, Math.sqrt((w * h) / approxCells));
    this.x0 = box.minX - this.cell;
    this.y0 = box.minY - this.cell;
    this.nx = Math.ceil(w / this.cell) + 3;
    this.ny = Math.ceil(h / this.cell) + 3;
    this.cells = Array.from({ length: this.nx * this.ny }, () => []);
  }

  insert(e: HitEntry) {
    const i0 = Math.max(0, Math.floor((e.box.minX - this.x0) / this.cell));
    const i1 = Math.min(this.nx - 1, Math.floor((e.box.maxX - this.x0) / this.cell));
    const j0 = Math.max(0, Math.floor((e.box.minY - this.y0) / this.cell));
    const j1 = Math.min(this.ny - 1, Math.floor((e.box.maxY - this.y0) / this.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.cells[j * this.nx + i].push(e);
  }

  query(x: number, y: number): HitEntry[] {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((y - this.y0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return [];
    return this.cells[j * this.nx + i];
  }
}

/* -------------------------------------------- build -------------------------------------------- */

function graphicsToSilk(
  graphics: Graphic[],
  layer: 'silk' | 'courtyard',
  ci: ComponentInstance,
  compIndex: number,
  ref: string,
  strokes: Map<number, Path2D>,
  fills: Path2D,
  texts: SilkText[],
): boolean {
  let hadRef = false;
  const bottom = ci.side === 'bottom';
  const rot = ci.rotation || 0;
  const tp = (p: Vec2) => footprintToBoard(ci, p);
  const strokePath = (w: number) => {
    const key = Math.round(w * 1000) / 1000;
    let p = strokes.get(key);
    if (!p) {
      p = new Path2D();
      strokes.set(key, p);
    }
    return p;
  };
  for (const g of graphics) {
    if (g.layer !== layer) continue;
    switch (g.kind) {
      case 'line': {
        const a = tp(g.a);
        const b = tp(g.b);
        const p = strokePath(g.width);
        p.moveTo(a[0], a[1]);
        p.lineTo(b[0], b[1]);
        break;
      }
      case 'polyline': {
        if (g.points.length < 2) break;
        const pts = g.points.map(tp);
        if (g.fill && g.closed !== false && pts.length >= 3) polyPath(pts, fills);
        const p = strokePath(g.width);
        p.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
        if (g.closed) p.closePath();
        break;
      }
      case 'circle': {
        const c = tp(g.c);
        if (g.fill) addCircle(fills, c[0], c[1], g.r + g.width / 2);
        else {
          const p = strokePath(g.width);
          addCircle(p, c[0], c[1], g.r);
        }
        break;
      }
      case 'arc': {
        const c = tp(g.c);
        let s = g.start;
        let e = g.end;
        if (bottom) {
          const s2 = 180 - e;
          e = 180 - s;
          s = s2;
        }
        s += rot;
        e += rot;
        const p = strokePath(g.width);
        p.moveTo(c[0] + g.r * Math.cos(s * DEG), c[1] + g.r * Math.sin(s * DEG));
        p.arc(c[0], c[1], g.r, s * DEG, e * DEG, false);
        break;
      }
      case 'text': {
        if (VALUE_PLACEHOLDER.test(g.text.trim())) break;
        const isRef = REF_PLACEHOLDER.test(g.text.trim());
        if (isRef) hadRef = true;
        const at = tp(g.at);
        const local = g.rotation ?? 0;
        const textRot = bottom ? rot - local : rot + local;
        texts.push({ x: at[0], y: at[1], size: g.size, rot: textRot, mirror: bottom, text: isRef ? ref : g.text, comp: compIndex });
        break;
      }
    }
  }
  return hadRef;
}

function stagedPositions(board: Board, parts: Record<string, PartDef>, outlineBox: BBox2): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  const unplaced = board.components.filter((c) => !c.placed);
  if (!unplaced.length) return out;
  const width = Math.max(30, outlineBox.maxX - outlineBox.minX);
  let x = outlineBox.minX;
  let y = outlineBox.minY - 6;
  let rowH = 0;
  for (const c of unplaced) {
    const fp = parts[c.partId]?.footprint;
    const body = parts[c.partId]?.body;
    const w = fp ? fp.courtyard.maxX - fp.courtyard.minX : (body?.w ?? 2);
    const h = fp ? fp.courtyard.maxY - fp.courtyard.minY : (body?.l ?? 2);
    if (x + w > outlineBox.minX + width && x > outlineBox.minX) {
      x = outlineBox.minX;
      y -= rowH + 2;
      rowH = 0;
    }
    const cxLocal = fp ? (fp.courtyard.minX + fp.courtyard.maxX) / 2 : 0;
    const cyLocal = fp ? (fp.courtyard.minY + fp.courtyard.maxY) / 2 : 0;
    out.set(c.id, [x + w / 2 - cxLocal, y - h / 2 - cyLocal]);
    x += w + 2;
    rowH = Math.max(rowH, h);
  }
  return out;
}

export function buildPcbScene(board: Board, parts: Record<string, PartDef>): PcbScene {
  const copperLayerList = copperLayersOf(board);
  const nets = new Map<string, SceneNet>();
  for (const n of board.nets) nets.set(n.id, { net: n, cls: n.class ?? guessNetClass(n.name) });

  /* outline */
  const hasOutline = (board.outline?.length ?? 0) >= 3;
  const outlinePath = new Path2D();
  let bbox = emptyBox();
  if (hasOutline) {
    polyPath(board.outline, outlinePath);
    bbox = polygonBBox(board.outline);
  }
  for (const cut of board.cutouts ?? []) if (cut.length >= 3) polyPath(cut, outlinePath);

  /* components & pads */
  const comps: SceneComp[] = [];
  const pads: ScenePad[] = [];
  const padPaths: Record<PadSide, Path2D> = { top: new Path2D(), bottom: new Path2D(), through: new Path2D(), npth: new Path2D() };
  const padDrills = new Path2D();
  const stagedPaths = { pads: new Path2D(), courtyards: new Path2D(), drills: new Path2D() };
  const silkStrokes = { top: new Map<number, Path2D>(), bottom: new Map<number, Path2D>() };
  const silkFills = { top: new Path2D(), bottom: new Path2D() };
  const silkTexts: { top: SilkText[]; bottom: SilkText[] } = { top: [], bottom: [] };
  const courtyardPaths = { top: new Path2D(), bottom: new Path2D() };
  const courtStrokes = { top: new Map<number, Path2D>(), bottom: new Map<number, Path2D>() };

  // Provisional box for staging unplaced parts.
  const provisional = validBox(bbox) ? bbox : { minX: 0, minY: 0, maxX: 50, maxY: 50 };
  const staged = stagedPositions(board, parts, provisional);
  let stagedBox: BBox2 | null = null;

  board.components.forEach((comp, ci) => {
    const part = parts[comp.partId];
    const fp = part?.footprint;
    const st = staged.get(comp.id);
    const placedAs: ComponentInstance = st ? { ...comp, x: st[0], y: st[1], rotation: 0, side: 'top' } : comp;
    const side: 'top' | 'bottom' = placedAs.side === 'bottom' ? 'bottom' : 'top';
    let courtyard: Vec2[];
    if (fp) courtyard = componentCourtyard(placedAs, fp);
    else {
      const w = part?.body?.w ?? 2;
      const l = part?.body?.l ?? 2;
      courtyard = [
        [-w / 2, -l / 2],
        [w / 2, -l / 2],
        [w / 2, l / 2],
        [-w / 2, l / 2],
      ].map((p) => footprintToBoard(placedAs, p as Vec2));
    }
    const cbox = polygonBBox(courtyard);
    const courtyardPath = polyPath(courtyard);
    if (st) stagedPaths.courtyards.addPath(courtyardPath);
    else courtyardPaths[side].addPath(courtyardPath);
    const sc: SceneComp = {
      i: ci,
      comp,
      placedAs,
      part,
      fp,
      courtyard,
      courtyardPath,
      bbox: cbox,
      center: [(cbox.minX + cbox.maxX) / 2, (cbox.minY + cbox.maxY) / 2],
      fabRef: { x: 0, y: 0, size: 1, rot: 0 },
      staged: !!st,
      pads: [],
    };
    if (st) stagedBox = stagedBox ? unionBox(stagedBox, cbox) : { ...cbox };
    // Fab reference: centred, sized to fit the courtyard, along the longer axis.
    {
      const lw = fp ? fp.courtyard.maxX - fp.courtyard.minX : (part?.body?.w ?? 2);
      const lh = fp ? fp.courtyard.maxY - fp.courtyard.minY : (part?.body?.l ?? 2);
      const along = lw >= lh * 0.9 ? 0 : 90;
      const long = along === 0 ? lw : lh;
      const short = along === 0 ? lh : lw;
      const size = Math.max(0.25, Math.min(short * 0.5, (long * 0.85) / Math.max(1.5, comp.ref.length * 0.8), 2.2));
      let rot = (placedAs.rotation || 0) + along;
      rot = ((rot % 360) + 360) % 360;
      sc.fabRef = { x: sc.center[0], y: sc.center[1], size, rot };
    }
    comps.push(sc);

    if (fp) {
      const pinByNumber = new Map(part?.pins.map((p) => [p.number, p]) ?? []);
      const pp = placedPads(placedAs, fp);
      for (const p of pp) {
        const pad: PadDef = p.pad;
        const padSide: PadSide = pad.kind === 'npth' ? 'npth' : pad.kind === 'tht' ? 'through' : side;
        const path = polyPath(p.polygon);
        const pbox = polygonBBox(p.polygon);
        let drill: ScenePad['drill'] = null;
        if (pad.kind !== 'smd' && (pad.drill || pad.slot)) {
          const w = pad.slot?.w ?? pad.drill ?? 0;
          const h = pad.slot?.h ?? pad.drill ?? 0;
          const rot = (placedAs.rotation || 0) + (placedAs.side === 'bottom' ? -(pad.rotation || 0) : pad.rotation || 0);
          drill = { x: p.x, y: p.y, w, h, rot };
          addSlot(st ? stagedPaths.drills : padDrills, p.x, p.y, w, h, rot);
        }
        if (st) stagedPaths.pads.addPath(path);
        else if (padSide !== 'npth') padPaths[padSide].addPath(path);
        const pin = pinByNumber.get(pad.number);
        const sp: ScenePad = {
          i: pads.length,
          comp: ci,
          number: pad.number,
          pinName: pin?.name,
          pinType: pin?.type,
          netId: comp.pinNets[pad.number],
          side: padSide,
          poly: p.polygon,
          path,
          x: p.x,
          y: p.y,
          bbox: pbox,
          drill,
        };
        sc.pads.push(sp.i);
        pads.push(sp);
      }
      if (st) return;
      const hadRef = graphicsToSilk(fp.graphics, 'silk', placedAs, ci, comp.ref, silkStrokes[side], silkFills[side], silkTexts[side]);
      graphicsToSilk(fp.graphics, 'courtyard', placedAs, ci, comp.ref, courtStrokes[side], new Path2D(), []);
      if (!hadRef) {
        // Default refdes: above the courtyard (board frame), small parts; centred for large bodies.
        const w = cbox.maxX - cbox.minX;
        const h = cbox.maxY - cbox.minY;
        const big = w > 4.5 && h > 4.5;
        const size = big ? Math.min(1.2, Math.min(w, h) * 0.18) : Math.max(0.6, Math.min(1.0, Math.max(w, h) * 0.3));
        silkTexts[side].push({
          x: sc.center[0],
          y: big ? sc.center[1] : cbox.maxY + size * 0.95,
          size,
          rot: 0,
          mirror: side === 'bottom',
          text: comp.ref,
          comp: ci,
        });
      }
    }
  });

  /* traces */
  const copper: Partial<Record<CopperLayer, CopperLayerData>> = {};
  for (const l of copperLayerList) copper[l] = { layer: l, traceGroups: [], traces: [], zones: [] };
  const traceById = new Map<string, number>();
  const groupMaps = new Map<CopperLayer, Map<number, Path2D>>();
  board.traces.forEach((t, ti) => {
    traceById.set(t.id, ti);
    const layerData = copper[t.layer] ?? (copper[t.layer] = { layer: t.layer, traceGroups: [], traces: [], zones: [] });
    layerData.traces.push(ti);
    if (t.points.length < 2) return;
    let gm = groupMaps.get(t.layer);
    if (!gm) groupMaps.set(t.layer, (gm = new Map()));
    const key = Math.round(t.width * 1000) / 1000;
    let path = gm.get(key);
    if (!path) gm.set(key, (path = new Path2D()));
    path.moveTo(t.points[0][0], t.points[0][1]);
    for (let i = 1; i < t.points.length; i++) path.lineTo(t.points[i][0], t.points[i][1]);
  });
  for (const [layer, gm] of groupMaps) {
    copper[layer]!.traceGroups = [...gm.entries()].sort((a, b) => b[0] - a[0]).map(([width, path]) => ({ width, path }));
  }

  /* zones */
  for (const z of board.zones) {
    const layerData = copper[z.layer] ?? (copper[z.layer] = { layer: z.layer, traceGroups: [], traces: [], zones: [] });
    let fill: Path2D | null = null;
    if (z.fill?.length) {
      fill = new Path2D();
      for (const ring of z.fill) if (ring.length >= 3) polyPath(ring, fill);
    }
    const outlinePts = z.outline?.length ? z.outline : null;
    layerData.zones.push({ zone: z, fill, outline: outlinePts ? polyPath(outlinePts) : null });
  }
  for (const l of Object.values(copper)) l!.zones.sort((a, b) => (a.zone.priority ?? 0) - (b.zone.priority ?? 0));

  /* vias & holes */
  const viaRings = new Path2D();
  const viaDrills = new Path2D();
  for (const v of board.vias) {
    addCircle(viaRings, v.x, v.y, v.diameter / 2);
    addCircle(viaDrills, v.x, v.y, v.drill / 2);
  }
  const holeRings = new Path2D();
  const holeDrills = new Path2D();
  for (const h of board.holes) {
    if (h.plated) addCircle(holeRings, h.x, h.y, (h.padDiameter ?? h.drill * 1.8) / 2);
    addCircle(holeDrills, h.x, h.y, h.drill / 2);
  }

  /* content box */
  let contentBox = validBox(bbox) ? { ...bbox } : emptyBox();
  for (const c of comps) contentBox = unionBox(contentBox, c.bbox);
  for (const t of board.traces) for (const p of t.points) growBox(contentBox, p[0], p[1], t.width);
  if (!validBox(contentBox)) contentBox = { minX: 0, minY: 0, maxX: 50, maxY: 50 };
  if (!validBox(bbox)) {
    const placedBox = emptyBox();
    for (const c of comps) if (!c.staged) Object.assign(placedBox, unionBox(placedBox, c.bbox));
    bbox = validBox(placedBox) ? placedBox : { ...contentBox };
  }

  /* hit index */
  const hit = new HitGrid(contentBox, Math.min(16384, Math.max(1024, board.traces.length * 2)));
  pads.forEach((p) => hit.insert({ kind: 'pad', i: p.i, seg: -1, box: p.bbox }));
  board.vias.forEach((v, i) => {
    const r = v.diameter / 2;
    hit.insert({ kind: 'via', i, seg: -1, box: { minX: v.x - r, minY: v.y - r, maxX: v.x + r, maxY: v.y + r } });
  });
  board.traces.forEach((t, ti) => {
    const hw = t.width / 2 + 0.3;
    for (let s = 0; s + 1 < t.points.length; s++) {
      const a = t.points[s];
      const b = t.points[s + 1];
      hit.insert({
        kind: 'trace',
        i: ti,
        seg: s,
        box: { minX: Math.min(a[0], b[0]) - hw, minY: Math.min(a[1], b[1]) - hw, maxX: Math.max(a[0], b[0]) + hw, maxY: Math.max(a[1], b[1]) + hw },
      });
    }
  });
  board.holes.forEach((h, i) => {
    const r = (h.padDiameter ?? h.drill) / 2;
    hit.insert({ kind: 'hole', i, seg: -1, box: { minX: h.x - r, minY: h.y - r, maxX: h.x + r, maxY: h.y + r } });
  });
  comps.forEach((c) => hit.insert({ kind: 'comp', i: c.i, seg: -1, box: c.bbox }));

  const toStrokeList = (m: Map<number, Path2D>) => [...m.entries()].map(([width, path]) => ({ width, path }));
  const courtyardTop = courtyardPaths.top;
  for (const g of courtStrokes.top.values()) courtyardTop.addPath(g);
  for (const g of courtStrokes.bottom.values()) courtyardPaths.bottom.addPath(g);

  const netGeomCache = new Map<string, NetGeometry>();
  const haloCache = new Map<string, HaloGeometry>();

  const scene: PcbScene = {
    board,
    parts,
    bbox,
    contentBox,
    outlinePath,
    outlineRing: hasOutline ? board.outline : [],
    hasOutline,
    copperLayers: copperLayerList,
    copper,
    pads,
    padPaths,
    padDrills,
    staged: stagedPaths,
    vias: board.vias,
    viaRings,
    viaDrills,
    holes: board.holes,
    holeRings,
    holeDrills,
    silk: {
      top: { strokes: toStrokeList(silkStrokes.top), fills: silkFills.top, texts: silkTexts.top },
      bottom: { strokes: toStrokeList(silkStrokes.bottom), fills: silkFills.bottom, texts: silkTexts.bottom },
    },
    courtyard: courtyardPaths,
    comps,
    compById: new Map(comps.map((c) => [c.comp.id, c])),
    traceById,
    nets,
    stagedBox,
    hit,
    netGeometry(netId: string): NetGeometry {
      const hitG = netGeomCache.get(netId);
      if (hitG) return hitG;
      const groups = new Map<string, { layer: CopperLayer; width: number; path: Path2D }>();
      for (const t of board.traces) {
        if (t.netId !== netId || t.points.length < 2) continue;
        const key = `${t.layer}|${t.width}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { layer: t.layer, width: t.width, path: new Path2D() }));
        g.path.moveTo(t.points[0][0], t.points[0][1]);
        for (let i = 1; i < t.points.length; i++) g.path.lineTo(t.points[i][0], t.points[i][1]);
      }
      const padsBySide: Partial<Record<PadSide, Path2D>> = {};
      for (const p of pads) {
        if (p.netId !== netId || comps[p.comp].staged) continue;
        (padsBySide[p.side] ??= new Path2D()).addPath(p.path);
      }
      const vias = new Path2D();
      let hasVias = false;
      for (const v of board.vias) {
        if (v.netId !== netId) continue;
        addCircle(vias, v.x, v.y, v.diameter / 2);
        hasVias = true;
      }
      const zones: NetGeometry['zones'] = [];
      for (const l of Object.values(copper)) {
        for (const z of l!.zones) if (z.zone.netId === netId && z.fill) zones.push({ layer: l!.layer, path: z.fill });
      }
      const g: NetGeometry = { traces: [...groups.values()], pads: padsBySide, vias, zones, hasVias };
      netGeomCache.set(netId, g);
      return g;
    },
    haloGeometry(layer: CopperLayer, netId: string, clearance: number): HaloGeometry {
      const key = `${layer}|${netId}|${clearance}`;
      const hitH = haloCache.get(key);
      if (hitH) return hitH;
      const groups = new Map<number, Path2D>();
      for (const t of board.traces) {
        if (t.layer !== layer || t.netId === netId || t.points.length < 2) continue;
        const w = Math.round((t.width + 2 * clearance) * 1000) / 1000;
        let p = groups.get(w);
        if (!p) groups.set(w, (p = new Path2D()));
        p.moveTo(t.points[0][0], t.points[0][1]);
        for (let i = 1; i < t.points.length; i++) p.lineTo(t.points[i][0], t.points[i][1]);
      }
      const padPath = new Path2D();
      const isOuter = layer === 'top' || layer === 'bottom';
      for (const p of pads) {
        if (comps[p.comp].staged || (p.netId === netId && p.netId)) continue;
        if (p.side === 'npth' || p.side === 'through' || (isOuter && p.side === layer)) padPath.addPath(p.path);
      }
      for (const p of pads) {
        if (p.side === 'npth' && p.drill && !comps[p.comp].staged) addSlot(padPath, p.drill.x, p.drill.y, p.drill.w + clearance * 2, p.drill.h + clearance * 2, p.drill.rot);
      }
      const viaPath = new Path2D();
      for (const v of board.vias) if (v.netId !== netId) addCircle(viaPath, v.x, v.y, v.diameter / 2 + clearance);
      for (const h of board.holes) if (h.netId !== netId || !h.plated) addCircle(viaPath, h.x, h.y, (h.plated ? (h.padDiameter ?? h.drill * 1.8) : h.drill) / 2 + clearance);
      const g: HaloGeometry = { traces: [...groups.entries()].map(([width, path]) => ({ width, path })), pads: padPath, vias: viaPath };
      haloCache.set(key, g);
      return g;
    },
  };
  return scene;
}

/* --------------------------------------------- picking ------------------------------------------ */

export type PcbHit =
  | { kind: 'pad'; pad: ScenePad; comp: SceneComp }
  | { kind: 'via'; via: Via; index: number }
  | { kind: 'trace'; trace: Trace; index: number; segment: number }
  | { kind: 'hole'; hole: MountingHole; index: number }
  | { kind: 'comp'; comp: SceneComp }
  | { kind: 'zone'; zone: Zone; layer: CopperLayer };

function distToPoly(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) best = Math.min(best, pointSegmentDistance(p, poly[j], poly[i]));
  return best;
}

function inEvenOdd(p: Vec2, rings: Vec2[][]): boolean {
  let inside = false;
  for (const r of rings) if (r.length >= 3 && pointInPolygon(p, r)) inside = !inside;
  return inside;
}

/**
 * Topmost item under board point (x, y). `tol` (mm) widens thin targets so hairline traces stay
 * hoverable when zoomed out.
 */
export function pickPcb(
  scene: PcbScene,
  x: number,
  y: number,
  opts: { tol: number; side: 'top' | 'bottom'; layerVisible: (l: CopperLayer) => boolean; padsOtherSide: boolean; zones: boolean },
): PcbHit | null {
  const p: Vec2 = [x, y];
  const cand = scene.hit.query(x, y);
  const facing = opts.side;
  let bestPad: { pad: ScenePad; d: number; rank: number } | null = null;
  let bestVia: { i: number; d: number } | null = null;
  let bestTrace: { i: number; seg: number; d: number; rank: number } | null = null;
  let bestHole: number | null = null;
  let bestComp: { c: SceneComp; area: number; rank: number } | null = null;
  const layerRank = (l: CopperLayer) => (l === facing ? 0 : l === 'top' || l === 'bottom' ? 2 : 1);
  for (const e of cand) {
    switch (e.kind) {
      case 'pad': {
        const pad = scene.pads[e.i];
        const rank = pad.side === facing || pad.side === 'through' || pad.side === 'npth' ? 0 : 1;
        if (rank === 1 && !opts.padsOtherSide) break;
        if (pad.side === 'top' || pad.side === 'bottom') {
          if (!opts.layerVisible(pad.side)) break;
        }
        const inside = pointInPolygon(p, pad.poly);
        const d = inside ? 0 : distToPoly(p, pad.poly);
        if (d <= opts.tol * 0.6 && (!bestPad || rank < bestPad.rank || (rank === bestPad.rank && d < bestPad.d))) bestPad = { pad, d, rank };
        break;
      }
      case 'via': {
        const v = scene.vias[e.i];
        const d = Math.hypot(x - v.x, y - v.y) - v.diameter / 2;
        if (d <= opts.tol * 0.6 && (!bestVia || d < bestVia.d)) bestVia = { i: e.i, d };
        break;
      }
      case 'trace': {
        const t = scene.board.traces[e.i];
        if (!opts.layerVisible(t.layer)) break;
        const d = pointSegmentDistance(p, t.points[e.seg], t.points[e.seg + 1]) - t.width / 2;
        const rank = layerRank(t.layer);
        if (d <= opts.tol && (!bestTrace || rank < bestTrace.rank || (rank === bestTrace.rank && d < bestTrace.d))) bestTrace = { i: e.i, seg: e.seg, d, rank };
        break;
      }
      case 'hole': {
        const h = scene.holes[e.i];
        if (Math.hypot(x - h.x, y - h.y) <= (h.padDiameter ?? h.drill) / 2 + opts.tol * 0.5) bestHole = e.i;
        break;
      }
      case 'comp': {
        const c = scene.comps[e.i];
        if (!pointInPolygon(p, c.courtyard)) break;
        const rank = c.placedAs.side === facing ? 0 : 1;
        const area = (c.bbox.maxX - c.bbox.minX) * (c.bbox.maxY - c.bbox.minY);
        if (!bestComp || rank < bestComp.rank || (rank === bestComp.rank && area < bestComp.area)) bestComp = { c, area, rank };
        break;
      }
    }
  }
  if (bestPad && bestPad.rank === 0) return { kind: 'pad', pad: bestPad.pad, comp: scene.comps[bestPad.pad.comp] };
  if (bestVia) return { kind: 'via', via: scene.vias[bestVia.i], index: bestVia.i };
  if (bestTrace && bestTrace.rank === 0) return { kind: 'trace', trace: scene.board.traces[bestTrace.i], index: bestTrace.i, segment: bestTrace.seg };
  if (bestPad) return { kind: 'pad', pad: bestPad.pad, comp: scene.comps[bestPad.pad.comp] };
  if (bestTrace) return { kind: 'trace', trace: scene.board.traces[bestTrace.i], index: bestTrace.i, segment: bestTrace.seg };
  if (bestHole !== null) return { kind: 'hole', hole: scene.holes[bestHole], index: bestHole };
  if (bestComp) return { kind: 'comp', comp: bestComp.c };
  if (opts.zones) {
    const order: CopperLayer[] = [facing, ...scene.copperLayers.filter((l) => l !== facing)];
    for (const l of order) {
      if (!opts.layerVisible(l)) continue;
      const zones = scene.copper[l]?.zones ?? [];
      for (let i = zones.length - 1; i >= 0; i--) {
        const z = zones[i].zone;
        if (z.fill?.length && inEvenOdd(p, z.fill)) return { kind: 'zone', zone: z, layer: l };
      }
    }
  }
  return null;
}

/** Rotate helper re-export for renderers. */
export { rotate2 };
