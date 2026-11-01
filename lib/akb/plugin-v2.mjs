// @ts-check
import { loadAkbConfig, invokeAkb, invocationScope, TOOLS } from "./client.mjs";
import {
  capture,
  configLocation,
  requireWorkspace,
  awaitCancellable,
  outputText,
} from "./host.mjs";

/** @param {import('@opencode/plugin').Plugin.Context} ctx
 * @param {{root: URL}} options */
export async function setupV2(ctx, { root }) {
  if (
    typeof ctx.tool?.transform !== "function" ||
    typeof ctx.session?.get !== "function" ||
    typeof ctx.permission?.assert !== "function"
  )
    throw new Error(
      "AKB production plugin requires OpenCode 2.x tool.transform, session.get and permission.assert",
    );
  const configFile = await configLocation(root, ctx.location.directory);
  await loadAkbConfig(configFile);
  const registration = await ctx.tool.transform((editor) => {
    for (const name of Object.keys(TOOLS))
      editor.add({
        name,
        description: `Read-only AKB ${name}; uses the executing Agent's registered identity`,
        input:
          /** @type {import('@opencode/plugin/promise/tool').Info['input']} */ ({
            type: "object",
            additionalProperties: false,
            ...(["akb_search", "akb_query"].includes(name)
              ? {
                  properties: {
                    query: { type: "string", minLength: 1, maxLength: 4000 },
                    topK: { type: "integer", minimum: 1, maximum: 50 },
                    knowledgeBaseId: {
                      type: "string",
                      minLength: 1,
                      maxLength: 128,
                    },
                  },
                  required: ["query"],
                }
              : { properties: {} }),
          }),
        options: { codemode: false, permission: name },
        async execute(values, context) {
          const captured = capture({
            agentName: context.agent,
            sessionId: context.sessionID,
            signal: context.signal,
            messageId: context.messageID,
            callId: context.id,
            directory: undefined,
          });
          if (typeof captured.callId !== "string" || !captured.callId)
            throw new Error("Missing trusted OpenCode tool call id");
          const session = await awaitCancellable(
            ctx.session.get(
              { sessionID: captured.sessionId },
              { signal: captured.signal },
            ),
            captured.signal,
          );
          if (session.id !== captured.sessionId)
            throw new Error("Unapproved session");
          const config = await loadAkbConfig(
            configFile,
            session.location?.directory,
          );
          const expectedScope = invocationScope(config, captured.agentName);
          await requireWorkspace(
            session.location?.directory,
            config.workspaceRoot,
          );
          if (!config.agents.some((a) => a.agentName === captured.agentName))
            throw new Error(
              "Executing Agent is not enrolled in this AKB connection",
            );
          await awaitCancellable(
            ctx.permission.assert({
              sessionID: captured.sessionId,
              agent: captured.agentName,
              source: {
                type: "tool",
                messageID: captured.messageId,
                id: captured.callId,
              },
              action: name,
              resources: ["*"],
              save: ["*"],
              metadata: {
                service: config.serverUrl,
                knowledgeBaseId:
                  values.knowledgeBaseId ?? config.knowledgeBaseId,
              },
            }),
            captured.signal,
          );
          captured.signal.throwIfAborted();
          const result = await invokeAkb(
            configFile,
            { ...captured, directory: session.location.directory },
            name,
            values,
            expectedScope,
          );
          return { content: outputText(result), metadata: result.metadata };
        },
      });
  });
  return () => registration.dispose();
}
