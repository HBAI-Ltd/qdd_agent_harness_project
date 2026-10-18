import {createMediaSpawn} from './media.mjs';
import {createHash, randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, lstat, realpath, readdir, readFile, open, rename, unlink, statfs} from 'node:fs/promises';
import path from 'node:path';
import {CloudError} from '../lib/hik-cloud.mjs';

const ID = /^[a-f0-9]{32}$/;
const FRAME = /^frame_([0-9]{6})\.jpg$/;
const TERMINAL = new Set(['done','failed','cancelled','interrupted']);
const MiB = 1024 * 1024;
const TIME_BASIS = 'capturedAt 约为本次任务开始墙钟时间加解码后采样相对时间，不代表摄像头精确拍摄时间；回放的历史录像时间需另看 sourceInfo。';
const messages = {
  CAPTURE_FAILED:'采集进程未正常完成，已保存的文件仍可查看',
  CAPTURE_EMPTY:'未取得可保存的画面，请确认设备在线后重试',
  CAPTURE_TIMEOUT:'采集超时，已停止任务并保留已保存文件',
  CAPTURE_QUOTA:'本地采集存储接近配额，已停止任务并保留文件',
  CAPTURE_DISK_SPACE:'磁盘剩余空间不足，已停止任务并保留文件',
  CAPTURE_INTERRUPTED:'本地服务重启前任务未完成，已保留现有文件',
  CAPTURE_STORAGE_FAILED:'无法保存采集结果，请检查本地磁盘与目录权限'
};
const fail = (code,message,status=400) => new CloudError(code,message,status);
const storageError = () => fail('CAPTURE_STORAGE_FAILED',messages.CAPTURE_STORAGE_FAILED,500);
const missing = () => fail('CAPTURE_NOT_FOUND','当前账号没有此采集任务或文件',404);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = value => new Date(value).toISOString();
const waitFor = (promise,ms) => new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),ms);promise.then(()=>{clearTimeout(timer);resolve(true);},()=>{clearTimeout(timer);resolve(true);});});

