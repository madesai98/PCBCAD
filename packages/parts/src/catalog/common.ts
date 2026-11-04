import type { BodyPrimitive, DistributorOffer, PackageSpec, PartCategory, PartDef, PinDef, PinType } from '@pcbcad/core';
import { generateBody } from '../body/generate';
import { generateFootprint } from '../footprint/generate';
import { completeSpec } from '../package/defaults';
import { lcscProductUrl } from '../sources/lcsc';

/** Offer pair for a part verified in the JLCPCB assembly catalog (prices omitted: fetched live by importPart). */
export function lcscOffers(code: string, libraryType: DistributorOffer['libraryType'] = 'extended'): DistributorOffer[] {
  return [
    { distributor: 'LCSC', sku: code, url: lcscProductUrl(code), currency: 'USD' },
    { distributor: 'JLCPCB', sku: code, url: `https://jlcpcb.com/partdetail/${code}`, currency: 'USD', libraryType },
  ];
}

/** Offer for a standard item without a verified distributor SKU. */
export function otherOffer(designation: string): DistributorOffer[] {
  return [{ distributor: 'Other', sku: designation }];
}

/** Pins from a compact list: [number, name, type?]. */
export function pinList(rows: [string, string, PinType?][], defaultType: PinType = 'passive'): PinDef[] {
  return rows.map(([number, name, type]) => ({ number, name, type: type ?? defaultType }));
}

export interface CatalogPartInput {
  id: string;
  mpn: string;
  manufacturer: string;
  description: string;
  category: PartCategory;
  package: string;
  value?: string;
  params?: Record<string, string>;
  offers: DistributorOffer[];
  pins: PinDef[];
  spec?: PackageSpec;
  bodyColor?: string;
  datasheetUrl?: string;
  massGrams?: number;
  notes?: string[];
  extra?: Partial<PartDef>;
  /** Custom primitives (fasteners, cables) instead of a generated body. */
  primitives?: BodyPrimitive[];
}

/** Assemble a fully specified builtin PartDef (generated footprint + body from the package spec). */
export function catalogPart(inp: CatalogPartInput): PartDef {
  const part: PartDef = {
    id: inp.id,
    mpn: inp.mpn,
    manufacturer: inp.manufacturer,
    description: inp.description,
    category: inp.category,
    package: inp.package,
    params: inp.params ?? {},
    offers: inp.offers,
    pins: inp.pins,
    provenance: {
      specs: 'builtin',
      symbol: inp.pins.length ? 'builtin' : 'missing',
      footprint: inp.spec ? 'builtin' : 'missing',
      model3d: inp.spec || inp.primitives ? 'builtin' : 'missing',
      sim: 'missing',
      source: 'builtin',
    },
  };
  if (inp.value) part.value = inp.value;
  if (inp.datasheetUrl) part.datasheetUrl = inp.datasheetUrl;
  if (inp.massGrams !== undefined) part.massGrams = inp.massGrams;
  if (inp.notes?.length) part.provenance.notes = inp.notes;
  if (inp.spec) {
    const spec = completeSpec(inp.spec);
    part.packageSpec = spec;
    part.footprint = generateFootprint(spec);
    part.model3d = { kind: 'primitives', primitives: inp.primitives ?? generateBody(spec, { category: inp.category, color: inp.bodyColor }), source: 'builtin' };
    part.body = { w: spec.bodyW ?? 1, l: spec.bodyL ?? 1, h: spec.bodyH ?? 1 };
  } else if (inp.primitives) {
    part.model3d = { kind: 'primitives', primitives: inp.primitives, source: 'builtin' };
  }
  Object.assign(part, inp.extra ?? {});
  if (part.sim) part.provenance.sim = 'builtin';
  return part;
}
