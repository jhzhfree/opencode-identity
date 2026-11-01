/**
 * Bridge to @opencode-identity/sdk for the MCP server program.
 *
 * Resolution order (first hit wins):
 *   1. IDENTITY_SDK_DIR                — explicit override
 *   2. <app>/vendor/identity-sdk       — portable bundle built by scripts/build-dist.mjs
 *   3. <repo>/packages/identity-sdk    — git checkout
 *   4. node_modules/@opencode-identity/sdk — installed as a dependency
 *
 * No npm install is required for cases 2 and 3.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;

const CANDIDATES = () => [
  process.env.IDENTITY_SDK_DIR,
  path.resolve(HERE, '../vendor/identity-sdk'),
  path.resolve(HERE, '../../../packages/identity-sdk'),
  path.resolve(HERE, '../../node_modules/@opencode-identity/sdk'),
  path.resolve(HERE, '../../../node_modules/@opencode-identity/sdk'),
].filter(Boolean);

export function resolveSdkDir() {
  for (const dir of CANDIDATES()) {
    if (existsSync(path.join(dir, 'src', 'index.mjs'))) return dir;
  }
  return null;
}

export const SDK_DIR = resolveSdkDir();
export const SDK_FOUND = Boolean(SDK_DIR);

let loaded = null;

export async function sdk() {
  if (!SDK_FOUND) {
    throw new Error('identity-sdk 未找到；请设置 IDENTITY_SDK_DIR 指向 packages/identity-sdk（或使用 dist 便携包）');
  }
  if (!loaded) loaded = import(pathToFileURL(path.join(SDK_DIR, 'src', 'index.mjs')).href);
  return loaded;
}

export function sdkInfo() {
  return { found: SDK_FOUND, dir: SDK_DIR };
}
