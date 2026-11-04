import type { BodyPrimitive, PackageSpec, PadDef, PartCategory, Vec2 } from '@pcbcad/core';
import { generateFootprint } from '../footprint/generate';
import { CHIP_SIZES, completeSpec } from '../package/defaults';
import { rnd } from '../util/num';
import { box, boxSpan, C, cyl, extrude, gullLead, pin1Mark, pinLead, resolveColor } from './prims';

/* --------------------------------------------------------------------------------------------- *
 * Parametric 3D bodies (BodyPrimitive[]). Footprint frame, mm, z = 0 at the board surface
 * (component side), +z away from the board. THT leads extend to z = −3 (through a 1.6 mm board).
 * Leads are placed on the generated footprint's pads so the model always lines up with it.
 * --------------------------------------------------------------------------------------------- */

export interface BodyOptions {
  category?: PartCategory;
  /** Lens / housing / sleeve colour: name ('red', 'blue', 'emerald green') or '#rrggbb'. */
  color?: string;
}

const BELOW = -3.0;

function exNum(s: PackageSpec, k: string): number | undefined {
  const v = s.extra?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function exStr(s: PackageSpec, k: string): string | undefined {
  const v = s.extra?.[k];
  return typeof v === 'string' ? v : undefined;
}

function exBool(s: PackageSpec, k: string): boolean | undefined {
  const v = s.extra?.[k];
  return typeof v === 'boolean' ? v : undefined;
}

function signalPads(pads: PadDef[]): PadDef[] {
  return pads.filter((p) => p.number !== '' && p.number !== 'MP' && p.kind !== 'npth');
}

/**
 * Generate a good-looking parametric 3D body for a package. Colours follow the part category
 * (black epoxy ICs with tinned leads, tan MLCCs, black-top resistors, white JST housings, black
 * headers with gold pins, metal USB-C shell, aluminium electrolytic cans, …).
 */
export function generateBody(spec: PackageSpec, opts: BodyOptions = {}): BodyPrimitive[] {
  const s = completeSpec(spec);
  const cat = opts.category;
  const color = resolveColor(opts.color);
  switch (s.family) {
    case 'chip':
      return chipBody(s, cat, color);
    case 'sod123':
    case 'sod323':
    case 'sma':
    case 'smb':
    case 'smc':
      return twoTermBody(s);
    case 'melf':
      return melfBody(s, cat);
    case 'sot23':
    case 'sot223':
    case 'soic':
    case 'ssop':
    case 'tssop':
    case 'msop':
    case 'qfp':
      return gullBody(s);
    case 'sot89':
      return sot89Body(s);
    case 'to252':
      return to252Body(s);
    case 'qfn':
    case 'dfn':
    case 'lga':
      return noLeadBody(s, cat);
    case 'bga':
      return bgaBody(s);
    case 'dip':
      return dipBody(s);
    case 'to92':
      return to92Body(s);
    case 'to220':
      return to220Body(s);
    case 'header':
      return headerBody(s);
    case 'jst-ph':
    case 'jst-xh':
    case 'jst-sh':
      return jstBody(s, color);
    case 'usb-c':
      return usbCBody(s);
    case 'usb-micro':
      return usbMicroBody(s);
    case 'crystal-smd':
      return crystalSmdBody(s);
    case 'hc49':
      return hc49Body(s);
    case 'electrolytic-smd':
      return elecSmdBody(s, color);
    case 'electrolytic-tht':
      return elecThtBody(s, color);
    case 'inductor-smd':
      return inductorBody(s);
    case 'tactile-switch':
      return tactBody(s);
    case 'led-tht':
      return ledThtBody(s, color);
    case 'terminal-block':
      return terminalBody(s, color);
    case 'battery-holder':
      return batteryBody(s);
    case 'module':
      return moduleBody(s);
    case 'custom':
    default:
      return [box([0, 0, (s.bodyH ?? 1) / 2], [s.bodyW ?? 2, s.bodyL ?? 2, s.bodyH ?? 1], C.epoxy, { radius: 0.1 })];
  }
}

/* -------------------------------------------------------------------------------- passives */

function chipBody(s: PackageSpec, cat: PartCategory | undefined, color: string | undefined): BodyPrimitive[] {
  const L = s.bodyW ?? 2;
  const W = s.bodyL ?? 1.25;
  const H = s.bodyH ?? 0.5;
  const t = CHIP_SIZES[s.size ?? '0805'];
  const T = rnd(Math.min(L * 0.3, t ? (t.T[0] + t.T[1]) / 2 : L * 0.2), 3);
  const out: BodyPrimitive[] = [];
  const caps = (h: number, w = W) => {
    out.push(boxSpan(-L / 2, -L / 2 + T, -w / 2, w / 2, 0, h, C.tin, { metal: true }));
    out.push(boxSpan(L / 2 - T, L / 2, -w / 2, w / 2, 0, h, C.tin, { metal: true }));
  };
  const diodeLike = cat === 'diode' || cat === 'zener' || cat === 'schottky' || cat === 'tvs' || (cat === undefined && exBool(s, 'polarized') === true);
  if (cat === 'led') {
    const lens = color ?? C.ledBody;
    out.push(boxSpan(-L / 2 + T * 0.5, L / 2 - T * 0.5, -W / 2, W / 2, 0, H * 0.55, C.ledBody));
    out.push(boxSpan(-L / 2 + T, L / 2 - T, -W / 2 + 0.03, W / 2 - 0.03, H * 0.55, H, lens));
    caps(H * 0.55);
    // cathode mark (green tint) on pin 1 end
    out.push(boxSpan(-L / 2 + T * 0.5, -L / 2 + T * 1.3, -W / 2 + 0.05, W / 2 - 0.05, H * 0.55, H * 0.56, '#2e9e4f'));
    return out;
  }
  if (cat === 'capacitor-polarized') {
    out.push(boxSpan(-L / 2 + T * 0.4, L / 2 - T * 0.4, -W / 2, W / 2, 0, H, '#d8a23a', { radius: 0.03 }));
    out.push(boxSpan(-L / 2 + T * 0.4, -L / 2 + T * 1.4, -W / 2 - 0.001, W / 2 + 0.001, H - 0.01, H + 0.005, '#6b4410'));
    caps(H * 0.6);
    return out;
  }
  if (cat === 'capacitor') {
    out.push(boxSpan(-L / 2 + T * 0.6, L / 2 - T * 0.6, -W / 2 + 0.01, W / 2 - 0.01, 0, H - 0.01, C.ceramicTan, { radius: 0.03 }));
    caps(H, W);
    return out;
  }
  if (cat === 'inductor' || cat === 'ferrite') {
    out.push(boxSpan(-L / 2 + T * 0.6, L / 2 - T * 0.6, -W / 2 + 0.01, W / 2 - 0.01, 0, H - 0.01, C.inductor, { radius: 0.03 }));
    caps(H, W);
    return out;
  }
  if (diodeLike) {
    out.push(boxSpan(-L / 2 + T * 0.6, L / 2 - T * 0.6, -W / 2, W / 2, 0, H, C.epoxy));
    out.push(boxSpan(-L / 2 + T * 0.8, -L / 2 + T * 1.6, -W / 2 - 0.001, W / 2 + 0.001, H - 0.005, H + 0.005, C.stripe));
    caps(H * 0.8);
    return out;
  }
  // resistor (default): white alumina substrate, black resistive top, tinned wrap-around caps
  out.push(boxSpan(-L / 2 + 0.02, L / 2 - 0.02, -W / 2, W / 2, 0, H - 0.04, C.substrate));
  out.push(boxSpan(-L / 2 + T, L / 2 - T, -W / 2 + 0.01, W / 2 - 0.01, H - 0.04, H, cat === 'fuse' ? '#4a4a4a' : C.resistorTop));
  caps(H, W + 0.01);
  return out;
}

function twoTermBody(s: PackageSpec): BodyPrimitive[] {
  const L = s.bodyW ?? 2.7;
  const W = s.bodyL ?? 1.6;
  const H = s.bodyH ?? 1.1;
  const span = s.leadSpan ?? L + 1;
  const jBend = s.family === 'sma' || s.family === 'smb' || s.family === 'smc';
  const leadW = jBend ? (s.family === 'sma' ? 1.4 : s.family === 'smb' ? 2.0 : 3.0) : s.family === 'sod123' ? 0.6 : 0.3;
  const z0 = jBend ? 0.15 : 0.1;
  const out: BodyPrimitive[] = [boxSpan(-L / 2, L / 2, -W / 2, W / 2, z0, H, C.epoxy, { radius: 0.08 })];
  // cathode band near pin 1 (−X)
  out.push(boxSpan(-L / 2 + L * 0.08, -L / 2 + L * 0.25, -W / 2 + 0.05, W / 2 - 0.05, H, H + 0.01, C.stripe));
  for (const sx of [-1, 1]) {
    if (jBend) {
      out.push(boxSpan(sx * (L / 2 - 0.4), sx * (span / 2), -leadW / 2, leadW / 2, 0, 0.15, C.tin, { metal: true }));
      out.push(boxSpan(sx * (L / 2), sx * (span / 2), -leadW / 2, leadW / 2, 0, Math.min(H * 0.55, 1.2), C.tin, { metal: true }));
    } else {
      out.push(...gullLead(sx > 0 ? '+x' : '-x', sx * (L / 2), sx * (span / 2), 0, leadW, Math.min(H * 0.45, 0.45), 0.12));
    }
  }
  return out;
}

function melfBody(s: PackageSpec, cat: PartCategory | undefined): BodyPrimitive[] {
  const L = s.bodyW ?? 3.5;
  const D = s.bodyL ?? 1.5;
  const cap = Math.min(0.5, L * 0.13);
  const diode = cat === 'diode' || cat === 'zener' || cat === 'schottky' || exBool(s, 'polarized') === true;
  const out: BodyPrimitive[] = [cyl([0, 0, D / 2], D / 2 - 0.02, L - 2 * cap, 'x', diode ? C.glassRed : C.melfBlue)];
  out.push(cyl([-(L / 2 - cap / 2), 0, D / 2], D / 2, cap, 'x', C.tin, { metal: true }));
  out.push(cyl([L / 2 - cap / 2, 0, D / 2], D / 2, cap, 'x', C.tin, { metal: true }));
  if (diode) out.push(cyl([-(L / 2 - cap - 0.25), 0, D / 2], D / 2 - 0.01, 0.3, 'x', C.dark));
  return out;
}

/* ----------------------------------------------------------------------------- leaded ICs */

function gullBody(s: PackageSpec): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const W = s.bodyW ?? 3.9;
  const L = s.bodyL ?? 4.9;
  const H = s.bodyH ?? 1.75;
  const quad = s.family === 'qfp';
  const standoff = s.family === 'tssop' || s.family === 'msop' ? 0.05 : 0.1;
  const zExit = standoff + (H - standoff) * 0.35;
  const out: BodyPrimitive[] = [boxSpan(-W / 2, W / 2, -L / 2, L / 2, standoff, H, C.epoxy, { radius: 0.08 })];
  const spanX = s.leadSpan ?? W + 2;
  const spanY = quad ? L + (spanX - W) : spanX;
  const sigs = signalPads(fp.pads);
  const pinCount = s.pins ?? sigs.length;
  const tab = s.family === 'sot223' ? String(pinCount) : undefined;
  for (const p of sigs) {
    if (p.pasteRatio !== undefined && Math.abs(p.x) < 1e-6 && Math.abs(p.y) < 1e-6) {
      out.push(boxSpan(-p.w / 2, p.w / 2, -p.h / 2, p.h / 2, 0, 0.02, C.tin, { metal: true }));
      continue;
    }
    const vertical = quad && Math.abs(p.y) > Math.abs(p.x);
    const width = rnd(Math.min(vertical ? p.w : p.h, p.number === tab ? 3.0 : (s.pitch ?? 1.27) * 0.42), 3);
    const lw = p.number === tab ? 3.0 : Math.max(0.15, width * 0.75);
    if (vertical) out.push(...gullLead(p.y > 0 ? '+y' : '-y', (Math.sign(p.y) * L) / 2, (Math.sign(p.y) * spanY) / 2, p.x, lw, zExit));
    else out.push(...gullLead(p.x > 0 ? '+x' : '-x', (Math.sign(p.x) * W) / 2, (Math.sign(p.x) * spanX) / 2, p.y, lw, zExit));
  }
  // pin-1 mark
  const p1 = sigs.find((p) => p.number === '1');
  if (p1) {
    const r = Math.min(0.35, Math.min(W, L) * 0.08);
    const mx = Math.max(-W / 2 + r * 2.2, Math.min(W / 2 - r * 2.2, p1.x * 0.6));
    const my = Math.max(-L / 2 + r * 2.2, Math.min(L / 2 - r * 2.2, p1.y + (quad ? -r : 0)));
    out.push(pin1Mark(mx, my, H, r));
  }
  return out;
}

