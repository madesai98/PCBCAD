import { routingTestBoard } from './test-fixtures';
import { autoRoute } from './route';
import { renderSvg } from './__scratch_svg';
const { board, parts } = routingTestBoard();
const r = autoRoute(board, parts, {});
console.log('route', r.stats, 'routed', r.routed.length, 'failed', r.failed);
const dir = '/tmp/claude-0/-home-user-PCBCAD/d0728f14-b498-54b0-a3ff-c4638263f542/scratchpad/pcb';
renderSvg(r.board, parts, dir + '/route.svg');
