import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rename,symlink,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CaptureManager} from '../local/captures.mjs';

const input={cameraId:'offline-camera',cameraName:'离线测试摄像头',sourceUrl:'rtsp://demo:dummy@example.invalid/live?token=dummy-only',durationSeconds:2,fps:1,accountKey:'account-a'};
const MiB=1024*1024;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const cleanupManagers=new Map();
async function temporary(t){
  const parent=path.resolve(os.tmpdir()),directory=await mkdtemp(path.join(parent,'tysl-capture-test-'));
  t.after(async()=>{for(const manager of cleanupManagers.get(directory)||[])await manager.dispose();cleanupManagers.delete(directory);const target=path.resolve(directory);assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('tysl-capture-test-'));await rm(target,{recursive:true,force:true,maxRetries:3});});
  return directory;
}
async function harness(t,options={}){
  const root=await temporary(t),children=[],calls=[];
  const manager=new CaptureManager({root,ffmpeg:process.execPath,baseUrl:'http://127.0.0.1:8790',...options.config},{
    statfs:options.statfs||(async()=>({bavail:1024*1024,bsize:4096})),
    spawn:(bin,args,settings)=>{const child=new EventEmitter();child.kill=signal=>{child.signals.push(signal);queueMicrotask(()=>child.emit('close',null,signal));return true;};child.signals=[];children.push(child);calls.push({bin,args,settings});return child;}
  });
  cleanupManagers.set(root,[manager]);return {manager,root,children,calls};
}
async function finished(manager,id,key='account-a'){
  for(let i=0;i<100;i++){const job=await manager.status(id,{accountKey:key});if(job.status!=='running')return job;await delay(20);}assert.fail('capture did not finish');
}

test('parameters are bounded before any process is started',async t=>{
  const h=await harness(t);
  for(const change of [{durationSeconds:0},{durationSeconds:3601},{durationSeconds:1.5},{fps:0.09},{fps:5.1},{fps:NaN},{maxWidth:319},{maxWidth:1921},{durationSeconds:3600,fps:5},{frameLimit:0},{frameLimit:3},{kind:'video',durationSeconds:601},{kind:'video',frameLimit:1},{sourceUrl:'file:///outside'},{sourceUrl:'https://example.invalid/\nsecret'},{accountKey:''},{cameraId:'../\0bad'},{unexpected:true}])await assert.rejects(h.manager.start({...input,...change}));
  assert.equal(h.calls.length,0);assert.deepEqual(await readdir(h.root),[]);
});

test('start returns immediately, reserves the sole process and uses safe spawn options',async t=>{
  const h=await harness(t),job=await h.manager.start(input);
  assert.equal(job.status,'running');assert.match(job.id,/^[a-f0-9]{32}$/);assert.equal(job.frameCount,0);
  assert.deepEqual(h.calls[0].settings,{windowsHide:true,shell:false,stdio:'ignore'});
  assert.equal(h.calls[0].args[h.calls[0].args.indexOf('-i')+1],input.sourceUrl);
  assert.ok(h.calls[0].args.includes('-atomic_writing'));
  await assert.rejects(h.manager.start(input),{code:'CAPTURE_BUSY'});
  assert.equal(h.calls.length,1);
});

