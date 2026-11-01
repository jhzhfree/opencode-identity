import { constants } from 'node:fs';
import { mkdir, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { protectionPolicy } from './protection.mjs';
const policy = protectionPolicy();
export function outside(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
export async function protectedRead(filename, workspace) {
  if (!path.isAbsolute(filename)) throw new Error('Identity paths must be absolute');
  await policy.verifyParents(path.dirname(filename)); await policy.verifyFile(filename);
  if (workspace && !outside(await realpath(workspace), await realpath(filename))) throw new Error('Keep identity files outside the Agent workspace');
  const f = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await f.stat(); policy.verifyHandle(stat);
    if (stat.size > 1048576) throw new Error('Identity file too large');
    return await f.readFile('utf8');
  } finally { await f.close(); }
}
export async function newDirectory(directory, workspace) {
  if (!path.isAbsolute(directory)) throw new Error('Use an absolute directory');
  await policy.verifyParents(path.dirname(directory));
  const actual = path.join(await realpath(path.dirname(directory)), path.basename(directory));
  if (workspace && !outside(await realpath(workspace), actual)) throw new Error('Keep identity files outside the Agent workspace');
  await mkdir(directory, { mode: 0o700 });
  try { await policy.harden(directory, 'directory'); await policy.verifyDirectory(directory); }
  catch (e) { await rm(directory, { recursive: true, force: true }); throw e; }
}
export async function newFile(filename, contents) {
  await policy.verifyParents(path.dirname(filename)); await policy.verifyDirectory(path.dirname(filename));
  const f = await open(filename, 'wx', 0o600);
  try { await policy.harden(filename, 'file'); await policy.verifyFile(filename); await f.writeFile(contents); await f.sync(); }
  finally { await f.close(); }
}
export const readJSON = async (filename, workspace) => JSON.parse(await protectedRead(filename, workspace));
export const writeJSON = (filename, value) => newFile(filename, JSON.stringify(value, null, 2) + '\n');