function sot89Body(s: PackageSpec): BodyPrimitive[] {
  const W = s.bodyW ?? 2.5;
  const L = s.bodyL ?? 4.5;
  const H = s.bodyH ?? 1.5;
  const p = s.pitch ?? 1.5;
  const out: BodyPrimitive[] = [boxSpan(-W / 2, W / 2, -L / 2, L / 2, 0.05, H, C.epoxy, { radius: 0.08 })];
  for (const y of [p, 0, -p]) out.push(boxSpan(-2.05, -W / 2 + 0.1, y - 0.22, y + 0.22, 0, 0.12, C.tin, { metal: true }));
  out.push(boxSpan(-0.6, W / 2 + 0.25, -0.85, 0.85, 0, 0.1, C.tin, { metal: true }));
  out.push(pin1Mark(-W / 4, p, H, 0.25));
  return out;
}

function to252Body(s: PackageSpec): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const d2 = s.extra?.variant === 'd2pak';
  const W = s.bodyW ?? 6.1;
  const L = s.bodyL ?? 6.6;
  const H = s.bodyH ?? 2.3;
  const span = s.leadSpan ?? (d2 ? 15.3 : 9.9);
  const cx = span / 2 - W / 2 - (d2 ? 0.6 : 0.5);
  const out: BodyPrimitive[] = [boxSpan(cx - W / 2, cx + W / 2, -L / 2, L / 2, 0.05, H, C.epoxy, { radius: 0.1 })];
  out.push(boxSpan(cx - W / 2 + 0.6, span / 2, -L * 0.4, L * 0.4, 0, 0.5, C.tin, { metal: true }));
  for (const p of signalPads(fp.pads)) {
    if (p.x > 0) continue;
    out.push(...gullLead('-x', cx - W / 2, -span / 2, p.y, Math.min(0.8, p.h * 0.7), H * 0.45, 0.5));
  }
  out.push(pin1Mark(cx - W / 4, L / 4, H, 0.4));
  return out;
}

