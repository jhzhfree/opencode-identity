/** Install the actual ZIP, with its own npm dependencies, then execute both entries. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fixture } from "./support/akb-fixture.mjs";
const cleanups = [];
try {
  const f = await fixture({ after: (fn) => cleanups.push(fn) });
  await f.enroll("build");
  await f.enroll("plan");
  const destination = path.join(f.root, "unzipped-plugin");
  await mkdir(destination, { mode: 0o700 });
  const zip = await readFile(f.result.zipFile);
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(
      zip.readUInt16LE(offset + 8),
      0,
      "Generated ZIP uses store-only entries",
    );
    const size = zip.readUInt32LE(offset + 18),
      nameLength = zip.readUInt16LE(offset + 26),
      extra = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString();
    assert.ok(!name.split("/").includes("..") && !path.isAbsolute(name));
    const begin = offset + 30 + nameLength + extra,
      file = path.join(destination, name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, zip.subarray(begin, begin + size), { mode: 0o600 });
    offset = begin + size;
  }
  const { installAkbPlugin } = await import(
    pathToFileURL(path.join(destination, "lib/akb/installer.mjs"))
  );
  const first = await installAkbPlugin({
    bundleDir: destination,
    configFile: f.result.configFile,
    major: "1",
    opencodeConfig: path.join(f.root, "global-v1.json"),
  });
  assert.equal(first.installed, true);
  const entry = await import(
    pathToFileURL(path.join(destination, "plugin-v1.mjs"))
  );
  const plugin = await entry.default({ directory: f.workspace });
  const result = await plugin.tool.akb_search.execute(
    { query: "artifact search" },
    {
      agent: "build",
      sessionID: "bundle-session",
      messageID: "bundle-message",
      directory: f.workspace,
      abort: new AbortController().signal,
      ask: () => Promise.resolve(),
    },
  );
  assert.equal(JSON.parse(result).agentId, f.result.agents[0].uuid);
  const second = await installAkbPlugin({
    bundleDir: destination,
    major: "2",
    opencodeConfig: path.join(f.root, "global-v2.json"),
  });
  assert.equal(second.installed, true);
  const v2 = (
    await import(pathToFileURL(path.join(destination, "opencode-v2/index.js")))
  ).default;
  const tools = new Map();
  const dispose = await v2.setup({
    location: { directory: f.workspace },
    session: {
      get: async ({ sessionID }) => ({
        id: sessionID,
        location: { directory: f.workspace },
      }),
    },
    permission: { assert: async () => {} },
    tool: {
      transform: async (fn) => {
        fn({ add: (t) => tools.set(t.name, t) });
        return { dispose() {} };
      },
    },
  });
  const output = await tools
    .get("akb_search")
    .execute(
      { query: "artifact v2" },
      {
        agent: "plan",
        sessionID: "bundle-session-v2",
        messageID: "bundle-message-v2",
        id: "bundle-call",
        signal: new AbortController().signal,
      },
    );
  assert.equal(JSON.parse(output.content).agentId, f.result.agents[1].uuid);
  dispose();
  console.log(
    "PASS: extracted ZIP installs with its own pinned dependencies and both V1/V2 entries query MCP with distinct enrolled Agent identities",
  );
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}
