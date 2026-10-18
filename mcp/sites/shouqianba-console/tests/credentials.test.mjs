import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,readdir,rm,rmdir} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {CredentialStore,readCredentials,readMcpKey} from '../lib/credentials.mjs';import {readVault,writeVault} from '../lib/vault.mjs';
const local=fileURLToPath(new URL('../../../.local/',import.meta.url));
const legacy=['session.dpapi','native-profile.dpapi','mcp-key','browser-key'];
const session={ucToken:'synthetic-consolidated-token',phone:'13900000000',authSource:'apk',cookies:[]};
const profile={appId:'synthetic-app',appSecret:'synthetic-consolidated-secret',device:{fingerprint:'synthetic-stable-device'}};
const keys={mcp:'a'.repeat(64),browser:'b'.repeat(64)};
const state=()=>({schemaVersion:1,service:'shouqianba',session:structuredClone(session),nativeProfile:structuredClone(profile),keys:{...keys},updatedAt:1});
const fakeLoad=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const fakeSave=async(file,value)=>{await writeFile(file,JSON.stringify(value));};
async function fixture(fn){await mkdir(local,{recursive:true});const dir=await mkdtemp(path.join(local,'sqb-single-file-test-'));try{return await fn(dir);}finally{for(const name of await readdir(dir))await rm(path.join(dir,name));await rmdir(dir);}}
async function legacyFixture(dir,save=fakeSave){await save(path.join(dir,legacy[0]),session);await save(path.join(dir,legacy[1]),profile);await writeFile(path.join(dir,legacy[2]),keys.mcp);await writeFile(path.join(dir,legacy[3]),keys.browser);}

test('真实DPAPI将四份凭据合并到单文件，保留令牌/设备/密钥；断开只清会话',()=>fixture(async dir=>{
 await legacyFixture(dir,writeVault);assert.equal(await readMcpKey(dir),keys.mcp);
 const store=await new CredentialStore({root:dir}).init();const value=await readCredentials(dir);assert.deepEqual(value.session,session);assert.deepEqual(value.nativeProfile,profile);assert.deepEqual(value.keys,keys);assert.deepEqual(await readdir(dir),['credentials.dpapi']);
 const disk=await readFile(store.file,'utf8');for(const secret of [session.ucToken,session.phone,profile.appSecret,keys.mcp,keys.browser])assert(!disk.includes(secret));assert.equal(await readMcpKey(path.join(dir,'mcp-key')),keys.mcp);
 await store.sessionStorage().clear();const cleared=await readVault(store.file);assert.equal(cleared.session,null);assert.deepEqual(cleared.nativeProfile,profile);assert.deepEqual(cleared.keys,keys);assert.deepEqual(await readdir(dir),['credentials.dpapi']);
}));

test('写入失败时完整保留四个旧文件，不把迁移当成功',()=>fixture(async dir=>{
 await legacyFixture(dir);const store=new CredentialStore({root:dir,load:fakeLoad,save:async()=>{throw Error('synthetic disk full');}});await assert.rejects(store.init());assert.deepEqual((await readdir(dir)).sort(),legacy.toSorted());assert.equal((await fakeLoad(path.join(dir,legacy[0]))).ucToken,session.ucToken);
}));

test('合并后回读校验失败时不删除旧凭据',()=>fixture(async dir=>{
 await legacyFixture(dir);const store=new CredentialStore({root:dir,load:fakeLoad,save:async(file,value)=>fakeSave(file,{...value,updatedAt:value.updatedAt+1})});await assert.rejects(store.init(),{code:'CREDENTIALS_VERIFY_FAILED'});for(const file of legacy)assert((await readdir(dir)).includes(file));
}));

test('损坏或未知版本的单文件不会回退、覆盖或清除旧凭据',()=>fixture(async dir=>{
 await legacyFixture(dir);const bad={...state(),schemaVersion:99};await fakeSave(path.join(dir,'credentials.dpapi'),bad);const store=new CredentialStore({root:dir,load:fakeLoad,save:fakeSave});await assert.rejects(store.init(),{code:'CREDENTIALS_INVALID'});assert.deepEqual(await fakeLoad(store.file),bad);assert((await readdir(dir)).includes('session.dpapi'));
}));

test('两个存储实例并发更新会话和App配置，不丢字段也不轮换访问密钥',()=>fixture(async dir=>{
 const options={root:dir,load:fakeLoad,save:async(file,value)=>{await new Promise(r=>setTimeout(r,8));await fakeSave(file,value);}};const a=new CredentialStore(options),b=new CredentialStore(options);await Promise.all([a.init(),b.init()]);const initial=await fakeLoad(a.file);
 await Promise.all([a.update(value=>({...value,session:{...session,ucToken:'synthetic-refreshed'}})),b.update(value=>({...value,nativeProfile:profile}))]);const current=await fakeLoad(a.file);assert.equal(current.session.ucToken,'synthetic-refreshed');assert.deepEqual(current.nativeProfile,profile);assert.deepEqual(current.keys,initial.keys);assert.deepEqual(await readdir(dir),['credentials.dpapi']);
}));

test('进程中断留下的锁可恢复，重启仍使用同一个凭据文件',()=>fixture(async dir=>{
 await fakeSave(path.join(dir,'credentials.dpapi'),state());await writeFile(path.join(dir,'credentials.dpapi.lock'),JSON.stringify({pid:2147483647,owner:'synthetic-dead-process'}));const store=await new CredentialStore({root:dir,load:fakeLoad,save:fakeSave}).init();assert.equal(store.snapshot().session.ucToken,session.ucToken);assert.deepEqual(await readdir(dir),['credentials.dpapi']);
}));

test('已迁移的单文件优先于旧残留，过时备份不覆盖新会话',()=>fixture(async dir=>{
 await legacyFixture(dir);const latest={...state(),session:{...session,ucToken:'synthetic-latest-token'}};await fakeSave(path.join(dir,'credentials.dpapi'),latest);const store=await new CredentialStore({root:dir,load:fakeLoad,save:fakeSave}).init();assert.equal(store.snapshot().session.ucToken,'synthetic-latest-token');assert.deepEqual(store.snapshot().keys,keys);assert.deepEqual(await readdir(dir),['credentials.dpapi']);
}));

test('旧版访问密钥无效时拒绝迁移，不生成替代密钥破坏现有连接',()=>fixture(async dir=>{
 await legacyFixture(dir);await writeFile(path.join(dir,'mcp-key'),'invalid legacy value');const store=new CredentialStore({root:dir,load:fakeLoad,save:fakeSave});await assert.rejects(store.init(),{code:'CREDENTIALS_INVALID'});assert.deepEqual((await readdir(dir)).sort(),legacy.toSorted());
}));
