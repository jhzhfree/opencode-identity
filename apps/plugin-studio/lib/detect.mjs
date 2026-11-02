/**
 * Detect the locally installed OpenCode CLI and enumerate real Agents.
 * Strategy: CLI first (`--version`, `agent list`), then config-file fallback,
 * then the two built-in Agent names. Never invents Agent names.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const exec = promisify(execFile);
const TIMEOUT = 15000;

/**
 * Parse `opencode --version` output (also tolerates `opencode 1.4.3` and build
 * metadata). Kept here so the app has no dependency outside this repository.
 */
export function parseOpenCodeVersion(output) {
  const match = typeof output === 'string' && output.match(/(?:^|\s)(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?(?=\s|$)/i);
  if (!match) throw new Error('Cannot parse OpenCode version');
  const major = Number(match[1]);
  return {
    version: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`,
    major,
    supported: [1, 2].includes(major),
    profile: major === 1 ? 'v1' : major === 2 ? 'v2' : null,
  };
}

function stripAnsi(s) {
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export {parseJsonc} from './jsonc.mjs';
import {parseJsonc} from './jsonc.mjs';

async function runCli(exe, args, cwd) {
  const isScript = /\.(cmd|bat)$/i.test(exe);
  const options = { cwd, timeout: TIMEOUT, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' };
  if (process.platform === 'win32' && isScript) {
    return exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${exe}" ${args.map(a => `"${a}"`).join(' ')}`], options);
  }
  return exec(exe, args, options);
}

/**
 * Every place an OpenCode host is known to ship a CLI, most specific first.
 * The desktop build keeps its CLI next to the Electron resources
 * (`…/ai.opencode.desktop/resources/opencode-cli.exe`), so a host installed that
 * way is invisible to a bare PATH lookup.
 */
export function installRoots() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  if (process.platform === 'win32') {
    return [
      path.join(home, '.opencode', 'bin'),
      path.join(localAppData, 'opencode'),
      path.join(localAppData, 'Programs', 'ai.opencode.desktop', 'resources'),
      path.join(localAppData, 'Programs', 'opencode', 'resources'),
      path.join(programFiles, 'OpenCode', 'resources'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/OpenCode.app/Contents/Resources',
      path.join(home, 'Applications', 'OpenCode.app', 'Contents', 'Resources'),
      path.join(home, '.opencode', 'bin'),
    ];
  }
  return [path.join(home, '.opencode', 'bin'), '/usr/lib/opencode', '/opt/OpenCode/resources'];
}

