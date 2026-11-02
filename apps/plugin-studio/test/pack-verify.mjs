/** End-to-end verification: build -> unzip -> run packaged server -> signed calls. */
import path from 'node:path';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createJob } from '../lib/jobs.mjs';
import { runBuild } from '../lib/builder.mjs';
import { readFile } from 'node:fs/promises';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const outRoot = await mkdtemp(path.join(tmpdir(), 'pack-verify-'));
const dataDir = path.join(outRoot, 'identity');

const job = createJob('build', {});
console.log('[1/4] runBuild 开始（生成 RSA-3072 需要几秒）…');
const build = await runBuild(job, {
  workspace: 'E:/workspace/opencode-identity',
  dataDir,
  agents: ['build', 'plan'],
  port: 8795,
  opencodeMajor: '2',
  legacyReadOnly: false,
  includePrivateKeys: true,
});
console.log('[1/4] 生成完成，zip bytes =', build.zip.length);
const ps1 = await readFile(path.join(dataDir, 'start-server.ps1'), 'utf8');
console.log('[2/4] start-server.ps1 含 --tools 逻辑:', ps1.includes('--tools $tools') ? 'YES' : 'NO');

// extract zip (stored entries -> Expand-Archive)
const zipFile = path.join(outRoot, 'bundle.zip');
await writeFile(zipFile, build.zip);
const extractDir = path.join(outRoot, 'extracted');
await mkdir(extractDir, { recursive: true });
execFileSync('powershell', ['-NoProfile', '-Command',
  `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${extractDir}' -Force`]);
console.log('[3/4] ZIP 解压完成');

// start the packaged server from inside the extracted tree
const port = 8795;
const server = spawn(process.execPath, [
  path.join(extractDir, 'server', 'bin', 'serve.mjs'),
  '--registry', path.join(extractDir, 'identity', 'registry.json'),
  '--port', String(port), '--quiet',
  '--tools', path.join(extractDir, 'server', 'examples', 'business-tools.mjs'),
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let serverLog = '';
server.stdout.on('data', c => { serverLog += c; });
server.stderr.on('data', c => { serverLog += c; });
await new Promise(r => setTimeout(r, 1800));

try {
  // selftest over the fresh build (server not started here -> e2e steps skip)
  const { runSelfTest } = await import('../lib/selftest.mjs');
  const testJob = createJob('selftest', {});
  const report = await runSelfTest(testJob, {
    entries: build.entries, configFile: build.configFile, workspace: build.workspace,
    agents: build.agents, serverRunning: false, auditCount: () => 0, zip: build.zip,
    opencodeMajor: '2', fragments: build.fragments, hostMajor: '2', hostVersion: null,
  });
  for (const c of report.checks) {
    if (c.id.startsWith('zip-') || c.id === 'v2-load' || c.id === 'v2-shape' || c.id === 'v2-tools') {
      console.log('[selftest]', c.pass ? 'PASS' : c.skip ? 'SKIP' : 'FAIL', c.id, '-', c.actual);
    }
  }
  console.log('[selftest] passed=%d failed=%d skipped=%d', report.passed, report.failed, report.skipped);
  if (report.failed > 0) { server.kill(); process.exit(1); }

  const { createProof, assertLocalEndpoint, HEADER } = await import(
    'file:///' + path.join(ROOT, 'packages/identity-sdk/src/index.mjs').replaceAll('\\', '/'));
  const url = assertLocalEndpoint(`http://127.0.0.1:${port}/mcp`);
  const key = await readFile(path.join(extractDir, 'identity', 'agent-1', 'private.pem'), 'utf8');
  const uuid = JSON.parse(await readFile(path.join(extractDir, 'identity', 'agent-1', 'identity.json'), 'utf8')).uuid;
  const call = async name => {
    const body = Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call',
      params: { name, arguments: {} },
    }));
    const proof = createProof({ uuid, agentName: 'build', privateKey: key, url, body, sessionId: 'pack', invocationId: crypto.randomUUID() });
    const res = await fetch(url, { method: 'POST', redirect: 'error', body, headers: { 'Content-Type': 'application/json', [HEADER]: proof } });
    return [res.status, await res.json()];
  };
  const [s1, j1] = await call('whoami');
  const id1 = j1.result?.structuredContent?.identity ?? j1.error;
  const [s2, j2] = await call('whoami_deep');
  const id2 = j2.result?.structuredContent ?? j2.error;
  console.log('[4/4] 包内服务端 whoami     :', s1, JSON.stringify(id1));
  console.log('[4/4] 包内服务端 whoami_deep:', s2, JSON.stringify(id2));
  const ok = s1 === 200 && id1?.verified === true && s2 === 200 && id2?.deep === true && id2?.uuid === uuid;
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  server.kill();
  if (process.exitCode !== 0) console.error('server log tail:', serverLog.slice(-400));
}
