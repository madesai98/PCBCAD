import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  History,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  RotateCcw,
  Sparkles,
  Square,
  User,
  X,
} from 'lucide-react';
import type { ChatItem, ProviderStatus } from '@pcbcad/core';
import { useApp } from '../store';
import { summarizeInput, toolInfo, TONE_COLOR } from '../toolMeta';
import { Markdown } from './Markdown';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** Collapse consecutive tool items into groups for a calmer timeline. */
function groupItems(items: ChatItem[]): (ChatItem | { kind: 'toolgroup'; id: string; tools: ToolItem[] })[] {
  const out: (ChatItem | { kind: 'toolgroup'; id: string; tools: ToolItem[] })[] = [];
  for (const it of items) {
    if (it.kind === 'tool') {
      const last = out[out.length - 1];
      if (last && last.kind === 'toolgroup') last.tools.push(it);
      else out.push({ kind: 'toolgroup', id: `g-${it.id}`, tools: [it] });
    } else out.push(it);
  }
  return out;
}

export function ChatPanel() {
  const thread = useApp((s) => s.thread);
  const threads = useApp((s) => s.threads);
  const project = useApp((s) => s.project);
  const selectThread = useApp((s) => s.selectThread);
  const newThread = useApp((s) => s.newThread);
  const providers = useApp((s) => s.providers);
  const [showThreads, setShowThreads] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const items = thread?.items ?? [];
  const grouped = useMemo(() => groupItems(items), [items]);
  const running = thread?.status === 'running';

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const provider = providers.find((p) => p.id === thread?.provider);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <button className="btn btn-ghost btn-sm min-w-0 flex-1 justify-start" onClick={() => setShowThreads((v) => !v)} title="Conversations">
          <History size={14} className="shrink-0 opacity-70" />
          <span className="truncate font-medium">{thread?.title ?? 'New conversation'}</span>
          <ChevronDown size={14} className="shrink-0 opacity-60" />
        </button>
        {thread && <AgentBadge provider={provider} model={thread.model} running={running} />}
        <button className="btn btn-ghost btn-sm btn-icon" title="New conversation" onClick={() => void newThread()} disabled={!project}>
          <MessageSquarePlus size={15} />
        </button>
      </div>
      {showThreads && (
        <div className="max-h-72 shrink-0 overflow-y-auto border-b border-[var(--border)] bg-[var(--bg-sunken)] p-1.5">
          {threads.length === 0 && <div className="p-3 text-xs dim">No conversations yet.</div>}
          {threads.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                void selectThread(t.id);
                setShowThreads(false);
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-[var(--bg-hover)] ${t.id === thread?.id ? 'bg-[var(--bg-hover)]' : ''}`}
            >
              {t.status === 'running' ? <Loader2 size={13} className="animate-spin text-[var(--accent)]" /> : <Bot size={13} className="opacity-50" />}
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              <span className="chip">{t.provider}</span>
            </button>
          ))}
        </div>
      )}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!thread || items.length === 0 ? <EmptyChat /> : null}
        <div className="flex flex-col gap-3">
          {grouped.map((it) =>
            it.kind === 'toolgroup' ? <ToolGroup key={it.id} tools={it.tools} /> : <ItemView key={it.id} item={it} />,
          )}
          {running && <Working items={items} />}
        </div>
      </div>
      <Composer />
    </div>
  );
}

function AgentBadge({ provider, model, running }: { provider?: ProviderStatus; model?: string; running: boolean }) {
  return (
    <span className={`chip ${running ? 'chip-accent' : ''}`} title={provider?.version ? `${provider.name} ${provider.version}` : provider?.name}>
      {running ? <span className="pulse-dot inline-block size-1.5 rounded-full bg-[var(--accent)]" /> : <Bot size={11} />}
      {provider?.name ?? '—'}
      {model && model !== 'default' && model !== 'scripted' ? ` · ${model}` : ''}
    </span>
  );
}

function EmptyChat() {
  const send = useApp((s) => s.send);
  const project = useApp((s) => s.project);
  const providers = useApp((s) => s.providers);
  const real = providers.filter((p) => p.available && p.id !== 'demo');
  const ideas = [
    'Design a USB-C powered environmental monitor with a remote BME280 probe on a cable, an ATmega328P, an injection-molded enclosure and a wall bracket.',
    'Add a 1-cell LiPo battery with USB-C charging to the main board and re-run the thermal analysis.',
    'Make the enclosure from PA66-GF30 and run a 1.5 m corner drop test.',
  ];
  return (
    <div className="mx-auto mt-6 max-w-md text-center fade-in">
      <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
        <Sparkles size={22} />
      </div>
      <h2 className="text-[15px] font-semibold">Describe the product you want to build</h2>
      <p className="mt-1.5 text-[13px] dim">
        The agent picks real parts from distributors, draws the schematic, lays out the boards, designs the enclosure and sheet metal, and verifies everything with simulation — you review the result in the workspace.
      </p>
      {real.length === 0 && (
        <p className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--bg-sunken)] p-2.5 text-left text-[12px] dim">
          No agent CLI detected. Install <span className="mono">claude</span>, <span className="mono">codex</span> or <span className="mono">gemini</span> and log in — or try the built-in scripted demo agent.
        </p>
      )}
      <div className="mt-4 flex flex-col gap-2 text-left">
        {ideas.map((t) => (
          <button key={t} className="card px-3 py-2.5 text-left text-[12.5px] transition hover:border-[var(--border-strong)]" disabled={!project} onClick={() => void send(t)}>
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function Working({ items }: { items: ChatItem[] }) {
  const last = [...items].reverse().find((i) => i.kind === 'tool' && i.status === 'running') as ToolItem | undefined;
  return (
    <div className="flex items-center gap-2 px-1 text-[12.5px]">
      <Loader2 size={14} className="animate-spin text-[var(--accent)]" />
      <span className="shimmer font-medium">{last ? `${toolInfo(last.name).title}…` : 'Thinking…'}</span>
    </div>
  );
}

function ItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end fade-in">
          <div className="max-w-[88%] rounded-2xl rounded-br-md bg-[var(--accent-soft)] px-3.5 py-2.5 text-[13.5px] leading-relaxed">
            <div className="whitespace-pre-wrap break-words">{item.text}</div>
            {item.attachments?.length ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {item.attachments.map((a) => (
                  <span key={a.name} className="chip">
                    <Paperclip size={10} /> {a.name}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className="flex gap-2.5 fade-in">
          <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-[var(--bg-sunken)] text-[var(--accent)]">
            <Sparkles size={13} />
          </div>
          <div className="min-w-0 flex-1 text-[13.5px] leading-relaxed">
            <Markdown text={item.text} />
          </div>
        </div>
      );
    case 'reasoning':
      return <Reasoning text={item.text} streaming={!!item.streaming} />;
    case 'system':
      return (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] ${item.level === 'error' ? 'border-[color-mix(in_oklab,var(--err)_40%,transparent)] text-[var(--err)]' : 'border-[var(--border)] dim'}`}>
          <CircleAlert size={13} className="mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap break-words">{item.text}</span>
        </div>
      );
    case 'turn':
      return <TurnMarker item={item} />;
    default:
      return null;
  }
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <button className="ml-8 text-left text-[12px] dim" onClick={() => setOpen((v) => !v)}>
      <span className="inline-flex items-center gap-1">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className={streaming ? 'shimmer' : ''}>Reasoning</span>
      </span>
      {open && <div className="mt-1 whitespace-pre-wrap border-l-2 border-[var(--border)] pl-2.5 italic">{text}</div>}
    </button>
  );
}

