import test from 'node:test';import assert from 'node:assert/strict';
import {SessionKeeper} from '../lib/session-keeper.mjs';import {Runtime} from '../lib/runtime.mjs';
const token='synthetic-keeper-native-token-'.padEnd(70,'x');
const user={admin:{merchant_id:3,merchant_user_id:4,role:'super_admin'},merchant:{id:3,name:'合成保活商户'}};
const saved={ucToken:token,authSource:'apk',phone:'13900000000',identities:[],cookies:[],verified:true};
const error=code=>Object.assign(Error('synthetic upstream failure'),{code});
function fixture(responder){let disk=structuredClone(saved),clears=0,saveFails=false;const calls=[];const runtime=new Runtime({vault:'unused',client:{cookies:new Map()},nativeClient:{request:async(path,options)=>{calls.push({path,options});return responder(path,options);}},load:async()=>structuredClone(disk),save:async(_p,v)=>{if(saveFails)throw Error('synthetic disk unavailable');disk=structuredClone(v);},clear:async()=>{disk=null;clears++;}});runtime.session=structuredClone(saved);return{runtime,calls,get disk(){return disk;},get clears(){return clears;},failSave(value){saveFails=value;}};}
function clock(runtime){let now=1800000000000,id=0;const timers=new Map();const keeper=new SessionKeeper({runtime,now:()=>now,setTimer:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)});return{keeper,timers,async tick(){assert.equal(timers.size,1);const [id,{fn,ms}]=[...timers][0];timers.delete(id);now+=ms;fn();await keeper.running;},advance(ms){now+=ms;},get delay(){return[...timers.values()][0]?.ms;}};}

test('后台启动后六小时刷新/查账户，云端有效期持久化且状态不含凭据',async()=>{
 const expires=Date.now()+604800000;const f=fixture(path=>path.endsWith('refreshToken')?{status:2,token:token+'r',valid_time:604800000,expire_time:expires}:user);const c=clock(f.runtime);await c.keeper.start();assert.equal(c.keeper.status().state,'healthy');assert.equal(f.disk.expireTime,expires);assert.equal(f.runtime.status().lease.expiresAt,expires);assert.equal(c.delay,21600000);assert.equal(f.calls.length,2);await c.tick();assert.equal(f.calls.length,4);assert.equal(c.keeper.status().lastError,null);assert(!JSON.stringify(c.keeper.status()).includes(token));assert(!JSON.stringify(f.runtime.status()).includes(token));c.keeper.stop();assert.equal(c.timers.size,0);
});

test('断网/超时/HTTP异常按1、5、15、60分钟退避，保留磁盘会话，恢复后重置六小时',async()=>{
 for(const code of ['NETWORK_ERROR','UPSTREAM_HTTP','UPSTREAM_FORMAT','SESSION_REFRESH_UNAVAILABLE']){let fail=true;const f=fixture(path=>{if(fail)throw error(code);return path.endsWith('refreshToken')?{status:2,token:token+'r'}:user;});const c=clock(f.runtime);await c.keeper.start();assert.equal(c.delay,60000);for(const ms of [300000,900000,3600000,21600000]){await c.tick();assert.equal(c.delay,ms);assert.equal(f.disk.ucToken,token);assert.equal(f.clears,0);}assert.equal(c.keeper.status().state,'retrying');fail=false;await c.tick();assert.equal(c.keeper.status().state,'healthy');assert.equal(c.delay,21600000);assert.equal(f.disk.ucToken,token+'r');c.keeper.stop();}
});

test('刷新持久化失败保留旧磁盘记录，重试保存新token，不标为健康或退出账号',async()=>{
 const f=fixture(path=>path.endsWith('refreshToken')?{status:2,token:token+'r'}:user);f.failSave(true);const c=clock(f.runtime);await c.keeper.start();assert.equal(c.keeper.status().lastError,'SESSION_SAVE_FAILED');assert.equal(c.keeper.status().state,'retrying');assert.equal(f.disk.ucToken,token);assert.equal(f.runtime.session.ucToken,token+'r');assert.equal(f.clears,0);f.failSave(false);await c.tick();assert.equal(f.disk.ucToken,token+'r');assert.equal(c.keeper.status().state,'healthy');c.keeper.stop();
});

test('过期900003续期轮换与并发后台/业务读共享一次刷新',async()=>{
 let finish,started;const startedPromise=new Promise(r=>started=r);let refreshed=false;const f=fixture(async(path,options)=>{if(path.endsWith('refreshToken')){started();await new Promise(r=>finish=r);refreshed=true;return{status:2,token:token+'new'};}if(!refreshed||options.token===token)throw error('AUTH_EXPIRED');return user;});const a=f.runtime.keepAlive();await startedPromise;const b=f.runtime.keepAlive();const read=f.runtime.authenticated('/V2/Account/get',{method:'GET',nativeAuth:true});await Promise.resolve();finish();await Promise.all([a,b,read]);assert.equal(f.calls.filter(c=>c.path.endsWith('refreshToken')).length,1);assert.equal(f.disk.ucToken,token+'new');assert.equal(f.clears,0);
});

test('主动检查不重叠；停用后迟到的任务不再排下一次，长时间空闲只触发一次',async()=>{
 let finish,count=0;const runtime={nativeClient:{},session:{authSource:'apk',ucToken:token},keepAlive:async()=>{count++;await new Promise(r=>finish=r);}};const c=clock(runtime);const first=c.keeper.start();assert.equal(c.keeper.run(),first);assert.equal(count,1);finish();await first;c.advance(3*86400000);const next=c.tick();assert.equal(count,2);c.keeper.stop();finish();await next;assert.equal(c.timers.size,0);assert.equal(c.keeper.status().nextCheckAt,null);
});

test('明确撤销和不可继续的SDK状态要求重新登录，不反复提交已撤销凭据',async()=>{
 for(const response of ['NATIVE_TOKEN_INVALID',{status:0},{status:1}]){const f=fixture(()=>{if(typeof response==='string')throw error(response);return response;});const c=clock(f.runtime);await c.keeper.start();assert.equal(c.keeper.status().state,'relogin_required');assert.equal(f.disk,null);assert.equal(f.clears,1);const count=f.calls.length;await c.tick();assert.equal(f.calls.length,count);c.keeper.stop();}
});

test('无登录/旧web会话不使用原生保活；断开或切换会话后不被迟到刷新复活',async()=>{
 for(const session of [null,{...saved,authSource:'web'}]){let calls=0;const runtime={nativeClient:{},session,keepAlive:async()=>{calls++;}};const c=clock(runtime);await c.keeper.start();assert.equal(calls,0);await c.tick();assert.equal(calls,0);c.keeper.stop();}
 let finish,started;const wait=new Promise(r=>started=r);const f=fixture(()=>{started();return new Promise(r=>finish=r);});const c=clock(f.runtime);const result=c.keeper.start();await wait;await f.runtime.disconnect();finish({status:2,token:token+'late'});await result;assert.equal(f.disk,null);assert.equal(f.runtime.status().stage,'signed_out');assert.equal(f.clears,1);assert.equal(c.keeper.status().state,'relogin_required');c.keeper.stop();
});
