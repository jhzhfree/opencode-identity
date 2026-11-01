import { fixture } from "./support/akb-fixture.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, cp, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateAkbBundle } from "../lib/akb/generator.mjs";
import { invokeAkb, loadAkbConfig } from "../lib/akb/client.mjs";
import { installAkbPlugin } from "../lib/akb/installer.mjs";
import { createV1Plugin } from "../lib/akb/plugin-v1.mjs";
import { setupV2 } from "../lib/akb/plugin-v2.mjs";
import { Effect } from "effect";

const context = (f, agentName = "build") => ({
  agentName,
  directory: f.workspace,
  sessionId: "session-" + agentName,
  messageId: "message-" + agentName,
  signal: new AbortController().signal,
});

test("generated bundle is self-contained, secret-free and rejects unverified or wrong Agent identities", async (t) => {
  const f = await fixture(t),
    zip = await readFile(f.result.zipFile);
  assert.equal(zip.includes(Buffer.from("BEGIN PRIVATE KEY")), false);
  assert.equal(zip.includes(Buffer.from(f.key)), false);
  const entry = await readFile(
    path.join(f.result.bundleDir, "plugin-v1.mjs"),
    "utf8",
  );
  assert.ok(!entry.includes("/workspace/"));
  await assert.rejects(
    invokeAkb(f.result.configFile, context(f), "akb_search", {
      query: "hello",
    }),
    /enrollment/,
  );
  await f.enroll("build");
  const output = await invokeAkb(
    f.result.configFile,
    context(f),
    "akb_search",
    { query: "中文问题", agentName: "plan", uuid: f.result.agents[1].uuid },
  );
  assert.equal(output.data.structuredContent.agentId, f.result.agents[0].uuid);
  await assert.rejects(
    invokeAkb(f.result.configFile, context(f, "unknown"), "akb_search", {
      query: "x",
    }),
    /not allowed/,
  );
  await assert.rejects(
    invokeAkb(
      f.result.configFile,
      { ...context(f), directory: f.root },
      "akb_search",
      { query: "x" },
    ),
    /workspace/,
  );
  await assert.rejects(
    invokeAkb(f.result.configFile, context(f), "akb_search", {
      query: "x",
      knowledgeBaseId: "KB_DENIED",
    }),
    /RPC_ERROR/,
  );
  f.registry.get(f.result.agents[0].uuid).enabled = false;
  await assert.rejects(
    invokeAkb(f.result.configFile, context(f), "akb_search", { query: "x" }),
    /PROOF_INVALID/,
  );
});

test("V1 Promise and Effect permission APIs preserve the executing Agent and reject denied approvals", async (t) => {
  const f = await fixture(t);
  await f.enroll("build");
  await f.enroll("plan");
  const plugin = await createV1Plugin(
    { directory: f.workspace },
    { root: pathToFileURL(f.result.bundleDir + path.sep) },
  );
  const make = (agent, ask) => ({
    agent,
    sessionID: "s-" + agent,
    messageID: "m-" + agent,
    directory: f.workspace,
    abort: new AbortController().signal,
    ask,
  });
  const results = await Promise.all([
    plugin.tool.akb_search.execute(
      { query: "A" },
      make("build", () => Promise.resolve()),
    ),
    plugin.tool.akb_search.execute(
      { query: "B" },
      make("plan", () => Effect.succeed(undefined)),
    ),
  ]);
  assert.equal(JSON.parse(results[0]).agentId, f.result.agents[0].uuid);
  assert.equal(JSON.parse(results[1]).agentId, f.result.agents[1].uuid);
  const count = f.requests.length;
  await assert.rejects(
    plugin.tool.akb_search.execute(
      { query: "x" },
      make("build", () => Promise.reject(new Error("denied"))),
    ),
    /denied/,
  );
  await assert.rejects(
    plugin.tool.akb_search.execute({ query: "x" }, make("build", undefined)),
    /approval API/,
  );
  assert.equal(f.requests.length, count);
});

