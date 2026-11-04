import type { BodyPrimitive, DistributorOffer, FastenerSpec, PartDef, Vec2 } from '@pcbcad/core';
import { boxSpan, cyl, extrude } from '../body/prims';
import { rnd } from '../util/num';
import { catalogPart, otherOffer } from './common';

/* --------------------------------------------------------------------------------------------- *
 * Fastener catalog (category 'fastener', FastenerSpec on every entry).
 *
 * Dimensions: ISO 7380-1 (button head), ISO 14583 / ISO 7045 (pan head), ISO 4762 (socket head),
 * ISO 4032 (hex nut), ISO 7089 (washer), ISO 273 medium clearance holes. Heat-set insert install
 * holes follow the common straight-knurl practice (≈ 0.9 × OD); thread-forming screws for plastic
 * use a pilot hole ≈ 0.8 × d.
 *
 * Distributor SKUs: an LCSC code is attached ONLY where it was verified through the JLCPCB parts
 * search API (2026-11-04) and the listing matched the size; everything else carries an 'Other'
 * offer with the standard designation and no price.
 *
 * Model frame (all fasteners): Z is the fastener axis, +Z points from the tip toward the head.
 *   screws: origin = bearing face under the head (head z ≥ 0, shank z ≤ 0);
 *   nuts, washers, inserts: origin = centre;   standoffs: origin = centre of the female end face
 *   that sits on the lower board (body z ∈ [0, L], male thread z < 0).
 * --------------------------------------------------------------------------------------------- */

const STAINLESS = '#c3c7cb';
const ZINC = '#b7bcc2';
const BLACK = '#2a2a2d';
const BRASS = '#c8a447';
const HOLE = '#121212';

/** ISO 898 / ISO 3506 tensile stress areas (mm²). */
const STRESS_AREA: Record<string, number> = { M2: 2.07, 'M2.5': 3.39, M3: 5.03 };
const CLEARANCE: Record<string, number> = { M2: 2.4, 'M2.5': 2.9, M3: 3.4 };
const DIA: Record<string, number> = { M2: 2, 'M2.5': 2.5, M3: 3 };

const DENSITY: Record<string, number> = { 'ss-a2': 0.00793, 'steel-zinc': 0.00785, brass: 0.0085 };

function hexagon(af: number): Vec2[] {
  const r = af / Math.sqrt(3);
  const pts: Vec2[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    pts.push([rnd(r * Math.cos(a), 4), rnd(r * Math.sin(a), 4)]);
  }
  return pts;
}

function hexArea(af: number): number {
  return (Math.sqrt(3) / 2) * af * af;
}

type Head = 'button' | 'pan' | 'socket';
type Drive = 'hex' | 'torx' | 'phillips';

function screwPrims(d: number, L: number, head: Head, dk: number, k: number, drive: Drive, color: string): BodyPrimitive[] {
  const out: BodyPrimitive[] = [cyl([0, 0, -L / 2], (d / 2) * 0.94, L, 'z', color, { metal: true, segments: 20 })];
  if (head === 'button') {
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const z0 = (k * i) / steps;
      const z1 = (k * (i + 1)) / steps;
      const t = (i + 0.5) / steps;
      out.push(cyl([0, 0, (z0 + z1) / 2], (dk / 2) * Math.sqrt(Math.max(0.15, 1 - t * t * 0.85)), z1 - z0, 'z', color, { metal: true, segments: 28 }));
    }
  } else if (head === 'pan') {
    out.push(cyl([0, 0, k * 0.4], dk / 2, k * 0.8, 'z', color, { metal: true, segments: 28 }));
    out.push(cyl([0, 0, k * 0.9], dk * 0.42, k * 0.2, 'z', color, { metal: true, segments: 28 }));
  } else {
    out.push(cyl([0, 0, k / 2], dk / 2, k, 'z', color, { metal: true, segments: 28 }));
  }
  const top = k + 0.004;
  if (drive === 'phillips') {
    const l = dk * 0.5;
    const w = Math.max(0.25, dk * 0.08);
    out.push(boxSpan(-l / 2, l / 2, -w / 2, w / 2, top - 0.006, top, HOLE));
    out.push(boxSpan(-w / 2, w / 2, -l / 2, l / 2, top - 0.006, top, HOLE));
  } else {
    const s = drive === 'torx' ? dk * 0.32 : dk * 0.36;
    out.push(extrude(hexagon(s), top - 0.006, top, HOLE));
  }
  return out;
}

