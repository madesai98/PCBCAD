/**
 * Injection-molding DFM rules (category 'dfm'). Rules and sources are listed in README.md.
 * Material limits come from Material.molding (minWall, nominalWall, maxWall, minDraft, ribRatio,
 * flowRatio, shrinkage).
 */
import type { CsgNode, CustomPart, DesignIssue, EnclosureShell, Material, ShellFace, Vec3 } from '@pcbcad/core';
import { getMaterial } from '@pcbcad/core';
import { sdRoundRect, segDist } from './poly';
import { bossGeom, cutoutExtents, pocketAt, shellGeom, snapCatchExtents, snapHookHeight, validateShell, ventExtents, type ShellGeom } from './shell';
import { fastenerResolver } from './parts';
import type { Project } from '@pcbcad/core';

type Sev = DesignIssue['severity'];

class Issues {
  list: DesignIssue[] = [];
  private seen = new Map<string, number>();
  constructor(private partId: string, private prefix = 'dfm') {}
  add(code: string, severity: Sev, message: string, suggestion?: string, at?: Vec3, key?: string): void {
    const base = `${this.prefix}:${this.partId}:${code}${key ? ':' + key : ''}`;
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);
    this.list.push({ id: n ? `${base}:${n}` : base, severity, category: 'dfm', code, message, target: { partId: this.partId }, ...(at ? { at } : {}), ...(suggestion ? { suggestion } : {}) });
  }
}

/**
 * Texture depth (mm) for a texture spec: number (mm) or a code. Mold-Tech MT-11000…11030 from the
 * Mold-Tech depth table, SPI A/B polished = 0, SPI C ≈ 0.005, SPI D1–D3 ≈ 0.010–0.025, VDI 3400 grade n:
 * ≈ 10·Ra with Ra = 0.1·10^(n/20) µm. Unknown codes assume 0.0375 mm (middle of 0.025–0.05).
 */
export function textureDepthMm(texture: unknown): number {
  if (typeof texture === 'number' && Number.isFinite(texture)) return Math.max(0, texture);
  if (typeof texture !== 'string' || !texture.trim()) return 0;
  const t = texture.trim().toUpperCase();
  if (/^(SPI[- ]?)?[AB][123]$|POLISH|GLOSS/.test(t)) return 0;
  if (/^(SPI[- ]?)?C[123]$/.test(t)) return 0.005;
  const d = /^(?:SPI[- ]?)?D([123])$/.exec(t);
  if (d) return [0.01, 0.015, 0.025][Number(d[1]) - 1];
  const mt: Record<string, number> = { 'MT-11000': 0.0102, 'MT-11010': 0.0254, 'MT-11020': 0.0381, 'MT-11030': 0.0508, 'MT-11040': 0.0635, 'MT-11050': 0.0889 };
  const key = t.replace(/^MT\s*/, 'MT-').replace(/^MT--/, 'MT-');
  if (mt[key] != null) return mt[key];
  const vdi = /^VDI[- ]?(\d{1,2})$/.exec(t);
  if (vdi) return (10 * 0.1 * Math.pow(10, Number(vdi[1]) / 20)) / 1000;
  return 0.0375;
}

/** Required draft (deg) = material minimum + 1° per 0.025 mm of texture depth. */
export function requiredDraftDeg(mat: Material | undefined, texture: unknown): number {
  return (mat?.molding?.minDraft ?? 1) + textureDepthMm(texture) / 0.025;
}

/**
 * Allowable short-term snap-fit strain (fraction). Heuristic ≈ 0.5 × strain at yield per resin
 * family (values in line with Bayer/Covestro and BASF snap-fit guides: ABS 2.5 %, PC 4 %, PC/ABS
 * 2.5 %, PA66 dry ≈ 4 %, POM 6 %, PP 6 %, glass-filled 1–1.5 %). Unknown materials: 0.25 × elongation
 * at break, clamped to 0.8–6 %.
 */
