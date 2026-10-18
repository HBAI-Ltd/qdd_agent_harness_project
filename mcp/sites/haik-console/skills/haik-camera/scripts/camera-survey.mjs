#!/usr/bin/env node
// Adapted from the user's haik-camera-survey tips. Uses persistent local MCP jobs.
import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function diffPct(a,b){
  if(a.length!==b.length||!a.length)throw Error('Thumbnail sizes differ');
  let changed=0;for(let i=0;i<a.length;i++)if(Math.abs(a[i]-b[i])>8)changed++;
  return Math.round(1000*changed/a.length)/10;
}
export function surveyOptions(value={}){
  const result={steps:12,direction:'right',every:2,moveMs:300,speed:2,settle:4,...value};
  for(const [key,min,max]of [['steps',1,40],['every',1,5],['moveMs',100,1000],['speed',1,5],['settle',0,15]])if(!Number.isInteger(result[key])||result[key]<min||result[key]>max)throw Error('Invalid '+key);
  if(!['right','left','up','down'].includes(result.direction))throw Error('Invalid direction');
  return result;
}

/** Call only for an explicitly requested survey after viewing the opening probe. */
export async function runSurvey(options,{tool,sample,opening,sleep=pause,now=Date.now,onProgress=()=>{}}){
  const opts=surveyOptions(options),started=now();
  const report={...opts,opening:opening.evidence,samples:[],failures:{},movedSteps:0,attemptedSteps:0,finalStop:null,closestToOpening:null,aborted:null};
  let previous=opening.thumb,diverged=false;
  for(let step=1;step<=opts.steps;step++){
    if(now()-started>=180000){report.aborted='TIME_BUDGET';break;}
    let failure,confirmed=false;report.attemptedSteps=step;
    try{
      const result=await tool('move_camera',{cameraId:opening.cameraId,direction:opts.direction,durationMs:opts.moveMs,speed:opts.speed});
      confirmed=result?.stopped===true;if(confirmed)report.movedSteps++;
      else failure={code:'PTZ_STOP_UNCONFIRMED'};
    }catch(error){failure=error.detail||{code:error.code||'LOCAL_SERVICE_ERROR'};confirmed=failure.stopped===true||failure.details?.stopped===true;}
    if(!confirmed){
      // The server already retries stopping. One supplementary explicit-direction call only.
      try{confirmed=(await tool('stop_camera',{cameraId:opening.cameraId,direction:opts.direction}))?.stopped===true;}catch{}
    }
    report.finalStop=confirmed;
    if(failure){const code=String(failure.code||'LOCAL_SERVICE_ERROR');report.failures[code]=(report.failures[code]||0)+1;report.aborted=confirmed?code:'PTZ_STOP_UNCONFIRMED';break;}
    if(!confirmed){report.aborted='PTZ_STOP_UNCONFIRMED';break;}
    if(step%opts.every!==0&&step!==opts.steps)continue;
    await sleep(opts.settle*1000);
    try{
      const frame=await sample(step),vsPrev=diffPct(previous,frame.thumb),vsOpening=diffPct(opening.thumb,frame.thumb);
      diverged||=vsOpening>=30;
      const row={step,...frame.evidence,vsPrev,vsOpening};report.samples.push(row);previous=frame.thumb;
      if(!report.closestToOpening||vsOpening<report.closestToOpening.diffPct)report.closestToOpening={step,diffPct:vsOpening};
      onProgress(row);
    }catch(error){report.aborted=error.code||'SAMPLE_FAILED';break;}
  }
  report.openingSimilarityHint=!!(diverged&&report.closestToOpening?.diffPct<12);
  report.note='Pixel differences are review hints, not angle feedback, motor verification, or proof of a full turn/exact return.';
  return report;
}

