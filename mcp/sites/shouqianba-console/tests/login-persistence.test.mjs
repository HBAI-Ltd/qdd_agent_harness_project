import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime} from '../lib/runtime.mjs';

const account={ucToken:'synthetic-saved-token',phone:'13900000000',verified:true,refreshTime:Date.now()-3*86400000,identities:[],cookies:[['https://web-platforms-msp.shouqianba.com',[['saved_cookie','synthetic-cookie']]]]};
const current={trade_user_info:{role:'super_admin',merchant_id:3,merchant_user_id:4},loginUserInfo:{name:'合成测试店'}};
function fixture(responder,saveHook){let disk=structuredClone(account),clears=0;const calls=[],saves=[];const runtime=new Runtime({vault:'unused',load:async()=>structuredClone(disk),save:async(_path,v)=>{if(saveHook)await saveHook(v);saves.push(structuredClone(v));disk=structuredClone(v);},clear:async()=>{disk=null;clears++;},client:{cookies:new Map(),request:async(path,options)=>{calls.push({path,options});return responder(path,options);}}});return{runtime,calls,saves,get disk(){return disk;},get clears(){return clears;}};}

test('重启加载三天前的加密会话与cookie，先检查原token，不因刷新时间旧而强制刷新',async()=>{
 const f=fixture(path=>{assert.equal(path,'/api/login/ucUser/getCurrentUser');return current;});await f.runtime.init();assert.equal(f.runtime.status().stage,'saved_session');assert.equal(f.runtime.status().persistence.saved,true);assert.equal(f.runtime.client.cookies.get('https://web-platforms-msp.shouqianba.com').get('saved_cookie'),'synthetic-cookie');
 const status=await f.runtime.checkSession();assert.equal(status.stage,'authenticated');assert.equal(status.persistence.saved,true);assert.equal(f.calls.length,1);assert.equal(f.clears,0);assert.equal(f.disk.ucToken,account.ucToken);
});

test('旧token明确被拒后刷新并保存，新实例读取刷新后的token恢复商户',async()=>{
 const f=fixture((path,options)=>{if(path.endsWith('refreshToken'))return{status:2,token:'synthetic-renewed-token',valid_time:3600};if(options.token===account.ucToken)throw Object.assign(new Error(),{code:'AUTH_EXPIRED'});return current;});await f.runtime.init();await f.runtime.checkSession();assert.equal(f.disk.ucToken,'synthetic-renewed-token');assert.equal(f.runtime.status().stage,'authenticated');
 const again=new Runtime({vault:'unused',load:async()=>f.disk,save:async()=>{},client:{cookies:new Map(),request:async(path,options)=>{assert(!path.endsWith('refreshToken'));assert.equal(options.token,'synthetic-renewed-token');return current;}}});await again.init();assert.equal((await again.checkSession()).stage,'authenticated');
});

test('网络失败和未知/缺字段的刷新响应保留磁盘会话，不伪装成登录过期',async()=>{
 for(const response of [null,{}, {status:1},{status:2,token:''}]){
  const f=fixture(path=>{if(path.endsWith('refreshToken'))return response;throw Object.assign(new Error(),{code:'AUTH_EXPIRED'});});await f.runtime.init();await assert.rejects(f.runtime.checkSession(),{code:'SESSION_REFRESH_UNAVAILABLE'});assert.equal(f.disk.ucToken,account.ucToken);assert.equal(f.clears,0);assert.equal(f.runtime.status().stage,'saved_session');
 }
 const f=fixture(()=>{throw Object.assign(new Error(),{code:'NETWORK_ERROR'});});await f.runtime.init();await assert.rejects(f.runtime.checkSession(),{code:'NETWORK_ERROR'});assert.equal(f.disk.ucToken,account.ucToken);assert.equal(f.clears,0);
});

test('官方明确无会话或刷新后的token仍被拒，才清除无效登录',async()=>{
 for(const response of [{status:0},{status:2,token:'synthetic-rejected-token'}]){const f=fixture(path=>{if(path.endsWith('refreshToken'))return response;throw Object.assign(new Error(),{code:'AUTH_EXPIRED'});});await f.runtime.init();await assert.rejects(f.runtime.checkSession(),{code:'AUTH_EXPIRED'});assert.equal(f.disk,null);assert.equal(f.runtime.status().stage,'signed_out');assert.equal(f.clears,1);}
});

test('多个会话保存串行完成，保存失败不删除旧磁盘凭据且可重试',async()=>{
 let active=0,max=0,fail=true;const f=fixture(()=>current,async()=>{active++;max=Math.max(active,max);await new Promise(resolve=>setTimeout(resolve,5));active--;if(fail)throw Error('disk full');});await f.runtime.init();await assert.rejects(f.runtime.persist(),{code:'SESSION_SAVE_FAILED'});assert.equal(f.disk.ucToken,account.ucToken);assert.equal(f.clears,0);assert.equal(f.runtime.status().persistence.saved,false);fail=false;
 f.runtime.session.version=1;const first=f.runtime.persist();f.runtime.session.version=2;await Promise.all([first,f.runtime.persist()]);assert.equal(max,1);assert.equal(f.disk.version,2);assert.equal(f.runtime.status().persistence.saved,true);
});

test('用户断开后迟到的刷新不能复活或重新落盘旧账号',async()=>{
 let finish,started;const waiting=new Promise(resolve=>started=resolve),refresh=new Promise(resolve=>finish=resolve);const f=fixture(path=>{if(path.endsWith('refreshToken')){started();return refresh;}throw Object.assign(new Error(),{code:'AUTH_EXPIRED'});});await f.runtime.init();const outcome=f.runtime.checkSession().then(()=>null,e=>e);await waiting;await f.runtime.disconnect();finish({status:2,token:'synthetic-late-token'});assert.equal((await outcome).code,'SESSION_CHANGED');assert.equal(f.disk,null);assert.equal(f.saves.length,0);assert.equal(f.runtime.status().stage,'signed_out');
});
