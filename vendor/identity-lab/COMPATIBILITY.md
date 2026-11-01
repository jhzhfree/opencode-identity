# OpenCode 1.x / 2.x 兼容说明（独立包 1.1.0）

生成器支持 `--opencode-major 1`、`2` 或 `both`（默认）。MCP 服务端及 UUID/公钥协议不随宿主版本改变；两种插件入口分别实现各自的宿主 API。

| API 参考版本 | 入口 | 审批路径 | 本包行为 |
| --- | --- | --- | --- |
| 1.0.142 / 1.1.4 | 默认导出函数，返回 tool map；execute 返回字符串 | ToolContext 未提供 ask | 默认拒绝；显式 legacyReadOnly 后允许三个本机只读工具 |
| 1.14.30 | 同上；兼容 server 属性 | context.ask 返回 Effect | 捕获原始 fiber，上下文不变地执行审批 |
| 1.19.5 | 同上 | context.ask 返回 Promise | 等待同一次审批，支持取消，拒绝不发请求 |
| 2.0.28 | 默认导出 id/setup；tool.transform | 正式 SDK 未公开 permission.assert | 默认拒绝；显式 legacyReadOnly 后允许三个本机只读工具，仍声明宿主工具权限 |
| 2.2.5 | 默认导出 id/setup；tool.transform | ctx.permission.assert 返回 Promise | 使用运行 Agent、会话和 source 进行原生审批 |

这里列的是已核对的正式 npm API 定义，不代表已经运行过每个版本的真实模型宿主。实现按能力检测，而非假设整个主版本的每个小版本完全相同：

- 1.x 必须提供真实 `ToolContext.agent`、sessionID 和 abort；目录缺失时使用旧插件实例的可信加载目录。
- 2.x 必须提供真实执行上下文的 agent/sessionID/messageID/id/signal，以及 tool.transform、session.get；执行时读取该会话的 location.directory，不把插件实例目录当成所有会话的目录。
- 1.x/2.x 缺少审批 API 时，只有操作者明确设置 `legacyReadOnly: true` 才可继续；身份签名和工作区检查不会关闭。
- 新版宿主具备审批方法时，始终执行原生审批，即使 legacyReadOnly 已开启。
- 不认识的审批返回类型、缺失真实 Agent 或未知主版本，不会凭模型参数补身份或静默降级。
- V2 的 tool.options.codemode=false，使三个演示工具以普通工具方式提供，不要求模型通过 Code Mode 间接调用。

## 配置区别

1.x：

```json
{"plugin":["file:///C:/secure/plugin/identity-plugin.mjs"],"permission":{"identity_whoami":"ask"}}
```

2.x：

```json
{
  "plugins":[{"package":"file:///C:/secure/plugin/opencode-v2"}],
  "permissions":[{"action":"identity_whoami","resource":"*","effect":"ask"}]
}
```

以上路径仅为形状示例，以生成器输出的真实路径为准；不要同时合并两个版本的配置。

## 从旧独立包升级

保留原来的 registry.json、terminal-config.json 和每个 Agent 的私钥，不必重建身份。解压新包后，用现有配置生成新目录：

```powershell
node bin/lab.mjs plugin --config C:\secure\terminal-config.json --out C:\secure\plugin-11 --opencode-major both
```

根据 doctor 识别出的主版本，替换全局配置中对应插件条目并重启。

## 验证级别

- 真实本地 HTTP 服务端和 RSA 签名请求：已测试。
- 1.x Effect、Promise、早期只读兼容；2.x 原生 setup/注册/权限/取消/会话目录/并发身份：自动化测试。
- V2 实现对官方 `@opencode/plugin@2.2.5`：`npm run check:contracts` 类型检查通过。此 SDK 是开发依赖，运行包不需要加载它。
- 真实 Windows NTFS、真实 OpenCode/模型 UI：仍需在目标机器按 README 验收。

## 官方参考

- [V1 → V2 插件迁移](https://opencode.ai/v2/docs/build/plugins/migrate-v1/)
- [V2 服务端插件与权限](https://opencode.ai/v2/docs/build/plugins/server/)
- [V2 插件目录及配置](https://opencode.ai/v2/docs/build/plugins/)
- [V2 权限规则](https://opencode.ai/v2/docs/permissions/)
- [V1 插件 SDK](https://www.npmjs.com/package/@opencode-ai/plugin)
- [V2 插件 SDK](https://www.npmjs.com/package/@opencode/plugin)
