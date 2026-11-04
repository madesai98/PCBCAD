import type { NumArray, PackedArray, Vec2, Vec3 } from './common';

/* ------------------------------------------------------------------------------------------------
 * Simulation runs (metadata stored in the project) and result payloads (stored as JSON assets,
 * referenced by SimulationRun.resultAssetId).
 * ---------------------------------------------------------------------------------------------- */

export type SimKind =
  | 'circuit-op'
  | 'circuit-transient'
  | 'mixed-signal'
  | 'pcb-thermal'
  | 'structural'
  | 'drop'
  | 'airflow';

export type MetricStatus = 'ok' | 'warn' | 'fail';

export interface SimMetric {
  label: string;
  value: number;
  unit: string;
  status?: MetricStatus;
  /** Optional limit the value was compared against. */
  limit?: number;
}

export interface SimSummary {
  /** One-line human summary, e.g. "Max junction 61.2 °C (U2, LDO) — OK". */
  headline: string;
  metrics: SimMetric[];
  warnings: string[];
  pass?: boolean;
}

export interface SimulationRun {
  id: string;
  kind: SimKind;
  title: string;
  target: { boardId?: string; partIds?: string[]; system?: boolean; assembly?: boolean };
  params: Record<string, unknown>;
  status: 'queued' | 'running' | 'done' | 'error';
  progress?: number;
  createdAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: SimSummary;
  resultAssetId?: string;
  error?: string;
}

/* ------------------------------------------- Circuit ------------------------------------------- */

export interface CircuitOpResult {
  kind: 'circuit-op';
  /** net id -> volts */
  nodeVoltages: Record<string, number>;
  /** net id -> display name ("board/NET") */
  netNames: Record<string, string>;
  /** component id -> dissipated power (W) */
  componentPower: Record<string, number>;
  /** component id -> pin number -> current INTO the pin (A) */
  pinCurrents: Record<string, Record<string, number>>;
  /** interconnect conductor id -> current (A), from -> to positive */
  conductorCurrents?: Record<string, number>;
  /** Power delivered by each source component (W). */
  sourcePower?: Record<string, number>;
  converged: boolean;
  iterations: number;
  warnings: string[];
}

export interface Waveform {
  name: string;
  kind: 'voltage' | 'current' | 'digital' | 'power';
  unit: string;
  netId?: string;
  componentId?: string;
  pin?: string;
  data: NumArray;
}

export interface CircuitTransientResult {
  kind: 'circuit-transient';
  time: NumArray;
  signals: Waveform[];
  /** component id -> average power over the run (W) */
  avgPower: Record<string, number>;
  netNames: Record<string, string>;
  warnings: string[];
}

export interface MixedSignalResult {
  kind: 'mixed-signal';
  /** Simulated duration (s). */
  duration: number;
  /** Wall-clock run time (ms). */
  wallMs: number;
  uart: { componentId: string; ref: string; port: string; text: string }[];
  /** Digital pin activity as transitions [time s, level 0|1] (level -1 = high-Z). */
  digital: { name: string; componentId: string; pin: string; transitions: [number, number][] }[];
  /** Sampled analog nodes. */
  analog: { time: NumArray; signals: Waveform[] };
  /** Indicators (LEDs etc.): fraction of time on and mean current. */
  indicators: { componentId: string; ref: string; color?: string; onFraction: number; meanCurrent: number }[];
  log: { t: number; source: string; level: 'info' | 'warn' | 'error'; msg: string }[];
  mcus: { componentId: string; ref: string; emulator: string; firmware?: string; cycles: number; clockHz: number; status: string }[];
  avgPower: Record<string, number>;
  warnings: string[];
}

/* --------------------------------------------- PCB thermal ------------------------------------- */

export interface Grid2 {
  nx: number;
  ny: number;
  /** Cell (0,0) lower-left corner in board frame (mm). */
  x0: number;
  y0: number;
  /** Cell size (mm). */
  dx: number;
  dy: number;
}

export interface PcbThermalResult {
  kind: 'pcb-thermal';
  boardId: string;
  ambient: number;
  /** Convection model used. */
  convection: { mode: 'natural' | 'forced'; hTop: number; hBottom: number; airVelocity?: number };
  grid: Grid2;
  /** 1 inside the board outline, 0 outside; length nx*ny, row-major (index = j*nx + i). */
  mask: PackedArray | number[];
  /** Temperature (°C) per cell, row-major, for each analysed layer. */
  layers: { layer: 'top' | 'bottom'; temperature: NumArray }[];
  components: {
    componentId: string;
    ref: string;
    power: number;
    tBoard: number;
    tCase: number;
    tJunction: number;
    tjMax?: number;
    status: 'ok' | 'warn' | 'fail';
  }[];
  traces: {
    traceId: string;
    netId: string;
    segment: number;
    current: number;
    /** A/mm² */
    currentDensity: number;
    /** IPC-2152/2221 estimated temperature rise of the conductor (°C). */
    tempRise: number;
    /** IPC-2221 current capacity for 10 °C rise (A). */
    ipcCapacity: number;
    /** Voltage drop along the segment (V). */
    voltageDrop: number;
    status: 'ok' | 'warn' | 'fail';
  }[];
  /** Per-net IR drop: worst voltage drop from source pin to any load pin (V). */
  netDrops?: { netId: string; name: string; maxDrop: number; current: number }[];
  maxTemp: number;
  totalPower: number;
}

