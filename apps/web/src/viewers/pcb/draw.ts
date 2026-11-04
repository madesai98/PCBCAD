import type { CopperLayer, DesignIssue, PcbThermalResult, Stackup, Vec2 } from '@pcbcad/core';
import { DEG, toFloat32, toUint8 } from '@pcbcad/core';
import { mix, withAlpha } from '../common/color';
import { colormapCss, colormapLUT } from '../common/colormaps';
import type { ViewerTheme } from '../common/theme';
import type { RatsnestEdge } from './ratsnest';
import type { PcbScene, SilkText } from './scene';

/* ------------------------------------------------------------------------------------------------
 * Canvas2D PCB renderer. Pure function of (scene, viewport, state) so the same code draws the
 * interactive PcbView and the 3D board textures.
 * ---------------------------------------------------------------------------------------------- */

export type PcbMode = 'realistic' | 'layers';
export type PcbLayerKey = 'top' | 'bottom' | 'inner' | 'silk' | 'mask' | 'courtyard' | 'ratsnest' | 'zones' | 'holes';
export type PcbLayerVisibility = Record<PcbLayerKey, boolean>;

export const DEFAULT_PCB_LAYERS: PcbLayerVisibility = {
  top: true,
  bottom: true,
  inner: true,
  silk: true,
  mask: true,
  courtyard: false,
  ratsnest: true,
  zones: true,
  holes: true,
};

/** Board → device-pixel affine map: X = a·x + e, Y = d·y + f (d < 0 for Y-up boards). */
export interface PcbViewport {
  a: number;
  d: number;
  e: number;
  f: number;
  /** Canvas size in device pixels. */
  width: number;
  height: number;
  dpr: number;
}

export interface ThermalImage {
  canvas: HTMLCanvasElement;
  x0: number;
  y0: number;
  w: number;
  h: number;
  min: number;
  max: number;
}

export interface CurrentOverlay {
  buckets: { color: string; groups: { width: number; path: Path2D }[] }[];
  warn: { width: number; path: Path2D }[];
  fail: { width: number; path: Path2D }[];
  maxDensity: number;
}

export interface IssueMarker {
  id: string;
  x: number;
  y: number;
  severity: DesignIssue['severity'];
  issue: DesignIssue;
}

export interface PcbDrawState {
  mode: PcbMode;
  layers: PcbLayerVisibility;
  /** Side facing the viewer. */
  side: 'top' | 'bottom';
  theme: ViewerTheme;
  /** Draw the canvas background, dot grid and board shadow (off for textures). */
  background: boolean;
  selected?: ReadonlySet<string>;
  highlightNet?: string | null;
  hoverNet?: string | null;
  hoverComp?: string | null;
  thermal?: ThermalImage | null;
  /** Thermal-only texture variant: heatmap fully opaque, no labels. */
  thermalOpaque?: boolean;
  thermalLabels?: { x: number; y: number; text: string; t: number }[];
  currents?: CurrentOverlay | null;
  issues?: IssueMarker[] | null;
  hoverIssue?: string | null;
  ratsnest?: RatsnestEdge[] | null;
  /** Off-screen buffer provider for zone clearance carving. */
  buffer?: () => CanvasRenderingContext2D | null;
}

/* -------------------------------------------- palettes ------------------------------------------ */

const MASK_COLORS: Record<Stackup['maskColor'], string> = {
  green: '#0f5a34',
  black: '#17191c',
  blue: '#123f86',
  red: '#8a1b1b',
  white: '#e6e9e4',
  purple: '#47206f',
  yellow: '#c4a312',
};

export interface RealisticPalette {
  mask: string;
  substrate: string;
  copperUnderMask: string;
  copperEdge: string;
  bareCopper: string;
  finish: string;
  finishEdge: string;
  opening: string;
  silk: string;
  hole: string;
  edge: string;
  courtyard: string;
}

export function realisticPalette(stackup: Stackup | undefined): RealisticPalette {
  const maskColor = stackup?.maskColor ?? 'green';
  const mask = MASK_COLORS[maskColor] ?? MASK_COLORS.green;
  const light = maskColor === 'white' || maskColor === 'yellow';
  const finish = stackup?.finish === 'ENIG' ? '#d8b25a' : stackup?.finish === 'OSP' ? '#cf8748' : '#c9cdd3';
  return {
    mask,
    substrate: '#b9a36a',
    copperUnderMask: light ? mix(mask, '#c98a44', 0.16) : maskColor === 'black' ? mix(mask, '#9a8a6a', 0.14) : mix(mask, '#d6c36a', 0.27),
    copperEdge: light ? mix(mask, '#000000', 0.08) : mix(mask, '#000000', 0.18),
    bareCopper: '#c77b3e',
    finish,
    finishEdge: mix(finish, '#000000', 0.25),
    opening: light ? mix(mask, '#8a7a50', 0.35) : mix(mask, '#000000', 0.38),
    silk: stackup?.silkColor === 'black' ? '#151515' : '#f4f4ef',
    hole: '#0b0c0e',
    edge: light ? mix(mask, '#000000', 0.3) : mix(mask, '#ffffff', 0.22),
    courtyard: '#ff4fd8',
  };
}

