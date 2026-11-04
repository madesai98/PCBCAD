/**
 * Demo part library for the viewer gallery: parametric footprints (KiCad-like dimensions),
 * pin definitions and simple 3D bodies. Gallery-only — real parts come from @pcbcad/parts.
 */
import type { BodyPrimitive, FootprintDef, Graphic, PadDef, PartCategory, PartDef, PinDef, PinType, Vec2 } from '@pcbcad/core';

/* -------------------------------------------- helpers ------------------------------------------- */

const SILK_W = 0.12;

function smd(number: string, x: number, y: number, w: number, h: number, shape: PadDef['shape'] = 'roundrect'): PadDef {
  return { number, shape, x, y, w, h, kind: 'smd', roundness: 0.25 };
}

function tht(number: string, x: number, y: number, d: number, drill: number, shape: PadDef['shape'] = 'circle', h = d): PadDef {
  return { number, shape, x, y, w: d, h, kind: 'tht', drill };
}

function rect(x0: number, y0: number, x1: number, y1: number, layer: Graphic['layer'] = 'silk', width = SILK_W): Graphic {
  return {
    kind: 'polyline',
    layer,
    width,
    closed: true,
    points: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
  };
}

function line(a: Vec2, b: Vec2, width = SILK_W): Graphic {
  return { kind: 'line', layer: 'silk', a, b, width };
}

function refText(x: number, y: number, size = 0.8): Graphic {
  return { kind: 'text', layer: 'silk', at: [x, y], text: 'REF**', size };
}

function cornerMarks(hw: number, hh: number, len: number): Graphic[] {
  const g: Graphic[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      g.push({
        kind: 'polyline',
        layer: 'silk',
        width: SILK_W,
        points: [
          [sx * hw, sy * (hh - len)],
          [sx * hw, sy * hh],
          [sx * (hw - len), sy * hh],
        ],
      });
    }
  return g;
}

function footprint(name: string, pads: PadDef[], graphics: Graphic[], body?: { w: number; l: number }, margin = 0.25): FootprintDef {
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
  if (body) {
    minX = Math.min(minX, -body.w / 2);
    maxX = Math.max(maxX, body.w / 2);
    minY = Math.min(minY, -body.l / 2);
    maxY = Math.max(maxY, body.l / 2);
  }
  if (!Number.isFinite(minX)) {
    minX = -1;
    minY = -1;
    maxX = 1;
    maxY = 1;
  }
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    name,
    pads,
    graphics: [...graphics, ...(body ? [rect(-body.w / 2, -body.l / 2, body.w / 2, body.l / 2, 'fab', 0.1)] : [])],
    courtyard: { minX: r(minX - margin), minY: r(minY - margin), maxX: r(maxX + margin), maxY: r(maxY + margin) },
    source: 'generated',
  };
}

const box = (c: [number, number, number], s: [number, number, number], color: string, metal = false, radius?: number): BodyPrimitive => ({
  kind: 'box',
  center: c,
  size: s,
  color,
  metal,
  radius,
});

const cyl = (c: [number, number, number], r: number, h: number, color: string, axis: 'x' | 'y' | 'z' = 'z', metal = false): BodyPrimitive => ({
  kind: 'cylinder',
  center: c,
  radius: r,
  height: h,
  axis,
  color,
  metal,
  segments: 28,
});

function pins(spec: [string, string, PinType, string[]?][]): PinDef[] {
  return spec.map(([number, name, type, functions]) => ({ number, name, type, functions }));
}

function part(p: Omit<PartDef, 'params' | 'offers' | 'provenance'> & Partial<Pick<PartDef, 'params' | 'offers'>>): PartDef {
  return {
    params: {},
    offers: [],
    provenance: { specs: 'builtin', symbol: 'generated', footprint: 'generated', model3d: 'generated', sim: 'builtin', source: 'demo' },
    ...p,
  };
}

/* ------------------------------------------ footprints ------------------------------------------ */

const CHIP: Record<string, { pw: number; ph: number; px: number; body: [number, number, number] }> = {
  '0402': { pw: 0.6, ph: 0.62, px: 0.5, body: [1.0, 0.5, 0.35] },
  '0603': { pw: 0.85, ph: 0.95, px: 0.8, body: [1.6, 0.8, 0.45] },
  '0805': { pw: 1.0, ph: 1.4, px: 0.95, body: [2.0, 1.25, 0.5] },
  '1206': { pw: 1.15, ph: 1.8, px: 1.45, body: [3.2, 1.6, 0.6] },
};

export function chipFootprint(size: string, mark?: 'cathode' | 'plus'): FootprintDef {
  const c = CHIP[size];
  const pads = [smd('1', -c.px, 0, c.pw, c.ph), smd('2', c.px, 0, c.pw, c.ph)];
  const yl = c.ph / 2 + 0.18;
  const xl = Math.max(0.05, c.px - c.pw / 2 - 0.15);
  const g: Graphic[] = [];
  if (size !== '0402') g.push(line([-xl, yl], [xl, yl]), line([-xl, -yl], [xl, -yl]));
  if (mark === 'cathode') g.push(line([-c.px - c.pw / 2 - 0.25, -c.ph / 2], [-c.px - c.pw / 2 - 0.25, c.ph / 2], 0.15));
  if (mark === 'plus') {
    const x = -c.px - c.pw / 2 - 0.45;
    g.push(line([x - 0.3, c.ph / 2 + 0.2], [x + 0.3, c.ph / 2 + 0.2]), line([x, c.ph / 2 - 0.1], [x, c.ph / 2 + 0.5]));
  }
  g.push(refText(0, c.ph / 2 + 0.75, size === '0402' ? 0.6 : 0.75));
  return footprint(`C_${size}_Metric`, pads, g, { w: c.body[0], l: c.body[1] });
}

