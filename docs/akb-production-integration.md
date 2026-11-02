# AKB MCP Agent 插件接入

## 边界

`packages/identity-sdk` 是唯一签名与安全文件实现；Studio、本地演示程序、独立插件包引用同一实现。`LOCAL_AGENT_PROOF_V1` 只用于本地演示，`AGENT_KEY_RS256_V2` 用于 AKB，两者不能回退或互换。

AKB 仍负责公钥登记、服务 Key、Agent 绑定、撤销、授权及防重放。插件不代替服务端授予知识库权限。普通服务凭证可按权限直接调用；Agent 凭证的发现接口允许只用服务 Key，工具执行必须逐请求验签。外部知识库只使用 `knowledgeBaseId: KB_...`。

## 工具页面的两种模式

页面默认选择“基础身份验证插件”，保留原 main 的本地 MCP 启停、身份验签、1.x/2.x 插件自检和部署流程。选择“AKB 知识库插件”后使用 AKB 地址、服务 Key 环境变量、公钥登记、分阶段检查与安装流程。工作区、Agent 和版本为公共配置；本机端口、legacyReadOnly、私钥迁移选项只出现在基础模式。

切换模式不会丢弃已生成结果；刷新带 `?job=` 的页面时按任务类型恢复，AKB 任务不会进入本地 MCP 验证流程。SDK 实验区仍可独立使用。

## 制作和使用

1. Node 22+，运行 `npm run dist`，独立复制 `dist/plugin-studio` 后运行 `start.cmd`。选择真实工作区和 Agent，填写 AKB 地址、服务 Key 环境变量名、可选默认 KB_ ID。输出目录必须在工作区外。
2. 将生成的 `enrollment.json` / `public.jwk` 登记到 AKB Agent 凭证，配置知识库范围及 Agent 策略。私钥保留在终端受保护目录，不上传 AKB。下载 ZIP 默认不含私钥、服务 Key。
3. 在启动 Studio / OpenCode 的进程环境设置服务 Key（例如 `AKB_SERVICE_KEY`），运行身份验证。验证结果必须同时匹配登记的 UUID、kid、策略和 MCP 返回身份。
4. 使用“分阶段检查”，填写实际问题和默认知识库。四阶段分别为 `connection`、`identity`、`catalog`、`retrieval`；未填写问题时检索为 `not_checked`，`ok` 为 false。目录或检索被拒绝时保留此前通过的阶段，不把拒绝解释为空结果。
5. 选择 OpenCode 1.x 或 2.x 安装，配置文件先备份。指定 Agent 调用 `akb_bases` 选择可见知识库，再调用 `akb_search` / `akb_query`。多个知识库时必须选择具体 KB_ ID。

命令行也支持：

```text
node bin/akb-plugin.mjs check --config <绝对配置路径> --agent build --query "测试问题" --base KB_...
```

更新插件时使用安装命令的 `--config` 指向原受保护配置，不必重新生成 UUID/密钥或登记。`build` 创建新身份且拒绝覆盖已有输出目录，不能用它覆盖旧私钥。密钥轮换须先在 AKB 登记新公钥并验证，再撤销旧密钥。

## 运行时身份与审计

OpenCode 插件在宿主工具上下文捕获 Agent、会话、消息和目录，通过授权确认后签名实际请求字节。模型工具参数不能提供身份或私钥。1.x 使用 Promise 工具接口；2.x 使用宿主会话与 Effect 接口，均校验真实工作区和调用权限。

AKB 的 `CallerContext` 来源为已认证凭证，保存不可变且不含秘密的调用方快照，普通工具不接收身份参数。同步请求结束清理；SSE 通过显式包装传入工作线程并清理。审计把身份读取次数、实际 scope/知识库授权决定、工具结果分开；读取身份不等于执行授权。

Octop 继续用原生 Python V2 签名和加密私钥存储；`InvocationCaller` 提供无秘密的异步上下文。该上下文是宿主断言，远端是否接受由 AKB 响应决定。会话、单次调用、链路 trace 分开保留，服务模式不伪装成 Agent。

跨语言公共向量见 `contracts/akb-v2`。向量故意过期，只验证协议一致性；正常服务不会放宽过期检查。Linux 自动验证不能代替 Windows 真机和生产 AKB 的验收。