export interface LayersPalette {
  copper: Record<CopperLayer, string>;
  pad: Record<'top' | 'bottom', string>;
  through: string;
  via: string;
  hole: string;
  silkTop: string;
  silkBottom: string;
  courtTop: string;
  courtBottom: string;
  edge: string;
  boardFill: string;
  mask: string;
  fab: string;
}

export function layersPalette(theme: ViewerTheme): LayersPalette {
  return theme.dark
    ? {
        copper: { top: '#d0403f', bottom: '#4381da', in1: '#c9b93a', in2: '#3dbd6c', in3: '#b462cc', in4: '#47c0c0' },
        pad: { top: '#e7615f', bottom: '#5d97ea' },
        through: '#d8b04a',
        via: '#c4c8ce',
        hole: '#0a0b0d',
        silkTop: '#eee8a6',
        silkBottom: '#e4a99c',
        courtTop: '#ff4fd8',
        courtBottom: '#4fe2ff',
        edge: '#e6d84a',
        boardFill: 'rgba(255,255,255,0.025)',
        mask: '#c77dff',
        fab: '#9aa3ae',
      }
    : {
        copper: { top: '#d23c3c', bottom: '#2c6cc9', in1: '#a69400', in2: '#1f9a4f', in3: '#9440b0', in4: '#14949a' },
        pad: { top: '#e2504f', bottom: '#3d7fe0' },
        through: '#c1951e',
        via: '#6f7781',
        hole: '#2a2e35',
        silkTop: '#6f6400',
        silkBottom: '#a4503f',
        courtTop: '#c31aa4',
        courtBottom: '#0f8fae',
        edge: '#a08700',
        boardFill: 'rgba(15,23,42,0.035)',
        mask: '#8a3fd1',
        fab: '#6b7480',
      };
}

/* ------------------------------------------ prepared data ---------------------------------------- */

/** Heatmap image for a PcbThermalResult layer (cells outside the mask are dilated so bilinear filtering never bleeds). */
export function buildThermalImage(result: PcbThermalResult, layer: 'top' | 'bottom' = 'top'): ThermalImage | null {
  const { nx, ny, x0, y0, dx, dy } = result.grid;
  if (!(nx > 0 && ny > 0) || typeof document === 'undefined') return null;
  const entry = result.layers.find((l) => l.layer === layer) ?? result.layers[0];
  if (!entry) return null;
  const temps = toFloat32(entry.temperature);
  const n = nx * ny;
  if (temps.length < n) return null;
  const maskArr = toUint8(result.mask as never);
  const hasMask = maskArr.length >= n;
  let min = Infinity;
  let max = -Infinity;
  const vals = new Float32Array(n);
  const known = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  for (let i = 0; i < n; i++) {
    if (!hasMask || maskArr[i]) {
      const t = temps[i];
      if (Number.isFinite(t)) {
        vals[i] = t;
        known[i] = 1;
        queue[qt++] = i;
        if (t < min) min = t;
        if (t > max) max = t;
      }
    }
  }
  if (!Number.isFinite(min)) return null;
  // BFS dilation into unknown cells.
  while (qh < qt) {
    const i = queue[qh++];
    const ix = i % nx;
    const iy = (i - ix) / nx;
    const nb = [ix > 0 ? i - 1 : -1, ix < nx - 1 ? i + 1 : -1, iy > 0 ? i - nx : -1, iy < ny - 1 ? i + nx : -1];
    for (const j of nb) {
      if (j < 0 || known[j]) continue;
      known[j] = 1;
      vals[j] = vals[i];
      queue[qt++] = j;
    }
  }
  if (max - min < 1e-6) max = min + 1;
  const lo = Math.min(min, result.ambient);
  const canvas = document.createElement('canvas');
  canvas.width = nx;
  canvas.height = ny;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(nx, ny);
  const lut = colormapLUT('turbo', 256);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = vals[j * nx + i];
      const k = Math.max(0, Math.min(255, Math.round(((v - lo) / (max - lo)) * 255)));
      const o = (j * nx + i) * 4;
      img.data[o] = lut[k * 3];
      img.data[o + 1] = lut[k * 3 + 1];
      img.data[o + 2] = lut[k * 3 + 2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, x0, y0, w: nx * dx, h: ny * dy, min: lo, max };
}

