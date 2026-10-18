import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {AuthManager, callbackParas} from '../local/auth.mjs';

const officialLogin = 'https://open.e.189.cn/api/logbox/oauth2/separate/unifyAccountLogin.do?paras=test&sign=test';
const callback = 'https://active1-e.ctseelink.cn/?paras=one%2Btwo%2Fthree%3D';
const login = token => ({token, phone:'13812345678', refreshToken:'refresh-test', roleInfos:[{id:'test-role',roleId:1,roleName:'测试角色',roleType:0}]});
const notFound = () => Object.assign(new Error('not found'),{code:'ENOENT'});
function harness(options = {}) {
  const events = [], files = new Map(); let now = 1800000000000;
  const paths = {vault:fileURLToPath(new URL('./active.dpapi',import.meta.url)),pendingVault:fileURLToPath(new URL('./pending.dpapi',import.meta.url)),baseUrl:'http://127.0.0.1:8790'};
  const auth = new AuthManager(paths, {
    now:()=>now,
    createCloud: config => ({async post(path, body) {events.push(['post',path,body,config]);return options.post ? options.post(path,body,config) : path.endsWith('getTyWebLoginUrl') ? officialLogin : login('new-test-token');}}),
    readVault:async path=>{if(options.readError)throw options.readError;if(!files.has(path))throw notFound();return files.get(path);},
    writeVault:async(path,value)=>{events.push(['write',path,value]);if(options.writeError)throw new Error('simulated disk error');files.set(path,value);},
    unlink:async path=>{events.push(['unlink',path]);files.delete(path);}
  });
  return {auth,events,files,paths,advance:ms=>now+=ms};
}

test('begin uses the exact official PC return URL and keeps state local', async()=>{
  const h=harness();await h.auth.init();const result=await h.auth.begin();
  assert.equal(result.url,officialLogin);assert.match(result.state,/^[a-f0-9]{32}$/);assert.equal(result.expiresIn,600);
  assert.deepEqual(h.events[0].slice(1,3),['/user-center/thirdParty/getTyWebLoginUrl',{returnUrl:'https://active1-e.ctseelink.cn'}]);
  assert.equal(h.files.size,0);
});

test('begin rejects changed official login hosts or paths',async()=>{
  for(const url of ['http://open.e.189.cn/api/logbox/oauth2/separate/unifyAccountLogin.do','https://open.e.189.cn.evil.invalid/api/logbox/oauth2/separate/unifyAccountLogin.do','https://open.e.189.cn/other','https://u@open.e.189.cn/api/logbox/oauth2/separate/unifyAccountLogin.do']){
    const h=harness({post:()=>url});await assert.rejects(h.auth.begin(),{code:'LOGIN_URL_INVALID'});
  }
});

test('callback accepts only the exact HTTPS official root and one paras',()=>{
  assert.equal(callbackParas(callback),'one+two/three=');
  for(const url of ['http://active1-e.ctseelink.cn/?paras=x','https://active1-e.ctseelink.cn.evil.invalid/?paras=x','https://active1-e.ctseelink.cn/other?paras=x','https://u@active1-e.ctseelink.cn/?paras=x','https://active1-e.ctseelink.cn:444/?paras=x','https://active1-e.ctseelink.cn/?paras=x#fragment','https://active1-e.ctseelink.cn/?paras=x&paras=y','https://active1-e.ctseelink.cn/?paras=x&returnUrl=y','https://active1-e.ctseelink.cn/?paras=','https://active1-e.ctseelink.cn/?paras=%0A','https://active1-e.ctseelink.cn/?paras=one+two'])assert.throws(()=>callbackParas(url));
});

test('invalid URL/state performs no exchange and a valid state is single use',async()=>{
  const h=harness();const {state}=await h.auth.begin();
  await assert.rejects(h.auth.finish(state,'https://evil.invalid/?paras=test'),{code:'LOGIN_CALLBACK_INVALID'});
  await assert.rejects(h.auth.finish('invalid',callback),{code:'LOGIN_STATE_INVALID'});
  assert.equal(h.events.filter(e=>e[0]==='post').length,1);
  await h.auth.finish(state,callback);
  assert.equal(h.events[1][2].paras,'one+two/three=');
  await assert.rejects(h.auth.finish(state,callback),{code:'LOGIN_STATE_INVALID'});
  assert.equal(h.events.filter(e=>e[0]==='post').length,2);
});

test('states expire and a new flow invalidates the previous flow',async()=>{
  const h=harness(),first=await h.auth.begin(),second=await h.auth.begin();
  await assert.rejects(h.auth.finish(first.state,callback),{code:'LOGIN_STATE_INVALID'});
  h.advance(600001);await assert.rejects(h.auth.finish(second.state,callback),{code:'LOGIN_STATE_INVALID'});
  assert.equal(h.events.filter(e=>e[0]==='post').length,2);
});

