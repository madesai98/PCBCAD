/**
 * Circuit netlist representation produced by `buildCircuit()` and consumed by the solvers.
 * Plain JSON-compatible data so agents/UI can inspect what was simulated.
 *
 * Node keys: the net id of each simulated net; `'0'` is the reference ground. In system
 * (multi-board) runs the ground nets of non-reference boards become `gnd@<boardId>` nodes that are
 * tied to the reference through the interconnect conductors. Internal helper nodes use
 * `<deviceId>#<name>`.
 */

/** Simulation target: one board or the whole multi-board system. */
export type CircuitTarget = { boardId: string } | { system: true };

/** Primitive device kinds understood by the MNA engine. */
export type DeviceKind =
  | 'resistor'
  | 'capacitor'
  | 'inductor'
  | 'vsource'
  | 'isource'
  | 'diode'
  | 'bjt'
  | 'mosfet'
  | 'ldo'
  | 'buck'
  | 'opamp'
  | 'load'
  | 'driver';

/** Parameter value as stored on a device (SI units; strings only for waveforms/labels). */
export type DeviceParam = number | string | boolean;

/**
 * One primitive device.
 *
 * Terminals (keys of `nodes`) per kind:
 *  - resistor/capacitor/inductor/vsource/isource: `p`, `n` (current positive p → n through the device)
 *  - diode: `a`, `k`
 *  - bjt: `c`, `b`, `e`;  mosfet: `d`, `g`, `s`
 *  - ldo / buck: `in`, `out`, `gnd`
 *  - opamp: `inp`, `inn`, `out`, `vp`, `vn`
 *  - load (IC/MCU supply current): `vcc0..`, `gnd0..`
 *  - driver (digital pin output stage): `pin`, `sup`, `gnd`
 *
 * Params per kind (SI):
 *  - resistor: R (Ω). capacitor: C (F), esr (Ω). inductor: L (H), dcr (Ω).
 *  - vsource: V (V), Rint (Ω), waveform ('dc'|'pulse'|'sin'|'pwl') + v1,v2,td,tr,tf,pw,per | vo,va,freq,td,theta,phase | points
 *  - isource: I (A, flowing p → n through the source, i.e. out of n into the circuit)
 *  - diode: Is (A), n, Rs (Ω), Bv (V, 0 = none), Ibv (A at -Bv)
 *  - bjt: polarity (+1 npn / -1 pnp), Is, betaF, betaR
 *  - mosfet: polarity (+1 n / -1 p), Vth (V, magnitude), K (A/V²), lambda (1/V)
 *  - ldo: Vout, dropout, Iq, Imax;  buck: Vout, efficiency, Iq, Imax, mode ('buck'|'boost'|'buck-boost'), uvlo
 *  - opamp: gain, Rout, Iq
 *  - load: Icc (A), von (V, supply voltage above which the load draws current)
 *  - driver: mode, rout, rpull, vfix (supply voltage used when `sup` is unconnected)
 */
export interface CircuitDevice {
  /** Unique device id within the circuit (component id, optionally with `#suffix`). */
  id: string;
  kind: DeviceKind;
  /** Finer classification: 'led','zener','tvs','schottky','ferrite','fuse','switch','link','leak','battery','ic','mcu','body-diode','rail','jumper'. */
  role?: string;
  /** Owning component (absent for interconnect links and leaks). */
  componentId?: string;
  /** Interconnect conductor id for `role: 'link'` resistors. */
  conductorId?: string;
  /** terminal -> node key ('0' = reference ground) */
  nodes: Record<string, string>;
  /** terminal -> component pin number (used for pinCurrents). */
  pins?: Record<string, string>;
  params: Record<string, DeviceParam>;
}

export interface CircuitComponent {
  id: string;
  ref: string;
  boardId: string;
  boardName: string;
  partId: string;
  category: string;
  /** Connected pins: pin number -> node key. */
  pinNodes: Record<string, string>;
  /** Pin number -> net id (as on the board). */
  pinNets: Record<string, string>;
  /** Display colour for LEDs. */
  color?: string;
  /** Power rating (W) if known. */
  powerRating?: number;
  /** Simulation model kind used ('resistor','mcu',..., or 'none'). */
  model: string;
}

export interface CircuitConductor {
  id: string;
  interconnectId: string;
  nodeA: string;
  nodeB: string;
  resistance: number;
  currentRating: number;
}

export interface Circuit {
  target: CircuitTarget;
  /** Non-ground node keys (the solver's unknown voltages, before internal nodes). */
  nodes: string[];
  /** net id -> node key (ground nets map to '0' or their board-ground node). */
  netToNode: Record<string, string>;
  /** net id -> display name ('NET' or 'Board/NET' for system runs). */
  netNames: Record<string, string>;
  devices: CircuitDevice[];
  components: Record<string, CircuitComponent>;
  conductors: CircuitConductor[];
  /** Ambient/junction temperature used for semiconductor thermal voltage (°C). */
  temperatureC: number;
  warnings: string[];
}

/** Options for {@link solveOp}. */
export interface OpOptions {
  /** Max Newton iterations per attempt (default 150). */
  maxIter?: number;
  /** Relative tolerance (default 1e-6). */
  reltol?: number;
  /** Absolute voltage tolerance (V, default 1e-6). */
  vntol?: number;
  /** Absolute current tolerance (A, default 1e-12). */
  abstol?: number;
  /** Time at which waveform sources are evaluated (s, default 0). */
  time?: number;
}

/** Options for {@link solveTransient}. */
export interface TransientOptions {
  /** End time (s). */
  tStop: number;
  /** Nominal step / output resolution (s). */
  tStep: number;
  /** Upper bound for the internal step (s, default tStep). */
  maxStep?: number;
  /**
   * Signals to record. Net ids, net names ('VCC', 'Board/VCC') or currents 'I(R1)' / 'I(R1.2)'
   * (component ref or id, optionally a pin). Default: every net voltage + source/inductor currents.
   */
  probes?: string[];
  /** Newton iteration limit per time point (default 50). */
  maxIter?: number;
  reltol?: number;
}