/** Trace segments coloured by current density (turbo) with warn/fail glow paths. */
export function buildCurrentOverlay(scene: PcbScene, result: PcbThermalResult): CurrentOverlay | null {
  if (!result.traces?.length) return null;
  let maxDensity = 0;
  for (const t of result.traces) if (t.currentDensity > maxDensity) maxDensity = t.currentDensity;
  if (!(maxDensity > 0)) maxDensity = 1;
  const N = 24;
  const buckets: Map<number, Path2D>[] = Array.from({ length: N }, () => new Map());
  const warn = new Map<number, Path2D>();
  const fail = new Map<number, Path2D>();
  const add = (m: Map<number, Path2D>, w: number, a: Vec2, b: Vec2) => {
    let p = m.get(w);
    if (!p) m.set(w, (p = new Path2D()));
    p.moveTo(a[0], a[1]);
    p.lineTo(b[0], b[1]);
  };
  for (const e of result.traces) {
    const ti = scene.traceById.get(e.traceId);
    if (ti === undefined) continue;
    const tr = scene.board.traces[ti];
    const segs = e.segment >= 0 && e.segment + 1 < tr.points.length ? [e.segment] : tr.points.slice(1).map((_, i) => i);
    const k = Math.min(N - 1, Math.max(0, Math.floor((e.currentDensity / maxDensity) * N)));
    for (const s of segs) {
      add(buckets[k], tr.width, tr.points[s], tr.points[s + 1]);
      if (e.status === 'warn') add(warn, tr.width, tr.points[s], tr.points[s + 1]);
      if (e.status === 'fail') add(fail, tr.width, tr.points[s], tr.points[s + 1]);
    }
  }
  const toList = (m: Map<number, Path2D>) => [...m.entries()].map(([width, path]) => ({ width, path }));
  return {
    buckets: buckets.map((m, i) => ({ color: colormapCss('turbo', 0.08 + (0.92 * (i + 0.5)) / N), groups: toList(m) })),
    warn: toList(warn),
    fail: toList(fail),
    maxDensity,
  };
}

/** Resolve issue locations on this board (explicit `at`, else component / trace / net centroid). */
export function buildIssueMarkers(scene: PcbScene, issues: DesignIssue[] | undefined | null): IssueMarker[] {
  if (!issues?.length) return [];
  const out: IssueMarker[] = [];
  for (const issue of issues) {
    if (issue.target?.boardId && issue.target.boardId !== scene.board.id) continue;
    let pos: Vec2 | null = null;
    if (issue.at && issue.at.length >= 2) pos = [issue.at[0], issue.at[1]];
    else if (issue.target?.componentIds?.length) {
      const c = scene.compById.get(issue.target.componentIds[0]);
      if (c) pos = c.center;
    } else if (issue.target?.traceIds?.length) {
      const ti = scene.traceById.get(issue.target.traceIds[0]);
      if (ti !== undefined) {
        const pts = scene.board.traces[ti].points;
        const m = Math.floor((pts.length - 1) / 2);
        pos = [(pts[m][0] + pts[m + 1 < pts.length ? m + 1 : m][0]) / 2, (pts[m][1] + pts[m + 1 < pts.length ? m + 1 : m][1]) / 2];
      }
    } else if (issue.target?.netIds?.length) {
      const pads = scene.pads.filter((p) => p.netId === issue.target!.netIds![0]);
      if (pads.length) pos = [pads.reduce((s, p) => s + p.x, 0) / pads.length, pads.reduce((s, p) => s + p.y, 0) / pads.length];
    }
    if (pos) out.push({ id: issue.id, x: pos[0], y: pos[1], severity: issue.severity, issue });
  }
  return out;
}

/* --------------------------------------------- helpers ------------------------------------------ */

function setBoard(ctx: CanvasRenderingContext2D, vp: PcbViewport) {
  ctx.setTransform(vp.a, 0, 0, vp.d, vp.e, vp.f);
}

function strokeGroups(ctx: CanvasRenderingContext2D, groups: { width: number; path: Path2D }[], color: string, extra = 0, minPx = 0, scale = 1) {
  ctx.strokeStyle = color;
  for (const g of groups) {
    ctx.lineWidth = Math.max(g.width + extra, minPx / scale);
    ctx.stroke(g.path);
  }
}

const gridTiles = new Map<string, CanvasPattern | null>();

