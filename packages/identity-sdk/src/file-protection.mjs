/** Owner-only files on POSIX; SID-based ACLs on Windows (no localized name parsing). */
import { lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const exec=promisify(execFile);
const trusted=(sid,acl)=>sid===acl.self||sid==='S-1-5-18'||sid==='S-1-5-32-544'||sid==='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'||acl.logonSids.includes(sid);
async function powershell(target,script) {
  const root=process.env.SystemRoot||process.env.windir||'C:\\Windows';
  const executable=path.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const prelude="$ErrorActionPreference='Stop';$p=$env:IDENTITY_LAB_ACL_PATH;$self=[Security.Principal.WindowsIdentity]::GetCurrent();";
  const encoded=Buffer.from(prelude+script,'utf16le').toString('base64');
  try {
    return (await exec(executable,['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:1048576,env:{...process.env,IDENTITY_LAB_ACL_PATH:target}})).stdout.trim();
  }catch(e){
    const detail=String((e&&(e.stderr||e.stdout))||(e&&e.message)||e||'').replace(/[\r\n]+/g,' ').trim().slice(0,300);
    throw new Error('Windows ACL operation failed on '+target+(detail?': '+detail:'')+'; use an owner-controlled NTFS directory and Windows PowerShell 5.1+');
  }
}
function systemTool(name) {
  const root=process.env.SystemRoot||process.env.windir||'C:\\Windows';
  for(const dir of ['System32','Sysnative']){const candidate=path.join(root,dir,name+'.exe');if(existsSync(candidate))return candidate;}
  return name+'.exe';
}
async function icacls(args) {
  try {
    await exec(systemTool('icacls'),args,{windowsHide:true,timeout:20000,maxBuffer:1048576});
  }catch(e){
    const detail=String((e&&(e.stderr||e.stdout))||(e&&e.message)||e||'').replace(/[\r\n]+/g,' ').trim().slice(0,300);
    throw new Error('Windows ACL operation failed on '+args[args.length-1]+(detail?': '+detail:'')+'; use an owner-controlled NTFS directory');
  }
}
// ACL reads spawn Windows PowerShell, which costs ~0.3s each and dominates every
// protected write and read. Results are cached briefly (a few seconds) and always
// dropped after hardening, so a change can never be served stale for long.
const aclCache=new Map();
const ACL_TTL_MS=3000;
function acl(target) {
  const hit=aclCache.get(target);
  if(hit&&Date.now()-hit.at<ACL_TTL_MS)return Promise.resolve(hit.value);
  return aclRead(target).then(value=>{aclCache.set(target,{at:Date.now(),value});return value;});
}
async function aclRead(target) {
  const raw=await powershell(target,"$a=Get-Acl -LiteralPath $p; $rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {@{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;allow=($_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow);inheritOnly=(($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)}}); @{self=$self.User.Value;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;logonSids=@($self.Groups|ForEach-Object {$_.Value}|Where-Object {$_ -like 'S-1-5-5-*'});rules=$rules}|ConvertTo-Json -Depth 5 -Compress");
  const value=JSON.parse(raw);if(!Array.isArray(value.rules)||!Array.isArray(value.logonSids))throw new Error('ACL unavailable');return value;
}
const fileError='Identity files must be owner-only regular files';
const parentError='Identity parent directories must not be writable by other users';
export function protectionPolicy() {
  if(process.platform!=='win32')return {
    async harden(){},
    verifyHandle(s){if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077))throw new Error(fileError);},
    async verifyFile(p){const s=await lstat(p);this.verifyHandle(s);if(s.isSymbolicLink())throw new Error(fileError);},
    async verifyDirectory(p){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw new Error('Directory must be owner-only (0700)');},
    async verifyParents(p){for(let cur=p;;cur=path.dirname(cur)){const s=await lstat(cur);if(!s.isDirectory()||s.isSymbolicLink()||(s.uid!==0&&s.uid!==process.getuid())||((s.mode&0o022)&&!((s.mode&0o1000)&&s.uid===0)))throw new Error(parentError);if(path.dirname(cur)===cur)break;}}
  };
  return {
    async harden(target,kind){
      // Set-Acl writes the SACL too, which needs SeSecurityPrivilege and fails in
      // ordinary processes with PrivilegeNotHeldException. icacls touches only the
      // DACL and owner, and takes the SID directly (no localized account names).
      const sid=(await acl(target)).self;
      await icacls([target,'/inheritance:r','/grant:r',kind==='directory'?`*${sid}:(OI)(CI)F`:`*${sid}:F`]);
      await icacls([target,'/setowner',`*${sid}`]);
      aclCache.clear();
    },
    verifyHandle(s){if(!s.isFile())throw new Error(fileError);},
    async verifyFile(p){const s=await lstat(p);if(!s.isFile()||s.isSymbolicLink())throw new Error(fileError);const a=await acl(p);if(a.owner!==a.self||!a.rules.some(r=>r.allow&&r.sid===a.self&&!r.inheritOnly)||a.rules.some(r=>r.allow&&!r.inheritOnly&&!trusted(r.sid,a)))throw new Error(fileError);},
    async verifyDirectory(p){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Invalid protected directory');const a=await acl(p);if(a.owner!==a.self||!a.rules.some(r=>r.allow&&r.sid===a.self&&!r.inheritOnly)||a.rules.some(r=>r.allow&&!r.inheritOnly&&!trusted(r.sid,a)))throw new Error('Directory must be owner-only');},
    async verifyParents(p){
      // Append/create-child (4) alone does not modify an existing child directory.
      const writeMask=2|16|64|256|65536|262144|524288;
      for(let cur=p;;cur=path.dirname(cur)){
        const s=await lstat(cur);if(!s.isDirectory()||s.isSymbolicLink())throw new Error(parentError);
        const a=await acl(cur);
        if(!trusted(a.owner,a)||a.rules.some(r=>r.allow&&!r.inheritOnly&&!trusted(r.sid,a)&&r.sid!=='S-1-3-0'&&(r.rights&writeMask)))throw new Error(parentError);
        if(path.dirname(cur)===cur)break;
      }
    }
  };
}
