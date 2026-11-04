import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Assembly, EnclosureShell, FastenerSpec, MechPart, MeshData, MeshGroup, PartDef, SheetMetalPart } from '@pcbcad/core';
import { pack } from '@pcbcad/core';

/* ------------------------------------------- mech parts ------------------------------------------ */

const BOSS_XY: [number, number][] = [
  [-26.5, -16.5],
  [26.5, -16.5],
  [-26.5, 16.5],
  [26.5, 16.5],
];
const CORNER_XY: [number, number][] = [
  [-31, -21],
  [31, -21],
  [-31, 21],
  [31, 21],
];

export function demoMech(): MechPart[] {
  const base: EnclosureShell = {
    id: 'shell-base',
    kind: 'enclosure-shell',
    name: 'Enclosure base',
    materialId: 'pc-abs',
    process: 'injection-molding',
    processOptions: { texture: 'MT-11010', gate: 'edge', cavities: 1 },
    color: '#e9ebee',
    role: 'base',
    outer: { width: 70, depth: 50, height: 16 },
    wall: 2,
    cornerRadius: 5,
    draftDeg: 1,
    lip: { kind: 'groove', height: 1.2, thickness: 1 },
    bosses: [
      ...BOSS_XY.map(([x, y], i) => ({ id: `b${i}`, x, y, outerDiameter: 6.2, holeDiameter: 4.0, height: 5, kind: 'insert' as const, gussets: 2 })),
      ...CORNER_XY.map(([x, y], i) => ({ id: `c${i}`, x, y, outerDiameter: 6, holeDiameter: 3.4, height: 14, kind: 'clearance' as const, throughFloor: true })),
    ],
    ribs: [],
    cutouts: [{ id: 'usb', face: '-x', shape: 'rounded-rect', u: 0, v: 10.2, width: 9.6, height: 3.8, radius: 1.2, purpose: 'connector', linked: { boardId: 'brd_main', componentId: 'cmp_main_j1' } }],
    vents: [{ id: 'v1', face: '-y', u: 0, v: 5, slotWidth: 1.6, slotLength: 8, count: 9, pitch: 3.2, orientation: 'v' }],
    snaps: [],
    matesWith: 'shell-cover',
  };
  const cover: EnclosureShell = {
    id: 'shell-cover',
    kind: 'enclosure-shell',
    name: 'Enclosure cover',
    materialId: 'pc-abs',
    process: 'injection-molding',
    color: '#2f3640',
    role: 'cover',
    outer: { width: 70, depth: 50, height: 8 },
    wall: 2,
    cornerRadius: 5,
    draftDeg: 1,
    lip: { kind: 'lip', height: 1.2, thickness: 1 },
    bosses: CORNER_XY.map(([x, y], i) => ({ id: `s${i}`, x, y, outerDiameter: 6, holeDiameter: 2.5, height: 6, kind: 'screw' as const })),
    ribs: [],
    cutouts: [{ id: 'lp', face: 'floor', shape: 'circle', u: 9.5, v: -14.5, width: 3, height: 3, purpose: 'led' }],
    vents: [{ id: 'v2', face: 'floor', u: -14, v: 8, slotWidth: 1.6, slotLength: 14, count: 8, pitch: 3.2, orientation: 'v' }],
    snaps: [],
    matesWith: 'shell-base',
  };
  const bracket: SheetMetalPart = {
    id: 'bracket',
    kind: 'sheet-metal',
    name: 'Wall bracket',
    materialId: 'al-5052-h32',
    process: 'sheet-metal',
    processOptions: { finish: 'anodized-black' },
    color: '#30343a',
    thickness: 1.5,
    bendRadius: 1.5,
    kFactor: 0.42,
    base: { width: 96, length: 34, cornerRadius: 3 },
    holes: [
      { id: 'h1', x: -42, y: 0, shape: 'slot', width: 8, height: 4.5 },
      { id: 'h2', x: 42, y: 0, shape: 'slot', width: 8, height: 4.5 },
      { id: 'h3', x: -20, y: 0, shape: 'circle', diameter: 3.4 },
      { id: 'h4', x: 20, y: 0, shape: 'circle', diameter: 3.4 },
    ],
    flanges: [
      { id: 'f1', edge: '+y', length: 7, angle: -90, width: 60 },
      { id: 'f2', edge: '-y', length: 7, angle: -90, width: 60 },
    ],
    reliefs: 'obround',
  };
  return [base, cover, bracket];
}