/* ------------------------------------------------------------------------- no-lead / array */

function noLeadBody(s: PackageSpec, cat: PartCategory | undefined): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const W = s.bodyW ?? 3;
  const L = s.bodyL ?? W;
  const H = s.bodyH ?? 0.9;
  const out: BodyPrimitive[] = [];
  const lidded = s.family === 'lga' && (cat === 'sensor' || exBool(s, 'lid') === true);
  if (lidded) {
    out.push(boxSpan(-W / 2, W / 2, -L / 2, L / 2, 0.01, H * 0.16, C.pcbGreen));
    out.push(boxSpan(-W / 2 + 0.05, W / 2 - 0.05, -L / 2 + 0.05, L / 2 - 0.05, H * 0.16, H, C.aluminium, { metal: true, radius: 0.05 }));
    out.push(cyl([W * 0.25, -L * 0.25, H + 0.002], Math.min(W, L) * 0.08, 0.004, 'z', C.dark));
  } else {
    out.push(boxSpan(-W / 2, W / 2, -L / 2, L / 2, 0.02, H, C.epoxy, { radius: 0.03 }));
  }
  const term = Math.min(0.4, Math.min(W, L) * 0.15);
  for (const p of signalPads(fp.pads)) {
    const isEP = p.pasteRatio !== undefined;
    if (isEP) {
      out.push(boxSpan(p.x - p.w / 2, p.x + p.w / 2, p.y - p.h / 2, p.y + p.h / 2, 0, 0.02, C.tin, { metal: true }));
      continue;
    }
    if (s.family === 'lga') {
      out.push(boxSpan(p.x - p.w * 0.4, p.x + p.w * 0.4, p.y - p.h * 0.4, p.y + p.h * 0.4, 0, 0.015, C.gold, { metal: true }));
      continue;
    }
    const horiz = p.w >= p.h;
    const tw = (horiz ? p.h : p.w) * 0.85;
    if (horiz) {
      const sx = Math.sign(p.x);
      out.push(boxSpan(sx * (W / 2 + 0.005), sx * (W / 2 - term), p.y - tw / 2, p.y + tw / 2, 0, 0.2, C.tin, { metal: true }));
    } else {
      const sy = Math.sign(p.y);
      out.push(boxSpan(p.x - tw / 2, p.x + tw / 2, sy * (L / 2 + 0.005), sy * (L / 2 - term), 0, 0.2, C.tin, { metal: true }));
    }
  }
  if (!lidded) {
    const p1 = fp.pads.find((p) => p.number === '1');
    const r = Math.min(0.25, Math.min(W, L) * 0.07);
    const mx = p1 ? Math.sign(p1.x || -1) * (W / 2 - r * 2.5) : -W / 2 + r * 2.5;
    out.push(pin1Mark(mx, L / 2 - r * 2.5, H, r));
  }
  return out;
}

