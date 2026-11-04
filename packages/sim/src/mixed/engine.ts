/**
 * Mixed-signal co-simulation: MCU emulators + chip behaviour scripts + analog circuit.
 */
import { pack, resolvePins } from '@pcbcad/core';
import type { BehaviorScript, ComponentInstance, MixedSignalResult, PartDef, PartSimModel, Project, Waveform } from '@pcbcad/core';
import { buildCircuit } from '../circuit/build';
import { DiodeModel, type DriveMode, type DriverModel } from '../circuit/devices';
import { MnaSystem } from '../circuit/mna';
import type { CircuitDevice, CircuitTarget } from '../circuit/types';
import { AnalogBridge } from './analog';
import { BUILTIN_BEHAVIORS } from './builtins';
import { ATMEGA328P_TQFP32_GROUND, ATMEGA328P_TQFP32_PINMAP, ATMEGA328P_TQFP32_SUPPLY } from './emulators/pinmaps';
import { registerDefaultEmulators } from './emulators/defaults';
import { getEmulatorFactory } from './emulators/registry';
import { createFunctionSandbox } from './script-api';
import {
  ScriptError,
  type McuEmulator,
  type McuHost,
  type MixedEnvironment,
  type MixedSignalOptions,
  type PinDrive,
  type PinSpec,
  type ScriptInstance,
  type ScriptSandbox,
  type ScriptShape,
  type ScriptValue,
} from './types';

/** Result of {@link runMixedSignal}: the core MixedSignalResult plus script state snapshots. */
export interface MixedSignalRunResult extends MixedSignalResult {
  /** Final `chip.state` of every behaviour-script component (JSON). */
  chipStates: Record<string, unknown>;
  /** Engine statistics. */
  stats: { analogSolves: number; cacheHits: number; analogFailures: number; iterations: number };
}

type McuModel = Extract<PartSimModel, { kind: 'mcu' }>;

interface PinRec {
  pin: string;
  node: string | null;
  driver: DriverModel | null;
  /** Sensed logic level (1/0, -1 = undefined). */
  level: number;
}

interface DigitalTrace {
  name: string;
  pin: string;
  transitions: [number, number][];
  last: number;
  driven: boolean;
  truncated: boolean;
}

interface McuRec {
  id: string;
  ref: string;
  emulatorName: string;
  clockHz: number;
  emu: McuEmulator | null;
  status: string;
  firmware?: string;
  part: PartDef;
  comp: ComponentInstance;
  portPin: Map<string, string>;
  pins: Map<string, PinRec>;
  supplyNode: string | null;
  groundNode: string;
  vil: number;
  vih: number;
  traces: Map<string, DigitalTrace>;
  uart: Map<string, string>;
  dead: boolean;
}

interface ChipRec {
  id: string;
  ref: string;
  behaviorId: string;
  part: PartDef;
  comp: ComponentInstance;
  inst: ScriptInstance | null;
  shape: ScriptShape | null;
  pins: Map<string, PinRec>;
  supplyNode: string | null;
  groundNode: string;
  supplyPins: Set<string>;
  watched: { spec: string | number; pin: string; level: number; select?: boolean }[];
  interval: number;
  nextStep: number;
  lastStep: number;
  errors: number;
  dead: boolean;
  uartOut: string;
  i2c?: { sdaGroup: string | null; sclGroup: string | null };
  spi?: { sckGroup: string | null; mosiGroup: string | null; misoGroup: string | null; csPin: string | null; csActiveHigh: boolean; active: boolean };
  uart?: { rxGroup: string | null; txGroup: string | null };
  pinCache: Map<string, string | null>;
}

const VIL = 0.3;
const VIH = 0.7;

function abortError(): Error {
  const e = new Error('Mixed-signal simulation aborted');
  e.name = 'AbortError';
  return e;
}

const yieldNow = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Run a mixed-signal co-simulation of a board (or the whole system).
 *
 * Quasi-static mode (default): MCU/chip pin drivers are push-pull output stages (rout ≈ 25 Ω to
 * the device supply / ground, high-Z = 1 GΩ, pull-ups ≈ 35 kΩ) stamped into the MNA system; the DC
 * operating point is re-solved whenever a driver changes (coalesced to ≥ `coalesce`, 1 µs) and at
 * least every `sampleInterval` (1 ms) when waveform sources exist. Inputs read node voltages with
 * VIL/VIH thresholds (fractions of the device supply, with hysteresis). 'transient' mode steps the
 * transient solver between events instead.
 *
 * Buses are transaction-level: AVR TWI/RP2040 I2C → chip scripts whose SDA/SCL pins share the MCU
 * bus nets (the bus is checked for pull-ups at each START: without them every address is NACKed
 * and a warning explains why); SPI → scripts whose SCK/MOSI match and whose CS is active; UART
 * bytes → text (and to scripts whose RX is on the MCU TX net).
 */
