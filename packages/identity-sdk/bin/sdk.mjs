#!/usr/bin/env node
/**
 * identity-sdk CLI — the standalone tool form of the SDK.
 *
 * Every subcommand is a thin wrapper over the library, so what you can do on the
 * command line is exactly what the generator and the MCP server do in-process.
 *
 *   identity-sdk describe
 *   identity-sdk keygen    [--out DIR] [--agent NAME] [--uuid UUID]
 *   identity-sdk sign      --private PEM --agent NAME [--uuid UUID] [--out FILE]
 *   identity-sdk verify    --public JWK_OR_PEM --attestation FILE_OR_TOKEN [--uuid U] [--agent A]
 *   identity-sdk proof     --private PEM --agent NAME --uuid UUID --url URL --body FILE
 *   identity-sdk verify-proof --token FILE_OR_TOKEN --registry FILE --url URL --body FILE
 *   identity-sdk selftest
 *
 * Exit codes: 0 success, 1 verification/usage failure, 2 bad invocation.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  SDK_VERSION, createProof, createReplayStore, describe, generateUuid,
  publicJwkOf, readPrivateKeyFile, signIdentity, validateRegistry, verifyIdentity,
  verifyWithPublicKey, normalizePublicKey, inspectAttestation,
  verifyProof, createAgentIdentity, assertLocalEndpoint,
  agentByName, createSignedClient, validateTerminalConfig, verifyAgent,
} from '../src/index.mjs';

const USAGE = `identity-sdk ${SDK_VERSION}

用法:
  identity-sdk describe
  identity-sdk keygen [--out DIR] [--agent NAME] [--uuid UUID]
  identity-sdk sign --private PEM --agent NAME [--uuid UUID] [--out FILE]
  identity-sdk verify --public JWK_OR_PEM --attestation FILE_OR_TOKEN [--uuid U] [--agent A] [--kid K]
  identity-sdk verify-public --public JWK_OR_PEM --attestation FILE_OR_TOKEN
  identity-sdk inspect --attestation FILE_OR_TOKEN [--public JWK_OR_PEM]
  identity-sdk proof --private PEM --agent NAME --uuid UUID --url URL --body FILE
  identity-sdk verify-proof --token FILE_OR_TOKEN --registry FILE --url URL --body FILE
  identity-sdk verify-agent --config TERMINAL_CONFIG --agent NAME
  identity-sdk call-tool --config TERMINAL_CONFIG --agent NAME --tool whoami [--args JSON]
  identity-sdk selftest

说明:
  keygen        生成 RSA-3072 密钥对 + UUID，并写出 private.pem / public.jwk / identity.json / enrollment.json
  sign          用私钥对 Agent 名称 + UUID 签名，输出身份证明（JSON 或紧凑 token）
  verify        只用公钥离线验签（JWK / PEM 均可，内联或文件）；任一处不一致都会以非零退出码结束
  verify-public verify 的别名，强调「只持有公钥即可验证」
  inspect       解码身份证明并显示 claim 与签名长度，不验签；给了 --public 时同时比对 kid
  proof         为一次 HTTP 请求生成 X-Agent-Proof
  verify-agent  读取终端配置，向运行中的 MCP 服务端发起签名请求并核对返回身份
  call-tool     同上，调用一个业务工具
  selftest      在本进程内跑一组自检（无外部依赖）
`;

// `parseArgs` refuses an option value that starts with "-", and every PEM
// starts with "-----BEGIN". Merge the pair into `--flag=value` before parsing so
// both `--public key.pem` and `--public "-----BEGIN PUBLIC KEY-----…"` work.
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length - 1; i += 1) {
  if (argv[i].startsWith('--') && !argv[i].includes('=') && argv[i + 1].startsWith('-----BEGIN')) {
    argv.splice(i, 2, `${argv[i]}=${argv[i + 1]}`);
  }
}

const { values: flags, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    agent: { type: 'string' },
    uuid: { type: 'string' },
    kid: { type: 'string' },
    private: { type: 'string' },
    public: { type: 'string' },
    attestation: { type: 'string' },
    token: { type: 'string' },
    registry: { type: 'string' },
    url: { type: 'string' },
    body: { type: 'string' },
    config: { type: 'string' },
    tool: { type: 'string' },
    args: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    json: { type: 'boolean' },
  },
});

const print = value => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);

/** Read a value that may be an inline JSON/token or a path to a file. */
async function readInlineOrFile(value) {
  if (!value) return null;
  const text = value.trim();
  if (text.startsWith('{') || text.startsWith('-----BEGIN') || text.split('.').length === 3) return text;
  return readFile(value, 'utf8');
}

