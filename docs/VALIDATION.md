# 验证记录

本轮修改起点：opencode-identity `7b6624e`；AKB Java 互操作基线 `1a23e3940899e9059db412bddaa60466c567c885`。

服务端基线核对（2026-11-02）：内网 `git@192.168.22.16:zhanghe/ai-knowledge-os.git` 分支 `feature/simple-agent-identity-v1`（`64138cb`）与公开镜像同名分支内容一致（backend 65 个 `*Service.java`、39 个 `*Controller.java`、db/migration V1–V80、docs 均同名同大小，关键契约点逐字符相同），因此不存在两仓之间的客户端适配差异。

验证入口：

- `npm test`：原 SDK、版本/Agent 检测、HTTP 签名和身份隔离、审批拒绝与取消、JSONC 备份与升级、Studio 独立启动及跨站写入拒绝。
- `npm run check:contracts`：正式 `@opencode/plugin@2.2.5` 的上下文、工具注册、审批和返回类型。
- `npm run test:bundle`：从 ZIP 实际解包，使用产物自己的依赖和配置定位，安装两代入口并分别以 build/plan 调用 MCP。服务数据为合成测试数据，不是生产知识库。
- `AKB_REPO=/path/to/akb npm run test:akb-java`：先执行 AKB Maven 测试生成 classpath；Node SDK 签出带中文/emoji 正文和网关前缀的证明，交给 AKB 真正的 AgentKeyProofVerifier。检查接受合法证明，并拒绝重放、正文/服务凭证篡改和公钥撤销。

历史记录：2026-11-01 上轮最终冻结源码后顺序执行：70 项测试通过、0 失败、0 跳过；官方 SDK 契约检查通过；从 ZIP 解包并按独立锁文件 npm ci 后，两代实际产物分别以不同 Agent 查询 MCP 通过；AKB 原 Java 验签器接受合法证明并拒绝四类反例。所有验证进程正常退出。没有使用生产凭证；Windows 实机及真实模型会话不在本地验证范围。CI 配置覆盖 Windows/Linux 与 Node 22/24，不将“已配置 CI”表述成 CI 已通过。


2026-11-01 知识库 ID 契约更新：72 项测试通过、0 失败、0 跳过；官方 SDK 类型契约检查通过；实际 ZIP 解包、独立依赖安装与 OpenCode 1.x/2.x 插件调用通过。新增覆盖数字主键/旧业务编码/旧字段拒绝、生成及配置校验、无默认知识库时获取目录并使用返回的 `knowledgeBaseId`、检索与问答精确请求体。使用 AKB `1a23e3940899e9059db412bddaa60466c567c885` 编译产物的真实 Java 验签器再次验证通过，接受包含 `KB_...` ID 的合法正文并拒绝重放、正文/凭证篡改和撤销密钥。本轮本地验证在 Linux，未执行生产环境联调或 Windows 实机验证。

2026-11-02 内网契约对齐：新增 `test/akb-contract.test.mjs` 5 项并通过（网关前缀进入签名 target、默认 TTL 30、`publicPathPrefix` 校验与 URL 组装、`-32001` 权限失败与 `413` 正文过大的错误码区分、正文摘要绑定实际字节）；`packages/identity-sdk` 57 项测试仍全部通过。行为变更：`tools/list` 不再把 `get_agent_identity` 当作必备项（它只在请求已携带验签身份时才出现在清单中），身份改由 `tools/call` 核对；密钥状态接受 `ACTIVE|RETIRING`；受保护配置里的默认知识库留空时不再发送该参数，由 AKB 选择默认库。本轮未做生产联调。`test/akb.test.mjs` 在本机整体超过默认超时，原因是 Windows ACL 加固单次耗时 5–8 秒（实测：新建目录 5.3–6.5 秒、写私钥 7.6 秒），需在放宽超时或非 Windows ACL 路径的环境中执行。
