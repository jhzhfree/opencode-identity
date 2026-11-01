# 插件安装与使用说明

适用于 **OpenCode 1.x / 2.x**，由 OpenCode Identity Studio 生成的身份插件。

---

## 0. 先看这个：5 分钟装完

```
① 页面上点「生成插件」→ 记下「身份数据目录」路径（例：C:\Users\me\mcp-identity\run-2026-11-01）
② 启动 MCP 服务端：powershell -ExecutionPolicy Bypass -File "<目录>\start-server.ps1"
   （等价的 node 命令见第 3 节）
③ 把 plugins 片段合并进 opencode.jsonc（第 4 节，照抄即可）
④ 重启 OpenCode，在同一个工作区里让 Agent 调 identity_whoami，UUID 与生成表格一致 → 装好了
```

三样东西缺一不可，先建立这个心智模型：

| 角色 | 是什么 | 装在哪 | 谁用它 |
|---|---|---|---|
| **插件** | 三个工具的壳，把调用转成签名请求 | OpenCode 配置里（1.x 一个文件 / 2.x 一个目录） | OpenCode 宿主进程 |
| **MCP 服务端** | 验签 + 执行业务工具 | 本机常驻进程（`127.0.0.1`） | 插件（HTTP + `X-Agent-Proof`） |
| **身份数据** | 私钥、公钥注册表、终端配置 | 一个固定目录（**必须在工作区之外**） | 插件读私钥，服务端读注册表 |

插件本身不含任何密钥；它读 `terminal-config.json` 里的绝对路径去找私钥。所以**目录不能随便搬**。

---

## 1. 前提条件

| 项 | 要求 | 怎么确认 |
|---|---|---|
| Node.js | **≥ 22**（本工具链用了 `import.meta.dirname`） | `node -v` |
| OpenCode | 1.x 或 2.x（本机实测 2.2.5） | `opencode --version`；桌面版在 `%LOCALAPPDATA%\Programs\ai.opencode.desktop\resources\opencode-cli.exe` |
| 工作区 | 一个已存在的绝对路径目录 | 生成时要填 |
| 端口 | 一个空闲的本地端口（默认 8790） | `netstat -ano \| findstr :8790` |

> Node 只被「服务端 / SDK / 生成工具」用到；插件在宿主自己的运行时里跑。

---

## 2. 拿到产物

### 2.1 方式 A：直接用生成目录（推荐，本机安装）

页面生成完成后，「身份数据目录」里已经有全部文件，**不需要下载 ZIP**：

```
<dataDir>\
├── registry.json            公钥注册表（含每个 Agent 的身份证明签名）
├── terminal-config.json     终端配置：私钥路径 + 服务端 URL + 工作区根
├── agent-1\ … agent-N\      private.pem / public.jwk / identity.json / enrollment.json
├── plugin\
│   ├── identity-plugin.mjs        1.x 插件入口（文件）
│   ├── opencode-v2\               2.x 插件入口（目录：index.js + package.json + runtime\）
│   ├── opencode.v1.fragment.json  1.x 配置片段
│   ├── opencode.v2.fragment.json  2.x 配置片段
│   └── opencode.fragment.json     本次主版本的片段副本（方便复制）
├── start-server.ps1         一键起服务端
├── verify.ps1               逐个 Agent 验身
└── SETUP.md                 本次生成的真实路径版说明
```

### 2.2 方式 B：下载 ZIP

页面「下载 ZIP」得到的是**部署包**，解压后结构：

```
SETUP.md
identity/registry.json
identity/terminal-config.json
identity/agent-N\…           （仅勾选「ZIP 中包含私钥」时才有 private.pem）
plugin\                      完整插件目录
server\bin\serve.mjs  server\lib\…  server\packages\identity-sdk\…
start-server.ps1  verify.ps1
```

**默认不含私钥**（勾选框「ZIP 中包含私钥（仅迁移用，默认不包含）」）。ZIP 里的 `terminal-config.json` 记录的仍是**原机器绝对路径**，所以：

