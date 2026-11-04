/**
 * End-to-end check: starts a bridge on a temp data dir, creates a project, runs the scripted
 * demo agent (which drives the real MCP proxy → bridge → engines), and reports the result.
 *
 *   npx tsx apps/server/scripts/e2e-demo.ts [--keep] [--provider demo|claude] [--prompt "..."]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { Project, ServerMessage, Thread } from '@pcbcad/core';
import { startServer } from '../src/server';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const provider = (args[args.indexOf('--provider') + 1] && args.includes('--provider') ? args[args.indexOf('--provider') + 1] : 'demo') as 'demo' | 'claude';
const prompt = args.includes('--prompt') ? args[args.indexOf('--prompt') + 1] : 'Build the demo product';
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined;
const dataDir = args.includes('--data-dir') ? path.resolve(args[args.indexOf('--data-dir') + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'pcbcad-e2e-'));

const srv = await startServer({ port: Number(process.env.PCBCAD_PORT ?? 4399), host: '127.0.0.1', dataDir, dev: true, open: false, webDist: null });
console.log(`bridge ${srv.url}  data ${dataDir}`);
const ws = new WebSocket(`${srv.url.replace('http', 'ws')}/ws`);
await new Promise((r) => ws.once('open', r));
let id = 1;
const pending = new Map<number, (v: any) => void>();
let project: Project | null = null;
let done: (() => void) | null = null;
const t0 = Date.now();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString()) as ServerMessage;
  if (m.type === 'response') {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (!m.ok) console.error('RPC error', m.error);
    p?.(m.ok ? m.result : null);
    return;
  }
  const e = m.event;
  if (e.kind === 'project.snapshot') project = e.project;
  if (e.kind === 'thread.item') {
    const it = e.item;
    const t = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
    if (it.kind === 'tool' && it.status !== 'running') console.log(`${t}s  ${it.status === 'error' ? '✗' : '✓'} ${it.name}  ${(it.output ?? '').split('\n')[0].slice(0, 150)}`);
    if (it.kind === 'assistant' && !it.streaming) console.log(`${t}s  » ${it.text.split('\n')[0].slice(0, 200)}`);
    if (it.kind === 'system') console.log(`${t}s  [${it.level}] ${it.text.slice(0, 300)}`);
    if (it.kind === 'turn' && it.status !== 'started') {
      console.log(`${t}s  turn ${it.status}${it.error ? `: ${it.error}` : ''}${it.costUsd ? ` $${it.costUsd.toFixed(3)}` : ''}`);
      done?.();
    }
  }
});
const call = <T = any>(method: string, params: Record<string, unknown> = {}) =>
  new Promise<T>((resolve) => {
    const i = id++;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const providers = await call('providers.list');
console.log('providers:', providers.map((p: any) => `${p.id}:${p.available ? 'ok' : 'missing'}`).join(' '));
const summary = await call<{ id: string }>('projects.create', { name: 'E2E product' });
await call('project.open', { projectId: summary.id });
const thread = await call<Thread>('threads.create', { projectId: summary.id, provider, model });
const finished = new Promise<void>((r) => (done = r));
await call('chat.send', { projectId: summary.id, threadId: thread.id, text: prompt });
await finished;
await new Promise((r) => setTimeout(r, 1500));
const p = project as Project | null;
if (p) {
  console.log('\n=== result ===');
  console.log(`boards: ${p.boards.map((b) => `${b.name} (${b.components.length} comps, ${b.nets.length} nets, ${b.traces.length} traces, ${b.vias.length} vias, ${b.zones.length} zones)`).join('; ')}`);
  console.log(`parts: ${Object.keys(p.parts).length}, interconnects: ${p.interconnects.length}, mechanical: ${p.mechanical.map((m) => m.name).join(', ')}`);
  console.log(`assembly: ${p.assembly.instances.length} instances, ${p.assembly.fasteners.length} fasteners; firmware: ${p.firmware.length}; behaviors: ${p.behaviors.length}`);
  for (const s of p.simulations) console.log(`sim ${s.kind}: ${s.status} ${s.summary?.headline ?? s.error ?? ''}`);
  console.log(`issues: ${p.issues.filter((i) => i.severity === 'error').length} errors, ${p.issues.filter((i) => i.severity === 'warning').length} warnings`);
  for (const i of p.issues.filter((x) => x.severity === 'error').slice(0, 25)) console.log(`  [${i.category}/${i.code}] ${i.message}`);
}
ws.close();
await srv.close();
if (!keep && !args.includes('--data-dir')) fs.rmSync(dataDir, { recursive: true, force: true });
else console.log(`kept data dir ${dataDir}`);
process.exit(0);
