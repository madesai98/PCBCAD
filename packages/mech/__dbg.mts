import { buildPartMesh, flatPattern, massProperties, initGeometry, partSolid, estimateSolidVolume, buildSheetModel } from './src/index';
await initGeometry();
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const R = (a: number, b: number) => a + (b - a) * rnd();
const faces = ['+x', '-x', '+y', '-y', 'floor'] as const;
// replay shell RNG consumption exactly as in the fuzz script
for (let n = 0; n < 150; n++) {
  const W = R(10, 200), D = R(10, 150), H = R(3, 80), wall = R(0.3, 6);
  pick(['base', 'cover', 'single']); pick(['pc-abs', 'abs', 'pp', 'al-5052-h32', 'nope']); R(-2, 30); R(-1, 8); R(0, 5); pick(['', 'MT-11010', 'VDI-30', 'x']);
  if (rnd() < 0.5) { pick(['lip', 'groove']); R(-1, 5); R(-1, 5); }
  Array.from({ length: Math.floor(R(0, 6)) }, () => { R(-W, W); R(-D, D); R(-1, 15); R(-1, 12); R(-2, H * 1.5); pick([1,2,3,4,5]); Math.floor(R(0, 6)); rnd(); });
  Array.from({ length: Math.floor(R(0, 4)) }, () => { R(-W, W); R(-D, D); R(-W, W); R(-D, D); R(-1, H); R(-0.5, 4); });
  Array.from({ length: Math.floor(R(0, 5)) }, () => { pick([...faces]); pick([1,2,3,4]); R(-W, W); R(-5, H + 5); R(-1, 40); R(-1, 30); R(-1, 10); });
  Array.from({ length: Math.floor(R(0, 3)) }, () => { pick([...faces]); R(-W / 2, W / 2); R(0, H); R(-1, 4); R(-1, 20); Math.floor(R(-1, 20)); R(-1, 6); pick([1,2]); });
  Array.from({ length: Math.floor(R(0, 3)) }, () => { pick([1,2,3,4]); R(-W / 2, W / 2); R(-1, 10); R(-1, 15); R(-1, 3); R(-1, 3); pick([1,2]); });
}
const mkFlange = (depth: number, i: number): any => ({ id: `f${depth}_${i}`, edge: depth ? 'far' : pick(['+x', '-x', '+y', '-y', 'far']), length: R(-2, 40), angle: R(-185, 185), width: rnd() < 0.4 ? R(-5, 60) : undefined, offset: rnd() < 0.4 ? R(-20, 20) : undefined, bendRadius: rnd() < 0.3 ? R(-1, 5) : undefined,
  holes: Array.from({ length: Math.floor(R(0, 3)) }, (_, k) => ({ id: `fh${depth}${i}${k}`, x: R(-20, 20), y: R(-5, 40), shape: pick(['circle', 'rect', 'slot']), diameter: R(-1, 8), width: R(-1, 10), height: R(-1, 6), pemPartId: rnd() < 0.2 ? 'S-M3-1' : undefined })),
  flanges: depth < 2 && rnd() < 0.4 ? [mkFlange(depth + 1, 0)] : undefined });
const want = new Set([11, 173, 50, 29]);
for (let n = 0; n < 200; n++) {
  const p: any = { id: 'p' + n, name: 'sm', kind: 'sheet-metal', materialId: pick(['al-5052-h32', 'spcc', 'ss-304', 'pc-abs']), process: 'sheet-metal', thickness: R(-0.5, 4), bendRadius: R(-1, 6), kFactor: R(-0.2, 1.2),
    base: { width: R(-5, 150), length: R(-5, 120), cornerRadius: R(-1, 10) }, reliefs: pick(['rect', 'obround', 'none', undefined]),
    holes: Array.from({ length: Math.floor(R(0, 4)) }, (_, k) => ({ id: 'h' + k, x: R(-80, 80), y: R(-60, 60), shape: pick(['circle', 'rect', 'slot']), diameter: R(-1, 10), width: R(-1, 12), height: R(-1, 8) })),
    flanges: Array.from({ length: Math.floor(R(0, 6)) }, (_, i) => mkFlange(0, i)) };
  if (!want.has(n)) continue;
  console.log('--- case', n, 't', p.thickness.toFixed(3), 'base', p.base.width.toFixed(1), p.base.length.toFixed(1), 'r', p.bendRadius.toFixed(2));
  const model = buildSheetModel(p);
  console.log('faces', model.faces.map(f => [f.id, f.poly.length, f.rect.map(v => +v.toFixed(2))]), 'issues', model.issues.map(i => i.code));
  try {
    const m = await buildPartMesh(p); const v = massProperties(m, 1).volumeMm3;
    for (const tc of [400000, 4000000]) console.log('raster', tc, estimateSolidVolume(partSolid(p)!, tc).volume.toFixed(0), 'mesh', v.toFixed(0));
  } catch (e: any) { console.log('err', e.message); }
  if (n === 11) console.log(JSON.stringify(p));
}
