/**
 * MCP identity server — the verification side, built on @opencode-identity/sdk.
 *
 * Trust boundaries, in order:
 *   1. transport   Host/Origin must match the loopback endpoint; POST /mcp; JSON body ≤ 64 KB
 *   2. registry    structural validation + per-entry identity attestation (name ↔ UUID ↔ key)
 *   3. request     X-Agent-Proof signature over method + path + audience + body hash + nonce
 *   4. tool        business arguments are validated separately; identity never comes from args
 *
 * The registry is re-read only when its mtime/size/inode change, so ACL checks are
 * paid once per configuration change instead of once per request.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { sdk } from './sdk.mjs';
import { runWithIdentity } from './context.mjs';

const MAX_BODY = 65536;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {{
 *   registryFile: string, requireAttestation?: boolean,
 *   audit?: (event: Record<string, unknown>) => void, version?: string,
 *   extraTools?: Record<string, { description: string, schema: object, run: (args: object, context: { identity: object }) => unknown }>,
 * }} options
 */
export async function createIdentityServer({ registryFile, requireAttestation = true, audit, version = '1.1.0', extraTools }) {
  const S = await sdk();
  const { HEADER, createReplayStore, validateRegistry, verifyProof, attestationReport } = S;

  const emit = audit ?? (event => process.stdout.write(`${JSON.stringify(event)}\n`));
  const replay = createReplayStore();
  /** @type {{ key: string, registry: any, report: any[] } | null} */
  let cache = null;
  let serverUrl = '';

  async function loadRegistry() {
    const info = await stat(registryFile);
    const key = `${info.mtimeMs}:${info.size}:${info.ino}`;
    if (cache?.key === key) return cache.registry;
    const raw = JSON.parse(await readFile(registryFile, 'utf8'));
    const registry = validateRegistry(raw, { requireAttestation });
    cache = { key, registry, report: attestationReport(registry) };
    return registry;
  }

  const tools = {
    whoami: {
      description: 'Return the current Agent UUID/name verified with the registered public key',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      run(args, context) { argsOnly(args, []); return { identity: verifiedIdentity(context) }; },
    },
    echo_secure: {
      description: 'Echo text together with the verified caller identity',
      schema: { type: 'object', properties: { text: { type: 'string', maxLength: 2000 } }, required: ['text'], additionalProperties: false },
      run(args, context) {
        const identity = verifiedIdentity(context);
        argsOnly(args, ['text']);
        if (typeof args.text !== 'string' || args.text.length > 2000) throw new Error('text must be a string up to 2000 characters');
        return { text: args.text, identity };
      },
    },
    add: {
      description: 'Add two finite numbers and include the verified caller identity',
      schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false },
      run(args, context) {
        const identity = verifiedIdentity(context);
        argsOnly(args, ['a', 'b']);
        if (!Number.isFinite(args.a) || !Number.isFinite(args.b) || !Number.isFinite(args.a + args.b)) throw new Error('a/b/result must be finite numbers');
        return { sum: args.a + args.b, identity };
      },
    },
  };

  // Business tools registered by the embedder. They run exactly like the
  // built-ins: verified identity arrives as context.identity and, for the
  // whole async call chain below them, via currentIdentity() (lib/context.mjs).
  if (extraTools !== undefined) {
    if (!object(extraTools) || Array.isArray(extraTools)) throw new Error('extraTools must be an object of { description, schema, run }');
    for (const [name, tool] of Object.entries(extraTools)) {
      if (Object.hasOwn(tools, name)) throw new Error(`Tool name already taken: ${name}`);
      if (!tool || typeof tool.description !== 'string' || !object(tool.schema) || typeof tool.run !== 'function') {
        throw new Error(`Invalid extra tool "${name}": description, schema and run(args, context) are required`);
      }
      tools[name] = tool;
    }
  }

  function argsOnly(args, fields) {
    if (!object(args) || Object.keys(args).some(key => !fields.includes(key))) {
      throw new Error('Invalid tool arguments; identity comes from the server context');
    }
  }

  function verifiedIdentity(context) {
    const identity=context?.identity;
    if (!identity?.verified || !Object.isFrozen(identity)) throw new Error('Verified request identity required');
    return identity;
  }

  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  async function dispatch(body, identity, usage = { context: 0, deep: 0 }) {
    if (!object(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return rpcError(body?.id, -32600, 'Invalid JSON-RPC request');
    if (body.method === 'notifications/initialized' && !('id' in body)) return null;
    if (!('id' in body) || (typeof body.id !== 'string' && typeof body.id !== 'number')) return rpcError(null, -32600, 'A request ID is required');
    const ok = result => ({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'initialize') {
      return ok({
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'local-agent-identity-mcp', version },
        instructions: 'Use whoami to check the server-verified Agent. Never provide identity as tool arguments.',
      });
    }
    if (body.method === 'ping') return ok({});
    if (body.method === 'tools/list') {
      return ok({
        tools: Object.entries(tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.schema,
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        })),
      });
    }
    if (body.method !== 'tools/call') return rpcError(body.id, -32601, 'Method not found');
    const params = body.params;
    if (!object(params) || typeof params.name !== 'string' || !Object.hasOwn(tools, params.name)) return rpcError(body.id, -32602, 'Unknown tool');
    try {
      // context.identity for the tool itself; runWithIdentity() additionally
      // exposes it to deeper layers via currentIdentity() (lib/context.mjs).
      // Both paths are counted so the audit line can prove the tool really
      // read the verified identity instead of just receiving a request.
      const data = await runWithIdentity(
        identity,
        () => tools[params.name].run(
          params.arguments ?? {},
          Object.freeze(Object.defineProperty({}, 'identity', {enumerable:true,get(){usage.context += 1;return identity;}})),
        ),
        () => { usage.deep += 1; },
      );
      return ok({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false });
    } catch (error) {
      return rpcError(body.id, -32602, /** @type {Error} */ (error).message);
    }
  }

  const send = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };

  const server = createServer(async (req, res) => {
    const expectedHost = new URL(serverUrl).host;
    if (req.headers.host !== expectedHost) return send(res, 403, { error: 'Invalid Host' });
    if (req.headers.origin && req.headers.origin !== new URL(serverUrl).origin) return send(res, 403, { error: 'Invalid Origin' });
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, server: 'local-agent-identity-mcp', sdk: true, attestation: cache?.report ?? [] });
    }
    if (req.url !== '/mcp') return send(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, { error: 'Use POST /mcp' });
    }
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'Use application/json' });

    let raw;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return send(res, 413, { error: 'Request too large' });
        chunks.push(chunk);
      }
      raw = Buffer.concat(chunks);
    } catch {
      if (!res.writableEnded) send(res, 400, { error: 'Invalid request body' });
      return;
    }

    let registry;
    try { registry = await loadRegistry(); }
    catch (error) {
      emit({ time: new Date().toISOString(), event: 'registry_unavailable', code: /** @type {any} */ (error).code, message: /** @type {Error} */ (error).message });
      return send(res, 503, { error: 'Registry unavailable or invalid' });
    }

    let identity;
    try {
      identity = verifyProof(req.headers[HEADER.toLowerCase()], {
        resolveAgent: uuid => registry.agents.find(agent => agent.uuid === uuid),
        url: serverUrl,
        body: raw,
        method: req.method,
        replay,
      });
    } catch (error) {
      emit({ time: new Date().toISOString(), event: 'authentication_failed', code: /** @type {any} */ (error).code ?? 'UNKNOWN' });
      return send(res, 401, rpcError(null, -32001, 'Agent authentication failed'));
    }

    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 200, rpcError(null, -32700, 'Parse error')); }
    /** @type {{ context: number, deep: number }} */
    const identityUse = { context: 0, deep: 0 };
    const result = await dispatch(body, identity, identityUse);
    // Only a tools/call can read the identity, and only if the tool really did:
    // context.identity (tool layer) and/or currentIdentity() (deeper layers).
    if (body?.method === 'tools/call' && identityUse.context + identityUse.deep > 0) {
      const via = [identityUse.context > 0 ? 'context.identity' : null, identityUse.deep > 0 ? 'currentIdentity()' : null].filter(Boolean);
      emit({
        time: new Date().toISOString(),
        event: 'identity_access',
        tool: body?.params?.name,
        agentName: identity.agentName,
        uuid: identity.uuid,
        kid: identity.kid,
        sessionId: identity.sessionId,
        invocationId: identity.invocationId,
        via,
        uses: { context: identityUse.context, deep: identityUse.deep },
        verified: true,
      });
    }
    emit({
      time: new Date().toISOString(),
      event: 'mcp_request',
      uuid: identity.uuid,
      agentName: identity.agentName,
      kid: identity.kid,
      sessionId: identity.sessionId,
      invocationId: identity.invocationId,
      method: body?.method,
      tool: body?.params?.name,
      identityAccess: body?.method === 'tools/call' ? identityUse : undefined,
      success: result?.error === undefined,
    });
    send(res, result === null ? 202 : 200, result === null ? undefined : result);
  });

  server.requestTimeout = 10000;
  server.headersTimeout = 10000;

  return {
    /** @param {number} port */
    async start(port = 8765) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(undefined); });
      });
      serverUrl = `http://127.0.0.1:${server.address().port}/mcp`;
      const registry = await loadRegistry();
      emit({ event: 'listening', url: serverUrl, registry: path.resolve(registryFile), agents: registry.agents.length, attestation: cache?.report ?? [] });
      return serverUrl;
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
    get url() { return serverUrl; },
    get registry() { return cache?.registry ?? null; },
  };
}
