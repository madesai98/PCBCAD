import { describe, expect, it } from 'vitest';
import type { CustomPart, DesignIssue, EnclosureShell, SheetMetalPart } from '@pcbcad/core';
import { allowableSnapStrain, checkMoldability, checkSheetMetal, requiredDraftDeg, snapStrain, textureDepthMm } from './index';
import { getMaterial } from '@pcbcad/core';

const codes = (l: DesignIssue[]) => l.map((i) => i.code);
const find = (l: DesignIssue[], code: string) => l.filter((i) => i.code === code);

function shell(extra: Partial<EnclosureShell> = {}): EnclosureShell {
  return {
    id: 'shell',
    name: 'Shell',
    kind: 'enclosure-shell',
    role: 'base',
    materialId: 'pc-abs',
    process: 'injection-molding',
    outer: { width: 100, depth: 60, height: 30 },
    wall: 2,
    cornerRadius: 4,
    draftDeg: 1,
    processOptions: { innerFillet: 1 },
    bosses: [],
    ribs: [],
    cutouts: [],
    vents: [],
    snaps: [],
    ...extra,
  };
}

function sheet(extra: Partial<SheetMetalPart> = {}): SheetMetalPart {
  return {
    id: 'sm',
    name: 'Bracket',
    kind: 'sheet-metal',
    materialId: 'al-5052-h32',
    process: 'sheet-metal',
    thickness: 1.5,
    bendRadius: 1.5,
    kFactor: 0.44,
    base: { width: 60, length: 40 },
    holes: [],
    flanges: [{ id: 'f', edge: '+x', length: 20, angle: 90 }],
    ...extra,
  };
}