export async function runMixedSignal(project: Project, target: CircuitTarget, opts: MixedSignalOptions): Promise<MixedSignalRunResult> {
  const wall0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (!(opts.duration > 0)) throw new Error('runMixedSignal: duration must be > 0');
  registerDefaultEmulators();
  const duration = opts.duration;
  const sampleInterval = Math.max(opts.sampleInterval ?? 1e-3, 1e-7);
  const coalesce = Math.max(opts.coalesce ?? 1e-6, 0);
  const maxTransitions = opts.maxTransitions ?? 100_000;
  const env: Required<MixedEnvironment> = {
    temperatureC: opts.environment?.temperatureC ?? project.settings?.ambientC ?? 25,
    pressurePa: opts.environment?.pressurePa ?? 101325,
    humidityPct: opts.environment?.humidityPct ?? 50,
  };
  const warnings: string[] = [];
  const log: MixedSignalResult['log'] = [];
  const warnOnce = new Set<string>();
  const addLog = (t: number, source: string, level: 'info' | 'warn' | 'error', msg: string) => {
    if (log.length < 20000) log.push({ t, source, level, msg });
    else if (!warnOnce.has('logcap')) {
      warnOnce.add('logcap');
      warnings.push('Log truncated at 20000 entries');
    }
  };
  const warn = (key: string, msg: string, t = 0, source = 'sim') => {
    if (warnOnce.has(key)) return;
    warnOnce.add(key);
    warnings.push(msg);
    addLog(t, source, 'warn', msg);
  };

  const circuit = buildCircuit(project, target, { temperatureC: env.temperatureC });
  warnings.push(...circuit.warnings);

  // components (instances + parts) included in the circuit
  const instances = new Map<string, { comp: ComponentInstance; part: PartDef }>();
  for (const b of project.boards) for (const c of b.components) if (circuit.components[c.id]) instances.set(c.id, { comp: c, part: project.parts[c.partId] });

  // behaviour scripts (run options > project > built-ins)
  const behaviors = new Map<string, BehaviorScript>();
  for (const b of BUILTIN_BEHAVIORS) behaviors.set(b.id, b);
  for (const b of project.behaviors ?? []) behaviors.set(b.id, b);
  for (const b of opts.behaviors ?? []) behaviors.set(b.id, b);
  let fnSandbox: ScriptSandbox | null = null;
  // Unmodified built-in scripts are trusted: they always run in-process (fast, no RPC). Anything
  // else (agent/user code, or an edited copy of a built-in) needs the caller's sandbox.
  const trustedCode = new Map(BUILTIN_BEHAVIORS.map((b) => [b.id, b.code]));
  const sandboxFor = (script: BehaviorScript): ScriptSandbox => {
    if (trustedCode.get(script.id) === script.code) return (fnSandbox ??= createFunctionSandbox());
    if (opts.sandbox) return opts.sandbox;
    throw new ScriptError(script.id, `Behaviour script '${script.id}' needs an isolated sandbox: pass opts.sandbox (createNodeSandbox() on the server, or createFunctionSandbox() for trusted code)`);
  };

  // low-resistance connectivity groups (bus matching across 0 Ω / ferrites / interconnect conductors)
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const d of circuit.devices) {
    if (d.kind !== 'resistor' || d.role === 'leak' || d.role === 'switch') continue;
    if (Number(d.params.R) <= 10) {
      const a = find(d.nodes.p);
      const b = find(d.nodes.n);
      if (a !== b) parent.set(a, b);
    }
  }
  const group = (node: string | null | undefined): string | null => (node ? find(node) : null);
  const nodeOfPin = (comp: ComponentInstance, pin: string): string | null => {
    const net = comp.pinNets[pin];
    return net ? circuit.netToNode[net] ?? null : null;
  };

  /* ---------------------------------------------- MCUs and chips ----------------------------- */
  const mcus: McuRec[] = [];
  const chips: ChipRec[] = [];
  const driverDevices: CircuitDevice[] = [];
  const driverOf = new Map<string, DriverModel>();

  const supplyOf = (comp: ComponentInstance, part: PartDef, supplyPins: string[], groundPins: string[]): { sup: string | null; gnd: string; supSet: Set<string> } => {
    const supSet = new Set<string>();
    let sup: string | null = null;
    let gnd: string | null = null;
    for (const ref of supplyPins) for (const p of comp.pinNets[ref] ? [ref] : resolvePins(part, ref)) {
      supSet.add(p);
      if (!sup) sup = nodeOfPin(comp, p);
    }
    for (const ref of groundPins) for (const p of comp.pinNets[ref] ? [ref] : resolvePins(part, ref)) {
      supSet.add(p);
      if (!gnd) gnd = nodeOfPin(comp, p);
    }
    return { sup, gnd: gnd ?? '0', supSet };
  };

  const addDriver = (compId: string, pin: string, node: string, sup: string | null, gnd: string, rout: number, vfix: number): string => {
    const id = `drv:${compId}:${pin}`;
    const d: CircuitDevice = { id, kind: 'driver', componentId: compId, nodes: { pin: node, gnd }, pins: { pin }, params: { mode: 'z', rout, rpull: 35e3, vfix } };
    if (sup) {
      d.nodes.sup = sup;
      d.pins!.sup = '';
    }
    driverDevices.push(d);
    return id;
  };

  for (const [id, { comp, part }] of instances) {
    if (!part) continue;
    const ref = circuit.components[id].ref;
    const sim = part.sim;
    if (sim?.kind === 'mcu') {
      const emulatorName = comp.mcu?.emulator ?? sim.emulator;
      const clockHz = comp.mcu?.clockHz ?? sim.clockHz ?? 16e6;
      let pinMap = sim.pinMap ?? {};
      let supplyPins = sim.supplyPins;
      let groundPins = sim.groundPins;
      if (!Object.keys(pinMap).length && /^avr:atmega328p$/i.test(emulatorName)) {
        pinMap = { ...ATMEGA328P_TQFP32_PINMAP };
        if (!supplyPins?.length) supplyPins = [...ATMEGA328P_TQFP32_SUPPLY];
        if (!groundPins?.length) groundPins = [...ATMEGA328P_TQFP32_GROUND];
        warn(`pinmap:${id}`, `${ref}: part has no sim pinMap; using the ATmega328P TQFP-32 default`);
      }
      const { sup, gnd } = supplyOf(comp, part, supplyPins ?? [], groundPins ?? []);
      if (!sup) warn(`nosup:${id}`, `${ref}: supply pin not connected — pin drivers use a fixed 5 V supply`);
      const rec: McuRec = {
        id,
        ref,
        emulatorName,
        clockHz,
        emu: null,
        status: 'not started',
        part,
        comp,
        portPin: new Map(Object.entries(pinMap)),
        pins: new Map(),
        supplyNode: sup,
        groundNode: gnd,
        vil: sim.vilRatio ?? VIL,
        vih: sim.vihRatio ?? 0.6,
        traces: new Map(),
        uart: new Map(),
        dead: false,
      };
      const supplySet = new Set([...(supplyPins ?? []), ...(groundPins ?? [])]);
      for (const [port, pin] of rec.portPin) {
        const node = nodeOfPin(comp, pin);
        let driver: string | null = null;
        if (node && !supplySet.has(pin) && !/^(AVCC|AREF|VCC|VDD|GND|ADC[67])$/i.test(port)) driver = addDriver(id, pin, node, sup, gnd, sim.rout ?? 25, 5);
        rec.pins.set(port, { pin, node, driver: null, level: -1 });
        if (driver) (rec.pins.get(port) as PinRec & { driverId?: string }).driverId = driver;
      }
      mcus.push(rec);
      continue;
    }
    const behaviorId = comp.behaviorId ?? (sim?.kind === 'ic' ? sim.behaviorId : undefined);
    if (!behaviorId) continue;
    let supplyPins: string[] = [];
    let groundPins: string[] = [];
    if (sim?.kind === 'ic') {
      supplyPins = sim.supplyPins;
      groundPins = sim.groundPins;
    } else {
      supplyPins = part.pins.filter((p) => /^(VCC|VDD|VDDIO|V\+|VIN|VS)$/i.test(p.name) || (p.type === 'power_in' && !/GND|VSS/i.test(p.name))).map((p) => p.number);
      groundPins = part.pins.filter((p) => /^(GND|VSS|AGND|DGND|EP)$/i.test(p.name)).map((p) => p.number);
    }
    const { sup, gnd, supSet } = supplyOf(comp, part, supplyPins, groundPins);
    const rec: ChipRec = {
      id,
      ref,
      behaviorId,
      part,
      comp,
      inst: null,
      shape: null,
      pins: new Map(),
      supplyNode: sup,
      groundNode: gnd,
      supplyPins: supSet,
      watched: [],
      interval: sampleInterval,
      nextStep: Infinity,
      lastStep: 0,
      errors: 0,
      dead: false,
      uartOut: '',
      pinCache: new Map(),
    };
    for (const pin of Object.keys(comp.pinNets)) {
      const node = nodeOfPin(comp, pin);
      const p: PinRec & { driverId?: string } = { pin, node, driver: null, level: -1 };
      if (node && !supSet.has(pin)) p.driverId = addDriver(id, pin, node, sup, gnd, 25, 3.3);
      rec.pins.set(pin, p);
    }
    chips.push(rec);
  }

  /* ---------------------------------------------- analog system ------------------------------ */
  const sys = new MnaSystem(circuit, driverDevices);
  for (const m of sys.models) if (m.dev.kind === 'driver') driverOf.set(m.dev.id, m as DriverModel);
  const bindDrivers = (pins: Map<string, PinRec>) => {
    for (const p of pins.values()) {
      const id = (p as PinRec & { driverId?: string }).driverId;
      if (id) p.driver = driverOf.get(id) ?? null;
    }
  };
  for (const m of mcus) bindDrivers(m.pins);
  for (const c of chips) bindDrivers(c.pins);

  const ledModels: number[] = [];
  const ledThreshold: number[] = [];
  sys.models.forEach((m, i) => {
    if (m instanceof DiodeModel && m.dev.role === 'led' && m.dev.componentId) {
      ledModels.push(i);
      const If = Number(m.dev.params.If ?? 0.02);
      ledThreshold.push(Math.min(1e-3, Math.max(1e-5, 0.01 * If)));
    }
  });
  const analog = new AnalogBridge(sys, {
    mode: opts.analogMode ?? 'quasi-static',
    maxStep: Math.min(sampleInterval / 20, 50e-6),
    ledModels,
    ledThreshold,
  });
  const init = analog.init();
  if (!init.converged) warnings.push('Initial operating point did not converge; analog results are approximate');

  // key nets for analog sampling: power nets + LED nets (non-ground)
  const keyNets: { netId: string; node: string }[] = [];
  {
    const seen = new Set<string>();
    const addNet = (netId: string) => {
      const node = circuit.netToNode[netId];
      if (!node || node === '0' || seen.has(netId) || !sys.nodeIndex.has(node)) return;
      seen.add(netId);
      keyNets.push({ netId, node });
    };
    for (const b of project.boards) for (const n of b.nets) if (n.class === 'power' && circuit.netToNode[n.id] !== undefined) addNet(n.id);
    for (const i of ledModels) {
      const dev = sys.models[i].dev;
      const comp = circuit.components[dev.componentId!];
      for (const pin of Object.values(dev.pins ?? {})) {
        const net = comp?.pinNets[pin];
        if (net) addNet(net);
      }
    }
    keyNets.splice(48);
  }

  /* ---------------------------------------------- helpers ------------------------------------ */
  let simTime = 0;
  const supplyV = (sup: string | null, gnd: string, dflt: number) => (sup ? analog.voltage(sup) - analog.voltage(gnd) : dflt);
  const levelOf = (v: number, vdd: number, last: number, vil: number, vih: number): number => {
    if (v >= vih * vdd) return 1;
    if (v <= vil * vdd) return 0;
    return last;
  };
  const toDriveMode = (d: PinDrive): DriveMode => d;

  const record = (rec: McuRec, port: string, pin: string, level: number, t: number) => {
    let tr = rec.traces.get(port);
    if (!tr) {
      tr = { name: `${rec.ref}.${port}`, pin, transitions: [], last: NaN, driven: false, truncated: false };
      rec.traces.set(port, tr);
    }
    if (tr.last === level) return;
    tr.last = level;
    if (tr.transitions.length < maxTransitions) tr.transitions.push([t, level]);
    else if (!tr.truncated) {
      tr.truncated = true;
      warn(`trunc:${rec.id}:${port}`, `${rec.ref}.${port}: more than ${maxTransitions} transitions; trace truncated`, t);
    }
  };

  /* ---------------------------------------------- chip scripts ------------------------------- */
  const resolveChipPin = (c: ChipRec, spec: PinSpec | undefined): string | null => {
    if (spec === undefined) return null;
    const cands = Array.isArray(spec) ? spec : [spec];
    for (const cand of cands) {
      const s = String(cand);
      if (c.pinCache.has(s)) {
        const v = c.pinCache.get(s)!;
        if (v) return v;
        continue;
      }
      let found: string | null = null;
      if (c.part.pins.some((p) => p.number === s) || c.comp.pinNets[s]) found = s;
      else {
        const r = resolvePins(c.part, s);
        found = r.find((p) => c.comp.pinNets[p]) ?? r[0] ?? null;
      }
      c.pinCache.set(s, found);
      if (found) return found;
    }
    return null;
  };

  const chipError = (c: ChipRec, e: unknown, t: number) => {
    const err = e as ScriptError;
    c.errors++;
    addLog(t, c.ref, 'error', `${c.behaviorId}: ${err?.message ?? String(e)}`);
    if (err?.timeout || c.errors >= 25) {
      c.dead = true;
      warn(`chipdead:${c.id}`, `${c.ref} (${c.behaviorId}) disabled after ${err?.timeout ? 'a timeout' : `${c.errors} script errors`}`, t, c.ref);
    }
  };

  const invokeChip = (c: ChipRec, path: string, args: ScriptValue[], t: number): unknown => {
    if (c.dead || !c.inst) return undefined;
    simTime = t;
    try {
      return c.inst.invoke(path, t, args);
    } catch (e) {
      chipError(c, e, t);
      return undefined;
    }
  };

  const chipHost = (c: ChipRec) => ({
    call: (op: string, a?: ScriptValue, b?: ScriptValue): ScriptValue => {
      switch (op) {
        case 'read':
        case 'voltage': {
          const pin = resolveChipPin(c, a as string);
          if (!pin) throw new Error(`unknown pin '${String(a)}' on ${c.ref}`);
          const p = c.pins.get(pin);
          if (!p?.node) return 0;
          analog.ensure(simTime);
          const v = analog.voltage(p.node) - analog.voltage(c.groundNode);
          if (op === 'voltage') return v;
          const vdd = supplyV(c.supplyNode, c.groundNode, 3.3);
          const l = levelOf(v, vdd, p.level < 0 ? (v > vdd / 2 ? 1 : 0) : p.level, VIL, VIH);
          return l === 1 ? 1 : 0;
        }
        case 'drive': {
          const pin = resolveChipPin(c, a as string);
          if (!pin) throw new Error(`unknown pin '${String(a)}' on ${c.ref}`);
          if (c.supplyPins.has(pin)) throw new Error(`pin '${String(a)}' is a supply/ground pin and cannot be driven`);
          const p = c.pins.get(pin);
          if (!p?.driver) return undefined; // unconnected pin
          if (typeof b === 'number') analog.setDriver(p.driver, 'analog', b, simTime);
          else analog.setDriver(p.driver, toDriveMode(b as PinDrive), 0, simTime);
          return undefined;
        }
        case 'uart': {
          const bytes = typeof a === 'number' ? [a & 0xff] : Array.from(String(a), (ch) => ch.charCodeAt(0) & 0xff);
          chipUartSend(c, bytes);
          return undefined;
        }
        case 'log':
          addLog(simTime, c.ref, 'info', String(a));
          return undefined;
        case 'warn':
          addLog(simTime, c.ref, 'warn', String(a));
          return undefined;
        case 'supply':
          analog.ensure(simTime);
          return supplyV(c.supplyNode, c.groundNode, 3.3);
        case 'hasPin':
          return resolveChipPin(c, a as string) !== null;
        default:
          throw new Error(`unknown chip API call '${op}'`);
      }
    },
  });

  const chipUartSend = (c: ChipRec, bytes: number[]) => {
    for (const b of bytes) c.uartOut += String.fromCharCode(b);
    if (!c.uart?.txGroup) return;
    for (const m of mcus) {
      if (!m.emu || m.dead) continue;
      for (const port of [m.emu.primaryUart ?? 'USART0', 'UART0', 'UART1']) {
        const bp = m.emu.busPorts(port);
        const rxPin = bp?.rx ? m.pins.get(bp.rx) : undefined;
        if (rxPin && group(rxPin.node) === c.uart.txGroup) {
          m.emu.uartReceive(port, bytes);
          break;
        }
      }
    }
  };

  for (const c of chips) {
    const script = behaviors.get(c.behaviorId);
    if (!script) {
      warn(`nobeh:${c.id}`, `${c.ref}: behaviour script '${c.behaviorId}' not found — chip pins stay high-Z`);
      c.dead = true;
      continue;
    }
    if (script.kind !== 'chip') {
      warn(`kind:${c.id}`, `${c.ref}: behaviour '${c.behaviorId}' is a ${script.kind} script, not a chip script`);
      c.dead = true;
      continue;
    }
    try {
      const sb = sandboxFor(script);
      const compiled = sb.compile(script.code, script.id);
      const params: Record<string, unknown> = {
        ...(c.comp.fields ?? {}),
        ...(c.comp.simOverrides ?? {}),
        temperatureC: env.temperatureC,
        pressurePa: env.pressurePa,
        humidityPct: env.humidityPct,
        value: c.comp.value ?? c.part.value,
      };
      for (const k of ['temperatureC', 'pressurePa', 'humidityPct']) if (c.comp.simOverrides?.[k] !== undefined) params[k] = Number(c.comp.simOverrides[k]);
      c.inst = compiled.instantiate({
        host: chipHost(c),
        params,
        meta: { ref: c.ref, id: c.id, kind: 'chip', pins: c.part.pins.map((p) => [p.number, p.name]), seed: hashSeed(c.id) },
      });
      c.shape = c.inst.shape;
    } catch (e) {
      warn(`chipinit:${c.id}`, `${c.ref}: ${(e as Error).message}`);
      c.dead = true;
      continue;
    }
    const s = c.shape!;
    if (s.interval) c.interval = Math.max(s.interval, 1e-6);
    if (s.hooks.includes('step')) c.nextStep = c.interval;
    for (const spec of s.inputs ?? []) {
      const pin = resolveChipPin(c, spec);
      if (pin) c.watched.push({ spec, pin, level: -1 });
      else warn(`inpin:${c.id}:${spec}`, `${c.ref}: input pin '${spec}' not found`);
    }
    const nodeGroup = (spec: PinSpec | undefined) => {
      const pin = resolveChipPin(c, spec);
      return pin ? group(c.pins.get(pin)?.node) : null;
    };
    if (s.i2c) c.i2c = { sdaGroup: nodeGroup(s.i2c.sda ?? ['SDA']), sclGroup: nodeGroup(s.i2c.scl ?? ['SCL']) };
    if (s.spi) {
      const csPin = resolveChipPin(c, s.spi.cs);
      c.spi = {
        sckGroup: nodeGroup(s.spi.sck ?? ['SCK', 'SCLK']),
        mosiGroup: nodeGroup(s.spi.mosi ?? ['MOSI', 'SDI', 'DIN']),
        misoGroup: nodeGroup(s.spi.miso ?? ['MISO', 'SDO', 'DOUT']),
        csPin: csPin && c.pins.get(csPin)?.node ? csPin : null,
        csActiveHigh: !!s.spi.csActiveHigh,
        active: false,
      };
      if (c.spi.csPin && s.hooks.includes('spi.select')) c.watched.push({ spec: '__cs', pin: c.spi.csPin, level: -1, select: true });
    }
    if (s.uart) c.uart = { rxGroup: nodeGroup(s.uart.rx ?? ['RX', 'RXD']), txGroup: nodeGroup(s.uart.tx ?? ['TX', 'TXD']) };
  }

  /* ---------------------------------------------- input propagation -------------------------- */
  let propagating = false;
  const propagate = () => {
    if (propagating) return;
    propagating = true;
    try {
      const t = Math.max(simTime, analog.t);
      for (const m of mcus) {
        const vdd = supplyV(m.supplyNode, m.groundNode, 5);
        const vg = analog.voltage(m.groundNode);
        for (const [port, p] of m.pins) {
          if (!p.node) continue;
          const v = analog.voltage(p.node) - vg;
          const l = levelOf(v, vdd, p.level, m.vil, m.vih);
          if (l !== p.level) {
            p.level = l;
            if (l >= 0 && m.emu && !m.dead && p.driver) m.emu.setInput(port, l === 1);
          }
          const tr = m.traces.get(port);
          if (p.driver && (!tr || !tr.driven)) record(m, port, p.pin, p.level, t);
        }
      }
      for (const c of chips) {
        if (c.dead || !c.inst || !c.watched.length) continue;
        const vdd = supplyV(c.supplyNode, c.groundNode, 3.3);
        const vg = analog.voltage(c.groundNode);
        for (const w of c.watched) {
          const node = c.pins.get(w.pin)?.node;
          if (!node) continue;
          const v = analog.voltage(node) - vg;
          const l = levelOf(v, vdd, w.level, VIL, VIH);
          if (l === w.level || l < 0) continue;
          const first = w.level < 0;
          w.level = l;
          if (first) continue;
          if (w.select && c.spi) {
            const active = c.spi.csActiveHigh ? l === 1 : l === 0;
            if (active !== c.spi.active) {
              c.spi.active = active;
              invokeChip(c, 'spi.select', [active], t);
            }
          } else {
            invokeChip(c, 'onInput', [w.spec, l, t], t);
          }
        }
      }
    } finally {
      propagating = false;
    }
  };
  analog.onSolved = propagate;

  /* ---------------------------------------------- MCU host ----------------------------------- */
  const i2cState = new Map<string, { selected: ChipRec[]; ok: boolean | null; read: boolean }>();
  const mcuHost = (m: McuRec): McuHost => {
    const t = () => (m.emu ? m.emu.time : simTime);
    const portVoltage = (port: string): number => {
      const p = m.pins.get(port);
      let node = p?.node ?? null;
      if (!p) {
        const pin = m.portPin.get(port);
        node = pin ? nodeOfPin(m.comp, pin) : null;
      }
      if (!node) return 0;
      simTime = t();
      analog.ensure(simTime);
      return analog.voltage(node) - analog.voltage(m.groundNode);
    };
    const busChips = (bus: string, kind: 'i2c'): ChipRec[] => {
      const bp = m.emu?.busPorts(bus);
      const sda = bp?.sda ? group(m.pins.get(bp.sda)?.node) : null;
      const scl = bp?.scl ? group(m.pins.get(bp.scl)?.node) : null;
      if (!sda || !scl) return [];
      return chips.filter((c) => !c.dead && c.inst && c[kind] && c.i2c!.sdaGroup === sda && c.i2c!.sclGroup === scl);
    };
    const i2cBus = (bus: string) => {
      const key = `${m.id}:${bus}`;
      let s = i2cState.get(key);
      if (!s) i2cState.set(key, (s = { selected: [], ok: null, read: false }));
      return s;
    };
    return {
      environment: env,
      pinChanged(port, drive) {
        const p = m.pins.get(port);
        if (!p) return;
        const te = t();
        if (p.driver) analog.setDriver(p.driver, toDriveMode(drive), 0, te);
        let tr = m.traces.get(port);
        if (!tr) {
          record(m, port, p.pin, p.level, te);
          tr = m.traces.get(port)!;
        }
        tr.driven = drive === 'high' || drive === 'low';
        if (tr.driven) record(m, port, p.pin, drive === 'high' ? 1 : 0, te);
        if (m.emu && analog.isDirty) m.emu.stopAt(te + coalesce);
      },
      voltage: portVoltage,
      pinVoltage(pinRef) {
        const pins = m.comp.pinNets[pinRef] ? [pinRef] : resolvePins(m.part, pinRef);
        const node = pins.map((p) => nodeOfPin(m.comp, p)).find((n) => n);
        if (!node) return 0;
        simTime = t();
        analog.ensure(simTime);
        return analog.voltage(node) - analog.voltage(m.groundNode);
      },
      supply() {
        simTime = t();
        analog.ensure(simTime);
        return supplyV(m.supplyNode, m.groundNode, 5);
      },
      uartTx(port, byte) {
        const prev = m.uart.get(port) ?? '';
        if (prev.length < 1_000_000) m.uart.set(port, prev + String.fromCharCode(byte));
        const bp = m.emu?.busPorts(port);
        const txGroup = bp?.tx ? group(m.pins.get(bp.tx)?.node) : null;
        if (!txGroup) return;
        for (const c of chips) if (c.uart && c.uart.rxGroup === txGroup && c.shape?.hooks.includes('uart.receive')) invokeChip(c, 'uart.receive', [byte], t());
      },
      i2cStart(bus) {
        const s = i2cBus(bus);
        simTime = t();
        s.selected = [];
        // bus idle-level check (pull-ups)
        const bp = m.emu?.busPorts(bus);
        if (bp?.sda && bp.scl) {
          const vdd = supplyV(m.supplyNode, m.groundNode, 5);
          const vs = portVoltage(bp.sda);
          const vc = portVoltage(bp.scl);
          const ok = vs >= 0.7 * vdd && vc >= 0.7 * vdd;
          if (!ok) {
            warn(
              `i2cpull:${m.id}:${bus}`,
              `${m.ref} ${bus}: SDA/SCL idle at ${vs.toFixed(2)} V / ${vc.toFixed(2)} V (VDD ${vdd.toFixed(2)} V) — no pull-up resistors to the supply on the I2C bus; the bus cannot work (all transfers NACKed). Add 2.2–10 kΩ pull-ups on SDA and SCL.`,
              simTime,
              m.ref,
            );
          }
          s.ok = ok;
        } else s.ok = true;
      },
      i2cAddress(bus, addr, read) {
        const s = i2cBus(bus);
        simTime = t();
        s.read = read;
        if (s.ok === false) return false;
        const targets = busChips(bus, 'i2c').filter((c) => {
          const st = c.shape!.i2c!;
          const a = st.dynamicAddress ? Number(invokeChip(c, 'i2c.address', [], simTime)) : st.address;
          return a === addr;
        });
        const acked: ChipRec[] = [];
        for (const c of targets) {
          const r = c.shape!.hooks.includes('i2c.start') ? invokeChip(c, 'i2c.start', [read], simTime) : undefined;
          if (r !== false && !c.dead) acked.push(c);
        }
        s.selected = acked;
        if (!targets.length) addLog(simTime, m.ref, 'info', `I2C ${bus}: no device answered at address 0x${addr.toString(16).padStart(2, '0')}`);
        return acked.length > 0;
      },
      i2cWrite(bus, byte) {
        const s = i2cBus(bus);
        simTime = t();
        let ack = false;
        for (const c of s.selected) if (invokeChip(c, 'i2c.write', [byte], simTime) !== false) ack = true;
        return ack;
      },
      i2cRead(bus, ack) {
        const s = i2cBus(bus);
        simTime = t();
        let v = 0xff;
        for (const c of s.selected) v &= Number(invokeChip(c, 'i2c.read', [ack], simTime) ?? 0xff) & 0xff;
        if (s.selected.length > 1) warn(`i2ccont:${m.id}:${bus}`, `${m.ref} ${bus}: several devices answer at the same address (bus contention)`, simTime, m.ref);
        return v;
      },
      i2cStop(bus) {
        const s = i2cBus(bus);
        simTime = t();
        for (const c of s.selected) if (c.shape!.hooks.includes('i2c.stop')) invokeChip(c, 'i2c.stop', [], simTime);
        s.selected = [];
      },
      spiTransfer(bus, byte) {
        simTime = t();
        const bp = m.emu?.busPorts(bus);
        const sck = bp?.sck ? group(m.pins.get(bp.sck)?.node) : null;
        const mosi = bp?.mosi ? group(m.pins.get(bp.mosi)?.node) : null;
        const miso = bp?.miso ? group(m.pins.get(bp.miso)?.node) : null;
        if (!sck || !mosi) return 0xff;
        analog.ensure(simTime);
        let out = 0xff;
        let responders = 0;
        for (const c of chips) {
          if (c.dead || !c.spi || c.spi.sckGroup !== sck || c.spi.mosiGroup !== mosi) continue;
          if (c.spi.csPin) {
            const node = c.pins.get(c.spi.csPin)?.node ?? null;
            const v = analog.voltage(node) - analog.voltage(c.groundNode);
            const vdd = supplyV(c.supplyNode, c.groundNode, 3.3);
            const high = v >= 0.5 * vdd;
            const active = c.spi.csActiveHigh ? high : !high;
            if (!active) continue;
            if (!c.spi.active && c.shape!.hooks.includes('spi.select')) {
              c.spi.active = true;
              invokeChip(c, 'spi.select', [true], simTime);
            }
          }
          const r = invokeChip(c, 'spi.transfer', [byte], simTime);
          if (c.spi.misoGroup && c.spi.misoGroup === miso && typeof r === 'number') {
            out &= r & 0xff;
            responders++;
          }
        }
        if (responders > 1) warn(`spicont:${m.id}`, `${m.ref} SPI: several selected devices drive MISO`, simTime, m.ref);
        return out;
      },
      log(level, msg) {
        addLog(t(), m.ref, level, msg);
      },
    };
  };

  /* ---------------------------------------------- start emulators ---------------------------- */
  for (const m of mcus) {
    const factory = getEmulatorFactory(m.emulatorName);
    if (!factory) {
      m.status = `error: unknown emulator '${m.emulatorName}'`;
      warn(`emu:${m.id}`, `${m.ref}: no emulator registered for '${m.emulatorName}'`);
      m.dead = true;
      continue;
    }
    const fw = opts.firmware?.[m.id];
    if (!fw) {
      m.status = 'no firmware';
      const fid = m.comp.mcu?.firmwareId ?? (m.part.sim as McuModel).firmwareId;
      warn(`nofw:${m.id}`, `${m.ref}: no firmware supplied${fid ? ` (firmwareId ${fid}: pass its bytes in opts.firmware['${m.id}'])` : ''} — pins stay high-Z`);
      m.dead = true;
      continue;
    }
    try {
      m.emu = await factory({
        name: m.emulatorName,
        clockHz: m.clockHz,
        model: m.part.sim as McuModel,
        component: { id: m.id, ref: m.ref },
        host: mcuHost(m),
        behavior: (id) => behaviors.get(id),
        sandbox: () => {
          const id = m.emulatorName.slice(m.emulatorName.indexOf(':') + 1);
          const s = behaviors.get(id);
          if (s) return sandboxFor(s);
          return opts.sandbox ?? (fnSandbox ??= createFunctionSandbox());
        },
        options: opts.emulatorOptions?.[m.id] ?? {},
      });
      m.emu.load(fw);
      m.firmware = fw.name ?? `${fw.format} image (${fw.bytes.length} bytes)`;
      m.status = m.emu.status === 'reset' ? 'running' : m.emu.status;
    } catch (e) {
      m.status = `error: ${(e as Error).message}`;
      warn(`emuerr:${m.id}`, `${m.ref}: ${(e as Error).message}`);
      m.dead = true;
      m.emu = null;
    }
  }
  for (const m of mcus) {
    for (const [port] of m.pins) if (m.emu && !m.emu.ports.includes(port) && !/^(AVCC|AREF|ADC[67])$/i.test(port)) warn(`port:${m.id}:${port}`, `${m.ref}: pinMap entry '${port}' is not a pin of emulator '${m.emulatorName}'`);
  }

  // chip setup at t = 0, then settle the analog state and initial input levels
  for (const c of chips) if (!c.dead && c.inst && c.shape?.hooks.includes('setup')) invokeChip(c, 'setup', [], 0);
  analog.ensure(0);
  propagate();
  for (const m of mcus) for (const [port, p] of m.pins) if (p.driver) record(m, port, p.pin, p.level, 0);

  // uart input
  for (const [key, text] of Object.entries(opts.uartInput ?? {})) {
    const [cid, port] = key.split(':');
    const bytes = Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
    const m = mcus.find((x) => x.id === cid);
    if (m?.emu) m.emu.uartReceive(port ?? m.emu.primaryUart ?? 'USART0', bytes);
    else {
      const c = chips.find((x) => x.id === cid);
      if (c && c.shape?.hooks.includes('uart.receive')) for (const b of bytes) invokeChip(c, 'uart.receive', [b], 0);
      else warn(`uartin:${key}`, `uartInput '${key}': no MCU/chip with that id`);
    }
  }

  /* ---------------------------------------------- main loop ---------------------------------- */
  const sampleTimes: number[] = [];
  const sampleData: number[][] = keyNets.map(() => []);
  const sample = (t: number) => {
    sampleTimes.push(t);
    for (let i = 0; i < keyNets.length; i++) sampleData[i].push(analog.voltage(keyNets[i].node));
  };
  sample(0);
  // Time comparisons use EPS (1 ps) so float noise between emulator cycle counts and event times
  // can never stall the loop; sample times are integer multiples of sampleInterval (no drift).
  const EPS = 1e-12;
  let sampleIndex = 1;
  let nextSample = sampleInterval;
  let t = 0;
  let iterations = 0;
  let stall = 0;
  let lastYield = now();
  let lastProgress = -1;
  const running = mcus.filter((m) => m.emu && !m.dead);
  const multi = running.length > 1;
  const quantum = multi ? Math.min(sampleInterval, 10e-6) : Infinity;
  while (t < duration - EPS) {
    iterations++;
    let nextChip = Infinity;
    for (const c of chips) if (!c.dead && c.nextStep < nextChip) nextChip = c.nextStep;
    const tEvent = Math.min(nextSample, nextChip, duration);
    let tTarget = Math.min(tEvent, t + quantum);
    for (const m of running) {
      if (m.dead || !m.emu) continue;
      if (m.emu.time < tTarget - EPS) {
        try {
          m.emu.run(tTarget);
        } catch (e) {
          m.dead = true;
          m.status = `error: ${(e as Error).message}`;
          warn(`emurun:${m.id}`, `${m.ref}: emulator stopped: ${(e as Error).message}`, m.emu.time, m.ref);
          continue;
        }
        const reached = m.emu.time;
        if (reached < tTarget - EPS) tTarget = Math.max(reached, t);
      }
    }
    if (tTarget <= t) {
      // an emulator made no progress (e.g. stopped exactly at its limit): never spin forever
      if (++stall > 100) {
        tTarget = Math.min(tEvent, t + quantum);
        stall = 0;
      }
    } else stall = 0;
    t = Math.max(t, tTarget);
    simTime = t;
    const atSample = t >= nextSample - EPS;
    analog.ensure(t, atSample);
    if (atSample) {
      sample(t);
      sampleIndex = Math.max(sampleIndex + 1, Math.floor(t / sampleInterval + 1e-9) + 1);
      nextSample = sampleIndex * sampleInterval;
    }
    for (const c of chips) {
      if (c.dead || t < c.nextStep - EPS) continue;
      invokeChip(c, 'step', [t, t - c.lastStep], t);
      c.lastStep = t;
      c.nextStep += c.interval;
      if (c.nextStep <= t + EPS) c.nextStep = t + c.interval;
    }
    if (analog.isDirty) analog.ensure(t);
    if ((iterations & 63) === 0) {
      const w = now();
      if (w - lastYield > 25) {
        if (opts.signal?.aborted) throw abortError();
        const frac = t / duration;
        if (opts.onProgress && frac - lastProgress >= 0.01) {
          lastProgress = frac;
          opts.onProgress(frac);
        }
        await yieldNow();
        if (opts.signal?.aborted) throw abortError();
        lastYield = now();
      }
    }
  }
  analog.finish(duration);
  if (sampleTimes[sampleTimes.length - 1] < duration - 1e-12) sample(duration);
  opts.onProgress?.(1);

  /* ---------------------------------------------- results ------------------------------------ */
  const avgPower: Record<string, number> = {};
  analog.probe.compIds.forEach((id, i) => {
    const c = circuit.components[id];
    if (c.model === 'none' && !mcus.some((m) => m.id === id) && !chips.some((x) => x.id === id)) return;
    if (c.model === 'connector' || c.model === 'crystal') return;
    avgPower[id] = analog.energy[i] / duration;
  });
  const indicators: MixedSignalResult['indicators'] = ledModels.map((mi, k) => {
    const dev = sys.models[mi].dev;
    const comp = circuit.components[dev.componentId!];
    return { componentId: dev.componentId!, ref: comp?.ref ?? dev.componentId!, color: comp?.color, onFraction: Math.min(1, analog.ledOn[k] / duration), meanCurrent: analog.ledCharge[k] / duration };
  });
  const uart: MixedSignalResult['uart'] = [];
  for (const m of mcus) for (const [port, text] of m.uart) uart.push({ componentId: m.id, ref: m.ref, port, text });
  for (const c of chips) if (c.uartOut) uart.push({ componentId: c.id, ref: c.ref, port: 'TX', text: c.uartOut });
  const digital: MixedSignalResult['digital'] = [];
  for (const m of mcus) {
    for (const [port, tr] of m.traces) {
      if (!m.pins.get(port)?.driver) continue;
      digital.push({ name: tr.name, componentId: m.id, pin: tr.pin, transitions: tr.transitions });
    }
  }
  const signals: Waveform[] = keyNets.map((k, i) => ({
    name: circuit.netNames[k.netId] ?? k.netId,
    kind: 'voltage',
    unit: 'V',
    netId: k.netId,
    data: pack(new Float32Array(sampleData[i])),
  }));
  const chipStates: Record<string, unknown> = {};
  for (const c of chips) {
    if (!c.inst) continue;
    try {
      chipStates[c.id] = c.inst.snapshot();
    } catch (e) {
      chipStates[c.id] = { error: (e as Error).message };
    }
    try {
      c.inst.dispose();
    } catch {
      /* ignore */
    }
  }
  for (const m of mcus) {
    try {
      m.emu?.dispose?.();
    } catch {
      /* ignore */
    }
  }
  if (analog.failures) warnings.push(`${analog.failures} analog solve(s) did not converge; affected intervals are approximate`);
  const wallMs = now() - wall0;
  return {
    kind: 'mixed-signal',
    duration,
    wallMs,
    uart,
    digital,
    analog: { time: pack(new Float64Array(sampleTimes)), signals },
    indicators,
    log,
    mcus: mcus.map((m) => ({
      componentId: m.id,
      ref: m.ref,
      emulator: m.emulatorName,
      firmware: m.firmware,
      cycles: m.emu?.cycles ?? 0,
      clockHz: m.clockHz,
      status: m.dead ? m.status : m.emu ? (m.emu.status === 'reset' || m.emu.status === 'running' ? 'ok' : m.emu.status) : m.status,
    })),
    avgPower,
    warnings: Array.from(new Set(warnings)),
    chipStates,
    stats: { analogSolves: analog.solves, cacheHits: analog.cacheHits, analogFailures: analog.failures, iterations },
  };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
