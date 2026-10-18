import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../local/runtime.mjs';
import {CloudError} from '../lib/hik-cloud.mjs';
async function fixture(overrides={}){
 const saved=[];const calls=[];const initial={session:{headers:{Authorization:'Bearer old'}},config:{headers:{}}};
 const runtime=await createRuntime('unused',{readVault:async()=>structuredClone(initial),writeVault:async(path,state)=>saved.push(state),now:()=>1000,
  createCloud:(session)=>({
   verifySession:async()=>{calls.push('verify');},
   sendCode:async()=>{calls.push('sms');},
   login:async()=>{calls.push('login');return {t:'new'};},
   request:async()=>({myTeam:[]}),listCameras:async()=>[],...overrides(session,calls),
  })});return {runtime,saved,calls};
}
test('invalid SMS input does not consume the rate limit or reach provider',async()=>{
 const {runtime,calls}=await fixture(()=>({}));await assert.rejects(runtime.action('send_code',{phone:'bad',captchaVerifyParam:'verified'}),{code:'INVALID_PHONE'});
 await assert.rejects(runtime.action('send_code',{phone:'13800000000',captchaVerifyParam:''}),{code:'CAPTCHA_REQUIRED'});
 await runtime.action('send_code',{phone:'13800000000',captchaVerifyParam:'verified'});assert.deepEqual(calls,['sms']);
 await assert.rejects(runtime.action('send_code',{phone:'13800000000',captchaVerifyParam:'verified'}),error=>error.code==='SMS_COOLDOWN'&&error.details.retryAfterSeconds===60);
});
test('API movement uses the same strict validation as MCP',async()=>{
 const {runtime,calls}=await fixture(()=>({}));
 for(const params of [{cameraId:'TEST:1',direction:'left',durationMs:0},{cameraId:'TEST:1',direction:'left',speed:'2'},{cameraId:'TEST:1',direction:'left',url:'x'}])await assert.rejects(runtime.action('move',params),{code:'INVALID_ARGUMENT'});
 assert.equal(calls.length,0);
});
test('verified new login survives a later network failure and retry preserves old session until completion',async()=>{
 let fail=true;const {runtime,saved,calls}=await fixture((session)=>({request:async()=>{if(session.headers.Authorization==='Bearer new'&&fail)throw new TypeError('network');return {myTeam:[]};}}));
 await assert.rejects(runtime.action('login',{phone:'13800000000',code:'123456'}),/network/);
 assert.ok(saved.at(-1).pendingLogin);assert.equal(saved.at(-1).session.headers.Authorization,'Bearer old');assert.ok(!JSON.stringify(saved).includes('123456'));
 fail=false;await runtime.action('login',{phone:'13800000000',code:'123456'});
 assert.equal(calls.filter(c=>c==='login').length,1);assert.equal(saved.at(-1).session.headers.Authorization,'Bearer new');assert.equal(saved.at(-1).pendingLogin,undefined);
});
test('expired sessions encountered through MCP tool context are invalidated for the login page',async()=>{
 const {runtime,saved}=await fixture(()=>({listCameras:async()=>{throw new CloudError('SESSION_EXPIRED','登录已过期',401);}}));
 await assert.rejects(runtime.toolContext().cloud.listCameras(),{status:401});assert.deepEqual(saved.at(-1).session,{headers:{}});
});

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const outcome=promise=>promise.then(value=>({value}),error=>({error}));
async function until(check){for(let n=0;n<1500;n++){if(check())return;await new Promise(setImmediate);}assert.fail('concurrency checkpoint was not reached');}
const credentials={phone:'13800000000',code:'123456'};
const camera={id:'TEST:1',name:'离线摄像头',online:true,encrypted:false,ptzAvailable:null};
async function mediaFixture(hooks={}){
 const events=[],saved=[],jobs=new Map();let nextJob=0,clock=1000;
 const publicJob=job=>{const {accountKey,...rest}=job;return {...rest,frames:rest.frames.map(frame=>({...frame}))};};
 const owned=(id,key)=>{const job=jobs.get(id);if(!job||job.accountKey!==key)throw new CloudError('CAPTURE_NOT_FOUND','没有此任务',404);return job;};
 const captures={root:'C:/offline-haik-captures',async init(){},
  async start(args){if([...jobs.values()].some(job=>job.status==='running'))throw new CloudError('CAPTURE_BUSY','测试任务仍在运行',409);events.push(['capture-start',args]);if(hooks.captureStart)await hooks.captureStart(args);const job={id:String(++nextJob).padStart(32,'0'),cameraId:args.cameraId,accountKey:args.accountKey,status:'running',frames:[],...hooks.initialJob};jobs.set(job.id,job);return publicJob(job);},
  async list({accountKey}){events.push(['capture-list',accountKey]);if(hooks.captureList)await hooks.captureList(accountKey);return [...jobs.values()].filter(job=>job.accountKey===accountKey).map(publicJob);},
  async status(id,{accountKey}){events.push(['capture-status',id,accountKey]);if(hooks.captureStatus)await hooks.captureStatus(id,accountKey);return publicJob(owned(id,accountKey));},
  async cancel(id,{accountKey}){events.push(['capture-cancel',id,accountKey]);const job=owned(id,accountKey);if(hooks.captureCancel)await hooks.captureCancel(id,accountKey);if(job.status==='running')job.status='cancelled';return publicJob(job);},
  async getFile(id,name,{accountKey}){events.push(['capture-file',id,accountKey]);if(hooks.captureFile)await hooks.captureFile(id,accountKey);owned(id,accountKey);return {path:'C:/offline-haik-captures/'+id+'/'+name,mime:'image/jpeg'};},
  async dispose(){events.push(['capture-dispose']);if(hooks.captureDispose)await hooks.captureDispose();for(const job of jobs.values())if(job.status==='running')job.status='cancelled';}
 };
 const playing=new Set(),streams={
  async start(id,url,options){events.push(['stream-start',id,options]);playing.add(id);if(hooks.streamStart)await hooks.streamStart(id,url,options);return {url:'http://127.0.0.1:8787/streams/offline/index.m3u8',protocol:'hls'};},
  async close(id){events.push(['stream-close',id]);if(hooks.streamClose)await hooks.streamClose(id);if(id===undefined)playing.clear();else playing.delete(id);},
  async dispose(){events.push(['stream-dispose']);playing.clear();}
 };
 const initial={session:{headers:{Authorization:'Bearer old'}},config:{headers:{}}};
 const runtime=await createRuntime('unused',{readVault:async()=>structuredClone(initial),writeVault:async(path,value)=>{saved.push(structuredClone(value));events.push(['write',value.session?.headers?.Authorization,!!value.pendingLogin]);if(hooks.write)await hooks.write(value);},now:()=>clock,captures,streams,mediaOptions:{baseUrl:'http://127.0.0.1:8787'},
  ...(hooks.snapshotPause?{snapshotPause:async ms=>{clock+=ms;await hooks.snapshotPause(ms);}}:{}),
  ...(hooks.recordings?{recordings:hooks.recordings}:{}),
  createCloud:(session,config,ptzState)=>({
   async verifySession(){events.push(['verify',session.headers.Authorization]);if(hooks.verify)await hooks.verify(session);},
   async request(route){events.push(['request',session.headers.Authorization,route]);return hooks.request?hooks.request(route,session):{myTeam:[]};},
   async login(){events.push(['login']);return hooks.login?hooks.login():{t:'new'};},
   async sendCode(){events.push(['sms']);},
   async listCameras(){events.push(['list',session.headers.Authorization]);return hooks.list?hooks.list(session):[camera];},
   async live(id,quality){events.push(['live',id,session.headers.Authorization,quality]);return hooks.live?hooks.live(id,session):{url:'https://example.invalid/live.flv',protocol:'flv'};},
   async ptz(id,direction){events.push(['move',id,session.headers.Authorization]);ptzState.set(id,{direction,stopConfirmed:false});try{if(hooks.move)await hooks.move(id);}finally{if(!hooks.unconfirmed)ptzState.get(id).stopConfirmed=true;}return {stopped:true};},
   async stop(id){events.push(['stop',id,session.headers.Authorization]);if(hooks.stop)await hooks.stop(id);if(ptzState.has(id))ptzState.get(id).stopConfirmed=true;return {stopped:true};}
  })
 });return {runtime,events,saved,jobs,captures,playing};
}

