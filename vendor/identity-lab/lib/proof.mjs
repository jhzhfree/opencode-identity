// Local V1 profile. No AKB fallback and no duplicate signing/verifying code.
import {S} from './sdk.mjs';
export const HEADER = S.HEADER;
export const UUID = S.UUID_PATTERN;
export const AGENT = S.AGENT_PATTERN;
export const hash = S.sha256Hex;
export const publicKid = S.keyId;
export const endpoint = S.assertLocalEndpoint;
export const makeProof = S.createProof;
export function verifyProof(token,{registry,url,body,method='POST',replay,now=Math.floor(Date.now()/1000)}) {
  const adapter = {use(nonce,exp,at) {
    for(const [key,expiry] of replay) if(expiry<=at) replay.delete(key);
    if(replay.has(nonce)||replay.size>=10000)return false;
    replay.set(nonce,exp);return true;
  }};
  return S.verifyProof(token,{resolveAgent:S.registryResolver(registry),url,body,method,replay:adapter,now});
}
