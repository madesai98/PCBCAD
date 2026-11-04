/**
 * @pcbcad/sim — circuit simulation (browser-safe).
 *
 *  - {@link buildCircuit}: Project (board or multi-board system) → Circuit netlist.
 *  - {@link solveOp}: DC operating point (MNA + damped Newton, gmin/source stepping).
 *  - {@link solveTransient}: transient analysis (trapezoidal / backward Euler).
 *  - {@link MnaSystem} / {@link CircuitProbe}: reusable compiled system for repeated solves
 *    (used by the mixed-signal co-simulation).
 */
export { buildCircuit, isGroundNet } from './build';
export type { BuildCircuitOptions } from './build';
export { solveOp, solveTransient, opResultFromSystem, CircuitProbe } from './analysis';
export { MnaSystem } from './mna';
export type { DcResult, NewtonResult } from './mna';
export { DriverModel, thermalVoltage } from './devices';
export type { DriveMode, Model as CircuitModel } from './devices';
export { makeWaveform, parsePwl } from './waveforms';
export type { Waveform as SourceWaveform } from './waveforms';
export { SparseLU, PatternBuilder, minimumDegreeOrder } from './linalg';
export type { CscPattern } from './linalg';
export type {
  Circuit,
  CircuitComponent,
  CircuitConductor,
  CircuitDevice,
  CircuitTarget,
  DeviceKind,
  DeviceParam,
  OpOptions,
  TransientOptions,
} from './types';
