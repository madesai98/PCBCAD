import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { rpc } from '../rpc';
import { useApp } from '../store';

interface Settings {
  defaultProvider: string;
  providerPaths: Record<string, string>;
  mouserApiKey?: string;
  allowWebResearch: boolean;
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const providers = useApp((st) => st.providers);
  const refresh = useApp((st) => st.refreshProviders);
  const toast = useApp((st) => st.toast);
  useEffect(() => {
    void rpc.call<Settings>('settings.get').then(setS);
  }, []);
  const save = async () => {
    if (!s) return;
    await rpc.call('settings.set', { patch: s });
    await refresh(true);
    toast('success', 'Settings saved');
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="card w-full max-w-lg p-5 shadow-[var(--shadow)]" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center">
          <h2 className="flex-1 text-[15px] font-semibold">Settings</h2>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        {!s ? (
          <div className="text-sm dim">Loading…</div>
        ) : (
          <div className="flex flex-col gap-4 text-[13px]">
            <section>
              <div className="label mb-2">Agent CLIs</div>
              <p className="mb-2 text-[12px] dim">PCBCAD drives the agent CLIs installed on this computer with your own logins (no API keys stored here). Override a path if the CLI is not on PATH.</p>
              {providers
                .filter((p) => p.id !== 'demo')
                .map((p) => (
                  <label key={p.id} className="mb-2 flex items-center gap-2">
                    <span className="w-28 shrink-0">{p.name}</span>
                    <input
                      className="input"
                      placeholder={p.path ?? `${p.id} (auto-detect on PATH)`}
                      value={s.providerPaths[p.id] ?? ''}
                      onChange={(e) => setS({ ...s, providerPaths: { ...s.providerPaths, [p.id]: e.target.value } })}
                    />
                  </label>
                ))}
            </section>
            <section>
              <div className="label mb-2">Distributors</div>
              <p className="mb-2 text-[12px] dim">JLCPCB/LCSC and the EasyEDA library are used without keys. Add a Mouser Search API key to include Mouser results.</p>
              <input className="input" placeholder="Mouser API key (optional)" value={s.mouserApiKey ?? ''} onChange={(e) => setS({ ...s, mouserApiKey: e.target.value })} />
            </section>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.allowWebResearch} onChange={(e) => setS({ ...s, allowWebResearch: e.target.checked })} />
              Allow agents to search the web and read datasheets
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void save()}>
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
