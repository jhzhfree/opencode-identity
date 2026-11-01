# @opencode-identity/sdk

Agent 身份的**唯一密码学实现**。零依赖、纯 ESM、可与任何 Node ≥ 20.11 项目组合。

生成侧（插件生成工具）用它签发身份，验证侧（MCP 服务端）用它验签，两边共用同一份签名规则，
不存在"生成端算一种、服务端算另一种"的漂移风险。

```
generateKeyPair ─┐
generateUuid ────┤
                 ├─→ signIdentity  （私钥签 Agent 名称 + UUID）
                 │        │
                 │        └─→ verifyIdentity（公钥验签，离线可验）
                 │
                 └─→ createProof   （私钥签单次请求：body + 方法 + 受众 + 时效）
                          │
                          └─→ verifyProof（服务端验签 + 重放防护）
```

## 安装 / 引入

本仓库里它就是一个**独立程序**，不需要安装：

```bash
node packages/identity-sdk/bin/sdk.mjs            # 无参数 = 交互菜单（双击 start.cmd 也是这个）
node packages/identity-sdk/bin/sdk.mjs describe   # 看能力
./packages/identity-sdk/start.sh selftest         # POSIX
```

包内直接引用（插件生成工具与 MCP 服务端就是这么用的）：

```js
import { createAgentIdentity, verifyIdentity, validateRegistry } from './packages/identity-sdk/src/index.mjs';
```

作为本地包安装：

```bash
npm install ../packages/identity-sdk
```

```js
import { createAgentIdentity } from '@opencode-identity/sdk';
```

## 四个核心动作

### 1. 生成密钥对

```js
import { generateKeyPair } from '@opencode-identity/sdk';

const pair = await generateKeyPair();          // RSA-3072，低于 3072 位直接抛错
pair.privatePem    // PKCS#8 PEM，只该落在受保护目录
pair.publicJwk     // { kty:'RSA', n, e, kid, alg:'RS256', use:'sig' }
pair.kid           // base64url(SHA-256('{"e","kty","n"}'))，与参考实现字节一致
```

`kid` 的推导刻意保持与 1.1.0 原包相同，因此旧注册表、旧令牌都能继续用。

### 2. 生成 UUID

```js
import { generateUuid, isUuid, assertUuid } from '@opencode-identity/sdk';

const uuid = generateUuid();   // v4，小写规范形式
isUuid(uuid);                  // true
assertUuid('ABC');             // 抛 IdentityError(code: 'UUID_INVALID')
```

### 3. 用私钥签「Agent 信息 + UUID」，用公钥验签

这是本 SDK 的核心能力。签名对象是 claim：`{ v, iss, sub: UUID, agent: 名称, kid, iat }`。

```js
import { signIdentity, verifyIdentity } from '@opencode-identity/sdk';

const attestation = signIdentity({
  uuid: '0f3c…',
  agentName: 'build',
  privateKey: pair.privatePem,
});

// attestation = {
//   version: 1,
//   claim:     { v:1, iss:'opencode-identity-sdk', sub:'0f3c…', agent:'build', kid:'…', iat:1730… },
//   signature: { alg:'RS256', typ:'agent-identity+attestation', kid:'…', value:'…' },
//   token:     'header.claim.signature'      // 紧凑三段式，方便当字符串传
// }

// 任何只拿到公钥的一方都能离线验：
const claim = verifyIdentity(attestation, {
  publicKey: pair.publicJwk,
  expectedUuid: '0f3c…',
  expectedAgent: 'build',
});
```

#### 只用公钥验签（第三方视角）

`verifyWithPublicKey(attestation, publicKey, options?)` 是给「只有公钥」的一方用的入口：
不需要私钥、不需要注册表、不需要网络。公钥可以是 SPKI PEM、JWK 对象、JWK 的 JSON 字符串，
甚至是不小心传了私钥（只会取公钥部分，返回值里不会出现私钥参数）。

