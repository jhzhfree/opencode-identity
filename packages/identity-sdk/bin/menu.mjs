#!/usr/bin/env node
/**
 * Interactive menu for manual use (double-click / `start-sdk`).
 *
 * Scripts should keep calling subcommands directly — the menu only builds argv
 * and re-runs this same CLI, so behaviour cannot drift between the two paths.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

const SELF = path.join(import.meta.dirname, 'sdk.mjs');

const ITEMS = [
  { key: '1', label: '查看 SDK 能力（describe）', args: ['describe'] },
  { key: '2', label: '生成密钥对 + UUID（keygen）', args: ['keygen'], ask: 'keygen' },
  { key: '3', label: '用私钥签发身份证明（sign）', args: ['sign'], ask: 'sign' },
  { key: '4', label: '只用公钥验签（verify-public）', args: ['verify-public'], ask: 'verify' },
  { key: '5', label: '只看身份证明内容，不验签（inspect）', args: ['inspect'], ask: 'inspect' },
  { key: '6', label: '生成请求证明 X-Agent-Proof（proof）', args: ['proof'], ask: 'proof' },
  { key: '7', label: '跑一组内置自检（selftest）', args: ['selftest'] },
  { key: '8', label: '查看全部命令行用法', args: ['--help'] },
];

function run(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SELF, ...args], { stdio: 'inherit' });
    child.on('exit', code => resolve(code ?? 0));
  });
}

function banner() {
  stdout.write('\n==============================================\n');
  stdout.write('  identity-sdk · 独立 SDK 工具\n');
  stdout.write('  （插件生成工具与 MCP 服务端用的是同一套方法）\n');
  stdout.write('==============================================\n');
  for (const item of ITEMS) stdout.write(`  ${item.key}. ${item.label}\n`);
  stdout.write('  0. 退出\n\n');
}

/** @param {readline.Interface} rl */
async function collect(kind, rl) {
  const ask = async (question, fallback) => {
    const answer = (await rl.question(`  ${question}${fallback ? `（回车用 ${fallback}）` : ''}: `)).trim();
    return answer || fallback || '';
  };
  if (kind === 'keygen') {
    const out = await ask('输出目录', './identity-out');
    const agent = await ask('Agent 名称', 'build');
    return ['keygen', '--out', out, '--agent', agent];
  }
  if (kind === 'sign') {
    const priv = await ask('私钥文件路径', './identity-out/private.pem');
    const agent = await ask('Agent 名称', 'build');
    const uuid = await ask('UUID（回车自动生成）');
    const out = await ask('输出文件（回车打印到终端）');
    return ['sign', '--private', priv, '--agent', agent, ...(uuid ? ['--uuid', uuid] : []), ...(out ? ['--out', out] : [])];
  }
  if (kind === 'verify') {
    const pub = await ask('公钥（PEM 文件路径 / JWK 文件 / 直接粘贴）');
    const att = await ask('身份证明（文件路径 / 紧凑 token）');
    return ['verify-public', '--public', pub, '--attestation', att];
  }
  if (kind === 'inspect') {
    const att = await ask('身份证明（文件路径 / 紧凑 token）');
    const pub = await ask('公钥（可选，给了就比对 kid）');
    return ['inspect', '--attestation', att, ...(pub ? ['--public', pub] : [])];
  }
  if (kind === 'proof') {
    const priv = await ask('私钥文件路径', './identity-out/private.pem');
    const agent = await ask('Agent 名称', 'build');
    const uuid = await ask('UUID');
    const url = await ask('目标 URL', 'http://127.0.0.1:8781/mcp');
    const body = await ask('请求体文件（空 body 用空文件）');
    return ['proof', '--private', priv, '--agent', agent, '--uuid', uuid, '--url', url, '--body', body];
  }
  return [];
}

export async function runMenu() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      banner();
      const answer = (await rl.question('请选择: ')).trim();
      if (answer === '0' || answer.toLowerCase() === 'q') return;
      const item = ITEMS.find(i => i.key === answer);
      if (!item) { stdout.write('无效选项，请重新输入。\n'); continue; }
      let args = item.args;
      if (item.ask) args = await collect(item.ask, rl);
      stdout.write('\n');
      const code = await run(args);
      stdout.write(code === 0 ? '\n[完成]\n' : `\n[退出码 ${code}]\n`);
      await rl.question('按回车返回菜单…');
    }
  } finally {
    rl.close();
  }
}

// Allow `node bin/menu.mjs` directly (not only via bin/sdk.mjs with no arguments).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMenu();
