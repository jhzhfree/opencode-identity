import path from "node:path";
import { readFile, realpath, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { newDirectory, newFile, writeJSON, readJSON } from "./files.mjs";
import {sdk,sdkInfo} from '../sdk.mjs';
import {LAB_DIR} from '../lab.mjs';
import {JSONC_DIR} from '../jsonc.mjs';
const {generateKeyPair,akbEndpoint}=await sdk();
import { validateKnowledgeBaseId } from "./client.mjs";
import { pluginFragment } from "./installer.mjs";
import { createZip } from "../zip.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// Shared vendor/ and packages/ live at the repository root, not inside the app.
const runtimeFiles = [
  "client.mjs",
  "files.mjs",
  "host.mjs",
  "plugin-v1.mjs",
  "plugin-v2.mjs",
  "generator.mjs",
  "installer.mjs",
  "cli.mjs",
  "checks.mjs",
];
const LAB_ROOT = LAB_DIR || path.join(ROOT, 'vendor/identity-lab');
const SDK_ROOT = sdkInfo().dir;
const sdkFiles = (await (await import('node:fs/promises')).readdir(path.join(SDK_ROOT,'src'))).filter(name=>name.endsWith('.mjs'));

export async function bundleEntries(directory) {
  const { readdir } = await import("node:fs/promises");
  const entries = [];
  async function walk(dir, prefix = "") {
    for (const f of await readdir(dir, { withFileTypes: true })) {
      if (["node_modules", ".git"].includes(f.name)) continue;
      const name = prefix + f.name;
      if (f.isDirectory()) await walk(path.join(dir, f.name), name + "/");
      else if (f.isFile())
        entries.push({ name, data: await readFile(path.join(dir, f.name)) });
    }
  }
  await walk(directory);
  return entries;
}
export async function generateAkbBundle({
  workspace,
  dataDir,
  agents,
  serverUrl,
  knowledgeBaseId = "",
  serviceKeyEnv = "AKB_SERVICE_KEY",
  opencodeMajor = "both",
  allowPrivateHttp = false,
}) {
  if (!path.isAbsolute(workspace || "") || !path.isAbsolute(dataDir || ""))
    throw new Error("Workspace and output directory must be absolute");
  if (
    !Array.isArray(agents) ||
    !agents.length ||
    agents.length > 100 ||
    new Set(agents).size !== agents.length ||
    agents.some(
      (a) => typeof a !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(a),
    )
  )
    throw new Error("Choose unique real OpenCode Agent names");
  if (!["1", "2", "both"].includes(String(opencodeMajor)))
    throw new Error("OpenCode 版本无效：请选择 1.x、2.x 或两者");
  if (typeof serviceKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(serviceKeyEnv))
    throw new Error("服务 Key 环境变量名无效：请填写 AKB_SERVICE_KEY 这样的变量名（大写字母、数字、下划线），不要填写服务 Key 本身、$ 前缀或赋值语句");
  if (typeof knowledgeBaseId !== "string" || knowledgeBaseId.length > 128)
    throw new Error("默认知识库 ID 无效（knowledgeBaseId）：请填写 KB_ 开头的内部 ID（最多 128 个字符），或留空");
  validateKnowledgeBaseId(knowledgeBaseId, { allowEmpty: true });
  const base = akbEndpoint(serverUrl, { allowPrivateHttp });
  const work = await realpath(workspace);
  await mkdir(path.dirname(dataDir), { recursive: true, mode: 0o700 });
  await newDirectory(dataDir, work);
  try {
    const records = [];
    await newDirectory(path.join(dataDir, "identities"), work);
    for (const [i, agentName] of agents.entries()) {
      const dir = path.join(dataDir, "identities", String(i + 1));
      await newDirectory(dir, work);
      const pair = await generateKeyPair(),
        uuid = randomUUID();
      await newFile(path.join(dir, "private.pem"), pair.privatePem);
      await writeJSON(path.join(dir, "public.jwk"), pair.publicJwk);
      await writeJSON(path.join(dir, "enrollment.json"), {
        name: agentName,
        agentId: uuid,
        publicJwk: pair.publicJwk,
      });
      records.push({
        agentName,
        uuid,
        kid: pair.kid,
        privateKeyFile: `identities/${i + 1}/private.pem`,
        publicKeyFile: `identities/${i + 1}/public.jwk`,
        enrollmentFile: `identities/${i + 1}/enrollment.json`,
      });
    }
    const configFile = path.join(dataDir, "akb-config.json");
    await writeJSON(configFile, {
      version: 1,
      target: "akb",
      serverUrl: base,
      workspaceRoot: work,
      serviceKeyEnv,
      knowledgeBaseId,
      timeoutMs: 10000,
      allowPrivateHttp,
      agents: records.map(({ agentName, uuid, privateKeyFile }) => ({
        agentName,
        uuid,
        privateKeyFile,
      })),
    });
    const bundleDir = path.join(dataDir, "plugin");
    await newDirectory(bundleDir, work);
    for (const dir of [
      "lib",
      "lib/akb",
      "packages",
      "packages/identity-sdk",
      "packages/identity-sdk/src",
      "vendor",
      "vendor/identity-lab",
      "vendor/identity-lab/lib",
      "bin",
      "public-enrollment",
    ])
      await newDirectory(path.join(bundleDir, dir), work);
    for (const f of runtimeFiles)
      await newFile(
        path.join(bundleDir, "lib/akb", f),
        f === 'client.mjs' ? "export * from '../../packages/identity-sdk/src/akb-client.mjs';\n" : f === 'files.mjs' ? "export * from '../../packages/identity-sdk/src/protected-files.mjs';\n" : await readFile(path.join(ROOT, "lib/akb", f)),
      );
    for (const f of sdkFiles)
      await newFile(
        path.join(bundleDir, "packages/identity-sdk/src", f),
        await readFile(path.join(SDK_ROOT, "src", f)),
      );
    for (const f of ["files.mjs", "protection.mjs", "sdk.mjs"])
      await newFile(
        path.join(bundleDir, "vendor/identity-lab/lib", f),
        await readFile(path.join(LAB_ROOT, "lib", f)),
      );
    for (const helper of ['sdk.mjs','lab.mjs']) await newFile(path.join(bundleDir,'lib',helper),await readFile(path.join(ROOT,'lib',helper)));
    await newFile(
      path.join(bundleDir, "lib/jsonc.mjs"),
      await readFile(path.join(ROOT, "lib/jsonc.mjs")),
    );
    async function copyTree(src, dst) {
      const { readdir } = await import("node:fs/promises");
      await newDirectory(dst, work);
      for (const item of await readdir(src, { withFileTypes: true })) {
        if (item.isDirectory())
          await copyTree(path.join(src, item.name), path.join(dst, item.name));
        else if (item.isFile())
          await newFile(
            path.join(dst, item.name),
            await readFile(path.join(src, item.name)),
          );
      }
    }
    await copyTree(
      JSONC_DIR,
      path.join(bundleDir, "vendor/jsonc-parser"),
    );
    await newFile(
      path.join(bundleDir, "vendor/identity-lab/LICENSE"),
      await readFile(path.join(LAB_ROOT, "LICENSE")),
    );
    await newFile(
      path.join(bundleDir, "THIRD_PARTY_LICENSES.txt"),
      await readFile(path.join(LAB_ROOT, "LICENSE")),
    );
    await newFile(
      path.join(bundleDir, "lib/zip.mjs"),
      await readFile(path.join(ROOT, "lib/zip.mjs")),
    );
    await newFile(
      path.join(bundleDir, "bin/akb-plugin.mjs"),
      "#!/usr/bin/env node\nimport '../lib/akb/cli.mjs';\n",
    );
    for (const file of ["package.json", "package-lock.json"])
      await newFile(
        path.join(bundleDir, file),
        await readFile(path.join(ROOT, "templates/akb-runtime", file)),
      );
    await newDirectory(path.join(bundleDir, "templates"), work);
    await copyTree(
      path.join(ROOT, "templates/akb-runtime"),
      path.join(bundleDir, "templates/akb-runtime"),
    );
    await writeJSON(path.join(bundleDir, "config-location.json"), {
      configFile: "../akb-config.json",
    });
    if (opencodeMajor !== "2")
      await newFile(
        path.join(bundleDir, "plugin-v1.mjs"),
        "import {createV1Plugin} from './lib/akb/plugin-v1.mjs';\nconst entry=(input)=>createV1Plugin(input,{root:new URL('./',import.meta.url)});entry.id='akb-agent-identity';entry.server=entry;export default entry;\n",
      );
    if (opencodeMajor !== "1") {
      await newDirectory(path.join(bundleDir, "opencode-v2"), work);
      await writeJSON(path.join(bundleDir, "opencode-v2/package.json"), {
        name: "local-akb-opencode-identity-v2",
        version: "1.2.0",
        type: "module",
        exports: { ".": "./index.js" },
      });
      await newFile(
        path.join(bundleDir, "opencode-v2/index.js"),
        "import {setupV2} from '../lib/akb/plugin-v2.mjs';\nexport default {id:'akb-agent-identity',setup:ctx=>setupV2(ctx,{root:new URL('../',import.meta.url)})};\n",
      );
    }
    for (const major of ["1", "2"])
      if (opencodeMajor === "both" || opencodeMajor === major)
        await writeJSON(
          path.join(bundleDir, `opencode.v${major}.fragment.json`),
          pluginFragment(bundleDir, major),
        );
    for (const [i, a] of records.entries()) {
      await writeJSON(
        path.join(bundleDir, "public-enrollment", `agent-${i + 1}.json`),
        await readJSON(path.join(dataDir, a.enrollmentFile)),
      );
      await writeJSON(
        path.join(bundleDir, "public-enrollment", `agent-${i + 1}-public.jwk`),
        await readJSON(path.join(dataDir, a.publicKeyFile)),
      );
    }
    await newFile(
      path.join(bundleDir, "install.ps1"),
      "\uFEFF" +
        `param([ValidateSet('1','2')][string]$Major,[string]$OpenCodeConfig,[string]$Config)
$ErrorActionPreference='Stop'
if (-not $Major -or -not $OpenCodeConfig) { throw 'Specify -Major 1 or 2 and -OpenCodeConfig (global opencode.json path)' }
$argsList=@((Join-Path $PSScriptRoot 'bin/akb-plugin.mjs'),'install','--bundle',$PSScriptRoot,'--major',$Major,'--opencode-config',$OpenCodeConfig)
if ($Config) { $argsList+=@('--config',$Config) }
& node @argsList
exit $LASTEXITCODE
`,
    );
    await newFile(
      path.join(bundleDir, "verify.ps1"),
      "\uFEFF" +
        `param([Parameter(Mandatory=$true)][string]$Agent)
$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'bin/akb-plugin.mjs') verify --bundle $PSScriptRoot --agent $Agent
exit $LASTEXITCODE
`,
    );
    const guide = `# AKB MCP 插件安装

1. 在 AKB 的 Agent 凭证详情登记每个 Agent。UUID 取 public-enrollment/agent-N.json 的 agentId，公钥单独导入 agent-N-public.jwk。不同 OpenCode Agent 使用不同 UUID 和密钥。
2. 在启动 Studio 和 OpenCode 的进程环境设置 ${serviceKeyEnv}；不要把服务 Key 写入 opencode.json 或工具参数。服务 Key 至少需要 LIST、SEARCH，使用问答时还需要 QUERY。
3. 在本目录验证：node bin/akb-plugin.mjs verify --agent ${agents[0]}。Windows 可运行 ./verify.ps1 -Agent ${agents[0]}。移动插件目录后用 --config 指定原受保护 akb-config.json 的绝对路径。
4. 安装：node bin/akb-plugin.mjs install --bundle . --major 1 --opencode-config <全局opencode.json绝对路径>；OpenCode 2.x 改为 --major 2。Windows 可运行 ./install.ps1 -Major 2 -OpenCodeConfig <路径>。JSON/JSONC 设置与注释会保留，原文件另存备份。重启 OpenCode。
5. 切换到已绑定 Agent，调用 akb_bases / akb_search / akb_query / akb_identity。Agent 身份来自宿主执行上下文，不接受模型参数指定身份。

插件包包含完整运行时，不引用 Studio 源目录。1.x 安装器安装固定依赖并禁用安装脚本；2.x 使用宿主原生 API。缺少审批 API 的早期版本拒绝执行，不提供生产模式的 legacyReadOnly 绕过。

ZIP 不包含私钥和服务 Key。本机 config-location.json 默认引用受保护的同级 akb-config.json；换电脑须单独安全迁移配置与密钥并用 --config 绑定，或生成新身份后在 AKB 登记。ZIP 本身不是身份迁移包。

默认 HTTPS；仅本机 HTTP 或显式允许的内网 IP HTTP 例外。网关重写公开路径时，AKB 需配置 knowledge.external.public-path-prefix。每次调用分别初始化 MCP 并签名业务请求，均计入服务配额；不共享 Agent 会话、不自动重试或降级认证。
`;
    await newFile(path.join(bundleDir, "SETUP.md"), guide);
    const zip = createZip(await bundleEntries(bundleDir));
    await newFile(path.join(dataDir, "akb-plugin.zip"), zip);
    return {
      target: "akb",
      dataDir,
      workspace: work,
      serverUrl: base,
      configFile,
      bundleDir,
      opencodeMajor,
      agents: records.map(({ privateKeyFile, ...a }) => a),
      zipFile: path.join(dataDir, "akb-plugin.zip"),
      zipSize: zip.length,
    };
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}
