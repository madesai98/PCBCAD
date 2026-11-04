/**
 * File exporters: binary STL, 3MF (zip, stored), DXF (flat patterns).
 */
import type { MeshData, Vec2 } from '@pcbcad/core';
import { meshArrays } from './meshutil';
import type { FlatPattern } from './sheet';

/* ------------------------------------------------ STL ------------------------------------------- */

/**
 * Binary STL (little-endian): 80-byte header ("PCBCAD STL: <name>", never starting with "solid"),
 * uint32 triangle count, then per triangle normal + 3 vertices (float32, mm) + uint16 0.
 * All groups are written; indexed meshes and triangle soups are both accepted.
 */
export function exportStl(mesh: MeshData, name = 'pcbcad-part'): Uint8Array {
  const arrays = meshArrays(mesh);
  let nTri = 0;
  for (const a of arrays) nTri += Math.floor(a.indices.length / 3);
  const buf = new ArrayBuffer(84 + 50 * nTri);
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  const header = `PCBCAD STL: ${name}`.slice(0, 80);
  for (let i = 0; i < 80; i++) bytes[i] = i < header.length ? header.charCodeAt(i) & 0x7f : 0x20;
  dv.setUint32(80, nTri, true);
  let off = 84;
  for (const { positions: p, indices: ix } of arrays) {
    for (let t = 0; t + 2 < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      dv.setFloat32(off, nx, true);
      dv.setFloat32(off + 4, ny, true);
      dv.setFloat32(off + 8, nz, true);
      off += 12;
      for (const v of [a, b, c]) {
        dv.setFloat32(off, p[v], true);
        dv.setFloat32(off + 4, p[v + 1], true);
        dv.setFloat32(off + 8, p[v + 2], true);
        off += 12;
      }
      dv.setUint16(off, 0, true);
      off += 2;
    }
  }
  return bytes;
}

/* ------------------------------------------------ 3MF ------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (STORE method, UTF-8 names). */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = new Uint8Array(30 + name.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 33, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 33, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    chunks.push(lh, f.data);
    central.push(ch);
    offset += lh.length + f.data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of all) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/**
 * 3MF package (core spec 2015/02, unit millimetre). Each mesh group becomes one object; vertices
 * are welded (1 µm) so manifold meshes stay manifold after crease-split normals.
 */
export function export3mf(mesh: MeshData, name = 'pcbcad-part'): Uint8Array {
  const enc = new TextEncoder();
  const objects: string[] = [];
  const items: string[] = [];
  const colors: string[] = [];
  let id = 2;
  for (const a of meshArrays(mesh)) {
    const map = new Map<string, number>();
    const verts: string[] = [];
    const remap = new Uint32Array(a.positions.length / 3);
    for (let v = 0; v < remap.length; v++) {
      const x = a.positions[v * 3], y = a.positions[v * 3 + 1], z = a.positions[v * 3 + 2];
      const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
      let k = map.get(key);
      if (k === undefined) {
        k = verts.length;
        map.set(key, k);
        verts.push(`<vertex x="${+x.toFixed(4)}" y="${+y.toFixed(4)}" z="${+z.toFixed(4)}"/>`);
      }
      remap[v] = k;
    }
    const tris: string[] = [];
    for (let t = 0; t + 2 < a.indices.length; t += 3) {
      const p = remap[a.indices[t]], q = remap[a.indices[t + 1]], r = remap[a.indices[t + 2]];
      if (p === q || q === r || p === r) continue;
      tris.push(`<triangle v1="${p}" v2="${q}" v3="${r}"/>`);
    }
    const col = /^#[0-9a-fA-F]{6}$/.test(a.group.color) ? a.group.color.toUpperCase() + 'FF' : '#808080FF';
    colors.push(`<base name="${xmlEscape(a.group.name ?? name)}" displaycolor="${col}"/>`);
    objects.push(
      `<object id="${id}" type="model" name="${xmlEscape(a.group.name ?? name)}" pid="1" pindex="${colors.length - 1}"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`,
    );
    items.push(`<item objectid="${id}"/>`);
    id++;
  }
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Title">${xmlEscape(name)}</metadata><metadata name="Application">PCBCAD</metadata>` +
    `<resources><basematerials id="1">${colors.join('')}</basematerials>${objects.join('')}</resources><build>${items.join('')}</build></model>`;
  const types =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(types) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: '3D/3dmodel.model', data: enc.encode(model) },
  ]);
}

