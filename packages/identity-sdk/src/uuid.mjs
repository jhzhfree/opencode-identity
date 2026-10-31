/**
 * Agent UUIDs.
 *
 * A UUID is the agent's trust anchor: it is what the key pair is bound to and
 * what the server reports back after verification. Generation lives here so the
 * generator tool and the SDK CLI cannot drift apart.
 */
import { randomUUID } from 'node:crypto';
import { fail } from './errors.mjs';

/** Any RFC 4122 layout. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Strict RFC 4122 version 4 (random) layout, lowercase hex. */
export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** @returns {string} a fresh v4 UUID in canonical lowercase form */
export function generateUuid() {
  return randomUUID();
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function assertUuid(value, label = 'uuid') {
  if (!isUuid(value)) fail('UUID_INVALID', `Invalid ${label}: expected a lowercase RFC 4122 UUID`);
  return /** @type {string} */ (value);
}
