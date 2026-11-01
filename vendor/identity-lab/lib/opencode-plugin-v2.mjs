// @ts-check
/** OpenCode 2.x Promise Plugin definition. Plugin.define is an identity helper;
 * this structural definition needs no V2 SDK at runtime. The official 2.2.5
 * SDK is used by check:contracts to validate this module's public types.
 */
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadTerminalConfig, callTool } from './client.mjs';
import { tools } from './server.mjs';
import { captureExecution, awaitCancellable, businessArgs, TOOL_NAMES } from './opencode-compat.mjs';

/** @param {import('@opencode/plugin').Plugin.Context} ctx */
export async function setupV2(ctx,options=ctx.options) {
  if(typeof options?.configFile!=='string')throw new Error('Protected configFile required');
  if(typeof ctx.tool?.transform!=='function'||typeof ctx.session?.get!=='function')throw new Error('Unsupported OpenCode 2.x plugin context');
  const config=await loadTerminalConfig(options.configFile,ctx.location.directory);
  const nativeApproval=typeof ctx.permission?.assert==='function';
  if(!nativeApproval&&config.legacyReadOnly!==true)throw new Error('This early OpenCode 2.x has no permission.assert API. Explicit legacyReadOnly is required for these three local read-only demo tools');
  const registration=await ctx.tool.transform(editor=>{
    for(const [name,serverTool]of Object.entries(tools)){
      if(!Object.hasOwn(TOOL_NAMES,name))continue;
      editor.add({name:TOOL_NAMES[name],description:`Authenticated local MCP ${name}; identity is taken from the executing Agent`,input:/** @type {import('@opencode/plugin/promise/tool').Info['input']} */ (serverTool.schema),
        options:{codemode:false,permission:TOOL_NAMES[name]},
        async execute(values,context){
          const captured=captureExecution({agentName:context.agent,sessionId:context.sessionID,signal:context.signal,
            messageId:context.messageID,callId:context.id});
          if(typeof captured.messageId!=='string'||typeof captured.callId!=='string')throw new Error('Missing trusted V2 tool source');
          const agent=config.agents.find(a=>a.agentName===captured.agentName);
          if(!agent)throw new Error('Executing OpenCode Agent is not registered in terminal config');
          // Plugin instance location is not necessarily the current session's location.
          const session=await awaitCancellable(ctx.session.get({sessionID:captured.sessionId},{signal:captured.signal}),captured.signal);
          if(session.id!==captured.sessionId||typeof session.location?.directory!=='string'||await realpath(session.location.directory)!==config.workspaceRoot)throw new Error('Unapproved session workspace');
          if(nativeApproval)await awaitCancellable(ctx.permission.assert({sessionID:captured.sessionId,agent:captured.agentName,
            source:{type:'tool',messageID:captured.messageId,id:captured.callId},action:TOOL_NAMES[name],resources:['*'],save:['*'],
            metadata:{server:config.serverUrl,tool:name}}),captured.signal);
          captured.signal.throwIfAborted();
          const invocationId=randomUUID();
          const result=await callTool(config,agent,name,businessArgs(name,values),{signal:captured.signal,sessionId:captured.sessionId,invocationId});
          return {content:JSON.stringify(result.structuredContent),metadata:{agentName:agent.agentName,uuid:agent.uuid,invocationId}};
        }
      });
    }
  });
  return ()=>registration.dispose();
}
export default {id:'local-mcp-agent-identity',setup:setupV2};
