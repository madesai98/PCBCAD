import { newId, nowIso, pack, type SimKind, type SimSummary, type SimulationRun } from '@pcbcad/core';
import type { ToolContext } from '../design/registry';

/** JSON replacer that stores typed arrays compactly as PackedArray. */
export function typedArrayReplacer(_key: string, value: unknown) {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const v = value as unknown as Float32Array;
    if (v instanceof Float64Array) return pack(new Float32Array(v), 'f32');
    return pack(v as never);
  }
  return value;
}

export interface SimTaskOutput<R = unknown> {
  result: R;
  summary: SimSummary;
  text: string;
}

/**
 * Runs a simulation task in the worker pool while tracking it as a SimulationRun in the
 * project (status, live progress for the UI, summary, result asset).
 */
export async function runSimulation<R>(
  ctx: ToolContext,
  spec: { kind: SimKind; title: string; target: SimulationRun['target']; params: Record<string, unknown>; task: string; payload: unknown; timeoutMs?: number },
): Promise<{ run: SimulationRun; out: SimTaskOutput<R> }> {
  const { session, services } = ctx;
  const run: SimulationRun = {
    id: newId('sim'),
    kind: spec.kind,
    title: spec.title,
    target: spec.target,
    params: spec.params,
    status: 'running',
    progress: 0,
    createdAt: nowIso(),
  };
  session.mutate(ctx, 'simulation', (p) => {
    p.simulations.push(run);
    if (p.simulations.length > 80) p.simulations.splice(0, p.simulations.length - 80);
    return `Started ${spec.title}`;
  });
  const started = Date.now();
  let lastEmit = 0;
  const pid = session.id;
  try {
    const out = await services.tasks.run<SimTaskOutput<R>>(spec.task, spec.payload, {
      signal: ctx.signal,
      timeoutMs: spec.timeoutMs,
      onProgress: (f, message) => {
        const now = Date.now();
        if (now - lastEmit < 200 && f < 1) return;
        lastEmit = now;
        const live = session.project.simulations.find((s) => s.id === run.id);
        if (live) live.progress = f;
        services.hub.toProject(pid, { kind: 'sim.progress', projectId: pid, runId: run.id, progress: f, status: 'running', message });
      },
    });
    const assetId = `sim_${run.id}.json`;
    services.store.putAsset(pid, assetId, JSON.stringify(out.result, typedArrayReplacer));
    session.mutate(ctx, 'simulation', (p) => {
      const live = p.simulations.find((s) => s.id === run.id);
      if (!live) return null;
      live.status = 'done';
      live.progress = 1;
      live.finishedAt = nowIso();
      live.durationMs = Date.now() - started;
      live.summary = out.summary;
      live.resultAssetId = assetId;
      Object.assign(run, live);
      return `${spec.title}: ${out.summary.headline}`;
    });
    services.hub.toProject(pid, { kind: 'sim.progress', projectId: pid, runId: run.id, progress: 1, status: 'done' });
    return { run, out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    session.mutate(ctx, 'simulation', (p) => {
      const live = p.simulations.find((s) => s.id === run.id);
      if (!live) return null;
      live.status = 'error';
      live.error = msg;
      live.finishedAt = nowIso();
      live.durationMs = Date.now() - started;
      return `${spec.title} failed: ${msg}`;
    });
    services.hub.toProject(pid, { kind: 'sim.progress', projectId: pid, runId: run.id, progress: 1, status: 'error', message: msg });
    throw e;
  }
}
