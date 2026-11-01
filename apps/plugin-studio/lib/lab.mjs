/**
 * Bridge to the vendored identity-lab templates (plugin generator).
 *
 * `vendor/identity-lab` is a copy of the upstream `mcp-agent-identity-lab`
 * runtime (see vendor/identity-lab/NOTICE.md). It used to be resolved from a
 * sibling `1.1.0/` directory outside the repository, which made this app
 * impossible to move or ship on its own. Override with `IDENTITY_LAB_DIR`.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;

const CANDIDATES = () => [
  process.env.IDENTITY_LAB_DIR,
  // Portable bundle: <app>/vendor/identity-lab
  path.resolve(HERE, '../vendor/identity-lab'),
  // Git checkout: <repo>/apps/plugin-studio/lib -> <repo>/vendor/identity-lab
  path.resolve(HERE, '../../../vendor/identity-lab'),
].filter(Boolean);

export function resolveLabDir() {
  for (const dir of CANDIDATES()) {
    if (existsSync(path.join(dir, 'lib', 'generator.mjs')) && existsSync(path.join(dir, 'bin', 'lab.mjs'))) return dir;
  }
  return null;
}

export const LAB_DIR = resolveLabDir();
export const LAB_FOUND = Boolean(LAB_DIR);

const cache = new Map();
export async function lab(file) {
  if (!LAB_DIR) throw new Error('identity-lab 未找到；请设置 IDENTITY_LAB_DIR 指向 vendor/identity-lab');
  if (!cache.has(file)) cache.set(file, import(pathToFileURL(path.join(LAB_DIR, 'lib', file)).href));
  return cache.get(file);
}

export function labInfo() {
  return { found: LAB_FOUND, dir: LAB_DIR, bin: LAB_DIR ? path.join(LAB_DIR, 'bin', 'lab.mjs') : null };
}
