import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../local/runtime.mjs';
import {CloudError} from '../lib/cloud.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const outcome=promise=>promise.then(value=>({value}),error=>({error}));
const caps={ptzProtocol:[5],liveProtocol:[3],sdCardVideoProtocol:[0,3]};
const login=token=>({token,userId:token,roleInfos:[{id:'role',roleId:1,roleName:'测试角色'}]});
const device=id=>({deviceCode:id,deviceName:id,onlineStatus:1});
async function until(check){for(let count=0;count<1000;count++){if(check())return;await new Promise(setImmediate);}assert.fail('Expected concurrency checkpoint was not reached');}

async function harness(hooks={}){
  const events=[],playing=new Set();let disposed=0;
  const auth={login:login('account-a'),async init(){},async ensureFresh(){return hooks.refresh?hooks.refresh(this):this.login;},async accept(value){events.push(['accept',value.token]);this.login=value;},async begin(){return {url:'https://example.invalid/'};}};
  const streams={
    async start(id,url,options){events.push(['start-stream',id]);events.push(['stream-options',id,options]);playing.add(id);if(hooks.streamStart)await hooks.streamStart(id,url,options);return {url:'http://127.0.0.1:8790/streams/test/index.m3u8',protocol:'hls'};},
    async close(id){events.push(['close-stream',id]);if(hooks.streamClose)await hooks.streamClose(id);if(id===undefined)playing.clear();else playing.delete(id);},
    async dispose(){disposed++;events.push(['dispose-streams']);playing.clear();}
  };
  const captureJobs=new Map();let captureSequence=0;
  const publicJob=job=>{const {accountKey,...value}=job;return {...value,frames:value.frames.map(frame=>({...frame}))};};
  const owned=(id,key)=>{const job=captureJobs.get(id);if(!job||job.accountKey!==key)throw new CloudError('CAPTURE_NOT_FOUND','测试任务不属于此账号',404);return job;};
  const captures={root:'C:/offline-captures',async init(){},
    async start(args){events.push(['start-capture',args.cameraId,args.accountKey,args]);if(hooks.captureStart)await hooks.captureStart(args);const job={id:String(++captureSequence).padStart(32,'0'),cameraId:args.cameraId,accountKey:args.accountKey,status:'running',frames:[],...hooks.initialCaptureJob};captureJobs.set(job.id,job);return publicJob(job);},
    async status(id,{accountKey}){events.push(['capture-status',id,accountKey]);if(hooks.captureStatus)await hooks.captureStatus(id,accountKey);return publicJob(owned(id,accountKey));},
    async list({accountKey}){events.push(['capture-list',accountKey]);if(hooks.captureList)await hooks.captureList(accountKey);return [...captureJobs.values()].filter(job=>job.accountKey===accountKey).map(publicJob);},
    async cancel(id,{accountKey}){events.push(['cancel-capture',id,accountKey]);const job=owned(id,accountKey);if(hooks.captureCancel)await hooks.captureCancel(id,accountKey);job.status='cancelled';return publicJob(job);},
    async getFile(id,name,{accountKey}){events.push(['capture-file',id,accountKey]);if(hooks.captureFile)await hooks.captureFile(id,accountKey);owned(id,accountKey);return {path:`C:/offline-captures/${id}/${name}`,mime:'image/jpeg'};},
    async dispose(){events.push(['dispose-captures']);if(hooks.captureDispose)await hooks.captureDispose();for(const job of captureJobs.values())if(job.status==='running')job.status='cancelled';}
  };
  const runtime=await createRuntime({baseUrl:'http://127.0.0.1:8790'},{auth,streams,...(hooks.withCaptures?{captures}:{}),...(hooks.snapshotNow?{snapshotNow:hooks.snapshotNow}:{}),...(hooks.snapshotPause?{snapshotPause:hooks.snapshotPause}:{}),createCloud:({token})=>({
    async listDevices(){events.push(['list',token]);return hooks.list?hooks.list(token):[device('a'),device('b')];},
    async supported(id){events.push(['supported',token,id]);return hooks.supported?hooks.supported(id,token):caps;},
    async live(id){events.push(['live',token,id]);return hooks.live?hooks.live(id,token):{url:'rtsp://example.invalid/'+id};},
    async post(route,body){events.push(['post',token,route,body]);return hooks.post?hooks.post(route,body,token):{streamUrl:'rtsp://example.invalid/recording'};},
    async move(id,direction,action,speed){events.push(['move',token,id,action,direction,speed]);if(hooks.move)await hooks.move({id,direction,action,speed,token});}
  })});
  return {runtime,events,playing,auth,captures,captureJobs,get disposed(){return disposed;}};
}
const moveArgs={cameraId:'a',direction:'up',durationMs:200,speed:2};

