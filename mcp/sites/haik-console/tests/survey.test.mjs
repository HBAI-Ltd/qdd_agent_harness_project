import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runSurvey,surveyOptions,diffPct} from '../skills/haik-camera/scripts/camera-survey.mjs';
const opening={cameraId:'CAM:1',thumb:Buffer.alloc(16),evidence:{jobId:'probe',path:'original.jpg',sha256:'hash'}};
const frame=level=>({thumb:Buffer.alloc(16,level),evidence:{jobId:'sample-'+level,reviewFile:'view_0002.jpg'}});

test('survey options enforce a bounded batch, duration, speed, settling and known axes',()=>{
 assert.equal(surveyOptions().settle,4);assert.equal(surveyOptions().steps,12);assert.equal(surveyOptions().speed,2);
 for(const options of [{steps:41},{steps:0},{moveMs:1001},{speed:6},{every:6},{settle:-1},{direction:'zoom_in'}])assert.throws(()=>surveyOptions(options));
});
test('survey performs serial short moves, waits after confirmed stops and samples planned boundaries',async()=>{
 const events=[];let clock=0;
 const report=await runSurvey({steps:3,every:2},{opening,now:()=>clock,sleep:async ms=>{events.push(['settle',ms]);clock+=ms;},tool:async(name,args)=>{events.push([name,args.direction,args.durationMs]);return{stopped:true};},sample:async step=>{events.push(['sample',step]);return frame(step*20);}});
 assert.deepEqual(events,[['move_camera','right',300],['move_camera','right',300],['settle',4000],['sample',2],['move_camera','right',300],['settle',4000],['sample',3]]);
 assert.equal(report.movedSteps,3);assert.equal(report.finalStop,true);assert.equal(report.aborted,null);assert.equal(report.samples.length,2);
});
test('an ambiguous movement gets one stop with its actual direction then ends without replay',async()=>{
 const calls=[];const report=await runSurvey({direction:'left'},{opening,tool:async(name,args)=>{calls.push([name,args.direction]);if(name==='move_camera')throw Object.assign(Error('timeout'),{detail:{code:'20008'}});return{stopped:true};},sample:()=>{throw Error('must not sample failed step');}});
 assert.deepEqual(calls,[['move_camera','left'],['stop_camera','left']]);assert.equal(report.finalStop,true);assert.equal(report.movedSteps,0);assert.equal(report.aborted,'20008');
});
test('failed motion with confirmed stopping stays a failed step and does not repeat stopping or movement',async()=>{
 let calls=0;const report=await runSurvey({steps:12},{opening,tool:async name=>{calls++;assert.equal(name,'move_camera');throw Object.assign(Error('rejected'),{detail:{code:'50000',details:{stopped:true}}});}});
 assert.equal(calls,1);assert.equal(report.finalStop,true);assert.equal(report.aborted,'50000');assert.equal(report.movedSteps,0);
});
test('unconfirmed stop ends the survey after one supplementary stop attempt',async()=>{
 const calls=[];const report=await runSurvey({}, {opening,tool:async name=>{calls.push(name);throw Object.assign(Error('failed'),{detail:{code:'PTZ_STOP_UNCONFIRMED'}});}});
 assert.deepEqual(calls,['move_camera','stop_camera']);assert.equal(report.finalStop,false);assert.equal(report.attemptedSteps,1);assert.equal(report.aborted,'PTZ_STOP_UNCONFIRMED');
});
test('missing stop confirmation is not counted as success even if supplementary stopping works',async()=>{
 const calls=[];const report=await runSurvey({}, {opening,tool:async name=>{calls.push(name);return name==='stop_camera'?{stopped:true}:{};}});
 assert.deepEqual(calls,['move_camera','stop_camera']);assert.equal(report.finalStop,true);assert.equal(report.movedSteps,0);assert.ok(report.aborted);
});
test('sample failure after a confirmed move prevents later blind movement',async()=>{
 let moves=0;const report=await runSurvey({every:1},{opening,sleep:async()=>{},tool:async()=>{moves++;return{stopped:true};},sample:async()=>{throw Object.assign(Error('card'),{code:'POSSIBLE_PROVIDER_CARD'});}});
 assert.equal(moves,1);assert.equal(report.finalStop,true);assert.equal(report.aborted,'POSSIBLE_PROVIDER_CARD');
});
test('elapsed budget is checked before another movement',async()=>{
 let clock=0,moves=0;const report=await runSurvey({every:1},{opening,now:()=>clock,sleep:async()=>{clock=180000;},tool:async()=>{moves++;return{stopped:true};},sample:async()=>frame(50)});
 assert.equal(moves,1);assert.equal(report.aborted,'TIME_BUDGET');assert.equal(report.finalStop,true);
});
test('pixel change heuristic requires prior divergence and reports hints without claiming a return',async()=>{
 assert.equal(diffPct(Buffer.alloc(16),Buffer.alloc(16,8)),0);assert.equal(diffPct(Buffer.alloc(16),Buffer.alloc(16,9)),100);
 assert.throws(()=>diffPct(Buffer.alloc(2),Buffer.alloc(1)));
 const deps={opening,sleep:async()=>{},tool:async()=>({stopped:true}),sample:async()=>frame(0)};
 const flat=await runSurvey({steps:2,every:1},deps);assert.equal(flat.openingSimilarityHint,false);
 let n=0;const changed=await runSurvey({steps:2,every:1},{...deps,sample:async()=>frame(n++===0?50:0)});
 assert.equal(changed.openingSimilarityHint,true);assert.deepEqual(changed.closestToOpening,{step:2,diffPct:0});assert.match(changed.note,/not angle feedback/);
});
