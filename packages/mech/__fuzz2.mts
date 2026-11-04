import { autoEnclosure, checkAssembly, checkMoldability, voxelizeAssemblyForAirflow } from './src/index';
import { createBoard, createProject } from '@pcbcad/core';
import { USBC, partDef, fastenerPart } from './src/__fixtures__/project';
let seed = 777; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const R = (a: number, b: number) => a + (b - a) * rnd();
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const stats = new Map<string, number>();
let errs = 0;
for (let n = 0; n < 60; n++) {
  const project = createProject('f');
  const W = R(25, 120), H = R(20, 90);
  const board = createBoard('B' + n, W, H, { cornerRadius: R(0, 3), thickness: pick([0.8, 1.0, 1.6, 2.0]) });
  const inset = R(3, 6);
  const drill = pick([2.2, 2.7, 3.2]);
  const nh = pick([0, 2, 3, 4]);
  const pos: [number, number][] = [[inset, inset], [W - inset, H - inset], [W - inset, inset], [inset, H - inset]];
  board.holes = pos.slice(0, nh).map(([x, y], i) => ({ id: 'H' + i, x, y, drill, plated: false }));
  project.parts = { [USBC.id]: USBC, BIG: partDef('BIG', { body: { w: R(3, 15), l: R(3, 15), h: R(1, 15) } }), SMALL: partDef('SMALL', { body: { w: 2, l: 1.25, h: 0.6 } }) };
  const comps: any[] = [];
  const nconn = pick([0, 1, 1, 2]);
  const sides = ['-y', '+y', '-x', '+x'];
  for (let c = 0; c < nconn; c++) {
    const side = sides[(c + Math.floor(rnd() * 4)) % 4];
    // footprint mates along -y; rotate so it faces `side`
    const rot = { '-y': 0, '+x': 90, '+y': 180, '-x': 270 }[side]!;
    const along = R(10, side.endsWith('y') ? W - 10 : H - 10);
    const off = 3.65 - R(0, 1.2);
    const [x, y] = side === '-y' ? [along, off] : side === '+y' ? [along, H - off] : side === '-x' ? [off, along] : [W - off, along];
    comps.push({ id: 'J' + c, ref: 'J' + (c + 1), partId: USBC.id, x, y, rotation: rot, side: 'top', placed: true, pinNets: {} });
  }
  comps.push({ id: 'U1', ref: 'U1', partId: 'BIG', x: W / 2, y: H / 2, rotation: R(0, 90), side: 'top', placed: true, pinNets: {} });
  if (rnd() < 0.5) comps.push({ id: 'U2', ref: 'U2', partId: 'SMALL', x: W / 3, y: H / 3, rotation: 0, side: 'bottom', placed: true, pinNets: {} });
  board.components = comps;
  project.boards.push(board);
  project.parts['S8'] = fastenerPart('S8', { type: 'screw', diameter: 3, length: 8, head: 'pan', materialId: 'steel-zinc' });
  try {
    const r = autoEnclosure(project, [board.id], { insert: pick(['heat-set', 'self-tapping']) as any, wall: pick([1.5, 2, 2.5]), clearance: pick([0.5, 1, 2]) });
    project.mechanical.push(r.base, r.cover);
    project.assembly = { instances: r.instances, fasteners: r.fasteners };
    const issues = checkAssembly(project, { resolution: 0.3 });
    for (const i of issues) if (i.severity !== 'info') { stats.set(i.code, (stats.get(i.code) ?? 0) + 1); if (i.severity === 'error') { errs++; console.log(n, i.code, i.message, '| nconn', nconn, 'board', W.toFixed(1), H.toFixed(1)); } }
    for (const i of [...checkMoldability(r.base), ...checkMoldability(r.cover)]) if (i.severity !== "info") { stats.set("dfm:" + i.code, (stats.get("dfm:" + i.code) ?? 0) + 1); if (i.code === "cutout-edge" || i.code === "cutout-spacing") console.log(n, i.code, i.message); }
    if (n % 10 === 0) await voxelizeAssemblyForAirflow(project);
  } catch (e: any) { errs++; console.log('threw', n, e.message, e.stack.split('\n')[1]); }
}
console.log('errors', errs, Object.fromEntries(stats));
