import { awgOhmPerMeter, interconnectLabel, newId, systemConnectivity, type Conductor, type Interconnect, type PartDef } from '@pcbcad/core';
import { requireBoard, requireComponent } from '../helpers';
import { S, ToolError, type ToolDef } from '../registry';
import { ensurePart } from './parts';

function matchesFamily(spec: PartDef['connector'], other: PartDef['connector'], otherId: string): boolean {
  if (!spec || !other) return false;
  return spec.matesWith.some((m) => {
    const [fam, gender] = m.split(':');
    if (m === otherId) return true;
    if (fam.toLowerCase() !== other.family.toLowerCase()) return false;
    return !gender || gender === other.gender;
  });
}

export const interconnectTools: ToolDef[] = [
  {
    name: 'connect_boards',
    title: 'Connect boards',
    group: 'interconnect',
    description:
      'Create an electrical interconnect between connectors on two boards: "cable" (harness with mating cable housings/crimps + wire; give cableParts from the distributor, e.g. JST PHR-4 housings + SPH-002T crimps + UL1007 wire), "mated" (direct board-to-board mating, e.g. header into socket) or "wires" (wires soldered to pads/holes). Conductors map pins straight (1→1), reversed, or by an explicit list. Validates connector mating, pin counts and net compatibility; system-level circuit simulation then includes wire + contact resistance.',
    inputSchema: S.obj(
      {
        name: S.str(),
        kind: S.enum(['cable', 'mated', 'wires']),
        a: S.obj({ board: S.str('board id or name'), ref: S.str('connector ref, e.g. J2') }, ['board', 'ref']),
        b: S.obj({ board: S.str(), ref: S.str() }, ['board', 'ref']),
        mapping: S.any('"straight" (default), "reversed", or [{"from":"1","to":"1","name":"VBUS","awg":24,"color":"red"}, ...]'),
        length: S.num('Cable length mm (default 100)'),
        awg: S.int('Wire gauge (default 26)'),
        cableParts: S.arr(S.obj({ part: S.str('LCSC/MPN/id'), qty: S.int() }, ['part', 'qty'])),
      },
      ['kind', 'a', 'b'],
    ),
    handler: async (ctx, a: any) => {
      const p = ctx.session.project;
      const ba = requireBoard(p, a.a.board);
      const bb = requireBoard(p, a.b.board);
      if (ba.id === bb.id) throw new ToolError('Both ends are on the same board; use connect for on-board nets.');
      const ca = requireComponent(ba, a.a.ref);
      const cb = requireComponent(bb, a.b.ref);
      const pa = p.parts[ca.partId];
      const pb = p.parts[cb.partId];
      const warnings: string[] = [];
      const cableParts: { partId: string; qty: number }[] = [];
      for (const cp of a.cableParts ?? []) {
        const part = await ensurePart(ctx, cp.part);
        cableParts.push({ partId: part.id, qty: cp.qty });
      }
      if (!pa?.connector) warnings.push(`${ca.ref} (${pa?.mpn}) has no functional connector spec — run configure_connector`);
      if (!pb?.connector) warnings.push(`${cb.ref} (${pb?.mpn}) has no functional connector spec — run configure_connector`);
      if (a.kind === 'mated' && pa?.connector && pb?.connector) {
        if (!matchesFamily(pa.connector, pb.connector, pb.id) && !matchesFamily(pb.connector, pa.connector, pa.id)) warnings.push(`${pa.connector.family} ${pa.connector.gender} does not list ${pb.connector.family} ${pb.connector.gender} as a mate`);
        if (pa.connector.gender === pb.connector.gender && pa.connector.gender !== 'genderless') warnings.push('Both connectors have the same gender');
      }
      if (a.kind === 'cable' && pa?.connector) {
        const ccParts = cableParts.map((c) => ctx.session.project.parts[c.partId]).filter((x) => x?.connector?.role === 'cable');
        for (const [end, spec] of [
          [ca.ref, pa.connector],
          [cb.ref, pb?.connector],
        ] as const) {
          if (spec && !ccParts.some((cp) => matchesFamily(spec, cp!.connector, cp!.id) || matchesFamily(cp!.connector, spec, ''))) {
            warnings.push(`No mating cable housing for ${end} (${spec.family}) in cableParts`);
          }
        }
      }
      const pinsA = (pa?.pins ?? []).map((x) => x.number);
      const pinsB = (pb?.pins ?? []).map((x) => x.number);
      let pairs: { from: string; to: string; name?: string; awg?: number; color?: string }[];
      if (Array.isArray(a.mapping)) pairs = a.mapping.map((m: any) => ({ from: String(m.from), to: String(m.to), name: m.name, awg: m.awg, color: m.color }));
      else {
        const n = Math.min(pinsA.length, pinsB.length);
        const numericA = pinsA.filter((x) => /^\d+$/.test(x)).sort((x, y) => +x - +y);
        const numericB = pinsB.filter((x) => /^\d+$/.test(x)).sort((x, y) => +x - +y);
        const la = numericA.length ? numericA : pinsA;
        const lb = numericB.length ? numericB : pinsB;
        const m = Math.min(la.length, lb.length, n || Infinity);
        pairs = [];
        for (let i = 0; i < m; i++) pairs.push({ from: la[i], to: a.mapping === 'reversed' ? lb[m - 1 - i] : lb[i] });
        // only wire pins that carry a net on at least one side
        pairs = pairs.filter((pr) => ca.pinNets[pr.from] || cb.pinNets[pr.to]);
      }
      if (!pairs.length) throw new ToolError('No conductors to create (no mapped pins carry nets). Connect the connector pins to nets first.');
      const netName = (b: typeof ba, id?: string) => (id ? (b.nets.find((n) => n.id === id)?.name ?? '?') : 'unconnected');
      const conductors: Conductor[] = pairs.map((pr) => {
        const nA = ca.pinNets[pr.from];
        const nB = cb.pinNets[pr.to];
        if (!nA || !nB) warnings.push(`${ca.ref}.${pr.from} (${netName(ba, nA)}) ↔ ${cb.ref}.${pr.to} (${netName(bb, nB)}): one side is not on a net`);
        const clsA = ba.nets.find((n) => n.id === nA)?.class;
        const clsB = bb.nets.find((n) => n.id === nB)?.class;
        if (clsA && clsB && clsA !== clsB && (clsA === 'ground' || clsB === 'ground' || clsA === 'power' || clsB === 'power')) warnings.push(`Net class mismatch on ${pr.from}→${pr.to}: ${clsA} ↔ ${clsB}`);
        return {
          id: newId('cond'),
          name: pr.name ?? netName(ba, nA),
          from: { boardId: ba.id, componentId: ca.id, pin: pr.from },
          to: { boardId: bb.id, componentId: cb.id, pin: pr.to },
          awg: pr.awg,
          color: pr.color,
        };
      });
      const ic: Interconnect = {
        id: newId('ic'),
        name: a.name ?? `${ba.name}:${ca.ref} ↔ ${bb.name}:${cb.ref}`,
        kind: a.kind,
        a: { boardId: ba.id, componentId: ca.id },
        b: { boardId: bb.id, componentId: cb.id },
        conductors,
        cableParts,
        length: a.length ?? (a.kind === 'mated' ? 0 : 100),
        awg: a.awg ?? 26,
      };
      ctx.session.mutate(ctx, 'connect_boards', (pr) => {
        pr.interconnects.push(ic);
        return `Connected ${interconnectLabel(pr, ic)} (${ic.kind}, ${conductors.length} conductors)`;
      });
      const links = systemConnectivity(ctx.session.project).links.filter((l) => l.interconnectId === ic.id);
      const rows = conductors.map((c) => {
        const l = links.find((x) => x.conductorId === c.id);
        return `${ca.ref}.${c.from.pin} (${netName(ba, ca.pinNets[c.from.pin])}) → ${cb.ref}.${c.to.pin} (${netName(bb, cb.pinNets[c.to.pin])})${l ? `: ${(l.resistance * 1000).toFixed(1)} mΩ, ${l.currentRating.toFixed(1)} A max` : ''}`;
      });
      const wireR = ic.kind !== 'mated' ? ` Wire AWG${ic.awg}: ${(awgOhmPerMeter(ic.awg!) * 1000).toFixed(0)} mΩ/m.` : '';
      return `Interconnect ${ic.name} [${ic.id}] created.${wireR}\n${rows.join('\n')}${warnings.length ? `\nWarnings:\n- ${[...new Set(warnings)].join('\n- ')}` : ''}`;
    },
  },
  {
    name: 'remove_interconnect',
    title: 'Remove interconnect',
    group: 'interconnect',
    description: 'Delete an interconnect by id or name.',
    inputSchema: S.obj({ id: S.str() }, ['id']),
    handler: (ctx, a: { id: string }) => {
      const ic = ctx.session.project.interconnects.find((x) => x.id === a.id || x.name === a.id);
      if (!ic) throw new ToolError(`Interconnect ${a.id} not found`);
      ctx.session.mutate(ctx, 'remove_interconnect', (p) => {
        p.interconnects = p.interconnects.filter((x) => x !== ic);
        return `Removed interconnect ${ic.name}`;
      });
      return 'Removed.';
    },
  },
];
