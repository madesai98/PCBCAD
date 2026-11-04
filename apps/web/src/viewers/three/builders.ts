import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BodyPrimitive, Board, CsgNode, EnclosureShell, FastenerSpec, MechPart, MeshData, PartDef, PcbThermalResult, SheetMetalPart, Transform3, Vec2 } from '@pcbcad/core';
import { getMaterial, toFloat32, toUint32 } from '@pcbcad/core';
import { mix } from '../common/color';
import type { ViewerTheme } from '../common/theme';
import { buildThermalImage, DEFAULT_PCB_LAYERS, drawPcb, realisticPalette, type PcbViewport } from '../pcb/draw';
import { buildPcbScene, type PcbScene } from '../pcb/scene';

const DEG = Math.PI / 180;

/* --------------------------------------------- materials ---------------------------------------- */

export class MaterialPool {
  private map = new Map<string, THREE.Material>();
  get<T extends THREE.Material>(key: string, make: () => T): T {
    let m = this.map.get(key) as T | undefined;
    if (!m) {
      m = make();
      this.map.set(key, m);
    }
    return m;
  }
  all(): THREE.Material[] {
    return [...this.map.values()];
  }
  dispose() {
    for (const m of this.map.values()) m.dispose();
    this.map.clear();
  }
}

/** Physically plausible material for a body primitive / mesh group colour. */
export function surfaceMaterial(pool: MaterialPool, color: string, metal: boolean, opts: { opacity?: number; rough?: number; tag?: string } = {}): THREE.MeshStandardMaterial {
  const key = `${opts.tag ?? 's'}|${color}|${metal ? 1 : 0}|${opts.opacity ?? 1}|${opts.rough ?? ''}`;
  return pool.get(key, () => {
    const c = new THREE.Color(color);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    const m = new THREE.MeshStandardMaterial({
      color: c,
      metalness: metal ? 0.92 : 0.0,
      roughness: opts.rough ?? (metal ? 0.32 : hsl.l < 0.18 ? 0.62 : 0.5),
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
      envMapIntensity: metal ? 1.0 : 0.85,
    });
    return m;
  });
}

/* ------------------------------------------- mesh data ------------------------------------------ */

/** Convert MeshData (packed or plain arrays) into one Mesh per material group. */
export function meshDataToObject(md: MeshData, materialFor: (g: MeshData['groups'][number]) => THREE.Material): THREE.Group {
  const group = new THREE.Group();
  for (const g of md.groups) {
    const pos = toFloat32(g.positions);
    if (pos.length < 9) continue;
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const idx = g.indices ? toUint32(g.indices) : null;
    if (idx && idx.length) geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const nrm = g.normals ? toFloat32(g.normals) : null;
    if (nrm && nrm.length === pos.length) geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    else if (idx && idx.length) geo = toCreasedNormals(geo, 32 * DEG);
    else geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, materialFor(g));
    mesh.name = g.name ?? '';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** Keep only position+normal, non-indexed (so heterogeneous geometries can be merged). */
function normalizeGeo(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let out = g.index ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
  out.morphAttributes = {};
  out.clearGroups();
  return out;
}

function mergeOrEmpty(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const list = geos.map(normalizeGeo);
  if (!list.length) return new THREE.BufferGeometry();
  const merged = list.length === 1 ? list[0] : mergeGeometries(list, false) ?? list[0];
  if (merged !== list[0]) list.forEach((g) => g.dispose());
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/* --------------------------------------------- shapes ------------------------------------------- */

function roundedRectShape(w: number, h: number, r: number, cx = 0, cy = 0): THREE.Shape {
  const s = new THREE.Shape();
  roundedRectPath(s, w, h, r, cx, cy);
  return s;
}

function roundedRectPath(p: THREE.Path, w: number, h: number, r: number, cx = 0, cy = 0) {
  r = Math.max(0, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3));
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  p.moveTo(x0 + r, y0);
  p.lineTo(x0 + w - r, y0);
  if (r > 0) p.absarc(x0 + w - r, y0 + r, r, -Math.PI / 2, 0, false);
  p.lineTo(x0 + w, y0 + h - r);
  if (r > 0) p.absarc(x0 + w - r, y0 + h - r, r, 0, Math.PI / 2, false);
  p.lineTo(x0 + r, y0 + h);
  if (r > 0) p.absarc(x0 + r, y0 + h - r, r, Math.PI / 2, Math.PI, false);
  p.lineTo(x0, y0 + r);
  if (r > 0) p.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
}

function circlePath(cx: number, cy: number, r: number): THREE.Path {
  const p = new THREE.Path();
  p.absarc(cx, cy, r, 0, Math.PI * 2, true);
  return p;
}

function polyShape(points: Vec2[]): THREE.Shape {
  return new THREE.Shape(points.map((p) => new THREE.Vector2(p[0], p[1])));
}

function extrude(shape: THREE.Shape, z0: number, z1: number, curveSegments = 16): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(1e-3, z1 - z0), bevelEnabled: false, curveSegments });
  g.translate(0, 0, z0);
  return g;
}

