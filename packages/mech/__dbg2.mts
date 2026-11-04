import { buildPartMesh, massProperties, initGeometry, partSolid, estimateSolidVolume } from './src/index';
await initGeometry();
let seed = 99; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const R = (a: number, b: number) => a + (b - a) * rnd();
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const tf = () => (rnd() < 0.5 ? { transform: { position: [R(-10, 10), R(-10, 10), R(-10, 10)], rotation: [R(-180, 180), R(-180, 180), R(-180, 180)] } } : {});
const node = (d: number): any => {
  if (d < 3 && rnd() < 0.5) return { op: pick(['union', 'difference', 'intersection']), children: Array.from({ length: Math.floor(R(0, 4)) }, () => node(d + 1)), ...tf() };
  switch (pick(['box', 'cylinder', 'sphere', 'extrude', 'revolve'])) {
    case 'box': return { shape: 'box', size: [R(-1, 20), R(0, 20), R(0, 20)], center: rnd() < 0.5, radius: rnd() < 0.3 ? R(-1, 6) : undefined, ...tf() };
    case 'cylinder': return { shape: 'cylinder', radius: R(-1, 8), height: R(-1, 20), radiusTop: rnd() < 0.3 ? R(-1, 8) : undefined, segments: rnd() < 0.2 ? Math.floor(R(-2, 40)) : undefined, center: rnd() < 0.5, ...tf() };
    case 'sphere': return { shape: 'sphere', radius: R(-1, 10), ...tf() };
    case 'extrude': return { shape: 'extrude', points: Array.from({ length: Math.floor(R(0, 8)) }, () => [R(-10, 10), R(-10, 10)]), height: R(-1, 10), ...tf() };
    default: return { shape: 'revolve', profile: Array.from({ length: Math.floor(R(0, 7)) }, () => [R(-2, 10), R(-5, 10)]), segments: rnd() < 0.3 ? Math.floor(R(3, 64)) : undefined, ...tf() };
  }
};
for (let n = 0; n <= 12; n++) {
  pick([1, 2, 3]); pick([1, 2, 3]); const csg = node(0);
  if (n !== 12) continue;
  console.log(JSON.stringify(csg));
  const walk = async (c: any, path: string) => {
    const part: any = { id: 'c', name: 'c', kind: 'custom', materialId: 'abs', process: 'cnc-machining', csg: c };
    const v = massProperties(await buildPartMesh(part), 1).volumeMm3;
    const est = estimateSolidVolume(partSolid(part)!, 1_500_000).volume;
    console.log(path, c.op ?? c.shape, 'mesh', v.toFixed(1), 'raster', est.toFixed(1));
    if (c.children) for (let i = 0; i < c.children.length; i++) await walk(c.children[i], path + '/' + i);
  };
  await walk(csg, 'root');
}
