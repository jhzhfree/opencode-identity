const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const state = {
  status: null,
  detect: null,
  agents: [],
  jobId: null,
  build: null,
  fragments: {},
  fragTab: null,
  selftestRunning: false,
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, bad = false) {
  const el = $('toast');
  el.textContent = message;
  el.style.background = bad ? '#b91c1c' : '#0f172a';
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3200);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pollJob(jobId, onTick, { interval = 600, timeout = 600000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    onTick(job);
    if (job.state !== 'running') return job;
    if (Date.now() > deadline) throw new Error('任务超时');
    await sleep(interval);
  }
}

/* ---------------- 状态条 ---------------- */

async function loadStatus() {
  const status = await api('/api/status');
  state.status = status;
  $('pill-node').textContent = `Node ${status.node}`;
  $('pill-node').className = 'pill ok';

  if (status.lab.found) {
    $('pill-lab').textContent = `lab ${status.lab.version ?? ''}`;
    $('pill-lab').className = 'pill ok';
    $('pill-lab').title = status.lab.dir;
  } else {
    $('pill-lab').textContent = 'lab 未找到';
    $('pill-lab').className = 'pill bad';
  }

  if (!$('workspace').value && status.defaults.workspace) $('workspace').value = status.defaults.workspace;
  if (!$('datadir').value) $('datadir').value = status.defaults.dataDir;
  if (!$('port').value) $('port').value = status.defaults.port;

  renderServer(status.server);
  return status;
}

function renderServer(server) {
  const pill = $('pill-server');
  pill.textContent = server?.running ? `服务端 :${server.port}` : '服务端未启动';
  pill.className = `pill ${server?.running ? 'ok' : ''}`;
  $('srv-dot').className = `dot ${server?.running ? 'on' : ''}`;
  $('srv-text').textContent = server?.running ? `运行中（PID ${server.pid ?? '-'}）` : '服务端未启动';
  $('srv-url').textContent = server?.running ? `http://127.0.0.1:${server.port}/mcp` : '';
  $('btn-srv-start').disabled = Boolean(server?.running);
  $('btn-srv-stop').disabled = !server?.running;
}

/* ---------------- Step 1：检测与 Agent ---------------- */

async function detect() {
  const workspace = $('workspace').value.trim();
  const box = $('detect-box');
  box.innerHTML = '<div class="detect-empty">正在检测 OpenCode 环境…</div>';
  try {
    const info = await api(`/api/opencode/detect?workspace=${encodeURIComponent(workspace)}`);
    state.detect = info;
    renderDetect(info);
    const pill = $('pill-opencode');
    if (info.cli.found) {
      pill.textContent = `opencode ${info.cli.version}`;
      pill.className = `pill ${info.cli.supported ? 'ok' : 'warn'}`;
    } else {
      pill.textContent = 'opencode 未安装';
      pill.className = 'pill warn';
    }
    if (!state.agents.length) {
      state.agents = info.agents.slice(0, 2).map(a => a.name);
      renderChips();
    }
  } catch (error) {
    box.innerHTML = `<div class="banner bad">检测失败：${esc(error.message)}</div>`;
    toast(error.message, true);
  }
}

