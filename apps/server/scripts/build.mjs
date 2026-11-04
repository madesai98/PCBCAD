// Production build of the PCBCAD bridge: bundles the server + worker with esbuild and copies the
// web app, MCP proxy and docs next to it.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..', '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const external = ['ws', 'manifold-3d', 'avr8js', 'rp2040js', 'fflate', 'clipper-lib', 'bufferutil', 'utf-8-validate'];
const banner = {
  js: "import { createRequire as __pcbcadCreateRequire } from 'node:module'; const require = __pcbcadCreateRequire(import.meta.url);",
};

const common = { bundle: true, platform: 'node', format: 'esm', target: 'node20', external, banner, sourcemap: true, logLevel: 'info' };

await build({ ...common, entryPoints: [path.join(root, 'src', 'cli.ts')], outfile: path.join(dist, 'cli.js') });
await build({ ...common, entryPoints: [path.join(root, 'src', 'sim', 'worker.ts')], outfile: path.join(dist, 'sim-worker.js') });

fs.copyFileSync(path.join(root, 'mcp', 'pcbcad-mcp.mjs'), path.join(dist, 'pcbcad-mcp.mjs'));
const api = path.join(repo, 'packages', 'sim', 'src', 'mixed', 'README.md');
if (fs.existsSync(api)) fs.copyFileSync(api, path.join(dist, 'scripting-api.md'));
const web = path.join(repo, 'apps', 'web', 'dist');
if (fs.existsSync(web)) fs.cpSync(web, path.join(dist, 'web'), { recursive: true });
else console.warn('! apps/web/dist not found — run the web build first (npm run build at the repo root does both).');
fs.chmodSync(path.join(dist, 'cli.js'), 0o755);
console.log(`Built PCBCAD bridge → ${path.relative(repo, dist)}`);