function chipBody(size: string, kind: 'res' | 'cap' | 'ind' | 'led' | 'fuse' | 'tant', color?: string): BodyPrimitive[] {
  const [w, l, h] = CHIP[size].body;
  const term = Math.min(0.5, w * 0.2);
  switch (kind) {
    case 'res':
      return [box([0, 0, h / 2], [w - 2 * term, l, h * 0.98], '#1b1c1e'), box([-(w - term) / 2, 0, h / 2], [term, l, h], '#cfd2d6', true), box([(w - term) / 2, 0, h / 2], [term, l, h], '#cfd2d6', true)];
    case 'cap':
      return [box([0, 0, h / 2], [w - 2 * term, l * 0.98, h * 0.98], '#b7895a'), box([-(w - term) / 2, 0, h / 2], [term, l, h], '#c9ccd0', true), box([(w - term) / 2, 0, h / 2], [term, l, h], '#c9ccd0', true)];
    case 'ind':
      return [box([0, 0, h / 2], [w - 2 * term, l * 0.98, h], '#3b3d40'), box([-(w - term) / 2, 0, h / 2], [term, l, h], '#c9ccd0', true), box([(w - term) / 2, 0, h / 2], [term, l, h], '#c9ccd0', true)];
    case 'fuse':
      return [box([0, 0, h / 2], [w - 2 * term, l * 0.98, h], '#2f5d3d'), box([-(w - term) / 2, 0, h / 2], [term, l, h], '#c9ccd0', true), box([(w - term) / 2, 0, h / 2], [term, l, h], '#c9ccd0', true)];
    case 'led':
      return [box([0, 0, h * 0.25], [w, l, h * 0.5], '#f1f1ec'), box([0, 0, h * 0.72], [w * 0.92, l * 0.92, h * 0.46], color ?? '#7dffa5'), box([-(w - term) / 2, 0, h * 0.2], [term, l, h * 0.4], '#d0d3d8', true), box([(w - term) / 2, 0, h * 0.2], [term, l, h * 0.4], '#d0d3d8', true)];
    case 'tant':
      return [box([0, 0, h / 2], [w * 0.86, l, h], '#d39b1c'), box([-w * 0.3, 0, h + 0.005], [w * 0.16, l * 0.9, 0.01], '#6b4a0a'), box([-(w - 0.3) / 2, 0, 0.15], [0.3, l * 0.6, 0.3], '#cfd2d6', true), box([(w - 0.3) / 2, 0, 0.15], [0.3, l * 0.6, 0.3], '#cfd2d6', true)];
  }
}

function sod123(): FootprintDef {
  return footprint('D_SOD-123', [smd('1', -1.65, 0, 0.9, 1.2), smd('2', 1.65, 0, 0.9, 1.2)], [line([-2.35, -0.9], [-2.35, 0.9], 0.15), line([-1.0, 0.95], [1.0, 0.95]), line([-1.0, -0.95], [1.0, -0.95]), refText(0, 1.7)], { w: 2.7, l: 1.6 });
}

function sma(): FootprintDef {
  return footprint('D_SMA', [smd('1', -2.0, 0, 2.5, 1.7), smd('2', 2.0, 0, 2.5, 1.7)], [line([-3.55, -1.5], [-3.55, 1.5], 0.18), line([-0.6, 1.5], [0.6, 1.5]), line([-0.6, -1.5], [0.6, -1.5]), refText(0, 2.3, 0.9)], { w: 4.3, l: 2.6 });
}

function sot23(): FootprintDef {
  return footprint(
    'SOT-23',
    [smd('1', -0.95, -1.1, 0.6, 1.0), smd('2', 0.95, -1.1, 0.6, 1.0), smd('3', 0, 1.1, 0.6, 1.0)],
    [line([-1.55, 0.75], [-0.5, 0.75]), line([0.5, 0.75], [1.55, 0.75]), line([-0.3, -0.75], [0.3, -0.75]), refText(0, 2.2, 0.75)],
    { w: 2.9, l: 1.3 },
  );
}

function sot563(): FootprintDef {
  const pads = [smd('1', -0.5, -0.68, 0.3, 0.6), smd('2', 0, -0.68, 0.3, 0.6), smd('3', 0.5, -0.68, 0.3, 0.6), smd('4', 0.5, 0.68, 0.3, 0.6), smd('5', 0, 0.68, 0.3, 0.6), smd('6', -0.5, 0.68, 0.3, 0.6)];
  return footprint('SOT-563', pads, [{ kind: 'circle', layer: 'silk', c: [-1.05, -1.0], r: 0.1, width: 0.1, fill: true }, refText(0, 1.55, 0.6)], { w: 1.6, l: 1.2 });
}

function sot223(): FootprintDef {
  const pads = [smd('1', -2.3, -3.15, 1.1, 2.0), smd('2', 0, -3.15, 1.1, 2.0), smd('3', 2.3, -3.15, 1.1, 2.0), smd('2', 0, 3.15, 3.6, 2.0)];
  return footprint('SOT-223-3_TabPin2', pads, [line([-3.4, 1.9], [-3.4, -1.9]), line([3.4, 1.9], [3.4, -1.9]), line([-3.4, -1.9], [-2.95, -1.9]), refText(0, 4.9, 1.0)], { w: 6.5, l: 3.5 });
}

