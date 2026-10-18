import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtemp,rm,access,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {NormalizeLegacyFlv,createMediaSpawn} from '../local/media.mjs';
import {CaptureManager} from '../local/captures.mjs';
import {StreamManager} from '../local/streams.mjs';

const ffmpeg=fileURLToPath(new URL('../../../tools/node_modules/ffmpeg-static/ffmpeg.exe',import.meta.url));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function available(t){try{await access(ffmpeg);return true;}catch{t.skip('Local FFmpeg is unavailable');return false;}}
async function execute(args){return new Promise((resolve,reject)=>{const child=spawn(ffmpeg,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']}),parts=[];let size=0;child.stdout.on('data',part=>{size+=part.length;if(size>4*1024*1024){child.kill();reject(new Error('fixture too large'));}else parts.push(part);});child.once('error',reject);child.once('close',code=>code===0?resolve(Buffer.concat(parts)):reject(new Error('offline FFmpeg failed')));});}
let fixturePromise;
async function fixture(){
  fixturePromise??=execute(['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x240:rate=10','-t','2','-an','-c:v','libx265','-preset','ultrafast','-x265-params','log-level=error:pools=1:frame-threads=1','-f','flv','pipe:1']).then(data=>{
    const headerLength=data.readUInt32BE(5)+4,parts=[data.subarray(0,headerLength)];let offset=headerLength,videoTags=0;
    while(offset<data.length){const header=Buffer.from(data.subarray(offset,offset+11)),size=header.readUIntBE(1,3);let payload=data.subarray(offset+11,offset+11+size);
      if(header[0]===9&&(payload[0]&128)&&payload.subarray(1,5).toString()==='hvc1'){
        const packet=payload[0]&15,frame=payload[0]&112;videoTags++;
        if(packet===0||packet===2)payload=Buffer.concat([Buffer.from([frame|12,packet,0,0,0]),payload.subarray(5)]);
        else if(packet===1)payload=Buffer.concat([Buffer.from([frame|12,1]),payload.subarray(5)]);
        else if(packet===3)payload=Buffer.concat([Buffer.from([frame|12,1,0,0,0]),payload.subarray(5)]);
        else throw new Error('unsupported test packet');
        header.writeUIntBE(payload.length,1,3);
      }
      const previous=Buffer.alloc(4);previous.writeUInt32BE(payload.length+11);parts.push(header,payload,previous);offset+=size+15;
    }
    assert.ok(videoTags>1);return Buffer.concat(parts);
  });return fixturePromise;
}
async function local(t,handler){
  const parent=path.resolve(os.tmpdir()),root=await mkdtemp(path.join(parent,'haik-media-test-')),resources=[];
  const server=http.createServer(handler);server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{for(const item of resources)await item.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));const target=path.resolve(root);assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('haik-media-test-'));await rm(target,{recursive:true,force:true,maxRetries:3});});
  return {root,resources,url:`http://127.0.0.1:${server.address().port}/fixture.flv`};
}
async function done(manager,id){for(let i=0;i<150;i++){const job=await manager.status(id,{accountKey:'offline-owner'});if(job.status!=='running')return job;await sleep(20);}assert.fail('offline capture timeout');}

test('legacy HEVC FLV normalization handles arbitrary chunk boundaries and rejects oversized/truncated input',async()=>{
  const header=Buffer.from('464c5601010000000900000000','hex'),tag=Buffer.alloc(11),payload=Buffer.from([0x1c,1,0,0,0,11,22,33]);tag[0]=9;tag.writeUIntBE(payload.length,1,3);const prev=Buffer.alloc(4);prev.writeUInt32BE(payload.length+11);
  const legacy=Buffer.concat([header,tag,payload,prev]),normalizer=new NormalizeLegacyFlv(),parts=[];
  normalizer.on('data',part=>parts.push(part));const completion=new Promise((resolve,reject)=>{normalizer.once('end',resolve);normalizer.once('error',reject);});
  for(const byte of legacy)normalizer.write(Buffer.from([byte]));normalizer.end();await completion;
  const normalized=Buffer.concat(parts);assert.equal(normalized.subarray(25,29).toString(),'hvc1');assert.deepEqual([...normalized.subarray(29,35)],[0,0,0,11,22,33]);
  for(const bytes of [Buffer.from('not-flv'),legacy.subarray(0,-1)]){
    const broken=new NormalizeLegacyFlv();broken.resume();const rejected=new Promise(resolve=>broken.once('error',resolve));broken.end(bytes);assert.equal((await rejected).code,'MEDIA_TRANSPORT_FAILED');
  }
  const oversized=Buffer.from(tag);oversized.writeUIntBE(100,1,3);const limited=new NormalizeLegacyFlv({maxTagBytes:10});limited.resume();const rejected=new Promise(resolve=>limited.once('error',resolve));limited.end(Buffer.concat([header,oversized]));assert.equal((await rejected).code,'MEDIA_TRANSPORT_FAILED');
});

