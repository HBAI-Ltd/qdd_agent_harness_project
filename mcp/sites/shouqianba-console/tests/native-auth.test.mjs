import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime} from '../lib/runtime.mjs';
const device={fingerprint:'synthetic-stable-device',brand:'Windows',model:'SQB Local Bridge',name:'本机经营台'};
const token='synthetic-native-long-token-'.padEnd(72,'x');
const identity={merchant_user_id:42,merchant_name:'合成商户',role:'super_admin'};
const account={admin:{merchant_id:31,merchant_sn:'M31',role:'super_admin'},merchant:{id:31,name:'合成商户',sn:'M31'},store_list:[{id:6,name:'合成店'}]};
const login={code:'10000',mchUserTokenInfo:{token},uc_user_id:'synthetic-uc-user',loginUserInfos:[identity]};
function fixture(respond,stored=null){let disk=structuredClone(stored),clears=0;const calls=[];const config={vault:'unused',nativeDevice:device,nativeClient:{request:async(path,options)=>{calls.push({path,options});return respond(path,options);}},client:{cookies:new Map(),request:async()=>{throw Error('unexpected web auth');}},load:async()=>structuredClone(disk),save:async(_p,value)=>{disk=structuredClone(value);},clear:async()=>{disk=null;clears++;}};return {runtime:new Runtime(config),config,calls,get disk(){return disk;},get clears(){return clears;}};}
const rejected=code=>Object.assign(Error('synthetic failure'),{code});
const saved={ucToken:token,authSource:'apk',phone:'13900000000',identities:[identity],cookies:[]};

test('App验证码场景、短信自动提交合同及服务器设备身份，不接受浏览器设备替换',async()=>{
 const f=fixture((path,options)=>{if(path.endsWith('sendAuthCodeWithRisk'))return{bizCode:200,sendId:'synthetic-send'};if(path.endsWith('loginWithAuthCodeV2'))return login;if(path==='/V2/Account/get')return account;throw Error(path);});
 assert.equal(f.runtime.status().auth.captcha.sceneId,'1wuucxrx');
 await f.runtime.sendCode({phone:'13900000000',captchaVerifyParam:'synthetic-human-result'});
 const risk=JSON.parse(f.calls[0].options.body.riskData);assert.equal(risk.sceneId,'1wuucxrx');assert.equal(risk.captchaVerifyParam,'synthetic-human-result');
 const status=await f.runtime.login({phone:'13900000000',code:'123456',fingerprint:'browser-cannot-override'});
 const body=f.calls[1].options.body;assert.equal(body.authCode,'123456');assert.equal(body.sendId,'synthetic-send');assert.equal(body.uc_device.device_fingerprint,device.fingerprint);assert.equal(body.uc_device.platform,'收钱吧APP');
 assert.equal(status.stage,'authenticated');assert.equal(status.auth.sessionSource,'apk');assert.equal(f.disk.context.merchant_user_id,42);assert.equal(f.disk.context.merchant_id,31);assert.equal(f.disk.ucUserId,'synthetic-uc-user');assert.equal(f.calls.length,3);assert(!JSON.stringify(status).includes(token));assert(!JSON.stringify(status).includes(device.fingerprint));
});

test('App长令牌重启走原生refresh后取账户，保存轮换结果供下一实例恢复',async()=>{
 const next=token+'renewed';const f=fixture((path,options)=>{if(path.endsWith('refreshToken')){assert.equal(options.method,'GET');assert.equal(options.query.threshold,86400);assert.equal(options.query.token,undefined);return{status:2,token:next};}assert.equal(path,'/V2/Account/get');assert.equal(options.query.token,next);assert.equal(options.token,next);return account;},saved);
 await f.runtime.init();assert.equal(f.runtime.status().stage,'saved_session');await f.runtime.checkSession();assert.equal(f.disk.ucToken,next);assert.equal(f.calls.length,2);
 const again=new Runtime(f.config);await again.init();assert.equal(again.session.ucToken,next);assert.equal(again.session.verified,false);assert.equal(again.status().auth.sessionSource,'apk');
});

test('App旧短令牌启动经loginWithAppToken转换，不当作每日续租接口',async()=>{
 const f=fixture(path=>{if(path.endsWith('loginWithAppToken'))return login;if(path==='/V2/Account/get')return account;throw Error(path);},{...saved,ucToken:'synthetic-old-token'});await f.runtime.init();await f.runtime.checkSession();assert.equal(f.disk.ucToken,token);assert.equal(f.calls[0].options.body.token,'synthetic-old-token');assert.equal(f.calls[0].options.body.uc_device.device_fingerprint,device.fingerprint);assert.equal(f.calls.length,2);
});

