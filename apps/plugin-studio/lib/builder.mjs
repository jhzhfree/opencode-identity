/** Orchestrates identity generation, config writing, plugin generation and packaging. */
import path from 'node:path';
import { readFile, readdir, stat, realpath, mkdir, writeFile } from 'node:fs/promises';
import { lab, labInfo, LAB_DIR } from './lab.mjs';
import { sdk, sdkInfo } from './sdk.mjs';
import { MCP_BIN } from './mcp-bin.mjs';
import { buildGuide } from './guide.mjs';
import { createZip } from './zip.mjs';

const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;

/** Runtime modules the vendored plugin templates import by relative path. */
const RUNTIME_MODULES = ['client.mjs', 'files.mjs', 'protection.mjs', 'proof.mjs', 'opencode-compat.mjs', 'server.mjs'];

/**
 * Make the generated plugin self-contained.
 *
 * The upstream generator writes an absolute `file:///…/vendor/identity-lab/…`
 * import, so a downloaded package broke as soon as it left this machine. Copy the
 * runtime next to the plugin and rewrite the import to a relative specifier.
 */
export async function localizePlugin(entries, opencodeMajor) {
  if (!LAB_DIR) return;
  const rewrite = async (target, fileName) => {
    const text = await readFile(target, 'utf8');
    const next = text.replace(/from "file:[^"]*?(opencode-plugin(?:-v2)?\.mjs)"/g, 'from "./runtime/$1"');
    if (next !== text) await writeFile(target, next, 'utf8');
    return fileName;
  };
  if (entries.v1 && opencodeMajor !== '2') {
    const runtime = path.join(path.dirname(entries.v1), 'runtime');
    await mkdir(runtime, { recursive: true });
    for (const name of [...RUNTIME_MODULES, 'opencode-plugin.mjs']) {
      await writeFile(path.join(runtime, name), await readFile(path.join(LAB_DIR, 'lib', name)));
    }
    await rewrite(entries.v1);
  }
  if (entries.v2 && opencodeMajor !== '1') {
    const runtime = path.join(entries.v2, 'runtime');
    await mkdir(runtime, { recursive: true });
    for (const name of [...RUNTIME_MODULES, 'opencode-plugin-v2.mjs']) {
      await writeFile(path.join(runtime, name), await readFile(path.join(LAB_DIR, 'lib', name)));
    }
    await rewrite(path.join(entries.v2, 'index.js'));
  }
}

async function walk(dir, prefix, out, skip = new Set(['node_modules', 'test', '.git'])) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await walk(full, name, out, skip);
    else if (entry.isFile()) out.push({ name, data: await readFile(full) });
  }
  return out;
}

async function fileEntries(files) {
  const out = [];
  for (const [name, file] of files) {
    if (!file) continue;
    const data = await readFile(file).catch(() => null);
    if (data) out.push({ name, data });
  }
  return out;
}

/** (Re)build the downloadable ZIP from files already on disk. */
export async function packageZip(result) {
  const mcpRoot = MCP_BIN ? path.resolve(path.dirname(MCP_BIN), '..') : null;
  const entries = [{ name: 'SETUP.md', data: await readFile(path.join(result.dataDir, 'SETUP.md')) }];
  entries.push(...await fileEntries([
    ['identity/registry.json', path.join(result.dataDir, 'registry.json')],
    ['identity/terminal-config.json', path.join(result.dataDir, 'terminal-config.json')],
    ['start-server.ps1', path.join(result.dataDir, 'start-server.ps1')],
    ['verify.ps1', path.join(result.dataDir, 'verify.ps1')],
    // The MCP server ships inside the download, so the package runs without the
    // generator or the upstream lab directory. Both programs read the same SDK.
    // context.mjs is mandatory: server.mjs imports it for runWithIdentity().
    ['server/bin/serve.mjs', mcpRoot ? path.join(mcpRoot, 'bin', 'serve.mjs') : null],
    ['server/lib/server.mjs', mcpRoot ? path.join(mcpRoot, 'lib', 'server.mjs') : null],
    ['server/lib/context.mjs', mcpRoot ? path.join(mcpRoot, 'lib', 'context.mjs') : null],
    ['server/lib/sdk.mjs', mcpRoot ? path.join(mcpRoot, 'lib', 'sdk.mjs') : null],
    // Reference implementation for --tools; start-server.ps1 mounts it when present.
    ['server/examples/business-tools.mjs', mcpRoot ? path.join(mcpRoot, 'examples', 'business-tools.mjs') : null],
  ]));
  const sdkDir = sdkInfo().dir;
  if (sdkDir) entries.push(...await walk(sdkDir, 'server/packages/identity-sdk', []));
  for (const [i, record] of result.agents.entries()) {
    entries.push(...await fileEntries([
      [`identity/agent-${i + 1}/identity.json`, path.join(record.dir, 'identity.json')],
      [`identity/agent-${i + 1}/public.jwk`, path.join(record.dir, 'public.jwk')],
      [`identity/agent-${i + 1}/enrollment.json`, path.join(record.dir, 'enrollment.json')],
      ...(result.includePrivateKeys ? [[`identity/agent-${i + 1}/private.pem`, path.join(record.dir, 'private.pem')]] : []),
    ]));
  }
  entries.push(...await walk(result.pluginDir, 'plugin', []));
  return createZip(entries);
}