/* ------------------------------------------ primitives ------------------------------------------ */

export function primitiveGeometry(p: BodyPrimitive): THREE.BufferGeometry {
  if (p.kind === 'box') {
    const [w, l, h] = p.size;
    const r = p.radius ? Math.min(p.radius, w / 2, l / 2, h / 2) * 0.999 : 0;
    const g = r > 0.01 ? new RoundedBoxGeometry(w, l, h, 2, r) : new THREE.BoxGeometry(w, l, h);
    if (p.rotation) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(p.rotation[0] * DEG, p.rotation[1] * DEG, p.rotation[2] * DEG, 'XYZ')));
    g.translate(p.center[0], p.center[1], p.center[2]);
    return g;
  }
  if (p.kind === 'cylinder') {
    const g = new THREE.CylinderGeometry(p.radius, p.radius, p.height, p.segments ?? 24);
    if (p.axis === 'z') g.rotateX(Math.PI / 2);
    else if (p.axis === 'x') g.rotateZ(-Math.PI / 2);
    g.translate(p.center[0], p.center[1], p.center[2]);
    return g;
  }
  return extrude(polyShape(p.points), p.z0, p.z1, 8);
}

/* --------------------------------------------- boards ------------------------------------------- */

export interface BoardBuild {
  group: THREE.Group;
  pickables: THREE.Mesh[];
  /** Component bounding boxes in the board frame. */
  compBoxes: Map<string, THREE.Box3>;
  pcb: PcbScene;
  setThermal(r: PcbThermalResult | null): void;
  dispose(): void;
}

interface TexturePair {
  color: THREE.CanvasTexture;
  rm: THREE.CanvasTexture;
}

function boardTextures(pcb: PcbScene, side: 'top' | 'bottom', theme: ViewerTheme, thermal: PcbThermalResult | null, maxAniso: number): TexturePair {
  const b = pcb.bbox;
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxY - b.minY);
  const ppm = Math.max(6, Math.min(22, 4096 / Math.max(w, h)));
  const W = Math.ceil(w * ppm);
  const H = Math.ceil(h * ppm);
  const vp: PcbViewport = { a: ppm, d: -ppm, e: -b.minX * ppm, f: b.maxY * ppm, width: W, height: H, dpr: 1 };
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  let buffer: CanvasRenderingContext2D | null = null;
  const thermalImg = thermal && side === 'top' ? buildThermalImage(thermal, 'top') : null;
  drawPcb(ctx, pcb, vp, {
    mode: 'realistic',
    layers: { ...DEFAULT_PCB_LAYERS, ratsnest: false, courtyard: false },
    side,
    theme,
    background: false,
    thermal: thermalImg,
    thermalOpaque: true,
    buffer: () => {
      if (!buffer) {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        buffer = c.getContext('2d');
      }
      return buffer;
    },
  });
  // Roughness (G) / metalness (B) map: exposed pads are shiny metal, soldermask is a glossy dielectric.
  const rmCanvas = document.createElement('canvas');
  rmCanvas.width = W;
  rmCanvas.height = H;
  const r = rmCanvas.getContext('2d')!;
  r.fillStyle = thermalImg ? 'rgb(0,150,0)' : 'rgb(0,105,0)';
  r.fillRect(0, 0, W, H);
  if (!thermalImg) {
    r.setTransform(vp.a, 0, 0, vp.d, vp.e, vp.f);
    r.fillStyle = 'rgb(0,72,255)';
    r.fill(pcb.padPaths[side]);
    r.fill(pcb.padPaths.through);
    r.fill(pcb.holeRings);
  }
  const color = new THREE.CanvasTexture(canvas);
  color.colorSpace = THREE.SRGBColorSpace;
  color.anisotropy = maxAniso;
  const rm = new THREE.CanvasTexture(rmCanvas);
  rm.colorSpace = THREE.NoColorSpace;
  rm.anisotropy = maxAniso;
  return { color, rm };
}

