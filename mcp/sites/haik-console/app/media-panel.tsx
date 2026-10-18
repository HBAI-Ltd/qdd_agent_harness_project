'use client';

import {useEffect,useRef,useState} from 'react';
import {Camera,Clapperboard,Download,FolderOpen,Images,LoaderCircle,Play,RefreshCw,Video} from 'lucide-react';
import {api} from '../lib/client-api';

export type MediaCamera={id:string;name:string;online:boolean;encrypted:boolean};
export type PlaybackResult={url:string;protocol?:string;mode?:string;cameraId?:string};
type Recording={id:string;name?:string;startTime?:string|number;endTime?:string|number;durationSeconds?:number;bytes?:number;encrypted?:boolean;source?:string};
type Artifact={sequence?:number;relativeSeconds?:number;capturedAt?:string;path?:string;url?:string;bytes?:number;sha256?:string};
type CaptureJob={id:string;cameraName?:string;kind:string;status:string;durationSeconds?:number;fps?:number;frameCount?:number;startedAt?:string;endedAt?:string;directory?:string;frames?:Artifact[];video?:Artifact;sourceInfo?:{mode?:string;date?:string};error?:{message?:string}};
type JobDetail={job:CaptureJob;offset:number;limit?:number;totalFrames:number;hasMore:boolean};
type RecordPage={recordings:Recording[];total:number;offset:number;limit:number;hasMore:boolean};
type Capability={live?:{available?:boolean};ptz?:{available?:boolean};sdPlayback?:{available?:boolean};cloudRecording?:{queryAvailable?:boolean}};
const PAGE=50;
const labels:Record<string,string>={running:'采集中',done:'已完成',failed:'采集失败',cancelled:'已取消',interrupted:'已中断'};
const today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const idValid=(value:string)=>/^[a-f0-9]{32}$/.test(value);
const errorText=(error:unknown)=>error instanceof Error?error.message:'请求未完成，请稍后重试。';
function time(value:string|number|undefined,withDate=false){
 if(value===undefined||value==='')return '时间未提供';
 const raw=String(value);let date:Date;
 if(typeof value==='number'||/^\d{10,13}$/.test(raw)){const n=Number(value);date=new Date(n<100000000000?n*1000:n);}
 else date=new Date(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw)?raw.replace(' ','T')+'+08:00':raw);
 return Number.isNaN(date.getTime())?raw.slice(0,80):date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',...(withDate?{year:'numeric',month:'2-digit',day:'2-digit'}:{}),hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}
function duration(value:number|undefined){return Number.isFinite(value)?Number(value)>=60?Math.floor(Number(value)/60)+' 分 '+Math.round(Number(value)%60)+' 秒':Math.round(Number(value)*10)/10+' 秒':'';}
function size(value:number|undefined){return value&&Number.isFinite(value)?value>=1048576?(value/1048576).toFixed(1)+' MB':(value/1024).toFixed(1)+' KB':'';}
function artifactUrl(value:string|undefined){
 if(!value||typeof window==='undefined')return '';
 try{const url=new URL(value,window.location.origin);if(url.origin!==window.location.origin||url.username||url.password||url.search||url.hash||!/^\/captures\/[a-f0-9]{32}\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url.pathname)||url.pathname.split('/').pop()?.includes('..'))return '';return url.href;}catch{return '';}
}

