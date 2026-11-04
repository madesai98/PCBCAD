import type { FootprintDef, PackageSpec } from '@pcbcad/core';
import { completeSpec } from '../package/defaults';
import { bgaFootprint, chipFootprint, dualGullFootprint, lgaFootprint, melfFootprint, noLeadFootprint, qfpFootprint, sot223Footprint, sot23Footprint, sot89Footprint, to252Footprint, twoTerminalFootprint } from './smd';
import { batteryHolderFootprint, crystalSmdFootprint, customFootprint, electrolyticSmdFootprint, inductorSmdFootprint, moduleFootprint, tactileSwitchFootprint, usbCFootprint, usbMicroFootprint } from './special';
import { dipFootprint, electrolyticThtFootprint, hc49Footprint, headerFootprint, jstShFootprint, jstThtFootprint, ledThtFootprint, terminalBlockFootprint, to220Footprint, to92Footprint } from './tht';

/**
 * Generate a land pattern from a parametric package description.
 *
 * IPC-7351B nominal density for SMD families (see ipc.ts), IPC-2222 level-B holes for THT,
 * JEDEC pin numbering (pin 1 top-left, counter-clockwise), pin-1 silk marker, fab outline,
 * courtyard (0.25 mm margin; 0.5 mm for connectors) rounded to 0.05 mm.
 * Missing dimensions are filled from typical package data (completeSpec). The returned footprint
 * has source 'generated' and `generator` set to the completed spec. Units: mm, Y up.
 */
export function generateFootprint(spec: PackageSpec): FootprintDef {
  const s = completeSpec(spec);
  switch (s.family) {
    case 'chip':
      return chipFootprint(s);
    case 'sod123':
    case 'sod323':
    case 'sma':
    case 'smb':
    case 'smc':
      return twoTerminalFootprint(s);
    case 'melf':
      return melfFootprint(s);
    case 'sot23':
      return sot23Footprint(s);
    case 'sot223':
      return sot223Footprint(s);
    case 'sot89':
      return sot89Footprint(s);
    case 'to252':
      return to252Footprint(s);
    case 'soic':
    case 'ssop':
    case 'tssop':
    case 'msop':
      return dualGullFootprint(s);
    case 'qfp':
      return qfpFootprint(s);
    case 'qfn':
    case 'dfn':
      return noLeadFootprint(s);
    case 'lga':
      return lgaFootprint(s);
    case 'bga':
      return bgaFootprint(s);
    case 'dip':
      return dipFootprint(s);
    case 'to92':
      return to92Footprint(s);
    case 'to220':
      return to220Footprint(s);
    case 'header':
      return headerFootprint(s);
    case 'jst-ph':
    case 'jst-xh':
      return jstThtFootprint(s);
    case 'jst-sh':
      return jstShFootprint(s);
    case 'usb-c':
      return usbCFootprint(s);
    case 'usb-micro':
      return usbMicroFootprint(s);
    case 'crystal-smd':
      return crystalSmdFootprint(s);
    case 'hc49':
      return hc49Footprint(s);
    case 'electrolytic-smd':
      return electrolyticSmdFootprint(s);
    case 'electrolytic-tht':
      return electrolyticThtFootprint(s);
    case 'inductor-smd':
      return inductorSmdFootprint(s);
    case 'tactile-switch':
      return tactileSwitchFootprint(s);
    case 'led-tht':
      return ledThtFootprint(s);
    case 'terminal-block':
      return terminalBlockFootprint(s);
    case 'battery-holder':
      return batteryHolderFootprint(s);
    case 'module':
      return moduleFootprint(s);
    case 'custom':
    default:
      return customFootprint(s);
  }
}