interface ScrewRow {
  id: string;
  mpn: string;
  manufacturer: string;
  standard: string;
  head: Head;
  drive: Drive;
  thread: string;
  L: number;
  dk: number;
  k: number;
  materialId: 'ss-a2' | 'steel-zinc';
  strength: string;
  proofStress: number;
  color: string;
  offers: DistributorOffer[];
  description: string;
}

function screwPart(r: ScrewRow): PartDef {
  const d = DIA[r.thread];
  const vol = Math.PI * (d / 2) ** 2 * r.L * 0.85 + Math.PI * (r.dk / 2) ** 2 * r.k * (r.head === 'button' ? 0.6 : r.head === 'pan' ? 0.8 : 0.9);
  const fastener: FastenerSpec = {
    type: 'screw',
    thread: r.thread,
    diameter: d,
    length: r.L,
    head: r.head,
    headDiameter: r.dk,
    headHeight: r.k,
    drive: r.drive,
    holeDiameter: CLEARANCE[r.thread],
    materialId: r.materialId,
    strengthClass: r.strength,
    proofLoad: Math.round(r.proofStress * STRESS_AREA[r.thread]),
  };
  return catalogPart({
    id: r.id,
    mpn: r.mpn,
    manufacturer: r.manufacturer,
    description: r.description,
    category: 'fastener',
    package: `${r.thread}x${r.L}`,
    params: { Standard: r.standard, Thread: r.thread, Length: `${r.L}mm`, Head: `${r.head} Ø${r.dk} × ${r.k}`, Drive: r.drive, Material: r.materialId === 'ss-a2' ? 'Stainless steel A2' : 'Carbon steel, plated', 'Clearance hole': `${CLEARANCE[r.thread]}mm` },
    offers: r.offers,
    pins: [],
    massGrams: rnd(vol * DENSITY[r.materialId], 3),
    primitives: screwPrims(d, r.L, r.head, r.dk, r.k, r.drive, r.color),
    extra: { fastener, body: { w: r.dk, l: r.dk, h: r.L + r.k } },
  });
}

const LENGTHS = [4, 5, 6, 8, 10, 12];
const THREADS = ['M2', 'M2.5', 'M3'] as const;

const ISO7380: Record<string, [number, number]> = { M2: [3.5, 1.3], 'M2.5': [4.7, 1.5], M3: [5.7, 1.65] };
const ISO14583: Record<string, [number, number]> = { M2: [4.0, 1.6], 'M2.5': [5.0, 2.1], M3: [5.6, 2.4] };
const ISO4762: Record<string, [number, number]> = { M2: [3.8, 2.0], 'M2.5': [4.5, 2.5], M3: [5.5, 3.0] };

/** Verified JLCPCB/LCSC SKUs for cross-recessed pan head machine screws (Shuntian PMxXy, nickel-plated steel). */
const PAN_PHILLIPS_LCSC: Record<string, string> = {
  'M2x4': 'C357393',
  'M2x6': 'C357534',
  'M2.5x4': 'C357536',
  'M3x4': 'C357397',
  'M3x5': 'C357398',
  'M3x6': 'C357543',
  'M3x8': 'C357544',
  'M3x10': 'C357545',
  'M3x12': 'C357546',
};
const PAN_PHILLIPS_MPN: Record<string, string> = { C357393: 'PM2X4nie', C357534: 'PM2X6', C357536: 'PM2.5X4', C357397: 'PM3X4nie', C357398: 'PM3X5nie', C357543: 'PM3X6', C357544: 'PM3X8', C357545: 'PM3X10', C357546: 'PM3X12' };