function shapeUVs(geo: THREE.BufferGeometry, minX: number, minY: number, w: number, h: number) {
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - minX) / w;
    uv[i * 2 + 1] = (pos.getY(i) - minY) / h;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export interface BoardBuildContext {
  pool: MaterialPool;
  theme: ViewerTheme;
  maxAniso: number;
  getMesh: (key: string) => Promise<MeshData | null>;
  /** Called after async content (component meshes) is added. */
  onAsync: () => void;
}

export function buildBoard(board: Board, parts: Record<string, PartDef>, ctx: BoardBuildContext): BoardBuild {
  const pcb = buildPcbScene(board, parts);
  const group = new THREE.Group();
  group.name = `board:${board.id}`;
  const t = board.stackup?.thickness ?? 1.6;
  const disposables: { dispose(): void }[] = [];
  const pickables: THREE.Mesh[] = [];
  const compBoxes = new Map<string, THREE.Box3>();
  let disposed = false;

  /* outline shape with holes */
  const b = pcb.bbox;
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const shape = pcb.hasOutline ? polyShape(board.outline) : roundedRectShape(bw, bh, 0, b.minX + bw / 2, b.minY + bh / 2);
  for (const cut of board.cutouts ?? []) if (cut.length >= 3) shape.holes.push(new THREE.Path(cut.map((p) => new THREE.Vector2(p[0], p[1]))));
  for (const hole of board.holes) shape.holes.push(circlePath(hole.x, hole.y, hole.drill / 2));
  let drillCount = 0;
  for (const p of pcb.pads) {
    if (!p.drill || drillCount > 400 || pcb.comps[p.comp].staged) continue;
    const d = Math.min(p.drill.w, p.drill.h);
    if (d < 0.5) continue;
    shape.holes.push(circlePath(p.drill.x, p.drill.y, d / 2));
    drillCount++;
  }

  const rp = realisticPalette(board.stackup);
  const edgeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(mix('#c9b67c', rp.mask, 0.32)), roughness: 0.78, metalness: 0 });
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  const body = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 10 });
  const bodyMesh = new THREE.Mesh(body, [hidden, edgeMat]);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  disposables.push(body, edgeMat, hidden);

  const faceTop = new THREE.ShapeGeometry(shape, 10);
  shapeUVs(faceTop, b.minX, b.minY, bw, bh);
  const faceBottom = faceTop.clone();
  // Flip winding + normals for the downward-facing face (UVs stay in board frame → correctly mirrored).
  const idx = faceBottom.getIndex();
  if (idx) {
    const arr = idx.array as Uint16Array | Uint32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const tmp = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = tmp;
    }
    idx.needsUpdate = true;
  }
  const nb = faceBottom.getAttribute('normal');
  for (let i = 0; i < nb.count; i++) nb.setXYZ(i, 0, 0, -1);
  disposables.push(faceTop, faceBottom);

  const makeFaceMat = (tex: TexturePair) =>
    new THREE.MeshPhysicalMaterial({ map: tex.color, roughnessMap: tex.rm, metalnessMap: tex.rm, roughness: 1, metalness: 1, clearcoat: 0.35, clearcoatRoughness: 0.32 });
  let topTex = boardTextures(pcb, 'top', ctx.theme, null, ctx.maxAniso);
  const botTex = boardTextures(pcb, 'bottom', ctx.theme, null, ctx.maxAniso);
  const topMat = makeFaceMat(topTex);
  const botMat = makeFaceMat(botTex);
  disposables.push(botTex.color, botTex.rm, topMat, botMat);
  const topMesh = new THREE.Mesh(faceTop, topMat);
  topMesh.position.z = t + 0.004;
  topMesh.receiveShadow = true;
  const botMesh = new THREE.Mesh(faceBottom, botMat);
  botMesh.position.z = -0.004;
  botMesh.receiveShadow = true;
  for (const m of [bodyMesh, topMesh, botMesh]) {
    m.userData.pick = { kind: 'board', boardId: board.id };
    pickables.push(m);
    group.add(m);
  }

  /* components */
  type Bucket = { color: string; metal: boolean; geos: THREE.BufferGeometry[]; ranges: { start: number; count: number; compId: string }[]; tris: number };
  const buckets = new Map<string, Bucket>();
  const compMatrix = (cIdx: number) => {
    const c = pcb.comps[cIdx].placedAs;
    const part = pcb.comps[cIdx].part;
    const m = new THREE.Matrix4().makeTranslation(c.x, c.y, c.side === 'bottom' ? 0 : t);
    m.multiply(new THREE.Matrix4().makeRotationZ((c.rotation || 0) * DEG));
    if (c.side === 'bottom') m.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
    const md = part?.model3d;
    if (md?.offset || md?.rotation) {
      const o = md.offset ?? [0, 0, 0];
      const r = md.rotation ?? [0, 0, 0];
      m.multiply(new THREE.Matrix4().compose(new THREE.Vector3(o[0], o[1], o[2]), new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ')), new THREE.Vector3(1, 1, 1)));
    }
    return m;
  };
  const addBox = (compId: string, box: THREE.Box3) => {
    const prev = compBoxes.get(compId);
    if (prev) prev.union(box);
    else compBoxes.set(compId, box.clone());
  };
  const addPrims = (compId: string, prims: BodyPrimitive[], m: THREE.Matrix4) => {
    for (const p of prims) {
      const geo = normalizeGeo(primitiveGeometry(p));
      geo.applyMatrix4(m);
      geo.computeBoundingBox();
      addBox(compId, geo.boundingBox!);
      const key = `${p.color}|${p.metal ? 1 : 0}`;
      let bk = buckets.get(key);
      if (!bk) buckets.set(key, (bk = { color: p.color, metal: !!p.metal, geos: [], ranges: [], tris: 0 }));
      const tris = geo.getAttribute('position').count / 3;
      const last = bk.ranges[bk.ranges.length - 1];
      if (last && last.compId === compId && last.start + last.count === bk.tris) last.count += tris;
      else bk.ranges.push({ start: bk.tris, count: tris, compId });
      bk.tris += tris;
      bk.geos.push(geo);
    }
  };
  const fallbackPrims = (cIdx: number): BodyPrimitive[] => {
    const sc = pcb.comps[cIdx];
    const part = sc.part;
    if (!sc.pads.length && !part?.body) return [];
    const body = part?.body;
    if (body) return [{ kind: 'box', center: [0, 0, body.h / 2], size: [body.w, body.l, body.h], color: '#2a2c31', radius: Math.min(0.3, body.h / 4) }];
    const fp = sc.fp;
    if (!fp) return [{ kind: 'box', center: [0, 0, 0.5], size: [2, 2, 1], color: '#3a3d44' }];
    const cw = (fp.courtyard.maxX - fp.courtyard.minX) * 0.8;
    const cl = (fp.courtyard.maxY - fp.courtyard.minY) * 0.8;
    return [{ kind: 'box', center: [(fp.courtyard.maxX + fp.courtyard.minX) / 2, (fp.courtyard.maxY + fp.courtyard.minY) / 2, 0.5], size: [cw, cl, 1], color: '#3a3d44', radius: 0.15 }];
  };

  pcb.comps.forEach((sc, cIdx) => {
    if (sc.staged || sc.comp.dnp) return;
    const part = sc.part;
    const m = compMatrix(cIdx);
    const md = part?.model3d;
    if (md?.kind === 'primitives' && md.primitives?.length) addPrims(sc.comp.id, md.primitives, m);
    else if (md?.kind === 'mesh' && md.meshAssetId) {
      const id = sc.comp.id;
      ctx
        .getMesh(md.meshAssetId)
        .catch(() => null)
        .then((data) => {
          if (disposed) return;
          if (!data) {
            // Fallback body as its own (unmerged) mesh.
            const prims = fallbackPrims(cIdx);
            if (!prims.length) return;
            const geos = prims.map((p) => normalizeGeo(primitiveGeometry(p)));
            const geo = mergeOrEmpty(geos);
            geo.applyMatrix4(m);
            geo.computeBoundingBox();
            const mesh = new THREE.Mesh(geo, surfaceMaterial(ctx.pool, prims[0].color, false));
            mesh.castShadow = true;
            mesh.userData.pick = { kind: 'component', boardId: board.id, compId: id };
            disposables.push(geo);
            addBox(id, geo.boundingBox!);
            group.add(mesh);
            pickables.push(mesh);
          } else {
            const obj = meshDataToObject(data, (g) => surfaceMaterial(ctx.pool, g.color || '#3a3d44', !!g.metal, { opacity: g.opacity }));
            obj.applyMatrix4(m);
            obj.updateMatrixWorld(true);
            obj.traverse((o) => {
              if ((o as THREE.Mesh).isMesh) {
                const mesh = o as THREE.Mesh;
                mesh.userData.pick = { kind: 'component', boardId: board.id, compId: id };
                pickables.push(mesh);
                disposables.push(mesh.geometry);
              }
            });
            addBox(id, new THREE.Box3().setFromObject(obj));
            group.add(obj);
          }
          ctx.onAsync();
        });
    } else addPrims(sc.comp.id, fallbackPrims(cIdx), m);
  });

  for (const bk of buckets.values()) {
    const merged = mergeOrEmpty(bk.geos);
    const mat = surfaceMaterial(ctx.pool, bk.color, bk.metal);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.pick = { kind: 'components', boardId: board.id, ranges: bk.ranges };
    disposables.push(merged);
    pickables.push(mesh);
    group.add(mesh);
  }

  return {
    group,
    pickables,
    compBoxes,
    pcb,
    setThermal(r) {
      const next = boardTextures(pcb, 'top', ctx.theme, r && r.boardId === board.id ? r : null, ctx.maxAniso);
      topMat.map = next.color;
      topMat.roughnessMap = next.rm;
      topMat.metalnessMap = next.rm;
      topMat.clearcoat = r ? 0.1 : 0.35;
      topMat.needsUpdate = true;
      topTex.color.dispose();
      topTex.rm.dispose();
      topTex = next;
    },
    dispose() {
      disposed = true;
      topTex.color.dispose();
      topTex.rm.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}

/** Component index for a merged-components raycast hit. */
export function compForFace(ranges: { start: number; count: number; compId: string }[], faceIndex: number): string | null {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (faceIndex < r.start) hi = mid - 1;
    else if (faceIndex >= r.start + r.count) lo = mid + 1;
    else return r.compId;
  }
  return null;
}

/* ------------------------------------ mechanical part fallbacks --------------------------------- */

export function mechColor(part: MechPart): { color: string; metal: boolean; rough: number } {
  const mat = getMaterial(part.materialId);
  const metal = mat?.family === 'metal' || part.process === 'sheet-metal' || part.process === 'die-casting';
  const finish = String(part.processOptions?.finish ?? '');
  const color = part.color ?? (finish.includes('black') ? '#2b2e33' : mat?.color) ?? (metal ? '#b8bec6' : '#d9dce1');
  const rough = metal ? (finish.includes('anodized') || finish.includes('powder') ? 0.55 : 0.36) : 0.58;
  return { color, metal: metal && !finish.includes('powder'), rough };
}

function shellGeometry(p: EnclosureShell): THREE.BufferGeometry {
  const { width: w, depth: d, height: h } = p.outer;
  const wall = Math.max(0.5, p.wall);
  const r = p.cornerRadius;
  const geos: THREE.BufferGeometry[] = [];
  geos.push(extrude(roundedRectShape(w, d, r), 0, wall));
  const ring = roundedRectShape(w, d, r);
  ring.holes.push(roundedRectPath2(w - 2 * wall, d - 2 * wall, Math.max(0, r - wall)));
  geos.push(extrude(ring, wall, h));
  for (const b of p.bosses) {
    const s = new THREE.Shape();
    s.absarc(b.x, b.y, b.outerDiameter / 2, 0, Math.PI * 2, false);
    if (b.holeDiameter > 0) s.holes.push(circlePath(b.x, b.y, b.holeDiameter / 2));
    geos.push(extrude(s, wall, wall + b.height, 20));
  }
  for (const rib of p.ribs) {
    const len = Math.hypot(rib.to[0] - rib.from[0], rib.to[1] - rib.from[1]);
    const g = new THREE.BoxGeometry(len, rib.thickness, rib.height);
    g.rotateZ(Math.atan2(rib.to[1] - rib.from[1], rib.to[0] - rib.from[0]));
    g.translate((rib.from[0] + rib.to[0]) / 2, (rib.from[1] + rib.to[1]) / 2, wall + rib.height / 2);
    geos.push(g);
  }
  return mergeOrEmpty(geos);
}

function roundedRectPath2(w: number, h: number, r: number): THREE.Path {
  const p = new THREE.Path();
  roundedRectPath(p, w, h, r);
  return p;
}

function sheetGeometry(p: SheetMetalPart): THREE.BufferGeometry {
  const t = p.thickness;
  const { width: W, length: L } = p.base;
  const base = roundedRectShape(W, L, p.base.cornerRadius ?? 0);
  for (const h of p.holes) {
    if (h.shape === 'circle' && h.diameter) base.holes.push(circlePath(h.x, h.y, h.diameter / 2));
    else if (h.width && h.height) base.holes.push(roundedRectPath2Offset(h.width, h.height, h.shape === 'slot' ? Math.min(h.width, h.height) / 2 : 0, h.x, h.y));
  }
  const geos: THREE.BufferGeometry[] = [extrude(base, 0, t)];
  for (const f of p.flanges) {
    if (f.edge === 'far') continue;
    const along = f.edge === '+x' || f.edge === '-x' ? L : W;
    const fw = f.width ?? along;
    const g = new THREE.BoxGeometry(fw, t, f.length);
    // Build standing up from the edge (local: X along edge, Y thickness, Z up), then bend by angle.
    g.translate(0, -t / 2, f.length / 2);
    g.rotateX(-(90 - f.angle) * DEG);
    const off = f.offset ?? 0;
    const m = new THREE.Matrix4();
    if (f.edge === '+y') m.makeTranslation(off, L / 2, 0).multiply(new THREE.Matrix4().makeRotationZ(0));
    else if (f.edge === '-y') m.makeTranslation(off, -L / 2, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI));
    else if (f.edge === '+x') m.makeTranslation(W / 2, off, 0).multiply(new THREE.Matrix4().makeRotationZ(-Math.PI / 2));
    else m.makeTranslation(-W / 2, off, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
    g.applyMatrix4(m);
    geos.push(g);
  }
  return mergeOrEmpty(geos);
}

function roundedRectPath2Offset(w: number, h: number, r: number, cx: number, cy: number): THREE.Path {
  const p = new THREE.Path();
  roundedRectPath(p, w, h, r, cx, cy);
  return p;
}

function applyT(g: THREE.BufferGeometry, t?: Transform3) {
  if (!t) return g;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...t.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'XYZ')),
    new THREE.Vector3(1, 1, 1),
  );
  g.applyMatrix4(m);
  return g;
}

