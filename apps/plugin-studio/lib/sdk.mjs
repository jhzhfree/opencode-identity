/**
 * Bridge to @opencode-identity/sdk.
 *
 * The SDK is a separate program in this repository (`packages/identity-sdk`),
 * but the same code also ships inside a portable bundle as `vendor/identity-sdk`
 * (see scripts/build-dist.mjs). Both layouts are searched, so the app works from
 * a git checkout and from a copied folder without `npm install`.
 *
 * Override with `IDENTITY_SDK_DIR` when the SDK is installed elsewhere.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;

const CANDIDATES = () => [
  process.env.IDENTITY_SDK_DIR,
  // Portable bundle: <app>/vendor/identity-sdk
  path.resolve(HERE, '../vendor/identity-sdk'),
  // Git checkout: <repo>/apps/<app>/lib -> <repo>/packages/identity-sdk
  path.resolve(HERE, '../../../packages/identity-sdk'),
  // npm / workspace install
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

/** Load the SDK once; the module is stateless so a single instance is safe. */
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
