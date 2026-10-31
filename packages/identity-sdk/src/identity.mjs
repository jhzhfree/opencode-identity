/**
 * Identity attestation: a detached signature binding an Agent name to a UUID.
 *
 * This is the primitive the whole system is built on. The generator signs
 * `{uuid, agentName, kid, issuedAt}` with the agent's private key and stores the
 * attestation next to the key pair; any consumer that only holds the public key
 * (the MCP server, an auditor, a deployment pipeline) can re-verify it offline
 * and detect a tampered registry where a name was swapped but the key was not.
 *
 * Wire format is a compact three-part token so it can travel as a single string:
 *
 *   base64url(canonical(header)) "." base64url(canonical(claim)) "." base64url(sig)
 *
 * `verifyIdentity` re-canonicalises the claim, so verification does not depend on
 * key order or on how the JSON was transported.
 */
import { sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { BASE64URL, canonicalJSON, deepFreeze, fromBase64url, base64url } from './canonical.mjs';
import { AUTH_FAILED, fail } from './errors.mjs';
import { SIGNING_ALG, keyId as computeKeyId, importPrivateKey, importPublicKey, publicJwkOf } from './keys.mjs';
import { assertUuid } from './uuid.mjs';

/** `typ` header value; distinguishes identity attestations from request proofs. */
export const ATTESTATION_TYP = 'agent-identity+attestation';
/** Schema version of the claim. */
export const ATTESTATION_VERSION = 1;
/** Issuer string recorded in the claim. */
export const ISSUER = 'opencode-identity-sdk';
/** Agent names accepted everywhere: kept identical to the reference implementation. */
export const AGENT_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function assertAgentName(value, label = 'Agent name') {
  if (typeof value !== 'string' || !AGENT_PATTERN.test(value)) {
    fail('AGENT_INVALID', `Invalid ${label}: 1-128 chars of A-Z a-z 0-9 _ . : -`);
  }
  return value;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Build the claim that will be signed.
 * @param {{ uuid: string, agentName: string, kid?: string, issuedAt?: number, audience?: string }} input
 */
export function buildIdentityClaim({ uuid, agentName, kid, issuedAt = nowSeconds(), audience }) {
  assertUuid(uuid);
  assertAgentName(agentName);
  if (!Number.isSafeInteger(issuedAt)) fail('CLAIM_INVALID', 'issuedAt must be integer seconds');
  /** @type {Record<string, unknown>} */
  const claim = { v: ATTESTATION_VERSION, iss: ISSUER, sub: uuid, agent: agentName, iat: issuedAt };
  if (kid) claim.kid = kid;
  if (audience) claim.aud = audience;
  return claim;
}

/**
 * Sign the identity claim with the agent's private key.
 * @param {{ uuid: string, agentName: string, privateKey: unknown, issuedAt?: number, audience?: string }} input
 * @returns {{ version: number, claim: Record<string, unknown>, signature: { alg: string, typ: string, kid: string, value: string }, token: string }}
 */
export function signIdentity({ uuid, agentName, privateKey, issuedAt = nowSeconds(), audience }) {
  const key = importPrivateKey(privateKey);
  const { n, e } = key.export({ format: 'jwk' });
  const kid = computeKeyId({ kty: 'RSA', n, e });
  const claim = buildIdentityClaim({ uuid, agentName, kid, issuedAt, audience });
  const header = { alg: SIGNING_ALG, typ: ATTESTATION_TYP, kid };
  const signingInput = `${base64url(canonicalJSON(header))}.${base64url(canonicalJSON(claim))}`;
  const value = nodeSign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url');
  return {
    version: ATTESTATION_VERSION,
    claim,
    signature: { alg: SIGNING_ALG, typ: ATTESTATION_TYP, kid, value },
    token: `${signingInput}.${value}`,
  };
}

/**
 * Verify an attestation against a public key.
 *
 * Throws `IdentityError` on any failure. The message is always the generic
 * `Agent authentication failed`; inspect `error.code` for the reason:
 * `ATTESTATION_MALFORMED`, `ATTESTATION_ALG`, `ATTESTATION_KID_MISMATCH`,
 * `ATTESTATION_SIGNATURE`, `ATTESTATION_UUID`, `ATTESTATION_AGENT`.
 *
 * @param {unknown} attestation structured attestation, compact token, or raw claim+signature
 * @param {{ publicKey: unknown, expectedUuid?: string, expectedAgent?: string, expectedKid?: string }} options
 * @returns {Readonly<Record<string, unknown>>} the verified claim, deep-frozen
 */
export function verifyIdentity(attestation, { publicKey, expectedUuid, expectedAgent, expectedKid }) {
  const key = importPublicKey(publicKey);
  const jwk = key.export({ format: 'jwk' });
  const actualKid = computeKeyId({ kty: 'RSA', n: jwk.n, e: jwk.e });

  /** @type {{ header: Record<string, unknown>, claim: Record<string, unknown>, signature: string }} */
  let parts;
  try {
    parts = decodeAttestation(attestation);
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error;
    fail('ATTESTATION_MALFORMED', AUTH_FAILED);
  }

  if (parts.header.alg !== SIGNING_ALG || parts.header.typ !== ATTESTATION_TYP) {
    fail('ATTESTATION_ALG', AUTH_FAILED);
  }
  if (parts.header.kid !== actualKid) fail('ATTESTATION_KID_MISMATCH', AUTH_FAILED);
  if (expectedKid && expectedKid !== actualKid) fail('ATTESTATION_KID_MISMATCH', AUTH_FAILED);

  const claim = parts.claim;
  if (claim.v !== ATTESTATION_VERSION || claim.iss !== ISSUER) fail('ATTESTATION_MALFORMED', AUTH_FAILED);
  if (typeof claim.kid !== 'string' || claim.kid !== actualKid) fail('ATTESTATION_KID_MISMATCH', AUTH_FAILED);
  if (typeof claim.sub !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(claim.sub)) {
    fail('ATTESTATION_UUID', AUTH_FAILED);
  }
  if (typeof claim.agent !== 'string' || !AGENT_PATTERN.test(claim.agent)) fail('ATTESTATION_AGENT', AUTH_FAILED);

  const signingInput = `${base64url(canonicalJSON(parts.header))}.${base64url(canonicalJSON(claim))}`;
  const ok = nodeVerify('RSA-SHA256', Buffer.from(signingInput), key, fromBase64url(parts.signature));
  if (!ok) fail('ATTESTATION_SIGNATURE', AUTH_FAILED);

  if (expectedUuid && claim.sub !== expectedUuid) fail('ATTESTATION_UUID', AUTH_FAILED);
  if (expectedAgent && claim.agent !== expectedAgent) fail('ATTESTATION_AGENT', AUTH_FAILED);

  return deepFreeze(claim);
}

/**
 * @param {unknown} attestation
 * @returns {{ header: Record<string, unknown>, claim: Record<string, unknown>, signature: string }}
 */
function decodeAttestation(attestation) {
  if (typeof attestation === 'string') {
    const segments = attestation.split('.');
    if (segments.length !== 3 || segments.some(segment => !BASE64URL.test(segment))) {
      fail('ATTESTATION_MALFORMED', AUTH_FAILED);
    }
    let header;
    let claim;
    try {
      header = JSON.parse(fromBase64url(segments[0]).toString('utf8'));
      claim = JSON.parse(fromBase64url(segments[1]).toString('utf8'));
    } catch { fail('ATTESTATION_MALFORMED', AUTH_FAILED); }
    return { header, claim, signature: segments[2] };
  }
  if (attestation && typeof attestation === 'object') {
    const value = /** @type {{ claim?: unknown, signature?: { value?: unknown, alg?: unknown, typ?: unknown, kid?: unknown } }} */ (attestation);
    if (value.claim && value.signature && typeof value.signature.value === 'string') {
      const claim = /** @type {Record<string, unknown>} */ (value.claim);
      const header = {
        alg: value.signature.alg ?? SIGNING_ALG,
        typ: value.signature.typ ?? ATTESTATION_TYP,
        kid: value.signature.kid ?? claim.kid,
      };
      return { header, claim, signature: value.signature.value };
    }
  }
  fail('ATTESTATION_MALFORMED', AUTH_FAILED);
}

/**
 * Convenience: verify and simultaneously assert the binding matches a registry row.
 * @param {{ uuid: string, agentName: string, kid: string, publicJwk: unknown, attestation?: unknown }} enrollment
 */
export function verifyEnrollment(enrollment) {
  if (!enrollment?.attestation) fail('ATTESTATION_ABSENT', 'Registry entry has no identity attestation');
  const claim = verifyIdentity(enrollment.attestation, {
    publicKey: enrollment.publicJwk,
    expectedUuid: enrollment.uuid,
    expectedAgent: enrollment.agentName,
    expectedKid: enrollment.kid,
  });
  return Object.freeze({ uuid: /** @type {string} */ (claim.sub), agentName: /** @type {string} */ (claim.agent), kid: /** @type {string} */ (claim.kid), issuedAt: claim.iat });
}

/**
 * Normalise "some public key" into one shape.
 *
 * Accepted inputs, because in practice a verifier receives keys in all of them:
 *   - SPKI PEM (`-----BEGIN PUBLIC KEY-----`)
 *   - a public JWK object (`{kty:'RSA', n, e}`), with or without `kid`
 *   - a JSON string of either the JWK itself or `{ publicJwk: … }` / `{ publicKey: … }`
 *   - a private key or private PEM (only its public half is used, never exported as private)
 *   - an existing KeyObject
 *
 * The returned `kid` is always derived from the key material itself, never taken
 * from the input, so a forged `kid` field cannot influence verification.
 *
 * @param {unknown} material
 * @returns {Readonly<{ kid: string, jwk: Record<string, unknown>, pem: string, modulusBits: number }>}
 */
export function normalizePublicKey(material) {
  const parsed = typeof material === 'string' ? parseKeyString(material) : material;
  const key = importPublicKey(parsed);
  const jwk = publicJwkOf(key);
  return Object.freeze({
    kid: jwk.kid,
    jwk,
    pem: key.export({ format: 'pem', type: 'spki' }).toString(),
    modulusBits: /** @type {{ modulusLength?: number }} */ (key.asymmetricKeyDetails)?.modulusLength ?? 0,
  });
}

/**
 * @param {string} raw
 */
function parseKeyString(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return raw;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { fail('KEY_PARSE', 'Public key JSON is not valid JSON'); }
  if (parsed && typeof parsed === 'object') {
    if (parsed.publicJwk && typeof parsed.publicJwk === 'object') return parsed.publicJwk;
    if (parsed.publicKey && typeof parsed.publicKey === 'object') return parsed.publicKey;
    if (parsed.jwk && typeof parsed.jwk === 'object') return parsed.jwk;
  }
  return parsed;
}

/**
 * Verify an attestation using nothing but a public key.
 *
 * This is the API a third party (MCP server, auditor, CI job) uses: it never
 * touches a private key and needs no registry. `verifyIdentity` is the lower
 * level primitive; this wrapper normalises the key and returns the derived key
 * fingerprint alongside the verified claim so the caller can display it.
 *
 * @param {unknown} attestation compact token, structured attestation, or identity.json
 * @param {unknown} publicKey PEM / JWK / JSON string / KeyObject
 * @param {{ expectedUuid?: string, expectedAgent?: string, expectedKid?: string }} [options]
 * @returns {Readonly<{ verified: true, claim: Readonly<Record<string, unknown>>, kid: string, modulusBits: number, publicPem: string, publicJwk: Record<string, unknown> }>}
 */
export function verifyWithPublicKey(attestation, publicKey, options = {}) {
  const key = normalizePublicKey(publicKey);
  const claim = verifyIdentity(attestation, {
    publicKey: key.jwk,
    ...(options.expectedUuid ? { expectedUuid: options.expectedUuid } : {}),
    ...(options.expectedAgent ? { expectedAgent: options.expectedAgent } : {}),
    ...(options.expectedKid ? { expectedKid: options.expectedKid } : {}),
  });
  return Object.freeze({
    verified: /** @type {const} */ (true),
    claim,
    kid: key.kid,
    modulusBits: key.modulusBits,
    publicPem: key.pem,
    publicJwk: key.jwk,
  });
}

/**
 * Decode an attestation WITHOUT verifying it.
 *
 * Useful for showing "what does this token claim" in a UI, and for pulling the
 * `kid` out of a token so the right registry row can be selected. Never treat
 * the output as trusted.
 *
 * @param {unknown} attestation
 */
export function inspectAttestation(attestation) {
  const parts = decodeAttestation(attestation);
  const claim = parts.claim;
  return Object.freeze({
    header: Object.freeze({ ...parts.header }),
    claim: Object.freeze({ ...claim }),
    signature: parts.signature,
    claimedKid: typeof parts.header.kid === 'string' ? parts.header.kid : (typeof claim.kid === 'string' ? claim.kid : null),
    claimedUuid: typeof claim.sub === 'string' ? claim.sub : null,
    claimedAgent: typeof claim.agent === 'string' ? claim.agent : null,
    signatureBytes: fromBase64url(parts.signature).length,
  });
}