function drawDotGrid(ctx: CanvasRenderingContext2D, vp: PcbViewport, theme: ViewerTheme) {
  const scale = Math.abs(vp.a);
  const steps = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250];
  const minPx = 18 * vp.dpr;
  const step = steps.find((s) => s * scale >= minPx) ?? 250;
  const stepPx = Math.max(4, Math.round(step * scale));
  const dot = Math.max(1, Math.round(vp.dpr));
  const color = theme.dark ? 'rgba(255,255,255,0.075)' : 'rgba(15,23,42,0.11)';
  const key = `${stepPx}|${dot}|${color}`;
  let pat = gridTiles.get(key);
  if (pat === undefined) {
    const tile = document.createElement('canvas');
    tile.width = stepPx;
    tile.height = stepPx;
    const tctx = tile.getContext('2d');
    if (tctx) {
      tctx.fillStyle = color;
      tctx.fillRect(0, 0, dot, dot);
    }
    pat = ctx.createPattern(tile, 'repeat');
    if (gridTiles.size > 64) gridTiles.clear();
    gridTiles.set(key, pat);
  }
  if (!pat) return;
  const ox = (((vp.e % stepPx) + stepPx) % stepPx) - dot / 2;
  const oy = (((vp.f % stepPx) + stepPx) % stepPx) - dot / 2;
  pat.setTransform(new DOMMatrix([1, 0, 0, 1, ox, oy]));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, vp.width, vp.height);
}

/** Draw a silk/fab text with a screen-space font size (crisp at any zoom), keeping it upright. */
function drawText(
  ctx: CanvasRenderingContext2D,
  vp: PcbViewport,
  t: { x: number; y: number; size: number; rot: number; mirror?: boolean; text: string },
  font: string,
  minPx: number,
  weight = 600,
): boolean {
  const scale = Math.abs(vp.a);
  const px = (t.size / 0.72) * scale;
  if (px < minPx) return false;
  const sx = vp.a * t.x + vp.e;
  const sy = vp.d * t.y + vp.f;
  const th = t.rot * DEG;
  const sa = Math.sign(vp.a);
  const sd = Math.sign(vp.d);
  // Screen-space baseline (u) and glyph-down (v) unit vectors. Bottom-side text is mirrored in the
  // footprint frame (g = -u); combined with a mirrored view it becomes readable, as on real boards.
  const m = t.mirror ? -1 : 1;
  let gx = m * sa * Math.cos(th);
  let gy = m * sd * Math.sin(th);
  let vx = sa * Math.sin(th);
  let vy = -sd * Math.cos(th);
  // Keep upright: never render glyphs upside down (rotate 180° instead).
  const upX = -vx;
  const upY = -vy;
  if (upY > 0.01 || (Math.abs(upY) <= 0.01 && upX > 0)) {
    gx = -gx;
    gy = -gy;
    vx = -vx;
    vy = -vy;
  }
  ctx.setTransform(gx, gy, vx, vy, sx, sy);
  ctx.font = `${weight} ${px.toFixed(2)}px ${font}`;
  ctx.fillText(t.text, 0, 0);
  return true;
}

/** Fill `paint` into an offscreen buffer, carve `carve` with destination-out, composite onto ctx. */
function withCarvedLayer(
  ctx: CanvasRenderingContext2D,
  vp: PcbViewport,
  st: PcbDrawState,
  alpha: number,
  paint: (b: CanvasRenderingContext2D) => void,
  carve: (b: CanvasRenderingContext2D) => void,
) {
  const b = st.buffer?.();
  if (!b) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    paint(ctx);
    ctx.restore();
    return;
  }
  b.save();
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalCompositeOperation = 'source-over';
  b.clearRect(0, 0, vp.width, vp.height);
  setBoard(b, vp);
  paint(b);
  b.globalCompositeOperation = 'destination-out';
  b.fillStyle = '#000';
  b.strokeStyle = '#000';
  carve(b);
  b.restore();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= alpha;
  ctx.drawImage(b.canvas, 0, 0);
  ctx.restore();
}

