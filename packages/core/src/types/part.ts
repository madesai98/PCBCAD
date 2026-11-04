import type { NumArray, Vec2, Vec3 } from './common';

/* ------------------------------------------------------------------------------------------------
 * Parts: everything that can be bought from a distributor (electronic components, connectors,
 * cables, fasteners) is a PartDef stored once per project in Project.parts (keyed by PartDef.id)
 * and referenced by instances (ComponentInstance.partId, FastenerInstance.partId, ...).
 * ---------------------------------------------------------------------------------------------- */

export type PartCategory =
  | 'resistor'
  | 'capacitor'
  | 'capacitor-polarized'
  | 'inductor'
  | 'ferrite'
  | 'diode'
  | 'zener'
  | 'schottky'
  | 'tvs'
  | 'led'
  | 'bjt-npn'
  | 'bjt-pnp'
  | 'mosfet-n'
  | 'mosfet-p'
  | 'ldo'
  | 'dc-dc'
  | 'mcu'
  | 'ic'
  | 'opamp'
  | 'comparator'
  | 'sensor'
  | 'memory'
  | 'logic'
  | 'driver'
  | 'interface'
  | 'rf-module'
  | 'module'
  | 'connector'
  | 'crystal'
  | 'oscillator'
  | 'switch'
  | 'button'
  | 'relay'
  | 'fuse'
  | 'battery'
  | 'buzzer'
  | 'display'
  | 'antenna'
  | 'testpoint'
  | 'fastener'
  | 'mechanical'
  | 'cable'
  | 'wire'
  | 'other';

export type PinType =
  | 'input'
  | 'output'
  | 'bidirectional'
  | 'tristate'
  | 'passive'
  | 'power_in'
  | 'power_out'
  | 'open_collector'
  | 'open_emitter'
  | 'nc'
  | 'unspecified';

export interface PinDef {
  /** Pad/pin number as printed in the datasheet: "1", "A1", "EP". Matches PadDef.number. */
  number: string;
  /** Pin name: "VDD", "PB5", "GPIO25", "~RESET". */
  name: string;
  type: PinType;
  /** Alternate functions, e.g. ["I2C0_SDA", "UART1_TX", "ADC0"]. */
  functions?: string[];
  /** Schematic symbol hint. */
  side?: 'left' | 'right' | 'top' | 'bottom';
}

/* ----------------------------------------- Footprints ----------------------------------------- */

export interface PadDef {
  /** Pad number; several pads may share a number (e.g. thermal pad split, mounting tabs). */
  number: string;
  shape: 'rect' | 'roundrect' | 'circle' | 'oval' | 'polygon';
  /** Pad centre in footprint frame (mm, Y up). */
  x: number;
  y: number;
  /** Size before rotation (mm). For circle, w = h = diameter. */
  w: number;
  h: number;
  /** Degrees CCW. */
  rotation?: number;
  /** roundrect corner radius as a ratio of min(w,h) (0..0.5). Default 0.25. */
  roundness?: number;
  /** For 'polygon': vertices relative to pad centre (before rotation). */
  polygon?: Vec2[];
  /** smd = copper on the component side only; tht = plated through hole on all copper layers; npth = non-plated hole. */
  kind: 'smd' | 'tht' | 'npth';
  /** Drill diameter (tht/npth). */
  drill?: number;
  /** Slotted hole size (overrides drill). */
  slot?: { w: number; h: number };
  /** Solder paste aperture ratio (0..1); default 1 for smd, 0 for tht. */
  pasteRatio?: number;
}

export type GraphicLayer = 'silk' | 'fab' | 'courtyard';

export type Graphic =
  | { kind: 'line'; layer: GraphicLayer; a: Vec2; b: Vec2; width: number }
  | { kind: 'polyline'; layer: GraphicLayer; points: Vec2[]; width: number; closed?: boolean; fill?: boolean }
  | { kind: 'circle'; layer: GraphicLayer; c: Vec2; r: number; width: number; fill?: boolean }
  /** start/end angles in degrees CCW from +X. */
  | { kind: 'arc'; layer: GraphicLayer; c: Vec2; r: number; start: number; end: number; width: number }
  | { kind: 'text'; layer: GraphicLayer; at: Vec2; text: string; size: number; rotation?: number };

