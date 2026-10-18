import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingDay,recordingTime,recordingDates,listRecordings,recordingSource} from '../lib/recordings.mjs';
import {CloudError,HikCloud} from '../lib/hik-cloud.mjs';

const DATE='2026-10-17';
const START=Date.UTC(2026,9,16,16);
const END=START+86400000-1;
const CAMERA={id:'offline-test-camera:1',deviceSerial:'OFFLINE_TEST_CAMERA',channelNo:1,online:true,encrypted:false};
const file=(start=START+3600000,end=start+60000,extra={})=>({deviceSerial:CAMERA.deviceSerial,channelNo:1,startTime:start,endTime:end,fileId:'offline-record',fileSize:4096,crypt:0,...extra});
const code=expected=>error=>error instanceof CloudError&&error.code===expected;
function clientFor(pages=[{files:[],isAll:true}],camera=CAMERA){
  const calls=[];
  let page=0;
  return {
    calls,
    async camera(id){calls.push({method:'camera',id});if(id!==camera.id)throw new CloudError('CAMERA_NOT_FOUND','offline fixture',404);return {...camera};},
    async videoToken(selected){assert.equal(selected.id,camera.id);calls.push({method:'videoToken'});return 'offline-fixture-token';},
    async ys(route,token,params){
      assert.equal(token,'offline-fixture-token');calls.push({method:'ys',route,params:{...params}});
      if(route==='/api/lapp/video/by/time'){
        assert(page<pages.length,'Unexpected extra recording request');
        const value=pages[page++];if(value instanceof Error)throw value;return value;
      }
      assert.equal(route,'/api/lapp/v2/live/address/get');
      return {url:'https://offline.example.invalid/playback.flv'};
    }
  };
}
const requests=client=>client.calls.filter(call=>call.method==='ys');

test('dates and wall-clock times validate real Beijing calendar values without host timezone dependence',()=>{
  assert.equal(recordingDay('2024-02-29'),'2024-02-29');
  assert.equal(recordingTime(DATE+' 23:59:59'),DATE+' 23:59:59');
  for(const value of ['2026-02-29','2026-04-31','2026-13-01','2026-00-01','2026-10-00','2026-1-17','2026-10-17T00:00:00Z',null,17])assert.throws(()=>recordingDay(value),code('INVALID_DATE'));
  for(const value of [DATE+' 24:00:00',DATE+' 23:60:00',DATE+' 23:59:60',DATE+'T12:00:00',DATE+' 12:00:00+08:00',null])assert.throws(()=>recordingTime(value),code('INVALID_TIME'));
});

test('v2 cloud queries use millisecond day bounds and cursor continuation, then sort and deduplicate',async()=>{
  const early=file(START+1000,START+61000,{fileId:'first'});
  const late=file(START+120000,START+180000,{fileId:'second'});
  const client=clientFor([{files:[late,early],isAll:false,nextFileTime:START+180000},{files:[late],isAll:true,nextFileTime:0}]);
  const rows=await listRecordings(client,CAMERA.id,DATE,'cloud');
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(row=>row.startTime),[DATE+' 00:00:01',DATE+' 00:02:00']);
  assert.equal(rows[0].endTime,DATE+' 00:01:01');
  assert.equal(rows[0].durationSeconds,60);
  assert.equal(rows[0].bytes,4096);
  const [first,next]=requests(client);
  assert.equal(first.route,'/api/lapp/video/by/time');
  assert.deepEqual(first.params,{deviceSerial:CAMERA.deviceSerial,channelNo:'1',startTime:String(START),endTime:String(END),recType:'1',version:'2.0',pageSize:'500'});
  assert.equal(next.params.startTime,String(START+180000));
  assert.equal(next.params.endTime,String(END));
  assert.equal(rows[0].source,'cloud');
  assert.match(rows[0].id,/^[a-f0-9]{64}$/);
});

test('SD and cloud query explicit storage types and generate distinct scope-bound record IDs',async()=>{
  const cloud=clientFor([{files:[file()],isAll:true}]);
  const sd=clientFor([{files:[file()],isAll:true}]);
  const [cloudRow]=await listRecordings(cloud,CAMERA.id,DATE,'cloud');
  const [sdRow]=await listRecordings(sd,CAMERA.id,DATE,'sd');
  assert.equal(requests(sd)[0].params.recType,'2');
  assert.equal(sdRow.source,'sd');
  assert.notEqual(cloudRow.id,sdRow.id);
});

