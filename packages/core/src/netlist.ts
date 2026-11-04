import type { Board, ComponentInstance, Interconnect, Net } from './types/board';
import type { PartCategory, PartDef } from './types/part';
import type { Project } from './types/project';
import { awgOhmPerMeter } from './units';

/** Reference-designator prefix for a part category (IEEE 315 / common practice). */
export function refPrefix(category: PartCategory): string {
  switch (category) {
    case 'resistor':
      return 'R';
    case 'capacitor':
    case 'capacitor-polarized':
      return 'C';
    case 'inductor':
      return 'L';
    case 'ferrite':
      return 'FB';
    case 'diode':
    case 'zener':
    case 'schottky':
    case 'tvs':
    case 'led':
      return 'D';
    case 'bjt-npn':
    case 'bjt-pnp':
    case 'mosfet-n':
    case 'mosfet-p':
      return 'Q';
    case 'connector':
    case 'cable':
      return 'J';
    case 'crystal':
    case 'oscillator':
      return 'Y';
    case 'switch':
    case 'button':
      return 'SW';
    case 'relay':
      return 'K';
    case 'fuse':
      return 'F';
    case 'battery':
      return 'BT';
    case 'buzzer':
      return 'BZ';
    case 'testpoint':
      return 'TP';
    case 'antenna':
      return 'AE';
    case 'fastener':
    case 'mechanical':
      return 'H';
    case 'display':
      return 'DS';
    case 'module':
    case 'rf-module':
      return 'M';
    default:
      return 'U';
  }
}

