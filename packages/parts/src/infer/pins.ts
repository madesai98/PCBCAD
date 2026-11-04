import type { PartCategory, PinDef, PinType } from '@pcbcad/core';

/** Categories whose pins are electrically passive (ERC 'passive'). */
const PASSIVE_CATEGORIES: PartCategory[] = [
  'resistor',
  'capacitor',
  'capacitor-polarized',
  'inductor',
  'ferrite',
  'diode',
  'zener',
  'schottky',
  'tvs',
  'led',
  'bjt-npn',
  'bjt-pnp',
  'mosfet-n',
  'mosfet-p',
  'crystal',
  'switch',
  'button',
  'relay',
  'fuse',
  'battery',
  'buzzer',
  'antenna',
  'testpoint',
  'connector',
  'cable',
  'wire',
  'fastener',
  'mechanical',
];

/** Upper-case pin name without inversion markers ('~RESET', 'RESET#', '/CS' → 'RESET', 'CS'). */
export function cleanPinName(name: string): string {
  return name
    .toUpperCase()
    .trim()
    .replace(/^[~!/]+/, '')
    .replace(/[{}\\]|OVERLINE/g, '')
    .replace(/[#*]$/, '')
    .replace(/\s+/g, '');
}

/** Name tokens: '(PCINT19/OC2B/INT1)PD3' → ['PCINT19','OC2B','INT1','PD3'], 'GPIO26_ADC0' → ['GPIO26','ADC0']. */
export function pinTokens(name: string): string[] {
  return cleanPinName(name)
    .split(/[()/,|_\s]+/)
    .map((t) => t.replace(/^[~!]+|[#*]+$/g, ''))
    .filter(Boolean);
}

export const GROUND_RE = /^(GND|VSS|AGND|DGND|PGND|SGND|CGND|GNDA|GNDD|GNDIO|VSSA|VSSD|VSSIO|EP|EPAD|E-?PAD|PAD|THERMAL|THERMALPAD|TAB_GND|0V|GND\d+|VSS\d+|COM_GND|GND\/ADJ|ADJ\/GND|GND\(ADJ\)|PAD_GND)$/;
export const SUPPLY_RE =
  /^(VCC|VDD|AVCC|AVDD|DVDD|DVCC|IOVDD|VDDIO|VIO|VDDA|VDDD|VDDQ|VCCIO|VCCA|VCCB|VCCQ|VBAT|VBATT|VIN|V\+|VS|VS\+|VPP|VREG_IN|VREGIN|USB_VDD|VDD_USB|VUSB|ADC_AVDD|VDDANA|VDDCORE|VDDPLL|VCC\d*|VDD\d*|VDD_[A-Z0-9_]+|VCC_[A-Z0-9_]+|3V3|3\.3V|5V|\+5V|\+3V3|VBUS|PVIN|AVIN|VIN\d|IN\+?VCC)$/;
const POWER_OUT_RE = /^(VOUT|VO|OUT|OUTPUT|VREG_VOUT|VREG_OUT|VREGOUT|VOUT\d|SW|LX|LX\d|SW\d|PH|VCAP_OUT|LDO_OUT|VDD_OUT)$/;
const NC_RE = /^(NC|N\.C\.?|NC\.|DNC|NIC|NULL|-|N\/C|NC\d+|RESERVED|RSVD|DNU)$/;
const GPIO_RE = /^(GPIO\d+|P[A-K]\d{1,2}|IO\d+|D\d+|PIO\d+|P\d_\d+|P\d\.\d+)$/;
const BIDIR_RE = /^(SDA|SDIO|SDI\/SDO|SWDIO|SWD|DATA|DQ|I\/O|SIO|USB_DP|USB_DM|USB_D[+-]|D\+|D-|DP|DM|DN|UD\+|UD-|QSPI_SD\d|QSPI_IO\d|IO|SD\d|DAT\d)$/;
const INPUT_RE =
  /^(N?RESET|NRST|RST|RSTN|RESETN|MCLR|RUN|XRES|CHIP_EN|EN|ENABLE|CE|CS|CSB|NCS|SS|SHDN|SD|STBY|STANDBY|WAKE|BOOT\d?|BOOTSEL|TESTEN|TEST|SWCLK|SCK|SCL|SCLK|CLK|CLKIN|XIN|XI|XTAL1|XTAL_IN|OSC1|OSCI|OSC_IN|EXTAL|RX|RXD|RXI|DIN|SDI|MOSI|CTS|DSR|RI|DCD|ADJ|FB|VFB|IN|IN\+|IN-|\+IN|-IN|INA?\+|INA?-|IN[1-4][+-]|[+-]IN[A-D1-4]|SET|ISET|VSET|MODE|SEL|SYNC|PWM_IN|A\d|ADDR\d?|SA\d|WP|HOLD|R232)$/;
const OUTPUT_RE = /^(TX|TXD|TXO|DOUT|SDO|MISO|XOUT|XO|XTAL2|XTAL_OUT|OSC2|OSCO|OSC_OUT|CLKOUT|MCO|RTS|DTR|OUT#?|INT|INT\d|IRQ|ALERT|DRDY|RDY|BUSY|PG|PGOOD|POK|FLT|FAULT|LED|PWM\d*|OUT[A-D1-4]|OUT\d|VOUTA|TNOW|STAT|CHRG)$/;
const OPEN_DRAIN_RE = /^(PG|PGOOD|POK|INT|IRQ|ALERT|FLT|FAULT|STAT|CHRG|OD|OPEN_DRAIN)$/;

const REGULATOR_CATS: PartCategory[] = ['ldo', 'dc-dc'];

function classify(name: string, category: PartCategory): PinType | undefined {
  const full = cleanPinName(name);
  const toks = pinTokens(name);
  if (!full) return undefined;
  if (NC_RE.test(full)) return 'nc';
  if (GROUND_RE.test(full)) return 'power_in';
  if (REGULATOR_CATS.includes(category)) {
    if (POWER_OUT_RE.test(full) || /^(VOUT|OUT)/.test(full)) return 'power_out';
    if (SUPPLY_RE.test(full) || /^(VIN|IN)\b/.test(full)) return 'power_in';
    if (OPEN_DRAIN_RE.test(full)) return 'open_collector';
    if (/^(BST|BOOT|BS|SS|TR|COMP|VC|NR|BYP|BYPASS|CAP)$/.test(full)) return 'passive';
    if (INPUT_RE.test(full)) return 'input';
    return undefined;
  }
  if (/^(VREG_VOUT|VREG_OUT|VREGOUT|LDO_OUT|VOUT\d?|VDD_OUT)$/.test(full)) return 'power_out';
  if (SUPPLY_RE.test(full)) return 'power_in';
  if (/^(V3|VCAP\d?|VDDCORE_CAP|AREF|VREF|VREF[+-]|REFOUT|BYPASS|CAP|C\d?|NR)$/.test(full)) return 'passive';
  if (toks.some((t) => GPIO_RE.test(t)) || BIDIR_RE.test(full) || toks.some((t) => BIDIR_RE.test(t))) return 'bidirectional';
  if (OPEN_DRAIN_RE.test(full)) return 'open_collector';
  if (OUTPUT_RE.test(full)) return 'output';
  if (INPUT_RE.test(full)) return 'input';
  if (/^ADC\d+$/.test(full) || /^AIN\d*$/.test(full)) return 'input';
  return undefined;
}

/**
 * Refine pin electrical types from names and the part category. Returns a new array in the same
 * order. Passive categories (R/C/L, diodes, transistors, connectors, switches, …) get 'passive'
 * (NC pins 'nc'); IC pins are classified from their names (GND/VDD → power_in, regulator outputs →
 * power_out, GPIO/SDA → bidirectional, TX/MISO → output, RX/RESET → input, NC → nc). Power, ground
 * and NC names always win; otherwise an existing non-'unspecified' type (e.g. from the EasyEDA
 * symbol) is kept.
 */
export function inferPinTypes(pins: PinDef[], category: PartCategory): PinDef[] {
  return pins.map((p) => {
    const name = p.name ?? '';
    const full = cleanPinName(name);
    if (PASSIVE_CATEGORIES.includes(category)) {
      return { ...p, type: NC_RE.test(full) ? 'nc' : 'passive' };
    }
    const t = classify(name, category);
    if (t === 'nc' || t === 'power_in' || t === 'power_out') return { ...p, type: t };
    if (p.type && p.type !== 'unspecified') return { ...p };
    return { ...p, type: t ?? 'unspecified' };
  });
}

/** True when the pin name looks like a ground net. */
export function isGroundName(name: string): boolean {
  return GROUND_RE.test(cleanPinName(name)) || pinTokens(name).some((t) => /^(GND|VSS|AGND|DGND|PGND)$/.test(t));
}

/** True when the pin name looks like a supply input. */
export function isSupplyName(name: string): boolean {
  return SUPPLY_RE.test(cleanPinName(name));
}
