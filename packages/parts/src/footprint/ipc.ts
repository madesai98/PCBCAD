import { ceilTo, floorTo, rnd } from '../util/num';

/**
 * IPC-7351B land-pattern calculator (nominal / density level B).
 *
 *   Zmax = Lmin + 2·JT + √(CL² + F² + P²)          outer extent of the two lands
 *   Gmin = Smax − 2·JH − √(CS² + F² + P²)          inner gap between the two lands
 *   Xmax = Wmin + 2·JS + √(CW² + F² + P²)          land width
 *
 * with S (terminal inner span) derived from L and T using the RMS tolerance method:
 *   Smin = Lmin − 2·Tmax,  CS = √(CL² + 2·CT²),  Smax = Smin + CS.
 *
 * F (fabrication tolerance) = 0.05 mm, P (placement tolerance) = 0.05 mm. Z is rounded up, G down
 * and X up to 0.05 mm. Optional `minGap` keeps lands from extending under a gull-wing body
 * (G ≥ E1 − 0.05): this reproduces the familiar IPC/vendor patterns, e.g. SOIC-8 → 1.55 × 0.60 mm
 * lands on 5.40 mm centres, TQFP-32 → 1.50 × 0.55 mm on 8.45 mm.
 */

export interface Range {
  min: number;
  max: number;
}

/** Toe / heel / side solder-fillet goals (mm). */
export interface Fillets {
  toe: number;
  heel: number;
  side: number;
}

/** IPC-7351B nominal fillet goals per lead form. */
export const FILLETS = {
  /** Table 3-5: rectangular / square-end chips ≥ 0603. */
  chip: { toe: 0.35, heel: -0.05, side: 0.0 },
  /** Table 3-6: chips smaller than 0603. */
  chipSmall: { toe: 0.2, heel: -0.05, side: 0.0 },
  /** Table 3-2: gull-wing, pitch > 0.625 mm. */
  gullWing: { toe: 0.35, heel: 0.35, side: 0.03 },
  /** Table 3-3: gull-wing, pitch ≤ 0.625 mm. */
  gullWingFine: { toe: 0.35, heel: 0.35, side: -0.02 },
  /** Tables 3-15/3-16: QFN / SON bottom-terminations (periphery). */
  noLead: { toe: 0.3, heel: 0.0, side: -0.04 },
  /** Table 3-10: inward flat-ribbon L leads (SMA/SMB/SMC, molded tantalum / inductors). */
  inwardL: { toe: 0.15, heel: 0.5, side: -0.05 },
} as const satisfies Record<string, Fillets>;

export const IPC_FAB_TOL = 0.05;
export const IPC_PLACE_TOL = 0.05;
export const IPC_ROUND = 0.05;

export function range(nominal: number, plusMinus: number): Range {
  return { min: rnd(nominal - plusMinus, 6), max: rnd(nominal + plusMinus, 6) };
}

export interface IpcLand {
  /** Outer extent (toe to toe) of the land pair. */
  Z: number;
  /** Inner gap between the lands. */
  G: number;
  /** Land width (perpendicular to the lead axis). */
  X: number;
  /** Land length along the lead axis = (Z − G) / 2. */
  length: number;
  /** Land width (= X). */
  width: number;
  /** Distance from the component centre to the land centre = (Z + G) / 4. */
  center: number;
}

export interface IpcInput {
  /** Overall terminal-to-terminal length (toe to toe of the component leads). */
  L: Range;
  /** Terminal (foot) length. */
  T: Range;
  /** Terminal width. */
  W: Range;
  fillets: Fillets;
  /** Minimum inner gap (e.g. body width for gull-wing packages). */
  minGap?: number;
  F?: number;
  P?: number;
}

/** Compute an IPC-7351B land pair for one lead axis. */
export function ipcLand(inp: IpcInput): IpcLand {
  const F = inp.F ?? IPC_FAB_TOL;
  const P = inp.P ?? IPC_PLACE_TOL;
  const { L, T, W, fillets } = inp;
  const CL = Math.max(0, L.max - L.min);
  const CT = Math.max(0, T.max - T.min);
  const CW = Math.max(0, W.max - W.min);
  const Smin = L.min - 2 * T.max;
  const CS = Math.min(Math.sqrt(CL * CL + 2 * CT * CT), Math.max(0, L.max - 2 * T.min - Smin));
  const Smax = Smin + CS;
  const ff = F * F + P * P;
  let Z = ceilTo(L.min + 2 * fillets.toe + Math.sqrt(CL * CL + ff), IPC_ROUND);
  let G = floorTo(Smax - 2 * fillets.heel - Math.sqrt(CS * CS + ff), IPC_ROUND);
  const X = ceilTo(W.min + 2 * fillets.side + Math.sqrt(CW * CW + ff), IPC_ROUND);
  if (inp.minGap !== undefined && G < inp.minGap) G = floorTo(inp.minGap, IPC_ROUND / 5);
  if (G < 0.1) G = 0.1;
  if (Z < G + 0.2) Z = ceilTo(G + 0.2, IPC_ROUND);
  return { Z, G, X, length: rnd((Z - G) / 2, 4), width: X, center: rnd((Z + G) / 4, 4) };
}

/** Plated-through-hole sizes per IPC-2222 level B: hole = lead + 0.25, annular ring ≥ 0.25 (min pad = hole + 0.6). */
export function thtHole(leadMax: number): { drill: number; pad: number } {
  const drill = ceilTo(leadMax + 0.2, 0.05);
  return { drill, pad: ceilTo(drill + 0.6, 0.05) };
}