test("V2 checks live session workspace, permission source, abort, disposal and concurrency", async (t) => {
  const f = await fixture(t);
  await f.enroll("build");
  await f.enroll("plan");
  const tools = new Map(),
    approvals = [];
  let wrong = false,
    disposed = false;
  const ctx = {
    location: { directory: f.workspace },
    session: {
      get: async ({ sessionID }) => ({
        id: sessionID,
        location: { directory: wrong ? f.root : f.workspace },
      }),
    },
    permission: {
      assert: async (v) => {
        approvals.push(v);
      },
    },
    tool: {
      transform: async (editor) => {
        editor({ add: (t) => tools.set(t.name, t) });
        return {
          dispose: () => {
            disposed = true;
          },
        };
      },
    },
  };
  const dispose = await setupV2(ctx, {
    root: pathToFileURL(f.result.bundleDir + path.sep),
  });
  const make = (agent) => ({
    agent,
    sessionID: "s-" + agent,
    messageID: "m-" + agent,
    id: "call-" + agent,
    signal: new AbortController().signal,
  });
  const outputs = await Promise.all(
    ["build", "plan"].map((agent) =>
      tools.get("akb_search").execute({ query: "x" }, make(agent)),
    ),
  );
  assert.notEqual(outputs[0].metadata.agentId, outputs[1].metadata.agentId);
  assert.equal(approvals[0].source.type, "tool");
  assert.ok(approvals.every((p) => p.source.id === "call-" + p.agent));
  wrong = true;
  await assert.rejects(
    tools.get("akb_search").execute({ query: "x" }, make("build")),
    /workspace/,
  );
  wrong = false;
  const cancelled = make("build");
  cancelled.signal = AbortSignal.abort(new Error("cancelled"));
  await assert.rejects(
    tools.get("akb_search").execute({ query: "x" }, cancelled),
    /cancelled/,
  );
  await assert.rejects(
    setupV2(
      { ...ctx, permission: {} },
      { root: pathToFileURL(f.result.bundleDir + path.sep) },
    ),
    /permission.assert/,
  );
  const before = f.requests.length;
  ctx.permission.assert = async () => {
    const config = JSON.parse(await readFile(f.result.configFile));
    config.knowledgeBaseId = "KB_CHANGED";
    await writeFile(f.result.configFile, JSON.stringify(config), {
      mode: 0o600,
    });
  };
  await assert.rejects(
    tools.get("akb_search").execute({ query: "x" }, make("build")),
    /changed during approval/,
  );
  assert.equal(f.requests.length, before);
  dispose();
  assert.equal(disposed, true);
});

test("installer preserves settings, backs up config, is idempotent and supports relocated bundles", async (t) => {
  const f = await fixture(t),
    global = path.join(f.root, "global", "opencode.json");
  await mkdir(path.dirname(global), { mode: 0o700 });
  await writeFile(
    global,
    JSON.stringify({
      model: "keep-this",
      plugin: ["other-plugin"],
      permission: { bash: "ask" },
    }),
    { mode: 0o600 },
  );
  const relocated = path.join(f.root, "relocated");
  await cp(f.result.bundleDir, relocated, { recursive: true });
  const result = await installAkbPlugin({
    bundleDir: relocated,
    configFile: f.result.configFile,
    major: "1",
    opencodeConfig: global,
    installDependencies: false,
  });
  await installAkbPlugin({
    bundleDir: relocated,
    major: "1",
    opencodeConfig: global,
    installDependencies: false,
  });
  const cfg = JSON.parse(await readFile(global));
  assert.equal(cfg.model, "keep-this");
  assert.equal(cfg.plugin.length, 2);
  assert.equal(cfg.permission.bash, "ask");
  assert.equal(cfg.permission.akb_search, "ask");
  assert.equal(JSON.parse(await readFile(result.backup)).model, "keep-this");
  assert.equal((await loadAkbConfig(f.result.configFile)).agents.length, 2);
  await assert.rejects(
    installAkbPlugin({
      bundleDir: relocated,
      major: "2",
      opencodeConfig: global,
      installDependencies: false,
    }),
    /1.x format/,
  );
  await assert.rejects(
    generateAkbBundle({
      workspace: f.workspace,
      dataDir: path.join(f.workspace, "bad"),
      agents: ["build"],
      serverUrl: "http://127.0.0.1:1",
    }),
    /outside/,
  );
});

test("JSONC installation preserves comments and upgrades only the managed plugin", async (t) => {
  const f = await fixture(t),
    global = path.join(f.root, "global.jsonc");
  const text =
    '// keep this comment\n{"model":"a,}","permission":{"bash":"ask",},}\n';
  await writeFile(global, text, { mode: 0o600 });
  const first = await installAkbPlugin({
    bundleDir: f.result.bundleDir,
    major: "1",
    opencodeConfig: global,
    installDependencies: false,
  });
  assert.equal(await readFile(first.backup, "utf8"), text);
  assert.ok((await readFile(global, "utf8")).includes("// keep this comment"));
  const moved = path.join(f.root, "new-plugin");
  await cp(f.result.bundleDir, moved, { recursive: true });
  await installAkbPlugin({
    bundleDir: moved,
    configFile: f.result.configFile,
    major: "1",
    opencodeConfig: global,
    installDependencies: false,
  });
  const { parseJsonc } = await import("../lib/jsonc.mjs");
  const config = parseJsonc(await readFile(global, "utf8"));
  assert.equal(config.model, "a,}");
  assert.equal(config.plugin.length, 1);
  assert.ok(config.plugin[0].includes("new-plugin"));
});

