# OpenCode Identity — 三个可分别启动的程序

MCP Agent 身份的工具集，拆成三个**互相独立、可分别手动启动**的程序。
密码学只有一份实现：`packages/identity-sdk`。另外两个程序都调用它，没有第二份密钥/签名代码。

插件生成工具另有 **AKB 生产模式**：检测 OpenCode Agent，生成独立 UUID / RSA 密钥，在 AKB 登记后验证并安装插件，让**执行中的指定 Agent** 以自己的身份查询知识库。生产使用 `X-API-Key` + `X-AKB-Workload-Assertion` / `AGENT_KEY_RS256_V2`；不会拿本机演示的 `X-Agent-Proof` 请求 AKB，也不会在缺少身份时降级成普通服务凭证。

| # | 程序 | 入口 | 默认地址 | 谁依赖它 | 依赖谁 |
| --- | --- | --- | --- | --- | --- |
| 1 | **插件生成工具**（Web UI） | `apps/plugin-studio/server.mjs` | http://127.0.0.1:4180 | — | SDK、插件模板 |
| 2 | **SDK 工具**（CLI / 库） | `packages/identity-sdk/bin/sdk.mjs` | 命令行 | 两个程序 | 无（零依赖） |
| 3 | **MCP 验签服务端** | `apps/mcp-server/bin/serve.mjs` | http://127.0.0.1:8781/mcp | 插件 | SDK |

```
                      ┌──────────────────────────────┐
   插件生成工具 ◄─────┤                              ├─────► MCP 验签服务端
  (Web UI, 4180)      │   @opencode-identity/sdk     │      (127.0.0.1:8781)
                      │  密钥 · UUID · 签名 · 验签    │
   SDK 工具 ◄─────────┤  请求证明 · 注册表 · 客户端    │◄───── 生成的插件
  (CLI/菜单)          └──────────────────────────────┘      (X-Agent-Proof)
```

## 文档

| 文档 | 内容 |
|---|---|
| **[docs/IDENTITY-PROTOCOL.md](docs/IDENTITY-PROTOCOL.md)** | **身份认证协议**：身份从哪来、`X-Agent-Proof` 逐字段、服务端四道闸门与 12 项校验、identity 如何注入工具与深层模块、攻击面与实测拒绝结果、自写客户端的 20 行范例、跨语言服务端（Java/Python）实现要点 |
| **[docs/PLUGIN-INSTALL.md](docs/PLUGIN-INSTALL.md)** | **插件安装与使用说明**：5 分钟装完、1.x/2.x 配置写法、三层验证、三个工具用法、权限审批、错误对照、卸载、安全边界 |
| **[docs/MANUAL-VERIFICATION.md](docs/MANUAL-VERIFICATION.md)** | **手动验证指南**：Web UI 与纯命令行两条路线、生成哪些文件、三层验证、5 条负向验证、日志读法、实测耗时与踩坑记录 |
| **[docs/AKB-DESIGN.md](docs/AKB-DESIGN.md)** | **AKB 生产模式**：设计分析与改进、与本机演示协议的边界 |
| **[docs/VALIDATION.md](docs/VALIDATION.md)** | 本轮验证记录与未做项 |
| [docs/LOCAL-DEMO-1.1.md](docs/LOCAL-DEMO-1.1.md) | 原本机演示功能（1.1.0） |
| [apps/plugin-studio/README.md](apps/plugin-studio/README.md) | 生成工具：页面流程、API、生成产物结构（含 AKB 插件） |
| [apps/mcp-server/README.md](apps/mcp-server/README.md) | 验签服务端：参数、协议、审计日志 |
| [packages/identity-sdk/README.md](packages/identity-sdk/README.md) | SDK：API 与 CLI 参考 |

## 目录

