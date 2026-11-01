import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseAgentList, looksLikeHelp, installRoots, detectOpenCode } from '../lib/detect.mjs';

// OpenCode 2.2.5 dropped `agent list`; the CLI answers a removed subcommand with
// its help text and exit code 0. Parsing that used to invent Agents named after
// the section headings.
const HELP = `
DESCRIPTION
  OpenCode command line interface

USAGE
  opencode <subcommand> [flags] [<directory>]

ARGUMENTS
  directory string    Directory to start OpenCode in (optional)

SUBCOMMANDS
  upgrade, update    Upgrade OpenCode to the latest or a specific version
`;

test('帮助文本不会被误解析成 Agent', () => {
  assert.equal(looksLikeHelp(HELP), true);
  assert.deepEqual(parseAgentList(HELP), []);
  assert.deepEqual(parseAgentList(''), []);
});

test('2.2.5 的 debug agents 输出优先取 id 而不是展示名', () => {
  const json = JSON.stringify([
    { id: 'build', name: 'Build', description: 'default', mode: 'primary' },
    { id: 'plan', name: 'Plan', description: 'read only', mode: 'primary' },
  ]);
  assert.deepEqual(parseAgentList(json).slice(0, 2), ['build', 'plan']);
  assert.deepEqual(parseAgentList(JSON.stringify({ agents: ['build'] })), ['build']);
});

test('桌面版安装目录在候选列表里', () => {
  const roots = installRoots();
  assert.ok(roots.length > 0);
  if (process.platform === 'win32') {
    assert.ok(roots.some(dir => dir.includes(path.join('Programs', 'ai.opencode.desktop'))), '缺少桌面版 resources 目录');
  }
});

test('OPENCODE_VERSION 能覆盖过期配置目录推断出的主版本', async () => {
  process.env.OPENCODE_VERSION = '2.2.5';
  try {
    const info = await detectOpenCode({ workspace: process.cwd() });
    assert.equal(info.cli.version, '2.2.5');
    assert.equal(info.cli.major, 2);
    assert.equal(info.cli.supported, true);
    assert.equal(info.host.suggestedMajor, '2');
    assert.equal(info.host.major, 2);
    // host.sdk must describe the running major, never a stale 1.x package.
    assert.equal(info.host.sdk.major, 2);
  } finally {
    delete process.env.OPENCODE_VERSION;
  }
});
