import type { ConnectorSpec, DistributorOffer, PartDef } from '@pcbcad/core';
import { awgAmpacity, awgDiameterMm, awgOhmPerMeter } from '@pcbcad/core';
import { boxSpan, C, cyl } from '../body/prims';
import { rnd } from '../util/num';
import { catalogPart, lcscOffers, otherOffer } from './common';

/* --------------------------------------------------------------------------------------------- *
 * Wire & cable consumables: UL1007 hook-up wire (sold by length; no verified LCSC spool SKU, so
 * offers are 'Other'), JST PH / XH crimp housings and crimp terminals with LCSC codes verified via
 * the JLCPCB parts search (2026-11-04). XHP-4 natural was not listed; the black variant XHP-4-BK
 * (C493084) is referenced in its params.
 * --------------------------------------------------------------------------------------------- */

const UL1007: Record<number, { od: number; strands: string }> = {
  22: { od: 1.6, strands: '7/0.254 mm (7/30)' },
  24: { od: 1.4, strands: '11/0.16 mm (11/34)' },
  26: { od: 1.3, strands: '7/0.16 mm (7/34)' },
};

function wire(awg: number): PartDef {
  const w = UL1007[awg];
  return catalogPart({
    id: `wire:ul1007-${awg}awg`,
    mpn: `UL1007 ${awg}AWG`,
    manufacturer: 'Generic',
    description: `UL1007 hook-up wire ${awg} AWG, stranded tinned copper, PVC, 300 V / 80 °C (sold per metre)`,
    category: 'wire',
    package: `${awg}AWG`,
    params: {
      Standard: 'UL1007',
      AWG: String(awg),
      Conductor: `Stranded tinned copper ${w.strands}`,
      'Conductor diameter': `${rnd(awgDiameterMm(awg), 3)}mm`,
      'Outer diameter': `${w.od}mm`,
      Insulation: 'PVC',
      'Voltage Rating': '300V',
      'Temperature Rating': '80℃',
      'Resistance (20℃)': `${rnd(awgOhmPerMeter(awg), 4)}Ω/m`,
      'Current Rating (bundle)': `${awgAmpacity(awg)}A`,
      Unit: 'metre',
    },
    offers: otherOffer(`UL1007 ${awg}AWG stranded tinned copper, PVC 300V 80°C`),
    pins: [
      { number: '1', name: 'A', type: 'passive' },
      { number: '2', name: 'B', type: 'passive' },
    ],
    primitives: [cyl([0, 0, 0], w.od / 2, 50, 'x', '#c0392b', { segments: 12 })],
    extra: {
      sim: { kind: 'connector' },
      ratings: { voltage: 300, current: awgAmpacity(awg), tempMax: 80 },
      massGrams: rnd(Math.PI * (awgDiameterMm(awg) / 2) ** 2 * 8.96 + Math.PI * ((w.od / 2) ** 2 - (awgDiameterMm(awg) / 2) ** 2) * 1.35, 2),
    },
  });
}

interface HousingDef {
  series: 'PH' | 'XH';
  n: number;
  code?: string;
  mpn: string;
}