export function allowableSnapStrain(mat: Material | undefined): number {
  const table: Record<string, number> = { abs: 0.025, pc: 0.04, 'pc-abs': 0.025, asa: 0.025, 'pa66-gf30': 0.015, 'pbt-gf30': 0.0125, pp: 0.06, pom: 0.06, 'nylon-66': 0.04, 'tpu-90a': 0.3 };
  if (mat && table[mat.id] != null) return table[mat.id];
  const e = mat?.elongation ?? 10;
  return Math.max(0.008, Math.min(0.06, (0.25 * e) / 100));
}

/** Snap-fit cantilever (constant rectangular section) max strain ε = 1.5·t·y / L². */
export function snapStrain(thickness: number, deflection: number, length: number): number {
  return length > 0 ? (1.5 * thickness * deflection) / (length * length) : Infinity;
}

const fmt = (v: number, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toString();

function faceHalfLen(g: ShellGeom, face: ShellFace): number {
  return face === '+x' || face === '-x' ? g.D / 2 : g.W / 2;
}

function checkShell(s: EnclosureShell, I: Issues, project?: Project): void {
  const errs = validateShell(s);
  if (errs.length) {
    for (const e of errs) I.add('invalid-geometry', 'error', `Shell '${s.name}': ${e}`, 'Fix the shell dimensions before any other DFM review.');
    return;
  }
  const g = shellGeom(s);
  const mat = getMaterial(s.materialId);
  const mold = mat?.molding;
  if (!mat) I.add('material', 'error', `Unknown material '${s.materialId}'`, 'Use a material id from the materials library (e.g. pc-abs, abs, pc).');
  else if (!mold || !mat.processes.includes('injection-molding'))
    I.add('material-process', 'error', `${mat.name} is not an injection-molding resin`, 'Choose a moldable resin such as PC/ABS, ABS, PC or PA66-GF30.');
  if (s.process !== 'injection-molding') I.add('process', 'info', `Process is '${s.process}'; these checks assume injection molding`);
  const minWall = mold?.minWall ?? 1.0;
  const maxWall = mold?.maxWall ?? 4.0;
  const nominal = mold?.nominalWall ?? 2.0;
  const t = g.t;

  // walls
  if (t < minWall) I.add('min-wall', 'error', `Wall ${fmt(t)} mm is below the ${mat?.name ?? 'resin'} minimum of ${minWall} mm — short shots and weak walls`, `Increase wall to ≥ ${minWall} mm (nominal ${nominal} mm).`);
  else if (t > maxWall) I.add('max-wall', 'warning', `Wall ${fmt(t)} mm exceeds the ${maxWall} mm maximum — sink marks, voids and long cooling`, `Reduce wall to ≤ ${maxWall} mm and add ribs for stiffness.`);
  else if (Math.abs(t - nominal) > 0.35 * nominal) I.add('nominal-wall', 'info', `Wall ${fmt(t)} mm is far from the ${nominal} mm nominal for ${mat?.name}`, `Consider ${nominal} mm.`);

  // draft
  const tex = s.processOptions?.textureDepth ?? s.processOptions?.texture;
  const req = requiredDraftDeg(mat, tex);
  if (!(s.draftDeg > 0)) I.add('draft', 'error', `No draft on walls — the part will drag and stick on ejection`, `Set draftDeg ≥ ${fmt(req, 1)}°${tex ? ` (texture ${tex})` : ''}.`);
  else if (s.draftDeg + 1e-9 < req)
    I.add('draft', 'warning', `Draft ${fmt(s.draftDeg, 2)}° is below the required ${fmt(req, 2)}°${tex ? ` for texture ${tex} (≈${fmt(textureDepthMm(tex), 3)} mm deep, +1° per 0.025 mm)` : ` (minimum for ${mat?.name})`}`, `Increase draftDeg to ≥ ${fmt(req, 1)}°.`);
  if (s.processOptions?.draftGeometry === false) I.add('draft-geometry', 'info', 'Draft is not applied to the generated geometry (processOptions.draftGeometry = false)');

  // corners
  const ri = g.R - t;
  if (ri < 0.5 * t)
    I.add('corner-radius', 'warning', `Inside corner radius ${fmt(Math.max(0, ri))} mm (cornerRadius − wall) is below 0.5 × wall = ${fmt(0.5 * t)} mm — stress concentration and poor flow`, `Use cornerRadius ≥ ${fmt(1.5 * t, 1)} mm (inner ≥ 0.5·wall; outer = inner + wall keeps the wall uniform).`);
  if (g.fillet < 0.5 * t) I.add('floor-fillet', 'info', `Floor-to-wall inside edge radius ${fmt(g.fillet)} mm (< 0.5 × wall)`, `Set processOptions.innerFillet ≥ ${fmt(0.5 * t, 1)} mm.`);

  // lip / groove
  if (s.lip) {
    const rem = t - s.lip.thickness;
    if (s.lip.thickness <= 0 || s.lip.height <= 0) I.add('lip', 'warning', 'Lip/groove has non-positive dimensions and is ignored');
    else if (rem < minWall)
      I.add(s.lip.kind === 'lip' ? 'lip-wall' : 'groove-wall', 'warning', `${s.lip.kind === 'lip' ? 'Lip' : 'Groove'} ${fmt(s.lip.thickness)} mm leaves ${fmt(rem)} mm of wall beside it (< ${minWall} mm)`, `Keep ${s.lip.kind} thickness ≤ ${fmt(t - minWall)} mm (≈ 0.4–0.5 × wall).`);
    if (s.lip.kind === 'lip' && s.lip.thickness < 0.6) I.add('lip-thin', 'warning', `Lip ${fmt(s.lip.thickness)} mm thick is hard to fill`, 'Use ≥ 0.6 mm (typically 0.4–0.5 × wall).');
  }

  // ribs
  const ribRatio = mold?.ribRatio ?? 0.6;
  for (const r of s.ribs ?? []) {
    if (r.thickness > ribRatio * t + 1e-9)
      I.add('rib-thickness', 'warning', `Rib ${r.id}: ${fmt(r.thickness)} mm thick > ${ribRatio} × wall (${fmt(ribRatio * t)} mm) — sink marks opposite the rib`, `Reduce to ≤ ${fmt(ribRatio * t)} mm (use more/taller ribs instead).`, [(r.from[0] + r.to[0]) / 2, (r.from[1] + r.to[1]) / 2, t], r.id);
    else if (r.thickness < Math.max(0.5, 0.4 * t)) I.add('rib-thin', 'warning', `Rib ${r.id}: ${fmt(r.thickness)} mm is too thin to fill reliably`, `Use ≥ ${fmt(Math.max(0.5, 0.4 * t))} mm.`, undefined, r.id);
    if (r.height > 3 * t) I.add('rib-height', 'warning', `Rib ${r.id}: height ${fmt(r.height)} mm > 3 × wall (${fmt(3 * t)} mm) — fill, venting and ejection problems`, `Limit to ${fmt(3 * t)} mm or split into two lower ribs.`, undefined, r.id);
  }
  const ribs = s.ribs ?? [];
  for (let i = 0; i < ribs.length; i++)
    for (let j = i + 1; j < ribs.length; j++) {
      const a = ribs[i], b = ribs[j];
      const da: [number, number] = [a.to[0] - a.from[0], a.to[1] - a.from[1]];
      const db: [number, number] = [b.to[0] - b.from[0], b.to[1] - b.from[1]];
      const la = Math.hypot(...da), lb = Math.hypot(...db);
      if (!la || !lb) continue;
      const cos = Math.abs((da[0] * db[0] + da[1] * db[1]) / (la * lb));
      if (cos < Math.cos((15 * Math.PI) / 180)) continue; // crossing ribs form junctions, not spacing
      const dist = Math.min(segDist(a.from[0], a.from[1], b.from[0], b.from[1], b.to[0], b.to[1]), segDist(a.to[0], a.to[1], b.from[0], b.from[1], b.to[0], b.to[1]), segDist(b.from[0], b.from[1], a.from[0], a.from[1], a.to[0], a.to[1]), segDist(b.to[0], b.to[1], a.from[0], a.from[1], a.to[0], a.to[1]));
      if (dist < 2 * t) I.add('rib-spacing', 'warning', `Ribs ${a.id} and ${b.id} are ${fmt(dist)} mm apart (< 2 × wall = ${fmt(2 * t)} mm) — thin steel between them overheats`, `Space parallel ribs ≥ ${fmt(2 * t)} mm (centre to centre).`, undefined, `${a.id}-${b.id}`);
    }

  // bosses
  const spec = fastenerResolver(project);
  for (const b of s.bosses ?? []) {
    const bg = bossGeom(g, b, b.fastenerPartId ? spec(b.fastenerPartId) : undefined);
    const at: Vec3 = [b.x, b.y, t];
    if (!bg) {
      I.add('boss-invalid', 'error', `Boss ${b.id} has non-positive outer diameter or height`, undefined, at, b.id);
      continue;
    }
    for (const n of bg.notes) I.add('boss-geometry', 'warning', `Boss ${b.id}: ${n}`, 'Enlarge the boss OD or use a smaller fastener head.', at, b.id);
    const pocket = pocketAt(g, t + 0.01);
    const dWall = -sdRoundRect(b.x, b.y, pocket.hx, pocket.hy, pocket.r);
    if (dWall < 0) I.add('boss-outside', 'error', `Boss ${b.id} centre is outside the inner pocket`, 'Move it inside the enclosure.', at, b.id);
    else if (dWall < bg.od / 2 + 0.25 * t)
      I.add('boss-wall-merge', 'warning', `Boss ${b.id} merges into the side wall (centre ${fmt(dWall)} mm from the wall, OD ${fmt(bg.od)}) — thick section, sink and voids`, `Move it ≥ ${fmt(bg.od / 2 + 0.5 * t)} mm from the wall and connect with a rib (≤ ${fmt(ribRatio * t)} mm).`, at, b.id);
    if ((b.kind === 'screw' || b.kind === 'insert') && bg.hole > 0) {
      const ratio = bg.od / bg.hole;
      if (ratio < 2.0) I.add('boss-od', 'warning', `Boss ${b.id}: OD/hole = ${fmt(ratio)} (< 2.0) — boss may crack from hoop stress (${b.kind === 'insert' ? 'insert installation' : 'thread forming'})`, `Use OD ≈ 2–2.5 × hole = ${fmt(2 * bg.hole, 1)}–${fmt(2.5 * bg.hole, 1)} mm.`, at, b.id);
      else if (ratio > 2.6) I.add('boss-od', 'info', `Boss ${b.id}: OD/hole = ${fmt(ratio)} (> 2.5) — unnecessarily thick boss`, `Reduce OD to ≈ ${fmt(2.2 * bg.hole, 1)} mm or core it out.`, at, b.id);
    }
    if (bg.hole > 0) {
      const bw = (bg.od - bg.hole) / 2;
      if (bw > 1.25 * t) I.add('boss-sink', 'warning', `Boss ${b.id}: wall ${fmt(bw)} mm > 1.25 × nominal wall — sink mark on the outer surface and voids`, `Keep boss wall ≤ 0.6–0.75 × wall (${fmt(0.75 * t)} mm) where cosmetic, or core the base of the boss.`, at, b.id);
      else if (bw > 0.75 * t) I.add('boss-sink', 'info', `Boss ${b.id}: wall ${fmt(bw)} mm > 0.75 × nominal wall — possible sink opposite the boss`, `Acceptable on non-cosmetic faces; otherwise thin the boss wall toward ${fmt(0.75 * t)} mm or use a sink-hiding texture.`, at, b.id);
    } else if (bg.od > 1.5 * t) I.add('boss-solid', 'warning', `Boss ${b.id} is solid (no hole) with Ø${fmt(bg.od)} mm — thick section`, 'Core it out (hole) or reduce its diameter.', at, b.id);
    const hgt = bg.z1 - bg.z0;
    if (hgt > 3 * bg.od && bg.gussets === 0) I.add('boss-height', 'warning', `Boss ${b.id}: height ${fmt(hgt)} mm > 3 × OD without gussets — may bend, short-shot or stick`, `Add 3–4 gussets (gussets: 4) or reduce the height.`, at, b.id);
  }

  // cutouts, vents, catches by face
  type Feat = { id: string; kind: 'cutout' | 'vent' | 'catch'; face: ShellFace; u0: number; u1: number; v0: number; v1: number };
  const feats: Feat[] = [];
  for (const c of s.cutouts ?? []) feats.push({ id: c.id, kind: 'cutout', face: c.face, ...cutoutExtents(c) });
  for (const v of s.vents ?? []) {
    feats.push({ id: v.id, kind: 'vent', face: v.face, ...ventExtents(v) });
    if (v.pitch - v.slotWidth < t - 1e-9)
      I.add('vent-web', 'warning', `Vent ${v.id}: web between slots ${fmt(v.pitch - v.slotWidth)} mm < wall (${fmt(t)} mm) — thin steel blades in the tool, flow hesitation`, `Use pitch ≥ slotWidth + wall = ${fmt(v.slotWidth + t)} mm.`, undefined, v.id);
    if (v.slotWidth < 1.0) I.add('vent-slot', 'info', `Vent ${v.id}: ${fmt(v.slotWidth)} mm slots need fragile core pins`, 'Prefer ≥ 1.0 mm slots.', undefined, v.id);
  }
  for (const sn of s.snaps ?? []) if (sn.kind === 'catch') feats.push({ id: sn.id, kind: 'catch', face: sn.face, ...snapCatchExtents(sn, g.H) });
  const byFace = new Map<ShellFace, Feat[]>();
  for (const f of feats) byFace.set(f.face, [...(byFace.get(f.face) ?? []), f]);
  for (const [face, list] of byFace) {
    const needSlide: string[] = [];
    for (const f of list) {
      const what = `${f.kind === 'cutout' ? 'Cutout' : f.kind === 'vent' ? 'Vent' : 'Snap window'} ${f.id} (${face})`;
      if (face === 'floor') {
        const p = pocketAt(g, t);
        const gap = Math.min(p.hx - Math.max(Math.abs(f.u0), Math.abs(f.u1)), p.hy - Math.max(Math.abs(f.v0), Math.abs(f.v1)));
        if (gap < t) I.add('cutout-edge', 'warning', `${what} is ${fmt(gap)} mm from the side wall (< 1 × wall)`, `Keep ≥ ${fmt(t)} mm of floor between openings and walls.`, undefined, f.id);
        continue;
      }
      const half = faceHalfLen(g, face);
      const straight = half - Math.max(g.R, t);
      const uMax = Math.max(Math.abs(f.u0), Math.abs(f.u1));
      if (uMax > straight + 1e-6) I.add('cutout-corner', 'warning', `${what} extends ${fmt(uMax - straight)} mm into the rounded corner`, `Keep it within |u| ≤ ${fmt(straight - t)} mm (≥ 1 × wall from the corner radius).`, undefined, f.id);
      else if (straight - uMax < t) I.add('cutout-edge', 'warning', `${what} is ${fmt(straight - uMax)} mm from the corner (< 1 × wall)`, `Keep ≥ ${fmt(t)} mm from the corner radius.`, undefined, f.id);
      if (f.v0 < 2 * t) I.add('cutout-edge', 'warning', `${what} is ${fmt(f.v0 - t)} mm above the inner floor (< 1 × wall)`, `Raise it so its bottom edge is ≥ ${fmt(2 * t)} mm above the outer floor.`, undefined, f.id);
      const openToRim = f.v1 >= g.H - 1e-6;
      if (!openToRim && g.H - f.v1 < t) I.add('cutout-edge', 'warning', `${what} leaves only ${fmt(g.H - f.v1)} mm of wall below the rim`, 'Extend it through the rim (open notch, no side action) or keep ≥ 1 × wall of rim above it.', undefined, f.id);
      if (!openToRim) needSlide.push(`${f.kind} ${f.id}`);
    }
    // spacing between features on the same face
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const gu = Math.max(a.u0 - b.u1, b.u0 - a.u1);
        const gv = Math.max(a.v0 - b.v1, b.v0 - a.v1);
        const gap = Math.max(gu, gv);
        if (gap < t) I.add('cutout-spacing', 'warning', `${a.id} and ${b.id} on face ${face} are ${fmt(Math.max(0, gap))} mm apart${gap < 0 ? ' (overlapping)' : ''} (< 1 × wall)`, `Separate openings by ≥ ${fmt(t)} mm or merge them.`, undefined, `${a.id}-${b.id}`);
      }
    if (needSlide.length && face !== 'floor')
      I.add('side-action', 'warning', `Face ${face}: ${needSlide.join(', ')} are closed openings in a side wall — undercuts that need a side action (slide)`, `Each slide adds ≈ $1.5k–5k tooling and ~10–20 % cycle time. Alternatives: extend cutouts through the rim (open to the parting line → shut-off, no slide), move vents to the floor/top, or accept the slide cost.`, undefined, face);
  }

  // snaps
  const eAllow = allowableSnapStrain(mat);
  for (const sn of s.snaps ?? []) {
    if (sn.kind !== 'hook') continue;
    const eps = snapStrain(sn.thickness, sn.overhang, sn.length);
    if (eps > eAllow)
      I.add('snap-strain', 'warning', `Snap ${sn.id}: bending strain ε = 1.5·t·y/L² = ${fmt(eps * 100, 1)} % exceeds the allowable ${fmt(eAllow * 100, 1)} % for ${mat?.name ?? 'the resin'} — the hook will yield or crack`, `Lengthen the beam to ≥ ${fmt(Math.sqrt((1.5 * sn.thickness * sn.overhang) / eAllow), 1)} mm, thin it, reduce the overhang, or taper the beam.`, undefined, sn.id);
    I.add('snap-undercut', 'info', `Snap hook ${sn.id} (hook height ${fmt(snapHookHeight(sn))} mm) is an undercut`, 'Mold it with a lifter, or open a pass-through window in the floor/rim below the hook so the core forms it directly.', undefined, sn.id);
  }

  // flow length
  if (mold) {
    const gate = String(s.processOptions?.gate ?? 'center');
    const gates = Math.max(1, Number(s.processOptions?.gates ?? 1) || 1);
    const path = gate === 'edge' ? Math.hypot(g.W, g.D / 2) + g.H : Math.hypot(g.W / 2, g.D / 2) + g.H;
    const ratio = path / Math.sqrt(gates) / t;
    if (ratio > mold.flowRatio) I.add('flow-length', 'warning', `Flow length/wall ≈ ${fmt(ratio, 0)} exceeds ~${mold.flowRatio} for ${mat?.name} (${gate} gate${gates > 1 ? ` ×${gates}` : ''}) — short-shot risk`, `Thicken the wall, add gates (processOptions.gates) or use a higher-flow grade.`);
    else if (ratio > 0.8 * mold.flowRatio) I.add('flow-length', 'info', `Flow length/wall ≈ ${fmt(ratio, 0)} is close to the ~${mold.flowRatio} limit for ${mat?.name}`);
    const sh = mold.shrinkage;
    I.add('shrinkage', 'info', `${mat?.name} shrinks ≈ ${sh} % — ${fmt(g.W)} mm becomes ≈ ${fmt(g.W * (1 - sh / 100))} mm; tool steel is cut oversize by the molder`, 'Mold mating halves in the same resin and give tolerance-critical mates (lip/groove, snaps) ≥ 0.1 mm clearance.');
  }
}

