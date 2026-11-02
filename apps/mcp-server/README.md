# MCP 验签服务端（独立程序）

程序 3。只做一件事：**用注册表里的公钥验出调用方身份，再把请求交给工具**。
不负责生成密钥、不生成插件——那两件事分别是程序 1 和程序 2。

## 启动

```bash
node apps/mcp-server/bin/serve.mjs --registry <registry.json> [--port 8781] [--quiet]

# 或
start-mcp.cmd --registry C:\Users\me\mcp-identity\run-1\registry.json --port 8781
./apps/mcp-server/start.sh --registry /home/me/run-1/registry.json
```

参数：

| 参数 | 说明 |
| --- | --- |
| `--registry <file>` | 必填。`{version:1, agents:[…]}`，每行含 `uuid/agentName/kid/publicJwk/attestation` |
| `--port <n>` | 默认 8781，只绑定 `127.0.0.1` |
| `--tools <file>` | 业务工具模块（ESM，default 导出 `{ 工具名: { description, schema, run(args, context) } }`），见下文「注册业务工具」 |
| `--allow-missing-attestation` | 允许旧注册表没有身份证明（排障用，正常不要开） |
| `--quiet` | 不输出每请求的 JSON 审计行 |
| `-V, --version` | 打印版本、Node 版本、实际使用的 SDK 路径 |
| `-h, --help` | 用法 |

启动后会先在 stderr 打一行 `[ready] http://127.0.0.1:<port>/mcp registry=… agents=N`，
stdout 每行一条 JSON 事件（`listening` / `mcp_request` / `authentication_failed` / `registry_unavailable`），
便于被其他程序或 shell 监督。

## 校验顺序

1. **传输**：Host 必须等于监听地址，带 Origin 时必须同源，只接受 `POST /mcp` + `application/json`，body ≤ 64 KB。
2. **注册表**：结构校验 + 每行身份证明（名称 ↔ UUID ↔ kid ↔ 公钥）。文件变了才重读（mtime/size/inode）。
3. **请求证明** `X-Agent-Proof`：body SHA-256、method、path、aud、≤30 s 有效、jti 一次性。
4. **工具参数**：只接受声明的字段；UUID / Agent 名永远来自验签结果。

失败一律 `401`，不区分「UUID 不存在」和「签名不对」，避免成为探测工具。

## 工具

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| `whoami` | 无 | `{identity:{uuid,agentName,kid,verified:true,…}}` |
| `echo_secure` | `{text}` | 原样回显 + 验出的身份 |
| `add` | `{a,b}` | 和 + 验出的身份 |

## 注册业务工具

`run(args, context)` 允许是 **async**（内部可任意做 IO），身份有两种取法：

| 取法 | 适用 | 说明 |
| --- | --- | --- |
| `context.identity` | 工具函数本身 | `dispatch` 冻结后作为第二参数传入 |
| `currentIdentity()` | 调用链更深的模块 | `lib/context.mjs` 的 `AsyncLocalStorage`；深层代码不改签名即可拿到同一份冻结身份 |

```js
// my-tools.mjs
import { currentIdentity } from '@opencode-identity/mcp-server/lib/context.mjs'; // 或相对路径 ../lib/context.mjs
export default {
  whoami_deep: {
    description: '…',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(args) {
      const { uuid, agentName } = currentIdentity(); // 验签后的冻结对象，伪造/篡改不了
      return { uuid, agentName };
    },
  },
};
```

```bash
node apps/mcp-server/bin/serve.mjs --registry … --tools ./my-tools.mjs
```

可运行示例见 [`examples/business-tools.mjs`](examples/business-tools.mjs)（工具 `whoami_deep`，
在 `await` 之后的深层代码里读身份，实测与 `whoami` 返回完全一致）。三条安全性质：

- 存储里只可能是 `verifyProof()` 产出的**冻结**对象，读得到、伪造/篡改不了；
- 每个请求一个独立 store，并发请求互不可见，请求结束即消失；
- 在请求链之外调用 `currentIdentity()` 直接抛错，绝不返回未验证的值。

工具名与内置三个工具冲突时启动即失败；`run` 抛出的错误与内置工具一样转成 JSON-RPC `-32602`。

## 健康检查

```bash
curl -H "Host: 127.0.0.1:8781" http://127.0.0.1:8781/health
# {"ok":true,"server":"local-agent-identity-mcp","sdk":true,"attestation":[{"agentName":"build","status":"verified"}]}
```

`attestation` 是启动时缓存的身份证明复核结果；注册表被改坏时 `/health` 会先失败（503），
不会带着坏数据继续放行请求。

## 跨语言

本程序是参考实现，验签端可以用任何语言重写（RSA-SHA256 + SHA-256 + JSON，均为标准能力），
token 格式与注册表不变、跨语言互通。Java / Python 的验签骨架、身份注入机制
（`ContextVar` / 显式传参）与两个必踩的坑见 [docs/IDENTITY-PROTOCOL.md](../../docs/IDENTITY-PROTOCOL.md) 第 11 节。

## 测试

```bash
node --test apps/mcp-server/test/serve.test.mjs
```

覆盖：进程启动、签名 `whoami` / `add`、健康检查、无证明 401、伪造 Host 403、缺注册表退出码 2。
测试用的是 SDK 自己生成的临时身份，不依赖程序 1。
