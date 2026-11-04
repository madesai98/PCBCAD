/**
 * Perceptual colormaps for simulation overlays.
 *  - turbo:   Google's improved rainbow (polynomial fit by Anton Mikhailov, max error < 1%).
 *  - inferno: matplotlib's inferno (6th-order polynomial fit by Matt Zucker).
 * All functions take t in [0, 1] (clamped) and return [r, g, b] in 0..1 (sRGB).
 */

export type ColormapName = 'turbo' | 'inferno';
export type RGB = [number, number, number];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function turbo(t: number): RGB {
  const x = clamp01(Number.isFinite(t) ? t : 0);
  const x2 = x * x;
  const x3 = x2 * x;
  const x4 = x2 * x2;
  const x5 = x4 * x;
  return [
    clamp01(0.13572138 + 4.6153926 * x - 42.66032258 * x2 + 132.13108234 * x3 - 152.94239396 * x4 + 59.28637943 * x5),
    clamp01(0.09140261 + 2.19418839 * x + 4.84296658 * x2 - 14.18503333 * x3 + 4.27729857 * x4 + 2.82956604 * x5),
    clamp01(0.1066733 + 12.64194608 * x - 60.58204836 * x2 + 110.36276771 * x3 - 89.90310912 * x4 + 27.34824973 * x5),
  ];
}

const INF = [
  [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
  [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
  [11.60249308247187, -3.972853965665698, -15.9423941062914],
  [-41.70399613139459, 17.43639888205313, 44.35414519872813],
  [77.162935699427, -33.40235894210092, -81.80730925738993],
  [-71.31942824499214, 32.62606426397723, 73.20951985803202],
  [25.13112622477341, -12.24266895238567, -23.07032500287172],
];

export function inferno(t: number): RGB {
  const x = clamp01(Number.isFinite(t) ? t : 0);
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let v = INF[6][c];
    for (let i = 5; i >= 0; i--) v = INF[i][c] + x * v;
    out[c] = clamp01(v);
  }
  return out;
}

export function colormap(name: ColormapName): (t: number) => RGB {
  return name === 'inferno' ? inferno : turbo;
}

const lutCache = new Map<string, Uint8ClampedArray>();

/** n-entry RGB lookup table (Uint8, 3 bytes per entry) for fast per-pixel colouring. */
export function colormapLUT(name: ColormapName, n = 256): Uint8ClampedArray {
  const key = `${name}:${n}`;
  const hit = lutCache.get(key);
  if (hit) return hit;
  const f = colormap(name);
  const lut = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = f(i / (n - 1));
    lut[i * 3] = r * 255;
    lut[i * 3 + 1] = g * 255;
    lut[i * 3 + 2] = b * 255;
  }
  lutCache.set(key, lut);
  return lut;
}

/** CSS rgb() string for t. */
export function colormapCss(name: ColormapName, t: number, alpha = 1): string {
  const [r, g, b] = colormap(name)(t);
  return alpha >= 1
    ? `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
    : `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
}

/** CSS linear-gradient() sampling the colormap. */
export function colormapGradient(name: ColormapName, direction = 'to right', stops = 16): string {
  const parts: string[] = [];
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1);
    parts.push(`${colormapCss(name, t)} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(${direction}, ${parts.join(', ')})`;
}