export function demoAssembly(): Assembly {
  const fasteners: Assembly['fasteners'] = [];
  BOSS_XY.forEach(([x, y], i) => {
    fasteners.push({ id: `fs_board_${i}`, partId: 'fst-m3-pan-6', position: [x, y, 8.6], direction: [0, 0, -1], joins: ['inst_main', 'inst_base'] });
    fasteners.push({ id: `fs_insert_${i}`, partId: 'fst-insert-m3', position: [x, y, 4.5], direction: [0, 0, -1], joins: ['inst_base'] });
  });
  CORNER_XY.forEach(([x, y], i) => fasteners.push({ id: `fs_cover_${i}`, partId: 'fst-m3-pan-20', position: [x, y, 0], direction: [0, 0, 1], joins: ['inst_base', 'inst_cover'] }));
  [-20, 20].forEach((x, i) => fasteners.push({ id: `fs_bracket_${i}`, partId: 'fst-m3-flat-8', position: [x, 0, -1.5], direction: [0, 0, 1], joins: ['inst_bracket', 'inst_base'] }));
  return {
    instances: [
      { id: 'inst_base', name: 'Enclosure base', target: { kind: 'mech', partId: 'shell-base' }, transform: { position: [0, 0, 0], rotation: [0, 0, 0] } },
      { id: 'inst_main', name: 'Main board', target: { kind: 'board', boardId: 'brd_main' }, transform: { position: [-30, -20, 7], rotation: [0, 0, 0] } },
      { id: 'inst_cover', name: 'Enclosure cover', target: { kind: 'mech', partId: 'shell-cover' }, transform: { position: [0, 0, 24], rotation: [180, 0, 0] } },
      { id: 'inst_bracket', name: 'Wall bracket', target: { kind: 'mech', partId: 'bracket' }, transform: { position: [0, 0, -1.5], rotation: [0, 0, 0] } },
    ],
    fasteners,
  };
}

function fastenerPart(id: string, mpn: string, description: string, spec: FastenerSpec): PartDef {
  return {
    id,
    mpn,
    manufacturer: 'Generic',
    description,
    category: 'fastener',
    package: spec.thread ?? '',
    params: {},
    offers: [{ distributor: 'McMaster', sku: mpn }],
    pins: [],
    fastener: spec,
    provenance: { specs: 'builtin', symbol: 'missing', footprint: 'missing', model3d: 'generated', sim: 'missing', source: 'demo' },
  };
}

export function demoFastenerParts(): PartDef[] {
  return [
    fastenerPart('fst-m3-pan-6', '92000A116', 'M3×6 pan head Phillips, zinc steel', { type: 'screw', thread: 'M3', diameter: 3, length: 6, head: 'pan', drive: 'phillips', materialId: 'steel-zinc' }),
    fastenerPart('fst-m3-pan-20', '92000A124', 'M3×20 pan head Phillips, zinc steel', { type: 'screw', thread: 'M3', diameter: 3, length: 20, head: 'pan', drive: 'phillips', materialId: 'steel-zinc' }),
    fastenerPart('fst-m3-flat-8', '92010A118', 'M3×8 flat head, stainless A2', { type: 'screw', thread: 'M3', diameter: 3, length: 8, head: 'flat', drive: 'hex', materialId: 'ss-a2' }),
    fastenerPart('fst-insert-m3', '94180A333', 'M3 heat-set insert, brass, 5 mm', { type: 'heat-set-insert', thread: 'M3', diameter: 3, length: 5, outerDiameter: 4.6, holeDiameter: 4.0, materialId: 'brass' }),
    fastenerPart('fst-standoff-m25', '95947A010', 'M2.5×10 nylon standoff', { type: 'standoff', thread: 'M2.5', diameter: 2.5, length: 10, outerDiameter: 5, materialId: 'nylon-66', ends: 'female-female' }),
  ];
}

/* ----------------------------------- procedural mesh "server" ------------------------------------ */

function rrShape(w: number, h: number, r: number, cx = 0, cy = 0, path: THREE.Path = new THREE.Shape()): THREE.Path {
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  r = Math.min(r, w / 2 - 0.01, h / 2 - 0.01);
  path.moveTo(x0 + r, y0);
  path.lineTo(x0 + w - r, y0);
  path.absarc(x0 + w - r, y0 + r, r, -Math.PI / 2, 0, false);
  path.lineTo(x0 + w, y0 + h - r);
  path.absarc(x0 + w - r, y0 + h - r, r, 0, Math.PI / 2, false);
  path.lineTo(x0 + r, y0 + h);
  path.absarc(x0 + r, y0 + h - r, r, Math.PI / 2, Math.PI, false);
  path.lineTo(x0, y0 + r);
  path.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
  return path;
}