function owner(key) {
  if(typeof key!=='string'||!key||key.length>256||/[\u0000-\u0020\u007f]/.test(key))throw fail('CAPTURE_ACCOUNT_INVALID','采集任务缺少有效账号标识');
  return createHash('sha256').update(key).digest('hex');
}
function sourceInfo(value) {
  if(value===undefined)return null;
  if(!object(value)||Object.keys(value).some(key=>!['mode','source','date','startTime','endTime','recordId'].includes(key))||!['live','playback'].includes(value.mode)||(value.source!==undefined&&!['cloud','sd'].includes(value.source))||(value.mode==='playback'&&value.source===undefined))throw fail('CAPTURE_SOURCE_INFO_INVALID','采集来源信息无效');
  const result={mode:value.mode,...(value.source!==undefined?{source:value.source}:{})};
  const validDate=date=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T00:00:00Z'))&&iso(Date.parse(date+'T00:00:00Z')).slice(0,10)===date;
  if(value.date!==undefined){
    if(!validDate(value.date))throw fail('CAPTURE_SOURCE_INFO_INVALID','录像日期必须是有效的 YYYY-MM-DD');
    result.date=value.date;
  }
  for(const key of ['startTime','endTime'])if(value[key]!==undefined){
    const time=value[key];
    if(typeof time!=='string'||time.length>40||!(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)||validDate(time.slice(0,10))&&(/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)||/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(time)&&Number.isFinite(Date.parse(time)))))throw fail('CAPTURE_SOURCE_INFO_INVALID','录像起止时间必须是北京时间 YYYY-MM-DD HH:mm:ss、HH:mm:ss 或带时区的 ISO 8601 文本');
    result[key]=time;
  }
  if(value.recordId!==undefined){if(typeof value.recordId!=='string'||!/^[A-Za-z0-9_.:+/=~-]{1,1024}$/.test(value.recordId)||value.recordId.includes('://'))throw fail('CAPTURE_SOURCE_INFO_INVALID','录像记录标识无效');result.recordId=value.recordId;}
  return result;
}
function parameters(value) {
  if(!object(value)||Object.keys(value).some(key=>!['cameraId','cameraName','sourceUrl','durationSeconds','fps','maxWidth','kind','frameLimit','accountKey','sourceInfo','sourceFormat'].includes(key)))throw fail('CAPTURE_ARGS_INVALID','采集参数无效');
  const {cameraId,sourceUrl,durationSeconds,kind='frames',fps=1,maxWidth=1280,frameLimit}=value;
  if(value.sourceFormat!==undefined&&!['flv','hls','mp4','rtsp'].includes(value.sourceFormat))throw fail('CAPTURE_SOURCE_INVALID','视频源格式不受支持');
  if(typeof cameraId!=='string'||!cameraId.trim()||cameraId.length>256||/[\u0000-\u001f\u007f]/.test(cameraId))throw fail('CAPTURE_CAMERA_INVALID','请选择有效摄像头');
  if(value.cameraName!==undefined&&(typeof value.cameraName!=='string'||value.cameraName.length>200||/[\u0000-\u001f\u007f]/.test(value.cameraName)))throw fail('CAPTURE_ARGS_INVALID','摄像头名称无效');
  if(!['frames','video'].includes(kind)||!Number.isInteger(durationSeconds)||durationSeconds<1||durationSeconds>(kind==='frames'?3600:600))throw fail('CAPTURE_DURATION_INVALID','截图时长须为 1–3600 秒整数，录像时长须为 1–600 秒整数');
  if(!Number.isFinite(fps)||fps<0.1||fps>5)throw fail('CAPTURE_FPS_INVALID','截图帧率须为每秒 0.1–5 帧');
  if(!Number.isInteger(maxWidth)||maxWidth<320||maxWidth>1920)throw fail('CAPTURE_WIDTH_INVALID','输出最大宽度须为 320–1920 像素整数');
  const expected=Math.ceil(durationSeconds*fps);
  if(frameLimit!==undefined&&(!Number.isInteger(frameLimit)||frameLimit<1||frameLimit>1800||frameLimit>expected||kind!=='frames'))throw fail('CAPTURE_FRAME_LIMIT','单次最多保存 1800 帧，frameLimit 不能超过按时长与帧率计算的帧数');
  const limit=frameLimit??expected;
  if(kind==='frames'&&limit>1800)throw fail('CAPTURE_FRAME_LIMIT','单次最多保存 1800 帧，请降低帧率、时长或指定 frameLimit');
  let url;
  try{url=new URL(sourceUrl);}catch{throw fail('CAPTURE_SOURCE_INVALID','运行时未提供有效的授权视频源');}
  if(typeof sourceUrl!=='string'||sourceUrl.length>16384||/[\u0000-\u0020\u007f]/.test(sourceUrl)||!['rtsp:','rtsps:','http:','https:'].includes(url.protocol)||!url.hostname)throw fail('CAPTURE_SOURCE_INVALID','仅支持运行时提供的授权网络视频源');
  const inputFormat=value.sourceFormat??(/\.m3u8$/i.test(url.pathname)?'hls':/\.mp4$/i.test(url.pathname)?'mp4':['http:','https:'].includes(url.protocol)?'flv':'rtsp');
  return {cameraId,cameraName:value.cameraName||cameraId,sourceUrl,protocol:url.protocol,durationSeconds,kind,fps,maxWidth,frameLimit:kind==='frames'?limit:null,ownerHash:owner(value.accountKey),sourceInfo:sourceInfo(value.sourceInfo),inputFormat};
}