- 同机安装 → 不要用 ZIP，直接用 `<dataDir>`；
- 换机器 / 换目录 → 勾选包含私钥下载，把 `identity\` 放到固定目录，然后**用生成工具重新生成一次插件**（插件里写死了 `terminal-config.json` 的绝对路径），不要手改 JSON。

---

## 3. 启动 MCP 服务端

服务端必须**常驻**：每次工具调用都会向它发一个带签名的 HTTP 请求。

### 3.1 命令行

服务端程序在两处之一，按你的安装方式选：

| 安装方式 | serve.mjs 在哪 |
|---|---|
| 用生成目录（方式 A） | `<studio>\apps\mcp-server\bin\serve.mjs` |
| 用下载的 ZIP（方式 B） | `<解压目录>\server\bin\serve.mjs` |

```powershell
# Windows PowerShell · 方式 A（本机，studio 仓库里）
node "E:\workspace\opencode-identity\studio\apps\mcp-server\bin\serve.mjs" `
     --registry "<dataDir>\registry.json" --port 8790

# Windows PowerShell · 方式 B（ZIP 解压包，自包含）
node "<解压目录>\server\bin\serve.mjs" `
     --registry "<解压目录>\identity\registry.json" --port 8790
```

```bash
# macOS / Linux（以 ZIP 包为例）
node "<解压目录>/server/bin/serve.mjs" --registry "<解压目录>/identity/registry.json" --port 8790
```

最省事的还是直接用生成好的脚本（`start-server.ps1` 里已写入本机真实路径，找不到时回落到同目录的 `server\`）：

```powershell
powershell -ExecutionPolicy Bypass -File "<dataDir>\start-server.ps1"
```

启动成功的标志（stdout）：

```text
{"event":"listening","url":"http://127.0.0.1:8790/mcp","agents":2,
 "attestation":[{"agentName":"build","status":"verified"},{"agentName":"plan","status":"verified"}]}
[ready] http://127.0.0.1:8790/mcp  agents=2
```

### 3.2 健康检查

```bash
curl http://127.0.0.1:8790/health
# {"ok":true,"server":"local-agent-identity-mcp","sdk":true,"attestation":[...]}
```

`attestation` 里每个 Agent 都必须是 `verified`，出现 `invalid` 说明注册表被改过。

### 3.3 让它在后台常驻

| 方式 | 命令 |
|---|---|
| 新开一个终端窗口 | 最省事，关掉窗口就停 |
| Windows 计划任务 | 触发器「登录时」，操作填 `node "<serve.mjs 路径>" --registry "<registry.json 路径>" --port 8790` |
| PM2 | `pm2 start "<serve.mjs 路径>" --name identity-mcp -- --registry "<registry.json 路径>" --port 8790` |
| systemd（Linux） | `ExecStart=/usr/bin/node <serve.mjs 路径> --registry <registry.json 路径> --port 8790` |

> `<serve.mjs 路径>` 按第 3.1 节的表选择：仓库里是 `apps/mcp-server/bin/serve.mjs`，ZIP 包里是 `server/bin/serve.mjs`。

> 端口被占用会直接退出（`EADDRINUSE`）。换端口时改 `terminal-config.json` 里的 `serverUrl` 即可——插件在**运行时**读取该文件，**只改内容不用重新生成插件**。但如果你改了 `terminal-config.json` 的**存放路径**，就必须重新生成插件（插件入口里内嵌了这个绝对路径）。

### 3.4 常用参数

| 参数 | 作用 |
|---|---|
| `--registry <file>` | 必填，注册表路径 |
| `--port <n>` | 默认 8781；只绑定 `127.0.0.1` |
| `--allow-missing-attestation` | 仅排障：允许注册表缺少身份证明（**不要在生产开**） |
| `--quiet` | 关闭逐请求审计输出 |
| `-h / -V` | 帮助 / 版本与 SDK 位置 |

---

## 4. 安装插件

先确认宿主主版本，两者**配置写法完全不同，混用必然失败**。

```bash
opencode --version        # 1.x 或 2.x
```

### 4.1 OpenCode 2.x

插件产物是**目录**：`<dataDir>\plugin\opencode-v2\`（含 `index.js`、`package.json`、`runtime\`）。

编辑配置文件，二选一：

- 全局：`C:\Users\<你>\.config\opencode\opencode.jsonc`（macOS/Linux `~/.config/opencode/opencode.jsonc`）
- 项目级：`<你的工作区>\opencode.jsonc`

把下面两项**合并**进去（保留文件里已有内容，不要整体覆盖）：

```jsonc
{
  "plugins": [
    { "package": "file:///C:/Users/me/mcp-identity/run-2026-11-01/plugin/opencode-v2" }
  ],
  "permissions": [
    { "action": "identity_whoami", "resource": "*", "effect": "ask" },
    { "action": "identity_echo",  "resource": "*", "effect": "ask" },
    { "action": "identity_add",   "resource": "*", "effect": "ask" }
  ]
}
```

可以直接复制 `<dataDir>\plugin\opencode.v2.fragment.json` 的内容（里面已经是真实绝对路径）。

要点：

- `package` 用 `file:///` + **正斜杠**绝对路径，指向**目录**（不是 `index.js`）。
- `permissions[].action` 就是工具名，`effect` 取 `ask` / `allow` / `deny`。
- 2.x 里 `plugin`（单数、字符串数组）是**已废弃**写法，别用。

