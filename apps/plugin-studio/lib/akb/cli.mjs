import { parseArgs } from "node:util";
import path from "node:path";
import { readJSON } from "./files.mjs";
import { generateAkbBundle } from "./generator.mjs";
import { verifyAgent, invokeAkb, loadAkbConfig } from "./client.mjs";
import { saveVerifiedBinding, installAkbPlugin } from "./installer.mjs";
const options = {
  workspace: { type: "string" },
  out: { type: "string" },
  agents: { type: "string" },
  server: { type: "string" },
  base: { type: "string" },
  major: { type: "string" },
  "service-key-env": { type: "string" },
  "allow-private-http": { type: "boolean" },
  config: { type: "string" },
  agent: { type: "string" },
  query: { type: "string" },
  bundle: { type: "string" },
  "opencode-config": { type: "string" },
  "no-deps": { type: "boolean" },
};
async function configPath(values) {
  if (values.config) return path.resolve(values.config);
  const bundle = path.resolve(values.bundle || ".");
  const location = await readJSON(path.join(bundle, "config-location.json"));
  return path.resolve(bundle, location.configFile);
}
try {
  const command = process.argv[2];
  if (!command || command === "help") {
    console.log(
      "build --workspace PATH --out PATH --agents build,plan --server HTTPS_URL [--base KB_ID] [--major both]\nverify --config PATH --agent NAME\nquery --config PATH --agent NAME --query TEXT [--base KB_ID]\ninstall --bundle PATH --major 1|2 --opencode-config GLOBAL_JSON [--config PATH]",
    );
  } else {
    const { values: v } = parseArgs({
      args: process.argv.slice(3),
      options,
      strict: true,
    });
    let result;
    if (command === "build")
      result = await generateAkbBundle({
        workspace: v.workspace,
        dataDir: v.out,
        agents: v.agents?.split(",").map((s) => s.trim()),
        serverUrl: v.server,
        knowledgeBaseId: v.base || "",
        serviceKeyEnv: v["service-key-env"] || "AKB_SERVICE_KEY",
        opencodeMajor: v.major || "both",
        allowPrivateHttp: v["allow-private-http"] === true,
      });
    else if (command === "verify") {
      const file = await configPath(v);
      result = await verifyAgent(file, v.agent);
      await saveVerifiedBinding(file, v.agent, result.binding);
      result = {
        verified: true,
        agentId: result.agentId,
        agentName: result.agentName,
        kid: result.kid,
      };
    } else if (command === "query") {
      const file = await configPath(v);
      const config = await loadAkbConfig(file);
      result = await invokeAkb(
        file,
        {
          agentName: v.agent,
          directory: config.workspaceRoot,
          sessionId: "management:" + v.agent,
          messageId: "cli-query",
          signal: new AbortController().signal,
        },
        "akb_search",
        v.base ? { query: v.query, knowledgeBaseId: v.base } : { query: v.query },
      );
    } else if (command === "install")
      result = await installAkbPlugin({
        bundleDir: path.resolve(v.bundle || "."),
        configFile: v.config,
        major: v.major,
        opencodeConfig: v["opencode-config"],
        installDependencies: !v["no-deps"],
      });
    else throw new Error("Unknown command. Run help for usage.");
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
