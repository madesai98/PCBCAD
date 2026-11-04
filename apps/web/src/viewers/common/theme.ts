import { useLayoutEffect, useMemo, useState, useSyncExternalStore, type RefObject } from 'react';
import type { NetClass } from '@pcbcad/core';
import { luminance } from './color';

/**
 * Resolved theme for canvas / SVG / WebGL drawing. Values come from the app's CSS variables
 * (--bg, --bg-elev, --bg-sunken, --border, --text, --text-dim, --canvas, accent scale) so the
 * viewers follow the `dark` class on <html> (or any ancestor) automatically.
 */
export interface ViewerTheme {
  dark: boolean;
  bg: string;
  bgElev: string;
  bgSunken: string;
  border: string;
  text: string;
  textDim: string;
  canvas: string;
  /** Accent for selections / focus (cyan 400 in dark, 600 in light). */
  accent: string;
  /** Softer accent used for hover. */
  accentSoft: string;
  ok: string;
  warn: string;
  fail: string;
  info: string;
  fontSans: string;
  fontMono: string;
  /** Categorical palette for plot series. */
  series: string[];
  /** Net-class colours (schematic labels, plots). */
  netClass: Record<NetClass, string>;
}

const DARK_SERIES = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#fb7185', '#60a5fa', '#a3e635', '#fb923c', '#e879f9', '#2dd4bf'];
const LIGHT_SERIES = ['#0891b2', '#d97706', '#7c3aed', '#059669', '#e11d48', '#2563eb', '#65a30d', '#ea580c', '#c026d3', '#0d9488'];

const FALLBACK_DARK = {
  bg: '#0b0d10',
  bgElev: '#12151a',
  bgSunken: '#0e1115',
  border: '#22272e',
  text: '#e6e9ef',
  textDim: '#8b93a1',
  canvas: '#0d1014',
};

const FALLBACK_LIGHT = {
  bg: '#f7f8fa',
  bgElev: '#ffffff',
  bgSunken: '#eef0f3',
  border: '#e3e6ea',
  text: '#0f172a',
  textDim: '#5b6472',
  canvas: '#f2f4f7',
};

/* ------------------------------- change notification (class toggles) ------------------------------ */

let version = 0;
const listeners = new Set<() => void>();
let observing = false;

function bump() {
  version++;
  listeners.forEach((l) => l());
}

function ensureObserver() {
  if (observing || typeof window === 'undefined' || typeof MutationObserver === 'undefined') return;
  observing = true;
  const mo = new MutationObserver(bump);
  const opts: MutationObserverInit = { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] };
  mo.observe(document.documentElement, opts);
  if (document.body) mo.observe(document.body, opts);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', bump);
}

function subscribe(cb: () => void) {
  ensureObserver();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Increments whenever the document theme (class/style on html/body) changes. */
export function useThemeVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

/* ------------------------------------------- reading ------------------------------------------- */

function cssVar(style: CSSStyleDeclaration | null, name: string, fallback: string): string {
  if (!style) return fallback;
  const v = style.getPropertyValue(name).trim();
  return v || fallback;
}

export function readTheme(el?: Element | null): ViewerTheme {
  const target = el ?? (typeof document !== 'undefined' ? document.documentElement : null);
  const style = target && typeof getComputedStyle !== 'undefined' ? getComputedStyle(target) : null;
  // Decide dark/light from the resolved background so nested theme scopes work too.
  const bgProbe = cssVar(style, '--bg', '');
  const classDark = typeof document !== 'undefined' && !!(target?.closest?.('.dark') ?? document.documentElement.classList.contains('dark'));
  const dark = bgProbe ? luminance(bgProbe) < 0.3 : classDark;
  const fb = dark ? FALLBACK_DARK : FALLBACK_LIGHT;
  const bodyFont = typeof document !== 'undefined' && document.body ? getComputedStyle(document.body).fontFamily : '';
  const fontSans = cssVar(style, '--font-sans', bodyFont || 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif');
  const fontMono = cssVar(style, '--font-mono', '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace');
  return {
    dark,
    bg: cssVar(style, '--bg', fb.bg),
    bgElev: cssVar(style, '--bg-elev', fb.bgElev),
    bgSunken: cssVar(style, '--bg-sunken', fb.bgSunken),
    border: cssVar(style, '--border', fb.border),
    text: cssVar(style, '--text', fb.text),
    textDim: cssVar(style, '--text-dim', fb.textDim),
    canvas: cssVar(style, '--canvas', fb.canvas),
    accent: dark ? cssVar(style, '--color-accent-400', '#22d3ee') : cssVar(style, '--color-accent-600', '#0891b2'),
    accentSoft: dark ? cssVar(style, '--color-accent-300', '#67e8f9') : cssVar(style, '--color-accent-500', '#06b6d4'),
    ok: dark ? '#34d399' : '#059669',
    warn: dark ? '#fbbf24' : '#d97706',
    fail: dark ? '#f87171' : '#dc2626',
    info: dark ? '#60a5fa' : '#2563eb',
    fontSans,
    fontMono,
    series: dark ? DARK_SERIES : LIGHT_SERIES,
    netClass: dark
      ? { power: '#f87171', ground: '#94a3b8', signal: '#22d3ee', 'high-speed': '#c084fc', analog: '#4ade80' }
      : { power: '#dc2626', ground: '#64748b', signal: '#0891b2', 'high-speed': '#9333ea', analog: '#16a34a' },
  };
}

/**
 * Theme for a viewer. Pass the viewer's root element ref so nested theme scopes are honoured;
 * re-reads whenever the document theme changes.
 */
export function useViewerTheme(ref?: RefObject<Element | null>): ViewerTheme {
  const v = useThemeVersion();
  const [mounted, setMounted] = useState(0);
  useLayoutEffect(() => {
    setMounted((m) => m + 1);
  }, []);
  return useMemo(() => readTheme(ref?.current ?? null), [v, mounted, ref]);
}

export function statusColor(theme: ViewerTheme, status: 'ok' | 'warn' | 'fail' | undefined): string {
  return status === 'fail' ? theme.fail : status === 'warn' ? theme.warn : status === 'ok' ? theme.ok : theme.textDim;
}
