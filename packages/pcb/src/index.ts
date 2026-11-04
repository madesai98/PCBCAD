/**
 * @pcbcad/pcb — board-level layout automation, checks and manufacturing outputs.
 *
 * Board frame: mm, Y up, origin lower-left. All functions are pure (inputs are never mutated) and
 * browser/worker safe.
 */
export { autoPlace, type AutoPlaceOptions, type BoardEdge } from './place';
export { autoRoute, type AutoRouteOptions, type AutoRouteResult } from './route';
export { fillZones } from './zones';
export { connectivity, ratsnest, type RatsLine } from './connectivity';
export { runDrc, convexOverlapDepth } from './drc';
export { runErc, IC_CATEGORIES } from './erc';
export { exportGerbers, GerberWriter, type GerberFile } from './gerber';
export { exportBom, exportCpl, zipFiles, unitPriceAt } from './assembly';
export { boardStats, type BoardStats } from './stats';
export { strokeText, textWidth, strokeWidthFor, hasGlyph, type TextOptions } from './font';
export { HOLE_TO_HOLE, MASK_EXPANSION } from './constants';
export { netTraceWidth, isGroundNet, isPowerNet } from './model';
