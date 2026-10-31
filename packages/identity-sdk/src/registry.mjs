/**
 * Public-key registry: the only identity data the MCP server trusts.
 *
 * A registry entry binds `uuid -> agentName -> public key` and now also carries
 * the self-signed identity attestation. Validating an entry therefore does two
 * independent things: structural checks (public-only JWK, RSA strength, kid
 * derivation) and a signature check over the name+UUID binding. Swapping the
 * agent name in a stolen registry is caught by the second check.
 */
import { deepFreeze } from './canonical.mjs';
import { fail } from './errors.mjs';
import { assertAgentName, AGENT_PATTERN, verifyEnrollment } from './identity.mjs';
import { isPublicOnlyJwk, keyId as computeKeyId, MIN_MODULUS_BITS } from './keys.mjs';
import { assertUuid } from './uuid.mjs';
import { importPublicKey } from './keys.mjs';

/** Registry schema version. */
export const REGISTRY_VERSION = 1;
/** Hard cap on entries; keeps request-path work bounded. */
export const MAX_AGENTS = 100;

/**
 * @param {{ uuid: string, agentName: string, publicJwk: unknown, kid?: string, enabled?: boolean, attestation?: unknown }} input
 */
export function buildEnrollment({ uuid, agentName, publicJwk, kid, enabled = true, attestation }) {
  assertUuid(uuid);
  assertAgentName(agentName);
  const jwk = /** @type {{ n?: string, e?: string, kid?: string }} */ (publicJwk);
  if (!isPublicOnlyJwk(jwk)) fail('REGISTRY_PRIVATE_KEY', 'Registry must contain public keys only');
  const derived = computeKeyId({ kty: 'RSA', n: jwk.n, e: jwk.e });
  if (kid && kid !== derived) fail('REGISTRY_KID', 'kid does not match the public key');
  if (typeof enabled !== 'boolean') fail('REGISTRY_ENTRY', 'enabled must be a boolean');
  /** @type {Record<string, unknown>} */
  const entry = { uuid, agentName, kid: derived, publicJwk: { .../** @type {object} */ (publicJwk), kid: derived }, enabled };
  if (attestation) entry.attestation = attestation;
  return entry;
}

/**
 * @param {unknown} value
 * @param {{ requireAttestation?: boolean, verifyAttestation?: boolean }} [options]
 * @returns {Readonly<{ version: number, agents: ReadonlyArray<any> }>}
 */
export function validateRegistry(value, { requireAttestation = false, verifyAttestation = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('REGISTRY_INVALID', 'Invalid registry');
  const registry = /** @type {{ version?: unknown, agents?: unknown }} */ (value);
  if (registry.version !== REGISTRY_VERSION || !Array.isArray(registry.agents) || registry.agents.length > MAX_AGENTS) {
    fail('REGISTRY_INVALID', 'Invalid registry header');
  }
  const ids = new Set();
  const names = new Set();
  for (const entry of /** @type {any[]} */ (registry.agents)) {
    if (!entry || typeof entry !== 'object' || !entry.uuid || !entry.agentName) fail('REGISTRY_ENTRY', 'Invalid registry entry');
    assertUuid(entry.uuid, 'registry uuid');
    if (!AGENT_PATTERN.test(entry.agentName)) fail('REGISTRY_ENTRY', 'Invalid registry Agent name');
    if (ids.has(entry.uuid)) fail('REGISTRY_DUPLICATE', 'Duplicate uuid in registry');
    if (names.has(entry.agentName)) fail('REGISTRY_DUPLICATE', 'Duplicate Agent name in registry');
    if (typeof entry.enabled !== 'boolean') fail('REGISTRY_ENTRY', 'enabled must be a boolean');
    if (!isPublicOnlyJwk(entry.publicJwk)) fail('REGISTRY_PRIVATE_KEY', 'Registry must contain public keys only');
    let key;
    try { key = importPublicKey(entry.publicJwk); } catch { fail('REGISTRY_KEY', 'Invalid public key in registry'); }
    if (computeKeyId(key.export({ format: 'jwk' })) !== entry.kid) fail('REGISTRY_KID', 'kid does not match the registered public key');
    if (key.asymmetricKeyDetails?.modulusLength < MIN_MODULUS_BITS) fail('REGISTRY_KEY', `Registered key must be RSA ${MIN_MODULUS_BITS}+`);

    if (requireAttestation && !entry.attestation) fail('ATTESTATION_ABSENT', `Registry entry ${entry.agentName} has no attestation`);
    if (verifyAttestation && entry.attestation) {
      verifyEnrollment(entry);
    }
    ids.add(entry.uuid);
    names.add(entry.agentName);
  }
  return deepFreeze({ version: REGISTRY_VERSION, agents: /** @type {any[]} */ (registry.agents) });
}

/**
 * Non-throwing attestation report, used by the UI and audit logs.
 * @param {{ agents: Array<{ agentName: string, attribution?: unknown, attestation?: unknown }> }} registry
 * @returns {Array<{ agentName: string, status: 'verified'|'absent'|'invalid', code?: string, message?: string }>}
 */
export function attestationReport(registry) {
  return registry.agents.map(entry => {
    if (!entry.attestation) return { agentName: entry.agentName, status: /** @type {const} */ ('absent') };
    try {
      verifyEnrollment(/** @type {any} */ (entry));
      return { agentName: entry.agentName, status: /** @type {const} */ ('verified') };
    } catch (error) {
      return {
        agentName: entry.agentName,
        status: /** @type {const} */ ('invalid'),
        code: /** @type {any} */ (error).code,
        message: /** @type {Error} */ (error).message,
      };
    }
  });
}
