import type { MeshData, Project, SimResult } from '@pcbcad/core';

const jsonCache = new Map<string, Promise<unknown>>();

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

async function getJson<T>(url: string, cacheKey = url): Promise<T> {
  let p = jsonCache.get(cacheKey) as Promise<T> | undefined;
  if (!p) {
    p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<T>;
    });
    jsonCache.set(cacheKey, p);
    p.catch(() => jsonCache.delete(cacheKey));
    if (jsonCache.size > 400) jsonCache.delete(jsonCache.keys().next().value!);
  }
  return p;
}

export function assetUrl(projectId: string, assetId: string, download?: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}${download ? `?download=${encodeURIComponent(download)}` : ''}`;
}

export function loadSimResult<T extends SimResult = SimResult>(projectId: string, assetId: string): Promise<T> {
  return getJson<T>(assetUrl(projectId, assetId));
}

/**
 * Mesh loader for the 3D viewer. Keys:
 *  - `mech:<partId>`      server-generated mechanical part mesh (cache key includes the part definition hash)
 *  - `fastener:<partId>`  fastener mesh
 *  - otherwise            a project asset id (fetched component 3D models)
 */
export function makeMeshLoader(project: Project) {
  return async (key: string): Promise<MeshData | null> => {
    try {
      if (key.startsWith('mech:')) {
        const id = key.slice(5);
        const part = project.mechanical.find((m) => m.id === id);
        if (!part) return null;
        return await getJson<MeshData>(`/api/projects/${project.id}/mech/${id}/mesh`, `mesh:${id}:${fnv1a(JSON.stringify(part))}`);
      }
      if (key.startsWith('fastener:')) {
        const id = key.slice(9);
        return await getJson<MeshData>(`/api/projects/${project.id}/fastener/${encodeURIComponent(id)}/mesh`);
      }
      return await getJson<MeshData>(assetUrl(project.id, key));
    } catch {
      return null;
    }
  };
}