test('PTZ reserves before preflight; duplicate is rejected and stop cancels before start',async()=>{
  const support=deferred(),h=await harness({supported:()=>support.promise});
  const first=outcome(h.runtime.action('ptz',moveArgs));
  await until(()=>h.events.some(event=>event[0]==='supported'));
  await assert.rejects(h.runtime.action('ptz',moveArgs),{code:'PTZ_BUSY'});
  await h.runtime.action('stop',{cameraId:'a'});
  support.resolve(caps);
  assert.equal((await first).value.cancelled,true);
  assert.equal(h.events.filter(event=>event[0]==='move').length,0);
});

test('stop during in-flight start is followed by another stop after start settles',async()=>{
  const started=deferred(),h=await harness({move:({action})=>action===0?started.promise:undefined});
  const moving=outcome(h.runtime.action('ptz',moveArgs));
  await until(()=>h.events.some(event=>event[0]==='move'&&event[3]===0));
  const stopping=h.runtime.action('stop',{cameraId:'a'});
  await until(()=>h.events.some(event=>event[0]==='move'&&event[3]===1));
  started.resolve();await stopping;assert.equal((await moving).error,undefined);
  assert.deepEqual(h.events.filter(event=>event[0]==='move').map(event=>event[3]),[0,1,1]);
});

test('ordinary successful PTZ pulse stops and releases its reservation',async()=>{
  const h=await harness();
  assert.deepEqual(await h.runtime.action('ptz',moveArgs),{ok:true,stopped:true});
  assert.deepEqual(h.events.filter(event=>event[0]==='move').map(event=>event[3]),[0,1]);
  await h.runtime.action('stop');
  assert.equal(h.events.filter(event=>event[0]==='move').length,2);
});

test('ambiguous start and failed stops remain retryable through stop-all',async()=>{
  let failStop=true;
  const h=await harness({move:({action})=>{if(action===0)throw new CloudError('START_FAILED','测试启动失败');if(failStop)throw new Error('test stop failure');}});
  await assert.rejects(h.runtime.action('ptz',moveArgs),{code:'PTZ_STOP_FAILED'});
  await assert.rejects(h.runtime.action('ptz',moveArgs),{code:'PTZ_BUSY'});
  failStop=false;await h.runtime.action('stop');
  assert.equal(h.events.filter(event=>event[0]==='move'&&event[3]===1).length,3);
  await assert.rejects(h.runtime.action('ptz',moveArgs),{code:'START_FAILED'});
});

test('a successful external stop cannot erase a later failed finally-stop retry',async()=>{
  const started=deferred(),externalStop=deferred();let stops=0,recovered=false;
  const h=await harness({move:({action})=>{
    if(action===0)return started.promise;
    if(++stops===1)return externalStop.promise;
    if(!recovered)throw new Error('test final stop failure');
  }});
  const moving=outcome(h.runtime.action('ptz',moveArgs));
  await until(()=>h.events.some(event=>event[0]==='move'&&event[3]===0));
  const stopping=outcome(h.runtime.action('stop',{cameraId:'a'}));
  await until(()=>stops===1);
  started.resolve();externalStop.resolve();
  assert.equal((await moving).error.code,'PTZ_STOP_FAILED');
  assert.equal((await stopping).error.code,'PTZ_STOP_FAILED');
  recovered=true;await h.runtime.action('stop');assert.equal(stops,4);
});

test('old list cannot repopulate cache after account replacement',async()=>{
  const oldList=deferred();
  const h=await harness({list:token=>token==='account-a'?oldList.promise:[device('new-account-device')]});
  const pending=outcome(h.runtime.action('list'));
  await until(()=>h.events.some(event=>event[0]==='list'));
  await h.runtime.acceptLogin(login('account-b'));
  assert.deepEqual((await h.runtime.action('list')).cameras.map(item=>item.id),['new-account-device']);
  oldList.resolve([device('old-account-device')]);
  assert.equal((await pending).error.code,'SESSION_CHANGED');
  assert.equal((await h.runtime.status()).cameraCount,1);
});