```js
import { verifyWithPublicKey, normalizePublicKey, inspectAttestation } from '@opencode-identity/sdk';

// 1) PEM —— 最贴近「别人把公钥文件发给你」的场景
const result = verifyWithPublicKey(token, publicPem, { expectedAgent: 'build' });
// {
//   verified: true,
//   claim:  { sub, agent, kid, iat, … },
//   kid:    '…',            // 由公钥本身推导，不信任 claim 里的 kid
//   modulusBits: 3072,
//   publicPem, publicJwk
// }

// 2) JWK 对象 / JSON 字符串
verifyWithPublicKey(token, publicJwk);
verifyWithPublicKey(token, JSON.stringify({ publicJwk }));

// 3) 只归一化公钥，拿指纹做比对
const { kid, pem, modulusBits } = normalizePublicKey(anyKeyMaterial);

// 4) 只解码、不验签（用于 UI 展示「这个 token 声称自己是谁」）
const info = inspectAttestation(token);
// { header, claim, signatureBytes, claimedKid, claimedUuid, claimedAgent }
```

`kid` 一律由密钥材料现算，传入的 `kid` 字段不参与判定，所以伪造 `kid` 无法绕过。
`normalizePublicKey` 遇到无法解析的材料抛 `KEY_PARSE`，弱于 3072 位抛 `KEY_WEAK`。
`inspectAttestation` 的输出**不可信**，只用于展示，真伪必须走 `verifyWithPublicKey`。

验签失败一律抛 `IdentityError`，`message` 固定为 `Agent authentication failed`（不泄露失败原因），
具体原因看 `error.code`：

| code | 含义 |
| --- | --- |
| `ATTESTATION_MALFORMED` | 不是三段式 token，或结构/版本/签发者不对 |
| `ATTESTATION_ALG` | 算法或 typ 不是 RS256 / `agent-identity+attestation` |
| `ATTESTATION_KID_MISMATCH` | 公钥与 kid 不符（key 被换过） |
| `ATTESTATION_SIGNATURE` | 签名对不上（claim 被改过） |
| `ATTESTATION_UUID` / `ATTESTATION_AGENT` | 与期望的 UUID / Agent 名称不一致 |

签名输入是 `base64url(canonical(header)) + '.' + base64url(canonical(claim))`，
其中 `canonical` 递归排序对象键，所以字段顺序、JSON 传输方式都不影响验签结果。

### 4. 给单次请求签名

身份证明回答"你是谁"，请求证明回答"这个 body、发给这个地址、在这一刻，确实是你发的"。

```js
import { createProof, verifyProof, createReplayStore } from '@opencode-identity/sdk';

const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'whoami', arguments: {} } }));
const token = createProof({
  uuid, agentName: 'build', privateKey: pair.privatePem,
  url: 'http://127.0.0.1:8781/mcp', body, sessionId: 'terminal',
});
// → 放进请求头 X-Agent-Proof
```

服务端：

```js
const replay = createReplayStore();
const identity = verifyProof(token, {
  resolveAgent: uuid => registry.agents.find(a => a.uuid === uuid),
  url: 'http://127.0.0.1:8781/mcp',
  body,
  replay,
});
// identity = { uuid, agentName, kid, sessionId, invocationId, verified: true }  （已冻结）
```

证明与以下内容强绑定，任何一项不符都会失败：

| 绑定项 | 失败 code |
| --- | --- |
| 请求体 SHA-256 | `PROOF_BODY` |
| HTTP 方法 / 路径 `/mcp` | `PROOF_METHOD` / `PROOF_PATH` |
| 受众 URL（必须是回环地址） | `PROOF_AUDIENCE` |
| 有效期（默认 30s，最多 30s） | `PROOF_EXPIRED` / `PROOF_TIME` |
| 时钟偏移（未来 5s 以上） | `PROOF_NOT_YET_VALID` |
| `jti` 唯一性 | `PROOF_REPLAY` |
| 注册表中的 UUID / 名称 / kid / enabled | `PROOF_UNKNOWN_AGENT` / `PROOF_AGENT_MISMATCH` / `PROOF_KID_MISMATCH` / `PROOF_DISABLED` |
| 签名本身 | `PROOF_SIGNATURE` |