function bgaBody(s: PackageSpec): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const W = s.bodyW ?? 8;
  const L = s.bodyL ?? 8;
  const H = s.bodyH ?? 1.2;
  const pitch = s.pitch ?? 0.8;
  const ball = exNum(s, 'ballDiameter') ?? 0.6 * pitch;
  const bh = ball * 0.75;
  const sub = Math.min(0.36, H * 0.3);
  const out: BodyPrimitive[] = [
    boxSpan(-W / 2, W / 2, -L / 2, L / 2, bh, bh + sub, '#3b3a28'),
    boxSpan(-W / 2 + 0.1, W / 2 - 0.1, -L / 2 + 0.1, L / 2 - 0.1, bh + sub, H, C.epoxy, { radius: 0.05 }),
  ];
  for (const p of fp.pads) out.push(cyl([p.x, p.y, bh / 2], ball / 2, bh, 'z', C.tin, { metal: true, segments: 12 }));
  out.push(pin1Mark(-W / 2 + 0.6, L / 2 - 0.6, H, 0.25));
  return out;
}

/* ------------------------------------------------------------------------------- THT parts */

function dipBody(s: PackageSpec): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const W = s.bodyW ?? 6.35;
  const L = s.bodyL ?? 10;
  const H = s.bodyH ?? 3.3;
  const z0 = 0.5;
  const out: BodyPrimitive[] = [boxSpan(-W / 2, W / 2, -L / 2, L / 2, z0, z0 + H, C.epoxy, { radius: 0.15 })];
  out.push(cyl([0, L / 2, z0 + H + 0.004], 0.75, 0.008, 'z', C.epoxyMark));
  out.push(pin1Mark(-W / 2 + 1.1, L / 2 - 1.1, z0 + H, 0.4));
  const zs = z0 + H * 0.4;
  for (const p of fp.pads) {
    const sx = Math.sign(p.x);
    out.push(boxSpan(sx * (W / 2), p.x + sx * 0.15, p.y - 0.75, p.y + 0.75, zs - 0.13, zs + 0.13, C.tin, { metal: true }));
    out.push(boxSpan(p.x - 0.13, p.x + 0.13, p.y - 0.75, p.y + 0.75, z0, zs, C.tin, { metal: true }));
    out.push(pinLead(p.x, p.y, BELOW, z0, 0.46, C.tin, false));
  }
  return out;
}

function to92Body(s: PackageSpec): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const d = s.bodyW ?? 4.6;
  const r = d / 2;
  const flat = -(s.bodyL ?? 3.6) + r;
  const z0 = 2.5;
  const H = s.bodyH ?? 4.6;
  const pts: Vec2[] = [];
  const a0 = Math.asin(Math.max(-1, Math.min(1, flat / r)));
  const a1 = Math.PI - a0;
  for (let i = 0; i <= 24; i++) {
    const a = a0 + ((a1 - a0) * i) / 24;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  const out: BodyPrimitive[] = [extrude(pts, z0, z0 + H, C.epoxy)];
  for (const p of fp.pads) out.push(pinLead(p.x, 0, BELOW, z0, 0.43));
  return out;
}

function to220Body(s: PackageSpec): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const W = s.bodyW ?? 10.1;
  const t = s.bodyL ?? 4.5;
  const out: BodyPrimitive[] = [];
  if (s.orientation === 'horizontal') {
    out.push(boxSpan(-W / 2, W / 2, 2.5, 2.5 + 9.2, 0, t, C.epoxy, { radius: 0.2 }));
    out.push(boxSpan(-W / 2, W / 2, 2.5 + 9.2, 2.5 + 15.5, 0, 1.3, C.tin, { metal: true }));
    out.push(cyl([0, 2.5 + 15.5 - 2.8, 0.66], 1.8, 1.34, 'z', C.dark));
    for (const p of fp.pads) {
      out.push(pinLead(p.x, 0, BELOW, 1.6, 0.8));
      out.push(boxSpan(p.x - 0.4, p.x + 0.4, -0.4, 2.6, 1.2, 2.0, C.tin, { metal: true }));
    }
    return out;
  }
  const y0 = t / 2 - 1.8;
  const z0 = 3.0;
  out.push(boxSpan(-W / 2, W / 2, y0 - t / 2, y0 + t / 2, z0, z0 + 9.2, C.epoxy, { radius: 0.2 }));
  out.push(boxSpan(-W / 2, W / 2, y0 + t / 2 - 1.3, y0 + t / 2, z0 + 9.2, z0 + 15.5, C.tin, { metal: true }));
  out.push(cyl([0, y0 + t / 2 - 0.65, z0 + 15.5 - 2.8], 1.8, 1.34, 'y', C.dark));
  for (const p of fp.pads) out.push(pinLead(p.x, 0, BELOW, z0 + 0.5, 0.8));
  return out;
}