test('account replacement cancels pending PTZ before any device command',async()=>{
  const support=deferred(),h=await harness({supported:()=>support.promise});
  const moving=outcome(h.runtime.action('ptz',moveArgs));
  await until(()=>h.events.some(event=>event[0]==='supported'));
  await h.runtime.acceptLogin(login('account-b'));
  support.resolve(caps);assert.equal((await moving).error.code,'SESSION_CHANGED');
  assert.equal(h.events.filter(event=>event[0]==='move').length,0);
});

test('account transition rejects new actions until its cleanup completes',async()=>{
  const closing=deferred(),h=await harness({streamClose:()=>closing.promise});
  const replacing=h.runtime.acceptLogin(login('account-b'));
  await until(()=>h.events.some(event=>event[0]==='close-stream'));
  await assert.rejects(h.runtime.action('ptz',moveArgs),{code:'SHUTTING_DOWN'});
  await assert.rejects(h.runtime.action('list'),{code:'SHUTTING_DOWN'});
  await h.runtime.action('status');
  closing.resolve();await replacing;
  assert.equal(h.auth.login.token,'account-b');
  assert.equal((await h.runtime.action('list')).cameras.length,2);
});

test('an old ensureFresh result cannot create a client after account replacement',async()=>{
  const refresh=deferred();let calls=0;
  const h=await harness({refresh:auth=>++calls===1?refresh.promise:auth.login});
  const oldLogin=h.auth.login,pending=outcome(h.runtime.action('list'));
  await until(()=>calls===1);await h.runtime.acceptLogin(login('account-b'));
  refresh.resolve(oldLogin);assert.equal((await pending).error.code,'SESSION_CHANGED');
  assert.equal(h.events.filter(event=>event[0]==='list'&&event[1]==='account-a').length,0);
});

test('stale ensureFresh value is rejected even when generation has not changed',async()=>{
  const h=await harness({refresh:auth=>{const old=auth.login;auth.login=login('account-b');return old;}});
  await assert.rejects(h.runtime.action('list'),{code:'SESSION_CHANGED'});
  assert.equal(h.events.filter(event=>event[0]==='list').length,0);
});

test('latest preview wins when older cloud response arrives last',async()=>{
  const urls={a:deferred(),b:deferred()},h=await harness({live:id=>urls[id].promise});
  const first=outcome(h.runtime.action('preview',{cameraId:'a'}));
  await until(()=>h.events.some(event=>event[0]==='live'&&event[2]==='a'));
  const second=h.runtime.action('preview',{cameraId:'b'});
  await until(()=>h.events.some(event=>event[0]==='live'&&event[2]==='b'));
  urls.b.resolve({url:'rtsp://example.invalid/b'});await second;
  urls.a.resolve({url:'rtsp://example.invalid/a'});assert.equal((await first).error.code,'SESSION_CHANGED');
  assert.deepEqual([...h.playing],['b']);
  assert.equal(h.events.filter(event=>event[0]==='start-stream'&&event[1]==='a').length,0);
});

test('superseded FFmpeg readiness is retired before the next stream starts',async()=>{
  const ready=deferred(),h=await harness({streamStart:id=>id==='a'?ready.promise:undefined});
  const first=outcome(h.runtime.action('preview',{cameraId:'a'}));
  await until(()=>h.events.some(event=>event[0]==='start-stream'));
  const second=h.runtime.action('preview',{cameraId:'b'});
  await until(()=>h.events.some(event=>event[0]==='live'&&event[2]==='b'));
  assert.equal(h.events.filter(event=>event[0]==='start-stream').length,1);
  ready.resolve();assert.equal((await first).error.code,'SESSION_CHANGED');await second;
  assert.deepEqual([...h.playing],['b']);
  const order=h.events.filter(event=>['start-stream','close-stream'].includes(event[0])).map(event=>event.join(':'));
  assert.deepEqual(order,['start-stream:a','close-stream:a','start-stream:b']);
});

