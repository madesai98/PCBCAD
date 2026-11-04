import { buildPartMesh, flatPattern, checkMoldability, checkSheetMetal, voxelizePart, estimateCost, massProperties, initGeometry, exportDxf, partSolid, estimateSolidVolume } from './src/index';
await initGeometry();
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const R = (a: number, b: number) => a + (b - a) * rnd();
const faces = ['+x', '-x', '+y', '-y', 'floor'] as const;
let fails = 0, thrown = 0, ok = 0;
for (let n = 0; n < 150; n++) {
  const W = R(10, 200), D = R(10, 150), H = R(3, 80), wall = R(0.3, 6);
  const s: any = { id: 's' + n, name: 'f', kind: 'enclosure-shell', role: pick(['base', 'cover', 'single']), materialId: pick(['pc-abs', 'abs', 'pp', 'al-5052-h32', 'nope']), process: 'injection-molding',
    outer: { width: W, depth: D, height: H }, wall, cornerRadius: R(-2, 30), draftDeg: R(-1, 8), processOptions: { innerFillet: R(0, 5), texture: pick(['', 'MT-11010', 'VDI-30', 'x']) },
    lip: rnd() < 0.5 ? { kind: pick(['lip', 'groove']), height: R(-1, 5), thickness: R(-1, 5) } : undefined,
    bosses: Array.from({ length: Math.floor(R(0, 6)) }, (_, i) => ({ id: 'b' + i, x: R(-W, W), y: R(-D, D), outerDiameter: R(-1, 15), holeDiameter: R(-1, 12), height: R(-2, H * 1.5), kind: pick(['screw', 'insert', 'clearance', 'pin', 'standoff']), gussets: Math.floor(R(0, 6)), throughFloor: rnd() < 0.3 })),
    ribs: Array.from({ length: Math.floor(R(0, 4)) }, (_, i) => ({ id: 'r' + i, from: [R(-W, W), R(-D, D)], to: [R(-W, W), R(-D, D)], height: R(-1, H), thickness: R(-0.5, 4) })),
    cutouts: Array.from({ length: Math.floor(R(0, 5)) }, (_, i) => ({ id: 'c' + i, face: pick([...faces]), shape: pick(['rect', 'rounded-rect', 'circle', 'slot']), u: R(-W, W), v: R(-5, H + 5), width: R(-1, 40), height: R(-1, 30), radius: R(-1, 10) })),
    vents: Array.from({ length: Math.floor(R(0, 3)) }, (_, i) => ({ id: 'v' + i, face: pick([...faces]), u: R(-W / 2, W / 2), v: R(0, H), slotWidth: R(-1, 4), slotLength: R(-1, 20), count: Math.floor(R(-1, 20)), pitch: R(-1, 6), orientation: pick(['u', 'v']) })),
    snaps: Array.from({ length: Math.floor(R(0, 3)) }, (_, i) => ({ id: 'n' + i, face: pick(['+x', '-x', '+y', '-y']), u: R(-W / 2, W / 2), width: R(-1, 10), length: R(-1, 15), thickness: R(-1, 3), overhang: R(-1, 3), kind: pick(['hook', 'catch']) })) };
  try { checkMoldability(s); estimateCost(s, 1000); } catch (e: any) { fails++; console.log('DFM/cost threw', n, e.message); }
  try {
    const m = await buildPartMesh(s);
    const v = massProperties(m, 1).volumeMm3;
    if (!(v > 0) && !(m.groups[0] && (m.groups[0].positions as any).length === 0)) { fails++; console.log('bad volume', n, v); }
    if (W * D * H < 2e5) { const g = await voxelizePart(s, Math.max(0.5, Math.cbrt(W * D * H / 2e5))); }
    ok++;
  } catch (e: any) {
    if (/EnclosureShell .*: /.test(e.message)) thrown++; else { fails++; console.log('mesh threw', n, e.message, JSON.stringify(s).slice(0, 300)); }
  }
}
console.log('shells ok', ok, 'clean-throw', thrown, 'fails', fails);
let sok = 0, sthrown = 0, sfail = 0;
const mkFlange = (depth: number, i: number): any => ({ id: `f${depth}_${i}`, edge: depth ? 'far' : pick(['+x', '-x', '+y', '-y', 'far']), length: R(-2, 40), angle: R(-185, 185), width: rnd() < 0.4 ? R(-5, 60) : undefined, offset: rnd() < 0.4 ? R(-20, 20) : undefined, bendRadius: rnd() < 0.3 ? R(-1, 5) : undefined,
  holes: Array.from({ length: Math.floor(R(0, 3)) }, (_, k) => ({ id: `fh${depth}${i}${k}`, x: R(-20, 20), y: R(-5, 40), shape: pick(['circle', 'rect', 'slot']), diameter: R(-1, 8), width: R(-1, 10), height: R(-1, 6), pemPartId: rnd() < 0.2 ? 'S-M3-1' : undefined })),
  flanges: depth < 2 && rnd() < 0.4 ? [mkFlange(depth + 1, 0)] : undefined });
for (let n = 0; n < 200; n++) {
  const p: any = { id: 'p' + n, name: 'sm', kind: 'sheet-metal', materialId: pick(['al-5052-h32', 'spcc', 'ss-304', 'pc-abs']), process: 'sheet-metal', thickness: R(-0.5, 4), bendRadius: R(-1, 6), kFactor: R(-0.2, 1.2),
    base: { width: R(-5, 150), length: R(-5, 120), cornerRadius: R(-1, 10) }, reliefs: pick(['rect', 'obround', 'none', undefined]),
    holes: Array.from({ length: Math.floor(R(0, 4)) }, (_, k) => ({ id: 'h' + k, x: R(-80, 80), y: R(-60, 60), shape: pick(['circle', 'rect', 'slot']), diameter: R(-1, 10), width: R(-1, 12), height: R(-1, 8) })),
    flanges: Array.from({ length: Math.floor(R(0, 6)) }, (_, i) => mkFlange(0, i)) };
  try { checkSheetMetal(p); estimateCost(p, 50); } catch (e: any) { sfail++; console.log('sheet DFM threw', n, e.message); }
  try {
    const f = flatPattern(p);
    exportDxf(f);
    if (!(f.outline.length >= 3)) { sfail++; console.log('empty outline', n); }
    const m = await buildPartMesh(p);
    const v = massProperties(m, 1).volumeMm3;
    if (!(v > 0)) { sfail++; console.log('sheet bad volume', n, v); }
    const est = estimateSolidVolume(partSolid(p)!, 400000).volume;
    if (Math.abs(est / v - 1) > 0.15 && v > 500) console.log('sheet raster/mesh volume mismatch', n, est.toFixed(0), v.toFixed(0));
    sok++;
  } catch (e: any) {
    if (/SheetMetalPart .*: /.test(e.message)) sthrown++; else { sfail++; console.log('sheet threw', n, e.message, JSON.stringify(p).slice(0, 400)); }
  }
}
console.log('sheets ok', sok, 'clean-throw', sthrown, 'fails', sfail);
