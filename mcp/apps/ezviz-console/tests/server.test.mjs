import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createLocalServer} from '../local/server.mjs';
import {CloudError} from '../lib/cloud.mjs';

const id='a'.repeat(32),streamId='b'.repeat(32),deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function setup(t,hooks={}){
 const parent=path.resolve(os.tmpdir()),root=await mkdtemp(path.join(parent,'ezviz-server-test-'));
 const assets=path.join(root,'assets'),captures=path.join(root,'captures'),streams=path.join(root,'streams');
 for(const directory of [assets,path.join(captures,id),path.join(streams,streamId)])await mkdir(directory,{recursive:true});
 await writeFile(path.join(assets,'index.html'),'<html>offline</html>');
 for(const name of ['frame_000001.jpg','recording.mp4'])await writeFile(path.join(captures,id,name),'0123456789');
 await writeFile(path.join(streams,streamId,'index.m3u8'),'#EXTM3U\nseg_000001.ts\n');await writeFile(path.join(streams,streamId,'seg_000001.ts'),'segment-data');
 const calls=[];let owner='a',stopped=0;
 const authorize=()=>{if(owner!=='a')throw new CloudError('CAPTURE_NOT_FOUND','当前账号没有此资源',404);};
 const runtime={captures:{root:captures},streams:{root:streams},
  async action(action,args){calls.push(['action',action,args]);if(hooks.action)return hooks.action(action,args);return action==='status'?{connected:true}:{ok:true};},
  async captureFile(job,name){calls.push(['capture-file',job,name]);authorize();if(job!==id)throw new CloudError('CAPTURE_NOT_FOUND','没有任务',404);return {path:hooks.filePath||path.join(captures,id,name),mime:'image/jpeg'};},
  async captureManifest(job){calls.push(['manifest',job]);authorize();if(job!==id)throw new CloudError('CAPTURE_NOT_FOUND','没有任务',404);return {id:job,status:'done',frameCount:1,frames:[{filename:'frame_000001.jpg',path:path.join(captures,id,'frame_000001.jpg')} ]};},
  async streamFile(session,name){calls.push(['stream-file',session,name]);authorize();if(session!==streamId)throw new CloudError('STREAM_NOT_FOUND','没有此预览',404);return {path:path.join(streams,streamId,name),mime:'application/vnd.apple.mpegurl'};},
  async dispose(){calls.push(['dispose']);if(hooks.dispose)await hooks.dispose();},toolContext(){return {action:(name,args)=>this.action(name,args)};}
 };
 const server=createLocalServer({runtime,assets,port:0,onStopped:()=>stopped++});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 function request(url,options={}){return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:url,method:options.method||'GET',headers:options.headers||{}},res=>{const parts=[];res.on('data',part=>parts.push(part));res.once('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts).toString()}));});
  req.setTimeout(3000,()=>req.destroy(new Error('test request timeout')));req.once('error',reject);req.end(options.body);
 });}
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(()=>resolve()));const target=path.resolve(root);assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('ezviz-server-test-'));await rm(target,{recursive:true,force:true,maxRetries:3});});
 return {server,request,root,assets,captures,streams,calls,port,setOwner:value=>{owner=value;},get stopped(){return stopped;}};
}

test('HTTP import has no vault side effects and server enforces Host/Origin before actions',async t=>{
 const h=await setup(t);assert.equal((await h.request('/')).status,200);
 assert.equal((await h.request('/api/camera?action=list',{headers:{Host:'evil.invalid'}})).status,403);
 assert.equal((await h.request('/api/camera',{method:'POST',headers:{Origin:'https://evil.invalid'},body:'{"action":"list"}'})).status,403);
 assert.equal(h.calls.length,0);const response=await h.request('/api/camera?action=status');assert.equal(response.status,200);assert.equal(JSON.parse(response.body).connected,true);
 assert.equal(response.headers['referrer-policy'],'no-referrer');assert.equal(response.headers['cross-origin-resource-policy'],'same-origin');
});

test('registered artifacts support GET, HEAD, suffix/open/closed Range and attachment download',async t=>{
 const h=await setup(t),route='/captures/'+id+'/recording.mp4';
 const full=await h.request(route);assert.equal(full.status,200);assert.equal(full.body,'0123456789');assert.equal(full.headers['content-type'],'video/mp4');assert.equal(full.headers['accept-ranges'],'bytes');
 const head=await h.request(route,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.body,'');assert.equal(head.headers['content-length'],'10');
 for(const [range,body,contentRange] of [['bytes=2-5','2345','bytes 2-5/10'],['bytes=-3','789','bytes 7-9/10'],['bytes=7-','789','bytes 7-9/10']]){
  const response=await h.request(route,{headers:{Range:range}});assert.equal(response.status,206);assert.equal(response.body,body);assert.equal(response.headers['content-range'],contentRange);
 }
 const headRange=await h.request(route,{method:'HEAD',headers:{Range:'bytes=2-5'}});assert.equal(headRange.status,206);assert.equal(headRange.body,'');assert.equal(headRange.headers['content-length'],'4');
 const download=await h.request(route+'?download=1');assert.equal(download.headers['content-disposition'],'attachment; filename="recording.mp4"');
 assert.equal((await h.request('/artifacts/'+id+'/frame_000001.jpg')).headers['content-type'],'image/jpeg');
});

