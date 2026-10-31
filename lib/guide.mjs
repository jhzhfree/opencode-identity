/** Generates a deployment guide filled with the real paths/UUIDs of this run. */
import path from 'node:path';

const nodeBin = (file) => `node "${file}"`;

export function buildGuide(ctx) {
  const {
    workspace, dataDir, port, serverUrl, agents, entries, fragments,
    opencodeMajor, legacyReadOnly, serverBin, sdkCli, sdkDir, opencodeVersion,
  } = ctx;
  const agentRows = agents.map(a => `| ${a.agentName} | \`${a.uuid}\` | \`${a.kid}\` |`).join('\n');
  const verifyLines = agents.map(a => `${nodeBin(sdkCli)} verify-agent --config "${path.join(dataDir, 'terminal-config.json')}" --agent ${a.agentName}`).join('\n');
  const mergeV1 = fragments.v1
    ? `"plugin": ["${entries.v1.replace(/\\/g, '/').replace(/^/, 'file:///')}"],\n"permission": { "identity_whoami": "ask", "identity_echo": "ask", "identity_add": "ask" }`
    : null;
  const mergeV2 = fragments.v2
    ? `"plugins": [{ "package": "${entries.v2.replace(/\\/g, '/').replace(/^/, 'file:///')}" }],\n"permissions": [\n  { "action": "identity_whoami", "resource": "*", "effect": "ask" },\n  { "action": "identity_echo", "resource": "*", "effect": "ask" },\n  { "action": "identity_add", "resource": "*", "effect": "ask" }\n]`
    : null;

  return `# MCP Agent 身份插件 · 部署说明

本文件由 OpenCode Identity Studio 生成，其中路径、端口、UUID 均为本次生成的真实值。

## 一、本次生成结果

| 项目 | 值 |
| --- | --- |
| 目标工作区 | \`${workspace}\` |
| 身份数据目录 | \`${dataDir}\` |
| MCP 服务地址 | \`${serverUrl}\` |
| 生成的主版本 | ${opencodeMajor === 'both' ? 'OpenCode 1.x + 2.x' : `OpenCode ${opencodeMajor}.x`} |
| 宿主版本探测 | ${opencodeVersion ? `\`${opencodeVersion}\`` : '未检测到本地 CLI'} |
| legacyReadOnly | ${legacyReadOnly ? 'true（仅限无审批 API 的早期宿主）' : 'false'} |

| Agent | UUID | 公钥指纹 (kid) |
| --- | --- | --- |
${agentRows}

## 二、目录结构

\`\`\`
${dataDir}
├── registry.json            # 公钥注册表（含每个 Agent 的身份证明签名）
├── terminal-config.json     # 终端配置（含私钥路径，勿外传）
├── agent-1 … agent-${agents.length}/          # private.pem / public.jwk / identity.json（含签名）/ enrollment.json
├── plugin/                  # 生成的插件${opencodeMajor === 'both' ? '（含 1.x 与 2.x 两个入口）' : ''}
├── start-server.ps1
└── verify.ps1
\`\`\`

> 数据目录必须保持在 Agent 工作区之外；本工具已校验。**不要移动该目录**——插件与配置里是绝对路径。确实要移动时，用 \`lab.mjs plugin --config <新配置> --out <新目录>\` 重新生成插件，不要重建身份。

## 三、启动 MCP 服务端

服务端必须常驻，插件每次工具调用都会向它发起签名请求。它由 SDK 验签，注册表里的身份证明也会在启动和变更时校验。

\`\`\`powershell
${nodeBin(serverBin)} --registry "${path.join(dataDir, 'registry.json')}" --port ${port}
\`\`\`

或直接运行 \`${path.join(dataDir, 'start-server.ps1')}\`。默认只监听 127.0.0.1，健康检查 \`GET ${serverUrl.replace('/mcp', '/health')}\`。

## 四、合并 OpenCode 配置

### OpenCode ${opencodeMajor === 'both' ? '1.x' : opencodeMajor + '.x'}${opencodeMajor === 'both' ? '（如使用 1.x）' : ''}

${mergeV1 ? `把下面两项合并进全局 \`opencode.json\`（保留已有 plugin 与 permission，不要覆盖）：

\`\`\`json
{
${mergeV1.split('\n').map(l => '  ' + l).join('\n')}
}
\`\`\`

对应文件：\`${fragments.v1}\`（可直接复制）` : '本次未生成 1.x 入口。'}

${mergeV2 ? `
### OpenCode ${opencodeMajor === 'both' ? '2.x' : opencodeMajor + '.x'}

\`\`\`json
{
${mergeV2.split('\n').map(l => '  ' + l).join('\n')}
}
\`\`\`

对应文件：\`${fragments.v2}\`（可直接复制）` : ''}