function candidates() {
  const list = [];
  if (process.env.OPENCODE_BIN) list.push(process.env.OPENCODE_BIN);
  const home = os.homedir();
  if (process.platform === 'win32') {
    list.push('opencode.exe', 'opencode');
    for (const dir of installRoots()) {
      list.push(path.join(dir, 'opencode-cli.exe'));
      list.push(path.join(dir, 'opencode.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('opencode', '/usr/local/bin/opencode', '/opt/homebrew/bin/opencode');
    for (const dir of installRoots()) list.push(path.join(dir, 'opencode-cli'));
    list.push(path.join(home, '.local', 'bin', 'opencode'), path.join(home, '.opencode', 'bin', 'opencode'));
  } else {
    list.push('opencode', '/usr/local/bin/opencode', '/usr/bin/opencode');
    for (const dir of installRoots()) list.push(path.join(dir, 'opencode-cli'));
    list.push(path.join(home, '.local', 'bin', 'opencode'), path.join(home, '.opencode', 'bin', 'opencode'));
  }
  // Drop absolute paths that do not exist, so the reported error is meaningful.
  const seen = new Set();
  return list.filter(exe => {
    if (seen.has(exe)) return false;
    seen.add(exe);
    return !path.isAbsolute(exe) || existsSync(exe);
  });
}

/** Versions shipped next to a bundled CLI, used when the binary cannot be spawned. */
async function bundledVersion(exe) {
  if (!path.isAbsolute(exe)) return null;
  const text = await readIfFile(path.join(path.dirname(exe), 'opencode-cli.version'));
  return text?.trim() || null;
}

/**
 * `--help` output is a valid exit-0 response, so a removed subcommand (OpenCode 2
 * dropped `agent list`) otherwise parses into fake Agents like "DESCRIPTION".
 */
export function looksLikeHelp(text) {
  return /^\s*(DESCRIPTION|USAGE|ARGUMENTS|FLAGS|GLOBAL FLAGS|SUBCOMMANDS)\s*$/m.test(text)
    || /^\s*OpenCode command line interface\s*$/m.test(text);
}

/** Pull Agent names out of `opencode debug agents` (JSON) or `agent list` (JSON/table). */
export function parseAgentList(stdout) {
  const text = stripAnsi(stdout || '').trim();
  if (!text || looksLikeHelp(text)) return [];
  try {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : parsed?.agents ?? parsed?.data ?? [];
    if (Array.isArray(rows)) {
      return rows
        // 2.x returns both `id` and a display `name` ("build" / "Build"); the
        // plugin only ever sees the id, so prefer it.
        .map(r => (typeof r === 'string' ? r : r?.id ?? r?.name ?? r?.agent))
        .filter(n => typeof n === 'string');
    }
  } catch { /* table output */ }
  const names = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(name|agent|agents|id)\b/i.test(line)) continue;
    if (/^[-=─┌└│|+]/.test(line)) continue;
    const m = line.match(/^[*\-\s]*([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})(?:\s{2,}|\t|\s*[-–:]\s*|$)/);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * 2.x lists Agents with `debug agents`; 1.x uses `agent list`. Try the command
 * that matches the detected major first and ignore help output from the other.
 */
async function listAgents(exe, major, workspace) {
  const attempts = major >= 2
    ? [['debug', 'agents'], ['agent', 'list']]
    : [['agent', 'list'], ['debug', 'agents']];
  let lastError = null;
  for (const args of attempts) {
    try {
      const { stdout } = await runCli(exe, args, workspace);
      const names = parseAgentList(stdout);
      if (names.length) return { names, command: `opencode ${args.join(' ')}` };
    } catch (e) {
      lastError = e;
    }
  }
  return { names: [], command: null, error: lastError };
}

async function readIfFile(file) {
  try {
    const s = await stat(file);
    if (!s.isFile()) return null;
    if (s.size > 2 * 1024 * 1024) return null;
    return await readFile(file, 'utf8');
  } catch { return null; }
}

function agentsFromConfig(value, file) {
  const found = [];
  const collect = obj => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of ['agent', 'agents']) {
      const block = obj[key];
      if (block && typeof block === 'object' && !Array.isArray(block)) {
        for (const name of Object.keys(block)) found.push({ name, source: `${file}#${key}`, description: block[name]?.description ?? '' });
      }
    }
  };
  collect(value);
  return found;
}

export async function detectOpenCode({ workspace } = {}) {
  const result = {
    platform: process.platform,
    cli: { found: false, path: null, version: null, major: null, supported: false, profile: null, error: null },
    agents: [],
    configFiles: [],
    warnings: [],
    checkedAt: new Date().toISOString(),
  };

  let cliError = null;
  for (const exe of candidates()) {
    let parsed = null;
    try {
      const { stdout } = await runCli(exe, ['--version'], workspace);
      parsed = parseOpenCodeVersion(stripAnsi(stdout).trim());
    } catch (e) {
      cliError = String(e.message).split('\n')[0];
      // A desktop install keeps the version next to the binary; trust it when the
      // binary itself cannot be spawned (sandbox, missing runtime, locked file).
      const bundled = await bundledVersion(exe);
      if (bundled) {
        try { parsed = parseOpenCodeVersion(bundled); } catch { parsed = null; }
      }
    }
    if (!parsed) continue;
    result.cli = { found: true, path: exe, version: parsed.version, major: parsed.major, supported: parsed.supported, profile: parsed.profile, error: null, source: 'cli' };
    const listed = await listAgents(exe, parsed.major, workspace);
    for (const name of listed.names) result.agents.push({ name, source: listed.command });
    if (!listed.names.length) {
      result.warnings.push(parsed.major >= 2
        ? 'CLI 已找到，但 `opencode debug agents` 未返回 Agent，改用配置文件扫描。'
        : 'CLI 已找到，但 `opencode agent list` 未返回 Agent，改用配置文件扫描。');
    }
    break;
  }
  // Explicit override wins, so a stale config directory cannot pin the major.
  const overrideVersion = (process.env.OPENCODE_VERSION || '').trim();
  if (overrideVersion) {
    try {
      const parsed = parseOpenCodeVersion(overrideVersion);
      result.cli = { ...result.cli, found: true, version: parsed.version, major: parsed.major, supported: parsed.supported, profile: parsed.profile, error: null, source: 'env:OPENCODE_VERSION' };
    } catch {
      result.warnings.push(`OPENCODE_VERSION=${overrideVersion} 不是合法版本号，已忽略。`);
    }
  }
  if (!result.cli.found) {
    result.cli.error = 'opencode 未安装或不在 PATH / 桌面版安装目录中（可用 OPENCODE_BIN 指定可执行文件路径）';
    if (cliError && !/ENOENT/.test(cliError)) result.warnings.push(`CLI 探测失败：${cliError}`);
  }
  if (result.cli.found && !result.cli.supported) {
    result.warnings.push(`检测到 OpenCode ${result.cli.version}，本项目只支持 1.x / 2.x 插件 API。`);
  }

  // Config-file fallback (also enriches descriptions when CLI worked).
  const home = os.homedir();
  const files = [
    path.join(home, '.config', 'opencode', 'opencode.json'),
    path.join(home, '.config', 'opencode', 'opencode.jsonc'),
    path.join(home, '.config', 'opencode', 'config.json'),
  ];
  if (workspace) {
    files.push(
      path.join(workspace, 'opencode.json'),
      path.join(workspace, 'opencode.jsonc'),
      path.join(workspace, '.opencode', 'opencode.json'),
      path.join(workspace, '.opencode', 'opencode.jsonc'),
    );
  }
  for (const file of files) {
    const text = await readIfFile(file);
    if (!text) continue;
    try {
      const value = parseJsonc(text);
      const found = agentsFromConfig(value, path.basename(file));
      for (const agent of found) result.agents.push({ ...agent, source: file });
      result.configFiles.push({ file, agents: found.map(a => a.name) });
    } catch (e) {
      result.warnings.push(`${file} 解析失败：${e.message}`);
    }
  }

  // Markdown agent definitions.
  const mdDirs = [path.join(home, '.config', 'opencode', 'agent')];
  if (workspace) mdDirs.push(path.join(workspace, '.opencode', 'agent'));
  for (const dir of mdDirs) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names.filter(n => /\.md$/i.test(n))) {
      const agentName = name.replace(/\.md$/i, '');
      const body = await readIfFile(path.join(dir, name));
      const description = (body?.match(/^description:\s*(.+)$/m)?.[1] ?? '').trim();
      result.agents.push({ name: agentName, source: path.join(dir, name), description });
    }
  }

  // Host hints from the OpenCode config directory (works even without the CLI on PATH).
  const configDir = path.join(home, '.config', 'opencode');
  const host = {
    configDir, exists: existsSync(configDir),
    sdk: null, declaredSdk: null, installedSdk: null,
    major: null, version: null, source: null,
    pluginsDir: null, installedPlugins: [], suggestedMajor: null,
  };

  // What is actually on disk beats what package.json claims: a config directory
  // can still declare 1.x long after the host moved to 2.x.
  for (const [pkgName, pkgMajor] of [['@opencode/plugin', 2], ['@opencode-ai/plugin', 1]]) {
    const text = await readIfFile(path.join(configDir, 'node_modules', pkgName, 'package.json'));
    if (!text) continue;
    try {
      const pkg = JSON.parse(text);
      host.installedSdk = { package: pkg.name ?? pkgName, version: pkg.version ?? null, major: pkgMajor, source: 'node_modules' };
      break;
    } catch { /* ignore */ }
  }

  const pkgText = await readIfFile(path.join(configDir, 'package.json'));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const v2 = deps['@opencode/plugin'];
      const v1 = deps['@opencode-ai/plugin'];
      if (v2) host.declaredSdk = { package: '@opencode/plugin', version: v2, major: 2, source: 'package.json' };
      else if (v1) host.declaredSdk = { package: '@opencode-ai/plugin', version: v1, major: 1, source: 'package.json' };
    } catch (e) {
      result.warnings.push(`读取 ${configDir}\\package.json 失败：${e.message}`);
    }
  }

  // Precedence: running CLI > installed package > declared dependency.
  // The CLI wins, and host.sdk is then re-pointed at the SDK that matches the
  // running major, so the UI never shows "1.3.17 → 宿主 2.x".
  const SDK_NAME = { 1: '@opencode-ai/plugin', 2: '@opencode/plugin' };
  if (result.cli.found && result.cli.supported) {
    host.version = result.cli.version;
    host.major = result.cli.major;
    host.source = result.cli.source === 'cli' ? 'cli' : result.cli.source;
    host.sdk = [host.installedSdk, host.declaredSdk].find(s => s && s.major === host.major)
      ?? { package: SDK_NAME[host.major], version: null, major: host.major, source: 'cli' };
  } else if (host.installedSdk) {
    host.version = host.installedSdk.version;
    host.major = host.installedSdk.major;
    host.source = 'node_modules';
    host.sdk = host.installedSdk;
  } else if (host.declaredSdk) {
    host.version = host.declaredSdk.version;
    host.major = host.declaredSdk.major;
    host.source = 'package.json';
    host.sdk = host.declaredSdk;
  }
  host.suggestedMajor = host.major ? String(host.major) : null;

  const pluginDir = path.join(configDir, 'plugin');
  if (existsSync(pluginDir)) {
    host.pluginsDir = pluginDir;
    try {
      host.installedPlugins = (await readdir(pluginDir)).filter(n => /\.(mjs|cjs|js|ts)$/i.test(n));
    } catch { /* ignore */ }
  }
  result.host = host;
  if (host.source === 'cli') {
    result.warnings.push(`宿主以 opencode ${host.version} 为准（CLI 实测），将生成 ${host.major}.x 插件。`);
  } else if (host.source === 'node_modules') {
    result.warnings.push(`未找到 opencode CLI，按配置目录已安装的 ${host.sdk?.package}@${host.version} 推断宿主为 ${host.major}.x。`);
  } else if (host.source === 'package.json') {
    result.warnings.push(`未找到 CLI 与已安装 SDK，只能按 ${configDir}\\package.json 声明的 ${host.sdk?.package}@${host.version} 推断宿主为 ${host.major}.x。`);
  } else if (host.exists) {
    result.warnings.push(`已找到 ${configDir}，但未发现插件 SDK 依赖，无法推断宿主主版本。`);
  }
  // A stale declaration is the usual reason a generated plugin silently targets
  // the wrong API, so call the mismatch out explicitly.
  if (host.declaredSdk && host.major && host.declaredSdk.major !== host.major) {
    result.warnings.push(`配置目录声明的是 ${host.declaredSdk.package}@${host.declaredSdk.version}（${host.declaredSdk.major}.x），与实测宿主 ${host.version}（${host.major}.x）不一致，已按实测宿主生成。`);
  }
  if (host.installedSdk && host.declaredSdk && host.installedSdk.version !== host.declaredSdk.version) {
    result.warnings.push(`配置目录声明 ${host.declaredSdk.version}，实际安装 ${host.installedSdk.version}，两者不一致，已按实际安装版本处理。`);
  }
  if (host.installedPlugins.length) {
    result.warnings.push(`检测到 ${host.installedPlugins.length} 个已有插件（${host.configDir}\\plugin）。合并配置时请保留它们，只追加本次片段。`);
  }

  // De-duplicate, keeping the first (most specific) source.
  const seen = new Map();
  for (const agent of result.agents) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(agent.name)) continue;
    if (!seen.has(agent.name)) seen.set(agent.name, agent);
  }
  result.agents = [...seen.values()];

  if (!result.agents.length) {
    result.agents = [
      { name: 'build', source: 'builtin 默认值（未在本机发现配置）', description: 'OpenCode 内置构建 Agent' },
      { name: 'plan', source: 'builtin 默认值（未在本机发现配置）', description: 'OpenCode 内置只读规划 Agent' },
    ];
    result.warnings.push('未检测到 opencode CLI 或 Agent 配置，已填入内置默认 Agent 名称，请按实际情况修改。');
  }
  if (!result.cli.found) {
    result.warnings.push('未找到 opencode 可执行文件。生成与验证不受影响，但 `doctor` 与真实宿主联调需要先安装 OpenCode CLI。');
  }
  return result;
}
