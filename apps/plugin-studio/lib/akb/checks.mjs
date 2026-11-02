import {loadAkbConfig,serviceCredential,requestJson,apiUrl,invocationSignal,verifyAgent,invokeAkb} from './client.mjs';
import {saveVerifiedBinding} from './installer.mjs';

/** Management checks never equate discovery, identity and retrieval success. */
export async function checkAkb({configFile,agentName,query='',knowledgeBaseId=''}) {
  const checks=['connection','identity','catalog','retrieval'].map(stage=>({stage,status:'not_checked',code:''}));
  const result={ok:false,checks};
  let stage=0;
  try {
    const config=await loadAkbConfig(configFile);
    const connected=await requestJson(apiUrl(config,'/api/v1/external/connection'),{
      serviceKey:serviceCredential(config),signal:invocationSignal(undefined,config.timeoutMs),
    });
    if(connected.success!==true || connected.data?.connected!==true) throw new Error('CONNECTION_REJECTED');
    checks[stage++].status='success';
    const verified=await verifyAgent(configFile,agentName);
    await saveVerifiedBinding(configFile,agentName,verified.binding);
    checks[stage++].status='success';
    const captured={agentName,directory:config.workspaceRoot,sessionId:'management:'+agentName,messageId:'connection-check',signal:new AbortController().signal};
    result.catalog=await invokeAkb(configFile,captured,'akb_bases',{});
    checks[stage++].status='success';
    if(!query.trim()) return result;
    result.retrieval=await invokeAkb(configFile,captured,'akb_search',knowledgeBaseId?{query,knowledgeBaseId}:{query});
    checks[stage].status='success';
    result.ok=true;
  } catch {
    checks[stage].status='failed';
    checks[stage].code=checks[stage].stage.toUpperCase()+'_FAILED';
  }
  return result;
}