令牌格式与 1.1.0 原包**字节兼容**：SDK 签的请求原包服务端能验，原包签的请求 SDK 服务端也能验。

## 注册表

```js
import { validateRegistry, attestationReport, buildEnrollment } from '@opencode-identity/sdk';

const registry = validateRegistry(json, { requireAttestation: true });
// 结构校验：uuid/名称唯一、只含公钥、kid 与公钥一致、RSA ≥ 3072
// 证明校验：每条 enrollment.attestation 用 publicJwk 验签，确认「名称 + UUID」没被换过

attestationReport(registry);
// [{ agentName:'build', status:'verified' }, …]  status: verified | absent | invalid
```

只改注册表里的 `agentName`、或把另一把公钥塞进来，都会被 `ATTESTATION_AGENT` / `REGISTRY_KID` 拦下
——这正是"公钥注册表被篡改"这一攻击面的封堵点。

## 一步到位

```js
import { createAgentIdentity } from '@opencode-identity/sdk';

const identity = await createAgentIdentity({ agentName: 'build' });
identity.uuid / identity.kid / identity.privatePem / identity.publicJwk
identity.attestation          // 结构化 + token
identity.enrollment           // 可直接放进 registry.json 的一行
identity.files                // identity.json / public.jwk / enrollment.json 三个文件的内容
```

## 带签名的客户端

CLI、Studio、部署脚本共用同一实现（`client.mjs`）：

```js
import { validateTerminalConfig, readPrivateKeyFile, createSignedClient } from '@opencode-identity/sdk';

const config = validateTerminalConfig(JSON.parse(text));
const privateKey = await readPrivateKeyFile(config.agents[0].privateKeyFile, { workspaceRoot: config.workspaceRoot });
const client = createSignedClient({ serverUrl: config.serverUrl, uuid, agentName: 'build', privateKey });

await client.whoami();                                  // 服务端验证到的身份
await client.callTool('add', { a: 12, b: 30 });          // { sum: 42, identity }
```

`readPrivateKeyFile` 会拒绝：相对路径、非普通文件、符号链接、超过 1MB、位于 Agent 工作区内。

## CLI

```bash
node bin/sdk.mjs describe
node bin/sdk.mjs keygen --out ./agent-build --agent build
node bin/sdk.mjs sign   --private ./agent-build/private.pem --agent build --out ./att.json
node bin/sdk.mjs verify --public ./agent-build/public.jwk --attestation ./agent-build/identity.json --agent build
node bin/sdk.mjs verify-public --public ./agent-build/public.pem --attestation ./agent-build/identity.json
node bin/sdk.mjs inspect --attestation ./agent-build/identity.json --public ./agent-build/public.jwk
node bin/sdk.mjs proof  --private ./agent-build/private.pem --agent build --uuid <uuid> --url http://127.0.0.1:8781/mcp --body ./req.json
node bin/sdk.mjs verify-proof --token ./proof.txt --registry ./registry.json --url http://127.0.0.1:8781/mcp --body ./req.json
node bin/sdk.mjs selftest
```

退出码：`0` 成功，`1` 验签/校验失败，`2` 用法错误。

## 测试

```bash
cd packages/identity-sdk
node --test test/sdk.test.mjs
```

57 条断言，覆盖密钥强度、kid 稳定性、签名/验签往返、**仅公钥验签（PEM / JWK / JSON / 私钥输入）**、
claim 篡改、错误公钥、伪造 kid、证明的 body/受众/方法/时效/重放、注册表篡改、以及与参考实现的格式互通。

## 边界

- 只做密码学与协议，**不做文件加固**。受保护目录的 ACL 硬化由生成器（`newFile`/`newDirectory`）负责。
- 私钥永远不进入 `publicJwk` / registry / 日志；`isPublicOnlyJwk` 会在写入注册表前拦一道。
- `assertLocalEndpoint` 只接受 `http://127.0.0.1|localhost|[::1]:<port>/mcp`，避免把证明发给外部主机。
