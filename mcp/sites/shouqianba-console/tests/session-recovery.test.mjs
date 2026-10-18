import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,rmdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {localKey} from '../lib/local-key.mjs';
import {localApi} from '../web/session.js';
const response=(status,data)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
test('服务重启和并发启动复用同一个本地访问标识',async()=>{
 const root=fileURLToPath(new URL('../../../.local/',import.meta.url));await mkdir(root,{recursive:true});const dir=await mkdtemp(root+'sqb-key-test-'),path=dir+'/browser-key';
 try{const keys=await Promise.all([localKey(path),localKey(path)]);assert.equal(keys[0],keys[1]);assert.equal(await localKey(path),keys[0]);assert.match(keys[0],/^[a-f0-9]{64}$/);}
 finally{await rm(path,{force:true});await rmdir(dir);}
});
test('旧页面会话被本机拒绝后恢复cookie，仅重试一次原请求',async()=>{
 const calls=[];let cloudCalls=0;
 const result=await localApi('/api/auth/sms',{phone:'synthetic-test'},async(path,options)=>{calls.push({path,options});if(calls.length===1)return response(401,{code:'LOCAL_SESSION_REQUIRED'});if(path==='/')return new Response('login page');cloudCalls++;return response(200,{sent:true});});
 assert.equal(result.sent,true);assert.deepEqual(calls.map(c=>c.path),['/api/auth/sms','/','/api/auth/sms']);assert.equal(cloudCalls,1);assert.equal(calls[0].options.body,calls[2].options.body);
});
test('收钱吧拒绝、会话过期或网络失败不会自动重发短信',async()=>{
 for(const [status,code] of [[400,'SMS_REJECTED'],[401,'AUTH_EXPIRED']]){let count=0;await assert.rejects(localApi('/api/auth/sms',{},async()=>{count++;return response(status,{code,message:'error'});}),{code});assert.equal(count,1);}
 let count=0;await assert.rejects(localApi('/api/auth/sms',{},async()=>{count++;throw new Error('network');}));assert.equal(count,1);
});
test('持续无效的本地会话不会无限重试',async()=>{let count=0;await assert.rejects(localApi('/api/status',undefined,async path=>{count++;return path==='/'?new Response('login page'):response(401,{code:'LOCAL_SESSION_REQUIRED'});}),{code:'LOCAL_SESSION_REQUIRED'});assert.equal(count,3);});