test('saved frames have stable hashes, local paths, approximate timestamps and survive cancellation',async t=>{
  const h=await harness(t),job=await h.manager.start(input),bytes=Buffer.from('offline-frame-bytes');
  await writeFile(path.join(job.directory,'frame_000001.jpg'),bytes);
  const partial=await h.manager.status(job.id,{accountKey:'account-a'});
  assert.equal(partial.status,'running');assert.equal(partial.frameCount,1);
  const frame=partial.frames[0];assert.equal(frame.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(frame.relativeSeconds,0);assert.equal(frame.capturedAt,job.startedAt);assert.equal(frame.approximateTime,true);
  assert.equal(frame.path,path.join(job.directory,'frame_000001.jpg'));assert.equal(frame.url,`http://127.0.0.1:8790/captures/${job.id}/frame_000001.jpg`);
  const cancelled=await h.manager.cancel(job.id,{accountKey:'account-a'});
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.frameCount,1);assert.deepEqual(h.children[0].signals,['SIGTERM']);
  const file=await h.manager.getFile(job.id,'frame_000001.jpg',{accountKey:'account-a'});assert.equal(file.mime,'image/jpeg');assert.deepEqual(await readFile(file.path),bytes);
  const persisted=await readFile(path.join(job.directory,'manifest.json'),'utf8');assert.ok(!persisted.includes(input.sourceUrl));assert.ok(!persisted.includes('dummy-only'));assert.ok(!persisted.includes('"accountKey"'));
  const list=await h.manager.list({accountKey:'account-a'});assert.equal(list.length,1);assert.equal(list[0].frameCount,1);assert.equal(list[0].frames,undefined);assert.ok(!JSON.stringify(list).includes('ownerHash'));
});

test('every job and download is isolated to the owner; unregistered files and traversal are rejected',async t=>{
  const h=await harness(t),job=await h.manager.start(input);
  await writeFile(path.join(job.directory,'frame_000001.jpg'),'sample');h.children[0].emit('close',0);await finished(h.manager,job.id);
  assert.deepEqual(await h.manager.list({accountKey:'account-b'}),[]);
  for(const method of [()=>h.manager.status(job.id,{accountKey:'account-b'}),()=>h.manager.cancel(job.id,{accountKey:'account-b'}),()=>h.manager.getFile(job.id,'frame_000001.jpg',{accountKey:'account-b'})])await assert.rejects(method(),{code:'CAPTURE_NOT_FOUND'});
  for(const name of ['../manifest.json','manifest.json','frame_000002.jpg','C:\\outside.jpg','frame_000001.jpg%00'])await assert.rejects(h.manager.getFile(job.id,name,{accountKey:'account-a'}),{code:'CAPTURE_NOT_FOUND'});
  await assert.rejects(h.manager.status('../outside',{accountKey:'account-a'}),{code:'CAPTURE_NOT_FOUND'});
});

test('symlink or junction directories cannot redirect reads or initial creation outside root',async t=>{
  const h=await harness(t),outside=await temporary(t),job=await h.manager.start(input);
  await writeFile(path.join(job.directory,'frame_000001.jpg'),'sample');h.children[0].emit('close',0);await finished(h.manager,job.id);
  await rename(job.directory,job.directory+'-saved');
  try{await symlink(outside,job.directory,process.platform==='win32'?'junction':'dir');}catch(error){if(error.code==='EPERM'){t.skip('OS does not permit test symlinks');return;}throw error;}
  await assert.rejects(h.manager.getFile(job.id,'frame_000001.jpg',{accountKey:'account-a'}),{code:'CAPTURE_STORAGE_FAILED'});
  const unsafe=new CaptureManager({root:path.join(job.directory,'must-not-exist'),ffmpeg:process.execPath,baseUrl:'http://127.0.0.1:8790'});
  await assert.rejects(unsafe.init(),{code:'CAPTURE_STORAGE_FAILED'});
  assert.deepEqual(await readdir(outside),[]);
});

test('process failure preserves partial frames; completed jobs are not deleted by dispose',async t=>{
  const h=await harness(t),job=await h.manager.start(input);
  await writeFile(path.join(job.directory,'frame_000001.jpg'),'sample');h.children[0].emit('close',1);
  const failed=await finished(h.manager,job.id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'CAPTURE_FAILED');assert.equal(failed.frameCount,1);
  await h.manager.dispose();assert.equal((await readFile(path.join(job.directory,'frame_000001.jpg'),'utf8')),'sample');
  await assert.rejects(h.manager.start(input),{code:'CAPTURE_CLOSED'});
});

