import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

import { lab, labInfo, LAB_FOUND } from './lib/lab.mjs';
import { sdk, sdkInfo } from './lib/sdk.mjs';
import { MCP_BIN } from './lib/mcp-bin.mjs';
import { detectOpenCode } from './lib/detect.mjs';
import { createJob, getJob, restoreJob, allJobs } from './lib/jobs.mjs';
import { generateAkbBundle } from './lib/akb/generator.mjs';
import { verifyAgent as verifyAkbAgent } from './lib/akb/client.mjs';
import { saveVerifiedBinding, installAkbPlugin } from './lib/akb/installer.mjs';
import { runBuild, packageZip, localizePlugin } from './lib/builder.mjs';
import { buildGuide } from './lib/guide.mjs';
import { runSelfTest } from './lib/selftest.mjs';
import { runSdkSelfTest } from './lib/sdk-check.mjs';

const PUBLIC = path.join(import.meta.dirname, 'public');
const JOBS_FILE = process.env.STUDIO_STATE_FILE || path.join(import.meta.dirname, '.studio-jobs.json');
const HOST = '127.0.0.1';
const PORT = Number(process.env.STUDIO_PORT || 4180);

/** Persist finished builds so a Studio restart does not lose the last result. */
async function persistJobs() {
  const records = allJobs()
    .filter(job => ['build','akb-build'].includes(job.type) && job.state === 'done')
    .map(job => {
      const { zip, ...result } = job.result;
      return { id: job.id, type: job.type, state: job.state, steps: job.steps, result, meta: job.meta, startedAt: job.startedAt, endedAt: job.endedAt, error: null };
    });
  await writeFile(JOBS_FILE, JSON.stringify(records, null, 2), 'utf8').catch(() => {});
}

async function loadPersistedJobs() {
  const text = await readFile(JOBS_FILE, 'utf8').catch(() => null);
  if (!text) return 0;
  try {
    const records = JSON.parse(text);
    for (const record of records) restoreJob(record);
    return records.length;
  } catch { return 0; }
}

const serverState = {
  proc: null,
  jobId: null,
  port: null,
  startedAt: null,
  registry: null,
  log: [],
};

const auditCount = () => serverState.log.length;

/**
 * Ephemeral key pairs created by the SDK playground. Only the public half and
 * the derived material ever leave this map; entries expire and are capped.
 */
const sdkKeys = new Map();
const SDK_KEY_TTL = 30 * 60 * 1000;
const SDK_KEY_LIMIT = 20;

function pruneSdkKeys() {
  const now = Date.now();
  for (const [ref, entry] of sdkKeys) if (now - entry.createdAt > SDK_KEY_TTL) sdkKeys.delete(ref);
  while (sdkKeys.size > SDK_KEY_LIMIT) sdkKeys.delete(sdkKeys.keys().next().value);
}

function requireSdkKey(ref) {
  pruneSdkKeys();
  const entry = sdkKeys.get(ref);
  if (!entry) throw Object.assign(new Error('密钥已过期，请重新生成密钥对'), { status: 410 });
  return entry;
}

/** Flip one claim field inside a compact token, keeping the original signature. */
function tamperToken(token, mode) {
  const [head, payload, signature] = token.split('.');
  if (mode === 'signature') {
    const flipped = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A');
    return `${head}.${payload}.${flipped}`;
  }
  const claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (mode === 'agent') claim.agent = 'plan';
  if (mode === 'uuid') claim.sub = '00000000-0000-4000-8000-000000000000';
  return `${head}.${Buffer.from(JSON.stringify(claim)).toString('base64url')}.${signature}`;
}

function sendJSON(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('请求体过大'),{status:413});
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求体不是合法 JSON'),{status:400}); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (path.relative(PUBLIC,file).startsWith('..') || path.isAbsolute(path.relative(PUBLIC,file))) { sendJSON(res, 403, { error: 'forbidden' }); return; }
  const data = await readFile(file).catch(() => null);
  if (!data) { sendJSON(res, 404, { error: 'not found' }); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(data);
}

