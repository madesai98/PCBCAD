import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { CheckpointInfo, Project, ProjectSummary, Thread, ThreadInfo } from '@pcbcad/core';
import { DEFAULT_SETTINGS, type Settings } from '../config';

function ensureDir(d: string) {
  fs.mkdirSync(d, { recursive: true });
}

/** Atomic write: temp file + rename. */
export function writeFileAtomic(file: string, data: string | Buffer | Uint8Array) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

export function assertSafeId(id: string, what = 'id'): string {
  if (!SAFE_ID.test(id) || id.includes('..')) throw new Error(`Invalid ${what}: ${id}`);
  return id;
}

/**
 * File-system persistence:
 *   <dataDir>/settings.json
 *   <dataDir>/projects/<pid>/project.json
 *   <dataDir>/projects/<pid>/assets/<assetId>
 *   <dataDir>/projects/<pid>/checkpoints/<rev>.json.gz
 *   <dataDir>/projects/<pid>/threads/<tid>.json
 *   <dataDir>/projects/<pid>/workspace/       (agent working directory)
 *   <dataDir>/parts-cache/<id>.json            (imported parts shared across projects)
 */
export class Store {
  constructor(readonly dataDir: string) {
    ensureDir(path.join(dataDir, 'projects'));
    ensureDir(path.join(dataDir, 'parts-cache'));
  }

  /* --------------------------------------- settings --------------------------------------- */

  loadSettings(): Settings {
    const f = path.join(this.dataDir, 'settings.json');
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(s: Settings) {
    writeFileAtomic(path.join(this.dataDir, 'settings.json'), JSON.stringify(s, null, 2));
  }

  /* --------------------------------------- projects --------------------------------------- */

  projectDir(pid: string) {
    return path.join(this.dataDir, 'projects', assertSafeId(pid, 'project id'));
  }

  workspaceDir(pid: string) {
    const d = path.join(this.projectDir(pid), 'workspace');
    ensureDir(d);
    return d;
  }

  listProjects(): ProjectSummary[] {
    const root = path.join(this.dataDir, 'projects');
    const out: ProjectSummary[] = [];
    for (const pid of fs.readdirSync(root)) {
      const f = path.join(root, pid, 'project.json');
      if (!fs.existsSync(f)) continue;
      try {
        const p = JSON.parse(fs.readFileSync(f, 'utf8')) as Project;
        out.push(summarize(p));
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  hasProject(pid: string) {
    return fs.existsSync(path.join(this.projectDir(pid), 'project.json'));
  }

  loadProject(pid: string): Project {
    const f = path.join(this.projectDir(pid), 'project.json');
    return JSON.parse(fs.readFileSync(f, 'utf8')) as Project;
  }

  saveProject(p: Project) {
    writeFileAtomic(path.join(this.projectDir(p.id), 'project.json'), JSON.stringify(p));
  }

  deleteProject(pid: string) {
    fs.rmSync(this.projectDir(pid), { recursive: true, force: true });
  }

  /* ---------------------------------------- assets ---------------------------------------- */

  assetPath(pid: string, assetId: string) {
    return path.join(this.projectDir(pid), 'assets', assertSafeId(assetId, 'asset id'));
  }

  putAsset(pid: string, assetId: string, data: string | Buffer | Uint8Array) {
    writeFileAtomic(this.assetPath(pid, assetId), data);
  }

  hasAsset(pid: string, assetId: string) {
    return fs.existsSync(this.assetPath(pid, assetId));
  }

  getAsset(pid: string, assetId: string): Buffer | null {
    const f = this.assetPath(pid, assetId);
    return fs.existsSync(f) ? fs.readFileSync(f) : null;
  }

  getJsonAsset<T>(pid: string, assetId: string): T | null {
    const b = this.getAsset(pid, assetId);
    return b ? (JSON.parse(b.toString('utf8')) as T) : null;
  }

  /* -------------------------------------- checkpoints ------------------------------------- */

  saveCheckpoint(p: Project, label: string) {
    const dir = path.join(this.projectDir(p.id), 'checkpoints');
    ensureDir(dir);
    const payload = JSON.stringify({ label, at: new Date().toISOString(), project: p });
    writeFileAtomic(path.join(dir, `${p.revision}.json.gz`), gzipSync(payload));
    // keep the most recent 60 checkpoints
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json.gz'))
      .map((f) => parseInt(f, 10))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    for (const r of files.slice(0, Math.max(0, files.length - 60))) fs.rmSync(path.join(dir, `${r}.json.gz`), { force: true });
  }

  listCheckpoints(pid: string): CheckpointInfo[] {
    const dir = path.join(this.projectDir(pid), 'checkpoints');
    if (!fs.existsSync(dir)) return [];
    const out: CheckpointInfo[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json.gz')) continue;
      try {
        const j = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, f))).toString('utf8'));
        out.push({ revision: parseInt(f, 10), at: j.at, label: j.label });
      } catch {
        /* ignore */
      }
    }
    return out.sort((a, b) => b.revision - a.revision);
  }

  loadCheckpoint(pid: string, revision: number): Project {
    const f = path.join(this.projectDir(pid), 'checkpoints', `${revision}.json.gz`);
    const j = JSON.parse(gunzipSync(fs.readFileSync(f)).toString('utf8'));
    return j.project as Project;
  }

  /* ----------------------------------------- threads -------------------------------------- */

  threadFile(pid: string, tid: string) {
    return path.join(this.projectDir(pid), 'threads', `${assertSafeId(tid, 'thread id')}.json`);
  }

  listThreads(pid: string): ThreadInfo[] {
    const dir = path.join(this.projectDir(pid), 'threads');
    if (!fs.existsSync(dir)) return [];
    const out: ThreadInfo[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Thread;
        const { items: _items, ...info } = t;
        out.push(info);
      } catch {
        /* ignore */
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  loadThread(pid: string, tid: string): Thread | null {
    const f = this.threadFile(pid, tid);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8')) as Thread;
  }

  saveThread(t: Thread) {
    writeFileAtomic(this.threadFile(t.projectId, t.id), JSON.stringify(t));
  }

  deleteThread(pid: string, tid: string) {
    fs.rmSync(this.threadFile(pid, tid), { force: true });
  }

  /* ---------------------------------------- parts cache ----------------------------------- */

  partsCacheFile(id: string) {
    return path.join(this.dataDir, 'parts-cache', `${assertSafeId(id.replace(/[^A-Za-z0-9_.:-]/g, '_'), 'part id')}.json`);
  }

  async readPartsCache<T>(id: string): Promise<T | null> {
    try {
      return JSON.parse(await fsp.readFile(this.partsCacheFile(id), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  writePartsCache(id: string, data: unknown) {
    writeFileAtomic(this.partsCacheFile(id), JSON.stringify(data));
  }
}

export function summarize(p: Project): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    updatedAt: p.updatedAt,
    boards: p.boards.length,
    components: p.boards.reduce((n, b) => n + b.components.length, 0),
    mechanical: p.mechanical.length,
  };
}
