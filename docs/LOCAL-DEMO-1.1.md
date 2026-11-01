> 历史本机演示文档。AKB 生产模式请使用主 README；旧相邻目录依赖已由本仓库 vendor/identity-lab 替代。

# OpenCode Identity Studio

把 MCP Agent 身份插件工厂做成一个本地 Web 工作台：**检测真实 OpenCode Agent → 生成密钥与配置 → 在线验签 → 打包下载可直接部署的插件**。

```
studio/
├── server.mjs                  路由 / 静态资源 / 服务端进程管理 / 任务持久化
├── bin/identity-server.mjs     MCP 身份服务端 CLI（SDK 验签）
├── lib/
│   ├── sdk.mjs                 SDK 加载器（可用 IDENTITY_SDK_DIR 指向外部安装）
│   ├── mcp-server.mjs          服务端实现：注册表 + 身份证明 + 请求证明 + 重放防护
│   ├── sdk-check.mjs           SDK 一致性自检（17 条断言，进程内跑）
│   ├── builder.mjs             生成编排：SDK 生成密钥/UUID/签名 → 注册表 → 插件 → 打包
│   ├── selftest.mjs            用模拟宿主上下文跑 1.x/2.x 插件接口自检（只断言本次生成的版本）
│   ├── detect.mjs              opencode CLI / 配置目录探测
│   ├── guide.mjs               生成带真实路径的 SETUP.md
│   ├── zip.mjs                 store-only ZIP（不依赖 PowerShell / 原生模块）
│   └── jobs.mjs                异步任务、进度、重启恢复
├── packages/identity-sdk/      ★ 独立 SDK 组件（零依赖）
│   ├── src/{keys,uuid,identity,proof,registry,client,agent}.mjs
│   ├── bin/sdk.mjs             CLI：keygen / sign / verify / proof / verify-agent / call-tool
│   ├── test/sdk.test.mjs       57 条单测
│   └── README.md               API 文档
└── public/                     index.html / app.js / style.css
```

## 为什么要拆出 SDK

原来生成密钥、签名、验签的代码和「生成工具」「服务端」混在一起，两边各写一份规则，只要有一处实现差异就会出现"生成端签的、服务端验不过"。

现在密码学只存在于 `packages/identity-sdk`：

| 能力 | 方法 | 谁在用 |
| --- | --- | --- |
| 生成密钥对 | `generateKeyPair()` / `createAgentIdentity()` | 生成侧 |
| 生成 UUID | `generateUuid()` | 生成侧 |
| 用私钥签 Agent 名称 + UUID | `signIdentity()` | 生成侧 |
| 用公钥验签 | `verifyWithPublicKey()` / `verifyIdentity()` | 服务端、部署脚本、Studio 面板 |
| 公钥归一化 / 只解码 | `normalizePublicKey()` / `inspectAttestation()` | 需要展示或比对指纹的调用方 |
| 请求签名 / 验签 | `createProof()` / `verifyProof()` | 生成后的插件、服务端 |
| 注册表与身份证明校验 | `validateRegistry()` / `verifyEnrollment()` | 服务端（启动与变更时） |

签名是**分离式**的：`identity.json` 里保存 `claim`（含 `sub`=UUID、`agent`=名称、`kid`）和 `signature`，
`registry.json` 的每一行还带同一份 `attestation`。所以即使有人改了注册表里的 Agent 名称、或把另一把公钥塞进来，
服务端也会以 `ATTESTATION_AGENT` / `REGISTRY_KID` 拒绝加载，而不是照着被改过的名字放行。

## 启动

```bash
cd studio
node server.mjs          # http://127.0.0.1:4180
```

