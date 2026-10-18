import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,rmdir} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
import {recordMaintenance} from '../lib/maintenance-log.mjs';
test('保活历史有界且只记录运行元数据，不保存传入的凭据/账号或原始响应',async()=>{
 const root=fileURLToPath(new URL('../../../.local/',import.meta.url));await mkdir(root,{recursive:true});const dir=await mkdtemp(root+'sqb-maintenance-log-test-'),path=dir+'/keepalive-history.json';
 try{await writeFile(path,JSON.stringify(Array.from({length:121},(_,i)=>({at:1800000000000+i,ok:true,token:'synthetic-history-secret'}))));await recordMaintenance(path,{at:1800000000200,ok:false,errorCode:'NETWORK_ERROR',expiresAt:1800604800000,tokenChanged:true,token:'synthetic-secret',phone:'13900000000',response:{token:'synthetic-secret'}});const content=await readFile(path,'utf8'),rows=JSON.parse(content);assert.equal(rows.length,120);assert.equal(rows[0].at,1800000000002);assert.deepEqual(rows.at(-1),{at:1800000000200,ok:false,errorCode:'NETWORK_ERROR',expiresAt:1800604800000,tokenChanged:true});assert(!content.includes('synthetic'));assert(!content.includes('13900000000'));assert(!content.includes('response'));}finally{await rm(path,{force:true});await rmdir(dir);}
});
