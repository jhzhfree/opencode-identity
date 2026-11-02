# 手动验证指南：从生成插件到确认"它真的是它"

面向要**在本机亲手跑一遍**并理解原理的人。全部命令与输出均为实机实测（Windows 11 / PowerShell 5.1 / Node v22.13.1 / OpenCode 2.2.5 桌面版），实测数据汇总在[附录 B](#附录-b本次实测数据)。

本文出现的真实路径按本机填写，换机器时替换 `<studio>`、`<dataDir>` 即可：

| 占位 | 本机取值 |
| --- | --- |
| `<studio>` | `E:\workspace\opencode-identity\studio` |
| `<workspace>` | `E:\workspace\opencode-identity\demo-project`（被 Agent 操作的工作区） |
| `<dataDir>` | `C:\Users\<你>\mcp-identity\<任意名字>`（身份数据目录，**必须在工作区之外**） |

---

## 0. 跑完能确认什么

1. 身份是**本机生成**的：每个 Agent 一对 RSA-3072 密钥 + 一个 UUID，私钥只落在 `<dataDir>` 里，从不上网。
2. 服务端**只用公钥就能验出**"这个请求来自哪个 Agent"，且不采信客户端在参数里自报的身份。
3. 生成的插件能装进 OpenCode，把宿主里某个 Agent 的工具调用变成**带签名**的 HTTP 请求。
4. **篡改、重放、伪造身份**都会被拒（返回码可判定，不是"看起来像成功了"）。
5. 每次调用在服务端留下**一行结构化审计日志**，能用 `invocationId` 对上一次具体调用。

---

## 1. 原理骨架

### 1.1 三个程序，各自独立

| # | 程序 | 入口 | 默认端口 | 职责 |
| --- | --- | --- | --- | --- |
| 1 | 插件生成工具（Web UI） | `apps/plugin-studio/server.mjs` | 4180 | 探测宿主 → 生成密钥/注册表 → 生成插件 → 打包 |
| 2 | SDK（CLI + 库） | `packages/identity-sdk/bin/sdk.mjs` | 无 | **唯一**的密码学实现：密钥、UUID、签名、验签、请求证明 |
| 3 | MCP 验签服务端 | `apps/mcp-server/bin/serve.mjs` | 8781（可改） | 验签 + 执行 `whoami` / `echo_secure` / `add` |

程序 1 与 3 都调用程序 2，**没有第二份签名/验签代码**。所以"生成端签的、服务端验不过"这种漂移在结构上不会出现。

### 1.2 三类产物

| 产物 | 是什么 | 装在哪 | 谁读它 |
| --- | --- | --- | --- |
| **插件** | 三个工具的壳，把调用转成签名请求 | OpenCode 配置里引用（1.x 一个文件 / 2.x 一个目录） | OpenCode 宿主进程 |
| **MCP 服务端** | 验签 + 业务工具 | 本机常驻进程，只绑 `127.0.0.1` | 插件（HTTP + `X-Agent-Proof`） |
| **身份数据** | 私钥、公钥注册表、终端配置 | `<dataDir>`（工作区之外） | 插件读私钥，服务端读注册表 |

插件本身**不含任何密钥**：它只内嵌 `<dataDir>\terminal-config.json` 的绝对路径，运行时去读私钥。这就是"目录不能随便搬"的原因。

### 1.3 两条签名链（理解这两条，后面全都通了）

```
① 身份证明 attestation（一次性，生成时签）
   私钥 ──签──▶ claim { sub: UUID, agent: 名称, kid, iat }
                │
                ├─ 存进 agent-N/identity.json
                └─ 同一份存进 registry.json 的对应行
   任何人拿 publicJwk 都能离线验 ──▶ 证明"这个 UUID 与这个名称绑在一起"

② 请求证明 X-Agent-Proof（每次调用都签，30 秒有效，一次性 jti）
   私钥 ──签──▶ { body 的 SHA-256, method, path, aud(服务端 URL), exp, jti }
                │
                └─ HTTP 头 X-Agent-Proof: header.claim.signature
   服务端：验签 + 校验 6 项绑定 + 注册表比对 ──▶ 得到可信 identity
```

关键点：**身份不在请求参数里**。服务端只认 `X-Agent-Proof` 验签出的 `uuid / agentName / kid`，参数里塞 `agentName` 会直接被判非法参数（见 [6.5](#65-在参数里伪造身份必被拒)）。

---

## 2. 30 秒环境自检

```powershell
node -v
# v22.13.1  ← 必须 ≥ 22

node <studio>\packages\identity-sdk\bin\sdk.mjs selftest
# { "passed": 7, "failed": 0, ... }  ← SDK 密码学自检

node <studio>\apps\mcp-server\bin\serve.mjs -V
# { "program": "identity-mcp-server", "version": "1.2.0", "node": "v22.13.1",
#   "sdk": "<studio>\\packages\\identity-sdk" }

# OpenCode：桌面版 CLI 不一定在 PATH 里，直接查安装目录
& "$env:LOCALAPPDATA\Programs\ai.opencode.desktop\resources\opencode-cli.exe" --version
# 2.2.5
```

`-V` 里的 `sdk` 字段很重要：它告诉你服务端实际加载的是哪份 SDK（便携包场景下应为 `vendor\identity-sdk`）。

---

## 3. 路线 A：用生成工具（Web UI）制作插件

### 3.1 启动生成工具

```powershell
cd <studio>
node apps\plugin-studio\server.mjs      # 等价：.\start-studio.cmd
# 或换端口：$env:STUDIO_PORT=4181; node apps\plugin-studio\server.mjs
```

浏览器打开 `http://127.0.0.1:4180`。页面顶部 `/api/status` 会显示 Node、lab（插件模板）、sdk 三个版本与定位路径；这三个都 `found: true` 才继续。

### 3.2 页面上要填/确认的字段

| 字段 | 说明 | 本机示例 |
| --- | --- | --- |
| 工作区 | **绝对路径**，插件只允许在这个目录里生效（服务端用 `realpath` 比对） | `<workspace>` |
| Agent | 必须与宿主真实 Agent 名一致；2.2.5 是 `build / compaction / explore / general / plan / summary / title` | `build`、`plan` |
| 服务端端口 | 生成时写进 `terminal-config.json` 的 `serverUrl` | `8790` |
| 数据目录 | 默认 `%USERPROFILE%\mcp-identity\run-<时间戳>`；**不要放在工作区内** | `<dataDir>` |
| 目标主版本 | 1.x / 2.x / 两个都生成；探测到 2.2.5 就选 2 | `2` |

Agent 名单怎么确认：

```powershell
& "$env:LOCALAPPDATA\Programs\ai.opencode.desktop\resources\opencode-cli.exe" debug agents   # 2.x
& "$env:LOCALAPPDATA\Programs\ai.opencode.desktop\resources\opencode-cli.exe" agent list     # 1.x（2.x 已移除）
```

### 3.3 生成过程（8 步，实测 2 个 Agent 约 72 秒）

| 步骤 | 实测耗时 | 说明 |
| --- | --- | --- |
| 校验工作区与输出目录 | 1 ms | 拒绝工作区内的目录、拒绝已存在的非空冲突目录 |
| 创建受保护数据目录 | 1.9 s | 建目录并设 ACL（仅当前账户可读） |
| 调用 SDK 生成 UUID 与 RSA-3072 密钥对 | 27.8 s | 每个 Agent 一对；RSA 生成是主要耗时 |
| 用私钥签发身份证明并写入注册表 | 2.4 s | `signIdentity()` → `registry.json` |
| 写入 `terminal-config.json` | 2.5 s | 私钥绝对路径 + `serverUrl` + `workspaceRoot` |
| 生成 OpenCode 插件 | 28.9 s | 复制模板运行时到插件目录并改写为相对引用 |
| 生成启动脚本与部署文档 | 7.6 s | `start-server.ps1` / `verify.ps1` / `SETUP.md` |
| 打包 ZIP | 14 ms | store-only ZIP，不依赖原生模块 |

### 3.4 生成了哪些文件

```text
<dataDir>\
├── registry.json            公钥注册表：{version:1, agents:[…]}，每行含 attestation
├── terminal-config.json     插件运行时读它：私钥路径 / serverUrl / workspaceRoot
├── agent-1\                 每个 Agent 一个目录
│   ├── private.pem          RSA-3072 私钥（PKCS#8）—— 绝不外传
│   ├── public.jwk           公钥 JWK（含 kid 指纹）
│   ├── identity.json        claim + signature + token（身份证明）
│   └── enrollment.json      可直接放进 registry 的一行（上面几项的合并）
├── agent-2\ … agent-N\
├── plugin\
│   ├── identity-plugin.mjs          1.x 入口（文件），内嵌 configFile 绝对路径
│   ├── runtime\                     1.x 运行时（模板副本，插件自包含）
│   ├── opencode-v2\
│   │   ├── index.js                 2.x 入口（目录），内嵌 configFile 绝对路径
│   │   ├── package.json             type: module
│   │   └── runtime\                 2.x 运行时（同 7 个模块，入口为 opencode-plugin-v2.mjs）
│   ├── opencode.v1.fragment.json    1.x 配置片段（可直接复制进 opencode.jsonc）
│   ├── opencode.v2.fragment.json    2.x 配置片段
│   └── opencode.fragment.json       本次主版本的片段副本
├── start-server.ps1         一键起服务端（内嵌真实 registry 路径）
├── verify.ps1               逐个 Agent 向服务端验身
└── SETUP.md                 本次生成的真实路径版说明（含 UUID/kid 表格）
```

`plugin\runtime\` 里固定 7 个模块：`client.mjs`（签名客户端）、`proof.mjs`（请求证明）、`server.mjs`（工具 schema）、`protection.mjs`（路径/ACL 防护）、`files.mjs`、`opencode-compat.mjs`、`opencode-plugin(-v2).mjs`（宿主适配）。

**哪些能外传**：

| 文件 | 能外传？ |
| --- | --- |
| `agent-N\private.pem`、`terminal-config.json` | **不行** |
| `registry.json`、`plugin\*`、`SETUP.md`（含真实路径，注意脱敏） | 可以 |
| `agent-N\identity.json` / `public.jwk` | 可以（只含公钥与签名） |

### 3.5 在同一个页面完成"能跑通"的确认

生成的 `jobId` 会贯穿下面几个 API（页面上的按钮就是调它们）：

| 动作 | 接口 | 判据 |
| --- | --- | --- |
| 启动服务端 | `POST /api/server/start {jobId, port}` | 返回 `running:true`，日志出现 `listening` + `[ready]` |
| 签名调工具 | `POST /api/verify {jobId, agent, tool, args}` | `structured.identity.verified === true`，UUID 与 `SETUP.md` 表格一致 |
| 插件自检 | `POST /api/selftest {jobId}` → 轮询 `GET /api/jobs/:id` | `state:"done"`，只有一个 1.x 条目 `skip` |
| 下载部署包 | `GET /api/download/:jobId` | ZIP 含 `server/` 与 `server/packages/identity-sdk/`（自包含） |

实测 `POST /api/verify` 的 `whoami`：`initialize` 19 ms + `tools/call` 5 ms（总计 24 ms；注册表按 mtime 缓存，不是每次重读）。

> **自检的一个坑**：如果生成时选了"1.x + 2.x 都生成"，而本机没有 `@opencode-ai/plugin`（宿主包，只在 OpenCode 安装目录里），1.x 自检分支会以 `Cannot find package '@opencode-ai/plugin'` 失败。这只是**自检环境**缺包，与 2.x 插件和真实宿主使用无关。本机 2.2.5 只选 2.x 时是 **15 通过 / 0 失败 / 1 跳过**。

---

## 4. 路线 B：纯命令行最小闭环（不打开 UI）

用途：在没有界面、或想确认"每个文件都是什么"时，用 SDK 手工造一套身份，跑通 401→200 的完整链路。

### 4.1 生成两套身份

```powershell
$sdk = '<studio>\packages\identity-sdk\bin\sdk.mjs'
$d   = "$env:USERPROFILE\mcp-identity\manual-verify"

node $sdk keygen --out "$d\agent-1" --agent build
node $sdk keygen --out "$d\agent-2" --agent plan
```

输出（每个 Agent 一份）：

```json
{ "agentName": "build", "uuid": "61a08f6a-fef4-40e9-ac59-a2d41dfa2a41",
  "kid": "lWN8cRd65OZLAFAUx7U8jZxombKn5Lihb5u88bqCGvM", "out": "…\\agent-1" }
```

同时写出 `private.pem` / `public.jwk` / `identity.json` / `enrollment.json`（见 [3.4](#34-生成了哪些文件)）。

### 4.2 组装注册表与终端配置

注册表就是"每行一个 `enrollment.json`"：

```powershell
node -e "const fs=require('fs');const d=process.argv[1];const e=n=>JSON.parse(fs.readFileSync(d+'/agent-'+n+'/enrollment.json','utf8'));const a1=e(1),a2=e(2);fs.writeFileSync(d+'/registry.json',JSON.stringify({version:1,agents:[a1,a2]},null,2));fs.writeFileSync(d+'/terminal-config.json',JSON.stringify({version:1,serverUrl:'http://127.0.0.1:8791/mcp',workspaceRoot:'<workspace>',legacyReadOnly:false,agents:[{agentName:a1.agentName,uuid:a1.uuid,privateKeyFile:d+'/agent-1/private.pem'},{agentName:a2.agentName,uuid:a2.uuid,privateKeyFile:d+'/agent-2/private.pem'}]},null,2));" "$d"
```

> **BOM 陷阱（实测踩到过）**：PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 UTF-8 **BOM**，服务端 `JSON.parse` 会直接抛
> `Unexpected token '\ufeff'` 并以退出码 2 结束。手写这两个文件时要么用上面的 `node -e`（默认无 BOM），要么用
> `[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))`。用生成工具产出则不存在此问题。

`terminal-config.json` 形状（字段含义写在这里，出问题先看它）：

```json
{
  "version": 1,
  "serverUrl": "http://127.0.0.1:8791/mcp",   // 只允许回环地址 + /mcp
  "workspaceRoot": "E:/workspace/opencode-identity/demo-project",  // 会话目录必须 realpath 等于它
  "legacyReadOnly": false,                    // 仅早期 2.x（无 permission.assert）才设 true
  "agents": [
    { "agentName": "build", "uuid": "3428…", "privateKeyFile": "C:/…/agent-1/private.pem" }
  ]
}
```

SDK 读私钥时会拒绝：相对路径、非普通文件、符号链接、>1 MB、**位于 `workspaceRoot` 之内**的私钥。所以身份目录必须在工作区外。

### 4.3 启动服务端

```powershell
node <studio>\apps\mcp-server\bin\serve.mjs --registry "$d\registry.json" --port 8791
```

启动成功的两行输出（stderr 一行给人看，stdout 一行给程序看）：

```json
{"event":"listening","url":"http://127.0.0.1:8791/mcp","registry":"…\\registry.json","agents":2,
 "attestation":[{"agentName":"build","status":"verified"},{"agentName":"plan","status":"verified"}]}
[ready] http://127.0.0.1:8791/mcp  registry=…  agents=2
```

`attestation` 每项都必须是 `verified`——这是"注册表没被改过"的第一道证据。

健康检查（PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，用 `curl.exe` 才是真 curl）：

```powershell
Invoke-RestMethod http://127.0.0.1:8791/health | ConvertTo-Json -Depth 4
# { "ok": true, "server": "local-agent-identity-mcp", "sdk": true, "attestation": [ … ] }
```

### 4.4 绕过宿主，直接验签（最有用的一步）

```powershell
node $sdk verify-agent --config "$d\terminal-config.json" --agent build
```

```json
{ "verified": true,
  "identity": { "uuid": "3428cbbb-…", "agentName": "build", "kid": "CA3o-…",
                "sessionId": "terminal", "invocationId": "76a531e1-…", "verified": true } }
```

换 `--agent plan`，`uuid` 必须不同。这一步就是"插件在宿主里做的事"的手工版：读私钥 → 签请求证明 → POST `/mcp` → 打印服务端验出的身份。

调用业务工具：

```powershell
# PowerShell 7 / bash
node $sdk call-tool --config "$d\terminal-config.json" --agent build --tool add --args '{"a":12,"b":30}'

# PowerShell 5.1：原生命令参数里的双引号会被吃掉，必须转义（否则报 JSON 解析错误）
node $sdk call-tool --config "$d\terminal-config.json" --agent build --tool add --args '{\"a\":12,\"b\":30}'
```

```json
{ "tool": "add", "agent": "build",
  "structuredContent": { "sum": 42,
    "identity": { "uuid": "3428…", "agentName": "build", "kid": "CA3o-…", "verified": true } } }
```

### 4.5 完全离线：只用公钥验签

不连服务端、不读注册表，验证"这个身份证明是不是这把公钥签的"：

```powershell
node $sdk verify --public "$d\agent-1\public.jwk" --attestation "$d\agent-1\identity.json" --agent build
# { "verified": true, "claim": { "sub": "<uuid>", "agent": "build", "kid": "…" },
#   "key": { "kid": "…", "modulusBits": 3072 }, "publicPem": "-----BEGIN PUBLIC KEY-----…" }

node $sdk inspect --attestation "$d\agent-1\identity.json"
# 只解码不验签：用来展示"它声称自己是谁"，真伪仍需 verify
```

### 4.6 可选：自己走一遍请求证明

```powershell
'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}' | Set-Content "$d\req.json" -Encoding ascii

node $sdk proof --private "$d\agent-1\private.pem" --agent build --uuid <uuid> `
     --url http://127.0.0.1:8791/mcp --body "$d\req.json"
# { "header": "X-Agent-Proof", "token": "eyJhbGciOi…" }

node $sdk verify-proof --token <token> --registry "$d\registry.json" `
     --url http://127.0.0.1:8791/mcp --body "$d\req.json"
# { "verified": true, "identity": { … } }   ← 第二次用同一 token 会得到 PROOF_REPLAY
```

---

## 5. 装进 OpenCode，在真实宿主里验证

### 5.1 OpenCode 2.x

插件产物是**目录** `<dataDir>\plugin\opencode-v2\`。把 `<dataDir>\plugin\opencode.v2.fragment.json` 的内容合并进配置（保留原有内容，不要整体覆盖）：

- 全局：`C:\Users\<你>\.config\opencode\opencode.jsonc`
- 项目级：`<workspace>\opencode.jsonc`

```jsonc
{
  "plugins": [
    { "package": "file:///C:/Users/me/mcp-identity/run-1/plugin/opencode-v2" }
  ],
  "permissions": [
    { "action": "identity_whoami", "resource": "*", "effect": "ask" },
    { "action": "identity_echo",  "resource": "*", "effect": "ask" },
    { "action": "identity_add",   "resource": "*", "effect": "ask" }
  ]
}
```

要点：`file:///` + **正斜杠** + 指向**目录**；`permissions[].action` 就是工具名；2.x 里 `plugin`（单数、字符串数组）已废弃。

### 5.2 OpenCode 1.x

插件产物是**文件** `<dataDir>\plugin\identity-plugin.mjs`：

```jsonc
{
  "plugin": ["file:///C:/Users/me/mcp-identity/run-1/plugin/identity-plugin.mjs"],
  "permission": { "identity_whoami": "ask", "identity_echo": "ask", "identity_add": "ask" }
}
```

两种写法**不可混用**。改完必须**完全退出并重启** OpenCode（桌面版从托盘退出），不是新开会话。

### 5.3 宿主里的判据

```powershell
Set-Location <workspace>
opencode run --agent build "调用 identity_whoami，告诉我服务端验证到的 UUID 和 Agent 名称"
opencode run --agent plan  "调用 identity_whoami，报告你的 UUID"
```

| 判据 | 期望 |
| --- | --- |
| `uuid` | 等于 `<dataDir>\SETUP.md` 表格里该 Agent 的值 |
| 两个 Agent 的 `uuid` | 必须不同（各自一对密钥） |
| `verified` | `true` |
| 审批 | `effect:"ask"` 时每次调用弹审批，显示工具名与服务端地址 |
| 换到别的工作区开会话 | 报 `Unapproved session workspace`（服务端用 realpath 比对） |
| 换一个未生成的 Agent | 报 `Executing OpenCode Agent is not registered in terminal config` |

如果宿主里报 `Unsupported OpenCode 2.x plugin context`，是主版本与入口类型不匹配：2.x 用目录，1.x 用文件。

---

## 6. 负向验证：这才是"看懂原理"

正向跑通只能证明"能通"，下面 5 条才能证明"挡得住"。

### 6.1 不带证明的请求 → 401

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST -H "Content-Type: application/json" `
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' http://127.0.0.1:8791/mcp
# 401  {"error":{"code":-32001,"message":"Agent authentication failed"}}
```

失败文案刻意统一：不区分"UUID 不存在"和"签名不对"，避免被当探测工具。

### 6.2 改写 Host → 403

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST -H "Host: evil.local" -H "Content-Type: application/json" `
  -d '{}' http://127.0.0.1:8791/mcp
# 403  {"error":"Invalid Host"}
```

同理，带非同源 `Origin` 也会 403。所以只能用 `http://127.0.0.1:<port>/mcp`，别经过代理或换主机名。

### 6.3 篡改注册表里的 Agent 名 → 拒绝加载（503）

```powershell
Copy-Item "$d\registry.json" "$d\registry.bak"
node -e "const fs=require('fs');const p=process.argv[1];const r=JSON.parse(fs.readFileSync(p,'utf8'));r.agents[0].agentName='build-2';fs.writeFileSync(p,JSON.stringify(r,null,2));" "$d\registry.json"
Start-Sleep 2
node $sdk verify-agent --config "$d\terminal-config.json" --agent build
# [MCP_HTTP] MCP rejected request (HTTP 503)

Copy-Item "$d\registry.bak" "$d\registry.json" -Force
```

服务端 stdout 会给出原因（不是含糊的失败）：

```json
{"time":"…","event":"registry_unavailable","code":"ATTESTATION_AGENT","message":"Agent authentication failed"}
```

因为每行的 `attestation` 是私钥签的 `{sub, agent}`，改名字/换公钥就对不上签名 → `ATTESTATION_AGENT` / `REGISTRY_KID`。

> 实测细节：注册表被改坏后，`GET /health` 仍可能返回上一次的缓存快照（200）；判断"注册表是否还能用"要以 **`/mcp` 实际请求**和 stdout 的 `registry_unavailable` 为准。

### 6.4 `enabled:false` 即时吊销 → 401，且不用重启

```powershell
node -e "const fs=require('fs');const p=process.argv[1];const r=JSON.parse(fs.readFileSync(p,'utf8'));r.agents[0].enabled=false;fs.writeFileSync(p,JSON.stringify(r,null,2));" "$d\registry.json"
Start-Sleep 2
node $sdk verify-agent --config "$d\terminal-config.json" --agent build   # 401
node $sdk verify-agent --config "$d\terminal-config.json" --agent plan    # 仍然 verified
```

### 6.5 在参数里伪造身份 → 必被拒

```powershell
node $sdk call-tool --config "$d\terminal-config.json" --agent build --tool add `
     --args '{\"a\":1,\"b\":2,\"agentName\":\"plan\",\"verified\":true}'
# [MCP_ERROR] Invalid tool arguments; identity comes from the server context
```

工具 schema 是 `additionalProperties: false`，`uuid / agentName / verified` 根本不是可传参数；身份只有一个来源——`X-Agent-Proof` 验签结果。审计日志里那一条会是 `"success":false`。

### 6.6 重放同一份证明 → 拒绝

同一 `jti` 第二次使用会被内存重放库拦住（`PROOF_REPLAY`）。最快的观察方式：把 [4.6](#46-可选自己走一遍请求证明) 的同一个 token 连发两次 `verify-proof`，第二次非零退出；或在服务端串行重发同一个 `X-Agent-Proof`。

---

## 7. 日志：在哪、怎么看

### 7.1 服务端 stdout：一行一个 JSON 事件

| event | 出现时机 | 关键字段 |
| --- | --- | --- |
| `listening` | 启动成功 | `url`、`registry`、`agents`、`attestation[]` |
| `mcp_request` | 每次通过验签的调用 | `uuid`、`agentName`、`kid`、`invocationId`、`method`、`tool`、`success` |
| `authentication_failed` | 证明验不过（401） | `code`（如 `PROOF_REPLAY`、`PROOF_KID_MISMATCH`） |
| `registry_unavailable` | 注册表损坏/被改（503） | `code`（如 `ATTESTATION_AGENT`、`REGISTRY_KID`） |

样例行：

```json
{"time":"2026-11-02T00:28:55.598Z","event":"mcp_request","uuid":"61a08f6a-…","agentName":"build",
 "kid":"lWN8cRd6…","invocationId":"63a4034a-…","method":"tools/call","tool":"add","success":true}
```

### 7.2 把日志落到文件（常驻时最实用）

```powershell
node <studio>\apps\mcp-server\bin\serve.mjs --registry "$d\registry.json" --port 8791 `
     1> "$d\server.out.log" 2> "$d\server.err.log"

Get-Content "$d\server.out.log" -Encoding utf8 -Tail 20     # 审计事件
Get-Content "$d\server.err.log" -Encoding utf8 -Tail 20     # [ready] / [startup] / [MCP_HTTP]
```

或后台启动并要求打印 PID：

```powershell
$p = Start-Process node -ArgumentList "<studio>\apps\mcp-server\bin\serve.mjs","--registry","$d\registry.json","--port","8791" `
     -RedirectStandardOutput "$d\server.out.log" -RedirectStandardError "$d\server.err.log" -WindowStyle Hidden -PassThru
```

### 7.3 生成工具自己的日志

| 看什么 | 位置 |
| --- | --- |
| 生成进度（8 步 + 每步耗时 + detail） | 页面进度条 / `GET /api/jobs/:jobId` 的 `steps[]` |
| 它拉起的服务端输出 | 「部署」区日志面板 / `GET /api/server/log` |
| 生成工具自身控制台 | 启动 `server.mjs` 的窗口（或重定向的文件） |

### 7.4 用 `invocationId` 串起"谁调了什么"

工具返回值里有 `invocationId`（每次唯一），服务端审计行里也有同一个值：

```powershell
Select-String -Path "$d\server.out.log" -Pattern '63a4034a' -Encoding utf8
```

模型侧只看到"工具成功"，服务端侧能看到"是哪个 uuid、哪个 Agent、哪个工具、成功与否"。审批弹窗里的 `messageID + callID + sessionID` 也能和这条对上，所以能回答"这次调用到底是谁发起的"。

### 7.5 常见错误对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `EADDRINUSE` | 端口被占 | 换 `--port`，同步改 `terminal-config.json` 的 `serverUrl`（只改内容不用重生成插件） |
| `[startup] Unexpected token '\ufeff'` | 注册表带 BOM | 用无 BOM 方式重写（[4.2](#42-组装注册表与终端配置)） |
| HTTP 401 | UUID/名称未登记、kid 与私钥不匹配、`enabled:false`、时钟偏差、证明被重放 | 看 `authentication_failed` 的 `code`；用 `verify-agent` 单独复现 |
| HTTP 403 | Host / Origin 被改写 | 只用 `http://127.0.0.1:<port>/mcp` |
| HTTP 503 | 注册表缺失/损坏/无读权限 | 看 `registry_unavailable` 的 `code` 与启动时的 `attestation` |
| 插件完全不加载 | 路径写法错 / 没重启 / 改错了配置文件 | `file:///` + 正斜杠；完全退出重启；确认全局还是项目级 |
| `Unapproved session workspace` | 会话目录 ≠ `workspaceRoot` | 到该工作区开会话，或用新工作区重新生成 |
| 每请求数秒 | Windows 每次读受保护文件都要校验 ACL | 已知开销；服务端常驻、注册表按 mtime 缓存 |
| `Cannot find package '@opencode-ai/plugin'` | 自检 1.x 但本机无宿主包 | 只生成 2.x，或在宿主机环境跑 |

---

## 8. 收尾与复位

```powershell
# 停服务端（按端口找 PID，比记 PID 可靠）
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8791 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# 临时吊销某个 Agent（不用重启服务端）
#   把 registry.json 里该条 "enabled": false

# 彻底卸载
#   1) 从 opencode.jsonc 删掉 plugins/permissions（1.x 删 plugin/permission）
#   2) 重启 OpenCode
#   3) 删除 <dataDir>（含私钥）
```

验证用的临时身份（如 `%USERPROFILE%\mcp-identity\manual-verify`）跑完即可删除；`registry.json` 与 `SETUP.md` 含 UUID/路径，分享前脱敏。

---

## 附录 A：命令速查

| 目的 | 命令 |
| --- | --- |
| 起生成工具 | `node <studio>\apps\plugin-studio\server.mjs` → 4180 |
| 起服务端 | `node <studio>\apps\mcp-server\bin\serve.mjs --registry <registry> --port 8790` |
| 造身份 | `node <sdk> keygen --out <dir> --agent build` |
| 离线验签 | `node <sdk> verify --public <public.jwk> --attestation <identity.json> --agent build` |
| 只解码 | `node <sdk> inspect --attestation <identity.json>` |
| 向服务端验身 | `node <sdk> verify-agent --config <terminal-config.json> --agent build` |
| 调业务工具 | `node <sdk> call-tool --config <terminal-config.json> --agent build --tool add --args '{"a":1,"b":2}'` |
| 生成证明 | `node <sdk> proof --private <pem> --agent build --uuid <uuid> --url <url> --body <file>` |
| 验证证明 | `node <sdk> verify-proof --token <token> --registry <json> --url <url> --body <file>` |
| SDK 自检 | `node <sdk> selftest`（7 条） |
| 健康检查 | `Invoke-RestMethod http://127.0.0.1:8790/health` |
| 宿主里跑一次 | `opencode run --agent build "调用 identity_whoami"` |

`sdk` = `<studio>\packages\identity-sdk\bin\sdk.mjs`。退出码：`0` 成功 / `1` 验签或校验失败 / `2` 用法错误。

## 附录 B：本次实测数据

环境：Windows 11、PowerShell 5.1.26100、Node v22.13.1、OpenCode 2.2.5 桌面版、仓库内运行（无 `node_modules`）。

| 项 | 结果 |
| --- | --- |
| SDK `selftest` | 7 通过 / 0 失败 |
| 服务端 `-V` | `identity-mcp-server 1.2.0`，SDK 解析到仓库内 `packages/identity-sdk` |
| 生成（2 Agent，主版本 both） | `state=done`，72.5 s；8 步耗时见 [3.3](#33-生成过程8-步实测-2-个-agent-约-72-秒) |
| 生成（1 Agent，仅 2.x） | `state=done`，49.4 s |
| `POST /api/verify` whoami | 24 ms（initialize 19 ms + call 5 ms），`verified:true` |
| `POST /api/selftest`（仅 2.x） | 16 项：15 通过 / 0 失败 / 1 跳过（1.x 未生成） |
| `POST /api/selftest`（both 生成） | 失败于加载 1.x 入口：缺宿主包 `@opencode-ai/plugin`（见 3.5 的坑） |
| CLI 闭环 | `keygen×2 → registry → serve → verify-agent(build/plan) → call-tool add` 全部通过，`sum=42` |
| 无证明请求 | 401 `Agent authentication failed` |
| 改写 Host | 403 `Invalid Host` |
| 篡改 `agentName` | `/mcp` 503 + `registry_unavailable / ATTESTATION_AGENT`；恢复文件后自动可用 |
| `enabled:false` | 该 Agent 401，另一 Agent 仍 `verified`（无需重启） |
| 参数里塞 `agentName`/`verified` | `Invalid tool arguments; identity comes from the server context` |
