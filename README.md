# OpenCode Identity — 三个可分别启动的程序

MCP Agent 身份的工具集，拆成三个**互相独立、可分别手动启动**的程序。
密码学只有一份实现：`packages/identity-sdk`。另外两个程序都调用它，没有第二份密钥/签名代码。

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
| **[docs/IDENTITY-PROTOCOL.md](docs/IDENTITY-PROTOCOL.md)** | **身份认证协议**：身份从哪来、`X-Agent-Proof` 逐字段、服务端四道闸门与 12 项校验、identity 如何注入工具、攻击面与实测拒绝结果、自写客户端的 20 行范例 |
| **[docs/PLUGIN-INSTALL.md](docs/PLUGIN-INSTALL.md)** | **插件安装与使用说明**：5 分钟装完、1.x/2.x 配置写法、三层验证、三个工具用法、权限审批、错误对照、卸载、安全边界 |
| [apps/plugin-studio/README.md](apps/plugin-studio/README.md) | 生成工具：页面流程、API、生成产物结构 |
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
│   │   ├── public/            前端
│   │   └── test/              探测回归测试
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
npm test                 # 探测回归 + MCP 程序冒烟 + SDK 单测（57 条）
npm run sdk:selftest     # SDK CLI 自检
```

实测结果（Windows 22.2.2 / OpenCode 2.2.5 桌面版）：

| 项 | 结果 |
| --- | --- |
| SDK 单测 | 57/57 |
| MCP 程序冒烟（起进程 + 签名调用 + 401/403 + 缺注册表） | 3/3 |
| 便携包 dist/mcp-server + dist/sdk 联调 | `verify-agent`  verified，203 ms |
| 插件生成（2.x，仓库内） | 8 步约 80 s，ZIP 151 KB |
| 插件自检（2.x + 服务端运行） | 15 通过 / 0 失败 / 1 跳过（未生成的 1.x） |
| 便携包 dist/plugin-studio 全流程 | 生成 + 起服务 + 自检 15/0/1 |

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 启动提示端口被占用 | `STUDIO_PORT=4181 node apps/plugin-studio/server.mjs`；MCP 用 `--port` |
| 提示 `identity-sdk 未找到` | 用仓库内路径启动，或设 `IDENTITY_SDK_DIR`；便携包请连 `vendor/` 一起拷 |
| `HTTP 401` | UUID/名称未登记、kid 与私钥不匹配、`enabled=false`、时钟偏差或证明被重放 |
| `HTTP 403` | Host/Origin 被改写；必须访问 `http://127.0.0.1:<port>/mcp` |
| 每次请求数秒（Windows） | 受保护文件每次读都要 PowerShell 校验 ACL，属已知开销；服务端已按 mtime 缓存注册表 |
