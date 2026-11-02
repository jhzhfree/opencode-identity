import path from 'node:path';
import {readJSON} from './files.mjs';
import {sdk} from '../sdk.mjs';

/** Public material only, selected from this completed build's known Agent records. */
export async function publicEnrollment(build,agentName) {
  if(build?.target!=='akb') throw Object.assign(new Error('请选择 AKB 生成任务'),{status:400});
  const record=build.agents.find(agent=>agent.agentName===agentName);
  if(!record) throw Object.assign(new Error('此任务中不存在该 Agent'),{status:400});
  const S=await sdk();
  const material=await readJSON(path.join(build.dataDir,record.publicKeyFile));
  if(!S.isPublicOnlyJwk(material)) throw new Error('公钥文件格式无效');
  const publicJwk=S.publicJwkOf(S.importPublicKey(material));
  if(publicJwk.kid!==record.kid) throw new Error('公钥与生成记录不匹配');
  return {agentName:record.agentName,uuid:record.uuid,kid:record.kid,publicJwk,publicPem:S.exportPublicPem(publicJwk)};
}
