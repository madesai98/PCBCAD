import { parentPort } from 'node:worker_threads';
import { HANDLERS } from './handlers';

if (!parentPort) throw new Error('worker.ts must run in a worker thread');
const port = parentPort;

port.on('message', async (m: { id: number; task: string; payload: unknown }) => {
  const handler = HANDLERS[m.task];
  if (!handler) {
    port.postMessage({ id: m.id, type: 'error', error: `unknown task ${m.task}` });
    return;
  }
  try {
    const result = await handler(m.payload as never, (progress: number, message?: string) =>
      port.postMessage({ id: m.id, type: 'progress', progress, message }),
    );
    port.postMessage({ id: m.id, type: 'result', result });
  } catch (e) {
    port.postMessage({ id: m.id, type: 'error', error: e instanceof Error ? `${e.message}` : String(e) });
  }
});