function qfp32(): FootprintDef {
  const pads: PadDef[] = [];
  const pitch = 0.8;
  const off = 4.2;
  for (let i = 0; i < 8; i++) {
    const t = 2.8 - i * pitch;
    pads.push(smd(String(1 + i), -off, t, 1.5, 0.55)); // left, top→bottom
    pads.push(smd(String(9 + i), -t, -off, 0.55, 1.5)); // bottom, left→right
    pads.push(smd(String(17 + i), off, -t, 1.5, 0.55)); // right, bottom→top
    pads.push(smd(String(25 + i), t, off, 0.55, 1.5)); // top, right→left
  }
  pads.sort((a, b) => Number(a.number) - Number(b.number));
  return footprint('LQFP-32_7x7mm_P0.8mm', pads, [...cornerMarks(3.6, 3.6, 0.45), { kind: 'circle', layer: 'silk', c: [-4.75, 3.75], r: 0.18, width: 0.1, fill: true }, refText(0, 5.75, 1.0)], { w: 7, l: 7 });
}

function lga8(): FootprintDef {
  const ys = [0.975, 0.325, -0.325, -0.975];
  const pads: PadDef[] = [];
  ys.forEach((y, i) => pads.push(smd(String(1 + i), -1.0, y, 0.5, 0.35)));
  [...ys].reverse().forEach((y, i) => pads.push(smd(String(5 + i), 1.0, y, 0.5, 0.35)));
  return footprint('LGA-8_2.5x2.5mm_P0.65mm', pads, [...cornerMarks(1.4, 1.4, 0.3), { kind: 'circle', layer: 'silk', c: [-1.65, 1.55], r: 0.12, width: 0.1, fill: true }, refText(0, 2.1, 0.7)], { w: 2.5, l: 2.5 });
}

function usbC(): FootprintDef {
  const sig: [string, number, number][] = [
    ['A1B12', -3.2, 0.6],
    ['A4B9', -2.4, 0.6],
    ['B8', -1.75, 0.3],
    ['A5', -1.25, 0.3],
    ['B7', -0.75, 0.3],
    ['A6', -0.25, 0.3],
    ['A7', 0.25, 0.3],
    ['B6', 0.75, 0.3],
    ['A8', 1.25, 0.3],
    ['B5', 1.75, 0.3],
    ['A9B4', 2.4, 0.6],
    ['A12B1', 3.2, 0.6],
  ];
  const pads: PadDef[] = sig.map(([n, x, w]) => smd(n, x, 3.05, w, 1.15, 'rect'));
  pads.push(
    { number: 'S1', shape: 'oval', x: -4.32, y: 2.6, w: 1.0, h: 2.1, kind: 'tht', slot: { w: 0.6, h: 1.7 } },
    { number: 'S1', shape: 'oval', x: 4.32, y: 2.6, w: 1.0, h: 2.1, kind: 'tht', slot: { w: 0.6, h: 1.7 } },
    { number: 'S1', shape: 'oval', x: -4.32, y: -1.58, w: 1.0, h: 1.6, kind: 'tht', slot: { w: 0.6, h: 1.2 } },
    { number: 'S1', shape: 'oval', x: 4.32, y: -1.58, w: 1.0, h: 1.6, kind: 'tht', slot: { w: 0.6, h: 1.2 } },
    { number: '', shape: 'circle', x: -2.89, y: 2.05, w: 0.65, h: 0.65, kind: 'npth', drill: 0.65 },
    { number: '', shape: 'circle', x: 2.89, y: 2.05, w: 0.65, h: 0.65, kind: 'npth', drill: 0.65 },
  );
  return footprint('USB_C_Receptacle_HRO_TYPE-C-31-M-12', pads, [line([-4.47, 0.6], [-4.47, -0.6]), line([4.47, 0.6], [4.47, -0.6]), line([-4.47, -2.7], [-4.47, -3.65]), line([4.47, -2.7], [4.47, -3.65]), refText(0, -5.0, 1.0)], { w: 8.94, l: 7.3 });
}

function jstPh(n: number): FootprintDef {
  const pads: PadDef[] = [];
  const x0 = -((n - 1) * 2.0) / 2;
  for (let i = 0; i < n; i++) pads.push(tht(String(i + 1), x0 + i * 2.0, 0, 1.2, 0.75, i === 0 ? 'roundrect' : 'oval', 1.75));
  const hw = ((n - 1) * 2.0) / 2 + 1.95;
  return footprint(`JST_PH_B${n}B-PH-K_1x0${n}_P2.00mm_Vertical`, pads, [rect(-hw, -1.7, hw, 2.8), line([-hw - 0.4, -1.0], [-hw - 0.4, 0.6], 0.15), refText(0, 3.6, 1.0)], { w: hw * 2, l: 4.5 });
}

function header(n: number): FootprintDef {
  const pads: PadDef[] = [];
  const x0 = -((n - 1) * 2.54) / 2;
  for (let i = 0; i < n; i++) pads.push(tht(String(i + 1), x0 + i * 2.54, 0, 1.7, 1.0, i === 0 ? 'rect' : 'circle'));
  const hw = (n * 2.54) / 2;
  return footprint(`PinHeader_1x0${n}_P2.54mm_Vertical`, pads, [rect(-hw, -1.27, hw, 1.27), refText(0, 2.1, 1.0)], { w: hw * 2, l: 2.54 });
}

