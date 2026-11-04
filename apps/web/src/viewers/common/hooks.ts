import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface Size {
  width: number;
  height: number;
}

/**
 * Tracks an element's content-box size with ResizeObserver. Returns a callback ref so it works
 * for conditionally rendered elements.
 */
export function useElementSize<T extends HTMLElement = HTMLDivElement>(): [(el: T | null) => void, Size, React.RefObject<T | null>] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const roRef = useRef<ResizeObserver | null>(null);
  const setRef = useCallback((el: T | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    ref.current = el;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      setSize((s) => (s.width === w && s.height === h ? s : { width: w, height: h }));
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      roRef.current = ro;
    }
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);
  return [setRef, size, ref];
}

/** Keeps a ref pointing at the latest value (for use inside long-lived callbacks). */
export function useLatest<T>(value: T): React.RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** requestAnimationFrame-coalesced invalidation. */
export function useRafCallback(fn: () => void): () => void {
  const fnRef = useLatest(fn);
  const raf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      fnRef.current();
    });
  }, [fnRef]);
}

export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [dpr]);
  return dpr;
}
