# OpenCode Identity Studio

本地插件制作工具：检测 OpenCode Agent，生成独立 UUID / RSA 密钥，在 AKB 登记后验证并安装插件，让**执行中的指定 Agent**以自己的身份查询知识库。

新增 AKB 生产模式与原本的本机演示协议分开：生产使用 `X-API-Key` + `X-AKB-Workload-Assertion` / `AGENT_KEY_RS256_V2`；不会拿本机演示的 `X-Agent-Proof` 请求 AKB，也不会缺少身份时降级成普通服务凭证。

## 快速使用（Windows / Linux / macOS）

需要 Node.js 22+、npm；Windows 使用 NTFS 和系统 PowerShell 5.1+ 做私钥 ACL 保护。

```sh
npm ci --ignore-scripts
npm start
```

打开 `http://127.0.0.1:4180`，使用 **AKB 生产插件** 卡片：

1. 检测 OpenCode，选择真实 Agent 名称（例如 `build`、`plan`），填写工作区和新的工作区外输出目录。
2. 输入 AKB 地址、默认知识库 ID（KB_ 开头）、服务 Key 的**环境变量名称**，点击生成。不在页面输入服务 Key；也不将私钥放进下载 ZIP。
3. 到 AKB「Agent 凭证」详情：选择服务 Key 获准查询的知识库，分别登记每个 Agent 的 UUID 与公钥。`public-enrollment/agent-N.json` 中有 UUID，`agent-N-public.jwk` 可直接作为公钥导入。
4. 在启动 Studio 和 OpenCode 的进程环境中设置服务 Key。Windows 示例：`$env:AKB_SERVICE_KEY = '<服务Key>'`。已经启动的进程不会自动获得后来设置的变量，需要重启。服务 Key 至少需要 `LIST`、`SEARCH`；使用问答还需 `QUERY`。
5. 回到工具验证每个 Agent。验证会检查服务端配置、签名身份、MCP 握手、工具清单与 `get_agent_identity` 返回的身份；成功后保存服务端确认的绑定坐标。
6. 选择宿主版本及**全局** `opencode.json` / `opencode.jsonc` 路径，安装。安装器保留设置和注释、备份原文件并替换自己管理的旧插件；重启 OpenCode。
7. 切换到已绑定 Agent，先调用 `akb_identity`、`akb_bases`，再调用 `akb_search` 或 `akb_query`。未绑定 Agent、错误工作区、拒绝审批、未完成登记或已撤销公钥均不能成功调用。

AKB 需部署支持 V2 验签和身份工具的版本；本次互操作基线是 `jhzhfree/akb@1a23e3940899e9059db412bddaa60466c567c885`。没有实际 AKB 地址及生产凭证时，可以运行下面的本地契约测试，不能将其当作生产联调已完成。

## 命令行制作与安装

生成器不覆盖现有目录。路径含空格时请按当前终端的规则加引号。

```sh
node bin/akb-plugin.mjs build --workspace /absolute/project --out /absolute/secure/identity --agents build,plan --server https://kb.example/gateway/api/mcp --base KB_xxxx --major both
node bin/akb-plugin.mjs verify --config /absolute/secure/identity/akb-config.json --agent build
node bin/akb-plugin.mjs query --config /absolute/secure/identity/akb-config.json --agent build --query "报销制度是什么？"
node bin/akb-plugin.mjs install --bundle /absolute/secure/identity/plugin --major 2 --opencode-config /absolute/global/opencode.json
```

在生成的 `plugin` 目录中也可直接运行：

```sh
node bin/akb-plugin.mjs verify --agent build
node bin/akb-plugin.mjs install --bundle . --major 1 --opencode-config /absolute/global/opencode.json
```

Windows 产物还包括 `verify.ps1 -Agent build` 和 `install.ps1 -Major 2 -OpenCodeConfig <全局配置路径>`。1.x 安装执行带锁文件的 `npm ci --omit=dev --ignore-scripts`；2.x 插件运行时无需额外 npm 依赖。

输出包含：

```text
输出目录/
  akb-config.json         # 受保护配置：映射、服务坐标、环境变量名，不存服务 Key
  identities/N/          # 私钥、公钥、UUID 登记资料
  plugin/                # 独立运行时、两版入口、CLI、安装脚本、配置片段和公开登记资料
  akb-plugin.zip         # plugin/ 的无私钥 ZIP
```

