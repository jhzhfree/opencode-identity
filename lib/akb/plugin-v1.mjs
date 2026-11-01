import { tool } from "@opencode-ai/plugin/tool";
import { Effect, Fiber } from "effect";
import { loadAkbConfig, invokeAkb, invocationScope, TOOLS } from "./client.mjs";
import {
  capture,
  configLocation,
  requireWorkspace,
  awaitCancellable,
  outputText,
} from "./host.mjs";

export async function createV1Plugin(input, { root }) {
  const configFile = await configLocation(root, input.directory);
  await loadAkbConfig(configFile);
  const filters = {
    query: tool.schema.string().min(1).max(4000),
    topK: tool.schema.number().int().min(1).max(50).optional(),
    knowledgeBaseId: tool.schema
      .string()
      .regex(/^KB_[A-Za-z0-9]{1,125}$/)
      .describe("Knowledge base ID returned by akb_bases (KB_...)")
      .optional(),
  };
  return {
    tool: Object.fromEntries(
      Object.keys(TOOLS).map((name) => [
        name,
        tool({
          description: `Read-only AKB ${name}; authenticated as the executing OpenCode Agent`,
          args: ["akb_search", "akb_query"].includes(name) ? filters : {},
          async execute(values, context) {
            const captured = capture({
              agentName: context.agent,
              sessionId: context.sessionID,
              signal: context.abort,
              directory: context.directory ?? input.directory,
              messageId: context.messageID,
            });
            const fiberContext = Fiber.getCurrent()?.context;
            const config = await loadAkbConfig(configFile, captured.directory);
            const expectedScope = invocationScope(config, captured.agentName);
            if (!config.agents.some((a) => a.agentName === captured.agentName))
              throw new Error(
                "Executing Agent is not enrolled in this AKB connection",
              );
            await requireWorkspace(captured.directory, config.workspaceRoot);
            if (typeof context.ask !== "function")
              throw new Error(
                "This OpenCode version has no approval API. Upgrade before using AKB production tools.",
              );
            const approval = context.ask({
              permission: name,
              patterns: ["*"],
              always: ["*"],
              metadata: {
                service: config.serverUrl,
                knowledgeBaseId:
                  values.knowledgeBaseId ?? config.knowledgeBaseId,
              },
            });
            if (Effect.isEffect(approval))
              await Effect.runPromise(
                fiberContext
                  ? approval.pipe(Effect.provide(fiberContext))
                  : approval,
                { signal: captured.signal },
              );
            else if (approval && typeof approval.then === "function")
              await awaitCancellable(approval, captured.signal);
            else throw new Error("Unsupported OpenCode permission result");
            captured.signal.throwIfAborted();
            return outputText(
              await invokeAkb(
                configFile,
                captured,
                name,
                values,
                expectedScope,
              ),
            );
          },
        }),
      ]),
    ),
  };
}