> **只合并匹配当前宿主主版本的一份**。1.x 用 \`plugin\` + \`permission\`（文件入口），2.x 用 \`plugins\` + \`permissions\`（目录入口）。合并后重启 OpenCode。

## 五、在真实宿主中验证

\`\`\`powershell
Set-Location "${workspace}"
opencode run --agent ${agents[0]?.agentName ?? 'build'} '调用 identity_whoami，告诉我服务端验证到的 UUID 和 Agent 标识'
\`\`\`

预期返回的 UUID 与本文档表格中 \`${agents[0]?.agentName ?? 'build'}\` 一致。第二次用另一个 Agent 运行时，UUID 必须不同。

## 六、不经宿主直接验证（排错用）

\`\`\`powershell
${verifyLines}
\`\`\`

任选一个 Agent 调业务工具：

\`\`\`powershell
${nodeBin(sdkCli)} call-tool --config "${path.join(dataDir, 'terminal-config.json')}" --agent ${agents[0]?.agentName ?? 'build'} --tool add --args '{"a":12,"b":30}'
\`\`\`

## 七、SDK 组件（生成与验签共用）

身份的密码学实现只有一个：\`${sdkDir ?? 'packages/identity-sdk'}\`。
生成端用它签发，服务端用它验签，所以两边不可能算出差别的签名。

| 能力 | 方法 | 说明 |
| --- | --- | --- |
| 生成密钥对 | \`generateKeyPair()\` | RSA-3072，低于 3072 位直接拒绝 |
| 生成 UUID | \`generateUuid()\` | v4，作为 Agent 的信任锚 |
| 签名 | \`signIdentity({uuid, agentName, privateKey})\` | 私钥签「Agent 名称 + UUID」 |
| 验签 | \`verifyWithPublicKey(attestation, publicKey)\` | 只持有公钥即可离线验证；PEM / JWK / JSON 均可 |

验签通过后得到的 claim 里 \`sub\` 是 UUID、\`agent\` 是 Agent 名称、\`kid\` 是公钥指纹。
本次生成的两个 Agent 的签名已经写进 \`agent-N/identity.json\`，并随 \`registry.json\` 一起被服务端校验：

\`\`\`powershell
# 离线验签（不需要服务端）
${nodeBin(sdkCli)} verify --public "${path.join(dataDir, 'agent-1', 'public.jwk')}" --attestation "${path.join(dataDir, 'agent-1', 'identity.json')}" --agent ${agents[0]?.agentName ?? 'build'}

# 查看 SDK 能力清单
${nodeBin(sdkCli)} describe
\`\`\`

改注册表里的 Agent 名称、或把另一把公钥塞进某一行，服务端会以 \`ATTESTATION_AGENT\` / \`REGISTRY_KID\` 拒绝加载并提供 503，而不会把攻击者的名字当成合法身份。

## 八、安全边界

- 私钥（\`private.pem\`）只在本机数据目录内，从未通过网络发送；服务端只登记公钥。
- 每个请求的证明有效期 30 秒，带唯一 \`jti\`，服务端内存去重防重放。
- 每个注册表条目都带「Agent 名称 + UUID」的私钥签名；服务端加载时用公钥复核，改名字或换公钥都会被拒。
- 撤销某个 Agent：把 \`registry.json\` 中该条 \`enabled\` 改为 \`false\`，下一个请求立即被拒，无需重启。
- \`registry.json\` / \`terminal-config.json\` 已按当前账户设置 ACL 仅本人可读；请勿复制到工作区或提交到仓库。
- 身份与业务参数分离：模型在参数里填写 UUID / Agent 名 / \`verified:true\` 一律被服务端拒绝。

## 九、常见问题

| 现象 | 处理 |
| --- | --- |
| \`HTTP 401\` | UUID/名称未登记、kid 与私钥不匹配、\`enabled=false\`、系统时间偏差，或证明被重放 |
| \`HTTP 403\` | 改写了 Host 或带了其他 Origin；必须用 \`http://127.0.0.1:${port}/mcp\` |
| \`HTTP 503\` | 注册表缺失/无效，或服务账户无权读取 |
| 插件导入失败 | 1.x 必须用 \`identity-plugin.mjs\` 文件入口，2.x 必须用 \`opencode-v2\` 目录入口，二者不可混用 |
| "Executing OpenCode Agent is not registered" | 宿主里的 Agent 名与生成时的名称不一致；改名后需重新生成身份 |
| 调用很慢（每请求数秒） | Windows 上每次读取受保护文件都要调 PowerShell 校验 ACL，属已知开销 |
`;
}
