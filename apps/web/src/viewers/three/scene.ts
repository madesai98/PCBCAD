import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { AssemblyInstance, Board, FastenerInstance, MechPart, MeshData, PartDef, PcbThermalResult, Project } from '@pcbcad/core';
import { mix } from '../common/color';
import type { ViewerTheme } from '../common/theme';
import {
  buildBoard,
  compForFace,
  fastenerGeometry,
  fastenerLength,
  fastenerMaterialColor,
  fastenerQuaternion,
  isScrewType,
  MaterialPool,
  mechColor,
  mechFallbackGeometry,
  meshDataToObject,
  surfaceMaterial,
  type BoardBuild,
} from './builders';
import { buildAirflowOverlay, buildStructuralOverlay, type AirflowOverlay, type StructuralOverlay } from './overlays';
import type { Assembly3DOverlay, Assembly3DSection, Assembly3DSelection, GetMesh } from './types';

const DEG = Math.PI / 180;

export interface HoverInfo {
  title: string;
  subtitle?: string;
  detail?: string;
  x: number;
  y: number;
}

export interface OverlayInfo {
  structural?: { max: number; maxAt: [number, number, number]; title: string };
  airflow?: { tMin: number; tMax: number; vMax: number; sliceZ: number };
  pcbThermal?: { min: number; max: number; ref?: string };
}

export interface SceneCallbacks {
  onHover(info: HoverInfo | null): void;
  onPick(sel: Assembly3DSelection | null): void;
  onLoading(pending: number): void;
  onMarker(x: number, y: number, visible: boolean): void;
  onOverlayInfo(info: OverlayInfo): void;
}

type PickData =
  | { kind: 'board'; boardId: string }
  | { kind: 'components'; boardId: string; ranges: { start: number; count: number; compId: string }[] }
  | { kind: 'component'; boardId: string; compId: string }
  | { kind: 'mech'; partId: string; instanceId: string }
  | { kind: 'fastener'; fastenerId: string; partId: string };

interface Node {
  key: string;
  kind: 'board' | 'mech';
  name: string;
  instanceId?: string;
  boardId?: string;
  part?: MechPart;
  outer: THREE.Group;
  inner: THREE.Group;
  content: THREE.Group;
  explicit?: THREE.Vector3;
  auto: THREE.Vector3;
  unassigned: boolean;
  build?: BoardBuild;
  pickables: THREE.Object3D[];
  disposables: { dispose(): void }[];
  capColor: string;
}