/** Next free reference with the given prefix on a board, e.g. 'R' -> 'R4'. */
export function nextRef(board: Board, prefix: string): string {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const c of board.components) {
    const m = re.exec(c.ref);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${max + 1}`;
}

function normPinName(s: string): string {
  return s
    .trim()
    .toUpperCase()
    .replace(/^[~!/]+/, '')
    .replace(/[{}\s]/g, '');
}

/**
 * Resolve a pin reference (number or name) to pin numbers. A name may match several pins
 * (e.g. 'GND' on a QFN with several ground pins + EP) — all are returned.
 */
export function resolvePins(part: PartDef, pinRef: string): string[] {
  const ref = String(pinRef).trim();
  const byNumber = part.pins.filter((p) => p.number === ref);
  if (byNumber.length) return [byNumber[0].number];
  const n = normPinName(ref);
  const byName = part.pins.filter((p) => normPinName(p.name) === n);
  if (byName.length) return byName.map((p) => p.number);
  const byFunction = part.pins.filter((p) => (p.functions ?? []).some((f) => normPinName(f) === n));
  if (byFunction.length === 1) return [byFunction[0].number];
  // Distributor symbols often pack alternate functions into the name, e.g.
  // "(PCINT19/OC2B/INT1)PD3" or "PC4(ADC4/SDA/PCINT12)": match on name tokens.
  const tokens = (name: string) =>
    name
      .toUpperCase()
      .split(/[()/,\s|]+/)
      .map((t) => t.replace(/^[~!]+/, '').replace(/[#*]+$/, ''))
      .filter(Boolean);
  const byToken = part.pins.filter((p) => tokens(p.name).includes(n));
  if (byToken.length) {
    // prefer the pin whose primary (port) token matches, e.g. 'PD3' over alternates
    const primary = byToken.filter((p) => {
      const t = tokens(p.name);
      return t[0] === n || t[t.length - 1] === n;
    });
    if (primary.length === 1) return [primary[0].number];
    if (byToken.length === 1) return [byToken[0].number];
    return byToken.map((p) => p.number);
  }
  // footprint pads without pin definitions (e.g. mounting tabs)
  if (part.footprint?.pads.some((p) => p.number === ref)) return [ref];
  return [];
}

/** Split "U1.VDD", "U1:3", "U1/PB5" into ref + pin. */
export function parsePinRef(s: string): { ref: string; pin: string } {
  const m = /^\s*([A-Za-z_]+[0-9]*[A-Za-z0-9_]*)\s*[.:/]\s*(.+?)\s*$/.exec(s);
  if (!m) throw new Error(`Bad pin reference '${s}'. Use REF.PIN, e.g. "U1.VDD" or "R3.1".`);
  return { ref: m[1], pin: m[2] };
}

export function findComponent(board: Board, refOrId: string): ComponentInstance | undefined {
  return board.components.find((c) => c.id === refOrId) ?? board.components.find((c) => c.ref.toLowerCase() === refOrId.toLowerCase());
}

export function findNet(board: Board, nameOrId: string): Net | undefined {
  return board.nets.find((n) => n.id === nameOrId) ?? board.nets.find((n) => n.name.toLowerCase() === nameOrId.toLowerCase());
}

export interface NetMember {
  componentId: string;
  ref: string;
  pin: string;
}

/** net id -> member pins. */
export function netMembers(board: Board): Map<string, NetMember[]> {
  const map = new Map<string, NetMember[]>();
  for (const n of board.nets) map.set(n.id, []);
  for (const c of board.components) {
    for (const [pin, netId] of Object.entries(c.pinNets)) {
      if (!map.has(netId)) map.set(netId, []);
      map.get(netId)!.push({ componentId: c.id, ref: c.ref, pin });
    }
  }
  return map;
}

export function guessNetClass(name: string): Net['class'] {
  const n = name.toUpperCase();
  if (/^(GND|AGND|DGND|PGND|VSS|0V|GROUND)\b/.test(n) || n === 'GND') return 'ground';
  if (/^(\+?\d+V\d*|V(CC|DD|BUS|IN|BAT|SYS|OUT|MOT)|3V3|5V|12V|1V8|VBAT|VBUS|VIN|PWR)/.test(n)) return 'power';
  if (/(USB_D[PM+-]|D\+|D-|CLK|ETH|LVDS|HDMI)/.test(n)) return 'high-speed';
  if (/(ADC|AIN|SENSE|VREF)/.test(n)) return 'analog';
  return 'signal';
}

/* ------------------------------------- System (multi-board) ------------------------------------ */

export interface SystemLink {
  interconnectId: string;
  conductorId: string;
  /** board net ids joined by this conductor */
  netA: string;
  netB: string;
  resistance: number;
  /** Rated current of the weakest element (connector contact / wire), A. */
  currentRating: number;
}

export interface SystemConnectivity {
  links: SystemLink[];
  warnings: string[];
}

/** Ampacity of copper wire in a bundle (chassis wiring), rough table (A). */
export function awgAmpacity(awg: number): number {
  const table: Record<number, number> = { 30: 0.5, 28: 0.8, 26: 1.3, 24: 2.1, 22: 3.0, 20: 5.0, 18: 7.0, 16: 10, 14: 15, 12: 20 };
  if (table[awg] != null) return table[awg];
  return Math.max(0.2, 3 * Math.pow(1.26, 22 - awg));
}

/**
 * Electrical links created by interconnects between board nets (used by system-level
 * circuit simulation and interconnect validation).
 */
export function systemConnectivity(project: Project): SystemConnectivity {
  const links: SystemLink[] = [];
  const warnings: string[] = [];
  const boards = new Map(project.boards.map((b) => [b.id, b]));
  for (const ic of project.interconnects) {
    for (const cd of ic.conductors) {
      const ba = boards.get(cd.from.boardId);
      const bb = boards.get(cd.to.boardId);
      const ca = ba?.components.find((c) => c.id === cd.from.componentId);
      const cb = bb?.components.find((c) => c.id === cd.to.componentId);
      if (!ba || !bb || !ca || !cb) {
        warnings.push(`Interconnect ${ic.name}: conductor ${cd.name ?? cd.id} references a missing board/component`);
        continue;
      }
      const netA = ca.pinNets[cd.from.pin];
      const netB = cb.pinNets[cd.to.pin];
      if (!netA || !netB) {
        warnings.push(`Interconnect ${ic.name}: ${ca.ref}.${cd.from.pin} or ${cb.ref}.${cd.to.pin} is not connected to a net`);
        continue;
      }
      const pa = project.parts[ca.partId];
      const pb = project.parts[cb.partId];
      const rcA = pa?.connector?.contactResistance ?? 0.02;
      const rcB = pb?.connector?.contactResistance ?? 0.02;
      const irA = pa?.connector?.currentRating ?? Infinity;
      const irB = pb?.connector?.currentRating ?? Infinity;
      const awg = cd.awg ?? ic.awg ?? 26;
      const lenMm = cd.length ?? ic.length ?? 100;
      let r = 0;
      let rating = Math.min(irA, irB);
      if (ic.kind === 'cable') {
        r = rcA + rcB + awgOhmPerMeter(awg) * (lenMm / 1000);
        rating = Math.min(rating, awgAmpacity(awg));
      } else if (ic.kind === 'mated') {
        r = Math.max(rcA, rcB);
      } else {
        r = awgOhmPerMeter(awg) * (lenMm / 1000) + 0.002;
        rating = Math.min(awgAmpacity(awg), rating === Infinity ? awgAmpacity(awg) : rating);
      }
      links.push({ interconnectId: ic.id, conductorId: cd.id, netA, netB, resistance: r, currentRating: Number.isFinite(rating) ? rating : 3 });
    }
  }
  return { links, warnings };
}

export function interconnectLabel(project: Project, ic: Interconnect): string {
  const ba = project.boards.find((b) => b.id === ic.a.boardId);
  const bb = project.boards.find((b) => b.id === ic.b.boardId);
  const ca = ba?.components.find((c) => c.id === ic.a.componentId);
  const cb = bb?.components.find((c) => c.id === ic.b.componentId);
  return `${ba?.name ?? '?'}:${ca?.ref ?? '?'} ↔ ${bb?.name ?? '?'}:${cb?.ref ?? '?'}`;
}
