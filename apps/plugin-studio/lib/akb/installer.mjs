import path from "node:path";
import {
  readFile,
  rename,
  rm,
  open,
  mkdir,
  realpath,
  lstat,
  chmod,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readJSON, writeJSON, newFile, outside } from "./files.mjs";
import { parseJsonc, replaceJsoncFields } from "../jsonc.mjs";
import { loadAkbConfig, TOOLS } from "./client.mjs";
const exec = promisify(execFile);
async function hardenOwned(target, kind) {
  const info = await lstat(target);
  if (
    info.isSymbolicLink() ||
    (kind === "directory" ? !info.isDirectory() : !info.isFile())
  )
    throw new Error("Refusing symlink or invalid installation target");
  if (process.platform === "win32") {
    const { protectionPolicy } = await import(
      "../../../../vendor/identity-lab/lib/protection.mjs"
    );
    await protectionPolicy().harden(target, kind);
  } else {
    if (info.uid !== process.getuid())
      throw new Error("Installation target must be owned by the current user");
    await chmod(target, kind === "directory" ? 0o700 : 0o600);
  }
}

export function pluginFragment(bundle, major) {
  if (!["1", "2"].includes(major)) throw new Error("Choose host major 1 or 2");
  const uri = pathToFileURL(
    major === "1"
      ? path.join(bundle, "plugin-v1.mjs")
      : path.join(bundle, "opencode-v2"),
  ).href;
  return major === "1"
    ? {
        plugin: [uri],
        permission: Object.fromEntries(
          Object.keys(TOOLS).map((n) => [n, "ask"]),
        ),
      }
    : {
        plugins: [{ package: uri }],
        permissions: Object.keys(TOOLS).map((action) => ({
          action,
          resource: "*",
          effect: "ask",
        })),
      };
}
export async function saveVerifiedBinding(configFile, agentName, binding) {
  const lock = await open(configFile + ".lock", "wx", 0o600);
  try {
    const current = await readJSON(configFile);
    const a = current.agents.find((a) => a.agentName === agentName);
    if (!a || a.uuid !== binding.externalAgentId)
      throw new Error("Agent configuration changed; verify again");
    a.binding = binding;
    const temp = configFile + "." + randomUUID() + ".tmp";
    try {
      await writeJSON(temp, current);
      await rename(temp, configFile);
    } finally {
      await rm(temp, { force: true });
    }
  } finally {
    await lock.close();
    await rm(configFile + ".lock", { force: true });
  }
}
export async function installAkbPlugin({
  bundleDir,
  configFile,
  major,
  opencodeConfig,
  installDependencies = true,
}) {
  if (
    !["1", "2"].includes(String(major)) ||
    !path.isAbsolute(opencodeConfig || "")
  )
    throw new Error(
      "Choose --major 1/2 and an absolute global --opencode-config path",
    );
  const bundle = await realpath(bundleDir);
  const locatorFile = path.join(bundle, "config-location.json");
  await hardenOwned(bundle, "directory");
  await hardenOwned(locatorFile, "file");
  const locator = await readJSON(locatorFile);
  const file = path.resolve(bundle, configFile || locator.configFile);
  const config = await loadAkbConfig(file);
  if (
    !outside(config.workspaceRoot, await realpath(bundle)) ||
    !outside(config.workspaceRoot, opencodeConfig)
  )
    throw new Error(
      "Use a global configuration and protected plugin outside the Agent workspace",
    );
  const entry =
    major === "1"
      ? path.join(bundle, "plugin-v1.mjs")
      : path.join(bundle, "opencode-v2");
  await realpath(entry);
  if (installDependencies && major === "1") {
    const env = { ...process.env };
    delete env[config.serviceKeyEnv];
    if (process.platform === "win32")
      await exec(
        process.env.ComSpec || "cmd.exe",
        [
          "/d",
          "/s",
          "/c",
          "npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
        ],
        {
          cwd: bundle,
          env,
          windowsHide: true,
          timeout: 180000,
          maxBuffer: 1024 * 1024,
        },
      );
    else
      await exec(
        "npm",
        ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: bundle, env, timeout: 180000, maxBuffer: 1024 * 1024 },
      );
  }
  await mkdir(path.dirname(opencodeConfig), { recursive: true, mode: 0o700 });
  await hardenOwned(path.dirname(opencodeConfig), "directory");
  try {
    await hardenOwned(opencodeConfig, "file");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const lock = await open(opencodeConfig + ".lock", "wx", 0o600);
  let backup = null;
  try {
    let raw = "{}";
    try {
      raw = await readFile(opencodeConfig, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const current = parseJsonc(raw);
    const fields = {};
    const markerFile = opencodeConfig + ".akb-plugin.json";
    let managed = null;
    try {
      managed = await readJSON(markerFile);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (!current || typeof current !== "object" || Array.isArray(current))
      throw new Error("Invalid OpenCode configuration");
    const uri = pathToFileURL(entry).href;
    if (major === "1") {
      if (current.plugins || current.permissions)
        throw new Error(
          "This global config appears to use the OpenCode 2.x format",
        );
      if (current.plugin !== undefined && !Array.isArray(current.plugin))
        throw new Error("Invalid plugin list");
      fields.plugin = [
        ...(current.plugin || []).filter(
          (p) =>
            (Array.isArray(p) ? p[0] : p) !== uri &&
            (Array.isArray(p) ? p[0] : p) !== managed?.uri,
        ),
        uri,
      ];
      if (
        current.permission !== undefined &&
        typeof current.permission !== "object" &&
        !["allow", "ask", "deny"].includes(current.permission)
      )
        throw new Error("Invalid permission policy");
      fields.permission = {
        ...(typeof current.permission === "string"
          ? { "*": current.permission }
          : current.permission || {}),
        ...Object.fromEntries(Object.keys(TOOLS).map((n) => [n, "ask"])),
      };
    } else {
      if (current.plugin || current.permission)
        throw new Error(
          "This global config appears to use the OpenCode 1.x format",
        );
      if (current.plugins !== undefined && !Array.isArray(current.plugins))
        throw new Error("Invalid plugins list");
      fields.plugins = [
        ...(current.plugins || []).filter(
          (p) => p?.package !== uri && p?.package !== managed?.uri,
        ),
        { package: uri },
      ];
      if (
        current.permissions !== undefined &&
        !Array.isArray(current.permissions)
      )
        throw new Error("Invalid permissions list");
      fields.permissions = [
        ...(current.permissions || []).filter(
          (p) => !Object.hasOwn(TOOLS, p.action),
        ),
        ...Object.keys(TOOLS).map((action) => ({
          action,
          resource: "*",
          effect: "ask",
        })),
      ];
    }
    if (configFile) {
      const tmp = locatorFile + "." + randomUUID() + ".tmp";
      try {
        await writeJSON(tmp, { configFile: file });
        await rename(tmp, locatorFile);
      } finally {
        await rm(tmp, { force: true });
      }
    }
    backup = opencodeConfig + "." + randomUUID() + ".bak";
    await newFile(backup, raw);
    const temp = opencodeConfig + "." + randomUUID() + ".tmp";
    try {
      await newFile(temp, replaceJsoncFields(raw, fields));
      await rename(temp, opencodeConfig);
    } finally {
      await rm(temp, { force: true });
    }
    const markerTemp = markerFile + "." + randomUUID() + ".tmp";
    try {
      await writeJSON(markerTemp, { uri, major });
      await rename(markerTemp, markerFile);
    } finally {
      await rm(markerTemp, { force: true });
    }
    return {
      installed: true,
      major,
      plugin: entry,
      opencodeConfig,
      backup,
      agents: config.agents.map((a) => a.agentName),
      verifiedAgents: config.agents
        .filter((a) => a.binding)
        .map((a) => a.agentName),
      restartRequired: true,
    };
  } finally {
    await lock.close();
    await rm(opencodeConfig + ".lock", { force: true });
  }
}