### 4.2 OpenCode 1.x

插件产物是**文件**：`<dataDir>\plugin\identity-plugin.mjs`。

```jsonc
{
  "plugin": ["file:///C:/Users/me/mcp-identity/run-2026-11-01/plugin/identity-plugin.mjs"],
  "permission": {
    "identity_whoami": "ask",
    "identity_echo": "ask",
    "identity_add": "ask"
  }
}
```

要点：1.x 是 `plugin`（数组）+ `permission`（对象，键为工具名，值为 `ask`/`allow`/`deny`）。

### 4.3 生效

改完**完全退出并重启 OpenCode**（不是新开会话）。Windows 桌面版注意从托盘退出。

---

## 5. 验证装好了

分三层查，从底往上，出问题时能立刻定位断层在哪。

### 第 1 层：服务端活着

```bash
curl http://127.0.0.1:8790/health
```

### 第 2 层：绕过宿主，直接验签（最有用的一层）

```powershell
node "<sdk>\bin\sdk.mjs" verify-agent --config "<dataDir>\terminal-config.json" --agent build
# → "verified": true, uuid = 表格里的那个
```

调一个业务工具：

```powershell
node "<sdk>\bin\sdk.mjs" call-tool --config "<dataDir>\terminal-config.json" --agent build --tool add --args '{"a":12,"b":30}'
# → structuredContent.sum = 42
```

`<sdk>` 取 SDK 程序所在目录，二选一：

- 本机用仓库：`E:\workspace\opencode-identity\studio\packages\identity-sdk`（`bin\sdk.mjs` 在里面）
- 用 ZIP 解压包：`<解压目录>\server\packages\identity-sdk`

也可以直接用生成目录里的 `verify.ps1`，它会逐个 Agent 验一遍。

### 第 3 层：在真实宿主里

```powershell
Set-Location "<你的工作区>"
opencode run --agent build "调用 identity_whoami，告诉我服务端验证到的 UUID 和 Agent 名称"
```

返回的 UUID 必须与生成结果表格中 `build` 行一致；换 `plan` 再跑一次，UUID 必须不同。

---

## 6. 使用：三个工具

| 工具名 | 参数 | 返回 | 用途 |
|---|---|---|---|
| `identity_whoami` | 无 | `identity:{uuid, agentName, kid, sessionId, invocationId, verified}` | 确认"我是谁"，验证签名链路 |
| `identity_echo` | `text`（≤2000 字符） | `{text, identity}` | 把文本和已验证身份一起回显，便于日志/链路追踪 |
| `identity_add` | `a`, `b`（有限数字） | `{sum, identity}` | 演示业务调用也带上可信身份 |

### 6.1 怎么让 Agent 用

直接说人话即可，例如：

- 「调用 identity_whoami，报告你的 UUID」
- 「用 identity_echo 回显 'hello'，并说明你的身份」
- 「用 identity_add 算 17+25，然后告诉我这是哪个 Agent 算的」

### 6.2 返回字段怎么读

