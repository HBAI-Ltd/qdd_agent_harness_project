import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {handleMcpMessage,parseFailure} from '../lib/mcp-server.mjs';
import {validateTool} from '../lib/mcp-tools.mjs';
import {MEDIA_TOOL_ACTIONS} from '../lib/media-tools.mjs';
const message=(method,params,id=1)=>({jsonrpc:'2.0',id,method,...(params?{params}:{})});
test('MCP rejects malformed envelopes and preserves string and zero IDs',async()=>{
 for(const bad of [null,[],{},message('ping',null,{}),{...message('ping'),params:null}])assert.equal((await handleMcpMessage(bad)).body.error.code,-32600);
 for(const id of [0,'request-1',null])assert.equal((await handleMcpMessage(message('ping',null,id))).body.id,id);
 assert.equal(parseFailure().body.error.code,-32700);
});
test('MCP negotiates supported protocol version and advertises real tools',async()=>{
 const init=await handleMcpMessage(message('initialize',{protocolVersion:'2025-03-26'}));assert.equal(init.body.result.protocolVersion,'2025-03-26');
 const listed=await handleMcpMessage(message('tools/list'));const tools=listed.body.result.tools;
 assert.equal(tools.length,15);assert.equal(new Set(tools.map(tool=>tool.name)).size,15);
 for(const name of ['camera_usage_guide','camera_connection_status','list_cameras','get_live_stream','move_camera','stop_camera',...Object.keys(MEDIA_TOOL_ACTIONS)])assert.ok(tools.some(tool=>tool.name===name),name);
});
test('notifications receive no response and never initiate camera movement',async()=>{
 let calls=0;const result=await handleMcpMessage({jsonrpc:'2.0',method:'tools/call',params:{name:'move_camera',arguments:{cameraId:'TEST:1',direction:'left'}}},()=>{calls++;});
 assert.deepEqual(result,{status:202,body:null});assert.equal(calls,0);
});
test('MCP validation rejects prototype properties and null arguments before resolving context',async()=>{
 assert.throws(()=>validateTool('list_cameras',JSON.parse('{"__proto__":{}}')));
 let calls=0;const result=await handleMcpMessage(message('tools/call',{name:'list_cameras',arguments:{constructor:'invalid'}}),()=>{calls++;});
 assert.equal(result.body.error.code,-32602);assert.equal(calls,0);
});
test('tool failures stay JSON-RPC results with actionable detail',async()=>{
 const result=await handleMcpMessage(message('tools/call',{name:'camera_connection_status'}),()=>({connectionStatus:()=>{throw Object.assign(new Error('请重新登录'),{code:'LOGIN_REQUIRED'});}}));
 assert.equal(result.status,200);assert.equal(result.body.result.isError,true);assert.equal(result.body.result.structuredContent.code,'LOGIN_REQUIRED');
});
test('media tools advertise bounds and local persistence annotations',async()=>{
 const tools=(await handleMcpMessage(message('tools/list'))).body.result.tools;
 const tool=name=>tools.find(item=>item.name===name);
 const capture=tool('camera_capture_start');
 assert.deepEqual(capture.inputSchema.required,['cameraId','durationSeconds']);
 assert.deepEqual(capture.inputSchema.properties.fps,{type:'number',minimum:0.1,maximum:5,default:1});
 assert.equal(capture.inputSchema.properties.durationSeconds.maximum,3600);
 assert.equal(capture.inputSchema.properties.maxWidth.maximum,1920);
 assert.equal(capture.annotations.readOnlyHint,false);assert.equal(capture.annotations.destructiveHint,false);
 assert.equal(tool('camera_snapshot').annotations.idempotentHint,false);
 for(const name of ['capture_status','capture_list'])assert.deepEqual(tool(name).annotations,{readOnlyHint:true,idempotentHint:true,openWorldHint:false});
 assert.equal(tool('capture_cancel').annotations.idempotentHint,true);
 assert.equal(tool('capture_cancel').annotations.destructiveHint,false);
 assert.equal(tool('capture_status').inputSchema.properties.limit.default,50);
 assert.equal(tool('capture_status').inputSchema.properties.limit.maximum,100);
});
test('invalid media ranges and source combinations never resolve camera context',async()=>{
 const id='a'.repeat(32),base={cameraId:'TEST:1',durationSeconds:10};
 const invalid=[
  ['camera_capabilities',{}],['camera_recording_dates',{cameraId:'TEST:1',source:'guessed'}],
  ['camera_recordings',{cameraId:'TEST:1',date:'2026/10/17'}],['camera_recordings',{cameraId:'TEST:1',date:'2026-10-17',offset:-1}],
  ['camera_playback',{cameraId:'TEST:1',date:'2026-10-17'}],['camera_playback',{cameraId:'TEST:1',source:'sd',startTime:'2026-10-17 12:00:00'}],
  ['camera_snapshot',{cameraId:'TEST:1',quality:'sub'}],['camera_snapshot',{cameraId:'TEST:1',maxWidth:1921}],
  ['camera_capture_start',{...base,durationSeconds:0}],['camera_capture_start',{...base,durationSeconds:3601}],
  ['camera_capture_start',{...base,durationSeconds:1801}],['camera_capture_start',{...base,durationSeconds:361,fps:5}],
  ['camera_capture_start',{...base,kind:'video',durationSeconds:601}],['camera_capture_start',{...base,fps:0.09}],
  ['camera_capture_start',{...base,maxWidth:319}],['camera_capture_start',{...base,mode:'live',source:'cloud'}],
  ['camera_capture_start',{...base,mode:'playback',date:'2026-10-17'}],
  ['capture_status',{jobId:'../private'}],['capture_status',{jobId:id,limit:101}],['capture_status',{jobId:id,offset:-1}],
  ['capture_list',{cameraId:''}],['capture_cancel',{jobId:id,path:'outside'}],
 ];
 for(const [name,args]of invalid){let calls=0;const result=await handleMcpMessage(message('tools/call',{name,arguments:args}),()=>{calls++;throw Error('must not resolve context');});assert.equal(result.body.error.code,-32602,name+' '+JSON.stringify(args));assert.equal(calls,0,name);}
});
test('valid media requests preserve selected IDs and route to the matching local action',async()=>{
 const cameraId='TEST:1',date='2026-10-17',jobId='b'.repeat(32),recordId='record-'.repeat(40);
 const cases=[
  ['camera_capabilities',{cameraId}],['camera_recording_dates',{cameraId}],['camera_recordings',{cameraId,date,source:'sd',offset:50,limit:50}],
  ['camera_playback',{cameraId,date,recordId}],['camera_snapshot',{cameraId,quality:2,maxWidth:1280}],
  ['camera_capture_start',{cameraId,mode:'playback',source:'sd',startTime:date+' 12:00:00',endTime:date+' 12:00:20',kind:'frames',durationSeconds:20,fps:1}],
  ['capture_status',{jobId,offset:50,limit:50}],['capture_list',{}],['capture_cancel',{jobId}],
 ];
 for(const [name,args]of cases){const calls=[];const value={selected:name,jobId};const result=await handleMcpMessage(message('tools/call',{name,arguments:args}),()=>({action:async(action,body)=>{calls.push({action,body});return value;}}));assert.deepEqual(calls,[{action:MEDIA_TOOL_ACTIONS[name],body:args}],name);assert.deepEqual(result.body.result.structuredContent,value);assert.deepEqual(JSON.parse(result.body.result.content[0].text),value);}
 for(const args of [{cameraId,durationSeconds:1800},{cameraId,durationSeconds:3600,fps:0.5},{cameraId,durationSeconds:600,kind:'video'}])assert.doesNotThrow(()=>validateTool('camera_capture_start',args));
});
test('stdio forwards emergency stop while movement is still pending',async(t)=>{
 let release;const moving=new Promise(resolve=>{release=resolve;});const arrived=[];
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;const m=JSON.parse(body);arrived.push(m.id);
  if(m.id==='move')await moving;else release();
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const child=spawn(process.execPath,['local/mcp-stdio.mjs'],{env:{...process.env,HAIK_PORT:String(server.address().port)},stdio:['pipe','pipe','pipe'],windowsHide:true});
 t.after(()=>child.kill());let output='';child.stdout.on('data',chunk=>output+=chunk);
 child.stdin.end(JSON.stringify(message('tools/call',{name:'move_camera'},'move'))+'\n'+JSON.stringify(message('tools/call',{name:'stop_camera'},'stop'))+'\n');
 const timeout=setTimeout(()=>{release();child.kill();},3000);t.after(()=>clearTimeout(timeout));
 const [exitCode]=await once(child,'exit');assert.equal(exitCode,0);assert.deepEqual(arrived,['move','stop']);
 const responses=output.trim().split('\n').map(line=>JSON.parse(line));assert.equal(responses.length,2);assert.deepEqual(new Set(responses.map(r=>r.id)),new Set(['move','stop']));
});