/** Visual approximation of a CSG tree (unions only; subtractions keep their first operand). */
function csgGeometry(node: CsgNode, out: THREE.BufferGeometry[] = []): THREE.BufferGeometry[] {
  if ('op' in node) {
    const kids = node.op === 'union' ? node.children : node.children.slice(0, 1);
    const sub: THREE.BufferGeometry[] = [];
    for (const k of kids) csgGeometry(k, sub);
    for (const g of sub) out.push(applyT(g, node.transform));
    return out;
  }
  let g: THREE.BufferGeometry;
  switch (node.shape) {
    case 'box': {
      const [x, y, z] = node.size;
      g = node.radius ? new RoundedBoxGeometry(x, y, z, 2, Math.min(node.radius, x / 2, y / 2, z / 2) * 0.99) : new THREE.BoxGeometry(x, y, z);
      if (!node.center) g.translate(x / 2, y / 2, z / 2);
      break;
    }
    case 'cylinder':
      g = new THREE.CylinderGeometry(node.radiusTop ?? node.radius, node.radius, node.height, node.segments ?? 32);
      g.rotateX(Math.PI / 2);
      if (!node.center) g.translate(0, 0, node.height / 2);
      break;
    case 'sphere':
      g = new THREE.SphereGeometry(node.radius, 32, 16);
      break;
    case 'extrude':
      g = extrude(polyShape(node.points), 0, node.height);
      break;
    case 'revolve': {
      g = new THREE.LatheGeometry(
        node.profile.map((p) => new THREE.Vector2(Math.max(0, p[0]), p[1])),
        node.segments ?? 48,
      );
      g.rotateX(Math.PI / 2);
      break;
    }
  }
  out.push(applyT(g, node.transform));
  return out;
}

