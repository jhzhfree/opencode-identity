import { createServer } from 'node:http';
import { createPublicKey } from 'node:crypto';
import { readJSON } from './files.mjs';
import { HEADER, UUID, AGENT, publicKid, verifyProof } from './proof.mjs';
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export function validateRegistry(value) {
  if (!object(value) || value.version!==1 || !Array.isArray(value.agents) || value.agents.length>100) throw new Error('Invalid registry');
  const ids = new Set();
  for (const a of value.agents) {
    if(!object(a)||!UUID.test(a.uuid)||!AGENT.test(a.agentName)||typeof a.enabled!=='boolean'||ids.has(a.uuid)||!object(a.publicJwk)) throw new Error('Invalid registry entry');
    if(['d','p','q','dp','dq','qi','oth'].some(k=>k in a.publicJwk))throw new Error('Registry must contain public keys only');
    const key=createPublicKey({key:a.publicJwk,format:'jwk'});
    if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<3072||a.kid!==publicKid(a.publicJwk))throw new Error('Invalid registered RSA key');
    ids.add(a.uuid);
  }
  return value;
}
function argsOnly(args, fields) {
  if(!object(args)||Object.keys(args).some(k=>!fields.includes(k)))throw new Error('Invalid tool arguments; identity comes from the server context');
}
function verifiedIdentity(context) {
  if(!context?.identity?.verified || !Object.isFrozen(context.identity))throw new Error('Verified request identity required');
  return context.identity;
}
// Every tool method receives context.identity from the authentication boundary.
export const tools = {
  whoami: {description:'Return the current Agent UUID/name verified with the registered public key',schema:{type:'object',properties:{},additionalProperties:false},
    run(args,context){argsOnly(args,[]);return {identity:verifiedIdentity(context)};}},
  echo_secure: {description:'Echo text together with the verified caller identity',schema:{type:'object',properties:{text:{type:'string',maxLength:2000}},required:['text'],additionalProperties:false},
    run(args,context){const identity=verifiedIdentity(context);argsOnly(args,['text']);if(typeof args.text!=='string'||args.text.length>2000)throw new Error('text must be a string up to 2000 characters');return {text:args.text,identity};}},
  add: {description:'Add two finite numbers and include the verified caller identity',schema:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b'],additionalProperties:false},
    run(args,context){const identity=verifiedIdentity(context);argsOnly(args,['a','b']);if(!Number.isFinite(args.a)||!Number.isFinite(args.b)||!Number.isFinite(args.a+args.b))throw new Error('a/b/result must be finite numbers');return {sum:args.a+args.b,identity};}}
};
const error = (id,code,message) => ({jsonrpc:'2.0',id:id??null,error:{code,message}});
function rpc(body,identity) {
  if(!object(body)||body.jsonrpc!=='2.0'||typeof body.method!=='string')return error(body?.id,-32600,'Invalid JSON-RPC request');
  if(body.method==='notifications/initialized' && !('id' in body))return null;
  if(!('id' in body)||(typeof body.id!=='string'&&typeof body.id!=='number'))return error(null,-32600,'A request ID is required');
  const ok=result=>({jsonrpc:'2.0',id:body.id,result});
  if(body.method==='initialize')return ok({protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'local-agent-identity-mcp',version:'1.1.0'},instructions:'Use whoami to check the server-verified Agent. Never provide identity as tool arguments.'});
  if(body.method==='ping')return ok({});
  if(body.method==='tools/list')return ok({tools:Object.entries(tools).map(([name,t])=>({name,description:t.description,inputSchema:t.schema,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}))});
  if(body.method!=='tools/call')return error(body.id,-32601,'Method not found');
  const p=body.params;
  if(!object(p)||typeof p.name!=='string'||!Object.hasOwn(tools,p.name))return error(body.id,-32602,'Unknown tool');
  try {
    const data=tools[p.name].run(p.arguments??{},Object.freeze({identity}));
    return ok({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError:false});
  } catch(e){return error(body.id,-32602,e.message);}
}
/**
 * @param {{registryFile?: string, audit?: (event: Record<string, any>) => unknown}} [options]
 */
export function createIdentityServer({registryFile, audit = event => process.stdout.write(JSON.stringify(event)+'\n')}={}) {
  if(typeof registryFile!=='string'||!registryFile)throw new Error('registryFile is required');
  const replay = new Map(); let serverUrl;
  const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(data===undefined?'':JSON.stringify(data));};
  const server=createServer(async(req,res)=>{
    if(req.headers.host!==new URL(serverUrl).host){send(res,403,{error:'Invalid Host'});return;}
    if(req.headers.origin && req.headers.origin!==new URL(serverUrl).origin){send(res,403,{error:'Invalid Origin'});return;}
    if(req.method==='GET'&&req.url==='/health'){send(res,200,{ok:true,server:'local-agent-identity-mcp'});return;}
    if(req.url!=='/mcp'){send(res,404,{error:'Not found'});return;}
    if(req.method!=='POST'){res.setHeader('Allow','POST');send(res,405,{error:'Use POST /mcp'});return;}
    if(!(req.headers['content-type']??'').toLowerCase().startsWith('application/json')){send(res,415,{error:'Use application/json'});return;}
    let raw;
    try {
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>65536){send(res,413,{error:'Request too large'});return;}chunks.push(chunk);}
      raw=Buffer.concat(chunks);
    }catch{if(!res.writableEnded)send(res,400,{error:'Invalid request body'});return;}
    let registry;
    try {registry=validateRegistry(await readJSON(registryFile));}catch{send(res,503,{error:'Registry unavailable or invalid'});return;}
    let identity;
    try {identity=verifyProof(req.headers[HEADER.toLowerCase()],{registry,url:serverUrl,body:raw,method:req.method,replay});}
    catch{audit({time:new Date().toISOString(),event:'authentication_failed'});send(res,401,error(null,-32001,'Agent authentication failed'));return;}
    let body;try{body=JSON.parse(raw.toString('utf8'));}catch{send(res,200,error(null,-32700,'Parse error'));return;}
    const result=rpc(body,identity);
    audit({time:new Date().toISOString(),event:'mcp_request',uuid:identity.uuid,agentName:identity.agentName,invocationId:identity.invocationId,method:body?.method,tool:body?.params?.name,success:result?.error===undefined});
    send(res,result===null?202:200,result===null?undefined:result);
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  return {
    async start(port=8765){
      if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
      const address=server.address();
      if(!address || typeof address==='string')throw new Error('Server address unavailable');
      serverUrl=`http://127.0.0.1:${address.port}/mcp`;return serverUrl;
    },
    async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));},
    get url(){return serverUrl;}
  };
}
