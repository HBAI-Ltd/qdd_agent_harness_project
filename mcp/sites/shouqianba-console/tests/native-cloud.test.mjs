import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeCloudClient,buildNativeRequest,signNativeParams} from '../lib/native-cloud.mjs';

const NOW=1700000000000;
const profile=()=>({appId:'test-app',appSecret:'test-secret',version:'7.3.1',device:{fingerprint:'device-fixture',brand:'Fixture',model:'Fixture Phone',name:'测试设备'}});
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function fixture(reply=()=>response({code:10000,data:{ok:true}})){
  const calls=[];
  const client=new NativeCloudClient({profile:profile(),now:()=>NOW,fetcher:async(url,init)=>{calls.push({url,init});return reply(url,init);}});
  return {client,calls};
}

test('native signer uses independent known value=key MD5 vector, including null and Unicode',()=>{
  // Explicit preimage: =nil&alpha=z&test-secret=appSecret&中文=a
  assert.equal(signNativeParams({z:'alpha',a:'中文',nil:null},'test-secret'),'D83DC9D629D9874A52EB2CA2C2F83410');
});

test('JSON signature uses compact nested Unicode JSON and recovered native common parameters',()=>{
  const {url,init}=buildNativeRequest(profile(),'/v6/appUser/sendAuthCodeChooseRisk',{body:{identifier:'测试',nested:{note:'你好',enabled:true,count:2}}},NOW);
  assert.equal(init.headers.signature,'BB68C7EEBC5C936EA7B1BF612911322A');
  assert.equal(init.body,'{"identifier":"测试","nested":{"note":"你好","enabled":true,"count":2}}');
  assert.equal(url.origin,'https://mapi.shouqianba.com');
  assert.equal(url.searchParams.get('deviceId'),'device-fixture');
  assert.equal(url.searchParams.get('device_model'),'1');
  assert.equal(url.searchParams.get('os_type'),'0');
  assert.equal(init.headers.device_type,'Fixture Phone');
  assert.equal(init.headers.timestamp,'1700000000000000');
  assert.equal(init.headers['Shouqianba-Client'],'shouqianba-app-native');
  assert.equal(init.headers.Authorization,undefined);assert.equal(init.headers.Origin,undefined);
  assert.equal(init.redirect,'error');
  assert(!url.href.includes('test-secret'));assert(!init.body.includes('test-secret'));
});

test('refresh keeps original threshold query and newly injected token is not signed',()=>{
  const opts={method:'GET',query:{threshold:86400000},token:'synthetic-token +/中文'};
  const first=buildNativeRequest(profile(),'/v5/ucToken/refreshToken',opts,NOW);
  const second=buildNativeRequest(profile(),'/v5/ucToken/refreshToken',{...opts,token:'another-token'},NOW);
  const withoutThreshold=buildNativeRequest(profile(),'/v5/ucToken/refreshToken',{method:'GET',token:opts.token},NOW);
  assert.equal(first.url.searchParams.get('threshold'),'86400000');
  assert.equal(first.url.searchParams.get('token'),opts.token);
  assert(first.url.search.includes('%20'));assert(first.url.search.includes('%2B'));
  assert.equal(first.init.headers.signature,second.init.headers.signature);
  assert.notEqual(first.init.headers.signature,withoutThreshold.init.headers.signature);
  assert.equal(first.init.body,undefined);
});

test('Account.get signs explicit query token and appends current token without replacing the original',async()=>{
  // Recovered aw4.a.g adds a query pair; w97.a does not replace an existing token.
  const options={method:'GET',query:{token:'synthetic-account-token'},token:'synthetic-current-token'};
  const first=buildNativeRequest(profile(),'/V2/Account/get',options,NOW);
  const changedCurrent=buildNativeRequest(profile(),'/V2/Account/get',{...options,token:'different-current'},NOW);
  const changedExplicit=buildNativeRequest(profile(),'/V2/Account/get',{...options,query:{token:'different-account'}},NOW);
  assert.deepEqual(first.url.searchParams.getAll('token'),['synthetic-account-token','synthetic-current-token']);
  assert.equal(first.init.headers.signature,changedCurrent.init.headers.signature);
  assert.notEqual(first.init.headers.signature,changedExplicit.init.headers.signature);
  const explicitOnly=buildNativeRequest(profile(),'/V2/Account/get',{method:'GET',query:{token:'synthetic-account-token'}},NOW);
  assert.deepEqual(explicitOnly.url.searchParams.getAll('token'),['synthetic-account-token']);
  assert.equal(first.init.headers.signature,explicitOnly.init.headers.signature);
  const {client}=fixture(()=>response({code:10000,data:{admin:{},merchant:{},store_list:[]}}));
  assert.deepEqual(await client.request('/V2/Account/get',options),{admin:{},merchant:{},store_list:[]});
  assert.throws(()=>buildNativeRequest(profile(),'/V2/Account/get',{body:{}},NOW),{code:'INVALID_ENDPOINT'});
});

