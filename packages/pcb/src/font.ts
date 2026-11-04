/**
 * Minimal single-stroke vector font for silkscreen (A–Z, 0–9 and - _ . + / ( ) , : = # * ' ").
 * Glyphs live on a 4×6 unit cell (cap height 6) with a 6-unit advance; lowercase maps to uppercase.
 */
import { rotate2, type Vec2 } from '@pcbcad/core';

type Glyph = number[][];

/** Polylines as flat [x0,y0,x1,y1,...] arrays in glyph units. */
const G: Record<string, Glyph> = {
  A: [[0, 0, 0, 4, 2, 6, 4, 4, 4, 0], [0, 3, 4, 3]],
  B: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3], [3, 3, 4, 2, 4, 1, 3, 0, 0, 0]],
  C: [[4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0, 3, 0, 4, 1]],
  D: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 1, 3, 0, 0, 0]],
  E: [[4, 6, 0, 6, 0, 0, 4, 0], [0, 3, 3, 3]],
  F: [[4, 6, 0, 6, 0, 0], [0, 3, 3, 3]],
  G: [[4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0, 3, 0, 4, 1, 4, 3, 2, 3]],
  H: [[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]],
  I: [[1, 6, 3, 6], [2, 6, 2, 0], [1, 0, 3, 0]],
  J: [[4, 6, 4, 1, 3, 0, 1, 0, 0, 1]],
  K: [[0, 0, 0, 6], [4, 6, 0, 2], [1.3, 3.3, 4, 0]],
  L: [[0, 6, 0, 0, 4, 0]],
  M: [[0, 0, 0, 6, 2, 3, 4, 6, 4, 0]],
  N: [[0, 0, 0, 6, 4, 0, 4, 6]],
  O: [[1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 1, 3, 0, 1, 0]],
  P: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3]],
  Q: [[1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 1, 3, 0, 1, 0], [2, 2, 4, 0]],
  R: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3], [2, 3, 4, 0]],
  S: [[4, 5, 3, 6, 1, 6, 0, 5, 0, 4, 1, 3, 3, 3, 4, 2, 4, 1, 3, 0, 1, 0, 0, 1]],
  T: [[0, 6, 4, 6], [2, 6, 2, 0]],
  U: [[0, 6, 0, 1, 1, 0, 3, 0, 4, 1, 4, 6]],
  V: [[0, 6, 2, 0, 4, 6]],
  W: [[0, 6, 1, 0, 2, 3, 3, 0, 4, 6]],
  X: [[0, 0, 4, 6], [0, 6, 4, 0]],
  Y: [[0, 6, 2, 3, 4, 6], [2, 3, 2, 0]],
  Z: [[0, 6, 4, 6, 0, 0, 4, 0]],
  '0': [[1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 1, 3, 0, 1, 0], [0.5, 1, 3.5, 5]],
  '1': [[1, 5, 2, 6, 2, 0], [1, 0, 3, 0]],
  '2': [[0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 0, 0, 4, 0]],
  '3': [[0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 4, 2, 4, 1, 3, 0, 1, 0, 0, 1], [1.5, 3, 3, 3]],
  '4': [[3, 0, 3, 6, 0, 2, 4, 2]],
  '5': [[4, 6, 0, 6, 0, 3, 3, 3, 4, 2, 4, 1, 3, 0, 1, 0, 0, 1]],
  '6': [[4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 3, 3, 0, 3]],
  '7': [[0, 6, 4, 6, 1, 0]],
  '8': [[1, 3, 0, 4, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 1, 3, 0, 2, 0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 3, 3]],
  '9': [[0, 1, 1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 4, 1, 3, 4, 3]],
  '-': [[1, 3, 3, 3]],
  _: [[0, -0.5, 4, -0.5]],
  '.': [[2, 0, 2, 0.4]],
  ',': [[2.2, 0.6, 1.6, -1]],
  '+': [[2, 1, 2, 5], [0, 3, 4, 3]],
  '/': [[0, 0, 4, 6]],
  '(': [[3, 6, 2, 5, 2, 1, 3, 0]],
  ')': [[1, 6, 2, 5, 2, 1, 1, 0]],
  ':': [[2, 1, 2, 1.4], [2, 4.4, 2, 4.8]],
  '=': [[0.5, 2, 3.5, 2], [0.5, 4, 3.5, 4]],
  '#': [[1, 0, 1.5, 6], [2.5, 0, 3, 6], [0, 2, 4, 2], [0, 4, 4, 4]],
  '*': [[2, 1.5, 2, 4.5], [0.7, 2.25, 3.3, 3.75], [0.7, 3.75, 3.3, 2.25]],
  "'": [[2, 6, 2, 4.5]],
  '"': [[1.3, 6, 1.3, 4.5], [2.7, 6, 2.7, 4.5]],
  '?': [[0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 2, 3, 2, 1.5], [2, 0, 2, 0.4]],
  '%': [[0, 0, 4, 6], [0.5, 5, 0.5, 5.5], [3.5, 0.5, 3.5, 1]],
};

const ADVANCE = 6;

export interface TextOptions {
  /** Anchor point (board frame, mm). */
  at: Vec2;
  /** Cap height (mm). */
  size: number;
  /** Degrees CCW. */
  rotation?: number;
  /** Mirror horizontally (bottom-side text, read from below). */
  mirror?: boolean;
  justify?: 'left' | 'center' | 'right';
  vjustify?: 'bottom' | 'middle' | 'top';
}

/** True when the font has a glyph for the character (space is always supported). */
export function hasGlyph(ch: string): boolean {
  return ch === ' ' || G[ch.toUpperCase()] !== undefined;
}

/** Width (mm) of a text string at the given cap height. */
export function textWidth(text: string, size: number): number {
  const n = [...text].length;
  return n === 0 ? 0 : ((n * ADVANCE - 2) * size) / 6;
}

/** Default stroke width (mm) for text of the given cap height (≥ 0.15 mm, fab minimum). */
export function strokeWidthFor(size: number): number {
  return Math.max(0.15, Math.round(size * 0.15 * 1000) / 1000);
}

/**
 * Render text to stroke polylines in board frame. Unknown characters render as a blank advance.
 * Combine with {@link strokeWidthFor} for the pen width.
 */
export function strokeText(text: string, o: TextOptions): Vec2[][] {
  const s = o.size / 6;
  const chars = [...text.toUpperCase()];
  const width = textWidth(text, o.size);
  const height = o.size;
  const dx = o.justify === 'center' ? -width / 2 : o.justify === 'right' ? -width : 0;
  const dy = o.vjustify === 'middle' ? -height / 2 : o.vjustify === 'top' ? -height : 0;
  const out: Vec2[][] = [];
  chars.forEach((ch, i) => {
    const g = G[ch];
    if (!g) return;
    for (const stroke of g) {
      const poly: Vec2[] = [];
      for (let k = 0; k < stroke.length; k += 2) {
        let x = dx + (i * ADVANCE + stroke[k]) * s;
        const y = dy + stroke[k + 1] * s;
        if (o.mirror) x = -x;
        const r = rotate2([x, y], o.rotation ?? 0);
        poly.push([o.at[0] + r[0], o.at[1] + r[1]]);
      }
      out.push(poly);
    }
  });
  return out;
}
