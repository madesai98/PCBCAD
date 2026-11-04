import type { FacetStatus, FootprintDef, Graphic, PackageSpec, PadDef, Vec2 } from '@pcbcad/core';
import { padPolygonLocal } from '@pcbcad/core';
import { ceilTo, floorTo, rnd } from '../util/num';

/** Line widths / clearances (mm). */
export const SILK_W = 0.12;
export const FAB_W = 0.1;
export const CRT_W = 0.05;
/** Silkscreen-to-pad clearance (JLCPCB minimum 0.15 + margin). */
export const SILK_PAD_CLEAR = 0.2;
/** Shortest silkscreen segment kept after clipping. */
const MIN_SILK_SEG = 0.2;

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBox(): Box {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function boxAdd(b: Box, x: number, y: number): void {
  if (x < b.minX) b.minX = x;
  if (y < b.minY) b.minY = y;
  if (x > b.maxX) b.maxX = x;
  if (y > b.maxY) b.maxY = y;
}

export function boxValid(b: Box): boolean {
  return Number.isFinite(b.minX) && Number.isFinite(b.maxX) && b.maxX >= b.minX && b.maxY >= b.minY;
}

/** Axis-aligned bounding box of a pad (rotation and polygon shape included). */
export function padBox(p: PadDef): Box {
  const b = emptyBox();
  for (const [x, y] of padPolygonLocal(p, 16)) boxAdd(b, x, y);
  if (p.kind !== 'smd' && (p.drill || p.slot)) {
    const r = Math.max(p.drill ?? 0, p.slot ? Math.max(p.slot.w, p.slot.h) : 0) / 2;
    boxAdd(b, p.x - r, p.y - r);
    boxAdd(b, p.x + r, p.y + r);
  }
  return b;
}

/** Portions of segment a→b lying outside all rectangles (Liang–Barsky interval subtraction). */
export function clipSegmentOutside(a: Vec2, b: Vec2, rects: Box[]): [Vec2, Vec2][] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const holes: [number, number][] = [];
  for (const r of rects) {
    let t0 = 0;
    let t1 = 1;
    const p = [-dx, dx, -dy, dy];
    const q = [a[0] - r.minX, r.maxX - a[0], a[1] - r.minY, r.maxY - a[1]];
    let inside = true;
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) {
        if (q[i] < 0) {
          inside = false;
          break;
        }
      } else {
        const t = q[i] / p[i];
        if (p[i] < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
    }
    if (inside && t1 > t0) holes.push([t0, t1]);
  }
  holes.sort((u, v) => u[0] - v[0]);
  const keep: [number, number][] = [];
  let cur = 0;
  for (const [h0, h1] of holes) {
    if (h0 > cur) keep.push([cur, h0]);
    cur = Math.max(cur, h1);
  }
  if (cur < 1) keep.push([cur, 1]);
  const len = Math.hypot(dx, dy);
  return keep
    .filter(([t0, t1]) => (t1 - t0) * len >= MIN_SILK_SEG)
    .map(([t0, t1]) => [
      [rnd(a[0] + dx * t0), rnd(a[1] + dy * t0)],
      [rnd(a[0] + dx * t1), rnd(a[1] + dy * t1)],
    ]);
}

export interface PadOpts {
  shape?: PadDef['shape'];
  rotation?: number;
  roundness?: number;
  pasteRatio?: number;
}

/**
 * Incrementally builds a FootprintDef. Pads first, then graphics; `build()` computes the courtyard
 * (pads ∪ body ∪ extra extents, plus margin, rounded outward to 0.05 mm, and grown to cover all
 * silkscreen) and appends the courtyard outline.
 */
export class FootprintBuilder {
  readonly pads: PadDef[] = [];
  readonly graphics: Graphic[] = [];
  private body?: Box;
  private extents = emptyBox();
  courtyardMargin = 0.25;

  constructor(readonly name: string) {}

  /** SMD land (default rounded rectangle, roundness 0.25). */
  smd(number: string, x: number, y: number, w: number, h: number, o: PadOpts = {}): PadDef {
    const shape = o.shape ?? 'roundrect';
    const pad: PadDef = { number, shape, x: rnd(x), y: rnd(y), w: rnd(w), h: rnd(h), kind: 'smd' };
    if (shape === 'roundrect') pad.roundness = o.roundness ?? 0.25;
    if (o.rotation) pad.rotation = o.rotation;
    if (o.pasteRatio !== undefined) pad.pasteRatio = o.pasteRatio;
    this.pads.push(pad);
    return pad;
  }

