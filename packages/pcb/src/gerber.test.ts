import { describe, expect, it } from 'vitest';
import { exportGerbers } from './gerber';
import { autoRoute } from './route';
import { fillZones } from './zones';
import { strokeText, textWidth } from './font';
import { routingTestBoard, makePart, footprint, thtPad, smdPad, comp } from './test-fixtures';

/** Minimal RS-274X sanity parser: returns the D-codes used, those defined, and flags. */
function parseGerber(src: string) {
  const defined = new Set<number>();
  const used: number[] = [];
  let usedBeforeDef = false;
  let regions = 0;
  let inRegion = false;
  const coords: [number, number][] = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    const ad = /^%ADD(\d+)([CRO]),([\d.]+)(X[\d.]+)?\*%$/.exec(line);
    if (ad) {
      defined.add(+ad[1]);
      continue;
    }
    const sel = /^D(\d+)\*$/.exec(line);
    if (sel && +sel[1] >= 10) {
      used.push(+sel[1]);
      if (!defined.has(+sel[1])) usedBeforeDef = true;
      continue;
    }
    if (line === 'G36*') {
      inRegion = true;
      regions++;
    }
    if (line === 'G37*') inRegion = false;
    const xy = /^X(-?\d+)Y(-?\d+)D0[123]\*$/.exec(line);
    if (xy) coords.push([+xy[1] / 1e6, +xy[2] / 1e6]);
  }
  return { defined, used, usedBeforeDef, regions, inRegion, coords };
}