test('null or omitted files is a valid empty terminal page, never an empty nonterminal page',async()=>{
  for(const data of [{files:null,isAll:true},{isAll:true},{files:[],isAll:true},[]])assert.deepEqual(await listRecordings(clientFor([data]),CAMERA.id,DATE),[]);
  for(const data of [{files:null,isAll:false,nextFileTime:START+1},{files:{},isAll:true},null])await assert.rejects(listRecordings(clientFor([data]),CAMERA.id,DATE),code('INVALID_RECORDINGS'));
});

test('malformed or stalled cursors fail instead of looping or silently truncating',async()=>{
  for(const next of [START,START-1,END+1,NaN,Infinity,START+0.5,undefined,'not-a-time']){
    const client=clientFor([{files:[],isAll:false,nextFileTime:next}]);
    await assert.rejects(listRecordings(client,CAMERA.id,DATE),code('INVALID_RECORDING_PAGE'));
    assert.equal(requests(client).length,1);
  }
  await assert.rejects(listRecordings(clientFor([{files:[],nextFileTime:START+1000}]),CAMERA.id,DATE),code('INVALID_RECORDING_PAGE'));
});

test('an endless but advancing server pagination is bounded',async()=>{
  const pages=Array.from({length:100},(_,index)=>({files:[],isAll:false,nextFileTime:START+index+1}));
  const client=clientFor(pages);
  await assert.rejects(listRecordings(client,CAMERA.id,DATE),code('RECORDING_LIMIT'));
  assert.equal(requests(client).length,100);
});

test('day clipping preserves Beijing date and excludes wholly outside or subsecond fragments',async()=>{
  const client=clientFor([{files:[
    file(START-60000,START,{fileId:'before'}),
    file(END+1,END+61000,{fileId:'after'}),
    file(START-60000,START+60000,{fileId:'cross-start'}),
    file(END-60000,END+60000,{fileId:'cross-end'}),
    file(START+1,START+999,{fileId:'short'})
  ],isAll:true}]);
  const rows=await listRecordings(client,CAMERA.id,DATE);
  assert.equal(rows.length,2);
  assert.equal(rows[0].startTime,DATE+' 00:00:00');
  assert.equal(rows[0].endTime,DATE+' 00:01:00');
  assert.equal(rows[1].endTime,DATE+' 23:59:59');
  assert(rows.every(row=>row.startTime.startsWith(DATE)&&row.endTime.startsWith(DATE)));
});

test('recording rows expose only normalized metadata and never download paths or cryptographic material',async()=>{
  const client=clientFor([{files:[file(undefined,undefined,{downloadPath:'PRIVATE_DOWNLOAD_PATH',coverPic:'PRIVATE_COVER_URL',ownerId:'PRIVATE_OWNER',keyChecksum:'PRIVATE_CHECKSUM',fileSize:'1024'})],isAll:true}]);
  const [row]=await listRecordings(client,CAMERA.id,DATE);
  assert.deepEqual(Object.keys(row).sort(),['id','name','source','startTime','endTime','durationSeconds','bytes','encrypted'].sort());
  assert.equal(row.bytes,1024);
  assert(!JSON.stringify(row).includes('PRIVATE_'));
  assert.equal(row.encrypted,false);
  const [unknownSize]=await listRecordings(clientFor([{files:[file(undefined,undefined,{fileSize:null})],isAll:true}]),CAMERA.id,DATE);
  assert.equal(unknownSize.bytes,null);
});

test('malformed fragment timestamps and foreign serial/channel are rejected',async()=>{
  const badFiles=[file(START/1000,START/1000+60),file(START,START),file(START,START-1),file(START+0.5,START+1000),file(undefined,undefined,{deviceSerial:'OTHER_CAMERA'}),file(undefined,undefined,{channelNo:2})];
  for(const value of badFiles)await assert.rejects(listRecordings(clientFor([{files:[value],isAll:true}]),CAMERA.id,DATE),code('INVALID_RECORDINGS'));
});

test('null fragment gives a controlled protocol error',async()=>{
  await assert.rejects(listRecordings(clientFor([{files:[null],isAll:true}]),CAMERA.id,DATE),code('INVALID_RECORDINGS'));
});

test('legacy array channel cameraNo is checked against the authorized camera',async()=>{
  await assert.rejects(listRecordings(clientFor([[file(undefined,undefined,{channelNo:undefined,cameraNo:'2'})]]),CAMERA.id,DATE),code('INVALID_RECORDINGS'));
  const rows=await listRecordings(clientFor([[file(undefined,undefined,{channelNo:undefined,cameraNo:'1'})]]),CAMERA.id,DATE);
  assert.equal(rows.length,1);
});

