import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
export const HEADER = 'X-Agent-Proof';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const AGENT = /^[A-Za-z0-9_.:-]{1,128}$/;
export const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export function publicKid(jwk) { return createHash('sha256').update(JSON.stringify({ e:jwk.e, kty:jwk.kty, n:jwk.n })).digest('base64url'); }
export function endpoint(value) {
  const u = new URL(value);
  if (!['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.protocol!=='http:' || u.pathname!=='/mcp' || u.search || u.hash || u.username || u.password) throw new Error('Local demo requires http://127.0.0.1:<port>/mcp (localhost / ::1 also supported)');
  return u.href;
}
export function makeProof({uuid,agentName,privateKey,url,body,sessionId='terminal',invocationId=randomUUID(),now=Math.floor(Date.now()/1000),jti=randomUUID()}) {
  if (!UUID.test(uuid) || !AGENT.test(agentName)) throw new Error('Invalid UUID or Agent name');
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType!=='rsa' || key.asymmetricKeyDetails.modulusLength<3072) throw new Error('RSA 3072 or stronger required');
  const jwk=createPublicKey(key).export({format:'jwk'}),kid=publicKid(jwk),target=new URL(endpoint(url));
  const claims={ver:1,sub:uuid,agent:agentName,aud:target.href,iat:now,exp:now+30,jti,session_id:sessionId,invocation_id:invocationId,method:'POST',path:target.pathname,body_sha256:hash(body)};
  const input=`${encode({alg:'RS256',typ:'mcp-agent-proof+jwt',kid})}.${encode(claims)}`;
  return `${input}.${sign('RSA-SHA256',Buffer.from(input),key).toString('base64url')}`;
}
export function verifyProof(token,{registry,url,body,method='POST',replay,now=Math.floor(Date.now()/1000)}) {
  const reject=()=>{throw new Error('Agent authentication failed');};
  if (typeof token!=='string' || token.length>8192) reject();
  const parts=token.split('.'); if(parts.length!==3 || parts.some(x=>!/^[A-Za-z0-9_-]+$/.test(x)))reject();
  let h,c;try{h=JSON.parse(Buffer.from(parts[0],'base64url'));c=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{reject();}
  if(!h || h.alg!=='RS256' || h.typ!=='mcp-agent-proof+jwt' || !c || c.ver!==1 || !UUID.test(c.sub) || !AGENT.test(c.agent))reject();
  const registered=registry.agents.find(a=>a.uuid===c.sub);
  if(!registered || registered.enabled!==true || registered.agentName!==c.agent || registered.kid!==h.kid)reject();
  let key;try{key=createPublicKey({key:registered.publicJwk,format:'jwk'});}catch{reject();}
  if(key.asymmetricKeyType!=='rsa' || key.asymmetricKeyDetails.modulusLength<3072 || publicKid(registered.publicJwk)!==h.kid)reject();
  if(!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key,Buffer.from(parts[2],'base64url')))reject();
  if(!Number.isSafeInteger(c.iat)||!Number.isSafeInteger(c.exp)||c.exp<=now||c.iat>now+5||c.exp<=c.iat||c.exp-c.iat>30)reject();
  if(c.aud!==endpoint(url)||c.method!==method||c.path!=='/mcp'||c.body_sha256!==hash(body)||!UUID.test(c.jti)||!UUID.test(c.invocation_id)||typeof c.session_id!=='string'||c.session_id.length<1||c.session_id.length>128)reject();
  for(const [key,exp]of replay)if(exp<=now)replay.delete(key);
  const nonce=`${c.sub}:${h.kid}:${c.jti}`;if(replay.has(nonce)||replay.size>=10000)reject();replay.set(nonce,c.exp);
  return Object.freeze({uuid:c.sub,agentName:c.agent,kid:h.kid,sessionId:c.session_id,invocationId:c.invocation_id,verified:true});
}