function requireJob(id) {
  const job = getJob(id);
  if (!job) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (job.state !== 'done') throw Object.assign(new Error('任务尚未完成'), { status: 409 });
  return job;
}

function buildMeta(result) {
  return {
    dataDir: result.dataDir,
    workspace: result.workspace,
    serverUrl: result.serverUrl,
    port: result.port,
    pluginDir: result.pluginDir,
    registryFile: result.registryFile,
    configFile: result.configFile,
    agents: result.agents,
    entries: result.entries,
    fragments: Object.fromEntries(Object.entries(result.fragments).map(([k, v]) => [k, v])),
    opencodeMajor: result.opencodeMajor,
    opencodeVersion: result.opencodeVersion,
    legacyReadOnly: result.legacyReadOnly,
    includePrivateKeys: result.includePrivateKeys,
    zipSize: result.zipSize,
  };
}

async function detectVersion(workspace) {
  const info = await detectOpenCode({ workspace }).catch(() => null);
  return info?.cli?.found ? info.cli.version : null;
}

const routes = {
  'GET /api/status': async () => {
    const labDir = labInfo();
    const sdkDir = sdkInfo();
    let labVersion = null;
    if (LAB_FOUND) labVersion = JSON.parse(await readFile(path.join(labDir.dir, 'package.json'), 'utf8')).version;
    let sdkVersion = null;
    if (sdkDir.found) sdkVersion = JSON.parse(await readFile(path.join(sdkDir.dir, 'package.json'), 'utf8')).version;
    return {
      node: process.versions.node,
      platform: process.platform,
      lab: { ...labDir, version: labVersion },
      sdk: { ...sdkDir, version: sdkVersion },
      studio: { port: PORT, pid: process.pid },
      home: os.homedir(),
      server: {
        running: Boolean(serverState.proc),
        port: serverState.port,
        jobId: serverState.jobId,
        startedAt: serverState.startedAt,
        pid: serverState.proc?.pid ?? null,
      },
      defaults: {
        port: 8790,
        workspace: process.env.STUDIO_WORKSPACE || '',
        dataDir: path.join(os.homedir(), 'mcp-identity', `run-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}`),
      },
    };
  },

  'GET /api/opencode/detect': async (_body, url) => detectOpenCode({ workspace: url.searchParams.get('workspace') || undefined }),

  // ---- SDK playground -------------------------------------------------------
  // These endpoints exercise the SDK in-process: the same functions the
  // generator and the MCP server call. Private keys stay in this process.

  'GET /api/sdk/info': async () => {
    const info = sdkInfo();
    const S = await sdk();
    return { ...S.describe(), dir: info.dir, available: info.found, liveKeys: sdkKeys.size, keyTtlMs: SDK_KEY_TTL };
  },

  'POST /api/sdk/keypair': async body => {
    const S = await sdk();
    const agentName = typeof body.agentName === 'string' && body.agentName.trim() ? body.agentName.trim() : 'build';
    const started = Date.now();
    const identity = await S.createAgentIdentity({ agentName });
    pruneSdkKeys();
    const ref = `k_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    sdkKeys.set(ref, { identity, createdAt: Date.now() });
    return {
      ref,
      agentName,
      uuid: identity.uuid,
      kid: identity.kid,
      publicJwk: identity.publicJwk,
      publicPem: identity.publicPem,
      attestation: identity.attestation,
      enrollment: identity.enrollment,
      ms: Date.now() - started,
      keyTtlMs: SDK_KEY_TTL,
    };
  },

  'POST /api/sdk/sign': async body => {
    const S = await sdk();
    let entry;
    let ref = body.ref ? String(body.ref) : null;
    if (ref) entry = requireSdkKey(ref);
    else {
      const agentName = typeof body.agentName === 'string' && body.agentName.trim() ? body.agentName.trim() : 'build';
      entry = { identity: await S.createAgentIdentity({ agentName }), createdAt: Date.now() };
      pruneSdkKeys();
      ref = `k_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      sdkKeys.set(ref, entry);
    }
    const agentName = String(body.agentName ?? entry.identity.agentName);
    const uuid = String(body.uuid ?? entry.identity.uuid);
    const started = Date.now();
    const attestation = S.signIdentity({ uuid, agentName, privateKey: entry.identity.privatePem });
    return { ref, agentName, uuid, kid: attestation.signature.kid, attestation, ms: Date.now() - started };
  },

  'POST /api/sdk/verify': async body => {
    const S = await sdk();
    const entry = body.ref ? requireSdkKey(String(body.ref)) : null;
    const publicKey = entry ? entry.identity.publicJwk : body.publicJwk ?? null;
    if (!publicKey) throw Object.assign(new Error('需要 ref 或 publicJwk'), { status: 400 });
    const source = body.attestation ?? entry?.identity.attestation?.token;
    if (!source) throw Object.assign(new Error('需要待验证的身份证明'), { status: 400 });
    const mode = String(body.tamper ?? 'none');
    const token = mode === 'none' ? source : tamperToken(String(source), mode);
    const options = {
      publicKey,
      ...(body.expectedUuid ? { expectedUuid: String(body.expectedUuid) } : {}),
      ...(body.expectedAgent ? { expectedAgent: String(body.expectedAgent) } : {}),
    };
    const started = Date.now();
    try {
      const claim = S.verifyIdentity(token, options);
      return { verified: true, tamper: mode, claim, identity: { uuid: claim.sub, agentName: claim.agent, kid: claim.kid }, ms: Date.now() - started };
    } catch (error) {
      return { verified: false, tamper: mode, code: error.code ?? 'UNKNOWN', message: error.message, ms: Date.now() - started };
    }
  },

  // Standalone public-key verification: no ref, no registry, no private key.
  // Whatever key the caller pastes (PEM / JWK / JSON) is normalised by the SDK,
  // and the claim is checked against it. This is the same code path the MCP
  // server uses when it loads registry.json.
  'POST /api/sdk/verify-public': async body => {
    const S = await sdk();
    const publicKey = body.publicKey ?? body.publicJwk ?? null;
    if (!publicKey) throw Object.assign(new Error('需要 publicKey（JWK / PEM / JSON 字符串）'), { status: 400 });
    if (!body.attestation) throw Object.assign(new Error('需要 attestation（三段 token 或 identity.json）'), { status: 400 });

    const source = body.attestation;
    let attestation = source;
    if (typeof source === 'string') {
      const trimmed = source.trim();
      if (trimmed.startsWith('{')) {
        try { attestation = JSON.parse(trimmed); } catch { throw Object.assign(new Error('attestation JSON 解析失败'), { status: 400 }); }
      }
    }

    const started = Date.now();
    const mode = String(body.tamper ?? 'none');
    let candidate = attestation;
    if (mode !== 'none') {
      const token = typeof attestation === 'string' ? attestation : attestation?.token ?? null;
      if (!token) return { verified: false, tamper: mode, code: 'ATTESTATION_MALFORMED', message: '篡改演示需要三段 token', ms: Date.now() - started };
      candidate = tamperToken(token, mode);
    }

    try {
      const result = S.verifyWithPublicKey(candidate, publicKey, {
        ...(body.expectedUuid ? { expectedUuid: String(body.expectedUuid) } : {}),
        ...(body.expectedAgent ? { expectedAgent: String(body.expectedAgent) } : {}),
        ...(body.expectedKid ? { expectedKid: String(body.expectedKid) } : {}),
      });
      return {
        verified: true,
        tamper: mode,
        claim: result.claim,
        key: { kid: result.kid, modulusBits: result.modulusBits },
        publicPem: result.publicPem,
        ms: Date.now() - started,
      };
    } catch (error) {
      return {
        verified: false,
        tamper: mode,
        code: error.code ?? 'UNKNOWN',
        message: error.message,
        ms: Date.now() - started,
      };
    }
  },

  'POST /api/sdk/inspect': async body => {
    const S = await sdk();
    if (!body.attestation) throw Object.assign(new Error('需要 attestation'), { status: 400 });
    const source = body.attestation;
    const trimmed = typeof source === 'string' ? source.trim() : source;
    try {
      const info = S.inspectAttestation(typeof trimmed === 'string' && trimmed.startsWith('{') ? JSON.parse(trimmed) : trimmed);
      return { ok: true, ...info };
    } catch (error) {
      return { ok: false, code: error.code ?? 'UNKNOWN', message: error.message };
    }
  },

  'POST /api/sdk/proof': async body => {
    const S = await sdk();
    const entry = requireSdkKey(String(body.ref ?? ''));
    const identity = entry.identity;
    const agentName = String(body.agentName ?? identity.agentName);
    const uuid = String(body.uuid ?? identity.uuid);
    const url = S.assertLocalEndpoint(String(body.url ?? `http://127.0.0.1:${serverState.port ?? 8790}/mcp`));
    const payload = typeof body.payload === 'string' && body.payload
      ? body.payload
      : JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    const raw = Buffer.from(payload);
    const started = Date.now();
    const token = S.createProof({ uuid, agentName, privateKey: identity.privatePem, url, body: raw, sessionId: 'sdk-playground' });
    const registry = S.validateRegistry(
      { version: 1, agents: [{ ...identity.enrollment, uuid, agentName }] },
      { requireAttestation: false, verifyAttestation: false },
    );
    const resolveAgent = target => registry.agents.find(agent => agent.uuid === target);
    const replay = S.createReplayStore();
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

    const attempt = fn => { try { return { ok: true, result: fn() }; } catch (error) { return { ok: false, code: error.code ?? 'UNKNOWN', message: error.message }; } };
    const first = attempt(() => S.verifyProof(token, { resolveAgent, url, body: raw, replay }));
    const replayAttempt = attempt(() => S.verifyProof(token, { resolveAgent, url, body: raw, replay }));
    const bodyAttempt = attempt(() => S.verifyProof(token, { resolveAgent, url, body: Buffer.from('{}'), replay: S.createReplayStore() }));

    return {
      header: S.HEADER,
      token,
      claims,
      url,
      body: payload,
      verify: first,
      replayAttempt,
      bodyTamper: bodyAttempt,
      replayStoreSize: replay.size,
      ms: Date.now() - started,
    };
  },

  'POST /api/sdk/selftest': async () => runSdkSelfTest(),

  'POST /api/akb/build': async body => {
    const job=createJob('akb-build');
    job.plan(['生成 AKB 身份与独立插件包']);
    const stamp=randomUUID();
    job.step('生成 AKB 身份与独立插件包',()=>generateAkbBundle({workspace:String(body.workspace||''),dataDir:body.dataDir||path.join(os.homedir(),'akb-identity',stamp),agents:body.agents,serverUrl:body.serverUrl,knowledgeBaseId:body.knowledgeBaseId||'',serviceKeyEnv:body.serviceKeyEnv||'AKB_SERVICE_KEY',opencodeMajor:String(body.opencodeMajor||'both'),allowPrivateHttp:body.allowPrivateHttp===true}))
      .then(result=>job.finish(result)).then(()=>persistJobs()).catch(error=>job.fail(error));
    return {jobId:job.id};
  },
  'POST /api/akb/verify': async body => {
    const build=requireJob(body.jobId);
    if(build.result.target!=='akb')throw Object.assign(new Error('请选择 AKB 生成任务'),{status:400});
    const verified=await verifyAkbAgent(build.result.configFile,String(body.agentName||''));
    await saveVerifiedBinding(build.result.configFile,verified.agentName,verified.binding);
    return {verified:true,agentName:verified.agentName,agentId:verified.agentId,kid:verified.kid};
  },
  'POST /api/akb/install': async body => {
    const build=requireJob(body.jobId);
    if(build.result.target!=='akb')throw Object.assign(new Error('请选择 AKB 生成任务'),{status:400});
    const job=createJob('akb-install');job.plan(['安装依赖并合并全局 OpenCode 配置']);
    job.step('安装依赖并合并全局 OpenCode 配置',()=>installAkbPlugin({bundleDir:build.result.bundleDir,configFile:build.result.configFile,major:String(body.major),opencodeConfig:body.opencodeConfig}))
      .then(result=>job.finish(result)).catch(error=>job.fail(error));
    return {jobId:job.id};
  },
  'POST /api/build': async body => {
    if (serverState.proc) throw Object.assign(new Error('请先停止正在运行的 MCP 服务端，再生成新的身份'), { status: 409 });
    const workspace = String(body.workspace ?? '').trim();
    if (!workspace || !path.isAbsolute(workspace)) throw Object.assign(new Error('工作区必须是绝对路径'), { status: 400 });
    const agents = Array.isArray(body.agents) ? body.agents.map(a => String(a).trim()).filter(Boolean) : [];
    if (!agents.length) throw Object.assign(new Error('至少选择一个 Agent'), { status: 400 });
    if (new Set(agents).size !== agents.length) throw Object.assign(new Error('Agent 名称重复'), { status: 400 });
    for (const name of agents) {
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(name)) throw Object.assign(new Error(`Agent 名称不合法：${name}`), { status: 400 });
    }
    const port = Number(body.port ?? 8790);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('端口不合法'), { status: 400 });
    const opencodeMajor = String(body.opencodeMajor ?? 'both');
    if (!['1', '2', 'both'].includes(opencodeMajor)) throw Object.assign(new Error('主版本必须是 1、2 或 both'), { status: 400 });

    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const dataDir = String(body.dataDir ?? '').trim() || path.join(os.homedir(), 'mcp-identity', `run-${stamp}`);
    if (!path.isAbsolute(dataDir)) throw Object.assign(new Error('数据目录必须是绝对路径'), { status: 400 });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(dataDir), { recursive: true });

    const job = createJob('build', { workspace, agents, port, dataDir });
    const params = {
      workspace, dataDir, agents, port, opencodeMajor,
      legacyReadOnly: body.legacyReadOnly === true,
      includePrivateKeys: body.includePrivateKeys === true,
      opencodeVersion: await detectVersion(workspace),
    };
    runBuild(job, params)
      .then(result => job.finish({ ...buildMeta(result), zip: result.zip }))
      .then(() => persistJobs())
      .catch(error => job.fail(error));
    return { jobId: job.id };
  },

  'POST /api/verify': async body => {
    const job = requireJob(body.jobId);
    const agentName = String(body.agent ?? '');
    const tool = String(body.tool ?? 'whoami');
    if (!['whoami', 'echo_secure', 'add'].includes(tool)) throw Object.assign(new Error('未知工具'), { status: 400 });
    if (!serverState.proc) throw Object.assign(new Error('MCP 服务端未运行，请先在「部署」区启动'), { status: 409 });

    // The Studio signs with the SDK, so what you see here is exactly what a
    // generated plugin does at runtime (and what the server verifies).
    const S = await sdk();
    const configFile = path.join(job.result.dataDir, 'terminal-config.json');
    const config = S.validateTerminalConfig(JSON.parse(await readFile(configFile, 'utf8')));
    const agent = S.agentByName(config, agentName);
    const privateKey = await S.readPrivateKeyFile(agent.privateKeyFile, { workspaceRoot: config.workspaceRoot });
    const client = S.createSignedClient({
      serverUrl: config.serverUrl, uuid: agent.uuid, agentName: agent.agentName, privateKey, sessionId: 'studio',
    });

    const args = tool === 'whoami' ? {} : tool === 'echo_secure' ? { text: String(body.text ?? 'hello') } : { a: Number(body.a ?? 0), b: Number(body.b ?? 0) };

    const t0 = Date.now();
    const init = await client.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'identity-studio', version: '1.1.0' } });
    const t1 = Date.now();
    const result = await client.callTool(tool, args);
    const t2 = Date.now();

    return {
      tool,
      agent: agentName,
      args,
      protocolVersion: init.protocolVersion,
      serverInfo: init.serverInfo,
      timings: { initializeMs: t1 - t0, callMs: t2 - t1, totalMs: t2 - t0 },
      structured: result.structuredContent,
      signer: 'identity-sdk',
    };
  },

  'POST /api/selftest': async body => {
    const job = requireJob(body.jobId);
    const testJob = createJob('selftest', { buildJobId: job.id });
    // Re-detect so the report compares the generated plugin with the host that is
    // running now, not with whatever was detected when the build started.
    const host = await detectOpenCode({ workspace: job.result.workspace }).catch(() => null);
    runSelfTest(testJob, {
      entries: job.result.entries,
      configFile: path.join(job.result.dataDir, 'terminal-config.json'),
      workspace: job.result.workspace,
      agents: job.result.agents,
      serverRunning: Boolean(serverState.proc),
      auditCount,
      zip: job.result.zip,
      opencodeMajor: job.result.opencodeMajor,
      fragments: job.result.fragments,
      hostMajor: host?.host?.major ?? null,
      hostVersion: host?.cli?.version ?? host?.host?.version ?? null,
    }).then(result => testJob.finish(result)).catch(error => testJob.fail(error));
    return { jobId: testJob.id };
  },

  'POST /api/server/start': async body => {
    const job = requireJob(body.jobId);
    if (serverState.proc) return { running: true, port: serverState.port, alreadyRunning: true };
    const port = Number(body.port ?? job.result.port);
    const registryFile = path.join(job.result.dataDir, 'registry.json');
    const serverBin = MCP_BIN;
    if (!serverBin) throw Object.assign(new Error('未找到 MCP 服务端程序（apps/mcp-server/bin/serve.mjs）；请单独启动 start-mcp'), { status: 500 });

    const proc = spawn(process.execPath, [serverBin, '--registry', registryFile, '--port', String(port)], {
      cwd: import.meta.dirname,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverState.proc = proc;
    serverState.jobId = job.id;
    serverState.port = port;
    serverState.registry = registryFile;
    serverState.startedAt = new Date().toISOString();
    serverState.log = [];

    const push = line => {
      serverState.log.push({ time: new Date().toISOString(), line: line.slice(0, 600) });
      if (serverState.log.length > 500) serverState.log.shift();
    };
    let buffer = '';
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        push(buffer.slice(0, index).trim());
        buffer = buffer.slice(index + 1);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', code => {
      push(`[server exited with code ${code}]`);
      serverState.proc = null;
      serverState.port = null;
      serverState.startedAt = null;
    });
    proc.on('error', error => push(`[spawn error] ${error.message}`));

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (serverState.log.some(l => l.line.includes('listening'))) return { running: true, port, log: serverState.log };
      if (!serverState.proc) return { running: false, error: serverState.log.map(l => l.line).join('\n') };
      await new Promise(r => setTimeout(r, 200));
    }
    return { running: true, port, warning: '启动确认超时，请查看日志' };
  },

  'POST /api/server/stop': async () => {
    if (!serverState.proc) return { running: false };
    const proc = serverState.proc;
    proc.kill();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && serverState.proc) await new Promise(r => setTimeout(r, 100));
    if (serverState.proc) { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
    serverState.proc = null;
    serverState.port = null;
    serverState.startedAt = null;
    return { running: false };
  },

  'GET /api/server/log': async () => ({ running: Boolean(serverState.proc), port: serverState.port, entries: serverState.log }),

  'POST /api/plugin': async body => {
    const job = requireJob(body.jobId);
    const opencodeMajor = String(body.opencodeMajor ?? 'both');
    if (!['1', '2', 'both'].includes(opencodeMajor)) throw Object.assign(new Error('主版本必须是 1、2 或 both'), { status: 400 });
    const { generatePlugin } = await lab('generator.mjs');
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const out = path.join(job.result.dataDir, `plugin-${opencodeMajor}-${stamp}`);
    const configFile = path.join(job.result.dataDir, 'terminal-config.json');
    const generated = await generatePlugin(configFile, out, { opencodeMajor });
    await localizePlugin(generated.entries, opencodeMajor);
    const fragments = {};
    for (const [key, file] of Object.entries(generated.fragments)) {
      fragments[key] = { file, content: JSON.parse(await readFile(file, 'utf8')) };
    }
    job.result.entries = generated.entries;
    job.result.fragments = fragments;
    job.result.pluginDir = out;
    job.result.opencodeMajor = opencodeMajor;
    job.result.zip = null;              // force a rebuild from the new plugin directory

    // Keep SETUP.md in sync with the newly generated plugin set.
    const guide = buildGuide({
      workspace: job.result.workspace,
      dataDir: job.result.dataDir,
      port: job.result.port,
      serverUrl: job.result.serverUrl,
      agents: job.result.agents,
      entries: generated.entries,
      fragments: Object.fromEntries(Object.entries(fragments).map(([k, v]) => [k, v.file])),
      opencodeMajor,
      legacyReadOnly: job.result.legacyReadOnly,
      labBin: labInfo().bin,
      opencodeVersion: job.result.opencodeVersion ?? null,
    });
    await writeFile(path.join(job.result.target==='akb'?job.result.bundleDir:job.result.dataDir, 'SETUP.md'), guide, 'utf8');
    await persistJobs();
    return { entries: generated.entries, fragments };
  },
};