test('failed shutdown still disposes streams and permits stop/status/shutdown retry only',async()=>{
  let failStop=true;
  const h=await harness({move:({action})=>{if(action===0)throw new Error('ambiguous start');if(failStop)throw new Error('failed stop');}});
  await assert.rejects(h.runtime.action('ptz',moveArgs),{code:'PTZ_STOP_FAILED'});
  await assert.rejects(h.runtime.dispose(),{code:'PTZ_STOP_FAILED'});
  assert.equal(h.disposed,1);await h.runtime.action('status');
  await assert.rejects(h.runtime.action('list'),{code:'SHUTTING_DOWN'});
  await assert.rejects(h.runtime.action('preview',{cameraId:'a'}),{code:'SHUTTING_DOWN'});
  failStop=false;await h.runtime.action('stop');await h.runtime.dispose();
  assert.equal(h.disposed,2);
});

test('shutdown cancels preflight without waiting for its network result',async()=>{
  const support=deferred(),h=await harness({supported:()=>support.promise});
  const moving=outcome(h.runtime.action('ptz',moveArgs));
  await until(()=>h.events.some(event=>event[0]==='supported'));
  await h.runtime.dispose();assert.equal(h.disposed,1);
  support.resolve(caps);assert.equal((await moving).error.code,'SESSION_CHANGED');
  assert.equal(h.events.filter(event=>event[0]==='move').length,0);
});

test('shutdown interrupts preview readiness and drains it before completing',async()=>{
  const ready=deferred(),h=await harness({streamStart:()=>ready.promise,streamClose:()=>ready.resolve()});
  const pending=outcome(h.runtime.action('preview',{cameraId:'a'}));
  await until(()=>h.events.some(event=>event[0]==='start-stream'));
  await h.runtime.dispose();
  assert.equal((await pending).error.code,'SESSION_CHANGED');assert.equal(h.disposed,1);assert.equal(h.playing.size,0);
});

test('invalid PTZ/preview arguments never reach fake cloud',async()=>{
  const h=await harness();
  for(const args of [{...moveArgs,cameraId:' '},{...moveArgs,speed:6},{...moveArgs,durationMs:199},{...moveArgs,direction:'zoom'}])await assert.rejects(h.runtime.action('ptz',args),{code:'INVALID_PTZ'});
  await assert.rejects(h.runtime.action('preview',{cameraId:'a',quality:'invalid'}),{code:'INVALID_QUALITY'});
  assert.deepEqual(h.events,[]);
});

test('invalid capture parameters are rejected before source lookup or spawn',async()=>{
  const h=await harness({withCaptures:true});
  for(const options of [{durationSeconds:0},{durationSeconds:3601},{durationSeconds:1.5},{durationSeconds:3600,fps:5},{fps:0.09},{fps:NaN},{maxWidth:1921},{kind:'video',durationSeconds:601}])await assert.rejects(h.runtime.action('capture-start',{cameraId:'a',...options}),{code:'INVALID_CAPTURE'});
  assert.deepEqual(h.events,[]);
});

test('capture source preflight never spawns after shutdown or account replacement',async()=>{
  for(const transition of ['dispose','replace']){
    const source=deferred(),h=await harness({withCaptures:true,live:()=>source.promise});
    const pending=outcome(h.runtime.action('capture-start',{cameraId:'a'}));
    await until(()=>h.events.some(event=>event[0]==='live'));
    if(transition==='dispose')await h.runtime.dispose();else await h.runtime.acceptLogin(login('account-b'));
    source.resolve({url:'rtsp://example.invalid/old'});
    assert.equal((await pending).error.code,'SESSION_CHANGED');
    assert.equal(h.events.filter(event=>event[0]==='start-capture').length,0);
  }
});

test('shutdown signals capture disposal before waiting for an in-flight spawn',async()=>{
  const starting=deferred(),h=await harness({withCaptures:true,captureStart:()=>starting.promise,captureDispose:()=>starting.resolve()});
  const pending=outcome(h.runtime.action('capture-start',{cameraId:'a'}));
  await until(()=>h.events.some(event=>event[0]==='start-capture'));
  await h.runtime.dispose();
  assert.equal((await pending).error.code,'SESSION_CHANGED');
  assert.ok(h.events.some(event=>event[0]==='dispose-captures'));
  assert.ok([...h.captureJobs.values()].every(job=>job.status==='cancelled'));
});

