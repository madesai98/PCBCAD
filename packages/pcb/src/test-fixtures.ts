/**
 * Test helpers: tiny footprints/parts/boards mirroring core's FootprintDef (no dependency on
 * @pcbcad/parts). Not exported from the package index.
 */
import { createBoard, type Board, type ComponentInstance, type FootprintDef, type NetClass, type PadDef, type PartCategory, type PartDef, type PinDef, type PinType } from '@pcbcad/core';

export function smdPad(number: string, x: number, y: number, w: number, h: number, shape: PadDef['shape'] = 'rect'): PadDef {
  return { number, shape, x, y, w, h, kind: 'smd' };
}

export function thtPad(number: string, x: number, y: number, d: number, drill: number, shape: PadDef['shape'] = 'circle'): PadDef {
  return { number, shape, x, y, w: d, h: d, kind: 'tht', drill };
}

export function footprint(name: string, pads: PadDef[], courtyard?: FootprintDef['courtyard'], graphics: FootprintDef['graphics'] = []): FootprintDef {
  let cy = courtyard;
  if (!cy) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pads) {
      minX = Math.min(minX, p.x - p.w / 2);
      maxX = Math.max(maxX, p.x + p.w / 2);
      minY = Math.min(minY, p.y - p.h / 2);
      maxY = Math.max(maxY, p.y + p.h / 2);
    }
    cy = { minX: minX - 0.25, minY: minY - 0.25, maxX: maxX + 0.25, maxY: maxY + 0.25 };
  }
  return { name, pads, graphics, courtyard: cy, source: 'builtin' };
}

export function chip(size: '0402' | '0603' | '0805' = '0805'): FootprintDef {
  const d = size === '0402' ? { x: 0.48, w: 0.56, h: 0.62, cx: 0.95, cy: 0.5 } : size === '0603' ? { x: 0.775, w: 0.75, h: 0.9, cx: 1.5, cy: 0.75 } : { x: 0.95, w: 1.0, h: 1.3, cx: 1.9, cy: 1.0 };
  return footprint(size, [smdPad('1', -d.x, 0, d.w, d.h, 'roundrect'), smdPad('2', d.x, 0, d.w, d.h, 'roundrect')], { minX: -d.cx, minY: -d.cy, maxX: d.cx, maxY: d.cy }, [
    { kind: 'line', layer: 'silk', a: [-0.2, d.cy - 0.1], b: [0.2, d.cy - 0.1], width: 0.12 },
  ]);
}

/** Dual-row gull-wing package: pins 1..n/2 down the left side, then up the right side. */
export function dualRow(name: string, pins: number, pitch: number, span: number, padW: number, padH: number, bodyW: number): FootprintDef {
  const half = pins / 2;
  const pads: PadDef[] = [];
  for (let i = 0; i < half; i++) pads.push(smdPad(String(i + 1), -span / 2, ((half - 1) / 2 - i) * pitch, padW, padH));
  for (let i = 0; i < half; i++) pads.push(smdPad(String(half + i + 1), span / 2, (i - (half - 1) / 2) * pitch, padW, padH));
  const yExt = ((half - 1) / 2) * pitch + padH / 2 + 0.25;
  const xExt = Math.max(span / 2 + padW / 2, bodyW / 2) + 0.25;
  return footprint(name, pads, { minX: -xExt, minY: -yExt, maxX: xExt, maxY: yExt }, [
    { kind: 'polyline', layer: 'silk', points: [[-bodyW / 2 + 0.6, yExt - 0.3], [bodyW / 2 - 0.6, yExt - 0.3]], width: 0.12 },
  ]);
}

export const soic8 = () => dualRow('SOIC-8', 8, 1.27, 5.4, 1.55, 0.6, 3.9);
export const tssop20 = () => dualRow('TSSOP-20', 20, 0.65, 5.8, 1.45, 0.4, 4.4);

/** 1×n pin header along Y (pin 1 at top). */
export function header(n: number, pitch = 2.54): FootprintDef {
  const pads: PadDef[] = [];
  for (let i = 0; i < n; i++) pads.push(thtPad(String(i + 1), 0, ((n - 1) / 2 - i) * pitch, 1.7, 1.0, i === 0 ? 'rect' : 'circle'));
  return footprint(`Header-1x${n}`, pads);
}

export function makePart(id: string, category: PartCategory, fp: FootprintDef | undefined, pins?: { number: string; name?: string; type?: PinType }[], extra: Partial<PartDef> = {}): PartDef {
  const pinDefs: PinDef[] = (pins ?? (fp ? [...new Set(fp.pads.map((p) => p.number))].map((n) => ({ number: n }) as { number: string; name?: string; type?: PinType }) : [])).map((p) => ({
    number: p.number,
    name: p.name ?? p.number,
    type: p.type ?? 'passive',
  }));
  return {
    id,
    mpn: extra.mpn ?? id.toUpperCase(),
    manufacturer: extra.manufacturer ?? 'ACME',
    description: extra.description ?? id,
    category,
    package: extra.package ?? fp?.name ?? '',
    params: {},
    offers: [],
    pins: pinDefs,
    footprint: fp,
    provenance: { specs: 'builtin', symbol: 'builtin', footprint: 'builtin', model3d: 'missing', sim: 'missing', source: 'test' },
    ...extra,
  };
}

