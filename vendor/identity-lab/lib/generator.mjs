import {S} from './sdk.mjs';
const {generateUuid:randomUUID} = S;
import { realpath, rename, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { newDirectory, newFile, protectedRead, readJSON, writeJSON } from './files.mjs';
import { AGENT, UUID, endpoint, publicKid } from './proof.mjs';
import { loadTerminalConfig } from './client.mjs';
import { validateRegistry } from './server.mjs';
import { requireMajor, TOOL_NAMES } from './opencode-compat.mjs';
export async function generateIdentity(directory,agentName,uuid) {
  if(!AGENT.test(agentName))throw new Error('Invalid Agent name');
  uuid=uuid??randomUUID();if(!UUID.test(uuid))throw new Error('Invalid trust UUID');
  await newDirectory(directory);
  try {
    const identity=await S.createAgentIdentity({agentName,uuid});
    const generated={agentId:identity.uuid,kid:identity.kid,publicJwk:identity.publicJwk};
    await newFile(path.join(directory,'private.pem'),identity.privatePem);
    await writeJSON(path.join(directory,'public.jwk'),identity.publicJwk);
    await writeJSON(path.join(directory,'identity.json'),identity.files['identity.json']);
    await writeJSON(path.join(directory,'enrollment.json'),identity.enrollment);
    return {agentName,uuid:generated.agentId,kid:generated.kid,publicKeyFile:path.join(directory,'enrollment.json'),privateKeyFile:path.join(directory,'private.pem')};
  }catch(e){await rm(directory,{recursive:true,force:true});throw e;}
}
export async function registerIdentity(registryFile,enrollmentFile) {
  const enrollment=await readJSON(enrollmentFile);validateRegistry({version:1,agents:[enrollment]});
  const lock=await open(registryFile+'.lock','wx',0o600);
  try {
    let registry;try{registry=validateRegistry(await readJSON(registryFile));}catch(e){if(e.code!=='ENOENT')throw e;registry={version:1,agents:[]};}
    const existing=registry.agents.find(a=>a.uuid===enrollment.uuid);
    if(existing && (existing.agentName!==enrollment.agentName||existing.kid!==publicKid(enrollment.publicJwk)))throw new Error('UUID already registered with a different Agent/key');
    if(existing)return {registered:true,uuid:enrollment.uuid,existing:true};
    const record={uuid:enrollment.uuid,agentName:enrollment.agentName,kid:enrollment.kid,publicJwk:enrollment.publicJwk,enabled:true};
    registry.agents.push(record);validateRegistry(registry);
    const temp=registryFile+'.'+randomUUID()+'.tmp';
    try {await writeJSON(temp,registry);await rename(temp,registryFile);}finally{await rm(temp,{force:true});}
    return {registered:true,uuid:record.uuid,agentName:record.agentName};
  }finally{await lock.close();await rm(registryFile+'.lock',{force:true});}
}
export async function generatePlugin(configFile,output,{opencodeMajor='both'}={}) {
  const major=requireMajor(opencodeMajor),config=await loadTerminalConfig(configFile);
  await newDirectory(output,config.workspaceRoot);
  try {
    const result={opencodeMajor:major,entries:{},fragments:{}};
    if(major!=='2'){
      const entry=pathToFileURL(fileURLToPath(new URL('./opencode-plugin.mjs',import.meta.url))).href;
      const pluginFile=path.join(output,'identity-plugin.mjs');
      await newFile(pluginFile,`import plugin from ${JSON.stringify(entry)};\nconst entry=(input)=>plugin.server(input,{configFile:${JSON.stringify(configFile)}});\nentry.id=plugin.id;entry.server=entry;export default entry;\n`);
      const fragment={plugin:[pathToFileURL(pluginFile).href],permission:Object.fromEntries(Object.values(TOOL_NAMES).map(n=>[n,'ask']))};
      result.entries.v1=pluginFile;result.fragments.v1=path.join(output,'opencode.v1.fragment.json');
      await writeJSON(result.fragments.v1,fragment);
      // Retain the original filename for existing V1 users.
      await writeJSON(path.join(output,'opencode.fragment.json'),fragment);
      result.pluginFile=pluginFile;result.fragmentFile=result.fragments.v1;
    }
    if(major!=='1'){
      const directory=path.join(output,'opencode-v2');await newDirectory(directory,config.workspaceRoot);
      const entry=pathToFileURL(fileURLToPath(new URL('./opencode-plugin-v2.mjs',import.meta.url))).href;
      await writeJSON(path.join(directory,'package.json'),{name:'local-mcp-agent-identity-v2',version:'1.1.0',type:'module',exports:{'.':'./index.js'}});
      await newFile(path.join(directory,'index.js'),`import {setupV2} from ${JSON.stringify(entry)};\nexport default {id:'local-mcp-agent-identity',setup:ctx=>setupV2(ctx,{configFile:${JSON.stringify(configFile)}})};\n`);
      const fragment={plugins:[{package:pathToFileURL(directory).href}],permissions:Object.values(TOOL_NAMES).map(action=>({action,resource:'*',effect:'ask'}))};
      result.entries.v2=directory;result.fragments.v2=path.join(output,'opencode.v2.fragment.json');await writeJSON(result.fragments.v2,fragment);
      if(major==='2'){result.pluginFile=path.join(directory,'index.js');result.fragmentFile=result.fragments.v2;await writeJSON(path.join(output,'opencode.fragment.json'),fragment);}
    }
    return result;
  }catch(e){await rm(output,{recursive:true,force:true});throw e;}
}
export async function setupDemo({directory,workspaceRoot,agents=['build','plan'],port=8765,opencodeMajor='both',legacyReadOnly=false}) {
  requireMajor(opencodeMajor);
  if(typeof legacyReadOnly!=='boolean')throw new Error('Invalid legacyReadOnly flag');
  if(!Number.isInteger(port)||port<1||port>65535||!Array.isArray(agents)||!agents.length||agents.length>100||new Set(agents).size!==agents.length||agents.some(a=>!AGENT.test(a)))throw new Error('Invalid demo Agent list or port');
  const workspace=await realpath(workspaceRoot),url=endpoint(`http://127.0.0.1:${port}/mcp`);
  await newDirectory(directory,workspace);
  try {
    const records=[],enrollments=[];
    for(const [i,name]of agents.entries()){
      const info=await generateIdentity(path.join(directory,`agent-${i+1}`),name);
      records.push({agentName:name,uuid:info.uuid,privateKeyFile:info.privateKeyFile});
      enrollments.push(await readJSON(info.publicKeyFile));
    }
    const registryFile=path.join(directory,'registry.json'),configFile=path.join(directory,'terminal-config.json');
    await writeJSON(registryFile,{version:1,agents:enrollments});
    await writeJSON(configFile,{version:1,serverUrl:url,workspaceRoot:workspace,legacyReadOnly,agents:records});
    const generated=await generatePlugin(configFile,path.join(directory,'plugin'),{opencodeMajor});
    const cli=fileURLToPath(new URL('../bin/lab.mjs',import.meta.url));
    const psQuote=s=>"'"+s.replace(/'/g,"''")+"'";
    await newFile(path.join(directory,'start-server.ps1'),`& node ${psQuote(cli)} server --registry ${psQuote(registryFile)} --port ${port}\nexit $LASTEXITCODE\n`);
    await newFile(path.join(directory,'verify.ps1'),records.map(a=>`& node ${psQuote(cli)} verify --config ${psQuote(configFile)} --agent ${psQuote(a.agentName)}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`).join('\n')+'\n');
    return {directory,serverUrl:url,registryFile,configFile,...generated,agents:records.map(({agentName,uuid})=>({agentName,uuid}))};
  }catch(e){await rm(directory,{recursive:true,force:true});throw e;}
}