/** Families understood by the footprint + 3D body generators in @pcbcad/parts. */
export type PackageFamily =
  | 'chip' // 0201..2512 resistors/caps/inductors/LEDs
  | 'sod123'
  | 'sod323'
  | 'sma'
  | 'smb'
  | 'smc'
  | 'melf'
  | 'sot23' // SOT-23-3/5/6
  | 'sot223'
  | 'sot89'
  | 'to252'
  | 'soic'
  | 'ssop'
  | 'tssop'
  | 'msop'
  | 'qfn'
  | 'dfn'
  | 'qfp' // LQFP/TQFP
  | 'lga'
  | 'bga'
  | 'dip'
  | 'to92'
  | 'to220'
  | 'header' // 2.54/2.0/1.27 pin headers & sockets
  | 'jst-ph'
  | 'jst-xh'
  | 'jst-sh'
  | 'usb-c'
  | 'usb-micro'
  | 'crystal-smd'
  | 'hc49'
  | 'electrolytic-smd'
  | 'electrolytic-tht'
  | 'inductor-smd' // shielded power inductors (e.g. 4x4, 5x5, 6x6)
  | 'tactile-switch'
  | 'led-tht'
  | 'terminal-block'
  | 'battery-holder'
  | 'module' // castellated / generic rectangular modules
  | 'custom';

export interface PackageSpec {
  family: PackageFamily;
  /** Total pin count. */
  pins?: number;
  /** Pin pitch (mm). */
  pitch?: number;
  /** Body dimensions: bodyW along X, bodyL along Y, bodyH height (mm). */
  bodyW?: number;
  bodyL?: number;
  bodyH?: number;
  /** Toe-to-toe lead span for gull-wing packages (mm). */
  leadSpan?: number;
  padW?: number;
  padH?: number;
  /** Header/connector rows. */
  rows?: number;
  exposedPad?: { w: number; h: number };
  /** Chip size code (imperial): '0201','0402','0603','0805','1206','1210','2010','2512'. */
  size?: string;
  orientation?: 'vertical' | 'horizontal' | 'right-angle';
  /** Free-form extra parameters for specific generators. */
  extra?: Record<string, number | string | boolean>;
}

export type FacetStatus = 'fetched' | 'generated' | 'agent' | 'builtin' | 'missing';

export interface FootprintDef {
  name: string;
  pads: PadDef[];
  graphics: Graphic[];
  /** Courtyard (keep-out) bbox in footprint frame. */
  courtyard: { minX: number; minY: number; maxX: number; maxY: number };
  source: FacetStatus;
  /** Present when generated from a parametric package description. */
  generator?: PackageSpec;
}

/* ------------------------------------------- 3D models ---------------------------------------- */

export type BodyPrimitive =
  | {
      kind: 'box';
      /** centre (mm), footprint frame, z = 0 at board surface (component side), +z away from board. */
      center: Vec3;
      size: Vec3;
      /** Euler degrees XYZ */
      rotation?: Vec3;
      color: string;
      metal?: boolean;
      /** fillet radius applied to all edges when rendered (visual only) */
      radius?: number;
    }
  | {
      kind: 'cylinder';
      center: Vec3;
      radius: number;
      height: number;
      axis: 'x' | 'y' | 'z';
      color: string;
      metal?: boolean;
      segments?: number;
    }
  | {
      /** Extruded closed polygon in the XY plane from z0 to z1. */
      kind: 'extrusion';
      points: Vec2[];
      z0: number;
      z1: number;
      color: string;
      metal?: boolean;
    };

/** Triangle mesh with material groups (used for fetched 3D models and generated mechanical meshes). */
export interface MeshGroup {
  name?: string;
  color: string;
  opacity?: number;
  metal?: boolean;
  /** xyz triplets (mm) */
  positions: NumArray;
  /** triangle vertex indices; if absent, positions are a triangle soup */
  indices?: NumArray;
  /** optional per-vertex normals */
  normals?: NumArray;
}

export interface MeshData {
  groups: MeshGroup[];
  bbox?: { min: Vec3; max: Vec3 };
}

export interface Model3D {
  /** 'primitives' = generated parametric body; 'mesh' = MeshData stored as a project asset (fetched OBJ converted). */
  kind: 'primitives' | 'mesh';
  primitives?: BodyPrimitive[];
  /** Asset id (MeshData JSON) for kind === 'mesh'. */
  meshAssetId?: string;
  /** Original STEP model location, if known (for MCAD export). */
  stepUrl?: string;
  stepAssetId?: string;
  /** Additional placement relative to the footprint frame (applied after the model's own coords). */
  offset?: Vec3;
  rotation?: Vec3;
  source: FacetStatus;
}