export function comp(id: string, ref: string, partId: string, x: number, y: number, rotation = 0, side: 'top' | 'bottom' = 'top'): ComponentInstance {
  return { id, ref, partId, x, y, rotation, side, placed: true, pinNets: {} };
}

export function addNet(board: Board, name: string, cls: NetClass = 'signal'): string {
  const id = `net_${name}`;
  if (!board.nets.some((n) => n.id === id)) board.nets.push({ id, name, class: cls });
  return id;
}

/** Connect "REF.PIN" endpoints to a net (creating the net). */
export function wire(board: Board, name: string, pins: string[], cls?: NetClass): string {
  const id = addNet(board, name, cls ?? (/^GND/.test(name) ? 'ground' : /^(VCC|VDD|3V3|5V|VBUS|VIN)/.test(name) ? 'power' : 'signal'));
  for (const p of pins) {
    const [ref, pin] = p.split('.');
    const c = board.components.find((x) => x.ref === ref);
    if (!c) throw new Error(`no component ${ref}`);
    c.pinNets[pin] = id;
  }
  return id;
}

export function emptyBoard(w: number, h: number, layers: 2 | 4 = 2): Board {
  const b = createBoard('Test', w, h, { cornerRadius: 1, layers });
  b.id = 'brd_test';
  return b;
}

/** Standard parts used by the tests. */
export function stdParts(): Record<string, PartDef> {
  const mcuPins = Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    if (n === 1) return { number: '1', name: 'VDD', type: 'power_in' as PinType };
    if (n === 2) return { number: '2', name: 'GND', type: 'power_in' as PinType };
    if (n === 19) return { number: '19', name: 'XTAL1', type: 'input' as PinType };
    if (n === 20) return { number: '20', name: 'XTAL2', type: 'output' as PinType };
    return { number: String(n), name: `PA${n}`, type: 'bidirectional' as PinType };
  });
  const icPins = [
    { number: '1', name: 'A', type: 'input' as PinType },
    { number: '2', name: 'B', type: 'input' as PinType },
    { number: '3', name: 'C', type: 'bidirectional' as PinType },
    { number: '4', name: 'GND', type: 'power_in' as PinType },
    { number: '5', name: 'D', type: 'bidirectional' as PinType },
    { number: '6', name: 'E', type: 'bidirectional' as PinType },
    { number: '7', name: 'Y', type: 'output' as PinType },
    { number: '8', name: 'VCC', type: 'power_in' as PinType },
  ];
  return {
    res: makePart('res', 'resistor', chip('0805'), undefined, { value: '10k', mpn: 'RC0805-10K', offers: [{ distributor: 'LCSC', sku: 'C17414', stock: 50000, priceBreaks: [{ qty: 1, price: 0.01 }, { qty: 100, price: 0.002 }] }] }),
    cap: makePart('cap', 'capacitor', chip('0805'), undefined, { value: '100nF', mpn: 'CL21B104', offers: [{ distributor: 'LCSC', sku: 'C49678', stock: 100000, priceBreaks: [{ qty: 10, price: 0.005 }, { qty: 1000, price: 0.001 }] }] }),
    mcu: makePart('mcu', 'mcu', tssop20(), mcuPins, { mpn: 'MCU-20', offers: [{ distributor: 'LCSC', sku: 'C1234', stock: 10, priceBreaks: [{ qty: 1, price: 1.5 }, { qty: 10, price: 1.2 }] }] }),
    ic: makePart('ic', 'ic', soic8(), icPins, { mpn: 'IC-8' }),
    hdr6: makePart('hdr6', 'connector', header(6), undefined, { mpn: 'HDR-1x6' }),
    hdr4: makePart('hdr4', 'connector', header(4), undefined, { mpn: 'HDR-1x4' }),
    xtal: makePart('xtal', 'crystal', footprint('XTAL-3225', [smdPad('1', -1.1, 0, 1.4, 1.2), smdPad('2', 1.1, 0, 1.4, 1.2)], { minX: -2.2, minY: -1.4, maxX: 2.2, maxY: 1.4 }), undefined, { value: '16MHz' }),
  };
}