function crystal3225(): FootprintDef {
  return footprint(
    'Crystal_SMD_3225-4Pin_3.2x2.5mm',
    [smd('1', -1.1, -0.8, 1.4, 1.15), smd('2', 1.1, -0.8, 1.4, 1.15), smd('3', 1.1, 0.8, 1.4, 1.15), smd('4', -1.1, 0.8, 1.4, 1.15)],
    [line([-2.0, -1.65], [-2.0, 1.65]), line([-2.0, -1.65], [2.0, -1.65]), refText(0, 2.3, 0.8)],
    { w: 3.2, l: 2.5 },
  );
}

function tact6x6(): FootprintDef {
  return footprint(
    'SW_SPST_TL3342 6x6mm',
    [smd('1', -3.975, 2.25, 1.55, 1.3), smd('2', 3.975, 2.25, 1.55, 1.3), smd('3', -3.975, -2.25, 1.55, 1.3), smd('4', 3.975, -2.25, 1.55, 1.3)],
    [rect(-3.1, -3.1, 3.1, 3.1), { kind: 'circle', layer: 'silk', c: [0, 0], r: 1.75, width: SILK_W }, refText(0, 4.0, 1.0)],
    { w: 6.2, l: 6.2 },
  );
}

function buzzer9(): FootprintDef {
  return footprint(
    'Buzzer_9x5.5mm_P4.0mm',
    [tht('1', -2.0, 0, 1.6, 0.8, 'rect'), tht('2', 2.0, 0, 1.6, 0.8)],
    [{ kind: 'circle', layer: 'silk', c: [0, 0], r: 4.65, width: SILK_W }, line([-3.6, 1.9], [-2.6, 1.9]), line([-3.1, 1.4], [-3.1, 2.4]), refText(0, 5.5, 1.0)],
    { w: 9.2, l: 9.2 },
  );
}

/* --------------------------------------------- parts -------------------------------------------- */

function passive(id: string, category: PartCategory, value: string, size: string, kind: Parameters<typeof chipBody>[1], extra: Partial<PartDef> = {}): PartDef {
  const [w, l, h] = CHIP[size].body;
  const mark = category === 'led' || category === 'diode' ? 'cathode' : category === 'capacitor-polarized' ? 'plus' : undefined;
  const pinDefs =
    category === 'led' || category === 'diode'
      ? pins([
          ['1', 'K', 'passive'],
          ['2', 'A', 'passive'],
        ])
      : category === 'capacitor-polarized'
        ? pins([
            ['1', '+', 'passive'],
            ['2', '-', 'passive'],
          ])
        : pins([
            ['1', '1', 'passive'],
            ['2', '2', 'passive'],
          ]);
  return part({
    id,
    mpn: extra.mpn ?? `${category.toUpperCase()}-${size}-${value}`,
    manufacturer: extra.manufacturer ?? 'Yageo',
    description: extra.description ?? `${value} ${size} ${category}`,
    category,
    package: size,
    packageSpec: { family: 'chip', size },
    value,
    pins: pinDefs,
    footprint: chipFootprint(size, mark),
    model3d: { kind: 'primitives', primitives: chipBody(size, kind, extra.params?.Color ? undefined : undefined), source: 'generated' },
    body: { w, l, h },
    ...extra,
  });
}