```
.
├── start-studio.cmd / .sh      程序 1 的启动脚本
├── start-mcp.cmd    / .sh      程序 3 的启动脚本（需要 --registry）
├── start-sdk.cmd    / .sh      程序 2 的启动脚本（无参数进交互菜单）
├── apps/
│   ├── plugin-studio/         程序 1：Web UI + 生成编排 + 自检 + ZIP 打包
│   │   ├── server.mjs
│   │   ├── lib/{builder,detect,selftest,sdk-check,guide,zip,jobs}.mjs
│   │   ├── lib/{sdk,lab,mcp-bin}.mjs     依赖定位（同仓库 / vendor / 环境变量）
│   │   ├── lib/akb/          AKB 生产模式：生成器、客户端、插件模板、安装器
│   │   ├── bin/akb-plugin.mjs  AKB 命令行：build / verify / query / install
│   │   ├── templates/akb-runtime/  产物运行时依赖清单
│   │   ├── public/            前端
│   │   └── test/              探测回归 + AKB 契约与互操作测试
│   └── mcp-server/            程序 3：验签服务端
│       ├── bin/serve.mjs
│       ├── lib/server.mjs     注册表缓存 + 身份证明 + 请求证明 + 重放防护
│       ├── lib/sdk.mjs        SDK 定位
│       └── test/serve.test.mjs 用 SDK 造身份 → 起进程 → 签名调用
├── packages/identity-sdk/     程序 2：JS 库 + CLI，零依赖
│   ├── src/  bin/  test/
├── vendor/identity-lab/       上游 1.1.0 插件模板副本（见 NOTICE.md）
└── scripts/build-dist.mjs     打三个便携包 → dist/
```

## 启动（Windows）

双击或在 cmd 里：

```bat
start-studio.cmd                                  :: 1. 插件生成工具 → http://127.0.0.1:4180
start-sdk.cmd                                     :: 2. SDK 工具（无参数 = 交互菜单）
start-mcp.cmd --registry C:\path\registry.json --port 8781   :: 3. MCP 服务端
```

macOS / Linux：

```sh
./start-studio.sh
./start-sdk.sh
./start-mcp.sh --registry /path/registry.json --port 8781
```

也可以直接用 node（三个程序各自独立，互不要求对方在运行）：

```bash
node apps/plugin-studio/server.mjs
node packages/identity-sdk/bin/sdk.mjs describe
node apps/mcp-server/bin/serve.mjs --registry ./registry.json --port 8781
```

每个程序目录里也有自己的 `start.cmd` / `start.sh`，单独拷走也能启动。

端口约定（两者同时跑不冲突）：

| 程序 | 默认端口 |
|---|---|
| 插件生成工具（Web UI） | `4180` |
| MCP 验签服务端（独立启动） | `8781` |
| 插件生成工具里生成/启动的服务端 | `8790`（可在页面改） |

## 三个程序分别能做什么

### 1. 插件生成工具（Web UI）

- 探测本机 OpenCode：`--version`、`debug agents`（2.x）/`agent list`（1.x）、桌面版自带 CLI 路径、配置目录声明。
- 按主版本生成插件：1.x 文件入口 / 2.x 目录入口 / 两者都生成。
- 身份生成、验签面板、请求证明、插件自检、ZIP 下载都在同一个页面。
- 可选：一键启动程序 3（MCP 服务端）并跑端到端验签；不启动也能完成生成。

### 2. SDK 工具（CLI / 库）

```
identity-sdk describe                         能力与版本
identity-sdk keygen   [--out DIR] [--agent N] 生成 RSA-3072 + UUID + 身份证明
identity-sdk sign     --private PEM --agent N 用私钥签发 {agent, uuid}
identity-sdk verify-public --public KEY --attestation T   只用公钥验签
identity-sdk inspect  --attestation T         只解码，不验签
identity-sdk proof    --private PEM ...       生成 X-Agent-Proof
identity-sdk verify-proof --token T --registry R --url U --body B
identity-sdk verify-agent --config C --agent N   向运行中的服务端验身
identity-sdk call-tool    --config C --agent N --tool add --args '{"a":1,"b":2}'
identity-sdk selftest                        内置自检
```

无参数且是终端时进入**交互菜单**（1–8 选项），适合双击启动；脚本里调用仍然是严格的
子命令 + 退出码语义（0 成功 / 1 校验失败 / 2 用法错误）。

作为库用：`import { generateKeyPair, signIdentity, verifyWithPublicKey, createProof } from '@opencode-identity/sdk'`。

### 3. MCP 验签服务端

- 只绑定 `127.0.0.1`，校验 Host / Origin、`application/json`、64 KB 上限。
- 读 `registry.json`（按 mtime/size/inode 缓存），每条记录都验身份证明；`enabled:false` 即时生效。
- 校验 `X-Agent-Proof`：body 哈希、method、path、aud、30 秒有效期、一次性 jti 重放库。
- 工具：`whoami`、`echo_secure`、`add`；身份只来自验签结果，不接受参数里的 UUID/名称。
- `--tools <file>` 注册业务工具（`run` 可 async）：工具拿 `context.identity`，更深层的模块用 `currentIdentity()`（AsyncLocalStorage）取同一份冻结身份，不改函数签名。
- 每请求一行 JSON 审计；`GET /health` 返回状态（同样只对本机）。

