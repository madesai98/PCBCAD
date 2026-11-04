import { buildPartMesh } from './src/parts';
import { massProperties } from './src/massprops';
import { flatPattern, buildSheetModel, bendDeduction } from './src/sheet';
import { exportStl } from './src/export';
import { estimateSolidVolume } from './src/solid';
import { partSolid } from './src/parts';
import { writeFileSync, mkdirSync } from 'node:fs';
const out = '/tmp/claude-0/-home-user-PCBCAD/d0728f14-b498-54b0-a3ff-c4638263f542/scratchpad/mech';
mkdirSync(out, { recursive: true });
const shell: any = { id: 's1', name: 'Base', kind: 'enclosure-shell', role: 'base', materialId: 'pc-abs', process: 'injection-molding',
  outer: { width: 100, depth: 60, height: 30 }, wall: 2, cornerRadius: 4, draftDeg: 0, bosses: [], ribs: [], cutouts: [], vents: [], snaps: [] };
let t0 = performance.now();
let m = await buildPartMesh(shell);
console.log('plain shell ms', (performance.now()-t0).toFixed(1));
const mp = massProperties(m, 1140);
const rr = (w:number,d:number,r:number)=> w*d - (4-Math.PI)*r*r;
const analytic = rr(100,60,4)*30 - rr(96,56,2)*28;
console.log('vol', mp.volumeMm3, 'analytic', analytic, 'err%', ((mp.volumeMm3/analytic-1)*100).toFixed(3), mp.bbox);
const est = estimateSolidVolume(partSolid(shell)!);
console.log('raster est', est.volume, ((est.volume/analytic-1)*100).toFixed(2));
// full featured
const full: any = { ...shell, draftDeg: 1, processOptions: { innerFillet: 1 },
  lip: { kind: 'lip', height: 1.5, thickness: 0.8 },
  bosses: [ { id: 'b1', x: 30, y: 15, outerDiameter: 8, holeDiameter: 4, height: 6, kind: 'insert', gussets: 4 },
            { id: 'b2', x: -30, y: -15, outerDiameter: 8, holeDiameter: 3.4, height: 8, kind: 'clearance', throughFloor: true } ],
  ribs: [ { id: 'r1', from: [-40, 0], to: [40, 0], height: 5, thickness: 1.2 } ],
  cutouts: [ { id: 'c1', face: '-y', shape: 'rounded-rect', u: 10, v: 30, width: 10, height: 4, radius: 1 },
             { id: 'c2', face: '+x', shape: 'circle', u: 0, v: 15, width: 8, height: 8 },
             { id: 'c3', face: 'floor', shape: 'slot', u: 0, v: -20, width: 12, height: 4 } ],
  vents: [ { id: 'v1', face: '+y', u: 0, v: 10, slotWidth: 1.5, slotLength: 8, count: 8, pitch: 3.5, orientation: 'v' } ],
  snaps: [ { id: 'h1', face: '+x', u: 10, width: 6, length: 8, thickness: 1.2, overhang: 0.8, kind: 'hook' },
           { id: 'k1', face: '-x', u: 10, width: 6, length: 8, thickness: 1.2, overhang: 0.8, kind: 'catch' } ] };
t0 = performance.now();
m = await buildPartMesh(full);
console.log('full shell ms', (performance.now()-t0).toFixed(1), 'vol', massProperties(m, 1140).volumeMm3, m.bbox);
writeFileSync(out + '/shell_full.stl', exportStl(m, 'full'));
// sheet
const sheet: any = { id: 'sm', name: 'L', kind: 'sheet-metal', materialId: 'al-5052-h32', process: 'sheet-metal', thickness: 1, bendRadius: 1, kFactor: 0.44,
  base: { width: 50, length: 30 }, holes: [], flanges: [ { id: 'f1', edge: '+x', length: 20, angle: 90 } ] };
const fp = flatPattern(sheet);
console.log('flat size', fp.size, 'expected', 50 + 20 - bendDeduction(90, 1, 1, 0.44), fp.outline.length, fp.areaMm2);
const sm = await buildPartMesh(sheet);
console.log('sheet bbox', sm.bbox, 'vol', massProperties(sm, 2680).volumeMm3);
const tray: any = { ...sheet, id: 'tray', base: { width: 80, length: 50, cornerRadius: 3 },
  holes: [ { id: 'h', x: 0, y: 0, shape: 'circle', diameter: 5 } ],
  flanges: [ { id: 'a', edge: '+x', length: 20, angle: 90, flanges: [ { id: 'a2', edge: 'far', length: 8, angle: 90 } ], holes: [ { id: 'fh', x: 0, y: 12, shape: 'slot', width: 8, height: 3 } ] },
             { id: 'b', edge: '-x', length: 20, angle: 90 },
             { id: 'c', edge: '+y', length: 15, angle: -90, width: 30, offset: 5 },
             { id: 'd', edge: '-y', length: 20, angle: 90 } ], reliefs: 'obround' };
const ft = flatPattern(tray);
console.log('tray flat', ft.size, ft.outline.length, 'holes', ft.holes.length, 'bends', ft.bendLines.length, ft.warnings);
const tm = await buildPartMesh(tray);
console.log('tray bbox', tm.bbox, 'vol', massProperties(tm, 2680).volumeMm3, 'flat area*t', ft.areaMm2);
writeFileSync(out + '/tray.stl', exportStl(tm, 'tray'));
writeFileSync(out + '/tray_flat.json', JSON.stringify(ft));