function lcscFastenerOffer(code: string): DistributorOffer[] {
  return [
    { distributor: 'LCSC', sku: code, url: `https://www.lcsc.com/product-detail/${code}.html`, currency: 'USD' },
    { distributor: 'JLCPCB', sku: code, url: `https://jlcpcb.com/partdetail/${code}`, currency: 'USD', libraryType: 'extended' },
  ];
}

function screws(): PartDef[] {
  const out: PartDef[] = [];
  for (const t of THREADS) {
    for (const L of LENGTHS) {
      const [dk7380, k7380] = ISO7380[t];
      out.push(
        screwPart({
          id: `fastener:iso7380-${t.toLowerCase()}x${L}`,
          mpn: `ISO 7380-1 ${t}x${L} A2-70`,
          manufacturer: 'Generic',
          standard: 'ISO 7380-1',
          head: 'button',
          drive: 'hex',
          thread: t,
          L,
          dk: dk7380,
          k: k7380,
          materialId: 'ss-a2',
          strength: 'A2-70',
          proofStress: 450,
          color: STAINLESS,
          offers: otherOffer(`ISO 7380-1 ${t}x${L} A2-70`),
          description: `Button head hex socket screw ${t}×${L} mm, stainless A2-70 (ISO 7380-1)`,
        }),
      );
      const [dkPan, kPan] = ISO14583[t];
      out.push(
        screwPart({
          id: `fastener:iso14583-${t.toLowerCase()}x${L}`,
          mpn: `ISO 14583 ${t}x${L} A2-70`,
          manufacturer: 'Generic',
          standard: 'ISO 14583',
          head: 'pan',
          drive: 'torx',
          thread: t,
          L,
          dk: dkPan,
          k: kPan,
          materialId: 'ss-a2',
          strength: 'A2-70',
          proofStress: 450,
          color: STAINLESS,
          offers: otherOffer(`ISO 14583 ${t}x${L} A2-70`),
          description: `Pan head hexalobular (Torx) screw ${t}×${L} mm, stainless A2-70 (ISO 14583)`,
        }),
      );
      const [dkS, kS] = ISO4762[t];
      out.push(
        screwPart({
          id: `fastener:iso4762-${t.toLowerCase()}x${L}`,
          mpn: `ISO 4762 ${t}x${L} A2-70`,
          manufacturer: 'Generic',
          standard: 'ISO 4762',
          head: 'socket',
          drive: 'hex',
          thread: t,
          L,
          dk: dkS,
          k: kS,
          materialId: 'ss-a2',
          strength: 'A2-70',
          proofStress: 450,
          color: STAINLESS,
          offers: otherOffer(`ISO 4762 ${t}x${L} A2-70`),
          description: `Socket head cap screw ${t}×${L} mm, stainless A2-70 (ISO 4762)`,
        }),
      );
      const code = PAN_PHILLIPS_LCSC[`${t}x${L}`];
      if (code) {
        out.push(
          screwPart({
            id: code,
            mpn: PAN_PHILLIPS_MPN[code],
            manufacturer: 'Shuntian',
            standard: 'ISO 7045 / GB/T 818',
            head: 'pan',
            drive: 'phillips',
            thread: t,
            L,
            dk: ISO14583[t][0],
            k: ISO14583[t][1],
            materialId: 'steel-zinc',
            strength: '4.8',
            proofStress: 310,
            color: ZINC,
            offers: lcscFastenerOffer(code),
            description: `Cross-recessed pan head machine screw ${t}×${L} mm, nickel-plated steel (ISO 7045 / GB/T 818)`,
          }),
        );
      }
    }
  }
  return out;
}

interface TappingRow {
  id: string;
  mpn: string;
  manufacturer: string;
  thread: string;
  d: number;
  L: number;
  dk: number;
  k: number;
  pilot: number;
  drive: Drive;
  color: string;
  offers: DistributorOffer[];
  description: string;
  point: 'flat' | 'pointed';
}

