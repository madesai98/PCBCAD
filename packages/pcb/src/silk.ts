/**
 * Silkscreen geometry: footprint graphics in board frame, reference-designator placement and
 * clipping of strokes away from exposed pads.
 */
import { componentCourtyard, footprintToBoard, type ComponentInstance, type FootprintDef, type Graphic, type Vec2 } from '@pcbcad/core';
import { bboxOf, bbOverlaps, makePrim, primOutline, type Prim } from './geom';
import { strokeText, strokeWidthFor, textWidth } from './font';

export interface SilkStroke {
  pts: Vec2[];
  width: number;
}

export interface SilkArt {
  strokes: SilkStroke[];
  /** Filled polygons (board frame). */
  fills: Vec2[][];
  /** True when the footprint carries its own reference text. */
  hasRefText: boolean;
}

const REF_PLACEHOLDERS = /REF\*\*|\$\{REFERENCE\}|%R|\{ref\}/g;
const VALUE_PLACEHOLDERS = /\$\{VALUE\}|%V|\{value\}/g;

function arcPoints(c: Vec2, r: number, startDeg: number, endDeg: number): Vec2[] {
  let sweep = endDeg - startDeg;
  while (sweep <= 0) sweep += 360;
  while (sweep > 360) sweep -= 360;
  const n = Math.max(4, Math.ceil(sweep / 10));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((startDeg + (sweep * i) / n) * Math.PI) / 180;
    pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return pts;
}

/** Silkscreen graphics of a placed component, transformed to board frame. */
export function footprintSilk(comp: ComponentInstance, fp: FootprintDef, value?: string): SilkArt {
  const strokes: SilkStroke[] = [];
  const fills: Vec2[][] = [];
  let hasRefText = false;
  const T = (p: Vec2) => footprintToBoard(comp, p);
  for (const g of fp.graphics ?? []) {
    if (g.layer !== 'silk') continue;
    addGraphic(g);
  }
  function addGraphic(g: Graphic) {
    switch (g.kind) {
      case 'line':
        strokes.push({ pts: [T(g.a), T(g.b)], width: g.width });
        break;
      case 'polyline': {
        if (g.points.length < 2) return;
        const pts = g.points.map(T);
        if (g.closed || g.fill) pts.push(pts[0]);
        if (g.fill && g.points.length >= 3) fills.push(g.points.map(T));
        strokes.push({ pts, width: g.width });
        break;
      }
      case 'circle': {
        const pts = arcPoints(g.c, g.r, 0, 360).map(T);
        if (g.fill) fills.push(pts.slice(0, -1));
        strokes.push({ pts, width: g.width });
        break;
      }
      case 'arc':
        strokes.push({ pts: arcPoints(g.c, g.r, g.start, g.end).map(T), width: g.width });
        break;
      case 'text': {
        let text = g.text;
        if (REF_PLACEHOLDERS.test(text)) hasRefText = true;
        REF_PLACEHOLDERS.lastIndex = 0;
        text = text.replace(REF_PLACEHOLDERS, comp.ref).replace(VALUE_PLACEHOLDERS, value ?? comp.value ?? '');
        if (text === comp.ref) hasRefText = true;
        const w = strokeWidthFor(g.size);
        for (const s of strokeText(text, { at: g.at, size: g.size, rotation: g.rotation, justify: 'center', vjustify: 'middle' })) strokes.push({ pts: s.map(T), width: w });
        break;
      }
    }
  }
  return { strokes, fills, hasRefText };
}

/** Footprint silk strokes as prims (used by DRC silk-over-pad). Text is included. */
export function silkPrims(comp: ComponentInstance, fp: FootprintDef): Prim[] {
  const out: Prim[] = [];
  const art = footprintSilk(comp, fp);
  for (const s of art.strokes) {
    for (let i = 1; i < s.pts.length; i++) out.push(makePrim([s.pts[i - 1], s.pts[i]], s.width / 2));
  }
  return out;
}

/**
 * Candidate reference-designator placements around the courtyard (board frame, upright text).
 * Returns strokes for the first candidate whose box avoids `avoid` polygons, else the first one.
 */