/** Local-frame placeholder geometry for a mechanical part (until/unless the server mesh arrives). */
export function mechFallbackGeometry(p: MechPart): THREE.BufferGeometry {
  switch (p.kind) {
    case 'enclosure-shell':
      return shellGeometry(p);
    case 'sheet-metal':
      return sheetGeometry(p);
    case 'purchased': {
      const [x, y, z] = p.envelope;
      const g = new RoundedBoxGeometry(x, y, z, 2, Math.min(x, y, z) * 0.06);
      g.translate(0, 0, z / 2);
      return mergeOrEmpty([g]);
    }
    case 'custom':
      return mergeOrEmpty(csgGeometry(p.csg));
  }
}

/* -------------------------------------------- fasteners ------------------------------------------ */

const SCREWS = new Set(['screw', 'self-tapping-screw', 'bolt', 'rivet']);

export function fastenerLength(spec: FastenerSpec): number {
  const d = spec.diameter > 0 ? spec.diameter : 3;
  if (spec.length) return spec.length;
  switch (spec.type) {
    case 'nut':
    case 'pem-nut':
      return 0.8 * d;
    case 'washer':
      return Math.max(0.3, 0.17 * d);
    case 'standoff':
    case 'pem-standoff':
      return 10;
    case 'heat-set-insert':
      return d <= 2.05 ? 4 : d <= 2.55 ? 4.5 : d <= 3.05 ? 5 : 6;
    default:
      return 3 * d;
  }
}

