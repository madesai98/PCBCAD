import type { FootprintDef, Graphic, PadDef, PinDef, PinType, Vec2, Vec3 } from '@pcbcad/core';
import { padPolygonLocal } from '@pcbcad/core';
import { categorize } from '../infer/categorize';
import { inferPinTypes, pinTokens } from '../infer/pins';
import type { EasyEdaConversion, EasyEdaModelRef } from '../types';
import { asArray, asNumber, asString, asText, getPath, isRecord, tryParseJson } from '../util/json';
import { ceilTo, floorTo, normDeg, rnd } from '../util/num';
import { firstArc, svgPathToPolylines } from './svgpath';

/** Attribution required for data taken from the EasyEDA / JLCEDA library. */
export const EASYEDA_ATTRIBUTION = 'Symbol, footprint and 3D model from the JLCEDA/EasyEDA official library (https://easyeda.com · https://lceda.cn)';

/** EasyEDA component (symbol + footprint + 3D reference) for an LCSC code. */
export function easyedaComponentUrl(lcsc: string): string {
  return `https://easyeda.com/api/products/${encodeURIComponent(lcsc)}/components?version=6.4.19.5`;
}

/** EasyEDA 3D model as OBJ text with inline materials (mm). */
export function easyedaObjUrl(uuid: string): string {
  return `https://modules.easyeda.com/3dmodel/${encodeURIComponent(uuid)}`;
}

/** EasyEDA 3D model as STEP. */
export function easyedaStepUrl(uuid: string): string {
  return `https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/${encodeURIComponent(uuid)}`;
}

/** mm per EasyEDA canvas unit (10 mil). */
const U = 0.254;

interface Frame {
  ox: number;
  oy: number;
}

const X = (f: Frame, x: number) => rnd((x - f.ox) * U);
const Y = (f: Frame, y: number) => rnd(-(y - f.oy) * U);

function nums(s: string | undefined): number[] {
  if (!s) return [];
  return s
    .trim()
    .split(/[\s,]+/)
    .map((t) => parseFloat(t))
    .filter((n) => Number.isFinite(n));
}

function dataStrOf(v: unknown): Record<string, unknown> | undefined {
  if (isRecord(v)) return v;
  if (typeof v === 'string') {
    const j = tryParseJson(v);
    return isRecord(j) ? j : undefined;
  }
  return undefined;
}

function shapesOf(ds: Record<string, unknown> | undefined): string[] {
  return asArray(ds?.shape).filter((s): s is string => typeof s === 'string');
}

/* ------------------------------------------------------------------------------------ symbol */

const EE_PIN_TYPE: Record<string, PinType> = { '0': 'unspecified', '1': 'input', '2': 'output', '3': 'bidirectional', '4': 'power_in' };

function normalisePadNumber(n: string): string {
  const t = n.trim();
  const m = /^[^()]*\(([^()]+)\)$/.exec(t);
  return m && /^[A-Z]{0,2}\d+$/i.test(m[1]) ? m[1] : t;
}

function parsePin(rec: string): PinDef | undefined {
  const seg = rec.split('^^').map((s) => s.split('~'));
  const settings = seg[0] ?? [];
  const number = normalisePadNumber((seg[4]?.[4] ?? '').trim() || (settings[3] ?? '').trim());
  if (!number) return undefined;
  const name = (seg[3]?.[4] ?? '').trim() || number;
  const pin: PinDef = { number, name, type: EE_PIN_TYPE[(settings[2] ?? '').trim()] ?? 'unspecified' };
  const rot = parseInt(settings[6] ?? '0', 10);
  const side = rot === 0 ? 'right' : rot === 180 ? 'left' : rot === 90 ? 'top' : rot === 270 ? 'bottom' : undefined;
  if (side) pin.side = side;
  if (/[()/]/.test(name)) {
    const toks = pinTokens(name).filter((t) => t !== number);
    if (toks.length > 1) pin.functions = [...new Set(toks)];
  }
  return pin;
}

