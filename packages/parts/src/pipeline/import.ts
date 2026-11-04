import type { DistributorOffer, FootprintDef, MeshData, PackageSpec, PartCategory, PartDef, PinDef } from '@pcbcad/core';
import { slugify } from '@pcbcad/core';
import { generateBody } from '../body/generate';
import { alignmentTurn, rotatePrimitivesZ } from '../body/transform';
import { generateFootprint } from '../footprint/generate';
import { categorize } from '../infer/categorize';
import { inferConnectorSpec } from '../infer/connector';
import { findParam, paramNumber, paramText, parseQuantity, parseTempRange } from '../infer/params';
import { cleanPinName, inferPinTypes, pinTokens } from '../infer/pins';
import { iccFromParams, inferSimModel } from '../infer/sim';
import { inferThermal } from '../infer/thermal';
import { parsePackageName } from '../package/parse';
import { convertEasyEdaComponent, EASYEDA_ATTRIBUTION, easyedaComponentUrl, easyedaObjUrl, easyedaStepUrl } from '../sources/easyeda';
import { isJlcPlaceholder, jlcSearch, type JlcSearchResult } from '../sources/jlc';
import { fetchLcscDetail } from '../sources/lcsc';
import { parseEasyEdaObj } from '../sources/obj';
import type { EasyEdaConversion, ImportPartOptions, NeedsAgentHint, PartImportResult, PartSearchHit } from '../types';
import { DEFAULT_TIMEOUT_MS, httpJson, httpRequest } from '../util/fetch';
import { getPath, isRecord } from '../util/json';
import { isLcscCode, lcscCode } from '../util/text';
import { ALL_CATALOG_PARTS, findCatalogPart } from './catalog';
import { matchScore } from './search';

/* --------------------------------------------------------------------------------------------- *
 * Deterministic part import: JLCPCB search (basics, price breaks, stock, library type) + LCSC
 * detail (parameters, datasheet, images, weight) + EasyEDA library (pins, footprint, 3D model)
 * → complete PartDef with per-facet provenance, inferred sim / connector / thermal data, and
 * precise needsAgent hints for whatever could not be determined.
 * --------------------------------------------------------------------------------------------- */

const LIB_RANK: Record<string, number> = { basic: 3, preferred: 2, extended: 1 };

/** Best search hit for an MPN query: exact (then suffix-less, then prefix) MPN match, in stock, basic library. */
export function pickBestHit(hits: PartSearchHit[], query: string): PartSearchHit | undefined {
  const cands = hits.filter((h) => !isJlcPlaceholder(h)).map((h) => ({ h, m: matchScore(h, query) }));
  const best = cands.filter((c) => c.m > 0);
  if (!best.length) return undefined;
  best.sort((a, b) => b.m - a.m || (b.h.stock > 0 ? 1 : 0) - (a.h.stock > 0 ? 1 : 0) || (LIB_RANK[b.h.libraryType ?? ''] ?? 0) - (LIB_RANK[a.h.libraryType ?? ''] ?? 0) || b.h.stock - a.h.stock);
  return best[0].h;
}

