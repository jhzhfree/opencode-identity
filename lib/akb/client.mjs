import { readJSON, protectedRead, outside } from "./files.mjs";
import { realpath } from "node:fs/promises";
import { createPrivateKey, randomUUID } from "node:crypto";
import path from "node:path";
import {
  akbEndpoint,
  validateAkbBinding,
  createAkbProof,
  AKB_HEADER,
  AKB_PROFILE,
} from "../../packages/identity-sdk/src/akb.mjs";
import { publicJwkOf } from "../../packages/identity-sdk/src/keys.mjs";

export const TOOLS = Object.freeze({
  akb_search: "knowledge_search",
  akb_query: "knowledge_query",
  akb_bases: "list_knowledge_bases",
  akb_identity: "get_agent_identity",
});
/** AKB's public selector is a generated KB_ identifier, never a numeric primary key or alias. */
export function validateKnowledgeBaseId(
  value = "",
  { allowEmpty = false } = {},
) {
  if (allowEmpty && value === "") return value;
  if (typeof value !== "string" || !/^KB_[A-Za-z0-9]{1,125}$/.test(value))
    throw new Error(
      "knowledgeBaseId must be a KB_ identifier from akb_bases; numeric IDs and aliases are not supported",
    );
  return value;
}

/** One-line, newline-free server message; keeps scope/permission failures diagnosable. */
function rpcMessage(error) {
  const text = String(error?.message ?? "").replace(/[\r\n]+/g, " ").trim();
  return text ? ": " + text.slice(0, 300) : "";
}

/** Gateway prefix that AKB prepends to the request URI when verifying request_binding.target. */
export function publicPathPrefixOf(value = "") {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string")
    throw new Error("publicPathPrefix must be a string");
  const prefix = value.trim();
  if (prefix === "") return "";
  if (!/^\/[A-Za-z0-9/_.:-]{0,255}$/.test(prefix) || prefix.endsWith("/"))
    throw new Error("publicPathPrefix must start with / and not end with /");
  return prefix;
}
/** Every AKB API call carries the same public prefix, including signed targets. */
export function apiUrl(config, suffix) {
  return config.serverUrl + (config.publicPathPrefix ?? "") + suffix;
}