ZIP 可以迁移插件代码，**不负责迁移身份**。在生成机器安装时自动引用同级受保护配置；换电脑要安全迁移配置与密钥并使用 `--config`，或重新生成身份并在 AKB 登记。不要将代码 ZIP 当作携带生产凭证的一键身份包。已有身份也可写入受保护配置的 `uuid`、`privateKeyFile` 后执行 `verify`；私钥路径必须在工作区外并通过所有者/ACL 检查。

## OpenCode 兼容范围

| 宿主 | 入口与行为 |
| --- | --- |
| 1.x Promise 审批 | callable 默认导出，注册自定义工具，等待 `context.ask` |
| 1.14.30 Effect 审批 | 同一入口，先捕获宿主 Fiber，再执行 Effect，不丢失审批上下文 |
| 2.x（SDK 2.2.5） | `id/setup`、`tool.transform`、实时 `session.get`、`permission.assert`、可释放注册 |
| 缺少必要审批能力的早期版本 | 生产模式拒绝，不开启 `legacyReadOnly` 绕过；请升级宿主 |

按真实 API 能力检查，并不声称每个 1.x / 2.x 小版本都已实机运行。插件通过自定义工具代理调用 MCP，因为静态 MCP headers 无法获取每次执行中的 Agent 身份。

知识库查询仅使用 `knowledgeBaseId`，值必须是 `akb_bases` 返回的 `KB_...` 系统 ID，不接受数字主键、业务编码或 `knowledgeBaseCode`。默认 ID 可留空，此时先调用 `akb_bases`，再将返回的 ID 传给 `akb_search` / `akb_query`。

工具只接受查询、topK、知识库标识等业务参数；没有可由模型填写的 UUID、私钥、服务 Key 或 Agent 名称参数。服务端最终执行知识库范围及权限检查，客户端不会用返回“已验签”替代资源授权。

## 网络与密钥边界

默认只允许 HTTPS；本机 HTTP 可用，私网 IP HTTP 必须显式勾选或添加 `--allow-private-http`。禁止 URL 内嵌凭证和认证重定向。AKB 的 resourceOrigin 填写协议、主机和端口（不含路径），插件连接地址可带网关前缀。网关保留前缀，重写时需要 AKB 配置 `knowledge.external.public-path-prefix`。

逐请求签名绑定真实方法、路径、正文、服务 Key 摘要和短期 nonce。完整 MCP 初始化、通知和工具请求共享 HTTP 超时预算；响应最多 2 MiB。发现请求可以只用服务 Key，业务工具必须带当前 Agent 签名，不自动重试或降级。所有请求都计入服务配额。

POSIX 私钥/配置使用 owner-only 权限，Windows 使用 SID ACL；拒绝不可信父目录、符号链接和工作区内的身份文件。Studio 仅监听本机，管理 POST 校验 Origin 和 JSON Content-Type。可信边界是 OpenCode 宿主与操作系统账号：这不是不同 Agent 之间的操作系统强隔离；若允许同账号任意终端/文件访问，不能声称私钥对该代码不可见。需要更强隔离时应配置工具沙箱或独立账号/可信签名代理。

## 验证

```sh
npm test                    # SDK、真实 HTTP 签名、两代上下文、安装与本地 Web API
npm run check:contracts     # 官方 OpenCode 2.2.5 SDK 类型契约
npm run test:bundle         # 实际解包、npm ci、加载产物并分别调用 MCP
```

可选：先在 AKB 工程执行 Maven 测试，再设置 `AKB_REPO` 指向该工程，运行 `npm run test:akb-java`。它使用 **AKB 真正的 Java 验签器**，不是复制一份验签实现。

CI 已配置 Linux / Windows、Node 22 / 24，以及固定 AKB 提交的 Java 互操作。当前本地验证在 Linux；Windows 结果以对应 CI 为准。

[设计分析与改进](docs/AKB-DESIGN.md) · [本轮验证记录](docs/VALIDATION.md) · [原本机演示功能](docs/LOCAL-DEMO-1.1.md)
