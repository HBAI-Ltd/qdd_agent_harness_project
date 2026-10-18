import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,access,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRuntime} from '../local/runtime.mjs';
import {createLocalServer} from '../local/server.mjs';

test('fresh installation serves HTTP and MCP with an honest setup-required status and no cloud requests or vault writes',async t=>{
 const parent=path.resolve(os.tmpdir()),root=await mkdtemp(path.join(parent,'haik-configuration-test-'));
 const vault=path.join(root,'haik-credentials.dpapi'),assets=path.join(root,'assets');
 await mkdir(assets);await writeFile(path.join(assets,'index.html'),'<html>local console</html>');
 let cloudCalls=0,writes=0;
 const runtime=await createRuntime(vault,{writeVault:async()=>{writes++;throw Error('unexpected vault write');},createCloud:()=>{cloudCalls++;throw Error('unexpected cloud client');}});
 const server=createLocalServer({runtime,assets,port:0});
 t.after(async()=>{
  await runtime.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  const target=path.resolve(root);assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('haik-configuration-test-'));
  await rm(target,{recursive:true,force:true,maxRetries:3});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const post=(route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await fetch(base+'/')).status,200);
 assert.equal((await (await fetch(base+'/health')).json()).service,'haik');
 const status=await (await fetch(base+'/api/camera?action=status')).json();
 assert.equal(status.connected,false);assert.equal(status.configured,false);assert.equal(status.configurationRequired,true);assert.match(status.message,/配置缺失/);
 const initialized=await (await post('/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',clientInfo:{name:'offline-test',version:'1'}}})).json();
 assert.equal(initialized.result.serverInfo.name,'haik-local');
 const tools=await (await post('/mcp',{jsonrpc:'2.0',id:2,method:'tools/list'})).json();
 assert.ok(tools.result.tools.some(tool=>tool.name==='camera_connection_status'));
 const connection=await (await post('/mcp',{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'camera_connection_status',arguments:{}}})).json();
 assert.deepEqual(connection.result.structuredContent,status);
 for(const body of [{action:'send_code',phone:'13800000000',captchaVerifyParam:'offline-proof'},{action:'login',phone:'13800000000',code:'123456'}]){
  const response=await post('/api/camera',body);assert.equal(response.status,409);assert.equal((await response.json()).code,'LOGIN_CONFIG_MISSING');
 }
 await assert.rejects(runtime.action('list'),{code:'LOGIN_REQUIRED'});
 await assert.rejects(access(vault),{code:'ENOENT'});
 assert.equal(cloudCalls,0);assert.equal(writes,0);
});

test('existing vault failures remain fatal and are never replaced by setup state',async()=>{
 for(const code of ['EACCES','INVALID_VAULT']){
  const failure=Object.assign(new Error('existing vault failure'),{code});let writes=0;
  await assert.rejects(createRuntime('unused',{readVault:async()=>{throw failure;},writeVault:async()=>{writes++;}}),error=>error===failure);
  assert.equal(writes,0);
 }
});

test('existing unconfigured vault is preserved and SMS fails locally before consuming its cooldown',async()=>{
 const state={session:{headers:{}},config:{headers:{'User-Agent':'preserved'}}},original=structuredClone(state);
 let writes=0,cloudCalls=0;
 const runtime=await createRuntime('unused',{readVault:async()=>state,writeVault:async()=>{writes++;},createCloud:()=>{cloudCalls++;}});
 assert.equal((await runtime.action('status')).configurationRequired,true);
 for(let attempt=0;attempt<2;attempt++)await assert.rejects(runtime.action('send_code',{phone:'13800000000',captchaVerifyParam:'offline-proof'}),{code:'LOGIN_CONFIG_MISSING'});
 await runtime.dispose();assert.deepEqual(state,original);assert.equal(writes,0);assert.equal(cloudCalls,0);
});
