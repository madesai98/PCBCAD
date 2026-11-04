import { generateFootprint } from './footprint/generate';
import type { PackageSpec } from '@pcbcad/core';
const specs: PackageSpec[] = [
  { family: 'chip', size: '0805' }, { family: 'chip', size: '0603' }, { family: 'chip', size: '0402' },
  { family: 'soic', pins: 8 }, { family: 'tssop', pins: 20 }, { family: 'msop', pins: 10 },
  { family: 'qfn', pins: 32, bodyW: 5, bodyL: 5 }, { family: 'qfn', pins: 56, bodyW: 7, bodyL: 7, pitch: 0.4, exposedPad: { w: 3.2, h: 3.2 } },
  { family: 'qfp', pins: 32, bodyW: 7, bodyL: 7, pitch: 0.8 }, { family: 'qfp', pins: 48 },
  { family: 'sot23', pins: 3 }, { family: 'sot23', pins: 5 }, { family: 'sot223' }, { family: 'sod123' }, { family: 'sma' },
  { family: 'dfn', pins: 8, bodyW: 3, bodyL: 3 }, { family: 'lga', pins: 8, bodyW: 2.5, bodyL: 2.5 },
];
for (const s of specs) {
  const fp = generateFootprint(s);
  const p1 = fp.pads[0];
  const ep = fp.pads.find((p) => p.pasteRatio !== undefined);
  const xs = fp.pads.filter((p) => p !== ep);
  const span = Math.max(...xs.map((p) => p.x)) - Math.min(...xs.map((p) => p.x));
  console.log(fp.name.padEnd(48), 'pads', fp.pads.length, 'p1', p1.number, `(${p1.x},${p1.y})`, `${p1.w}x${p1.h}`, 'xspan', span.toFixed(3), ep ? `EP ${ep.w}x${ep.h}` : '', 'crt', JSON.stringify(fp.courtyard), 'silk', fp.graphics.filter(g=>g.layer==='silk').length);
}