export function demoParts(): Record<string, PartDef> {
  const list: PartDef[] = [
    part({
      id: 'C14877',
      mpn: 'ATMEGA328P-AU',
      manufacturer: 'Microchip',
      description: '8-bit AVR MCU, 32 KB flash, 20 MHz, TQFP-32',
      category: 'mcu',
      package: 'TQFP-32',
      packageSpec: { family: 'qfp', pins: 32, pitch: 0.8, bodyW: 7, bodyL: 7, bodyH: 1.2 },
      pins: pins([
        ['1', 'PD3', 'bidirectional', ['INT1', 'OC2B']],
        ['2', 'PD4', 'bidirectional'],
        ['3', 'GND', 'power_in'],
        ['4', 'VCC', 'power_in'],
        ['5', 'GND', 'power_in'],
        ['6', 'VCC', 'power_in'],
        ['7', 'PB6/XTAL1', 'bidirectional', ['XTAL1']],
        ['8', 'PB7/XTAL2', 'bidirectional', ['XTAL2']],
        ['9', 'PD5', 'bidirectional'],
        ['10', 'PD6', 'bidirectional', ['OC0A']],
        ['11', 'PD7', 'bidirectional'],
        ['12', 'PB0', 'bidirectional'],
        ['13', 'PB1', 'bidirectional'],
        ['14', 'PB2', 'bidirectional'],
        ['15', 'PB3/MOSI', 'bidirectional'],
        ['16', 'PB4/MISO', 'bidirectional'],
        ['17', 'PB5/SCK', 'bidirectional'],
        ['18', 'AVCC', 'power_in'],
        ['19', 'ADC6', 'input'],
        ['20', 'AREF', 'passive'],
        ['21', 'GND', 'power_in'],
        ['22', 'ADC7', 'input'],
        ['23', 'PC0', 'bidirectional'],
        ['24', 'PC1', 'bidirectional'],
        ['25', 'PC2', 'bidirectional'],
        ['26', 'PC3', 'bidirectional'],
        ['27', 'PC4/SDA', 'bidirectional', ['SDA']],
        ['28', 'PC5/SCL', 'bidirectional', ['SCL']],
        ['29', 'PC6/~RESET', 'input', ['RESET']],
        ['30', 'PD0/RXD', 'bidirectional', ['RXD']],
        ['31', 'PD1/TXD', 'bidirectional', ['TXD']],
        ['32', 'PD2', 'bidirectional', ['INT0']],
      ]),
      footprint: qfp32(),
      model3d: { kind: 'primitives', primitives: qfpBody(), source: 'generated' },
      body: { w: 7, l: 7, h: 1.2 },
      sim: { kind: 'mcu', emulator: 'avr:atmega328p', clockHz: 16e6, supplyPins: ['4', '6', '18'], groundPins: ['3', '5', '21'], Icc: 0.009, pinMap: { PB5: '17', PD6: '10', PD1: '31', PD0: '30' } },
      thermal: { thetaJA: 87, tjMax: 150 },
      offers: [{ distributor: 'LCSC', sku: 'C14877', stock: 2310, priceBreaks: [{ qty: 1, price: 2.41 }] }],
    }),
    part({
      id: 'C6186',
      mpn: 'AMS1117-3.3',
      manufacturer: 'AMS',
      description: '1 A LDO regulator, 3.3 V fixed, SOT-223',
      category: 'ldo',
      package: 'SOT-223',
      pins: pins([
        ['1', 'GND/ADJ', 'power_in'],
        ['2', 'VOUT', 'power_out'],
        ['3', 'VIN', 'power_in'],
      ]),
      footprint: sot223(),
      model3d: {
        kind: 'primitives',
        primitives: [box([0, 0, 0.85], [6.5, 3.5, 1.6], '#1e1f22'), box([0, 3.0, 0.07], [3.0, 1.6, 0.14], '#cfd2d6', true), ...[-2.3, 0, 2.3].map((x) => box([x, -2.6, 0.12], [0.7, 1.6, 0.18], '#cfd2d6', true))],
        source: 'generated',
      },
      body: { w: 6.5, l: 7, h: 1.7 },
      sim: { kind: 'ldo', in: '3', out: '2', gnd: '1', Vout: 3.3, dropout: 1.1, Iq: 0.005, Imax: 1 },
      thermal: { thetaJA: 90, thetaJC: 15, tjMax: 125 },
    }),
    part({
      id: 'C92489',
      mpn: 'BME280',
      manufacturer: 'Bosch',
      description: 'Humidity, pressure and temperature sensor, LGA-8',
      category: 'sensor',
      package: 'LGA-8(2.5x2.5)',
      pins: pins([
        ['1', 'GND', 'power_in'],
        ['2', 'CSB', 'input'],
        ['3', 'SDI', 'bidirectional'],
        ['4', 'SCK', 'input'],
        ['5', 'SDO', 'bidirectional'],
        ['6', 'VDDIO', 'power_in'],
        ['7', 'GND', 'power_in'],
        ['8', 'VDD', 'power_in'],
      ]),
      footprint: lga8(),
      model3d: { kind: 'primitives', primitives: [box([0, 0, 0.46], [2.5, 2.5, 0.92], '#c8ccd1', true), cyl([0.55, 0.55, 0.93], 0.18, 0.02, '#202124')], source: 'generated' },
      body: { w: 2.5, l: 2.5, h: 0.93 },
      sim: { kind: 'ic', supplyPins: ['6', '8'], groundPins: ['1', '7'], Icc: 0.0007 },
    }),
    part({
      id: 'C165948',
      mpn: 'TYPE-C-31-M-12',
      manufacturer: 'Korean Hroparts',
      description: 'USB 2.0 Type-C receptacle, 16P, SMD',
      category: 'connector',
      package: 'SMD-16P',
      pins: pins([
        ['A1B12', 'GND', 'power_in'],
        ['A4B9', 'VBUS', 'power_in'],
        ['A5', 'CC1', 'bidirectional'],
        ['B5', 'CC2', 'bidirectional'],
        ['A6', 'D+', 'bidirectional'],
        ['A7', 'D-', 'bidirectional'],
        ['B6', 'D+', 'bidirectional'],
        ['B7', 'D-', 'bidirectional'],
        ['A8', 'SBU1', 'passive'],
        ['B8', 'SBU2', 'passive'],
        ['A9B4', 'VBUS', 'power_in'],
        ['A12B1', 'GND', 'power_in'],
        ['S1', 'SHIELD', 'passive'],
      ]),
      footprint: usbC(),
      model3d: {
        kind: 'primitives',
        primitives: [box([0, -0.6, 1.6], [8.94, 7.3, 3.2], '#c9ced4', true, 1.2), box([0, -4.15, 1.6], [7.2, 0.2, 1.9], '#17181a', false, 0.6), box([0, -3.9, 1.6], [5.6, 0.5, 0.7], '#2a2c30')],
        source: 'generated',
      },
      body: { w: 8.94, l: 7.3, h: 3.2 },
      connector: { family: 'USB-C', gender: 'female', role: 'board', positions: 16, matesWith: ['USB-C:male'], contactResistance: 0.03, currentRating: 3, matingDirection: '-y', opening: { width: 9.4, height: 3.6, zCenter: 1.6 } },
    }),
    part({
      id: 'C131337',
      mpn: 'B4B-PH-K-S',
      manufacturer: 'JST',
      description: 'PH series 2.0 mm header, 4 positions, vertical',
      category: 'connector',
      package: 'TH,P=2mm',
      pins: pins([
        ['1', '1', 'passive'],
        ['2', '2', 'passive'],
        ['3', '3', 'passive'],
        ['4', '4', 'passive'],
      ]),
      footprint: jstPh(4),
      model3d: {
        kind: 'primitives',
        primitives: [box([0, 0.55, 3.0], [9.9, 4.5, 6.0], '#efe9d8', false, 0.3), box([0, 0.35, 5.6], [8.6, 3.0, 0.9], '#5b574c'), ...[-3, -1, 1, 3].map((x) => box([x, 0, 3.2], [0.64, 0.64, 5.0], '#d6b65a', true))],
        source: 'generated',
      },
      body: { w: 9.9, l: 4.5, h: 6.0 },
      connector: { family: 'JST-PH', gender: 'male', role: 'board', positions: 4, pitch: 2.0, matesWith: ['JST-PH:female'], contactResistance: 0.02, currentRating: 2, matingDirection: '+z' },
    }),
    part({
      id: 'C2337',
      mpn: 'PZ254V-11-03P',
      manufacturer: 'XFCN',
      description: 'Pin header 1x3, 2.54 mm, vertical',
      category: 'connector',
      package: 'HDR-1x3',
      pins: pins([
        ['1', '1', 'passive'],
        ['2', '2', 'passive'],
        ['3', '3', 'passive'],
      ]),
      footprint: header(3),
      model3d: { kind: 'primitives', primitives: [box([0, 0, 1.25], [7.62, 2.54, 2.5], '#141517'), ...[-2.54, 0, 2.54].map((x) => box([x, 0, 3.6], [0.64, 0.64, 8.2], '#d9b54b', true))], source: 'generated' },
      body: { w: 7.62, l: 2.54, h: 8.5 },
    }),
    part({
      id: 'C13738',
      mpn: 'X322516MLB4SI',
      manufacturer: 'YXC',
      description: '16 MHz crystal, 3225, 20 pF',
      category: 'crystal',
      package: 'SMD3225-4P',
      value: '16MHz',
      pins: pins([
        ['1', 'X1', 'passive'],
        ['2', 'GND', 'passive'],
        ['3', 'X2', 'passive'],
        ['4', 'GND', 'passive'],
      ]),
      footprint: crystal3225(),
      model3d: { kind: 'primitives', primitives: [box([0, 0, 0.15], [3.2, 2.5, 0.3], '#e7dcc3'), box([0, 0, 0.5], [2.9, 2.2, 0.42], '#d3d6da', true, 0.15)], source: 'generated' },
      body: { w: 3.2, l: 2.5, h: 0.75 },
      sim: { kind: 'crystal', a: '1', b: '3', freq: 16e6 },
    }),
    part({
      id: 'C318884',
      mpn: 'TS-1187A-B-A-B',
      manufacturer: 'XKB',
      description: 'Tactile switch 6x6 mm SMD',
      category: 'button',
      package: 'SMD-4P 6x6',
      pins: pins([
        ['1', '1', 'passive'],
        ['2', '2', 'passive'],
        ['3', '3', 'passive'],
        ['4', '4', 'passive'],
      ]),
      footprint: tact6x6(),
      model3d: {
        kind: 'primitives',
        primitives: [box([0, 0, 1.0], [6.0, 6.0, 2.0], '#1f2023'), box([0, 0, 2.6], [6.0, 6.0, 1.2], '#c3c7cc', true), cyl([0, 0, 3.9], 1.75, 1.6, '#2a2b2e'), ...[-3.6, 3.6].flatMap((x) => [box([x, 2.25, 0.2], [1.2, 0.7, 0.3], '#cfd2d6', true), box([x, -2.25, 0.2], [1.2, 0.7, 0.3], '#cfd2d6', true)])],
        source: 'generated',
      },
      body: { w: 6, l: 6, h: 4.7 },
      sim: { kind: 'switch', a: '1', b: '3', closed: false },
    }),
    part({
      id: 'C96446',
      mpn: 'MLT-8530',
      manufacturer: 'Jiangsu Huaneng',
      description: 'Magnetic buzzer 9x5.5 mm, 3.6 V',
      category: 'buzzer',
      package: 'TH 9x5.5',
      pins: pins([
        ['1', '+', 'passive'],
        ['2', '-', 'passive'],
      ]),
      footprint: buzzer9(),
      model3d: { kind: 'mesh', meshAssetId: 'model:buzzer-9mm', source: 'fetched' },
      body: { w: 9, l: 9, h: 5.5 },
    }),
    part({
      id: 'C8545',
      mpn: '2N7002',
      manufacturer: 'Nexperia',
      description: 'N-channel MOSFET 60 V 300 mA SOT-23',
      category: 'mosfet-n',
      package: 'SOT-23',
      pins: pins([
        ['1', 'G', 'input'],
        ['2', 'S', 'passive'],
        ['3', 'D', 'passive'],
      ]),
      footprint: sot23(),
      model3d: { kind: 'primitives', primitives: [box([0, 0, 0.55], [2.9, 1.3, 0.95], '#1d1e21'), ...[[-0.95, -0.9], [0.95, -0.9], [0, 0.9]].map(([x, y]) => box([x, y, 0.12], [0.4, 0.6, 0.15], '#cfd2d6', true))], source: 'generated' },
      body: { w: 2.9, l: 2.4, h: 1.1 },
      sim: { kind: 'mosfet', polarity: 'n', g: '1', d: '3', s: '2', Vth: 1.6, Rds_on: 2.5 },
    }),
    part({
      id: 'C81598',
      mpn: '1N4148W',
      manufacturer: 'Diodes Inc',
      description: 'Switching diode 75 V SOD-123',
      category: 'diode',
      package: 'SOD-123',
      pins: pins([
        ['1', 'K', 'passive'],
        ['2', 'A', 'passive'],
      ]),
      footprint: sod123(),
      model3d: { kind: 'primitives', primitives: [box([0, 0, 0.55], [2.7, 1.6, 1.05], '#202124'), box([-1.05, 0, 1.08], [0.35, 1.55, 0.02], '#c9c9c9'), box([-1.55, 0, 0.1], [0.5, 0.6, 0.15], '#cfd2d6', true), box([1.55, 0, 0.1], [0.5, 0.6, 0.15], '#cfd2d6', true)], source: 'generated' },
      body: { w: 2.7, l: 1.6, h: 1.1 },
      sim: { kind: 'diode', anode: '2', cathode: '1', Vf: 0.72 },
    }),
    part({
      id: 'C8678',
      mpn: 'SS14',
      manufacturer: 'MDD',
      description: 'Schottky diode 40 V 1 A SMA',
      category: 'schottky',
      package: 'SMA(DO-214AC)',
      pins: pins([
        ['1', 'K', 'passive'],
        ['2', 'A', 'passive'],
      ]),
      footprint: sma(),
      model3d: { kind: 'primitives', primitives: [box([0, 0, 1.05], [4.3, 2.6, 2.1], '#232427'), box([-1.6, 0, 2.11], [0.45, 2.5, 0.02], '#cfcfcf'), box([-2.3, 0, 0.12], [0.9, 1.5, 0.2], '#cfd2d6', true), box([2.3, 0, 0.12], [0.9, 1.5, 0.2], '#cfd2d6', true)], source: 'generated' },
      body: { w: 4.3, l: 2.6, h: 2.1 },
      sim: { kind: 'diode', anode: '2', cathode: '1', Vf: 0.38 },
    }),
    part({
      id: 'C1000182',
      mpn: 'TMP102AIDRLR',
      manufacturer: 'Texas Instruments',
      description: 'Digital temperature sensor, I2C, SOT-563',
      category: 'sensor',
      package: 'SOT-563',
      pins: pins([
        ['1', 'SCL', 'input'],
        ['2', 'GND', 'power_in'],
        ['3', 'ALERT', 'output'],
        ['4', 'ADD0', 'input'],
        ['5', 'V+', 'power_in'],
        ['6', 'SDA', 'bidirectional'],
      ]),
      footprint: sot563(),
      model3d: { kind: 'primitives', primitives: [box([0, 0, 0.3], [1.6, 1.2, 0.55], '#1f2023')], source: 'generated' },
      body: { w: 1.6, l: 1.6, h: 0.6 },
    }),
    // Passives
    passive('C25744', 'resistor', '10k', '0402', 'res', { mpn: '0402WGF1002TCE' }),
    passive('C25900', 'resistor', '4.7k', '0402', 'res', { mpn: '0402WGF4701TCE' }),
    passive('C25905', 'resistor', '5.1k', '0402', 'res', { mpn: '0402WGF5101TCE' }),
    passive('C25104', 'resistor', '330', '0402', 'res', { mpn: '0402WGF3300TCE' }),
    passive('C25076', 'resistor', '100', '0402', 'res', { mpn: '0402WGF1000TCE' }),
    passive('C25741', 'resistor', '100k', '0402', 'res', { mpn: '0402WGF1003TCE' }),
    passive('C11702', 'resistor', '1k', '0402', 'res', { mpn: '0402WGF1001TCE' }),
    passive('C1525', 'capacitor', '100nF', '0402', 'cap', { mpn: 'CL05B104KO5NNNC', manufacturer: 'Samsung' }),
    passive('C1555', 'capacitor', '22pF', '0402', 'cap', { mpn: 'CL05C220JB5NNNC', manufacturer: 'Samsung' }),
    passive('C15850', 'capacitor', '10uF', '0805', 'cap', { mpn: 'CL21A106KAYNNNE', manufacturer: 'Samsung' }),
    passive('C7171', 'capacitor-polarized', '22uF', '1206', 'tant', { mpn: 'TAJA226K016RNJ', manufacturer: 'Kyocera AVX', package: 'CASE-A_3216' }),
    passive('C1015', 'ferrite', '600R@100MHz', '0603', 'ind', { mpn: 'GZ1608D601TF', manufacturer: 'Sunlord' }),
    passive('C369159', 'fuse', '500mA', '1206', 'fuse', { mpn: 'SMD1206P050TF', manufacturer: 'PTTC' }),
    passive('C72043', 'led', 'Green', '0603', 'led', {
      mpn: '19-217/GHC-YR1S2/3T',
      manufacturer: 'Everlight',
      params: { Color: 'Green' },
      model3d: { kind: 'primitives', primitives: chipBody('0603', 'led', '#57e389'), source: 'generated' },
      sim: { kind: 'led', anode: '2', cathode: '1', Vf: 2.1, If: 0.02, color: '#22c55e' },
    }),
    passive('C2286', 'led', 'Red', '0603', 'led', {
      mpn: 'KT-0603R',
      manufacturer: 'Hubei KENTO',
      params: { Color: 'Red' },
      model3d: { kind: 'primitives', primitives: chipBody('0603', 'led', '#ff5a52'), source: 'generated' },
      sim: { kind: 'led', anode: '2', cathode: '1', Vf: 1.9, If: 0.02, color: '#ef4444' },
    }),
    // Board artwork (silk only, no pads).
    part({
      id: 'custom:logo',
      mpn: 'LOGO',
      manufacturer: 'demo',
      description: 'Silkscreen logo',
      category: 'mechanical',
      package: 'logo',
      pins: [],
      footprint: {
        name: 'Logo',
        pads: [],
        graphics: [
          { kind: 'text', layer: 'silk', at: [0, 0.6], text: 'ENV-NODE', size: 1.5 },
          { kind: 'text', layer: 'silk', at: [0, -1.2], text: 'rev B · 2026-11', size: 0.75 },
          rect(-6.3, -2.2, 6.3, 1.9),
        ],
        courtyard: { minX: -6.4, minY: -2.3, maxX: 6.4, maxY: 2.0 },
        source: 'agent',
      },
    }),
  ];
  return Object.fromEntries(list.map((p) => [p.id, p]));
}

