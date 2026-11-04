/**
 * @pcbcad/sim — mixed-signal co-simulation (browser-safe entry point).
 *
 *  - {@link runMixedSignal}: MCU firmware emulation + chip behaviour scripts + analog circuit.
 *  - Emulators: 'avr:atmega328p' (avr8js), 'rp2040' (rp2040js, bootrom supplied by the caller),
 *    'script:<behaviorId>'; add more with {@link registerEmulator}.
 *  - Behaviour scripts: {@link BUILTIN_BEHAVIORS}, {@link validateBehaviorScript},
 *    {@link createFunctionSandbox} (trusted code). The isolated Node sandbox lives in
 *    '@pcbcad/sim/mixed/sandbox-node' (`createNodeSandbox`) and is intentionally not exported here.
 *
 * Scripting API: see packages/sim/src/mixed/README.md.
 */
export { runMixedSignal } from './engine';
export type { MixedSignalRunResult } from './engine';
export { registerEmulator, getEmulatorFactory, listEmulators } from './emulators/registry';
export { registerDefaultEmulators } from './emulators/defaults';
export { ATMEGA328P_TQFP32_PINMAP, ATMEGA328P_TQFP32_SUPPLY, ATMEGA328P_TQFP32_GROUND } from './emulators/pinmaps';
export { setRp2040Bootrom, normalizeBootrom, hasBoot2 } from './emulators/rp2040';
export { BUILTIN_BEHAVIORS, builtinBehavior } from './builtins';
export { createFunctionSandbox, validateBehaviorScript, PRELUDE_SRC } from './script-api';
export type { BehaviorValidation } from './script-api';
export { parseIntelHex, parseUf2, parseElf, decodeFirmware, UF2_FAMILY_RP2040 } from './firmware';
export { AnalogBridge } from './analog';
export { ScriptError } from './types';
export type {
  BusPorts,
  CompiledScript,
  EmulatorContext,
  EmulatorFactory,
  FirmwareFormat,
  FirmwareInput,
  McuEmulator,
  McuHost,
  MemorySegment,
  MixedEnvironment,
  MixedSignalOptions,
  PinDrive,
  PinSpec,
  ScriptHost,
  ScriptInstance,
  ScriptSandbox,
  ScriptShape,
  ScriptValue,
} from './types';