/* --------------------------------------- Simulation models ------------------------------------ */

/**
 * How a part behaves in circuit / mixed-signal simulation. Pin references are pin NUMBERS.
 * Values are SI.
 */
export type PartSimModel =
  | { kind: 'resistor'; R: number; pins?: [string, string] }
  | { kind: 'capacitor'; C: number; esr?: number; pins?: [string, string] }
  | { kind: 'inductor'; L: number; dcr?: number; pins?: [string, string] }
  | { kind: 'ferrite'; R: number; pins?: [string, string] }
  | { kind: 'diode'; anode: string; cathode: string; Is?: number; n?: number; Rs?: number; Vf?: number; If?: number; Bv?: number }
  | { kind: 'led'; anode: string; cathode: string; Vf: number; If: number; color?: string; Rs?: number }
  | { kind: 'bjt'; polarity: 'npn' | 'pnp'; b: string; c: string; e: string; beta: number; Is?: number }
  | { kind: 'mosfet'; polarity: 'n' | 'p'; g: string; d: string; s: string; Vth: number; Rds_on: number; Vgs_rated?: number }
  /** Ideal-ish voltage source with internal resistance (batteries, bench supply, USB VBUS). */
  | { kind: 'vsource'; p: string; n: string; V: number; Rint?: number }
  /** Linear regulator: output = min(Vout, Vin - dropout), quiescent current Iq from IN to GND. */
  | { kind: 'ldo'; in: string; out: string; gnd: string; Vout: number; dropout: number; Iq?: number; Imax?: number }
  /** Switching regulator (averaged): input power = output power / efficiency. */
  | { kind: 'buck'; in: string; out: string; gnd: string; Vout: number; efficiency: number; Iq?: number; Imax?: number }
  | { kind: 'switch'; a: string; b: string; closed: boolean; Ron?: number }
  | { kind: 'fuse'; a: string; b: string; R: number; Ihold: number }
  | { kind: 'opamp'; inp: string; inn: string; out: string; vp: string; vn: string; gain?: number; gbw?: number; Rout?: number }
  | { kind: 'crystal'; a: string; b: string; freq: number }
  /** Generic IC: draws Icc between supply and ground pins; optional behaviour script drives pins. */
  | { kind: 'ic'; supplyPins: string[]; groundPins: string[]; Icc: number; behaviorId?: string }
  /**
   * Microcontroller. `emulator` selects a CPU emulator: 'avr:atmega328p', 'rp2040', or 'script:<behaviorId>'
   * for an agent-authored emulator. pinMap maps emulator port names (e.g. "PB5", "GPIO25") to pin numbers.
   */
  | {
      kind: 'mcu';
      emulator: string;
      clockHz: number;
      supplyPins: string[];
      groundPins: string[];
      Icc: number;
      pinMap: Record<string, string>;
      firmwareId?: string;
      /** Logic thresholds as fraction of supply (default VIL 0.3, VIH 0.6), output resistance (Ω, default 25). */
      vilRatio?: number;
      vihRatio?: number;
      rout?: number;
    }
  /** Connectors/test points are transparent: their pins are just net nodes. Mating is handled by Interconnects. */
  | { kind: 'connector' }
  | { kind: 'none' };

/* ---------------------------------------- Connector spec -------------------------------------- */

/**
 * Makes ANY distributor connector "functional": defines what it mates with and its electrical
 * properties so multi-board interconnects can be validated and simulated.
 */
export interface ConnectorSpec {
  /** Series/family, e.g. 'JST-PH', 'JST-XH', 'USB-C', 'Molex-PicoBlade', 'Header-2.54'. */
  family: string;
  gender: 'male' | 'female' | 'genderless';
  /** board = mounted on a PCB; cable = crimp housing / plug on a cable; panel = panel mount. */
  role: 'board' | 'cable' | 'panel';
  positions: number;
  pitch?: number;
  /** Families (optionally "family:gender") or part ids this connector mates with. */
  matesWith: string[];
  /** Mated contact resistance per contact (Ω). */
  contactResistance: number;
  /** Rated current per contact (A). */
  currentRating: number;
  voltageRating?: number;
  matingCycles?: number;
  /** Pin mapping to the mating connector (this pin -> mate pin). Default identity. */
  pinMap?: Record<string, string>;
  /** Accepted wire gauge range for crimp contacts [min AWG number, max AWG number]. */
  awgRange?: [number, number];
  /** Direction of the mating face in footprint frame. */
  matingDirection?: '+x' | '-x' | '+y' | '-y' | '+z';
  /** Size of the opening needed in an enclosure wall (mm) and its centre height above the board surface. */
  opening?: { width: number; height: number; zCenter: number };
  /** Who configured this spec. */
  configuredBy?: 'builtin' | 'agent' | 'user';
}