/** 50×40 mm 2-layer board, 25 components, 30 nets, hand-placed. */
export function routingTestBoard(): { board: Board; parts: Record<string, PartDef> } {
  const parts = stdParts();
  const b = emptyBoard(50, 40);
  const add = (c: ComponentInstance) => b.components.push(c);
  add(comp('j1', 'J1', 'hdr6', 3, 20));
  add(comp('j2', 'J2', 'hdr4', 47, 20));
  add(comp('u1', 'U1', 'mcu', 25, 20));
  add(comp('u2', 'U2', 'ic', 11, 34));
  add(comp('u3', 'U3', 'ic', 39, 34));
  add(comp('c1', 'C1', 'cap', 25, 26.5));
  add(comp('c2', 'C2', 'cap', 11, 29.5));
  add(comp('c3', 'C3', 'cap', 39, 29.5));
  add(comp('c4', 'C4', 'cap', 7.5, 9, 90));
  add(comp('c5', 'C5', 'cap', 7.5, 30, 90));
  add(comp('c6', 'C6', 'cap', 43, 9, 90));
  for (let k = 0; k < 7; k++) add(comp(`r${k + 1}`, `R${k + 1}`, 'res', 16, 7 + 2.8 * k));
  for (let k = 0; k < 7; k++) add(comp(`r${k + 8}`, `R${k + 8}`, 'res', 34, 7 + 2.8 * k));
  wire(b, 'VCC', ['J1.1', 'U1.1', 'U2.8', 'U3.8', 'C1.1', 'C2.1', 'C3.1', 'C4.1', 'C5.1', 'C6.1']);
  wire(b, 'GND', ['J1.2', 'U1.2', 'U2.4', 'U3.4', 'C1.2', 'C2.2', 'C3.2', 'C4.2', 'C5.2', 'C6.2', 'J2.4']);
  // left group: U1 pins 3..9 -> R7..R1 -> J1.3..6, U2.1..3
  const leftDest = ['J1.6', 'J1.5', 'J1.4', 'J1.3', 'U2.3', 'U2.2', 'U2.1'];
  for (let k = 0; k < 7; k++) {
    const r = `R${k + 1}`;
    wire(b, `SL${k + 1}`, [`U1.${9 - k}`, `${r}.2`]);
    wire(b, `DL${k + 1}`, [`${r}.1`, leftDest[k]]);
  }
  // right group: U1 pins 11..17 -> R8..R14 -> J2.1..3, U3.1..3,5
  const rightDest = ['J2.3', 'J2.2', 'J2.1', 'U3.5', 'U3.3', 'U3.2', 'U3.1'];
  for (let k = 0; k < 7; k++) {
    const r = `R${k + 8}`;
    wire(b, `SR${k + 1}`, [`U1.${11 + k}`, `${r}.1`]);
    wire(b, `DR${k + 1}`, [`${r}.2`, rightDest[k]]);
  }
  return { board: b, parts };
}

/** Deterministic large board: `ics` MCUs with 2 decaps each, 4 headers, and resistors up to `total` parts. */
export function bigBoard(total = 150, w = 100, h = 80, ics = 6): { board: Board; parts: Record<string, PartDef> } {
  const parts = stdParts();
  const b = emptyBoard(w, h);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const add = (id: string, ref: string, partId: string) => {
    const c = comp(id, ref, partId, 0, 0);
    c.placed = false;
    b.components.push(c);
    return c;
  };
  for (let k = 1; k <= 4; k++) add(`j${k}`, `J${k}`, 'hdr6');
  for (let k = 1; k <= ics; k++) add(`u${k}`, `U${k}`, 'mcu');
  let cIdx = 1;
  for (let k = 1; k <= ics; k++) for (let m = 0; m < 2; m++) add(`c${cIdx}`, `C${cIdx++}`, 'cap');
  let rIdx = 1;
  while (b.components.length < total) add(`r${rIdx}`, `R${rIdx++}`, 'res');
  const pins: string[] = [];
  for (let k = 1; k <= 4; k++) for (let p = 3; p <= 6; p++) pins.push(`J${k}.${p}`);
  for (let k = 1; k <= ics; k++) for (let p = 3; p <= 18; p++) pins.push(`U${k}.${p}`);
  wire(b, 'VCC', [...Array.from({ length: 4 }, (_, k) => `J${k + 1}.1`), ...Array.from({ length: ics }, (_, k) => `U${k + 1}.1`), ...Array.from({ length: cIdx - 1 }, (_, k) => `C${k + 1}.1`)]);
  wire(b, 'GND', [...Array.from({ length: 4 }, (_, k) => `J${k + 1}.2`), ...Array.from({ length: ics }, (_, k) => `U${k + 1}.2`), ...Array.from({ length: cIdx - 1 }, (_, k) => `C${k + 1}.2`)]);
  let n = 0;
  for (let r = 1; r < rIdx && pins.length >= 2; r++) {
    const a = pins.splice(Math.floor(rnd() * pins.length), 1)[0];
    wire(b, `N${n++}`, [a, `R${r}.1`]);
    if (rnd() < 0.5 && pins.length) wire(b, `N${n++}`, [`R${r}.2`, pins.splice(Math.floor(rnd() * pins.length), 1)[0]]);
    else if (r > 1) wire(b, `N${n++}`, [`R${r}.2`, `R${r - 1}.2`].filter((x, i, arr) => arr.indexOf(x) === i));
  }
  return { board: b, parts };
}