  /** Plated through-hole pad. `h` defaults to `w` (circle / square); slot is in pad-local axes. */
  tht(number: string, x: number, y: number, w: number, drill: number, shape: 'circle' | 'rect' | 'oval' | 'roundrect' = 'circle', h?: number, slot?: { w: number; h: number }): PadDef {
    const hh = h ?? w;
    const sh = shape === 'circle' && Math.abs(hh - w) > 1e-6 ? 'oval' : shape;
    const pad: PadDef = { number, shape: sh, x: rnd(x), y: rnd(y), w: rnd(w), h: rnd(hh), kind: 'tht', drill: rnd(drill) };
    if (sh === 'roundrect') pad.roundness = 0.25;
    if (slot) pad.slot = { w: rnd(slot.w), h: rnd(slot.h) };
    this.pads.push(pad);
    return pad;
  }

  /** Non-plated hole (mounting peg / locating hole). */
  npth(x: number, y: number, drill: number): PadDef {
    const pad: PadDef = { number: '', shape: 'circle', x: rnd(x), y: rnd(y), w: rnd(drill), h: rnd(drill), kind: 'npth', drill: rnd(drill) };
    this.pads.push(pad);
    return pad;
  }

  /** Declare the component body rectangle (centre + size); drawn on fab and used for the courtyard. */
  setBody(cx: number, cy: number, w: number, l: number): Box {
    this.body = { minX: rnd(cx - w / 2), minY: rnd(cy - l / 2), maxX: rnd(cx + w / 2), maxY: rnd(cy + l / 2) };
    return this.body;
  }

  /** Extend the courtyard to include a point (e.g. connector overhang). */
  include(x: number, y: number): void {
    boxAdd(this.extents, x, y);
  }

  line(layer: Graphic['layer'], a: Vec2, b: Vec2, width = layer === 'silk' ? SILK_W : layer === 'fab' ? FAB_W : CRT_W): void {
    this.graphics.push({ kind: 'line', layer, a: [rnd(a[0]), rnd(a[1])], b: [rnd(b[0]), rnd(b[1])], width });
  }

  poly(layer: Graphic['layer'], points: Vec2[], closed = true, fill = false, width = layer === 'silk' ? SILK_W : layer === 'fab' ? FAB_W : CRT_W): void {
    const g: Graphic = { kind: 'polyline', layer, points: points.map((p) => [rnd(p[0]), rnd(p[1])] as Vec2), width };
    if (closed) g.closed = true;
    if (fill) g.fill = true;
    this.graphics.push(g);
  }

  circle(layer: Graphic['layer'], c: Vec2, r: number, fill = false, width = layer === 'silk' ? SILK_W : FAB_W): void {
    const g: Graphic = { kind: 'circle', layer, c: [rnd(c[0]), rnd(c[1])], r: rnd(r), width };
    if (fill) g.fill = true;
    this.graphics.push(g);
  }

  arc(layer: Graphic['layer'], c: Vec2, r: number, start: number, end: number, width = layer === 'silk' ? SILK_W : FAB_W): void {
    this.graphics.push({ kind: 'arc', layer, c: [rnd(c[0]), rnd(c[1])], r: rnd(r), start: rnd(start, 3), end: rnd(end, 3), width });
  }

  /** Keep-out rectangles around copper for silkscreen clipping. */
  private silkKeepouts(): Box[] {
    const m = SILK_PAD_CLEAR + SILK_W / 2;
    return this.pads.map((p) => {
      const b = padBox(p);
      return { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
    });
  }

  /** Silkscreen segment, automatically clipped away from pads. */
  silkLine(a: Vec2, b: Vec2): void {
    for (const [p, q] of clipSegmentOutside(a, b, this.silkKeepouts())) this.line('silk', p, q);
  }

  /** Silkscreen polyline (each edge clipped against pads). */
  silkPath(points: Vec2[], closed = false): void {
    const keep = this.silkKeepouts();
    const n = points.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      for (const [p, q] of clipSegmentOutside(points[i], points[(i + 1) % n], keep)) this.line('silk', p, q);
    }
  }