function symbolPins(root: Record<string, unknown>): PinDef[] {
  const pins: PinDef[] = [];
  const seen = new Set<string>();
  const units = [dataStrOf(root.dataStr), ...asArray(root.subparts).map((sp) => dataStrOf(getPath(sp, 'dataStr')))];
  for (const ds of units) {
    for (const s of shapesOf(ds)) {
      if (!s.startsWith('P~')) continue;
      const p = parsePin(s);
      if (p && !seen.has(p.number)) {
        seen.add(p.number);
        pins.push(p);
      }
    }
  }
  return pins.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

/* --------------------------------------------------------------------------------- footprint */

function graphicLayer(layer: string): Graphic['layer'] | undefined {
  if (layer === '3') return 'silk';
  if (layer === '13' || layer === '99' || layer === '101') return 'fab';
  return undefined;
}

function convertPad(a: string[], f: Frame, warnings: string[]): PadDef | undefined {
  const shapeRaw = (a[0] ?? '').toUpperCase();
  const cx = asNumber(a[1]);
  const cy = asNumber(a[2]);
  if (cx === undefined || cy === undefined) return undefined;
  let w = (asNumber(a[3]) ?? 0) * U;
  let h = (asNumber(a[4]) ?? 0) * U;
  const layer = (a[5] ?? '1').trim();
  const number = normalisePadNumber(a[7] ?? '');
  const holeR = (asNumber(a[8]) ?? 0) * U;
  const rot = normDeg(asNumber(a[10]) ?? 0);
  const holeLen = (asNumber(a[12]) ?? 0) * U;
  const plated = (a[14] ?? 'Y').trim().toUpperCase() !== 'N';
  const drill = rnd(2 * holeR);
  const x = X(f, cx);
  const y = Y(f, cy);
  if (!['1', '2', '11'].includes(layer)) {
    warnings.push(`pad ${number || '?'} on non-copper layer ${layer} skipped`);
    return undefined;
  }
  if (layer === '2') warnings.push(`pad ${number} is on the bottom copper layer (kept as SMD on the component side)`);
  let shape: PadDef['shape'] = shapeRaw === 'RECT' ? 'rect' : shapeRaw === 'OVAL' ? 'oval' : shapeRaw === 'ELLIPSE' ? 'circle' : shapeRaw === 'POLYGON' ? 'polygon' : 'rect';
  let polygon: Vec2[] | undefined;
  let rotation = rot;
  if (shape === 'polygon') {
    const p = nums(a[9]);
    const pts: Vec2[] = [];
    for (let i = 0; i + 1 < p.length; i += 2) {
      const q: Vec2 = [rnd(X(f, p[i]) - x), rnd(Y(f, p[i + 1]) - y)];
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last[0] - q[0], last[1] - q[1]) > 1e-4) pts.push(q);
    }
    if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-4) pts.pop();
    if (pts.length >= 3) {
      polygon = pts;
      rotation = 0; // polygon points already carry the rotation
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      w = Math.max(...xs) - Math.min(...xs);
      h = Math.max(...ys) - Math.min(...ys);
    } else {
      shape = 'rect';
      warnings.push(`polygon pad ${number} has no usable outline; using its ${rnd(w, 3)}×${rnd(h, 3)} bounding rectangle`);
    }
  }
  if (shape === 'circle' && Math.abs(w - h) > 1e-3) shape = 'oval';
  let kind: PadDef['kind'] = 'smd';
  if (drill > 0) kind = plated ? 'tht' : 'npth';
  else if (layer === '11') warnings.push(`multi-layer pad ${number} has no drill; treated as SMD`);
  if (kind !== 'smd') {
    if (w < drill) w = drill;
    if (h < drill) h = drill;
  }
  const pad: PadDef = { number, shape, x, y, w: rnd(Math.max(w, 0.01)), h: rnd(Math.max(h, 0.01)), kind };
  if (rotation) pad.rotation = rotation;
  if (polygon) pad.polygon = polygon;
  if (kind !== 'smd') pad.drill = drill;
  if (kind !== 'smd' && holeLen > drill + 0.01) {
    const sp = nums(a[13]);
    let alongX: boolean;
    if (sp.length >= 4) {
      const vx = sp[2] - sp[0];
      const vy = -(sp[3] - sp[1]);
      const ang = (Math.atan2(vy, vx) * 180) / Math.PI - rotation;
      alongX = Math.abs(Math.cos((ang * Math.PI) / 180)) >= Math.abs(Math.sin((ang * Math.PI) / 180));
    } else alongX = pad.w >= pad.h;
    pad.slot = alongX ? { w: rnd(holeLen), h: drill } : { w: drill, h: rnd(holeLen) };
  }
  return pad;
}