export default function MediaPanel({camera,connected,scope,onPlayback,onPlaybackStart,onLive}:{camera?:MediaCamera;connected:boolean;scope:number;onPlayback:(result:PlaybackResult,ticket?:number)=>void|Promise<void>;onPlaybackStart?:()=>number;onLive:()=>void|Promise<void>}){
 const [source,setSource]=useState('cloud'),[date,setDate]=useState(today),[dates,setDates]=useState<string[]>([]),[records,setRecords]=useState<RecordPage|null>(null),[recordBusy,setRecordBusy]=useState(false),[datesBusy,setDatesBusy]=useState(false),[recordMessage,setRecordMessage]=useState(''),[recordError,setRecordError]=useState(false),[capability,setCapability]=useState(''),[capabilityBusy,setCapabilityBusy]=useState(false);
 const [seconds,setSeconds]=useState('10'),[fps,setFps]=useState('1'),[width,setWidth]=useState('1280'),[captureBusy,setCaptureBusy]=useState(false),[captureMessage,setCaptureMessage]=useState(''),[captureError,setCaptureError]=useState(false);
 const [jobs,setJobs]=useState<CaptureJob[]>([]),[root,setRoot]=useState(''),[jobsBusy,setJobsBusy]=useState(false),[jobMessage,setJobMessage]=useState(''),[jobError,setJobError]=useState(false),[detail,setDetail]=useState<JobDetail|null>(null),[detailBusy,setDetailBusy]=useState(false);
 const generation=useRef(0),recordVersion=useRef(0),datesVersion=useRef(0),capVersion=useRef(0),jobsVersion=useRef(0),detailVersion=useRef(0),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),mounted=useRef(true),jobsRef=useRef<CaptureJob[]>([]),detailRef=useRef<JobDetail|null>(null),busyRef=useRef(false),connectedRef=useRef(connected);
 connectedRef.current=connected;
 const ready=connected&&!!camera;
 function recordNotice(text:string,error=false){setRecordMessage(text);setRecordError(error);}
 function captureNotice(text:string,error=false){setCaptureMessage(text);setCaptureError(error);}
 function jobNotice(text:string,error=false){setJobMessage(text);setJobError(error);}
 function valid(token:number){return mounted.current&&token===generation.current;}
 async function copy(value:string){const token=generation.current;try{await navigator.clipboard.writeText(value);if(valid(token))jobNotice('路径已复制，可交给本机图片分析工具使用。');}catch{if(valid(token))jobNotice('浏览器未允许复制，可选中显示的路径手动复制。',true);}}
 async function getJob(id:string,offset=0,silent=false){
  if(!idValid(id)||!connectedRef.current)return;
  const token=generation.current,version=++detailVersion.current;setDetailBusy(true);if(!silent)jobNotice('正在读取任务详情…');
  try{const result=await api<JobDetail>('capture-status',{jobId:id,offset,limit:PAGE});if(!valid(token)||version!==detailVersion.current)return;if(!result.job||result.job.id!==id)throw Error('任务详情格式无法识别。');setDetail(result);detailRef.current=result;if(!silent)jobNotice(result.job.status==='running'?'任务正在采集，运行期间每 5 秒刷新。':'任务文件已列出，图片与录像均保存在本机。');}
  catch(error){if(valid(token)&&version===detailVersion.current)jobNotice(errorText(error),true);}
  finally{if(valid(token)&&version===detailVersion.current)setDetailBusy(false);}
 }
 async function refreshJobs(silent=false){
  if(!connectedRef.current)return;
  const token=generation.current,version=++jobsVersion.current;clearTimeout(timer.current);setJobsBusy(true);if(!silent)jobNotice('正在读取本地任务…');
  try{
   const result=await api<{jobs:CaptureJob[];root:string}>('capture-list',{});if(!valid(token)||version!==jobsVersion.current)return;
   const next=(Array.isArray(result.jobs)?result.jobs:[]).filter(job=>job&&idValid(job.id));jobsRef.current=next;setJobs(next);setRoot(typeof result.root==='string'?result.root:'');
   if(!silent)jobNotice(next.length?'共 '+next.length+' 个本地任务。':'尚无采集任务，可以先获取单张截图。');
   const selected=detailRef.current;
   if(selected){const current=next.find(job=>job.id===selected.job.id);if(!current){detailVersion.current++;detailRef.current=null;setDetail(null);setDetailBusy(false);}else if(!silent||current.status==='running'||selected.job.status==='running')await getJob(current.id,selected.offset,true);}
  }catch(error){if(valid(token)&&version===jobsVersion.current)jobNotice(errorText(error),true);}
  finally{if(valid(token)&&version===jobsVersion.current){setJobsBusy(false);if(jobsRef.current.some(job=>job.status==='running'))timer.current=setTimeout(()=>void refreshJobs(true),5000);}}
 }
 useEffect(()=>{
  generation.current++;recordVersion.current++;datesVersion.current++;capVersion.current++;jobsVersion.current++;detailVersion.current++;clearTimeout(timer.current);busyRef.current=false;
  setRecords(null);setDates([]);setCapability('');setRecordBusy(false);setDatesBusy(false);setCapabilityBusy(false);setCaptureBusy(false);setDetailBusy(false);setJobsBusy(false);setRecordMessage('');setCaptureMessage('');setJobMessage('');setDetail(null);detailRef.current=null;jobsRef.current=[];setJobs([]);setRoot('');
  if(connected)void refreshJobs();
  return()=>{generation.current++;clearTimeout(timer.current);};
  // Camera/account changes invalidate every outstanding response.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[camera?.id,connected,scope]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;clearTimeout(timer.current);};},[]);
 function query(){if(!ready||!camera)throw Error('请连接账号并选择摄像头。');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>today())throw Error('请选择北京时间今天或之前的有效日期。');return{cameraId:camera.id,source,date};}
 async function getRecords(offset=0){
  let args:ReturnType<typeof query>;try{args=query();}catch(error){recordNotice(errorText(error),true);return;}
  const token=generation.current,version=++recordVersion.current;setRecordBusy(true);recordNotice('正在查询'+(source==='sd'?'SD 卡':'云端')+'录像…');
  try{const result=await api<RecordPage>('recordings',{...args,offset,limit:PAGE});if(!valid(token)||version!==recordVersion.current)return;setRecords({...result,recordings:Array.isArray(result.recordings)?result.recordings:[]});recordNotice(result.recordings?.length?'录像时间均为北京时间。':'该日期未查询到录像。录像服务或 SD 卡状态可能影响结果。');}
  catch(error){if(valid(token)&&version===recordVersion.current){setRecords(null);recordNotice(errorText(error),true);}}
  finally{if(valid(token)&&version===recordVersion.current)setRecordBusy(false);}
 }
 async function getDates(){
  if(!ready||!camera)return;const token=generation.current,version=++datesVersion.current;setDatesBusy(true);recordNotice('正在读取云录像日期…');
  try{const result=await api<{dates:string[]}>('recording-dates',{cameraId:camera.id});if(!valid(token)||version!==datesVersion.current)return;const values=[...new Set((Array.isArray(result.dates)?result.dates:[]).filter(value=>/^\d{4}-\d{2}-\d{2}$/.test(value)))].sort().reverse();setDates(values);recordNotice(values.length?'点击日期可选中，然后查询录像。':'云端未返回可用日期，可手动选择日期查询。');}
  catch(error){if(valid(token)&&version===datesVersion.current)recordNotice(errorText(error),true);}
  finally{if(valid(token)&&version===datesVersion.current)setDatesBusy(false);}
 }
 async function checkCapabilities(){
  if(!ready||!camera)return;const token=generation.current,version=++capVersion.current;setCapabilityBusy(true);setCapability('正在检查设备能力…');
  try{const result=await api<Capability>('capabilities',{cameraId:camera.id});if(!valid(token)||version!==capVersion.current)return;const flag=(value:boolean|undefined)=>value===true?'支持':value===false?'未提供':'待确认';setCapability('实时预览：'+flag(result.live?.available)+' · 云台控制：'+flag(result.ptz?.available)+' · SD 卡回放：'+flag(result.sdPlayback?.available)+' · 云录像查询：'+flag(result.cloudRecording?.queryAvailable)+'。录像以实际查询结果为准。');}
  catch(error){if(valid(token)&&version===capVersion.current)setCapability(errorText(error));}
  finally{if(valid(token)&&version===capVersion.current)setCapabilityBusy(false);}
 }
 async function play(record:Recording){
  if(!camera||record.encrypted)return;const token=generation.current,version=++recordVersion.current,ticket=onPlaybackStart?.();setRecordBusy(true);recordNotice('正在获取录像回放…');
  try{const result=await api<PlaybackResult>('playback',{cameraId:camera.id,source,date,recordId:record.id});if(!valid(token)||version!==recordVersion.current)return;await onPlayback(result,ticket);if(valid(token))recordNotice('已切换到历史回放，可在上方画面中查看。');}
  catch(error){if(valid(token)&&version===recordVersion.current)recordNotice(errorText(error),true);}
  finally{if(valid(token)&&version===recordVersion.current)setRecordBusy(false);}
 }
 async function create(action:string,args:Record<string,unknown>){
  if(busyRef.current){captureNotice('正在提交任务，请稍候。');return;}const token=generation.current;busyRef.current=true;setCaptureBusy(true);captureNotice(action==='snapshot'?'正在获取单张截图…':'正在创建本地采集任务…');
  try{const result=await api<{job:CaptureJob}> (action,args);if(!valid(token))return;captureNotice('文件由本机保存，可在下方任务中查看进度、图片与下载。');await refreshJobs();if(valid(token)&&result.job?.id)await getJob(result.job.id);}
  catch(error){if(valid(token))captureNotice(errorText(error),true);}
  finally{if(valid(token)){busyRef.current=false;setCaptureBusy(false);}}
 }
 function start(kind:'snapshot'|'frames'|'video'){
  try{
   if(!ready||!camera)throw Error('请先连接账号并选择摄像头。');const maxWidth=Number(width);if(!Number.isInteger(maxWidth)||maxWidth<320||maxWidth>1920)throw Error('截图最大宽度应为 320–1,920 的整数。');
   if(kind==='snapshot'){void create('snapshot',{cameraId:camera.id,maxWidth});return;}
   const durationSeconds=Number(seconds);if(!Number.isInteger(durationSeconds)||durationSeconds<1||durationSeconds>(kind==='video'?600:3600))throw Error(kind==='video'?'本地视频时长应为 1–600 秒的整数。':'批量截图时长应为 1–3,600 秒的整数。');
   const args:Record<string,unknown>={cameraId:camera.id,mode:'live',kind,durationSeconds,maxWidth};
   if(kind==='frames'){const frameRate=Number(fps);if(!Number.isFinite(frameRate)||frameRate<0.1||frameRate>5)throw Error('截图帧率应为每秒 0.1–5 帧。');if(Math.ceil(durationSeconds*frameRate)>1800)throw Error('每次最多保存 1,800 张，请降低时长或帧率。');args.fps=frameRate;}
   void create('capture-start',args);
  }catch(error){captureNotice(errorText(error),true);}
 }
 async function cancel(id:string){const token=generation.current;try{await api('capture-cancel',{jobId:id});if(valid(token)){jobNotice('取消请求已提交，已保存文件会保留。');await refreshJobs();}}catch(error){if(valid(token))jobNotice(errorText(error),true);}}
 function clearRecordQuery(){recordVersion.current++;datesVersion.current++;setRecordBusy(false);setDatesBusy(false);setRecords(null);recordNotice('');}
 const selected=detail?.job;
 const frames=selected?.frames?.slice(0,PAGE)||[];
 const videoUrl=artifactUrl(selected?.video?.url);

 return <div className="media-panels">
  <section className="media-card" aria-labelledby="recordings-title"><div className="media-heading"><div><span className="section-kicker">RECORDINGS</span><h2 id="recordings-title">录像回放</h2></div><button className="media-button" disabled={!ready} onClick={()=>void onLive()}><RadioIcon/>返回实时</button></div>
   <div className="media-camera-line"><p>{camera?'当前摄像头：'+camera.name:'选择摄像头后查询云端或 SD 卡录像。'}</p><button className="media-button" disabled={!ready||capabilityBusy} onClick={()=>void checkCapabilities()}>{capabilityBusy?<LoaderCircle size={13} className="spin"/>:null}检查设备能力</button></div>
   {capability&&<p className="media-capability" role="status">{capability}</p>}
   <form className="media-form" onSubmit={event=>{event.preventDefault();void getRecords(0);}}><label>录像来源<select value={source} disabled={recordBusy} onChange={event=>{setSource(event.target.value);clearRecordQuery();setDates([]);}}><option value="cloud">云端录像</option><option value="sd">SD 卡录像</option></select></label><label>日期 · 北京时间<input type="date" value={date} max={today()} required disabled={recordBusy} onChange={event=>{setDate(event.target.value);clearRecordQuery();}}/></label><button className="primary-button" type="submit" disabled={!ready||recordBusy}>{recordBusy?<LoaderCircle size={14} className="spin"/>:<Clapperboard size={14}/>}查询录像</button><button className="media-button" type="button" disabled={!ready||datesBusy||source!=='cloud'} onClick={()=>void getDates()}>查看云录像日期</button></form>
   {dates.length>0&&<div className="media-dates" aria-label="可用云录像日期">{dates.map(day=><button key={day} className={'media-button '+(date===day?'active':'')} aria-pressed={date===day} onClick={()=>{setDate(day);clearRecordQuery();}}>{day}</button>)}</div>}
   {recordMessage&&<p className={'media-message '+(recordError?'error':'')} role="status" aria-live="polite">{recordMessage}</p>}
   <div className="recording-results" aria-busy={recordBusy}>{records?.recordings.length?records.recordings.map(record=><article key={record.id} className="media-recording"><div><strong>{record.name||time(record.startTime)+' — '+time(record.endTime)}</strong><p>{[record.name?time(record.startTime)+' — '+time(record.endTime):'',duration(record.durationSeconds),size(record.bytes)].filter(Boolean).join(' · ')}</p>{record.encrypted&&<p className="media-warning">录像已加密，暂不兼容回放与保存。</p>}{Number(record.durationSeconds)>600&&<p>本次保存片段前 10 分钟。</p>}</div><div className="media-row-actions"><button className="primary-button" disabled={recordBusy||!!record.encrypted} onClick={()=>void play(record)}><Play size={13}/>回放</button><button className="media-button" disabled={captureBusy||!!record.encrypted||(Number.isFinite(record.durationSeconds)&&Number(record.durationSeconds)<1)} onClick={()=>camera&&void create('capture-start',{cameraId:camera.id,mode:'playback',source,date,recordId:record.id,kind:'video',durationSeconds:Math.min(600,Number.isFinite(record.durationSeconds)?Math.floor(Number(record.durationSeconds)):30)})}><Download size={13}/>保存到本机</button></div></article>):<p className="media-empty">{records?'这一天没有可显示的录像。':'选择日期，查询该摄像头的录像。'}</p>}</div>
   {records&&(records.offset>0||records.hasMore)&&<div className="media-pagination"><span>第 {records.offset+1}–{records.offset+records.recordings.length} 段 / 共 {records.total} 段</span><div><button className="media-button" disabled={recordBusy||records.offset===0} onClick={()=>void getRecords(Math.max(0,records.offset-PAGE))}>上一页</button><button className="media-button" disabled={recordBusy||!records.hasMore} onClick={()=>void getRecords(records.offset+PAGE)}>下一页</button></div></div>}
  </section>
  <section className="media-card" aria-labelledby="capture-title"><div className="media-heading"><div><span className="section-kicker">CAPTURE & ANALYZE</span><h2 id="capture-title">截图与本地录像</h2></div><span className="subtle-tag">保存在这台电脑</span></div><p className="media-description">按指定时长、帧率保存画面，供 MCP 和本机工具持续分析。任务由本地服务执行，关闭网页后仍会继续。</p>
   <div className="media-form"><label>采集时长 · 秒<input type="number" min="1" max="3600" step="1" value={seconds} onChange={event=>setSeconds(event.target.value)}/></label><label>截图帧率 · 帧/秒<input type="number" min="0.1" max="5" step="0.1" value={fps} onChange={event=>setFps(event.target.value)}/></label><label>截图最大宽度 · 像素<input type="number" min="320" max="1920" step="1" value={width} onChange={event=>setWidth(event.target.value)}/></label></div>
   <div className="media-actions"><button className="primary-button" disabled={!ready||captureBusy} onClick={()=>start('snapshot')}><Camera size={14}/>单张截图</button><button className="media-button" disabled={!ready||captureBusy} onClick={()=>start('frames')}><Images size={14}/>按帧率批量截图</button><button className="media-button" disabled={!ready||captureBusy} onClick={()=>start('video')}><Video size={14}/>录制本地视频</button></div><p className="media-hint">批量截图最多 3,600 秒、1,800 张。本地视频每次最多 600 秒，输出 15 帧/秒；截图帧率与宽度不改变摄像头设置。</p>{captureMessage&&<p className={'media-message '+(captureError?'error':'')} role="status" aria-live="polite">{captureMessage}</p>}
  </section>
  <section className="media-card" aria-labelledby="jobs-title"><div className="media-heading"><div><span className="section-kicker">LOCAL LIBRARY</span><h2 id="jobs-title">本地采集任务</h2></div><button className="media-button" disabled={!connected||jobsBusy} onClick={()=>void refreshJobs()}><RefreshCw size={13} className={jobsBusy?'spin':''}/>刷新任务</button></div>
   {root&&<div className="media-path"><FolderOpen size={14}/><span>保存目录</span><code>{root}</code><button className="media-button" onClick={()=>void copy(root)}>复制目录</button></div>}<p className="media-hint">完成的文件持续保留，供后续分析。仅在有运行中任务时每 5 秒刷新。</p>{jobMessage&&<p className={'media-message '+(jobError?'error':'')} role="status" aria-live="polite">{jobMessage}</p>}
   <div className="media-job-list" aria-busy={jobsBusy}>{jobs.length?jobs.map(job=><article className="media-job" key={job.id}><div><strong>{job.cameraName||'摄像头'} · {job.kind==='video'?'本地录像':'截图采集'}</strong><p>{[job.sourceInfo?.mode==='playback'?'历史录像':'实时采集',duration(job.durationSeconds),job.kind!=='video'?(job.frameCount||0)+' 张图片':'',job.startedAt?time(job.startedAt,true):''].filter(Boolean).join(' · ')}</p></div><span className={'media-job-state '+(Object.hasOwn(labels,job.status)?job.status:'')}>{labels[job.status]||'状态待确认'}</span><div className="media-row-actions"><button className="media-button" onClick={()=>void getJob(job.id,0)}>{selected?.id===job.id?'刷新详情':'查看文件'}</button>{job.status==='running'&&<button className="media-button" onClick={()=>void cancel(job.id)}>取消任务</button>}</div></article>):<p className="media-empty">{connected?'尚无采集任务，可先获取单张截图。':'连接账号后查看当前账号的本地任务。'}</p>}</div>
   {detail&&selected&&<section className="media-job-detail" aria-label="采集任务详情"><div className="media-detail-heading"><div><h3>{selected.cameraName||'摄像头'} · {selected.kind==='video'?'本地录像':'截图采集'}</h3><p>{labels[selected.status]||'状态待确认'} · {selected.sourceInfo?.mode==='playback'?'历史录像 '+(selected.sourceInfo.date||''):'实时采集'} · 任务 {selected.id}</p></div><button className="media-button" onClick={()=>{detailVersion.current++;detailRef.current=null;setDetail(null);setDetailBusy(false);}}>收起详情</button></div>
    {selected.directory&&<div className="media-path"><span>任务目录</span><code>{selected.directory}</code><button className="media-button" onClick={()=>void copy(selected.directory!)}>复制目录</button></div>}<a className="media-button media-manifest" href={'/api/captures/'+selected.id+'/manifest'} download={'capture-'+selected.id+'.json'}><Download size={13}/>下载任务清单 · JSON</a>{selected.error?.message&&<p className="media-message error">{selected.error.message}</p>}
    {videoUrl?<div className="media-video-file"><div><strong>视频已保存{selected.video?.bytes?' · '+size(selected.video.bytes):''}</strong>{selected.video?.path&&<code>{selected.video.path}</code>}</div><a className="media-button" href={videoUrl} download><Download size={13}/>下载 MP4</a>{selected.video?.path&&<button className="media-button" onClick={()=>void copy(selected.video!.path!)}>复制视频路径</button>}</div>:selected.kind==='video'&&<p className="media-hint">{selected.status==='running'?'录像完成后会显示 MP4 下载链接。':'本次任务暂无可下载的视频文件。'}</p>}
    {selected.kind!=='video'&&<><p className="media-hint">图片时间为本机任务开始时间加解码采样时间的近似值；历史录像拍摄时间请参见任务清单 sourceInfo。</p><div className="media-frame-grid">{frames.map((frame,index)=>{const url=artifactUrl(frame.url);return url?<figure className="media-frame" key={frame.sequence||index}><a className="media-frame-image" href={url} target="_blank" rel="noopener noreferrer"><img src={url} loading="lazy" alt={'截图 '+(frame.sequence||index+1)}/></a><figcaption><span>截图 {frame.sequence||index+1}{Number.isFinite(frame.relativeSeconds)?' · 第 '+Math.round(Number(frame.relativeSeconds)*10)/10+' 秒':''}</span>{frame.capturedAt&&<small>本机采集约 {time(frame.capturedAt,true)} 北京时间</small>}<div><a className="media-button" href={url} download>下载图片</a>{frame.path&&<button className="media-button" title={frame.path} onClick={()=>void copy(frame.path!)}>复制路径</button>}</div></figcaption></figure>:null;})}</div>{!frames.length&&<p className="media-hint">{selected.status==='running'?'正在采集，首张截图保存后会显示在这里。':'本次任务暂无已保存图片。'}</p>}</>}
    {(detail.offset>0||detail.hasMore)&&<div className="media-pagination"><span>第 {detail.offset+1}–{detail.offset+frames.length} 张 / 共 {detail.totalFrames} 张</span><div><button className="media-button" disabled={detailBusy||detail.offset===0} onClick={()=>void getJob(selected.id,Math.max(0,detail.offset-PAGE))}>上一页图片</button><button className="media-button" disabled={detailBusy||!detail.hasMore} onClick={()=>void getJob(selected.id,detail.offset+PAGE)}>下一页图片</button></div></div>}
   </section>}
  </section>
 </div>;
}
function RadioIcon(){return <Play size={13}/>;}