test('login enrichment signs actual final body, removes nested IP and empties unavailable location without mutating caller',()=>{
  const body={identifier:'13900000000',auth_code:'123456',uc_device:{device_type:1,device_fingerprint:'device-fixture',IP:'must-remove',latitude:'must-clear'}};
  const initial=structuredClone(body);
  const {url,init}=buildNativeRequest(profile(),'/v6/appUser/loginWithAuthCodeV2',{body,token:'synthetic-session'},NOW);
  assert.deepEqual(JSON.parse(init.body),{identifier:'13900000000',auth_code:'123456',uc_device:{device_type:1,device_fingerprint:'device-fixture',latitude:'',device_address:'',longitude:''},ip:''});
  assert.deepEqual(body,initial);
  assert.equal(url.searchParams.get('token'),'synthetic-session');
  assert.equal(init.headers.signature,'435CF1BD5E781C6CB4B031427E03DA72');
  const existingIp=buildNativeRequest(profile(),'/v6/appUser/loginWithAuthCodeV2',{body:{...body,ip:'192.0.2.1'}},NOW);
  assert.equal(JSON.parse(existingIp.init.body).ip,'192.0.2.1');
});

test('loginWithAppToken is not part of selected sensitive login enrichment paths',()=>{
  const body={uc_device:{IP:'synthetic-ip',latitude:'synthetic-location'}};
  const {init}=buildNativeRequest(profile(),'/v6/appUser/loginWithAppToken',{body},NOW);
  assert.deepEqual(JSON.parse(init.body),body);
});

test('explicit body token is signed while automatic query token is not',()=>{
  const body={id:'synthetic-identity',token:'body-context-token'};
  const a=buildNativeRequest(profile(),'/v6/appUser/changeLoginUser',{body,token:'session-one'},NOW);
  const b=buildNativeRequest(profile(),'/v6/appUser/changeLoginUser',{body,token:'session-two'},NOW);
  const c=buildNativeRequest(profile(),'/v6/appUser/changeLoginUser',{body:{...body,token:'changed-body-token'},token:'session-one'},NOW);
  assert.equal(a.init.headers.signature,b.init.headers.signature);
  assert.notEqual(a.init.headers.signature,c.init.headers.signature);
});

test('strict endpoint and method allowlist rejects arbitrary URL, query-in-path and unsupported request forms before fetch',async()=>{
  const {client,calls}=fixture();
  for(const path of ['https://example.com/v6/appUser/getLoginInfo','//example.com/x','/v6/appUser/getLoginInfo?token=x','/v6/appUser/../getLoginInfo','/api/findStores'])await assert.rejects(client.request(path),{code:'INVALID_ENDPOINT'});
  await assert.rejects(client.request('/v6/appUser/getLoginInfo'),{code:'INVALID_ENDPOINT'});
  await assert.rejects(client.request('/v5/ucToken/refreshToken',{method:'GET',body:{}}),{code:'NATIVE_REQUEST_INVALID'});
  await assert.rejects(client.request('/v6/appUser/sendAuthCodeWithRisk',{body:new URLSearchParams({x:'1'})}),{code:'NATIVE_REQUEST_INVALID'});
  await assert.rejects(client.request('/v6/appUser/sendAuthCodeWithRisk',{body:{},query:{extra:'unsigned'}}),{code:'NATIVE_REQUEST_INVALID'});
  await assert.rejects(client.request('/v5/ucToken/refreshToken',{method:'GET',query:{token:'caller-token'}}),{code:'NATIVE_REQUEST_INVALID'});
  assert.equal(calls.length,0);
});

test('profile validation is generic and snapshots configuration without publicly exposing secret',()=>{
  for(const value of [{}, {...profile(),appSecret:''}, {...profile(),version:'bad'}, {...profile(),device:{...profile().device,model:'bad\r\nheader'}}, {...profile(),commonDeviceModel:'4'}])assert.throws(()=>new NativeCloudClient({profile:value}),{code:'NATIVE_PROFILE_INVALID'});
  const config=profile();const client=new NativeCloudClient({profile:config});config.appSecret='mutated';
  assert(!JSON.stringify(client).includes('test-secret'));
  assert.throws(()=>buildNativeRequest(profile(),'/v6/appUser/loginWithAuthCodeV2',{body:{x:NaN}},NOW),{code:'NATIVE_REQUEST_INVALID'});
  const cyclic={};cyclic.self=cyclic;
  assert.throws(()=>buildNativeRequest(profile(),'/v6/appUser/loginWithAuthCodeV2',{body:cyclic},NOW),{code:'NATIVE_REQUEST_INVALID'});
});

