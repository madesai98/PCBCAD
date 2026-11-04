/**
 * Default pin maps for built-in MCU emulators (port name → package pin number).
 */

/** ATmega328P TQFP-32 (also used when a part's sim.pinMap is empty). */
export const ATMEGA328P_TQFP32_PINMAP: Readonly<Record<string, string>> = Object.freeze({
  PD3: '1',
  PD4: '2',
  PB6: '7',
  PB7: '8',
  PD5: '9',
  PD6: '10',
  PD7: '11',
  PB0: '12',
  PB1: '13',
  PB2: '14',
  PB3: '15',
  PB4: '16',
  PB5: '17',
  AVCC: '18',
  ADC6: '19',
  AREF: '20',
  ADC7: '22',
  PC0: '23',
  PC1: '24',
  PC2: '25',
  PC3: '26',
  PC4: '27',
  PC5: '28',
  PC6: '29',
  PD0: '30',
  PD1: '31',
  PD2: '32',
});
/** ATmega328P TQFP-32 supply pins (VCC 4, 6; AVCC 18). */
export const ATMEGA328P_TQFP32_SUPPLY: readonly string[] = ['4', '6', '18'];
/** ATmega328P TQFP-32 ground pins. */
export const ATMEGA328P_TQFP32_GROUND: readonly string[] = ['3', '5', '21'];