test('App网络失败/未知刷新响应保留磁盘记录；明确status0/1或900001才清理',async()=>{
 for(const response of [null,{}, {status:2,token:''}]){const f=fixture(()=>response,saved);await f.runtime.init();await assert.rejects(f.runtime.checkSession(),{code:'SESSION_REFRESH_UNAVAILABLE'});assert.equal(f.disk.ucToken,token);assert.equal(f.clears,0);}
 const offline=fixture(()=>{throw rejected('NETWORK_ERROR');},saved);await offline.runtime.init();await assert.rejects(offline.runtime.checkSession(),{code:'NETWORK_ERROR'});assert.equal(offline.disk.ucToken,token);
 for(const value of [0,1,'900001']){const f=fixture(()=>{if(value==='900001')throw rejected('NATIVE_TOKEN_INVALID');return{status:value};},saved);await f.runtime.init();await assert.rejects(f.runtime.checkSession());assert.equal(f.disk,null);assert.equal(f.clears,1);}
});

test('原生900003刷新后重试一次，网页数据拒绝不抹掉仍有效的App会话',async()=>{
 let attempts=0;const f=fixture(path=>{if(path.endsWith('refreshToken'))return{status:2,token:token+'rotated'};if(++attempts===1)throw rejected('AUTH_EXPIRED');return account;});f.runtime.session=structuredClone(saved);
 await f.runtime.checkSession();assert.equal(f.disk.ucToken,token+'rotated');assert.equal(f.calls.length,3);
 f.runtime.client.request=async()=>{throw rejected('AUTH_EXPIRED');};await assert.rejects(f.runtime.authenticated('/api/findStores'),{code:'DATA_AUTH_UNVERIFIED'});assert.equal(f.runtime.status().stage,'authenticated');assert.equal(f.clears,0);
});

test('App额外设备校验不能伪装登录成功，商户身份必须由用户明确选择',async()=>{
 for(const code of ['20034','20041','20043','20033']){const f=fixture(path=>path.endsWith('sendAuthCodeWithRisk')?{bizCode:200,sendId:'synthetic-send'}:{...login,code});await f.runtime.sendCode({phone:'13900000000',captchaVerifyParam:'synthetic'});await assert.rejects(f.runtime.login({phone:'13900000000',code:'123456'}));assert.equal(f.disk,null);assert.equal(f.runtime.status().stage,'signed_out');}
 const identities=[identity,{merchant_user_id:43,merchant_name:'第二合成商户'}];const f=fixture(path=>{if(path.endsWith('sendAuthCodeWithRisk'))return{bizCode:200,sendId:'synthetic-send'};if(path.endsWith('loginWithAuthCodeV2'))return{...login,loginUserInfos:identities};if(path.endsWith('changeLoginUser'))return{...login,mchUserTokenInfo:{token:token+'selected'}};if(path==='/V2/Account/get')return{...account,admin:{...account.admin,merchant_user_id:43}};throw Error(path);});await f.runtime.sendCode({phone:'13900000000',captchaVerifyParam:'synthetic'});await f.runtime.login({phone:'13900000000',code:'123456'});assert.equal(f.calls.length,2);assert.equal(f.runtime.status().stage,'saved_session');assert.equal(f.runtime.status().identities[1].name,'第二合成商户');await f.runtime.chooseIdentity({index:1});assert.equal(f.calls[2].options.body.merchantUserId,43);assert.equal(f.calls[2].options.body.token,token);assert.equal(f.disk.ucToken,token);assert.equal(f.disk.context.merchant_user_id,43);
});

test('旧网页会话不自动升级为App会话，原生配置缺失不回退网页续期',async()=>{
 const f=fixture(()=>{throw Error('no native expected');},{...saved,authSource:'web'});f.runtime.client.request=async path=>{assert.equal(path,'/api/login/ucUser/getCurrentUser');return{trade_user_info:{role:'super_admin',merchant_id:31,merchant_user_id:42}};};await f.runtime.init();await f.runtime.checkSession();assert.equal(f.calls.length,0);assert.equal(f.runtime.status().auth.sessionSource,'web');
 const absent=new Runtime({...f.config,nativeClient:null,load:async()=>saved});await absent.init();await assert.rejects(absent.checkSession(),{code:'NATIVE_PROFILE_REQUIRED'});assert.equal(absent.status().stage,'saved_session');
});

test('断开后迟到的App启动刷新不能复活本机会话',async()=>{
 let finish,started;const waiting=new Promise(r=>started=r);const f=fixture(()=>{started();return new Promise(r=>finish=r);},saved);await f.runtime.init();const outcome=f.runtime.checkSession().catch(e=>e);await waiting;await f.runtime.disconnect();finish({status:2,token:token+'late'});assert.equal((await outcome).code,'SESSION_CHANGED');assert.equal(f.disk,null);assert.equal(f.clears,1);
});