/** Passive value string from distributor parameters ('10kΩ' → '10k', '100nF', '4.7uH', '16MHz'). */
export function valueFromParams(category: PartCategory, params: Record<string, string>): string | undefined {
  const first = (s: string | undefined) => s?.split(/[@\s,;(]/)[0]?.replace(/^±/, '');
  switch (category) {
    case 'resistor': {
      const r = first(paramText(params, /^resistance/i));
      return r ? r.replace(/\s*(Ω|Ω|ohms?)$/i, '') : undefined;
    }
    case 'capacitor':
    case 'capacitor-polarized':
      return first(paramText(params, /^capacitance/i));
    case 'inductor':
      return first(paramText(params, /^inductance/i));
    case 'ferrite':
      return first(paramText(params, /impedance/i));
    case 'crystal':
    case 'oscillator':
      return first(paramText(params, /^frequency/i));
    case 'ldo':
    case 'dc-dc': {
      const v = paramText(params, /^output voltage/i);
      return v && !/~|adj/i.test(v) ? first(v) : undefined;
    }
    default:
      return undefined;
  }
}

/** Ratings (V, A, W, °C) from distributor parameters. */
export function ratingsFromParams(params: Record<string, string>): PartDef['ratings'] | undefined {
  const r: NonNullable<PartDef['ratings']> = {};
  const v = paramNumber(params, [/^voltage rating/i, /drain to source voltage|drain-source voltage|^vds\b/i, /voltage - dc reverse|reverse voltage|^vr\b/i, /voltage-supply\(max\)|voltage - supply \(max\)/i, /^voltage - supply/i, /^rated voltage/i], 'max');
  if (v !== undefined) r.voltage = v;
  const i = paramNumber(params, [/current - continuous drain|^id\b/i, /current - rectified|forward current/i, /^output current/i, /^current rating|rated current|contact current/i], 'first');
  if (i !== undefined) r.current = i;
  const pw = findParam(params, /^power$|^power\s*\((watts|w)\)|^pd - power dissipation|^power dissipation|^rated power|^power rating/i);
  const p = pw && /\d\s*[mµu]?W\b/i.test(pw.value) ? parseQuantity(pw.value, 'max') : undefined;
  if (p !== undefined) r.power = p;
  const t = parseTempRange(paramText(params, /^operating temperature/i, /operating junction temperature/i));
  if (t) {
    r.tempMin = t[0];
    r.tempMax = t[1];
  }
  return Object.keys(r).length ? r : undefined;
}

function uniquePadPins(fp: FootprintDef): PinDef[] {
  const nums = [...new Set(fp.pads.map((p) => p.number).filter((n) => n !== ''))];
  nums.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return nums.map((n) => ({ number: n, name: n, type: 'unspecified' }));
}

const TRIVIAL_PINS: PartCategory[] = ['resistor', 'capacitor', 'inductor', 'ferrite', 'fuse', 'connector', 'cable', 'wire', 'testpoint', 'switch', 'button', 'crystal', 'mechanical', 'fastener'];
const NO_SIM_NEEDED: PartCategory[] = ['fastener', 'mechanical', 'antenna', 'display', 'other'];

/** Overlay curated builtin knowledge (sim, thermal, connector ratings) when it is consistent with the imported pins. */
function overlayBuiltin(part: PartDef, b: PartDef, log: string[]): void {
  if (b.thermal) part.thermal = { ...b.thermal };
  const sameNames = part.pins.length > 0 && part.pins.every((ip) => {
    const bp = b.pins.find((p) => p.number === ip.number);
    return bp && pinNamesCompatible(ip.name, bp.name);
  });
  if (sameNames) {
    part.pins = part.pins.map((ip) => {
      const bp = b.pins.find((p) => p.number === ip.number) as PinDef;
      const out: PinDef = { ...ip, type: bp.type };
      if (bp.functions) out.functions = [...bp.functions];
      return out;
    });
    log.push('Pin types: curated builtin pin table applied');
  }
  if (b.sim) {
    const refs = simPinRefs(b.sim);
    const ok = refs.every((n) => {
      const ip = part.pins.find((p) => p.number === n);
      const bp = b.pins.find((p) => p.number === n);
      return ip && bp && pinNamesCompatible(ip.name, bp.name);
    });
    if (ok) {
      part.sim = structuredClone(b.sim);
      part.provenance.sim = 'builtin';
      log.push('Sim model: curated builtin model applied');
    } else log.push('Sim model: builtin model not applied (pin naming differs from the library symbol)');
  }
  if (b.connector && part.connector) {
    const { matingDirection, opening } = part.connector;
    part.connector = { ...b.connector, matingDirection: matingDirection ?? b.connector.matingDirection, opening: opening ?? b.connector.opening };
  }
}

/** Same pin when the cleaned names match or one name's tokens are contained in the other's ('PD3' ~ '(PCINT19/OC2B/INT1)PD3'). */
export function pinNamesCompatible(a: string, b: string): boolean {
  if (cleanPinName(a) === cleanPinName(b)) return true;
  const ta = new Set(pinTokens(a));
  const tb = pinTokens(b);
  if (!tb.length || !ta.size) return false;
  const ua = [...ta];
  return tb.every((t) => ta.has(t)) || ua.every((t) => tb.includes(t));
}

function simPinRefs(sim: NonNullable<PartDef['sim']>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(sim)) {
    if (k === 'kind' || k === 'emulator' || k === 'color' || k === 'behaviorId' || k === 'firmwareId') continue;
    if (typeof v === 'string') {
      out.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) if (typeof x === 'string') out.push(x);
    } else if (k === 'pinMap' && isRecord(v)) {
      for (const x of Object.values(v)) if (typeof x === 'string') out.push(x);
    }
  }
  return [...new Set(out)];
}