function housing(h: HousingDef): PartDef {
  const pitch = h.series === 'PH' ? 2.0 : 2.5;
  const w = rnd((h.n - 1) * pitch + (h.series === 'PH' ? 2.9 : 3.8), 2);
  const depth = h.series === 'PH' ? 3.2 : 3.9;
  const height = h.series === 'PH' ? 6.0 : 6.8;
  const family = h.series === 'PH' ? 'JST-PH' : 'JST-XH';
  const contact = h.series === 'PH' ? 'SPH-002T-P0.5S' : 'SXH-001T-P0.6';
  const connector: ConnectorSpec = {
    family,
    gender: 'female',
    role: 'cable',
    positions: h.n,
    pitch,
    matesWith: [`${family}:male`, `B${h.n}B-${h.series}`, `S${h.n}B-${h.series}`],
    contactResistance: h.series === 'PH' ? 0.02 : 0.01,
    currentRating: h.series === 'PH' ? 2 : 3,
    voltageRating: h.series === 'PH' ? 100 : 250,
    matingCycles: 30,
    awgRange: h.series === 'PH' ? [24, 32] : [22, 28],
    configuredBy: 'builtin',
  };
  const offers: DistributorOffer[] = h.code ? lcscOffers(h.code, 'extended') : otherOffer(`JST ${h.mpn}`);
  const params: Record<string, string> = { Series: h.series, Pitch: `${pitch}mm`, Positions: String(h.n), Contact: contact, Color: 'Natural', Material: h.series === 'PH' ? 'PA66 UL94V-0' : 'PA6 UL94V-0' };
  if (!h.code && h.series === 'XH' && h.n === 4) params['Alternative (black)'] = 'XHP-4-BK (LCSC C493084)';
  const prims = [boxSpan(-w / 2, w / 2, -depth / 2, depth / 2, 0, height, h.series === 'PH' ? C.jstNatural : C.xhNatural, { radius: 0.15 })];
  for (let i = 0; i < h.n; i++) prims.push(boxSpan(-((h.n - 1) / 2) * pitch + i * pitch - 0.45, -((h.n - 1) / 2) * pitch + i * pitch + 0.45, -0.45, 0.45, height - 0.002, height + 0.004, C.dark));
  return catalogPart({
    id: h.code ?? `connector:jst-${h.mpn.toLowerCase()}`,
    mpn: h.mpn,
    manufacturer: 'JST',
    description: `JST ${h.series} crimp housing ${h.n} positions, ${pitch} mm pitch (use ${contact} terminals)`,
    category: 'connector',
    package: `P=${pitch}mm`,
    params,
    offers,
    pins: Array.from({ length: h.n }, (_, i) => ({ number: String(i + 1), name: String(i + 1), type: 'passive' as const })),
    primitives: prims,
    extra: { connector, sim: { kind: 'connector' }, body: { w, l: depth, h: height } },
  });
}

function contact(series: 'PH' | 'XH', code: string, mpn: string): PartDef {
  const family = series === 'PH' ? 'JST-PH' : 'JST-XH';
  const connector: ConnectorSpec = {
    family,
    gender: 'female',
    role: 'cable',
    positions: 1,
    pitch: series === 'PH' ? 2.0 : 2.5,
    matesWith: [`${family}:male`],
    contactResistance: series === 'PH' ? 0.02 : 0.01,
    currentRating: series === 'PH' ? 2 : 3,
    voltageRating: series === 'PH' ? 100 : 250,
    awgRange: series === 'PH' ? [24, 32] : [22, 28],
    configuredBy: 'builtin',
  };
  return catalogPart({
    id: code,
    mpn,
    manufacturer: 'JST',
    description: `JST ${series} crimp terminal (socket contact), phosphor bronze, tin plated, AWG ${connector.awgRange?.[0]}–${connector.awgRange?.[1]}`,
    category: 'connector',
    package: '-',
    params: { Series: series, 'Wire range': `${connector.awgRange?.[1]}~${connector.awgRange?.[0]} AWG`, Material: 'Phosphor bronze', Plating: 'Tin' },
    offers: lcscOffers(code, 'extended'),
    pins: [{ number: '1', name: '1', type: 'passive' }],
    primitives: [boxSpan(-0.4, 0.4, -4.5, 4.5, 0, 0.8, C.tin, { metal: true })],
    extra: { connector, sim: { kind: 'connector' } },
  });
}

/** Wire, crimp housings and crimp terminals (category 'wire' / 'connector'). */
export const WIRING_PARTS: PartDef[] = [
  wire(22),
  wire(24),
  wire(26),
  housing({ series: 'PH', n: 2, code: 'C157955', mpn: 'PHR-2' }),
  housing({ series: 'PH', n: 3, code: 'C265393', mpn: 'PHR-3' }),
  housing({ series: 'PH', n: 4, code: 'C111514', mpn: 'PHR-4' }),
  housing({ series: 'PH', n: 5, code: 'C157953', mpn: 'PHR-5' }),
  housing({ series: 'PH', n: 6, code: 'C157952', mpn: 'PHR-6' }),
  contact('PH', 'C111515', 'SPH-002T-P0.5S'),
  housing({ series: 'XH', n: 2, code: 'C144401', mpn: 'XHP-2' }),
  housing({ series: 'XH', n: 3, code: 'C144402', mpn: 'XHP-3' }),
  housing({ series: 'XH', n: 4, mpn: 'XHP-4' }),
  housing({ series: 'XH', n: 5, code: 'C144404', mpn: 'XHP-5' }),
  housing({ series: 'XH', n: 6, code: 'C144405', mpn: 'XHP-6' }),
  contact('XH', 'C140573', 'SXH-001T-P0.6'),
];