function tappingPart(r: TappingRow): PartDef {
  const vol = Math.PI * (r.d / 2) ** 2 * r.L * 0.8 + Math.PI * (r.dk / 2) ** 2 * r.k * 0.8;
  const fastener: FastenerSpec = {
    type: 'self-tapping-screw',
    thread: r.thread,
    diameter: r.d,
    length: r.L,
    head: 'pan',
    headDiameter: r.dk,
    headHeight: r.k,
    drive: r.drive,
    holeDiameter: r.pilot,
    materialId: 'steel-zinc',
    strengthClass: 'case-hardened',
  };
  return catalogPart({
    id: r.id,
    mpn: r.mpn,
    manufacturer: r.manufacturer,
    description: r.description,
    category: 'fastener',
    package: `${r.thread}x${r.L}`,
    params: {
      Thread: r.thread,
      Length: `${r.L}mm`,
      Point: r.point,
      'Pilot hole (plastic)': `${r.pilot}mm`,
      'Recommended boss OD': `${rnd(r.d * 2.2, 1)}mm`,
      'Recommended engagement': `${rnd(r.d * 2, 1)}mm`,
    },
    offers: r.offers,
    pins: [],
    massGrams: rnd(vol * DENSITY['steel-zinc'], 3),
    primitives: screwPrims(r.d, r.L, 'pan', r.dk, r.k, r.drive, r.color),
    extra: { fastener, body: { w: r.dk, l: r.dk, h: r.L + r.k } },
  });
}

function tappingScrews(): PartDef[] {
  const pt = (d: number, L: number): TappingRow => {
    const code = `K${Math.round(d * 10)}`;
    return {
      id: `fastener:pt-${code.toLowerCase()}x${L}`,
      mpn: `PT ${code}x${L} WN 5411`,
      manufacturer: 'Generic',
      thread: `PT ${code}`,
      d,
      L,
      dk: rnd(d * 2, 2),
      k: rnd(d * 0.8, 2),
      pilot: rnd(d * 0.8, 2),
      drive: 'torx',
      color: ZINC,
      offers: otherOffer(`PT ${code}x${L} (EJOT PT / WN 5411 style) pan head Torx, zinc plated`),
      description: `Thread-forming screw for plastics ${code}×${L} mm (PT style, 30° flank), pilot hole Ø${rnd(d * 0.8, 2)} mm`,
      point: 'flat',
    };
  };
  return [
    tappingPart(pt(2.5, 6)),
    tappingPart(pt(2.5, 8)),
    tappingPart(pt(3.0, 8)),
    tappingPart(pt(3.0, 10)),
    tappingPart({
      id: 'C5222490',
      mpn: 'PB3X6-1',
      manufacturer: 'Shuntian',
      thread: 'ST3.0',
      d: 3.0,
      L: 6,
      dk: 5.0,
      k: 2.0,
      pilot: 2.5,
      drive: 'phillips',
      color: ZINC,
      offers: lcscFastenerOffer('C5222490'),
      description: 'Phillips pan head flat-point self-tapping screw ST3×6 mm for plastic bosses, nickel plated (head Ø5.0)',
      point: 'flat',
    }),
    tappingPart({
      id: 'C5222493',
      mpn: 'PB3X8',
      manufacturer: 'Shuntian',
      thread: 'ST3.0',
      d: 3.0,
      L: 8,
      dk: 5.0,
      k: 2.0,
      pilot: 2.5,
      drive: 'phillips',
      color: BLACK,
      offers: lcscFastenerOffer('C5222493'),
      description: 'Phillips pan head flat-point self-tapping screw ST3×8 mm for plastic bosses, black oxide (head Ø5.0)',
      point: 'flat',
    }),
    tappingPart({
      id: 'C50054',
      mpn: 'M3x6',
      manufacturer: 'XHHD',
      thread: 'ST3.0',
      d: 3.0,
      L: 6,
      dk: 5.6,
      k: 2.2,
      pilot: 2.5,
      drive: 'phillips',
      color: ZINC,
      offers: lcscFastenerOffer('C50054'),
      description: 'Phillips pan head self-tapping screw PA3×6 mm (pointed), nickel plated',
      point: 'pointed',
    }),
  ];
}

