/**
 * In-process SDK conformance checks.
 *
 * These exercise the exact functions the generator and the MCP server call, so a
 * green board means the installed SDK is behaving — no external process, no
 * network, no filesystem ACL work.
 */
import { sdk } from './sdk.mjs';

const silent = async fn => {
  try { await fn(); return null; } catch (error) { return error; }
};

function record(list, id, name, expect, fn) {
  const started = Date.now();
  return (async () => {
    try {
      const actual = await fn();
      const pass = typeof expect === 'function' ? expect(actual) : actual === expect;
      list.push({ id, name, expect: typeof expect === 'function' ? 'predicate' : String(expect), actual: String(actual), pass, ms: Date.now() - started });
      return actual;
    } catch (error) {
      list.push({ id, name, expect: typeof expect === 'function' ? 'predicate' : String(expect), actual: `抛出：${error.message}`, pass: false, ms: Date.now() - started });
      return null;
    }
  })();
}

function rejectRecord(list, id, name, pattern, fn) {
  const started = Date.now();
  return (async () => {
    const error = await silent(fn);
    const pass = Boolean(error) && pattern.test(error.code ?? error.message);
    list.push({ id, name, expect: `拒绝（/${pattern}/）`, actual: error ? `${error.code}: ${error.message}` : '未拒绝', pass, ms: Date.now() - started });
    return error;
  })();
}