function renderDetect(info) {
  const cli = info.cli;
  const version = cli.found
    ? `<b style="color:#15803d">${esc(cli.version)}（主版本 ${cli.major}）</b>`
    : `<b style="color:#b45309">未找到（PATH 与桌面版安装目录）</b>`;
  const files = info.configFiles.length
    ? info.configFiles.map(f => `<div class="mono small">${esc(f.file)} → ${esc(f.agents.join(', ') || '（无 agent 定义）')}</div>`).join('')
    : '<span class="muted small">未发现配置文件（opencode.json / .opencode/agent/*.md）</span>';
  const host = info.host ?? {};
  const hostVersion = host.version ?? host.sdk?.version ?? null;
  const sourceLabel = { cli: 'CLI 实测', node_modules: '已安装包', 'package.json': 'package.json 声明', 'env:OPENCODE_VERSION': '环境变量指定' }[host.source] ?? null;
  const sdk = host.sdk
    ? `<b style="color:#15803d">${esc(host.sdk.package)}${host.sdk.version ? '@' + esc(host.sdk.version) : ''}</b> → 宿主 <b style="color:#15803d">${esc(hostVersion ?? '未知')}</b>（${esc(host.major)}.x${sourceLabel ? ' · ' + esc(sourceLabel) : ''}）`
    : (host.exists
      ? (host.declaredSdk ? `已安装 ${esc(host.declaredSdk.package)}@${esc(host.declaredSdk.version)}` : '配置目录存在，未声明插件 SDK')
      : '未发现配置目录');
  const plugins = host.installedPlugins?.length
    ? `<span style="color:#b45309">${esc(host.installedPlugins.join(', '))}</span>`
    : '无';

  const picks = info.agents.map(a => `
    <span class="chip pick" data-agent="${esc(a.name)}" title="${esc(a.source)}">+ ${esc(a.name)}</span>
  `).join('');

  $('detect-box').innerHTML = `
    <div class="detect-grid">
      <div><b>OpenCode CLI</b>${version}</div>
      <div><b>宿主版本（实测 / 推断）</b>${sdk}</div>
      <div><b>发现的 Agent</b>${esc(info.agents.map(a => a.name).join(', ') || '无')}</div>
      <div><b>已有插件（不要覆盖）</b>${plugins}</div>
      <div style="grid-column:1/-1"><b>配置文件</b>${files}</div>
    </div>
    <div class="chips" style="margin-top:12px">${picks}</div>
    ${info.warnings.length ? `<div class="banner warn" style="margin:12px 0 0">${info.warnings.map(w => esc(w)).join('<br>')}</div>` : ''}
    <div class="agent-src" style="margin-top:10px">点击 Agent 加入生成列表；列表在下方可继续手工编辑。</div>
  `;
  $('detect-box').querySelectorAll('.chip.pick').forEach(chip => {
    chip.addEventListener('click', () => {
      const name = chip.dataset.agent;
      if (state.agents.includes(name)) { toast('已在列表中'); return; }
      state.agents.push(name);
      renderChips();
    });
  });
  if (host.suggestedMajor && !$('major').dataset.touched) {
    $('major').value = host.suggestedMajor;
    toast(`已按实测宿主 ${hostVersion ?? host.suggestedMajor + '.x'} 预选 OpenCode ${host.suggestedMajor}.x`);
  }
  // Generating the other major produces a plugin the installed host will not load.
  const chosen = $('major').value;
  if (host.major && chosen !== 'both' && chosen !== String(host.major)) {
    const warning = document.createElement('div');
    warning.className = 'banner warn';
    warning.style.marginTop = '10px';
    warning.textContent = `当前选择生成 ${chosen}.x，但本机宿主是 ${hostVersion ?? host.major + '.x'}（${host.major}.x），生成的插件不会被该宿主加载。`;
    $('detect-box').appendChild(warning);
  }
}

function renderChips() {
  const box = $('agent-chips');
  box.innerHTML = state.agents.map(name => `
    <span class="chip">${esc(name)}<button data-remove="${esc(name)}" title="移除">×</button></span>
  `).join('') || '<span class="hint">尚未添加 Agent</span>';
  box.querySelectorAll('button[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.agents = state.agents.filter(a => a !== btn.dataset.remove);
      renderChips();
    });
  });
}

/* ---------------- Step 2：生成 ---------------- */

function renderSteps(job, listId = 'build-steps') {
  const list = $(listId);
  list.innerHTML = job.steps.map(step => {
    const mark = step.status === 'done' ? '' : step.status === 'failed' ? '' : step.status === 'running' ? '' : '';
    return `<li class="${step.status}">
      <span class="mark">${mark}</span>
      <span class="name">${esc(step.name)}</span>
      ${step.detail ? `<span class="detail">${esc(step.detail)}</span>` : ''}
      ${step.ms != null ? `<span class="ms">${step.ms >= 1000 ? (step.ms / 1000).toFixed(1) + 's' : step.ms + 'ms'}</span>` : ''}
    </li>`;
  }).join('');
}

