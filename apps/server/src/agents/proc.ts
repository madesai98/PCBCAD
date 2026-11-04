import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  aborted: boolean;
}

/** Locate an executable on PATH (adds .cmd/.exe on Windows). */
export function findExecutable(name: string, override?: string): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extra = process.platform === 'win32' ? [] : [path.join(process.env.HOME ?? '', '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(process.env.HOME ?? '', '.npm-global', 'bin'), path.join(process.env.HOME ?? '', '.bun', 'bin')];
  for (const d of [...dirs, ...extra]) {
    for (const e of exts) {
      const f = path.join(d, name + e);
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/** Run a command and capture stdout (for --version / --help probes). */
export function capture(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { shell: process.platform === 'win32', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e) });
      return;
    }
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, stdout, stderr: stderr + String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Spawn a CLI that emits JSON lines on stdout. Each parsed object goes to onJson; non-JSON
 * lines go to onText. Writes `stdin` then closes it. Kills the process tree on abort.
 */
export function runJsonLines(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; stdin?: string; signal: AbortSignal; onJson: (o: any) => void; onText?: (line: string) => void },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stderr = '';
    let aborted = false;
    const kill = () => {
      aborted = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }, 3000).unref();
    };
    if (opts.signal.aborted) kill();
    opts.signal.addEventListener('abort', kill, { once: true });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      if (s.startsWith('{') || s.startsWith('[')) {
        try {
          opts.onJson(JSON.parse(s));
          return;
        } catch {
          /* fall through */
        }
      }
      opts.onText?.(s);
    });
    child.on('error', (e) => {
      stderr += `\n${e.message}`;
    });
    child.on('close', (code, signal) => {
      opts.signal.removeEventListener('abort', kill);
      resolve({ code, signal, stderr, aborted });
    });
    if (opts.stdin != null) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}
