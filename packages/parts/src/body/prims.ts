import type { BodyPrimitive, Vec2, Vec3 } from '@pcbcad/core';
import { rnd } from '../util/num';

/** Material colours for generated bodies (sRGB hex). */
export const C = {
  epoxy: '#1d1d1f',
  epoxyMark: '#5c5c62',
  tin: '#c7ccd1',
  gold: '#d2a83e',
  copper: '#b8733f',
  steel: '#9fa5ab',
  aluminium: '#d2d6db',
  shell: '#b8bcc2',
  ceramicTan: '#c9a777',
  substrate: '#f0ede4',
  resistorTop: '#161616',
  inductor: '#3a3b3e',
  ledBody: '#f3f0e8',
  jstNatural: '#efe8d4',
  xhNatural: '#f3efe4',
  shNatural: '#ece4cf',
  headerBlack: '#1f1f22',
  dark: '#070707',
  tongue: '#2c2c30',
  crystalBase: '#e7dcc6',
  pcbGreen: '#21492f',
  pcbBlue: '#1c3b6c',
  terminalGreen: '#2f8a52',
  sleeveBlack: '#17181b',
  sleeveBlue: '#1d3264',
  stripe: '#c9ced6',
  glassRed: '#8a2323',
  melfBlue: '#3f6f9f',
} as const;

const LED_COLORS: Record<string, string> = {
  red: '#ff3b30',
  green: '#30d158',
  'emerald green': '#1fd17a',
  'yellow green': '#a6e22e',
  blue: '#0a84ff',
  yellow: '#ffd60a',
  orange: '#ff9f0a',
  amber: '#ffb000',
  white: '#f5f7fa',
  'warm white': '#fff1d6',
  'cold white': '#eef6ff',
  pink: '#ff6fae',
  purple: '#bf5af2',
  uv: '#8e5cff',
  infrared: '#4b2b2b',
  ir: '#4b2b2b',
  rgb: '#e8e8e8',
};

/** Resolve a colour name ('red', 'Emerald Green') or hex string to hex; undefined if unknown. */
export function resolveColor(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const t = c.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(t)) return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`.toLowerCase();
  const k = t.toLowerCase();
  if (LED_COLORS[k]) return LED_COLORS[k];
  for (const [name, hex] of Object.entries(LED_COLORS)) if (k.includes(name)) return hex;
  return undefined;
}

const r3 = (v: number) => rnd(v, 4);
const v3 = (v: Vec3): Vec3 => [r3(v[0]), r3(v[1]), r3(v[2])];

/** Axis-aligned box from its centre and size. */
export function box(center: Vec3, size: Vec3, color: string, o: { metal?: boolean; radius?: number; rotation?: Vec3 } = {}): BodyPrimitive {
  const p: BodyPrimitive = { kind: 'box', center: v3(center), size: v3([Math.abs(size[0]), Math.abs(size[1]), Math.abs(size[2])]), color };
  if (o.metal) p.metal = true;
  if (o.radius) p.radius = r3(o.radius);
  if (o.rotation) p.rotation = o.rotation;
  return p;
}

/** Box spanning [x0,x1] × [y0,y1] × [z0,z1] (any order). */
export function boxSpan(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: string, o: { metal?: boolean; radius?: number } = {}): BodyPrimitive {
  return box([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [x1 - x0, y1 - y0, z1 - z0], color, o);
}

export function cyl(center: Vec3, radius: number, height: number, axis: 'x' | 'y' | 'z', color: string, o: { metal?: boolean; segments?: number } = {}): BodyPrimitive {
  const p: BodyPrimitive = { kind: 'cylinder', center: v3(center), radius: r3(radius), height: r3(height), axis, color };
  if (o.metal) p.metal = true;
  if (o.segments) p.segments = o.segments;
  return p;
}

export function extrude(points: Vec2[], z0: number, z1: number, color: string, metal = false): BodyPrimitive {
  const p: BodyPrimitive = { kind: 'extrusion', points: points.map((q) => [r3(q[0]), r3(q[1])] as Vec2), z0: r3(z0), z1: r3(z1), color };
  if (metal) p.metal = true;
  return p;
}

/**
 * Gull-wing lead leaving a body side at height `zExit` and landing on the board.
 * `dir` is the outward axis: '+x' | '-x' | '+y' | '-y'. `edge` = body edge coordinate along that
 * axis, `toe` = lead tip coordinate, `across` = lead centre on the other axis.
 */
export function gullLead(dir: '+x' | '-x' | '+y' | '-y', edge: number, toe: number, across: number, width: number, zExit: number, thick = 0.15, color: string = C.tin): BodyPrimitive[] {
  const s = dir === '+x' || dir === '+y' ? 1 : -1;
  const len = Math.abs(toe - edge);
  // Z profile: shoulder out of the body, vertical knee, foot on the board
  const k = edge + s * Math.max(thick, len * 0.4);
  const out: BodyPrimitive[] = [];
  const seg = (u0: number, u1: number, z0: number, z1: number) => {
    const lo = Math.min(u0, u1);
    const hi = Math.max(u0, u1);
    if (dir === '+x' || dir === '-x') out.push(boxSpan(lo, hi, across - width / 2, across + width / 2, z0, z1, color, { metal: true }));
    else out.push(boxSpan(across - width / 2, across + width / 2, lo, hi, z0, z1, color, { metal: true }));
  };
  seg(edge - s * 0.05, k + (s * thick) / 2, zExit - thick / 2, zExit + thick / 2);
  seg(k - thick / 2, k + thick / 2, 0, zExit);
  seg(k - (s * thick) / 2, toe, 0, thick);
  return out;
}

/** Straight THT lead (square cross-section) from z0 to z1 at (x, y). */
export function pinLead(x: number, y: number, z0: number, z1: number, size: number, color: string = C.tin, round = false): BodyPrimitive {
  return round ? cyl([x, y, (z0 + z1) / 2], size / 2, z1 - z0, 'z', color, { metal: true, segments: 12 }) : boxSpan(x - size / 2, x + size / 2, y - size / 2, y + size / 2, z0, z1, color, { metal: true });
}

/** Small pin-1 marking dimple on a top surface. */
export function pin1Mark(x: number, y: number, zTop: number, r: number, color: string = C.epoxyMark): BodyPrimitive {
  return cyl([x, y, zTop + 0.005], r, 0.01, 'z', color, { segments: 20 });
}