async function startBuild() {
  const workspace = $('workspace').value.trim();
  const dataDir = $('datadir').value.trim();
  if (!workspace) { toast('请先填写工作区路径', true); return; }
  if (!state.agents.length) { toast('至少选择一个 Agent', true); return; }

  $('btn-build').disabled = true;
  $('step2').hidden = false;
  $('build-sub').textContent = '正在创建任务…';
  $('build-result').innerHTML = '';
  $('build-steps').innerHTML = '';

  try {
    const { jobId } = await api('/api/build', {
      body: {
        workspace,
        dataDir: dataDir || undefined,
        agents: state.agents,
        port: Number($('port').value || 8781),
        opencodeMajor: $('major').value,
        legacyReadOnly: $('legacy').checked,
        includePrivateKeys: $('withkeys').checked,
      },
    });
    state.jobId = jobId;
    const job = await pollJob(jobId, tick => {
      renderSteps(tick);
      $('build-bar').style.width = `${tick.progress}%`;
      $('build-pct').textContent = `${tick.progress}%`;
      $('build-sub').textContent = tick.state === 'running' ? '生成中，请勿关闭页面…' : '';
    });
    if (job.state === 'failed') throw new Error(job.error);
    renderBuildResult(job);
    history.replaceState(null, '', `?job=${job.id}`);
    toast('生成完成');
  } catch (error) {
    $('build-result').innerHTML = `<div class="banner bad">生成失败：${esc(error.message)}</div>`;
    toast(error.message, true);
  } finally {
    $('btn-build').disabled = false;
  }
}

