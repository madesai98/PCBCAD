import { getMaterial, interconnectLabel, newId, nowIso, type DesignIssue, type Project } from '@pcbcad/core';
import { buildBom } from '../bom';
import { boardSize } from '../helpers';
import { S, type ToolDef } from '../registry';

function routedPct(p: Project, boardId: string): string {
  const unrouted = p.issues.filter((i) => i.code === 'unrouted' && i.target?.boardId === boardId).length;
  return unrouted ? `${unrouted} unrouted connection(s)` : 'routing: no unrouted issues recorded';
}

export function overviewText(p: Project): string {
  const lines: string[] = [];
  lines.push(`Project "${p.name}" (rev ${p.revision})${p.description ? ` — ${p.description}` : ''}`);
  if (p.requirements.length) lines.push(`Requirements:\n${p.requirements.map((r) => `  • ${r}`).join('\n')}`);
  lines.push(`Boards (${p.boards.length}):`);
  for (const b of p.boards) {
    const { w, h } = boardSize(b);
    const placed = b.components.filter((c) => c.placed).length;
    lines.push(
      `  - ${b.name} [${b.id}] ${w.toFixed(1)}×${h.toFixed(1)} mm, ${b.stackup.layers}L ${b.stackup.thickness} mm, ${b.components.length} components (${placed} placed), ${b.nets.length} nets, ${b.traces.length} traces, ${b.vias.length} vias, ${b.zones.length} zones, ${b.holes.length} holes; ${routedPct(p, b.id)}`,
    );
    if (b.components.length) lines.push(`    refs: ${b.components.map((c) => `${c.ref}=${p.parts[c.partId]?.mpn ?? c.partId}${c.value ? `(${c.value})` : ''}`).join(', ')}`);
  }
  if (p.interconnects.length) {
    lines.push(`Interconnects (${p.interconnects.length}):`);
    for (const ic of p.interconnects) lines.push(`  - ${ic.name} [${ic.id}] ${ic.kind}: ${interconnectLabel(p, ic)}, ${ic.conductors.length} conductors${ic.length ? `, ${ic.length} mm` : ''}${ic.awg ? ` AWG${ic.awg}` : ''}`);
  }
  const bom = buildBom(p);
  const needs = Object.values(p.parts).filter((pt) => pt.provenance.footprint === 'missing' || pt.pins.length === 0 || pt.provenance.sim === 'missing');
  lines.push(
    `Parts library: ${Object.keys(p.parts).length} parts; BOM ≈ $${bom.total.toFixed(2)}/unit @ ${p.settings.buildQuantity} pcs${bom.unpriced ? ` (${bom.unpriced} lines unpriced)` : ''}` +
      (needs.length ? `; needing attention: ${needs.map((n) => n.id).join(', ')}` : ''),
  );
  if (p.mechanical.length) {
    lines.push(`Mechanical (${p.mechanical.length}):`);
    for (const m of p.mechanical) {
      const mat = getMaterial(m.materialId)?.name ?? m.materialId;
      let d = '';
      if (m.kind === 'enclosure-shell') d = `${m.role} shell ${m.outer.width}×${m.outer.depth}×${m.outer.height} mm, wall ${m.wall}, draft ${m.draftDeg}°, ${m.bosses.length} bosses, ${m.ribs.length} ribs, ${m.cutouts.length} cutouts, ${m.vents.length} vents, ${m.snaps.length} snaps`;
      else if (m.kind === 'sheet-metal') d = `sheet ${m.thickness} mm, base ${m.base.width}×${m.base.length}, ${m.flanges.length} flanges, ${m.holes.length} holes`;
      else if (m.kind === 'custom') d = 'custom CSG';
      else d = `purchased ${m.partId}`;
      lines.push(`  - ${m.name} [${m.id}] ${mat}, ${m.process}: ${d}`);
    }
  }
  lines.push(`Assembly: ${p.assembly.instances.length} instances, ${p.assembly.fasteners.length} fasteners`);
  if (p.firmware.length) lines.push(`Firmware: ${p.firmware.map((f) => `${f.name} [${f.id}] ${f.format} ${f.size} B${f.target ? ` (${f.target})` : ''}`).join(', ')}`);
  if (p.behaviors.length) lines.push(`Behaviour scripts: ${p.behaviors.map((b) => `${b.name} [${b.id}] ${b.kind}`).join(', ')}`);
  const latest = new Map<string, (typeof p.simulations)[number]>();
  for (const s of p.simulations) latest.set(s.kind, s);
  if (latest.size) {
    lines.push('Latest simulations:');
    for (const s of latest.values()) lines.push(`  - ${s.kind} [${s.id}] ${s.status}${s.summary ? `: ${s.summary.headline}${s.summary.pass === false ? ' ✗' : s.summary.pass ? ' ✓' : ''}` : s.error ? `: ${s.error}` : ''}`);
  }
  const counts = countIssues(p.issues);
  lines.push(`Issues: ${counts.errors} errors, ${counts.warnings} warnings${counts.byCat ? ` (${counts.byCat})` : ''}${p.issues.length ? ' — call get_issues for details' : ''}`);
  if (p.notes.length) lines.push(`Design notes: ${p.notes.length} (latest: ${p.notes[p.notes.length - 1].title})`);
  return lines.join('\n');
}