test('account replacement waits for a late capture spawn to be cancelled under its original owner',async()=>{
  const starting=deferred(),h=await harness({withCaptures:true,captureStart:()=>starting.promise});
  const pending=outcome(h.runtime.action('capture-start',{cameraId:'a'}));
  await until(()=>h.events.some(event=>event[0]==='start-capture'));
  const replacing=h.runtime.acceptLogin(login('account-b'));
  await until(()=>h.events.some(event=>event[0]==='close-stream'));
  assert.equal(h.auth.login.token,'account-a');
  starting.resolve();assert.equal((await pending).error.code,'SESSION_CHANGED');await replacing;
  const cancelled=h.events.findIndex(event=>event[0]==='cancel-capture'),accepted=h.events.findIndex(event=>event[0]==='accept');
  assert.ok(cancelled>=0&&cancelled<accepted);assert.equal([...h.captureJobs.values()][0].status,'cancelled');
  assert.deepEqual((await h.runtime.action('capture-list')).jobs,[]);
  await h.runtime.action('capture-start',{cameraId:'a'});
  const launches=h.events.filter(event=>event[0]==='start-capture');assert.notEqual(launches[0][2],launches[1][2]);
});

for(const operation of ['status','list','cancel','file','manifest'])test(`old capture ${operation} result cannot cross an account switch`,async()=>{
  const gate=deferred();let calls=0;
  const hold=()=>++calls===1?gate.promise:undefined;
  const hook={status:'captureStatus',list:'captureList',cancel:'captureCancel',file:'captureFile',manifest:'captureStatus'}[operation];
  const h=await harness({withCaptures:true,initialCaptureJob:{status:'done'},[hook]:hold});
  const {job}=await h.runtime.action('capture-start',{cameraId:'a'});
  const requests={
    status:()=>h.runtime.action('capture-status',{jobId:job.id}),list:()=>h.runtime.action('capture-list'),cancel:()=>h.runtime.action('capture-cancel',{jobId:job.id}),
    file:()=>h.runtime.captureFile(job.id,'frame_000001.jpg'),manifest:()=>h.runtime.captureManifest(job.id)
  };
  const pending=outcome(requests[operation]());await until(()=>calls===1);
  await h.runtime.acceptLogin(login('account-b'));gate.resolve();
  assert.equal((await pending).error.code,'SESSION_CHANGED');
  await assert.rejects(h.runtime.action('capture-status',{jobId:job.id}),{code:'CAPTURE_NOT_FOUND'});
});

test('capture downloads and manifests are blocked while account cleanup is pending',async()=>{
  const cleaning=deferred(),h=await harness({withCaptures:true,streamClose:()=>cleaning.promise});
  const replacing=h.runtime.acceptLogin(login('account-b'));
  await until(()=>h.events.some(event=>event[0]==='close-stream'));
  await assert.rejects(h.runtime.captureFile('old-job','frame_000001.jpg'),{code:'SHUTTING_DOWN'});
  await assert.rejects(h.runtime.captureManifest('old-job'),{code:'SHUTTING_DOWN'});
  assert.equal(h.events.filter(event=>event[0]==='capture-file'||event[0]==='capture-status').length,0);
  cleaning.resolve();await replacing;
});

test('capture cleanup does not prevent first login when no account was active',async()=>{
  const h=await harness({withCaptures:true});h.auth.login=null;
  await h.runtime.acceptLogin(login('account-b'));assert.equal(h.auth.login.token,'account-b');
  assert.equal(h.events.filter(event=>event[0]==='capture-list').length,0);
});

test('snapshot returns the first saved frame from the same single-frame job',async()=>{
  let now=0;const h=await harness({withCaptures:true,snapshotNow:()=>now,snapshotPause:async ms=>{now+=ms;},captureStatus:()=>{const job=[...h.captureJobs.values()][0];job.frames=[{filename:'frame_000001.jpg',path:'C:/offline-captures/frame_000001.jpg'}];job.status='done';}});
  const result=await h.runtime.action('snapshot',{cameraId:'a',durationSeconds:999,fps:5});
  assert.equal(result.pending,false);assert.equal(result.frame.filename,'frame_000001.jpg');
  const requests=h.events.filter(event=>event[0]==='start-capture');assert.equal(requests.length,1);assert.equal(requests[0][3].durationSeconds,1);assert.equal(requests[0][3].fps,1);assert.equal(requests[0][3].frameLimit,1);
});