/** Read key material: inline PEM/JWK JSON, or a file holding either. */
async function readKeyMaterial(value) {
  const raw = await readInlineOrFile(value);
  return raw === null ? null : raw.trim();
}

async function writeMaybe(file, content) {
  if (!file) return null;
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, content, 'utf8');
  return path.resolve(file);
}

const [command] = positionals;

// No subcommand and a real terminal: manual launch from a shortcut or a
// double-click. Piped/automated calls keep the strict usage + exit 2 behaviour.
if (!command && !flags.help && process.stdin.isTTY && process.stdout.isTTY) {
  const { runMenu } = await import('./menu.mjs');
  await runMenu();
  process.exit(0);
}

try {
  if (flags.help || !command) {
    print(USAGE);
    process.exit(command ? 0 : 2);
  }

  if (command === 'describe') {
    print(describe());
  } else if (command === 'keygen') {
    const agentName = flags.agent ?? 'build';
    const identity = await createAgentIdentity({ agentName, uuid: flags.uuid ?? generateUuid() });
    const outDir = flags.out ? path.resolve(flags.out) : null;
    if (outDir) {
      await mkdir(outDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(outDir, 'private.pem'), identity.privatePem, { mode: 0o600 });
      await writeFile(path.join(outDir, 'public.jwk'), `${JSON.stringify(identity.publicJwk, null, 2)}\n`, { mode: 0o600 });
      await writeFile(path.join(outDir, 'identity.json'), `${JSON.stringify(identity.files['identity.json'], null, 2)}\n`, { mode: 0o600 });
      await writeFile(path.join(outDir, 'enrollment.json'), `${JSON.stringify(identity.enrollment, null, 2)}\n`, { mode: 0o600 });
    }
    print({
      agentName,
      uuid: identity.uuid,
      kid: identity.kid,
      out: outDir,
      publicJwk: identity.publicJwk,
      attestation: identity.attestation.token,
    });
  } else if (command === 'sign') {
    if (!flags.private || !flags.agent) throw Object.assign(new Error('sign 需要 --private 与 --agent'), { code: 'USAGE' });
    const privateKey = await readPrivateKeyFile(path.resolve(flags.private));
    const attestation = signIdentity({ uuid: flags.uuid ?? generateUuid(), agentName: flags.agent, privateKey });
    const file = await writeMaybe(flags.out, `${JSON.stringify(attestation, null, 2)}\n`);
    print(file ? { file, ...attestation } : attestation);
  } else if (command === 'verify' || command === 'verify-public') {
    if (!flags.public || !flags.attestation) throw Object.assign(new Error(`${command} 需要 --public 与 --attestation`), { code: 'USAGE' });
    const publicMaterial = await readKeyMaterial(flags.public);
    const attestation = await readInlineOrFile(flags.attestation);
    const trimmed = attestation.trim();
    const material = trimmed.startsWith('{') ? JSON.parse(trimmed) : trimmed;
    const result = verifyWithPublicKey(material, publicMaterial, {
      ...(flags.uuid ? { expectedUuid: flags.uuid } : {}),
      ...(flags.agent ? { expectedAgent: flags.agent } : {}),
      ...(flags.kid ? { expectedKid: flags.kid } : {}),
    });
    print({
      verified: result.verified,
      claim: result.claim,
      key: { kid: result.kid, modulusBits: result.modulusBits },
      publicPem: result.publicPem,
    });
  } else if (command === 'inspect') {
    if (!flags.attestation) throw Object.assign(new Error('inspect 需要 --attestation'), { code: 'USAGE' });
    const attestation = await readInlineOrFile(flags.attestation);
    const trimmed = attestation.trim();
    const info = inspectAttestation(trimmed.startsWith('{') ? JSON.parse(trimmed) : trimmed);
    let kidMatchesKey = null;
    if (flags.public) {
      const key = normalizePublicKey(await readKeyMaterial(flags.public));
      kidMatchesKey = key.kid === info.claimedKid;
    }
    print({
      header: info.header,
      claim: info.claim,
      signatureBytes: info.signatureBytes,
      claimedKid: info.claimedKid,
      kidMatchesKey,
      note: '未验签：inspect 只解码，真伪仍需 verify',
    });
  } else if (command === 'proof') {
    if (!flags.private || !flags.agent || !flags.uuid || !flags.url || !flags.body) {
      throw Object.assign(new Error('proof 需要 --private --agent --uuid --url --body'), { code: 'USAGE' });
    }
    const privateKey = await readPrivateKeyFile(path.resolve(flags.private));
    const body = await readFile(flags.body);
    const token = createProof({ uuid: flags.uuid, agentName: flags.agent, privateKey, url: assertLocalEndpoint(flags.url), body });
    print({ header: 'X-Agent-Proof', token });
  } else if (command === 'verify-proof') {
    if (!flags.token || !flags.registry || !flags.url || !flags.body) {
      throw Object.assign(new Error('verify-proof 需要 --token --registry --url --body'), { code: 'USAGE' });
    }
    const registry = validateRegistry(JSON.parse(await readFile(flags.registry, 'utf8')));
    const token = (await readInlineOrFile(flags.token)).trim();
    const body = await readFile(flags.body);
    const identity = verifyProof(token, {
      resolveAgent: uuid => registry.agents.find(agent => agent.uuid === uuid),
      url: assertLocalEndpoint(flags.url),
      body,
      replay: createReplayStore(),
    });
    print({ verified: true, identity });
  } else if (command === 'verify-agent') {
    if (!flags.config || !flags.agent) throw Object.assign(new Error('verify-agent 需要 --config 与 --agent'), { code: 'USAGE' });
    const result = await verifyAgent({ configFile: path.resolve(flags.config), agentName: flags.agent });
    print(result);
  } else if (command === 'call-tool') {
    if (!flags.config || !flags.agent || !flags.tool) throw Object.assign(new Error('call-tool 需要 --config --agent --tool'), { code: 'USAGE' });
    const config = validateTerminalConfig(JSON.parse(await readFile(path.resolve(flags.config), 'utf8')));
    const agent = agentByName(config, flags.agent);
    const privateKey = await readPrivateKeyFile(agent.privateKeyFile, { workspaceRoot: config.workspaceRoot });
    const client = createSignedClient({ serverUrl: config.serverUrl, uuid: agent.uuid, agentName: agent.agentName, privateKey });
    const args = flags.args ? JSON.parse(flags.args) : {};
    const result = await client.callTool(flags.tool, args);
    print({ tool: flags.tool, agent: agent.agentName, structuredContent: result.structuredContent });
  } else if (command === 'selftest') {
    const identity = await createAgentIdentity({ agentName: 'cli-agent' });
    const claim = verifyIdentity(identity.attestation, { publicKey: identity.publicJwk, expectedUuid: identity.uuid, expectedAgent: 'cli-agent' });
    const other = await createAgentIdentity({ agentName: 'other-agent' });
    let tamperRejected = false;
    try {
      verifyIdentity(identity.attestation.token.replace(/.$/, c => (c === 'A' ? 'B' : 'A')), { publicKey: identity.publicJwk });
    } catch { tamperRejected = true; }
    let wrongKeyRejected = false;
    try { verifyIdentity(identity.attestation, { publicKey: other.publicJwk }); } catch { wrongKeyRejected = true; }
    const viaPem = verifyWithPublicKey(identity.attestation.token, identity.publicPem, { expectedAgent: identity.agentName });
    const viaJsonKey = verifyWithPublicKey(identity.attestation, JSON.stringify({ publicJwk: identity.publicJwk }));
    const normalizedKid = normalizePublicKey(identity.publicPem).kid;
    const checks = [
      { id: 'kid', pass: publicJwkOf(identity.privateKey).kid === identity.kid },
      { id: 'sign-verify', pass: claim.sub === identity.uuid && claim.agent === identity.agentName },
      { id: 'public-pem', pass: viaPem.verified === true && viaPem.claim.sub === identity.uuid && viaPem.modulusBits === 3072 },
      { id: 'public-jwk-json', pass: viaJsonKey.claim.agent === identity.agentName },
      { id: 'normalize-kid', pass: normalizedKid === identity.kid },
      { id: 'tamper', pass: tamperRejected },
      { id: 'wrong-key', pass: wrongKeyRejected },
    ];
    print({ passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length, checks });
    if (checks.some(c => !c.pass)) process.exit(1);
  } else {
    print(`未知命令：${command}\n\n${USAGE}`);
    process.exit(2);
  }
} catch (error) {
  const code = /** @type {any} */ (error).code ?? 'ERROR';
  process.stderr.write(`[${code}] ${/** @type {Error} */ (error).message}\n`);
  process.exit(code === 'USAGE' ? 2 : 1);
}