/* --------------------------------------------- custom ------------------------------------------- */

function checkCustom(p: CustomPart, I: Issues): void {
  const mat = getMaterial(p.materialId);
  const mold = mat?.molding;
  if (!mat) I.add('material', 'error', `Unknown material '${p.materialId}'`);
  else if (!mold || !mat.processes.includes('injection-molding')) I.add('material-process', 'error', `${mat.name} is not an injection-molding resin`, 'Choose a moldable resin.');
  if (p.process !== 'injection-molding') I.add('process', 'info', `Process is '${p.process}'; these checks assume injection molding`);
  const minWall = mold?.minWall ?? 1.0;
  const maxWall = mold?.maxWall ?? 4.0;
  let sharp = false;
  const walk = (n: CsgNode, negated: boolean, path: string): void => {
    if ('op' in n) {
      n.children.forEach((c, i) => walk(c, negated !== (n.op === 'difference' && i > 0), `${path}/${n.op}[${i}]`));
      if (n.op === 'difference' && !negated && n.children.length >= 2) {
        const a = n.children[0];
        for (const b of n.children.slice(1)) {
          if (!('shape' in a) || !('shape' in b) || a.shape !== 'box' || b.shape !== 'box') continue;
          const ra = a.transform?.rotation ?? [0, 0, 0];
          const rb = b.transform?.rotation ?? [0, 0, 0];
          if (ra.some((v, k) => Math.abs(v - rb[k]) > 1e-6)) continue;
          const lo = (bx: typeof a) => {
            const pos = bx.transform?.position ?? [0, 0, 0];
            return bx.size.map((sz, k) => pos[k] - (bx.center ? sz / 2 : 0));
          };
          const la = lo(a), lb = lo(b);
          const walls: number[] = [];
          for (let k = 0; k < 3; k++) {
            const w0 = lb[k] - la[k];
            const w1 = la[k] + a.size[k] - (lb[k] + b.size[k]);
            if (w0 > 1e-6) walls.push(w0);
            if (w1 > 1e-6) walls.push(w1);
          }
          const wmin = Math.min(...walls);
          const wmax = Math.max(...walls);
          if (walls.length && wmin < minWall) I.add('min-wall', 'error', `${path}: wall ${fmt(wmin)} mm (box minus box) is below ${minWall} mm`, `Increase to ≥ ${minWall} mm.`);
          if (walls.length && wmax > maxWall) I.add('max-wall', 'warning', `${path}: wall ${fmt(wmax)} mm exceeds ${maxWall} mm`, 'Core out thick sections to a uniform wall.');
          if (walls.length && wmax > 1.5 * wmin) I.add('wall-uniformity', 'warning', `${path}: wall varies ${fmt(wmin)}–${fmt(wmax)} mm (> 1.5:1) — warpage and sink`, 'Keep walls within ±25 % of nominal.');
        }
      }
      return;
    }
    if (negated) return;
    if (n.shape === 'box') {
      if (!(n.radius && n.radius > 0)) sharp = true;
      const m = Math.min(...n.size);
      if (m > maxWall) I.add('thick-section', 'warning', `${path}: solid box with smallest dimension ${fmt(m)} mm (> ${maxWall} mm) — sink and voids`, 'Shell/core it to a uniform wall or switch to machining.');
    } else if (n.shape === 'cylinder') {
      const d = 2 * Math.max(n.radius, n.radiusTop ?? n.radius);
      if (Math.min(d, n.height) > maxWall) I.add('thick-section', 'warning', `${path}: solid cylinder Ø${fmt(d)} × ${fmt(n.height)} mm — thick section`, 'Core it out (e.g. hollow it with a coaxial hole).');
    } else if (n.shape === 'sphere') {
      if (2 * n.radius > maxWall) I.add('thick-section', 'warning', `${path}: solid sphere Ø${fmt(2 * n.radius)} mm — thick section`, 'Hollow it out.');
    }
  };
  walk(p.csg, false, 'csg');
  if (sharp) I.add('sharp-corners', 'info', 'Boxes without edge radius produce sharp inside corners', 'Give boxes a radius ≥ 0.5 × wall.');
  const tex = p.processOptions?.textureDepth ?? p.processOptions?.texture;
  const req = requiredDraftDeg(mat, tex);
  const draft = Number(p.processOptions?.draftDeg ?? 0);
  if (draft + 1e-9 < req)
    I.add('draft', 'warning', `Custom CSG geometry has ${draft ? `${fmt(draft, 2)}°` : 'no'} draft (needs ≥ ${fmt(req, 1)}°) on faces parallel to the pull direction`, `Apply ≥ ${fmt(req, 1)}° draft (record it in processOptions.draftDeg once modelled; cones/tapered extrusions can provide it).`);
}

/** Injection-molding DFM review of a shell or custom CSG part. */
export function checkMoldability(part: EnclosureShell | CustomPart, ctx: { project?: Project } = {}): DesignIssue[] {
  const I = new Issues(part.id);
  if (part.kind === 'enclosure-shell') checkShell(part, I, ctx.project);
  else if (part.kind === 'custom') checkCustom(part, I);
  else I.add('unsupported', 'info', `checkMoldability does not apply to '${(part as { kind: string }).kind}' parts`);
  return I.list;
}