export async function main(argv){
  const [command,cameraId,...rest]=argv;
  if(!command||['help','--help','-h'].includes(command)){
    console.log('camera-survey.mjs status\ncamera-survey.mjs probe <cameraId> [seconds]\ncamera-survey.mjs survey <cameraId> --probe-job <reviewed-job-id> [--steps 12 --dir right --every 2 --move 300 --speed 2 --settle 4 --rotate 0 --label survey]\ncamera-survey.mjs sheet <report-directory> [columns]\nSet HAIK_ROOT to the workspace if running elsewhere. Inspect actual probe images before survey.');return;
  }
  if(!['status','probe','survey','sheet'].includes(command))throw Error('Unknown command');
  const root=path.resolve(process.env.HAIK_ROOT||process.cwd()),port=Number(process.env.HAIK_PORT||8787);
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid HAIK_PORT');
  const origin='http://127.0.0.1:'+port;let rpcId=0;
  async function tool(name,args={}){
    const response=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(180000),redirect:'error'});
    if(!response.ok)throw Error('Local MCP HTTP '+response.status);
    const message=await response.json();if(message.error)throw Error('Local MCP request rejected');
    const result=message.result,data=result?.structuredContent??JSON.parse(result?.content?.[0]?.text||'null');
    if(result?.isError)throw Object.assign(Error('Local camera operation failed'),{detail:data});return data;
  }
  if(command==='status'){await tool('camera_usage_guide');console.log(JSON.stringify({connection:await tool('camera_connection_status'),...await tool('list_cameras')},null,2));return;}
  const require=createRequire(path.join(root,'tools/package.json')),sharp=require('sharp');
  const flags={};if(command==='survey'){
    for(let i=0;i<rest.length;i+=2){const key=rest[i];if(!/^--(?:probe-job|steps|dir|every|move|speed|settle|rotate|label)$/.test(key)||rest[i+1]===undefined||Object.hasOwn(flags,key))throw Error('Invalid survey flag');flags[key]=rest[i+1];}
  }
  const rotation=Number(flags['--rotate']||0);if(![0,90,180,270].includes(rotation))throw Error('Invalid rotation');
  const outputRoot=path.join(root,'.local/camera-surveys');
  async function sheet(directory,columns=5){
    if(!Number.isInteger(columns)||columns<1||columns>8)throw Error('Columns must be 1–8');
    const report=JSON.parse(await readFile(path.join(directory,'report.json'),'utf8'));
    const frames=[report.opening,...(report.samples||[])].filter(Boolean);if(!frames.length||frames.length>41)throw Error('No bounded frame list in report');
    const width=300,height=190,parts=[];
    for(const [i,frame]of frames.entries()){
      if(!/^view_[0-9]{4}\.jpg$/.test(frame.reviewFile))throw Error('Invalid review filename');
      parts.push({input:await sharp(path.join(directory,frame.reviewFile)).resize(width,height-22,{fit:'contain',background:'#101820'}).jpeg().toBuffer(),left:i%columns*width,top:Math.floor(i/columns)*height});
      parts.push({input:Buffer.from('<svg width="300" height="22"><rect width="300" height="22" fill="#101820"/><text x="8" y="16" fill="white" font-size="13">'+frame.reviewFile+'</text></svg>'),left:i%columns*width,top:Math.floor(i/columns)*height+height-22});
    }
    const destination=path.join(directory,'sheet.png');await sharp({create:{width:columns*width,height:Math.ceil(frames.length/columns)*height,channels:3,background:'#101820'}}).composite(parts).png().toFile(destination);return destination;
  }
  if(command==='sheet'){const directory=path.resolve(cameraId||'');console.log(JSON.stringify({sheet:await sheet(directory,Number(rest[0]||5))}));return;}
  await tool('camera_usage_guide');
  if(!cameraId||cameraId.length>128)throw Error('Choose a listed camera ID');
  if(command==='probe'&&(rest.length>1||rest[0]?.startsWith('--')))throw Error('Invalid probe arguments');
  const seconds=command==='probe'?Number(rest[0]||6):1;if(!Number.isInteger(seconds)||seconds<1||seconds>15)throw Error('Probe duration must be 1–15 seconds');
  const options=surveyOptions({steps:Number(flags['--steps']||12),direction:flags['--dir']||'right',every:Number(flags['--every']||2),moveMs:Number(flags['--move']||300),speed:Number(flags['--speed']||2),settle:Number(flags['--settle']??4)});
  const label=flags['--label']||command;if(!/^[A-Za-z0-9_-]{1,40}$/.test(label))throw Error('Invalid label');
  const directory=path.join(outputRoot,label+'-'+Date.now());await mkdir(directory,{recursive:true});
  async function completed(job){
    const deadline=Date.now()+45000;while(job.status==='running'&&Date.now()<deadline){await pause(1000);job=(await tool('capture_status',{jobId:job.id,limit:100})).job;}
    if(job.status!=='done'||!job.frames?.length)throw Error('Capture incomplete; inspect the persistent job');return job;
  }
  async function frameFromJob(job,step){
    if(job.cameraId!==cameraId||job.sourceInfo?.mode!=='live'||Date.now()-Date.parse(job.endedAt)>300000||!Number.isFinite(Date.parse(job.endedAt)))throw Error('Use a recent live probe for the selected camera');
    const frame=job.frames.at(-1),url=new URL(frame.url);
    if(url.origin!==origin||url.username||url.password||url.search||url.hash||!/^\/captures\/[a-f0-9]{32}\/frame_\d{6}\.jpg$/.test(url.pathname))throw Error('Invalid local artifact URL');
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Local artifact unavailable');
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>16*1024*1024||createHash('sha256').update(bytes).digest('hex')!==frame.sha256)throw Error('Artifact hash mismatch');
    const info=await sharp(bytes).metadata();
    // Resolution is a warning heuristic, not an OCR verdict. Preserve the job for inspection.
    if(info.width===512&&info.height===288)throw Object.assign(Error('Possible provider error card; inspect original image before moving'),{code:'POSSIBLE_PROVIDER_CARD',jobId:job.id,path:frame.path});
    const reviewFile='view_'+String(step).padStart(4,'0')+'.jpg';await sharp(bytes).rotate(rotation).jpeg({quality:90}).toFile(path.join(directory,reviewFile));
    const thumb=await sharp(bytes).grayscale().resize(64,36,{fit:'fill'}).raw().toBuffer();
    return {cameraId,thumb,evidence:{jobId:job.id,sequence:frame.sequence,path:frame.path,sha256:frame.sha256,capturedAt:frame.capturedAt,reviewFile}};
  }
  async function sample(step,duration=1){return frameFromJob(await completed((await tool('camera_capture_start',{cameraId,mode:'live',kind:'frames',durationSeconds:duration,fps:1,maxWidth:1280,quality:2})).job),step);}
  if(command==='probe'){
    const opening=await sample(0,seconds),report={cameraId,opening:opening.evidence,samples:[],verdict:'saved-frames-require-visual-review'};
    await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({directory,...report,sheet:await sheet(directory)}));return;
  }
  const probeId=flags['--probe-job'];if(!/^[a-f0-9]{32}$/.test(probeId||''))throw Error('Run probe, inspect actual images, then supply --probe-job');
  const opening=await frameFromJob(await completed((await tool('capture_status',{jobId:probeId,limit:100})).job),0);
  const report=await runSurvey(options,{tool,sample,opening});report.cameraId=cameraId;
  await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({directory,...report,sheet:await sheet(directory)}));if(report.aborted)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({code:error.code||error.detail?.code||'SURVEY_FAILED',message:error.detail?'Local camera operation failed':String(error.message).replace(/https?:\/\/\S+/g,'[hidden]'),...(error.jobId?{jobId:error.jobId,path:error.path}:{})}));process.exitCode=1;});
