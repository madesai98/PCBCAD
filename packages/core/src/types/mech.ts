import type { Transform3, Vec2, Vec3 } from './common';

export type ManufacturingProcess =
  | 'injection-molding'
  | 'sheet-metal'
  | 'cnc-machining'
  | 'fdm-printing'
  | 'sla-printing'
  | 'sls-printing'
  | 'die-casting'
  | 'extrusion'
  | 'purchased';

export interface MechPartBase {
  id: string;
  name: string;
  /** Material id from the materials library (see materials.ts). */
  materialId: string;
  process: ManufacturingProcess;
  /**
   * Process options, e.g. injection molding: { texture: 'MT-11010', gate: 'edge', cavities: 1 };
   * sheet metal: { finish: 'anodized-black' | 'powder-coat' | 'zinc-plated' }; FDM: { infill: 0.4, layerHeight: 0.2 }.
   */
  processOptions?: Record<string, string | number | boolean>;
  /** Display colour (#rrggbb). */
  color?: string;
  quantity?: number;
  notes?: string;
}

/* ---------------------------------- Injection-molded shells ----------------------------------- */

/**
 * Faces of a shell. 'floor' is the closed face (outer surface at local z = 0).
 * Side faces: '+x' is the plane x = +outer.width/2, etc.
 */
export type ShellFace = 'floor' | '+x' | '-x' | '+y' | '-y';

/**
 * Screw boss / insert boss / alignment pin rising from the inner floor.
 * (x, y) in shell local frame (centred).
 */
export interface ShellBoss {
  id: string;
  x: number;
  y: number;
  outerDiameter: number;
  /** Pilot hole (self-tapping), insert hole (heat-set insert) or clearance hole. */
  holeDiameter: number;
  /** Height above the inner floor surface (mm). */
  height: number;
  kind: 'screw' | 'insert' | 'clearance' | 'pin' | 'standoff';
  fastenerPartId?: string;
  /** Number of support gussets (0 = none). */
  gussets?: number;
  /** Through hole in the floor for screw access from outside (counterbored for the head). */
  throughFloor?: boolean;
}

export interface ShellRib {
  id: string;
  from: Vec2;
  to: Vec2;
  /** Height above inner floor (mm). */
  height: number;
  thickness: number;
}

/**
 * Opening in a face. Face-local coordinates (u, v):
 *   '+x' / '-x' : u = local Y, v = local Z (absolute, z = 0 at floor outer surface)
 *   '+y' / '-y' : u = local X, v = local Z
 *   'floor'     : u = local X, v = local Y
 * (u, v) is the cutout centre; width along u, height along v.
 */
export interface ShellCutout {
  id: string;
  face: ShellFace;
  shape: 'rect' | 'rounded-rect' | 'circle' | 'slot';
  u: number;
  v: number;
  width: number;
  height: number;
  /** Corner radius for rounded-rect. */
  radius?: number;
  purpose?: 'connector' | 'button' | 'led' | 'display' | 'cable' | 'switch' | 'other';
  /** Board component this opening serves (e.g. a USB-C receptacle). */
  linked?: { boardId: string; componentId: string };
}

/** A grille of parallel slots on a face (same face-local coordinates as ShellCutout). */
export interface VentPattern {
  id: string;
  face: ShellFace;
  u: number;
  v: number;
  slotWidth: number;
  slotLength: number;
  count: number;
  /** Centre-to-centre spacing of slots (mm). */
  pitch: number;
  /** Slots run along 'u' or 'v'. */
  orientation: 'u' | 'v';
}

export interface SnapFit {
  id: string;
  face: Exclude<ShellFace, 'floor'>;
  /** Position along the face (u as in ShellCutout). */
  u: number;
  width: number;
  /** Cantilever beam length/thickness and hook overhang (mm). */
  length: number;
  thickness: number;
  overhang: number;
  /** 'hook' = cantilever with hook on this part; 'catch' = matching window/ledge. */
  kind: 'hook' | 'catch';
}

/**
 * One injection-molded shell half (base or cover). Local frame: X/Y centred on the outer
 * footprint, z = 0 at the outer surface of the closed face (floor), interior floor at z = wall,
 * open face at z = outer.height.
 */
export interface EnclosureShell extends MechPartBase {
  kind: 'enclosure-shell';
  role: 'base' | 'cover' | 'single';
  outer: { width: number; depth: number; height: number };
  /** Nominal wall thickness (mm). */
  wall: number;
  /** Vertical-edge outer corner radius (mm). */
  cornerRadius: number;
  /** Draft angle on walls (degrees) — used by DFM; geometry may approximate. */
  draftDeg: number;
  /** Mating feature on the open rim. */
  lip?: { kind: 'lip' | 'groove'; height: number; thickness: number };
  bosses: ShellBoss[];
  ribs: ShellRib[];
  cutouts: ShellCutout[];
  vents: VentPattern[];
  snaps: SnapFit[];
  /** Id of the mating shell (other half), if any. */
  matesWith?: string;
}

