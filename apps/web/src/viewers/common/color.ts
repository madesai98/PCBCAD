/**
 * Tiny colour helpers shared by the canvas/WebGL viewers. Only sRGB hex / rgb() / rgba() strings are
 * parsed — that is what the app's CSS variables and our palettes use.
 */

export type RGBA = [number, number, number, number];

const cache = new Map<string, RGBA>();

/** Parse '#rgb', '#rrggbb', '#rrggbbaa', 'rgb(r,g,b)', 'rgba(r,g,b,a)', 'rgb(r g b / a)'. Channels 0..255, alpha 0..1. */
export function parseColor(input: string, fallback: RGBA = [128, 128, 128, 1]): RGBA {
  const key = input.trim();
  const hit = cache.get(key);
  if (hit) return hit;
  let out: RGBA | null = null;
  if (key.startsWith('#')) {
    const h = key.slice(1);
    if (h.length === 3 || h.length === 4) {
      const v = h.split('').map((c) => parseInt(c + c, 16));
      out = [v[0], v[1], v[2], h.length === 4 ? v[3] / 255 : 1];
    } else if (h.length === 6 || h.length === 8) {
      out = [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
        h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      ];
    }
  } else {
    const m = /^rgba?\(([^)]+)\)$/i.exec(key);
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length >= 3) {
        const ch = (s: string) => (s.endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s));
        const a = parts[3] !== undefined ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
        out = [ch(parts[0]), ch(parts[1]), ch(parts[2]), a];
      }
    }
  }
  if (!out || out.some((v) => Number.isNaN(v))) return fallback;
  if (cache.size > 512) cache.clear();
  cache.set(key, out);
  return out;
}

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');

export function toHex(c: RGBA | [number, number, number]): string {
  return `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;
}

/** Same colour with a new alpha, as an rgba() string. */
export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, alpha * c[3])).toFixed(3)})`;
}

/** Linear mix in sRGB space: t = 0 → a, t = 1 → b. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  return toHex([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]);
}

export function lighten(c: string, t: number): string {
  return mix(c, '#ffffff', t);
}

export function darken(c: string, t: number): string {
  return mix(c, '#000000', t);
}

/** Relative luminance (0..1) of an sRGB colour. */
export function luminance(color: string): number {
  const [r, g, b] = parseColor(color);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Readable text colour (near-black or near-white) on the given background. */
export function contrastText(bg: string): string {
  return luminance(bg) > 0.45 ? '#0b0d10' : '#ffffff';
}