test('explicit fragment storage source must agree with requested cloud or SD source',async()=>{
  await assert.rejects(listRecordings(clientFor([{files:[file(undefined,undefined,{recType:2})],isAll:true}]),CAMERA.id,DATE,'cloud'),code('INVALID_RECORDINGS'));
  await assert.rejects(listRecordings(clientFor([{files:[file(undefined,undefined,{recType:1})],isAll:true}]),CAMERA.id,DATE,'sd'),code('INVALID_RECORDINGS'));
});

test('invalid date/source and unauthorized camera do not reach video APIs',async()=>{
  let client=clientFor();await assert.rejects(listRecordings(client,CAMERA.id,'2026-02-30'),code('INVALID_DATE'));assert.deepEqual(client.calls,[]);
  client=clientFor();await assert.rejects(listRecordings(client,CAMERA.id,DATE,'auto'),code('INVALID_SOURCE'));assert.deepEqual(client.calls,[]);
  client=clientFor();await assert.rejects(listRecordings(client,'missing-camera',DATE),code('CAMERA_NOT_FOUND'));assert.equal(requests(client).length,0);
});

test('calendar explicitly remains unsupported after checking camera authorization',async()=>{
  for(const source of ['cloud','sd']){
    const client=clientFor();await assert.rejects(recordingDates(client,CAMERA.id,source),code('RECORDING_CALENDAR_UNAVAILABLE'));
    assert.deepEqual(client.calls,[{method:'camera',id:CAMERA.id}]);
  }
  await assert.rejects(recordingDates(clientFor(),'missing-camera'),code('CAMERA_NOT_FOUND'));
});

test('cloud playback must revalidate record membership and use type3 FLV with stopTime',async()=>{
  const pages=[{files:[file()],isAll:true}];
  const [row]=await listRecordings(clientFor(pages),CAMERA.id,DATE,'cloud');
  const client=clientFor(pages);
  const result=await recordingSource(client,CAMERA.id,{source:'cloud',date:DATE,recordId:row.id});
  assert.equal(result.protocol,'flv');
  assert.equal(result.durationSeconds,60);
  assert.equal(result.sourceInfo.recordId,row.id);
  assert.equal(result.sourceInfo.startTime,DATE+' 01:00:00');
  const play=requests(client).at(-1);
  assert.equal(play.route,'/api/lapp/v2/live/address/get');
  assert.deepEqual(play.params,{deviceSerial:CAMERA.deviceSerial,channelNo:'1',protocol:'4',type:'3',startTime:DATE+' 01:00:00',stopTime:DATE+' 01:01:00',expireTime:'300',supportH265:'1'});
  assert(!Object.hasOwn(play.params,'endTime'));
  assert(!Object.hasOwn(play.params,'quality'));
});

test('SD explicit-time playback uses type2 and local Beijing wall-clock strings',async()=>{
  const client=clientFor();
  const value=await recordingSource(client,CAMERA.id,{source:'sd',startTime:DATE+' 10:00:00',endTime:DATE+' 10:02:00'});
  assert.equal(requests(client).length,1);
  assert.equal(requests(client)[0].params.type,'2');
  assert.equal(requests(client)[0].params.stopTime,DATE+' 10:02:00');
  assert.equal(value.durationSeconds,120);
  assert.deepEqual(value.sourceInfo,{mode:'playback',source:'sd',date:DATE,startTime:DATE+' 10:00:00',endTime:DATE+' 10:02:00'});
});

test('record IDs cannot be reused across camera, date, or source and guessed upstream file IDs are rejected',async()=>{
  const [row]=await listRecordings(clientFor([{files:[file()],isAll:true}]),CAMERA.id,DATE,'cloud');
  const otherCamera={...CAMERA,id:'another-camera:1',deviceSerial:'ANOTHER_CAMERA'};
  const otherFile=file(undefined,undefined,{deviceSerial:otherCamera.deviceSerial});
  const cases=[
    [clientFor([{files:[otherFile],isAll:true}],otherCamera),otherCamera.id,{source:'cloud',date:DATE,recordId:row.id}],
    [clientFor([{files:[file()],isAll:true}]),CAMERA.id,{source:'sd',date:DATE,recordId:row.id}],
    [clientFor([{files:[],isAll:true}]),CAMERA.id,{source:'cloud',date:'2026-10-16',recordId:row.id}],
    [clientFor([{files:[file()],isAll:true}]),CAMERA.id,{source:'cloud',date:DATE,recordId:'offline-record'}]
  ];
  for(const [client,id,args] of cases){await assert.rejects(recordingSource(client,id,args),code('RECORDING_NOT_FOUND'));assert(requests(client).every(call=>call.route==='/api/lapp/video/by/time'));}
});