test('SMS login blocks new movement and old capture is cancelled before the active account is replaced',async()=>{
 const verifying=deferred(),h=await mediaFixture({verify:session=>session.headers.Authorization==='Bearer new'?verifying.promise:undefined});
 const capture=await h.runtime.action('capture-start',{cameraId:camera.id,durationSeconds:2,fps:1});
 const pending=h.runtime.action('login',credentials);await until(()=>h.events.some(event=>event[0]==='verify'&&event[1]==='Bearer new'));
 await assert.rejects(h.runtime.action('move',{cameraId:camera.id,direction:'left'}),{code:'SHUTTING_DOWN'});
 assert.equal(h.events.filter(event=>event[0]==='move').length,0);verifying.resolve();await pending;
 assert.equal(h.jobs.get(capture.job.id).status,'cancelled');
 assert.ok(h.events.findIndex(event=>event[0]==='capture-cancel')<h.events.findIndex(event=>event[0]==='write'&&event[1]==='Bearer new'&&!event[2]));
 assert.deepEqual((await h.runtime.action('capture-list')).jobs,[]);
});

test('active or unconfirmed PTZ prevents SMS exchange until an explicit stop succeeds',async()=>{
 const moving=deferred(),h=await mediaFixture({move:()=>moving.promise,unconfirmed:true});
 const pending=h.runtime.action('move',{cameraId:camera.id,direction:'left'});await until(()=>h.events.some(event=>event[0]==='move'));
 await assert.rejects(h.runtime.action('login',credentials),{code:'PTZ_STOP_REQUIRED'});moving.resolve();await pending;
 await assert.rejects(h.runtime.action('login',credentials),{code:'PTZ_STOP_REQUIRED'});assert.equal(h.events.filter(event=>event[0]==='login').length,0);
 await h.runtime.action('stop',{cameraId:camera.id});await h.runtime.action('login',credentials);assert.equal(h.events.filter(event=>event[0]==='login').length,1);
});

