import { requireBoard } from '../helpers';
import { S, type ToolDef } from '../registry';

export const exportTools: ToolDef[] = [
  {
    name: 'export_manufacturing',
    title: 'Export manufacturing package',
    group: 'export',
    description:
      'Generate the manufacturing package as a zip: per-board Gerbers (RS-274X X2) + Excellon drills, BOM and pick-and-place (JLCPCB format), STL meshes for molded/sheet-metal parts, DXF flat patterns for sheet metal, the project file and a README with component STEP links. Returns a download link.',
    inputSchema: S.obj({ boardIds: S.arr(S.str()), include: S.arr(S.enum(['gerber', 'drill', 'bom', 'cpl', 'stl', 'dxf', 'project'])) }),
    slow: true,
    handler: async (ctx, a: { boardIds?: string[]; include?: string[] }) => {
      const p = ctx.session.project;
      const boardIds = a.boardIds?.map((b) => requireBoard(p, b).id);
      const r = await ctx.services.tasks.run<{ zip: Uint8Array; files: { name: string; size: number }[] }>('export.manufacturing', { project: p, boardIds, include: a.include }, { signal: ctx.signal, timeoutMs: 10 * 60_000 });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const assetId = `export_${stamp}.zip`;
      ctx.services.store.putAsset(p.id, assetId, Buffer.from(r.zip));
      ctx.session.mutate(ctx, 'export_manufacturing', () => `Exported manufacturing package (${r.files.length} files)`);
      const url = `${ctx.services.baseUrl()}/api/projects/${p.id}/assets/${assetId}?download=${encodeURIComponent(p.name.replace(/[^A-Za-z0-9_-]+/g, '_'))}-manufacturing.zip`;
      return { text: `Manufacturing package ready (${(r.zip.byteLength / 1024).toFixed(0)} KB, ${r.files.length} files):\n${r.files.map((f) => `- ${f.name} (${f.size} B)`).join('\n')}\nDownload: ${url}`, data: { url, assetId } };
    },
  },
];