function TurnMarker({ item }: { item: Extract<ChatItem, { kind: 'turn' }> }) {
  const restore = useApp((s) => s.restore);
  const [confirm, setConfirm] = useState(false);
  if (item.status === 'started') return null;
  const parts = [
    item.status === 'completed' ? 'Done' : item.status === 'interrupted' ? 'Interrupted' : 'Failed',
    item.durationMs ? `${(item.durationMs / 1000).toFixed(item.durationMs < 10_000 ? 1 : 0)} s` : '',
    item.costUsd ? `$${item.costUsd.toFixed(3)}` : '',
    item.outputTokens ? `${item.outputTokens.toLocaleString()} out tok` : '',
  ].filter(Boolean);
  return (
    <div className="group flex items-center gap-2 py-1 text-[11px] faint">
      <div className="h-px flex-1 bg-[var(--border)]" />
      <span className={item.status === 'failed' ? 'text-[var(--err)]' : ''}>{parts.join(' · ')}</span>
      {item.checkpointRevision != null &&
        (confirm ? (
          <span className="flex items-center gap-1">
            <button className="btn btn-sm" onClick={() => void restore(item.checkpointRevision!).then(() => setConfirm(false))}>
              <RotateCcw size={11} /> Restore design to before this turn
            </button>
            <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setConfirm(false)}>
              <X size={12} />
            </button>
          </span>
        ) : (
          <button className="btn btn-ghost btn-sm opacity-0 transition group-hover:opacity-100" onClick={() => setConfirm(true)} title="Undo everything this turn changed">
            <RotateCcw size={11} /> Revert
          </button>
        ))}
      <div className="h-px flex-1 bg-[var(--border)]" />
    </div>
  );
}