function drawZones(ctx: CanvasRenderingContext2D, scene: PcbScene, vp: PcbViewport, st: PcbDrawState, layer: CopperLayer, color: string, alpha: number) {
  const data = scene.copper[layer];
  if (!data?.zones.length) return;
  const scale = Math.abs(vp.a);
  for (const z of data.zones) {
    if (!z.fill) {
      // Unfilled zone: hatched outline.
      if (!z.outline) continue;
      ctx.save();
      ctx.strokeStyle = withAlpha(color, 0.7);
      ctx.lineWidth = 1.2 / scale;
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.stroke(z.outline);
      ctx.restore();
      continue;
    }
    const halo = scene.haloGeometry(layer, z.zone.netId, Math.max(0.1, z.zone.clearance || scene.board.rules?.clearance || 0.2));
    withCarvedLayer(
      ctx,
      vp,
      st,
      alpha,
      (b) => {
        b.fillStyle = color;
        b.fill(z.fill!, 'evenodd');
      },
      (b) => {
        b.lineCap = 'round';
        b.lineJoin = 'round';
        for (const g of halo.traces) {
          b.lineWidth = g.width;
          b.stroke(g.path);
        }
        const c = Math.max(0.1, z.zone.clearance || 0.2);
        b.lineWidth = c * 2;
        b.fill(halo.pads);
        b.stroke(halo.pads);
        b.fill(halo.vias);
      },
    );
  }
}

/* ---------------------------------------------- draw -------------------------------------------- */