可选环境变量：`STUDIO_PORT`、`STUDIO_WORKSPACE`、`IDENTITY_LAB_DIR`（插件运行时所在的上游包）、`IDENTITY_SDK_DIR`。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/status` | Node / lab / sdk 版本、服务端进程状态 |
| GET | `/api/opencode/detect?workspace=` | 探测 CLI、宿主主版本、Agent 列表 |
| POST | `/api/build` | 生成身份与插件（异步任务） |
| GET | `/api/jobs/:id` | 任务进度 |
| POST | `/api/verify` | **用 SDK 签名**后调用 MCP 工具（whoami / echo_secure / add） |
| POST | `/api/selftest` | 插件接口自检（模拟宿主） |
| POST | `/api/server/start` \| `/stop` | 启动/停止 SDK 服务端 |
| GET | `/api/server/log` | 审计日志 |
| POST | `/api/plugin` | 只换主版本重新生成插件 |
| GET | `/api/download/:id` | 下载 ZIP（含 `server/` 与 `server/packages/identity-sdk/`） |
| GET | `/api/sdk/info` | SDK 版本、模块、方法清单 |
| POST | `/api/sdk/keypair` | 生成密钥对 + UUID + 身份证明（私钥留在服务进程内） |
| POST | `/api/sdk/sign` | 用该私钥签 Agent 名称 + UUID |
| POST | `/api/sdk/verify` | 用会话内 `ref` 取公钥验签；`tamper=agent\|uuid\|signature` 演示篡改必被拒 |
| POST | `/api/sdk/verify-public` | **只凭请求里的公钥**（PEM / JWK / JSON）验签，不需要 ref 或注册表 |
| POST | `/api/sdk/inspect` | 只解码身份证明并显示 claim（不验签） |
| POST | `/api/sdk/proof` | 生成 X-Agent-Proof 并往返验证：通过 / 重放被拒 / 改 body 被拒 |
| POST | `/api/sdk/selftest` | 22 条 SDK 断言 |

## 宿主版本探测

生成哪一版插件由**实测宿主**决定，顺序是：`OPENCODE_VERSION` 环境变量 → CLI `--version` →
配置目录已安装的插件 SDK → 配置目录 `package.json` 声明。

- CLI 候选包含桌面版的 `…\Programs\ai.opencode.desktop\resources\opencode-cli.exe`（macOS 为
  `OpenCode.app/Contents/Resources/opencode-cli`），只查 PATH 会漏掉桌面安装。
- 2.x 用 `opencode debug agents` 列 Agent，1.x 用 `opencode agent list`。升级到 2.x 后
  `agent list` 已移除，CLI 会返回帮助文本且退出码为 0；探测会识别帮助文本，不会把
  `DESCRIPTION`/`USAGE` 当成 Agent。
- 配置目录的 `package.json` 可能长期停留在旧版本（例如声明 `@opencode-ai/plugin@1.4.3`
  而宿主已是 2.2.5）。实测宿主与声明不一致时会以实测为准，并在面板上给出提示。

## 测试

```bash
npm test                # 宿主探测单测（帮助文本、debug agents、桌面版路径、版本覆盖）
npm run sdk:test        # SDK 单测（57 条）
npm run sdk:selftest    # SDK CLI 自检
# Studio 面板：/api/sdk/selftest → 22 条断言
# Studio 面板：/api/selftest     → 插件自检，只断言本次生成的主版本，另一版本记为跳过
cd ../1.1.0/.../mcp-agent-identity-lab && npm run check:contracts  # 对官方 @opencode/plugin@2.2.5 做真实类型检查
node --test test/lab.test.mjs   # 上游包测试（Windows 上必须在 PowerShell 里跑）
```

## 与上游 `mcp-agent-identity-lab` 的关系

- 生成插件仍调用上游 `generatePlugin`（1.x 文件入口 / 2.x 目录入口），所以生成的插件引用上游运行时。
- 身份生成已改为 SDK：密钥对、UUID、签名都由 SDK 完成，`identity.json` 因此多了 `claim` + `signature`。
- MCP 服务端已换成 `bin/identity-server.mjs`（SDK 验签），仍**字节兼容**上游插件发出的 `X-Agent-Proof`，
  所以 1.x/2.x 插件不用改就能对接。
- 注册表只增加了一个 `attestation` 字段，上游服务端读到会忽略，互不破坏。

## 性能

服务端把注册表按 `mtime + size + inode` 缓存，只在文件变化时重新读取并复核身份证明，
因此工具调用从原来的 4–6 秒降到 10–30 毫秒（`/api/verify` 实测）。

## 演示模式

打开 `http://127.0.0.1:4180/?sdk=demo` 会自动跑一遍 SDK 面板（生成密钥 → 验签 → 请求证明 → 自检），方便截图与演示。