// Path-parameter routes (job id in the URL).
const params = {
  'GET /api/jobs/:id': async id => getJob(id)?.toJSON() ?? null,
  'GET /api/download/:id': async id => {
    const job = requireJob(id);
    if(job.result.target==='akb')return {__file:true,buffer:await readFile(job.result.zipFile),name:'akb-opencode-plugin.zip'};
    if (!job.result.zip) job.result.zip = await packageZip(job.result);
    return { __file: true, buffer: job.result.zip, name: `mcp-identity-${path.basename(job.result.dataDir)}.zip` };
  },
  'GET /api/guide/:id': async id => {
    const job = requireJob(id);
    return { text: await readFile(path.join(job.result.target==='akb'?job.result.bundleDir:job.result.dataDir, 'SETUP.md'), 'utf8').catch(() => '') };
  },
};

const server = createServer(async (req, res) => {
  const host = req.headers.host ?? '';
  const allowedHosts = [`${HOST}:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`];
  if (!allowedHosts.includes(host)) { sendJSON(res, 403, { error: 'Invalid Host' }); return; }

  const url = new URL(req.url, `http://${host}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'POST') {
      const origin=req.headers.origin;
      if ((origin && !allowedHosts.map(h=>'http://'+h).includes(origin)) || req.headers['sec-fetch-site']==='cross-site') {sendJSON(res,403,{error:'Cross-origin management requests are forbidden'});return;}
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')) {sendJSON(res,415,{error:'Use application/json'});return;}
    }
    if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (!pathname.startsWith('/api/')) { await serveStatic(res, pathname); return; }

    let matched = null;
    let handlerArgs = [];
    const exact = `${req.method} ${pathname}`;
    if (routes[exact]) {
      matched = routes[exact];
      handlerArgs = [req.method === 'POST' ? await readBody(req) : {}, url];
    } else {
      const segments = pathname.split('/').filter(Boolean); // api, jobs|download|guide, id
      if (segments.length === 3) {
        const key = `${req.method} /api/${segments[1]}/:id`;
        if (params[key]) { matched = params[key]; handlerArgs = [segments[2]]; }
      }
    }
    if (!matched) { sendJSON(res, 404, { error: `未知接口 ${req.method} ${pathname}` }); return; }

    const result = await matched(...handlerArgs);
    if (result && result.__file) {
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${result.name}"`,
        'Content-Length': result.buffer.length,
        'Cache-Control': 'no-store',
      });
      res.end(result.buffer);
      return;
    }
    sendJSON(res, 200, result);
  } catch (error) {
    sendJSON(res, error.status ?? 500, { error: error.message });
  }
});

const restoredCount = await loadPersistedJobs();

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ listening: `http://${HOST}:${PORT}`, lab: labInfo(), restoredJobs: restoredCount }, null, 2));
});

const shutdown = () => {
  if (serverState.proc) { try { serverState.proc.kill(); } catch { /* ignore */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