function nutPart(thread: string, af: number, m: number, offers: DistributorOffer[], id: string, mpn: string, manufacturer: string): PartDef {
  const d = DIA[thread];
  const vol = (hexArea(af) - Math.PI * (d / 2) ** 2) * m;
  const fastener: FastenerSpec = { type: 'nut', thread, diameter: d, head: 'hex', outerDiameter: af, length: m, materialId: 'steel-zinc', strengthClass: '6' };
  const prims: BodyPrimitive[] = [
    extrude(hexagon(af), -m / 2, m / 2, ZINC, true),
    cyl([0, 0, m / 2 + 0.003], (d / 2) * 0.95, 0.006, 'z', HOLE, { segments: 20 }),
    cyl([0, 0, -m / 2 - 0.003], (d / 2) * 0.95, 0.006, 'z', HOLE, { segments: 20 }),
  ];
  return catalogPart({
    id,
    mpn,
    manufacturer,
    description: `Hex nut ${thread}, A/F ${af} mm × ${m} mm, plated steel (ISO 4032 / DIN 934)`,
    category: 'fastener',
    package: thread,
    params: { Standard: 'ISO 4032 / DIN 934', Thread: thread, 'Width across flats': `${af}mm`, Height: `${m}mm` },
    offers,
    pins: [],
    massGrams: rnd(vol * DENSITY['steel-zinc'], 3),
    primitives: prims,
    extra: { fastener, body: { w: af * 1.155, l: af, h: m } },
  });
}

function nuts(): PartDef[] {
  return [
    nutPart('M2', 4.0, 1.6, otherOffer('ISO 4032 M2-6 zinc plated'), 'fastener:iso4032-m2', 'ISO 4032 M2', 'Generic'),
    nutPart('M2.5', 5.0, 2.0, lcscFastenerOffer('C357431'), 'C357431', 'M2.5', 'Shuntian'),
    nutPart('M3', 5.5, 2.4, [...lcscFastenerOffer('C357432'), { distributor: 'LCSC', sku: 'C133377', url: 'https://www.lcsc.com/product-detail/C133377.html', currency: 'USD' }], 'C357432', 'DIN934 M3nie', 'Shuntian'),
  ];
}

function washers(): PartDef[] {
  const row = (thread: string, d1: number, d2: number, h: number, offers: DistributorOffer[], id: string, mpn: string, manufacturer: string, materialId: 'ss-a2' | 'steel-zinc'): PartDef => {
    const vol = Math.PI * ((d2 / 2) ** 2 - (d1 / 2) ** 2) * h;
    const fastener: FastenerSpec = { type: 'washer', thread, diameter: DIA[thread], outerDiameter: d2, length: h, holeDiameter: d1, materialId };
    return catalogPart({
      id,
      mpn,
      manufacturer,
      description: `Plain washer ${thread} (Ø${d1}/Ø${d2} × ${h} mm), ${materialId === 'ss-a2' ? 'stainless A2' : 'zinc-plated steel'} (ISO 7089)`,
      category: 'fastener',
      package: thread,
      params: { Standard: 'ISO 7089', 'Inner diameter': `${d1}mm`, 'Outer diameter': `${d2}mm`, Thickness: `${h}mm` },
      offers,
      pins: [],
      massGrams: rnd(vol * DENSITY[materialId], 4),
      primitives: [cyl([0, 0, 0], d2 / 2, h, 'z', materialId === 'ss-a2' ? STAINLESS : ZINC, { metal: true, segments: 28 }), cyl([0, 0, h / 2 + 0.003], d1 / 2, 0.006, 'z', HOLE, { segments: 20 }), cyl([0, 0, -h / 2 - 0.003], d1 / 2, 0.006, 'z', HOLE, { segments: 20 })],
      extra: { fastener, body: { w: d2, l: d2, h } },
    });
  };
  return [
    row('M2', 2.2, 5.0, 0.3, otherOffer('ISO 7089 M2 A2'), 'fastener:iso7089-m2', 'ISO 7089 M2 A2', 'Generic', 'ss-a2'),
    row('M2.5', 2.7, 6.0, 0.5, otherOffer('ISO 7089 M2.5 A2'), 'fastener:iso7089-m2.5', 'ISO 7089 M2.5 A2', 'Generic', 'ss-a2'),
    row('M3', 3.2, 7.0, 0.5, lcscFastenerOffer('C24867'), 'C24867', '3M SUS', 'XHHD', 'ss-a2'),
  ];
}