function clonePart(p: PartDef): PartDef {
  return structuredClone(p);
}

function catalogResult(p: PartDef, log: string[]): PartImportResult {
  return { part: clonePart(p), meshes: [], log, needsAgent: [] };
}

function stubPart(q: string, code: string | undefined, log: string[], reason: string): PartImportResult {
  const id = code ?? `custom:${slugify(q)}`;
  const part: PartDef = {
    id,
    mpn: q,
    manufacturer: 'Unknown',
    description: '',
    category: 'other',
    package: '',
    params: {},
    offers: [],
    pins: [],
    provenance: { specs: 'missing', symbol: 'missing', footprint: 'missing', model3d: 'missing', sim: 'missing', source: 'not found', notes: [reason] },
  };
  log.push(reason);
  return {
    part,
    meshes: [],
    log,
    needsAgent: [
      { facet: 'specs', hint: `${reason} Search with search_parts and import an LCSC code, or define the part (mpn, manufacturer, category, package, params) from its datasheet.` },
      { facet: 'pins', hint: 'Provide every pin (number as printed on the footprint, name, electrical type) from the datasheet pin table.' },
      { facet: 'footprint', hint: 'Provide a packageSpec (family + dimensions from the datasheet package drawing) or an explicit footprint.' },
      { facet: 'model3d', hint: 'A parametric body is generated automatically once packageSpec is known.' },
      { facet: 'sim', hint: 'Provide a PartSimModel (e.g. {kind:"ic", supplyPins, groundPins, Icc}).' },
    ],
  };
}

/**
 * Import a part by LCSC code (e.g. 'C2040') or MPN. Each request uses `timeoutMs` (default 15 s);
 * a failing source only degrades its facets. Throws only when no source is reachable at all and no
 * offline catalog entry matches (so callers can retry instead of caching an empty part).
 */