  /** Silkscreen rectangle (offset outward by half the line width) clipped against pads. */
  silkRect(b: Box, grow = SILK_W / 2 + 0.01): void {
    const x0 = b.minX - grow;
    const y0 = b.minY - grow;
    const x1 = b.maxX + grow;
    const y1 = b.maxY + grow;
    this.silkPath(
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ],
      true,
    );
  }

  /** Filled silk dot if it clears all pads; returns whether it was placed. */
  silkDot(x: number, y: number, r = 0.15): boolean {
    const m = SILK_PAD_CLEAR + r;
    for (const p of this.pads) {
      const b = padBox(p);
      if (x > b.minX - m && x < b.maxX + m && y > b.minY - m && y < b.maxY + m) return false;
    }
    this.circle('silk', [x, y], Math.max(0.02, r - SILK_W / 2), true, SILK_W);
    return true;
  }

  /** Try candidate positions in order and place a pin-1 dot at the first one that clears copper. */
  pin1Dot(candidates: Vec2[], r = 0.15): void {
    for (const [x, y] of candidates) if (this.silkDot(x, y, r)) return;
  }

  /** Fab body outline with an optional chamfered pin-1 corner ('tl' | 'tr' | 'bl' | 'br'). */
  fabBody(b: Box, chamferCorner?: 'tl' | 'tr' | 'bl' | 'br'): void {
    const w = b.maxX - b.minX;
    const l = b.maxY - b.minY;
    const c = chamferCorner ? Math.min(1, 0.25 * Math.min(w, l)) : 0;
    const pts: Vec2[] = [];
    // CCW from bottom-left; chamfer points are ordered along the outline
    if (chamferCorner === 'bl') pts.push([b.minX, b.minY + c], [b.minX + c, b.minY]);
    else pts.push([b.minX, b.minY]);
    if (chamferCorner === 'br') pts.push([b.maxX - c, b.minY], [b.maxX, b.minY + c]);
    else pts.push([b.maxX, b.minY]);
    if (chamferCorner === 'tr') pts.push([b.maxX, b.maxY - c], [b.maxX - c, b.maxY]);
    else pts.push([b.maxX, b.maxY]);
    if (chamferCorner === 'tl') pts.push([b.minX + c, b.maxY], [b.minX, b.maxY - c]);
    else pts.push([b.minX, b.maxY]);
    this.poly('fab', pts, true);
  }

  /** Finalise: compute the courtyard and return the FootprintDef. */
  build(generator?: PackageSpec, source: FacetStatus = 'generated'): FootprintDef {
    const cy = emptyBox();
    for (const p of this.pads) {
      const b = padBox(p);
      boxAdd(cy, b.minX, b.minY);
      boxAdd(cy, b.maxX, b.maxY);
    }
    if (this.body) {
      boxAdd(cy, this.body.minX, this.body.minY);
      boxAdd(cy, this.body.maxX, this.body.maxY);
    }
    if (boxValid(this.extents)) {
      boxAdd(cy, this.extents.minX, this.extents.minY);
      boxAdd(cy, this.extents.maxX, this.extents.maxY);
    }
    if (!boxValid(cy)) boxAdd(cy, 0, 0);
    const m = this.courtyardMargin;
    let court: Box = {
      minX: floorTo(cy.minX - m, 0.05),
      minY: floorTo(cy.minY - m, 0.05),
      maxX: ceilTo(cy.maxX + m, 0.05),
      maxY: ceilTo(cy.maxY + m, 0.05),
    };
    // grow to cover silkscreen
    for (const g of this.graphics) {
      if (g.layer !== 'silk') continue;
      const gb = graphicBox(g);
      if (!gb) continue;
      court = {
        minX: Math.min(court.minX, floorTo(gb.minX - 0.05, 0.05)),
        minY: Math.min(court.minY, floorTo(gb.minY - 0.05, 0.05)),
        maxX: Math.max(court.maxX, ceilTo(gb.maxX + 0.05, 0.05)),
        maxY: Math.max(court.maxY, ceilTo(gb.maxY + 0.05, 0.05)),
      };
    }
    this.poly(
      'courtyard',
      [
        [court.minX, court.minY],
        [court.maxX, court.minY],
        [court.maxX, court.maxY],
        [court.minX, court.maxY],
      ],
      true,
    );
    const fp: FootprintDef = { name: this.name, pads: this.pads, graphics: this.graphics, courtyard: court, source };
    if (generator) fp.generator = generator;
    return fp;
  }
}

/** Bounding box of a graphic including its stroke. */
export function graphicBox(g: Graphic): Box | undefined {
  const b = emptyBox();
  const hw = 'width' in g ? g.width / 2 : 0;
  switch (g.kind) {
    case 'line':
      boxAdd(b, g.a[0], g.a[1]);
      boxAdd(b, g.b[0], g.b[1]);
      break;
    case 'polyline':
      for (const p of g.points) boxAdd(b, p[0], p[1]);
      break;
    case 'circle':
      boxAdd(b, g.c[0] - g.r, g.c[1] - g.r);
      boxAdd(b, g.c[0] + g.r, g.c[1] + g.r);
      break;
    case 'arc':
      boxAdd(b, g.c[0] - g.r, g.c[1] - g.r);
      boxAdd(b, g.c[0] + g.r, g.c[1] + g.r);
      break;
    case 'text':
      boxAdd(b, g.at[0] - g.size, g.at[1] - g.size / 2);
      boxAdd(b, g.at[0] + g.size, g.at[1] + g.size / 2);
      break;
  }
  if (!boxValid(b)) return undefined;
  return { minX: b.minX - hw, minY: b.minY - hw, maxX: b.maxX + hw, maxY: b.maxY + hw };
}

/** Format a dimension for footprint names: 1.27 → '1.27', 2 → '2.00' when `fixed`. */
export function fmtMm(v: number, fixed = false): string {
  return fixed ? v.toFixed(2) : String(rnd(v, 3));
}
