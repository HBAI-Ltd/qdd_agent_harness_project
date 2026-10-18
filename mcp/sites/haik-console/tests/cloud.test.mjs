import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HikCloud,checked,CloudError} from '../lib/hik-cloud.mjs';
import {validateTool,callCameraTool} from '../lib/mcp-tools.mjs';
const session={headers:{Authorization:'Bearer test-session'}};
function fixture({startFailure=false,stopFailure=false}={}){
 const calls=[];
 const fetcher=async(url,init={})=>{
  const u=new URL(url);calls.push({path:u.pathname,params:init.body instanceof URLSearchParams?Object.fromEntries(init.body):undefined});
  if(u.pathname.endsWith('listRootZone'))return Response.json({code:0,data:[{id:7,name:'Test zone'}]});
  if(u.pathname.endsWith('homePage')){assert.equal(u.searchParams.get('zoneId'),'7');assert.equal(u.searchParams.get('page'),'1');return Response.json({code:0,data:[{deviceSerial:'TEST00001',deviceName:'Test camera',cameraList:[{channelNo:1,status:1}]}]});}
  if(u.pathname.endsWith('/device/get'))return Response.json({code:0,data:{deviceToken:'wrong-scope',deviceVideoToken:'correct-video-scope'}});
  if(u.pathname.endsWith('/live/address/get')){assert.equal(init.body.get('accessToken'),'correct-video-scope');assert.equal(init.body.get('protocol'),'4');assert.equal(init.body.get('supportH265'),'1');return Response.json({code:'200',data:{url:'https://media.invalid/test.flv'}});}
  if(u.pathname.endsWith('/ptz/start')){assert.equal(init.body.get('accessToken'),'correct-video-scope');assert.equal(init.body.get('newSpeed'),'2');if(startFailure)throw new Error('Network interrupted');return Response.json({result:{code:'200',msg:'ok'}});}
  if(u.pathname.endsWith('/ptz/stop')){if(stopFailure)throw new Error('Stop network interrupted');return Response.json({result:{code:'200',msg:'ok'}});}
  throw new Error('Unexpected route: '+u.pathname);
 };
 return {calls,cloud:new HikCloud(session,{sdk:{appKey:'test-sdk-metadata'}},fetcher)};
}
test('camera list respects returned zones and H265-compatible FLV uses the device video token',async()=>{const {cloud}=fixture();const cameras=await cloud.listCameras();assert.equal(cameras.length,1);assert.equal(cameras[0].id,'TEST00001:1');const live=await cloud.live(cameras[0].id);assert.equal(live.protocol,'flv');});
test('unlisted camera never reaches device-token or video APIs',async()=>{const {cloud,calls}=fixture();await assert.rejects(cloud.live('OTHER:1'),{code:'CAMERA_NOT_FOUND'});assert.ok(!calls.some(c=>c.path.includes('/token/')||c.path.includes('/live/')));});
test('live URL refreshes an explicitly rejected channel token once without changing the camera',async()=>{
 const {cloud,calls}=fixture();let requests=0;const original=cloud.ys.bind(cloud);
 cloud.ys=async(path,...args)=>{if(path.endsWith('/live/address/get')&&++requests===1)throw new CloudError('20001','通道不存在');return original(path,...args);};
 assert.equal((await cloud.live('TEST00001:1')).protocol,'flv');assert.equal(requests,2);assert.equal(calls.filter(c=>c.path.endsWith('/device/get')).length,2);
 assert.equal(calls.at(-1).params.channelNo,'1');assert.equal(calls.at(-1).params.deviceSerial,'TEST00001');
});
test('repeated live channel rejection is reported and transport failures do not trigger token loops',async()=>{
 const {cloud}=fixture();let attempts=0;cloud.ys=async()=>{attempts++;throw new CloudError('20032','通道不存在');};
 await assert.rejects(cloud.live('TEST00001:1'),{code:'20032'});assert.equal(attempts,2);
 attempts=0;cloud.ys=async()=>{attempts++;throw new TypeError('Connection interrupted');};
 await assert.rejects(cloud.live('TEST00001:1'),TypeError);assert.equal(attempts,1);
});
test('PTZ sends stop even when starting fails',async()=>{const {cloud,calls}=fixture({startFailure:true});await assert.rejects(cloud.ptz('TEST00001:1','right',100,2),/Network interrupted/);assert.equal(calls.at(-1).path,'/api/device/ptz/stop');});
test('PTZ reports unconfirmed stopping instead of reporting success',async()=>{const {cloud}=fixture({stopFailure:true});await assert.rejects(cloud.ptz('TEST00001:1','right',100,2),{code:'PTZ_STOP_UNCONFIRMED'});});
test('invalid motion cannot perform network requests',async()=>{const {cloud,calls}=fixture();await assert.rejects(cloud.ptz('TEST00001:1','toString',100,2),{code:'INVALID_DIRECTION'});await assert.rejects(cloud.ptz('TEST00001:1','right',5000,2),{code:'INVALID_DURATION'});assert.equal(calls.length,0);});
test('missing account session performs no cloud requests',async()=>{let calls=0;const cloud=new HikCloud(null,{},()=>{calls++;});await assert.rejects(cloud.listCameras(),{code:'LOGIN_REQUIRED'});assert.equal(calls,0);});
test('MCP rejects unknown and out-of-range arguments',()=>{assert.throws(()=>validateTool('move_camera',{cameraId:'TEST00001:1',direction:'right',durationMs:2000}));assert.throws(()=>validateTool('list_cameras',{url:'https://other.invalid/'}));});
test('MCP lists actual provider results through the same service',async()=>{const {cloud}=fixture();const r=await callCameraTool('list_cameras',{}, {session,cloud});assert.equal(r.structuredContent.cameras.length,1);assert.equal(JSON.parse(r.content[0].text).cameras[0].id,'TEST00001:1');});
test('expired bearer is classified as authentication failure without confusing SMS errors',()=>{assert.throws(()=>checked({code:'SESSION_EXPIRED',message:'登录已过期'}),{status:401});assert.throws(()=>checked({code:'SMS_INVALID',message:'登录验证码错误'}),{status:502});});
test('MCP connection status verifies with its provider instead of trusting stored session presence',async()=>{const result=await callCameraTool('camera_connection_status',{}, {session,connectionStatus:async()=>({connected:false,expired:true})});assert.equal(result.structuredContent.connected,false);assert.equal(result.structuredContent.expired,true);});

