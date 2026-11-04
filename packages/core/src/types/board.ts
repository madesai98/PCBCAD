import type { CopperLayer, Side, Vec2 } from './common';

export interface Stackup {
  /** Copper layer count. */
  layers: 2 | 4 | 6;
  /** Finished board thickness (mm). */
  thickness: number;
  /** Copper weight in oz/ft² (1 oz ≈ 35 µm). */
  copperOz: { outer: number; inner: number };
  /** Dielectric material id (materials library), normally 'fr4'. */
  dielectric: string;
  finish: 'HASL' | 'LF-HASL' | 'ENIG' | 'OSP';
  maskColor: 'green' | 'black' | 'blue' | 'red' | 'white' | 'purple' | 'yellow';
  silkColor: 'white' | 'black';
}

export interface DesignRules {
  /** Copper-to-copper clearance (mm). */
  clearance: number;
  /** Default signal trace width (mm). */
  traceWidth: number;
  /** Default power/ground trace width (mm). */
  powerTraceWidth: number;
  minTraceWidth: number;
  viaDrill: number;
  viaDiameter: number;
  /** Copper-to-board-edge clearance (mm). */
  edgeClearance: number;
  minDrill: number;
  minAnnularRing: number;
  /** Routing grid used by the autorouter (mm). */
  routingGrid: number;
}

export type NetClass = 'signal' | 'power' | 'ground' | 'high-speed' | 'analog';

export interface Net {
  id: string;
  name: string;
  class: NetClass;
  /** Override trace width for this net (mm). */
  traceWidth?: number;
}

export interface ComponentInstance {
  id: string;
  /** Reference designator: R1, U3, J2. Unique per board. */
  ref: string;
  partId: string;
  /** Overrides PartDef.value for display/BOM (normally the same). */
  value?: string;
  /** Placement origin in board frame (mm). */
  x: number;
  y: number;
  /** Degrees CCW. */
  rotation: number;
  side: Side;
  /** False until the component has been given a real position on the board. */
  placed: boolean;
  locked?: boolean;
  /** Do not populate. */
  dnp?: boolean;
  /** pin number -> net id. Unconnected pins are absent. */
  pinNets: Record<string, string>;
  /** Schematic placement (schematic units are mm on a 2.54 mm grid). */
  schematic?: { x: number; y: number; rotation?: number; group?: string };
  /** Free-form fields: tolerance, notes, assembly hints. */
  fields?: Record<string, string>;
  /** Per-instance MCU configuration overrides (see PartSimModel 'mcu'). */
  mcu?: { emulator?: string; firmwareId?: string; clockHz?: number };
  /** Per-instance behaviour script override. */
  behaviorId?: string;
  /** Per-instance simulation parameter overrides, e.g. {"closed": true} for a switch, {"V": 3.7} for a battery. */
  simOverrides?: Record<string, number | boolean | string>;
}

export interface Trace {
  id: string;
  netId: string;
  layer: CopperLayer;
  width: number;
  /** Polyline vertices in board frame (mm). */
  points: Vec2[];
  locked?: boolean;
}

export interface Via {
  id: string;
  netId: string;
  x: number;
  y: number;
  drill: number;
  diameter: number;
  /** Span; default through (top..bottom). */
  from?: CopperLayer;
  to?: CopperLayer;
}

export interface Zone {
  id: string;
  netId: string;
  layer: CopperLayer;
  /** Zone outline; default = board outline inset by edgeClearance. */
  outline?: Vec2[];
  clearance: number;
  /** Minimum copper width kept when filling (mm). */
  minWidth?: number;
  thermalRelief?: boolean;
  /** Higher priority zones fill first. */
  priority?: number;
  /** Computed fill polygons (outer rings and holes as separate rings; even-odd fill). Filled by the pour engine. */
  fill?: Vec2[][];
}

export interface MountingHole {
  id: string;
  x: number;
  y: number;
  drill: number;
  plated: boolean;
  /** Copper ring diameter for plated holes. */
  padDiameter?: number;
  netId?: string;
  /** Fastener part intended for this hole. */
  fastenerPartId?: string;
}

export interface Board {
  id: string;
  name: string;
  description?: string;
  /** Closed polygon (CCW) in board frame. Rounded corners are pre-tessellated. */
  outline: Vec2[];
  /** Original parametric outline (when created as a rectangle). */
  outlineSpec?: { kind: 'rect'; width: number; height: number; cornerRadius: number };
  /** Internal cutouts (closed polygons). */
  cutouts?: Vec2[][];
  stackup: Stackup;
  rules: DesignRules;
  components: ComponentInstance[];
  nets: Net[];
  traces: Trace[];
  vias: Via[];
  zones: Zone[];
  holes: MountingHole[];
  /** Optional schematic annotations. */
  schematic?: { notes?: { at: Vec2; text: string }[] };
}

/* ---------------------------------------- Interconnects --------------------------------------- */

export interface InterconnectEndpoint {
  boardId: string;
  componentId: string;
  pin: string;
}

export interface Conductor {
  id: string;
  name?: string;
  from: InterconnectEndpoint;
  to: InterconnectEndpoint;
  /** Wire gauge (AWG). */
  awg?: number;
  color?: string;
  /** Conductor length (mm); defaults to Interconnect.length. */
  length?: number;
}

/**
 * Connection between boards.
 *  - 'cable'  : a harness between connector A (board 1) and connector B (board 2) using mating cable
 *               connectors + wire (cableParts) — each conductor has wire + 2× contact resistance.
 *  - 'mated'  : direct board-to-board mating (mezzanine headers, card edge) — contact resistance only.
 *  - 'wires'  : discrete wires soldered to pads/through-holes.
 */
export interface Interconnect {
  id: string;
  name: string;
  kind: 'cable' | 'mated' | 'wires';
  a: { boardId: string; componentId: string };
  b: { boardId: string; componentId: string };
  /** Distributor parts consumed by the cable (housings, crimp terminals, wire). */
  cableParts?: { partId: string; qty: number }[];
  conductors: Conductor[];
  /** Cable length (mm). */
  length?: number;
  awg?: number;
  notes?: string;
}
