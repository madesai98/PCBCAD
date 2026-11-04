import { createProject, newId, nowIso, type ActivityEntry, type Project } from '@pcbcad/core';
import type { Hub } from '../hub';
import { summarize, type Store } from '../store/store';

export type Actor = 'agent' | 'user' | 'system';

export interface MutationContext {
  actor: Actor;
  threadId?: string;
}

/**
 * In-memory working copy of a project. All design changes go through mutate(), which bumps the
 * revision, records an activity entry (shown live in the UI), persists (debounced) and pushes a
 * snapshot to every browser viewing the project (throttled).
 */
export class ProjectSession {
  private saveTimer: NodeJS.Timeout | null = null;
  private snapTimer: NodeJS.Timeout | null = null;
  private lastSnap = 0;

  constructor(
    public project: Project,
    private store: Store,
    private hub: Hub,
  ) {}

  get id() {
    return this.project.id;
  }

  /**
   * Apply a change. `fn` mutates the project in place and returns the activity summary
   * (string) or null for no-op. Exceptions abort without recording (callers should validate
   * before mutating so partial edits don't occur).
   */
  mutate(ctx: MutationContext, op: string, fn: (p: Project) => string | null): string | null {
    const summary = fn(this.project);
    if (summary == null) return null;
    this.touch(ctx, op, summary);
    return summary;
  }

  /** Record a change already applied to this.project. */
  touch(ctx: MutationContext, op: string, summary: string) {
    const p = this.project;
    p.revision += 1;
    p.updatedAt = nowIso();
    const entry: ActivityEntry = { id: newId('act'), at: p.updatedAt, actor: ctx.actor, op, summary, threadId: ctx.threadId };
    p.activity.push(entry);
    if (p.activity.length > 400) p.activity.splice(0, p.activity.length - 400);
    this.hub.toProject(p.id, { kind: 'project.activity', projectId: p.id, entry });
    this.scheduleSave();
    this.scheduleSnapshot();
  }

  replaceProject(p: Project, ctx: MutationContext, summary: string) {
    const rev = this.project.revision;
    this.project = p;
    this.project.revision = Math.max(rev, p.revision);
    this.touch(ctx, 'restore', summary);
  }

  checkpoint(label: string) {
    this.flush();
    this.store.saveCheckpoint(this.project, label);
    return this.project.revision;
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.store.saveProject(this.project);
      this.hub.broadcast({ kind: 'projects.changed', projects: this.store.listProjects() });
    }, 400);
  }

  private scheduleSnapshot() {
    if (this.snapTimer) return;
    const wait = Math.max(0, 120 - (Date.now() - this.lastSnap));
    this.snapTimer = setTimeout(() => {
      this.snapTimer = null;
      this.lastSnap = Date.now();
      this.pushSnapshot();
    }, wait);
  }

  pushSnapshot() {
    this.hub.toProject(this.project.id, { kind: 'project.snapshot', project: this.project });
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.store.saveProject(this.project);
  }

  summary() {
    return summarize(this.project);
  }
}

export class SessionManager {
  private sessions = new Map<string, ProjectSession>();

  constructor(
    private store: Store,
    private hub: Hub,
  ) {}

  get(pid: string): ProjectSession {
    let s = this.sessions.get(pid);
    if (!s) {
      if (!this.store.hasProject(pid)) throw new Error(`Project ${pid} not found`);
      const p = migrate(this.store.loadProject(pid));
      s = new ProjectSession(p, this.store, this.hub);
      this.sessions.set(pid, s);
    }
    return s;
  }

  create(name: string, description = ''): ProjectSession {
    const p = createProject(name, description);
    this.store.saveProject(p);
    const s = new ProjectSession(p, this.store, this.hub);
    this.sessions.set(p.id, s);
    this.hub.broadcast({ kind: 'projects.changed', projects: this.store.listProjects() });
    return s;
  }

  delete(pid: string) {
    this.sessions.delete(pid);
    this.store.deleteProject(pid);
    this.hub.broadcast({ kind: 'projects.changed', projects: this.store.listProjects() });
  }

  flushAll() {
    for (const s of this.sessions.values()) s.flush();
  }
}

/** Fill fields added after a project was first saved. */
function migrate(p: Project): Project {
  p.requirements ??= [];
  p.parts ??= {};
  p.boards ??= [];
  p.interconnects ??= [];
  p.mechanical ??= [];
  p.assembly ??= { instances: [], fasteners: [] };
  p.firmware ??= [];
  p.behaviors ??= [];
  p.simulations ??= [];
  p.issues ??= [];
  p.notes ??= [];
  p.activity ??= [];
  p.settings ??= { ambientC: 25, currency: 'USD', buildQuantity: 100 };
  p.revision ??= 0;
  return p;
}
