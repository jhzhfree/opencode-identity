/**
 * Per-request identity context for layers below the tool functions.
 *
 * `dispatch()` already hands the verified identity to every tool as
 * `context.identity`, so top-level tools never need this module. It exists for
 * business modules further down the call stack that should know *who* is
 * calling without every intermediate function threading an `identity`
 * parameter through its signature.
 *
 * Safety properties:
 * - The store only ever holds the frozen object produced by `verifyProof()`
 *   (`uuid` / `agentName` / `kid` / `sessionId` / `invocationId`), so callers
 *   can read it but never forge or mutate it.
 * - Each JSON-RPC request gets its own store, so concurrent requests on the
 *   same process cannot see each other's identity, and the value is gone once
 *   the request's async chain ends.
 * - `currentIdentity()` throws outside a verified request instead of returning
 *   something unverified — same stance as the tools' `verifiedIdentity()`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with `identity` available to every async descendant via
 * `currentIdentity()`. Called once per `tools/call` by `dispatch()`.
 *
 * @template T
 * @param {Readonly<{ uuid: string, agentName: string, kid: string, sessionId: string, invocationId: string, verified: true }>} identity
 * @param {() => T} fn
 * @param {() => void} [onAccess] called each time `currentIdentity()` reads the
 *   identity, so the server can log that a deep layer actually used it.
 * @returns {T}
 */
export function runWithIdentity(identity, fn, onAccess) {
  return storage.run({ identity, onAccess }, fn);
}

/**
 * The verified caller identity of the request this code is running in.
 * @returns {Readonly<{ uuid: string, agentName: string, kid: string, sessionId: string, invocationId: string, verified: true }>}
 */
export function currentIdentity() {
  const store = storage.getStore();
  const identity = store?.identity;
  if (!identity?.verified || !Object.isFrozen(identity)) {
    throw new Error('No verified caller identity in context; call from inside a tool execution');
  }
  // The observer is server-owned; failures to log must never break a business call.
  try { store.onAccess?.(); } catch { /* ignore */ }
  return identity;
}
