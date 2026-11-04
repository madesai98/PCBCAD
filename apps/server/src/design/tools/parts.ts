import type { ConnectorSpec, PackageSpec, PartDef, PartSimModel, PinDef, Project } from '@pcbcad/core';
import { slugify } from '@pcbcad/core';
import { FASTENERS, generateBody, generateFootprint, inferConnectorSpec, inferPinTypes, inferSimModel, inferThermal } from '@pcbcad/parts';
import { unitPrice } from '../bom';
import { fmt, partLabel, pinList, requirePart } from '../helpers';
import { S, ToolError, type ToolContext, type ToolDef } from '../registry';

const FACET_ICON: Record<string, string> = { fetched: '✓ fetched', generated: '◐ generated', agent: '✎ agent', builtin: '✓ builtin', missing: '✗ missing' };

export function describePart(part: PartDef, project?: Project): string {
  const pv = part.provenance;
  const price = unitPrice(part, project?.settings.buildQuantity ?? 100);
  const lines = [
    `${part.id}: ${part.mpn} — ${part.manufacturer} — ${part.package}${part.value ? ` — ${part.value}` : ''} [${part.category}]`,
    part.description ? `  ${part.description}` : '',
    `  Offers: ${part.offers.map((o) => `${o.distributor} ${o.sku}${o.stock != null ? ` stock ${o.stock}` : ''}${o.libraryType ? ` (${o.libraryType})` : ''}`).join('; ') || 'none'}${price.price != null ? `; unit $${price.price.toFixed(4)}` : ''}`,
    `  Facets: specs ${FACET_ICON[pv.specs]}, symbol/pins ${FACET_ICON[pv.symbol]} (${part.pins.length}), footprint ${FACET_ICON[pv.footprint]}${part.footprint ? ` (${part.footprint.name}, ${part.footprint.pads.length} pads)` : ''}, 3D ${FACET_ICON[pv.model3d]}${part.model3d ? ` (${part.model3d.kind})` : ''}, sim ${FACET_ICON[pv.sim]}${part.sim ? ` (${part.sim.kind})` : ''}`,
    part.pins.length ? `  Pins: ${pinList(part)}` : '',
    part.datasheetUrl ? `  Datasheet: ${part.datasheetUrl}` : '',
    part.connector ? `  Connector: ${part.connector.family} ${part.connector.gender} ${part.connector.positions}P, ${part.connector.currentRating} A/contact, mates ${part.connector.matesWith.join('/')}` : '',
    part.fastener ? `  Fastener: ${part.fastener.type} ${part.fastener.thread ?? ''} L${part.fastener.length ?? '-'} hole Ø${part.fastener.holeDiameter ?? '-'}` : '',
    Object.keys(part.params).length
      ? `  Params: ${Object.entries(part.params)
          .slice(0, 20)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ')}`
      : '',
    pv.notes?.length ? `  Notes: ${pv.notes.join(' | ')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Add (or refresh) a part in the project library; stores 3D mesh assets. */
export async function importIntoProject(ctx: ToolContext, id: string, refresh = false): Promise<{ part: PartDef; text: string }> {
  const r = await ctx.services.parts.import(id, { refresh });
  const part = r.part;
  for (const m of r.meshes) ctx.services.store.putAsset(ctx.session.id, m.assetId, JSON.stringify(m.mesh));
  ctx.session.mutate(ctx, 'import_part', (p) => {
    p.parts[part.id] = part;
    return `Imported ${partLabel(part)}`;
  });
  const needs = r.needsAgent.length ? `\nNeeds agent input:\n${r.needsAgent.map((n) => `- ${n.facet}: ${n.hint}`).join('\n')}\n(Fix with define_part.)` : '';
  const log = r.log.length ? `\nPipeline log: ${r.log.slice(-6).join(' | ')}` : '';
  return { part, text: `${describePart(part, ctx.session.project)}${needs}${r.fromCache ? '\n(from local parts cache)' : ''}${log}` };
}

/** Ensure a part id (LCSC code, MPN or catalog id) is in the project, importing it if necessary. */
export async function ensurePart(ctx: ToolContext, id: string): Promise<PartDef> {
  const p = ctx.session.project;
  const existing = p.parts[id] ?? Object.values(p.parts).find((x) => x.mpn.toLowerCase() === id.toLowerCase() || x.offers.some((o) => o.sku === id));
  if (existing) return existing;
  const catalog = FASTENERS.find((f) => f.id === id || f.mpn === id);
  if (catalog) {
    ctx.session.mutate(ctx, 'import_part', (pr) => {
      pr.parts[catalog.id] = structuredClone(catalog);
      return `Added ${catalog.mpn} from fastener catalog`;
    });
    return ctx.session.project.parts[catalog.id];
  }
  return (await importIntoProject(ctx, id)).part;
}

function normalisePins(pins: Partial<PinDef>[], category: PartDef['category']): PinDef[] {
  const base = pins.map((p, i) => ({
    number: String(p.number ?? i + 1),
    name: String(p.name ?? p.number ?? i + 1),
    type: (p.type ?? 'unspecified') as PinDef['type'],
    functions: p.functions,
    side: p.side,
  }));
  return inferPinTypes(base, category).map((p, i) => (pins[i]?.type ? { ...p, type: pins[i].type! } : p));
}

export const partTools: ToolDef[] = [
  {
    name: 'search_parts',
    title: 'Search distributor parts',
    group: 'parts',
    description:
      'Search real distributor inventory (JLCPCB/LCSC; Mouser too when an API key is configured). Returns LCSC codes, MPNs, packages, stock, price and key attributes. Prefer in-stock JLCPCB "basic" parts for passives (no assembly setup fee). Use specific queries, e.g. "AMS1117-3.3", "0805 10k 1%", "USB-C 16P receptacle", "JST PH 4P SMD right angle".',
    inputSchema: S.obj({ query: S.str('Keyword / MPN / description'), limit: S.int('Max results (default 10, max 30)'), inStockOnly: S.bool('Only parts with stock (default true)') }, ['query']),
    handler: async (ctx, a: { query: string; limit?: number; inStockOnly?: boolean }) => {
      const hits = await ctx.services.parts.search(a.query, { limit: Math.min(30, a.limit ?? 10), inStockOnly: a.inStockOnly ?? true });
      if (!hits.length) return `No results for "${a.query}". Try a broader query or the bare MPN.`;
      const qty = ctx.session.project.settings.buildQuantity;
      const lines = hits.map((h) => {
        const breaks = [...h.priceBreaks].sort((x, y) => x.qty - y.qty);
        let price = breaks[0]?.price;
        for (const b of breaks) if (qty >= b.qty) price = b.price;
        const attrs = Object.entries(h.attributes)
          .slice(0, 6)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ');
        return `${h.lcsc || h.url || '-'} | ${h.mpn} | ${h.manufacturer} | ${h.package} | stock ${h.stock}${h.libraryType ? ` | ${h.libraryType}` : ''}${price != null ? ` | $${price.toFixed(4)}@${qty}` : ''} | ${h.description}${attrs ? ` | ${attrs}` : ''}`;
      });
      return { text: `${hits.length} result(s) for "${a.query}":\nLCSC | MPN | Manufacturer | Package | Stock | Library | Price | Description | Attributes\n${lines.join('\n')}`, data: hits };
    },
  },
  {
    name: 'import_part',
    title: 'Import part',
    group: 'parts',
    description:
      'Import a real part into the project library by LCSC code (e.g. "C14877") or exact MPN. Deterministically fetches specs, price/stock, datasheet, pinout, footprint and 3D model (JLCPCB/LCSC + EasyEDA library) and infers a simulation model, thermal data and connector spec. Reports any facet that needs your input (fix those with define_part).',
    inputSchema: S.obj({ id: S.str('LCSC code (C-number) or MPN'), refresh: S.bool('Bypass the local cache') }, ['id']),
    handler: async (ctx, a: { id: string; refresh?: boolean }) => {
      const { part, text } = await importIntoProject(ctx, a.id, a.refresh);
      return { text, data: { partId: part.id } };
    },
  },
  {
    name: 'get_part',
    title: 'Part details',
    group: 'parts',
    description: 'Full details for a part in the project library: pins, parameters, offers, facet provenance, sim model, connector/fastener spec.',
    inputSchema: S.obj({ partId: S.str() }, ['partId']),
    handler: (ctx, a: { partId: string }) => {
      const part = requirePart(ctx.session.project, a.partId);
      const extra = [
        part.sim ? `  Sim model: ${JSON.stringify(part.sim)}` : '  Sim model: none',
        part.thermal ? `  Thermal: ${JSON.stringify(part.thermal)}` : '',
        part.body ? `  Body: ${part.body.w}×${part.body.l}×${part.body.h} mm` : '',
        part.footprint ? `  Footprint pads: ${part.footprint.pads.map((pd) => `${pd.number}@(${pd.x.toFixed(2)},${pd.y.toFixed(2)}) ${pd.w.toFixed(2)}×${pd.h.toFixed(2)} ${pd.kind}`).slice(0, 40).join('; ')}` : '',
      ];
      return [describePart(part, ctx.session.project), ...extra].filter(Boolean).join('\n');
    },
  },
  {
    name: 'define_part',
    title: 'Define / patch part',
    group: 'parts',
    description:
      'Create a custom part or patch facets of an existing one when the deterministic import could not determine them (LLM fallback, e.g. from the datasheet). Provide pins, and either packageSpec (parametric footprint + 3D body are generated) or an explicit footprint. Can also set sim model, thermal data, ratings, connector/fastener spec and distributor offers. Fields you pass replace the existing ones; provenance is marked "agent".',
    inputSchema: S.obj(
      {
        id: S.str('Existing part id to patch, or new id (default custom:<mpn>)'),
        mpn: S.str(),
        manufacturer: S.str(),
        description: S.str(),
        category: S.str('PartCategory, e.g. resistor, capacitor, led, ldo, mcu, ic, sensor, connector, crystal, switch, module, fastener'),
        package: S.str(),
        value: S.str(),
        pins: S.arr(S.obj({ number: S.str(), name: S.str(), type: S.str('input|output|bidirectional|passive|power_in|power_out|open_collector|nc|...'), functions: S.arr(S.str()) }, ['number', 'name'])),
        packageSpec: S.obj(
          {
            family: S.str('chip|sot23|sot223|sot89|soic|ssop|tssop|msop|qfn|dfn|qfp|lga|bga|dip|to92|to220|header|jst-ph|jst-xh|jst-sh|usb-c|crystal-smd|hc49|electrolytic-smd|inductor-smd|tactile-switch|led-tht|terminal-block|battery-holder|module|...'),
            pins: S.int(),
            pitch: S.num(),
            bodyW: S.num(),
            bodyL: S.num(),
            bodyH: S.num(),
            leadSpan: S.num(),
            padW: S.num(),
            padH: S.num(),
            rows: S.int(),
            exposedPad: S.obj({ w: S.num(), h: S.num() }),
            size: S.str("chip size code '0402'...'2512'"),
          },
          ['family'],
        ),
        footprint: S.any('Explicit FootprintDef (pads in mm, Y up) — alternative to packageSpec'),
        sim: S.any('PartSimModel, e.g. {"kind":"ldo","in":"3","out":"2","gnd":"1","Vout":3.3,"dropout":1.1,"Iq":0.005}'),
        thermal: S.obj({ thetaJA: S.num(), thetaJC: S.num(), tjMax: S.num() }),
        ratings: S.obj({ voltage: S.num(), current: S.num(), power: S.num(), tempMin: S.num(), tempMax: S.num() }),
        offers: S.arr(S.obj({ distributor: S.str(), sku: S.str(), url: S.str(), stock: S.int(), priceBreaks: S.arr(S.obj({ qty: S.int(), price: S.num() })) }, ['distributor', 'sku'])),
        datasheetUrl: S.str(),
        connector: S.any('ConnectorSpec (see configure_connector)'),
        fastener: S.any('FastenerSpec'),
        massGrams: S.num(),
        body: S.obj({ w: S.num(), l: S.num(), h: S.num() }),
        params: S.any('Additional parameters {name: value}'),
      },
      [],
    ),
    handler: (ctx, a: Record<string, any>) => {
      const p = ctx.session.project;
      const id: string = a.id ?? (a.mpn ? `custom:${slugify(a.mpn)}` : '');
      if (!id) throw new ToolError('Provide id (to patch) or mpn (to create).');
      const existing = p.parts[id];
      if (!existing && !a.mpn) throw new ToolError(`Part ${id} does not exist; provide mpn to create it.`);
      const part: PartDef = existing
        ? structuredClone(existing)
        : {
            id,
            mpn: a.mpn,
            manufacturer: a.manufacturer ?? 'Unknown',
            description: a.description ?? '',
            category: a.category ?? 'other',
            package: a.package ?? a.packageSpec?.family ?? 'custom',
            params: {},
            offers: [],
            pins: [],
            provenance: { specs: 'agent', symbol: 'missing', footprint: 'missing', model3d: 'missing', sim: 'missing', source: 'agent-defined' },
          };
      const notes: string[] = [];
      for (const k of ['mpn', 'manufacturer', 'description', 'category', 'package', 'value', 'datasheetUrl', 'massGrams', 'body', 'ratings'] as const) {
        if (a[k] !== undefined) (part as any)[k] = a[k];
      }
      if (a.params) part.params = { ...part.params, ...a.params };
      if (a.offers) {
        part.offers = a.offers;
        part.provenance.specs = 'agent';
      }
      if (a.pins) {
        part.pins = normalisePins(a.pins, part.category);
        part.provenance.symbol = 'agent';
      }
      if (a.packageSpec) {
        const spec = a.packageSpec as PackageSpec;
        part.packageSpec = spec;
        part.footprint = generateFootprint(spec);
        part.footprint.source = 'generated';
        part.model3d = { kind: 'primitives', primitives: generateBody(spec, { category: part.category }), source: 'generated' };
        part.provenance.footprint = 'generated';
        part.provenance.model3d = 'generated';
        const fp = part.footprint;
        part.body ??= { w: spec.bodyW ?? fp.courtyard.maxX - fp.courtyard.minX, l: spec.bodyL ?? fp.courtyard.maxY - fp.courtyard.minY, h: spec.bodyH ?? 1 };
      }
      if (a.footprint) {
        part.footprint = { graphics: [], courtyard: bboxOfPads(a.footprint.pads ?? []), name: part.package, ...a.footprint, source: 'agent' };
        part.provenance.footprint = 'agent';
      }
      if (a.sim) {
        part.sim = a.sim as PartSimModel;
        part.provenance.sim = 'agent';
      } else if (!part.sim) {
        const inferred = inferSimModel(part);
        if (inferred) {
          part.sim = inferred;
          part.provenance.sim = 'generated';
        }
      }
      if (a.thermal) part.thermal = { ...part.thermal, ...a.thermal };
      else part.thermal ??= inferThermal(part);
      if (a.connector) part.connector = { ...(a.connector as ConnectorSpec), configuredBy: 'agent' };
      else if (part.category === 'connector' && !part.connector) part.connector = inferConnectorSpec(part);
      if (a.fastener) part.fastener = a.fastener;
      // consistency check
      if (part.footprint && part.pins.length) {
        const padNums = new Set(part.footprint.pads.map((x) => x.number));
        const pinNums = new Set(part.pins.map((x) => x.number));
        const noPad = [...pinNums].filter((n) => !padNums.has(n));
        const noPin = [...padNums].filter((n) => !pinNums.has(n));
        if (noPad.length) notes.push(`pins without pads: ${noPad.join(', ')}`);
        if (noPin.length) notes.push(`pads without pins (ok for mounting tabs/EP if intended): ${noPin.join(', ')}`);
      }
      part.provenance.notes = [...(part.provenance.notes ?? []).filter((n) => !n.startsWith('Consistency:')), ...(notes.length ? [`Consistency: ${notes.join('; ')}`] : [])];
      ctx.session.mutate(ctx, 'define_part', (pr) => {
        pr.parts[part.id] = part;
        return `${existing ? 'Updated' : 'Defined'} part ${partLabel(part)}`;
      });
      return `${existing ? 'Updated' : 'Created'} part.\n${describePart(part, p)}${notes.length ? `\n⚠ ${notes.join('; ')}` : ''}`;
    },
  },
  {
    name: 'configure_connector',
    title: 'Configure functional connector',
    group: 'parts',
    description:
      'Make a distributor connector part functional for multi-board design: mating family/gender, positions, contact resistance and current rating, pin mapping to its mate, enclosure opening size and mating direction. Required before connect_boards can validate/simulate the interconnect.',
    inputSchema: S.obj(
      {
        partId: S.str(),
        family: S.str("Series, e.g. 'JST-PH', 'JST-XH', 'USB-C', 'Header-2.54'"),
        gender: S.enum(['male', 'female', 'genderless']),
        role: S.enum(['board', 'cable', 'panel']),
        positions: S.int(),
        pitch: S.num(),
        matesWith: S.arr(S.str(), 'Families (optionally "family:gender") or part ids it mates with'),
        contactResistance: S.num('Ω per mated contact'),
        currentRating: S.num('A per contact'),
        voltageRating: S.num(),
        pinMap: S.any('{"1":"1",...} this pin → mate pin (default identity)'),
        matingDirection: S.enum(['+x', '-x', '+y', '-y', '+z']),
        opening: S.obj({ width: S.num(), height: S.num(), zCenter: S.num() }, ['width', 'height', 'zCenter']),
      },
      ['partId', 'family', 'gender', 'positions', 'matesWith', 'contactResistance', 'currentRating'],
    ),
    handler: (ctx, a: any) => {
      const part = requirePart(ctx.session.project, a.partId);
      const spec: ConnectorSpec = {
        family: a.family,
        gender: a.gender,
        role: a.role ?? 'board',
        positions: a.positions,
        pitch: a.pitch,
        matesWith: a.matesWith,
        contactResistance: a.contactResistance,
        currentRating: a.currentRating,
        voltageRating: a.voltageRating,
        pinMap: a.pinMap,
        matingDirection: a.matingDirection,
        opening: a.opening,
        configuredBy: ctx.actor === 'user' ? 'user' : 'agent',
      };
      ctx.session.mutate(ctx, 'configure_connector', (p) => {
        const pt = p.parts[part.id];
        pt.connector = spec;
        if (!pt.sim) pt.sim = { kind: 'connector' };
        return `Configured ${pt.mpn} as ${spec.family} ${spec.gender} ${spec.positions}P connector`;
      });
      return `Connector configured: ${part.mpn} → ${spec.family} ${spec.gender} ${spec.positions}P, ${spec.currentRating} A/contact, ${spec.contactResistance} Ω, mates ${spec.matesWith.join('/')}.`;
    },
  },
  {
    name: 'list_fasteners',
    title: 'Fastener catalog',
    group: 'parts',
    description: 'List catalog fasteners (screws, thread-forming screws for plastic bosses, nuts, heat-set inserts, standoffs, washers) with specs and distributor SKUs. Use the ids with add_fastener / create_enclosure.',
    inputSchema: S.obj({ type: S.str('screw|self-tapping-screw|nut|washer|standoff|heat-set-insert|pem-nut|pem-standoff'), thread: S.str('e.g. M2.5') }),
    handler: (_ctx, a: { type?: string; thread?: string }) => {
      const list = FASTENERS.filter((f) => (!a.type || f.fastener?.type === a.type) && (!a.thread || f.fastener?.thread?.toLowerCase() === a.thread.toLowerCase()));
      if (!list.length) return 'No matching fasteners.';
      return list
        .map((f) => {
          const s = f.fastener!;
          return `${f.id} | ${f.mpn} | ${s.type} ${s.thread ?? ''} ${s.length ? `L${s.length}` : ''} ${s.head ?? ''} | hole Ø${s.holeDiameter ?? '-'} | ${s.materialId} | ${f.offers.map((o) => `${o.distributor} ${o.sku}`).join(', ')}`;
        })
        .join('\n');
    },
  },
];

function bboxOfPads(pads: { x: number; y: number; w: number; h: number }[]) {
  if (!pads.length) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pads) {
    const r = Math.max(p.w, p.h) / 2;
    minX = Math.min(minX, p.x - r);
    maxX = Math.max(maxX, p.x + r);
    minY = Math.min(minY, p.y - r);
    maxY = Math.max(maxY, p.y + r);
  }
  return { minX: minX - 0.25, minY: minY - 0.25, maxX: maxX + 0.25, maxY: maxY + 0.25 };
}

export { fmt };
