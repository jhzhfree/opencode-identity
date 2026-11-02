import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateKeyPair } from "../../../packages/identity-sdk/src/keys.mjs";
import { createAkbProof } from "../../../packages/identity-sdk/src/akb.mjs";
const exec = promisify(execFile);
if (!process.env.AKB_REPO)
  throw new Error(
    "Set AKB_REPO to a compiled AKB checkout (run mvn test first)",
  );
const repo = path.resolve(process.env.AKB_REPO),
  reports = path.join(repo, "backend/target/surefire-reports");
const report = (await readdir(reports)).find(
  (f) => f.startsWith("TEST-") && f.endsWith(".xml"),
);
const xml = await readFile(path.join(reports, report), "utf8");
const matched = xml.match(/<property name="java.class.path" value="([^"]+)"/);
if (!matched) throw new Error("AKB surefire report has no compiled classpath");
const classpath = matched[1]
  .replaceAll("&amp;", "&")
  .replaceAll("&quot;", '"')
  .replaceAll("&#10;", "\n");
const root = await mkdtemp(path.join(tmpdir(), "akb-java-interop-"));
try {
  const pair = await generateKeyPair(),
    uuid = "e21cce9c-1b16-4ab8-a76a-bb761df919b8";
  const binding = {
    policyId: "17",
    applicationPrincipalId: "123",
    bindingId: "21",
    externalAgentId: uuid,
    runtimeAgentKey: uuid,
    issuer: "https://akb.local/agent-identity",
    audience: "akb-external-api",
    resource: "https://akb.example",
    platformId: "akb-service",
    installationId: "install",
    workspaceId: "workspace",
  };
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "1",
    method: "tools/call",
    params: {
      name: "knowledge_search",
      arguments: { query: "中文查询 🔎", knowledgeBaseId: "KB_HR" },
    },
  });
  const serviceKey = "synthetic_java_interop_service_key";
  const proof = createAkbProof({
    binding,
    privateKey: pair.privateKey,
    serviceKey,
    url: "https://akb.example/gateway/api/mcp",
    body,
    sessionId: "test-session",
    terminalAgent: "build",
    messageId: "message",
  });
  const fixture = path.join(root, "fixture.json");
  await writeFile(
    fixture,
    JSON.stringify({
      binding,
      publicJwk: pair.publicJwk,
      proof,
      body,
      serviceKey,
    }),
    { mode: 0o600 },
  );
  const source = fileURLToPath(
    new URL("./java/AkbVerifierProbe.java", import.meta.url),
  );
  await exec(
    "java",
    [
      "-m",
      "jdk.compiler/com.sun.tools.javac.Main",
      "-cp",
      classpath,
      "-d",
      root,
      source,
    ],
    { timeout: 60000, maxBuffer: 1024 * 1024 },
  );
  const result = await exec(
    "java",
    ["-cp", root + path.delimiter + classpath, "AkbVerifierProbe", fixture],
    { timeout: 60000, maxBuffer: 1024 * 1024 },
  );
  console.log(result.stdout);
} finally {
  await rm(root, { recursive: true, force: true });
}
