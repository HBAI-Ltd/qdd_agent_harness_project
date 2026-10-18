import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const toolsDir=fileURLToPath(new URL('../../../tools/node_modules',import.meta.url));
const sharp=createRequire(new URL('../../../tools/package.json',import.meta.url))('sharp');
const script=fileURLToPath(new URL('../skills/haik-camera/scripts/camera-survey.mjs',import.meta.url));
const jobId='a'.repeat(32);
async function fixture(t,width=320,height=180){
 const root=await mkdtemp(path.join(os.tmpdir(),'haik-survey-test-'));
 t.after(async()=>{const actual=path.resolve(root),parent=path.resolve(os.tmpdir());if(path.dirname(actual)!==parent||!path.basename(actual).startsWith('haik-survey-test-'))throw Error('Unsafe cleanup path');await rm(actual,{recursive:true,force:true});});
 const bytes=await sharp({create:{width,height,channels:3,background:'#407080'}}).jpeg().toBuffer(),hash=createHash('sha256').update(bytes).digest('hex'),calls=[];
 let port;
 const server=http.createServer(async(req,res)=>{
  if(req.url.startsWith('/captures/')){res.writeHead(200,{'Content-Type':'image/jpeg'});res.end(bytes);return;}
  let input='';for await(const chunk of req)input+=chunk;const m=JSON.parse(input),name=m.params.name;calls.push({name,args:m.params.arguments});
  const job={id:jobId,cameraId:'CAM:1',kind:'frames',status:'done',sourceInfo:{mode:'live'},endedAt:new Date().toISOString(),frames:[{sequence:1,path:path.join(root,'raw.jpg'),sha256:hash,capturedAt:new Date().toISOString(),url:`http://127.0.0.1:${port}/captures/${jobId}/frame_000001.jpg`}]};
  const data=['camera_capture_start','capture_status'].includes(name)?{job}:name==='move_camera'?{code:'20008',details:{stopped:true}}:{};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{...(name==='move_camera'?{isError:true}:{}),structuredContent:data}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));port=server.address().port;t.after(()=>new Promise(resolve=>server.close(resolve)));
 async function run(args){return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[script,...args],{env:{...process.env,HAIK_ROOT:root,HAIK_PORT:String(port),NODE_PATH:toolsDir},windowsHide:true});let out='',err='';
  const timer=setTimeout(()=>{child.kill();reject(Error('CLI fixture timeout'));},15000);
  child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);resolve({code,out,err});});
 });}
 return {root,server,calls,run};
}
test('CLI probe saves a review/report and offline sheet rebuild never contacts MCP',async t=>{
 const {calls,run}=await fixture(t);const result=await run(['probe','CAM:1','6']);assert.equal(result.code,0,result.err);
 const data=JSON.parse(result.out);assert.equal(data.opening.jobId,jobId);assert.equal(data.verdict,'saved-frames-require-visual-review');assert.ok((await readFile(data.sheet)).length>0);
 assert.deepEqual(calls.map(item=>item.name),['camera_usage_guide','camera_capture_start']);assert.equal(calls[1].args.durationSeconds,6);
 const count=calls.length,rebuild=await run(['sheet',data.directory,'2']);assert.equal(rebuild.code,0,rebuild.err);assert.equal(calls.length,count);
});
test('CLI warns on possible error-card size, returns original evidence and never moves',async t=>{
 const {run,calls}=await fixture(t,512,288);const result=await run(['probe','CAM:1']);assert.equal(result.code,1);
 const error=JSON.parse(result.err);assert.equal(error.code,'POSSIBLE_PROVIDER_CARD');assert.equal(error.jobId,jobId);assert.ok(error.path);assert.ok(!calls.some(c=>c.name==='move_camera'));
});
test('CLI survey persists its failed-step report and does not replay a timed-out move',async t=>{
 const {run,calls}=await fixture(t);const result=await run(['survey','CAM:1','--probe-job',jobId,'--steps','12']);assert.equal(result.code,1,result.err);
 const report=JSON.parse(result.out);assert.equal(report.aborted,'20008');assert.equal(report.finalStop,true);assert.equal(report.movedSteps,0);
 assert.deepEqual(calls.map(c=>c.name),['camera_usage_guide','capture_status','move_camera']);
 assert.equal(JSON.parse(await readFile(path.join(report.directory,'report.json'),'utf8')).aborted,'20008');assert.ok((await readFile(report.sheet)).length>0);
});