function ext(shape: THREE.Shape, z0: number, z1: number, seg = 12): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false, curveSegments: seg });
  g.translate(0, 0, z0);
  return g;
}

function circle(cx: number, cy: number, r: number): THREE.Path {
  const p = new THREE.Path();
  p.absarc(cx, cy, r, 0, Math.PI * 2, true);
  return p;
}

/** A wall panel (in its own XY plane) with rectangular holes, then placed with a matrix. */
function panel(w: number, h: number, t: number, holes: { u: number; v: number; w: number; h: number; r: number }[], m: THREE.Matrix4): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, h);
  s.lineTo(-w / 2, h);
  s.closePath();
  for (const ho of holes) s.holes.push(rrShape(ho.w, ho.h, ho.r, ho.u, ho.v, new THREE.Path()));
  const g = ext(s, 0, t, 8);
  g.applyMatrix4(m);
  return g;
}

function toGroup(geos: THREE.BufferGeometry[], color: string, extra: Partial<MeshGroup> = {}): MeshGroup {
  const norm = geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    return n;
  });
  const merged = mergeGeometries(norm, false)!;
  const pos = merged.getAttribute('position').array as Float32Array;
  const nrm = merged.getAttribute('normal').array as Float32Array;
  return { color, positions: pack(new Float32Array(pos)), normals: pack(new Float32Array(nrm)), ...extra };
}

