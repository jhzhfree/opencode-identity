import { AGENT } from './proof.mjs';
export const TOOL_NAMES=Object.freeze({whoami:'identity_whoami',echo_secure:'identity_echo',add:'identity_add'});
export function parseOpenCodeVersion(output) {
  const match=typeof output==='string'&&output.match(/(?:^|\s)(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?(?=\s|$)/i);
  if(!match)throw new Error('Cannot parse OpenCode version');
  const major=Number(match[1]);
  return {version:`${match[1]}.${match[2]}.${match[3]}${match[4]?'-'+match[4]:''}`,major,supported:[1,2].includes(major),profile:major===1?'v1':major===2?'v2':null};
}
export function requireMajor(value='both') {
  if(!['1','2','both'].includes(String(value)))throw new Error('OpenCode major must be 1, 2 or both');
  return String(value);
}
export function captureExecution({agentName,sessionId,signal,directory=undefined,messageId=undefined,callId=undefined}) {
  if(typeof agentName!=='string'||!AGENT.test(agentName)||typeof sessionId!=='string'||sessionId.length<1||sessionId.length>128
    ||!signal||typeof signal.throwIfAborted!=='function')throw new Error('Missing trusted OpenCode execution identity or cancellation signal');
  signal.throwIfAborted();
  return Object.freeze({agentName,sessionId,signal,directory,messageId,callId});
}
export async function awaitCancellable(promise,signal) {
  signal.throwIfAborted();let listener;
  const cancelled=new Promise((_,reject)=>{listener=()=>reject(signal.reason??new Error('Cancelled'));signal.addEventListener('abort',listener,{once:true});});
  try {return await Promise.race([promise,cancelled]);}finally{signal.removeEventListener('abort',listener);}
}
export function businessArgs(name,args) {
  return name==='whoami'?{}:name==='echo_secure'?{text:args.text}:{a:args.a,b:args.b};
}
