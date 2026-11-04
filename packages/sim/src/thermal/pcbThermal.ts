import type { CopperLayer, Grid2, PartDef, PcbThermalResult, Project, Vec2 } from '@pcbcad/core';
import { componentCourtyard, pack, placedPads, polygonArea, polygonBBox, rotate2 } from '@pcbcad/core';
import { forcedConvectionH, mixedConvectionH, naturalConvectionH, radiationFlux, radiationH } from './convection';
import { GridMultigrid, type GridSystem } from './gridSolver';
import { buildBoardNetwork, type BoardNetwork } from './network';
import { caseToBoardTheta, defaultThetaJC } from './packageThermal';
import { CoverageRaster, addPadShape, addRing, centreMask, makeGrid, windowGrid } from './raster';
import { barrelAreaMm2, copperConductivity, dielectricConductivity, layerCopperMm, layerZ, stackLayers, viaSpan } from './stackup';
import { analyzeNetworks, netsWithCurrent, type CopperLoss, type TraceCurrentResult } from './traceCurrents';

/**
 * Steady-state PCB conduction model (see README.md for the full model description and limits).
 *
 *  - Uniform grid over the board bbox, cells whose centre lies outside the outline / in a cutout
 *    or mounting hole are masked out.
 *  - M nodes per cell: 'lumped' (default) → a top and a bottom node, inner copper layers lumped
 *    into the nearer node; 'resolved' → one node per copper layer.
 *  - In-plane sheet conductance of node m in a cell: k_in·t_FR4,m + Σ k_Cu·t_Cu,l·f_l (f = copper
 *    area fraction of layer l in the cell, rasterised from pads, traces, vias, zone fills);
 *    harmonic mean between neighbouring cells.
 *  - Through-plane: k_z·A/Δz between consecutive nodes, plus k_Cu·A_barrel/Δz for every plated
 *    barrel (vias, THT pads, plated holes) in the cell.
 *  - Faces: natural/forced convection (+ linearised radiation, ε = 0.9) on the top node (top
 *    face) and bottom node (bottom face); board side faces convect/radiate from all nodes of edge
 *    cells. Air (convection & radiation sink) = enclosureAirTemp ?? ambient.
 *  - Sources: component power spread over its pad copper on its side (courtyard if no pads),
 *    trace/via/plane Joule heating from the DC current solution when pinCurrents are given
 *    (re-evaluated with the local copper temperature every outer iteration).
 *  - Outer fixed-point iterations update h (from the face mean rise), the per-cell radiative
 *    coefficient and the Joule heating; each inner solve is MG-preconditioned CG to 1e-8.
 */

export interface PcbThermalOptions {
  /** Dissipated power per component (W), keyed by component id (falls back to ref). Negative values are ignored. */
  power: Record<string, number>;
  /** Current INTO each component pin (A): component id (or ref) → pin number → A. Enables trace Joule heating and the trace/IR-drop report. */
  pinCurrents?: Record<string, Record<string, number>>;
  /** Ambient temperature (°C). Default: project.settings.ambientC, else 25. */
  ambient?: number;
  /**
   * Convection model. natural (default): plate correlations iterated with the face mean rise.
   * forced: laminar/turbulent flat-plate correlation, flow along board X at `airVelocity` m/s
   * (default 1), combined with natural convection as (h_f³ + h_n³)^⅓. hTop/hBottom override the
   * CONVECTIVE coefficient of that face (W/m²K); radiation is still added unless emissivity = 0.
   */
  convection?: { mode: 'natural' | 'forced'; airVelocity?: number; hTop?: number; hBottom?: number };
  /** Board orientation for natural convection. 'vertical' assumes board +Y points up. Default 'horizontal' (top face up). */
  orientation?: 'horizontal' | 'vertical';
  /** Grid cell size (mm). Default max(0.4, maxDim/150). */
  resolution?: number;
  /** Air temperature around the board inside an enclosure (°C); replaces ambient as the convection and radiation sink. */
  enclosureAirTemp?: number;
  /** Surface emissivity of both faces (default 0.9, solder mask). 0 disables radiation. */
  emissivity?: number;
  /**
   * Treatment of 4/6-layer boards. 'lumped': top + bottom node per cell, inner copper lumped into
   * the nearer node (fast, but optimistic when heat must cross the outer prepreg into an inner
   * plane without thermal vias). 'resolved': one node per copper layer. 'auto' (default):
   * resolved unless that exceeds 400k unknowns. 2-layer boards always use 2 nodes.
   */
  innerLayers?: 'auto' | 'lumped' | 'resolved';
  /** Board side faces: 'convective' (default, same h as the faces' mean + radiation) or 'adiabatic' (e.g. clamped in card guides). */
  edges?: 'convective' | 'adiabatic';
}