export async function importPart(idOrMpn: string, opts: ImportPartOptions = {}): Promise<PartImportResult> {
  const q = (idOrMpn ?? '').trim();
  if (!q) throw new Error('importPart: empty part id');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetch;
  const with3d = opts.with3d !== false;
  const log: string[] = [];
  const needs: NeedsAgentHint[] = [];
  const t0 = Date.now();

  // catalog ids (fastener:…, wire:…, connector:…, custom:…) never hit the network
  if (q.includes(':')) {
    const c = findCatalogPart(q);
    if (c) return catalogResult(c, [`Catalog part ${c.id} (${c.mpn}).`]);
  }

  /* ------------------------------------------------------------------------- resolve LCSC code */
  let code: string | undefined;
  let jlc: JlcSearchResult | undefined;
  let anyResponse = false;
  const errors: string[] = [];
  if (isLcscCode(q)) code = lcscCode(q);
  else {
    const s = await jlcSearch(q, { pageSize: 30, fetch: fetchImpl, timeoutMs });
    if (s.ok) {
      anyResponse = true;
      const best = pickBestHit(s.hits, q);
      if (best) {
        code = best.lcsc;
        jlc = { ...s, hits: [best] };
        log.push(`Resolved "${q}" → ${best.lcsc} (${best.mpn}, ${best.manufacturer}, stock ${best.stock}${best.libraryType ? `, ${best.libraryType}` : ''})`);
      }
    } else errors.push(`JLCPCB search: ${s.error}`);
    if (!code) {
      const c = findCatalogPart(q);
      if (c) return catalogResult(c, [...log, ...errors, `Using offline catalog entry ${c.id} for "${q}".`]);
      if (!anyResponse) throw new Error(`Part import failed for "${q}": distributor search unreachable (${errors.join('; ')})`);
      return stubPart(q, undefined, log, `No JLCPCB/LCSC part matches MPN "${q}".`);
    }
  }

  // catalog consumables (fasteners, wiring): keep the curated spec, refresh offers
  const catalog = findCatalogPart(code);
  const isConsumable = catalog && (catalog.category === 'fastener' || catalog.category === 'wire' || (catalog.category === 'connector' && catalog.connector?.role === 'cable'));

  /* ----------------------------------------------------------------------- fetch all sources */
  const [jlcRes, lcscRes, eeRes] = await Promise.all([
    jlc ? Promise.resolve(jlc) : jlcSearch(code, { pageSize: 10, fetch: fetchImpl, timeoutMs }),
    fetchLcscDetail(code, { fetch: fetchImpl, timeoutMs }),
    isConsumable ? Promise.resolve(undefined) : httpJson(easyedaComponentUrl(code), { fetch: fetchImpl, timeoutMs, headers: { Accept: 'application/json' } }),
  ]);
  const jlcHit = jlcRes.ok ? jlcRes.hits.find((h) => h.lcsc === code) : undefined;
  if (jlcRes.ok) anyResponse = true;
  else errors.push(`JLCPCB search: ${jlcRes.error}`);
  const lp = lcscRes.ok ? lcscRes.part : undefined;
  if (lcscRes.ok) anyResponse = true;
  else errors.push(`LCSC detail: ${lcscRes.error}`);
  let ee: EasyEdaConversion | undefined;
  if (eeRes) {
    if (eeRes.ok) {
      anyResponse = true;
      if (getPath(eeRes.json, 'success') !== false && isRecord(getPath(eeRes.json, 'result'))) ee = convertEasyEdaComponent(eeRes.json);
      else log.push('EasyEDA: no library component for this code');
    } else errors.push(`EasyEDA: ${eeRes.error}`);
  }
  log.push(`Sources: JLCPCB ${jlcHit ? 'ok' : jlcRes.ok ? 'not listed' : 'failed'}, LCSC ${lp ? 'ok' : lcscRes.ok ? 'not listed' : 'failed'}, EasyEDA ${ee ? 'ok' : isConsumable ? 'skipped' : eeRes?.ok ? 'not listed' : 'failed'}`);
  for (const e of errors) log.push(e);

  if (isConsumable && catalog) {
    const part = clonePart(catalog);
    refreshOffers(part, code, jlcHit, lp);
    part.provenance.fetchedAt = new Date().toISOString();
    log.push(`Catalog ${catalog.category} ${catalog.id}: curated spec kept, offers refreshed`);
    return { part, meshes: [], log, needsAgent: [] };
  }

  const eeUsable = !!ee && (ee.pins.length > 0 || ee.footprint.pads.length > 0);
  if (!jlcHit && !lp && !eeUsable) {
    const b = findCatalogPart(code);
    if (b) return catalogResult(b, [...log, `Using offline catalog entry ${b.id}.`]);
    if (!anyResponse) throw new Error(`Part import failed for ${code}: no source reachable (${errors.join('; ')})`);
    return stubPart(q, code, log, `LCSC code ${code} is unknown to JLCPCB, LCSC and EasyEDA.`);
  }

  /* ----------------------------------------------------------------------------- specs */
  const info = ee?.info ?? {};
  const mpn = jlcHit?.mpn || lp?.mpn || info.mpn || q;
  const manufacturer = jlcHit?.manufacturer || lp?.manufacturer || info.manufacturer || 'Unknown';
  const description = jlcHit?.description || lp?.description || info.description || info.title || '';
  const pkg = jlcHit?.package || lp?.package || info.package || '';
  const params: Record<string, string> = { ...(jlcHit?.attributes ?? {}), ...(lp?.params ?? {}) };
  let category: PartCategory = jlcHit && jlcHit.category !== 'other' ? jlcHit.category : lp?.category && lp.category !== 'other' ? lp.category : categorize(info.tags ?? '', '', `${description} ${info.title ?? ''}`, mpn);
  if (category === 'other' && ee) category = categorize('', '', description, mpn);

  const part: PartDef = {
    id: code,
    mpn,
    manufacturer,
    description,
    category,
    package: pkg,
    params,
    offers: [],
    pins: [],
    provenance: {
      specs: jlcHit || lp ? 'fetched' : 'missing',
      symbol: 'missing',
      footprint: 'missing',
      model3d: 'missing',
      sim: 'missing',
      source: ee ? 'JLCPCB/LCSC + EasyEDA library' : 'JLCPCB/LCSC',
      fetchedAt: new Date().toISOString(),
    },
  };
  refreshOffers(part, code, jlcHit, lp);
  const datasheet = lp?.datasheetUrl ?? jlcHit?.datasheetUrl ?? info.datasheet;
  if (datasheet) part.datasheetUrl = datasheet;
  const image = jlcHit?.imageUrl ?? lp?.imageUrl;
  if (image) part.imageUrl = image;
  if (lp?.massGrams !== undefined) part.massGrams = lp.massGrams;
  const value = valueFromParams(category, params);
  if (value) part.value = value;
  const ratings = ratingsFromParams(params);
  if (ratings) part.ratings = ratings;
  if (!jlcHit && !lp) needs.push({ facet: 'specs', hint: `Distributor data for ${code} is unavailable; fill description, category, package and key parameters from the datasheet.` });

  /* ----------------------------------------------------------------- pins & footprint */
  const notes: string[] = [];
  if (ee) {
    if (ee.footprint.pads.length) {
      part.footprint = ee.footprint;
      part.provenance.footprint = 'fetched';
    }
    if (ee.pins.length) {
      part.pins = inferPinTypes(ee.pins, category);
      part.provenance.symbol = 'fetched';
    }
    for (const w of ee.warnings) if (!/origin corrected/.test(w)) notes.push(`EasyEDA: ${w}`);
  }
  // curated builtin entry: fills pins / footprint / package spec the library record did not provide
  const builtin = ALL_CATALOG_PARTS.find((b) => b.id === code);
  if (!part.footprint && builtin?.footprint?.pads.length) {
    part.footprint = structuredClone(builtin.footprint);
    part.provenance.footprint = 'builtin';
    log.push('Footprint: curated builtin footprint used (no library footprint)');
  }
  if (!part.pins.length && builtin?.pins.length) {
    part.pins = structuredClone(builtin.pins);
    part.provenance.symbol = 'builtin';
    log.push('Pins: curated builtin pin table used (no library symbol)');
  }
  const pinCount = part.footprint ? new Set(part.footprint.pads.map((p) => p.number).filter(Boolean)).size : part.pins.length || undefined;
  const ctx = { pins: pinCount, mpn, description, category };
  const builtinSpec = builtin?.packageSpec ? structuredClone(builtin.packageSpec) : undefined;
  const spec: PackageSpec | undefined =
    part.provenance.footprint === 'builtin' && builtinSpec
      ? builtinSpec
      : (parsePackageName(pkg, ctx) ??
        (info.footprintName ? parsePackageName(info.footprintName, ctx) : undefined) ??
        (info.package && info.package !== pkg ? parsePackageName(info.package, ctx) : undefined) ??
        builtinSpec);
  if (spec) part.packageSpec = spec;
  if (!part.footprint) {
    if (spec) {
      part.footprint = generateFootprint(spec);
      part.provenance.footprint = 'generated';
      log.push(`Footprint generated from package "${pkg}" (${spec.family})`);
    } else {
      needs.push({ facet: 'footprint', hint: `No library footprint and package "${pkg || '?'}" is not recognised. Provide packageSpec (family + body/pitch/pad dimensions) or an explicit footprint from the datasheet${datasheet ? ` (${datasheet})` : ''}.` });
    }
  }
  if (!part.pins.length) {
    const fromPads = part.footprint ? uniquePadPins(part.footprint) : spec?.pins ? Array.from({ length: spec.pins }, (_, i) => ({ number: String(i + 1), name: String(i + 1), type: 'unspecified' as const })) : [];
    if (fromPads.length) {
      part.pins = inferPinTypes(fromPads, category);
      part.provenance.symbol = 'generated';
      if (!TRIVIAL_PINS.includes(category)) {
        const what = ['diode', 'schottky', 'zener', 'tvs', 'led', 'capacitor-polarized'].includes(category) ? 'Confirm polarity: pin numbering assumes pin 1 = cathode / negative.' : 'Pin names/types are unknown (pins are numbered only).';
        needs.push({ facet: 'pins', hint: `${what} Provide the pin table (number, name, type) from the datasheet${datasheet ? ` (${datasheet})` : ''}.` });
      }
    } else {
      needs.push({ facet: 'pins', hint: `No symbol data for ${mpn}; provide every pin (number, name, electrical type) from the datasheet${datasheet ? ` (${datasheet})` : ''}.` });
    }
  }

  /* -------------------------------------------------------------------------------- 3D */
  const meshes: { assetId: string; mesh: MeshData }[] = [];
  const model = ee?.model3d;
  if (model && with3d) {
    const r = await httpRequest(easyedaObjUrl(model.uuid), { fetch: fetchImpl, timeoutMs });
    if (r.ok && /^\s*(v|newmtl|#|o|g|usemtl)\s/m.test(r.text)) {
      const mesh = parseEasyEdaObj(r.text, model);
      if (mesh.groups.length) {
        const assetId = `mesh_${code}`;
        meshes.push({ assetId, mesh });
        part.model3d = { kind: 'mesh', meshAssetId: assetId, stepUrl: easyedaStepUrl(model.uuid), source: 'fetched' };
        part.provenance.model3d = 'fetched';
        log.push(`3D model ${model.name} (${mesh.groups.length} material groups)`);
      }
    } else log.push(`3D model download failed: ${r.error ?? 'not an OBJ file'}`);
  } else if (model) log.push('3D mesh download skipped (with3d = false)');
  if (!part.model3d && spec) {
    let prims = generateBody(spec, { category });
    if (part.footprint && part.provenance.footprint === 'fetched') {
      const turn = alignmentTurn(part.footprint, generateFootprint(spec));
      if (turn) prims = rotatePrimitivesZ(prims, turn);
    }
    part.model3d = { kind: 'primitives', primitives: prims, source: 'generated' };
    if (model) part.model3d.stepUrl = easyedaStepUrl(model.uuid);
    part.provenance.model3d = 'generated';
  }
  if (!part.model3d && builtin?.model3d) {
    part.model3d = structuredClone(builtin.model3d);
    part.provenance.model3d = 'builtin';
  }
  if (!part.model3d) needs.push({ facet: 'model3d', hint: `No 3D model; provide packageSpec so a parametric body can be generated (body width/length/height from the datasheet).` });

  /* -------------------------------------------------------------------- body envelope */
  const mesh = meshes[0]?.mesh;
  const hParam = paramNumber(params, [/z-height|height - seated|^height\b|switch height|^thickness/i]);
  if (mesh?.bbox) {
    const b = mesh.bbox;
    part.body = { w: round3(b.max[0] - b.min[0]), l: round3(b.max[1] - b.min[1]), h: round3(Math.max(0.1, b.max[2])) };
  } else if (spec?.bodyW && spec.bodyL) {
    const turn = part.footprint && part.provenance.footprint === 'fetched' ? alignmentTurn(part.footprint, generateFootprint(spec)) : 0;
    const swap = turn === 90 || turn === 270;
    part.body = { w: swap ? spec.bodyL : spec.bodyW, l: swap ? spec.bodyW : spec.bodyL, h: hParam ?? spec.bodyH ?? 1 };
  } else if (part.footprint) {
    const c = part.footprint.courtyard;
    part.body = { w: round3(Math.max(0.2, c.maxX - c.minX - 0.5)), l: round3(Math.max(0.2, c.maxY - c.minY - 0.5)), h: hParam ?? 1 };
  }

  /* ------------------------------------------------------------- sim / connector / thermal */
  const sim = inferSimModel(part);
  if (sim) {
    part.sim = sim;
    part.provenance.sim = 'generated';
  }
  if (['connector', 'cable'].includes(category)) {
    const cs = inferConnectorSpec(part);
    if (cs) {
      part.connector = cs;
      if (cs.role === 'board' && !cs.matingDirection) needs.push({ facet: 'connector', hint: `Mating direction of ${mpn} could not be derived from the footprint; set matingDirection (+x/-x/+y/-y/+z) and the enclosure opening with configure_connector.` });
      if (cs.family.startsWith('WTB') || cs.family === 'Generic') needs.push({ facet: 'connector', hint: `Connector series of ${mpn} is not recognised (family "${cs.family}"); set family, gender and matesWith with configure_connector.` });
    } else needs.push({ facet: 'connector', hint: `Configure ${mpn} with configure_connector (family, gender, positions, ratings, mating direction).` });
  }
  const thermal = inferThermal(part);
  if (thermal) part.thermal = thermal;
  if (builtin) overlayBuiltin(part, builtin, log);
  if (!part.sim && !NO_SIM_NEEDED.includes(category)) needs.push({ facet: 'sim', hint: simHint(part) });
  else if (part.sim?.kind === 'ic' && part.provenance.sim === 'generated' && (category === 'rf-module' || category === 'module') && iccFromParams(params) === undefined) {
    needs.push({ facet: 'sim', hint: `Supply current of ${mpn} is not in the distributor data; the ${category} default Icc = ${part.sim.Icc} A was used. Set Icc (average and peak) from the datasheet if power or thermal results matter.` });
  }

  if (ee) part.provenance.attribution = EASYEDA_ATTRIBUTION;
  if (notes.length) part.provenance.notes = notes.slice(0, 12);
  log.push(`Imported ${code} ${mpn} [${category}] in ${Date.now() - t0} ms: pins ${part.provenance.symbol}, footprint ${part.provenance.footprint}, 3D ${part.provenance.model3d}, sim ${part.provenance.sim}`);
  return { part, meshes, log, needsAgent: needs };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function simHint(part: PartDef): string {
  switch (part.category) {
    case 'mcu':
      return `No built-in CPU emulator for ${part.mpn} (only ATmega328P and RP2040). Provide {kind:"mcu", emulator:"script:<behaviorId>", clockHz, supplyPins, groundPins, Icc, pinMap} with an agent-authored emulator, or {kind:"ic", supplyPins, groundPins, Icc} for power-only simulation.`;
    case 'ldo':
    case 'dc-dc':
      return `Output voltage / pin roles of ${part.mpn} could not be determined (adjustable output or unusual pin names). Provide {kind:"${part.category === 'ldo' ? 'ldo' : 'buck'}", in, out, gnd, Vout, ${part.category === 'ldo' ? 'dropout' : 'efficiency'}} with Vout set by the feedback divider.`;
    case 'relay':
      return `Model the relay coil and contact explicitly (e.g. coil as {kind:"resistor"} and contact as {kind:"switch"}) — PartSimModel holds one element, so pick the side that matters.`;
    case 'resistor':
    case 'capacitor':
    case 'capacitor-polarized':
    case 'inductor':
      return `Value of ${part.mpn} could not be read from the parameters; set part.value (e.g. "10k", "100nF") or the sim model directly.`;
    default:
      return `Provide a PartSimModel for ${part.mpn}, e.g. {kind:"ic", supplyPins:[…], groundPins:[…], Icc} using the supply current from the datasheet.`;
  }
}

/** Replace LCSC / JLCPCB offers with live data (keeps other distributors). */
function refreshOffers(part: PartDef, code: string, jlcHit: PartSearchHit | undefined, lp: Partial<PartDef> | undefined): void {
  const now = new Date().toISOString();
  const keep = part.offers.filter((o) => o.distributor !== 'LCSC' && o.distributor !== 'JLCPCB');
  const prevLcsc = part.offers.filter((o) => o.distributor === 'LCSC' && o.sku !== code);
  const offers: DistributorOffer[] = [];
  const lo = lp?.offers?.[0];
  if (lo) offers.push({ ...lo, fetchedAt: now });
  else {
    const old = part.offers.find((o) => o.distributor === 'LCSC' && o.sku === code);
    if (old) offers.push(old);
  }
  if (jlcHit) {
    const o: DistributorOffer = { distributor: 'JLCPCB', sku: code, url: `https://jlcpcb.com/partdetail/${code}`, stock: jlcHit.stock, currency: 'USD', priceBreaks: jlcHit.priceBreaks, fetchedAt: now };
    if (jlcHit.libraryType) o.libraryType = jlcHit.libraryType;
    offers.push(o);
  } else {
    const old = part.offers.find((o) => o.distributor === 'JLCPCB' && o.sku === code);
    if (old) offers.push(old);
  }
  part.offers = [...offers, ...prevLcsc, ...keep];
}