test('old 401 arriving after a new login cannot invalidate the replacement account',async()=>{
 const listing=deferred(),h=await mediaFixture({list:session=>session.headers.Authorization==='Bearer old'?listing.promise:[camera]});
 const pending=outcome(h.runtime.action('list'));await until(()=>h.events.some(event=>event[0]==='list'));
 await h.runtime.action('login',credentials);listing.reject(new CloudError('EXPIRED','旧会话过期',401));
 assert.equal((await pending).error.code,'SESSION_CHANGED');assert.equal((await h.runtime.action('status')).connected,true);assert.equal(h.saved.at(-1).session.headers.Authorization,'Bearer new');
});

test('expired account cancels captures but retains stop authorization while PTZ stop is unconfirmed',async()=>{
 let expired=false,stopFails=true;
 const h=await mediaFixture({unconfirmed:true,list:()=>{if(expired)throw new CloudError('EXPIRED','过期',401);return [camera];},stop:()=>{if(stopFails)throw new CloudError('STOP_FAILED','停止未确认');}});
 const capture=await h.runtime.action('capture-start',{cameraId:camera.id,durationSeconds:2,fps:1});await h.runtime.action('move',{cameraId:camera.id,direction:'left'});expired=true;
 await assert.rejects(h.runtime.action('list'),{code:'PTZ_STOP_REQUIRED'});assert.equal(h.jobs.get(capture.job.id).status,'cancelled');assert.equal(h.saved.at(-1).session.headers.Authorization,'Bearer old');
 const status=await h.runtime.action('status');assert.equal(status.connected,false);assert.equal(status.stopRequired,true);
 await assert.rejects(h.runtime.action('login',credentials),{code:'PTZ_STOP_REQUIRED'});stopFails=false;
 await h.runtime.action('stop',{cameraId:camera.id});assert.deepEqual(h.saved.at(-1).session,{headers:{}});await h.runtime.action('login',credentials);
});