export type PcbThermalComponent = PcbThermalResult['components'][number];

export interface PcbThermalComponentReport extends PcbThermalComponent {
  /** Junction-to-case resistance used (°C/W): part.thermal.thetaJC or package default. */
  thetaJC: number;
  /** Case-to-board (solder joint) resistance used (°C/W). */
  thetaCB: number;
  /** Stand-alone estimate airTemp + P·θJA when the part has thetaJA (°C). */
  tJunctionThetaJA?: number;
}

export interface PcbThermalReport extends PcbThermalResult {
  convection: PcbThermalResult['convection'] & {
    /** Area-mean linearised radiative coefficients (W/m²K). */
    hRadTop: number;
    hRadBottom: number;
    /** Characteristic length used by the correlations (mm). */
    lengthScale: number;
    orientation: 'horizontal' | 'vertical';
  };
  components: PcbThermalComponentReport[];
  traces: TraceCurrentResult['traces'];
  /** Air temperature used as convection/radiation sink (°C). */
  airTemp: number;
  /** Energy balance of the final solution (W): heat in vs. convective + radiative loss (exact σT⁴). */
  heatBalance: { input: number; convection: number; radiation: number; relativeError: number };
  solver: { unknowns: number; nodesPerCell: number; iterations: number; outerIterations: number; residual: number; converged: boolean; ms: number };
  warnings: string[];
}

interface ComponentRec {
  id: string;
  ref: string;
  part?: PartDef;
  power: number;
  node: number;
  cells: Int32Array;
  w: Float64Array;
  padArea: number;
}

const MAX_CELLS = 1.5e6;
const MAX_RESOLVED_UNKNOWNS = 400_000;
const MAX_OUTER = 8;
/** Relative residual of the final linear solve. */
const FINAL_TOL = 1e-8;

function finiteOr(v: number | undefined, d: number): number {
  return v !== undefined && Number.isFinite(v) ? v : d;
}

function perimeter(poly: Vec2[]): number {
  let p = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) p += Math.hypot(poly[i][0] - poly[j][0], poly[i][1] - poly[j][1]);
  return p;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Steady-state temperature field of a board, component junction temperatures and (optionally)
 * trace currents with Joule heating.
 *
 * @param project  project (parts library + boards)
 * @param boardId  board to analyse
 * @param opts     see {@link PcbThermalOptions}
 * @returns the contract PcbThermalResult plus diagnostics (heat balance, solver stats, warnings)
 * @throws when the board does not exist or has no usable outline
 */
