import { importPart, searchParts, BUILTIN_PARTS, FASTENERS, WIRING_PARTS } from './index';
console.log('catalog sizes', BUILTIN_PARTS.length, FASTENERS.length, WIRING_PARTS.length);
for (const id of process.argv.slice(2)) {
  const t = Date.now();
  try {
    const r = await importPart(id);
    const p = r.part;
    console.log(`\n== ${id} → ${p.id} ${p.mpn} [${p.category}] pkg=${p.package} value=${p.value ?? ''} ${Date.now() - t}ms`);
    console.log('  spec', JSON.stringify(p.packageSpec && { f: p.packageSpec.family, pins: p.packageSpec.pins, w: p.packageSpec.bodyW, l: p.packageSpec.bodyL }));
    console.log('  prov', JSON.stringify(p.provenance).slice(0, 300));
    console.log('  pins', p.pins.slice(0, 8).map((x) => `${x.number}:${x.name}:${x.type}`).join(' '), p.pins.length > 8 ? `…(${p.pins.length})` : '');
    console.log('  fp', p.footprint?.name, p.footprint?.pads.length, 'body', JSON.stringify(p.body), 'mass', p.massGrams);
    console.log('  sim', JSON.stringify(p.sim)?.slice(0, 300));
    console.log('  thermal', JSON.stringify(p.thermal), 'ratings', JSON.stringify(p.ratings));
    if (p.connector) console.log('  conn', JSON.stringify(p.connector));
    console.log('  offers', p.offers.map((o) => `${o.distributor}:${o.sku}:${o.stock}:${o.libraryType ?? ''}:${o.priceBreaks?.length ?? 0}pb`).join(' '));
    console.log('  meshes', r.meshes.map((m) => `${m.assetId} ${JSON.stringify(m.mesh.bbox)}`).join(' '));
    console.log('  needs', JSON.stringify(r.needsAgent));
    console.log('  log', r.log.join(' | ').slice(0, 600));
  } catch (e) {
    console.log(id, 'ERROR', e instanceof Error ? e.message : e);
  }
}
const hits = await searchParts('ATMEGA328P-AU', { limit: 5 });
console.log('\nsearch ATMEGA328P-AU', hits.map((h) => `${h.lcsc} ${h.mpn} ${h.package} stock=${h.stock} ${h.libraryType} ${h.category} pb=${h.priceBreaks.length}`));
const h2 = await searchParts('0805 10k 1%', { limit: 5, inStockOnly: true });
console.log('search 0805 10k', h2.map((h) => `${h.lcsc} ${h.mpn} ${h.package} ${h.stock} ${h.libraryType} ${h.category}`));
const h3 = await searchParts('M3x8 standoff', { limit: 5 });
console.log('search M3x8 standoff', h3.map((h) => `${h.source} ${h.lcsc} ${h.mpn} ${h.category}`));
