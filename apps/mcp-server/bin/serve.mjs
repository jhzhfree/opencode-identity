#!/usr/bin/env node
/**
 * MCP identity server — program #3 of this repository.
 *
 *   node bin/serve.mjs --registry <registry.json> [--port 8781]
 *                      [--allow-missing-attestation] [--quiet]
 *
 * Everything cryptographic comes from @opencode-identity/sdk (program #2), so the
 * verification rules are identical to what the plugin generator and the CLI use.
 *
 * Binds 127.0.0.1 only. Each accepted request emits one JSON audit line on stdout,
 * which makes the process easy to supervise from another program or a shell.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { createIdentityServer } from '../lib/server.mjs';
import { sdkInfo } from '../lib/sdk.mjs';

const USAGE = `identity-mcp-server — 用 SDK 验签的 MCP 身份服务端

用法:
  node bin/serve.mjs --registry <registry.json> [选项]

必填:
  --registry <file>               由插件生成工具 / SDK 产出的 registry.json

可选:
  --port <n>                      监听端口，默认 8781（只绑定 127.0.0.1）
  --allow-missing-attestation     允许注册表中缺少身份证明（仅供旧数据排障）
  --quiet                         不输出每条请求的 JSON 审计行
  -h, --help                      显示本帮助
  -V, --version                   显示版本与 SDK 位置

示例:
  node bin/serve.mjs --registry C:/Users/me/mcp-identity/run-1/registry.json --port 8781
  curl http://127.0.0.1:8781/health

说明:
  客户端必须带 X-Agent-Proof 请求头；身份由服务端用注册表公钥验出，
  token 内容、Host/Origin、30 秒有效期与重放都会被校验。
`;

const { values } = parseArgs({
  options: {
    registry: { type: 'string' },
    port: { type: 'string', default: '8781' },
    'allow-missing-attestation': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    version: { type: 'boolean', short: 'V', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help || (!values.registry && !values.version)) {
  process.stderr.write(USAGE);
  process.exit(values.help ? 0 : 2);
}

if (values.version) {
  const sdk = sdkInfo();
  process.stdout.write(`${JSON.stringify({
    program: 'identity-mcp-server',
    version: '1.2.0',
    node: process.version,
    sdk: sdk.found ? sdk.dir : null,
  }, null, 2)}\n`);
  process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write('invalid --port\n');
  process.exit(2);
}

const registryFile = path.resolve(/** @type {string} */ (values.registry));
if (!existsSync(registryFile)) {
  process.stderr.write(`[startup] 注册表不存在：${registryFile}\n`);
  process.exit(2);
}

const audit = values.quiet ? () => {} : event => process.stdout.write(`${JSON.stringify(event)}\n`);

const server = await createIdentityServer({
  registryFile,
  requireAttestation: !values['allow-missing-attestation'],
  audit,
});

try {
  const url = await server.start(port);
  process.stderr.write(`[ready] ${url}  registry=${registryFile}  agents=${server.registry?.agents.length ?? 0}\n`);
} catch (error) {
  const code = /** @type {any} */ (error).code ? `${/** @type {any} */ (error).code}: ` : '';
  process.stderr.write(`[startup] ${code}${/** @type {Error} */ (error).message}\n`);
  process.exit(1);
}

const shutdown = async () => {
  await server.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