function renderBuildResult(job) {
  const r = job.result;
  state.build = r;
  state.jobId = job.id;
  state.fragments = r.fragments;
  $('build-sub').textContent = `耗时 ${(job.elapsedMs / 1000).toFixed(1)} 秒`;
  $('build-bar').style.width = '100%';
  $('build-pct').textContent = '100%';

  const rows = r.agents.map(a => `<tr>
    <td><b>${esc(a.agentName)}</b></td>
    <td class="mono">${esc(a.uuid)}</td>
    <td class="mono">${esc(a.kid)}</td>
  </tr>`).join('');

  $('build-result').innerHTML = `
    <div class="result-box">
      <h3>身份已登记</h3>
      <table style="margin-top:10px">
        <thead><tr><th>Agent</th><th>UUID</th><th>kid（公钥指纹）</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <dl class="kv">
        <dt>数据目录</dt><dd>${esc(r.dataDir)}</dd>
        <dt>工作区</dt><dd>${esc(r.workspace)}</dd>
        <dt>服务地址</dt><dd>${esc(r.serverUrl)}</dd>
        <dt>插件入口</dt><dd>${Object.entries(r.entries).map(([k, v]) => `<div>${esc(k)}: ${esc(v)}</div>`).join('')}</dd>
        <dt>ZIP 大小</dt><dd>${(r.zipSize / 1024).toFixed(1)} KB</dd>
      </dl>
    </div>`;

  $('step3').hidden = false;
  $('step4').hidden = false;
  $('verify-agent').innerHTML = r.agents.map(a => `<option value="${esc(a.agentName)}">${esc(a.agentName)}</option>`).join('');
  $('run-cmd').textContent = `opencode run --agent ${r.agents[0].agentName} '调用 identity_whoami，告诉我 UUID'`;
  renderFragTabs();
  $('step3').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- Step 3：验证 ---------------- */

async function startServer() {
  if (!state.jobId) return;
  $('btn-srv-start').disabled = true;
  try {
    const result = await api('/api/server/start', { body: { jobId: state.jobId, port: Number($('port').value || 8781) } });
    if (!result.running) throw new Error(result.error || '启动失败');
    await loadStatus();
    toast(result.alreadyRunning ? '服务端已在运行' : `服务端已启动 :${result.port}`);
  } catch (error) {
    toast(error.message, true);
    $('btn-srv-start').disabled = false;
  }
}

async function stopServer() {
  try {
    await api('/api/server/stop', { body: {} });
    await loadStatus();
    toast('服务端已停止');
  } catch (error) { toast(error.message, true); }
}

async function showServerLog() {
  const el = $('srv-log');
  if (!el.hidden) { el.hidden = true; return; }
  const { entries, running } = await api('/api/server/log');
  el.textContent = entries.length
    ? entries.map(e => `${e.time.slice(11, 19)}  ${e.line}`).join('\n')
    : (running ? '（暂无输出）' : '（服务端未运行）');
  el.hidden = false;
  el.scrollTop = el.scrollHeight;
}

async function runVerify() {
  if (!state.jobId) return;
  const tool = $('verify-tool').value;
  const body = {
    jobId: state.jobId,
    agent: $('verify-agent').value,
    tool,
  };
  if (tool === 'echo_secure') body.text = $('arg-text').value;
  if (tool === 'add') { body.a = Number($('arg-a').value); body.b = Number($('arg-b').value); }

  $('btn-verify').disabled = true;
  $('verify-out').innerHTML = '<div class="hint" style="margin-top:12px">正在用 SDK 签名并请求服务端…</div>';
  try {
    const result = await api('/api/verify', { body });
    const identity = result.structured?.identity;
    $('verify-out').innerHTML = `
      <div class="banner ok" style="margin-top:12px">
        验签通过：<b>${esc(identity?.agentName)}</b> · UUID <code>${esc(identity?.uuid)}</code>
        <div class="small" style="margin-top:4px">
          initialize ${result.timings.initializeMs}ms · tools/call ${result.timings.callMs}ms · 合计 ${result.timings.totalMs}ms
          · 协议 ${esc(result.protocolVersion)}
        </div>
      </div>
      <pre class="code out">${esc(JSON.stringify(result.structured, null, 2))}</pre>`;
  } catch (error) {
    $('verify-out').innerHTML = `<div class="banner bad" style="margin-top:12px">${esc(error.message)}</div>`;
  } finally {
    $('btn-verify').disabled = false;
  }
}

async function runSelftest() {
  if (!state.jobId || state.selftestRunning) return;
  state.selftestRunning = true;
  $('btn-selftest').disabled = true;
  $('selftest-out').innerHTML = '';
  try {
    const { jobId } = await api('/api/selftest', { body: { jobId: state.jobId } });
    const job = await pollJob(jobId, tick => renderSteps(tick, 'selftest-steps'));
    if (job.state === 'failed') throw new Error(job.error);
    const { checks, passed, failed, skipped = 0 } = job.result;
    const rows = checks.map(c => `
      <div class="check-row ${c.skip ? 'skip' : c.pass ? 'pass' : 'fail'}">
        <span class="mark">${c.skip ? '–' : c.pass ? '✓' : '✕'}</span>
        <div class="body">
          <div><b>${esc(c.name)}</b></div>
          <div class="why">期望 ${esc(c.expect)} · 实际 ${esc(c.actual)}</div>
        </div>
      </div>`).join('');
    $('selftest-out').innerHTML = `
      <div class="banner ${failed ? 'bad' : 'ok'}" style="margin-top:12px">
        ${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}${skipped ? `，${skipped} 项按需跳过` : ''}${job.result.checks.some(c => c.id.startsWith('e2e') || c.id.startsWith('guard')) ? '' : '（服务端未运行，仅完成结构检查）'}
      </div>
      <div class="checks">${rows}</div>`;
    toast(failed ? `${failed} 项失败` : '自检全部通过', failed > 0);
  } catch (error) {
    $('selftest-out').innerHTML = `<div class="banner bad" style="margin-top:12px">${esc(error.message)}</div>`;
  } finally {
    state.selftestRunning = false;
    $('btn-selftest').disabled = false;
  }
}

/* ---------------- Step 4：部署 ---------------- */

function renderFragTabs() {
  const keys = Object.keys(state.fragments);
  if (!keys.length) return;
  if (!state.fragTab || !keys.includes(state.fragTab)) state.fragTab = keys[0];
  $('frag-tabs').innerHTML = keys.map(key => `
    <button class="tab ${key === state.fragTab ? 'active' : ''}" data-tab="${key}">
      ${key === 'v1' ? 'OpenCode 1.x' : 'OpenCode 2.x'}
    </button>`).join('');
  $('frag-tabs').querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => { state.fragTab = tab.dataset.tab; renderFragTabs(); });
  });
  $('frag-body').textContent = JSON.stringify(state.fragments[state.fragTab]?.content ?? {}, null, 2);
}

