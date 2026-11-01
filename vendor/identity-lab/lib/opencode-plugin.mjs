/** OpenCode 1.x entry; handles native Promise and Effect permission APIs. */
import { tool } from '@opencode-ai/plugin/tool';
import { Effect, Fiber } from 'effect';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadTerminalConfig, callTool } from './client.mjs';
import { captureExecution, awaitCancellable, businessArgs, TOOL_NAMES } from './opencode-compat.mjs';
export async function createPlugin(input,options) {
  if(typeof options?.configFile!=='string')throw new Error('Protected configFile required');
  const config=await loadTerminalConfig(options.configFile,input.directory);
  const make=(name,args)=>tool({description:`Local authenticated MCP ${name}; identity comes from the executing OpenCode Agent`,args,
    async execute(values,context){
      // Capture the executing host identity and approval fiber before the first await.
      const captured=captureExecution({agentName:context.agent,sessionId:context.sessionID,signal:context.abort,
        directory:context.directory??input.directory,messageId:context.messageID});
      const fiberContext=Fiber.getCurrent()?.context;
      const agent=config.agents.find(a=>a.agentName===captured.agentName);
      if(!agent)throw new Error('Executing OpenCode Agent is not registered in terminal config');
      if(await realpath(captured.directory)!==config.workspaceRoot)throw new Error('Unapproved workspace');
      if(typeof context.ask==='function'){
        // A native Promise begins executing immediately. Never retry the permission call.
        const approval=context.ask({permission:TOOL_NAMES[name],patterns:['*'],always:['*'],metadata:{server:config.serverUrl,tool:name}});
        if(Effect.isEffect(approval))await Effect.runPromise(fiberContext?approval.pipe(Effect.provide(fiberContext)):approval,{signal:captured.signal});
        else if(approval&&typeof approval.then==='function')await awaitCancellable(approval,captured.signal);
        else throw new Error('Unsupported OpenCode 1.x permission API result');
      }else if(config.legacyReadOnly!==true){
        throw new Error('This old OpenCode 1.x has no tool approval API. Explicit legacyReadOnly is required for these three local read-only demo tools');
      }
      captured.signal.throwIfAborted();
      const result=await callTool(config,agent,name,businessArgs(name,values),{signal:captured.signal,sessionId:captured.sessionId,invocationId:randomUUID()});
      // A string works with both the original 1.x executor and newer ToolResult APIs.
      return JSON.stringify(result.structuredContent);
    }});
  return {tool:{identity_whoami:make('whoami',{}),identity_echo:make('echo_secure',{text:tool.schema.string().max(2000)}),identity_add:make('add',{a:tool.schema.number(),b:tool.schema.number()})}};
}
// Callable default is required by old V1 loaders; newer V1 loaders can use server().
const entry=(input,options)=>createPlugin(input,options);
entry.id='local-mcp-agent-identity';entry.server=entry;
export default entry;
