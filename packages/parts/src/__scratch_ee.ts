import fs from 'node:fs';
import { convertEasyEdaComponent } from './sources/easyeda';
import { parseEasyEdaObj } from './sources/obj';
const dir = process.argv[2];
for (const c of process.argv.slice(3)) {
  const j = JSON.parse(fs.readFileSync(`${dir}/${c}_easyeda.json`, 'utf8'));
  const conv = convertEasyEdaComponent(j);
  const pads = conv.footprint.pads.filter((p) => p.kind !== 'npth');
  const xs = pads.map((p) => p.x), ys = pads.map((p) => p.y);
  const pc = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  let line = `${c} ${conv.footprint.name} pins=${conv.pins.length} pads=${conv.footprint.pads.length} padC=(${pc[0].toFixed(3)},${pc[1].toFixed(3)}) crt=${JSON.stringify(conv.footprint.courtyard)} model=${JSON.stringify(conv.model3d && { o: conv.model3d.offset, r: conv.model3d.rotation })}`;
  const objPath = `${dir}/${c}_model.obj`;
  if (conv.model3d && fs.existsSync(objPath)) {
    const mesh = parseEasyEdaObj(fs.readFileSync(objPath, 'utf8'), conv.model3d);
    const b = mesh.bbox!;
    line += ` mesh groups=${mesh.groups.length} bboxC=(${((b.min[0] + b.max[0]) / 2).toFixed(3)},${((b.min[1] + b.max[1]) / 2).toFixed(3)}) z=[${b.min[2].toFixed(3)},${b.max[2].toFixed(3)}] size=${(b.max[0]-b.min[0]).toFixed(2)}x${(b.max[1]-b.min[1]).toFixed(2)}`;
  }
  console.log(line);
  if (conv.warnings.length) console.log('   warnings:', conv.warnings.slice(0, 4).join(' | '));
}