async function copyFragment() {
  const text = $('frag-body').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('片段已复制');
  } catch {
    toast('复制失败，请手动选择', true);
  }
}

async function showGuide() {
  const el = $('guide-body');
  if (!el.hidden) { el.hidden = true; return; }
  const { text } = await api(`/api/guide/${state.jobId}`);
  el.textContent = text || '（SETUP.md 尚未生成）';
  el.hidden = false;
}

async function regeneratePlugin() {
  if (!state.jobId) return;
  const major = $('regen-major').value;
  $('btn-regen').disabled = true;
  $('btn-regen').textContent = '生成中…';
  try {
    const { entries, fragments } = await api('/api/plugin', { body: { jobId: state.jobId, opencodeMajor: major } });
    state.fragments = fragments;
    state.build.entries = entries;
    state.build.opencodeMajor = major;
    state.build.pluginDir = Object.values(entries)[0];
    renderFragTabs();
    toast('插件已重新生成，请重新下载 ZIP');
  } catch (error) {
    toast(error.message, true);
  } finally {
    $('btn-regen').disabled = false;
    $('btn-regen').textContent = '重新生成插件';
  }
}

function downloadZip() {
  if (!state.jobId) return;
  window.location.href = `/api/download/${state.jobId}`;
}

/* ---------------- SDK 组件 ---------------- */

state.sdk = { info: null, ref: null, identity: null, attestation: null };

// Only the actions that need a key pair generated in this session start disabled.
// Verify / tamper / reset stay usable because a user can paste any public key and token.
const SDK_BUTTONS = ['btn-sdk-sign', 'btn-sdk-proof', 'btn-sdk-fill-jwk', 'btn-sdk-fill-pem'];

async function loadSdkInfo() {
  try {
    const info = await api('/api/sdk/info');
    state.sdk.info = info;
    $('pill-sdk').textContent = `sdk ${info.version}`;
    $('pill-sdk').className = 'pill ok';
    $('pill-sdk').title = `${info.dir}\n${info.modules.map(m => m.id).join(', ')}`;
    $('sdk-version').textContent = `${info.name} v${info.version}`;
    $('sdk-version').title = info.modules.map(m => `${m.id}: ${m.purpose}`).join('\n');
  } catch (error) {
    $('pill-sdk').textContent = 'sdk 不可用';
    $('pill-sdk').className = 'pill bad';
    $('sdk-version').textContent = error.message;
  }
}