function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.filter((t) => t.status === 'running').length;
  const errors = tools.filter((t) => t.status === 'error').length;
  if (tools.length <= 3 || open)
    return (
      <div className="ml-8 flex flex-col gap-1.5">
        {tools.map((t) => (
          <ToolCard key={t.id} t={t} />
        ))}
        {tools.length > 3 && (
          <button className="self-start text-[11px] faint hover:underline" onClick={() => setOpen(false)}>
            Collapse {tools.length} steps
          </button>
        )}
      </div>
    );
  const last = tools.slice(-2);
  return (
    <div className="ml-8 flex flex-col gap-1.5">
      <button className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--border)] px-2.5 py-1.5 text-[12px] dim hover:bg-[var(--bg-hover)]" onClick={() => setOpen(true)}>
        <ChevronRight size={12} />
        {tools.length - 2} earlier steps
        <span className="flex -space-x-1">
          {tools.slice(0, -2).slice(-8).map((t) => {
            const I = toolInfo(t.name).icon;
            return (
              <span key={t.id} className="grid size-5 place-items-center rounded-md border border-[var(--border)] bg-[var(--bg-elev)]" style={{ color: TONE_COLOR[toolInfo(t.name).tone] }}>
                <I size={11} />
              </span>
            );
          })}
        </span>
        {errors > 0 && <span className="chip chip-err">{errors} failed</span>}
        {running > 0 && <Loader2 size={12} className="animate-spin" />}
      </button>
      {last.map((t) => (
        <ToolCard key={t.id} t={t} />
      ))}
    </div>
  );
}

function ToolCard({ t }: { t: ToolItem }) {
  const [open, setOpen] = useState(false);
  const meta = toolInfo(t.name);
  const Icon = meta.icon;
  const summary = summarizeInput(t.name, t.input);
  const firstLine = t.output?.split('\n').find((l) => l.trim()) ?? '';
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] fade-in">
      <button className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left hover:bg-[var(--bg-hover)]" onClick={() => setOpen((v) => !v)}>
        <span className="grid size-6 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in oklab, ${TONE_COLOR[meta.tone]} 15%, transparent)`, color: TONE_COLOR[meta.tone] }}>
          <Icon size={13} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
            {meta.title}
            {!t.design && <span className="chip">tool</span>}
          </span>
          <span className="block truncate text-[11.5px] dim">{t.status === 'running' ? summary || 'working…' : firstLine || summary}</span>
        </span>
        {t.status === 'running' ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-[var(--accent)]" />
        ) : t.status === 'error' ? (
          <CircleAlert size={14} className="shrink-0 text-[var(--err)]" />
        ) : (
          <Check size={14} className="shrink-0 text-[var(--ok)]" />
        )}
        {t.durationMs != null && t.durationMs > 900 && <span className="text-[10.5px] faint">{(t.durationMs / 1000).toFixed(1)}s</span>}
      </button>
      {open && (
        <div className="border-t border-[var(--border)] bg-[var(--bg-sunken)] px-3 py-2">
          {summary && <div className="mb-1.5 text-[11px] dim">{summary}</div>}
          <details className="mb-1.5">
            <summary className="cursor-pointer text-[11px] faint">Arguments</summary>
            <pre className="mono mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px] dim">{JSON.stringify(t.input, null, 2)}</pre>
          </details>
          <pre className="mono max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11.5px] leading-relaxed">{t.output ?? '…'}</pre>
        </div>
      )}
    </div>
  );
}

