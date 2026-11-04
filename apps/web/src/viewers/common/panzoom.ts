/**
 * Pointer/wheel/pinch pan-zoom controller for 2D viewers (SVG schematic, Canvas2D PCB).
 *
 * The view maps world → screen (CSS px, relative to the element) as
 *     sx = x + k · wx        sy = y ± k · wy
 * (the sign of the Y term is the consumer's business — zoom-about-point and pan are identical
 * for Y-up and Y-down worlds). Consumers get `onChange(view)` on every change and should redraw
 * via requestAnimationFrame; the controller never touches React state.
 */

export interface View2D {
  k: number;
  x: number;
  y: number;
}

export interface PanZoomOptions {
  onChange: (v: View2D) => void;
  /** Click (pointer down+up without dragging). Coordinates relative to the element. */
  onClick?: (sx: number, sy: number, e: PointerEvent) => void;
  onDoubleClick?: (sx: number, sy: number, e: MouseEvent) => void;
  /** Pointer moved without a button pressed (or mid-drag with `dragging` = true). */
  onHover?: (sx: number, sy: number, e: PointerEvent, dragging: boolean) => void;
  onLeave?: () => void;
  /** Allowed zoom range (evaluated lazily so it can depend on the fit scale). */
  minK?: () => number;
  maxK?: () => number;
}

const DRAG_THRESHOLD = 4;

export class PanZoom {
  view: View2D = { k: 1, x: 0, y: 0 };
  private el: HTMLElement;
  private opts: PanZoomOptions;
  private pointers = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number; id: number; moved: boolean } | null = null;
  private pinch: { dist: number; cx: number; cy: number } | null = null;
  private anim = 0;
  private cleanup: (() => void)[] = [];
  /** True while a drag/pinch is in progress. */
  interacting = false;

  constructor(el: HTMLElement, opts: PanZoomOptions) {
    this.el = el;
    this.opts = opts;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, o);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, o));
    };
    on('pointerdown', this.onPointerDown);
    on('pointermove', this.onPointerMove);
    on('pointerup', this.onPointerUp);
    on('pointercancel', this.onPointerUp);
    on('pointerleave', this.onPointerLeave);
    on('wheel', this.onWheel, { passive: false });
    on('dblclick', this.onDblClick);
    el.style.touchAction = 'none';
  }

  destroy() {
    cancelAnimationFrame(this.anim);
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
  }

  set(v: View2D, notify = true) {
    cancelAnimationFrame(this.anim);
    this.view = { ...v };
    if (notify) this.opts.onChange(this.view);
  }

  /** Smoothly animate to a target view (ease-out cubic). */
  animateTo(target: View2D, ms = 260) {
    cancelAnimationFrame(this.anim);
    const from = { ...this.view };
    if (ms <= 0 || typeof requestAnimationFrame === 'undefined') {
      this.set(target);
      return;
    }
    const t0 = performance.now();
    // Interpolate in log-zoom space so the motion feels uniform.
    const lk0 = Math.log(from.k);
    const lk1 = Math.log(target.k);
    const step = () => {
      const u = Math.min(1, (performance.now() - t0) / ms);
      const e = 1 - Math.pow(1 - u, 3);
      this.view = {
        k: Math.exp(lk0 + (lk1 - lk0) * e),
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
      };
      this.opts.onChange(this.view);
      if (u < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const { k, x, y } = this.view;
    const minK = this.opts.minK?.() ?? 1e-6;
    const maxK = this.opts.maxK?.() ?? 1e6;
    const nk = Math.max(minK, Math.min(maxK, k * factor));
    const f = nk / k;
    if (f === 1) return;
    this.view = { k: nk, x: sx - (sx - x) * f, y: sy - (sy - y) * f };
    this.opts.onChange(this.view);
  }

  panBy(dx: number, dy: number) {
    this.view = { ...this.view, x: this.view.x + dx, y: this.view.y + dy };
    this.opts.onChange(this.view);
  }

  private local(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    // Let interactive overlay controls (buttons, inputs) receive their own events.
    const t = e.target as HTMLElement | null;
    if (t && t !== this.el && t.closest('[data-pz-ignore]')) return;
    cancelAnimationFrame(this.anim);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (this.pointers.size === 1) {
      this.down = { x: p.x, y: p.y, id: e.pointerId, moved: false };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      if (this.down) this.down.moved = true; // a pinch is never a click
      this.interacting = true;
    }
    if (e.button === 1) e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent) => {
    const p = this.local(e);
    const prev = this.pointers.get(e.pointerId);
    if (!prev) {
      this.opts.onHover?.(p.x, p.y, e, false);
      return;
    }
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size >= 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      if (this.pinch.dist > 0) this.zoomAt(cx, cy, dist / this.pinch.dist);
      this.panBy(cx - this.pinch.cx, cy - this.pinch.cy);
      this.pinch = { dist, cx, cy };
      return;
    }
    if (this.down && e.pointerId === this.down.id) {
      if (!this.down.moved && Math.hypot(p.x - this.down.x, p.y - this.down.y) > DRAG_THRESHOLD) {
        this.down.moved = true;
        this.interacting = true;
        this.el.style.cursor = 'grabbing';
      }
      if (this.down.moved) this.panBy(p.x - prev.x, p.y - prev.y);
      this.opts.onHover?.(p.x, p.y, e, this.down.moved);
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const had = this.pointers.delete(e.pointerId);
    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!had) return;
    if (this.pointers.size < 2) this.pinch = null;
    if (this.down && this.down.id === e.pointerId) {
      const wasClick = !this.down.moved && e.type === 'pointerup';
      this.down = null;
      this.el.style.cursor = '';
      if (wasClick) {
        const p = this.local(e);
        this.opts.onClick?.(p.x, p.y, e);
      }
    }
    if (this.pointers.size === 0) {
      this.interacting = false;
      this.down = null;
    }
  };

  private onPointerLeave = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) this.opts.onLeave?.();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.local(e);
    // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels as larger steps.
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1;
    const dy = e.deltaY * unit;
    const speed = e.ctrlKey ? 0.01 : 0.0018;
    const factor = Math.exp(-dy * speed);
    this.zoomAt(p.x, p.y, Math.max(0.5, Math.min(2, factor)));
  };

  private onDblClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && t !== this.el && t.closest('[data-pz-ignore]')) return;
    const p = this.local(e);
    this.opts.onDoubleClick?.(p.x, p.y, e);
  };
}

/** View that fits a world bbox into a viewport (CSS px) with padding, for a Y-up (flipY) or Y-down world. */
export function fitView(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  width: number,
  height: number,
  opts: { padding?: number; flipY?: boolean; mirrorX?: boolean; maxK?: number } = {},
): View2D {
  const pad = opts.padding ?? 24;
  const bw = Math.max(1e-6, bbox.maxX - bbox.minX);
  const bh = Math.max(1e-6, bbox.maxY - bbox.minY);
  const k = Math.min(opts.maxK ?? Infinity, Math.max(1e-6, Math.min((width - pad * 2) / bw, (height - pad * 2) / bh)));
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  const sxSign = opts.mirrorX ? -1 : 1;
  const sySign = opts.flipY ? -1 : 1;
  return { k, x: width / 2 - sxSign * k * cx, y: height / 2 - sySign * k * cy };
}
