/**
 * Registers the built-in emulators (lazy-loaded so avr8js / rp2040js are only fetched when used).
 */
import { getEmulatorFactory, registerEmulator } from './registry';

let done = false;

export function registerDefaultEmulators(): void {
  if (done) return;
  done = true;
  if (!getEmulatorFactory('avr:atmega328p')) registerEmulator('avr:atmega328p', async (ctx) => (await import('./avr')).createAtmega328p(ctx));
  if (!getEmulatorFactory('rp2040')) registerEmulator('rp2040', async (ctx) => (await import('./rp2040')).createRp2040(ctx));
  if (!getEmulatorFactory('script:x')) registerEmulator('script:*', async (ctx) => (await import('./script')).createScriptEmulator(ctx));
}