export function simulatePcbThermal(project: Project, boardId: string, opts: PcbThermalOptions): PcbThermalReport {
  const t0 = nowMs();
  const board = project.boards.find((b) => b.id === boardId);
  if (!board) throw new Error(`simulatePcbThermal: board '${boardId}' not found`);
  if (!board.outline || board.outline.length < 3) throw new Error(`simulatePcbThermal: board '${board.name}' has no outline`);
  const warnings: string[] = [];
  const parts = project.parts ?? {};
  const ambient = finiteOr(opts.ambient, finiteOr(project.settings?.ambientC, 25));
  const tAir = finiteOr(opts.enclosureAirTemp, ambient);
  const eps = Math.min(1, Math.max(0, finiteOr(opts.emissivity, 0.9)));
  const orientation = opts.orientation ?? 'horizontal';
  const convMode = opts.convection?.mode ?? 'natural';
  const airVelocity = Math.max(0, finiteOr(opts.convection?.airVelocity, 1));
  const hTopOverride = opts.convection?.hTop;
  const hBotOverride = opts.convection?.hBottom;
  const stack = board.stackup;
  const layers = stackLayers(stack);
  const tB = stack.thickness > 0 ? stack.thickness : 1.6;
  const { kIn, kZ } = dielectricConductivity(stack);
  const kCu = copperConductivity();

  /* --------------------------------------------- grid --------------------------------------------- */
  const bb = polygonBBox(board.outline);
  const W = bb.maxX - bb.minX;
  const H = bb.maxY - bb.minY;
  if (!(W > 0 && H > 0)) throw new Error(`simulatePcbThermal: board '${board.name}' outline is degenerate`);
  let res = finiteOr(opts.resolution, Math.max(0.4, Math.max(W, H) / 150));
  if (!(res > 0)) res = Math.max(0.4, Math.max(W, H) / 150);
  if ((W / res) * (H / res) > MAX_CELLS) {
    const r2 = Math.sqrt((W * H) / MAX_CELLS);
    warnings.push(`Resolution ${res} mm would need ${Math.round((W / res) * (H / res))} cells; coarsened to ${r2.toFixed(3)} mm`);
    res = r2;
  }
  const grid: Grid2 = makeGrid(bb, res);
  const { nx, ny, x0, y0, dx, dy } = grid;
  const NC = nx * ny;
  const holes = board.holes.filter((h) => h.drill > 0).map((h) => ({ x: h.x, y: h.y, r: h.drill / 2 }));
  const mask = centreMask(grid, [board.outline, ...(board.cutouts ?? [])], holes);
  const cellOf = new Int32Array(NC).fill(-1);
  let n = 0;
  for (let k = 0; k < NC; k++) if (mask[k]) cellOf[k] = n++;
  if (n === 0) throw new Error(`simulatePcbThermal: board '${board.name}' covers no grid cell at ${res} mm resolution`);
  const cellArea = dx * dy * 1e-6; // m²

  /* ------------------------------------------ node layout ------------------------------------------ */
  const mode = opts.innerLayers ?? 'auto';
  let resolved = layers.length > 2 && mode !== 'lumped';
  if (resolved && mode === 'auto' && n * layers.length > MAX_RESOLVED_UNKNOWNS) {
    resolved = false;
    warnings.push(`inner copper layers lumped into the top/bottom nodes (${n * layers.length} unknowns would exceed the resolved-model budget); use a coarser resolution or innerLayers: 'resolved' for full accuracy`);
  }
  const groups: CopperLayer[][] = resolved ? layers.map((l) => [l]) : [layers.slice(0, layers.length / 2), layers.slice(layers.length / 2)];
  const M = groups.length;
  const nodeOf = new Map<CopperLayer, number>();
  groups.forEach((g, m) => g.forEach((l) => nodeOf.set(l, m)));
  const z = layerZ(stack);
  const dz: number[] = []; // mm between node m and m+1
  const fr4Share: number[] = []; // mm of dielectric conducting in-plane with node m
  if (!resolved) {
    dz.push(tB);
    fr4Share.push(tB / 2, tB / 2);
  } else {
    for (let m = 0; m + 1 < M; m++) dz.push(Math.max(1e-3, (z[layers[m]] ?? 0) - (z[layers[m + 1]] ?? 0)));
    for (let m = 0; m < M; m++) fr4Share.push((m > 0 ? dz[m - 1] / 2 : 0) + (m < M - 1 ? dz[m] / 2 : 0));
  }
  const Mz = M - 1;

  /* --------------------------------------- copper coverage --------------------------------------- */
  let wMin = Infinity;
  for (const t of board.traces) if (t.width > 0 && t.width < wMin) wMin = t.width;
  if (!Number.isFinite(wMin)) wMin = 0.25;
  const sub = Math.min(24, Math.max(4, Math.ceil((4 * dy) / Math.max(wMin, 0.05))));
  const rasters = new Map<CopperLayer, CoverageRaster>();
  for (const l of layers) rasters.set(l, new CoverageRaster(grid, sub));
  const inner = layers.filter((l) => l !== 'top' && l !== 'bottom');
  const barrels: { x: number; y: number; drill: number; span: CopperLayer[] }[] = [];
  for (const comp of board.components) {
    if (!comp.placed) continue;
    const fp = parts[comp.partId]?.footprint;
    if (!fp) continue;
    for (const pp of placedPads(comp, fp)) {
      if (pp.pad.kind === 'npth') continue;
      for (const l of pp.layers) {
        if (l === 'inner') inner.forEach((il) => addPadShape(rasters.get(il)!, pp));
        else {
          const r = rasters.get(l);
          if (r) addPadShape(r, pp);
        }
      }
      if (pp.pad.kind === 'tht') {
        const d = pp.pad.slot ? (pp.pad.slot.w + pp.pad.slot.h) / 2 : (pp.pad.drill ?? Math.min(pp.w, pp.h) * 0.6);
        barrels.push({ x: pp.x, y: pp.y, drill: d, span: layers });
      }
    }
  }
  for (const t of board.traces) {
    const r = rasters.get(t.layer);
    if (!r || !(t.width > 0)) continue;
    for (let k = 0; k + 1 < t.points.length; k++) r.addCapsule(t.points[k][0], t.points[k][1], t.points[k + 1][0], t.points[k + 1][1], t.width / 2);
    if (t.points.length === 1) r.addDisc(t.points[0][0], t.points[0][1], t.width / 2);
  }
  for (const v of board.vias) {
    const span = viaSpan(stack, v.from, v.to);
    for (const l of span) rasters.get(l)!.addDisc(v.x, v.y, v.diameter / 2);
    barrels.push({ x: v.x, y: v.y, drill: v.drill, span });
  }
  for (const h of board.holes) {
    if (!h.plated) continue;
    const r = (h.padDiameter ?? h.drill * 1.6) / 2;
    for (const l of layers) rasters.get(l)!.addDisc(h.x, h.y, r);
    barrels.push({ x: h.x, y: h.y, drill: h.drill, span: layers });
  }
  for (const zn of board.zones) {
    const r = rasters.get(zn.layer);
    if (!r) continue;
    const rings = zn.fill && zn.fill.length ? zn.fill : [zn.outline && zn.outline.length >= 3 ? zn.outline : board.outline];
    if (rings.length === 1) addRing(r, rings[0]);
    else r.addPolygon(rings);
  }
  const cov = new Map<CopperLayer, Float64Array>();
  for (const l of layers) cov.set(l, rasters.get(l)!.finish());
  rasters.clear();

  /* ------------------------------------------- couplings ------------------------------------------- */
  const K = new Float64Array(n * M);
  const tCu = layers.map((l) => {
    const t = layerCopperMm(stack, l) * 1e-3;
    return Number.isFinite(t) && t > 0 ? t : 0;
  });
  for (let k = 0; k < NC; k++) {
    const c = cellOf[k];
    if (c < 0) continue;
    for (let m = 0; m < M; m++) {
      let s = kIn * fr4Share[m] * 1e-3;
      for (const l of groups[m]) s += kCu * tCu[layers.indexOf(l)] * cov.get(l)![k];
      K[c * M + m] = s;
    }
  }
  const gE = new Float64Array(n * M);
  const gN = new Float64Array(n * M);
  const gZ = new Float64Array(n * Math.max(Mz, 0));
  const sumG = new Float64Array(n * M);
  const edgeLen = new Float64Array(n); // exposed side-face length per cell (mm); stays 0 for adiabatic edges
  const edgesConvect = opts.edges !== 'adiabatic';
  const rx = dy / dx;
  const ry = dx / dy;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = cellOf[j * nx + i];
      if (c < 0) continue;
      const e = i + 1 < nx ? cellOf[j * nx + i + 1] : -1;
      const t = j + 1 < ny ? cellOf[(j + 1) * nx + i] : -1;
      const w = i > 0 ? cellOf[j * nx + i - 1] : -1;
      const s = j > 0 ? cellOf[(j - 1) * nx + i] : -1;
      if (edgesConvect) {
        if (e < 0) edgeLen[c] += dy;
        if (w < 0) edgeLen[c] += dy;
        if (t < 0) edgeLen[c] += dx;
        if (s < 0) edgeLen[c] += dx;
      }
      for (let m = 0; m < M; m++) {
        const a = K[c * M + m];
        if (e >= 0) {
          const b = K[e * M + m];
          const g = ((2 * a * b) / (a + b)) * rx;
          gE[c * M + m] = g;
          sumG[c * M + m] += g;
          sumG[e * M + m] += g;
        }
        if (t >= 0) {
          const b = K[t * M + m];
          const g = ((2 * a * b) / (a + b)) * ry;
          gN[c * M + m] = g;
          sumG[c * M + m] += g;
          sumG[t * M + m] += g;
        }
      }
      for (let m = 0; m < Mz; m++) gZ[c * Mz + m] = (kZ * cellArea) / (dz[m] * 1e-3);
    }
  }
  // plated barrels (any net): copper conduction between the nodes they span
  const cellAt = (x: number, y: number): number => {
    const i = Math.floor((x - x0) / dx);
    const j = Math.floor((y - y0) / dy);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return -1;
    return cellOf[j * nx + i];
  };
  for (const b of barrels) {
    const c = cellAt(b.x, b.y);
    if (c < 0 || b.span.length < 2) continue;
    const Ab = barrelAreaMm2(b.drill) * 1e-6;
    if (!resolved) {
      const top = nodeOf.get(b.span[0])!;
      const bot = nodeOf.get(b.span[b.span.length - 1])!;
      if (top === bot) continue;
      const len = Math.max(1e-3, (z[b.span[0]] ?? tB) - (z[b.span[b.span.length - 1]] ?? 0));
      gZ[c] += (kCu * Ab) / (len * 1e-3);
    } else {
      for (let q = 0; q + 1 < b.span.length; q++) {
        const m = nodeOf.get(b.span[q])!;
        gZ[c * Mz + m] += (kCu * Ab) / (dz[m] * 1e-3);
      }
    }
  }
  for (let c = 0; c < n; c++)
    for (let m = 0; m < Mz; m++) {
      const g = gZ[c * Mz + m];
      sumG[c * M + m] += g;
      sumG[c * M + m + 1] += g;
    }

  /* ------------------------------------------ nearest cell ------------------------------------------ */
  const nearestActive = (x: number, y: number): number => {
    const i0 = Math.min(nx - 1, Math.max(0, Math.floor((x - x0) / dx)));
    const j0 = Math.min(ny - 1, Math.max(0, Math.floor((y - y0) / dy)));
    if (cellOf[j0 * nx + i0] >= 0) return cellOf[j0 * nx + i0];
    for (let r = 1; r < Math.max(nx, ny); r++) {
      let best = -1;
      let bd = Infinity;
      for (let j = j0 - r; j <= j0 + r; j++) {
        if (j < 0 || j >= ny) continue;
        for (let i = i0 - r; i <= i0 + r; i++) {
          if (i < 0 || i >= nx || (Math.abs(i - i0) !== r && Math.abs(j - j0) !== r)) continue;
          const c = cellOf[j * nx + i];
          if (c < 0) continue;
          const d = (i - i0) ** 2 + (j - j0) ** 2;
          if (d < bd) ((bd = d), (best = c));
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  };

  /* -------------------------------------------- sources -------------------------------------------- */
  const src = new Float64Array(n * M);
  const comps: ComponentRec[] = [];
  const knownKeys = new Set<string>();
  for (const b of project.boards) for (const c of b.components) knownKeys.add(c.id).add(c.ref);
  const unknown = Object.keys(opts.power ?? {}).filter((k) => !knownKeys.has(k));
  if (unknown.length) warnings.push(`power given for unknown component(s): ${unknown.slice(0, 8).join(', ')}${unknown.length > 8 ? ', …' : ''}`);
  const negative: string[] = [];
  for (const comp of board.components) {
    let P = finiteOr(opts.power?.[comp.id] ?? opts.power?.[comp.ref], 0);
    if (!comp.placed || comp.dnp) {
      if (P > 0) warnings.push(`${comp.ref}: ${P.toFixed(3)} W ignored (${comp.dnp ? 'DNP' : 'not placed'})`);
      continue;
    }
    if (P < 0) {
      if (P < -1e-3) negative.push(comp.ref);
      P = 0;
    }
    const part = parts[comp.partId];
    if (!part) warnings.push(`${comp.ref}: part '${comp.partId}' missing from the project library`);
    const fp = part?.footprint;
    const node = comp.side === 'bottom' ? M - 1 : 0;
    const shapes: Vec2[][] = [];
    const padShapes: ReturnType<typeof placedPads> = [];
    let padArea = 0;
    if (fp) {
      for (const pp of placedPads(comp, fp)) {
        if (pp.pad.kind === 'npth' || !(pp.layers.includes(comp.side) || pp.pad.kind === 'tht')) continue;
        shapes.push(pp.polygon);
        padShapes.push(pp);
        padArea += Math.abs(polygonArea(pp.polygon));
      }
      if (!shapes.length) shapes.push(componentCourtyard(comp, fp));
    } else {
      const bw = part?.body?.w ?? 2;
      const bl = part?.body?.l ?? 2;
      const corners: Vec2[] = [
        [-bw / 2, -bl / 2],
        [bw / 2, -bl / 2],
        [bw / 2, bl / 2],
        [-bw / 2, bl / 2],
      ];
      shapes.push(corners.map((p) => rotate2(p, comp.rotation || 0)).map((p) => [p[0] + comp.x, p[1] + comp.y] as Vec2));
    }
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (const s of shapes)
      for (const p of s) {
        bx0 = Math.min(bx0, p[0]);
        by0 = Math.min(by0, p[1]);
        bx1 = Math.max(bx1, p[0]);
        by1 = Math.max(by1, p[1]);
      }
    const i0 = Math.max(0, Math.floor((bx0 - x0) / dx) - 1);
    const j0 = Math.max(0, Math.floor((by0 - y0) / dy) - 1);
    const i1 = Math.min(nx - 1, Math.floor((bx1 - x0) / dx) + 1);
    const j1 = Math.min(ny - 1, Math.floor((by1 - y0) / dy) + 1);
    const cells: number[] = [];
    const ws: number[] = [];
    if (i1 >= i0 && j1 >= j0) {
      const wg = windowGrid(grid, i0, j0, i1 - i0 + 1, j1 - j0 + 1);
      const r = new CoverageRaster(wg, Math.max(sub, 6));
      if (padShapes.length) for (const pp of padShapes) addPadShape(r, pp);
      else for (const s of shapes) addRing(r, s);
      const f = r.finish();
      for (let jj = 0; jj < wg.ny; jj++)
        for (let ii = 0; ii < wg.nx; ii++) {
          const fr = f[jj * wg.nx + ii];
          if (!(fr > 0)) continue;
          const c = cellOf[(j0 + jj) * nx + i0 + ii];
          if (c < 0) continue;
          cells.push(c);
          ws.push(fr);
        }
    }
    if (!cells.length) {
      const c = nearestActive(comp.x, comp.y);
      if (c >= 0) {
        cells.push(c);
        ws.push(1);
        if (P > 0) warnings.push(`${comp.ref}: footprint lies outside the board outline; its ${P.toFixed(3)} W was applied at the nearest board cell`);
      }
    }
    let sw = 0;
    for (const w of ws) sw += w;
    const rec: ComponentRec = { id: comp.id, ref: comp.ref, part, power: P, node, cells: Int32Array.from(cells), w: Float64Array.from(ws.map((w) => w / (sw || 1))), padArea };
    comps.push(rec);
    if (P > 0) for (let q = 0; q < rec.cells.length; q++) src[rec.cells[q] * M + node] += P * rec.w[q];
  }

  if (negative.length) warnings.push(`negative power (delivered by sources) treated as 0 for: ${negative.slice(0, 8).join(', ')}${negative.length > 8 ? ', …' : ''}`);

  /* --------------------------------------- trace currents --------------------------------------- */
  let network: BoardNetwork | undefined;
  if (opts.pinCurrents && Object.keys(opts.pinCurrents).length) {
    network = buildBoardNetwork(board, parts, netsWithCurrent(board, opts.pinCurrents));
    warnings.push(...network.warnings);
  }
  const theta = new Float64Array(n * M);
  const tempAt = (layer: CopperLayer, x: number, y: number): number => {
    const c = cellAt(x, y);
    const m = nodeOf.get(layer) ?? 0;
    return c >= 0 ? tAir + theta[c * M + m] : tAir;
  };
  const srcJ = new Float64Array(n * M);
  let lostJoule = 0;
  const depositLosses = (losses: CopperLoss[]) => {
    srcJ.fill(0);
    lostJoule = 0;
    const add = (layer: CopperLayer, x: number, y: number, p: number) => {
      let c = cellAt(x, y);
      if (c < 0) c = nearestActive(x, y);
      if (c < 0) {
        lostJoule += p;
        return;
      }
      srcJ[c * M + (nodeOf.get(layer) ?? 0)] += p;
    };
    const step = 0.5 * Math.min(dx, dy);
    for (const L of losses) {
      if (L.line) {
        const len = Math.hypot(L.bx - L.ax, L.by - L.ay);
        const ns = Math.max(1, Math.ceil(len / step));
        for (let s = 0; s < ns; s++) {
          const t = (s + 0.5) / ns;
          add(L.layer, L.ax + (L.bx - L.ax) * t, L.ay + (L.by - L.ay) * t, L.power / ns);
        }
      } else if (L.layer2) {
        add(L.layer, L.ax, L.ay, L.power / 2);
        add(L.layer2, L.ax, L.ay, L.power / 2);
      } else add(L.layer, L.ax, L.ay, L.power);
    }
  };

  /* ------------------------------------- convection geometry ------------------------------------- */
  let areaMm2 = Math.abs(polygonArea(board.outline));
  for (const c of board.cutouts ?? []) areaMm2 -= Math.abs(polygonArea(c));
  areaMm2 = Math.max(areaMm2, 1e-6);
  const Lh = areaMm2 / Math.max(perimeter(board.outline), 1e-6); // mm, A/P
  const lengthScale = convMode === 'forced' ? W : orientation === 'vertical' ? H : Lh;
  const faceArea = n * cellArea;
  let edgeArea = 0;
  for (let c = 0; c < n; c++) edgeArea += edgeLen[c] * tB * 1e-6;

  const natural = (face: 'top' | 'bottom', meanRise: number) =>
    naturalConvectionH(orientation, face, meanRise, tAir, (orientation === 'vertical' ? H : Lh) * 1e-3);
  const faceH = (face: 'top' | 'bottom', meanRise: number): number => {
    const ov = face === 'top' ? hTopOverride : hBotOverride;
    if (ov !== undefined && Number.isFinite(ov) && ov >= 0) return ov;
    const hn = natural(face, meanRise);
    if (convMode !== 'forced') return hn;
    return mixedConvectionH(forcedConvectionH(airVelocity, W * 1e-3, tAir + meanRise / 2), hn);
  };

  /* -------------------------------------------- solve -------------------------------------------- */
  let totalStatic = 0;
  for (let i = 0; i < src.length; i++) totalStatic += src[i];
  // initial guess: uniform rise with h ≈ 12 W/m²K per face
  theta.fill(totalStatic > 0 ? totalStatic / (12 * (2 * faceArea + edgeArea)) : 0);
  const prev = new Float64Array(n * M);
  const rhs = new Float64Array(n * M);
  const diag = new Float64Array(n * M);
  let hTop = 0;
  let hBot = 0;
  let hEdge = 0;
  let iterations = 0;
  let outer = 0;
  let residual = 0;
  let converged = true;
  let lastChange = 1;
  let traceResult: TraceCurrentResult | undefined;
  for (outer = 1; outer <= MAX_OUTER; outer++) {
    let sTop = 0;
    let sBot = 0;
    for (let c = 0; c < n; c++) {
      sTop += theta[c * M];
      sBot += theta[c * M + M - 1];
    }
    const nTop = faceH('top', sTop / n);
    const nBot = faceH('bottom', sBot / n);
    const hChange = outer === 1 ? Infinity : Math.max(Math.abs(nTop - hTop) / Math.max(hTop, 1e-9), Math.abs(nBot - hBot) / Math.max(hBot, 1e-9));
    hTop = nTop;
    hBot = nBot;
    hEdge = (hTop + hBot) / 2;
    if (network) {
      const { losses } = analyzeNetworks(board, network, opts.pinCurrents!, tempAt);
      depositLosses(losses);
    }
    for (let c = 0; c < n; c++) {
      const ae = (edgeLen[c] * tB * 1e-6) / M;
      for (let m = 0; m < M; m++) {
        const q = c * M + m;
        const th = theta[q];
        const hr = eps > 0 ? radiationH(eps, tAir + th, tAir) : 0;
        let b = ae > 0 ? ae * (hEdge + hr) : 0;
        if (m === 0) b += cellArea * (hTop + hr);
        if (m === M - 1) b += cellArea * (hBot + hr);
        diag[q] = sumG[q] + b;
        rhs[q] = src[q] + srcJ[q];
      }
    }
    if (outer === 1) {
      let loss = 0;
      for (let q = 0; q < diag.length; q++) loss += diag[q] - sumG[q];
      if (!(loss > 0))
        throw new Error('simulatePcbThermal: the board has no heat-loss path (h = 0 on both faces, emissivity 0 and adiabatic edges)');
    }
    const sys: GridSystem = { nx, ny, M, cellOf, n, gE, gN, gZ, diag };
    const mg = new GridMultigrid(sys);
    prev.set(theta);
    // Inexact fixed-point iterations: intermediate solves only need to be accurate relative to
    // how much the outer iteration still changes the field; the final solve goes to 1e-8.
    const tol = outer === MAX_OUTER ? FINAL_TOL : Math.min(1e-4, Math.max(FINAL_TOL, 1e-2 * lastChange));
    let st = mg.solve(rhs, theta, { tol, maxIter: 500 });
    iterations += st.iterations;
    let dmax = 0;
    let tmax = 0;
    for (let q = 0; q < theta.length; q++) {
      dmax = Math.max(dmax, Math.abs(theta[q] - prev[q]));
      tmax = Math.max(tmax, Math.abs(theta[q]));
    }
    lastChange = dmax / Math.max(tmax, 1e-2);
    const done = (outer >= 2 && lastChange <= 1e-4 && hChange < 1e-3) || outer === MAX_OUTER;
    if (done && tol > FINAL_TOL) {
      st = mg.solve(rhs, theta, { tol: FINAL_TOL, maxIter: 500 });
      iterations += st.iterations;
    }
    residual = st.residual;
    converged = st.converged;
    if (done) break;
  }
  if (!converged) warnings.push(`thermal solver did not reach the 1e-8 residual target (residual ${residual.toExponential(2)})`);
  if (lastChange > 1e-3) {
    converged = false;
    warnings.push(`convection/radiation/Joule-heating iteration not converged after ${MAX_OUTER} passes (last relative change ${lastChange.toExponential(1)})`);
  }
  if (lostJoule > 1e-9) warnings.push(`${lostJoule.toExponential(2)} W of copper loss lies outside the board grid and was ignored`);
  if (network) traceResult = analyzeNetworks(board, network, opts.pinCurrents!, tempAt).result;
  if (traceResult) warnings.push(...traceResult.warnings);

  /* ------------------------------------------ heat balance ------------------------------------------ */
  let input = 0;
  for (let q = 0; q < rhs.length; q++) input += rhs[q];
  let qConv = 0;
  let qRad = 0;
  let hrTop = 0;
  let hrBot = 0;
  for (let c = 0; c < n; c++) {
    const top = theta[c * M];
    const bot = theta[c * M + M - 1];
    qConv += cellArea * (hTop * top + hBot * bot);
    if (eps > 0) {
      qRad += cellArea * (radiationFlux(eps, tAir + top, tAir) + radiationFlux(eps, tAir + bot, tAir));
      hrTop += radiationH(eps, tAir + top, tAir);
      hrBot += radiationH(eps, tAir + bot, tAir);
    }
    const ae = (edgeLen[c] * tB * 1e-6) / M;
    if (ae > 0)
      for (let m = 0; m < M; m++) {
        const th = theta[c * M + m];
        qConv += ae * hEdge * th;
        if (eps > 0) qRad += ae * radiationFlux(eps, tAir + th, tAir);
      }
  }
  const heatBalance = { input, convection: qConv, radiation: qRad, relativeError: input > 0 ? (qConv + qRad - input) / input : 0 };

  /* --------------------------------------------- outputs --------------------------------------------- */
  const topT = new Float32Array(NC).fill(tAir);
  const botT = new Float32Array(NC).fill(tAir);
  let maxTemp = tAir;
  for (let k = 0; k < NC; k++) {
    const c = cellOf[k];
    if (c < 0) continue;
    topT[k] = tAir + theta[c * M];
    botT[k] = tAir + theta[c * M + M - 1];
    for (let m = 0; m < M; m++) maxTemp = Math.max(maxTemp, tAir + theta[c * M + m]);
  }
  const components: PcbThermalComponentReport[] = comps.map((r) => {
    let tb = 0;
    for (let q = 0; q < r.cells.length; q++) tb += r.w[q] * theta[r.cells[q] * M + r.node];
    const tBoard = tAir + tb;
    const thetaJC = r.part?.thermal?.thetaJC ?? defaultThetaJC(r.part);
    const thetaCB = caseToBoardTheta(r.padArea);
    const tCase = tBoard + r.power * thetaCB;
    const tJunction = tCase + r.power * thetaJC;
    const tjMax = r.part?.thermal?.tjMax ?? r.part?.ratings?.tempMax ?? 125;
    const status: PcbThermalComponent['status'] = tJunction > tjMax ? 'fail' : tJunction - tAir > 0.85 * (tjMax - tAir) ? 'warn' : 'ok';
    const out: PcbThermalComponentReport = { componentId: r.id, ref: r.ref, power: r.power, tBoard, tCase, tJunction, tjMax, status, thetaJC, thetaCB };
    const thetaJA = r.part?.thermal?.thetaJA;
    if (thetaJA !== undefined && thetaJA > 0 && r.power > 0) {
      out.tJunctionThetaJA = tAir + r.power * thetaJA;
      const riseModel = tJunction - tAir;
      const riseJA = r.power * thetaJA;
      if (Math.max(riseModel, riseJA) > 2 && (riseModel > 2 * riseJA || riseJA > 2 * riseModel))
        warnings.push(
          `${r.ref}: board model gives a junction rise of ${riseModel.toFixed(1)} °C but θJA (${thetaJA} °C/W) predicts ${riseJA.toFixed(1)} °C — they differ by more than 2×; check copper area / package data`,
        );
    }
    if (status === 'fail') warnings.push(`${r.ref}: junction ${tJunction.toFixed(1)} °C exceeds Tj,max ${tjMax} °C`);
    return out;
  });

  return {
    kind: 'pcb-thermal',
    boardId: board.id,
    ambient,
    convection: {
      mode: convMode,
      hTop,
      hBottom: hBot,
      ...(convMode === 'forced' ? { airVelocity } : {}),
      hRadTop: eps > 0 ? hrTop / n : 0,
      hRadBottom: eps > 0 ? hrBot / n : 0,
      lengthScale,
      orientation,
    },
    grid,
    mask: pack(mask, 'u8'),
    layers: [
      { layer: 'top', temperature: pack(topT) },
      { layer: 'bottom', temperature: pack(botT) },
    ],
    components,
    traces: traceResult?.traces ?? [],
    ...(traceResult ? { netDrops: traceResult.netDrops } : {}),
    maxTemp,
    totalPower: input,
    airTemp: tAir,
    heatBalance,
    solver: { unknowns: n * M, nodesPerCell: M, iterations, outerIterations: outer, residual, converged, ms: nowMs() - t0 },
    warnings,
  };
}

