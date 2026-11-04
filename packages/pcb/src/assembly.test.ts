import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createProject } from '@pcbcad/core';
import { exportBom, exportCpl, unitPriceAt, zipFiles } from './assembly';
import { boardStats } from './stats';
import { autoRoute } from './route';
import { comp, emptyBoard, routingTestBoard, stdParts, wire } from './test-fixtures';

function project() {
  const p = createProject('Demo');
  const { board, parts } = routingTestBoard();
  p.parts = parts;
  p.boards.push(board);
  p.settings.buildQuantity = 100;
  return p;
}

/** Tiny CSV parser handling quoted fields. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.trim().split('\n')) {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    rows.push(out);
  }
  return rows;
}

describe('exportBom', () => {
  it('groups identical parts and prices them at the build quantity', () => {
    const p = project();
    const rows = parseCsv(exportBom(p));
    expect(rows[0]).toEqual(['Designator', 'Qty', 'Value', 'MPN', 'Manufacturer', 'Package', 'LCSC', 'Unit Price', 'Ext Price', 'Stock']);
    const res = rows.find((r) => r[3] === 'RC0805-10K')!;
    expect(res[1]).toBe('14');
    expect(res[0].split(',')).toHaveLength(14);
    expect(res[0].startsWith('R1,R2,R3')).toBe(true);
    expect(res[0].endsWith('R13,R14')).toBe(true);
    expect(res[6]).toBe('C17414');
    expect(res[7]).toBe('0.0020'); // 14 × 100 boards ≥ 100-piece break
    expect(res[8]).toBe('0.0280');
    expect(res[9]).toBe('50000');
    const mcu = rows.find((r) => r[3] === 'MCU-20')!;
    expect(mcu[7]).toBe('1.20'); // 1 × 100 ≥ 10
    // quantity override below the first break uses the smallest break
    const one = parseCsv(exportBom(p, { quantity: 1 }));
    expect(one.find((r) => r[3] === 'MCU-20')![7]).toBe('1.50');
  });

  it('excludes DNP parts, prefixes designators across boards and escapes CSV', () => {
    const p = project();
    p.boards[0].components.find((c) => c.ref === 'R1')!.dnp = true;
    const second = emptyBoard(10, 10);
    second.id = 'b2';
    second.name = 'Aux';
    second.components.push(comp('x', 'R1', 'res', 5, 5));
    p.boards.push(second);
    p.parts.res.description = 'x';
    p.parts.res.manufacturer = 'Yageo, "Inc"';
    const rows = parseCsv(exportBom(p));
    const res = rows.find((r) => r[3] === 'RC0805-10K')!;
    expect(res[1]).toBe('14');
    expect(res[0]).toContain('Aux:R1');
    expect(res[0]).not.toContain('Test:R1,');
    expect(res[4]).toBe('Yageo, "Inc"');
    const only = parseCsv(exportBom(p, { boardId: 'b2' }));
    expect(only).toHaveLength(2);
    expect(only[1][0]).toBe('R1');
  });

  it('picks the right price break', () => {
    const offer = { distributor: 'LCSC' as const, sku: 'C1', priceBreaks: [{ qty: 100, price: 0.5 }, { qty: 1, price: 1 }, { qty: 1000, price: 0.2 }] };
    expect(unitPriceAt(offer, 1)).toBe(1);
    expect(unitPriceAt(offer, 99)).toBe(1);
    expect(unitPriceAt(offer, 100)).toBe(0.5);
    expect(unitPriceAt(offer, 5000)).toBe(0.2);
    expect(unitPriceAt(undefined, 5)).toBeUndefined();
  });
});

describe('exportCpl', () => {
  it('writes JLCPCB placement rows in mm', () => {
    const parts = stdParts();
    const b = emptyBoard(30, 20);
    b.components.push(comp('a', 'R2', 'res', 10.5, 3.25, -90), { ...comp('b', 'R10', 'res', 1, 2, 450), side: 'bottom' }, { ...comp('c', 'R3', 'res', 0, 0), dnp: true });
    const lines = exportCpl(b, parts).trim().split('\n');
    expect(lines[0]).toBe('Designator,Mid X,Mid Y,Layer,Rotation');
    expect(lines.slice(1)).toEqual(['R2,10.5000mm,3.2500mm,Top,270', 'R10,1.0000mm,2.0000mm,Bottom,90']);
  });
});

describe('zipFiles', () => {
  it('round-trips text and binary entries', () => {
    const zip = zipFiles([
      { name: 'a/readme.txt', content: 'hello' },
      { name: 'b.bin', content: new Uint8Array([1, 2, 3]) },
    ]);
    expect(zip[0]).toBe(0x50); // 'PK'
    expect(zip[1]).toBe(0x4b);
    const files = unzipSync(zip);
    expect(strFromU8(files['a/readme.txt'])).toBe('hello');
    expect([...files['b.bin']]).toEqual([1, 2, 3]);
  });
});

describe('boardStats', () => {
  it('summarises routing progress, copper and area', () => {
    const { board, parts } = routingTestBoard();
    const s0 = boardStats(board, parts);
    expect(s0.components).toBe(25);
    expect(s0.nets).toBe(30);
    expect(s0.routedPct).toBe(0);
    expect(s0.viaCount).toBe(0);
    expect(s0.areaMm2).toBeGreaterThan(1995);
    expect(s0.areaMm2).toBeLessThan(2000);
    const r = autoRoute(board, parts);
    const s1 = boardStats(r.board, parts);
    expect(s1.routedPct).toBe(100);
    expect(s1.viaCount).toBe(r.stats.vias);
    expect(s1.traceLengthMm).toBeCloseTo(r.stats.lengthMm, 3);
    expect(s1.copperAreaMm2).toBeGreaterThan(s0.copperAreaMm2);
    // partially routed
    const half = structuredClone(r.board);
    half.traces = half.traces.filter((t) => t.netId !== 'net_VCC');
    const s2 = boardStats(half, parts);
    expect(s2.routedPct).toBeGreaterThan(50);
    expect(s2.routedPct).toBeLessThan(100);
    void wire;
  });
});
