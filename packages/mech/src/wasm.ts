/**
 * manifold-3d (WASM CSG kernel) loading. The module is imported lazily so that the pure-JS parts of
 * @pcbcad/mech (flat patterns, DFM, voxelization, assembly checks) never pull in WASM.
 *
 * manifold.js locates `manifold.wasm` via `new URL('manifold.wasm', import.meta.url)`, which works
 * unchanged in Node (ESM) and in Vite/browser bundles.
 */
import type { ManifoldToplevel } from 'manifold-3d';

let wasm: ManifoldToplevel | null = null;
let pending: Promise<ManifoldToplevel> | null = null;

/** Idempotent manifold-3d initialisation. Safe to call concurrently; a failed load can be retried. */
export function initGeometry(): Promise<void> {
  if (wasm) return Promise.resolve();
  if (!pending) {
    pending = (async () => {
      const mod = await import('manifold-3d');
      const factory = (mod as unknown as { default: () => Promise<ManifoldToplevel> }).default;
      const w = await factory();
      w.setup();
      wasm = w;
      return w;
    })();
    pending.catch(() => {
      pending = null;
    });
  }
  return pending.then(() => undefined);
}

/** True once initGeometry() has resolved. */
export function geometryReady(): boolean {
  return wasm !== null;
}

/** The initialised manifold module (throws with a helpful message otherwise). */
export function getWasm(): ManifoldToplevel {
  if (!wasm) throw new Error('@pcbcad/mech: geometry kernel not initialised — await initGeometry() first');
  return wasm;
}

/** Collects WASM objects so they can be freed in one go (manifold objects are not garbage-collected). */
export class Arena {
  private items: { delete(): void }[] = [];
  add<T extends { delete(): void }>(x: T): T {
    this.items.push(x);
    return x;
  }
  dispose(): void {
    for (const x of this.items) {
      try {
        x.delete();
      } catch {
        /* already freed */
      }
    }
    this.items = [];
  }
}
