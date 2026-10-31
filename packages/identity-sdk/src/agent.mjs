/**
 * Composite agent identity: key pair + UUID + attestation in one call.
 *
 * This is the exact unit the generator tool needs. It stays in-memory so the
 * caller decides how to persist it (hardened files, vault, HSM shim, tests).
 */
import { fail } from './errors.mjs';
import { generateKeyPair } from './keys.mjs';
import { signIdentity, assertAgentName } from './identity.mjs';
import { buildEnrollment } from './registry.mjs';
import { assertUuid, generateUuid } from './uuid.mjs';

/**
 * @param {{ agentName: string, uuid?: string, issuedAt?: number, modulusLength?: number }} input
 */
export async function createAgentIdentity({ agentName, uuid = generateUuid(), issuedAt, modulusLength }) {
  assertAgentName(agentName);
  assertUuid(uuid);
  const pair = await generateKeyPair(modulusLength ? { modulusLength } : undefined);
  const attestation = signIdentity({ uuid, agentName, privateKey: pair.privateKey, ...(issuedAt ? { issuedAt } : {}) });
  if (attestation.claim.kid !== pair.kid) fail('IDENTITY_KID', 'Attestation kid does not match the generated key');
  const enrollment = buildEnrollment({
    uuid,
    agentName,
    publicJwk: pair.publicJwk,
    kid: pair.kid,
    enabled: true,
    attestation,
  });
  return Object.freeze({
    uuid,
    agentName,
    kid: pair.kid,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    privatePem: pair.privatePem,
    publicPem: pair.publicPem,
    publicJwk: pair.publicJwk,
    attestation,
    enrollment,
    /** File-shaped view written by the generator (private key kept separate). */
    files: Object.freeze({
      'identity.json': { version: 1, uuid, agentName, kid: pair.kid, claim: attestation.claim, signature: attestation.signature },
      'public.jwk': pair.publicJwk,
      'enrollment.json': enrollment,
    }),
  });
}
