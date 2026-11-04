import type { FootprintDef, MeshData, PartCategory, PartDef, PinDef, PriceBreak, Vec3 } from '@pcbcad/core';
import type { FetchLike } from './util/fetch';

/** One distributor search result (JLCPCB/LCSC, Mouser, or the offline builtin catalog). */
export interface PartSearchHit {
  /** LCSC code ('C2040'); '' for non-LCSC sources (Mouser) and catalog items without a verified code. */
  lcsc: string;
  mpn: string;
  manufacturer: string;
  /** Package as given by the distributor, e.g. 'LGA-8(2.5x2.5)'. */
  package: string;
  description: string;
  category: PartCategory;
  /** Units in stock (0 when unknown). */
  stock: number;
  libraryType?: 'basic' | 'extended' | 'preferred';
  priceBreaks: PriceBreak[];
  currency: 'USD';
  datasheetUrl?: string;
  imageUrl?: string;
  /** Product page. For Mouser hits this embeds the Mouser part number (SKU). */
  url?: string;
  /** Distributor attributes, e.g. {'Voltage - Supply': '1.71V~3.6V'}. */
  attributes: Record<string, string>;
  source: 'JLCPCB' | 'Mouser' | 'DigiKey' | 'builtin';
}

/** Facets the deterministic pipeline could not fill; an LLM agent completes them via define_part. */
export type NeedsAgentFacet = 'pins' | 'footprint' | 'model3d' | 'sim' | 'specs' | 'connector';

export interface NeedsAgentHint {
  facet: NeedsAgentFacet;
  /** Precise, actionable description of what is missing and where to find it. */
  hint: string;
}

export interface PartImportResult {
  part: PartDef;
  /** Mesh assets referenced by part.model3d.meshAssetId (asset id `mesh_<lcsc>`). */
  meshes: { assetId: string; mesh: MeshData }[];
  /** Human-readable pipeline log (one line per step). */
  log: string[];
  needsAgent: NeedsAgentHint[];
}

/**
 * Placement of an EasyEDA 3D model relative to the footprint origin (mm / degrees, our Y-up frame).
 * `offset` is the position of the model's XY bounding-box centre; offset[2] is the height of the
 * model's lowest point above the board surface (negative for THT pins). `rotation` is applied to the
 * raw OBJ (extrinsic X, then Y, then Z; CCW positive) before centring.
 */
export interface EasyEdaModelPlacement {
  offset?: Vec3;
  rotation?: Vec3;
}

export interface EasyEdaModelRef {
  /** 3D model uuid (https://modules.easyeda.com/3dmodel/{uuid}). */
  uuid: string;
  name: string;
  offset: Vec3;
  rotation: Vec3;
}

export interface EasyEdaConversion {
  pins: PinDef[];
  /** Converted footprint (source 'fetched'); pads is empty (source 'missing') when the data had none. */
  footprint: FootprintDef;
  model3d?: EasyEdaModelRef;
  /** Normalised metadata (mpn, manufacturer, package, lcsc, datasheet, …) plus raw c_para entries. */
  info: Record<string, string>;
  warnings: string[];
}

export interface SearchPartsOptions {
  /** Maximum hits returned (default 10). */
  limit?: number;
  /** Drop distributor hits with zero stock (catalog hits are never dropped). */
  inStockOnly?: boolean;
  fetch?: FetchLike;
  /** Enables the Mouser Search API v1 in addition to JLCPCB. */
  mouserApiKey?: string;
  /** Per-request timeout (default 15 s). */
  timeoutMs?: number;
}

export interface ImportPartOptions {
  fetch?: FetchLike;
  /** Download the EasyEDA OBJ model and convert it to MeshData (default true). */
  with3d?: boolean;
  /** Per-request timeout (default 15 s). */
  timeoutMs?: number;
}