describe('exportGerbers', () => {
  const { board, parts } = routingTestBoard();
  board.zones.push({ id: 'z', netId: 'net_GND', layer: 'bottom', clearance: 0.3, thermalRelief: true });
  const routed = fillZones(autoRoute(board, parts, { skipNets: ['GND'] }).board, parts);
  const { files } = exportGerbers(routed, parts, { projectName: 'Demo Project' });
  const byName = (suffix: string) => files.find((f) => f.name.endsWith(suffix))!;

  it('writes the full layer set with KiCad-style names', () => {
    const names = files.map((f) => f.name);
    for (const s of ['F_Cu.gbr', 'B_Cu.gbr', 'F_Mask.gbr', 'B_Mask.gbr', 'F_Paste.gbr', 'B_Paste.gbr', 'F_Silkscreen.gbr', 'B_Silkscreen.gbr', 'Edge_Cuts.gbr', 'PTH.drl', 'NPTH.drl'])
      expect(names.some((n) => n.endsWith(s))).toBe(true);
    expect(names[0].startsWith('demo-project-test-')).toBe(true);
  });

  it('produces syntactically sane RS-274X X2 files', () => {
    for (const f of files.filter((x) => x.name.endsWith('.gbr'))) {
      const c = f.content;
      expect(c).toMatch(/^%TF\.GenerationSoftware,PCBCAD/);
      expect(c).toContain('%FSLAX46Y46*%');
      expect(c).toContain('%MOMM*%');
      expect(c).toMatch(/%TF\.FileFunction,[^*]+\*%/);
      expect(c.trimEnd().endsWith('M02*')).toBe(true);
      const p = parseGerber(c);
      expect(p.usedBeforeDef).toBe(false);
      expect(p.inRegion).toBe(false);
      for (const [x, y] of p.coords) {
        expect(x).toBeGreaterThan(-1);
        expect(x).toBeLessThan(51);
        expect(y).toBeGreaterThan(-1);
        expect(y).toBeLessThan(41);
      }
    }
    expect(byName('F_Cu.gbr').content).toContain('%TF.FileFunction,Copper,L1,Top*%');
    expect(byName('B_Cu.gbr').content).toContain('%TF.FileFunction,Copper,L2,Bot*%');
    expect(byName('F_Mask.gbr').content).toContain('%TF.FilePolarity,Negative*%');
    expect(byName('Edge_Cuts.gbr').content).toContain('%TF.FileFunction,Profile,NP*%');
  });

  it('writes zone fills as regions with clear-polarity holes', () => {
    const b = byName('B_Cu.gbr').content;
    const p = parseGerber(b);
    expect(p.regions).toBeGreaterThan(1);
    expect(b).toContain('%LPC*%');
    expect(b.indexOf('%LPC*%')).toBeLessThan(b.indexOf('ViaPad') > 0 ? b.length : b.length);
    // after the fills, polarity returns to dark before traces/pads
    const lastClear = b.lastIndexOf('%LPC*%');
    expect(b.indexOf('%LPD*%', lastClear)).toBeGreaterThan(lastClear);
  });

  it('expands mask openings and writes paste only for SMD pads', () => {
    const mask = parseGerber(byName('F_Mask.gbr').content);
    const paste = parseGerber(byName('F_Paste.gbr').content);
    expect(mask.coords.length).toBeGreaterThan(paste.coords.length); // THT pads have mask, no paste
    // the 1.7 mm THT pads get 1.8 mm mask apertures
    expect(byName('F_Mask.gbr').content).toMatch(/%ADD\d+C,1\.800000\*%/);
    expect(byName('B_Paste.gbr').content).not.toMatch(/D03/);
  });

  it('writes reference designators in the stroke font', () => {
    const silk = byName('F_Silkscreen.gbr').content;
    const p = parseGerber(silk);
    expect(p.coords.length).toBeGreaterThan(200);
    const strokes = strokeText('R10', { at: [0, 0], size: 1 });
    expect(strokes.length).toBeGreaterThan(3);
    expect(textWidth('R10', 1)).toBeCloseTo(16 / 6, 9);
  });

  it('writes Excellon drill files with a METRIC tool table', () => {
    const pth = byName('PTH.drl').content;
    expect(pth.startsWith('M48')).toBe(true);
    expect(pth).toContain('METRIC');
    expect(pth).toContain('; #@! TF.FileFunction,Plated,1,2,PTH');
    const tools = [...pth.matchAll(/^T(\d+)C([\d.]+)$/gm)].map((m) => [+m[1], +m[2]]);
    expect(tools.length).toBeGreaterThanOrEqual(2);
    expect(tools.some(([, d]) => d === 0.3)).toBe(true); // vias
    expect(tools.some(([, d]) => d === 1)).toBe(true); // header pins
    const header = pth.slice(0, pth.indexOf('\n%\n'));
    const body = pth.slice(pth.indexOf('\n%\n'));
    for (const [t] of tools) {
      expect(header).toContain(`T${t}C`);
      expect(body).toContain(`\nT${t}\n`);
    }
    expect(pth.trimEnd().endsWith('M30')).toBe(true);
    const hits = (body.match(/^X-?[\d.]+Y-?[\d.]+$/gm) ?? []).length;
    expect(hits).toBe(routed.vias.length + 10); // 6 + 4 header pins
  });

  it('handles slots, NPTH holes, rotated and bottom-side pads', () => {
    const p2 = { ...parts };
    p2.slot = makePart('slot', 'connector', footprint('SLOT', [{ ...thtPad('1', 0, 0, 2, 1), shape: 'oval', w: 3, h: 1.6, slot: { w: 2, h: 0.8 } }, { number: '', shape: 'circle', x: 3, y: 0, w: 1, h: 1, kind: 'npth', drill: 1 }]));
    p2.rot = makePart('rot', 'resistor', footprint('ROT', [{ ...smdPad('1', 0, 0, 1, 0.5), rotation: 30 }, { ...smdPad('2', 2, 0, 1, 0.5, 'roundrect') }]));
    const b = structuredClone(routed);
    b.components.push(comp('s', 'J9', 'slot', 30, 5), { ...comp('q', 'R99', 'rot', 40, 5, 45), side: 'bottom' });
    const out = exportGerbers(b, p2).files;
    const pth = out.find((f) => f.name.endsWith('PTH.drl'))!.content;
    expect(pth).toMatch(/G85X/);
    const npth = out.find((f) => f.name.endsWith('NPTH.drl'))!.content;
    expect(npth).toContain('NonPlated');
    expect(npth).toMatch(/^X33\.000Y5\.000$/m);
    const bcu = parseGerber(out.find((f) => f.name.endsWith('B_Cu.gbr'))!.content);
    expect(bcu.usedBeforeDef).toBe(false);
    expect(out.find((f) => f.name.endsWith('B_Paste.gbr'))!.content).toContain('G36*');
  });
});
