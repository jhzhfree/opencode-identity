/**
 * Contract tests for the AKB V2 client against the server rules that are easy to
 * get wrong: signed target with a gateway prefix, proof TTL, and error mapping.
 * These deliberately avoid the protected-file generator, so they stay fast on
 * hosts where Windows ACL hardening is slow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  createAkbProof,
  validateAkbBinding,
} from "../packages/identity-sdk/src/akb.mjs";
import { generateKeyPair } from "../packages/identity-sdk/src/keys.mjs";
import { mcp, publicPathPrefixOf, apiUrl } from "../lib/akb/client.mjs";

const decode = (token) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

async function bindingFor(agentId, origin) {
  return validateAkbBinding(
    {
      policyId: "17",
      applicationPrincipalId: "123",
      bindingId: agentId,
      externalAgentId: agentId,
      runtimeAgentKey: agentId,
      issuer: "https://akb.local/agent-identity",
      audience: "akb-external-api",
      resource: origin,
      platformId: "akb-service",
      installationId: "install",
      workspaceId: "scope",
    },
    { endpoint: origin, agentId },
  );
}

test("signed target carries the gateway public path prefix", async () => {
  const { privateKey } = await generateKeyPair();
  const agentId = crypto.randomUUID();
  const origin = "http://127.0.0.1:65500";
  const binding = await bindingFor(agentId, origin);
  const signed = (url, publicPathPrefix) =>
    decode(
      createAkbProof({
        binding,
        privateKey,
        serviceKey: "synthetic_key",
        url,
        body: "{}",
        sessionId: "s",
        terminalAgent: "build",
        publicPathPrefix,
      }),
    ).request_binding.target;

  // apiUrl() composes serverUrl + prefix + "/api/mcp", so the prefix is only in the prefix.
  assert.equal(signed(origin + "/api/mcp", "/gateway"), "/gateway/api/mcp");
  assert.equal(signed(origin + "/api/mcp", ""), "/api/mcp");
  assert.equal(signed(origin + "/api/mcp?x=1", ""), "/api/mcp?x=1");
  assert.throws(
    () =>
      createAkbProof({
        binding,
        privateKey,
        serviceKey: "k",
        url: origin + "/api/mcp",
        body: "{}",
        sessionId: "s",
        terminalAgent: "build",
        publicPathPrefix: "gateway",
      }),
    /Invalid AKB proof parameters/,
  );
});

test("proof TTL stays inside the 60s server window by default", async () => {
  const { privateKey } = await generateKeyPair();
  const agentId = crypto.randomUUID();
  const binding = await bindingFor(agentId, "http://127.0.0.1:65500");
  const claims = decode(
    createAkbProof({
      binding,
      privateKey,
      serviceKey: "synthetic_key",
      url: "http://127.0.0.1:65500/api/mcp",
      body: "{}",
      sessionId: "s",
      terminalAgent: "build",
    }),
  );
  assert.equal(claims.exp - claims.iat, 30);
  assert.ok(claims.exp - claims.iat <= 60);
});

test("public path prefix and API URL are validated and composed", () => {
  assert.equal(publicPathPrefixOf(undefined), "");
  assert.equal(publicPathPrefixOf("/gateway"), "/gateway");
  for (const bad of ["gateway", "/gateway/", "/a b", 7])
    assert.throws(() => publicPathPrefixOf(bad), /publicPathPrefix/, `${bad}`);
  const config = { serverUrl: "http://kb.example", publicPathPrefix: "/gw" };
  assert.equal(apiUrl(config, "/api/mcp"), "http://kb.example/gw/api/mcp");
  assert.equal(
    apiUrl({ serverUrl: "http://kb.example" }, "/api/mcp"),
    "http://kb.example/api/mcp",
  );
});

test("permission failures and oversized bodies surface distinct codes", async () => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      requests.push({ url: req.url, assertion: !!req.headers["x-akb-workload-assertion"] });
      if (req.url === "/too-large") {
        res.writeHead(413, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ code: "REQUEST_TOO_LARGE" }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32001, message: "Agent is not authorized" },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const agentId = crypto.randomUUID();
  const { privateKey, publicJwk } = await generateKeyPair();
  const config = { serverUrl: origin, publicPathPrefix: "", timeoutMs: 10000 };
  const ctx = {
    agent: { uuid: agentId, binding: await bindingFor(agentId, origin), publicJwk },
    key: privateKey,
    serviceKey: "synthetic_key",
    invocation: {
      sessionId: "s",
      terminalAgent: "build",
      invocationId: crypto.randomUUID(),
    },
  };
  await assert.rejects(
    () => mcp(config, ctx, "tools/call", { name: "knowledge_search", arguments: {} }),
    (error) => {
      assert.match(error.message, /AKB_FORBIDDEN/);
      assert.match(error.message, /not authorized/);
      return true;
    },
  );
  assert.equal(requests[0].assertion, true);
  const { requestJson } = await import("../lib/akb/client.mjs");
  await assert.rejects(
    () =>
      requestJson(origin + "/too-large", {
        serviceKey: "synthetic_key",
        body: { hello: "world" },
      }),
    /REQUEST_TOO_LARGE/,
  );
  await new Promise((resolve) => server.close(resolve));
});

test("body digest binds the exact bytes that are sent", async () => {
  const { privateKey } = await generateKeyPair();
  const agentId = crypto.randomUUID();
  const binding = await bindingFor(agentId, "http://127.0.0.1:65500");
  const body = JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call" });
  const claims = decode(
    createAkbProof({
      binding,
      privateKey,
      serviceKey: "synthetic_key",
      url: "http://127.0.0.1:65500/api/mcp",
      body,
      sessionId: "s",
      terminalAgent: "build",
    }),
  );
  assert.equal(
    claims.request_binding.body_sha256,
    createHash("sha256").update(Buffer.from(body)).digest("hex"),
  );
});
