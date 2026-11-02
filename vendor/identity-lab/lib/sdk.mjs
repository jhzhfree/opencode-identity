import path from 'node:path';
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const candidates = [process.env.IDENTITY_SDK_DIR, path.resolve(import.meta.dirname,'identity-sdk'), path.resolve(import.meta.dirname,'../../identity-sdk'), path.resolve(import.meta.dirname,'../../../packages/identity-sdk')].filter(Boolean);
const root = candidates.find(p => existsSync(path.join(p,'src/index.mjs')));
if (!root) throw new Error('Identity SDK missing from plugin runtime');
export const S = await import(pathToFileURL(path.join(root,'src/index.mjs')).href);
