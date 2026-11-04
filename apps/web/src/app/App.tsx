import { useEffect, useState } from 'react';
import { Bot, CircleAlert, CircuitBoard, Info, Loader2, Menu, MessageSquare, Plus, Sparkles, X } from 'lucide-react';
import { ChatPanel } from './components/ChatPanel';
import { Logo, Sidebar, timeAgo } from './components/Sidebar';
import { Workspace } from './components/Workspace';
import { useApp } from './store';

export function App() {
  const init = useApp((s) => s.init);
  const project = useApp((s) => s.project);
  const mobilePane = useApp((s) => s.mobilePane);
  const setMobilePane = useApp((s) => s.setMobilePane);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const setSidebar = useApp((s) => s.setSidebar);
  const thread = useApp((s) => s.thread);
  useEffect(() => init(), [init]);
  const running = thread?.status === 'running';

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="hidden w-[248px] shrink-0 border-r border-[var(--border)] lg:block">
        <Sidebar />
      </div>
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setSidebar(false)} />
          <div className="absolute inset-y-0 left-0 w-[280px] max-w-[85vw] border-r border-[var(--border)] shadow-[var(--shadow)]">
            <Sidebar />
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* mobile header */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border)] px-2 lg:hidden">
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setSidebar(true)}>
            <Menu size={16} />
          </button>
          <Logo size={20} />
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{project?.name ?? 'PCBCAD'}</span>
          {project && (
            <div className="flex rounded-lg border border-[var(--border)] bg-[var(--bg-sunken)] p-0.5">
              <button className={`flex items-center gap-1 rounded-md px-2 py-1 text-[12px] ${mobilePane === 'chat' ? 'bg-[var(--bg-elev)] shadow-[var(--shadow)]' : 'dim'}`} onClick={() => setMobilePane('chat')}>
                {running ? <Loader2 size={12} className="animate-spin" /> : <MessageSquare size={12} />} Agent
              </button>
              <button className={`flex items-center gap-1 rounded-md px-2 py-1 text-[12px] ${mobilePane === 'workspace' ? 'bg-[var(--bg-elev)] shadow-[var(--shadow)]' : 'dim'}`} onClick={() => setMobilePane('workspace')}>
                <CircuitBoard size={12} /> Design
              </button>
            </div>
          )}
        </div>
        {project ? (
          <div className="flex min-h-0 flex-1">
            <div className={`min-h-0 w-full shrink-0 border-r border-[var(--border)] bg-[var(--bg)] lg:flex lg:w-[400px] xl:w-[440px] ${mobilePane === 'chat' ? 'flex' : 'hidden'}`}>
              <div className="h-full w-full">
                <ChatPanel />
              </div>
            </div>
            <div className={`min-h-0 min-w-0 flex-1 lg:block ${mobilePane === 'workspace' ? 'block' : 'hidden'}`}>
              <Workspace />
            </div>
          </div>
        ) : (
          <Welcome />
        )}
      </div>
      <Toasts />
    </div>
  );
}

function Welcome() {
  const projects = useApp((s) => s.projects);
  const loaded = useApp((s) => s.projectsLoaded);
  const createProject = useApp((s) => s.createProject);
  const openProject = useApp((s) => s.openProject);
  const providers = useApp((s) => s.providers);
  const conn = useApp((s) => s.conn);
  const [name, setName] = useState('');
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-5 py-12 lg:py-20">
        <div className="text-center">
          <div className="mx-auto mb-5 w-fit">
            <Logo size={56} />
          </div>
          <h1 className="text-[28px] font-semibold tracking-tight">Design complete hardware with your AI agent</h1>
          <p className="mx-auto mt-2 max-w-xl text-[14px] dim">
            Real distributor parts, multi-board electronics, firmware-in-the-loop simulation, injection-molded enclosures and sheet metal — designed by the agent CLI on your machine, reviewed by you.
          </p>
        </div>
        {conn !== 'open' && (
          <div className="card flex items-center gap-2 px-4 py-3 text-[13px] text-[var(--warn)]">
            <CircleAlert size={15} /> Connecting to the PCBCAD bridge… make sure <span className="mono">pcbcad</span> is running.
          </div>
        )}
        <form
          className="card flex flex-col gap-2 p-4 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void createProject(name.trim() || 'Untitled product');
          }}
        >
          <input className="input !h-10 flex-1 !text-[14px]" placeholder="Name your product, e.g. Smart plant monitor" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-primary !h-10 !px-4" type="submit" disabled={conn !== 'open'}>
            <Plus size={15} /> New product
          </button>
        </form>
        <div className="grid gap-3 sm:grid-cols-3">
          {providers.map((p) => (
            <div key={p.id} className="card flex items-start gap-2.5 px-3.5 py-3">
              {p.id === 'demo' ? <Sparkles size={16} className="mt-0.5 text-[var(--accent)]" /> : <Bot size={16} className={`mt-0.5 ${p.available ? 'text-[var(--ok)]' : 'faint'}`} />}
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{p.name}</div>
                <div className="text-[11.5px] dim">{p.available ? `Ready${p.version ? ` · ${p.version}` : ''}` : (p.hint ?? 'Not installed')}</div>
              </div>
            </div>
          ))}
        </div>
        {loaded && projects.length > 0 && (
          <div>
            <div className="label mb-2">Recent products</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {projects.slice(0, 6).map((p) => (
                <button key={p.id} className="card px-4 py-3 text-left transition hover:border-[var(--border-strong)]" onClick={() => void openProject(p.id)}>
                  <div className="text-[13.5px] font-medium">{p.name}</div>
                  <div className="mt-0.5 text-[11.5px] dim">
                    {p.boards} boards · {p.components} components · {p.mechanical} mechanical · {timeAgo(p.updatedAt)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-start gap-2 text-[12px] faint">
          <Info size={13} className="mt-0.5 shrink-0" />
          PCBCAD runs locally. Agents use your own CLI logins (Claude Code, Codex, Gemini) through a local MCP bridge — no API keys are stored here.
        </div>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto card flex items-start gap-2 px-3 py-2.5 text-[12.5px] shadow-[var(--shadow)] fade-in" style={{ borderColor: t.level === 'error' ? 'var(--err)' : t.level === 'success' ? 'var(--ok)' : undefined }}>
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          <button onClick={() => dismiss(t.id)} className="opacity-60 hover:opacity-100">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
