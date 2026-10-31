/**
 * Signed JSON-RPC client.
 *
 * Used by three callers that must behave identically:
 *  - the Studio verification panel,
 *  - the generated `verify.ps1` / SDK CLI on a deployed machine,
 *  - any custom integration that wants to speak the same protocol.
 *
 * Signing is delegated to `createProof`; this module only handles config
 * validation, key loading and transport.
 */
import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.mjs';
import { HEADER, assertLocalEndpoint, createProof } from './proof.mjs';
import { UUID_PATTERN, generateUuid } from './uuid.mjs';
import { AGENT_PATTERN } from './identity.mjs';
import { importPrivateKey } from './keys.mjs';

/** Refuse to read anything larger than this as key material. */
const MAX_KEY_BYTES = 1024 * 1024;

/**
 * Validate a terminal config object (`terminal-config.json`).
 * @param {unknown} value
 * @returns {Readonly<{ version: 1, serverUrl: string, workspaceRoot: string, legacyReadOnly: boolean, agents: ReadonlyArray<any> }>}
 */
export function validateTerminalConfig(value) {
  if (!value || typeof value !== 'object') fail('CONFIG_INVALID', 'Invalid terminal config');
  const config = /** @type {any} */ (value);
  if (config.version !== 1) fail('CONFIG_INVALID', 'Unsupported terminal config version');
  if (config.legacyReadOnly !== undefined && typeof config.legacyReadOnly !== 'boolean') fail('CONFIG_INVALID', 'legacyReadOnly must be a boolean');
  if (!Array.isArray(config.agents) || config.agents.length === 0 || config.agents.length > 100) fail('CONFIG_INVALID', 'Invalid Agent list');
  if (typeof config.workspaceRoot !== 'string' || !path.isAbsolute(config.workspaceRoot)) fail('CONFIG_INVALID', 'workspaceRoot must be an absolute path');

  const names = new Set();
  const ids = new Set();
  for (const agent of config.agents) {
    if (!agent || typeof agent !== 'object') fail('CONFIG_INVALID', 'Invalid Agent entry');
    if (typeof agent.agentName !== 'string' || !AGENT_PATTERN.test(agent.agentName)) fail('CONFIG_INVALID', 'Invalid Agent name');
    if (typeof agent.uuid !== 'string' || !UUID_PATTERN.test(agent.uuid)) fail('CONFIG_INVALID', 'Invalid Agent UUID');
    if (typeof agent.privateKeyFile !== 'string' || !path.isAbsolute(agent.privateKeyFile)) fail('CONFIG_INVALID', 'privateKeyFile must be absolute');
    if (names.has(agent.agentName) || ids.has(agent.uuid)) fail('CONFIG_INVALID', 'Ambiguous Agent mapping');
    names.add(agent.agentName);
    ids.add(agent.uuid);
  }
  return Object.freeze({ ...config, serverUrl: assertLocalEndpoint(config.serverUrl) });
}

/**
 * @param {{ agents: ReadonlyArray<any> }} config
 * @param {string} agentName
 */
export function agentByName(config, agentName) {
  const agent = config.agents.find(a => a.agentName === agentName);
  if (!agent) fail('AGENT_NOT_CONFIGURED', `Agent not configured: ${agentName}`);
  return agent;
}

/**
 * Read private key material with cheap integrity checks: absolute path, regular
 * file, no symlink, size cap, and (when a workspace is supplied) outside that
 * workspace. Full ACL hardening stays with the generator that created the file.
 * @param {string} filename
 * @param {{ workspaceRoot?: string }} [options]
 * @returns {Promise<import('node:crypto').KeyObject>}
 */
export async function readPrivateKeyFile(filename, { workspaceRoot } = {}) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('KEY_PATH', 'Private key path must be absolute');
  if (workspaceRoot) {
    const [root, target] = await Promise.all([realpath(workspaceRoot), realpath(filename).catch(() => null)]);
    if (target) {
      const relative = path.relative(root, target);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        fail('KEY_LOCATION', 'Keep identity files outside the Agent workspace');
      }
    }
  }
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail('KEY_UNREADABLE', `Cannot open private key: ${filename}`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail('KEY_UNREADABLE', 'Private key path is not a regular file');
    if (stat.size > MAX_KEY_BYTES) fail('KEY_UNREADABLE', 'Private key file is too large');
    return importPrivateKey(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

/**
 * Create a client bound to one agent identity.
 * @param {{
 *   serverUrl: string, uuid: string, agentName: string, privateKey: unknown,
 *   sessionId?: string, timeoutMs?: number, fetchImpl?: typeof fetch,
 * }} input
 */
export function createSignedClient({ serverUrl, uuid, agentName, privateKey, sessionId = 'terminal', timeoutMs = 15000, fetchImpl = fetch }) {
  const url = assertLocalEndpoint(serverUrl);
  const key = importPrivateKey(privateKey);

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {{ invocationId?: string, signal?: AbortSignal }} [options]
   */
  async function rpc(method, params, { invocationId = generateUuid(), signal } = {}) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: generateUuid(), method, params }));
    const proof = createProof({ uuid, agentName, privateKey: key, url, body, sessionId, invocationId });
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      body,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', [HEADER]: proof },
      signal: combined,
    });
    if (!response.ok) fail('MCP_HTTP', `MCP rejected request (HTTP ${response.status})`);
    const text = await response.text();
    if (text.length > 1048576) fail('MCP_RESPONSE', 'MCP response too large');
    let parsed;
    try { parsed = JSON.parse(text); } catch { fail('MCP_RESPONSE', 'MCP response is not JSON'); }
    if (parsed.jsonrpc !== '2.0' || parsed.error || parsed.result?.isError) fail('MCP_ERROR', parsed.error?.message ?? 'Invalid MCP result');
    return parsed.result;
  }

  return {
    url,
    uuid,
    agentName,
    rpc,
    /** @param {string} name @param {Record<string, unknown>} args */
    callTool: (name, args) => rpc('tools/call', { name, arguments: args }),
    /** Returns the identity the server verified for this client. */
    async whoami() {
      const result = await rpc('tools/call', { name: 'whoami', arguments: {} });
      const identity = result.structuredContent?.identity;
      if (identity?.uuid !== uuid || identity?.agentName !== agentName || identity?.verified !== true) {
        fail('IDENTITY_MISMATCH', 'Server returned a mismatched identity');
      }
      return identity;
    },
  };
}

/**
 * One-shot helper: read the key from disk, build a client, run `whoami`.
 * @param {{ configFile?: string, config?: any, agentName: string, workspaceRoot?: string }} input
 */
export async function verifyAgent({ configFile, config, agentName, workspaceRoot }) {
  const loaded = config ?? validateTerminalConfig(JSON.parse(await readFile(/** @type {string} */ (configFile), 'utf8')));
  const agent = agentByName(loaded, agentName);
  const privateKey = await readPrivateKeyFile(agent.privateKeyFile, { workspaceRoot: workspaceRoot ?? loaded.workspaceRoot });
  const client = createSignedClient({ serverUrl: loaded.serverUrl, uuid: agent.uuid, agentName, privateKey });
  return { verified: true, identity: await client.whoami() };
}