function headerBody(s: PackageSpec): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const pitch = s.pitch ?? 2.54;
  const rows = s.rows ?? 1;
  const cols = Math.ceil((s.pins ?? 4) / rows);
  const female = exStr(s, 'gender') === 'female';
  const ra = s.orientation === 'right-angle' || s.orientation === 'horizontal';
  const H = s.bodyH ?? 8.5;
  const pin = pitch >= 2.5 ? 0.64 : pitch >= 1.95 ? 0.5 : 0.4;
  const w = cols * pitch;
  const out: BodyPrimitive[] = [];
  const pads = fp.pads;
  const yLow = Math.min(...pads.map((p) => p.y));
  if (ra) {
    const depth = female ? 8.5 : 2.5;
    const yb0 = yLow - pitch / 2 - 1.0 - depth;
    const yb1 = yLow - pitch / 2 - 1.0;
    out.push(boxSpan(-w / 2, w / 2, yb0, yb1, 0, rows * pitch, female ? C.headerBlack : C.headerBlack, { radius: 0.1 }));
    for (const p of pads) {
      const rowIdx = Math.round((p.y - yLow) / pitch);
      const zp = pitch / 2 + rowIdx * pitch;
      out.push(pinLead(p.x, p.y, BELOW, zp + pin / 2, pin, C.gold));
      if (!female) out.push(boxSpan(p.x - pin / 2, p.x + pin / 2, yb0 - 6.0, p.y + pin / 2, zp - pin / 2, zp + pin / 2, C.gold, { metal: true }));
      else out.push(boxSpan(p.x - pin / 2, p.x + pin / 2, yb1, p.y + pin / 2, zp - pin / 2, zp + pin / 2, C.gold, { metal: true }));
    }
    return out;
  }
  const base = female ? H : 2.5;
  out.push(boxSpan(-w / 2, w / 2, -(rows * pitch) / 2, (rows * pitch) / 2, 0, base, C.headerBlack, { radius: 0.08 }));
  for (const p of pads) {
    if (female) {
      out.push(boxSpan(p.x - pin * 0.7, p.x + pin * 0.7, p.y - pin * 0.7, p.y + pin * 0.7, base, base + 0.01, C.dark));
      out.push(pinLead(p.x, p.y, BELOW, 0.5, pin * 0.8, C.gold));
    } else {
      out.push(pinLead(p.x, p.y, BELOW, H, pin, C.gold));
    }
  }
  return out;
}

function jstBody(s: PackageSpec, color: string | undefined): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const housing = color ?? (s.family === 'jst-xh' ? C.xhNatural : s.family === 'jst-sh' ? C.shNatural : C.jstNatural);
  const W = s.bodyW ?? 6;
  const H = s.bodyH ?? 6;
  const side = s.orientation === 'right-angle' || s.orientation === 'horizontal';
  const smd = exBool(s, 'smd') === true || s.family === 'jst-sh';
  const sig = fp.pads.filter((p) => p.number !== 'MP' && p.number !== '');
  const mps = fp.pads.filter((p) => p.number === 'MP');
  // body box from the footprint fab outline
  const fab = fp.graphics.find((g) => g.layer === 'fab' && g.kind === 'polyline');
  let y0 = -2;
  let y1 = 2;
  if (fab && fab.kind === 'polyline') {
    y0 = Math.min(...fab.points.map((p) => p[1]));
    y1 = Math.max(...fab.points.map((p) => p[1]));
  }
  const out: BodyPrimitive[] = [boxSpan(-W / 2, W / 2, y0, y1, 0, H, housing, { radius: 0.15 })];
  const pin = s.family === 'jst-sh' ? 0.3 : s.family === 'jst-xh' ? 0.64 : 0.5;
  if (side) {
    // mating face at −Y: dark cavity plate with contacts
    const wall = s.family === 'jst-sh' ? 0.35 : 0.7;
    out.push(boxSpan(-W / 2 + wall, W / 2 - wall, y0 - 0.005, y0 + 0.002, wall * 0.8, H - wall * 0.9, C.dark));
    for (const p of sig) out.push(boxSpan(p.x - pin / 2, p.x + pin / 2, y0 - 0.01, y0 - 0.004, H * 0.35, H * 0.35 + pin, C.tin, { metal: true }));
  } else {
    const wall = s.family === 'jst-sh' ? 0.35 : 0.8;
    out.push(boxSpan(-W / 2 + wall, W / 2 - wall, y0 + wall, y1 - wall, H - 0.002, H + 0.005, C.dark));
    for (const p of sig) out.push(boxSpan(p.x - pin / 2, p.x + pin / 2, p.y - pin / 2, p.y + pin / 2, H + 0.005, H + 0.012, C.tin, { metal: true }));
  }
  for (const p of sig) {
    if (p.kind === 'smd') out.push(boxSpan(p.x - pin / 2, p.x + pin / 2, p.y - p.h / 2 + 0.2, Math.min(p.y + p.h / 2 - 0.2, y1 + 0.5), 0, 0.12, C.tin, { metal: true }));
    else out.push(pinLead(p.x, p.y, BELOW, 0.5, pin));
  }
  for (const p of mps) out.push(boxSpan(p.x - p.w / 2 + 0.1, p.x + p.w / 2 - 0.1, p.y - p.h / 2 + 0.1, p.y + p.h / 2 - 0.1, 0, Math.min(1.2, H * 0.4), C.tin, { metal: true }));
  return out;
}