/** Internal runtime API: sourceUrl must come from the current account's authorized live/playback API. */
export class CaptureManager {
  constructor({root,ffmpeg,baseUrl,quotaBytes=2*1024*MiB,maxJobs=200}, dependencies={}) {
    if(typeof root!=='string'||!path.isAbsolute(root)||typeof ffmpeg!=='string'||!path.isAbsolute(ffmpeg))throw new TypeError('Capture root and ffmpeg must be absolute paths');
    const base=new URL(baseUrl);
    if(!['http:','https:'].includes(base.protocol)||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new TypeError('Capture baseUrl must be a loopback origin');
    if(!Number.isSafeInteger(quotaBytes)||quotaBytes<32*MiB||!Number.isInteger(maxJobs)||maxJobs<1||maxJobs>200)throw new TypeError('Invalid capture storage limits');
    this.root=path.resolve(root);this.ffmpeg=ffmpeg;this.baseUrl=base.origin;this.quotaBytes=quotaBytes;this.maxJobs=maxJobs;
    this.spawn=dependencies.spawn||createMediaSpawn(dependencies.transport);this.now=dependencies.now||Date.now;this.statfs=dependencies.statfs||statfs;
    this.jobs=new Map();this.running=null;this.tail=Promise.resolve();this.initializing=null;this.initialized=false;this.disposed=false;
  }
  _queue(work){const result=this.tail.then(work);this.tail=result.catch(()=>{});return result;}
  async _ancestors(directory,allowMissing=false){
    const full=path.resolve(directory),anchor=path.parse(full).root;
    let current=anchor;
    for(const segment of path.relative(anchor,full).split(path.sep).filter(Boolean)){
      current=path.join(current,segment);
      let info;try{info=await lstat(current);}catch(error){if(allowMissing&&error.code==='ENOENT')return;throw storageError();}
      if(info.isSymbolicLink()||!info.isDirectory())throw storageError();
    }
  }
  async _root(){
    await this._ancestors(this.root);
    const actual=await realpath(this.root);
    if(this.rootReal&&actual!==this.rootReal)throw storageError();
    this.rootReal=actual;
    return actual;
  }
  _path(id,name){
    if(!ID.test(id)||name!==undefined&&!(FRAME.test(name)||name==='recording.mp4'||name==='manifest.json'||/^manifest\.[a-f0-9]{16}\.tmp$/.test(name)))throw missing();
    const result=path.resolve(this.root,id,...(name?[name]:[])),relative=path.relative(this.root,result);
    if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw missing();
    return result;
  }
  async _directory(id){
    await this._root();const directory=this._path(id);
    const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==path.join(this.rootReal,id))throw storageError();
    return directory;
  }
  async _file(job,name){
    await this._directory(job.id);const file=this._path(job.id,name),info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||await realpath(file)!==path.join(this.rootReal,job.id,name))throw storageError();
    return {file,info};
  }
  async _persist(job){
    await this._directory(job.id);
    const temporary=this._path(job.id,'manifest.'+randomBytes(8).toString('hex')+'.tmp');
    // Explicit fields prevent source URLs, child-process objects or credentials from reaching disk.
    const manifest={version:1,id:job.id,ownerHash:job.ownerHash,cameraId:job.cameraId,cameraName:job.cameraName,kind:job.kind,status:job.status,
      durationSeconds:job.durationSeconds,fps:job.fps,maxWidth:job.maxWidth,frameLimit:job.frameLimit,startedAt:job.startedAt,endedAt:job.endedAt,
      approximateTime:true,timeBasis:TIME_BASIS,sourceInfo:job.sourceInfo,outputFps:job.kind==='video'?15:job.fps,error:job.error||null,frames:job.frames,video:job.video||null};
    let handle;
    try{
      handle=await open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(manifest,null,2),'utf8');await handle.close();handle=null;
      await this._directory(job.id);await rename(temporary,this._path(job.id,'manifest.json'));
    }catch{throw storageError();}finally{await handle?.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
  }
  async _usage(directory=this.root,depth=0){
    if(depth===0)await this._root();let bytes=0;
    for(const item of await readdir(directory,{withFileTypes:true})){
      const name=path.join(directory,item.name),info=await lstat(name);
      if(info.isSymbolicLink())throw storageError();
      if(info.isDirectory()){
        if(depth>=1)throw storageError();
        bytes+=await this._usage(name,depth+1);
      }else if(info.isFile())bytes+=info.size;
      else throw storageError();
    }
    return bytes;
  }
  async init(){
    if(this.initialized)return this;if(this.initializing)return this.initializing;
    this.initializing=(async()=>{
      try{
        await this._ancestors(this.root,true);await mkdir(this.root,{recursive:true,mode:0o700});await this._root();
        const entries=await readdir(this.root,{withFileTypes:true});
        if(entries.filter(entry=>entry.isDirectory()).length>this.maxJobs)throw fail('CAPTURE_JOB_LIMIT','采集任务数量已达到上限，请先手动整理本地文件',409);
        for(const entry of entries){
          if(entry.isSymbolicLink())throw storageError();
          if(!entry.isDirectory()||!ID.test(entry.name))continue;
          let data;
          try{await this._directory(entry.name);const {file,info}=await this._file({id:entry.name},'manifest.json');if(info.size>4*MiB)continue;data=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error?.code==='CAPTURE_STORAGE_FAILED')throw error;continue;}
          const job=this._restore(entry.name,data);if(!job)continue;
          this.jobs.set(job.id,job);
          if(job.status==='running'){
            job.status='interrupted';job.endedAt=iso(this.now());job.error={code:'CAPTURE_INTERRUPTED',message:messages.CAPTURE_INTERRUPTED};
            await this._scan(job,true);await this._persist(job);
          }
        }
        this.initialized=true;return this;
      }catch(error){if(error instanceof CloudError)throw error;throw storageError();}
    })();
    try{return await this.initializing;}finally{this.initializing=null;}
  }
  _restore(id,value){
    if(!object(value)||value.version!==1||value.id!==id||!/^[a-f0-9]{64}$/.test(value.ownerHash)||!['running',...TERMINAL].includes(value.status)||!['frames','video'].includes(value.kind)||typeof value.cameraId!=='string'||!value.cameraId||value.cameraId.length>256||typeof value.cameraName!=='string'||value.cameraName.length>200||!Number.isFinite(Date.parse(value.startedAt)))return null;
    const {durationSeconds,fps,maxWidth,frameLimit}=value;
    if(!Number.isInteger(durationSeconds)||durationSeconds<1||durationSeconds>(value.kind==='video'?600:3600)||!Number.isFinite(fps)||fps<0.1||fps>5||!Number.isInteger(maxWidth)||maxWidth<320||maxWidth>1920||value.kind==='frames'&&(!Number.isInteger(frameLimit)||frameLimit<1||frameLimit>1800))return null;
    let restoredSourceInfo;try{restoredSourceInfo=sourceInfo(value.sourceInfo===null?undefined:value.sourceInfo);}catch{return null;}
    const job={id,ownerHash:value.ownerHash,cameraId:value.cameraId,cameraName:value.cameraName,kind:value.kind,status:value.status,durationSeconds,fps,maxWidth,frameLimit,sourceInfo:restoredSourceInfo,
      startedAt:iso(Date.parse(value.startedAt)),endedAt:Number.isFinite(Date.parse(value.endedAt))?iso(Date.parse(value.endedAt)):null,frames:[],video:null,error:null};
    if(object(value.error)&&Object.hasOwn(messages,value.error.code))job.error={code:value.error.code,message:messages[value.error.code]};
    const seen=new Set();
    if(job.kind==='frames'&&Array.isArray(value.frames))for(const frame of value.frames.slice(0,1800)){
      if(!object(frame)||typeof frame.filename!=='string'||!FRAME.test(frame.filename)||!/^[a-f0-9]{64}$/.test(frame.sha256)||!Number.isSafeInteger(frame.bytes)||frame.bytes<1)continue;
      const sequence=Number(FRAME.exec(frame.filename)[1]);if(sequence<1||sequence>frameLimit||seen.has(sequence))continue;
      seen.add(sequence);job.frames.push(this._artifact(job,frame.filename,frame.sha256,frame.bytes));
    }
    job.frames.sort((a,b)=>a.sequence-b.sequence);
    if(job.kind==='video'&&object(value.video)&&value.video.filename==='recording.mp4'&&/^[a-f0-9]{64}$/.test(value.video.sha256)&&Number.isSafeInteger(value.video.bytes)&&value.video.bytes>0)job.video=this._artifact(job,'recording.mp4',value.video.sha256,value.video.bytes);
    return job;
  }
  _artifact(job,filename,sha256,bytes){
    const sequence=FRAME.test(filename)?Number(FRAME.exec(filename)[1]):0,relativeSeconds=sequence?(sequence-1)/job.fps:0;
    return {filename,...(sequence?{sequence}:{}),relativeSeconds,capturedAt:iso(Date.parse(job.startedAt)+relativeSeconds*1000),approximateTime:true,
      path:this._path(job.id,filename),url:this.baseUrl+'/captures/'+job.id+'/'+filename,sha256,bytes};
  }
  async _hash(job,name){
    const {file,info}=await this._file(job,name);
    if(info.size<1||info.size>this.quotaBytes)return null;
    let handle;
    try{
      handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const current=await handle.stat();
      if(!current.isFile()||current.ino!==info.ino||current.dev!==info.dev||current.size!==info.size)throw storageError();
      const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
      const after=await handle.stat();if(after.size!==info.size||after.mtimeMs!==info.mtimeMs)return null;
      return this._artifact(job,name,hash.digest('hex'),info.size);
    }finally{await handle?.close().catch(()=>{});}
  }
  async _scan(job,closed=false){
    await this._directory(job.id);let changed=false;
    if(job.kind==='frames'){
      const known=new Set(job.frames.map(frame=>frame.filename));
      for(const name of (await readdir(this._path(job.id))).sort()){
        const match=FRAME.exec(name);if(!match||known.has(name)||Number(match[1])<1||Number(match[1])>job.frameLimit)continue;
        const artifact=await this._hash(job,name);if(artifact){job.frames.push(artifact);known.add(name);changed=true;}
      }
      job.frames.sort((a,b)=>a.sequence-b.sequence);
    }else if(closed&&!job.video){
      try{const artifact=await this._hash(job,'recording.mp4');if(artifact&&artifact.bytes>=128){job.video=artifact;changed=true;}}catch(error){if(error?.code!=='ENOENT')throw error;}
    }
    return changed;
  }
  _public(job,summary=false){
    return {id:job.id,cameraId:job.cameraId,cameraName:job.cameraName,kind:job.kind,status:job.status,durationSeconds:job.durationSeconds,fps:job.fps,maxWidth:job.maxWidth,frameLimit:job.frameLimit,
      startedAt:job.startedAt,endedAt:job.endedAt,approximateTime:true,timeBasis:TIME_BASIS,frameCount:job.frames.length,
      ...(summary?{lastFrame:job.frames.at(-1)||null}:{frames:job.frames.map(frame=>({...frame}))}),video:job.video?{...job.video}:null,error:job.error?{...job.error}:null,
      directory:this._path(job.id),partial:job.status!=='done',outputFps:job.kind==='video'?15:job.fps,sourceInfo:job.sourceInfo?{...job.sourceInfo}:null};
  }
  _owned(id,key){if(typeof id!=='string'||!ID.test(id))throw missing();const job=this.jobs.get(id);if(!job||job.ownerHash!==owner(key))throw missing();return job;}
  async start(input){
    const params=parameters(input);await this.init();
    return this._queue(async()=>{
      if(this.disposed)throw fail('CAPTURE_CLOSED','采集管理器已关闭',409);
      if(this.running)throw fail('CAPTURE_BUSY','已有采集任务正在运行，请等待或取消后再开始',409);
      const directories=(await readdir(this.root,{withFileTypes:true})).filter(entry=>entry.isDirectory()).length;
      if(directories>=this.maxJobs)throw fail('CAPTURE_JOB_LIMIT','采集任务数量已达到上限，请先手动整理本地文件',409);
      const used=await this._usage(),reserve=16*MiB,estimate=params.kind==='frames'?params.frameLimit*MiB:Math.ceil(params.durationSeconds*300000)+2*MiB;
      if(used+estimate+reserve>this.quotaBytes)throw fail('CAPTURE_QUOTA','本地采集配额不足，请先手动整理文件或减少采集量',409);
      let space;try{space=await this.statfs(this.root);}catch{throw storageError();}
      const available=Number(space.bavail)*Number(space.bsize);
      if(!Number.isFinite(available))throw storageError();
      if(available<estimate+reserve)throw fail('CAPTURE_DISK_SPACE','磁盘可用空间不足，请先整理文件或减少采集量',409);
      const id=randomBytes(16).toString('hex'),job={id,...params,sourceUrl:undefined,protocol:undefined,status:'running',startedAt:iso(this.now()),endedAt:null,frames:[],video:null,error:null,child:null,exited:false,desiredStatus:null,baseBytes:used};
      delete job.sourceUrl;delete job.protocol;
      await mkdir(this._path(id),{mode:0o700});await this._persist(job);
      job.done=new Promise(resolve=>{job.resolveDone=resolve;});
      this.jobs.set(id,job);this.running=job;
      const args=this._arguments(job,params.sourceUrl,params.protocol);
      const close=(code)=>{if(job.exited)return;job.exited=true;job.child=null;clearTimeout(job.killTimer);clearTimeout(job.wallTimer);clearInterval(job.monitor);this._queue(()=>this._finish(job,code)).catch(()=>{job.status='failed';job.error={code:'CAPTURE_STORAGE_FAILED',message:messages.CAPTURE_STORAGE_FAILED};job.endedAt=iso(this.now());if(this.running===job)this.running=null;job.resolveDone();});};
      try{
        job.child=this.spawn(this.ffmpeg,args,{windowsHide:true,shell:false,stdio:'ignore'});
        job.child.once('error',()=>close(null));job.child.once('close',code=>close(code));
      }catch{close(null);}
      if(!job.exited){
        job.wallTimer=setTimeout(()=>this._queue(()=>this._stop(job,'failed','CAPTURE_TIMEOUT')).catch(()=>{}),(job.durationSeconds+30)*1000);job.wallTimer.unref?.();
        job.monitor=setInterval(()=>this._queue(async()=>{
          if(job.exited)return;
          try{
            const changed=await this._scan(job);if(changed)await this._persist(job);
            const bytes=await this._usage(this._path(job.id),1);
            if(job.baseBytes+bytes+16*MiB>this.quotaBytes)await this._stop(job,'failed','CAPTURE_QUOTA');
            const free=await this.statfs(this.root);
            if(Number(free.bavail)*Number(free.bsize)<16*MiB)await this._stop(job,'failed','CAPTURE_DISK_SPACE');
          }catch{await this._stop(job,'failed','CAPTURE_STORAGE_FAILED');}
        }).catch(()=>{}),1000);job.monitor.unref?.();
      }
      return this._public(job);
    });
  }
  _arguments(job,sourceUrl,protocol){
    const args=['-hide_banner','-loglevel','error','-nostdin','-y','-protocol_whitelist','rtsp,rtsps,tcp,tls,http,https,udp,rtp,crypto'];
    if(protocol==='rtsp:'||protocol==='rtsps:')args.push('-rtsp_transport','tcp');
    if(job.inputFormat&&job.inputFormat!=='rtsp')args.push('-f',job.inputFormat==='mp4'?'mov':job.inputFormat);
    args.push('-i',sourceUrl,'-map','0:v:0','-an','-sn','-dn','-t',String(job.durationSeconds));
    const scale=`scale=w='trunc(min(${job.maxWidth},iw)/2)*2':h=-2`;
    if(job.kind==='frames')args.push('-vf',`setpts=PTS-STARTPTS,fps=${job.fps}:start_time=0,${scale}`,'-frames:v',String(job.frameLimit),'-c:v','mjpeg','-q:v','3','-f','image2','-atomic_writing','1',path.join(this._path(job.id),'frame_%06d.jpg'));
    else args.push('-vf','setpts=PTS-STARTPTS,'+scale,'-r','15','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-crf','25','-maxrate','2000k','-bufsize','4000k','-g','30','-movflags','+frag_keyframe+empty_moov+default_base_moof','-f','mp4',this._path(job.id,'recording.mp4'));
    return args;
  }
  async _finish(job,code){
    try{
      await this._scan(job,true);
      job.status=job.desiredStatus||(code===0?'done':'failed');job.endedAt=iso(this.now());
      if(job.status==='done'&&!(job.frames.length||job.video)){job.status='failed';job.error={code:'CAPTURE_EMPTY',message:messages.CAPTURE_EMPTY};}
      else if(job.status==='failed'&&!job.error)job.error={code:'CAPTURE_FAILED',message:messages.CAPTURE_FAILED};
      await this._persist(job);
    }catch{
      job.status='failed';job.endedAt=iso(this.now());job.error={code:'CAPTURE_STORAGE_FAILED',message:messages.CAPTURE_STORAGE_FAILED};
      await this._persist(job).catch(()=>{});
    }finally{if(this.running===job)this.running=null;job.resolveDone();}
  }
  async _stop(job,status='cancelled',code){
    if(job.exited||TERMINAL.has(job.status))return;
    if(!job.desiredStatus){job.desiredStatus=status;if(code)job.error={code,message:messages[code]};}
    try{job.child?.kill('SIGTERM');}catch{}
    if(!job.killTimer){job.killTimer=setTimeout(()=>{if(!job.exited)try{job.child?.kill('SIGKILL');}catch{}},1500);job.killTimer.unref?.();}
  }
  async status(id,{accountKey}={}){
    await this.init();return this._queue(async()=>{const job=this._owned(id,accountKey);if(job.status==='running'&&!job.exited&&await this._scan(job))await this._persist(job);return this._public(job);});
  }
  async list({accountKey}={}){
    const hash=owner(accountKey);await this.init();return this._queue(async()=>{
      if(this.running?.ownerHash===hash&&!this.running.exited&&await this._scan(this.running))await this._persist(this.running);
      return [...this.jobs.values()].filter(job=>job.ownerHash===hash).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).map(job=>this._public(job,true));
    });
  }
  async cancel(id,{accountKey}={}){
    await this.init();const job=await this._queue(async()=>{const job=this._owned(id,accountKey);await this._stop(job);return job;});
    if(!TERMINAL.has(job.status)){
      await waitFor(job.done,5000);
      if(!TERMINAL.has(job.status))throw fail('CAPTURE_STOP_FAILED','尚未确认采集进程退出，请稍后重试',503);
    }
    return this.status(id,{accountKey});
  }
  async getFile(id,filename,{accountKey}={}){
    await this.init();return this._queue(async()=>{
      const job=this._owned(id,accountKey);
      if(typeof filename!=='string'||!(FRAME.test(filename)||filename==='recording.mp4'))throw missing();
      const artifact=job.frames.find(frame=>frame.filename===filename)||(job.video?.filename===filename?job.video:null);
      if(!artifact)throw missing();
      try{const actual=await this._hash(job,filename);if(!actual||actual.bytes!==artifact.bytes||actual.sha256!==artifact.sha256)throw missing();return {path:actual.path,mime:filename.endsWith('.jpg')?'image/jpeg':'video/mp4'};}catch(error){if(error instanceof CloudError)throw error;throw missing();}
    });
  }
  async dispose(){
    this.disposed=true;await this.init();const job=await this._queue(async()=>{const job=this.running;if(job)await this._stop(job);return job;});
    if(job&&!job.exited){await waitFor(job.done,5000);if(!job.exited)throw fail('CAPTURE_STOP_FAILED','尚未确认采集进程退出，请稍后重试',503);}
    await this.tail;
  }
}