function holeFor(od: number): number {
  return rnd(Math.round(od * 0.9 * 10) / 10, 2);
}

function insertPart(thread: string, L: number, od: number, offers: DistributorOffer[], id: string, mpn: string, manufacturer: string, hole?: number, note?: string): PartDef {
  const d = DIA[thread];
  const h = hole ?? holeFor(od);
  const vol = Math.PI * ((od / 2) ** 2 - (d / 2) ** 2) * L * 0.92;
  const fastener: FastenerSpec = { type: 'heat-set-insert', thread, diameter: d, length: L, outerDiameter: od, holeDiameter: h, materialId: 'brass' };
  const prims: BodyPrimitive[] = [cyl([0, 0, 0], od / 2, L, 'z', BRASS, { metal: true, segments: 16 }), cyl([0, 0, L / 2 + 0.003], (d / 2) * 0.95, 0.006, 'z', HOLE, { segments: 20 })];
  return catalogPart({
    id,
    mpn,
    manufacturer,
    description: `Brass heat-set / knurled threaded insert ${thread} × ${L} mm, OD ${od} mm — install hole Ø${h} mm${note ? ` (${note})` : ''}`,
    category: 'fastener',
    package: `${thread}x${L}`,
    params: { Thread: thread, Length: `${L}mm`, 'Outer diameter': `${od}mm`, 'Install hole': `${h}mm`, 'Min boss OD': `${rnd(od + 2.4, 1)}mm`, Material: 'Brass' },
    offers,
    pins: [],
    massGrams: rnd(vol * DENSITY.brass, 3),
    primitives: prims,
    extra: { fastener, body: { w: od, l: od, h: L } },
  });
}

function inserts(): PartDef[] {
  const generic: [string, number, number, number][] = [
    ['M2', 3, 3.6, 3.2],
    ['M2', 4, 3.6, 3.2],
    ['M2.5', 4, 4.0, 3.6],
    ['M2.5', 5.7, 4.0, 3.6],
    ['M3', 3, 4.6, 4.0],
    ['M3', 4, 4.6, 4.0],
    ['M3', 5.7, 4.6, 4.0],
  ];
  const out = generic.map(([t, L, od, hole]) =>
    insertPart(t, L, od, otherOffer(`Heat-set insert ${t}×${L} OD${od} brass (tapered knurl)`), `fastener:insert-${t.toLowerCase()}x${L}-od${od}`, `Heat-set insert ${t}x${L} OD${od}`, 'Generic', hole, 'tapered heat-set insert for 3D prints / molded bosses'),
  );
  // XHHD straight-knurl brass inserts verified in the JLCPCB catalog: [thread, length, OD, LCSC, model]
  const xhhd: [string, number, number, string, string][] = [
    ['M2', 3, 3.5, 'C51939156', 'SZGZ0102'],
    ['M2', 4, 3.5, 'C51939001', 'SZGZ0104'],
    ['M2', 5, 3.5, 'C51939115', 'SZGZ0105'],
    ['M2.5', 4, 4.0, 'C51939343', 'SZGZ0403'],
    ['M2.5', 5, 4.0, 'C51939234', 'SZGZ0405'],
    ['M2.5', 6, 4.0, 'C51939389', 'SZGZ0407'],
    ['M3', 4, 4.5, 'C51939249', 'SZGZ0702'],
    ['M3', 5, 4.5, 'C51939345', 'SZGZ0703'],
    ['M3', 6, 4.5, 'C51939309', 'SZGZ0704'],
    ['M3', 4, 5.0, 'C51939263', 'SZGZ0803'],
    ['M3', 5, 5.0, 'C51939247', 'SZGZ0805'],
    ['M3', 6, 5.0, 'C51939269', 'SZGZ0807'],
  ];
  for (const [t, L, od, code, model] of xhhd) out.push(insertPart(t, L, od, lcscFastenerOffer(code), code, model, 'XHHD', undefined, 'straight knurl, through thread'));
  return out;
}

