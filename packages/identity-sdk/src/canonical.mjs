/**
 * Deterministic encoding helpers.
 *
 * Signatures are computed over canonical bytes, so signing and verification
 * agree regardless of property insertion order or the runtime that produced the
 * object. Base64url without padding is used everywhere so tokens are URL-safe
 * and byte-identical on both sides.
 */
import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';

/**
 * JSON with recursively sorted object keys and no insignificant whitespace.
 * Rejects values that have no deterministic JSON representation.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJSON(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) fail('CANONICAL_NUMBER', 'Only finite numbers can be canonicalised');
    return JSON.stringify(value);
  }
  if (type === 'bigint' || type === 'function' || type === 'symbol' || type === 'undefined') {
    fail('CANONICAL_TYPE', `Cannot canonicalise ${type}`);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJSON(item === undefined ? null : item)).join(',')}]`;
  if (type === 'object') {
    const entries = Object.keys(value)
      .filter(key => /** @type {Record<string, unknown>} */ (value)[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJSON(/** @type {Record<string, unknown>} */ (value)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return fail('CANONICAL_TYPE', `Cannot canonicalise ${type}`);
}

/** @param {Buffer|string} value */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {Buffer|string} value */
export function sha256Base64url(value) {
  return createHash('sha256').update(value).digest('base64url');
}

/** @param {Buffer|string} value */
export function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * @param {string} value
 * @returns {Buffer}
 */
export function fromBase64url(value) {
  return Buffer.from(value, 'base64url');
}

/** Strict check for unpadded base64url alphabet. */
export const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Deep-freeze so downstream code cannot mutate verified material.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