function Composer() {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<{ name: string; firmwareId?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const thread = useApp((s) => s.thread);
  const project = useApp((s) => s.project);
  const send = useApp((s) => s.send);
  const interrupt = useApp((s) => s.interrupt);
  const uploadFirmware = useApp((s) => s.uploadFirmware);
  const uploadAttachment = useApp((s) => s.uploadAttachment);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const running = thread?.status === 'running';

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(220, ta.scrollHeight)}px`;
  }, [text]);

  const submit = async () => {
    const t = text.trim();
    if (!t || running || !project) return;
    setText('');
    const att = attachments;
    setAttachments([]);
    await send(t, att.length ? att : undefined);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    setBusy(true);
    for (const f of Array.from(files)) {
      if (/\.(hex|ihex|bin|uf2|elf)$/i.test(f.name)) {
        const fw = await uploadFirmware(f);
        if (fw) setAttachments((a) => [...a, { name: fw.name, firmwareId: fw.id }]);
      } else {
        const r = await uploadAttachment(f);
        if (r) setAttachments((a) => [...a, { name: r.name }]);
      }
    }
    setBusy(false);
  };

  return (
    <div className="shrink-0 border-t border-[var(--border)] p-3">
      <div
        className="rounded-2xl border border-[var(--border)] bg-[var(--bg-sunken)] p-2 transition focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)]"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void onFiles(e.dataTransfer.files);
        }}
      >
        {attachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1 px-1">
            {attachments.map((a) => (
              <span key={a.name} className="chip">
                <Paperclip size={10} /> {a.name}
                <button onClick={() => setAttachments((x) => x.filter((y) => y !== a))}>
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder={project ? (running ? 'The agent is working…' : 'Describe what to build or change…') : 'Open or create a project first'}
          disabled={!project}
          className="block w-full resize-none bg-transparent px-1.5 py-1 text-[13.5px] leading-relaxed outline-none placeholder:text-[var(--text-faint)]"
        />
        <div className="mt-1 flex items-center gap-1.5">
          <AgentPicker />
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
          <button className="btn btn-ghost btn-sm btn-icon" title="Attach firmware (.hex/.bin/.uf2/.elf) or datasheets" onClick={() => fileRef.current?.click()} disabled={!project || busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
          </button>
          <div className="flex-1" />
          {running ? (
            <button className="btn btn-sm" onClick={interrupt} title="Stop the agent">
              <Square size={11} fill="currentColor" /> Stop
            </button>
          ) : (
            <button className="btn btn-primary btn-sm btn-icon" onClick={() => void submit()} disabled={!text.trim() || !project} title="Send (Enter)">
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between px-1 text-[10.5px] faint">
        <span>
          <User size={10} className="mr-1 inline" />
          Enter to send · Shift+Enter newline · drop firmware to attach
        </span>
      </div>
    </div>
  );
}

function AgentPicker() {
  const providers = useApp((s) => s.providers);
  const provider = useApp((s) => s.composerProvider);
  const model = useApp((s) => s.composerModel);
  const setAgent = useApp((s) => s.setComposerAgent);
  const refresh = useApp((s) => s.refreshProviders);
  const [open, setOpen] = useState(false);
  const current = providers.find((p) => p.id === provider);
  const modelLabel = current?.models.find((m) => m.id === model)?.label;
  return (
    <div className="relative">
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)}>
        <Bot size={13} />
        <span className="max-w-[160px] truncate">
          {current?.name ?? 'Choose agent'}
          {modelLabel && modelLabel !== 'Default' && modelLabel !== 'Scripted walkthrough' ? ` · ${modelLabel}` : ''}
        </span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-50 mb-1.5 w-72 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-1.5 shadow-[var(--shadow)]">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="label">Agent CLI</span>
              <button className="text-[11px] faint hover:underline" onClick={() => void refresh(true)}>
                Re-detect
              </button>
            </div>
            {providers.map((p) => (
              <div key={p.id} className="mb-1">
                <div className={`flex items-center gap-2 px-2 py-1 text-[12.5px] font-medium ${p.available ? '' : 'opacity-50'}`}>
                  <span className={`size-1.5 rounded-full ${p.available ? 'bg-[var(--ok)]' : 'bg-[var(--text-faint)]'}`} />
                  {p.name}
                  {p.version && <span className="text-[10.5px] font-normal faint">{p.version}</span>}
                </div>
                {p.available ? (
                  <div className="flex flex-wrap gap-1 px-2 pb-1">
                    {p.models.map((m) => (
                      <button
                        key={m.id}
                        title={m.description}
                        className={`chip cursor-pointer ${p.id === provider && (model ?? p.defaultModel) === m.id ? 'chip-accent' : ''}`}
                        onClick={() => {
                          setAgent(p.id, m.id);
                          setOpen(false);
                        }}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="px-2 pb-1 text-[11px] faint">{p.hint}</div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