test('request returns success data and supplies timeout, redirects rejected and TLS defaults untouched',async()=>{
  const {client,calls}=fixture(()=>response({code:'10000',data:{identities:[]}}));
  assert.deepEqual(await client.request('/v6/appUser/getLoginInfo',{method:'GET',token:'synthetic-token'}),{identities:[]});
  assert.equal(calls.length,1);assert.equal(calls[0].init.redirect,'error');
  assert(calls[0].init.signal instanceof AbortSignal);assert.equal(calls[0].init.signal.aborted,false);
  for(const field of ['agent','dispatcher','rejectUnauthorized'])assert.equal(calls[0].init[field],undefined);
});

test('network and redirect failures become sanitized service errors without retries',async()=>{
  const {client,calls}=fixture(()=>{throw new Error('token=must-not-leak redirect or TLS failure');});
  await assert.rejects(client.request('/v6/appUser/getLoginInfo',{method:'GET'}),error=>error.code==='NETWORK_ERROR'&&!error.message.includes('must-not-leak'));
  assert.equal(calls.length,1);
});

test('900003 expiry and 900001 invalid native token remain distinct',async()=>{
  for(const [code,expected] of [[900003,'AUTH_EXPIRED'],[900001,'NATIVE_TOKEN_INVALID']]){
    const {client}=fixture(()=>response({code,message:'token=must-not-leak',data:{token:'never-expose'}}));
    await assert.rejects(client.request('/v6/appUser/getLoginInfo',{method:'GET'}),error=>error.code===expected&&error.status===401&&error.upstreamCode===String(code)&&!JSON.stringify(error).includes('never-expose')&&!error.message.includes('must-not-leak'));
  }
});

test('unknown upstream codes are preserved safely without treating special login codes as success',async()=>{
  for(const code of [50000,80001,20034,20041,20043,'RISKREQUIRED','RISK_REQUIRED','bad token=secret']){
    const {client}=fixture(()=>response({code,message:'captcha=secret',data:{token:'secret'}}));
    await assert.rejects(client.request('/v6/appUser/getLoginInfo',{method:'GET'}),error=>error.code==='UPSTREAM_REJECTED'&&!error.message.includes('secret')&&(['bad token=secret','RISK_REQUIRED'].includes(code)?error.upstreamCode===undefined:error.upstreamCode===String(code)));
  }
});

test('native converter accepts JSON-string data and falls back to whole successful body when data absent',async()=>{
  const stringData=fixture(()=>response({code:10000,data:'{"code":20034,"choices":[{"id":"synthetic"}]}'}));
  assert.deepEqual(await stringData.client.request('/v6/appUser/getLoginInfo',{method:'GET'}),{code:20034,choices:[{id:'synthetic'}]});
  const noData=fixture(()=>response({code:10000,result:'synthetic-model-field'}));
  assert.deepEqual(await noData.client.request('/v6/appUser/getLoginInfo',{method:'GET'}),{code:10000,result:'synthetic-model-field'});
  const invalidString=fixture(()=>response({code:10000,data:'not JSON'}));
  await assert.rejects(invalidString.client.request('/v6/appUser/getLoginInfo',{method:'GET'}),{code:'UPSTREAM_FORMAT'});
});

test('HTTP failure and malformed or structurally invalid envelopes are explicit',async()=>{
  const cases=[()=>response({code:10000},503),()=>new Response('not JSON'),()=>response(null),()=>response({code:null}),()=>response({code:{nested:10000}})];
  for(const [index,reply] of cases.entries()){
    const {client}=fixture(reply);
    await assert.rejects(client.request('/v6/appUser/getLoginInfo',{method:'GET'}),{code:index===0?'UPSTREAM_HTTP':'UPSTREAM_FORMAT'});
  }
});

test('native converter follows optional outer code and null/empty data rules',async()=>{
 for(const envelope of [{data:null},{data:''},{code:10000,data:null}]){const f=fixture(()=>response(envelope));assert.deepEqual(await f.client.request('/v6/appUser/getLoginInfo',{method:'GET'}),{});}
 const f=fixture(()=>response({bizCode:200,sendId:'synthetic-send'}));assert.deepEqual(await f.client.request('/v6/appUser/sendAuthCodeWithRisk',{body:{}}),{bizCode:200,sendId:'synthetic-send'});
});
