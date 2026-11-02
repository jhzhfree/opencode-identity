import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON } from "./files.mjs";
export function capture({
  agentName,
  sessionId,
  signal,
  directory,
  messageId,
  callId,
}) {
  if (
    typeof agentName !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(agentName) ||
    typeof sessionId !== "string" ||
    !sessionId ||
    sessionId.length > 128 ||
    !signal ||
    typeof signal.throwIfAborted !== "function" ||
    typeof messageId !== "string" ||
    !messageId ||
    messageId.length > 128
  )
    throw new Error("Missing trusted OpenCode Agent execution context");
  signal.throwIfAborted();
  return Object.freeze({
    agentName,
    sessionId,
    signal,
    directory,
    messageId,
    callId,
  });
}
export async function configLocation(root, workspace) {
  const directory = root instanceof URL ? fileURLToPath(root) : root;
  const locator = await readJSON(
    path.join(directory, "config-location.json"),
    workspace,
  );
  if (typeof locator.configFile !== "string")
    throw new Error("Missing protected AKB config location");
  return path.resolve(directory, locator.configFile);
}
export async function requireWorkspace(actual, expected) {
  if (
    typeof actual !== "string" ||
    path.relative(await realpath(actual), expected) !== ""
  )
    throw new Error("Unapproved OpenCode session workspace");
}
export async function awaitCancellable(promise, signal) {
  signal.throwIfAborted();
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(signal.reason || new Error("Cancelled"));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
export function outputText(result) {
  return JSON.stringify(result.data.structuredContent ?? result.data);
}
