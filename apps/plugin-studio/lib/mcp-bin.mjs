/**
 * Locate the MCP server program (`apps/mcp-server/bin/serve.mjs`).
 *
 * The generator can start the server for you ("部署" step). That is a convenience,
 * not a dependency: the server ships as its own program and runs fine on its own.
 * In a portable bundle the server is vendored next to the app.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';

const HERE = import.meta.dirname;

const CANDIDATES = () => [
  process.env.IDENTITY_MCP_BIN,
  // Git checkout: <repo>/apps/plugin-studio/lib -> <repo>/apps/mcp-server/bin/serve.mjs
  path.resolve(HERE, '../../mcp-server/bin/serve.mjs'),
  // Portable bundle: <app>/vendor/mcp-server/bin/serve.mjs
  path.resolve(HERE, '../vendor/mcp-server/bin/serve.mjs'),
].filter(Boolean);

export function resolveMcpBin() {
  for (const candidate of CANDIDATES()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export const MCP_BIN = resolveMcpBin();