## 依赖定位（为什么不用 npm install）

两个 app 各自有一个 `lib/sdk.mjs`，按顺序找 SDK：

1. `IDENTITY_SDK_DIR` 环境变量
2. `<app>/vendor/identity-sdk`（便携包）
3. `<repo>/packages/identity-sdk`（git 检出）
4. `node_modules/@opencode-identity/sdk`

插件模板同理：`IDENTITY_LAB_DIR` → `<app>/vendor/identity-lab` → `<repo>/vendor/identity-lab`。
MCP 服务端入口：`IDENTITY_MCP_BIN` → `apps/mcp-server/bin/serve.mjs` → `<app>/vendor/mcp-server/bin/serve.mjs`。

所以三个程序都能在**没有任何 node_modules**的目录里跑，Node 22+ 即可。

## 打便携包

```bash
npm run dist
```

生成 `dist/`（已 gitignore）：

| 目录 | 内容 | 启动 |
| --- | --- | --- |
| `dist/plugin-studio/` | 程序 + `vendor/{identity-sdk,identity-lab,mcp-server}` | `start.cmd` → 4180 |
| `dist/mcp-server/` | 程序 + `vendor/identity-sdk` | `start.cmd --registry …` |
| `dist/sdk/` | 库 + CLI | `start.cmd`（菜单） |

三个目录完全独立：只拷其中一个，删掉其余两个，仍然可以运行。

## 测试

```bash
npm test                 # 探测回归 + MCP 程序冒烟 + SDK 单测（57 条）+ AKB 契约测试
npm run sdk:selftest     # SDK CLI 自检
npm run check:contracts  # 官方 OpenCode 2.2.5 SDK 类型契约
npm run test:bundle      # 实际解包、npm ci、加载产物并分别调用 MCP
```

可选：先在 AKB 工程执行 Maven 测试，再设置 `AKB_REPO` 指向该工程，运行 `npm run test:akb-java`。它使用 **AKB 真正的 Java 验签器**，不是复制一份验签实现。

实测结果（Windows 22.2.2 / OpenCode 2.2.5 桌面版）：

| 项 | 结果 |
| --- | --- |
| SDK 单测 | 57/57 |
| MCP 程序冒烟（起进程 + 签名调用 + 401/403 + 缺注册表） | 3/3 |
| 便携包 dist/mcp-server + dist/sdk 联调 | `verify-agent`  verified，203 ms |
| 插件生成（2.x，仓库内） | 8 步约 80 s，ZIP 151 KB |
| 插件自检（2.x + 服务端运行） | 15 通过 / 0 失败 / 1 跳过（未生成的 1.x） |
| 便携包 dist/plugin-studio 全流程 | 生成 + 起服务 + 自检 15/0/1 |

## AKB 生产模式

打开 `http://127.0.0.1:4180`，使用 **AKB 生产插件** 卡片：

1. 检测 OpenCode，选择真实 Agent 名称（例如 `build`、`plan`），填写工作区和新的工作区外输出目录。
2. 输入 AKB 地址、默认知识库 ID（KB_ 开头，可留空）、服务 Key 的**环境变量名称**，点击生成。不在页面输入服务 Key；也不将私钥放进下载 ZIP。
3. 到 AKB「Agent 凭证」详情：选择服务 Key 获准查询的知识库，分别登记每个 Agent 的 UUID 与公钥。`public-enrollment/agent-N.json` 中有 UUID，`agent-N-public.jwk` 可直接作为公钥导入。
4. 在启动 Studio 和 OpenCode 的进程环境中设置服务 Key。Windows 示例：`$env:AKB_SERVICE_KEY = '<服务Key>'`。已经启动的进程不会自动获得后来设置的变量，需要重启。服务 Key 至少需要 `LIST`、`SEARCH`；使用问答还需 `QUERY`。
5. 回到工具验证每个 Agent。验证会检查服务端配置、签名身份、MCP 握手与工具清单；`get_agent_identity` 只在请求已携带验签身份时出现在清单中，因此由 `tools/call` 实际调用来核对身份；成功后保存服务端确认的绑定坐标。
6. 选择宿主版本及**全局** `opencode.json` / `opencode.jsonc` 路径，安装。安装器保留设置和注释、备份原文件并替换自己管理的旧插件；重启 OpenCode。
7. 切换到已绑定 Agent，先调用 `akb_identity`、`akb_bases`，再调用 `akb_search` 或 `akb_query`。未绑定 Agent、错误工作区、拒绝审批、未完成登记或已撤销公钥均不能成功调用。