/* ----------------------------------------- Voxel models ---------------------------------------- */

export interface VoxelGridSpec {
  nx: number;
  ny: number;
  nz: number;
  /** Voxel edge length (mm). */
  h: number;
  /** World position (mm) of the min corner of voxel (0,0,0). */
  origin: Vec3;
}

/**
 * Material-indexed voxel grid. cells[i + nx*(j + ny*k)] = material index (0 = empty/air).
 * materials[index - 1] is the material id for index >= 1.
 */
export interface VoxelGrid extends VoxelGridSpec {
  cells: Uint8Array;
  materials: string[];
  /** Optional per-voxel tag (e.g. which part/instance it belongs to), same indexing. */
  tags?: Uint16Array;
  tagNames?: string[];
}

export interface StructuralResult {
  kind: 'structural';
  title: string;
  grid: VoxelGridSpec;
  /** Linear indices of solid voxels (u32). */
  solid: NumArray;
  /** Material index per solid voxel (u8). */
  solidMaterial?: NumArray;
  /** von Mises stress per solid voxel (MPa). */
  vonMises: NumArray;
  /** Displacement per solid voxel (xyz triplets, mm). */
  displacement: NumArray;
  maxVonMises: number;
  maxDisplacement: number;
  /** min over voxels of yield / vonMises */
  minSafetyFactor: number;
  /** Location (mm) of the max stress. */
  maxStressAt: Vec3;
  loads: string[];
  fixtures: string[];
  massGrams: number;
  solver: { iterations: number; residual: number; dofs: number; converged: boolean };
  materials: { id: string; name: string; E: number; yieldStrength: number }[];
}

export interface DropResult {
  kind: 'drop';
  heightM: number;
  orientation: string;
  impactVelocity: number;
  /** Peak deceleration in g. */
  peakG: number;
  peakForceN: number;
  contactDurationMs: number;
  stopDistanceMm: number;
  massGrams: number;
  method: string;
  structural: StructuralResult;
  componentRisks: { componentId: string; ref: string; massGrams: number; inertialForceN: number; risk: 'low' | 'medium' | 'high'; note: string }[];
}

export interface AirflowResult {
  kind: 'airflow';
  mode: 'natural' | 'forced';
  ambient: number;
  grid: VoxelGridSpec;
  /** Per cell: 0 = air, 1.. = solid material index. */
  cells: NumArray;
  /** Temperature per cell (°C). */
  temperature: NumArray;
  /** Velocity per cell (xyz triplets, m/s). */
  velocity: NumArray;
  /** Seeded streamlines (mm) for visualisation. */
  streamlines: Vec3[][];
  components: { componentId: string; ref: string; power: number; temperature: number }[];
  vents: { name: string; flowM3s: number; direction: 'in' | 'out' }[];
  maxAirTemp: number;
  meanAirTemp: number;
  maxSolidTemp: number;
  /** Heat removed via vents (advection) vs through walls (conduction+external convection), W. */
  heatBalance: { input: number; vents: number; walls: number };
  iterations: number;
  converged: boolean;
}

export type SimResult =
  | CircuitOpResult
  | CircuitTransientResult
  | MixedSignalResult
  | PcbThermalResult
  | StructuralResult
  | DropResult
  | AirflowResult;

/* -------------------------------------------- Issues ------------------------------------------- */

export interface DesignIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  category: 'drc' | 'erc' | 'dfm' | 'assembly' | 'sim' | 'part' | 'interconnect';
  /** Machine-readable code, e.g. 'clearance', 'unrouted', 'min-wall', 'draft', 'bend-radius'. */
  code: string;
  message: string;
  target?: {
    boardId?: string;
    componentIds?: string[];
    netIds?: string[];
    traceIds?: string[];
    partId?: string;
    instanceIds?: string[];
  };
  /** Board-frame (2D) or assembly/part-frame (3D) location. */
  at?: Vec2 | Vec3;
  suggestion?: string;
}

/* --------------------------------------- Firmware & behaviour ---------------------------------- */

export interface FirmwareImage {
  id: string;
  name: string;
  format: 'hex' | 'bin' | 'uf2' | 'elf';
  size: number;
  sha256: string;
  assetId: string;
  /** Intended emulator target, e.g. 'avr:atmega328p', 'rp2040'. */
  target?: string;
  uploadedAt: string;
  notes?: string;
}

/**
 * JavaScript behaviour model for a chip (kind 'chip') or a full CPU emulator (kind 'mcu-emulator').
 * See packages/sim/src/mixed/README.md for the scripting API.
 */
export interface BehaviorScript {
  id: string;
  name: string;
  kind: 'chip' | 'mcu-emulator';
  code: string;
  description?: string;
  updatedAt: string;
  author: 'agent' | 'user' | 'builtin';
}