function countIssues(issues: DesignIssue[]) {
  const by = new Map<string, number>();
  for (const i of issues) by.set(i.category, (by.get(i.category) ?? 0) + 1);
  return {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    byCat: [...by.entries()].map(([k, v]) => `${k} ${v}`).join(', '),
  };
}

/** Replace the issues of the given categories (optionally scoped to a board / part). */
export function setIssues(p: Project, categories: DesignIssue['category'][], issues: DesignIssue[], scope?: { boardId?: string; partId?: string }) {
  p.issues = p.issues.filter((i) => {
    if (!categories.includes(i.category)) return true;
    if (scope?.boardId && i.target?.boardId && i.target.boardId !== scope.boardId) return true;
    if (scope?.partId && i.target?.partId !== scope.partId) return true;
    return false;
  });
  p.issues.push(...issues.map((i) => ({ ...i, id: i.id || newId('iss') })));
}

export function formatIssues(issues: DesignIssue[], max = 40): string {
  if (!issues.length) return 'No issues.';
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : b.severity === 'error' ? 1 : a.severity === 'warning' ? -1 : 1));
  const lines = sorted.slice(0, max).map((i) => {
    const at = i.at ? ` @(${i.at.map((v) => v.toFixed(2)).join(',')})` : '';
    return `[${i.severity}] ${i.category}/${i.code}: ${i.message}${at}${i.suggestion ? ` → ${i.suggestion}` : ''}`;
  });
  if (sorted.length > max) lines.push(`… ${sorted.length - max} more`);
  return lines.join('\n');
}

export const projectTools: ToolDef[] = [
  {
    name: 'get_design_overview',
    title: 'Design overview',
    group: 'project',
    description:
      'Summarise the whole product design: boards (size, stack-up, components, nets, routing), interconnects, parts library and BOM cost, mechanical parts, assembly, firmware, latest simulation results and open issues. Call this first and whenever you need to re-orient.',
    inputSchema: S.obj({}),
    handler: (ctx) => ({ text: overviewText(ctx.session.project) }),
  },
  {
    name: 'set_project_info',
    title: 'Set project info',
    group: 'project',
    description: 'Set the product name, description and/or requirement list (requirements replace the existing list). Also sets build quantity and ambient temperature used for costing/simulation.',
    inputSchema: S.obj({
      name: S.str(),
      description: S.str(),
      requirements: S.arr(S.str(), 'Product requirements, one per line (electrical, mechanical, environmental, cost).'),
      buildQuantity: S.int('Production quantity for BOM pricing'),
      ambientC: S.num('Ambient temperature for simulations (°C)'),
    }),
    handler: (ctx, a: { name?: string; description?: string; requirements?: string[]; buildQuantity?: number; ambientC?: number }) => {
      ctx.session.mutate(ctx, 'set_project_info', (p) => {
        if (a.name) p.name = a.name;
        if (a.description != null) p.description = a.description;
        if (a.requirements) p.requirements = a.requirements;
        if (a.buildQuantity) p.settings.buildQuantity = a.buildQuantity;
        if (a.ambientC != null) p.settings.ambientC = a.ambientC;
        return `Updated project info${a.requirements ? ` (${a.requirements.length} requirements)` : ''}`;
      });
      return 'Project info updated.';
    },
  },
  {
    name: 'add_design_note',
    title: 'Add design note',
    group: 'project',
    description: 'Record a design decision or rationale for the human reviewer (shown in the Overview timeline). Use for part choices, trade-offs, assumptions, and open questions.',
    inputSchema: S.obj({ title: S.str('Short title'), text: S.str('Explanation (markdown ok)'), tags: S.arr(S.str()) }, ['title', 'text']),
    handler: (ctx, a: { title: string; text: string; tags?: string[] }) => {
      ctx.session.mutate(ctx, 'add_design_note', (p) => {
        p.notes.push({ id: newId('note'), at: nowIso(), author: ctx.actor === 'user' ? 'user' : 'agent', title: a.title, text: a.text, tags: a.tags });
        return `Note: ${a.title}`;
      });
      return 'Note added.';
    },
  },
  {
    name: 'get_issues',
    title: 'List issues',
    group: 'project',
    description: 'List current design issues from the latest DRC/ERC/DFM/assembly/simulation checks, optionally filtered.',
    inputSchema: S.obj({ category: S.enum(['drc', 'erc', 'dfm', 'assembly', 'sim', 'part', 'interconnect']), boardId: S.str(), severity: S.enum(['error', 'warning', 'info']) }),
    handler: (ctx, a: { category?: string; boardId?: string; severity?: string }) => {
      const issues = ctx.session.project.issues.filter(
        (i) => (!a.category || i.category === a.category) && (!a.boardId || i.target?.boardId === a.boardId) && (!a.severity || i.severity === a.severity),
      );
      return formatIssues(issues, 80);
    },
  },
];
