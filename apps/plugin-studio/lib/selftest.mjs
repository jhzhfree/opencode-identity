/**
 * Verifies the generated plugins against simulated OpenCode host contexts.
 * Structural checks need no server; end-to-end checks require the MCP server.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const signal = () => new AbortController().signal;

function check(list, id, name, expect, fn) {
  const started = Date.now();
  return (async () => {
    try {
      const actual = await fn();
      const pass = typeof expect === 'function' ? expect(actual) : actual === expect;
      list.push({ id, name, expect: typeof expect === 'function' ? 'predicate' : String(expect), actual: typeof actual === 'string' ? actual : JSON.stringify(actual), pass, ms: Date.now() - started });
      return actual;
    } catch (e) {
      list.push({ id, name, expect: typeof expect === 'function' ? 'predicate' : String(expect), actual: `抛出：${e.message}`, pass: false, ms: Date.now() - started });
      return null;
    }
  })();
}

/** A major that was not requested is not a failure; record it as skipped. */
function skip(list, id, name, reason) {
  list.push({ id, name, expect: '—', actual: reason, pass: false, skip: true, ms: 0 });
}

async function expectReject(list, id, name, pattern, fn) {
  const started = Date.now();
  try {
    await fn();
    list.push({ id, name, expect: `拒绝（/${pattern}/）`, actual: '未拒绝，调用成功', pass: false, ms: Date.now() - started });
    return false;
  } catch (e) {
    const pass = pattern.test(e.message);
    list.push({ id, name, expect: `拒绝（/${pattern}/）`, actual: e.message, pass, ms: Date.now() - started });
    return pass;
  }
}

/**
 * Structural check of the config fragment against the real host schemas:
 * 2.x expects `plugins: (string | {package, options?})[]` and
 * `permissions: {action, resource, effect: allow|deny|ask}[]`;
 * 1.x expects `plugin: string[]` plus a `permission` name → ask map.
 */
export function validateFragment(fragment, major) {
  const errors = [];
  if (!fragment || typeof fragment !== 'object') return ['片段不是对象'];
  if (Number(major) >= 2) {
    if (!Array.isArray(fragment.plugins) || !fragment.plugins.length) errors.push('缺少 plugins 数组');
    for (const [i, entry] of (fragment.plugins ?? []).entries()) {
      const ok = typeof entry === 'string' || (entry && typeof entry.package === 'string' && entry.package.length > 0);
      if (!ok) errors.push(`plugins[${i}] 必须是字符串或 { package }`);
      if (entry && typeof entry === 'object' && entry.options !== undefined && (typeof entry.options !== 'object' || entry.options === null)) {
        errors.push(`plugins[${i}].options 必须是对象`);
      }
    }
    for (const [i, rule] of (fragment.permissions ?? []).entries()) {
      if (typeof rule?.action !== 'string' || !rule.action) errors.push(`permissions[${i}].action 必须是字符串`);
      if (typeof rule?.resource !== 'string') errors.push(`permissions[${i}].resource 必须是字符串`);
      if (!['allow', 'deny', 'ask'].includes(rule?.effect)) errors.push(`permissions[${i}].effect 必须是 allow / deny / ask`);
    }
  } else {
    if (!Array.isArray(fragment.plugin) || !fragment.plugin.length) errors.push('缺少 plugin 数组');
    for (const [i, entry] of (fragment.plugin ?? []).entries()) {
      if (typeof entry !== 'string') errors.push(`plugin[${i}] 必须是文件 URL 字符串`);
    }
    const permission = fragment.permission;
    if (permission !== undefined) {
      if (typeof permission !== 'object' || permission === null) errors.push('permission 必须是对象');
      else for (const [name, effect] of Object.entries(permission)) {
        if (!['ask', 'allow', 'deny'].includes(effect)) errors.push(`permission.${name} 必须是 ask / allow / deny`);
      }
    }
  }
  return errors;
}

