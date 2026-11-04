/**
 * Minimal SVG path support for EasyEDA shapes (SOLIDREGION / ARC / symbol paths): M, L, H, V, A, Z
 * (absolute and relative); C/S/Q/T segments are approximated by their end points. Coordinates are
 * returned in the path's own frame (no unit conversion).
 */

export interface SvgSubpath {
  points: [number, number][];
  closed: boolean;
}

export interface SvgArc {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Start angle (rad) in the path frame, measured from +x toward +y. */
  theta1: number;
  /** Signed sweep (rad); positive = increasing angle (clockwise on a y-down canvas). */
  dtheta: number;
  phi: number;
}

function vecAngle(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy;
  const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  let a = Math.acos(Math.max(-1, Math.min(1, len > 0 ? dot / len : 1)));
  if (ux * vy - uy * vx < 0) a = -a;
  return a;
}

/** SVG elliptical-arc endpoint → centre parameterisation (SVG 1.1 implementation notes F.6.5). */
export function svgArcToCenter(x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number, largeArc: boolean, sweep: boolean, x2: number, y2: number): SvgArc | undefined {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < 1e-12 || ry < 1e-12) return undefined;
  if (Math.abs(x1 - x2) < 1e-12 && Math.abs(y1 - y2) < 1e-12) return undefined;
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cos * dx2 + sin * dy2;
  const y1p = -sin * dx2 + cos * dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, den > 0 ? num / den : 0));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = vecAngle(1, 0, ux, uy);
  let dtheta = vecAngle(ux, uy, vx, vy);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  return { cx, cy, rx, ry, theta1, dtheta, phi };
}

/** Points along an arc (inclusive of both ends), at most `stepDeg` apart. */
export function arcPoints(a: SvgArc, stepDeg = 10): [number, number][] {
  const n = Math.max(2, Math.ceil(Math.abs((a.dtheta * 180) / Math.PI) / stepDeg));
  const cos = Math.cos(a.phi);
  const sin = Math.sin(a.phi);
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = a.theta1 + (a.dtheta * i) / n;
    const ex = a.rx * Math.cos(t);
    const ey = a.ry * Math.sin(t);
    out.push([a.cx + cos * ex - sin * ey, a.cy + sin * ex + cos * ey]);
  }
  return out;
}

const CMD_RE = /([MmLlHhVvAaZzCcSsQqTt])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;

/** Parse an SVG path into polylines, tessellating arcs. */
export function svgPathToPolylines(d: string, stepDeg = 10): SvgSubpath[] {
  const toks: (string | number)[] = [];
  for (const m of d.matchAll(CMD_RE)) toks.push(m[1] !== undefined ? m[1] : parseFloat(m[2]));
  const out: SvgSubpath[] = [];
  let cur: SvgSubpath | undefined;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cmd = '';
  let i = 0;
  const num = (): number | undefined => (typeof toks[i] === 'number' ? (toks[i++] as number) : undefined);
  const push = (px: number, py: number) => {
    if (!cur) {
      cur = { points: [[x, y]], closed: false };
      out.push(cur);
    }
    cur.points.push([px, py]);
    x = px;
    y = py;
  };
  while (i < toks.length) {
    if (typeof toks[i] === 'string') cmd = toks[i++] as string;
    else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'Z') {
      if (cur) cur.closed = true;
      x = sx;
      y = sy;
      cur = undefined;
      cmd = '';
      continue;
    }
    if (C === 'M') {
      const a = num();
      const b = num();
      if (a === undefined || b === undefined) break;
      x = rel ? x + a : a;
      y = rel ? y + b : b;
      sx = x;
      sy = y;
      cur = { points: [[x, y]], closed: false };
      out.push(cur);
      cmd = rel ? 'l' : 'L';
      continue;
    }
    if (C === 'L' || C === 'T') {
      const a = num();
      const b = num();
      if (a === undefined || b === undefined) break;
      push(rel ? x + a : a, rel ? y + b : b);
      continue;
    }
    if (C === 'H') {
      const a = num();
      if (a === undefined) break;
      push(rel ? x + a : a, y);
      continue;
    }
    if (C === 'V') {
      const a = num();
      if (a === undefined) break;
      push(x, rel ? y + a : a);
      continue;
    }
    if (C === 'A') {
      const v = [num(), num(), num(), num(), num(), num(), num()];
      if (v.some((n) => n === undefined)) break;
      const [rx, ry, rot, la, sw, ex0, ey0] = v as number[];
      const ex = rel ? x + ex0 : ex0;
      const ey = rel ? y + ey0 : ey0;
      const arc = svgArcToCenter(x, y, rx, ry, rot, la !== 0, sw !== 0, ex, ey);
      if (arc) for (const p of arcPoints(arc, stepDeg).slice(1)) push(p[0], p[1]);
      else push(ex, ey);
      continue;
    }
    if (C === 'C' || C === 'S' || C === 'Q') {
      const n = C === 'C' ? 6 : 4;
      const v: number[] = [];
      for (let k = 0; k < n; k++) {
        const t = num();
        if (t === undefined) break;
        v.push(t);
      }
      if (v.length < n) break;
      push(rel ? x + v[n - 2] : v[n - 2], rel ? y + v[n - 1] : v[n - 1]);
      continue;
    }
    i++;
  }
  return out.filter((p) => p.points.length >= 2);
}

/** First arc ('M x y A …') of an EasyEDA ARC path, in path coordinates. */
export function firstArc(d: string): { arc?: SvgArc; start: [number, number]; end: [number, number] } | undefined {
  const toks: (string | number)[] = [];
  for (const m of d.matchAll(CMD_RE)) toks.push(m[1] !== undefined ? m[1] : parseFloat(m[2]));
  const mi = toks.findIndex((t) => t === 'M' || t === 'm');
  const ai = toks.findIndex((t) => t === 'A' || t === 'a');
  if (mi < 0 || ai < 0) return undefined;
  const x1 = toks[mi + 1];
  const y1 = toks[mi + 2];
  const v = toks.slice(ai + 1, ai + 8);
  if (typeof x1 !== 'number' || typeof y1 !== 'number' || v.length < 7 || v.some((t) => typeof t !== 'number')) return undefined;
  const [rx, ry, rot, la, sw, ex0, ey0] = v as number[];
  const rel = toks[ai] === 'a';
  const ex = rel ? x1 + ex0 : ex0;
  const ey = rel ? y1 + ey0 : ey0;
  return { arc: svgArcToCenter(x1, y1, rx, ry, rot, la !== 0, sw !== 0, ex, ey), start: [x1, y1], end: [ex, ey] };
}
