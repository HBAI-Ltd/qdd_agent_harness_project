import {CloudError,TyslCloud} from '../lib/cloud.mjs';
import {AuthManager} from './auth.mjs';
import {StreamManager} from './streams.mjs';
import {CaptureManager} from './captures.mjs';
import {createHash} from 'node:crypto';
import {recordingDay,recordingRange,recordingDates,cloudRecordings,sdRecordings,cloudRecordingSource,sdRecordingSource} from '../lib/recordings.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const validId=id=>typeof id==='string'&&id.trim().length>0&&id.length<=256;
const maskPhone=value=>String(value||'').replace(/^(\d{3})\d{4}(\d{4})$/,'$1****$2');
const changed=()=>new CloudError('SESSION_CHANGED','账号或预览已切换，请重新操作',409);
const stopFailed=()=>new CloudError('PTZ_STOP_FAILED','未能确认云台停止，请点击“停止移动”重试');

// The optional second argument is for offline concurrency tests only.
export async function createRuntime({vault,pendingVault,ffmpeg,streamRoot,captureRoot,baseUrl},dependencies={}){
  const auth=dependencies.auth||new AuthManager({vault,pendingVault,baseUrl});await auth.init();
  const streams=dependencies.streams||new StreamManager({ffmpeg,root:streamRoot,baseUrl});
  const captures=dependencies.captures||(captureRoot?new CaptureManager({ffmpeg,root:captureRoot,baseUrl}):null);
  if(captures)await captures.init();
  const createCloud=dependencies.createCloud||(options=>new TyslCloud(options));
  const snapshotNow=dependencies.snapshotNow||Date.now,snapshotPause=dependencies.snapshotPause||pause;
  const active=new Map(),pendingStops=new Map(),capabilities=new Map();
  let devices=[],listWarnings=[],loadedAt=0,loading,state='ready',generation=0,accountRevision=0;
  let previewSequence=0,currentPreview,previewTail=Promise.resolve(),lifecycleTail=Promise.resolve(),captureTail=Promise.resolve();
  const recordCache=new Map();

  function accountKey(){
    const login=auth.login,role=login?.roleInfos?.[0];
    if(!login?.token||!role?.id)throw new CloudError('LOGIN_REQUIRED','请先连接天翼视联账号',401);
    return createHash('sha256').update(JSON.stringify([login.userId||'',role.id,role.roleId])).digest('hex');
  }
  function captureStore(){if(!captures)throw new CloudError('CAPTURE_UNAVAILABLE','当前运行环境未配置本地采集目录',503);return captures;}
  function page(args,max=200){
    const offset=args.offset??0,limit=args.limit??50;
    if(!Number.isSafeInteger(offset)||offset<0||offset>150000||!Number.isInteger(limit)||limit<1||limit>max)throw new CloudError('INVALID_PAGE','分页参数无效',400);
    return {offset,limit};
  }
  async function getRecords(args,context){
    const date=recordingDay(args.date),source=args.source??'cloud';
    if(!['cloud','sd'].includes(source))throw new CloudError('INVALID_SOURCE','请选择云录像或 SD 卡录像',400);
    await camera(args.cameraId,context);guard(context);
    const key=JSON.stringify([context,args.cameraId,date,source]),cached=recordCache.get(key);
    if(cached&&Date.now()-cached.loadedAt<30000)return cached.records;
    const client=await cloud(context),records=await(source==='cloud'?cloudRecordings(client,args.cameraId,date):sdRecordings(client,args.cameraId,date));guard(context);
    if(recordCache.size>=30)recordCache.delete(recordCache.keys().next().value);
    recordCache.set(key,{records,loadedAt:Date.now()});return records;
  }
  async function mediaSource(args,context){
    const item=await camera(args.cameraId,context);guard(context);
    const client=await cloud(context);guard(context);
    if((args.mode??'live')==='live'){
      if(args.quality!==undefined&&!['main','sub'].includes(args.quality))throw new CloudError('INVALID_QUALITY','画质参数无效',400);
      if(Number(item.onlineStatus)!==1)throw new CloudError('CAMERA_OFFLINE','摄像头当前离线',409);
      const caps=capabilities.get(args.cameraId)||await client.supported(args.cameraId);guard(context);capabilities.set(args.cameraId,caps);
      if(!caps?.liveProtocol?.includes(3))throw new CloudError('LIVE_UNAVAILABLE','摄像头未提供可采集的视频源',409);
      const source=await client.live(args.cameraId,args.quality==='sub'?0:1);guard(context);
      return {...source,item,sourceInfo:{mode:'live'}};
    }
    if(args.mode!=='playback'||!['cloud','sd'].includes(args.source??'cloud'))throw new CloudError('INVALID_SOURCE','采集来源无效',400);
    const source=args.source??'cloud';
    let record;
    if(args.recordId!==undefined){
      if(typeof args.recordId!=='string'||!args.recordId||args.recordId.length>1024)throw new CloudError('INVALID_RECORDING','录像片段标识无效',400);
      record=(await getRecords({...args,source},context)).find(value=>value.id===args.recordId);guard(context);
      if(!record)throw new CloudError('RECORDING_NOT_FOUND','录像不在该摄像头所选日期的片段列表中',404);
    }else if(source==='cloud')throw new CloudError('RECORDING_REQUIRED','云录像回放需要先选择片段',400);
    if(record?.encrypted)throw new CloudError('RECORDING_ENCRYPTED','该录像已加密，当前本地播放器尚不支持解密',409);
    const startTime=record?.startTime??args.startTime,endTime=record?.endTime??args.endTime;
    let durationSeconds=record?.durationSeconds;
    if(source==='sd')durationSeconds=recordingRange(startTime,endTime);
    const result=source==='cloud'?await cloudRecordingSource(client,args.cameraId,record.id):await sdRecordingSource(client,args.cameraId,startTime,endTime,record?.name);
    guard(context);
    return {...result,item,durationSeconds,sourceInfo:{mode:'playback',source,...(args.date?{date:args.date}:{}),...(startTime?{startTime}:{}),...(endTime?{endTime}:{}),...(record?{recordId:record.id}:{})}};
  }
  function captureArgs(args){
    const kind=args.kind??'frames',durationSeconds=args.durationSeconds??10,fps=args.fps??1,maxWidth=args.maxWidth??1280;
    if(!['frames','video'].includes(kind)||!Number.isInteger(durationSeconds)||durationSeconds<1||durationSeconds>(kind==='video'?600:3600)||typeof fps!=='number'||!Number.isFinite(fps)||fps<0.1||fps>5||!Number.isInteger(maxWidth)||maxWidth<320||maxWidth>1920||(kind==='frames'&&Math.ceil(durationSeconds*fps)>1800))throw new CloudError('INVALID_CAPTURE','采集参数超出范围：截图 1–3600 秒、0.1–5 帧/秒、最多1800帧；录像1–600秒；宽度320–1920',400);
    return {kind,durationSeconds,fps,maxWidth};
  }
  async function startCapture(args,snapshot=false){
    const context=generation;guard(context);const store=captureStore(),key=accountKey();
    const options=captureArgs(snapshot?{...args,kind:'frames',durationSeconds:1,fps:1}:args);
    const source=await mediaSource(args,context);guard(context);
    if(source.durationSeconds&&options.durationSeconds>source.durationSeconds)throw new CloudError('CAPTURE_RANGE','采集时长不能超过所选录像片段时长',400);
    const launch=captureTail.then(async()=>{
      guard(context);
      const job=await store.start({...options,cameraId:args.cameraId,cameraName:source.item.deviceName,sourceUrl:source.url,sourceInfo:source.sourceInfo,accountKey:key,...(snapshot?{frameLimit:1}:{})});
      try{guard(context);}catch(error){await store.cancel(job.id,{accountKey:key});throw error;}
      return job;
    });
    captureTail=launch.catch(()=>{});
    let job=await launch;guard(context);
    if(snapshot){
      const deadline=snapshotNow()+18000;
      while(job.status==='running'&&!(job.frames?.length)&&snapshotNow()<deadline){await snapshotPause(250);guard(context);job=await store.status(job.id,{accountKey:key});guard(context);}
      return {job,...(job.frames?.[0]?{frame:job.frames[0]}:{}),pending:job.status==='running'};
    }
    return {job};
  }
  async function captureStatus(args){
    const {offset,limit}=page(args,100),job=await captureStore().status(args.jobId,{accountKey:accountKey()});
    const totalFrames=job.frames?.length||0;
    return {job:{...job,frameCount:totalFrames,frames:job.frames?.slice(offset,offset+limit)||[]},offset,limit,totalFrames,hasMore:offset+limit<totalFrames,nextOffset:Math.min(offset+limit,totalFrames)};
  }

  function guard(context,allowBlocked=false){
    if(context!==generation)throw changed();
    if(!allowBlocked&&state!=='ready')throw new CloudError('SHUTTING_DOWN','本地服务正在切换账号或关闭',503);
  }
  async function cloud(context,allowBlocked=false){
    guard(context,allowBlocked);
    const login=await auth.ensureFresh();
    guard(context,allowBlocked);
    // A refresh can have awaited work belonging to an earlier login.
    if(login!==auth.login)throw changed();
    if(!login?.token)throw new CloudError('LOGIN_REQUIRED','请先连接天翼视联账号',401);
    const role=login.roleInfos?.[0];
    if(!role?.id||role.roleId===undefined)throw new CloudError('ROLE_INFO_MISSING','当前账号角色信息不完整，请重新连接',401);
    return createCloud({token:login.token,role});
  }
  async function list(force=false,context=generation){
    guard(context);
    if(!force&&Date.now()-loadedAt<15000)return devices;
    if(loading?.generation===context)return loading.promise;
    const entry={generation:context};
    entry.promise=(async()=>{
      const client=await cloud(context),fresh=await client.listDevices();guard(context);
      devices=fresh;listWarnings=client.listWarnings||[];loadedAt=Date.now();return fresh;
    })();
    loading=entry;
    try{return await entry.promise;}finally{if(loading===entry)loading=undefined;}
  }
  function publicCamera(item){
    const caps=capabilities.get(String(item.deviceCode));
    return {id:String(item.deviceCode),name:String(item.deviceName||'未命名摄像头'),online:Number(item.onlineStatus)===1,
      model:String(item.model||item.modelName||''),regionName:item._regionName||({B:'自有与分享',C:'来自级联'}[item.deviceScope]||''),
      ptzAvailable:caps?Array.isArray(caps.ptzProtocol)&&caps.ptzProtocol.includes(5):null};
  }
  async function camera(id,context){
    if(!validId(id))throw new CloudError('INVALID_CAMERA','请选择有效摄像头',400);
    let item=(await list(false,context)).find(d=>String(d.deviceCode)===id);guard(context);
    if(!item){item=(await list(true,context)).find(d=>String(d.deviceCode)===id);guard(context);}
    if(!item)throw new CloudError('CAMERA_NOT_FOUND','摄像头不在当前账号授权列表中',404);
    return item;
  }

  // A stop during start cannot confirm the final state; finally sends it again
  // after start settles. Unconfirmed stops remain available to stop-all/retry.
  function stopRecord(operation){
    operation.stopOutstanding=(operation.stopOutstanding||0)+1;
    pendingStops.set(operation.id,operation);
    let confirmed=false;
    const attempt=async()=>{
      for(let count=0;count<2;count++){
        try{
          if(operation.accountRevision!==accountRevision)throw changed();
          const client=await cloud(generation,true);
          if(operation.accountRevision!==accountRevision)throw changed();
          await client.move(operation.id,operation.direction,1,operation.speed);
          confirmed=true;
          return;
        }catch{}
      }
      throw stopFailed();
    };
    const result=(operation.stopTail||Promise.resolve()).then(attempt).finally(()=>{
      operation.stopOutstanding--;
      if(confirmed&&!operation.startInFlight&&operation.stopOutstanding===0&&pendingStops.get(operation.id)===operation)pendingStops.delete(operation.id);
    });
    operation.stopTail=result.catch(()=>{});return result;
  }
  async function stopOne(id){
    const operation=active.get(id);if(operation)operation.cancelled=true;
    const pending=pendingStops.get(id);
    // A cancelled preflight cannot send start, so it need not block on network.
    if(operation&&!operation.startSent)return;
    if(!pending){if(state==='ready')await camera(id,generation);return;}
    let error;
    try{await stopRecord(pending);}catch(value){error=value;}
    if(operation)await operation.done;
    if(pendingStops.get(id)===pending)throw error||stopFailed();
  }
  async function stop(id){
    if(id!==undefined){if(!validId(id))throw new CloudError('INVALID_CAMERA','摄像头标识无效',400);await stopOne(id);}
    else{
      const ids=new Set([...active.keys(),...pendingStops.keys()]);
      const results=await Promise.allSettled([...ids].map(stopOne));
      const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
    }
    return {ok:true};
  }
  async function ptz(args){
    const {cameraId:id,direction,durationMs=350,speed=2}=args;
    if(!validId(id)||!['up','down','left','right'].includes(direction)||!Number.isInteger(durationMs)||durationMs<200||durationMs>1000||!Number.isInteger(speed)||speed<1||speed>5)throw new CloudError('INVALID_PTZ','云台参数无效',400);
    const context=generation;guard(context);
    if(active.has(id)||pendingStops.has(id))throw new CloudError('PTZ_BUSY','请先确认该摄像头的上一条云台操作已停止',409);
    let resolveDone;
    const operation={id,direction,speed,accountRevision,cancelled:false,startSent:false,startInFlight:false,done:new Promise(resolve=>{resolveDone=resolve;})};
    active.set(id,operation); // Reserve before the first await, including preflight.
    const proceed=()=>{guard(context);return !operation.cancelled;};
    let failure;
    try{
      const item=await camera(id,context);
      if(!proceed())return {ok:true,stopped:true,cancelled:true};
      if(Number(item.onlineStatus)!==1)throw new CloudError('CAMERA_OFFLINE','摄像头当前离线',409);
      const client=await cloud(context);
      if(!proceed())return {ok:true,stopped:true,cancelled:true};
      const caps=capabilities.get(id)||await client.supported(id);
      if(!proceed())return {ok:true,stopped:true,cancelled:true};
      capabilities.set(id,caps);
      if(!Array.isArray(caps.ptzProtocol)||!caps.ptzProtocol.includes(5))throw new CloudError('PTZ_UNAVAILABLE','该摄像头没有提供云端云台控制',409);
      operation.startSent=true;operation.startInFlight=true;pendingStops.set(id,operation);
      try{await client.move(id,direction,0,speed);}finally{operation.startInFlight=false;}
      const until=Date.now()+durationMs;
      while(!operation.cancelled&&context===generation&&state==='ready'&&Date.now()<until)await pause(Math.min(25,until-Date.now()));
    }catch(error){failure=error;}
    finally{
      if(operation.startSent){try{await stopRecord(operation);}catch(error){failure=error;}}
      if(active.get(id)===operation)active.delete(id);
      resolveDone();
    }
    if(failure)throw failure;
    return {ok:true,stopped:true};
  }

  function queuePreview(work){const result=previewTail.then(work);previewTail=result.catch(()=>{});return result;}
  async function preview(args,playback=false){
    if(!validId(args.cameraId))throw new CloudError('INVALID_CAMERA','请选择有效摄像头',400);
    if(args.quality!==undefined&&!['main','sub'].includes(args.quality))throw new CloudError('INVALID_QUALITY','画质参数无效',400);
    const context=generation,sequence=++previewSequence;
    const check=()=>{guard(context);if(sequence!==previewSequence)throw changed();};
    const item=await camera(args.cameraId,context);check();
    const source=await mediaSource({...args,mode:playback?'playback':'live'},context);check();
    return queuePreview(async()=>{
      check();
      if(currentPreview&&currentPreview!==args.cameraId){await streams.close(currentPreview);currentPreview=undefined;check();}
      const result=await streams.start(args.cameraId,source.url,{finite:playback});
      // Retire a result superseded during readiness before another start.
      try{check();}catch(error){await streams.close(args.cameraId);if(currentPreview===args.cameraId)currentPreview=undefined;throw error;}
      currentPreview=args.cameraId;
      return {...result,mode:playback?'playback':'live',...(source.sourceInfo.mode==='playback'?{sourceInfo:source.sourceInfo}:{}),pageUrl:baseUrl+'/?'+new URLSearchParams({cameraId:args.cameraId,...(playback?{playback:'1',source:args.source??'cloud',date:args.date||String(args.startTime||'').slice(0,10),...(args.recordId?{recordId:args.recordId}:{startTime:args.startTime,endTime:args.endTime})}:{preview:'1',quality:args.quality==='sub'?'sub':'main'})})};
    });
  }
  function invalidate(){
    generation++;previewSequence++;devices=[];listWarnings=[];loadedAt=0;loading=undefined;capabilities.clear();recordCache.clear();
    for(const operation of active.values())operation.cancelled=true;
    return generation;
  }
  function queueLifecycle(work){const result=lifecycleTail.then(work);lifecycleTail=result.catch(()=>{});return result;}
  async function closeCaptures(dispose=false){
    let failure,disposal;
    // Signal shutdown before draining a start that may itself need disposal to settle.
    if(dispose&&captures){try{disposal=Promise.resolve(captures.dispose());disposal.catch(()=>{});}catch(error){failure=error;}}
    try{
      await captureTail;
      if(captures&&!dispose&&auth.login?.token&&auth.login?.roleInfos?.[0]?.id){
        const key=accountKey();
        for(const job of await captures.list({accountKey:key}))if(job.status==='running')await captures.cancel(job.id,{accountKey:key});
      }
    }catch(error){failure??=error;}
    try{await disposal;}catch(error){failure??=error;}
    if(failure)throw failure;
  }
  async function closePreviews(dispose=false){
    let failure;
    const captureResult=closeCaptures(dispose).then(()=>null,error=>error);
    // Interrupt a start already awaiting readiness before draining its queue.
    try{await streams.close();}catch(error){failure=error;}
    await previewTail;
    try{if(dispose)await streams.dispose();else await streams.close();}catch(error){failure=error;}
    currentPreview=undefined;
    const captureFailure=await captureResult;failure??=captureFailure;
    if(failure)throw failure;
  }
  const runtime={auth,streams,captures,
    async captureFile(id,name){const context=generation;guard(context);const key=accountKey(),file=await captureStore().getFile(id,name,{accountKey:key});guard(context);return file;},
    async captureManifest(id){const context=generation;guard(context);const key=accountKey(),job=await captureStore().status(id,{accountKey:key});guard(context);return job;},
    async status(){
      const login=auth.login;
      return {local:true,connected:!!login?.token,phoneMasked:maskPhone(login?.phone),roleName:String(login?.roleInfos?.[0]?.roleName||''),cameraCount:devices.length,consoleUrl:baseUrl};
    },
    acceptLogin(login){
      if(state!=='ready')return Promise.reject(new CloudError('SESSION_BUSY','本地服务正在切换账号或关闭',409));
      state='switching';const context=invalidate();
      return queueLifecycle(async()=>{
        try{
          let failure;
          try{await stop();}catch(error){failure=error;}
          try{await closePreviews();}catch(error){failure??=error;}
          if(failure)throw failure;
          if(context!==generation||state!=='switching')throw changed();
          await auth.accept(login);accountRevision++;
        }finally{if(context===generation&&state==='switching')state='ready';}
      });
    },
    async action(action,args={}){
      if(args===null||typeof args!=='object'||Array.isArray(args))throw new CloudError('INVALID_BODY','请求格式无效',400);
      if(action==='status')return runtime.status();
      if(action==='stop')return stop(args.cameraId);
      const context=generation;guard(context);
      const result=await(async()=>{
      if(action==='list')return {cameras:(await list(true,generation)).map(publicCamera),...(listWarnings.length?{warnings:listWarnings}:{})};
      if(action==='login-start'){const context=generation,result=await auth.begin();guard(context);return result;}
      if(action==='ptz')return ptz(args);
      if(action==='preview')return preview(args);
      if(action==='playback')return preview(args,true);
      if(action==='capabilities'){
        const context=generation;await camera(args.cameraId,context);const client=await cloud(context),caps=await client.supported(args.cameraId);guard(context);capabilities.set(args.cameraId,caps);
        return {cameraId:args.cameraId,live:{available:caps.liveProtocol?.includes(3)===true},ptz:{available:caps.ptzProtocol?.includes(5)===true},sdPlayback:{available:caps.sdCardVideoProtocol?.includes(3)===true},cloudRecording:{queryAvailable:true},rawProtocols:{live:caps.liveProtocol||[],ptz:caps.ptzProtocol||[],sd:caps.sdCardVideoProtocol||[]}};
      }
      if(action==='recording-dates'){const context=generation;await camera(args.cameraId,context);const client=await cloud(context),dates=await recordingDates(client,args.cameraId);guard(context);return {source:'cloud',dates,timeZone:'Asia/Shanghai'};}
      if(action==='recordings'){
        const {offset,limit}=page(args),records=await getRecords(args,generation);
        return {cameraId:args.cameraId,date:args.date,source:args.source??'cloud',timeZone:'Asia/Shanghai',recordings:records.slice(offset,offset+limit),total:records.length,offset,limit,hasMore:offset+limit<records.length};
      }
      if(action==='capture-start')return startCapture(args);
      if(action==='snapshot')return startCapture({...args,mode:'live'},true);
      if(action==='capture-status')return captureStatus(args);
      if(action==='capture-list'){const jobs=await captureStore().list({accountKey:accountKey()});return {jobs:args.cameraId?jobs.filter(job=>job.cameraId===args.cameraId):jobs,root:captures.root};}
      if(action==='capture-cancel')return {job:await captureStore().cancel(args.jobId,{accountKey:accountKey()})};
      throw new CloudError('INVALID_ACTION','未知操作',400);
      })();
      // Disk-backed capture reads and every other async action belong to the
      // account that issued them, even when its result arrives after a switch.
      guard(context);return result;
    },
    dispose(){
      state='closing';invalidate();
      return queueLifecycle(async()=>{
        let failure;
        try{await stop();}catch(error){failure=error;}
        // Process cleanup is unconditional even when cloud stop failed.
        try{await closePreviews(true);}catch(error){failure??=error;}
        state='closed';if(failure)throw failure;
      });
    }
  };
  return runtime;
}
