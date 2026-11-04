import { create } from 'zustand';
import type {
  ChatItem,
  CheckpointInfo,
  Project,
  ProjectSummary,
  ProviderId,
  ProviderStatus,
  ServerEvent,
  Thread,
  ThreadInfo,
} from '@pcbcad/core';
import { rpc } from './rpc';

export type WorkspaceTab = 'overview' | 'schematic' | 'pcb' | 'assembly' | 'parts' | 'simulation' | 'firmware' | 'manufacturing';

export type Selection =
  | { kind: 'component'; boardId: string; componentId: string }
  | { kind: 'part'; partId: string }
  | { kind: 'mech'; partId: string }
  | { kind: 'sim'; runId: string }
  | null;

export interface Toast {
  id: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

interface State {
  conn: 'connecting' | 'open' | 'closed';
  version?: string;
  projects: ProjectSummary[];
  projectsLoaded: boolean;
  projectId?: string;
  project?: Project;
  threads: ThreadInfo[];
  threadId?: string;
  thread?: Thread;
  providers: ProviderStatus[];
  checkpoints: CheckpointInfo[];
  simProgress: Record<string, { progress: number; status: string; message?: string }>;
  toasts: Toast[];
  tab: WorkspaceTab;
  boardId?: string;
  selection: Selection;
  theme: 'dark' | 'light';
  mobilePane: 'chat' | 'workspace';
  sidebarOpen: boolean;
  composerProvider?: ProviderId;
  composerModel?: string;
}

interface Actions {
  init(): void;
  refreshProviders(refresh?: boolean): Promise<void>;
  openProject(id: string): Promise<void>;
  closeProject(): void;
  createProject(name: string, description?: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  importProject(file: File): Promise<void>;
  selectThread(id: string): Promise<void>;
  newThread(provider?: ProviderId, model?: string): Promise<string>;
  setComposerAgent(provider: ProviderId, model?: string): void;
  send(text: string, attachments?: { name: string; firmwareId?: string }[]): Promise<void>;
  interrupt(): void;
  restore(revision: number): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
  uploadFirmware(file: File): Promise<{ id: string; name: string } | null>;
  uploadAttachment(file: File): Promise<{ name: string } | null>;
  setTab(t: WorkspaceTab): void;
  setBoard(id?: string): void;
  select(s: Selection): void;
  toast(level: Toast['level'], message: string): void;
  dismissToast(id: number): void;
  toggleTheme(): void;
  setMobilePane(p: 'chat' | 'workspace'): void;
  setSidebar(open: boolean): void;
}

let toastId = 1;

function loadPref<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(`pcbcad.${k}`);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}

function savePref(k: string, v: unknown) {
  try {
    localStorage.setItem(`pcbcad.${k}`, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

export const useApp = create<State & Actions>((set, get) => ({
  conn: 'connecting',
  projects: [],
  projectsLoaded: false,
  threads: [],
  providers: [],
  checkpoints: [],
  simProgress: {},
  toasts: [],
  tab: loadPref<WorkspaceTab>('tab', 'overview'),
  selection: null,
  theme: loadPref<'dark' | 'light'>('theme', 'dark'),
  mobilePane: 'workspace',
  sidebarOpen: false,
  composerProvider: loadPref<ProviderId | undefined>('provider', undefined),
  composerModel: loadPref<string | undefined>('model', undefined),

  init() {
    document.documentElement.classList.toggle('dark', get().theme === 'dark');
    rpc.onStatus((s) => {
      set({ conn: s });
      if (s === 'open') {
        void rpc.call<ProjectSummary[]>('projects.list').then((projects) => set({ projects, projectsLoaded: true }));
        void get().refreshProviders();
        const pid = get().projectId ?? loadPref<string | undefined>('project', undefined);
        if (pid) void get().openProject(pid).catch(() => set({ projectId: undefined, project: undefined }));
      }
    });
    rpc.on((e) => handleEvent(e, set, get));
  },

  async refreshProviders(refresh = false) {
    const providers = await rpc.call<ProviderStatus[]>('providers.list', { refresh });
    set({ providers });
    if (!get().composerProvider) {
      const first = providers.find((p) => p.available && p.id !== 'demo') ?? providers.find((p) => p.id === 'demo');
      if (first) set({ composerProvider: first.id, composerModel: first.defaultModel });
    }
  },

  async openProject(id) {
    const r = await rpc.call<{ project: Project; threads: ThreadInfo[]; checkpoints: CheckpointInfo[] }>('project.open', { projectId: id });
    savePref('project', id);
    const boardId = r.project.boards.find((b) => b.id === get().boardId)?.id ?? r.project.boards[0]?.id;
    set({ projectId: id, project: r.project, threads: r.threads, checkpoints: r.checkpoints, boardId, selection: null, thread: undefined, threadId: undefined, sidebarOpen: false });
    const last = r.threads[0];
    if (last) await get().selectThread(last.id);
  },

  closeProject() {
    void rpc.call('project.close');
    savePref('project', undefined);
    set({ projectId: undefined, project: undefined, threads: [], thread: undefined, threadId: undefined });
  },

  async createProject(name, description) {
    const s = await rpc.call<ProjectSummary>('projects.create', { name, description });
    await get().openProject(s.id);
  },

  async deleteProject(id) {
    await rpc.call('projects.delete', { projectId: id });
    if (get().projectId === id) get().closeProject();
  },

  async importProject(file) {
    const json = JSON.parse(await file.text());
    const s = await rpc.call<ProjectSummary>('projects.import', { project: json });
    await get().openProject(s.id);
  },

  async selectThread(id) {
    const pid = get().projectId;
    if (!pid) return;
    const t = await rpc.call<Thread>('threads.get', { projectId: pid, threadId: id });
    set({ threadId: id, thread: t ?? undefined, composerProvider: t?.provider ?? get().composerProvider, composerModel: t?.model ?? get().composerModel });
  },

  async newThread(provider, model) {
    const pid = get().projectId!;
    const p = provider ?? get().composerProvider ?? 'demo';
    const t = await rpc.call<ThreadInfo>('threads.create', { projectId: pid, provider: p, model: model ?? get().composerModel });
    set({ threads: [t, ...get().threads.filter((x) => x.id !== t.id)] });
    await get().selectThread(t.id);
    return t.id;
  },

  setComposerAgent(provider, model) {
    savePref('provider', provider);
    savePref('model', model);
    set({ composerProvider: provider, composerModel: model });
    const t = get().thread;
    if (t && t.status !== 'running' && (t.provider !== provider || t.model !== model) && get().projectId) {
      void rpc.call('threads.update', { projectId: get().projectId, threadId: t.id, provider, model });
    }
  },

  async send(text, attachments) {
    const pid = get().projectId;
    if (!pid) return;
    let tid = get().threadId;
    const t = get().thread;
    if (!tid || !t) tid = await get().newThread();
    set({ mobilePane: 'chat' });
    try {
      await rpc.call('chat.send', { projectId: pid, threadId: tid, text, attachments });
    } catch (e) {
      get().toast('error', (e as Error).message);
    }
  },

  interrupt() {
    const tid = get().threadId;
    if (tid) void rpc.call('chat.interrupt', { threadId: tid });
  },

  async restore(revision) {
    const pid = get().projectId;
    if (!pid) return;
    await rpc.call('project.restore', { projectId: pid, revision });
    const checkpoints = await rpc.call<CheckpointInfo[]>('checkpoints.list', { projectId: pid });
    set({ checkpoints });
    get().toast('success', `Restored design to revision ${revision}`);
  },

  async callTool(name, args) {
    const pid = get().projectId;
    if (!pid) throw new Error('no project');
    const r = await rpc.call<{ text: string; isError?: boolean }>('tools.call', { projectId: pid, name, args });
    if (r.isError) get().toast('error', r.text.slice(0, 300));
    return r;
  },

  async uploadFirmware(file) {
    const pid = get().projectId;
    if (!pid) return null;
    const res = await fetch(`/api/projects/${pid}/firmware?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'x-pcbcad-client': 'web' } });
    if (!res.ok) {
      get().toast('error', `Upload failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
      return null;
    }
    const fw = await res.json();
    get().toast('success', `Firmware ${fw.name} uploaded (${fw.size} bytes)`);
    return fw;
  },

  async uploadAttachment(file) {
    const pid = get().projectId;
    if (!pid) return null;
    const res = await fetch(`/api/projects/${pid}/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'x-pcbcad-client': 'web' } });
    if (!res.ok) return null;
    return res.json();
  },

  setTab(t) {
    savePref('tab', t);
    set({ tab: t, mobilePane: 'workspace' });
  },
  setBoard(id) {
    set({ boardId: id });
  },
  select(s) {
    set({ selection: s });
  },
  toast(level, message) {
    const id = toastId++;
    set({ toasts: [...get().toasts, { id, level, message }] });
    setTimeout(() => get().dismissToast(id), level === 'error' ? 8000 : 4000);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  toggleTheme() {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    savePref('theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    set({ theme });
  },
  setMobilePane(p) {
    set({ mobilePane: p });
  },
  setSidebar(open) {
    set({ sidebarOpen: open });
  },
}));

function upsertItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i < 0) return [...items, item];
  const next = items.slice();
  next[i] = item;
  return next;
}

function handleEvent(e: ServerEvent, set: (p: Partial<State>) => void, get: () => State & Actions) {
  const s = get();
  switch (e.kind) {
    case 'hello':
      set({ version: e.version });
      break;
    case 'projects.changed':
      set({ projects: e.projects });
      break;
    case 'project.snapshot':
      if (e.project.id === s.projectId) {
        const boardId = e.project.boards.some((b) => b.id === s.boardId) ? s.boardId : e.project.boards[0]?.id;
        set({ project: e.project, boardId });
      }
      break;
    case 'threads.changed':
      if (e.projectId === s.projectId) set({ threads: e.threads });
      break;
    case 'thread.updated': {
      if (e.thread.projectId !== s.projectId) break;
      set({ threads: s.threads.some((t) => t.id === e.thread.id) ? s.threads.map((t) => (t.id === e.thread.id ? e.thread : t)) : [e.thread, ...s.threads] });
      if (s.thread && s.thread.id === e.thread.id) set({ thread: { ...s.thread, ...e.thread, items: s.thread.items } });
      if (e.thread.status !== 'running' && s.projectId) void rpc.call<CheckpointInfo[]>('checkpoints.list', { projectId: s.projectId }).then((checkpoints) => set({ checkpoints }));
      break;
    }
    case 'thread.item':
      if (s.thread && s.thread.id === e.threadId) set({ thread: { ...s.thread, items: upsertItem(s.thread.items, e.item) } });
      break;
    case 'thread.delta': {
      if (!s.thread || s.thread.id !== e.threadId) break;
      const items = s.thread.items.map((it) => (it.id === e.itemId && (it.kind === 'assistant' || it.kind === 'reasoning') ? { ...it, text: it.text + e.delta } : it));
      set({ thread: { ...s.thread, items } });
      break;
    }
    case 'sim.progress':
      if (e.projectId === s.projectId) set({ simProgress: { ...s.simProgress, [e.runId]: { progress: e.progress, status: e.status, message: e.message } } });
      break;
    case 'toast':
      if (!e.message.startsWith('mesh:')) s.toast(e.level, e.message);
      break;
  }
}
