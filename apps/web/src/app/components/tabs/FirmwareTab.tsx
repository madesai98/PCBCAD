import { useMemo, useRef, useState } from 'react';
import { Binary, Cpu, FileCode, Loader2, Play, Upload } from 'lucide-react';
import type { MixedSignalResult } from '@pcbcad/core';
import { LogicAnalyzer } from '../../../viewers';
import { useLatestRun, useSimResult } from '../../hooks';
import { useApp } from '../../store';
import { timeAgo } from '../Sidebar';
import { Section } from '../ui';

export function FirmwareTab() {
  const project = useApp((s) => s.project)!;
  const callTool = useApp((s) => s.callTool);
  const uploadFirmware = useApp((s) => s.uploadFirmware);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [openScript, setOpenScript] = useState<string | null>(null);
  const run = useLatestRun('mixed-signal');
  const result = useSimResult<MixedSignalResult>(run);
  const mcus = useMemo(
    () =>
      project.boards.flatMap((b) =>
        b.components
          .filter((c) => project.parts[c.partId]?.sim?.kind === 'mcu' || c.mcu?.emulator)
          .map((c) => {
            const part = project.parts[c.partId];
            const sim = part?.sim?.kind === 'mcu' ? part.sim : undefined;
            return { board: b, c, part, emulator: c.mcu?.emulator ?? sim?.emulator ?? '—', firmwareId: c.mcu?.firmwareId ?? sim?.firmwareId, clock: c.mcu?.clockHz ?? sim?.clockHz };
          }),
      ),
    [project],
  );
  const scripted = useMemo(() => project.boards.flatMap((b) => b.components.filter((c) => c.behaviorId || (project.parts[c.partId]?.sim?.kind === 'ic' && (project.parts[c.partId]!.sim as { behaviorId?: string }).behaviorId)).map((c) => ({ b, c }))), [project]);

  const simulate = async () => {
    setBusy(true);
    try {
      await callTool('run_firmware_simulation', { duration: 1 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1300px] flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-[16px] font-semibold">Firmware & behaviour models</h2>
          <input
            ref={fileRef}
            type="file"
            accept=".hex,.ihex,.bin,.uf2,.elf"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await uploadFirmware(f);
              e.target.value = '';
            }}
          />
          <button className="btn btn-sm" onClick={() => fileRef.current?.click()}>
            <Upload size={12} /> Upload firmware
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy || !mcus.some((m) => m.firmwareId)} onClick={() => void simulate()}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run firmware simulation
          </button>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title={<span className="flex items-center gap-1.5"><Cpu size={13} /> Microcontrollers</span>}>
            {mcus.length === 0 ? (
              <div className="px-4 py-5 text-[12.5px] dim">No MCU components. Parts with an emulator (ATmega328P via avr8js, RP2040 via rp2040js, or an agent-written emulator) appear here.</div>
            ) : (
              <div className="flex flex-col divide-y divide-[var(--border)]">
                {mcus.map((m) => (
                  <div key={m.c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">
                        {m.board.name} · {m.c.ref} <span className="dim">{m.part?.mpn}</span>
                      </div>
                      <div className="text-[11.5px] dim">
                        Emulator <span className="mono">{m.emulator}</span>
                        {m.clock ? ` · ${(m.clock / 1e6).toFixed(m.clock % 1e6 ? 3 : 0)} MHz` : ''}
                      </div>
                    </div>
                    <select
                      className="input !h-8 !w-56 !text-[12px]"
                      value={m.firmwareId ?? ''}
                      onChange={(e) => void callTool('configure_mcu', { boardId: m.board.id, ref: m.c.ref, firmwareId: e.target.value })}
                    >
                      <option value="">No firmware</option>
                      {project.firmware.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </Section>
          <Section title={<span className="flex items-center gap-1.5"><Binary size={13} /> Firmware images</span>}>
            {project.firmware.length === 0 ? (
              <div className="px-4 py-5 text-[12.5px] dim">Upload a compiled image (.hex / .bin / .uf2 / .elf) — it runs unmodified in the MCU emulator.</div>
            ) : (
              <div className="flex flex-col divide-y divide-[var(--border)]">
                {project.firmware.map((f) => (
                  <div key={f.id} className="px-4 py-2.5">
                    <div className="flex items-center gap-2 text-[13px]">
                      <span className="font-medium">{f.name}</span>
                      <span className="chip">{f.format}</span>
                      {f.target && <span className="chip">{f.target}</span>}
                      <span className="flex-1" />
                      <span className="text-[11px] faint">{timeAgo(f.uploadedAt)}</span>
                    </div>
                    <div className="mono mt-0.5 truncate text-[11px] faint">
                      {f.size.toLocaleString()} bytes · sha256 {f.sha256.slice(0, 16)}…{f.notes ? ` · ${f.notes}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
        <Section title={<span className="flex items-center gap-1.5"><FileCode size={13} /> Behaviour scripts</span>}>
          {project.behaviors.length === 0 ? (
            <div className="px-4 py-5 text-[12.5px] dim">Non-MCU chips (sensors, drivers, memories, displays) are simulated by small JavaScript behaviour models the agent writes — or built-ins like the BME280 model.</div>
          ) : (
            <div className="flex flex-col divide-y divide-[var(--border)]">
              {project.behaviors.map((b) => {
                const users = scripted.filter((x) => x.c.behaviorId === b.id).map((x) => `${x.b.name}:${x.c.ref}`);
                return (
                  <div key={b.id}>
                    <button className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-[var(--bg-hover)]" onClick={() => setOpenScript(openScript === b.id ? null : b.id)}>
                      <span className="text-[13px] font-medium">{b.name}</span>
                      <span className="chip">{b.kind}</span>
                      <span className="chip">{b.author}</span>
                      <span className="flex-1 truncate text-[11.5px] dim">{users.length ? `used by ${users.join(', ')}` : b.description}</span>
                    </button>
                    {openScript === b.id && <pre className="mono mx-4 mb-3 max-h-96 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-sunken)] p-3 text-[11.5px] leading-relaxed">{b.code}</pre>}
                  </div>
                );
              })}
            </div>
          )}
        </Section>
        <Section title={`Latest run${run ? ` · ${run.title}` : ''}`}>
          {!run ? (
            <div className="px-4 py-5 text-[12.5px] dim">No firmware simulation yet.</div>
          ) : result.loading ? (
            <div className="flex items-center gap-2 px-4 py-5 text-[12.5px] dim">
              <Loader2 size={13} className="animate-spin" /> Loading…
            </div>
          ) : result.data ? (
            <LogicAnalyzer result={result.data} />
          ) : null}
        </Section>
      </div>
    </div>
  );
}
