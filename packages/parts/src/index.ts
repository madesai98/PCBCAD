/**
 * @pcbcad/parts — deterministic parts pipeline.
 *
 * Browser-safe: package parsing, IPC-7351B footprint and parametric 3D body generators, category /
 * pin / simulation / connector / thermal inference, distributor and EasyEDA parsers, offline
 * catalogs. Network functions (searchParts, importPart, …) use the global (or injected) fetch.
 */

export * from './types';

// package parsing & generators
export { parsePackageName, type PackageContext } from './package/parse';
export { completeSpec, CHIP_SIZES, CRYSTAL_SIZES, chipSizeFromDims } from './package/defaults';
export { generateFootprint } from './footprint/generate';
export { ipcLand, FILLETS, type IpcLand, type IpcInput, type Fillets, type Range } from './footprint/ipc';
export { generateBody, type BodyOptions } from './body/generate';
export { rotatePrimitivesZ, alignmentTurn, type QuarterTurn } from './body/transform';

// inference
export { categorize } from './infer/categorize';
export { inferPinTypes, cleanPinName, pinTokens } from './infer/pins';
export { inferSimModel, mcuEmulator, mcuPinMap, vOutFromMpn, ledColor } from './infer/sim';
export { inferConnectorSpec } from './infer/connector';
export { inferThermal } from './infer/thermal';
export { parseQuantity, parseTempRange, paramNumber, paramText, findParam } from './infer/params';

// sources (parsers are pure; fetchers never throw)
export { parseJlcSearch, jlcSearch, JLC_SEARCH_URL, isJlcPlaceholder, normalisePriceBreaks, type JlcSearchResult } from './sources/jlc';
export { parseLcscDetail, fetchLcscDetail, lcscDetailUrl, lcscProductUrl, type LcscDetailResult } from './sources/lcsc';
export { convertEasyEdaComponent, EASYEDA_ATTRIBUTION, easyedaComponentUrl, easyedaObjUrl, easyedaStepUrl } from './sources/easyeda';
export { parseEasyEdaObj, rotationMatrix } from './sources/obj';
export { parseMouserSearch, mouserSearch, MOUSER_SEARCH_URL } from './sources/mouser';

// pipeline
export { searchParts, rankHits, matchScore } from './pipeline/search';
export { importPart, pickBestHit, valueFromParams, ratingsFromParams } from './pipeline/import';
export { searchCatalog, findCatalogPart, catalogHit, ALL_CATALOG_PARTS } from './pipeline/catalog';

// catalogs
export { BUILTIN_PARTS } from './catalog/builtin';
export { FASTENERS } from './catalog/fasteners';
export { WIRING_PARTS } from './catalog/wiring';

export { httpRequest, httpJson, DEFAULT_TIMEOUT_MS, type FetchLike, type HttpResult } from './util/fetch';
