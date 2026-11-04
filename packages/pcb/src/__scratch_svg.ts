import type { Board, PartDef } from '@pcbcad/core';
import { buildCopperModel } from './model';
import { primOutline } from './geom';
import { writeFileSync } from 'node:fs';
export function renderSvg(board: Board, parts: Record<string, PartDef>, file: string, scale = 20) {
  const m = buildCopperModel(board, parts);
  const W = 60, H = 50;
  const tx = (x: number) => (x + 2) * scale, ty = (y: number) => (H - 5 - y) * scale;
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" style="background:#111">`];
  out.push(`<polygon points="${board.outline.map(p => `${tx(p[0])},${ty(p[1])}`).join(' ')}" fill="#0a2a0a" stroke="#ff0" stroke-width="1"/>`);
  for (const z of board.zones) for (const r of z.fill ?? []) out.push(`<polygon points="${r.map(p => `${tx(p[0])},${ty(p[1])}`).join(' ')}" fill="${z.layer==='top'?'rgba(200,60,60,0.25)':'rgba(60,60,220,0.25)'}" stroke="#888" stroke-width="0.5"/>`);
  for (const it of m.items) {
    if (it.kind === 'pad') { const poly = primOutline(it.prim!, 0); out.push(`<polygon points="${poly.map(p => `${tx(p[0])},${ty(p[1])}`).join(' ')}" fill="#c80" opacity="0.9"/>`); }
  }
  for (const t of board.traces) out.push(`<polyline points="${t.points.map(p => `${tx(p[0])},${ty(p[1])}`).join(' ')}" fill="none" stroke="${t.layer === 'top' ? '#e33' : '#36f'}" stroke-width="${t.width * scale}" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>`);
  for (const v of board.vias) out.push(`<circle cx="${tx(v.x)}" cy="${ty(v.y)}" r="${v.diameter / 2 * scale}" fill="#ccc"/><circle cx="${tx(v.x)}" cy="${ty(v.y)}" r="${v.drill / 2 * scale}" fill="#111"/>`);
  for (const c of board.components) out.push(`<text x="${tx(c.x)}" y="${ty(c.y)}" fill="#fff" font-size="${scale*0.8}" text-anchor="middle">${c.ref}</text>`);
  out.push('</svg>');
  writeFileSync(file, out.join('\n'));
}
