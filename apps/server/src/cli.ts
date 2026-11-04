#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { defaultDataDir, findWebDist, VERSION } from './config';
import { startServer } from './server';

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) out[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* headless */
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(`PCBCAD ${VERSION} — agent-driven PCB + mechanical CAD

Usage: pcbcad [--port 4321] [--host 127.0.0.1] [--data-dir ~/.pcbcad] [--no-open]

Starts the local bridge (web UI + agent CLI orchestration + MCP tools) and opens the browser.
Agents: Claude Code (claude), Codex (codex), Gemini CLI (gemini) are detected on PATH.`);
    return;
  }
  const dev = !!args.dev;
  const cfg = {
    port: Number(args.port ?? process.env.PCBCAD_PORT ?? 4321),
    host: String(args.host ?? process.env.PCBCAD_HOST ?? '127.0.0.1'),
    dataDir: path.resolve(String(args['data-dir'] ?? (dev && !process.env.PCBCAD_DATA_DIR ? path.join(process.cwd(), '..', '..', '.pcbcad-data') : defaultDataDir()))),
    dev,
    open: !args['no-open'] && !process.env.CI,
    webDist: dev ? null : findWebDist(),
  };
  const srv = await startServer(cfg);
  const webUrl = dev ? 'http://127.0.0.1:5173' : srv.url;
  console.log(`\n  PCBCAD ${VERSION}\n  ➜ UI:      ${webUrl}\n  ➜ Bridge:  ${srv.url}\n  ➜ Data:    ${cfg.dataDir}\n`);
  const providers = await srv.agents.providers();
  for (const p of providers) console.log(`  ${p.available ? '●' : '○'} ${p.name}${p.version ? ` ${p.version}` : ''}${p.available ? '' : ` — ${p.hint ?? 'not found'}`}`);
  console.log('');
  if (cfg.open) openBrowser(webUrl);
  const shutdown = async () => {
    await srv.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