function standoffPart(thread: string, L: number, male: number, af: number, round: boolean, offers: DistributorOffer[], id: string, mpn: string, manufacturer: string): PartDef {
  const d = DIA[thread];
  const ends: FastenerSpec['ends'] = male > 0 ? 'male-female' : 'female-female';
  const fastener: FastenerSpec = { type: 'standoff', thread, diameter: d, length: L, outerDiameter: af, holeDiameter: CLEARANCE[thread], materialId: 'brass', ends };
  const body = round ? cyl([0, 0, L / 2], af / 2, L, 'z', BRASS, { metal: true, segments: 20 }) : extrude(hexagon(af), 0, L, BRASS, true);
  const prims: BodyPrimitive[] = [body, cyl([0, 0, L + 0.003], (d / 2) * 0.95, 0.006, 'z', HOLE, { segments: 16 })];
  if (male > 0) prims.push(cyl([0, 0, -male / 2], (d / 2) * 0.94, male, 'z', BRASS, { metal: true, segments: 16 }));
  else prims.push(cyl([0, 0, -0.003], (d / 2) * 0.95, 0.006, 'z', HOLE, { segments: 16 }));
  const area = round ? Math.PI * (af / 2) ** 2 : hexArea(af);
  const vol = (area - Math.PI * (d / 2) ** 2) * L + (male > 0 ? Math.PI * (d / 2) ** 2 * male * 0.85 : 0);
  return catalogPart({
    id,
    mpn,
    manufacturer,
    description: `${round ? 'Round' : 'Hex'} standoff ${thread} ${male > 0 ? 'male-female' : 'female-female'}, ${L} mm${male > 0 ? ` + ${male} mm thread` : ''}, ${round ? `Ø${af}` : `${af} A/F`}, brass`,
    category: 'fastener',
    package: `${thread}x${L}${male > 0 ? `+${male}` : ''}`,
    params: { Thread: thread, Length: `${L}mm`, Ends: ends, [round ? 'Diameter' : 'Width across flats']: `${af}mm`, ...(male > 0 ? { 'Male thread length': `${male}mm` } : {}), Material: 'Brass' },
    offers,
    pins: [],
    massGrams: rnd(vol * DENSITY.brass, 3),
    primitives: prims,
    extra: { fastener, body: { w: af * (round ? 1 : 1.155), l: af, h: L + male } },
  });
}

