/**
 * Unit tests for @opencode-identity/sdk.
 * Pure crypto and protocol logic — no filesystem ACL calls, so this suite runs
 * fast and identically on every platform.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';

import {
  IdentityError, generateUuid, isUuid, assertUuid,
  generateKeyPair, publicJwkOf, keyId, importPrivateKey, importPublicKey, isPublicOnlyJwk, MIN_MODULUS_BITS,
  buildIdentityClaim, signIdentity, verifyIdentity, verifyEnrollment, assertAgentName,
  verifyWithPublicKey, normalizePublicKey, inspectAttestation,
  createProof, verifyProof, createReplayStore, assertLocalEndpoint, bodyHash,
  buildEnrollment, validateRegistry, attestationReport,
  validateTerminalConfig, createAgentIdentity, canonicalJSON, describe,
} from '../src/index.mjs';

const silent = async fn => {
  try { await fn(); return null; } catch (error) { return error; }
};
const expectCode = async (fn, code) => {
  const error = await silent(fn);
  assert.ok(error instanceof IdentityError, `expected IdentityError, got ${error}`);
  assert.equal(error.code, code);
  return error;
};

// A single key pair shared by the read-only assertions keeps the suite fast;
// tests that mutate or generate their own material do so explicitly.
const pair = await generateKeyPair();

test('uuid:生成与校验', async t => {
  await t.test('生成的 UUID 为 v4 且可校验', () => {
    const uuid = generateUuid();
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(isUuid(uuid), true);
    assert.equal(assertUuid(uuid), uuid);
  });
  await t.test('拒绝大写/错位/非字符串', async () => {
    for (const bad of ['ABC', '7F0F0D0E-0000-4000-8000-000000000000', '', null, 123]) {
      assert.equal(isUuid(bad), false);
      await expectCode(() => assertUuid(bad), 'UUID_INVALID');
    }
  });
});

test('keys:密钥对与 kid', async t => {
  await t.test('默认生成 RSA-3072，公钥可用', () => {
    assert.equal(pair.modulusLength, MIN_MODULUS_BITS);
    assert.equal(pair.publicJwk.kty, 'RSA');
    assert.equal(pair.publicJwk.alg, 'RS256');
    assert.equal(pair.publicJwk.use, 'sig');
    assert.equal(createPublicKey(pair.publicPem).asymmetricKeyType, 'rsa');
  });
  await t.test('kid 是对 {e,kty,n} 的稳定摘要', () => {
    const expected = keyId({ e: pair.publicJwk.e, kty: 'RSA', n: pair.publicJwk.n });
    assert.equal(pair.kid, expected);
    assert.equal(publicJwkOf(pair.privatePem).kid, expected, 'PEM 与 KeyObject 推导一致');
    assert.equal(publicJwkOf(pair.privateKey).kid, expected);
  });
  await t.test('拒绝弱密钥（2048 位）', async () => {
    await expectCode(() => generateKeyPair({ modulusLength: 2048 }), 'KEY_STRENGTH');
  });
  await t.test('导入私钥后不能作为公钥误用', async () => {
    assert.equal(importPrivateKey(pair.privatePem).type, 'private');
    assert.equal(importPublicKey(pair.publicJwk).type, 'public');
    await expectCode(() => importPrivateKey(pair.publicPem), 'KEY_TYPE');
  });
  await t.test('公钥 JWK 判定不含私钥参数', () => {
    assert.equal(isPublicOnlyJwk(pair.publicJwk), true);
    assert.equal(isPublicOnlyJwk({ ...pair.publicJwk, d: 'x' }), false);
  });
});

test('identity:对 Agent 名称 + UUID 签名与验签', async t => {
  const identity = await createAgentIdentity({ agentName: 'build' });

  await t.test('签名包含 uuid/agent/kid，且可被公钥验证', () => {
    assert.equal(identity.attestation.claim.sub, identity.uuid);
    assert.equal(identity.attestation.claim.agent, 'build');
    assert.equal(identity.attestation.signature.kid, identity.kid);
    const claim = verifyIdentity(identity.attestation, { publicKey: identity.publicJwk });
    assert.equal(claim.sub, identity.uuid);
    assert.equal(claim.agent, 'build');
    assert.equal(Object.isFrozen(claim), true);
  });

  await t.test('紧凑 token 与结构化对象等价', () => {
    assert.equal(typeof identity.attestation.token, 'string');
    assert.equal(identity.attestation.token.split('.').length, 3);
    const fromToken = verifyIdentity(identity.attestation.token, { publicKey: identity.publicJwk });
    const fromObject = verifyIdentity(identity.attestation, { publicKey: identity.publicJwk });
    assert.deepEqual(fromToken, fromObject);
  });

  await t.test('篡改 claim 后验签失败', async () => {
    const [head, , sig] = identity.attestation.token.split('.');
    const forged = JSON.parse(Buffer.from(identity.attestation.token.split('.')[1], 'base64url').toString('utf8'));
    forged.agent = 'plan';
    const token = `${head}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
    await expectCode(() => verifyIdentity(token, { publicKey: identity.publicJwk }), 'ATTESTATION_SIGNATURE');
  });

  await t.test('换一个公钥验签失败', async () => {
    const other = await createAgentIdentity({ agentName: 'plan' });
    await expectCode(() => verifyIdentity(identity.attestation, { publicKey: other.publicJwk }), 'ATTESTATION_KID_MISMATCH');
  });

  await t.test('期望的 UUID / 名称不匹配时拒绝', async () => {
    await expectCode(() => verifyIdentity(identity.attestation, { publicKey: identity.publicJwk, expectedUuid: generateUuid() }), 'ATTESTATION_UUID');
    await expectCode(() => verifyIdentity(identity.attestation, { publicKey: identity.publicJwk, expectedAgent: 'plan' }), 'ATTESTATION_AGENT');
  });

  await t.test('畸形输入一律拒绝且错误码稳定', async () => {
    for (const bad of ['', 'a.b', 'not-a-token', null, 42, {}]) {
      const error = await silent(() => verifyIdentity(bad, { publicKey: identity.publicJwk }));
      assert.ok(error instanceof IdentityError);
      assert.equal(error.message, 'Agent authentication failed');
    }
  });

  await t.test('非法 Agent 名称被拒', async () => {
    await expectCode(() => assertAgentName('bad name'), 'AGENT_INVALID');
    await expectCode(() => assertAgentName('x'.repeat(129)), 'AGENT_INVALID');
    assert.equal(assertAgentName('build'), 'build');
  });

  await t.test('claim 规范化：字段顺序不影响签名', () => {
    assert.equal(canonicalJSON({ b: 1, a: 2 }), canonicalJSON({ a: 2, b: 1 }));
    assert.equal(canonicalJSON({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalJSON([1, { z: 1, y: 2 }]), '[1,{"y":2,"z":1}]');
  });
});

test('verifyWithPublicKey:只持有公钥即可验签', async t => {
  const uuid = generateUuid();
  const attestation = signIdentity({ uuid, agentName: 'build', privateKey: pair.privatePem });

  await t.test('JWK 对象', () => {
    const result = verifyWithPublicKey(attestation, pair.publicJwk);
    assert.equal(result.verified, true);
    assert.equal(result.claim.sub, uuid);
    assert.equal(result.kid, pair.kid);
    assert.equal(result.modulusBits, MIN_MODULUS_BITS);
  });
  await t.test('SPKI PEM 字符串', () => {
    const result = verifyWithPublicKey(attestation.token, pair.publicPem);
    assert.equal(result.claim.agent, 'build');
    assert.equal(result.publicPem.trim(), pair.publicPem.trim());
  });
  await t.test('JWK 的 JSON 字符串 / 包了一层 publicJwk', () => {
    assert.equal(verifyWithPublicKey(attestation, JSON.stringify(pair.publicJwk)).claim.sub, uuid);
    assert.equal(verifyWithPublicKey(attestation, JSON.stringify({ publicJwk: pair.publicJwk })).claim.sub, uuid);
  });
  await t.test('私钥也可作为输入，但只使用公钥部分', () => {
    const result = verifyWithPublicKey(attestation, pair.privatePem);
    assert.equal(result.claim.sub, uuid);
    assert.ok(!('d' in result.publicJwk), '导出的 JWK 不得包含私钥参数');
  });
  await t.test('另一把公钥 -> ATTESTATION_KID_MISMATCH', async () => {
    const other = await generateKeyPair();
    await expectCode(() => verifyWithPublicKey(attestation, other.publicJwk), 'ATTESTATION_KID_MISMATCH');
  });
  await t.test('篡改 claim 后签名失效 -> ATTESTATION_SIGNATURE', async () => {
    const forged = { ...attestation, claim: { ...attestation.claim, agent: 'plan' } };
    await expectCode(() => verifyWithPublicKey(forged, pair.publicJwk), 'ATTESTATION_SIGNATURE');
  });
  await t.test('expectedAgent / expectedUuid / expectedKid 都会参与断言', async () => {
    assert.equal(verifyWithPublicKey(attestation, pair.publicJwk, { expectedAgent: 'build', expectedUuid: uuid }).verified, true);
    await expectCode(() => verifyWithPublicKey(attestation, pair.publicJwk, { expectedAgent: 'plan' }), 'ATTESTATION_AGENT');
    await expectCode(() => verifyWithPublicKey(attestation, pair.publicJwk, { expectedUuid: generateUuid() }), 'ATTESTATION_UUID');
    await expectCode(() => verifyWithPublicKey(attestation, pair.publicJwk, { expectedKid: 'nope' }), 'ATTESTATION_KID_MISMATCH');
  });
  await t.test('normalizePublicKey 对各种输入给出同一个 kid', () => {
    const keys = [pair.publicJwk, pair.publicPem, pair.privatePem, JSON.stringify(pair.publicJwk)]
      .map(material => normalizePublicKey(material));
    for (const key of keys) {
      assert.equal(key.kid, pair.kid);
      assert.match(key.pem, /BEGIN PUBLIC KEY/);
      assert.equal(key.modulusBits, MIN_MODULUS_BITS);
    }
  });
  await t.test('伪造 kid 字段不影响验签（kid 由密钥本身推导）', async () => {
    const other = await generateKeyPair();
    const forgedKey = { ...other.publicJwk, kid: pair.kid };
    await expectCode(() => verifyWithPublicKey(attestation, forgedKey), 'ATTESTATION_KID_MISMATCH');
  });
  await t.test('无法解析的公钥 -> KEY_PARSE', async () => {
    await expectCode(() => normalizePublicKey('not a key'), 'KEY_PARSE');
  });
  await t.test('inspectAttestation 只解码不验签', () => {
    const forged = { ...attestation, claim: { ...attestation.claim, agent: 'plan' } };
    const info = inspectAttestation(forged);
    assert.equal(info.claim.agent, 'plan');
    assert.equal(info.claimedUuid, uuid);
    assert.equal(info.claimedKid, pair.kid);
    assert.ok(info.signatureBytes > 300);
  });
});

test('registry:注册表与身份证明', async t => {
  const build = await createAgentIdentity({ agentName: 'build' });
  const plan = await createAgentIdentity({ agentName: 'plan' });

  await t.test('合法注册表通过校验并可生成报告', () => {
    const registry = validateRegistry({ version: 1, agents: [build.enrollment, plan.enrollment] });
    assert.equal(registry.agents.length, 2);
    const report = attestationReport(registry);
    assert.deepEqual(report.map(r => r.status), ['verified', 'verified']);
  });

  await t.test('把注册表里的 agentName 改成别的名字会被证明校验拦下', async () => {
    const tampered = { version: 1, agents: [{ ...build.enrollment, agentName: 'plan' }] };
    const error = await expectCode(() => validateRegistry(tampered), 'ATTESTATION_AGENT');
    assert.equal(error.code, 'ATTESTATION_AGENT');
  });

  await t.test('换掉 publicJwk 会被 kid 校验拦下', async () => {
    const swapped = { version: 1, agents: [{ ...build.enrollment, publicJwk: plan.publicJwk }] };
    await expectCode(() => validateRegistry(swapped), 'REGISTRY_KID');
  });

  await t.test('含私钥参数的注册表被拒', async () => {
    const leaky = { version: 1, agents: [{ ...build.enrollment, publicJwk: { ...build.publicJwk, d: 'x' } }] };
    await expectCode(() => validateRegistry(leaky), 'REGISTRY_PRIVATE_KEY');
  });

  await t.test('重复 UUID / 名称被拒', async () => {
    await expectCode(() => validateRegistry({ version: 1, agents: [build.enrollment, { ...build.enrollment }] }), 'REGISTRY_DUPLICATE');
  });

  await t.test('requireAttestation 时缺失证明被拒', async () => {
    const { attestation: _omit, ...withoutAttestation } = build.enrollment;
    await expectCode(() => validateRegistry({ version: 1, agents: [withoutAttestation] }, { requireAttestation: true }), 'ATTESTATION_ABSENT');
    const lax = validateRegistry({ version: 1, agents: [withoutAttestation] });
    assert.equal(attestationReport(lax)[0].status, 'absent');
  });

  await t.test('enrollment 构建会拒绝私钥材料', async () => {
    await expectCode(() => buildEnrollment({ uuid: generateUuid(), agentName: 'x', publicJwk: { ...build.publicJwk, d: 'x' } }), 'REGISTRY_PRIVATE_KEY');
  });
});

test('proof:请求签名、绑定与重放', async t => {
  const agent = await createAgentIdentity({ agentName: 'build' });
  const url = 'http://127.0.0.1:8799/mcp';
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'whoami', arguments: {} } }));
  const registry = validateRegistry({ version: 1, agents: [agent.enrollment] });
  const resolveAgent = uuid => registry.agents.find(a => a.uuid === uuid);

  await t.test('签名后可用公钥验签并返回身份', () => {
    const token = createProof({ uuid: agent.uuid, agentName: 'build', privateKey: agent.privatePem, url, body, sessionId: 's1' });
    const identity = verifyProof(token, { resolveAgent, url, body, replay: createReplayStore() });
    assert.equal(identity.uuid, agent.uuid);
    assert.equal(identity.agentName, 'build');
    assert.equal(identity.kid, agent.kid);
    assert.equal(identity.sessionId, 's1');
    assert.equal(identity.verified, true);
    assert.equal(Object.isFrozen(identity), true);
  });

  await t.test('body 被改动 -> PROOF_BODY', async () => {
    const token = createProof({ uuid: agent.uuid, agentName: 'build', privateKey: agent.privateKey, url, body });
    await expectCode(() => verifyProof(token, { resolveAgent, url, body: Buffer.from('{}'), replay: createReplayStore() }), 'PROOF_BODY');
  });

  await t.test('受众不一致（端口不同）-> PROOF_AUDIENCE', async () => {
    const token = createProof({ uuid: agent.uuid, agentName: 'build', privateKey: agent.privateKey, url, body });
    await expectCode(() => verifyProof(token, { resolveAgent, url: 'http://127.0.0.1:9000/mcp', body, replay: createReplayStore() }), 'PROOF_AUDIENCE');
  });

  await t.test('方法不一致 -> PROOF_METHOD', async () => {
    const token = createProof({ uuid: agent.uuid, agentName: 'build', privateKey: agent.privateKey, url, body });
    await expectCode(() => verifyProof(token, { resolveAgent, url, body, method: 'PUT', replay: createReplayStore() }), 'PROOF_METHOD');
  });

  await t.test('重放被拒，且 nonce 按 uuid:kid:jti 记录', async () => {
    const token = createProof({ uuid: agent.uuid, agentName: 'build', privateKey: agent.privateKey, url, body });
    const replay = createReplayStore();
    verifyProof(token, { resolveAgent, url, body, replay });
    await expectCode(() => verifyProof(token, { resolveAgent, url, body, replay }), 'PROOF_REPLAY');
    assert.equal(replay.size, 1);
  });

  await t.test('过期与超长 TTL 被拒', async () => {
    const expired = createProof({ uuid: agent.uuid, agentName: 'build', privateKey: agent.privateKey, url, body, now: Math.floor(Date.now() / 1000) - 120 });
    await expectCode(() => verifyProof(expired, { resolveAgent, url, body, replay: createReplayStore() }), 'PROOF_EXPIRED');
    await expectCode(() => createProof({ uuid: agent.uuid, agentName: 'build', privateKey: agent.privateKey, url, body, ttl: 120 }), 'PROOF_TTL');
  });

  await t.test('未来时间超出时钟偏移 -> PROOF_NOT_YET_VALID', async () => {
    const future = createProof({ uuid: agent.uuid, agentName: 'build', privateKey: agent.privateKey, url, body, now: Math.floor(Date.now() / 1000) + 60 });
    await expectCode(() => verifyProof(future, { resolveAgent, url, body, replay: createReplayStore() }), 'PROOF_NOT_YET_VALID');
  });

  await t.test('未登记 / 已撤销 / 名称不符 -> 拒绝', async () => {
    const token = createProof({ uuid: agent.uuid, agentName: 'build', privateKey: agent.privateKey, url, body });
    await expectCode(() => verifyProof(token, { resolveAgent: () => undefined, url, body, replay: createReplayStore() }), 'PROOF_UNKNOWN_AGENT');
    await expectCode(() => verifyProof(token, { resolveAgent: () => ({ ...agent.enrollment, enabled: false }), url, body, replay: createReplayStore() }), 'PROOF_DISABLED');
    await expectCode(() => verifyProof(token, { resolveAgent: () => ({ ...agent.enrollment, agentName: 'plan' }), url, body, replay: createReplayStore() }), 'PROOF_AGENT_MISMATCH');
  });

  await t.test('签名被篡改 -> PROOF_SIGNATURE', async () => {
    const token = createProof({ uuid: agent.uuid, agentName: 'build', privateKey: agent.privateKey, url, body });
    const parts = token.split('.');
    const flipped = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}${parts[2].endsWith('AA') ? 'BB' : 'AA'}`;
    const error = await silent(() => verifyProof(flipped, { resolveAgent, url, body, replay: createReplayStore() }));
    assert.ok(['PROOF_SIGNATURE', 'PROOF_MALFORMED'].includes(error.code), error.code);
  });

  await t.test('仅接受回环地址', async () => {
    assert.equal(assertLocalEndpoint('http://127.0.0.1:8781/mcp'), 'http://127.0.0.1:8781/mcp');
    for (const bad of ['http://evil.example/mcp', 'https://127.0.0.1:8781/mcp', 'http://127.0.0.1:8781/other', 'http://user:pw@127.0.0.1:8781/mcp']) {
      await expectCode(() => assertLocalEndpoint(bad), 'ENDPOINT_INVALID');
    }
  });

  await t.test('bodyHash 与参考实现一致（hex sha256）', () => {
    assert.equal(bodyHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

test('client:配置校验', async t => {
  const agent = await createAgentIdentity({ agentName: 'build' });
  const base = {
    version: 1,
    serverUrl: 'http://127.0.0.1:8781/mcp',
    workspaceRoot: process.platform === 'win32' ? 'C:\\workspace' : '/tmp/workspace',
    agents: [{ agentName: 'build', uuid: agent.uuid, privateKeyFile: process.platform === 'win32' ? 'C:\\identity\\private.pem' : '/tmp/identity/private.pem' }],
  };

  await t.test('合法配置被规范化', () => {
    const config = validateTerminalConfig(base);
    assert.equal(config.serverUrl, 'http://127.0.0.1:8781/mcp');
    assert.equal(Object.isFrozen(config), true);
  });

  await t.test('重复 Agent / 非绝对路径 / 非回环地址被拒', async () => {
    await expectCode(() => validateTerminalConfig({ ...base, agents: [...base.agents, { ...base.agents[0] }] }), 'CONFIG_INVALID');
    await expectCode(() => validateTerminalConfig({ ...base, agents: [{ ...base.agents[0], privateKeyFile: 'rel/private.pem' }] }), 'CONFIG_INVALID');
    await expectCode(() => validateTerminalConfig({ ...base, serverUrl: 'http://10.0.0.1:8781/mcp' }), 'ENDPOINT_INVALID');
  });
});

test('interop:与参考实现的 proof 令牌双向兼容', async t => {
  const agent = await createAgentIdentity({ agentName: 'build' });
  const url = 'http://127.0.0.1:8799/mcp';
  const body = Buffer.from('{"jsonrpc":"2.0","id":"1","method":"ping"}');
  const registry = validateRegistry({ version: 1, agents: [agent.enrollment] });
  const resolveAgent = uuid => registry.agents.find(a => a.uuid === uuid);

  await t.test('SDK 生成的 token 结构符合参考格式', () => {
    const token = createProof({ uuid: agent.uuid, agentName: 'build', privateKey: agent.privateKey, url, body });
    const [head, claim] = token.split('.');
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(claim, 'base64url').toString('utf8'));
    assert.deepEqual(Object.keys(header).sort(), ['alg', 'kid', 'typ']);
    assert.equal(header.alg, 'RS256');
    assert.equal(header.typ, 'mcp-agent-proof+jwt');
    assert.equal(claims.ver, 1);
    assert.equal(claims.aud, url);
    assert.equal(claims.path, '/mcp');
    assert.equal(claims.method, 'POST');
    assert.equal(claims.exp - claims.iat, 30);
    assert.equal(claims.body_sha256, bodyHash(body));
  });

  await t.test('用参考实现的字段顺序/序列化方式构造的 token 也能验过', () => {
    // Reference implementation: JSON.stringify with insertion order, base64url, RS256.
    // Re-encoding the same claims in a different key order must still verify,
    // because verification signs over the received bytes, not a canonical form.
    const token = createProof({ uuid: agent.uuid, agentName: 'build', privateKey: agent.privateKey, url, body });
    const identity = verifyProof(token, { resolveAgent, url, body, replay: createReplayStore() });
    assert.equal(identity.uuid, agent.uuid);
  });
});

test('describe:对外声明的 API 与实际导出一致', () => {
  const info = describe();
  assert.equal(info.name, '@opencode-identity/sdk');
  assert.equal(info.modules.length, 7);
  for (const module of info.modules) assert.ok(module.methods.length > 0);
});
