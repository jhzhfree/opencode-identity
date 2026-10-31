/**
 * Per-request proof: the signature that authorises a single HTTP call.
 *
 * An identity attestation proves *who* an agent is; a proof proves that this
 * particular request body, sent to this particular endpoint at this particular
 * moment, was produced by the holder of the agent's private key. It is bound to
 * the body hash, the method, the path and the audience URL, and carries a unique
 * `jti` so it cannot be replayed.
 *
 * The token format is byte-compatible with the reference lab implementation
 * (`X-Agent-Proof`), so SDK-signed requests work against servers built on the
 * original package and vice versa.
 */
import { sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { BASE64URL, deepFreeze, fromBase64url, sha256Hex } from './canonical.mjs';
import { AUTH_FAILED, fail } from './errors.mjs';
import { SIGNING_ALG, keyId as computeKeyId, importPrivateKey, importPublicKey } from './keys.mjs';
import { AGENT_PATTERN, assertAgentName } from './identity.mjs';
import { UUID_PATTERN, assertUuid, generateUuid } from './uuid.mjs';

/** HTTP header carrying the proof. */
export const HEADER = 'X-Agent-Proof';
/** Header `typ` for request proofs. */
export const PROOF_TYP = 'mcp-agent-proof+jwt';
/** Proof schema version. */
export const PROOF_VERSION = 1;
/** Maximum accepted token length. */
export const MAX_TOKEN_LENGTH = 8192;
/** Default lifetime in seconds. */
export const DEFAULT_TTL = 30;
/** Maximum lifetime a verifier accepts. */
export const MAX_TTL = 30;
/** Allowed clock skew (seconds) between signer and verifier. */
export const CLOCK_SKEW = 5;

const sec = (now = Date.now()) => Math.floor(now / 1000);

/**
 * @param {Buffer|string|Uint8Array} body
 * @returns {string} hex SHA-256, identical to the reference implementation
 */
export function bodyHash(body) {
  return sha256Hex(Buffer.isBuffer(body) ? body : Buffer.from(body));
}

/**
 * Restrict the audience to a loopback MCP endpoint.
 * @param {string|URL} value
 * @returns {string} normalised href
 */
export function assertLocalEndpoint(value) {
  let url;
  try { url = new URL(String(value)); } catch { fail('ENDPOINT_INVALID', 'Server URL is not a valid URL'); }
  const hostOk = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!hostOk || url.protocol !== 'http:' || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password) {
    fail('ENDPOINT_INVALID', 'Local only: http://127.0.0.1:<port>/mcp (localhost / [::1] also supported)');
  }
  return url.href;
}

/**
 * Sign one request.
 * @param {{
 *   uuid: string, agentName: string, privateKey: unknown,
 *   url: string, body: Buffer|string, method?: string,
 *   sessionId?: string, invocationId?: string, now?: number, ttl?: number, jti?: string,
 * }} input
 * @returns {string} the `X-Agent-Proof` token
 */
export function createProof({
  uuid, agentName, privateKey, url, body,
  method = 'POST', sessionId = 'terminal', invocationId = generateUuid(),
  now = sec(), ttl = DEFAULT_TTL, jti = generateUuid(),
}) {
  assertUuid(uuid);
  assertAgentName(agentName);
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL) fail('PROOF_TTL', `ttl must be 1..${MAX_TTL} seconds`);
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 128) fail('PROOF_SESSION', 'sessionId must be 1..128 characters');

  const key = importPrivateKey(privateKey);
  const { n, e } = key.export({ format: 'jwk' });
  const kid = computeKeyId({ kty: 'RSA', n, e });
  const target = new URL(assertLocalEndpoint(url));

  const claims = {
    ver: PROOF_VERSION,
    sub: uuid,
    agent: agentName,
    aud: target.href,
    iat: now,
    exp: now + ttl,
    jti,
    session_id: sessionId,
    invocation_id: invocationId,
    method,
    path: target.pathname,
    body_sha256: bodyHash(body),
  };
  const header = { alg: SIGNING_ALG, typ: PROOF_TYP, kid };
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${input}.${nodeSign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

/**
 * Replay protection: nonces live until their proof expires.
 */
export function createReplayStore({ limit = 10000 } = {}) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  return {
    /** @param {number} now */
    prune(now) {
      for (const [key, exp] of seen) if (exp <= now) seen.delete(key);
    },
    /**
     * @param {string} nonce
     * @param {number} exp
     * @param {number} now
     * @returns {boolean} true when the nonce was fresh and is now recorded
     */
    use(nonce, exp, now) {
      this.prune(now);
      if (seen.has(nonce) || seen.size >= limit) return false;
      seen.set(nonce, exp);
      return true;
    },
    get size() { return seen.size; },
  };
}

/**
 * Verify a request proof.
 *
 * @param {unknown} token value of `X-Agent-Proof`
 * @param {{
 *   resolveAgent: (uuid: string) => ({ uuid: string, agentName: string, kid: string, publicJwk: unknown, enabled?: boolean } | null | undefined),
 *   url: string, body: Buffer|string, method?: string,
 *   replay?: ReturnType<typeof createReplayStore>, now?: number,
 *   maxTtl?: number, clockSkew?: number,
 * }} options
 * @returns {Readonly<{ uuid: string, agentName: string, kid: string, sessionId: string, invocationId: string, verified: true }>}
 */
