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
    if(connected.data.agentIdentityRequired===false) throw Object.assign(new Error('Agent credential required'),{code:'AGENT_CREDENTIAL_REQUIRED'});
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
  } catch(error) {
    checks[stage].status='failed';
    checks[stage].code=checks[stage].stage.toUpperCase()+'_FAILED';
    const messages={
      'local-config':'检查所选 Agent 是否存在于生成配置，且原私钥文件可读取。',
      'binding-configuration':'检查该服务 Key 是否为 Agent 凭证，以及生成的 UUID 是否已登记并绑定到此凭证。',
      'binding-validation':'AKB 返回的 Agent 绑定与本机 UUID、服务地址或 V2 配置不匹配。',
      'proof-verification':'AKB 未接受签名：检查登记公钥与本机 kid、Agent/策略启用状态、终端时间；有网关时检查公开路径前缀。',
      'verified-key-match':'验签响应与本机 UUID、kid、策略或密钥状态不匹配。',
      'mcp-initialize':'身份状态检查后，MCP 初始化失败；检查 MCP 接口地址、协议及网关配置。',
      'mcp-tools-list':'MCP 工具发现失败；检查服务 Key 的 LIST/SEARCH scope。',
      'mcp-identity':'MCP 身份工具失败或返回身份不匹配；检查 get_agent_identity 及 AKB 版本。',
    };
    if(Object.hasOwn(messages,error?.verificationStep)) {
      checks[stage].step=error.verificationStep;
      checks[stage].message=messages[error.verificationStep];
    }
    const codes=['AGENT_CREDENTIAL_REQUIRED','CREDENTIAL_OR_PROOF_INVALID','FORBIDDEN','REQUEST_TOO_LARGE','RATE_LIMITED','UPSTREAM_UNAVAILABLE','AKB_HTTP_ERROR'];
    if(codes.includes(error?.code)) checks[stage].reason=error.code;
    if(error?.code==='AGENT_CREDENTIAL_REQUIRED') checks[stage].message='当前 Key 为普通服务凭证。此插件需要 AKB Agent 凭证及对应 Agent UUID/公钥登记。';
    if(Number.isInteger(error?.status)&&error.status>=400&&error.status<=599) checks[stage].httpStatus=error.status;
    if(typeof error?.traceId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(error.traceId)) checks[stage].traceId=error.traceId;
  }
  return result;
}
