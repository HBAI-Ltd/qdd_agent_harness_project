import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,rmdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import net from 'node:net';
import {writeVault,readVault} from '../lib/vault.mjs';

test('真实服务关闭再启动：恢复DPAPI账号、旧浏览器cookie与刷新后的凭据',async()=>{
 const root=fileURLToPath(new URL('../../../.local/',import.meta.url));await mkdir(root,{recursive:true});const dir=await mkdtemp(root+'sqb-restart-test-');let child;
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));const base='http://127.0.0.1:'+port;
 async function start(){child=spawn(process.execPath,['--import',new URL('./fixtures/restart-cloud.mjs',import.meta.url).href,fileURLToPath(new URL('../server.mjs',import.meta.url))],{env:{...process.env,SQB_HOST:'127.0.0.1',SQB_PORT:String(port),SQB_STATE_DIR:dir},windowsHide:true,stdio:['ignore','pipe','pipe']});await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Restart test server exited');}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Restart test server timeout')),8000).unref())]);}
 async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}child=null;}
 try{
  for(const token of ['synthetic-restart-token','synthetic-expired-restart-token']){
   await writeVault(dir+'/session.dpapi',{ucToken:token,phone:'13900000000',verified:true,refreshTime:Date.now()-3*86400000,cookies:[['https://web-platforms-msp.shouqianba.com',[['restore_cookie','synthetic-persisted-cookie']]]]});
   await start();const page=await fetch(base),cookie=page.headers.get('set-cookie').split(';')[0];assert.match(page.headers.get('set-cookie'),/Max-Age=2592000/);
   const headers={Cookie:cookie,'Content-Type':'application/json'};assert.equal((await(await fetch(base+'/api/status',{headers})).json()).stage,'saved_session');
   let response=await fetch(base+'/api/auth/check',{method:'POST',headers,body:'{}'});assert.equal(response.status,200);const status=await response.json();assert.equal(status.stage,'authenticated');assert.equal(status.persistence.saved,true);assert.equal(status.merchant.merchantId,303);
   const disk=await readFile(dir+'/session.dpapi','utf8');assert(!disk.includes('synthetic'));assert(!disk.includes('13900000000'));assert.equal((await readVault(dir+'/session.dpapi')).ucToken,token.includes('expired')?'synthetic-renewed-restart-token':token);
   await stop();await start();response=await fetch(base+'/api/status',{headers});assert.equal(response.status,200);assert.equal((await response.json()).stage,'saved_session');response=await fetch(base+'/api/auth/check',{method:'POST',headers,body:'{}'});assert.equal(response.status,200);assert.equal((await response.json()).stage,'authenticated');await stop();
  }
 }finally{await stop();for(const name of ['session.dpapi','browser-key','mcp-key'])await rm(dir+'/'+name,{force:true});await rmdir(dir);}
});