test('authorization is saved pending before activation; active account is preserved',async()=>{
  const h=harness();h.auth.login=login('old-test-token');const {state}=await h.auth.begin();const candidate=await h.auth.finish(state,callback);
  assert.equal(h.auth.login.token,'old-test-token');assert.equal(h.files.size,1);assert.equal(h.events.at(-1)[0],'write');
  assert.equal(candidate.phone,'138****5678');await h.auth.accept(candidate);
  assert.equal(h.auth.login.token,'new-test-token');assert.equal(h.auth.pending,null);assert.equal(h.events.at(-1)[0],'unlink');
});

test('missing role info preserves the exchanged token pending without guessing role ID',async()=>{
  const h=harness({post:path=>path.endsWith('getTyWebLoginUrl')?officialLogin:{token:'pending-test-token'}});h.auth.login=login('old-test-token');const {state}=await h.auth.begin();
  await assert.rejects(h.auth.finish(state,callback),{code:'ROLE_INFO_MISSING'});
  assert.equal(h.auth.pending.token,'pending-test-token');assert.equal(h.files.size,1);assert.equal(h.auth.login.token,'old-test-token');
  await assert.rejects(h.auth.finish(state,callback),{code:'LOGIN_STATE_INVALID'});
});

test('a pending write failure retains the result in memory and leaves active alone',async()=>{
  const h=harness({writeError:true});h.auth.login=login('old-test-token');const {state}=await h.auth.begin();
  await assert.rejects(h.auth.finish(state,callback),{code:'PENDING_VAULT_WRITE_FAILED'});
  assert.equal(h.auth.pending.token,'new-test-token');assert.equal(h.auth.login.token,'old-test-token');
});

test('init never silently ignores vault decryption errors',async()=>{
  const h=harness({readError:new Error('simulated decryption error')});await assert.rejects(h.auth.init(),{code:'VAULT_READ_FAILED'});
});

test('a failed single-use exchange is not retried with the same state',async()=>{
  const h=harness({post:path=>{if(path.endsWith('getTyWebLoginUrl'))return officialLogin;throw new Error('simulated transport error');}}),{state}=await h.auth.begin();
  await assert.rejects(h.auth.finish(state,callback),{code:'LOGIN_EXCHANGE_FAILED'});
  await assert.rejects(h.auth.finish(state,callback),{code:'LOGIN_STATE_INVALID'});
  assert.equal(h.events.filter(e=>e[0]==='post').length,2);
});

test('pending recovery never replaces an existing active account',async()=>{
  const h=harness();h.files.set(h.paths.vault,{version:1,login:login('old-test-token')});h.files.set(h.paths.pendingVault,{version:1,login:{token:'incomplete-test-token'}});
  await h.auth.init();assert.equal(h.auth.login.token,'old-test-token');assert.equal(h.auth.pending.token,'incomplete-test-token');assert.equal(h.events.length,0);
});

test('a second begin cannot interrupt an exchange before pending persistence',async()=>{
  let release;const waiting=new Promise(resolve=>{release=resolve;});
  const h=harness({post:path=>path.endsWith('getTyWebLoginUrl')?officialLogin:waiting}),{state}=await h.auth.begin(),finishing=h.auth.finish(state,callback);
  await assert.rejects(h.auth.begin(),{code:'LOGIN_BUSY'});
  await assert.rejects(h.auth.finish(state,callback),{code:'LOGIN_BUSY'});
  release(login('new-test-token'));await finishing;
  assert.equal(h.events.filter(e=>e[0]==='post').length,2);assert.equal(h.files.size,1);
});

test('exchange preserves both v4 data envelopes and flat successful token results',async()=>{
  for(const value of [{code:0,data:login('data-test-token')},{code:0,...login('flat-test-token')},{code:0,data:{},...login('root-test-token')}]){
    const h=harness({post:path=>path.endsWith('getTyWebLoginUrl')?officialLogin:value}),{state}=await h.auth.begin();
    const candidate=await h.auth.finish(state,callback);assert.equal(candidate.token,value.data?.token||value.token);assert.equal(h.files.size,1);
  }
});

test('empty or malformed success envelopes never overwrite pending or active vaults',async()=>{
  for(const value of [undefined,null,'invalid',[],{code:0},{code:0,data:{}},{code:0,data:{token:''}}]){
    const h=harness({post:path=>path.endsWith('getTyWebLoginUrl')?officialLogin:value});h.auth.login=login('old-test-token');const {state}=await h.auth.begin();
    await assert.rejects(h.auth.finish(state,callback),{code:'LOGIN_TOKEN_MISSING'});
    assert.equal(h.files.size,0);assert.equal(h.auth.login.token,'old-test-token');assert.equal(h.auth.pending,null);
  }
});
