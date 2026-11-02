/**
 * Build three portable programs under `dist/`.
 *
 * Each folder is self-contained: copy it anywhere with Node 22+ installed and run
 * `start.cmd` (Windows) or `start.sh` (macOS/Linux). No npm install, no git
 * checkout, no sibling directories.
 *
 *   dist/plugin-studio/   -> /api/status, UI on http://127.0.0.1:4180
 *   dist/mcp-server/      -> node bin/serve.mjs --registry <file>
 *   dist/sdk/             -> node bin/sdk.mjs (no args = interactive menu)
 *
 * The generator and the server both carry their own copy of the SDK vendor
 * folder, so they stay independent even if you delete one of the others.
 */
import { cp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

const ignore = source => /[\\/](node_modules|\.git|test|dist)([\\/]|$)/.test(source);

async function copy(from, to) {
  await cp(path.join(ROOT, from), path.join(DIST, to), {
    recursive: true,
    filter: source => !ignore(source.replace(ROOT, '')),
  });
}

async function stampManifest(target, manifest) {
  const file = path.join(DIST, target, 'package.json');
  const current = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, `${JSON.stringify({ ...current, ...manifest }, null, 2)}\n`, 'utf8');
}

async function main() {
  if (await stat(DIST).catch(() => null)) await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // 1. SDK — no dependencies at all.
  await copy('packages/identity-sdk', 'sdk');
  await copy('packages/identity-sdk/start.cmd', 'sdk/start.cmd');
  await copy('packages/identity-sdk/start.sh', 'sdk/start.sh');
  await stampManifest('sdk', { name: '@opencode-identity/sdk', private: true });

  // 2. MCP server — vendored SDK only.
  await copy('apps/mcp-server', 'mcp-server');
  await copy('apps/mcp-server/start.cmd', 'mcp-server/start.cmd');
  await copy('apps/mcp-server/start.sh', 'mcp-server/start.sh');
  await copy('packages/identity-sdk', 'mcp-server/vendor/identity-sdk');
  await stampManifest('mcp-server', { name: '@opencode-identity/mcp-server', private: true });

  // 3. Plugin generator — vendored SDK, plugin templates and MCP server.
  await copy('apps/plugin-studio', 'plugin-studio');
  await copy('apps/plugin-studio/start.cmd', 'plugin-studio/start.cmd');
  await copy('apps/plugin-studio/start.sh', 'plugin-studio/start.sh');
  await copy('packages/identity-sdk', 'plugin-studio/vendor/identity-sdk');
  await copy('vendor/identity-lab', 'plugin-studio/vendor/identity-lab');
  await copy('apps/mcp-server', 'plugin-studio/vendor/mcp-server');
  await stampManifest('plugin-studio', { name: '@opencode-identity/plugin-studio', private: true });

  const sizes = [];
  for (const name of ['plugin-studio', 'mcp-server', 'sdk']) {
    sizes.push(`${name}: ${(await dirSize(path.join(DIST, name)) / 1024).toFixed(0)} KB`);
  }
  process.stdout.write(`dist ready -> ${DIST}\n${sizes.join('\n')}\n`);
}

async function dirSize(dir) {
  const entries = await (await import('node:fs/promises')).readdir(dir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(full) : (await stat(full)).size;
  }
  return total;
}

await main();
