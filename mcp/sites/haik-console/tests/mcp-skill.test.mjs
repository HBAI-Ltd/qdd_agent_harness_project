import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {handleMcpMessage} from '../lib/mcp-server.mjs';
import {CAMERA_SKILL_URI,CAMERA_CAPTURE_URI,CAMERA_SURVEY_URI,CAMERA_SURVEY_SCRIPT_URI} from '../lib/mcp-skill.mjs';
const rpc=(method,params,id=1)=>({jsonrpc:'2.0',id,method,...(params?{params}:{})});
const noCameraContext=()=>{throw new Error('Guide discovery must never resolve credentials or contact cameras');};

test('initialization advertises skill resources and a tools-only entry point without resolving account context',async()=>{
 const result=await handleMcpMessage(rpc('initialize',{protocolVersion:'2025-06-18'}),noCameraContext);
 assert.ok(result.body.result.capabilities.resources);
 assert.ok(result.body.result.instructions.includes(CAMERA_SKILL_URI));
 assert.ok(result.body.result.instructions.includes('camera_usage_guide'));
 const tools=await handleMcpMessage(rpc('tools/list'),noCameraContext);
 const guide=tools.body.result.tools.find(tool=>tool.name==='camera_usage_guide');
 assert.equal(guide.annotations.readOnlyHint,true);assert.equal(guide.annotations.idempotentHint,true);
 assert.deepEqual(new Set(tools.body.result.tools.filter(t=>t.name!=='camera_usage_guide').map(t=>t.name)),
  new Set(['camera_connection_status','list_cameras','get_live_stream','move_camera','stop_camera','camera_capabilities','camera_recording_dates','camera_recordings','camera_playback','camera_snapshot','camera_capture_start','capture_status','capture_list','capture_cancel']));
 assert.equal(tools.body.result.tools.length,15);
});
test('resources and tool fallback return the same canonical skill without requiring login',async()=>{
 const canonical=(await readFile(new URL('../skills/haik-camera/SKILL.md',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 const resources=await handleMcpMessage(rpc('resources/list'),noCameraContext);
 assert.equal(resources.body.result.resources.length,4);
 for(const resource of resources.body.result.resources){
  const result=await handleMcpMessage(rpc('resources/read',{uri:resource.uri}),noCameraContext);
  assert.equal(result.body.result.contents[0].uri,resource.uri);assert.equal(result.body.result.contents[0].mimeType,resource.mimeType);
 }
 const direct=await handleMcpMessage(rpc('resources/read',{uri:CAMERA_SKILL_URI}),noCameraContext);
 const fallback=await handleMcpMessage(rpc('tools/call',{name:'camera_usage_guide',arguments:{}}),noCameraContext);
 assert.equal(direct.body.result.contents[0].text,canonical);
 assert.equal(fallback.body.result.content[0].text,canonical);
 assert.equal(fallback.body.result.structuredContent.uri,CAMERA_SKILL_URI);
});
test('capture reference is progressively available through resources and tools-only clients',async()=>{
 const direct=await handleMcpMessage(rpc('resources/read',{uri:CAMERA_CAPTURE_URI,_meta:{}}),noCameraContext);
 const fallback=await handleMcpMessage(rpc('tools/call',{name:'camera_usage_guide',arguments:{section:'capture'}}),noCameraContext);
 assert.equal(direct.body.result.contents[0].text,fallback.body.result.content[0].text);
 assert.equal(fallback.body.result.structuredContent.section,'capture');
 const canonical=(await readFile(new URL('../skills/haik-camera/references/capture.md',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 assert.equal(direct.body.result.contents[0].text,canonical);
});
test('unknown URIs never become filesystem reads and malformed discovery parameters are rejected',async()=>{
 for(const uri of ['file:///private/credentials','https://untrusted.invalid','haik://skills/../credentials']){
  const result=await handleMcpMessage(rpc('resources/read',{uri}),noCameraContext);assert.equal(result.body.error.code,-32002);
 }
 for(const [method,params] of [['resources/read',{}],['resources/read',{uri:CAMERA_SKILL_URI,path:'private'}],['resources/list',{cursor:'bogus'}],['tools/call',{name:'camera_usage_guide',arguments:{section:'unknown'}}],['tools/call',{name:'camera_usage_guide',arguments:{cameraId:'CAM-A:1'}}]]){
  const result=await handleMcpMessage(rpc(method,params),noCameraContext);assert.equal(result.body.error.code,-32602);
 }
 const templates=await handleMcpMessage(rpc('resources/templates/list'),noCameraContext);assert.deepEqual(templates.body.result,{resourceTemplates:[]});
});

test('survey tips and executable source are exposed identically through read-only resources and guide sections',async()=>{
 for(const [section,uri,source]of [['survey',CAMERA_SURVEY_URI,'references/survey.md'],['survey-script',CAMERA_SURVEY_SCRIPT_URI,'scripts/camera-survey.mjs']]){
  const direct=await handleMcpMessage(rpc('resources/read',{uri}),noCameraContext);
  const fallback=await handleMcpMessage(rpc('tools/call',{name:'camera_usage_guide',arguments:{section}}),noCameraContext);
  const canonical=(await readFile(new URL('../skills/haik-camera/'+source,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  assert.equal(direct.body.result.contents[0].text,canonical);assert.equal(fallback.body.result.content[0].text,canonical);
  assert.equal(fallback.body.result.structuredContent.uri,uri);assert.equal(fallback.body.result.structuredContent.version,'1.2.0');
 }
});
