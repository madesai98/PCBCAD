import { useEffect, useState } from 'react';
import type { SimKind, SimResult, SimulationRun } from '@pcbcad/core';
import { loadSimResult } from './api';
import { useApp } from './store';

/** Load a simulation result asset (cached). */
export function useSimResult<T extends SimResult>(run: SimulationRun | undefined | null): { data: T | null; loading: boolean; error: string | null } {
  const projectId = useApp((s) => s.projectId);
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: false, error: null });
  const assetId = run?.status === 'done' ? run.resultAssetId : undefined;
  useEffect(() => {
    if (!projectId || !assetId) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    loadSimResult<T>(projectId, assetId)
      .then((data) => !cancelled && setState({ data, loading: false, error: null }))
      .catch((e) => !cancelled && setState({ data: null, loading: false, error: String(e.message ?? e) }));
    return () => {
      cancelled = true;
    };
  }, [projectId, assetId]);
  return state;
}

/** Latest finished run of a kind (optionally for a board). */
export function useLatestRun(kind: SimKind, boardId?: string): SimulationRun | undefined {
  return useApp((s) => {
    const runs = s.project?.simulations ?? [];
    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i];
      if (r.kind === kind && r.status === 'done' && (!boardId || r.target.boardId === boardId)) return r;
    }
    return undefined;
  });
}
