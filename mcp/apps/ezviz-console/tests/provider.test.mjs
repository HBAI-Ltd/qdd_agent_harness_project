import test from 'node:test';
import assert from 'node:assert/strict';
import {EzvizCloud,CloudError,validateCredentials} from '../lib/cloud.mjs';
import {recordingDates,listRecordings,recordingSource} from '../lib/recordings.mjs';
const epoch=1800000000000,key='offline-app-key',secret='offline-app-secret';
const session=()=>({headers:{Authorization:'offline-token'},expireTime:epoch+3600000});
const camera={id:'NVR:2',deviceSerial:'NVR',channelNo:2,online:true,encrypted:false};
function fixture(handler){
 const calls=[],states=new Map(),saved=[];
 const client=new EzvizCloud(session(),{credentials:{appKey:key,appSecret:secret}},async(url,options)=>{const item={url:new URL(url),method:options.method||'GET',headers:options.headers,params:Object.fromEntries(options.body||[])};calls.push(item);return {ok:true,json:async()=>handler(item,calls.length)};},states,async value=>saved.push(value),()=>epoch);
 return {client,calls,states,saved};
}
const ok=data=>({code:'200',data});

test('application exchange uses form credentials and absolute millisecond expiry',async()=>{
 const h=fixture(item=>{assert.equal(item.url.origin,'https://open.ys7.com');assert.equal(item.url.pathname,'/api/lapp/token/get');assert.deepEqual(item.params,{appKey:key,appSecret:secret});return ok({accessToken:'fresh-token',expireTime:epoch+604800000});});
 const result=await h.client.exchange(key,secret);assert.equal(result.expireTime,epoch+604800000);assert.equal(result.headers.Authorization,'fresh-token');
 const bad=fixture(()=>ok({accessToken:'x',expireTime:604800}));await assert.rejects(bad.client.exchange(key,secret),{code:'INVALID_TOKEN'});
});
test('invalid credentials and provider errors never echo secrets or raw vendor messages',async()=>{
 const h=fixture(()=>({code:'10030',msg:'secret='+secret}));assert.throws(()=>validateCredentials('phone','123456'),{code:'INVALID_CREDENTIALS'});
 await assert.rejects(h.client.exchange(key,secret),error=>error.code==='10030'&&!error.message.includes(secret));
 const limited=fixture(()=>({code:'10005',msg:'dummy'}));await assert.rejects(limited.client.verifySession(),{code:'10005'});assert.equal(limited.calls.length,1);
});
test('concurrent access refreshes an expired token once and persists before use',async()=>{
 const h=fixture(()=>ok({accessToken:'fresh-token',expireTime:epoch+604800000}));h.client.session.expireTime=epoch+10;
 assert.deepEqual(await Promise.all([h.client.token(),h.client.token(),h.client.token()]),['fresh-token','fresh-token','fresh-token']);assert.equal(h.calls.length,1);assert.equal(h.saved.length,1);
});
test('explicit token rejection renews an idempotent read once',async()=>{
 const h=fixture(item=>item.url.pathname==='/api/lapp/token/get'?ok({accessToken:'fresh-token',expireTime:epoch+604800000}):item.params.accessToken==='offline-token'?{code:'10002'}:ok([]));
 assert.deepEqual(await h.client.listCameras(),[]);assert.deepEqual(h.calls.map(row=>row.url.pathname),['/api/lapp/device/list','/api/lapp/token/get','/api/lapp/device/list']);
 const always=fixture(item=>item.url.pathname==='/api/lapp/token/get'?ok({accessToken:'fresh-token',expireTime:epoch+604800000}):{code:'10002'});await assert.rejects(always.client.listCameras(),{code:'10002'});assert.equal(always.calls.length,3);
});
test('NVR channels retain parent identity and unknown flags, never substitute IPC serial',async()=>{
 const h=fixture(item=>item.url.pathname==='/api/lapp/device/list'?ok([{deviceSerial:'NVR',status:1}]):ok([{deviceSerial:'NVR',ipcSerial:'OTHER-IPC',channelNo:2,status:-1},{deviceSerial:'NVR',channelNo:3,status:1,isEncrypt:0}]));
 const rows=await h.client.listCameras();assert.equal(rows[0].id,'NVR:2');assert.equal(rows[0].online,null);assert.equal(rows[0].encrypted,null);assert.equal(rows[1].online,true);assert.equal(rows[1].encrypted,false);
 const bad=fixture(item=>item.url.pathname==='/api/lapp/device/list'?ok([{deviceSerial:'NVR'}]):ok([{deviceSerial:'OTHER',channelNo:1}]));await assert.rejects(bad.client.listCameras(),{code:'INVALID_LIST'});
});
test('device pagination is zero based and continues after full page',async()=>{
 const h=fixture(item=>item.url.pathname==='/api/lapp/device/list'?ok(item.params.pageStart==='0'?Array.from({length:50},(_,i)=>({deviceSerial:'D'+i,status:1})):[]):ok([{channelNo:1,status:1,isEncrypt:0}]));
 assert.equal((await h.client.listCameras()).length,50);assert.deepEqual(h.calls.filter(row=>row.url.pathname==='/api/lapp/device/list').map(row=>row.params.pageStart),['0','1']);
});
test('live stream requests FLV/HEVC explicitly and disables error-card video',async()=>{
 const h=fixture(()=>ok({url:'https://stream.example.invalid/live.flv'}));h.client.camera=async()=>camera;
 const result=await h.client.live(camera.id,2);assert.equal(result.protocol,'flv');assert.deepEqual(h.calls[0].params,{accessToken:'offline-token',deviceSerial:'NVR',channelNo:'2',protocol:'4',type:'1',quality:'2',expireTime:'300',supportH265:'1',diserr:'1',mute:'1'});
 for(const encrypted of [true,null]){h.client.camera=async()=>({...camera,encrypted});await assert.rejects(h.client.live(camera.id),{code:'CAMERA_ENCRYPTED'});}assert.equal(h.calls.length,1);
});
test('capabilities interpret string flags, including horizontal-only PTZ',async()=>{
 const h=fixture(()=>ok({ptz_left_right:'1',ptz_top_bottom:'0',support_cloud:'0',support_disk:'1'}));h.client.camera=async()=>camera;
 const result=await h.client.capabilities(camera.id);assert.deepEqual(result.ptz,{available:true,horizontal:true,vertical:false});assert.equal(result.cloudRecording.available,false);assert.equal(result.sdPlayback.available,true);
});
test('uncertain PTZ start is never replayed and always stops with actual direction',async()=>{
 const h=fixture(item=>item.url.pathname.endsWith('/start')?{code:'20008'}:ok());h.client.camera=async()=>camera;
 await assert.rejects(h.client.ptz(camera.id,'left',100,0),error=>error.code==='20008'&&error.details.stopped===true);
 assert.deepEqual(h.calls.map(row=>row.url.pathname),['/api/lapp/device/ptz/start','/api/lapp/device/ptz/stop']);assert.equal(h.calls[0].params.speed,'0');assert.equal(h.calls[0].params.newSpeed,undefined);assert.equal(h.calls[1].params.direction,'2');
});
test('failed stopping gates later movement; explicit stop uses last actual direction',async()=>{
 let fail=true;const h=fixture(item=>item.url.pathname.endsWith('/stop')&&fail?{code:'20008'}:ok());h.client.camera=async()=>camera;
 await assert.rejects(h.client.ptz(camera.id,'right',100,1),{code:'PTZ_STOP_UNCONFIRMED'});await assert.rejects(h.client.ptz(camera.id,'left'),{code:'PTZ_STOP_REQUIRED'});
 assert.equal(h.calls.filter(row=>row.url.pathname.endsWith('/start')).length,1);fail=false;await h.client.stop(camera.id,'left');assert.equal(h.calls.at(-1).params.direction,'3');assert.equal(h.states.get(camera.id).stopConfirmed,true);
});
test('calendar uses header token and meta envelope; -1 is unknown, not a recorded day',async()=>{
 const h=fixture(item=>{assert.equal(item.method,'GET');assert.equal(item.headers.accessToken,'offline-token');assert.equal(item.url.searchParams.get('queryMonth'),'2026-10');assert.equal(item.url.searchParams.get('recType'),'2');return {meta:{code:200},data:[{recDay:'2026-10-01',local:-1},{recDay:'2026-10-02',local:1},{recDay:'2026-10-03',local:0}]};});h.client.camera=async()=>camera;
 assert.deepEqual(await recordingDates(h.client,camera.id,'sd','2026-10'),['2026-10-02']);await assert.rejects(recordingDates(h.client,camera.id,'sd','2026-13'),{code:'INVALID_DATE'});
});
test('recordings validate millisecond source/channel identity and playback uses stopTime',async()=>{
 const start=Date.parse('2026-10-16T12:00:00+08:00'),end=start+10000;
 const h=fixture(item=>item.url.pathname==='/api/lapp/video/by/time'?ok({isAll:true,files:[{deviceSerial:'NVR',channelNo:2,recType:1,startTime:start,endTime:end,crypt:0,downloadPath:'private-cloud-value'}]}):ok({url:'https://stream.example.invalid/play.flv'}));h.client.camera=async()=>camera;
 const rows=await listRecordings(h.client,camera.id,'2026-10-16','cloud');assert.equal(rows[0].durationSeconds,10);assert.ok(!JSON.stringify(rows).includes('private-cloud-value'));
 await recordingSource(h.client,camera.id,{source:'cloud',date:'2026-10-16',recordId:rows[0].id});assert.equal(h.calls.at(-1).params.stopTime,'2026-10-16 12:00:10');assert.equal(h.calls.at(-1).params.type,'3');assert.equal(h.calls.at(-1).params.endTime,undefined);
 const bad=fixture(()=>ok({isAll:false,files:[],nextFileTime:1}));bad.client.camera=async()=>camera;await assert.rejects(listRecordings(bad.client,camera.id,'2026-10-16'),{code:'INVALID_RECORDING_PAGE'});
});