test('restart loads persisted metadata and marks unfinished jobs interrupted without deleting frames',async t=>{
  const h=await harness(t),job=await h.manager.start(input);
  await writeFile(path.join(job.directory,'frame_000001.jpg'),'sample');h.children[0].emit('close',0);await finished(h.manager,job.id);await h.manager.dispose();
  const manifestPath=path.join(job.directory,'manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.status='running';manifest.frames=[];manifest.endedAt=null;await writeFile(manifestPath,JSON.stringify(manifest));
  const restored=new CaptureManager({root:h.root,ffmpeg:process.execPath,baseUrl:'http://127.0.0.1:8790'});cleanupManagers.get(h.root).push(restored);await restored.init();
  const result=await restored.status(job.id,{accountKey:'account-a'});assert.equal(result.status,'interrupted');assert.equal(result.error.code,'CAPTURE_INTERRUPTED');assert.equal(result.frameCount,1);assert.equal(result.frames[0].filename,'frame_000001.jpg');
  assert.deepEqual(await restored.list({accountKey:'account-b'}),[]);
  assert.equal(JSON.parse(await readFile(manifestPath,'utf8')).status,'interrupted');
});

test('quota, free space and job count reject work without spawning or deleting older files',async t=>{
  const quota=await harness(t,{config:{quotaBytes:32*MiB}});await assert.rejects(quota.manager.start({...input,durationSeconds:20,fps:1}),{code:'CAPTURE_QUOTA'});assert.equal(quota.calls.length,0);
  const space=await harness(t,{statfs:async()=>({bavail:1,bsize:4096})});await assert.rejects(space.manager.start(input),{code:'CAPTURE_DISK_SPACE'});assert.equal(space.calls.length,0);
  const count=await harness(t,{config:{maxJobs:1}}),job=await count.manager.start({...input,durationSeconds:1,fps:1,frameLimit:1});
  await writeFile(path.join(job.directory,'frame_000001.jpg'),'sample');count.children[0].emit('close',0);await finished(count.manager,job.id);
  await assert.rejects(count.manager.start(input),{code:'CAPTURE_JOB_LIMIT'});assert.equal(await readFile(path.join(job.directory,'frame_000001.jpg'),'utf8'),'sample');
});

test('video uses H264 without audio and only exposes a closed partial MP4',async t=>{
  const h=await harness(t),job=await h.manager.start({...input,kind:'video',durationSeconds:1});
  const args=h.calls[0].args;assert.equal(args[args.indexOf('-c:v')+1],'libx264');assert.ok(args.includes('-an'));assert.ok(args.includes('+frag_keyframe+empty_moov+default_base_moof'));
  await writeFile(path.join(job.directory,'recording.mp4'),Buffer.alloc(256,1));
  assert.equal((await h.manager.status(job.id,{accountKey:'account-a'})).video,null);
  const cancelled=await h.manager.cancel(job.id,{accountKey:'account-a'});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.video.bytes,256);assert.equal((await h.manager.getFile(job.id,'recording.mp4',{accountKey:'account-a'})).mime,'video/mp4');
});

test('storage monitoring stops a running job near its quota while retaining partial files',async t=>{
  const h=await harness(t,{config:{quotaBytes:32*MiB}}),job=await h.manager.start({...input,durationSeconds:10,fps:1});
  await writeFile(path.join(job.directory,'frame_000001.jpg'),Buffer.alloc(17*MiB,1));
  const stopped=await finished(h.manager,job.id);assert.equal(stopped.status,'failed');assert.equal(stopped.error.code,'CAPTURE_QUOTA');assert.equal(stopped.frameCount,1);assert.deepEqual(h.children[0].signals,['SIGTERM']);
  assert.equal((await readFile(stopped.frames[0].path)).length,17*MiB);
});

test('a modified registered file cannot be downloaded with a stale checksum',async t=>{
  const h=await harness(t),job=await h.manager.start(input),filename=path.join(job.directory,'frame_000001.jpg');
  await writeFile(filename,'original');h.children[0].emit('close',0);await finished(h.manager,job.id);
  await writeFile(filename,'modified');await assert.rejects(h.manager.getFile(job.id,'frame_000001.jpg',{accountKey:'account-a'}),{code:'CAPTURE_NOT_FOUND'});
});