/* ----------------------------------------- Sheet metal ----------------------------------------- */

export interface SheetHole {
  id: string;
  /** Base: (x, y) in part frame. On a flange: x = u (along the edge, centred), y = v (distance from the base outer surface along the flange). */
  x: number;
  y: number;
  shape: 'circle' | 'rect' | 'slot';
  diameter?: number;
  width?: number;
  height?: number;
  /** Self-clinching hardware (PEM) installed in this hole. */
  pemPartId?: string;
}

/**
 * Flange bent from an edge of the base (or, when nested, from the far edge of its parent flange).
 * length = outer (virtual sharp) length measured from the parent's outer surface.
 * angle  = bend angle in degrees, positive bends toward +Z (up) for base flanges.
 */
export interface SheetFlange {
  id: string;
  edge: '+x' | '-x' | '+y' | '-y' | 'far';
  length: number;
  angle: number;
  /** Width along the edge (default: full edge minus reliefs). */
  width?: number;
  /** Offset of the flange centre along the edge from the edge midpoint. */
  offset?: number;
  /** Inside bend radius override. */
  bendRadius?: number;
  holes?: SheetHole[];
  flanges?: SheetFlange[];
}

/**
 * Sheet-metal part. Base face: rectangle centred at the origin in XY, occupying z ∈ [0, thickness].
 */
export interface SheetMetalPart extends MechPartBase {
  kind: 'sheet-metal';
  thickness: number;
  /** Default inside bend radius (mm). */
  bendRadius: number;
  kFactor: number;
  base: { width: number; length: number; cornerRadius?: number };
  holes: SheetHole[];
  flanges: SheetFlange[];
  reliefs?: 'rect' | 'obround' | 'none';
}

/* ------------------------------------------ Custom CSG ----------------------------------------- */

export type CsgNode =
  | { op: 'union' | 'difference' | 'intersection'; children: CsgNode[]; transform?: Transform3 }
  | { shape: 'box'; size: Vec3; center?: boolean; radius?: number; transform?: Transform3 }
  | { shape: 'cylinder'; radius: number; height: number; radiusTop?: number; segments?: number; center?: boolean; transform?: Transform3 }
  | { shape: 'sphere'; radius: number; transform?: Transform3 }
  /** Polygon in XY extruded along +Z. */
  | { shape: 'extrude'; points: Vec2[]; height: number; transform?: Transform3 }
  /** Profile (r, z) revolved about the Z axis. */
  | { shape: 'revolve'; profile: Vec2[]; segments?: number; transform?: Transform3 };

/** Custom part described by CSG (knobs, light pipes, brackets, CNC blocks). Local frame is the CSG frame. */
export interface CustomPart extends MechPartBase {
  kind: 'custom';
  csg: CsgNode;
}

/** Off-the-shelf mechanical item (fan, display, battery pack, knob) referencing a distributor PartDef. */
export interface PurchasedPart extends MechPartBase {
  kind: 'purchased';
  partId: string;
  /** Simple envelope for rendering/collision when no 3D model exists. Local frame centred, z from 0 to size[2]. */
  envelope: Vec3;
  /** Axial fan data for airflow simulation (fans blow along local +Z). */
  fan?: { maxFlowM3s: number; maxPressurePa: number; voltage: number; current: number };
}

export type MechPart = EnclosureShell | SheetMetalPart | CustomPart | PurchasedPart;

/* ------------------------------------------- Assembly ------------------------------------------ */

export interface AssemblyInstance {
  id: string;
  name: string;
  target: { kind: 'board'; boardId: string } | { kind: 'mech'; partId: string };
  transform: Transform3;
  /** Exploded-view offset (mm). */
  explode?: Vec3;
  visible?: boolean;
}

export interface FastenerInstance {
  id: string;
  /** PartDef with a FastenerSpec. */
  partId: string;
  /** Assembly-frame position: bearing point under the head (screws) / centre (nuts, inserts). */
  position: Vec3;
  /** Unit vector of insertion (head → tip). */
  direction: Vec3;
  /** Assembly instance ids this fastener clamps/joins. */
  joins: string[];
  note?: string;
}

export interface Assembly {
  instances: AssemblyInstance[];
  fasteners: FastenerInstance[];
}