test('invalid, overflow and multi ranges return 416 without reading outside the opened file',async t=>{
 const h=await setup(t),route='/captures/'+id+'/recording.mp4';
 for(const range of ['bytes=10-','bytes=4-2','bytes=-0','bytes=-','bytes=0-1,4-5','bytes=0-9999999999999999999999','unknown']){
  const response=await h.request(route,{headers:{Range:range}});assert.equal(response.status,416);assert.equal(response.body,'');assert.equal(response.headers['content-range'],'bytes */10');
 }
});

test('manifests use account-checked public JSON and streams use runtime authorization',async t=>{
 const h=await setup(t),manifest='/api/captures/'+id+'/manifest';
 const response=await h.request(manifest);assert.equal(response.status,200);assert.equal(JSON.parse(response.body).id,id);assert.match(response.headers['content-disposition'],/\.json/);assert.ok(!response.body.includes('ownerHash'));
 assert.equal((await h.request('/captures/'+id+'/manifest.json',{method:'HEAD'})).body,'');
 assert.equal((await h.request('/streams/'+streamId+'/index.m3u8')).body,'#EXTM3U\nseg_000001.ts\n');
 assert.equal((await h.request('/streams/'+streamId+'/seg_000001.ts',{headers:{Range:'bytes=0-6'}})).body,'segment');
 h.setOwner('another-account');for(const route of [manifest,'/captures/'+id+'/recording.mp4','/streams/'+streamId+'/index.m3u8'])assert.equal((await h.request(route)).status,404);
});

test('media traversal/unregistered names are rejected before runtime and outside-root paths are denied',async t=>{
 const h=await setup(t);
 for(const route of ['/captures/'+id+'/vault.dpapi','/captures/'+id+'/frame_000001.jpg%2f..%2fsecret','/streams/'+streamId+'/../secret','/streams/'+streamId+'/../%2fsecret','/captures/invalid/recording.mp4','/%2f..%2foutside.jpg'])assert.equal((await h.request(route)).status,404);
 assert.equal(h.calls.length,0);
 const outside=path.join(h.root,'outside.mp4');await writeFile(outside,'private');
 const other=await setup(t,{filePath:outside});const response=await other.request('/captures/'+id+'/recording.mp4');assert.equal(response.status,404);assert.ok(!response.body.includes('private'));
});

test('directory symlinks/junctions cannot redirect artifact or static reads',async t=>{
 const h=await setup(t),outside=path.join(h.root,'outside');await mkdir(outside);await writeFile(path.join(outside,'recording.mp4'),'private');await writeFile(path.join(outside,'secret.jpg'),'private');
 await rename(path.join(h.captures,id),path.join(h.captures,id+'-saved'));
 try{await symlink(outside,path.join(h.captures,id),process.platform==='win32'?'junction':'dir');await symlink(outside,path.join(h.assets,'linked'),process.platform==='win32'?'junction':'dir');}catch(error){if(error.code==='EPERM'){t.skip('OS disallows test symlinks');return;}throw error;}
 assert.equal((await h.request('/captures/'+id+'/recording.mp4')).status,404);assert.equal((await h.request('/linked/secret.jpg')).status,404);
 assert.equal(await readFile(path.join(outside,'recording.mp4'),'utf8'),'private');
});

test('CloudError keeps safe stop details but never exposes credentials, URLs or stack',async t=>{
 const error=new CloudError('STOP_FAILED','https://example.invalid/private?token=hidden Bearer dummy-token',502,{token:'dummy',stopped:false,startCode:'20032',stopCode:'20008'});
 const fixed=await setup(t,{action:()=>{throw error;}}),response=await fixed.request('/api/camera?action=status'),value=JSON.parse(response.body);
 assert.equal(response.status,502);assert.deepEqual(value.details,{startCode:'20032',stopCode:'20008',stopped:false});assert.ok(!response.body.includes('dummy'));assert.ok(!response.body.includes('example.invalid'));assert.ok(!response.body.includes('stack'));
});

test('shutdown waits for dispose, rejects new work and only then closes the listener',async t=>{
 const disposing=deferred(),h=await setup(t,{dispose:()=>disposing.promise});let completed=false;
 const request=h.request('/shutdown',{method:'POST',body:'{}'}).then(value=>{completed=true;return value;});
 while(!h.calls.some(call=>call[0]==='dispose'))await new Promise(setImmediate);
 assert.equal(completed,false);assert.equal(JSON.parse((await h.request('/health')).body).closing,true);
 assert.equal((await h.request('/api/camera?action=list')).status,503);
 disposing.resolve();assert.equal((await request).status,200);await new Promise(setImmediate);assert.equal(h.stopped,1);
});

test('a failed disposal keeps the listener available for explicit stop and a successful shutdown retry',async t=>{
 let attempts=0;const h=await setup(t,{dispose:()=>{if(++attempts===1)throw new CloudError('PTZ_STOP_REQUIRED','停止未确认',409);}});
 const failed=await h.request('/shutdown',{method:'POST',body:'{}'});assert.equal(failed.status,409);assert.equal(h.stopped,0);
 assert.equal(JSON.parse((await h.request('/health')).body).closing,false);
 const stop=await h.request('/api/camera',{method:'POST',body:'{"action":"stop","cameraId":"TEST:1"}'});assert.equal(stop.status,200);
 assert.equal((await h.request('/shutdown',{method:'POST',body:'{}'})).status,200);assert.equal(attempts,2);
});
