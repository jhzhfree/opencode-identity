import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { generateAkbBundle } from "../../lib/akb/generator.mjs";
import { verifyAgent } from "../../lib/akb/client.mjs";
import { saveVerifiedBinding } from "../../lib/akb/installer.mjs";
const digest = (b) => createHash("sha256").update(b).digest("hex");
export async function fixture(t, {agentIdentityRequired=true}={}) {
  const root = await mkdtemp(path.join(tmpdir(), "akb-plugin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "work");
  await mkdir(workspace, { mode: 0o700 });
  const registry = new Map(),
    seen = new Set(),
    requests = [];
  const key = "synthetic_akb_service_key_for_tests";
  process.env.AKB_TEST_KEY = key;
  t.after(() => delete process.env.AKB_TEST_KEY);
  const server = createServer(async (req, res) => {
    const bytes = [];
    for await (const b of req) bytes.push(b);
    const raw = Buffer.concat(bytes);
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      assert.equal(req.headers["x-api-key"], key);
      assert.equal(req.headers.authorization, undefined);
      const url = new URL(req.url, "http://" + req.headers.host);
      if (url.pathname === "/gateway/api/v1/external/connection") return send(200,{success:true,data:{connected:true,agentIdentityRequired}});
      if (url.pathname === "/gateway/api/v1/external/identity/configuration") {
        const a = registry.get(url.searchParams.get("agentId"));
        assert.ok(a);
        return send(200, {
          success: true,
          data: {
            policyId: "17",
            applicationPrincipalId: "123",
            bindingId: a.uuid,
            externalAgentId: a.uuid,
            runtimeAgentKey: a.uuid,
            issuer: "https://akb.local/agent-identity",
            audience: "akb-external-api",
            resource: url.origin,
            platformId: "akb-service",
            installationId: "install",
            workspaceId: "scope",
          },
        });
      }
      const discovery = raw.length ? JSON.parse(raw) : null;
      if (
        url.pathname.endsWith("/api/mcp") &&
        !req.headers["x-akb-workload-assertion"]
      ) {
        if (discovery?.method === "initialize")
          return send(200, {
            jsonrpc: "2.0",
            id: discovery.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
            },
          });
        if (discovery?.method === "tools/list")
          return send(200, {
            jsonrpc: "2.0",
            id: discovery.id,
            result: {
              tools: [
                "knowledge_search",
                "knowledge_query",
                "list_knowledge_bases",
                "get_agent_identity",
              ].map((name) => ({ name, inputSchema: { type: "object" } })),
            },
          });
        if (discovery?.method === "notifications/initialized") {
          assert.equal(req.headers["mcp-protocol-version"], "2025-06-18");
          res.writeHead(202);
          return res.end();
        }
      }
      const token = req.headers["x-akb-workload-assertion"];
      assert.equal(typeof token, "string");
      const [h, c, s] = token.split(".");
      const header = JSON.parse(Buffer.from(h, "base64url")),
        claims = JSON.parse(Buffer.from(c, "base64url"));
      const a = registry.get(claims.sub?.slice(6));
      assert.ok(a);
      assert.equal(a.enabled, true);
      assert.equal(header.typ, "akb-agent-proof+jwt");
      assert.equal(header.alg, "RS256");
      assert.equal(header.kid, a.publicJwk.kid);
      assert.ok(
        verifySignature(
          "RSA-SHA256",
          Buffer.from(h + "." + c),
          createPublicKey({ key: a.publicJwk, format: "jwk" }),
          Buffer.from(s, "base64url"),
        ),
      );
      assert.equal(claims.ver, 2);
      assert.equal(claims.runtime_agent, a.uuid);
      assert.equal(claims.credential_sha256, digest(key));
      assert.equal(claims.policy_id, "17");
      assert.equal(claims.azp, "123");
      assert.equal(claims.resource, url.origin);
      assert.equal(claims.request_binding.method, req.method);
      assert.equal(claims.request_binding.target, req.url);
      assert.equal(claims.request_binding.body_sha256, digest(raw));
      assert.ok(
        claims.exp > Math.floor(Date.now() / 1000) &&
          claims.exp - claims.iat <= 60,
      );
      assert.ok(!seen.has(claims.jti));
      seen.add(claims.jti);
      requests.push({ claims, body: raw.length ? JSON.parse(raw) : null });
      const identity = {
        agentId: a.uuid,
        kid: a.publicJwk.kid,
        keyStatus: "ACTIVE",
        policyId: 17,
        proofProfile: "AGENT_KEY_RS256_V2",
        terminalAgentName: claims.terminal_agent,
      };
      if (url.pathname.endsWith("/identity/status"))
        return send(200, { success: true, data: identity });
      const rpc = JSON.parse(raw);
      assert.equal(req.headers["mcp-protocol-version"], "2025-06-18");
      let result;
      if (rpc.method === "initialize")
        result = { protocolVersion: "2025-03-26", capabilities: { tools: {} } };
      else if (rpc.method === "tools/list")
        result = {
          tools: [
            "knowledge_search",
            "knowledge_query",
            "list_knowledge_bases",
            "get_agent_identity",
          ].map((name) => ({ name, inputSchema: { type: "object" } })),
        };
      else {
        const name = rpc.params.name,
          args = rpc.params.arguments;
        if (
          ["knowledge_search", "knowledge_query"].includes(name) &&
          (typeof args.knowledgeBaseId !== "string" ||
            !/^KB_[A-Za-z0-9]{1,125}$/.test(args.knowledgeBaseId) ||
            Object.hasOwn(args, "knowledgeBaseCode"))
        )
          return send(200, {
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32602, message: "invalid knowledgeBaseId" },
          });
        if (args.knowledgeBaseId === "KB_DENIED")
          return send(200, {
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32003, message: "forbidden" },
          });
        const value =
          name === "get_agent_identity"
            ? identity
            : name === "list_knowledge_bases"
            ? [{ knowledgeBaseId: "KB_HR", name: "Policies" }]
            : {
                answer: "查询结果 " + claims.terminal_agent,
                knowledgeBaseId: args.knowledgeBaseId,
                agentId: a.uuid,
              };
        result = {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        };
      }
      send(200, { jsonrpc: "2.0", id: rpc.id, result });
    } catch (error) {
      send(401, { error: "proof rejected" });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const serverUrl = `http://127.0.0.1:${server.address().port}/gateway/api/mcp`;
  const progress=[];
  const result = await generateAkbBundle({
    onProgress:event=>progress.push(event),
    workspace,
    dataDir: path.join(root, "secure"),
    agents: ["build", "plan"],
    serverUrl,
    knowledgeBaseId: "KB_HR",
    serviceKeyEnv: "AKB_TEST_KEY",
  });
  for (const a of result.agents) {
    const record = JSON.parse(
      await readFile(path.join(result.dataDir, a.enrollmentFile)),
    );
    registry.set(a.uuid, { ...record, uuid: a.uuid, enabled: true });
  }
  async function enroll(name) {
    const result = await verifyAgent(resultFile(), name);
    await saveVerifiedBinding(resultFile(), name, result.binding);
    return result;
  }
  const resultFile = () => result.configFile;
  return { root, workspace, result, registry, requests, enroll, key, progress };
}