/** @returns {Promise<{ checks: any[], passed: number, failed: number, ms: number }>} */
export async function runSdkSelfTest() {
  const started = Date.now();
  const S = await sdk();
  const checks = [];

  const build = await S.createAgentIdentity({ agentName: 'sdk-build' });
  const plan = await S.createAgentIdentity({ agentName: 'sdk-plan' });

  await record(checks, 'uuid', '生成 UUID v4', value => /^[0-9a-f-]{36}$/.test(value) && S.isUuid(value), async () => build.uuid);
  await record(checks, 'key-strength', '密钥对为 RSA-3072', 3072, async () => build.publicJwk && S.importPublicKey(build.publicJwk).asymmetricKeyDetails.modulusLength);
  await record(checks, 'kid', 'kid = base64url(SHA-256(e,kty,n))', true,
    async () => S.keyId({ e: build.publicJwk.e, kty: 'RSA', n: build.publicJwk.n }) === build.kid);
  await record(checks, 'sign', '用私钥签 Agent 名称 + UUID', true,
    async () => build.attestation.claim.sub === build.uuid && build.attestation.claim.agent === 'sdk-build');
  await record(checks, 'verify', '用公钥验签通过并返回 claim', true, async () => {
    const claim = S.verifyIdentity(build.attestation.token, { publicKey: build.publicJwk, expectedUuid: build.uuid, expectedAgent: 'sdk-build' });
    return claim.sub === build.uuid && claim.agent === 'sdk-build';
  });
  await record(checks, 'verify-pem', '只给 SPKI PEM 公钥即可验签', true, async () => {
    const result = S.verifyWithPublicKey(build.attestation.token, build.publicPem, { expectedAgent: 'sdk-build' });
    return result.verified === true && result.claim.sub === build.uuid && result.modulusBits === 3072;
  });
  await record(checks, 'verify-jwk-json', '公钥以 JSON 字符串传入也可验签', true,
    async () => S.verifyWithPublicKey(build.attestation, JSON.stringify({ publicJwk: build.publicJwk })).claim.sub === build.uuid);
  await record(checks, 'normalize-key', 'PEM / JWK / 私钥三种输入推导出同一个 kid', 'same',
    async () => {
      const kids = [build.publicPem, build.publicJwk, build.privatePem].map(material => S.normalizePublicKey(material).kid);
      return new Set([...kids, build.kid]).size === 1 ? 'same' : kids.join(',');
    });
  await rejectRecord(checks, 'verify-expected-agent', '期望 Agent 与实际不符被拒', /ATTESTATION_AGENT/,
    () => S.verifyWithPublicKey(build.attestation, build.publicJwk, { expectedAgent: 'sdk-plan' }));
  await record(checks, 'inspect', 'inspect 只解码 claim、不做信任判断', 'sdk-plan,true',
    async () => {
      const [head, , sig] = build.attestation.token.split('.');
      const claim = JSON.parse(Buffer.from(build.attestation.token.split('.')[1], 'base64url').toString('utf8'));
      claim.agent = 'sdk-plan';
      const forged = `${head}.${Buffer.from(JSON.stringify(claim)).toString('base64url')}.${sig}`;
      const info = S.inspectAttestation(forged);
      let rejected = false;
      try { S.verifyWithPublicKey(forged, build.publicJwk); } catch { rejected = true; }
      return `${info.claim.agent},${rejected}`;
    });
  await rejectRecord(checks, 'tamper-agent', '篡改 Agent 名称后验签被拒', /ATTESTATION_SIGNATURE/, () => {
    const [head, , sig] = build.attestation.token.split('.');
    const claim = JSON.parse(Buffer.from(build.attestation.token.split('.')[1], 'base64url').toString('utf8'));
    claim.agent = 'sdk-plan';
    return S.verifyIdentity(`${head}.${Buffer.from(JSON.stringify(claim)).toString('base64url')}.${sig}`, { publicKey: build.publicJwk });
  });
  await rejectRecord(checks, 'tamper-uuid', '篡改 UUID 后验签被拒', /ATTESTATION_SIGNATURE/, () => {
    const [head, , sig] = build.attestation.token.split('.');
    const claim = JSON.parse(Buffer.from(build.attestation.token.split('.')[1], 'base64url').toString('utf8'));
    claim.sub = plan.uuid;
    return S.verifyIdentity(`${head}.${Buffer.from(JSON.stringify(claim)).toString('base64url')}.${sig}`, { publicKey: build.publicJwk });
  });
  await rejectRecord(checks, 'wrong-key', '换另一把公钥验签被拒', /ATTESTATION_KID_MISMATCH/, () => S.verifyIdentity(build.attestation, { publicKey: plan.publicJwk }));

  const url = 'http://127.0.0.1:8799/mcp';
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'whoami', arguments: {} } }));
  const registry = S.validateRegistry({ version: 1, agents: [build.enrollment] }, { requireAttestation: true });
  const resolveAgent = uuid => registry.agents.find(agent => agent.uuid === uuid);

  const token = await record(checks, 'proof', '为请求生成 X-Agent-Proof', value => typeof value === 'string' && value.split('.').length === 3,
    async () => S.createProof({ uuid: build.uuid, agentName: 'sdk-build', privateKey: build.privatePem, url, body }));
  await record(checks, 'proof-verify', '服务端用公钥验证请求证明', true, async () => {
    const identity = S.verifyProof(token, { resolveAgent, url, body, replay: S.createReplayStore() });
    return identity.uuid === build.uuid && identity.verified === true && Object.isFrozen(identity);
  });
  await rejectRecord(checks, 'proof-body', '请求体被改动后验签被拒', /PROOF_BODY/, () => S.verifyProof(token, { resolveAgent, url, body: Buffer.from('{}'), replay: S.createReplayStore() }));
  await rejectRecord(checks, 'proof-audience', '发往其他端口被拒', /PROOF_AUDIENCE/, () => S.verifyProof(token, { resolveAgent, url: 'http://127.0.0.1:9000/mcp', body, replay: S.createReplayStore() }));
  await rejectRecord(checks, 'proof-replay', '同一证明重放被拒', /PROOF_REPLAY/, async () => {
    const replay = S.createReplayStore();
    S.verifyProof(token, { resolveAgent, url, body, replay });
    S.verifyProof(token, { resolveAgent, url, body, replay });
  });

  await record(checks, 'registry', '注册表条目带身份证明并通过校验', 'verified,verified',
    async () => S.attestationReport(S.validateRegistry({ version: 1, agents: [build.enrollment, plan.enrollment] })).map(r => r.status).join(','));
  await rejectRecord(checks, 'registry-tamper', '注册表被改名后校验失败', /ATTESTATION_AGENT/,
    () => S.validateRegistry({ version: 1, agents: [{ ...build.enrollment, agentName: 'sdk-plan' }] }));
  await rejectRecord(checks, 'registry-key-swap', '注册表被换公钥后校验失败', /REGISTRY_KID/,
    () => S.validateRegistry({ version: 1, agents: [{ ...build.enrollment, publicJwk: plan.publicJwk }] }));
  await record(checks, 'canonical', '规范化与字段顺序无关', true,
    async () => S.canonicalJSON({ b: 1, a: 2 }) === S.canonicalJSON({ a: 2, b: 1 }));

  return {
    checks,
    passed: checks.filter(check => check.pass).length,
    failed: checks.filter(check => !check.pass).length,
    ms: Date.now() - started,
  };
}