function usbCBody(s: PackageSpec): BodyPrimitive[] {
  const W = s.bodyW ?? 8.94;
  const L = s.bodyL ?? 7.35;
  const H = s.bodyH ?? 3.26;
  const yc = 2.3 - L / 2;
  const yFront = yc - L / 2;
  const out: BodyPrimitive[] = [box([0, yc, H / 2], [W, L, H], C.shell, { metal: true, radius: Math.min(1.2, H / 2 - 0.05) })];
  out.push(boxSpan(-W / 2 + 0.3, W / 2 - 0.3, yFront - 0.006, yFront + 0.002, 0.3, H - 0.3, C.dark));
  out.push(boxSpan(-3.35, 3.35, yFront - 0.012, yFront - 0.006, H / 2 - 0.35, H / 2 + 0.35, C.tongue));
  for (const sx of [-1, 1]) {
    for (const y of [1.705, -2.475]) out.push(boxSpan(sx * 4.325 - 0.25, sx * 4.325 + 0.25, y - 0.5, y + 0.5, -0.85, 0.6, C.shell, { metal: true }));
  }
  for (let i = 0; i < 12; i++) {
    const x = -2.75 + i * 0.5;
    out.push(boxSpan(x - 0.12, x + 0.12, 2.3, 2.9, 0, 0.1, C.gold, { metal: true }));
  }
  return out;
}

function usbMicroBody(s: PackageSpec): BodyPrimitive[] {
  const W = s.bodyW ?? 8.0;
  const L = s.bodyL ?? 5.6;
  const H = s.bodyH ?? 2.5;
  const yc = -1.3;
  const yFront = yc - L / 2;
  const out: BodyPrimitive[] = [box([0, yc, H / 2], [W, L, H], C.shell, { metal: true, radius: 0.3 })];
  out.push(boxSpan(-W / 2 + 0.55, W / 2 - 0.55, yFront - 0.006, yFront + 0.002, 0.35, H - 0.35, C.dark));
  out.push(boxSpan(-2.4, 2.4, yFront - 0.012, yFront - 0.006, H / 2 - 0.25, H / 2 + 0.1, C.tongue));
  for (let i = 0; i < 5; i++) out.push(boxSpan((i - 2) * 0.65 - 0.12, (i - 2) * 0.65 + 0.12, 1.1, 1.9, 0, 0.1, C.gold, { metal: true }));
  for (const sx of [-1, 1]) {
    out.push(boxSpan(sx * 3.6 - 0.2, sx * 3.6 + 0.2, -1.8, -0.85, -1.0, 0.5, C.shell, { metal: true }));
    out.push(boxSpan(sx * 2.425 - 0.25, sx * 2.425 + 0.25, 1.1, 1.55, -1.0, 0.5, C.shell, { metal: true }));
  }
  return out;
}

/* ------------------------------------------------------------------------------ misc parts */

function crystalSmdBody(s: PackageSpec): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const L = s.bodyW ?? 3.2;
  const W = s.bodyL ?? 2.5;
  const H = s.bodyH ?? 0.75;
  if (s.extra?.variant === 'hc49smd') {
    return [
      boxSpan(-L / 2, L / 2, -W / 2, W / 2, 0, 0.5, C.headerBlack),
      box([0, 0, 0.5 + (H - 0.5) / 2], [L - 0.6, W - 0.4, H - 0.5], C.shell, { metal: true, radius: (W - 0.4) / 2 - 0.05 }),
      ...fp.pads.map((p) => boxSpan(p.x - p.w * 0.35, p.x + p.w * 0.35, p.y - p.h * 0.3, p.y + p.h * 0.3, 0, 0.1, C.tin, { metal: true })),
    ];
  }
  const base = Math.min(0.3, H * 0.4);
  const out: BodyPrimitive[] = [boxSpan(-L / 2, L / 2, -W / 2, W / 2, 0, base, C.crystalBase, { radius: 0.05 })];
  out.push(boxSpan(-L / 2 + 0.12, L / 2 - 0.12, -W / 2 + 0.12, W / 2 - 0.12, base, H, s.extra?.oscillator ? '#cfd3d8' : C.shell, { metal: true, radius: 0.08 }));
  for (const p of fp.pads) {
    const sx = Math.sign(p.x);
    const sy = Math.sign(p.y) || 1;
    out.push(boxSpan(p.x - p.w * 0.35, sx * (L / 2 + 0.005), p.y - p.h * 0.35, sy * Math.min(W / 2 + 0.005, Math.abs(p.y) + p.h * 0.35), 0, 0.06, C.gold, { metal: true }));
  }
  return out;
}