test('stopping retries device timeouts and uses retained authorization and direction',async()=>{
 const {cloud,calls}=fixture();let stops=0;const original=cloud.ys.bind(cloud);
 cloud.ys=async(path,token,params)=>{if(path.endsWith('/stop')&&++stops<3)throw new CloudError('20008','设备响应超时');return original(path,token,params);};
 await cloud.ptz('TEST00001:1','left',100,2);assert.equal(stops,3);
 const before=calls.length;await cloud.stop('TEST00001:1');assert.equal(calls.length,before+1);assert.equal(calls.at(-1).params.direction,'2');
});
test('unconfirmed stop blocks the next movement until explicit stop succeeds',async()=>{
 const {cloud,calls}=fixture({stopFailure:true});await assert.rejects(cloud.ptz('TEST00001:1','left',100,2),{code:'PTZ_STOP_UNCONFIRMED'});
 const before=calls.length;await assert.rejects(cloud.ptz('TEST00001:1','right',100,2),{code:'PTZ_STOP_REQUIRED'});assert.equal(calls.length,before);
 cloud.ys=async()=>({});await cloud.stop('TEST00001:1');assert.equal(cloud.ptzState.get('TEST00001:1').stopConfirmed,true);
});
test('stop never silently guesses a direction without movement history',async()=>{
 const {cloud,calls}=fixture();await assert.rejects(cloud.stop('TEST00001:1'),{code:'STOP_DIRECTION_REQUIRED'});assert.equal(calls.length,0);
});
test('stop refreshes channel authorization once on provider channel mismatch',async()=>{
 const {cloud}=fixture();let stops=0,tokens=0;const original=cloud.ys.bind(cloud),token=cloud.videoToken.bind(cloud);
 cloud.videoToken=async(camera)=>{tokens++;return token(camera);};
 cloud.ys=async(path,...args)=>{if(path.endsWith('/stop')&&++stops===1)throw new CloudError('20032','该用户下通道不存在');return original(path,...args);};
 await cloud.ptz('TEST00001:1','left',100,2);assert.equal(stops,2);assert.equal(tokens,2);assert.equal(cloud.ptzState.get('TEST00001:1').stopConfirmed,true);
});
test('start refreshes explicit channel rejection once and still confirms stopping',async()=>{
 const {cloud}=fixture();let starts=0;const original=cloud.ys.bind(cloud);
 cloud.ys=async(path,...args)=>{if(path.endsWith('/start')&&++starts===1)throw new CloudError('20032','该用户下通道不存在');return original(path,...args);};
 const result=await cloud.ptz('TEST00001:1','left',100,2);assert.equal(starts,2);assert.equal(result.stopped,true);
});
test('failed movement reports confirmed stopping instead of leaving the caller uncertain',async()=>{
 const {cloud}=fixture();const original=cloud.ys.bind(cloud);
 cloud.ys=async(path,...args)=>{if(path.endsWith('/start'))throw new CloudError('20032','该用户下通道不存在');return original(path,...args);};
 await assert.rejects(cloud.ptz('TEST00001:1','left',100,2),error=>error.code==='20032'&&error.details.stopped===true);
});
