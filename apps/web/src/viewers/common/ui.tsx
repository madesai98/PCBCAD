import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Join class names, skipping falsy values. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Floating glass panel used for viewer toolbars/legends. Marked so pan/zoom ignores it. */
export function FloatPanel({ className, children, style }: { className?: string; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      data-pz-ignore=""
      style={style}
      className={cx(
        'pointer-events-auto rounded-lg border border-(--border) bg-(--bg-elev)/85 shadow-[0_1px_2px_rgba(0,0,0,.06),0_8px_24px_-12px_rgba(0,0,0,.35)] backdrop-blur-md',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ToolButton({
  title,
  active,
  onClick,
  children,
  disabled,
  className,
}: {
  title: string;
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-[12px] font-medium transition-colors',
        'text-(--text-dim) hover:bg-(--bg-sunken) hover:text-(--text) disabled:opacity-40',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-500',
        active && 'bg-accent-500/12 text-accent-700 hover:bg-accent-500/18 hover:text-accent-700 dark:text-accent-300 dark:hover:text-accent-200',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function ToolDivider() {
  return <div className="mx-0.5 h-4 w-px bg-(--border)" />;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'sm',
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'xs';
  className?: string;
}) {
  return (
    <div data-pz-ignore="" className={cx('inline-flex items-center rounded-md bg-(--bg-sunken) p-0.5', className)} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'inline-flex items-center gap-1 rounded-[5px] font-medium transition-all',
            size === 'xs' ? 'h-5 px-1.5 text-[11px]' : 'h-6 px-2 text-[12px]',
            o.value === value
              ? 'bg-(--bg-elev) text-(--text) shadow-[0_1px_2px_rgba(0,0,0,.12)]'
              : 'text-(--text-dim) hover:text-(--text)',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Button + anchored panel; closes on outside click / Escape. */
export function Popover({
  trigger,
  children,
  align = 'left',
  className,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative" data-pz-ignore="">
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div
          className={cx(
            'absolute top-full z-30 mt-1.5 min-w-[190px] rounded-lg border border-(--border) bg-(--bg-elev) p-1 shadow-[0_12px_32px_-12px_rgba(0,0,0,.45)]',
            align === 'right' ? 'right-0' : 'left-0',
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** Checkbox row with a colour swatch (layer toggles). */
export function SwatchToggle({
  label,
  color,
  checked,
  onChange,
  hint,
}: {
  label: string;
  color: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-(--text) hover:bg-(--bg-sunken)"
    >
      <span
        className="h-3 w-3 shrink-0 rounded-[3px] border transition-opacity"
        style={{ background: checked ? color : 'transparent', borderColor: color, opacity: checked ? 1 : 0.55 }}
      />
      <span className={cx('flex-1', !checked && 'text-(--text-dim)')}>{label}</span>
      {hint && <kbd className="font-mono text-[10px] text-(--text-dim)">{hint}</kbd>}
    </button>
  );
}

/** Tooltip card positioned near a point inside a relatively positioned container. */
export function HoverCard({
  x,
  y,
  containerW,
  containerH,
  children,
}: {
  x: number;
  y: number;
  containerW: number;
  containerH: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 200, h: 60 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
  });
  const off = 14;
  let left = x + off;
  let top = y + off;
  if (left + box.w > containerW - 6) left = Math.max(6, x - off - box.w);
  if (top + box.h > containerH - 6) top = Math.max(6, y - off - box.h);
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-20 max-w-[280px] rounded-lg border border-(--border) bg-(--bg-elev)/95 px-2.5 py-2 text-[12px] leading-snug text-(--text) shadow-[0_10px_30px_-10px_rgba(0,0,0,.5)] backdrop-blur-md"
      style={{ left, top }}
    >
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-(--border) bg-(--bg-sunken) px-1 font-mono text-[10px] text-(--text-dim)">{children}</kbd>;
}
