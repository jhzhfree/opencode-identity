/**
 * Bridge to @opencode-identity/sdk.
 *
 * The SDK lives inside this repo (`studio/packages/identity-sdk`) so the tool is
 * self-contained, but an external installation can be pointed at via
 * `IDENTITY_SDK_DIR` — useful when the same SDK is shared with another product.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;

const CANDIDATES = () => [
  process.env.IDENTITY_SDK_DIR,
  path.resolve(HERE, '../packages/identity-sdk'),
  path.resolve(HERE, '../../node_modules/@opencode-identity/sdk'),
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
  if (!SDK_FOUND) throw new Error('identity-sdk 未找到；请设置 IDENTITY_SDK_DIR 指向 packages/identity-sdk');
  if (!loaded) loaded = import(pathToFileURL(path.join(SDK_DIR, 'src', 'index.mjs')).href);
  return loaded;
}

export function sdkInfo() {
  return { found: SDK_FOUND, dir: SDK_DIR };
}
