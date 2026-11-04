import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProviderId } from '@pcbcad/core';

export const VERSION = '0.1.0';

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  dev: boolean;
  open: boolean;
  /** Directory with the built web app (index.html). */
  webDist: string | null;
}

export interface Settings {
  defaultProvider: ProviderId;
  defaultModels: Partial<Record<ProviderId, string>>;
  /** Override executable paths for provider CLIs. */
  providerPaths: Partial<Record<ProviderId, string>>;
  /** Optional distributor API keys (used in addition to the keyless JLCPCB/LCSC/EasyEDA sources). */
  mouserApiKey?: string;
  /** Allow agents to use web search / fetch for datasheets. */
  allowWebResearch: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultProvider: 'claude',
  defaultModels: {},
  providerPaths: {},
  allowWebResearch: true,
};

export function defaultDataDir(): string {
  if (process.env.PCBCAD_DATA_DIR) return path.resolve(process.env.PCBCAD_DATA_DIR);
  return path.join(os.homedir(), '.pcbcad');
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** apps/server root (works from src/ in dev and dist/ in production). */
export const SERVER_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..');

export function findWebDist(): string | null {
  const candidates = [
    process.env.PCBCAD_WEB_DIST,
    path.join(SERVER_ROOT, 'dist', 'web'),
    path.join(REPO_ROOT, 'apps', 'web', 'dist'),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'index.html'))) return c;
  return null;
}

/** Path to the dependency-free MCP stdio proxy that agent CLIs spawn. */
export function mcpProxyPath(): string {
  const candidates = [path.join(SERVER_ROOT, 'mcp', 'pcbcad-mcp.mjs'), path.join(SERVER_ROOT, 'dist', 'pcbcad-mcp.mjs')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}