test('snapshot timeout leaves one queryable pending job; terminal failure is explicit in its result',async()=>{
  let now=0;const h=await harness({withCaptures:true,snapshotNow:()=>now,snapshotPause:async ms=>{now+=ms;}});
  const result=await h.runtime.action('snapshot',{cameraId:'a'});
  assert.equal(now,18000);assert.equal(result.pending,true);assert.equal(result.job.status,'running');assert.equal(result.frame,undefined);
  assert.equal(h.events.filter(event=>event[0]==='start-capture').length,1);assert.equal(h.events.filter(event=>event[0]==='cancel-capture').length,0);
  assert.equal((await h.runtime.action('capture-status',{jobId:result.job.id})).job.id,result.job.id);await h.runtime.dispose();
  const failed=await harness({withCaptures:true,initialCaptureJob:{status:'failed',error:{code:'CAPTURE_EMPTY',message:'没有画面'}}});
  const response=await failed.runtime.action('snapshot',{cameraId:'a'});assert.equal(response.pending,false);assert.equal(response.frame,undefined);assert.equal(response.job.error.code,'CAPTURE_EMPTY');
});

test('snapshot cannot return an old frame when account changes during polling',async()=>{
  const polling=deferred(),h=await harness({withCaptures:true,snapshotPause:async()=>{},captureStatus:()=>polling.promise});
  const pending=outcome(h.runtime.action('snapshot',{cameraId:'a'}));
  await until(()=>h.events.some(event=>event[0]==='capture-status'));
  await h.runtime.acceptLogin(login('account-b'));polling.resolve();
  assert.equal((await pending).error.code,'SESSION_CHANGED');assert.equal([...h.captureJobs.values()][0].status,'cancelled');
});

test('a stream cleanup failure still awaits capture disposal before shutdown returns',async()=>{
  const disposing=deferred(),h=await harness({withCaptures:true,streamClose:()=>{throw new CloudError('TEST_STREAM_CLOSE','测试关闭失败');},captureDispose:()=>disposing.promise});
  const capture=await h.runtime.action('capture-start',{cameraId:'a'});let returned=false;
  const shutdown=outcome(h.runtime.dispose()).then(value=>{returned=true;return value;});
  await until(()=>h.events.some(event=>event[0]==='dispose-captures'));
  await new Promise(setImmediate);assert.equal(returned,false);
  disposing.resolve();assert.equal((await shutdown).error.code,'TEST_STREAM_CLOSE');assert.equal(h.captureJobs.get(capture.job.id).status,'cancelled');
});

const playbackArgs={cameraId:'a',source:'sd',startTime:'2026-10-16 09:30:00',endTime:'2026-10-16 09:31:00'};
test('capabilities uses the observed sdCardVideoProtocol field',async()=>{
  const h=await harness(),result=await h.runtime.action('capabilities',{cameraId:'a'});
  assert.equal(result.sdPlayback.available,true);
  assert.deepEqual(result.rawProtocols.sd,[0,3]);
});
test('an older finite playback start is retired before a newer live preview starts',async()=>{
  const ready=deferred(),h=await harness({streamStart:(id,url,options)=>options.finite?ready.promise:undefined});
  const first=outcome(h.runtime.action('playback',playbackArgs));
  await until(()=>h.events.some(event=>event[0]==='start-stream'));
  const second=h.runtime.action('preview',{cameraId:'a'});
  await until(()=>h.events.some(event=>event[0]==='live'));
  assert.equal(h.events.filter(event=>event[0]==='start-stream').length,1);
  ready.resolve();assert.equal((await first).error.code,'SESSION_CHANGED');await second;
  assert.deepEqual(h.events.filter(event=>event[0]==='stream-options').map(event=>event[2].finite),[true,false]);assert.deepEqual([...h.playing],['a']);
});

test('a late playback URL cannot replace an already started newer live preview',async()=>{
  const oldSource=deferred(),h=await harness({post:()=>oldSource.promise});
  const first=outcome(h.runtime.action('playback',playbackArgs));
  await until(()=>h.events.some(event=>event[0]==='post'));
  await h.runtime.action('preview',{cameraId:'b'});oldSource.resolve({streamUrl:'rtsp://example.invalid/old-recording'});
  assert.equal((await first).error.code,'SESSION_CHANGED');assert.deepEqual([...h.playing],['b']);
  assert.deepEqual(h.events.filter(event=>event[0]==='stream-options').map(event=>event[2].finite),[false]);
});
