/**
 * Pluggable MCU emulator registry.
 */
import type { EmulatorFactory } from '../types';

const registry = new Map<string, EmulatorFactory>();

/**
 * Register an emulator factory. `name` is matched exactly ('avr:atmega328p', 'rp2040'), or as a
 * family wildcard 'family:*' that handles every 'family:<anything>' name (e.g. 'script:*').
 * Registering an existing name replaces it.
 */
export function registerEmulator(name: string, factory: EmulatorFactory): void {
  registry.set(name.toLowerCase(), factory);
}

/** Resolve a factory for an emulator name (exact match first, then 'family:*'). */
export function getEmulatorFactory(name: string): EmulatorFactory | undefined {
  const n = name.toLowerCase();
  const exact = registry.get(n);
  if (exact) return exact;
  const i = n.indexOf(':');
  if (i > 0) return registry.get(`${n.slice(0, i)}:*`);
  return undefined;
}

/** Names of registered emulators. */
export function listEmulators(): string[] {
  return Array.from(registry.keys());
}