export async function runBuild(job, params) {
  const { generatePlugin } = await lab('generator.mjs');
  const files = await lab('files.mjs');
  const { newDirectory, writeJSON, newFile, readJSON } = files;
  const S = await sdk();
  const { createAgentIdentity, validateRegistry, assertLocalEndpoint } = S;

  const { workspace, dataDir, agents, port, opencodeMajor, legacyReadOnly, includePrivateKeys } = params;

  job.plan([
    '校验工作区与输出目录',
    '创建受保护数据目录',
    '调用 SDK 生成 UUID 与 RSA-3072 密钥对',
    '用私钥签发 Agent 身份证明并写入注册表',
    '写入终端配置 terminal-config.json',
    '生成 OpenCode 插件',
    '生成启动脚本与部署文档',
    '打包 ZIP',
  ]);

  let created = false;
  try {
    const info = await job.step('校验工作区与输出目录', async () => {
      const ws = await stat(workspace).catch(() => null);
      if (!ws?.isDirectory()) throw new Error(`工作区不存在或不是目录：${workspace}`);
      const realWorkspace = await realpath(workspace);
      if (path.resolve(dataDir).toLowerCase().startsWith(realWorkspace.toLowerCase())) {
        throw new Error('身份数据目录不能位于 Agent 工作区内');
      }
      const exists = await stat(dataDir).catch(() => null);
      if (exists) throw new Error('输出目录已存在，请换一个新目录（不会覆盖已有私钥）');
      return { workspace: realWorkspace, dataDir };
    });

    await job.step('创建受保护数据目录', async () => {
      await newDirectory(dataDir, info.workspace);
      created = true;
    });

    const records = [];
    const enrollments = [];
    await job.step('调用 SDK 生成 UUID 与 RSA-3072 密钥对', async step => {
      for (const [i, agentName] of agents.entries()) {
        const dir = path.join(dataDir, `agent-${i + 1}`);
        step.detail = `${agentName}（${i + 1}/${agents.length}）正在生成 RSA-3072…`;
        await newDirectory(dir, info.workspace);
        // Key pair + UUID + attestation all come from the SDK, so the generator
        // and the MCP server cannot drift apart on the signing rules.
        const identity = await createAgentIdentity({ agentName });
        await newFile(path.join(dir, 'private.pem'), identity.privatePem);
        await writeJSON(path.join(dir, 'public.jwk'), identity.publicJwk);
        await writeJSON(path.join(dir, 'identity.json'), identity.files['identity.json']);
        await writeJSON(path.join(dir, 'enrollment.json'), identity.enrollment);
        records.push({
          agentName,
          uuid: identity.uuid,
          kid: identity.kid,
          privateKeyFile: path.join(dir, 'private.pem'),
          dir,
          attestation: identity.attestation.token,
        });
        enrollments.push(identity.enrollment);
        step.detail = `${agentName} ✓ ${identity.uuid.slice(0, 8)}… kid ${identity.kid.slice(0, 10)}…`;
      }
    });

    const registryFile = path.join(dataDir, 'registry.json');
    await job.step('用私钥签发 Agent 身份证明并写入注册表', async () => {
      // requireAttestation: every row must carry a signature over {agentName, uuid}.
      const registry = validateRegistry({ version: 1, agents: enrollments }, { requireAttestation: true });
      await writeJSON(registryFile, registry);
    });

    const configFile = path.join(dataDir, 'terminal-config.json');
    const serverUrl = assertLocalEndpoint(`http://127.0.0.1:${port}/mcp`);
    const config = {
      version: 1,
      serverUrl,
      workspaceRoot: info.workspace,
      legacyReadOnly,
      agents: records.map(r => ({ agentName: r.agentName, uuid: r.uuid, privateKeyFile: r.privateKeyFile })),
    };
    await job.step('写入终端配置 terminal-config.json', async () => {
      await writeJSON(configFile, config);
    });

    const pluginDir = path.join(dataDir, 'plugin');
    const generated = await job.step('生成 OpenCode 插件', async () => {
      const result = await generatePlugin(configFile, pluginDir, { opencodeMajor });
      await localizePlugin(result.entries, opencodeMajor);
      return result;
    });

    const serverBin = MCP_BIN;
    const sdkCli = path.join(sdkInfo().dir ?? '', 'bin', 'sdk.mjs');
    const startScript = path.join(dataDir, 'start-server.ps1');
    const verifyScript = path.join(dataDir, 'verify.ps1');
    const guideFile = path.join(dataDir, 'SETUP.md');
    await job.step('生成启动脚本与部署文档', async () => {
      // UTF-8 BOM: Windows PowerShell 5.1 otherwise decodes these files as ANSI and
      // can swallow the newline after a non-ASCII comment.
      const BOM = '\uFEFF';
      await newFile(startScript, BOM + [
        '# MCP 身份服务端（SDK 验签）· 由 OpenCode Identity Studio 生成',
        "$ErrorActionPreference = 'Stop'",
        `$registry = ${psQuote(registryFile)}`,
        `$server = ${psQuote(serverBin)}`,
        // Business tools: the ZIP layout bundles examples/business-tools.mjs next
        // to the server; a git checkout keeps them in apps/mcp-server/examples.
        `$tools = Join-Path (Split-Path $server -Parent) 'examples\\business-tools.mjs'`,
        "if (-not (Test-Path $tools)) { $tools = Join-Path $PSScriptRoot 'server\\examples\\business-tools.mjs' }",
        "if (-not (Test-Path $registry)) { $registry = Join-Path $PSScriptRoot 'identity\\registry.json' }",
        "if (-not (Test-Path $server)) { $server = Join-Path $PSScriptRoot 'server\\bin\\serve.mjs' }",
        `if (Test-Path $tools) { & node $server --registry $registry --port ${port} --tools $tools }`,
        `else { & node $server --registry $registry --port ${port} }`,
        'exit $LASTEXITCODE',
        '',
      ].join('\n'));
      await newFile(verifyScript, BOM + [
        '# 用 SDK 向运行中的服务端发起签名请求并核对身份',
        `$sdk = ${psQuote(sdkCli)}`,
        "if (-not $sdk -or -not (Test-Path $sdk)) { $sdk = Join-Path $PSScriptRoot 'server\\packages\\identity-sdk\\bin\\sdk.mjs' }",
        ...records.map(r => `& node $sdk verify-agent --config ${psQuote(configFile)} --agent ${psQuote(r.agentName)}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`),
        '',
      ].join('\n'));
      const guide = buildGuide({
        workspace: info.workspace,
        dataDir,
        port,
        serverUrl,
        agents: records,
        entries: generated.entries,
        fragments: generated.fragments,
        opencodeMajor,
        legacyReadOnly,
        labBin: labInfo().bin,
        serverBin,
        sdkCli,
        sdkDir: sdkInfo().dir,
        opencodeVersion: params.opencodeVersion ?? null,
      });
      await newFile(guideFile, guide);
    });

    const fragments = {};
    for (const [key, file] of Object.entries(generated.fragments)) {
      fragments[key] = { file, content: JSON.parse(await readFile(file, 'utf8')) };
    }

    const zip = await job.step('打包 ZIP', async () => packageZip({
      dataDir,
      agents: records,
      pluginDir,
      includePrivateKeys,
    }));

    return {
      dataDir,
      workspace: info.workspace,
      serverUrl,
      port,
      registryFile,
      configFile,
      pluginDir,
      fragments,
      entries: generated.entries,
      agents: records.map(({ agentName, uuid, kid, dir }) => ({ agentName, uuid, kid, dir })),
      legacyReadOnly,
      opencodeMajor,
      opencodeVersion: params.opencodeVersion ?? null,
      includePrivateKeys,
      zipSize: zip.length,
      zip,
    };
  } catch (error) {
    if (created) {
      const { rm } = await import('node:fs/promises');
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}