test("AKB endpoints reject public HTTP and credentials in URLs", async () => {
  const { akbEndpoint } = await import("../packages/identity-sdk/src/akb.mjs");
  assert.throws(() => akbEndpoint("http://example.com/api/mcp"), /HTTPS/);
  assert.throws(
    () => akbEndpoint("http://10.attacker.example", { allowPrivateHttp: true }),
    /HTTPS/,
  );
  assert.throws(
    () => akbEndpoint("https://user:password@example.com"),
    /HTTPS/,
  );
  assert.throws(() => akbEndpoint("http://192.168.1.2"), /HTTPS/);
  assert.equal(
    akbEndpoint("http://192.168.1.2/api/mcp", { allowPrivateHttp: true }),
    "http://192.168.1.2",
  );
  assert.equal(
    akbEndpoint("https://kb.example/gateway/api/mcp"),
    "https://kb.example/gateway",
  );
});

test("installer preserves a scalar default permission policy", async (t) => {
  const f = await fixture(t),
    file = path.join(f.root, "scalar-config.json");
  await writeFile(file, JSON.stringify({ permission: "deny" }), {
    mode: 0o600,
  });
  await installAkbPlugin({
    bundleDir: f.result.bundleDir,
    major: "1",
    opencodeConfig: file,
    installDependencies: false,
  });
  const result = JSON.parse(await readFile(file));
  assert.equal(result.permission["*"], "deny");
  assert.equal(result.permission.akb_search, "ask");
});

test("a configuration change during approval requires a fresh approval", async (t) => {
  const f = await fixture(t);
  await f.enroll("build");
  const plugin = await createV1Plugin(
    { directory: f.workspace },
    { root: pathToFileURL(f.result.bundleDir + path.sep) },
  );
  const count = f.requests.length;
  await assert.rejects(
    plugin.tool.akb_search.execute(
      { query: "x" },
      {
        agent: "build",
        sessionID: "session",
        messageID: "message",
        directory: f.workspace,
        abort: new AbortController().signal,
        ask: async () => {
          const config = JSON.parse(await readFile(f.result.configFile));
          config.knowledgeBaseId = "KB_OTHER";
          await writeFile(f.result.configFile, JSON.stringify(config), {
            mode: 0o600,
          });
        },
      },
    ),
    /changed during approval/,
  );
  assert.equal(f.requests.length, count);
});

test("canonical KB IDs are enforced at generation, configuration and invocation boundaries", async (t) => {
  const f = await fixture(t);
  await f.enroll("build");
  const before = f.requests.length;
  for (const invalid of [1, "1", "HR-POLICY", "KB_bad/path", ""]) {
    await assert.rejects(
      invokeAkb(f.result.configFile, context(f), "akb_search", {
        query: "q",
        knowledgeBaseId: invalid,
      }),
      /knowledgeBaseId.*KB_/,
    );
  }
  await assert.rejects(
    invokeAkb(f.result.configFile, context(f), "akb_search", {
      query: "q",
      knowledgeBaseId: "KB_HR",
      knowledgeBaseCode: 6,
    }),
    /only knowledgeBaseId/,
  );
  assert.equal(
    f.requests.length,
    before,
    "invalid selectors must not reach AKB",
  );
  for (const invalid of [1, "1", "HR-POLICY"]) {
    await assert.rejects(
      generateAkbBundle({
        workspace: f.workspace,
        dataDir: path.join(f.root, "invalid-bundle"),
        agents: ["build"],
        serverUrl: (await loadAkbConfig(f.result.configFile)).serverUrl,
        knowledgeBaseId: invalid,
      }),
      /knowledgeBaseId|generation options/,
    );
  }
  const config = JSON.parse(await readFile(f.result.configFile, "utf8"));
  config.knowledgeBaseId = "1";
  await writeFile(f.result.configFile, JSON.stringify(config), { mode: 0o600 });
  await assert.rejects(
    loadAkbConfig(f.result.configFile),
    /knowledgeBaseId.*KB_/,
  );
});

test("discovery supplies the canonical ID when no default base is configured", async (t) => {
  const f = await fixture(t);
  await f.enroll("build");
  const config = JSON.parse(await readFile(f.result.configFile, "utf8"));
  config.knowledgeBaseId = "";
  await writeFile(f.result.configFile, JSON.stringify(config), { mode: 0o600 });
  const catalog = await invokeAkb(
    f.result.configFile,
    context(f),
    "akb_bases",
    {},
  );
  const id = catalog.data.structuredContent[0].knowledgeBaseId;
  assert.equal(id, "KB_HR");
  await invokeAkb(f.result.configFile, context(f), "akb_search", {
    query: "啊",
    knowledgeBaseId: id,
    topK: 3,
  });
  await invokeAkb(f.result.configFile, context(f), "akb_query", {
    query: "啊",
    knowledgeBaseId: id,
  });
  const calls = f.requests
    .filter((r) => r.body?.method === "tools/call")
    .map((r) => r.body.params);
  assert.deepEqual(calls.at(-2), {
    name: "knowledge_search",
    arguments: { query: "啊", knowledgeBaseId: "KB_HR", topK: 3 },
  });
  assert.deepEqual(calls.at(-1), {
    name: "knowledge_query",
    arguments: { question: "啊", knowledgeBaseId: "KB_HR" },
  });
});
