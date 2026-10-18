import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,rmdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import net from 'node:net';
import {writeVault,readVault} from '../lib/vault.mjs';

test('App真实进程重启：加载加密配置/会话、原生启动轮换、再次重启和旧浏览器cookie恢复',async()=>{
 const root=fileURLToPath(new URL('../../../.local/',import.meta.url));await mkdir(root,{recursive:true});const dir=await mkdtemp(root+'sqb-native-restart-test-');let child;
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));const base='http://127.0.0.1:'+port;
 async function start(){child=spawn(process.execPath,['--import',new URL('./fixtures/native-restart-cloud.mjs',import.meta.url).href,fileURLToPath(new URL('../server.mjs',import.meta.url))],{env:{...process.env,SQB_HOST:'127.0.0.1',SQB_PORT:String(port),SQB_STATE_DIR:dir},windowsHide:true,stdio:['ignore','pipe','pipe']});await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Native restart server exited');}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Native restart server timeout')),20000).unref())]);}
 async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}child=null;}
 const token='synthetic-native-restart-token-'.padEnd(72,'x');
 try{
  await writeVault(dir+'/native-profile.dpapi',{appId:'synthetic-app',appSecret:'synthetic-native-profile-secret',version:'7.3.1',commonDeviceModel:'1',device:{fingerprint:'synthetic-native-restart-device',brand:'Windows',model:'SQB Local Bridge',name:'合成测试设备'}});
  await writeVault(dir+'/session.dpapi',{ucToken:token,authSource:'apk',phone:'13900000000',identities:[],cookies:[]});
  let headers;
  for(let round=1;round<=2;round++){
   await start();if(!headers){const page=await fetch(base);headers={Cookie:page.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'};}
   const before=await(await fetch(base+'/api/status',{headers})).json();assert(['saved_session','authenticated'].includes(before.stage));assert.equal(before.auth.loginSource,'apk');assert.equal(before.auth.sessionSource,'apk');assert.equal(before.auth.captcha.sceneId,'1wuucxrx');assert(!JSON.stringify(before).includes('synthetic-native-profile-secret'));
   const response=await fetch(base+'/api/auth/check',{method:'POST',headers,body:'{}'});assert.equal(response.status,200);const status=await response.json();assert.equal(status.stage,'authenticated');assert.equal(status.persistence.saved,true);assert.equal(status.merchant.merchantId,303);
   const credentials=await readVault(dir+'/credentials.dpapi'),saved=credentials.session;assert.equal(credentials.nativeProfile.device.fingerprint,'synthetic-native-restart-device');assert.equal(saved.ucToken,token+'r'.repeat(round));assert.equal(saved.authSource,'apk');assert.equal(saved.context.merchant_user_id,404);
   for(const name of ['credentials.dpapi']){const bytes=await readFile(dir+'/'+name,'utf8');assert(!bytes.includes('synthetic'));assert(!bytes.includes('13900000000'));}
   await stop();
  }
 }finally{await stop();for(const name of ['session.dpapi','native-profile.dpapi','browser-key','mcp-key','keepalive-history.json','credentials.dpapi'])await rm(dir+'/'+name,{force:true});await rmdir(dir);}
});