function hc49Body(s: PackageSpec): BodyPrimitive[] {
  const W = s.bodyW ?? 11.05;
  const L = s.bodyL ?? 4.65;
  const H = s.bodyH ?? 3.5;
  const pitch = s.pitch ?? 4.88;
  return [
    boxSpan(-W / 2 - 0.15, W / 2 + 0.15, -L / 2 - 0.15, L / 2 + 0.15, 0, 0.4, C.shell, { metal: true, radius: L / 2 }),
    box([0, 0, 0.4 + H / 2], [W, L, H], C.shell, { metal: true, radius: L / 2 - 0.05 }),
    pinLead(-pitch / 2, 0, BELOW, 0.2, 0.43, C.tin, true),
    pinLead(pitch / 2, 0, BELOW, 0.2, 0.43, C.tin, true),
  ];
}

function elecSmdBody(s: PackageSpec, color: string | undefined): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const D = exNum(s, 'diameter') ?? 6.3;
  const side = s.bodyW ?? D + 0.3;
  const H = s.bodyH ?? 5.4;
  const c = side * 0.25;
  const h = side / 2;
  const plate: Vec2[] = [
    [-h + c, -h],
    [h, -h],
    [h, h],
    [-h + c, h],
    [-h, h - c],
    [-h, -h + c],
  ];
  const out: BodyPrimitive[] = [extrude(plate, 0, 0.5, C.sleeveBlack)];
  out.push(cyl([0, 0, 0.5 + (H - 0.5) / 2], D / 2, H - 0.5, 'z', C.aluminium, { metal: true, segments: 40 }));
  // dark marking on the negative (+X, pin 2) half of the top
  const half: Vec2[] = [];
  for (let i = 0; i <= 20; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / 20;
    half.push([(D / 2 - 0.15) * Math.cos(a), (D / 2 - 0.15) * Math.sin(a)]);
  }
  out.push(extrude(half, H, H + 0.01, color ?? '#1b2a52'));
  out.push(cyl([0, 0, H + 0.006], D * 0.18, 0.012, 'z', '#9aa1a8'));
  for (const p of fp.pads) out.push(boxSpan(p.x - p.w * 0.4, p.x + p.w * 0.4, -0.35, 0.35, 0, 0.12, C.tin, { metal: true }));
  return out;
}

function elecThtBody(s: PackageSpec, color: string | undefined): BodyPrimitive[] {
  const D = exNum(s, 'diameter') ?? s.bodyW ?? 5;
  const H = s.bodyH ?? 11;
  const pitch = s.pitch ?? 2;
  const lead = D <= 6.3 ? 0.5 : D <= 10 ? 0.6 : 0.8;
  const z0 = 0.4;
  return [
    cyl([0, 0, z0 + (H - z0) / 2], D / 2, H - z0, 'z', color ?? C.sleeveBlack, { segments: 40 }),
    cyl([0, 0, H + 0.02], D / 2 - 0.25, 0.05, 'z', C.aluminium, { metal: true, segments: 40 }),
    boxSpan(D / 2 - 0.06, D / 2 + 0.01, -D * 0.18, D * 0.18, z0 + 0.6, H - 0.4, C.stripe),
    pinLead(-pitch / 2, 0, BELOW, z0, lead, C.tin, true),
    pinLead(pitch / 2, 0, BELOW, z0, lead, C.tin, true),
  ];
}

function inductorBody(s: PackageSpec): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const W = s.bodyW ?? 4;
  const L = s.bodyL ?? W;
  const H = s.bodyH ?? 2;
  const out: BodyPrimitive[] = [boxSpan(-W / 2, W / 2, -L / 2, L / 2, 0.02, H, C.inductor, { radius: Math.min(0.4, W * 0.08) })];
  out.push(cyl([0, 0, H + 0.004], Math.min(W, L) * 0.32, 0.008, 'z', '#55575c'));
  for (const p of fp.pads) {
    const sx = Math.sign(p.x);
    out.push(boxSpan(sx * (W / 2 + 0.01), sx * (W / 2 - p.w * 0.6), -p.h * 0.4, p.h * 0.4, 0, Math.min(0.6, H * 0.3), C.tin, { metal: true }));
  }
  return out;
}

function tactBody(s: PackageSpec): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const W = s.bodyW ?? 6;
  const L = s.bodyL ?? W;
  const H = s.bodyH ?? 5;
  const tht = exBool(s, 'smd') === false;
  const baseH = Math.min(3.1, H * 0.62);
  const out: BodyPrimitive[] = [boxSpan(-W / 2, W / 2, -L / 2, L / 2, 0, baseH, C.headerBlack, { radius: 0.15 })];
  out.push(boxSpan(-W / 2, W / 2, -L / 2, L / 2, baseH, baseH + 0.25, C.steel, { metal: true }));
  const rAct = Math.min(W, L) * 0.29;
  out.push(cyl([0, 0, (baseH + 0.25 + H) / 2], rAct, H - baseH - 0.25, 'z', C.headerBlack, { segments: 32 }));
  for (const p of fp.pads) {
    if (tht) out.push(pinLead(p.x, p.y, BELOW, 0.5, 0.7));
    else {
      const sy = Math.sign(p.y);
      out.push(...gullLead(sy > 0 ? '+y' : '-y', sy * (L / 2), p.y + (sy * p.h) / 4, p.x, 0.7, 0.6, 0.2, C.steel));
    }
  }
  return out;
}

