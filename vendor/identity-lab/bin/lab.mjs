#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { setupDemo, generateIdentity, registerIdentity, generatePlugin } from '../lib/generator.mjs';
import { createIdentityServer, validateRegistry } from '../lib/server.mjs';
import { loadTerminalConfig, verifyTerminal, callTool } from '../lib/client.mjs';
import { readJSON } from '../lib/files.mjs';
import { parseOpenCodeVersion } from '../lib/opencode-compat.mjs';
const usage=`Local MCP Agent Identity Lab (Node 22+, OpenCode 1.x / 2.x adapters)
  node bin/lab.mjs demo --out <NEW-ABS-DIR> --workspace <ABS-DIR> [--agents build,plan] [--port 8765] [--opencode-major 1|2|both] [--legacy-readonly true]
  node bin/lab.mjs server --registry <ABS-registry.json> [--port 8765]
  node bin/lab.mjs verify --config <ABS-terminal-config.json> --agent build
  node bin/lab.mjs call --config <ABS-terminal-config.json> --agent build --tool add --args-file <ABS-args.json>
  node bin/lab.mjs keygen --out <NEW-ABS-DIR> --agent build [--uuid <UUID>]
  node bin/lab.mjs register --registry <ABS-registry.json> --public <ABS-enrollment.json>
  node bin/lab.mjs plugin --config <ABS-terminal-config.json> --out <NEW-ABS-DIR> [--opencode-major 1|2|both]
  node bin/lab.mjs doctor [--opencode <EXE>] [--workspace <ABS-DIR>]
`;
function flags(args){const result={};for(let i=0;i<args.length;i+=2){const name=args[i];if(!/^--[a-z-]+$/.test(name)||args[i+1]===undefined||Object.hasOwn(result,name))throw new Error('Expected unique --name value pairs');result[name]=args[i+1];}return result;}
const required=(f,k)=>{if(!f[k])throw new Error(`Missing ${k}`);return f[k];};
const absolute=(f,k)=>{const p=required(f,k);if(!path.isAbsolute(p))throw new Error(`${k} must be absolute`);return p;};
const print=value=>console.log(JSON.stringify(value,null,2));
export async function main(argv=process.argv.slice(2)) {
  const [command,...args]=argv;if(!command||['help','--help','-h'].includes(command)){console.log(usage);return;}
  if(Number(process.versions.node.split('.')[0])<22)throw new Error('Node 22+ required');
  const f=flags(args);
  const allowed={demo:['--out','--workspace','--agents','--port','--opencode-major','--legacy-readonly'],server:['--registry','--port'],verify:['--config','--agent'],call:['--config','--agent','--tool','--args','--args-file'],keygen:['--out','--agent','--uuid'],register:['--registry','--public'],plugin:['--config','--out','--opencode-major'],doctor:['--opencode','--workspace']};
  if(!allowed[command]||Object.keys(f).some(k=>!allowed[command].includes(k)))throw new Error(usage);
  if(f['--legacy-readonly']!==undefined&&!['true','false'].includes(f['--legacy-readonly']))throw new Error('--legacy-readonly must be true or false');
  if(command==='demo')return print(await setupDemo({directory:absolute(f,'--out'),workspaceRoot:absolute(f,'--workspace'),agents:(f['--agents']??'build,plan').split(','),port:Number(f['--port']??8765),opencodeMajor:f['--opencode-major']??'both',legacyReadOnly:f['--legacy-readonly']==='true'}));
  if(command==='keygen')return print(await generateIdentity(absolute(f,'--out'),required(f,'--agent'),f['--uuid']));
  if(command==='register')return print(await registerIdentity(absolute(f,'--registry'),absolute(f,'--public')));
  if(command==='plugin')return print(await generatePlugin(absolute(f,'--config'),absolute(f,'--out'),{opencodeMajor:f['--opencode-major']??'both'}));
  if(command==='verify')return print(await verifyTerminal(absolute(f,'--config'),required(f,'--agent')));
  if(command==='call'){
    const config=await loadTerminalConfig(absolute(f,'--config')),agent=config.agents.find(a=>a.agentName===required(f,'--agent'));
    if(!agent)throw new Error('Agent not configured');
    if(f['--args']&&f['--args-file'])throw new Error('Use --args OR --args-file');
    const raw=f['--args-file']?await readFile(absolute(f,'--args-file'),'utf8'):(f['--args']??'{}');
    return print(await callTool(config,agent,required(f,'--tool'),JSON.parse(raw.replace(/^\uFEFF/,''))));
  }
  if(command==='doctor'){
    const executable=f['--opencode']??(process.platform==='win32'?'opencode.exe':'opencode'),exec=promisify(execFile);
    const options={encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:1048576,cwd:f['--workspace']?await realpath(f['--workspace']):undefined};
    const version=(await exec(executable,['--version'],options)).stdout.trim();
    const detected=parseOpenCodeVersion(version);let agents,agentListError;
    try{agents=(await exec(executable,['agent','list'],options)).stdout;}catch{agentListError='This host did not expose agent list via the expected CLI; use the host Agent settings';}
    if(!detected.supported)process.exitCode=2;
    return print({node:process.versions.node,opencode:version,...detected,fragment:detected.profile?`opencode.${detected.profile}.fragment.json`:null,agents,agentListError});
  }
  const registryFile=absolute(f,'--registry');validateRegistry(await readJSON(registryFile));
  const server=createIdentityServer({registryFile});const url=await server.start(Number(f['--port']??8765));print({listening:url,registryFile});
  for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>server.close().then(()=>process.exit(0)));
}
main().catch(e=>{console.error(e instanceof SyntaxError?'Invalid JSON input':e.message);process.exitCode=1;});