export function isScrewType(spec: FastenerSpec): boolean {
  return SCREWS.has(spec.type);
}

function hexShape(af: number): THREE.Shape {
  const r = af / Math.sqrt(3);
  const s = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6;
    if (i === 0) s.moveTo(r * Math.cos(a), r * Math.sin(a));
    else s.lineTo(r * Math.cos(a), r * Math.sin(a));
  }
  s.closePath();
  return s;
}

function ringShape(outer: THREE.Shape, holeR: number): THREE.Shape {
  if (holeR > 0) outer.holes.push(circlePath(0, 0, holeR));
  return outer;
}

function circleShape(r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  return s;
}

function knurlShape(od: number, depth: number): THREE.Shape {
  const s = new THREE.Shape();
  const n = 28;
  for (let i = 0; i <= n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const r = i % 2 ? od / 2 - depth : od / 2;
    if (i === 0) s.moveTo(r * Math.cos(a), r * Math.sin(a));
    else s.lineTo(r * Math.cos(a), r * Math.sin(a));
  }
  return s;
}

function lathe(profile: [number, number][], seg = 28): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    profile.map(([r, z]) => new THREE.Vector2(Math.max(0, r), z)),
    seg,
  );
  g.rotateX(Math.PI / 2); // lathe axis Y → Z
  return g;
}

