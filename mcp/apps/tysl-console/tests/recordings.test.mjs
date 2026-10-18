import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingDay,recordingTime,recordingRange,cloudFileTimes,recordingDates,cloudRecordings,sdRecordings,cloudRecordingSource,sdRecordingSource} from '../lib/recordings.mjs';

test('Beijing calendar input rejects overflow dates, missing zones and inverted ranges',()=>{
  assert.equal(recordingDay('2024-02-29'),'2024-02-29');
  for(const value of ['2026-02-29','2026-13-01','2026-1-01','2026-10-17T00:00:00Z'])assert.throws(()=>recordingDay(value),{code:'INVALID_DATE'});
  assert.throws(()=>recordingTime('2026-10-17 24:01:00'),{code:'INVALID_TIME'});
  assert.equal(recordingRange('2026-10-17 12:00:00','2026-10-17 12:00:25'),25);
  assert.throws(()=>recordingRange('2026-10-17 12:00:00','2026-10-17 11:00:00'),{code:'INVALID_TIME_RANGE'});
});
test('cloud filenames supply recording time, never upload timestamp',()=>{
  for(const suffix of ['_ALARM.ps','.ps'])assert.equal(cloudFileTimes({name:'20261017120000-20261017120025'+suffix}).durationSeconds,25);
  assert.deepEqual(cloudFileTimes({name:'unknown.ps',createDate:'2026-10-17 12:00:00'}),{startTime:null,endTime:null,durationSeconds:null});
});
test('cloud dates and pages use evidenced bodies and strip signed URLs from public records',async()=>{
  const calls=[];
  const client={async post(path,body){calls.push({path,body});if(path.endsWith('getFolderList'))return [{name:'20261017'},{name:'20260230'},{name:'not-a-date'}];return {count:2,fileList:[{id:String(body.pageNum),name:'20261017120000-20261017120025_ALARM.ps',size:123,fileDownloadUrl:'https://example.invalid/private-token',extendProps:{streamEncrypt:'0'}}]};}};
  assert.deepEqual(await recordingDates(client,'camera'),['2026-10-17']);
  const items=await cloudRecordings(client,'camera','2026-10-17');
  assert.equal(items.length,2);assert.equal(items[0].durationSeconds,25);
  assert.equal(JSON.stringify(items).includes('private-token'),false);
  assert.deepEqual(calls[1].body,{deviceCode:'camera',path:'20261017',isHttp:true,pageSize:1500,pageNum:1});
  assert.equal(calls[2].body.pageNum,2);
});
test('a repeating cloud page cannot silently satisfy the total with duplicates',async()=>{
  const client={async post(){return {count:4,fileList:[{id:'same'}]};}};
  await assert.rejects(cloudRecordings(client,'camera','2026-10-17'),{code:'INVALID_RECORDING_PAGE'});
});
test('SD queries use day strings and normalize exact response fields',async()=>{
  const calls=[];
  const client={async post(path,body){calls.push({path,body});return [{recordName:'r',beginTime:'2026-10-17 12:00:00',endTime:'2026-10-17 12:01:00'}];}};
  const items=await sdRecordings(client,'camera','2026-10-17');
  assert.equal(items[0].durationSeconds,60);assert.match(items[0].id,/^[a-f0-9]{64}$/);
  assert.deepEqual(calls[0].body,{deviceCode:'camera',beginTime:'2026-10-17 00:00:00',endTime:'2026-10-17 23:59:59'});
});
test('playback URLs use their own response fields and fixed protocol values',async()=>{
  const calls=[];
  const client={async post(path,body){calls.push({path,body});return path.endsWith('getFileUrlById')?{url:'https://example.invalid/clip'}:{streamUrl:'rtsp://example.invalid/clip'};}};
  assert.equal((await cloudRecordingSource(client,'camera','file')).url,'https://example.invalid/clip');
  assert.deepEqual(calls[0].body,{deviceCode:'camera',id:'file',isHttp:true,fileType:0,type:1});
  await sdRecordingSource(client,'camera','2026-10-17 12:00:00','2026-10-17 12:01:00','r');
  assert.deepEqual(calls[1].body,{deviceCode:'camera',beginTime:'2026-10-17 12:00:00',endTime:'2026-10-17 12:01:00',playProtocol:3,recordName:'r'});
});