export async function loadAkbConfig(filename, workspace) {
  const config = await readJSON(filename, workspace);
  if (
    config.version !== 1 ||
    config.target !== "akb" ||
    typeof config.workspaceRoot !== "string" ||
    !path.isAbsolute(config.workspaceRoot) ||
    !Array.isArray(config.agents) ||
    !config.agents.length ||
    config.agents.length > 100 ||
    !/^[A-Z_][A-Z0-9_]{0,127}$/.test(config.serviceKeyEnv)
  )
    throw new Error("Invalid protected AKB configuration");
  validateKnowledgeBaseId(config.knowledgeBaseId, { allowEmpty: true });
  config.workspaceRoot = await realpath(config.workspaceRoot);
  if (!outside(config.workspaceRoot, await realpath(filename)))
    throw new Error(
      "Keep the protected AKB configuration outside the Agent workspace",
    );
  if (
    workspace &&
    path.relative(await realpath(workspace), config.workspaceRoot) !== ""
  )
    throw new Error("Unapproved OpenCode workspace");
  config.serverUrl = akbEndpoint(config.serverUrl, {
    allowPrivateHttp: config.allowPrivateHttp === true,
  });
  if (
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 1000 ||
    config.timeoutMs > 60000
  )
    throw new Error("timeoutMs must be 1000..60000");
  config.publicPathPrefix = publicPathPrefixOf(config.publicPathPrefix);
  if (
    new Set(config.agents.map((a) => a.agentName)).size !==
      config.agents.length ||
    new Set(config.agents.map((a) => a.uuid)).size !== config.agents.length
  )
    throw new Error("Agent mappings must be unique");
  config.agents = config.agents.map((a) => {
    if (
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(a.agentName) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        a.uuid,
      ) ||
      typeof a.privateKeyFile !== "string"
    )
      throw new Error("Invalid Agent mapping");
    return Object.freeze({
      ...a,
      privateKeyFile: path.resolve(path.dirname(filename), a.privateKeyFile),
      ...(a.binding
        ? {
            binding: validateAkbBinding(a.binding, {
              endpoint: config.serverUrl,
              agentId: a.uuid,
            }),
          }
        : {}),
    });
  });
  return Object.freeze({ ...config, agents: Object.freeze(config.agents) });
}
export function serviceCredential(config) {
  const value = process.env[config.serviceKeyEnv];
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(value))
    throw new Error(
      `Set ${config.serviceKeyEnv} in the OpenCode process environment; never put the service Key in tool arguments`,
    );
  return value;
}
export function invocationSignal(signal, timeoutMs) {
  return AbortSignal.any([
    signal || new AbortController().signal,
    AbortSignal.timeout(timeoutMs),
  ]);
}
export async function requestJson(
  url,
  {
    serviceKey,
    body,
    method = body === undefined ? "GET" : "POST",
    binding,
    privateKey,
    invocation,
    signal,
    protocolVersion,
    notification = false,
    publicPathPrefix = "",
  },
) {
  signal?.throwIfAborted();
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = { "X-API-Key": serviceKey, Accept: "application/json" };
  if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (binding)
    headers[AKB_HEADER] = createAkbProof({
      binding,
      privateKey,
      serviceKey,
      url,
      method,
      body: raw,
      publicPathPrefix,
      ...invocation,
    });
  const res = await fetch(url, {
    method,
    headers,
    body: method === "GET" ? undefined : raw,
    redirect: "error",
    signal,
  });
  const trace = res.headers.get("x-trace-id");
  if (!res.ok) {
    await res.body?.cancel();
    const code =
      {
        401: "CREDENTIAL_OR_PROOF_INVALID",
        403: "FORBIDDEN",
        413: "REQUEST_TOO_LARGE",
        429: "RATE_LIMITED",
        503: "UPSTREAM_UNAVAILABLE",
      }[res.status] || "AKB_HTTP_ERROR";
    throw Object.assign(
      new Error(
        `${code} (HTTP ${res.status})${
          trace && /^[A-Za-z0-9_-]{1,128}$/.test(trace) ? " trace=" + trace : ""
        }`,
      ),
      { code, status: res.status },
    );
  }
  if (notification) {
    if (![202, 204].includes(res.status))
      throw new Error("Invalid MCP notification response");
    await res.body?.cancel();
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body || []) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) {
      await res.body?.cancel().catch(() => {});
      throw new Error("AKB response exceeds 2 MiB");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("AKB returned invalid JSON");
  }
}
export async function mcp(
  config,
  { agent, key, serviceKey, invocation, signal, protocolVersion },
  method,
  params = {},
) {
  const id = randomUUID();
  const result = await requestJson(apiUrl(config, "/api/mcp"), {
    serviceKey,
    binding: [
      "initialize",
      "tools/list",
      "ping",
      "notifications/initialized",
    ].includes(method)
      ? undefined
      : agent.binding,
    privateKey: key,
    invocation,
    signal,
    protocolVersion,
    publicPathPrefix: config.publicPathPrefix ?? "",
    body: { jsonrpc: "2.0", id, method, params },
  });
  if (!result || result.jsonrpc !== "2.0" || result.id !== id || result.error)
    throw new Error(
      result?.error
        ? `${Number(result.error.code) === -32001 ? "AKB_FORBIDDEN" : "AKB_RPC_ERROR"} (${Number(result.error.code) || "unknown"})${rpcMessage(result.error)}`
        : "Invalid AKB JSON-RPC response",
    );
  if (result.result?.isError)
    throw new Error(
      "AKB_TOOL_ERROR: check Agent permissions and knowledge base scope",
    );
  return result.result;
}
export async function initializeMcp(config, ctx) {
  const init = await mcp(config, ctx, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "opencode-akb-identity", version: "1.2.0" },
  });
  if (
    !init?.capabilities?.tools ||
    !["2025-03-26", "2025-06-18", "2025-11-25"].includes(init.protocolVersion)
  )
    throw new Error("Unsupported AKB MCP protocol or missing tools capability");
  ctx.protocolVersion = init.protocolVersion;
  await requestJson(apiUrl(config, "/api/mcp"), {
    serviceKey: ctx.serviceKey,
    signal: ctx.signal,
    protocolVersion: ctx.protocolVersion,
    publicPathPrefix: config.publicPathPrefix ?? "",
    notification: true,
    body: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });
  return init;
}
export async function verifyAgent(configFile, agentName, { signal } = {}) {
  const config = await loadAkbConfig(configFile);
  const agent = config.agents.find((a) => a.agentName === agentName);
  if (!agent) throw new Error("Agent is not mapped in this connection");
  const serviceKey = serviceCredential(config),
    key = createPrivateKey(
      await protectedRead(agent.privateKeyFile, config.workspaceRoot),
    );
  const bounded = invocationSignal(signal, config.timeoutMs);
  const response = await requestJson(
    apiUrl(config, "/api/v1/external/identity/configuration") +
      "?" +
      new URLSearchParams({ agentId: agent.uuid }),
    { serviceKey, signal: bounded },
  );
  if (response.success !== true)
    throw new Error("AKB identity configuration was rejected");
  const binding = validateAkbBinding(response.data, {
    endpoint: config.serverUrl,
    agentId: agent.uuid,
  });
  const invocation = {
    sessionId: "setup:" + agentName,
    terminalAgent: agentName,
    invocationId: randomUUID(),
  };
  const status = await requestJson(
    apiUrl(config, "/api/v1/external/identity/status"),
    {
      serviceKey,
      binding,
      privateKey: key,
      invocation,
      signal: bounded,
      publicPathPrefix: config.publicPathPrefix ?? "",
    },
  );
  const expected = publicJwkOf(key);
  // AKB accepts ACTIVE and RETIRING keys; RETIRING is still usable until valid_until.
  if (
    status.success !== true ||
    status.data?.agentId !== agent.uuid ||
    status.data?.kid !== expected.kid ||
    !["ACTIVE", "RETIRING"].includes(status.data?.keyStatus) ||
    status.data?.proofProfile !== AKB_PROFILE ||
    String(status.data?.policyId) !== binding.policyId
  )
    throw new Error("AKB did not verify this Agent and active key");
  const verified = { ...agent, binding };
  const ctx = { agent: verified, key, serviceKey, invocation, signal: bounded };
  await initializeMcp(config, ctx);
  // tools/list is a discovery call without a signed identity, so AKB only lists
  // the tools this service Key is scoped for; get_agent_identity appears in the
  // list only when the caller already carries a verified identity, and is
  // therefore checked through tools/call below instead.
  const listed = await mcp(config, ctx, "tools/list");
  const names = Array.isArray(listed?.tools)
    ? listed.tools.map((t) => t.name)
    : [];
  if (
    !names.length ||
    !names.some((n) => ["knowledge_search", "list_knowledge_bases"].includes(n))
  )
    throw new Error(
      "AKB MCP advertises no readable knowledge tool for this service Key; check LIST/SEARCH scopes",
    );
  const identity = await mcp(config, ctx, "tools/call", {
    name: "get_agent_identity",
    arguments: {},
  });
  let described = identity.structuredContent;
  if (!described) {
    try {
      described = JSON.parse(
        identity.content?.find((x) => x.type === "text")?.text,
      );
    } catch {}
  }
  if (described?.agentId !== agent.uuid || described?.kid !== expected.kid)
    throw new Error("MCP identity does not match the enrolled Agent");
  return {
    binding,
    kid: expected.kid,
    agentId: agent.uuid,
    agentName,
    verified: true,
  };
}
export function invocationScope(config, agentName) {
  const agent = config.agents.find((a) => a.agentName === agentName);
  return JSON.stringify({
    serverUrl: config.serverUrl,
    workspaceRoot: config.workspaceRoot,
    serviceKeyEnv: config.serviceKeyEnv,
    knowledgeBaseId: config.knowledgeBaseId,
    agent,
  });
}
export async function invokeAkb(
  configFile,
  captured,
  toolName,
  args,
  expectedScope,
) {
  const config = await loadAkbConfig(configFile, captured.directory);
  if (
    expectedScope !== undefined &&
    invocationScope(config, captured.agentName) !== expectedScope
  )
    throw new Error(
      "AKB configuration changed during approval; review and retry",
    );
  const agent = config.agents.find((a) => a.agentName === captured.agentName);
  if (!agent)
    throw new Error(
      "Executing OpenCode Agent is not allowed to use this AKB connection",
    );
  if (!agent.binding)
    throw new Error(
      "Complete AKB public-key enrollment and run verify before using this plugin",
    );
  if (!Object.hasOwn(TOOLS, toolName))
    throw new Error("Unsupported AKB read-only tool");
  const key = createPrivateKey(
    await protectedRead(agent.privateKeyFile, config.workspaceRoot),
  );
  const values = {};
  if (["akb_search", "akb_query"].includes(toolName)) {
    if (
      typeof args.query !== "string" ||
      !args.query.trim() ||
      args.query.length > 4000
    )
      throw new Error("query must be 1..4000 characters");
    values[toolName === "akb_query" ? "question" : "query"] = args.query;
    if (args.topK !== undefined) {
      if (!Number.isInteger(args.topK) || args.topK < 1 || args.topK > 50)
        throw new Error("topK must be 1..50");
      values.topK = args.topK;
    }
    if (Object.hasOwn(args, "knowledgeBaseCode"))
      throw new Error("Use only knowledgeBaseId with a KB_ identifier");
    // An explicit argument must be a canonical KB_ id; an empty default in the
    // protected config means "let AKB choose the Key's default base" (omitted).
    const explicit = Object.hasOwn(args, "knowledgeBaseId");
    const kb = validateKnowledgeBaseId(
      explicit ? args.knowledgeBaseId : config.knowledgeBaseId,
      { allowEmpty: !explicit },
    );
    if (kb) values.knowledgeBaseId = kb;
  }
  // Identity can only come from captured host context and protected mapping, never args.
  const invocation = {
    sessionId: captured.sessionId,
    messageId: captured.messageId,
    terminalAgent: captured.agentName,
    invocationId: randomUUID(),
  };
  const signal = invocationSignal(captured.signal, config.timeoutMs);
  const ctx = {
    agent,
    key,
    serviceKey: serviceCredential(config),
    invocation,
    signal,
  };
  await initializeMcp(config, ctx);
  return {
    data: await mcp(config, ctx, "tools/call", {
      name: TOOLS[toolName],
      arguments: values,
    }),
    metadata: {
      agentName: captured.agentName,
      agentId: agent.uuid,
      invocationId: invocation.invocationId,
    },
  };
}