export function verifyProof(token, {
  resolveAgent, url, body, method = 'POST',
  replay, now = sec(), maxTtl = MAX_TTL, clockSkew = CLOCK_SKEW,
}) {
  if (typeof resolveAgent !== 'function') fail('PROOF_CONFIG', 'resolveAgent(uuid) is required to verify a proof');
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) fail('PROOF_MALFORMED', AUTH_FAILED);
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some(segment => !BASE64URL.test(segment))) fail('PROOF_MALFORMED', AUTH_FAILED);

  /** @type {Record<string, any>} */
  let header;
  /** @type {Record<string, any>} */
  let claims;
  try {
    header = JSON.parse(fromBase64url(segments[0]).toString('utf8'));
    claims = JSON.parse(fromBase64url(segments[1]).toString('utf8'));
  } catch { fail('PROOF_MALFORMED', AUTH_FAILED); }

  if (!header || header.alg !== SIGNING_ALG || header.typ !== PROOF_TYP) fail('PROOF_ALG', AUTH_FAILED);
  if (!claims || claims.ver !== PROOF_VERSION) fail('PROOF_VERSION', AUTH_FAILED);
  if (typeof claims.sub !== 'string' || !UUID_PATTERN.test(claims.sub)) fail('PROOF_UUID', AUTH_FAILED);
  if (typeof claims.agent !== 'string' || !AGENT_PATTERN.test(claims.agent)) fail('PROOF_AGENT', AUTH_FAILED);

  const registered = resolveAgent(claims.sub);
  if (!registered) fail('PROOF_UNKNOWN_AGENT', AUTH_FAILED);
  if (registered.enabled !== true) fail('PROOF_DISABLED', AUTH_FAILED);
  if (registered.agentName !== claims.agent) fail('PROOF_AGENT_MISMATCH', AUTH_FAILED);
  if (registered.kid !== header.kid) fail('PROOF_KID_MISMATCH', AUTH_FAILED);

  let key;
  try { key = importPublicKey(registered.publicJwk); } catch { fail('PROOF_KEY', AUTH_FAILED); }
  const jwk = key.export({ format: 'jwk' });
  if (computeKeyId({ kty: 'RSA', n: jwk.n, e: jwk.e }) !== header.kid) fail('PROOF_KID_MISMATCH', AUTH_FAILED);

  const signedInput = `${segments[0]}.${segments[1]}`;
  if (!nodeVerify('RSA-SHA256', Buffer.from(signedInput), key, fromBase64url(segments[2]))) fail('PROOF_SIGNATURE', AUTH_FAILED);

  if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) fail('PROOF_TIME', AUTH_FAILED);
  if (claims.exp <= now) fail('PROOF_EXPIRED', AUTH_FAILED);
  if (claims.iat > now + clockSkew) fail('PROOF_NOT_YET_VALID', AUTH_FAILED);
  if (claims.exp <= claims.iat || claims.exp - claims.iat > maxTtl) fail('PROOF_TIME', AUTH_FAILED);

  if (claims.aud !== assertLocalEndpoint(url)) fail('PROOF_AUDIENCE', AUTH_FAILED);
  if (claims.method !== method) fail('PROOF_METHOD', AUTH_FAILED);
  if (claims.path !== '/mcp') fail('PROOF_PATH', AUTH_FAILED);
  if (claims.body_sha256 !== bodyHash(body)) fail('PROOF_BODY', AUTH_FAILED);
  if (typeof claims.jti !== 'string' || !UUID_PATTERN.test(claims.jti)) fail('PROOF_JTI', AUTH_FAILED);
  if (typeof claims.invocation_id !== 'string' || !UUID_PATTERN.test(claims.invocation_id)) fail('PROOF_INVOCATION', AUTH_FAILED);
  if (typeof claims.session_id !== 'string' || claims.session_id.length < 1 || claims.session_id.length > 128) fail('PROOF_SESSION', AUTH_FAILED);

  if (replay) {
    const nonce = `${claims.sub}:${header.kid}:${claims.jti}`;
    if (!replay.use(nonce, claims.exp, now)) fail('PROOF_REPLAY', AUTH_FAILED);
  }

  return deepFreeze({
    uuid: claims.sub,
    agentName: claims.agent,
    kid: header.kid,
    sessionId: claims.session_id,
    invocationId: claims.invocation_id,
    verified: /** @type {const} */ (true),
  });
}

/**
 * Build a `resolveAgent` from a validated registry.
 * @param {{ agents: Array<{ uuid: string, agentName: string, kid: string, publicJwk: unknown, enabled: boolean }> }} registry
 */
export function registryResolver(registry) {
  const index = new Map(registry.agents.map(agent => [agent.uuid, agent]));
  return (uuid) => index.get(uuid);
}