AKB 需部署支持 V2 验签和身份工具的版本；互操作基线 `jhzhfree/akb@1a23e3940899e9059db412bddaa60466c567c885`，已与内网 `ai-knowledge-os` 分支 `feature/simple-agent-identity-v1`（`64138cb`）核对一致。没有实际 AKB 地址及生产凭证时，只能运行本地契约测试，不能当作生产联调已完成。

### 命令行制作与安装

```sh
node apps/plugin-studio/bin/akb-plugin.mjs build --workspace /absolute/project --out /absolute/secure/identity --agents build,plan --server https://kb.example/gateway/api/mcp --base KB_xxxx --major both
node apps/plugin-studio/bin/akb-plugin.mjs verify --config /absolute/secure/identity/akb-config.json --agent build
node apps/plugin-studio/bin/akb-plugin.mjs query --config /absolute/secure/identity/akb-config.json --agent build --query "报销制度是什么？"
node apps/plugin-studio/bin/akb-plugin.mjs install --bundle /absolute/secure/identity/plugin --major 2 --opencode-config /absolute/global/opencode.json
```

网关部署时需加 `--public-path-prefix /gateway`（或页面填写）：AKB 校验的 `request_binding.target` 是「前缀 + 路径 + 查询串」，漏掉前缀会导致每次调用 401。

Windows 产物还包括 `verify.ps1 -Agent build` 和 `install.ps1 -Major 2 -OpenCodeConfig <全局配置路径>`。1.x 安装执行带锁文件的 `npm ci --omit=dev --ignore-scripts`；2.x 插件运行时无需额外 npm 依赖。

输出包含：

```text
输出目录/
  akb-config.json         # 受保护配置：映射、服务坐标、环境变量名，不存服务 Key
  identities/N/          # 私钥、公钥、UUID 登记资料
  plugin/                # 独立运行时、两版入口、CLI、安装脚本、配置片段和公开登记资料
  akb-plugin.zip         # plugin/ 的无私钥 ZIP
```

ZIP 可以迁移插件代码，**不负责迁移身份**。换电脑要安全迁移配置与密钥并使用 `--config`，或重新生成身份并在 AKB 登记。

### 兼容范围与网络边界

| 宿主 | 入口与行为 |
| --- | --- |
| 1.x Promise 审批 | callable 默认导出，注册自定义工具，等待 `context.ask` |
| 1.14.30 Effect 审批 | 同一入口，先捕获宿主 Fiber，再执行 Effect，不丢失审批上下文 |
| 2.x（SDK 2.2.5） | `id/setup`、`tool.transform`、实时 `session.get`、`permission.assert`、可释放注册 |
| 缺少必要审批能力的早期版本 | 生产模式拒绝，不开启 `legacyReadOnly` 绕过；请升级宿主 |

知识库查询只接受 `KB_...` 系统 ID；默认 ID 留空时先调用 `akb_bases` 再传 ID。逐请求签名绑定方法、路径（含网关前缀）、正文、服务 Key 摘要与一次性 nonce，TTL 默认 30 秒（服务端上限 60）。权限不足返回 `AKB_FORBIDDEN`（`tools/call` 的 `-32001`），正文过大为 `REQUEST_TOO_LARGE`（HTTP 413）。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 启动提示端口被占用 | `STUDIO_PORT=4181 node apps/plugin-studio/server.mjs`；MCP 用 `--port` |
| 提示 `identity-sdk 未找到` | 用仓库内路径启动，或设 `IDENTITY_SDK_DIR`；便携包请连 `vendor/` 一起拷 |
| `HTTP 401` | UUID/名称未登记、kid 与私钥不匹配、`enabled=false`、时钟偏差或证明被重放 |
| `HTTP 403` | Host/Origin 被改写；必须访问 `http://127.0.0.1:<port>/mcp` |
| 每次请求数秒（Windows） | 受保护文件每次读都要 PowerShell 校验 ACL，属已知开销；服务端已按 mtime 缓存注册表 |
