import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { newId, nowIso, type BehaviorScript, type FirmwareImage, type Project } from '@pcbcad/core';
import { BUILTIN_BEHAVIORS, validateBehaviorScript } from '@pcbcad/sim';
import { REPO_ROOT, SERVER_ROOT } from '../../config';
import { runSimulation } from '../../sim/service';
import { requireBoard, requireComponent } from '../helpers';
import { S, ToolError, type ToolContext, type ToolDef } from '../registry';
import { resolveTarget } from './sim';

const run = promisify(execFile);

export function addFirmware(ctx: ToolContext, name: string, bytes: Buffer, target?: string, notes?: string): FirmwareImage {
  const lower = name.toLowerCase();
  const format: FirmwareImage['format'] = lower.endsWith('.hex') || lower.endsWith('.ihex') ? 'hex' : lower.endsWith('.uf2') ? 'uf2' : lower.endsWith('.elf') ? 'elf' : 'bin';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fw: FirmwareImage = {
    id: newId('fw'),
    name,
    format,
    size: bytes.length,
    sha256,
    assetId: `fw_${sha256.slice(0, 16)}.${format}`,
    target: target ?? (format === 'uf2' ? 'rp2040' : format === 'hex' ? 'avr:atmega328p' : undefined),
    uploadedAt: nowIso(),
    notes,
  };
  ctx.services.store.putAsset(ctx.session.id, fw.assetId, bytes);
  ctx.session.mutate(ctx, 'firmware', (p) => {
    p.firmware.push(fw);
    return `Added firmware ${name} (${bytes.length} bytes, ${format})`;
  });
  return fw;
}

/** MCUs that have firmware assigned (instance override, else part default). */
export function firmwareMap(ctx: ToolContext, p: Project, boardIds?: string[]) {
  const out: Record<string, { bytes: Uint8Array; format: FirmwareImage['format']; name: string }> = {};
  const missing: string[] = [];
  for (const b of p.boards) {
    if (boardIds && !boardIds.includes(b.id)) continue;
    for (const c of b.components) {
      const part = p.parts[c.partId];
      if (part?.sim?.kind !== 'mcu' && !c.mcu?.emulator) continue;
      const fwId = c.mcu?.firmwareId ?? (part?.sim?.kind === 'mcu' ? part.sim.firmwareId : undefined);
      if (!fwId) {
        missing.push(`${b.name}:${c.ref}`);
        continue;
      }
      const fw = p.firmware.find((f) => f.id === fwId);
      const bytes = fw ? ctx.services.store.getAsset(p.id, fw.assetId) : null;
      if (!fw || !bytes) {
        missing.push(`${b.name}:${c.ref} (firmware ${fwId} missing)`);
        continue;
      }
      out[c.id] = { bytes: new Uint8Array(bytes), format: fw.format, name: fw.name };
    }
  }
  return { firmware: out, missing };
}

function scriptingApiDoc(): string {
  const candidates = [path.join(REPO_ROOT, 'packages', 'sim', 'src', 'mixed', 'README.md'), path.join(SERVER_ROOT, 'dist', 'scripting-api.md')];
  for (const c of candidates) if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  return 'Scripting API documentation not found.';
}

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    return stdout.trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

