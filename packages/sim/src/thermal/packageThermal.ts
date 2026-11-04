import type { PackageFamily, PartDef } from '@pcbcad/core';
import { getMaterial } from '@pcbcad/core';

/**
 * Package-level thermal defaults used when a part has no datasheet values.
 *
 * θJC here means the junction-to-board-side-of-the-case resistance seen by heat that leaves the
 * package through its leads / exposed pad into the PCB (the board model assumes ALL component
 * power enters the board, see README). Values are typical datasheet / JEDEC figures (θJC-bottom,
 * θJB or θJL as appropriate for the package style), rounded and deliberately mid-to-conservative.
 * For 2-terminal chip parts the "junction" is the resistive film / winding hot spot and the value
 * is the hot-spot-to-terminal resistance.
 */

const CHIP_THETA: Record<string, number> = {
  '01005': 300,
  '0201': 250,
  '0402': 180,
  '0603': 120,
  '0805': 85,
  '1206': 55,
  '1210': 45,
  '1812': 35,
  '2010': 35,
  '2512': 25,
};

const FAMILY_THETA: Record<PackageFamily, number> = {
  chip: 85,
  sod123: 120,
  sod323: 160,
  sma: 25,
  smb: 18,
  smc: 12,
  melf: 60,
  sot23: 120,
  sot223: 15,
  sot89: 30,
  to252: 4,
  soic: 40,
  ssop: 45,
  tssop: 45,
  msop: 50,
  qfn: 8,
  dfn: 10,
  qfp: 18,
  lga: 25,
  bga: 12,
  dip: 45,
  to92: 80,
  to220: 3,
  header: 15,
  'jst-ph': 20,
  'jst-xh': 15,
  'jst-sh': 25,
  'usb-c': 15,
  'usb-micro': 20,
  'crystal-smd': 60,
  hc49: 60,
  'electrolytic-smd': 30,
  'electrolytic-tht': 30,
  'inductor-smd': 20,
  'tactile-switch': 40,
  'led-tht': 150,
  'terminal-block': 10,
  'battery-holder': 30,
  module: 10,
  custom: 30,
};

/** Families whose θJC drops to ~10 °C/W with an exposed (soldered) thermal pad. */
const EP_FAMILIES = new Set<PackageFamily>(['soic', 'ssop', 'tssop', 'msop', 'qfp']);

const NAME_PATTERNS: [RegExp, PackageFamily][] = [
  [/(^|[^0-9])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)([^0-9]|$)/, 'chip'],
  [/SOT-?223/i, 'sot223'],
  [/SOT-?89/i, 'sot89'],
  [/SOT-?23|SOT-?323|SOT-?363|SOT-?353|SOT-?563|SC-?70|SC-?59|TSOT/i, 'sot23'],
  [/TO-?252|TO-?263|D2?PAK/i, 'to252'],
  [/TO-?220/i, 'to220'],
  [/TO-?92/i, 'to92'],
  [/SOD-?123/i, 'sod123'],
  [/SOD-?323|SOD-?523|SOD-?923/i, 'sod323'],
  [/(^|[^A-Z])SMA([^A-Z]|$)|DO-?214AC/i, 'sma'],
  [/(^|[^A-Z])SMB([^A-Z]|$)|DO-?214AA/i, 'smb'],
  [/(^|[^A-Z])SMC([^A-Z]|$)|DO-?214AB/i, 'smc'],
  [/MELF|LL-?34|SOD-?80/i, 'melf'],
  [/QFN/i, 'qfn'],
  [/DFN|W?SON(-|\b)|VSON/i, 'dfn'],
  [/MSOP|VSSOP|[µu]SOP/i, 'msop'],
  [/TSSOP/i, 'tssop'],
  [/SSOP|QSOP/i, 'ssop'],
  [/SOIC|SOP|SO-?\d/i, 'soic'],
  [/QFP/i, 'qfp'],
  [/BGA/i, 'bga'],
  [/LGA/i, 'lga'],
  [/DIP/i, 'dip'],
];

/** Package family from the parametric spec, else guessed from the package name. */
export function packageFamily(part: PartDef | undefined): PackageFamily | undefined {
  if (!part) return undefined;
  if (part.packageSpec?.family) return part.packageSpec.family;
  const name = part.package ?? '';
  for (const [re, fam] of NAME_PATTERNS) if (re.test(name)) return fam;
  return undefined;
}

function chipSize(part: PartDef): string | undefined {
  if (part.packageSpec?.size) return part.packageSpec.size;
  const m = /(^|[^0-9])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)([^0-9]|$)/.exec(part.package ?? '');
  return m?.[2];
}

function hasExposedPad(part: PartDef): boolean {
  if (part.packageSpec?.exposedPad) return true;
  if (/(^|[^A-Z])EP([^A-Z]|$)|PowerPAD|HTSSOP|HSOP|exposed/i.test(part.package ?? '')) return true;
  return !!part.footprint?.pads.some((p) => /^(EP|PAD|TAB|0)$/i.test(p.number) && p.kind === 'smd' && p.w * p.h >= 2);
}

/**
 * Default junction-to-case (board side) thermal resistance (°C/W) for a part without
 * `thermal.thetaJC`.
 */
export function defaultThetaJC(part: PartDef | undefined): number {
  if (!part) return FAMILY_THETA.custom;
  const fam = packageFamily(part);
  if (fam === 'chip') {
    const s = chipSize(part);
    return (s && CHIP_THETA[s]) || FAMILY_THETA.chip;
  }
  if (!fam) return hasExposedPad(part) ? 12 : FAMILY_THETA.custom;
  if (EP_FAMILIES.has(fam) && hasExposedPad(part)) return 10;
  return FAMILY_THETA[fam] ?? FAMILY_THETA.custom;
}

/** Solder joint thickness (mm) assumed for the case-to-board resistance. */
const SOLDER_JOINT_MM = 0.075;

/**
 * Case-to-board resistance (°C/W) of the solder joints: θcb = t_joint / (k_solder · A_pads),
 * t_joint = 75 µm, k = SAC305 (58 W/m·K). Clamped to [0.05, 10] °C/W.
 * @param padAreaMm2 total soldered pad area on the component side (mm²)
 */
export function caseToBoardTheta(padAreaMm2: number): number {
  const k = getMaterial('solder-sac305')?.thermalConductivity ?? 58;
  if (!(padAreaMm2 > 0)) return 10;
  const th = (SOLDER_JOINT_MM * 1e-3) / (k * padAreaMm2 * 1e-6);
  return Math.min(10, Math.max(0.05, th));
}