test('source preflight cannot spawn after shutdown, and pending capture spawn is drained and cancelled',async()=>{
 const source=deferred(),h=await mediaFixture({live:()=>source.promise}),pending=outcome(h.runtime.action('capture-start',{cameraId:camera.id,durationSeconds:2,fps:1}));
 await until(()=>h.events.some(event=>event[0]==='live'));await h.runtime.dispose();source.resolve({url:'https://example.invalid/old.flv',protocol:'flv'});
 assert.equal((await pending).error.code,'SESSION_CHANGED');assert.equal(h.events.filter(event=>event[0]==='capture-start').length,0);
 const spawning=deferred(),other=await mediaFixture({captureStart:()=>spawning.promise,captureDispose:()=>spawning.resolve()});
 const starting=outcome(other.runtime.action('capture-start',{cameraId:camera.id,durationSeconds:2,fps:1}));await until(()=>other.events.some(event=>event[0]==='capture-start'));await other.runtime.dispose();
 assert.equal((await starting).error.code,'SESSION_CHANGED');assert.ok([...other.jobs.values()].every(job=>job.status==='cancelled'));
});

for(const operation of ['status','list','file','manifest','cancel'])test(`old capture ${operation} cannot cross a successful SMS account switch`,async()=>{
 const gate=deferred();let calls=0;const hold=()=>++calls===1?gate.promise:undefined;
 const hook={status:'captureStatus',list:'captureList',file:'captureFile',manifest:'captureStatus',cancel:'captureCancel'}[operation];
 const h=await mediaFixture({initialJob:{status:'done'},[hook]:hold}),{job}=await h.runtime.action('capture-start',{cameraId:camera.id,durationSeconds:2,fps:1});
 const requests={status:()=>h.runtime.action('capture-status',{jobId:job.id}),list:()=>h.runtime.action('capture-list'),file:()=>h.runtime.captureFile(job.id,'frame_000001.jpg'),manifest:()=>h.runtime.captureManifest(job.id),cancel:()=>h.runtime.action('capture-cancel',{jobId:job.id})};
 const pending=outcome(requests[operation]());await until(()=>calls===1);await h.runtime.action('login',credentials);gate.resolve();assert.equal((await pending).error.code,'SESSION_CHANGED');
 await assert.rejects(h.runtime.action('capture-status',{jobId:job.id}),{code:'CAPTURE_NOT_FOUND'});
});

test('SMS results arriving after shutdown remain pending encrypted data and cannot activate',async()=>{
 const sms=deferred(),h=await mediaFixture({login:()=>sms.promise}),pending=outcome(h.runtime.action('login',credentials));
 await until(()=>h.events.some(event=>event[0]==='login'));await h.runtime.dispose();sms.resolve({t:'new'});
 assert.equal((await pending).error.code,'SESSION_CHANGED');assert.equal(h.saved.at(-1).session.headers.Authorization,'Bearer old');assert.equal(h.saved.at(-1).pendingLogin.session.headers.Authorization,'Bearer new');assert.ok(!JSON.stringify(h.saved).includes(credentials.code));
});

test('shutdown during active vault commit restores the old account and retains pending authorization',async()=>{
 const writing=deferred(),h=await mediaFixture({write:value=>value.session.headers.Authorization==='Bearer new'&&!value.pendingLogin?writing.promise:undefined});
 const pending=outcome(h.runtime.action('login',credentials));await until(()=>h.events.some(event=>event[0]==='write'&&event[1]==='Bearer new'&&!event[2]));
 const shutdown=h.runtime.dispose();writing.resolve();assert.equal((await pending).error.code,'SESSION_CHANGED');await shutdown;
 assert.equal(h.saved.at(-1).session.headers.Authorization,'Bearer old');assert.equal(h.saved.at(-1).pendingLogin.session.headers.Authorization,'Bearer new');
});