describe('checkMoldability (shell)', () => {
  it('a well-designed shell has no errors or warnings', () => {
    const issues = checkMoldability(
      shell({
        bosses: [{ id: 'b', x: 20, y: 0, outerDiameter: 8, holeDiameter: 3.6, height: 8, kind: 'insert' }],
        ribs: [{ id: 'r', from: [-30, -10], to: [-30, 10], height: 5, thickness: 1.2 }],
        cutouts: [{ id: 'c', face: '-y', shape: 'rounded-rect', u: 0, v: 30, width: 10, height: 4, radius: 1 }],
      }),
    );
    expect(issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(issues.every((i) => i.category === 'dfm' && i.target?.partId === 'shell')).toBe(true);
  });

  it('flags thin walls', () => {
    const issues = checkMoldability(shell({ wall: 0.6, cornerRadius: 2 }));
    const w = find(issues, 'min-wall');
    expect(w).toHaveLength(1);
    expect(w[0].severity).toBe('error');
    expect(w[0].suggestion).toMatch(/≥ 1 mm/);
    expect(codes(checkMoldability(shell({ wall: 5, cornerRadius: 8 })))).toContain('max-wall');
  });

  it('flags low draft, including texture allowance', () => {
    expect(find(checkMoldability(shell({ draftDeg: 0 })), 'draft')[0].severity).toBe('error');
    const tex = checkMoldability(shell({ draftDeg: 1, processOptions: { texture: 'MT-11010', innerFillet: 1 } }));
    const d = find(tex, 'draft');
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe('warning');
    expect(textureDepthMm('MT-11010')).toBeCloseTo(0.0254, 4);
    expect(requiredDraftDeg(getMaterial('pc-abs'), 'MT-11010')).toBeCloseTo(0.75 + 1.016, 3);
    expect(textureDepthMm('SPI-A2')).toBe(0);
    expect(textureDepthMm('VDI-30')).toBeCloseTo(0.0316, 3);
    expect(textureDepthMm('something-else')).toBe(0.0375);
  });

  it('flags thick, tall and crowded ribs', () => {
    const issues = checkMoldability(
      shell({
        ribs: [
          { id: 'thick', from: [-30, 0], to: [30, 0], height: 5, thickness: 2.0 },
          { id: 'tall', from: [-30, 10], to: [30, 10], height: 9, thickness: 1.0 },
          { id: 'near', from: [-30, 12.5], to: [30, 12.5], height: 4, thickness: 1.0 },
        ],
      }),
    );
    expect(find(issues, 'rib-thickness').map((i) => i.message)).toEqual([expect.stringContaining('thick')]);
    expect(find(issues, 'rib-height')).toHaveLength(1);
    expect(find(issues, 'rib-spacing')).toHaveLength(1);
  });

  it('flags boss proportions, wall merging and missing gussets', () => {
    const issues = checkMoldability(
      shell({
        bosses: [
          { id: 'thin', x: 0, y: 0, outerDiameter: 5, holeDiameter: 4, height: 6, kind: 'insert' },
          { id: 'wall', x: 46, y: 0, outerDiameter: 8, holeDiameter: 3.6, height: 6, kind: 'screw' },
          { id: 'tall', x: -20, y: 0, outerDiameter: 6, holeDiameter: 2.6, height: 20, kind: 'screw' },
        ],
      }),
    );
    expect(find(issues, 'boss-od')[0].message).toMatch(/thin|crack/);
    expect(find(issues, 'boss-wall-merge').map((i) => i.message)).toEqual([expect.stringContaining('Boss wall')]);
    expect(find(issues, 'boss-height').map((i) => i.message)).toEqual([expect.stringContaining('Boss tall')]);
  });

  it('flags sharp inside corners, cutouts near edges and side actions (not for rim notches)', () => {
    const issues = checkMoldability(
      shell({
        cornerRadius: 2,
        cutouts: [
          { id: 'window', face: '+x', shape: 'rect', u: 0, v: 15, width: 10, height: 5 },
          { id: 'low', face: '-x', shape: 'circle', u: 0, v: 3.5, width: 4, height: 4 },
          { id: 'notch', face: '-y', shape: 'rect', u: 0, v: 30, width: 10, height: 6 },
        ],
        vents: [{ id: 'v', face: '+y', u: 0, v: 15, slotWidth: 2, slotLength: 8, count: 5, pitch: 3, orientation: 'v' }],
      }),
    );
    expect(codes(issues)).toContain('corner-radius');
    const side = find(issues, 'side-action').map((i) => i.message).join('\n');
    expect(side).toMatch(/\+x/);
    expect(side).toMatch(/\+y/);
    expect(side).not.toMatch(/notch/);
    expect(find(issues, 'cutout-edge').some((i) => i.message.includes('low'))).toBe(true);
    expect(codes(issues)).toContain('vent-web');
  });

  it('checks snap-fit strain with ε = 1.5·t·y/L²', () => {
    expect(snapStrain(2, 1.5, 5)).toBeCloseTo((1.5 * 2 * 1.5) / 25, 12);
    expect(allowableSnapStrain(getMaterial('pc'))).toBe(0.04);
    const bad = checkMoldability(shell({ snaps: [{ id: 's', face: '+x', u: 0, width: 6, length: 5, thickness: 2, overhang: 1.5, kind: 'hook' }] }));
    expect(find(bad, 'snap-strain')).toHaveLength(1);
    const ok = checkMoldability(shell({ snaps: [{ id: 's', face: '+x', u: 0, width: 6, length: 12, thickness: 1.2, overhang: 0.6, kind: 'hook' }] }));
    expect(find(ok, 'snap-strain')).toHaveLength(0);
    expect(find(ok, 'snap-undercut')).toHaveLength(1);
  });

  it('flags long flow paths and non-moldable materials', () => {
    expect(codes(checkMoldability(shell({ outer: { width: 400, depth: 300, height: 60 }, wall: 1.2, cornerRadius: 3 })))).toContain('flow-length');
    expect(find(checkMoldability(shell({ materialId: 'al-5052-h32' })), 'material-process')[0].severity).toBe('error');
  });

  it('reviews custom CSG parts', () => {
    const part: CustomPart = {
      id: 'knob',
      name: 'Knob',
      kind: 'custom',
      materialId: 'abs',
      process: 'injection-molding',
      csg: {
        op: 'difference',
        children: [
          { shape: 'box', size: [20, 20, 10], center: true },
          { shape: 'box', size: [19.4, 19.4, 9], center: true, transform: { position: [0, 0, 1], rotation: [0, 0, 0] } },
        ],
      },
    };
    const issues = checkMoldability(part);
    expect(codes(issues)).toContain('min-wall');
    expect(codes(issues)).toContain('draft');
    expect(codes(issues)).toContain('sharp-corners');
  });
});

describe('checkSheetMetal', () => {
  it('a sensible bracket passes', () => {
    const issues = checkSheetMetal(sheet({ holes: [{ id: 'h', x: -10, y: 0, shape: 'circle', diameter: 4 }] }));
    expect(issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('flags holes too close to a bend (and inside the bend zone)', () => {
    const near = checkSheetMetal(sheet({ flanges: [{ id: 'f', edge: '+x', length: 20, angle: 90, holes: [{ id: 'close', x: 0, y: 5, shape: 'circle', diameter: 3 }] }] }));
    const hb = find(near, 'hole-bend');
    expect(hb).toHaveLength(1);
    expect(hb[0].message).toMatch(/close/);
    expect(hb[0].suggestion).toBeTruthy();
    const inBend = checkSheetMetal(sheet({ holes: [{ id: 'inzone', x: 29, y: 0, shape: 'circle', diameter: 1.6 }] }));
    expect(find(inBend, 'hole-in-bend')[0].severity).toBe('error');
    const base = checkSheetMetal(sheet({ holes: [{ id: 'b', x: 22, y: 0, shape: 'circle', diameter: 3 }] }));
    expect(find(base, 'hole-bend')).toHaveLength(1);
  });

  it('flags tight bend radius, short flanges, small holes and edge distance', () => {
    expect(find(checkSheetMetal(sheet({ bendRadius: 0.5 })), 'bend-radius')[0].severity).toBe('error');
    expect(find(checkSheetMetal(sheet({ flanges: [{ id: 'f', edge: '+x', length: 5, angle: 90 }] })), 'flange-length')).toHaveLength(1);
    const holes = checkSheetMetal(
      sheet({
        holes: [
          { id: 'tiny', x: 0, y: 0, shape: 'circle', diameter: 1 },
          { id: 'edge', x: -20, y: 18.5, shape: 'circle', diameter: 2 },
          { id: 'slot', x: 0, y: -18, shape: 'slot', width: 6, height: 2 },
        ],
      }),
    );
    expect(find(holes, 'hole-size').map((i) => i.message)).toEqual([expect.stringContaining('tiny')]);
    expect(find(holes, 'hole-edge').map((i) => i.message.split(':')[0]).sort()).toEqual(['Hole edge', 'Hole slot']);
  });

  it('flags gauges, K-factor, missing reliefs, oversize flats and PEM rules', () => {
    expect(codes(checkSheetMetal(sheet({ thickness: 1.3 })))).toContain('sheet-gauge');
    expect(codes(checkSheetMetal(sheet({ kFactor: 0.7 })))).toContain('k-factor');
    const norelief = checkSheetMetal(sheet({ reliefs: 'none', flanges: [{ id: 'f', edge: '+x', length: 20, angle: 90, width: 20 }] }));
    expect(find(norelief, 'bend-relief')[0].severity).toBe('warning');
    expect(codes(checkSheetMetal(sheet({ base: { width: 1500, length: 2600 } })))).toContain('sheet-size');
    const pem = checkSheetMetal(sheet({ thickness: 0.5, holes: [{ id: 'p', x: -27, y: 0, shape: 'circle', diameter: 4.22, pemPartId: 'S-M3-1' }] }));
    expect(find(pem, 'pem-thickness')[0].severity).toBe('error');
    expect(codes(pem)).toContain('pem-edge');
    const badHole = checkSheetMetal(sheet({ holes: [{ id: 'p', x: -10, y: 0, shape: 'circle', diameter: 4.0, pemPartId: 'S-M3-1' }] }));
    expect(codes(badHole)).toContain('pem-hole');
  });

  it('reports structural model problems', () => {
    const bad = checkSheetMetal(sheet({ flanges: [{ id: 'f', edge: 'far', length: 20, angle: 90 }, { id: 'g', edge: '-x', length: 2, angle: 90 }] }));
    expect(codes(bad)).toContain('flange-edge');
    expect(codes(bad)).toContain('flange-too-short');
    expect(find(checkSheetMetal(sheet({ thickness: 0 })), 'invalid-geometry')).toHaveLength(1);
  });
});
