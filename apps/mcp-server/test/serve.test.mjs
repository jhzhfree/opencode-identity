/**
 * Program #3 smoke test: the MCP server must run as its own process.
 *
 * The test generates an identity with the SDK (program #2), writes a registry,
 * launches `bin/serve.mjs` exactly like `start-mcp.cmd` does, then talks to it
 * over HTTP with a signed client. Nothing from the plugin generator is involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  createAgentIdentity,
  createSignedClient,
  validateRegistry,
} from '../../../packages/identity-sdk/src/index.mjs';

const SERVE = path.resolve(import.meta.dirname, '..', 'bin', 'serve.mjs');

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {any} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}

/** Launch the program and resolve once it prints its ready line. */
async function startServer(registryFile, port, extraArgs = []) {
  const child = spawn(process.execPath, [SERVE, '--registry', registryFile, '--port', String(port), '--quiet', ...extraArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not become ready:\n${log}`)), 20000);
    const onData = chunk => {
      log += chunk.toString('utf8');
      if (log.includes('[ready]')) { clearTimeout(timer); resolve(undefined); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${log}`)); });
  });
  return { child, ready, log: () => log };
}

test('MCP server program verifies a signed request and rejects an unsigned one', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-program-'));
  const identity = await createAgentIdentity({ agentName: 'build' });
  const registryFile = path.join(root, 'registry.json');
  const registry = validateRegistry({ version: 1, agents: [identity.enrollment] }, { requireAttestation: true });
  await writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  const port = await freePort();
  const { child, ready, log } = await startServer(registryFile, port);
  t.after(async () => { child.kill(); });

  await ready;

  const client = createSignedClient({
    serverUrl: `http://127.0.0.1:${port}/mcp`,
    uuid: identity.uuid,
    agentName: identity.agentName,
    privateKey: identity.privatePem,
  });

  const who = await client.whoami();
  assert.equal(who.uuid, identity.uuid);
  assert.equal(who.agentName, 'build');
  assert.equal(who.kid, identity.kid);
  assert.equal(who.verified, true);

  const sum = await client.callTool('add', { a: 2, b: 5 });
  assert.equal(sum.structuredContent.sum, 7);

  // Health endpoint stays public (loopback only) and reports the registry state.
  const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  // No proof header → 401, and the tool is never executed.
  const unsigned = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(unsigned.status, 401);

  // Foreign Host header → 403 before any crypto work. `fetch` refuses to send a
  // custom Host header, so this one goes through node:http.
  const wrongHost = await rawGet(port, '/health', 'example.com');
  assert.equal(wrongHost, 403);

  assert.match(log(), /agents=1/);
});

test('identity context: available inside a request, rejected outside', async () => {
  const { runWithIdentity, currentIdentity } = await import('../lib/context.mjs');

  assert.throws(() => currentIdentity(), /No verified caller identity/);

  const identity = Object.freeze({ uuid: 'u1', agentName: 'build', verified: true });
  assert.equal(runWithIdentity(identity, () => currentIdentity()), identity);

  // The store survives awaits inside the same request chain.
  await runWithIdentity(identity, async () => {
    await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(currentIdentity(), identity);
  });

  assert.throws(() => currentIdentity(), /No verified caller identity/);

  // Anything that is not the frozen verifyProof() output is refused.
  await assert.rejects(() => runWithIdentity({ uuid: 'u2', verified: true }, async () => currentIdentity()),
    /No verified caller identity/);
});

test('business tools (--tools) see the verified identity from deep layers', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-extra-tools-'));
  const identity = await createAgentIdentity({ agentName: 'plan' });
  const registryFile = path.join(root, 'registry.json');
  const registry = validateRegistry({ version: 1, agents: [identity.enrollment] }, { requireAttestation: true });
  await writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  // A business module that never touches its `context` argument: it reads the
  // identity through the ambient request context instead, after an await, so
  // the test also proves the store follows the async chain.
  const toolsFile = path.join(root, 'business-tools.mjs');
  const contextModule = new URL('../lib/context.mjs', import.meta.url).href.replaceAll('\\', '/');
  await writeFile(toolsFile, `
    import { currentIdentity } from ${JSON.stringify(contextModule)};
    export default {
      probe: {
        description: 'Return the caller identity seen from a deep async layer',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        async run(args) {
          if (Object.keys(args).length) throw new Error('probe takes no arguments');
          await new Promise(resolve => setTimeout(resolve, 5));
          const identity = currentIdentity();
          return { deep: true, uuid: identity.uuid, agentName: identity.agentName, verified: identity.verified };
        },
      },
    };
  `, 'utf8');

  const port = await freePort();
  const { child, ready } = await startServer(registryFile, port, ['--tools', toolsFile]);
  t.after(async () => { child.kill(); });
  await ready;

  const client = createSignedClient({
    serverUrl: `http://127.0.0.1:${port}/mcp`,
    uuid: identity.uuid,
    agentName: identity.agentName,
    privateKey: identity.privatePem,
  });

  const result = await client.callTool('probe', {});
  assert.equal(result.structuredContent.deep, true);
  assert.equal(result.structuredContent.uuid, identity.uuid);
  assert.equal(result.structuredContent.agentName, 'plan');
  assert.equal(result.structuredContent.verified, true);

  // The business tool shows up in tools/list next to the built-ins.
  const list = await client.rpc('tools/list', {});
  assert.ok(list.tools.some(tool => tool.name === 'probe'));
});

test('MCP server program refuses a missing registry', async () => {  const missing = path.join(os.tmpdir(), `no-such-registry-${Date.now()}.json`);
  const { exitCode, stderr } = await runOnce(['--registry', missing]);
  assert.equal(exitCode, 2);
  assert.match(stderr, /注册表不存在/);
});

test('MCP server program prints usage without arguments', async () => {
  const { exitCode, stderr } = await runOnce([]);
  assert.equal(exitCode, 2);
  assert.match(stderr, /identity-mcp-server/);
});

function runOnce(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SERVE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('exit', code => resolve({ exitCode: code, stderr }));
  });
}

/** GET with a spoofed Host header; resolves the status code. */
function rawGet(port, pathname, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { Host: hostHeader } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}