test('only whitelisted source provenance is persisted and historical time does not replace capture wall clock',async t=>{
  const h=await harness(t),sourceInfo={mode:'playback',source:'sd',date:'2026-10-16',startTime:'2026-10-16T09:30:00+08:00',endTime:'09:31:00',recordId:'offline-record-1'};
  for(const invalid of [{...sourceInfo,sourceUrl:input.sourceUrl},{...sourceInfo,mode:'unknown'},{...sourceInfo,source:'disk'},{...sourceInfo,date:'2026-02-31'},{...sourceInfo,startTime:'25:00:00'},{...sourceInfo,startTime:'2026-02-31 09:30:00'},{...sourceInfo,recordId:'https://example.invalid/token'},{...sourceInfo,recordId:'x'.repeat(1025)}])await assert.rejects(h.manager.start({...input,sourceInfo:invalid}),{code:'CAPTURE_SOURCE_INFO_INVALID'});
  assert.equal(h.calls.length,0);
  const job=await h.manager.start({...input,sourceInfo});await writeFile(path.join(job.directory,'frame_000001.jpg'),'sample');h.children[0].emit('close',0);
  const done=await finished(h.manager,job.id);assert.deepEqual(done.sourceInfo,sourceInfo);assert.equal(done.frames[0].capturedAt,job.startedAt);assert.notEqual(done.frames[0].capturedAt,sourceInfo.startTime);
  assert.deepEqual(JSON.parse(await readFile(path.join(job.directory,'manifest.json'),'utf8')).sourceInfo,sourceInfo);
  const local={...sourceInfo,startTime:'2026-10-16 09:30:00',endTime:'2026-10-16 09:31:00',recordId:'x'.repeat(1024)};
  const localJob=await h.manager.start({...input,sourceInfo:local});assert.deepEqual(localJob.sourceInfo,local);await h.manager.cancel(localJob.id,{accountKey:'account-a'});
  const live=await h.manager.start({...input,sourceInfo:{mode:'live'}});assert.deepEqual(live.sourceInfo,{mode:'live'});
});

test('offline FFmpeg lavfi produces actual JPEG frames and a decodable H264 MP4',async t=>{
  const ffmpeg=fileURLToPath(new URL('../../../tools/node_modules/ffmpeg-static/ffmpeg.exe',import.meta.url));
  try{await access(ffmpeg);}catch{t.skip('Local FFmpeg executable is unavailable');return;}
  const root=await temporary(t);
  const manager=new CaptureManager({root,ffmpeg,baseUrl:'http://127.0.0.1:8790'},{spawn:(bin,args,options)=>{
    const index=args.indexOf('-i');return spawn(bin,['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=15',...args.slice(index+2)],options);
  }});cleanupManagers.set(root,[manager]);
  const frames=await manager.start({...input,sourceUrl:'https://example.invalid/offline-fixture'}),result=await finished(manager,frames.id);
  assert.equal(result.status,'done');assert.equal(result.frameCount,2);assert.equal(result.frames[1].relativeSeconds,1);
  for(const frame of result.frames){const bytes=await readFile(frame.path);assert.equal(bytes.readUInt16BE(0),0xffd8);assert.equal(frame.sha256,createHash('sha256').update(bytes).digest('hex'));}
  const snapshot=await manager.start({...input,sourceUrl:'https://example.invalid/offline-fixture',durationSeconds:1,fps:1,frameLimit:1});assert.equal((await finished(manager,snapshot.id)).frameCount,1);
  const slow=await manager.start({...input,sourceUrl:'https://example.invalid/offline-fixture',durationSeconds:1,fps:0.1});assert.equal((await finished(manager,slow.id)).frameCount,1);
  const video=await manager.start({...input,sourceUrl:'https://example.invalid/offline-fixture',kind:'video',durationSeconds:1}),recorded=await finished(manager,video.id);
  assert.equal(recorded.status,'done');assert.ok(recorded.video.bytes>128);
  const exit=await new Promise(resolve=>{const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-i',recorded.video.path,'-map','0:v:0','-f','null','-'],{windowsHide:true,shell:false,stdio:'ignore'});child.once('error',()=>resolve(-1));child.once('close',resolve);});assert.equal(exit,0);
});