/* ----------------------------------------- Fasteners ------------------------------------------ */

export interface FastenerSpec {
  type:
    | 'screw'
    | 'self-tapping-screw'
    | 'bolt'
    | 'nut'
    | 'washer'
    | 'standoff'
    | 'heat-set-insert'
    | 'pem-nut'
    | 'pem-standoff'
    | 'rivet';
  /** Thread designation: 'M2', 'M2.5', 'M3', '#4-40'. */
  thread?: string;
  /** Nominal (major) diameter, mm. */
  diameter: number;
  /** Length (screws: under head; standoffs/inserts: body length), mm. */
  length?: number;
  head?: 'pan' | 'socket' | 'flat' | 'button' | 'hex' | 'none';
  headDiameter?: number;
  headHeight?: number;
  drive?: 'phillips' | 'hex' | 'torx' | 'slotted' | 'none';
  /** Outer diameter (inserts, round standoffs) or across-flats (nuts, hex standoffs), mm. */
  outerDiameter?: number;
  /** Recommended hole in the mating part: clearance hole for screws, install hole for inserts/PEMs, mm. */
  holeDiameter?: number;
  /** Material id from the materials library (e.g. 'steel-zinc', 'ss-a2', 'brass', 'nylon-66'). */
  materialId: string;
  /** e.g. '8.8', 'A2-70', '4.8' */
  strengthClass?: string;
  /** Tensile proof load (N). */
  proofLoad?: number;
  /** Female thread at both ends etc. */
  ends?: 'female-female' | 'male-female' | 'male-male';
}

/* ------------------------------------------- Parts -------------------------------------------- */

export interface PriceBreak {
  qty: number;
  price: number;
}

export interface DistributorOffer {
  distributor: 'LCSC' | 'JLCPCB' | 'DigiKey' | 'Mouser' | 'Nexar' | 'McMaster' | 'Other';
  sku: string;
  url?: string;
  stock?: number;
  currency?: string;
  priceBreaks?: PriceBreak[];
  moq?: number;
  /** JLCPCB assembly library type. */
  libraryType?: 'basic' | 'extended' | 'preferred';
  fetchedAt?: string;
}

export interface PartProvenance {
  specs: FacetStatus;
  symbol: FacetStatus;
  footprint: FacetStatus;
  model3d: FacetStatus;
  sim: FacetStatus;
  /** Where the data came from, e.g. 'JLCPCB/LCSC + EasyEDA library', 'builtin', 'agent'. */
  source: string;
  /** Attribution text required/appropriate for the data source (shown in the UI). */
  attribution?: string;
  fetchedAt?: string;
  notes?: string[];
}

export interface PartDef {
  /** Stable key, usually the LCSC code ('C92489') or 'custom:<slug>'. */
  id: string;
  mpn: string;
  manufacturer: string;
  description: string;
  category: PartCategory;
  /** Package name as given by the distributor, e.g. 'LGA-8(2.5x2.5)', '0805', 'SOT-223'. */
  package: string;
  /** Normalised parametric package (when recognised); drives generators. */
  packageSpec?: PackageSpec;
  /** Value for passives: '10k', '100nF', '4.7uH'. */
  value?: string;
  /** Raw distributor parameters, e.g. {'Voltage - Supply': '1.71V~3.6V'}. */
  params: Record<string, string>;
  offers: DistributorOffer[];
  datasheetUrl?: string;
  imageUrl?: string;
  pins: PinDef[];
  footprint?: FootprintDef;
  model3d?: Model3D;
  /** Body envelope (mm) used for collision checks and fallbacks: w along X, l along Y, h height. */
  body?: { w: number; l: number; h: number };
  sim?: PartSimModel;
  thermal?: {
    /** Junction-to-ambient (°C/W) on a reference board. */
    thetaJA?: number;
    /** Junction-to-case (°C/W). */
    thetaJC?: number;
    /** Maximum junction temperature (°C). */
    tjMax?: number;
  };
  ratings?: { voltage?: number; current?: number; power?: number; tempMin?: number; tempMax?: number };
  connector?: ConnectorSpec;
  fastener?: FastenerSpec;
  massGrams?: number;
  provenance: PartProvenance;
}
