import {
  findComponent,
  formatValue,
  type Board,
  type ComponentInstance,
  type MechPart,
  type PartDef,
  type Project,
} from '@pcbcad/core';
import { ToolError } from './registry';

export function requireBoard(p: Project, ref?: string): Board {
  if (!ref) {
    if (p.boards.length === 1) return p.boards[0];
    if (p.boards.length === 0) throw new ToolError('No boards yet. Create one with create_board.');
    throw new ToolError(`Several boards exist (${p.boards.map((b) => `${b.name} [${b.id}]`).join(', ')}); pass boardId.`);
  }
  const b = p.boards.find((x) => x.id === ref) ?? p.boards.find((x) => x.name.toLowerCase() === ref.toLowerCase());
  if (!b) throw new ToolError(`Board '${ref}' not found. Boards: ${p.boards.map((x) => `${x.name} [${x.id}]`).join(', ') || 'none'}`);
  return b;
}

export function requireComponent(b: Board, ref: string): ComponentInstance {
  const c = findComponent(b, ref);
  if (!c) throw new ToolError(`Component '${ref}' not found on board '${b.name}'. Refs: ${b.components.map((x) => x.ref).join(', ') || 'none'}`);
  return c;
}

export function requirePart(p: Project, partId: string): PartDef {
  const part = p.parts[partId] ?? Object.values(p.parts).find((x) => x.mpn.toLowerCase() === partId.toLowerCase());
  if (!part) throw new ToolError(`Part '${partId}' is not in the project library. Import it first with import_part (LCSC code like C14877 or an MPN).`);
  return part;
}

export function requireMech(p: Project, id: string): MechPart {
  const m = p.mechanical.find((x) => x.id === id) ?? p.mechanical.find((x) => x.name.toLowerCase() === id.toLowerCase());
  if (!m) throw new ToolError(`Mechanical part '${id}' not found. Parts: ${p.mechanical.map((x) => `${x.name} [${x.id}]`).join(', ') || 'none'}`);
  return m;
}

export function partLabel(part: PartDef): string {
  const lcsc = part.offers.find((o) => o.distributor === 'LCSC' || o.distributor === 'JLCPCB')?.sku;
  return `${part.mpn}${part.value ? ` (${part.value})` : ''} ${part.package}${lcsc ? ` [${lcsc}]` : ''}`;
}

export function fmt(v: number, unit: string, digits = 3) {
  return formatValue(v, unit, digits);
}

export function round(v: number, d = 3) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export function pinList(part: PartDef, max = 80): string {
  const pins = part.pins.slice(0, max).map((p) => `${p.number}:${p.name}`);
  return pins.join(', ') + (part.pins.length > max ? `, … (+${part.pins.length - max})` : '');
}

/** Board staging area for unplaced components (to the right of the outline). */
export function stagingPosition(b: Board): { x: number; y: number } {
  const maxX = Math.max(...b.outline.map((p) => p[0]));
  const maxY = Math.max(...b.outline.map((p) => p[1]));
  const unplaced = b.components.filter((c) => !c.placed).length;
  const col = Math.floor(unplaced / 8);
  const row = unplaced % 8;
  return { x: maxX + 8 + col * 10, y: maxY - 4 - row * 7 };
}

export function boardSize(b: Board) {
  const xs = b.outline.map((p) => p[0]);
  const ys = b.outline.map((p) => p[1]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

export function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export function table(rows: (string | number)[][]): string {
  return rows.map((r) => r.join(' | ')).join('\n');
}