function polylineFromTrack(pointsStr: string, f: Frame): Vec2[] {
  const p = nums(pointsStr);
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < p.length; i += 2) out.push([X(f, p[i]), Y(f, p[i + 1])]);
  return out;
}

function arcGraphic(path: string, f: Frame, layer: Graphic['layer'], width: number): Graphic | undefined {
  const a = firstArc(path);
  if (!a) return undefined;
  if (!a.arc) {
    return { kind: 'line', layer, a: [X(f, a.start[0]), Y(f, a.start[1])], b: [X(f, a.end[0]), Y(f, a.end[1])], width };
  }
  const { cx, cy, rx, ry, theta1, dtheta } = a.arc;
  const c: Vec2 = [X(f, cx), Y(f, cy)];
  if (Math.abs(rx - ry) > 1e-3 * Math.max(rx, ry)) {
    const pts = svgPathToPolylines(path)[0]?.points.map((q) => [X(f, q[0]), Y(f, q[1])] as Vec2) ?? [];
    return pts.length >= 2 ? { kind: 'polyline', layer, points: pts, width } : undefined;
  }
  const r = rnd(rx * U);
  if (Math.abs(dtheta) >= 2 * Math.PI - 0.02) return { kind: 'circle', layer, c, r, width };
  // canvas angle θ (y down) ↔ our angle −θ (y up); arcs are stored counter-clockwise start → end
  const s0 = (-theta1 * 180) / Math.PI;
  const s1 = (-(theta1 + dtheta) * 180) / Math.PI;
  const norm = (d: number) => rnd(((d % 360) + 360) % 360, 3);
  const [start, end] = dtheta > 0 ? [norm(s1), norm(s0)] : [norm(s0), norm(s1)];
  return { kind: 'arc', layer, c, r, start, end, width };
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function addPt(b: Box, x: number, y: number): void {
  if (x < b.minX) b.minX = x;
  if (x > b.maxX) b.maxX = x;
  if (y < b.minY) b.minY = y;
  if (y > b.maxY) b.maxY = y;
}

interface FootprintResult {
  footprint: FootprintDef;
  model?: EasyEdaModelRef;
}

function convertFootprint(pd: Record<string, unknown>, warnings: string[]): FootprintResult {
  const ds = dataStrOf(pd.dataStr);
  const head = isRecord(ds?.head) ? (ds?.head as Record<string, unknown>) : {};
  const canvas = asString(ds?.canvas).split('~');
  const ox = asNumber(head.x) ?? asNumber(canvas[16]) ?? 0;
  const oy = asNumber(head.y) ?? asNumber(canvas[17]) ?? 0;
  if (asNumber(head.x) === undefined) warnings.push('footprint head has no origin; using canvas origin');
  const f: Frame = { ox, oy };
  const name = asText(pd.title) ?? asText(getPath(head, 'c_para', 'package')) ?? 'EasyEDA footprint';
  const pads: PadDef[] = [];
  const graphics: Graphic[] = [];
  const body: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let model: EasyEdaModelRef | undefined;
  let outlinePts: Vec2[] = [];
  for (const rec of shapesOf(ds)) {
    const tilde = rec.indexOf('~');
    const kind = tilde < 0 ? rec : rec.slice(0, tilde);
    try {
      if (kind === 'SVGNODE') {
        const node = tryParseJson(rec.slice(tilde + 1));
        const attrs = getPath(node, 'attrs');
        if (!isRecord(attrs) || attrs.c_etype !== 'outline3D') continue;
        const uuid = asText(attrs.uuid);
        if (!uuid) continue;
        const co = nums(asString(attrs.c_origin));
        const rotv = nums(asString(attrs.c_rotation));
        const z = (asNumber(attrs.z) ?? 0) * U;
        let offX = co.length >= 2 ? X(f, co[0]) : 0;
        let offY = co.length >= 2 ? Y(f, co[1]) : 0;
        const pts: Vec2[] = [];
        for (const ch of asArray(getPath(node, 'childNodes'))) {
          const p = nums(asString(getPath(ch, 'attrs', 'points')));
          for (let i = 0; i + 1 < p.length; i += 2) pts.push([X(f, p[i]), Y(f, p[i + 1])]);
        }
        outlinePts = pts;
        if (pts.length) {
          const xs = pts.map((q) => q[0]);
          const ys = pts.map((q) => q[1]);
          const ocx = (Math.min(...xs) + Math.max(...xs)) / 2;
          const ocy = (Math.min(...ys) + Math.max(...ys)) / 2;
          // c_origin is unreliable in parts of the library; the outline (model projection) is authoritative
          if (Math.abs(ocx - offX) > 0.1 || Math.abs(ocy - offY) > 0.1) {
            warnings.push(`3D model origin corrected to the outline centre (${rnd(ocx, 3)}, ${rnd(ocy, 3)}) mm`);
            offX = ocx;
            offY = ocy;
          }
        }
        const offset: Vec3 = [rnd(offX), rnd(offY), rnd(z)];
        const rotation: Vec3 = [rotv[0] ?? 0, rotv[1] ?? 0, rotv[2] ?? 0];
        model = { uuid, name: asText(attrs.title) ?? name, offset, rotation };
        continue;
      }
      const a = rec.split('~').slice(1);
      switch (kind) {
        case 'PAD': {
          const p = convertPad(a, f, warnings);
          if (p) pads.push(p);
          break;
        }
        case 'HOLE': {
          const cx = asNumber(a[0]);
          const cy = asNumber(a[1]);
          const r = (asNumber(a[2]) ?? 0) * U;
          if (cx !== undefined && cy !== undefined && r > 0) {
            const d = rnd(2 * r);
            pads.push({ number: '', shape: 'circle', x: X(f, cx), y: Y(f, cy), w: d, h: d, kind: 'npth', drill: d });
          }
          break;
        }
        case 'VIA': {
          const cx = asNumber(a[0]);
          const cy = asNumber(a[1]);
          const dia = (asNumber(a[2]) ?? 0) * U;
          const r = (asNumber(a[4]) ?? 0) * U;
          if (cx !== undefined && cy !== undefined && r > 0) pads.push({ number: '', shape: 'circle', x: X(f, cx), y: Y(f, cy), w: rnd(Math.max(dia, 2 * r + 0.1)), h: rnd(Math.max(dia, 2 * r + 0.1)), kind: 'tht', drill: rnd(2 * r) });
          break;
        }
        case 'TRACK': {
          const layer = graphicLayer(a[1] ?? '');
          if (!layer) break;
          const width = rnd(Math.max(0.05, (asNumber(a[0]) ?? 0.5) * U));
          const pts = polylineFromTrack(a[3] ?? '', f);
          if (pts.length === 2) graphics.push({ kind: 'line', layer, a: pts[0], b: pts[1], width });
          else if (pts.length > 2) graphics.push({ kind: 'polyline', layer, points: pts, width });
          if ((a[1] === '99' || a[1] === '13') && pts.length) for (const q of pts) addPt(body, q[0], q[1]);
          break;
        }
        case 'CIRCLE': {
          const layer = graphicLayer(a[4] ?? '');
          const cx = asNumber(a[0]);
          const cy = asNumber(a[1]);
          const r = (asNumber(a[2]) ?? 0) * U;
          if (!layer || cx === undefined || cy === undefined || r <= 0) break;
          const width = rnd(Math.max(0.05, (asNumber(a[3]) ?? 0.5) * U));
          graphics.push({ kind: 'circle', layer, c: [X(f, cx), Y(f, cy)], r: rnd(r), width });
          break;
        }
        case 'ARC': {
          const layer = graphicLayer(a[1] ?? '');
          if (!layer) break;
          const width = rnd(Math.max(0.05, (asNumber(a[0]) ?? 0.5) * U));
          const g = arcGraphic(a[3] ?? '', f, layer, width);
          if (g) graphics.push(g);
          break;
        }
        case 'RECT': {
          const layer = graphicLayer(a[4] ?? '');
          const x0 = asNumber(a[0]);
          const y0 = asNumber(a[1]);
          const w = asNumber(a[2]);
          const h = asNumber(a[3]);
          if (!layer || x0 === undefined || y0 === undefined || !w || !h) break;
          const width = rnd(Math.max(0.05, (asNumber(a[7]) ?? 0.5) * U));
          const pts: Vec2[] = [
            [X(f, x0), Y(f, y0)],
            [X(f, x0 + w), Y(f, y0)],
            [X(f, x0 + w), Y(f, y0 + h)],
            [X(f, x0), Y(f, y0 + h)],
          ];
          graphics.push({ kind: 'polyline', layer, points: pts, width, closed: true });
          break;
        }
        case 'SOLIDREGION': {
          const lid = a[0] ?? '';
          const layer = graphicLayer(lid);
          if (!layer || (a[3] ?? 'solid') === 'npth') break;
          for (const sp of svgPathToPolylines(a[2] ?? '')) {
            const pts = sp.points.map((q) => [X(f, q[0]), Y(f, q[1])] as Vec2);
            if (pts.length < 3) continue;
            if (lid === '99') {
              graphics.push({ kind: 'polyline', layer: 'fab', points: pts, width: 0.1, closed: true });
              for (const q of pts) addPt(body, q[0], q[1]);
            } else if (lid === '3') graphics.push({ kind: 'polyline', layer: 'silk', points: pts, width: 0.05, closed: true, fill: true });
            else graphics.push({ kind: 'polyline', layer, points: pts, width: 0.1, closed: true });
          }
          break;
        }
        case 'TEXT': {
          if ((a[0] ?? '') !== 'L') break;
          const layer = graphicLayer(a[6] ?? '');
          const cx = asNumber(a[1]);
          const cy = asNumber(a[2]);
          const text = (a[9] ?? '').trim();
          if (!layer || cx === undefined || cy === undefined || !text || (a[11] ?? '') === 'none') break;
          const size = rnd(Math.max(0.3, (asNumber(a[8]) ?? 4) * U), 3);
          const g: Graphic = { kind: 'text', layer, at: [X(f, cx), Y(f, cy)], text, size };
          const rot = asNumber(a[4]);
          if (rot) g.rotation = normDeg(rot);
          graphics.push(g);
          break;
        }
        default:
          break;
      }
    } catch (e) {
      warnings.push(`could not convert ${kind} record: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // courtyard: pads ∪ body (component-shape layer) ∪ 3D-model outline, + 0.25 mm
  const cy: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pads) for (const [x, y] of padPolygonLocal(p, 8)) addPt(cy, x, y);
  if (Number.isFinite(body.minX)) {
    addPt(cy, body.minX, body.minY);
    addPt(cy, body.maxX, body.maxY);
  }
  for (const q of outlinePts) addPt(cy, q[0], q[1]);
  if (!Number.isFinite(cy.minX)) addPt(cy, 0, 0);
  const courtyard = {
    minX: floorTo(cy.minX - 0.25, 0.01),
    minY: floorTo(cy.minY - 0.25, 0.01),
    maxX: ceilTo(cy.maxX + 0.25, 0.01),
    maxY: ceilTo(cy.maxY + 0.25, 0.01),
  };
  graphics.push({
    kind: 'polyline',
    layer: 'courtyard',
    points: [
      [courtyard.minX, courtyard.minY],
      [courtyard.maxX, courtyard.minY],
      [courtyard.maxX, courtyard.maxY],
      [courtyard.minX, courtyard.maxY],
    ],
    width: 0.05,
    closed: true,
  });
  if (!pads.length) warnings.push('footprint has no pads');
  const footprint: FootprintDef = { name, pads, graphics, courtyard, source: pads.length ? 'fetched' : 'missing' };
  return { footprint, model };
}

/* ------------------------------------------------------------------------------------- entry */

function emptyFootprint(): FootprintDef {
  return { name: 'missing', pads: [], graphics: [], courtyard: { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 }, source: 'missing' };
}

/**
 * Convert an EasyEDA component response (the API envelope or its `result`) into pins, a footprint
 * (mm, Y up, origin = EasyEDA footprint origin), the 3D model reference and metadata.
 * Pin types are refined with inferPinTypes using a category guessed from the library tags.
 * Never throws: problems are reported in `warnings`.
 */
export function convertEasyEdaComponent(json: unknown): EasyEdaConversion {
  const warnings: string[] = [];
  const root = isRecord(json) && isRecord(json.result) ? json.result : isRecord(json) && 'dataStr' in json ? json : undefined;
  if (!root) {
    const msg = asText(getPath(json, 'message')) ?? asText(getPath(json, 'msg'));
    return { pins: [], footprint: emptyFootprint(), info: {}, warnings: [`invalid EasyEDA component data${msg ? `: ${msg}` : ''}`] };
  }
  const symHead = getPath(dataStrOf(root.dataStr), 'head');
  const symPara = getPath(symHead, 'c_para');
  const pd = isRecord(root.packageDetail) ? root.packageDetail : undefined;
  const fpHead = getPath(dataStrOf(pd?.dataStr), 'head');
  const fpPara = getPath(fpHead, 'c_para');
  const info: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    const t = asText(v);
    if (t) info[k] = t;
  };
  put('title', root.title);
  put('description', root.description);
  put('lcsc', getPath(root, 'lcsc', 'number') ?? getPath(symPara, 'Supplier Part'));
  put('mpn', getPath(symPara, 'Manufacturer Part') ?? getPath(symPara, 'BOM_Manufacturer Part'));
  put('manufacturer', getPath(symPara, 'Manufacturer') ?? getPath(symPara, 'BOM_Manufacturer'));
  put('package', getPath(symPara, 'package') ?? getPath(fpPara, 'package'));
  put('prefix', getPath(symPara, 'pre'));
  put('jlcPartClass', getPath(symPara, 'JLCPCB Part Class'));
  put('datasheet', getPath(fpPara, 'link') ?? getPath(root, 'lcsc', 'url'));
  put('footprintName', pd?.title ?? getPath(fpPara, 'package'));
  put('model3dName', getPath(fpPara, '3DModel'));
  put('symbolUuid', root.uuid);
  put('footprintUuid', pd?.uuid);
  const tags = asArray(root.tags)
    .map((t) => asText(t))
    .filter((t): t is string => !!t);
  if (tags.length) info.tags = tags.join(', ');
  if (isRecord(symPara)) for (const [k, v] of Object.entries(symPara)) put(`symbol.${k}`, v);
  if (isRecord(fpPara)) for (const [k, v] of Object.entries(fpPara)) put(`footprint.${k}`, v);

  const category = categorize(tags.join(' / '), '', `${info.title ?? ''} ${info.description ?? ''}`, info.mpn ?? '');
  const rawPins = symbolPins(root);
  if (!rawPins.length) warnings.push('symbol has no pins');
  const pins = inferPinTypes(rawPins, category === 'other' ? 'ic' : category);

  let footprint = emptyFootprint();
  let model: EasyEdaModelRef | undefined;
  if (pd) {
    const r = convertFootprint(pd, warnings);
    footprint = r.footprint;
    model = r.model;
  } else warnings.push('component has no footprint (packageDetail)');
  if (!model) warnings.push('no 3D model reference in the footprint');
  const out: EasyEdaConversion = { pins, footprint, info, warnings };
  if (model) out.model3d = model;
  return out;
}
