/**
 * Dev utility: run the deterministic parts pipeline for one or more LCSC codes / MPNs and print
 * what PCBCAD would store (facets, connector spec, footprint summary, agent hints).
 *
 *   npx tsx apps/server/scripts/inspect-part.ts C265102 AMS1117-3.3
 */
import { importPart } from '@pcbcad/parts';

for (const id of process.argv.slice(2)) {
  const r = await importPart(id, { with3d: false });
  const p = r.part;
  const fp = p.footprint;
  console.log(`${id} → ${p.id} ${p.mpn} (${p.manufacturer}) [${p.category}] ${p.package}`);
  console.log(`  facets: ${JSON.stringify({ specs: p.provenance.specs, symbol: p.provenance.symbol, footprint: p.provenance.footprint, model3d: p.provenance.model3d, sim: p.provenance.sim })}`);
  console.log(`  pins: ${p.pins.map((x) => `${x.number}:${x.name}`).join(' ')}`);
  if (fp) {
    console.log(`  courtyard: ${JSON.stringify(fp.courtyard)}`);
    console.log(`  pads: ${fp.pads.map((d) => `${d.number}@(${d.x.toFixed(2)},${d.y.toFixed(2)}) ${d.w.toFixed(2)}×${d.h.toFixed(2)} ${d.kind}`).join(' ')}`);
  }
  if (p.connector) console.log(`  connector: ${JSON.stringify(p.connector)}`);
  if (p.sim) console.log(`  sim: ${JSON.stringify(p.sim)}`);
  if (p.body) console.log(`  body: ${JSON.stringify(p.body)}`);
  if (r.needsAgent.length) console.log(`  needsAgent: ${JSON.stringify(r.needsAgent)}`);
}