test('offline or encrypted cameras, and encrypted fragments, never obtain playback URLs',async()=>{
  for(const [camera,expected] of [[{...CAMERA,online:false},'CAMERA_OFFLINE'],[{...CAMERA,encrypted:true},'CAMERA_ENCRYPTED']]){
    const client=clientFor([],camera);await assert.rejects(recordingSource(client,CAMERA.id,{source:'sd',startTime:DATE+' 01:00:00',endTime:DATE+' 01:01:00'}),code(expected));assert.equal(requests(client).length,0);
  }
  const encrypted=file(undefined,undefined,{crypt:1});
  const [row]=await listRecordings(clientFor([{files:[encrypted],isAll:true}]),CAMERA.id,DATE);
  assert.equal(row.encrypted,true);
  const client=clientFor([{files:[encrypted],isAll:true}]);
  await assert.rejects(recordingSource(client,CAMERA.id,{source:'cloud',date:DATE,recordId:row.id}),code('RECORDING_ENCRYPTED'));
  assert(requests(client).every(call=>call.route==='/api/lapp/video/by/time'));
});

test('playback rejects unselected cloud recordings and invalid or cross-day SD time ranges',async()=>{
  await assert.rejects(recordingSource(clientFor(),CAMERA.id,{source:'cloud',startTime:DATE+' 01:00:00',endTime:DATE+' 01:01:00'}),code('RECORDING_REQUIRED'));
  for(const [begin,end] of [[DATE+' 01:00:00',DATE+' 01:00:00'],[DATE+' 01:00:00',DATE+' 00:59:59'],[DATE+' 23:59:00','2026-10-18 00:01:00']]){
    const client=clientFor();await assert.rejects(recordingSource(client,CAMERA.id,{source:'sd',startTime:begin,endTime:end}),code('INVALID_TIME_RANGE'));assert.equal(requests(client).length,0);
  }
});

test('playback rejects unsafe URL protocols or embedded credentials',async()=>{
  for(const url of [undefined,'not a url','http://offline.example.invalid/a.flv','file:///a','https://user:password@offline.example.invalid/a.flv']){
    const client=clientFor();client.ys=async()=>({url});
    await assert.rejects(recordingSource(client,CAMERA.id,{source:'sd',startTime:DATE+' 01:00:00',endTime:DATE+' 01:01:00'}),code('INVALID_PLAY_URL'));
  }
});

test('cloud errors propagate without fabricating empty recordings',async()=>{
  const failure=new CloudError('20032','offline authorization error');
  await assert.rejects(listRecordings(clientFor([failure]),CAMERA.id,DATE),error=>error===failure);
});

function capabilityClient(data,camera=CAMERA){
  const cloud=new HikCloud(null,{},async()=>{throw new Error('Unexpected network request');});
  const calls=[];
  cloud.camera=async id=>{assert.equal(id,camera.id);calls.push('camera');return camera;};
  cloud.videoToken=async selected=>{assert.equal(selected,camera);calls.push('token');return 'offline-fixture-token';};
  cloud.ys=async(route,token,params)=>{calls.push('capacity');assert.equal(route,'/api/lapp/device/capacity');assert.equal(token,'offline-fixture-token');assert.deepEqual(params,{deviceSerial:camera.deviceSerial,channelNo:String(camera.channelNo)});return data;};
  return {cloud,calls};
}

test('capabilities use only declared read endpoint and normalize string/int flags without leaking raw fields',async()=>{
  const {cloud,calls}=capabilityClient({support_disk:'1',support_cloud:1,support_replay_download:'1',ptz_left_right:'1',ptz_top_bottom:'0',privateField:'DO_NOT_EXPOSE'});
  const value=await cloud.capabilities(CAMERA.id);
  assert.deepEqual(calls,['camera','token','capacity']);
  assert.equal(value.cameraId,CAMERA.id);
  assert.equal(value.sdPlayback.available,true);
  assert.equal(value.sdPlayback.downloadSupported,true);
  assert.equal(value.cloudRecording.available,true);
  assert.equal(value.cloudRecording.calendarAvailable,false);
  assert.equal(value.ptz.horizontal,true);
  assert.equal(value.ptz.vertical,false);
  assert(!JSON.stringify(value).includes('DO_NOT_EXPOSE'));
});

test('capabilities reject nonobject response and treat absent capability flags as unsupported',async()=>{
  for(const value of [null,[],false,'1'])await assert.rejects(capabilityClient(value).cloud.capabilities(CAMERA.id),code('INVALID_CAPABILITIES'));
  const result=await capabilityClient({}, {...CAMERA,online:false}).cloud.capabilities(CAMERA.id);
  assert.equal(result.sdPlayback.available,false);
  assert.equal(result.cloudRecording.available,false);
  assert.equal(result.live.available,false);
  assert.equal(result.localCapture.available,false);
});