test('same phone has stable capture ownership after token rotation and snapshot timeout keeps one persistent job',async()=>{
 let serial=0;const h=await mediaFixture({login:()=>({t:'new-'+ ++serial}),snapshotPause:async()=>{}});
 await h.runtime.action('login',credentials);const first=await h.runtime.action('capture-start',{cameraId:camera.id,durationSeconds:2,fps:1}),key=h.events.find(event=>event[0]==='capture-start')[1].accountKey;
 await h.runtime.action('login',credentials);const second=await h.runtime.action('capture-start',{cameraId:camera.id,durationSeconds:2,fps:1});await h.runtime.action('capture-cancel',{jobId:second.job.id});assert.equal(h.events.filter(event=>event[0]==='capture-start').at(-1)[1].accountKey,key);
 assert.ok((await h.runtime.action('capture-list')).jobs.some(job=>job.id===first.job.id));
 const snapshot=await h.runtime.action('snapshot',{cameraId:camera.id});assert.equal(snapshot.pending,true);assert.equal(snapshot.frame,undefined);assert.equal(snapshot.job.status,'running');
 assert.equal(h.events.filter(event=>event[0]==='capture-start').length,3);await h.runtime.dispose();
});

test('confirmed recording helpers receive scoped camera and propagate FLV provenance without guessed endpoints',async()=>{
 const record={id:'record-1',startTime:'2026-10-16 09:30:00',endTime:'2026-10-16 09:31:00',source:'sd',durationSeconds:60};
 const h=await mediaFixture({recordings:{recordingDates:async()=>['2026-10-16'],listRecordings:async()=>[record],recordingSource:async(client,id,args)=>({url:'https://example.invalid/recording.flv',protocol:'flv',durationSeconds:60,sourceInfo:{mode:'playback',source:'sd',date:args.date,startTime:record.startTime,endTime:record.endTime,recordId:record.id}})}});
 assert.deepEqual((await h.runtime.action('recording-dates',{cameraId:camera.id})).dates,['2026-10-16']);
 assert.equal((await h.runtime.action('recordings',{cameraId:camera.id,date:'2026-10-16',source:'sd'})).total,1);
 await assert.rejects(h.runtime.action('capture-start',{cameraId:camera.id,mode:'playback',source:'sd',date:'2026-10-16',recordId:record.id,durationSeconds:61}),{code:'CAPTURE_RANGE'});
 await h.runtime.action('capture-start',{cameraId:camera.id,mode:'playback',source:'sd',date:'2026-10-16',recordId:record.id,durationSeconds:2});
 const args=h.events.find(event=>event[0]==='capture-start')[1];assert.equal(args.sourceFormat,'flv');assert.equal(args.sourceInfo.mode,'playback');assert.equal(args.sourceInfo.startTime,record.startTime);
});

test('new live preview wins over delayed finite playback and passes the correct muxer flags',async()=>{
 const ready=deferred(),h=await mediaFixture({streamStart:(id,url,options)=>options.finite?ready.promise:undefined,recordings:{recordingSource:async()=>({url:'https://example.invalid/recording.flv',protocol:'flv',sourceInfo:{mode:'playback',source:'sd'}})}});
 const old=outcome(h.runtime.action('playback',{cameraId:camera.id,date:'2026-10-16',source:'sd',recordId:'record-1'}));await until(()=>h.events.some(event=>event[0]==='stream-start'));
 const fresh=h.runtime.action('preview',{cameraId:camera.id});await until(()=>h.events.some(event=>event[0]==='live'));ready.resolve();assert.equal((await old).error.code,'SESSION_CHANGED');await fresh;
 assert.deepEqual(h.events.filter(event=>event[0]==='stream-start').map(event=>event[2]),[{finite:true,format:'flv'},{finite:false,format:'flv'}]);assert.deepEqual([...h.playing],[camera.id]);
});

test('failed shutdown preserves the PTZ stop gate and allows explicit stop followed by shutdown retry',async()=>{
 let stopFails=true;const h=await mediaFixture({unconfirmed:true,stop:()=>{if(stopFails)throw new CloudError('STOP_FAILED','停止未确认');}});
 await h.runtime.action('move',{cameraId:camera.id,direction:'left'});
 await assert.rejects(h.runtime.dispose(),{code:'PTZ_STOP_REQUIRED'});
 await assert.rejects(h.runtime.action('login',credentials),{code:'PTZ_STOP_REQUIRED'});
 assert.equal((await h.runtime.action('status')).connected,true);
 stopFails=false;await h.runtime.action('stop',{cameraId:camera.id});await h.runtime.dispose();assert.equal((await h.runtime.action('status')).connected,false);
});
