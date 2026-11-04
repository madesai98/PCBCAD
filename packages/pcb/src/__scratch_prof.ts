import { bigBoard } from './test-fixtures';
import { autoRoute } from './route';
import { autoPlace } from './place';
const { board, parts } = bigBoard(150);
const p = autoPlace(board, parts, { seed: 1 });
const t0 = Date.now();
const r = autoRoute(p.board, parts, { maxTimeMs: 60000, ripupPasses: Number(process.argv[2] ?? 4) });
console.log('route ms', Date.now() - t0, r.stats, 'routed', r.routed.length, 'failed', r.failed.length, JSON.stringify(r.failed));