/* ------------------------------------------------ DXF ------------------------------------------- */

export interface DxfOptions {
  /**
   * 'lw' (default): LWPOLYLINE contours (accepted by virtually every CAD/CAM reader);
   * 'r12': strict AutoCAD R12 POLYLINE/VERTEX/SEQEND contours.
   */
  polyline?: 'lw' | 'r12';
  /** Text height for bend notes (mm). Default 2.5. */
  textHeight?: number;
}

function f(n: number): string {
  const s = n.toFixed(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
}

/**
 * Flat pattern → DXF (AutoCAD R12 ASCII, AC1009, millimetres). Layers: OUTLINE (outer contour,
 * colour 7), HOLES (inner contours; round holes as CIRCLE, colour 5), BEND (bend centre lines as
 * LINE plus a TEXT note "UP 90%%d R1 BA2.262", colour 1).
 */
export function exportDxf(flat: FlatPattern, opts: DxfOptions = {}): string {
  const mode = opts.polyline ?? 'lw';
  const th = opts.textHeight ?? 2.5;
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code).padStart(3, ' '), typeof value === 'number' ? f(value) : value);
  const poly = (layer: string, pts: Vec2[]) => {
    if (pts.length < 2) return;
    if (mode === 'lw') {
      g(0, 'LWPOLYLINE');
      g(8, layer);
      g(90, String(pts.length));
      g(70, '1');
      for (const [x, y] of pts) {
        g(10, x);
        g(20, y);
      }
    } else {
      g(0, 'POLYLINE');
      g(8, layer);
      g(66, '1');
      g(70, '1');
      g(10, 0);
      g(20, 0);
      g(30, 0);
      for (const [x, y] of pts) {
        g(0, 'VERTEX');
        g(8, layer);
        g(10, x);
        g(20, y);
        g(30, 0);
      }
      g(0, 'SEQEND');
      g(8, layer);
    }
  };
  const bb = flat.bbox ?? { minX: 0, minY: 0, maxX: flat.size[0], maxY: flat.size[1] };
  // header
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1009');
  g(9, '$INSUNITS');
  g(70, '4');
  g(9, '$EXTMIN');
  g(10, bb.minX);
  g(20, bb.minY);
  g(30, 0);
  g(9, '$EXTMAX');
  g(10, bb.maxX);
  g(20, bb.maxY);
  g(30, 0);
  g(0, 'ENDSEC');
  // tables
  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LTYPE');
  g(70, '1');
  g(0, 'LTYPE');
  g(2, 'CONTINUOUS');
  g(70, '0');
  g(3, 'Solid line');
  g(72, '65');
  g(73, '0');
  g(40, 0);
  g(0, 'ENDTAB');
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, '3');
  for (const [name, color] of [
    ['OUTLINE', '7'],
    ['HOLES', '5'],
    ['BEND', '1'],
  ]) {
    g(0, 'LAYER');
    g(2, name);
    g(70, '0');
    g(62, color);
    g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  // entities
  g(0, 'SECTION');
  g(2, 'ENTITIES');
  poly('OUTLINE', flat.outline);
  flat.holes.forEach((h, i) => {
    const c = flat.holeCircles?.[i];
    if (c) {
      g(0, 'CIRCLE');
      g(8, 'HOLES');
      g(10, c.center[0]);
      g(20, c.center[1]);
      g(30, 0);
      g(40, c.diameter / 2);
    } else poly('HOLES', h);
  });
  for (const b of flat.bendLines) {
    g(0, 'LINE');
    g(8, 'BEND');
    g(10, b.a[0]);
    g(20, b.a[1]);
    g(30, 0);
    g(11, b.b[0]);
    g(21, b.b[1]);
    g(31, 0);
    let ang = (Math.atan2(b.b[1] - b.a[1], b.b[0] - b.a[0]) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang <= -90) ang += 180;
    const mx = (b.a[0] + b.b[0]) / 2;
    const my = (b.a[1] + b.b[1]) / 2;
    g(0, 'TEXT');
    g(8, 'BEND');
    g(10, mx);
    g(20, my);
    g(30, 0);
    g(40, th);
    g(1, `${b.direction.toUpperCase()} ${f(b.angle)}%%d R${f(b.radius)} BA${b.allowance.toFixed(3)}`);
    g(50, ang);
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}
