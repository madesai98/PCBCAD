import { buildPartMesh, checkMoldability, voxelizePart, estimateCost, massProperties, initGeometry, partSolid, estimateSolidVolume } from './src/index';
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
let ok = 0, fails = 0, maxErr = 0;
for (let n = 0; n < 300; n++) {
  const part: any = { id: 'c' + n, name: 'c', kind: 'custom', materialId: pick(['abs', 'pc', 'al-6061-t6']), process: pick(['injection-molding', 'cnc-machining', 'fdm-printing']), csg: node(0) };
  try {
    checkMoldability(part); estimateCost(part, 100);
    const m = await buildPartMesh(part);
    const v = massProperties(m, 1).volumeMm3;
    const s = partSolid(part);
    if (v > 50) {
      const est = estimateSolidVolume(s!, 1_500_000).volume;
      const err = Math.abs(est / v - 1);
      if (err > 0.1) { console.log('mismatch', n, v.toFixed(1), est.toFixed(1)); }
      maxErr = Math.max(maxErr, err);
    }
    await voxelizePart(part, 1);
    ok++;
  } catch (e: any) { fails++; console.log('threw', n, e.message.slice(0, 200)); }
}
console.log('custom ok', ok, 'fails', fails, 'max raster/mesh err', maxErr.toFixed(3));
for (const env of [[0, 0, 0], [40, 40, 10], [-1, 5, 5], [80, 80, 25]]) {
  for (const fan of [undefined, { maxFlowM3s: 0.01, maxPressurePa: 40, voltage: 12, current: 0.2 }]) {
    const p: any = { id: 'p', name: 'p', kind: 'purchased', materialId: 'abs', process: 'purchased', partId: 'x', envelope: env, fan };
    try { const m = await buildPartMesh(p); console.log('purchased', env, !!fan, massProperties(m, 1).volumeMm3.toFixed(0)); } catch (e: any) { console.log('purchased threw', env, e.message); }
  }
}
