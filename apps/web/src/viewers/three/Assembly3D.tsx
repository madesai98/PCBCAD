import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import type { Assembly3DProps } from './types';

// three.js (~600 kB) is only fetched when a 3D view is actually rendered.
const Impl = lazy(() => import('./Assembly3DImpl'));

function Fallback({ className, style }: Pick<Assembly3DProps, 'className' | 'style'>) {
  return (
    <div className={`relative grid h-full min-h-[240px] w-full place-items-center bg-(--canvas) ${className ?? ''}`} style={style}>
      <div className="flex items-center gap-2 text-[12px] text-(--text-dim)">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading 3D engine…
      </div>
    </div>
  );
}

/**
 * Interactive three.js assembly viewer: boards (PCB-textured), components, mechanical parts,
 * fasteners, explode / x-ray / section, structural / airflow / PCB-thermal overlays.
 */
export function Assembly3D(props: Assembly3DProps) {
  return (
    <Suspense fallback={<Fallback className={props.className} style={props.style} />}>
      <Impl {...props} />
    </Suspense>
  );
}