```json
{
  "identity": {
    "uuid": "a8c58691-ce0f-425d-af1b-0e00158c5147",
    "agentName": "build",
    "kid": "7mkaMZWtQkhEDvVopMeZBYEDD0Wmu7dF9tqU3dCxp8o",
    "sessionId": "ses_xxx",
    "invocationId": "8dce216c-6927-4593-a1bb-d032616c3a65",
    "verified": true
  }
}
```

- `uuid` / `agentName` 来自**服务端用注册表公钥验出的签名**，不是模型填的；
- `kid` 是公钥指纹，可用于核对注册表条目；
- `invocationId` 每次调用唯一，和服务端审计日志一一对应，排障时用它查。

### 6.3 关键约束：身份不能由模型指定

工具参数里**没有** `uuid` / `agentName` / `verified` 这些字段。任何试图塞进去的调用都会被服务端按非法参数拒绝（`additionalProperties: false`）。

身份只有一个来源：插件用**执行该工具的那个 Agent 的私钥**签一份请求证明，服务端用注册表公钥验。换 Agent 就自动换私钥，模型无法伪造。

### 6.4 直接调服务端（不装插件也能用）

任何支持 MCP 的客户端都能接，只要它能发 `X-Agent-Proof`：

```
POST http://127.0.0.1:8790/mcp
Content-Type: application/json
X-Agent-Proof: <header.claim.signature>
```

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"add","arguments":{"a":1,"b":2}}}
```

用 SDK 一行搞定：

```js
import { createSignedClient } from '@opencode-identity/sdk';
```

---

## 7. 权限与审批

`permissions` 里的 `effect` 决定每次调用要不要弹审批：

| effect | 行为 | 建议 |
|---|---|---|
| `ask` | 每次调用弹审批，显示工具名 + 服务端地址 | **默认，推荐** |
| `allow` | 静默通过 | 只在自动化脚本里用 |
| `deny` | 直接拒绝 | 用来临时封禁某个工具 |

插件内部对每次调用都会把「来源」（`messageID` + `callID` + `sessionID`）交给宿主审批接口，所以审批弹窗能精确对应到是哪次模型调用发起的，而不是笼统的"某个插件想执行"。

**`legacyReadOnly`**：仅当宿主是**没有审批 API 的早期 2.x** 时才需要（生成时勾选即可）。勾上后不再弹审批，仅限三个只读演示工具。正常 2.2.5 **不要勾**。

---

## 8. 多 Agent / 多项目

- **每个 Agent 一行注册记录**，各自一对 RSA-3072 密钥。插件按"执行工具的那个 Agent"自动选私钥，不需要手工切换。
- 生成时填的 Agent 名必须与宿主里真实存在的 Agent 一致。查看真实名单：

  ```bash
  opencode debug agents      # 2.x
  opencode agent list        # 1.x
  ```

  2.2.5 上是：`build`、`compaction`、`explore`、`general`、`plan`、`summary`、`title`。
- **会话工作区必须等于生成时填的工作区**（服务端用 `realpath` 比较）。在别的目录开会话会报 `Unapproved session workspace`。
- **一个项目一套身份数据**。不要把同一个 `dataDir` 同时指向多个项目——`terminal-config.json` 里的 `workspaceRoot` 只有一个值。

---

## 9. 常见错误对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `HTTP 401` | UUID/名称未登记、kid 与私钥不匹配、`enabled:false`、系统时间偏差大、请求被重放 | 查服务端审计日志里的 `uuid`；`verify-agent` 单独复现 |
| `HTTP 403` | Host / Origin 不匹配 | 必须用 `http://127.0.0.1:<port>/mcp`，别用 `localhost` 之外的主机名或经代理 |
| `HTTP 503` | 注册表缺失/损坏，或服务账户读不了 | 看服务端启动日志的 `attestation` 字段 |
| `Executing OpenCode Agent is not registered in terminal config` | 当前 Agent 名不在 `terminal-config.json` 里 | 用生成工具把该 Agent 加进去重新生成 |
| `Unapproved session workspace` | 会话不在生成时的工作区 | 切到该工作区开会话，或按新工作区重新生成 |
| `Unsupported OpenCode 2.x plugin context` | 插件与宿主版本不匹配 | 2.x 用 `opencode-v2` 目录，1.x 用 `identity-plugin.mjs` |
| `This early OpenCode 2.x has no permission.assert API` | 宿主太旧且没勾 `legacyReadOnly` | 升级宿主；或生成时勾选 `legacyReadOnly` |
| 插件完全不加载 | 路径写法错 / 没重启 / 配置没合并进正确文件 | 用 `file:///` + 正斜杠；完全退出重启；确认改的是全局还是项目级 |
| `EADDRINUSE` | 端口被占 | 换 `--port`，同步改 `terminal-config.json` 的 `serverUrl` |
| 调用很慢（每请求数秒） | Windows 上每次读受保护文件都要校验 ACL | 已知开销；把服务端常驻、减少冷启动 |
| `identity_add` 报 400 | `a`/`b` 不是有限数字，或多传了字段 | 只传 `a`、`b` 两个数值 |

