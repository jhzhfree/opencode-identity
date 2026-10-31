/**
 * Typed errors for the identity SDK.
 *
 * Every rejection carries a stable machine-readable `code` so callers can react
 * without string-matching, while `message` stays deliberately generic on the
 * authentication path to avoid becoming a verification oracle.
 */
export class IdentityError extends Error {
  /**
   * @param {string} code stable identifier, e.g. `PROOF_EXPIRED`
   * @param {string} message human-readable, safe to log
   * @param {Record<string, unknown>} [detail] extra context for local debugging
   */
  constructor(code, message, detail) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  /** @param {unknown} value */
  static isIdentityError(value) {
    return value instanceof IdentityError;
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [detail]
 * @returns {never}
 */
export function fail(code, message, detail) {
  throw new IdentityError(code, message, detail);
}

/** The single message used for every authentication failure. */
export const AUTH_FAILED = 'Agent authentication failed';
