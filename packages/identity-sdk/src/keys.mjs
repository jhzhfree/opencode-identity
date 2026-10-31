/**
 * RSA key material: generation, import/export, and key ids.
 *
 * Design notes
 * - 3072-bit RSA is the floor, matching the reference implementation.
 * - `kid` is the base64url SHA-256 over the canonical public params `{e,kty,n}`.
 *   This exact derivation is kept byte-compatible with the original lab package
 *   so tokens and registries interoperate in both directions.
 * - Private keys never leave this module as anything but PEM/KeyObject; no
 *   helper here serialises a private key into a public structure.
 */
import { createPrivateKey, createPublicKey, generateKeyPair as nodeGenerateKeyPair } from 'node:crypto';
import { promisify } from 'node:util';
import { sha256Base64url } from './canonical.mjs';
import { fail } from './errors.mjs';

const generateRsa = promisify(nodeGenerateKeyPair);

/** Minimum accepted modulus length. */
export const MIN_MODULUS_BITS = 3072;
/** Only RS256 is produced or accepted. */
export const SIGNING_ALG = 'RS256';

/**
 * @typedef {object} PublicJwk
 * @property {'RSA'} kty
 * @property {string} n
 * @property {string} e
 * @property {string} kid
 * @property {'RS256'} alg
 * @property {'sig'} use
 */

/**
 * Key id: base64url(SHA-256(JSON.stringify({e,kty,n}))).
 * Byte-compatible with the reference `publicKid` implementation.
 * @param {{e?: unknown, kty?: unknown, n?: unknown}} jwk
 * @returns {string}
 */
export function keyId(jwk) {
  if (!jwk || typeof jwk !== 'object' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string' || jwk.kty !== 'RSA') {
    fail('JWK_INVALID', 'A public RSA JWK with kty/n/e is required to compute a key id');
  }
  return sha256Base64url(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }));
}

/**
 * True when the JWK contains only public parameters.
 * @param {unknown} jwk
 */
export function isPublicOnlyJwk(jwk) {
  if (!jwk || typeof jwk !== 'object') return false;
  const privateParams = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];
  return !privateParams.some(key => key in /** @type {Record<string, unknown>} */ (jwk));
}

/**
 * @param {import('node:crypto').KeyObject|string} keyLike private key, public key or PEM
 * @returns {PublicJwk}
 */
export function publicJwkOf(keyLike) {
  const key = keyLike instanceof Object && 'type' in keyLike
    ? /** @type {import('node:crypto').KeyObject} */ (keyLike)
    : createPrivateKey(/** @type {string} */ (keyLike));
  const exported = (key.type === 'private' ? createPublicKey(key) : key).export({ format: 'jwk' });
  const jwk = { kty: 'RSA', n: exported.n, e: exported.e };
  return Object.freeze({ ...jwk, kid: keyId(jwk), alg: SIGNING_ALG, use: 'sig' });
}

/**
 * @param {unknown} key
 * @param {{ minBits?: number, label?: string }} [options]
 */
export function assertKeyStrength(key, { minBits = MIN_MODULUS_BITS, label = 'key' } = {}) {
  const detail = /** @type {import('node:crypto').KeyObject} */ (key).asymmetricKeyDetails;
  if (/** @type {import('node:crypto').KeyObject} */ (key).asymmetricKeyType !== 'rsa'
    || !detail?.modulusLength
    || detail.modulusLength < minBits) {
    fail('KEY_WEAK', `${label} must be RSA ${minBits} bits or stronger`);
  }
  return /** @type {import('node:crypto').KeyObject} */ (key);
}

/**
 * Generate a fresh RSA key pair for one agent.
 * @param {{ modulusLength?: number }} [options]
 */
export async function generateKeyPair({ modulusLength = MIN_MODULUS_BITS } = {}) {
  if (!Number.isInteger(modulusLength) || modulusLength < MIN_MODULUS_BITS) {
    fail('KEY_STRENGTH', `modulusLength must be an integer >= ${MIN_MODULUS_BITS}`);
  }
  const { publicKey, privateKey } = await generateRsa('rsa', { modulusLength, publicExponent: 0x10001 });
  const jwk = publicJwkOf(privateKey);
  return Object.freeze({
    privateKey,
    publicKey,
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    publicJwk: jwk,
    kid: jwk.kid,
    modulusLength,
  });
}

/**
 * Accept a KeyObject, PKCS#8 PEM, or JWK and return a private KeyObject.
 * @param {unknown} material
 * @returns {import('node:crypto').KeyObject}
 */
export function importPrivateKey(material) {
  if (material && typeof material === 'object' && 'type' in material) {
    const key = /** @type {import('node:crypto').KeyObject} */ (material);
    if (key.type !== 'private') fail('KEY_TYPE', 'Expected a private key');
    return assertKeyStrength(key, { label: 'private key' });
  }
  if (typeof material === 'string') {
    let key;
    try { key = createPrivateKey(material); }
    catch {
      // Distinguish "this is a public key" from "this is not a key at all".
      let isPublic = false;
      try { createPublicKey(material); isPublic = true; } catch { /* not a public key either */ }
      if (isPublic) fail('KEY_TYPE', 'Expected a private key, got a public key');
      fail('KEY_PARSE', 'Unable to parse the private key PEM');
    }
    return assertKeyStrength(key, { label: 'private key' });
  }
  fail('KEY_TYPE', 'Private key must be a KeyObject or a PKCS#8 PEM string');
}

/**
 * Accept a KeyObject, SPKI PEM, public JWK, or a private key (public half is used).
 * @param {unknown} material
 * @returns {import('node:crypto').KeyObject}
 */
export function importPublicKey(material) {
  let key;
  if (material && typeof material === 'object' && 'type' in material) {
    const given = /** @type {import('node:crypto').KeyObject} */ (material);
    key = given.type === 'private' ? createPublicKey(given) : given;
  } else if (typeof material === 'string') {
    try { key = createPublicKey(material); } catch { fail('KEY_PARSE', 'Unable to parse the public key'); }
  } else if (material && typeof material === 'object') {
    try { key = createPublicKey({ key: /** @type {import('node:crypto').JsonWebKey} */ (material), format: 'jwk' }); }
    catch { fail('KEY_PARSE', 'Unable to import the public JWK'); }
  } else {
    fail('KEY_TYPE', 'Public key must be a KeyObject, SPKI PEM string, or JWK');
  }
  return assertKeyStrength(key, { label: 'public key' });
}

/**
 * PEM for a public key, useful for documentation and manual verification.
 * @param {unknown} material
 */
export function exportPublicPem(material) {
  return importPublicKey(material).export({ format: 'pem', type: 'spki' }).toString();
}