function qfpBody(): BodyPrimitive[] {
  const prims: BodyPrimitive[] = [box([0, 0, 0.75], [7, 7, 1.3], '#1c1d20', false, 0.15), cyl([-2.6, 2.6, 1.41], 0.4, 0.02, '#2c2e33')];
  for (let i = 0; i < 8; i++) {
    const t = 2.8 - i * 0.8;
    prims.push(box([-4.0, t, 0.22], [1.0, 0.37, 0.16], '#cfd2d6', true));
    prims.push(box([-t, -4.0, 0.22], [0.37, 1.0, 0.16], '#cfd2d6', true));
    prims.push(box([4.0, -t, 0.22], [1.0, 0.37, 0.16], '#cfd2d6', true));
    prims.push(box([t, 4.0, 0.22], [0.37, 1.0, 0.16], '#cfd2d6', true));
  }
  return prims;
}

/** Symbol-library sampler: one part per schematic symbol family (pins + categories only). */
export function symbolSamplerParts(): PartDef[] {
  const two = (id: string, category: PartCategory, value: string, names: [string, string] = ['1', '2'], sim?: PartDef['sim']): PartDef =>
    part({ id, mpn: id.toUpperCase(), manufacturer: 'demo', description: category, category, package: '-', value, pins: pins([
      ['1', names[0], 'passive'],
      ['2', names[1], 'passive'],
    ]), sim });
  const three = (id: string, category: PartCategory, names: [string, string, string]): PartDef =>
    part({ id, mpn: id.toUpperCase(), manufacturer: 'demo', description: category, category, package: 'SOT-23', pins: pins([
      ['1', names[0], 'passive'],
      ['2', names[1], 'passive'],
      ['3', names[2], 'passive'],
    ]) });
  return [
    two('s-res', 'resistor', '10k'),
    two('s-cap', 'capacitor', '100nF'),
    two('s-capp', 'capacitor-polarized', '220uF', ['+', '-']),
    two('s-ind', 'inductor', '4.7uH'),
    two('s-fb', 'ferrite', '120R'),
    two('s-d', 'diode', '1N4148', ['K', 'A']),
    two('s-z', 'zener', '5V1', ['K', 'A']),
    two('s-sk', 'schottky', 'SS34', ['K', 'A']),
    two('s-tvs', 'tvs', 'SMAJ5.0A', ['K', 'A']),
    two('s-led-b', 'led', 'Blue', ['K', 'A'], { kind: 'led', anode: '2', cathode: '1', Vf: 3, If: 0.02, color: '#3b82f6' }),
    two('s-led-y', 'led', 'Amber', ['K', 'A'], { kind: 'led', anode: '2', cathode: '1', Vf: 2, If: 0.02, color: '#f59e0b' }),
    two('s-xtal', 'crystal', '32.768kHz'),
    two('s-sw', 'switch', 'SPDT'),
    two('s-btn', 'button', 'TACT'),
    two('s-fuse', 'fuse', '2A'),
    two('s-bat', 'battery', 'CR2032', ['+', '-']),
    two('s-bz', 'buzzer', '4kHz', ['+', '-']),
    three('s-npn', 'bjt-npn', ['B', 'C', 'E']),
    three('s-pnp', 'bjt-pnp', ['B', 'C', 'E']),
    three('s-nmos', 'mosfet-n', ['G', 'S', 'D']),
    three('s-pmos', 'mosfet-p', ['G', 'S', 'D']),
    part({
      id: 's-opamp',
      mpn: 'MCP6002',
      manufacturer: 'Microchip',
      description: 'Dual op-amp',
      category: 'opamp',
      package: 'SOIC-8',
      pins: pins([
        ['1', 'OUTA', 'output'],
        ['2', 'INA-', 'input'],
        ['3', 'INA+', 'input'],
        ['4', 'VSS', 'power_in'],
        ['5', 'INB+', 'input'],
        ['6', 'INB-', 'input'],
        ['7', 'OUTB', 'output'],
        ['8', 'VDD', 'power_in'],
      ]),
    }),
    part({
      id: 's-conn',
      mpn: 'SM04B-SRSS',
      manufacturer: 'JST',
      description: 'Qwiic connector',
      category: 'connector',
      package: 'SH-4',
      pins: pins([
        ['1', 'GND', 'passive'],
        ['2', 'VCC', 'passive'],
        ['3', 'SDA', 'passive'],
        ['4', 'SCL', 'passive'],
      ]),
    }),
  ];
}
