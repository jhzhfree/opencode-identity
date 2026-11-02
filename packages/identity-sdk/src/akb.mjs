/** AKB AGENT_KEY_RS256_V2. Kept separate from the local lab's X-Agent-Proof. */
import { sign, randomUUID, createHash } from "node:crypto";
import { isIP } from "node:net";
import { importPrivateKey, publicJwkOf } from "./keys.mjs";

export const AKB_HEADER = "X-AKB-Workload-Assertion";
export const AKB_PROFILE = "AGENT_KEY_RS256_V2";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function akbEndpoint(value, { allowPrivateHttp = false } = {}) {
  const u = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  const privateIp =
    (isIP(u.hostname) === 4 &&
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)) ||
    /^\[(fc|fd)[0-9a-f:]+\]$/i.test(u.hostname);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        (loopback || (allowPrivateHttp && privateIp))
      ))
  )
    throw new Error(
      "AKB endpoint requires HTTPS (HTTP only for loopback or explicitly allowed private IPs)",
    );
  u.pathname = u.pathname
    .replace(/\/+$/, "")
    .replace(/\/api\/(mcp|v1\/external)$/, "");
  return u.href.replace(/\/$/, "");
}
export function validateAkbBinding(value, { endpoint, agentId }) {
  const fields = [
    "policyId",
    "applicationPrincipalId",
    "bindingId",
    "externalAgentId",
    "runtimeAgentKey",
    "issuer",
    "audience",
    "resource",
    "platformId",
    "installationId",
    "workspaceId",
  ];
  if (
    !value ||
    fields.some(
      (k) =>
        typeof value[k] !== "string" ||
        !value[k] ||
        value[k].length > 2048 ||
        /[\x00-\x1f\x7f]/.test(value[k]),
    ) ||
    !uuid(value.externalAgentId) ||
    value.externalAgentId !== agentId ||
    value.resource !== new URL(endpoint).origin
  )
    throw new Error(
      "AKB signing configuration does not match this endpoint and registered Agent",
    );
  return Object.freeze(Object.fromEntries(fields.map((k) => [k, value[k]])));
}
export function createAkbProof({
  binding,
  privateKey,
  serviceKey,
  url,
  method = "POST",
  body = "",
  sessionId,
  invocationId = randomUUID(),
  terminalAgent,
  messageId,
  now = Math.floor(Date.now() / 1000),
  ttl = 30,
  jti = randomUUID(),
  publicPathPrefix = "",
}) {
  if (
    !binding ||
    !uuid(binding.externalAgentId) ||
    !uuid(invocationId) ||
    !uuid(jti) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > 60 ||
    typeof serviceKey !== "string" ||
    !/^[A-Za-z0-9_-]{1,512}$/.test(serviceKey) ||
    typeof publicPathPrefix !== "string" ||
    (publicPathPrefix !== "" &&
      !/^\/[A-Za-z0-9/_.:-]{0,255}$/.test(publicPathPrefix))
  )
    throw new Error("Invalid AKB proof parameters");
  for (const [name, value] of [
    ["session", sessionId],
    ["terminal", terminalAgent],
    ...(messageId === undefined ? [] : [["message", messageId]]),
  ])
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 128 ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      throw new Error(`Invalid ${name} identifier`);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(terminalAgent))
    throw new Error("Invalid terminal Agent");
  validateAkbBinding(binding, {
    endpoint: binding.resource,
    agentId: binding.externalAgentId,
  });
  const target = new URL(url);
  if (
    target.username ||
    target.password ||
    target.hash ||
    target.origin !== binding.resource ||
    target.pathname.length + target.search.length > 2048 ||
    !["GET", "POST"].includes(method)
  )
    throw new Error("Request does not match AKB resource");
  const key = importPrivateKey(privateKey);
  const jwk = publicJwkOf(key);
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (bits > 4096 || key.asymmetricKeyDetails?.publicExponent !== 65537n)
    throw new Error("AKB requires RSA 3072..4096 with exponent 65537");
  const claims = {
    ver: 2,
    iss: binding.issuer,
    aud: binding.audience,
    resource: binding.resource,
    policy_id: binding.policyId,
    azp: binding.applicationPrincipalId,
    sub: "agent:" + binding.externalAgentId,
    platform_id: binding.platformId,
    installation_id: binding.installationId,
    workspace_id: binding.workspaceId,
    runtime_agent: binding.runtimeAgentKey,
    terminal_agent: terminalAgent,
    session_id: sessionId,
    invocation_id: invocationId,
    ...(messageId ? { message_id: messageId } : {}),
    iat: now,
    exp: now + ttl,
    jti,
    credential_sha256: hash(serviceKey),
    request_binding: {
      method,
      // The server compares publicPathPrefix + requestURI + query, so a gateway
      // prefix must be part of the signed target or every call fails with 401.
      target: publicPathPrefix + target.pathname + target.search,
      body_sha256: hash(Buffer.isBuffer(body) ? body : Buffer.from(body)),
    },
  };
  const head = { alg: "RS256", typ: "akb-agent-proof+jwt", kid: jwk.kid };
  const input = [head, claims]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  const token =
    input +
    "." +
    sign("RSA-SHA256", Buffer.from(input), key).toString("base64url");
  if (token.length > 8192)
    throw new Error("AKB proof exceeds the server limit");
  return token;
}