function baseMesh(p: EnclosureShell): MeshData {
  const { width: W, depth: D, height: H } = p.outer;
  const t = p.wall;
  const r = p.cornerRadius;
  const geos: THREE.BufferGeometry[] = [];
  // Floor with corner screw clearance holes.
  const floor = rrShape(W, D, r) as THREE.Shape;
  for (const [x, y] of CORNER_XY) floor.holes.push(circle(x, y, 1.7));
  geos.push(ext(floor, 0, t));
  // Side walls as four flat panels (so the USB opening and vents can be cut) + quarter-tube corners.
  const vents = Array.from({ length: 9 }, (_, i) => ({ u: (i - 4) * 3.2, v: 6, w: 1.6, h: 8, r: 0.8 }));
  const wallX = (x: number, holes: { u: number; v: number; w: number; h: number; r: number }[]) =>
    panel(D - 2 * r, H - t, t, holes, new THREE.Matrix4().makeTranslation(x, 0, t).multiply(new THREE.Matrix4().makeRotationZ(-Math.PI / 2)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
  const wallY = (y: number, holes: { u: number; v: number; w: number; h: number; r: number }[]) =>
    panel(W - 2 * r, H - t, t, holes, new THREE.Matrix4().makeTranslation(0, y, t).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
  geos.push(wallX(-W / 2 + t, [{ u: 0, v: 10.2 - t, w: 9.6, h: 3.8, r: 1.2 }]));
  geos.push(wallX(W / 2, []));
  geos.push(wallY(-D / 2 + t, vents));
  geos.push(wallY(D / 2, []));
  for (const [sx, sy] of [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ]) {
    const c = new THREE.Shape();
    const cx = sx * (W / 2 - r);
    const cy = sy * (D / 2 - r);
    const a0 = Math.atan2(sy, sx) - Math.PI / 4;
    c.absarc(cx, cy, r, a0, a0 + Math.PI / 2, false);
    c.absarc(cx, cy, r - t, a0 + Math.PI / 2, a0, true);
    geos.push(ext(c, t, H, 10));
  }
  for (const b of p.bosses) {
    const s = new THREE.Shape();
    s.absarc(b.x, b.y, b.outerDiameter / 2, 0, Math.PI * 2, false);
    s.holes.push(circle(b.x, b.y, b.holeDiameter / 2));
    geos.push(ext(s, t, t + b.height, 20));
  }
  const feet = CORNER_XY.map(([x, y]) => {
    const g = new THREE.CylinderGeometry(3.2, 3.6, 1.2, 24);
    g.rotateX(Math.PI / 2);
    g.translate(x * 0.82, y * 0.72, -0.6);
    return g;
  });
  return { groups: [toGroup(geos, p.color ?? '#e9ebee', { name: 'shell' }), toGroup(feet, '#24272b', { name: 'rubber feet' })] };
}

function coverMesh(p: EnclosureShell): MeshData {
  const { width: W, depth: D, height: H } = p.outer;
  const t = p.wall;
  const r = p.cornerRadius;
  const top = rrShape(W, D, r) as THREE.Shape;
  for (let i = 0; i < 8; i++) top.holes.push(rrShape(1.6, 14, 0.8, -14 + (i - 3.5) * 3.2, 8, new THREE.Path()));
  top.holes.push(circle(9.5, -14.5, 1.5));
  const ring = rrShape(W, D, r) as THREE.Shape;
  ring.holes.push(rrShape(W - 2 * t, D - 2 * t, r - t, 0, 0, new THREE.Path()));
  const geos = [ext(top, 0, t), ext(ring, t, H)];
  for (const b of p.bosses) {
    const s = new THREE.Shape();
    s.absarc(b.x, b.y, b.outerDiameter / 2, 0, Math.PI * 2, false);
    s.holes.push(circle(b.x, b.y, b.holeDiameter / 2));
    geos.push(ext(s, t, t + b.height, 20));
  }
  const pipe = new THREE.CylinderGeometry(1.45, 1.45, 6, 20);
  pipe.rotateX(Math.PI / 2);
  pipe.translate(9.5, -14.5, 3);
  return { groups: [toGroup(geos, p.color ?? '#2f3640', { name: 'cover' }), toGroup([pipe], '#dff3ff', { name: 'light pipe', opacity: 0.75 })] };
}

function bracketMesh(p: SheetMetalPart): MeshData {
  const t = p.thickness;
  const W = p.base.width;
  const L = p.base.length;
  const plate = rrShape(W, L, 3) as THREE.Shape;
  for (const h of p.holes) {
    if (h.shape === 'circle') plate.holes.push(circle(h.x, h.y, (h.diameter ?? 3) / 2));
    else plate.holes.push(rrShape(h.width ?? 8, h.height ?? 4, Math.min(h.width ?? 8, h.height ?? 4) / 2, h.x, h.y, new THREE.Path()));
  }
  const geos = [ext(plate, 0, t, 16)];
  for (const sy of [1, -1]) {
    const f = new THREE.BoxGeometry(60, t, 7);
    f.translate(0, sy * (L / 2 - t / 2), -3.5 + t);
    geos.push(f);
  }
  return { groups: [toGroup(geos, p.color ?? '#30343a', { name: 'bracket', metal: true })] };
}

function buzzerMesh(): MeshData {
  const body = new THREE.CylinderGeometry(4.5, 4.5, 5.5, 40);
  body.rotateX(Math.PI / 2);
  body.translate(0, 0, 2.75);
  const top = new THREE.CylinderGeometry(1.1, 1.1, 0.2, 24);
  top.rotateX(Math.PI / 2);
  top.translate(0, 0, 5.55);
  const pins = [-2, 2].map((x) => {
    const g = new THREE.CylinderGeometry(0.3, 0.3, 3.5, 10);
    g.rotateX(Math.PI / 2);
    g.translate(x, 0, -1.2);
    return g;
  });
  return {
    groups: [toGroup([body], '#1b1c1f', { name: 'body' }), toGroup([top], '#0a0a0a', { name: 'sound hole' }), toGroup(pins, '#d4d7db', { name: 'pins', metal: true })],
  };
}

/** Simulated mesh service: returns procedural meshes after a short "network" delay. */
export function makeDemoMeshLoader(mech: MechPart[], delayMs = 450): (key: string) => Promise<MeshData | null> {
  const cache = new Map<string, MeshData | null>();
  const build = (key: string): MeshData | null => {
    if (key === 'model:buzzer-9mm') return buzzerMesh();
    if (key.startsWith('mech:')) {
      const part = mech.find((m) => m.id === key.slice(5));
      if (!part) return null;
      if (part.kind === 'enclosure-shell') return part.role === 'cover' ? coverMesh(part) : baseMesh(part);
      if (part.kind === 'sheet-metal') return bracketMesh(part);
      return null;
    }
    return null; // fasteners: let the viewer generate them procedurally
  };
  return (key) =>
    new Promise((resolve) => {
      const jitter = delayMs * (0.6 + 0.8 * ((key.length * 37) % 10) / 10);
      setTimeout(() => {
        if (!cache.has(key)) cache.set(key, build(key));
        resolve(cache.get(key) ?? null);
      }, jitter);
    });
}