const sdkKv = rows => `<dl class="sdk-grid">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

function renderSdkKey(data) {
  $('sdk-key').innerHTML = sdkKv([
    ['密钥对', `RSA-3072 · kid <code>${esc(data.kid)}</code>`],
    ['UUID', esc(data.uuid)],
    ['公钥 n', `${esc(data.publicJwk.n.slice(0, 56))}…`],
    ['生成耗时', `${data.ms} ms`],
    ['私钥', `仅留在服务进程内存，不回传浏览器（ref <code>${esc(data.ref)}</code>，${Math.round(data.keyTtlMs / 60000)} 分钟有效）`],
  ]) + `<pre class="code tiny">${esc(JSON.stringify({ claim: data.attestation.claim, signature: { ...data.attestation.signature, value: `${data.attestation.signature.value.slice(0, 40)}…` } }, null, 2))}</pre>`;
}

function renderSdkAttestation(attestation, note) {
  $('sdk-token')?.remove();
  const pre = document.createElement('pre');
  pre.className = 'code tiny';
  pre.id = 'sdk-token';
  pre.textContent = attestation.token;
  $('sdk-key').appendChild(pre);
  if (note) toast(note);
}

async function sdkKeypair() {
  const btn = $('btn-sdk-keypair');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const data = await api('/api/sdk/keypair', { body: { agentName: $('sdk-agent').value.trim() || 'build' } });
    state.sdk.ref = data.ref;
    state.sdk.identity = data;
    state.sdk.attestation = data.attestation.token;
    $('sdk-uuid').value = data.uuid;
    $('sdk-expect-agent').value = data.agentName;
    $('sdk-expect-uuid').value = data.uuid;
    $('sdk-public').value = JSON.stringify(data.publicJwk, null, 2);
    $('sdk-attestation').value = data.attestation.token;
    $('sdk-verify-out').innerHTML = '';
    $('sdk-proof-out').innerHTML = '';
    renderSdkKey(data);
    for (const id of SDK_BUTTONS) $(id).disabled = false;
    toast(`密钥对已生成（${data.ms} ms）`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '生成密钥对';
  }
}

async function sdkSign() {
  if (!state.sdk.ref) return;
  const body = { ref: state.sdk.ref };
  const agentName = $('sdk-agent').value.trim();
  const uuid = $('sdk-uuid').value.trim();
  if (agentName) body.agentName = agentName;
  if (uuid) body.uuid = uuid;
  try {
    const data = await api('/api/sdk/sign', { body });
    state.sdk.attestation = data.attestation.token;
    $('sdk-attestation').value = data.attestation.token;
    renderSdkAttestation(data.attestation, `已用私钥签名 ${data.agentName} / ${data.uuid.slice(0, 8)}…`);
    $('sdk-verify-out').innerHTML = '<div class="hint">签名已更新并写入上方「身份证明」，点「用公钥验签」验证，或点篡改按钮看它如何被拒。</div>';
  } catch (error) {
    toast(error.message, true);
  }
}

/** Fill the public-key box from the key pair this session generated. */
function fillSdkPublic(kind) {
  if (!state.sdk.identity) { toast('先生成密钥对', true); return; }
  $('sdk-public').value = kind === 'pem'
    ? state.sdk.identity.publicPem
    : JSON.stringify(state.sdk.identity.publicJwk, null, 2);
  toast(kind === 'pem' ? '已填入 SPKI PEM' : '已填入公钥 JWK');
}

/** Verify using ONLY what is in the public-key box. No ref, no registry, no private key. */
async function sdkVerify(tamper = 'none') {
  const out = $('sdk-verify-out');
  const rawPublic = $('sdk-public').value.trim();
  const rawAttestation = $('sdk-attestation').value.trim();
  if (!rawPublic) { out.innerHTML = '<div class="banner bad" style="margin-top:12px">先粘贴公钥，或点「填入 JWK / 填入 PEM」。</div>'; return; }
  if (!rawAttestation) { out.innerHTML = '<div class="banner bad" style="margin-top:12px">先粘贴身份证明，或先生成密钥对。</div>'; return; }

  let publicKey = rawPublic;
  if (rawPublic.startsWith('{')) {
    try { publicKey = JSON.parse(rawPublic); }
    catch (error) { out.innerHTML = `<div class="banner bad" style="margin-top:12px">公钥 JSON 解析失败：${esc(error.message)}</div>`; return; }
  }

  const body = { publicKey, attestation: rawAttestation, tamper };
  const expectedAgent = $('sdk-expect-agent').value.trim();
  const expectedUuid = $('sdk-expect-uuid').value.trim();
  if (expectedAgent) body.expectedAgent = expectedAgent;
  if (expectedUuid) body.expectedUuid = expectedUuid;

  out.innerHTML = '<div class="hint" style="margin-top:12px">正在用公钥验签…</div>';
  try {
    const data = await api('/api/sdk/verify-public', { body });
    if (data.verified) {
      out.innerHTML = `<div class="banner ok" style="margin:12px 0 0">✓ 公钥验签通过（${data.ms} ms）· 仅使用公钥，未接触私钥</div>`
        + sdkKv([
          ['声明 Agent', esc(data.claim.agent)],
          ['声明 UUID', esc(data.claim.sub)],
          ['claim kid', esc(data.claim.kid)],
          ['公钥 kid（由密钥推导）', esc(data.key.kid)],
          ['密钥强度', `RSA-${data.key.modulusBits}`],
          ['签发时间', esc(new Date(data.claim.iat * 1000).toLocaleString())],
          ['签发者', esc(data.claim.iss)],
        ]);
    } else {
      const explain = tamper === 'none'
        ? ''
        : '<div class="hint" style="margin-top:8px">篡改被正确拒绝 —— 签名确实覆盖 Agent 名称与 UUID，改任何一个字段都会失配。</div>';
      out.innerHTML = `<div class="banner bad" style="margin:12px 0 0">✕ 验签失败：<b>${esc(data.code)}</b>（${data.ms} ms）<br>${esc(data.message)}</div>${explain}`;
    }
  } catch (error) {
    out.innerHTML = `<div class="banner bad" style="margin-top:12px">${esc(error.message)}</div>`;
  }
}

async function sdkProof() {
  if (!state.sdk.ref) return;
  const btn = $('btn-sdk-proof');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const data = await api('/api/sdk/proof', {
      body: { ref: state.sdk.ref, url: $('sdk-url').value.trim(), payload: $('sdk-payload').value },
    });
    const claim = data.claims;
    const line = (ok, good, bad) => (ok ? `✓ ${good}` : `✕ ${bad}`);
    $('sdk-proof-out').innerHTML = sdkKv([
      ['请求头', `<code>${esc(data.header)}</code>`],
      ['受众', `${esc(claim.aud)} · ${esc(claim.path)} · ${esc(claim.method)}`],
      ['有效期', `${claim.exp - claim.iat} 秒（exp ${esc(new Date(claim.exp * 1000).toLocaleTimeString())}）`],
      ['body 摘要', esc(claim.body_sha256)],
      ['jti', esc(claim.jti)],
      ['验签', data.verify.ok ? line(true, `通过 · ${esc(data.verify.result.uuid.slice(0, 8))}… / ${esc(data.verify.result.agentName)}`, '') : line(false, '', esc(data.verify.code))],
      ['重放同一证明', line(!data.replayAttempt.ok, `已拒绝 ${esc(data.replayAttempt.code ?? '')}`, '未被拒绝（异常）')],
      ['篡改 body', line(!data.bodyTamper.ok, `已拒绝 ${esc(data.bodyTamper.code ?? '')}`, '未被拒绝（异常）')],
      ['往返耗时', `${data.ms} ms`],
    ]) + `<pre class="code tiny">${esc(data.token)}</pre>`;
  } catch (error) {
    $('sdk-proof-out').innerHTML = `<div class="banner bad" style="margin-top:12px">${esc(error.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '生成并往返验证';
  }
}