function standoffs(): PartDef[] {
  const out: PartDef[] = [];
  const LEN = [5, 6, 8, 10, 12, 15, 20];
  // female-female hex: thread → { length: [LCSC, model, A/F] }
  const ff: Record<string, Record<number, [string, string, number]>> = {
    M2: { 5: ['C50377186', 'STTZ2002', 3.0], 6: ['C50377187', 'STTZ2003', 3.0], 8: ['C50377189', 'STTZ2005', 3.0], 10: ['C50377191', 'STTZ2007', 3.0], 12: ['C50377193', 'STTZ2009', 3.0], 15: ['C50377196', 'STTZ2012', 3.0], 20: ['C50377201', 'STTZ2017', 3.0] },
    'M2.5': { 5: ['C50377263', 'STTZ7003', 4.6], 6: ['C50377264', 'STTZ7004', 4.6], 8: ['C50377266', 'STTZ7006', 4.6], 10: ['C50377268', 'STTZ7008', 4.6] },
    M3: { 5: ['C551325', 'M3*5', 4.7], 6: ['C551326', 'M3*6', 4.7], 8: ['C551328', 'M3*8', 4.7], 10: ['C551330', 'M3*10', 4.7], 15: ['C551335', 'M3*15', 4.7], 20: ['C551340', 'M3*20', 4.7] },
  };
  const defaultAf: Record<string, number> = { M2: 4.0, 'M2.5': 5.0, M3: 5.0 };
  for (const t of THREADS) {
    for (const L of LEN) {
      const v = ff[t][L];
      if (v) out.push(standoffPart(t, L, 0, v[2], false, lcscFastenerOffer(v[0]), v[0], v[1], t === 'M3' ? 'Shuntian' : 'XHHD'));
      else out.push(standoffPart(t, L, 0, defaultAf[t], false, otherOffer(`Hex standoff ${t}x${L} F-F brass`), `fastener:standoff-ff-${t.toLowerCase()}x${L}`, `Standoff ${t}x${L} F-F`, 'Generic'));
    }
  }
  // male-female hex (M2.5 / M3, 6 mm male thread)
  const mf: Record<string, Record<number, [string, string, string, number]>> = {
    'M2.5': {
      5: ['C50377845', 'DTTZ4302', 'XHHD', 4.6],
      6: ['C50377846', 'DTTZ4303', 'XHHD', 4.6],
      8: ['C50377848', 'DTTZ4305', 'XHHD', 4.6],
      10: ['C50377850', 'DTTZ4307', 'XHHD', 4.6],
      12: ['C50377852', 'DTTZ4309', 'XHHD', 4.6],
      15: ['C50377855', 'DTTZ4312', 'XHHD', 4.6],
      20: ['C50377860', 'DTTZ4317', 'XHHD', 4.6],
    },
    M3: {
      5: ['C87703', 'Copper pillarsM3*5+6', 'XHHD', 5.0],
      6: ['C357406', 'M3X6+6', 'Shuntian', 5.0],
      8: ['C55118339', 'M3X8+6', 'RYEWARY', 5.0],
      10: ['C551322', 'M3x10+6Cu', 'Shuntian', 5.0],
      15: ['C55118520', 'M3X15+6', 'RYEWARY', 5.0],
      20: ['C357414', 'M3X20+6', 'Shuntian', 5.0],
    },
  };
  for (const t of ['M2.5', 'M3']) {
    for (const L of LEN) {
      const v = mf[t][L];
      if (v) out.push(standoffPart(t, L, 6, v[3], false, lcscFastenerOffer(v[0]), v[0], v[1], v[2]));
      else out.push(standoffPart(t, L, 6, defaultAf[t], false, otherOffer(`Hex standoff ${t}x${L}+6 M-F brass`), `fastener:standoff-mf-${t.toLowerCase()}x${L}`, `Standoff ${t}x${L}+6 M-F`, 'Generic'));
    }
  }
  // M2 male-female round (3 mm male thread), XHHD
  const m2: Record<number, [string, string]> = { 5: ['C50378374', 'DTTZ1004'], 6: ['C50378375', 'DTTZ1005'], 8: ['C50378377', 'DTTZ1007'], 10: ['C193465', 'M2*10+3'], 12: ['C50378381', 'DTTZ1011'], 15: ['C50378384', 'DTTZ1014'], 20: ['C50378389', 'DTTZ1019'] };
  for (const L of LEN) {
    const v = m2[L];
    out.push(standoffPart('M2', L, 3, 3.5, true, lcscFastenerOffer(v[0]), v[0], v[1], 'XHHD'));
  }
  return out;
}

/**
 * Catalog fasteners: ISO 7380 / ISO 14583 / ISO 4762 screws (M2–M3, 4–12 mm), cross-recessed pan
 * head screws with verified LCSC SKUs, thread-forming screws for plastic bosses, ISO 4032 nuts,
 * ISO 7089 washers, brass heat-set inserts and hex / round standoffs (F-F, M-F; 5–20 mm).
 */
export const FASTENERS: PartDef[] = [...screws(), ...tappingScrews(), ...nuts(), ...washers(), ...inserts(), ...standoffs()];
