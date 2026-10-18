import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rmdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readVault } from '../lib/vault.mjs';

test('原生初始化拒绝空参数，加密保存独立设备身份，重复执行不覆盖已有凭据',async()=>{
 const root=fileURLToPath(new URL('../../../.local/',import.meta.url));await mkdir(root,{recursive:true});const dir=await mkdtemp(root+'sqb-init-test-'),configPath=dir+'/client-config.json';
 const script=fileURLToPath(new URL('../../../scripts/initialize-shouqianba.mjs',import.meta.url));
 const run=async()=>{const child=spawn(process.execPath,[script],{env:{...process.env,SQB_STATE_DIR:dir,SQB_CLIENT_CONFIG_PATH:configPath},windowsHide:true,stdio:['ignore','pipe','pipe']});const output=[];child.stdout.on('data',c=>output.push(c));child.stderr.on('data',c=>output.push(c));const[code]=await once(child,'exit');return{code,output:Buffer.concat(output).toString('utf8')};};
 try{
  await writeFile(configPath,JSON.stringify({appId:'',appSecret:'',version:'7.3.1'}));assert.equal((await run()).code,1);assert.equal((await readVault(dir+'/credentials.dpapi')).nativeProfile,null);
  await writeFile(configPath,JSON.stringify({appId:'synthetic-app',appSecret:'synthetic-private-client-value',version:'7.3.1',device:{fingerprint:'cannot-import-old-device'},token:'cannot-import-account'}));
  const first=await run();assert.equal(first.code,0);assert(!first.output.includes('synthetic-private-client-value'));const encrypted=await readFile(dir+'/credentials.dpapi','utf8');assert(!encrypted.includes('synthetic-private-client-value'));
  const saved=await readVault(dir+'/credentials.dpapi'),profile=saved.nativeProfile;assert.equal(saved.session,null);assert.equal(profile.appSecret,'synthetic-private-client-value');assert.match(profile.device.fingerprint,/^[a-f0-9-]{36}$/);assert.equal(profile.device.brand,'Windows');assert.equal(profile.token,undefined);assert(!(await readdir(dir)).includes('session.dpapi'));
  await writeFile(configPath,'invalid JSON must not replace a valid profile');assert.equal((await run()).code,0);assert.equal(await readFile(dir+'/credentials.dpapi','utf8'),encrypted);assert(!(await readdir(dir)).includes('native-profile.dpapi.lock'));
 }finally{for(const name of ['client-config.json','credentials.dpapi','credentials.dpapi.lock'])await rm(dir+'/'+name,{force:true});await rmdir(dir);}
});