async function sdkSelftest() {
  const btn = $('btn-sdk-selftest');
  btn.disabled = true;
  btn.textContent = '运行中…';
  $('sdk-selftest-out').innerHTML = '<div class="hint" style="margin-top:10px">正在执行断言…</div>';
  try {
    const result = await api('/api/sdk/selftest', { body: {} });
    $('sdk-selftest-hint').textContent = `${result.passed}/${result.passed + result.failed} 通过 · 用时 ${result.ms} ms`;
    $('sdk-selftest-out').innerHTML = `<div class="checks">${result.checks.map(check => `
      <div class="check-row ${check.pass ? 'pass' : 'fail'}">
        <span class="mark">${check.pass ? '✓' : '✕'}</span>
        <div class="body">${esc(check.name)}<div class="why">${esc(check.actual)}</div></div>
        <span class="ms">${check.ms} ms</span>
      </div>`).join('')}</div>`;
  } catch (error) {
    $('sdk-selftest-out').innerHTML = `<div class="banner bad" style="margin-top:12px">${esc(error.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '运行 SDK 自检';
  }
}

/** ?sdk=demo 时自动走一遍 SDK 面板，便于截图与演示。 */
async function sdkDemo() {
  await sdkKeypair();
  await sdkVerify('none');
  await sdkProof();
  await sdkSelftest();
}

/* ---------------- 事件绑定 ---------------- */
$('btn-detect').addEventListener('click', detect);
$('btn-build').addEventListener('click', startBuild);
$('btn-srv-start').addEventListener('click', startServer);
$('btn-srv-stop').addEventListener('click', stopServer);
$('btn-srv-log').addEventListener('click', showServerLog);
$('btn-verify').addEventListener('click', runVerify);
$('btn-selftest').addEventListener('click', runSelftest);
$('btn-copy-frag').addEventListener('click', copyFragment);
$('btn-open-guide').addEventListener('click', showGuide);
$('btn-download').addEventListener('click', downloadZip);
$('btn-regen').addEventListener('click', regeneratePlugin);

$('btn-sdk-keypair').addEventListener('click', sdkKeypair);
$('btn-sdk-sign').addEventListener('click', sdkSign);
$('btn-sdk-fill-jwk').addEventListener('click', () => fillSdkPublic('jwk'));
$('btn-sdk-fill-pem').addEventListener('click', () => fillSdkPublic('pem'));
$('btn-sdk-public-clear').addEventListener('click', () => {
  $('sdk-public').value = '';
  $('sdk-verify-out').innerHTML = '';
});
$('btn-sdk-verify').addEventListener('click', () => sdkVerify('none'));
$('btn-sdk-tamper-agent').addEventListener('click', () => sdkVerify('agent'));
$('btn-sdk-tamper-uuid').addEventListener('click', () => sdkVerify('uuid'));
$('btn-sdk-tamper-sig').addEventListener('click', () => sdkVerify('signature'));
$('btn-sdk-proof').addEventListener('click', sdkProof);
$('btn-sdk-selftest').addEventListener('click', sdkSelftest);
$('btn-sdk-reset').addEventListener('click', () => {
  state.sdk = { info: state.sdk.info, ref: null, identity: null, attestation: null };
  $('sdk-key').innerHTML = '';
  $('sdk-uuid').value = '';
  $('sdk-expect-agent').value = '';
  $('sdk-expect-uuid').value = '';
  $('sdk-public').value = '';
  $('sdk-attestation').value = '';
  $('sdk-verify-out').innerHTML = '';
  $('sdk-proof-out').innerHTML = '';
  for (const id of SDK_BUTTONS) $(id).disabled = true;
});
$('pill-sdk').addEventListener('click', () => $('sdk').scrollIntoView({ behavior: 'smooth', block: 'start' }));

$('verify-tool').addEventListener('change', () => {
  const tool = $('verify-tool').value;
  $('args-echo').hidden = tool !== 'echo_secure';
  $('args-add').hidden = tool !== 'add';
});

$('agent-input').addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const name = $('agent-input').value.trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(name)) { toast('名称只能包含字母数字和 _.:-', true); return; }
  if (state.agents.includes(name)) { toast('已存在'); return; }
  state.agents.push(name);
  $('agent-input').value = '';
  renderChips();
});

$('workspace').addEventListener('change', () => { state.detect = null; });
$('major').addEventListener('change', () => { $('major').dataset.touched = '1'; });

/** 刷新页面或换标签页后，用 ?job=<id> 恢复最近一次生成结果。 */
async function restoreFromQuery() {
  const id = new URLSearchParams(location.search).get('job');
  if (!id) return false;
  try {
    const job = await api(`/api/jobs/${id}`);
    if (job.state !== 'done') return false;
    $('step2').hidden = false;
    renderSteps(job);
    renderBuildResult(job);
    $('workspace').value = job.result.workspace;
    $('port').value = job.result.port;
    $('datadir').value = job.result.dataDir;
    $('major').value = job.result.opencodeMajor;
    $('major').dataset.touched = '1';
    state.agents = job.result.agents.map(a => a.agentName);
    renderChips();
    $('build-sub').textContent = `已恢复 ${new Date().toLocaleTimeString()} 的生成结果`;
    return true;
  } catch {
    return false;
  }
}

loadStatus().then(async () => {
  loadSdkInfo();
  if (new URLSearchParams(location.search).get('sdk') === 'demo') { sdkDemo(); return; }
  await restoreFromQuery();
  // Detect even on a restored job: the host version may have changed since the
  // build, and the panel must show what is installed now.
  if ($('workspace').value) detect();
}).catch(error => toast(error.message, true));
