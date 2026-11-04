import { estimateSolidVolume } from './src/solid';
import { partSolid } from './src/parts';
const shell: any = { id: 's1', name: 'Base', kind: 'enclosure-shell', role: 'base', materialId: 'pc-abs', process: 'injection-molding',
  outer: { width: 100, depth: 60, height: 30 }, wall: 2, cornerRadius: 4, draftDeg: 0, bosses: [], ribs: [], cutouts: [], vents: [], snaps: [] };
const rr = (w:number,d:number,r:number)=> w*d - (4-Math.PI)*r*r;
const analytic = rr(100,60,4)*30 - rr(96,56,2)*28;
for (const tc of [200000, 600000, 2000000]) {
  const t0 = performance.now();
  const est = estimateSolidVolume(partSolid(shell)!, tc);
  console.log(tc, 'est', est.volume.toFixed(0), 'err%', ((est.volume/analytic-1)*100).toFixed(2), 'ms', (performance.now()-t0).toFixed(0));
}
