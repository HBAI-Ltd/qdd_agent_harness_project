import test from 'node:test';
import assert from 'node:assert/strict';
import {handleMcpMessage} from '../lib/mcp.mjs';

const message=(name,args)=>({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
test('new media tools reject arbitrary sources, paths and oversized frame batches before runtime',async()=>{
  let calls=0;const runtime={async action(){calls++;return {};}};
  for(const [name,args] of [
    ['tysl_camera_capture_start',{cameraId:'camera',durationSeconds:3600,fps:5}],
    ['tysl_camera_capture_start',{cameraId:'camera',durationSeconds:1,sourceUrl:'http://example.invalid'}],
    ['tysl_camera_capture_start',{cameraId:'camera',kind:'video',durationSeconds:601}],
    ['tysl_camera_capture_start',{cameraId:'camera',mode:'playback',durationSeconds:10,source:'cloud'}],
    ['tysl_camera_playback',{cameraId:'camera',source:'cloud',date:'2026-10-17'}],
    ['tysl_camera_snapshot',{cameraId:'camera',outputPath:'C:/arbitrary.jpg'}],
    ['tysl_capture_status',{jobId:'../other'}],
    ['tysl_capture_status',{jobId:'a'.repeat(32),limit:1000}]
  ])assert.equal((await handleMcpMessage(message(name,args),runtime)).body.error?.code,-32602);
  assert.equal(calls,0);
});
test('capture status, replay and snapshot tools map to explicit runtime actions',async()=>{
  const calls=[];const runtime={async action(action,args){calls.push([action,args]);return {ok:true};}};
  for(const [name,args,action] of [
    ['tysl_camera_capture_start',{cameraId:'camera',durationSeconds:10,fps:1},'capture-start'],
    ['tysl_camera_snapshot',{cameraId:'camera',maxWidth:1280},'snapshot'],
    ['tysl_camera_playback',{cameraId:'camera',date:'2026-10-17',recordId:'file'},'playback'],
    ['tysl_capture_status',{jobId:'a'.repeat(32),offset:50,limit:50},'capture-status']
  ]){assert.equal((await handleMcpMessage(message(name,args),runtime)).body.result.isError,undefined);assert.equal(calls.at(-1)[0],action);}
});
