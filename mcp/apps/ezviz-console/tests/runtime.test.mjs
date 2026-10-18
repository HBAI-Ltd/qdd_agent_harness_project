import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../local/runtime.mjs';
import {EzvizCloud,CloudError} from '../lib/cloud.mjs';
import {CAMERA_TOOLS} from '../lib/mcp-tools.mjs';
import {handleMcpMessage} from '../lib/mcp-server.mjs';
const creds={appKey:'offline-new-key',appSecret:'offline-new-secret'};
const initial=()=>({session:{headers:{Authorization:'old-token'},expireTime:Date.now()+3600000},config:{},accountOwner:'old-owner'});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function fixture(hooks={}){
 const writes=[],events=[],states=new Map();const runtime=await createRuntime('unused',{readVault:async()=>initial(),writeVault:async(_,value)=>{writes.push(value);if(hooks.write)await hooks.write(value);},createCloud:(session,config,ptzState)=>({
  verifySession:async()=>{events.push(['verify',session.headers?.Authorization]);if(hooks.verify)await hooks.verify(session);},
  exchange:async()=>{events.push(['exchange']);return {headers:{Authorization:'new-token'},expireTime:Date.now()+604800000};},
  listCameras:async()=>{events.push(['list']);return [];},
  ptz:async(id,direction)=>{ptzState.set(id,{direction,stopConfirmed:!hooks.unconfirmed});return {stopped:!hooks.unconfirmed};},
  stop:async(id)=>{events.push(['stop',id]);if(hooks.stop)await hooks.stop();ptzState.get(id).stopConfirmed=true;return {stopped:true};}
 })});return {runtime,writes,events,states};
}
test('a fresh setup starts logged out without touching provider or creating credentials',async()=>{
 let touched=0;const runtime=await createRuntime('missing',{readVault:async()=>{throw Object.assign(Error(),{code:'ENOENT'});},writeVault:async()=>{touched++;},createCloud:()=>{touched++;throw Error('unexpected');}});
 assert.deepEqual(await runtime.action('status'),{connected:false,local:true});await assert.rejects(runtime.action('list'),{code:'LOGIN_REQUIRED'});assert.equal(touched,0);await runtime.dispose();
});
test('failed new app verification preserves existing credentials and does not expose new secrets',async()=>{
 const h=await fixture({verify:session=>{if(session.headers.Authorization==='new-token')throw new CloudError('10030','应用校验失败');}});
 await assert.rejects(h.runtime.action('connect',creds),{code:'10030'});assert.equal(h.writes.length,0);assert.equal((await h.runtime.action('status')).connected,true);await h.runtime.dispose();
});
test('app connection persists on server only; status/MCP never return app secret',async()=>{
 const h=await fixture();const result=await h.runtime.action('connect',creds);assert.equal(result.connected,true);assert.equal(h.writes.at(-1).config.credentials.appSecret,creds.appSecret);assert.equal(h.writes.at(-1).session.headers.Authorization,'new-token');
 const status=await h.runtime.action('status');assert.ok(!JSON.stringify(status).includes(creds.appSecret));assert.ok(!JSON.stringify(result).includes('new-token'));await h.runtime.dispose();
});
test('switching apps invalidates pending work and blocks new motion during verification',async()=>{
 const gate=deferred(),started=deferred();const h=await fixture({verify:session=>{if(session.headers.Authorization==='new-token'){started.resolve();return gate.promise;}}});
 const connecting=h.runtime.action('connect',creds);await started.promise;await assert.rejects(h.runtime.action('move',{cameraId:'D:1',direction:'left'}),{code:'SHUTTING_DOWN'});gate.resolve();await connecting;assert.equal(h.events.filter(row=>row[0]==='exchange').length,1);await h.runtime.dispose();
});
test('unconfirmed stop prevents switching and shutdown keeps explicit stop retry available',async()=>{
 let fail=true;const h=await fixture({unconfirmed:true,stop:()=>{if(fail)throw new CloudError('20008','stop timeout');}});
 await h.runtime.action('move',{cameraId:'D:1',direction:'right'});await assert.rejects(h.runtime.action('connect',creds),{code:'PTZ_STOP_REQUIRED'});await assert.rejects(h.runtime.dispose(),{code:'PTZ_STOP_REQUIRED'});
 fail=false;assert.deepEqual(await h.runtime.action('stop',{cameraId:'D:1',direction:'right'}),{stopped:true});await h.runtime.dispose();
});
test('HTTP/MCP validation rejects wrong-brand speed, oversized sampling and unknown arguments',async()=>{
 const h=await fixture();for(const args of [{cameraId:'D:1',direction:'left',speed:5},{cameraId:'D:1',direction:'left',durationMs:0},{cameraId:'D:1',direction:'left',url:'https://unexpected.invalid'}])await assert.rejects(h.runtime.action('move',args),{code:'INVALID_ARGUMENT'});
 await assert.rejects(h.runtime.action('capture-start',{cameraId:'D:1',durationSeconds:3600,fps:5}),{code:'INVALID_ARGUMENT'});assert.equal(h.events.length,0);await h.runtime.dispose();
});
test('concurrent runtime calls share refresh and persist renewed session once',async()=>{
 const now=1800000000000,writes=[],calls=[];let shared;
 const runtime=await createRuntime('unused',{now:()=>now,readVault:async()=>({session:{headers:{Authorization:'old'},expireTime:now},config:{credentials:creds}}),writeVault:async(_,value)=>writes.push(value),createCloud:undefined});
 // Default provider uses global fetch; override only for this isolated test.
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{calls.push(url);return {ok:true,json:async()=>url.endsWith('/token/get')?{code:'200',data:{accessToken:'renewed',expireTime:now+3600000}}:{code:'200',data:[]}};};
 try{await Promise.all([runtime.action('status'),runtime.action('list')]);assert.equal(calls.filter(url=>url.endsWith('/token/get')).length,1);assert.equal(writes.length,1);assert.equal(writes[0].session.headers.Authorization,'renewed');}finally{globalThis.fetch=oldFetch;await runtime.dispose();}
});
test('MCP metadata is independently namespaced and resources work without login or runtime access',async()=>{
 assert.equal(CAMERA_TOOLS.length,15);assert.equal(new Set(CAMERA_TOOLS.map(row=>row.name)).size,15);assert.ok(CAMERA_TOOLS.every(row=>row.name.startsWith('ezviz_')));
 const noContext=()=>{throw Error('must not access account');};
 for(const request of [{method:'initialize'},{method:'tools/list'},{method:'resources/list'},{method:'resources/read',params:{uri:'ezviz://skills/ezviz-camera/SKILL.md'}},{method:'tools/call',params:{name:'ezviz_usage_guide',arguments:{}}}]){const result=await handleMcpMessage({jsonrpc:'2.0',id:1,...request},noContext);assert.ok(result.body.result);}
 const foreign=await handleMcpMessage({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_cameras',arguments:{}}},noContext);assert.equal(foreign.body.error.code,-32602);
});