interface FNode {
  fi: FastenerInstance;
  spec?: PartDef['fastener'];
  part?: PartDef;
  outer: THREE.Group;
  inner: THREE.Group;
  dir: THREE.Vector3;
  length: number;
  disposables: { dispose(): void }[];
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const GRID_VERT = /* glsl */ `
varying vec3 vPos;
#include <clipping_planes_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPos = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
}`;

const GRID_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uMajorColor;
uniform float uMinor;
uniform float uMajor;
uniform float uFade;
uniform vec2 uCenter;
uniform float uOpacity;
varying vec3 vPos;
float gridLine(vec2 p, float spacing) {
  vec2 c = p / spacing;
  vec2 g = abs(fract(c - 0.5) - 0.5) / max(fwidth(c), vec2(1e-5));
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  float d = length(vPos.xy - uCenter);
  float fade = 1.0 - smoothstep(uFade * 0.25, uFade, d);
  float minor = gridLine(vPos.xy, uMinor);
  float major = gridLine(vPos.xy, uMajor);
  vec3 col = mix(uColor, uMajorColor, major);
  float a = max(minor * 0.55, major) * uOpacity * fade;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}`;

export class AssemblyScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private pmrem: THREE.PMREMGenerator;
  private envTex: THREE.Texture;
  private root = new THREE.Group();
  private overlayRoot = new THREE.Group();
  private helpers = new THREE.Group();
  private key: THREE.DirectionalLight;
  private fill: THREE.DirectionalLight;
  private ground: THREE.Mesh;
  private grid: THREE.Mesh;
  private gridMat: THREE.ShaderMaterial;
  private pool = new MaterialPool();
  private nodes: Node[] = [];
  private fnodes: FNode[] = [];
  private boardCache = new Map<string, { board: Board; parts: Record<string, PartDef>; build: BoardBuild }>();
  private meshCache = new Map<string, Promise<MeshData | null>>();
  private project: Project | null = null;
  private getMesh: GetMesh | null = null;
  private generation = 0;
  private pending = 0;
  private explodeTarget = 0;
  private explodeCur = 0;
  private xray = false;
  private section: Assembly3DSection | null = null;
  private plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private sectionHelper: THREE.LineLoop | null = null;
  private caps: { meshes: THREE.Object3D[]; disposables: { dispose(): void }[] } = { meshes: [], disposables: [] };
  private overlay: Assembly3DOverlay = {};
  private structural: StructuralOverlay | null = null;
  private airflow: AirflowOverlay | null = null;
  private sliceFrac = 0.5;
  private thermalBoard: string | null = null;
  private showFasteners = true;
  private selectedId: string | null = null;
  private selBox: THREE.Box3Helper | null = null;
  private hoverBox: THREE.Box3Helper | null = null;
  private hoverKey = '';
  private theme: ViewerTheme;
  private cb: SceneCallbacks;
  private raf = 0;
  private dirty = true;
  private width = 1;
  private height = 1;
  private userMoved = false;
  private fittedFor: string | null = null;
  private refitTimer = 0;
  private camAnim: { t0: number; ms: number; fromP: THREE.Vector3; toP: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3 } | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = { x: 0, y: 0, down: null as null | { x: number; y: number }, inside: false };
  private lastTime = performance.now();
  private disposed = false;
  private maxAniso: number;
  private bounds = new THREE.Box3();

  constructor(
    private container: HTMLElement,
    theme: ViewerTheme,
    cb: SceneCallbacks,
  ) {
    this.theme = theme;
    this.cb = cb;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0x000000, 0);
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.outline = 'none';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(120, -160, 110);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => this.request());
    this.controls.addEventListener('start', () => {
      this.userMoved = true;
      this.camAnim = null;
    });

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTex = this.pmrem.fromScene(room, 0.035).texture;
    room.dispose?.();
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.85;

    this.key = new THREE.DirectionalLight(0xffffff, 1.9);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    this.key.shadow.radius = 4;
    this.fill = new THREE.DirectionalLight(0xdfe8ff, 0.45);
    this.scene.add(this.key, this.key.target, this.fill, this.fill.target);

    const shadowMat = new THREE.ShadowMaterial({ opacity: 0.3, transparent: true, depthWrite: false });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
    this.ground.receiveShadow = true;
    this.ground.renderOrder = -2;
    this.gridMat = new THREE.ShaderMaterial({
      vertexShader: GRID_VERT,
      fragmentShader: GRID_FRAG,
      transparent: true,
      depthWrite: false,
      extensions: {} as never,
      uniforms: {
        uColor: { value: new THREE.Color() },
        uMajorColor: { value: new THREE.Color() },
        uMinor: { value: 5 },
        uMajor: { value: 25 },
        uFade: { value: 200 },
        uCenter: { value: new THREE.Vector2() },
        uOpacity: { value: 0.5 },
      },
    });
    this.gridMat.toneMapped = false;
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.gridMat);
    this.grid.renderOrder = -1;
    this.helpers.add(this.ground, this.grid);
    this.scene.add(this.root, this.overlayRoot, this.helpers);
    this.applyTheme();

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.loop();
  }

  /* ----------------------------------------- public API ----------------------------------------- */

  setTheme(theme: ViewerTheme) {
    this.theme = theme;
    this.applyTheme();
    if (this.selBox) (this.selBox.material as THREE.LineBasicMaterial).color.set(theme.accent);
    this.request();
  }

  setProject(project: Project, getMesh: GetMesh) {
    if (project === this.project && getMesh === this.getMesh) return;
    if (getMesh !== this.getMesh) this.meshCache.clear();
    const firstForProject = this.project?.id !== project.id;
    this.project = project;
    this.getMesh = getMesh;
    this.rebuild();
    if (firstForProject) {
      this.userMoved = false;
      this.fittedFor = null;
    }
    this.maybeFit();
  }

  setExplode(f: number) {
    this.explodeTarget = Math.max(0, Math.min(1, f || 0));
    this.request();
  }

  setXray(on: boolean) {
    this.xray = on;
    this.applyMaterialModes();
    this.rebuildCaps();
    this.request();
  }

  setSection(s: Assembly3DSection | null | undefined) {
    const was = !!this.section;
    this.section = s ?? null;
    if (this.section) {
      const n = this.section.axis === 'x' ? new THREE.Vector3(-1, 0, 0) : this.section.axis === 'y' ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, -1);
      this.plane.normal.copy(n);
      this.plane.constant = this.section.offset;
    }
    if (was !== !!this.section || this.section) this.applyClipping();
    if (was !== !!this.section) this.rebuildCaps();
    this.updateSectionHelper();
    this.request();
  }

  setOverlay(o: Assembly3DOverlay | undefined) {
    const next = o ?? {};
    if (next.structural !== this.overlay.structural) {
      this.structural?.dispose();
      if (this.structural) this.overlayRoot.remove(this.structural.group);
      this.structural = next.structural ? buildStructuralOverlay(next.structural) : null;
      if (this.structural) this.overlayRoot.add(this.structural.group);
    }
    if (next.airflow !== this.overlay.airflow) {
      this.airflow?.dispose();
      if (this.airflow) this.overlayRoot.remove(this.airflow.group);
      this.airflow = next.airflow ? buildAirflowOverlay(next.airflow) : null;
      if (this.airflow) {
        this.airflow.setSlice(this.sliceFrac);
        this.overlayRoot.add(this.airflow.group);
      }
    }
    if (next.pcbThermal !== this.overlay.pcbThermal) {
      this.overlay = { ...this.overlay, pcbThermal: next.pcbThermal };
      this.applyBoardThermal();
    }
    this.overlay = next;
    this.applyMaterialModes();
    this.applyClipping();
    this.emitOverlayInfo();
    this.updateBounds();
    this.maybeFit();
    this.request();
  }

  setAirflowSlice(frac: number) {
    this.sliceFrac = frac;
    if (this.airflow) {
      this.airflow.setSlice(frac);
      this.emitOverlayInfo();
      this.request();
    }
  }

  setShowFasteners(on: boolean) {
    this.showFasteners = on;
    for (const f of this.fnodes) f.outer.visible = on;
    this.request();
  }

  setSelected(id: string | null | undefined) {
    this.selectedId = id ?? null;
    this.updateSelection();
    this.request();
  }

  resize(w: number, h: number) {
    if (w < 2 || h < 2) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.maybeFit();
    this.request();
  }

  fit(animate = true, dir?: THREE.Vector3) {
    const box = this.contentBox(true);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = this.camera.fov * DEG;
    const fitH = sphere.radius / Math.sin(fov / 2);
    const fitW = fitH / Math.max(0.3, Math.min(1, this.camera.aspect));
    const dist = Math.max(fitH, fitW) * 0.92;
    const d = (dir ?? this.camera.position.clone().sub(this.controls.target)).clone();
    if (d.lengthSq() < 1e-9) d.set(0.8, -1.15, 0.85);
    d.normalize();
    const toP = sphere.center.clone().addScaledVector(d, dist);
    this.camera.near = Math.max(0.05, dist / 400);
    this.camera.far = dist * 40 + sphere.radius * 4;
    this.camera.updateProjectionMatrix();
    if (animate) this.camAnim = { t0: performance.now(), ms: 520, fromP: this.camera.position.clone(), toP, fromT: this.controls.target.clone(), toT: sphere.center.clone() };
    else {
      this.camera.position.copy(toP);
      this.controls.target.copy(sphere.center);
      this.controls.update();
    }
    this.request();
  }

  view(preset: 'iso' | 'top' | 'front' | 'right' | 'bottom') {
    const dirs: Record<string, THREE.Vector3> = {
      iso: new THREE.Vector3(0.8, -1.15, 0.85),
      top: new THREE.Vector3(0, -0.0012, 1),
      front: new THREE.Vector3(0, -1, 0.0012),
      right: new THREE.Vector3(1, 0, 0.0012),
      bottom: new THREE.Vector3(0, -0.0012, -1),
    };
    this.userMoved = true;
    this.fit(true, dirs[preset]);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.refitTimer);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerup', this.onUp);
    canvas.removeEventListener('pointerleave', this.onLeave);
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.clearNodes();
    for (const c of this.boardCache.values()) c.build.dispose();
    this.boardCache.clear();
    this.structural?.dispose();
    this.airflow?.dispose();
    this.clearCaps();
    this.pool.dispose();
    this.envTex.dispose();
    this.pmrem.dispose();
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.grid.geometry.dispose();
    this.gridMat.dispose();
    this.selBox?.dispose();
    this.hoverBox?.dispose();
    this.sectionHelper?.geometry.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    canvas.remove();
  }

  /* -------------------------------------------- build -------------------------------------------- */

  private clearNodes() {
    for (const n of this.nodes) {
      for (const d of n.disposables) d.dispose();
      n.outer.removeFromParent();
    }
    for (const f of this.fnodes) {
      for (const d of f.disposables) d.dispose();
      f.outer.removeFromParent();
    }
    this.nodes = [];
    this.fnodes = [];
  }

  private loadMesh(key: string, sig: string): Promise<MeshData | null> {
    const k = `${key}#${sig}`;
    let p = this.meshCache.get(k);
    if (!p) {
      const gm = this.getMesh;
      p = gm ? gm(key).catch(() => null) : Promise.resolve(null);
      this.meshCache.set(k, p);
    }
    return p;
  }

  private trackAsync<T>(p: Promise<T>): Promise<T> {
    this.pending++;
    this.cb.onLoading(this.pending);
    return p.finally(() => {
      this.pending = Math.max(0, this.pending - 1);
      this.cb.onLoading(this.pending);
    });
  }

  private rebuild() {
    const project = this.project;
    if (!project) return;
    const gen = ++this.generation;
    this.clearNodes();
    this.clearCaps();
    const parts = project.parts;

    // Board builds (cached by object identity).
    const usedBoards = new Set<string>();
    const boardBuild = (b: Board): BoardBuild => {
      usedBoards.add(b.id);
      const hit = this.boardCache.get(b.id);
      if (hit && hit.board === b && hit.parts === parts) return hit.build;
      hit?.build.dispose();
      const build = buildBoard(b, parts, {
        pool: this.pool,
        theme: this.theme,
        maxAniso: this.maxAniso,
        getMesh: (key) => this.trackAsync(this.loadMesh(key, 'asset')),
        onAsync: () => {
          if (gen !== this.generation) return;
          this.afterAsync();
        },
      });
      this.boardCache.set(b.id, { board: b, parts, build });
      return build;
    };

    const boardsInAssembly = new Set<string>();
    for (const inst of project.assembly.instances) {
      if (inst.visible === false) continue;
      if (inst.target.kind === 'board') {
        const b = project.boards.find((x) => x.id === (inst.target as { boardId: string }).boardId);
        if (!b) continue;
        boardsInAssembly.add(b.id);
        this.nodes.push(this.boardNode(b, boardBuild(b), inst, false));
      } else {
        const part = project.mechanical.find((m) => m.id === (inst.target as { partId: string }).partId);
        if (!part) continue;
        this.nodes.push(this.mechNode(part, inst, gen));
      }
    }
    // Boards not in the assembly yet: lay them out side by side so early designs still render.
    const extra = project.boards.filter((b) => !boardsInAssembly.has(b.id));
    if (extra.length) {
      this.root.updateMatrixWorld(true);
      const box = new THREE.Box3();
      for (const n of this.nodes) box.expandByObject(n.outer);
      let x = box.isEmpty() ? 0 : box.max.x + 20;
      const y0 = box.isEmpty() ? 0 : box.min.y;
      for (const b of extra) {
        const build = boardBuild(b);
        const node = this.boardNode(b, build, null, true);
        const bb = build.pcb.bbox;
        node.inner.position.set(x - bb.minX, y0 - bb.minY, 0);
        x += bb.maxX - bb.minX + 15;
        this.nodes.push(node);
      }
    }
    for (const [id, c] of this.boardCache) {
      if (!usedBoards.has(id)) {
        c.build.dispose();
        this.boardCache.delete(id);
      }
    }
    for (const n of this.nodes) this.root.add(n.outer);

    // Fasteners.
    for (const fi of project.assembly.fasteners) {
      const part = parts[fi.partId];
      const spec = part?.fastener;
      if (!spec) continue;
      const fn = this.fastenerNode(fi, part, gen);
      this.fnodes.push(fn);
      fn.outer.visible = this.showFasteners;
      this.root.add(fn.outer);
    }
    this.applyBoardThermal();
    this.computeExplode();
    this.applyMaterialModes();
    this.applyClipping();
    this.rebuildCaps();
    this.updateBounds();
    this.updateSelection();
    this.request();
  }

  private boardNode(b: Board, build: BoardBuild, inst: AssemblyInstance | null, unassigned: boolean): Node {
    const outer = new THREE.Group();
    const inner = new THREE.Group();
    const content = new THREE.Group();
    outer.add(inner);
    inner.add(content);
    if (inst) this.applyTransform(inner, inst);
    content.add(build.group.parent ? build.group.clone() : build.group);
    return {
      key: inst?.id ?? `board:${b.id}`,
      kind: 'board',
      name: inst?.name ?? b.name,
      instanceId: inst?.id,
      boardId: b.id,
      outer,
      inner,
      content,
      explicit: inst?.explode ? new THREE.Vector3(...inst.explode) : undefined,
      auto: new THREE.Vector3(),
      unassigned,
      build,
      pickables: build.pickables,
      disposables: [],
      capColor: '#c3b27a',
    };
  }

  private mechNode(part: MechPart, inst: AssemblyInstance, gen: number): Node {
    const outer = new THREE.Group();
    const inner = new THREE.Group();
    const content = new THREE.Group();
    outer.add(inner);
    inner.add(content);
    this.applyTransform(inner, inst);
    const look = mechColor(part);
    const node: Node = {
      key: inst.id,
      kind: 'mech',
      name: inst.name || part.name,
      instanceId: inst.id,
      part,
      outer,
      inner,
      content,
      explicit: inst.explode ? new THREE.Vector3(...inst.explode) : undefined,
      auto: new THREE.Vector3(),
      unassigned: false,
      pickables: [],
      disposables: [],
      capColor: mix(look.color, '#000000', 0.18),
    };
    const material = () => {
      const m = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(look.color),
        metalness: look.metal ? 0.88 : 0,
        roughness: look.rough,
        clearcoat: look.metal ? 0 : 0.06,
        clearcoatRoughness: 0.6,
        side: THREE.DoubleSide,
      });
      m.userData.mech = true;
      node.disposables.push(m);
      return m;
    };
    const setContent = (obj: THREE.Object3D, geos: THREE.BufferGeometry[]) => {
      content.clear();
      node.pickables = [];
      obj.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const mesh = o as THREE.Mesh;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.userData.pick = { kind: 'mech', partId: part.id, instanceId: inst.id } satisfies PickData;
          node.pickables.push(mesh);
        }
      });
      content.add(obj);
      // Crisp CAD feature edges.
      for (const g of geos) {
        const tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
        if (tris > 200000) continue;
        const eg = new THREE.EdgesGeometry(g, 28);
        const lm = new THREE.LineBasicMaterial({ color: this.theme.dark ? '#0b0d10' : '#1f2933', transparent: true, opacity: 0.22 });
        lm.userData.edge = true;
        const lines = new THREE.LineSegments(eg, lm);
        lines.raycast = () => {};
        content.add(lines);
        node.disposables.push(eg, lm);
      }
    };
    // Placeholder geometry now…
    const fb = mechFallbackGeometry(part);
    node.disposables.push(fb);
    const fbMesh = new THREE.Mesh(fb, material());
    setContent(fbMesh, [fb]);
    // …and the server mesh when it arrives.
    this.trackAsync(this.loadMesh(`mech:${part.id}`, hash(JSON.stringify(part)))).then((md) => {
      if (this.disposed || gen !== this.generation || !md || !md.groups?.length) return;
      const mats = new Map<string, THREE.Material>();
      const obj = meshDataToObject(md, (g) => {
        const k = `${g.color}|${g.opacity ?? 1}|${g.metal ? 1 : 0}`;
        let m = mats.get(k);
        if (!m) {
          const mm = material();
          if (g.color) mm.color.set(g.color);
          if (g.metal !== undefined) mm.metalness = g.metal ? 0.88 : 0;
          if (g.opacity !== undefined && g.opacity < 1) {
            mm.transparent = true;
            mm.opacity = g.opacity;
          }
          mats.set(k, (m = mm));
        }
        return m;
      });
      const geos: THREE.BufferGeometry[] = [];
      obj.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          geos.push((o as THREE.Mesh).geometry);
          node.disposables.push((o as THREE.Mesh).geometry);
        }
      });
      setContent(obj, geos);
      this.afterAsync();
    });
    return node;
  }

  private fastenerNode(fi: FastenerInstance, part: PartDef, gen: number): FNode {
    const spec = part.fastener!;
    const outer = new THREE.Group();
    const inner = new THREE.Group();
    outer.add(inner);
    const dir = new THREE.Vector3(...fi.direction);
    if (dir.lengthSq() < 1e-9) dir.set(0, 0, -1);
    dir.normalize();
    const length = fastenerLength(spec);
    inner.quaternion.copy(fastenerQuaternion(dir));
    const pos = new THREE.Vector3(...fi.position);
    if (!isScrewType(spec)) pos.addScaledVector(dir, -length / 2);
    inner.position.copy(pos);
    const fn: FNode = { fi, spec, part, outer, inner, dir, length, disposables: [] };
    const look = fastenerMaterialColor(spec);
    const mat = surfaceMaterial(this.pool, look.color, look.metal, { rough: look.metal ? 0.3 : 0.55, tag: 'fastener' });
    const put = (geo: THREE.BufferGeometry) => {
      inner.clear();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.userData.pick = { kind: 'fastener', fastenerId: fi.id, partId: fi.partId } satisfies PickData;
      inner.add(mesh);
    };
    const geo = fastenerGeometry(spec);
    fn.disposables.push(geo);
    put(geo);
    this.trackAsync(this.loadMesh(`fastener:${fi.partId}`, hash(JSON.stringify(spec)))).then((md) => {
      if (this.disposed || gen !== this.generation || !md?.groups?.length) return;
      const obj = meshDataToObject(md, () => mat);
      const meshes: THREE.Mesh[] = [];
      obj.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
      if (!meshes.length) return;
      inner.clear();
      for (const m of meshes) {
        m.castShadow = true;
        m.userData.pick = { kind: 'fastener', fastenerId: fi.id, partId: fi.partId } satisfies PickData;
        fn.disposables.push(m.geometry);
        inner.add(m);
      }
      this.request();
    });
    return fn;
  }

  private applyTransform(g: THREE.Object3D, inst: AssemblyInstance) {
    const t = inst.transform;
    g.position.set(t.position[0], t.position[1], t.position[2]);
    g.rotation.set(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'XYZ');
  }

  private afterAsync() {
    // Async meshes change bounds: recompute explode/bounds, rebuild caps, maybe refit (debounced).
    clearTimeout(this.refitTimer);
    this.refitTimer = window.setTimeout(() => {
      if (this.disposed) return;
      this.computeExplode();
      this.applyMaterialModes();
      this.applyClipping();
      this.rebuildCaps();
      this.updateBounds();
      this.updateSelection();
      if (!this.userMoved) this.fit(this.fittedFor !== null);
      this.request();
    }, 60);
  }

  /* -------------------------------------------- explode ------------------------------------------- */

  private computeExplode() {
    // World boxes with explode disabled.
    const saved = this.nodes.map((n) => n.outer.position.clone());
    for (const n of this.nodes) n.outer.position.set(0, 0, 0);
    this.root.updateMatrixWorld(true);
    const boxes = this.nodes.map((n) => new THREE.Box3().setFromObject(n.content));
    this.nodes.forEach((n, i) => n.outer.position.copy(saved[i]));
    const asm = new THREE.Box3();
    this.nodes.forEach((n, i) => !n.unassigned && !boxes[i].isEmpty() && asm.union(boxes[i]));
    if (asm.isEmpty()) return;
    const size = asm.getSize(new THREE.Vector3());
    const center = asm.getCenter(new THREE.Vector3());
    const step = Math.max(10, size.z * 0.75 + 6);
    // Anchor = largest mech "base" (or largest instance).
    let anchor = -1;
    let best = -1;
    this.nodes.forEach((n, i) => {
      if (n.unassigned || boxes[i].isEmpty()) return;
      const s = boxes[i].getSize(new THREE.Vector3());
      const vol = s.x * s.y * Math.max(1, s.z) * (n.part?.kind === 'enclosure-shell' && n.part.role === 'base' ? 4 : 1);
      if (vol > best) {
        best = vol;
        anchor = i;
      }
    });
    const levels = [...new Set(this.nodes.map((n, i) => (n.unassigned || boxes[i].isEmpty() ? null : Math.round(boxes[i].min.z * 2) / 2)).filter((v): v is number => v !== null))].sort((a, b) => a - b);
    const anchorLevel = anchor >= 0 ? levels.indexOf(Math.round(boxes[anchor].min.z * 2) / 2) : 0;
    this.nodes.forEach((n, i) => {
      n.auto.set(0, 0, 0);
      if (n.unassigned || boxes[i].isEmpty() || i === anchor) return;
      const lvl = levels.indexOf(Math.round(boxes[i].min.z * 2) / 2) - anchorLevel;
      const c = boxes[i].getCenter(new THREE.Vector3());
      const isCover = n.part?.kind === 'enclosure-shell' && n.part.role === 'cover';
      const dz = lvl * step + (isCover ? step * 0.8 : 0) + (lvl === 0 && !isCover ? (c.z >= center.z ? step * 0.5 : -step * 0.5) : 0);
      n.auto.set((c.x - center.x) * 0.25, (c.y - center.y) * 0.25, dz);
    });
  }

  private applyExplode() {
    const f = this.explodeCur;
    const offsetOf = new Map<string, THREE.Vector3>();
    for (const n of this.nodes) {
      const v = (n.explicit ?? n.auto).clone().multiplyScalar(f);
      n.outer.position.copy(v);
      if (n.instanceId) offsetOf.set(n.instanceId, v);
    }
    for (const fn of this.fnodes) {
      let base = new THREE.Vector3();
      let bestDot = -Infinity;
      for (const j of fn.fi.joins) {
        const o = offsetOf.get(j);
        if (!o) continue;
        const d = o.dot(fn.dir.clone().negate());
        if (d > bestDot || (d === bestDot && o.lengthSq() > base.lengthSq())) {
          bestDot = d;
          base = o.clone();
        }
      }
      fn.outer.position.copy(base).addScaledVector(fn.dir, -f * (fn.length + 12));
    }
  }

  /* -------------------------------------------- modes --------------------------------------------- */

  private forEachContentMaterial(fn: (m: THREE.Material, mech: boolean, obj: THREE.Object3D) => void) {
    const seen = new Set<THREE.Material>();
    const visit = (root: THREE.Object3D, mechFlag: boolean) =>
      root.traverse((o) => {
        const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!mm) return;
        for (const m of Array.isArray(mm) ? mm : [mm]) {
          if (seen.has(m)) continue;
          seen.add(m);
          fn(m, mechFlag || !!m.userData.mech, o);
        }
      });
    for (const n of this.nodes) visit(n.outer, n.kind === 'mech');
    for (const f of this.fnodes) visit(f.outer, false);
  }

  private applyMaterialModes() {
    const ghostAll = !!this.structural;
    const ghostMech = this.xray || !!this.airflow;
    this.forEachContentMaterial((m, mech) => {
      if (m.userData.base === undefined) m.userData.base = { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite };
      const base = m.userData.base as { transparent: boolean; opacity: number; depthWrite: boolean };
      const isEdge = !!m.userData.edge;
      let opacity = base.opacity;
      if (ghostAll) opacity = isEdge ? 0.08 : 0.1;
      else if (ghostMech && mech) opacity = isEdge ? 0.35 : 0.18;
      const transparent = opacity < 1 || base.transparent;
      if (m.transparent !== transparent || m.opacity !== opacity) {
        m.transparent = transparent;
        m.opacity = opacity;
        m.depthWrite = opacity < 1 ? false : base.depthWrite;
        m.needsUpdate = true;
      }
    });
    for (const n of this.nodes)
      n.content.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const m = mesh.material as THREE.Material;
        mesh.castShadow = !(Array.isArray(m) ? false : m.transparent && m.opacity < 0.5);
      });
  }

  private applyClipping() {
    const planes = this.section ? [this.plane] : [];
    const apply = (m: THREE.Material) => {
      const had = (m.clippingPlanes?.length ?? 0) > 0;
      if (had !== planes.length > 0) {
        m.clippingPlanes = planes;
        m.clipShadows = true;
        m.needsUpdate = true;
      } else if (planes.length) m.clippingPlanes = planes;
    };
    this.forEachContentMaterial((m) => apply(m));
    this.overlayRoot.traverse((o) => {
      const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (mm) for (const m of Array.isArray(mm) ? mm : [mm]) apply(m);
    });
  }

  private clearCaps() {
    for (const m of this.caps.meshes) m.removeFromParent();
    for (const d of this.caps.disposables) d.dispose();
    this.caps = { meshes: [], disposables: [] };
  }

  /** Stencil-based section caps, one coloured cap per board / mechanical node. */
  private rebuildCaps() {
    this.clearCaps();
    if (!this.section) return;
    const box = this.contentBox(false);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()).length() * 2 + 20;
    const center = box.getCenter(new THREE.Vector3());
    let order = 10;
    for (const n of this.nodes) {
      const ghost = !!this.structural || ((this.xray || !!this.airflow) && n.kind === 'mech');
      if (ghost) continue;
      const meshes: THREE.Mesh[] = [];
      if (n.kind === 'mech') n.content.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
      else n.content.traverse((o) => (o as THREE.Mesh).isMesh && Array.isArray((o as THREE.Mesh).material) && meshes.push(o as THREE.Mesh));
      if (!meshes.length) continue;
      const mk = (side: THREE.Side, op: THREE.StencilOp) => {
        const m = new THREE.MeshBasicMaterial({ side, colorWrite: false, depthWrite: false, depthTest: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op, clippingPlanes: [this.plane] });
        this.caps.disposables.push(m);
        return m;
      };
      const back = mk(THREE.BackSide, THREE.IncrementWrapStencilOp);
      const front = mk(THREE.FrontSide, THREE.DecrementWrapStencilOp);
      for (const mesh of meshes) {
        for (const mat of [back, front]) {
          const s = new THREE.Mesh(mesh.geometry, mat);
          s.renderOrder = order;
          s.raycast = () => {};
          mesh.add(s);
          this.caps.meshes.push(s);
        }
      }
      const capMat = new THREE.MeshStandardMaterial({
        color: n.capColor,
        roughness: 0.7,
        metalness: 0.05,
        side: THREE.DoubleSide,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp,
        stencilZPass: THREE.ReplaceStencilOp,
      });
      const capGeo = new THREE.PlaneGeometry(size, size);
      const cap = new THREE.Mesh(capGeo, capMat);
      const nrm = this.plane.normal.clone().negate();
      cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nrm);
      const p = this.plane.projectPoint(center, new THREE.Vector3());
      cap.position.copy(p);
      cap.renderOrder = order + 0.5;
      cap.raycast = () => {};
      cap.onAfterRender = (r) => r.clearStencil();
      this.helpers.add(cap);
      this.caps.meshes.push(cap);
      this.caps.disposables.push(capMat, capGeo);
      order += 2;
    }
  }

  private updateSectionHelper() {
    if (this.sectionHelper) {
      this.sectionHelper.removeFromParent();
      this.sectionHelper.geometry.dispose();
      (this.sectionHelper.material as THREE.Material).dispose();
      this.sectionHelper = null;
    }
    if (!this.section) return;
    const box = this.contentBox(false);
    if (box.isEmpty()) return;
    const min = box.min;
    const max = box.max;
    const o = this.section.offset;
    const pad = 4;
    let pts: THREE.Vector3[];
    if (this.section.axis === 'x')
      pts = [new THREE.Vector3(o, min.y - pad, min.z - pad), new THREE.Vector3(o, max.y + pad, min.z - pad), new THREE.Vector3(o, max.y + pad, max.z + pad), new THREE.Vector3(o, min.y - pad, max.z + pad)];
    else if (this.section.axis === 'y')
      pts = [new THREE.Vector3(min.x - pad, o, min.z - pad), new THREE.Vector3(max.x + pad, o, min.z - pad), new THREE.Vector3(max.x + pad, o, max.z + pad), new THREE.Vector3(min.x - pad, o, max.z + pad)];
    else pts = [new THREE.Vector3(min.x - pad, min.y - pad, o), new THREE.Vector3(max.x + pad, min.y - pad, o), new THREE.Vector3(max.x + pad, max.y + pad, o), new THREE.Vector3(min.x - pad, max.y + pad, o)];
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    this.sectionHelper = new THREE.LineLoop(g, new THREE.LineDashedMaterial({ color: this.theme.accent, dashSize: 3, gapSize: 2, transparent: true, opacity: 0.85, toneMapped: false }));
    this.sectionHelper.computeLineDistances();
    this.helpers.add(this.sectionHelper);
  }

  private applyBoardThermal() {
    const r = this.overlay.pcbThermal ?? null;
    const target = r?.boardId ?? null;
    if (target === this.thermalBoard && !r) return;
    for (const [id, c] of this.boardCache) {
      if (id === target) c.build.setThermal(r);
      else if (id === this.thermalBoard) c.build.setThermal(null);
    }
    this.thermalBoard = target;
    this.emitOverlayInfo();
  }

  private emitOverlayInfo() {
    const info: OverlayInfo = {};
    const s = this.overlay.structural;
    if (this.structural && s) info.structural = { max: this.structural.max, maxAt: [this.structural.maxAt.x, this.structural.maxAt.y, this.structural.maxAt.z], title: s.title };
    if (this.airflow) info.airflow = { tMin: this.airflow.tMin, tMax: this.airflow.tMax, vMax: this.airflow.vMax, sliceZ: (this.airflow.group.children[0] as THREE.Mesh).position.z };
    const t = this.overlay.pcbThermal;
    if (t) {
      let min = Infinity;
      for (const l of t.layers) for (const v of Array.isArray(l.temperature) ? l.temperature : []) min = Math.min(min, v);
      info.pcbThermal = { min: Number.isFinite(min) ? Math.min(min, t.ambient) : t.ambient, max: t.maxTemp };
    }
    this.cb.onOverlayInfo(info);
  }

  /* ------------------------------------------- bounds -------------------------------------------- */

  private contentBox(includeOverlays: boolean): THREE.Box3 {
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const n of this.nodes) box.expandByObject(n.outer);
    if (this.showFasteners) for (const f of this.fnodes) box.expandByObject(f.outer);
    if (includeOverlays) {
      if (this.structural) box.union(this.structural.box);
      if (this.airflow) box.union(this.airflow.box);
    }
    return box;
  }

  private updateBounds() {
    const box = this.contentBox(true);
    if (box.isEmpty()) box.set(new THREE.Vector3(-20, -20, 0), new THREE.Vector3(20, 20, 10));
    this.bounds.copy(box);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(10, size.length() / 2);
    const z = box.min.z - 0.05;
    const g = radius * 10;
    this.ground.scale.set(g, g, 1);
    this.ground.position.set(center.x, center.y, z - 0.02);
    this.grid.scale.set(g, g, 1);
    this.grid.position.set(center.x, center.y, z - 0.03);
    const minor = Math.pow(10, Math.floor(Math.log10(radius / 6)));
    this.gridMat.uniforms.uMinor.value = minor;
    this.gridMat.uniforms.uMajor.value = minor * 5;
    this.gridMat.uniforms.uFade.value = radius * 3.2;
    (this.gridMat.uniforms.uCenter.value as THREE.Vector2).set(center.x, center.y);
    // Shadow camera hugging the content.
    const dir = new THREE.Vector3(-0.45, -0.65, 1.0).normalize();
    this.key.position.copy(center).addScaledVector(dir, radius * 3);
    this.key.target.position.copy(center);
    const cam = this.key.shadow.camera;
    cam.left = -radius * 1.4;
    cam.right = radius * 1.4;
    cam.top = radius * 1.4;
    cam.bottom = -radius * 1.4;
    cam.near = radius * 0.5;
    cam.far = radius * 6;
    cam.updateProjectionMatrix();
    this.fill.position.copy(center).addScaledVector(new THREE.Vector3(0.7, 0.8, 0.4).normalize(), radius * 3);
    this.fill.target.position.copy(center);
    this.updateSectionHelper();
  }

  private maybeFit() {
    if (this.width < 2 || !this.project) return;
    const key = `${this.project.id}`;
    if (this.fittedFor !== key) {
      const box = this.contentBox(true);
      if (box.isEmpty()) return;
      this.fittedFor = key;
      this.fit(false, new THREE.Vector3(0.8, -1.15, 0.85));
    }
  }

  /* ------------------------------------------- theme --------------------------------------------- */

  private applyTheme() {
    const t = this.theme;
    (this.gridMat.uniforms.uColor.value as THREE.Color).set(t.dark ? '#5d6878' : '#8a94a3');
    (this.gridMat.uniforms.uMajorColor.value as THREE.Color).set(t.dark ? '#8b96a6' : '#6b7584');
    this.gridMat.uniforms.uOpacity.value = t.dark ? 0.32 : 0.38;
    (this.ground.material as THREE.ShadowMaterial).opacity = t.dark ? 0.55 : 0.2;
    this.forEachContentMaterial((m) => {
      if (m.userData.edge) (m as THREE.LineBasicMaterial).color.set(t.dark ? '#0b0d10' : '#1f2933');
    });
    if (this.sectionHelper) (this.sectionHelper.material as THREE.LineDashedMaterial).color.set(t.accent);
  }

  /* ------------------------------------------ selection ------------------------------------------ */

  private entityBox(id: string): THREE.Box3 | null {
    this.root.updateMatrixWorld(true);
    for (const n of this.nodes) {
      if (n.instanceId === id || n.part?.id === id || (n.kind === 'board' && n.boardId === id)) return new THREE.Box3().setFromObject(n.content);
    }
    for (const n of this.nodes) {
      const b = n.build?.compBoxes.get(id);
      if (b) return b.clone().applyMatrix4(n.content.children[0]?.matrixWorld ?? n.content.matrixWorld);
    }
    for (const f of this.fnodes) if (f.fi.id === id) return new THREE.Box3().setFromObject(f.outer);
    return null;
  }

  private updateSelection() {
    if (this.selBox) {
      this.selBox.removeFromParent();
      this.selBox.dispose();
      this.selBox = null;
    }
    if (!this.selectedId) return;
    const box = this.entityBox(this.selectedId);
    if (!box || box.isEmpty()) return;
    box.expandByScalar(0.25);
    this.selBox = new THREE.Box3Helper(box, new THREE.Color(this.theme.accent));
    (this.selBox.material as THREE.LineBasicMaterial).toneMapped = false;
    (this.selBox.material as THREE.LineBasicMaterial).depthTest = false;
    (this.selBox.material as THREE.LineBasicMaterial).transparent = true;
    this.selBox.renderOrder = 20;
    this.helpers.add(this.selBox);
  }

  private setHoverBox(box: THREE.Box3 | null) {
    if (this.hoverBox) {
      this.hoverBox.removeFromParent();
      this.hoverBox.dispose();
      this.hoverBox = null;
    }
    if (!box) return;
    this.hoverBox = new THREE.Box3Helper(box.clone().expandByScalar(0.2), new THREE.Color(this.theme.accentSoft));
    const m = this.hoverBox.material as THREE.LineBasicMaterial;
    m.transparent = true;
    m.opacity = 0.55;
    m.toneMapped = false;
    m.depthTest = false;
    this.hoverBox.renderOrder = 19;
    this.helpers.add(this.hoverBox);
  }

  /* ------------------------------------------- picking ------------------------------------------- */

  private pick(clientX: number, clientY: number): { sel: Assembly3DSelection; info: Omit<HoverInfo, 'x' | 'y'>; key: string } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = [];
    for (const n of this.nodes) for (const p of n.pickables) targets.push(p);
    if (this.showFasteners) for (const f of this.fnodes) f.inner.traverse((o) => (o as THREE.Mesh).isMesh && targets.push(o));
    let hits = this.raycaster.intersectObjects(targets, false).filter((h) => {
      if (!h.object.visible) return false;
      if (this.section && this.plane.distanceToPoint(h.point) < -1e-6) return false;
      return true;
    });
    const ghostMech = this.xray || !!this.airflow || !!this.structural;
    if (ghostMech) {
      const nonMech = hits.filter((h) => (h.object.userData.pick as PickData | undefined)?.kind !== 'mech');
      if (nonMech.length) hits = nonMech;
    }
    const hit = hits[0];
    if (!hit) return null;
    const pd = hit.object.userData.pick as PickData;
    const project = this.project!;
    switch (pd.kind) {
      case 'components':
      case 'component': {
        const compId = pd.kind === 'component' ? pd.compId : compForFace(pd.ranges, hit.faceIndex ?? -1);
        const board = project.boards.find((b) => b.id === pd.boardId);
        const c = board?.components.find((x) => x.id === compId);
        if (!c || !board) return null;
        const part = project.parts[c.partId];
        return {
          sel: { kind: 'component', boardId: board.id, componentId: c.id },
          info: { title: c.ref, subtitle: [c.value ?? part?.value, part?.mpn].filter(Boolean).join(' · '), detail: `${board.name} · ${c.side}` },
          key: `c:${c.id}`,
        };
      }
      case 'board': {
        const board = project.boards.find((b) => b.id === pd.boardId);
        const node = this.nodes.find((n) => n.boardId === pd.boardId);
        const ob = board?.outlineSpec;
        return {
          sel: { kind: 'board', boardId: pd.boardId, instanceId: node?.instanceId },
          info: { title: board?.name ?? 'Board', subtitle: ob ? `${ob.width}×${ob.height} mm · ${board?.stackup.layers}L · ${board?.stackup.thickness} mm` : undefined, detail: node?.unassigned ? 'Not in assembly yet' : undefined },
          key: `b:${pd.boardId}`,
        };
      }
      case 'mech': {
        const part = project.mechanical.find((m) => m.id === pd.partId);
        return {
          sel: { kind: 'mech', partId: pd.partId, instanceId: pd.instanceId },
          info: { title: part?.name ?? 'Part', subtitle: part ? `${part.kind.replace('-', ' ')} · ${part.materialId}` : undefined, detail: part?.process.replace(/-/g, ' ') },
          key: `m:${pd.instanceId}`,
        };
      }
      case 'fastener': {
        const part = project.parts[pd.partId];
        const s = part?.fastener;
        return {
          sel: { kind: 'part', partId: pd.partId, fastenerId: pd.fastenerId },
          info: { title: s ? `${s.thread ?? `M${s.diameter}`} ${s.type.replace(/-/g, ' ')}` : 'Fastener', subtitle: s?.length ? `${s.length} mm · ${s.materialId}` : s?.materialId, detail: part?.mpn },
          key: `f:${pd.fastenerId}`,
        };
      }
    }
  }

  private onDown = (e: PointerEvent) => {
    this.pointer.down = { x: e.clientX, y: e.clientY };
  };

  private onUp = (e: PointerEvent) => {
    const d = this.pointer.down;
    this.pointer.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || e.button !== 0) return;
    const r = this.pick(e.clientX, e.clientY);
    this.cb.onPick(r?.sel ?? null);
  };

  private hoverQueued = false;
  private onMove = (e: PointerEvent) => {
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.inside = true;
    if (this.pointer.down || this.hoverQueued) {
      if (this.pointer.down && this.hoverKey) {
        this.hoverKey = '';
        this.setHoverBox(null);
        this.cb.onHover(null);
      }
      return;
    }
    this.hoverQueued = true;
    requestAnimationFrame(() => {
      this.hoverQueued = false;
      if (this.disposed || !this.pointer.inside) return;
      const r = this.pick(this.pointer.x, this.pointer.y);
      const rect = this.renderer.domElement.getBoundingClientRect();
      if (!r) {
        if (this.hoverKey) {
          this.hoverKey = '';
          this.setHoverBox(null);
          this.request();
        }
        this.cb.onHover(null);
        return;
      }
      if (r.key !== this.hoverKey) {
        this.hoverKey = r.key;
        const id = r.sel.kind === 'component' ? r.sel.componentId : r.sel.kind === 'mech' ? (r.sel.instanceId ?? r.sel.partId) : r.sel.kind === 'part' ? r.sel.fastenerId : r.sel.boardId;
        this.setHoverBox(id === this.selectedId ? null : this.entityBox(id));
        this.request();
      }
      this.cb.onHover({ ...r.info, x: this.pointer.x - rect.left, y: this.pointer.y - rect.top });
    });
  };

  private onLeave = () => {
    this.pointer.inside = false;
    this.hoverKey = '';
    this.setHoverBox(null);
    this.cb.onHover(null);
    this.request();
  };

  private onContextLost = (e: Event) => {
    e.preventDefault();
  };

  /* -------------------------------------------- loop --------------------------------------------- */

  request() {
    this.dirty = true;
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    let active = false;
    if (this.camAnim) {
      const a = this.camAnim;
      const u = Math.min(1, (now - a.t0) / a.ms);
      const e = 1 - Math.pow(1 - u, 3);
      this.camera.position.lerpVectors(a.fromP, a.toP, e);
      this.controls.target.lerpVectors(a.fromT, a.toT, e);
      if (u >= 1) this.camAnim = null;
      active = true;
    }
    if (Math.abs(this.explodeTarget - this.explodeCur) > 1e-4) {
      this.explodeCur += (this.explodeTarget - this.explodeCur) * Math.min(1, dt * 9);
      if (Math.abs(this.explodeTarget - this.explodeCur) < 1e-3) this.explodeCur = this.explodeTarget;
      this.applyExplode();
      if (this.selectedId) this.updateSelection();
      active = true;
    } else if (this.dirty) this.applyExplode();
    const changed = this.controls.update();
    if (!(changed || active || this.dirty)) return;
    this.dirty = false;
    if (this.structural) {
      for (const c of this.structural.group.children) if (c.userData.billboard) c.quaternion.copy(this.camera.quaternion);
      const p = this.structural.maxAt.clone().project(this.camera);
      const visible = p.z < 1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
      this.cb.onMarker(((p.x + 1) / 2) * this.width, ((1 - p.y) / 2) * this.height, visible);
    } else this.cb.onMarker(0, 0, false);
    this.renderer.render(this.scene, this.camera);
    if (changed || active) this.dirty = true;
  };
}
