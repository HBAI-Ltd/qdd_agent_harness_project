import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createConsoleServer} from '../local/server.mjs';
import {CloudError} from '../lib/cloud.mjs';

const session='a'.repeat(32);
const playlist='#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg_000000.ts\n';
const segment=Buffer.alloc(188,0x47);

async function fixture(t){
  const parent=path.resolve(tmpdir());
  const root=await mkdtemp(path.join(parent,'tysl-http-media-'));
  const assets=path.join(root,'public');
  await mkdir(assets);
  await writeFile(path.join(assets,'index.html'),'<!doctype html><title>Offline fixture</title>');
  const playlistFile=path.join(root,'index.m3u8'),segmentFile=path.join(root,'seg_000000.ts');
  await writeFile(playlistFile,playlist);await writeFile(segmentFile,segment);
  let controls=0;
  const runtime={
    streams:{getFile(id,name){
      if(id!==session)throw new CloudError('STREAM_NOT_FOUND','预览已结束，请重新打开',404);
      if(name==='index.m3u8')return {path:playlistFile,mime:'application/vnd.apple.mpegurl'};
      if(name==='seg_000000.ts')return {path:segmentFile,mime:'video/mp2t'};
      throw new CloudError('STREAM_NOT_FOUND','播放资源不存在',404);
    }},
    async status(){return {connected:false};},
    async action(){controls++;return {ok:true};},
    async dispose(){},
  };
  const {server}=createConsoleServer({runtime,port:0,assets});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)),parent);
    assert.ok(path.basename(root).startsWith('tysl-http-media-'));
    await rm(root,{recursive:true,force:true});
  });
  const baseUrl='http://127.0.0.1:'+server.address().port;
  return {baseUrl,controls:()=>controls};
}

test('HLS manifests and segments load from cross-origin and opaque task pages',async t=>{
  const {baseUrl}=await fixture(t);
  for(const origin of ['http://127.0.0.1:5173','https://task.example.test','null']){
    for(const [name,type,expected] of [['index.m3u8','application/vnd.apple.mpegurl',Buffer.from(playlist)],['seg_000000.ts','video/mp2t',segment]]){
      const response=await fetch(`${baseUrl}/streams/${session}/${name}`,{headers:{Origin:origin}});
      assert.equal(response.status,200);
      assert.equal(response.headers.get('content-type'),type);
      assert.equal(response.headers.get('access-control-allow-origin'),'*');
      assert.equal(response.headers.get('cross-origin-resource-policy'),'cross-origin');
      assert.equal(response.headers.get('access-control-allow-credentials'),null);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);
    }
  }
});

test('media HEAD, preflight and missing-stream responses retain CORS headers',async t=>{
  const {baseUrl}=await fixture(t);
  const url=`${baseUrl}/streams/${session}/index.m3u8`;
  const head=await fetch(url,{method:'HEAD',headers:{Origin:'null'}});
  assert.equal(head.status,200);assert.equal(head.headers.get('access-control-allow-origin'),'*');
  assert.equal((await head.arrayBuffer()).byteLength,0);
  const preflight=await fetch(url,{method:'OPTIONS',headers:{Origin:'http://127.0.0.1:5173','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Range'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'*');
  assert.equal(preflight.headers.get('access-control-allow-methods'),'GET, HEAD, OPTIONS');
  assert.equal(preflight.headers.get('access-control-allow-headers'),'Range');
  const missing=await fetch(`${baseUrl}/streams/${'b'.repeat(32)}/index.m3u8`,{headers:{Origin:'null'}});
  assert.equal(missing.status,404);assert.equal(missing.headers.get('access-control-allow-origin'),'*');
  assert.equal(missing.headers.get('cross-origin-resource-policy'),'cross-origin');
  assert.equal((await missing.json()).code,'STREAM_NOT_FOUND');
});

test('cross-origin media access does not grant access to account or control APIs',async t=>{
  const h=await fixture(t);
  for(const endpoint of ['/api/status','/api/action','/mcp','/shutdown','/']){
    const mutation=['/api/action','/mcp','/shutdown'].includes(endpoint);
    const response=await fetch(h.baseUrl+endpoint,{method:mutation?'POST':'GET',headers:{Origin:'http://127.0.0.1:5173',...(mutation?{'Content-Type':'application/json'}:{})},...(mutation?{body:'{}'}:{})});
    assert.equal(response.status,403,endpoint);
    assert.equal(response.headers.get('access-control-allow-origin'),null,endpoint);
    assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
    assert.equal((await response.json()).code,'BAD_ORIGIN');
  }
  assert.equal(h.controls(),0);
  const sameOrigin=await fetch(h.baseUrl+'/api/status',{headers:{Origin:h.baseUrl}});
  assert.equal(sameOrigin.status,200);assert.deepEqual(await sameOrigin.json(),{connected:false});
  const invalidMedia=await fetch(`${h.baseUrl}/streams/${session}/outside.txt`,{headers:{Origin:'null'}});
  assert.equal(invalidMedia.status,403);assert.equal(invalidMedia.headers.get('access-control-allow-origin'),null);
});