export const firmwareTools: ToolDef[] = [
  {
    name: 'list_firmware',
    title: 'Firmware images',
    group: 'firmware',
    description: 'List firmware images uploaded by the user or built by you, and which MCU components use them.',
    inputSchema: S.obj({}),
    handler: (ctx) => {
      const p = ctx.session.project;
      if (!p.firmware.length) return 'No firmware yet. The user can upload .hex/.bin/.uf2 files in the Firmware tab, or use build_firmware (AVR) to compile C sources.';
      const users = new Map<string, string[]>();
      for (const b of p.boards)
        for (const c of b.components) {
          const part = p.parts[c.partId];
          const fw = c.mcu?.firmwareId ?? (part?.sim?.kind === 'mcu' ? part.sim.firmwareId : undefined);
          if (fw) users.set(fw, [...(users.get(fw) ?? []), `${b.name}:${c.ref}`]);
        }
      return p.firmware.map((f) => `${f.id} | ${f.name} | ${f.format} | ${f.size} B | target ${f.target ?? '?'} | used by ${users.get(f.id)?.join(', ') ?? '—'}${f.notes ? ` | ${f.notes}` : ''}`).join('\n');
    },
  },
  {
    name: 'configure_mcu',
    title: 'Configure MCU emulation',
    group: 'firmware',
    description:
      'Configure an MCU component for firmware-in-the-loop simulation: emulator ("avr:atmega328p" via avr8js, "rp2040" via rp2040js, or "script:<behaviorId>" for an emulator you write with write_behavior_script kind "mcu-emulator"), firmware image id and clock.',
    inputSchema: S.obj({ boardId: S.str(), ref: S.str(), emulator: S.str(), firmwareId: S.str(), clockHz: S.num() }, ['boardId', 'ref']),
    handler: (ctx, a: { boardId: string; ref: string; emulator?: string; firmwareId?: string; clockHz?: number }) => {
      const p = ctx.session.project;
      const b = requireBoard(p, a.boardId);
      const c = requireComponent(b, a.ref);
      if (a.firmwareId && !p.firmware.some((f) => f.id === a.firmwareId || f.name === a.firmwareId)) throw new ToolError(`Firmware ${a.firmwareId} not found (list_firmware)`);
      const fwId = a.firmwareId ? p.firmware.find((f) => f.id === a.firmwareId || f.name === a.firmwareId)!.id : undefined;
      if (a.emulator?.startsWith('script:') && !p.behaviors.some((s) => `script:${s.id}` === a.emulator)) throw new ToolError(`No behaviour script ${a.emulator.slice(7)}`);
      ctx.session.mutate(ctx, 'configure_mcu', () => {
        c.mcu = { ...c.mcu, ...(a.emulator ? { emulator: a.emulator } : {}), ...(fwId ? { firmwareId: fwId } : {}), ...(a.clockHz ? { clockHz: a.clockHz } : {}) };
        return `Configured ${c.ref} emulation (${c.mcu.emulator ?? 'part default'}${fwId ? `, firmware ${fwId}` : ''})`;
      });
      const part = p.parts[c.partId];
      return `MCU ${c.ref}: emulator ${c.mcu?.emulator ?? (part?.sim?.kind === 'mcu' ? part.sim.emulator : 'none')}, firmware ${c.mcu?.firmwareId ?? 'none'}, clock ${c.mcu?.clockHz ?? (part?.sim?.kind === 'mcu' ? part.sim.clockHz : '?')} Hz.`;
    },
  },
  {
    name: 'get_scripting_api',
    title: 'Behaviour scripting API',
    group: 'firmware',
    description: 'Documentation of the JavaScript API for chip behaviour scripts (I2C/SPI/UART/GPIO models of non-MCU ICs) and custom MCU emulator scripts, with examples. Read before write_behavior_script.',
    inputSchema: S.obj({}),
    handler: () => scriptingApiDoc(),
  },
  {
    name: 'write_behavior_script',
    title: 'Write behaviour script',
    group: 'firmware',
    description:
      'Create or update a JavaScript behaviour model: kind "chip" for ICs that are not MCUs (sensors, drivers, shift registers, EEPROMs, displays) — simulated at pin/bus level alongside the MCU firmware; kind "mcu-emulator" for a CPU emulator that loads a real firmware binary. The code is validated in a sandbox. Assign it to components (refs) or to a part (all instances). Built-ins: builtin:bme280, builtin:74hc595, builtin:24c02, builtin:ssd1306.',
    inputSchema: S.obj(
      {
        id: S.str('Script id (update if exists)'),
        name: S.str(),
        kind: S.enum(['chip', 'mcu-emulator']),
        code: S.str('JavaScript source per get_scripting_api'),
        description: S.str(),
        builtin: S.str('Use a builtin script instead of code, e.g. "builtin:bme280"'),
        assign: S.arr(S.obj({ boardId: S.str(), ref: S.str() }, ['ref'])),
        partId: S.str('Assign as the default model of this part'),
      },
      ['name'],
    ),
    handler: (ctx, a: { id?: string; name: string; kind?: 'chip' | 'mcu-emulator'; code?: string; description?: string; builtin?: string; assign?: { boardId?: string; ref: string }[]; partId?: string }) => {
      const p = ctx.session.project;
      let script: BehaviorScript;
      if (a.builtin) {
        const b = BUILTIN_BEHAVIORS.find((s: BehaviorScript) => s.id === a.builtin);
        if (!b) throw new ToolError(`Unknown builtin ${a.builtin}. Available: ${BUILTIN_BEHAVIORS.map((s: BehaviorScript) => s.id).join(', ')}`);
        script = { ...b };
      } else {
        if (!a.code) throw new ToolError('Provide code or builtin');
        const kind = a.kind ?? 'chip';
        const v = validateBehaviorScript(a.code, kind);
        if (!v.ok) return { text: `Script rejected:\n- ${v.errors.join('\n- ')}`, isError: true };
        script = { id: a.id ?? newId('bhv'), name: a.name, kind, code: a.code, description: a.description, updatedAt: nowIso(), author: ctx.actor === 'user' ? 'user' : 'agent' };
      }
      const assigned: string[] = [];
      ctx.session.mutate(ctx, 'write_behavior_script', (pr) => {
        const i = pr.behaviors.findIndex((s) => s.id === script.id);
        if (i >= 0) pr.behaviors[i] = script;
        else pr.behaviors.push(script);
        for (const as of a.assign ?? []) {
          const b = requireBoard(pr, as.boardId);
          const c = requireComponent(b, as.ref);
          if (script.kind === 'mcu-emulator') c.mcu = { ...c.mcu, emulator: `script:${script.id}` };
          else c.behaviorId = script.id;
          assigned.push(`${b.name}:${c.ref}`);
        }
        if (a.partId) {
          const part = pr.parts[a.partId];
          if (!part) throw new ToolError(`Part ${a.partId} not in library`);
          if (script.kind === 'chip') {
            const prev = part.sim?.kind === 'ic' ? part.sim : undefined;
            const supply = part.pins.filter((x) => x.type === 'power_in' && !/gnd|vss/i.test(x.name)).map((x) => x.number);
            const ground = part.pins.filter((x) => /gnd|vss/i.test(x.name)).map((x) => x.number);
            part.sim = { kind: 'ic', supplyPins: prev?.supplyPins ?? supply, groundPins: prev?.groundPins ?? ground, Icc: prev?.Icc ?? 0.001, behaviorId: script.id };
          } else if (part.sim?.kind === 'mcu') part.sim.emulator = `script:${script.id}`;
          assigned.push(`part ${part.mpn}`);
        }
        return `Saved behaviour script ${script.name}${assigned.length ? ` → ${assigned.join(', ')}` : ''}`;
      });
      return `Script ${script.name} [${script.id}] (${script.kind}) saved${assigned.length ? `, assigned to ${assigned.join(', ')}` : ''}.`;
    },
  },
  {
    name: 'build_firmware',
    title: 'Build firmware (AVR)',
    group: 'firmware',
    description:
      'Compile C firmware for AVR (ATmega328P etc.) with the locally installed avr-gcc + avr-libc, producing an Intel HEX image added to the project (optionally assigned to an MCU). Use for firmware-in-the-loop tests when the user has not supplied a binary. Returns compiler errors if any.',
    inputSchema: S.obj(
      {
        name: S.str('Image name, e.g. "env-sensor"'),
        mcu: S.str('avr-gcc -mmcu value (default atmega328p)'),
        fCpu: S.num('F_CPU Hz (default 16000000)'),
        sources: S.any('{"main.c": "<source>", ...}'),
        assign: S.obj({ boardId: S.str(), ref: S.str() }, ['ref']),
      },
      ['name', 'sources'],
    ),
    slow: true,
    handler: async (ctx, a: { name: string; mcu?: string; fCpu?: number; sources: Record<string, string>; assign?: { boardId?: string; ref: string } }) => {
      const gcc = await which('avr-gcc');
      const objcopy = await which('avr-objcopy');
      if (!gcc || !objcopy) throw new ToolError('avr-gcc/avr-objcopy not found on this machine. Ask the user to install the AVR toolchain (e.g. `apt install gcc-avr avr-libc` or `brew install avr-gcc`) or to upload a compiled .hex.');
      const mcu = a.mcu ?? 'atmega328p';
      if (!/^[a-z0-9]+$/i.test(mcu)) throw new ToolError('invalid mcu');
      const dir = path.join(ctx.services.store.workspaceDir(ctx.session.id), 'firmware', a.name.replace(/[^A-Za-z0-9_-]/g, '_'));
      fs.mkdirSync(dir, { recursive: true });
      const cFiles: string[] = [];
      for (const [file, src] of Object.entries(a.sources)) {
        const safe = path.basename(file);
        if (!/\.(c|h|S)$/.test(safe)) throw new ToolError(`Unsupported source ${file}`);
        fs.writeFileSync(path.join(dir, safe), src);
        if (safe.endsWith('.c') || safe.endsWith('.S')) cFiles.push(safe);
      }
      if (!cFiles.length) throw new ToolError('No .c sources');
      const elf = path.join(dir, `${a.name}.elf`);
      const hex = path.join(dir, `${a.name}.hex`);
      try {
        await run(gcc, ['-mmcu=' + mcu, `-DF_CPU=${a.fCpu ?? 16000000}UL`, '-Os', '-std=gnu11', '-Wall', '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections', '-o', elf, ...cFiles], { cwd: dir, timeout: 60_000 });
        await run(objcopy, ['-O', 'ihex', '-R', '.eeprom', elf, hex], { cwd: dir, timeout: 30_000 });
      } catch (e: any) {
        return { text: `Compilation failed:\n${String(e.stderr ?? e.message).slice(0, 4000)}`, isError: true };
      }
      let size = '';
      try {
        const avrSize = await which('avr-size');
        if (avrSize) size = (await run(avrSize, [elf])).stdout.trim();
      } catch {
        /* optional */
      }
      const fw = addFirmware(ctx, `${a.name}.hex`, fs.readFileSync(hex), `avr:${mcu}`, `Built from ${cFiles.join(', ')} with avr-gcc`);
      if (a.assign) {
        const b = requireBoard(ctx.session.project, a.assign.boardId);
        const c = requireComponent(b, a.assign.ref);
        ctx.session.mutate(ctx, 'configure_mcu', () => {
          c.mcu = { ...c.mcu, firmwareId: fw.id };
          return `Assigned ${fw.name} to ${c.ref}`;
        });
      }
      return `Built ${fw.name} [${fw.id}] (${fw.size} bytes hex).${size ? `\n${size}` : ''}${a.assign ? `\nAssigned to ${a.assign.ref}.` : ''}`;
    },
  },
  {
    name: 'run_firmware_simulation',
    title: 'Firmware-in-the-loop simulation',
    group: 'firmware',
    description:
      'Mixed-signal co-simulation: MCUs run their real firmware in emulators, chip behaviour scripts respond on I2C/SPI/UART/GPIO, and the analog circuit is solved around them (LED currents, pull-ups, ADC voltages). Returns UART console output, GPIO activity, LED duty and power. Set environment conditions for sensor models.',
    inputSchema: S.obj(
      {
        target: S.str('Board id/name or "system"'),
        duration: S.num('Simulated seconds (default 1, max 20)'),
        uartInput: S.any('{ref: "text sent to the MCU UART"}'),
        environment: S.obj({ temperatureC: S.num(), pressurePa: S.num(), humidityPct: S.num() }),
      },
    ),
    slow: true,
    handler: async (ctx, a: { target?: string; duration?: number; uartInput?: Record<string, string>; environment?: { temperatureC?: number; pressurePa?: number; humidityPct?: number } }) => {
      const p = ctx.session.project;
      const t = resolveTarget(p, a.target);
      const boardIds = 'boardId' in t.target ? [t.target.boardId] : undefined;
      const { firmware, missing } = firmwareMap(ctx, p, boardIds);
      if (!Object.keys(firmware).length) throw new ToolError(`No MCU has firmware assigned${missing.length ? ` (${missing.join(', ')})` : ''}. Upload firmware in the UI, or build_firmware, then configure_mcu.`);
      const uartInput: Record<string, string> = {};
      for (const [ref, text] of Object.entries(a.uartInput ?? {})) {
        for (const b of p.boards) {
          const c = b.components.find((x) => x.ref === ref);
          if (c) uartInput[c.id] = text;
        }
      }
      const duration = Math.min(20, Math.max(0.001, a.duration ?? 1));
      const { out } = await runSimulation(ctx, {
        kind: 'mixed-signal',
        title: `Firmware simulation ${duration}s — ${t.label}`,
        target: 'system' in t.target ? { system: true } : { boardId: t.target.boardId },
        params: { duration, environment: a.environment },
        task: 'mixed',
        payload: { project: p, target: t.target, duration, firmware, behaviors: p.behaviors, uartInput, environment: a.environment },
        timeoutMs: 10 * 60_000,
      });
      return [out.text, missing.length ? `MCUs without firmware (held idle): ${missing.join(', ')}` : ''].filter(Boolean).join('\n');
    },
  },
];
