import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readVault,writeVault} from './vault.mjs';

const legacyNames=['session.dpapi','native-profile.dpapi','mcp-key','browser-key'];
const keyValid=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message)=>Object.assign(new Error(message),{code,status:503});
const asPath=value=>value instanceof URL?fileURLToPath(value):path.resolve(value);
export const credentialsPath=root=>path.join(asPath(root),'credentials.dpapi');
function validate(value){
  if(!object(value)||value.schemaVersion!==1||value.service!=='shouqianba'||!keyValid(value.keys?.mcp)||!keyValid(value.keys?.browser)||(value.session!==null&&!object(value.session))||(value.nativeProfile!==null&&!object(value.nativeProfile)))throw fail('CREDENTIALS_INVALID','本机凭据文件格式无效，已保留原文件，请检查当前 Windows 用户及凭据文件');
  return value;
}
export async function readCredentials(root){const value=await readVault(credentialsPath(root));return value===null?null:validate(value);}
export async function readMcpKey(root){
  let directory=asPath(root);if(path.basename(directory)==='mcp-key')directory=path.dirname(directory);
  const value=await readCredentials(directory);if(value)return value.keys.mcp;
  // Read-only compatibility before the service has migrated a legacy install.
  const key=(await readFile(path.join(directory,'mcp-key'),'utf8')).trim();
  if(!keyValid(key))throw fail('CREDENTIALS_INVALID','本机 MCP 访问凭据无效，请检查经营台连接');return key;
}
async function alive(pid){try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}

export class CredentialStore {
  constructor({root,load=readVault,save=writeVault}={}){this.root=asPath(root);this.file=credentialsPath(root);this.load=load;this.save=save;this.current=null;this.queue=Promise.resolve();}
  snapshot(){if(!this.current)throw fail('CREDENTIALS_NOT_READY','本机凭据尚未初始化');return structuredClone(this.current);}
  async lock(){
    const file=this.file+'.lock',owner=randomUUID(),deadline=Date.now()+30000;
    await mkdir(this.root,{recursive:true});
    for(;;){
      let handle;
      try{handle=await open(file,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,owner}));return async()=>{await handle.close();try{const saved=JSON.parse(await readFile(file,'utf8'));if(saved.owner===owner)await rm(file,{force:true});}catch(error){if(error.code!=='ENOENT')throw error;}};}
      catch(error){if(handle){await handle.close();await rm(file,{force:true});throw error;}if(error.code!=='EEXIST')throw error;}
      try{
        const raw=await readFile(file,'utf8');let saved;try{saved=JSON.parse(raw);}catch{}
        const stale=saved&&Number.isInteger(saved.pid)?!(await alive(saved.pid)):Date.now()-(await stat(file)).mtimeMs>30000;
        if(stale&&await readFile(file,'utf8')===raw){await rm(file,{force:true});continue;}
      }catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(Date.now()>=deadline)throw fail('CREDENTIALS_BUSY','本机凭据正在更新，请稍后重试');
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
  exclusive(operation){
    const task=this.queue.then(async()=>{const release=await this.lock();try{return await operation();}finally{await release();}});
    this.queue=task.catch(()=>{});return task;
  }
  async init(){
    return this.exclusive(async()=>{
      let value=await this.load(this.file);
      if(value===null){
        const session=await this.load(path.join(this.root,'session.dpapi'));
        const nativeProfile=await this.load(path.join(this.root,'native-profile.dpapi'));
        const keys={};for(const [name,legacy]of [['mcp','mcp-key'],['browser','browser-key']]){
          try{keys[name]=(await readFile(path.join(this.root,legacy),'utf8')).trim();if(!keyValid(keys[name]))throw fail('CREDENTIALS_INVALID','旧版访问密钥无效，已保留原文件');}
          catch(error){if(error.code!=='ENOENT')throw error;keys[name]=randomBytes(32).toString('hex');}
        }
        value=validate({schemaVersion:1,service:'shouqianba',keys,session,nativeProfile,updatedAt:Date.now()});
        await this.save(this.file,value);
      }
      validate(value);
      const verified=validate(await this.load(this.file));
      if(JSON.stringify(verified)!==JSON.stringify(value))throw fail('CREDENTIALS_VERIFY_FAILED','合并凭据校验失败，已保留旧文件');
      this.current=verified;
      for(const name of legacyNames)await rm(path.join(this.root,name),{force:true});
      return this;
    });
  }
  async update(change){
    return this.exclusive(async()=>{
      const previous=validate(await this.load(this.file));
      const next=validate(await change(structuredClone(previous)));next.updatedAt=Date.now();
      await this.save(this.file,next);this.current=next;return this.snapshot();
    });
  }
  sessionStorage(){return {load:async()=>this.snapshot().session,save:async(_file,session)=>this.update(value=>({...value,session})),clear:async()=>this.update(value=>({...value,session:null}))};}
}
