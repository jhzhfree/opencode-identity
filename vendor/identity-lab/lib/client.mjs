import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { readJSON, protectedRead } from './files.mjs';
import { AGENT, UUID, HEADER, endpoint, makeProof } from './proof.mjs';
export async function loadTerminalConfig(filename, workspace) {
  const c=await readJSON(filename,workspace);
  if(c.legacyReadOnly!==undefined&&typeof c.legacyReadOnly!=='boolean')throw new Error('legacyReadOnly must be boolean');
  if(c.version!==1||!Array.isArray(c.agents)||!c.agents.length||c.agents.length>100)throw new Error('Invalid terminal config');
  const url=endpoint(c.serverUrl),root=await realpath(c.workspaceRoot),names=new Set(),ids=new Set();
  if(workspace && root!==await realpath(workspace))throw new Error('Unapproved workspace');
  for(const a of c.agents){
    if(!AGENT.test(a.agentName)||!UUID.test(a.uuid)||names.has(a.agentName)||ids.has(a.uuid))throw new Error('Invalid or ambiguous Agent mapping');
    await protectedRead(a.privateKeyFile,root);names.add(a.agentName);ids.add(a.uuid);Object.freeze(a);
  }
  return Object.freeze({...c,serverUrl:url,workspaceRoot:root,agents:Object.freeze(c.agents)});
}
export async function rpcCall(config,agent,method,params,{signal=new AbortController().signal,sessionId='terminal',invocationId=randomUUID()}={}) {
  signal.throwIfAborted();
  const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params}));
  const proof=makeProof({uuid:agent.uuid,agentName:agent.agentName,privateKey:await protectedRead(agent.privateKeyFile,config.workspaceRoot),url:config.serverUrl,body,sessionId,invocationId});
  const res=await fetch(config.serverUrl,{method:'POST',redirect:'error',body,headers:{'Content-Type':'application/json','Accept':'application/json',[HEADER]:proof},signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
  if(!res.ok)throw new Error(`MCP rejected request (HTTP ${res.status})`);
  const reader=res.body.getReader();let size=0;const chunks=[];
  try{for(;;){const c=await reader.read();if(c.done)break;size+=c.value.length;if(size>1048576)throw new Error('MCP response too large');chunks.push(Buffer.from(c.value));}}finally{await reader.cancel();}
  const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const request=JSON.parse(body.toString('utf8'));
  if(result.jsonrpc!=='2.0'||result.id!==request.id||result.error||result.result?.isError)throw new Error(result.error?.message??'Invalid MCP result');
  return result.result;
}
export async function callTool(config,agent,name,args,context={}) {
  const invocation={...context,invocationId:context.invocationId??randomUUID()};
  const init=await rpcCall(config,agent,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'identity-lab-terminal',version:'1.1.0'}},invocation);
  if(init.protocolVersion!=='2025-06-18')throw new Error('Unsupported MCP protocol');
  return rpcCall(config,agent,'tools/call',{name,arguments:args},invocation);
}
export async function verifyTerminal(configFile,agentName) {
  const config=await loadTerminalConfig(configFile),agent=config.agents.find(a=>a.agentName===agentName);
  if(!agent)throw new Error('Agent not configured');
  const result=await callTool(config,agent,'whoami',{}),identity=result.structuredContent?.identity;
  if(identity?.uuid!==agent.uuid||identity?.agentName!==agent.agentName||identity?.verified!==true)throw new Error('Server returned a mismatched identity');
  return {verified:true,identity};
}