export async function runSelfTest(job, ctx) {
  const { entries, configFile, workspace, agents, serverRunning, auditCount, zip } = ctx;
  const checks = [];
  // Only the majors this build asked for are asserted. Testing both unconditionally
  // used to report failures for an entry the user never requested.
  const requested = String(ctx.opencodeMajor ?? (entries.v1 && entries.v2 ? 'both' : entries.v2 ? '2' : '1'));
  const wantV1 = requested !== '2';
  const wantV2 = requested !== '1';
  const hostMajor = ctx.hostMajor == null ? null : String(ctx.hostMajor);
  const hostVersion = ctx.hostVersion ?? null;

  job.plan(['加载生成的插件模块', '校验 2.x 接口形状', '校验 1.x 接口形状', '校验打包内容', '端到端身份验证', '校验拒绝与隔离路径']);

  await job.step('校验打包内容', async () => {
    if (!zip) { skip(checks, 'zip-integrity', 'ZIP 携带最新服务端与示例', '本次自检未提供 ZIP'); return; }
    // ZIP entries are stored (method 0), so file names and file content appear
    // verbatim in the buffer and a byte search is a faithful check.
    await check(checks, 'zip-integrity', 'ZIP 携带服务端全部模块（含 context.mjs）与业务工具示例',
      a => a.pass,
      () => {
        const missing = ['server/lib/server.mjs', 'server/lib/context.mjs', 'server/lib/sdk.mjs',
          'server/examples/business-tools.mjs', 'server/bin/serve.mjs', 'identity/registry.json']
          .filter(name => !zip.includes(Buffer.from(name)));
        return { pass: missing.length === 0, actual: missing.length ? `缺失 ${missing.join(', ')}` : '6/6 全部在包内' };
      });
    await check(checks, 'zip-logic', '打包的 server.mjs 是最新逻辑（runWithIdentity / async dispatch）',
      a => a.has,
      () => {
        const text = zip.toString('latin1');
        return { has: text.includes('runWithIdentity(') && text.includes('await dispatch('), actual: null };
      });
  });

  const v2 = await job.step('加载生成的插件模块', async () => {
    const result = {};
    if (entries.v2) {
      const mod = await import(pathToFileURL(path.join(entries.v2, 'index.js')).href);
      result.v2 = mod.default;
    }
    if (entries.v1) {
      const mod = await import(pathToFileURL(entries.v1).href);
      result.v1 = mod.default;
    }
    return result;
  });

  if (hostMajor) {
    await check(checks, 'host-version', `生成的插件覆盖实测宿主 OpenCode ${hostVersion ?? hostMajor + '.x'}`, '包含',
      async () => (requested === 'both' || requested === hostMajor) ? '包含' : `只生成了 ${requested}.x`);
  }

  // The fragment is what the user pastes into opencode.json; a shape the host
  // rejects would only surface after deployment, so assert it here.
  for (const [key, major] of [['v2', 2], ['v1', 1]]) {
    const fragment = ctx.fragments?.[key]?.content;
    if (!fragment) continue;
    await check(checks, `${key}-fragment`, `${major}.x 配置片段符合宿主字段形状`, '无错误', async () => {
      const errors = validateFragment(fragment, major);
      return errors.length ? errors.join('；') : '无错误';
    });
  }

  await job.step('校验 2.x 接口形状', async () => {
    if (!v2.v2) {
      if (wantV2) checks.push({ id: 'v2-load', name: '2.x 插件入口', expect: '存在', actual: '未生成 2.x 入口', pass: false, ms: 0 });
      else skip(checks, 'v2-load', '2.x 插件入口', '本次只生成 1.x，跳过');
      return;
    }
    await check(checks, 'v2-shape', '2.x 入口导出 id 与 setup(ctx)', a => a.hasSetup && a.id === 'local-mcp-agent-identity', async () => ({
      id: v2.v2.id, hasSetup: typeof v2.v2.setup === 'function',
    }));
    const added = [];
    const fake = {
      options: { configFile },
      location: { directory: workspace },
      app: { version: hostVersion ?? '2.2.5', platform: process.platform },
      agent: { id: agents[0].agentName },
      // 2.2.5 Registration.dispose() is async.
      tool: { transform: async ed => { await ed({ add: t => added.push(t) }); return { async dispose() {} }; } },
      session: { get: async ({ sessionID }) => ({ id: sessionID, location: { directory: workspace } }) },
      permission: { assert: async () => ({ approved: true }) },
    };
    let cleanup;
    let setupError = null;
    try { cleanup = await v2.v2.setup(fake); } catch (e) { setupError = e; }
    checks.push({ id: 'v2-setup', name: '2.x setup(ctx) 在 2.2.5 形状的上下文里完成注册', expect: '无异常',
      actual: setupError ? `抛出：${setupError.message}` : '正常返回', pass: !setupError, ms: 0 });
    await check(checks, 'v2-tools', '2.x 注册 identity_whoami / identity_echo / identity_add', 'identity_add,identity_echo,identity_whoami',
      async () => added.map(t => t.name).sort().join(','));
    await check(checks, 'v2-codemode', '三个工具均以普通工具提供（codemode=false）', true,
      async () => added.every(t => t.options && t.options.codemode === false));
    // OpenCode 2.2.5 Plugin.setup may return Cleanup | void; a returned value that
    // is not a function would be invoked as a cleanup callback and throw on unload.
    await check(checks, 'v2-cleanup', 'setup 返回可调用的清理函数（或 undefined）', true,
      async () => cleanup === undefined || typeof cleanup === 'function');
    if (typeof cleanup === 'function') { try { await cleanup(); } catch { /* unload must not throw */ } }
    v2.added = added;
    v2.ctx = fake;
  });

  await job.step('校验 1.x 接口形状', async () => {
    if (!v2.v1) {
      if (wantV1) checks.push({ id: 'v1-load', name: '1.x 插件入口', expect: '存在', actual: '未生成 1.x 入口', pass: false, ms: 0 });
      else skip(checks, 'v1-load', '1.x 插件入口', '本次只生成 2.x，跳过');
      return;
    }
    await check(checks, 'v1-shape', '1.x 默认导出为函数并带 id', a => a.isFunction && a.id === 'local-mcp-agent-identity',
      async () => ({ isFunction: typeof v2.v1 === 'function', id: v2.v1.id }));
    const plugin = await v2.v1({ directory: workspace });
    const tools = plugin.tool ?? plugin;
    await check(checks, 'v1-tools', '1.x 返回三个工具', 'identity_add,identity_echo,identity_whoami',
      async () => Object.keys(tools).sort().join(','));
    v2.v1tools = tools;
  });

  await job.step('端到端身份验证', async step => {
    if (!serverRunning) { step.detail = '服务端未启动，跳过端到端检查'; return; }
    const build = agents[0];
    const plan = agents[1] ?? agents[0];

    if (v2.added?.length) {
      step.detail = `2.x ${build.agentName} whoami`;
      const who = v2.added.find(t => t.name === 'identity_whoami');
      await check(checks, 'e2e-v2-whoami', `2.x 调用 whoami 返回 ${build.agentName} 的服务端身份`, a => a.uuid === build.uuid && a.agentName === build.agentName && a.verified === true,
        async () => JSON.parse((await who.execute({}, { agent: build.agentName, sessionID: 'studio-1', messageID: 'm1', id: 'c1', signal: signal() })).content).identity);

      step.detail = `2.x ${plan.agentName} add`;
      const add = v2.added.find(t => t.name === 'identity_add');
      const result = await add.execute({ a: 12, b: 30 }, { agent: plan.agentName, sessionID: 'studio-1', messageID: 'm2', id: 'c2', signal: signal() });
      const payload = JSON.parse(result.content);
      checks.push({ id: 'e2e-v2-add', name: `2.x ${plan.agentName} 调用 add(12,30)`, expect: '42 + 该 Agent 的 UUID', actual: `sum=${payload.sum}, uuid=${payload.identity.uuid.slice(0, 8)}…`,
        pass: payload.sum === 42 && payload.identity.uuid === plan.uuid, ms: 0 });
    }

    if (v2.v1tools) {
      step.detail = `1.x ${plan.agentName} whoami`;
      const raw = await v2.v1tools.identity_whoami.execute({}, {
        agent: plan.agentName, sessionID: 'studio-2', messageID: 'm3', directory: workspace, abort: signal(), ask: async () => true,
      });
      const identity = JSON.parse(raw).identity;
      checks.push({ id: 'e2e-v1-whoami', name: `1.x 调用 whoami 返回 ${plan.agentName} 的服务端身份`, expect: plan.uuid, actual: identity.uuid,
        pass: identity.uuid === plan.uuid && identity.verified === true, ms: 0 });
    }
  });

  await job.step('校验拒绝与隔离路径', async () => {
    if (!v2.added?.length) return;
    const who = v2.added.find(t => t.name === 'identity_whoami');

    await expectReject(checks, 'guard-agent', '未登记的 Agent 名称', /not registered/i,
      () => who.execute({}, { agent: 'not-registered-agent', sessionID: 's', messageID: 'm', id: 'c', signal: signal() }));

    // Foreign workspace: session directory differs from config workspaceRoot.
    const added = [];
    const before = auditCount?.() ?? 0;
    let assertCalls = 0;
    const foreign = {
      options: { configFile },
      location: { directory: workspace },
      // 2.2.5 Registration.dispose() is async.
      tool: { transform: async ed => { await ed({ add: t => added.push(t) }); return { async dispose() {} }; } },
      session: { get: async ({ sessionID }) => ({ id: sessionID, location: { directory: path.dirname(workspace) } }) },
      permission: { assert: async () => { assertCalls++; return {}; } },
    };
    const mod = await import(pathToFileURL(path.join(entries.v2, 'index.js')).href);
    await mod.default.setup(foreign);
    await expectReject(checks, 'guard-workspace', '会话目录不在批准工作区内', /Unapproved session workspace/i,
      () => added.find(t => t.name === 'identity_whoami').execute({}, { agent: agents[0].agentName, sessionID: 's', messageID: 'm', id: 'c', signal: signal() }));
    checks.push({ id: 'guard-workspace-preflight', name: '工作区校验先于审批（未弹出审批）', expect: 'assert 调用次数 0', actual: String(assertCalls), pass: assertCalls === 0, ms: 0 });

    // Denied approval must not reach the server.
    const denied = {
      ...foreign,
      session: { get: async ({ sessionID }) => ({ id: sessionID, location: { directory: workspace } }) },
      permission: { assert: async () => { throw new Error('user denied'); } },
    };
    const deniedTools = [];
    denied.tool = { transform: async ed => { await ed({ add: t => deniedTools.push(t) }); return { dispose() {} }; } };
    await mod.default.setup(denied);
    const beforeDenied = auditCount?.() ?? 0;
    await expectReject(checks, 'guard-approval', '审批被拒绝时中止调用', /denied/i,
      () => deniedTools.find(t => t.name === 'identity_whoami').execute({}, { agent: agents[0].agentName, sessionID: 's', messageID: 'm', id: 'c', signal: signal() }));
    if (auditCount) {
      const delta = auditCount() - beforeDenied;
      checks.push({ id: 'guard-approval-norequest', name: '拒绝审批后未发出 MCP 请求', expect: '0 条审计记录', actual: `${delta} 条`, pass: delta === 0, ms: 0 });
    }

    // Aborted signal.
    const ac = new AbortController();
    ac.abort();
    await expectReject(checks, 'guard-abort', '调用前已取消', /abort/i,
      () => who.execute({}, { agent: agents[0].agentName, sessionID: 's', messageID: 'm', id: 'c', signal: ac.signal }));
  });

  return {
    checks,
    passed: checks.filter(c => c.pass).length,
    failed: checks.filter(c => !c.pass && !c.skip).length,
    skipped: checks.filter(c => c.skip).length,
    requested,
    hostVersion,
  };
}
