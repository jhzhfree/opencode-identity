# 验证记录

基线：opencode-identity `40b22ee`；AKB Java 互操作基线 `7d19cadf0b14e3b2c44b8b2016587cef35a613f1`。

验证入口：

- `npm test`：原 SDK、版本/Agent 检测、HTTP 签名和身份隔离、审批拒绝与取消、JSONC 备份与升级、Studio 独立启动及跨站写入拒绝。
- `npm run check:contracts`：正式 `@opencode/plugin@2.2.5` 的上下文、工具注册、审批和返回类型。
- `npm run test:bundle`：从 ZIP 实际解包，使用产物自己的依赖和配置定位，安装两代入口并分别以 build/plan 调用 MCP。服务数据为合成测试数据，不是生产知识库。
- `AKB_REPO=/path/to/akb npm run test:akb-java`：先执行 AKB Maven 测试生成 classpath；Node SDK 签出带中文/emoji 正文和网关前缀的证明，交给 AKB 真正的 AgentKeyProofVerifier。检查接受合法证明，并拒绝重放、正文/服务凭证篡改和公钥撤销。

2026-11-01 最终冻结源码后顺序执行：70 项测试通过、0 失败、0 跳过；官方 SDK 契约检查通过；从 ZIP 解包并按独立锁文件 npm ci 后，两代实际产物分别以不同 Agent 查询 MCP 通过；AKB 原 Java 验签器接受合法证明并拒绝四类反例。所有验证进程正常退出。没有使用生产凭证；Windows 实机及真实模型会话不在本地验证范围。CI 配置覆盖 Windows/Linux 与 Node 22/24，不将“已配置 CI”表述成 CI 已通过。