/** Procedural fastener in the shared local frame (+Z = insertion; screws: bearing face at z = 0). */
export function fastenerGeometry(spec: FastenerSpec): THREE.BufferGeometry {
  const d = spec.diameter > 0 ? spec.diameter : 3;
  const L = fastenerLength(spec);
  const geos: THREE.BufferGeometry[] = [];
  switch (spec.type) {
    case 'nut':
      geos.push(extrude(ringShape(hexShape(spec.outerDiameter ?? 1.6 * d + 0.7), d / 2), 0, L, 24));
      break;
    case 'washer':
      geos.push(extrude(ringShape(circleShape((spec.outerDiameter ?? 2.1 * d + 0.7) / 2), (d + 0.2) / 2), 0, L, 32));
      break;
    case 'standoff': {
      const od = spec.outerDiameter ?? (d <= 2.5 ? d + 1.5 : d <= 3 ? 5 : 1.6 * d);
      geos.push(extrude(ringShape(hexShape(od), d / 2), 0, L, 24));
      const stud = Math.min(2 * d, 6);
      if (spec.ends === 'male-female' || spec.ends === 'male-male') geos.push(lathe([[0, L], [d / 2, L], [d / 2, L + stud], [0, L + stud]]));
      if (spec.ends === 'male-male') geos.push(lathe([[0, -stud], [d / 2, -stud], [d / 2, 0], [0, 0]]));
      break;
    }
    case 'pem-standoff':
    case 'pem-nut': {
      const od = spec.outerDiameter ?? 1.45 * d + 1.2;
      geos.push(extrude(ringShape(circleShape(od / 2), d / 2), 0, L, 28));
      geos.push(extrude(ringShape(circleShape(od / 2 + 0.6), d / 2), -1.0, 0, 28));
      break;
    }
    case 'heat-set-insert': {
      const od = spec.outerDiameter ?? (d <= 2.05 ? 3.6 : d <= 2.55 ? 4.0 : d <= 3.05 ? 4.6 : 5.6);
      const kd = Math.min(0.25, 0.06 * od);
      geos.push(extrude(ringShape(knurlShape(od, kd), d / 2), 0, 0.42 * L, 4));
      geos.push(extrude(ringShape(circleShape(od / 2 - kd * 1.5), d / 2), 0.42 * L, 0.58 * L, 24));
      geos.push(extrude(ringShape(knurlShape(od, kd), d / 2), 0.58 * L, L, 4));
      break;
    }
    default: {
      const head = spec.head ?? (spec.type === 'bolt' ? 'hex' : spec.type === 'rivet' ? 'button' : 'pan');
      const hd = spec.headDiameter ?? (head === 'socket' ? 1.5 * d : head === 'flat' ? 2 * d : head === 'hex' ? 1.6 * d + 0.7 : 1.9 * d);
      const hh = spec.headHeight ?? ({ pan: 0.6 * d, socket: d, button: 0.55 * d, flat: Math.max(0.3 * d, (hd - d) / 2), hex: 0.65 * d, none: 0 } as Record<string, number>)[head] ?? 0.6 * d;
      const r = hd / 2;
      const pointed = spec.type === 'self-tapping-screw';
      const tip = pointed ? Math.min(0.9 * d, 0.4 * L) : Math.min(0.12 * d, 0.2 * L);
      const shank: [number, number][] = [
        [d / 2, 0],
        [d / 2, L - tip],
        [pointed ? 0.18 * d : d / 2 - tip, L],
        [0, L],
      ];
      if (head === 'hex') {
        const hx = extrude(hexShape(hd), -hh, 0, 6);
        geos.push(hx, lathe([[0, 0], ...shank]));
      } else if (head === 'flat') {
        geos.push(lathe([[0, -hh], [r, -hh], [r, -hh + 0.06 * hh], ...shank]));
      } else if (head === 'none') {
        geos.push(lathe([[0, 0], ...shank]));
      } else {
        const prof: [number, number][] = [[0, -hh]];
        const n = 8;
        if (head === 'button') for (let k = 1; k <= n; k++) prof.push([r * Math.sin(((k / n) * Math.PI) / 2), -hh * Math.cos(((k / n) * Math.PI) / 2) * 0.9 - 0.1 * hh]);
        else if (head === 'socket') prof.push([r * 0.92, -hh], [r, -hh + 0.08 * hh]);
        else {
          const f = 0.35 * hh;
          for (let k = 0; k <= n; k++) prof.push([r - f + f * Math.sin(((k / n) * Math.PI) / 2), -hh + f - f * Math.cos(((k / n) * Math.PI) / 2)]);
        }
        prof.push([r, 0], ...shank);
        geos.push(lathe(prof));
        // Drive recess hint (dark ring) is left to the material; keep geometry light.
      }
    }
  }
  return mergeOrEmpty(geos);
}

/** Basis that maps local +Z to `dir` (same convention as the server's fastenerPlacement). */
export function fastenerQuaternion(dir: THREE.Vector3): THREE.Quaternion {
  const z = dir.clone().normalize();
  const ref = Math.abs(z.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const x = new THREE.Vector3().crossVectors(ref, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

export function fastenerMaterialColor(spec: FastenerSpec): { color: string; metal: boolean } {
  const m = getMaterial(spec.materialId);
  const color = m?.color && m.color !== '#ffffff' ? m.color : spec.materialId.includes('brass') ? '#c9a24a' : spec.materialId.includes('nylon') ? '#ece9df' : '#b9bfc7';
  return { color, metal: (m?.family ?? 'metal') === 'metal' };
}