export function drawPcb(ctx: CanvasRenderingContext2D, scene: PcbScene, vp: PcbViewport, st: PcbDrawState) {
  const theme = st.theme;
  const scale = Math.abs(vp.a);
  const px = 1 / scale; // board units per device pixel
  const L = st.layers;
  const facing = st.side;
  const far: 'top' | 'bottom' = facing === 'top' ? 'bottom' : 'top';
  const outline = scene.outlinePath;
  const fontMono = theme.fontMono;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (st.background) {
    ctx.fillStyle = theme.canvas;
    ctx.fillRect(0, 0, vp.width, vp.height);
    drawDotGrid(ctx, vp, theme);
  } else {
    ctx.clearRect(0, 0, vp.width, vp.height);
  }

  const realistic = st.mode === 'realistic';
  const rp = realisticPalette(scene.board.stackup);
  const lp = layersPalette(theme);
  const layerOn = (l: CopperLayer) => (l === 'top' ? L.top : l === 'bottom' ? L.bottom : L.inner);

  /* board body (+ shadow) */
  setBoard(ctx, vp);
  if (scene.hasOutline) {
    if (st.background) {
      ctx.save();
      ctx.shadowColor = theme.dark ? 'rgba(0,0,0,0.55)' : 'rgba(15,23,42,0.22)';
      ctx.shadowBlur = 28 * vp.dpr;
      ctx.shadowOffsetY = 8 * vp.dpr;
      ctx.fillStyle = realistic ? (L.mask ? rp.mask : rp.substrate) : theme.canvas;
      ctx.fill(outline, 'evenodd');
      ctx.restore();
    }
    ctx.save();
    ctx.clip(outline, 'evenodd');
  } else {
    ctx.save();
  }

  if (realistic) {
    /* ------------------------------------ realistic ------------------------------------ */
    const base = L.mask ? rp.mask : rp.substrate;
    const copperCol = L.mask ? rp.copperUnderMask : rp.bareCopper;
    if (scene.hasOutline) {
      ctx.fillStyle = base;
      ctx.fill(outline, 'evenodd');
    }
    if (layerOn(facing)) {
      if (L.zones) drawZones(ctx, scene, vp, st, facing, copperCol, 1);
      const groups = scene.copper[facing]?.traceGroups ?? [];
      if (L.mask) strokeGroups(ctx, groups, rp.copperEdge, 0.07, 0, scale);
      strokeGroups(ctx, groups, copperCol, 0, 0, scale);
      // Tented vias read as small copper rings under the mask.
      ctx.fillStyle = copperCol;
      ctx.fill(scene.viaRings);
    }
    if (L.silk) drawSilk(ctx, scene, vp, facing, rp.silk, fontMono);
    // Exposed pads (mask openings) with surface finish.
    const padPath = scene.padPaths[facing];
    if (L.mask) {
      ctx.strokeStyle = rp.opening;
      ctx.lineWidth = 0.1;
      ctx.stroke(padPath);
      ctx.stroke(scene.padPaths.through);
      ctx.stroke(scene.holeRings);
    }
    const finish = L.mask ? rp.finish : rp.bareCopper;
    ctx.fillStyle = finish;
    ctx.fill(padPath);
    ctx.fill(scene.padPaths.through);
    ctx.fill(scene.holeRings);
    ctx.strokeStyle = withAlpha(rp.finishEdge, 0.55);
    ctx.lineWidth = Math.min(0.03, px);
    ctx.stroke(padPath);
    if (!L.mask) {
      ctx.fillStyle = rp.bareCopper;
      ctx.fill(scene.viaRings);
    }
    if (L.holes) {
      ctx.fillStyle = rp.hole;
      ctx.fill(scene.padDrills);
      ctx.fill(scene.viaDrills);
      ctx.fill(scene.holeDrills);
    }
    if (L.courtyard) {
      ctx.strokeStyle = withAlpha(lp.courtTop, 0.85);
      ctx.lineWidth = 1.1 * px * vp.dpr;
      ctx.stroke(scene.courtyard[facing]);
    }
  } else {
    /* ------------------------------------- layers ------------------------------------- */
    if (scene.hasOutline) {
      ctx.fillStyle = lp.boardFill;
      ctx.fill(outline, 'evenodd');
    }
    const order = facing === 'top' ? [...scene.copperLayers].reverse() : [...scene.copperLayers];
    for (const l of order) {
      if (!layerOn(l)) continue;
      const col = lp.copper[l];
      if (L.zones) drawZones(ctx, scene, vp, st, l, col, l === facing ? 0.2 : 0.12);
      strokeGroups(ctx, scene.copper[l]?.traceGroups ?? [], col, 0, 0, scale);
      if (l === 'top' || l === 'bottom') {
        ctx.fillStyle = lp.pad[l];
        ctx.fill(scene.padPaths[l]);
      }
    }
    if (L.top || L.bottom || L.inner) {
      ctx.fillStyle = lp.through;
      ctx.fill(scene.padPaths.through);
      ctx.fill(scene.holeRings);
      ctx.fillStyle = lp.via;
      ctx.fill(scene.viaRings);
    }
    if (L.mask) {
      ctx.strokeStyle = withAlpha(lp.mask, 0.55);
      ctx.lineWidth = Math.max(0.1, 1.2 * px);
      ctx.stroke(scene.padPaths[facing]);
      ctx.stroke(scene.padPaths.through);
    }
    if (L.holes) {
      ctx.fillStyle = lp.hole;
      ctx.fill(scene.padDrills);
      ctx.fill(scene.viaDrills);
      ctx.fill(scene.holeDrills);
    }
    if (L.silk) {
      drawSilk(ctx, scene, vp, far, withAlpha(far === 'top' ? lp.silkTop : lp.silkBottom, 0.75), fontMono);
      drawSilk(ctx, scene, vp, facing, facing === 'top' ? lp.silkTop : lp.silkBottom, fontMono);
    }
    if (L.courtyard) {
      ctx.lineWidth = 1.1 * px * vp.dpr;
      ctx.strokeStyle = withAlpha(far === 'top' ? lp.courtTop : lp.courtBottom, 0.6);
      ctx.stroke(scene.courtyard[far]);
      ctx.strokeStyle = facing === 'top' ? lp.courtTop : lp.courtBottom;
      ctx.stroke(scene.courtyard[facing]);
    }
    // Fab-style reference labels centred on bodies (when silkscreen is hidden).
    if (!L.silk) {
      ctx.fillStyle = theme.dark ? 'rgba(230,233,239,0.62)' : 'rgba(15,23,42,0.62)';
      for (const c of scene.comps) {
        if (c.staged || !c.pads.length) continue;
        if (c.placedAs.side !== facing && !(c.placedAs.side === far && (far === 'top' ? L.top : L.bottom))) continue;
        drawText(ctx, vp, { ...c.fabRef, text: c.comp.ref }, fontMono, 6 * vp.dpr, 600);
      }
    }
    setBoard(ctx, vp);
  }
  ctx.restore(); // clip

  /* board edge */
  setBoard(ctx, vp);
  if (scene.hasOutline) {
    ctx.strokeStyle = realistic ? rp.edge : lp.edge;
    ctx.lineWidth = (realistic ? 1.0 : 1.4) * px * vp.dpr;
    ctx.stroke(outline);
  }

  /* staged (unplaced) components */
  if (scene.stagedBox) {
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = theme.dark ? '#5b6472' : '#9aa3b2';
    ctx.fill(scene.staged.pads);
    ctx.fillStyle = realistic ? rp.hole : lp.hole;
    ctx.fill(scene.staged.drills);
    ctx.setLineDash([4 * px * vp.dpr, 3 * px * vp.dpr]);
    ctx.lineWidth = px * vp.dpr;
    ctx.strokeStyle = theme.textDim;
    ctx.stroke(scene.staged.courtyards);
    ctx.setLineDash([]);
    ctx.fillStyle = theme.textDim;
    for (const c of scene.comps) if (c.staged) drawText(ctx, vp, { ...c.fabRef, text: c.comp.ref }, fontMono, 7 * vp.dpr, 600);
    ctx.restore();
    setBoard(ctx, vp);
    const sb = scene.stagedBox;
    const lx = vp.a * sb.minX + vp.e;
    const ly = vp.d * sb.maxY + vp.f;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.textDim;
    ctx.font = `500 ${11 * vp.dpr}px ${theme.fontSans}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('Unplaced', Math.min(lx, vp.a < 0 ? vp.a * sb.maxX + vp.e : lx), ly - 6 * vp.dpr);
    ctx.restore();
    setBoard(ctx, vp);
  }

  /* ------------------------------------------- overlays ------------------------------------------- */

  if (st.thermal) {
    const th = st.thermal;
    ctx.save();
    if (scene.hasOutline) ctx.clip(outline, 'evenodd');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = st.thermalOpaque ? 0.92 : 0.84;
    ctx.drawImage(th.canvas, th.x0, th.y0, th.w, th.h);
    ctx.globalAlpha = 1;
    // Context: pads + courtyards faintly on top.
    ctx.strokeStyle = 'rgba(255,255,255,0.33)';
    ctx.lineWidth = 0.8 * px * vp.dpr;
    ctx.stroke(scene.courtyard[facing]);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fill(scene.padPaths[facing]);
    ctx.fill(scene.padPaths.through);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill(scene.holeDrills);
    ctx.restore();
    if (!st.thermalOpaque && st.thermalLabels?.length) drawThermalLabels(ctx, vp, st);
    setBoard(ctx, vp);
  }

  if (st.currents) {
    const cur = st.currents;
    ctx.save();
    if (scene.hasOutline) {
      ctx.fillStyle = withAlpha(theme.canvas, 0.62);
      ctx.fill(outline, 'evenodd');
    }
    const minW = 1.6 * vp.dpr;
    ctx.globalAlpha = 0.55;
    strokeGroups(ctx, cur.fail, theme.fail, 0.5, minW + 4 * vp.dpr, scale);
    strokeGroups(ctx, cur.warn, theme.warn, 0.4, minW + 3 * vp.dpr, scale);
    ctx.globalAlpha = 1;
    for (const b of cur.buckets) strokeGroups(ctx, b.groups, b.color, 0, minW, scale);
    ctx.restore();
  }

  if (L.ratsnest && st.ratsnest?.length) {
    ctx.save();
    ctx.lineWidth = 1.1 * px * vp.dpr;
    ctx.strokeStyle = theme.dark ? 'rgba(236,240,245,0.78)' : 'rgba(15,23,42,0.62)';
    const hl = st.highlightNet ?? st.hoverNet;
    const p = new Path2D();
    const ph = new Path2D();
    for (const r of st.ratsnest) {
      const target = r.netId === hl ? ph : p;
      target.moveTo(r.from[0], r.from[1]);
      target.lineTo(r.to[0], r.to[1]);
    }
    ctx.stroke(p);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 2 * px * vp.dpr;
    ctx.stroke(ph);
    // endpoints
    ctx.fillStyle = ctx.strokeStyle;
    ctx.restore();
  }

  /* net highlight (external, with dimming) */
  if (st.highlightNet) {
    if (scene.hasOutline) {
      ctx.fillStyle = withAlpha(theme.canvas, theme.dark ? 0.6 : 0.55);
      ctx.fill(outline, 'evenodd');
    }
    drawNet(ctx, scene, vp, st, st.highlightNet, theme.accent, 1, true);
  }
  if (st.hoverNet && st.hoverNet !== st.highlightNet) drawNet(ctx, scene, vp, st, st.hoverNet, theme.accentSoft, 0.55, false);

  /* selection / hover component */
  if (st.selected?.size) {
    ctx.save();
    for (const id of st.selected) {
      const c = scene.compById.get(id);
      if (!c) continue;
      ctx.fillStyle = withAlpha(theme.accent, 0.16);
      ctx.fill(c.courtyardPath);
      ctx.shadowColor = theme.accent;
      ctx.shadowBlur = 10 * vp.dpr;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2 * px * vp.dpr;
      ctx.stroke(c.courtyardPath);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }
  if (st.hoverComp && !st.selected?.has(st.hoverComp)) {
    const c = scene.compById.get(st.hoverComp);
    if (c) {
      ctx.save();
      ctx.fillStyle = withAlpha(theme.accentSoft, 0.08);
      ctx.fill(c.courtyardPath);
      ctx.strokeStyle = withAlpha(theme.accentSoft, 0.9);
      ctx.lineWidth = 1.3 * px * vp.dpr;
      ctx.setLineDash([4 * px * vp.dpr, 3 * px * vp.dpr]);
      ctx.stroke(c.courtyardPath);
      ctx.restore();
    }
  }

  /* issue markers (screen space) */
  if (st.issues?.length) drawIssues(ctx, vp, st);

  ctx.restore();
}

function drawSilk(ctx: CanvasRenderingContext2D, scene: PcbScene, vp: PcbViewport, side: 'top' | 'bottom', color: string, font: string) {
  const silk = scene.silk[side];
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  for (const g of silk.strokes) {
    ctx.lineWidth = g.width;
    ctx.stroke(g.path);
  }
  ctx.fill(silk.fills);
  const minPx = 4.5 * vp.dpr;
  for (const t of silk.texts) drawText(ctx, vp, t as SilkText, font, minPx, 700);
  setBoard(ctx, vp);
}

function drawNet(ctx: CanvasRenderingContext2D, scene: PcbScene, vp: PcbViewport, st: PcbDrawState, netId: string, color: string, alpha: number, glow: boolean) {
  const g = scene.netGeometry(netId);
  const scale = Math.abs(vp.a);
  ctx.save();
  setBoard(ctx, vp);
  ctx.globalAlpha = alpha;
  if (glow) {
    ctx.shadowColor = withAlpha(color, 0.8);
    ctx.shadowBlur = 8 * vp.dpr;
  }
  for (const z of g.zones) {
    ctx.fillStyle = withAlpha(color, 0.18);
    ctx.fill(z.path, 'evenodd');
  }
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const t of g.traces) {
    const onFacing = t.layer === st.side;
    ctx.globalAlpha = alpha * (onFacing ? 1 : 0.7);
    ctx.lineWidth = Math.max(t.width, (1.5 * vp.dpr) / scale);
    ctx.stroke(t.path);
  }
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (const p of Object.values(g.pads)) if (p) ctx.fill(p);
  if (g.hasVias) ctx.fill(g.vias);
  ctx.restore();
}

function drawThermalLabels(ctx: CanvasRenderingContext2D, vp: PcbViewport, st: PcbDrawState) {
  const labels = st.thermalLabels ?? [];
  const theme = st.theme;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `600 ${10.5 * vp.dpr}px ${theme.fontMono}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const l of labels) {
    const sx = vp.a * l.x + vp.e;
    const sy = vp.d * l.y + vp.f;
    const w = ctx.measureText(l.text).width + 14 * vp.dpr;
    const h = 18 * vp.dpr;
    const x = sx + 8 * vp.dpr;
    const y = sy - h - 6 * vp.dpr;
    ctx.fillStyle = 'rgba(10,12,15,0.82)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 5 * vp.dpr);
    ctx.fill();
    ctx.fillStyle = colormapCss('turbo', l.t);
    ctx.beginPath();
    ctx.arc(x + 7 * vp.dpr, y + h / 2, 3 * vp.dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(l.text, x + 13 * vp.dpr, y + h / 2 + 0.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = vp.dpr;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(x, y + h);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(sx, sy, 2.2 * vp.dpr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawIssues(ctx: CanvasRenderingContext2D, vp: PcbViewport, st: PcbDrawState) {
  const theme = st.theme;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const m of st.issues ?? []) {
    const sx = vp.a * m.x + vp.e;
    const sy = vp.d * m.y + vp.f;
    const col = m.severity === 'error' ? theme.fail : m.severity === 'warning' ? theme.warn : theme.info;
    const hover = st.hoverIssue === m.id;
    const r = (hover ? 11 : 9) * vp.dpr;
    ctx.beginPath();
    ctx.arc(sx, sy, r + 5 * vp.dpr, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(col, hover ? 0.22 : 0.14);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.lineWidth = 2 * vp.dpr;
    ctx.strokeStyle = col;
    ctx.fillStyle = withAlpha('#000000', 0.35);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.font = `800 ${11 * vp.dpr}px ${theme.fontSans}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(m.severity === 'info' ? 'i' : '!', sx, sy + 0.5 * vp.dpr);
  }
  ctx.restore();
}

/** Small helper for thermal labels: hottest powered components. */
export function thermalLabelsFor(scene: PcbScene, result: PcbThermalResult, image: ThermalImage | null, count = 4): PcbDrawState['thermalLabels'] {
  if (!image) return [];
  const comps = [...result.components].filter((c) => c.power > 0).sort((a, b) => b.tJunction - a.tJunction).slice(0, count);
  const out: NonNullable<PcbDrawState['thermalLabels']> = [];
  for (const c of comps) {
    const sc = scene.compById.get(c.componentId);
    if (!sc) continue;
    out.push({ x: sc.center[0], y: sc.center[1], text: `${c.ref} ${c.tJunction.toFixed(1)}°C`, t: (c.tJunction - image.min) / Math.max(1e-6, image.max - image.min) });
  }
  return out;
}
