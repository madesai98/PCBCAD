import { useRef, useState } from 'react';
import { Boxes, CircuitBoard, Cpu, FolderOpen, Moon, Plus, Settings, Sun, Trash2, Upload } from 'lucide-react';
import { useApp } from '../store';
import { SettingsDialog } from './SettingsDialog';

export function timeAgo(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#0e7490" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#lg)" />
      <rect x="15" y="15" width="34" height="34" rx="7" fill="none" stroke="#032027" strokeWidth="3.5" />
      <circle cx="25" cy="25" r="4" fill="#032027" />
      <circle cx="39" cy="39" r="4" fill="#032027" />
      <path d="M25 25 H33 L39 31 V39" stroke="#032027" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Sidebar() {
  const projects = useApp((s) => s.projects);
  const projectId = useApp((s) => s.projectId);
  const openProject = useApp((s) => s.openProject);
  const createProject = useApp((s) => s.createProject);
  const deleteProject = useApp((s) => s.deleteProject);
  const importProject = useApp((s) => s.importProject);
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const conn = useApp((s) => s.conn);
  const version = useApp((s) => s.version);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [settings, setSettings] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <aside className="flex h-full w-full flex-col bg-[var(--bg-sunken)]">
      <div className="flex h-12 items-center gap-2.5 px-4">
        <Logo size={24} />
        <span className="text-[14px] font-semibold tracking-tight">PCBCAD</span>
        <span className="text-[10.5px] faint">{version ? `v${version}` : ''}</span>
        <span className="flex-1" />
        <span title={conn === 'open' ? 'Connected to bridge' : conn === 'connecting' ? 'Connecting…' : 'Disconnected'} className={`size-2 rounded-full ${conn === 'open' ? 'bg-[var(--ok)]' : conn === 'connecting' ? 'bg-[var(--warn)] pulse-dot' : 'bg-[var(--err)]'}`} />
      </div>
      <div className="px-3 pb-2">
        {creating ? (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              void createProject(name.trim());
              setName('');
              setCreating(false);
            }}
          >
            <input autoFocus className="input" placeholder="Product name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setCreating(false)} />
            <div className="flex gap-1.5">
              <button className="btn btn-primary btn-sm flex-1" type="submit">
                Create
              </button>
              <button className="btn btn-sm" type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="flex gap-1.5">
            <button className="btn btn-primary btn-sm flex-1" onClick={() => setCreating(true)}>
              <Plus size={14} /> New product
            </button>
            <button className="btn btn-sm btn-icon" title="Import .pcbcad.json" onClick={() => fileRef.current?.click()}>
              <Upload size={13} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importProject(f);
              }}
            />
          </div>
        )}
      </div>
      <div className="label px-4 pb-1 pt-2">Products</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {projects.length === 0 && <div className="px-2 py-3 text-[12px] faint">No products yet.</div>}
        {projects.map((p) => (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => void openProject(p.id)}
            onKeyDown={(e) => e.key === 'Enter' && void openProject(p.id)}
            className={`group mb-0.5 cursor-pointer rounded-lg px-2.5 py-2 transition ${p.id === projectId ? 'bg-[var(--bg-elev)] shadow-[var(--shadow)] ring-1 ring-[var(--border)]' : 'hover:bg-[var(--bg-hover)]'}`}
          >
            <div className="flex items-center gap-2">
              <FolderOpen size={13} className={p.id === projectId ? 'text-[var(--accent)]' : 'opacity-50'} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{p.name}</span>
              <button
                className="opacity-0 transition group-hover:opacity-60 hover:!opacity-100"
                title="Delete product"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${p.name}"? This cannot be undone.`)) void deleteProject(p.id);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
            <div className="mt-1 flex items-center gap-2.5 pl-5 text-[11px] faint">
              <span className="inline-flex items-center gap-0.5">
                <CircuitBoard size={10} /> {p.boards}
              </span>
              <span className="inline-flex items-center gap-0.5">
                <Cpu size={10} /> {p.components}
              </span>
              <span className="inline-flex items-center gap-0.5">
                <Boxes size={10} /> {p.mechanical}
              </span>
              <span className="flex-1 text-right">{timeAgo(p.updatedAt)}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1 border-t border-[var(--border)] px-2 py-2">
        <button className="btn btn-ghost btn-sm" onClick={() => setSettings(true)}>
          <Settings size={13} /> Settings
        </button>
        <span className="flex-1" />
        <button className="btn btn-ghost btn-sm btn-icon" onClick={toggleTheme} title="Toggle theme">
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    </aside>
  );
}
