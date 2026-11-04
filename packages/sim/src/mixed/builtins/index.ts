/**
 * Built-in behaviour scripts (BehaviorScript, kind 'chip'), referenced by id from
 * part.sim {kind:'ic', behaviorId} or ComponentInstance.behaviorId.
 */
import type { BehaviorScript } from '@pcbcad/core';
import { BME280_CODE } from './bme280';
import { EEPROM24C02_CODE, HC595_CODE, SSD1306_CODE } from './others';

const STAMP = '2026-11-04T00:00:00.000Z';

export const BUILTIN_BEHAVIORS: BehaviorScript[] = [
  {
    id: 'builtin:bme280',
    name: 'Bosch BME280 (I2C/SPI)',
    kind: 'chip',
    code: BME280_CODE,
    description:
      'BME280 environmental sensor: chip id 0x60, soft reset, ctrl/config registers, typical calibration NVM (0x88–0xA1, 0xE1–0xE7) and raw ADC registers computed by inverting the Bosch integer compensation so firmware reads back params.temperatureC / pressurePa / humidityPct. I2C 0x76 (SDO low) / 0x77 (SDO high); 4-wire SPI when CSB is driven low.',
    updatedAt: STAMP,
    author: 'builtin',
  },
  {
    id: 'builtin:74hc595',
    name: '74HC595 shift register',
    kind: 'chip',
    code: HC595_CODE,
    description: '8-bit shift register with output latch (standard 16-pin pinout). Bit-banged SRCLK/RCLK edges or hardware SPI (SCK→SRCLK, MOSI→SER, MISO←QH′); ~OE tri-states the outputs, ~SRCLR clears.',
    updatedAt: STAMP,
    author: 'builtin',
  },
  {
    id: 'builtin:24c02',
    name: '24C02 I2C EEPROM',
    kind: 'chip',
    code: EEPROM24C02_CODE,
    description: '256-byte I2C EEPROM at 0x50|A2A1A0: page writes (8 bytes), 5 ms write cycle with ACK polling, random/sequential reads. params.contents (hex) preloads the memory.',
    updatedAt: STAMP,
    author: 'builtin',
  },
  {
    id: 'builtin:ssd1306',
    name: 'SSD1306 128×64 OLED (I2C)',
    kind: 'chip',
    code: SSD1306_CODE,
    description: 'SSD1306 OLED controller at I2C 0x3C/0x3D: command set incl. addressing modes, control-byte protocol, 1 KB framebuffer in state.fb and an ASCII rendering logged on display updates.',
    updatedAt: STAMP,
    author: 'builtin',
  },
];

/** Look up a built-in behaviour by id. */
export function builtinBehavior(id: string): BehaviorScript | undefined {
  return BUILTIN_BEHAVIORS.find((b) => b.id === id);
}