排障通用手段：服务端默认逐请求打审计行，用返回里的 `invocationId` 去比对：

```json
{"time":"...","event":"mcp_request","uuid":"...","agentName":"build","kid":"...","invocationId":"...","method":"tools/call","tool":"whoami","success":true}
```

---

## 10. 卸载

1. 从 `opencode.jsonc` 里删掉 `plugins` 条目（1.x 删 `plugin`）和对应 `permissions`（`permission`）；
2. 重启 OpenCode；
3. 停掉服务端进程；
4. 删除 `<dataDir>`（含私钥）——建议先确认不再需要这些身份。

只想**临时停用某个 Agent**：把 `registry.json` 里该条 `enabled` 改成 `false`，**下一个请求立刻被拒，不用重启服务端**。

---

## 11. 安全须知

- `private.pem` 只在 `<dataDir>` 内，从未上网；服务端只登记公钥。签名与验签的完整协议（`X-Agent-Proof` 的每个字段、服务端 12 项校验、为什么身份不能放在参数里）见 [IDENTITY-PROTOCOL.md](IDENTITY-PROTOCOL.md)。
- `registry.json` / `terminal-config.json` 生成时已按当前账户设 ACL（仅本人可读）。**不要复制进工作区、不要提交仓库**。
- 每个请求证明有效期 **30 秒**，带一次性 `jti`，服务端内存去重防重放。
- 每个注册表条目都带「Agent 名称 + UUID」的私钥签名；改名或替换公钥会导致 `ATTESTATION_AGENT` / `REGISTRY_KID`，服务端拒绝加载（503）而不是把攻击者当合法身份。
- 撤销 = `enabled:false`；轮换密钥 = 重新生成该 Agent 的身份并更新注册表。

---

## 12. 文件清单速查

| 文件 | 归属 | 能不能外传 |
|---|---|---|
| `agent-N\private.pem` | 插件（签名用） | **绝对不行** |
| `registry.json` | 服务端（验签用） | 只含公钥，可给同事，但不必外传 |
| `terminal-config.json` | 插件（找私钥 + 服务端地址） | 含私钥路径，不外传 |
| `plugin\*` | 宿主 | 可共享（不含密钥） |
| `server\*` | 服务端 | 可共享 |
| `SETUP.md` | 人看 | 含真实路径，注意脱敏后再分享 |

---

## 附：本文事实依据

- 配置字段（`plugins` / `permissions` / `plugin` / `permission`）与官方 `https://opencode.ai/config.json` 及 `@opencode/schema@2.2.5` 核对：`plugins[].package` 为字符串（目录或文件 URI），`permissions[].action` 为字符串、`effect ∈ {allow, deny, ask}`。第 4.1 节的片段已用 `opencode debug config` 在 2.2.5 上实机解析通过。
- 工具名、入参与返回结构来自 `server.mjs` 的 `tools` 定义（`whoami` / `echo_secure` / `add`，全部 `additionalProperties:false`）。
- 错误文案（`Unapproved session workspace`、`Executing OpenCode Agent is not registered` 等）为源码中的原始英文串，便于直接搜索。
- 插件接口形状由工具内置自检以模拟宿主上下文验证；本机环境为 OpenCode 2.2.5。
- 第 4.2 节的 1.x 写法沿自上游 1.x 生成器（`plugin` + `permission`）。本机没有 1.x 宿主，**未实机验证**，仅由上游测试覆盖。