test('own HTTP legacy HEVC feed produces persistent JPEG and H264 MP4 through Node transport',async t=>{
  if(!await available(t))return;const legacy=await fixture();let requests=0;
  const localFixture=await local(t,(req,res)=>{requests++;res.writeHead(200,{'Content-Type':'video/x-flv'});res.end(legacy);});
  const launches=[],transport=createMediaSpawn({spawn:(bin,args,options)=>{launches.push({args,options});return spawn(bin,args,options);}});
  const manager=new CaptureManager({root:localFixture.root,ffmpeg,baseUrl:'http://127.0.0.1:8787'},{spawn:transport});localFixture.resources.push(manager);
  const input={cameraId:'offline:1',cameraName:'离线',sourceUrl:localFixture.url.replace('fixture.flv','opaque-stream'),durationSeconds:2,fps:1,accountKey:'offline-owner',sourceInfo:{mode:'live'}};
  const job=await manager.start(input),result=await done(manager,job.id);assert.equal(result.status,'done');assert.equal(result.frameCount,2);
  for(const frame of result.frames){const bytes=await readFile(frame.path);assert.equal(bytes.readUInt16BE(0),0xffd8);assert.equal(frame.sha256,createHash('sha256').update(bytes).digest('hex'));}
  const record=await manager.start({...input,kind:'video',durationSeconds:1}),recorded=await done(manager,record.id);assert.equal(recorded.status,'done');assert.ok(recorded.video.bytes>128);
  await execute(['-hide_banner','-loglevel','error','-i',recorded.video.path,'-f','null','-']);assert.equal(requests,2);
  for(const launch of launches){assert.equal(launch.args[launch.args.indexOf('-i')+1],'pipe:0');assert.ok(!launch.args.includes(input.sourceUrl));assert.equal(launch.options.shell,false);assert.equal(launch.options.windowsHide,true);}
  assert.ok(!(await readFile(path.join(job.directory,'manifest.json'),'utf8')).includes(input.sourceUrl));
  await manager.dispose();const restored=new CaptureManager({root:localFixture.root,ffmpeg,baseUrl:'http://127.0.0.1:8787'});localFixture.resources.push(restored);await restored.init();
  assert.equal((await restored.status(job.id,{accountKey:'offline-owner'})).frameCount,2);assert.deepEqual(await restored.list({accountKey:'another-owner'}),[]);
});

test('cancelling a capture destroys its HTTP response and stdin pipeline',async t=>{
  if(!await available(t))return;const legacy=await fixture();let opened=false,closed=false;
  const localFixture=await local(t,(req,res)=>{opened=true;res.on('close',()=>{closed=true;});res.writeHead(200,{'Content-Type':'video/x-flv'});res.write(legacy);});
  const manager=new CaptureManager({root:localFixture.root,ffmpeg,baseUrl:'http://127.0.0.1:8787'});localFixture.resources.push(manager);
  const job=await manager.start({cameraId:'offline:1',sourceUrl:localFixture.url,sourceFormat:'flv',durationSeconds:20,fps:1,accountKey:'offline-owner'});
  for(let i=0;i<100&&!opened;i++)await sleep(10);assert.equal(opened,true);
  const result=await manager.cancel(job.id,{accountKey:'offline-owner'});assert.equal(result.status,'cancelled');
  for(let i=0;i<100&&!closed;i++)await sleep(10);assert.equal(closed,true);
});

test('Node video transport rejects redirects without requesting their destination',async t=>{
  if(!await available(t))return;let redirected=0;
  const localFixture=await local(t,(req,res)=>{if(req.url==='/destination')redirected++;res.writeHead(302,{Location:'/destination'});res.end();});
  const manager=new CaptureManager({root:localFixture.root,ffmpeg,baseUrl:'http://127.0.0.1:8787'});localFixture.resources.push(manager);
  const job=await manager.start({cameraId:'offline:1',sourceUrl:localFixture.url,sourceFormat:'flv',durationSeconds:1,fps:1,accountKey:'offline-owner'}),result=await done(manager,job.id);
  assert.equal(result.status,'failed');assert.equal(redirected,0);assert.equal(result.frameCount,0);
});

test('finite HLS playback transcodes the same legacy feed and retains completed segments',async t=>{
  if(!await available(t))return;const legacy=await fixture(),localFixture=await local(t,(req,res)=>{res.writeHead(200);res.end(legacy);});
  const streams=new StreamManager({root:path.join(localFixture.root,'streams'),ffmpeg,baseUrl:'http://127.0.0.1:8787'});localFixture.resources.push(streams);
  const result=await streams.start('offline:1',localFixture.url,{finite:true,format:'flv'});assert.equal(result.protocol,'hls');
  const id=new URL(result.url).pathname.split('/')[2],entry=streams.getFile(id,'index.m3u8'),playlist=await readFile(entry.path,'utf8');
  assert.ok(playlist.includes('#EXT-X-ENDLIST'));const segment=playlist.split(/\r?\n/).find(line=>/^seg_\d+\.ts$/.test(line));assert.ok(segment);assert.ok((await readFile(streams.getFile(id,segment).path)).length>0);
});