function ledThtBody(s: PackageSpec, color: string | undefined): BodyPrimitive[] {
  const d = exNum(s, 'diameter') ?? 5;
  const H = s.bodyH ?? 8.6;
  const pitch = s.pitch ?? 2.54;
  const lens = color ?? '#ff3b30';
  const z0 = 1.0;
  const r = d / 2;
  const out: BodyPrimitive[] = [cyl([0, 0, z0 + 0.5], r + 0.4, 1.0, 'z', lens, { segments: 40 })];
  const cylTop = z0 + H - r;
  out.push(cyl([0, 0, (z0 + 1.0 + cylTop) / 2], r, cylTop - z0 - 1.0, 'z', lens, { segments: 40 }));
  for (let i = 1; i <= 4; i++) {
    const a0 = ((i - 1) / 4) * (Math.PI / 2);
    const a1 = (i / 4) * (Math.PI / 2);
    const zA = cylTop + r * Math.sin(a0);
    const zB = cylTop + r * Math.sin(a1);
    out.push(cyl([0, 0, (zA + zB) / 2], r * Math.cos((a0 + a1) / 2), zB - zA, 'z', lens, { segments: 40 }));
  }
  out.push(pinLead(-pitch / 2, 0, BELOW, z0, 0.5));
  out.push(pinLead(pitch / 2, 0, BELOW, z0, 0.5));
  return out;
}

function terminalBody(s: PackageSpec, color: string | undefined): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const pitch = s.pitch ?? 5.08;
  const W = s.bodyW ?? (s.pins ?? 2) * pitch;
  const D = s.bodyL ?? 8;
  const H = s.bodyH ?? 10;
  const yc = -D / 2 + D * 0.42;
  const out: BodyPrimitive[] = [boxSpan(-W / 2, W / 2, yc - D / 2, yc + D / 2, 0, H, color ?? C.terminalGreen, { radius: 0.2 })];
  for (const p of fp.pads) {
    out.push(cyl([p.x, yc + D * 0.1, H + 0.15], pitch * 0.3, 0.3, 'z', C.steel, { metal: true, segments: 24 }));
    out.push(boxSpan(p.x - pitch * 0.28, p.x + pitch * 0.28, yc + D * 0.1 - 0.15, yc + D * 0.1 + 0.15, H + 0.3, H + 0.31, C.dark));
    out.push(boxSpan(p.x - pitch * 0.3, p.x + pitch * 0.3, yc - D / 2 - 0.006, yc - D / 2 + 0.002, H * 0.2, H * 0.5, C.dark));
    out.push(pinLead(p.x, p.y, BELOW, 0.5, 0.9));
  }
  return out;
}

function batteryBody(s: PackageSpec): BodyPrimitive[] {
  const W = s.bodyW ?? 24;
  const L = s.bodyL ?? 20.5;
  const cell = typeof s.extra?.cell === 'string' ? s.extra.cell : 'CR2032';
  const m = /CR(\d\d)(\d\d)/.exec(cell);
  const d = m ? parseInt(m[1], 10) : 20;
  const th = m ? parseInt(m[2], 10) / 10 : 3.2;
  return [
    boxSpan(-W / 2, W / 2, -L / 2, L / 2, 0, 1.2, C.headerBlack, { radius: 0.5 }),
    cyl([0, 0, 1.0 + th / 2], d / 2, th, 'z', C.aluminium, { metal: true, segments: 48 }),
    boxSpan(-W / 2 - 1.2, W / 2 + 1.2, -2.0, 2.0, 1.0 + th, 1.0 + th + 0.2, C.steel, { metal: true }),
    boxSpan(-W / 2 - 2.7, -W / 2 + 0.3, -2.0, 2.0, 0, 0.2, C.steel, { metal: true }),
    boxSpan(W / 2 - 0.3, W / 2 + 2.7, -2.0, 2.0, 0, 0.2, C.steel, { metal: true }),
  ];
}

function moduleBody(s: PackageSpec): BodyPrimitive[] {
  const fp = generateFootprint(s);
  const W = s.bodyW ?? 18;
  const L = s.bodyL ?? 25.5;
  const H = s.bodyH ?? 3.1;
  const ant = exNum(s, 'antennaTop') ?? 0;
  const pcb = 0.8;
  const out: BodyPrimitive[] = [boxSpan(-W / 2, W / 2, -L / 2, L / 2, 0, pcb, C.pcbBlue)];
  out.push(boxSpan(-W / 2 + 0.8, W / 2 - 0.8, -L / 2 + 0.8, L / 2 - 0.8 - ant, pcb, H, C.shell, { metal: true, radius: 0.2 }));
  if (ant > 0) out.push(boxSpan(-W / 2 + 1.5, W / 2 - 1.5, L / 2 - ant + 0.8, L / 2 - 0.8, pcb, pcb + 0.02, C.gold, { metal: true }));
  for (const p of fp.pads) {
    if (p.pasteRatio !== undefined) continue;
    const horiz = p.w > p.h;
    if (horiz) {
      const sx = Math.sign(p.x);
      out.push(boxSpan(sx * (W / 2 + 0.01), sx * (W / 2 - 0.6), p.y - p.h * 0.35, p.y + p.h * 0.35, 0, pcb + 0.01, C.gold, { metal: true }));
    } else {
      const sy = Math.sign(p.y);
      out.push(boxSpan(p.x - p.w * 0.35, p.x + p.w * 0.35, sy * (L / 2 + 0.01), sy * (L / 2 - 0.6), 0, pcb + 0.01, C.gold, { metal: true }));
    }
  }
  return out;
}