export function placeRefText(comp: ComponentInstance, fp: FootprintDef, avoid: { bb: ReturnType<typeof bboxOf>; poly: Vec2[] }[]): SilkStroke[] {
  const court = componentCourtyard(comp, fp);
  const bb = bboxOf(court);
  const cw = bb.maxX - bb.minX;
  const ch = bb.maxY - bb.minY;
  const size = Math.max(cw, ch) < 2.5 ? 0.8 : 1.0;
  const w = strokeWidthFor(size);
  const tw = textWidth(comp.ref, size);
  const gap = 0.2 + w / 2;
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  const mirror = comp.side === 'bottom';
  const cands: { at: Vec2; box: ReturnType<typeof bboxOf> }[] = [
    { at: [cx, bb.maxY + gap + size / 2], box: { minX: cx - tw / 2, maxX: cx + tw / 2, minY: bb.maxY + gap, maxY: bb.maxY + gap + size } },
    { at: [cx, bb.minY - gap - size / 2], box: { minX: cx - tw / 2, maxX: cx + tw / 2, minY: bb.minY - gap - size, maxY: bb.minY - gap } },
    { at: [bb.maxX + gap + tw / 2, cy], box: { minX: bb.maxX + gap, maxX: bb.maxX + gap + tw, minY: cy - size / 2, maxY: cy + size / 2 } },
    { at: [bb.minX - gap - tw / 2, cy], box: { minX: bb.minX - gap - tw, maxX: bb.minX - gap, minY: cy - size / 2, maxY: cy + size / 2 } },
    { at: [cx, cy], box: { minX: cx - tw / 2, maxX: cx + tw / 2, minY: cy - size / 2, maxY: cy + size / 2 } },
  ];
  let pick = cands[0];
  for (const c of cands) {
    const box = { minX: c.box.minX - w, minY: c.box.minY - w, maxX: c.box.maxX + w, maxY: c.box.maxY + w };
    if (!avoid.some((a) => bbOverlaps(a.bb, box))) {
      pick = c;
      break;
    }
  }
  return strokeText(comp.ref, { at: pick.at, size, mirror, justify: 'center', vjustify: 'middle' }).map((pts) => ({ pts, width: w }));
}

/** Convex keep-out polygon around a pad prim for silk clipping. */
export function silkKeepout(p: Prim, margin: number): { bb: ReturnType<typeof bboxOf>; poly: Vec2[] } {
  const poly = primOutline(p, margin);
  return { bb: bboxOf(poly), poly };
}

/** Parameter interval [t0,t1] of segment a→b inside convex CCW polygon (Cyrus–Beck), or null. */
function clipSegConvex(a: Vec2, b: Vec2, poly: Vec2[]): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    // inward normal for CCW polygon edge j→i
    const ex = poly[i][0] - poly[j][0];
    const ey = poly[i][1] - poly[j][1];
    const nx = -ey;
    const ny = ex;
    const num = nx * (a[0] - poly[j][0]) + ny * (a[1] - poly[j][1]);
    const den = nx * dx + ny * dy;
    if (Math.abs(den) < 1e-15) {
      if (num < 0) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return t1 - t0 > 1e-9 ? [t0, t1] : null;
}

/** Remove the parts of strokes that fall inside any keep-out polygon. */
export function clipStrokes(strokes: SilkStroke[], keepouts: { bb: ReturnType<typeof bboxOf>; poly: Vec2[] }[]): SilkStroke[] {
  if (!keepouts.length) return strokes;
  const out: SilkStroke[] = [];
  for (const s of strokes) {
    let cur: Vec2[] = [];
    const flush = () => {
      if (cur.length >= 2) out.push({ pts: cur, width: s.width });
      cur = [];
    };
    if (s.pts.length === 1) {
      out.push(s);
      continue;
    }
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1];
      const b = s.pts[i];
      const sb = bboxOf([a, b], s.width / 2);
      const cuts: [number, number][] = [];
      for (const k of keepouts) {
        if (!bbOverlaps(k.bb, sb)) continue;
        const iv = clipSegConvex(a, b, k.poly);
        if (iv) cuts.push(iv);
      }
      if (!cuts.length) {
        if (!cur.length) cur.push(a);
        cur.push(b);
        continue;
      }
      cuts.sort((x, y) => x[0] - y[0]);
      let t = 0;
      const pieces: [number, number][] = [];
      for (const [c0, c1] of cuts) {
        if (c0 > t + 1e-9) pieces.push([t, c0]);
        t = Math.max(t, c1);
      }
      if (t < 1 - 1e-9) pieces.push([t, 1]);
      const at = (u: number): Vec2 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
      for (const [u0, u1] of pieces) {
        if (u0 > 1e-9 || !cur.length) {
          flush();
          cur.push(at(u0));
        }
        cur.push(at(u1));
        if (u1 < 1 - 1e-9) flush();
      }
      if (!pieces.length || pieces[pieces.length - 1][1] < 1 - 1e-9) flush();
    }
    flush();
  }
  return out;
}
