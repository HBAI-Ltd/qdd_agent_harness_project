import {HikCloud,CloudError} from '../lib/hik-cloud.mjs';
import {readVault,writeVault} from './vault.mjs';
import {createHash} from 'node:crypto';
import {validateAction} from '../lib/camera-actions.mjs';
import {CaptureManager} from './captures.mjs';
import {StreamManager} from './streams.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const validId=id=>typeof id==='string'&&id.trim()&&id.length<=256;
const changed=()=>new CloudError('SESSION_CHANGED','账号或媒体任务已切换，请重新操作',409);
const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const terminal=status=>['done','failed','cancelled','interrupted'].includes(status);

export async function createRuntime(vaultPath,dependencies={}){
  const read=dependencies.readVault||readVault,write=dependencies.writeVault||writeVault,now=dependencies.now||Date.now;
  const makeCloud=dependencies.createCloud||((session,config,ptzState)=>new HikCloud(session,config,fetch,ptzState));
  let state;
  try{state=await read(vaultPath);}catch(error){
    // A new installation may expose the local console and MCP before cloud setup.
    // Decryption, permissions and malformed existing vault failures remain fatal.
    if(error.code!=='ENOENT')throw error;
    state={session:{headers:{}},config:{}};
  }
  let nextSms=0,saving=Promise.resolve(),loginBusy=false,phase='ready',generation=0;
  let cameras=[],loadedAt=0,loading,previewSequence=0,currentPreview,previewTail=Promise.resolve(),captureTail=Promise.resolve(),lifecycleTail=Promise.resolve();
  const leases=new Map(),ptzState=new Map(),captureOwners=new Map(),media=dependencies.mediaOptions||{};
  const captures=dependencies.captures||(media.captureRoot?new CaptureManager({root:media.captureRoot,ffmpeg:media.ffmpeg,baseUrl:media.baseUrl}):null);
  const streams=dependencies.streams||(media.streamRoot?new StreamManager({root:media.streamRoot,ffmpeg:media.ffmpeg,baseUrl:media.baseUrl}):null);
  if(captures)await captures.init();
  const saveValue=value=>{const snapshot=structuredClone(value);saving=saving.catch(()=>{}).then(()=>write(vaultPath,snapshot));return saving;};
  const save=()=>saveValue(state);
  const connected=()=>!!state.session?.headers?.Authorization;
  const configured=()=>typeof state.config?.loginAuthorization==='string'&&!!state.config.loginAuthorization.trim();
  const configurationMessage='海康客户端登录配置缺失。请填写 mcp/.local/haik-client-config.json，运行 node mcp/scripts/initialize-haik.mjs，再重启海康服务。';
  const loginConfigured=()=>{if(!configured())throw new CloudError('LOGIN_CONFIG_MISSING',configurationMessage,409);};
  const cloud=(session=state.session)=>makeCloud(session,state.config,ptzState);
  const guard=context=>{if(context!==generation)throw changed();if(phase!=='ready')throw new CloudError('SHUTTING_DOWN','本地服务正在切换账号或关闭',503);};
  const authorized=()=>{if(!connected()||state.expired)throw new CloudError('LOGIN_REQUIRED','请先登录海康互联账号',401);};
  const accountKey=()=>{authorized();return state.accountOwner||hash(state.session.userId||state.session.uid||state.session.headers.Authorization);};
  const store=()=>{if(!captures)throw new CloudError('CAPTURE_UNAVAILABLE','未配置本地采集目录',503);return captures;};
  const player=()=>{if(!streams)throw new CloudError('MEDIA_UNAVAILABLE','未配置本地播放器',503);return streams;};
  const invalidate=()=>{generation++;previewSequence++;cameras=[];loadedAt=0;loading=undefined;return generation;};
  const queueLifecycle=work=>{const result=lifecycleTail.then(work);lifecycleTail=result.catch(()=>{});return result;};
  const ptzBlocked=()=>leases.size>0||[...ptzState.values()].some(item=>item.stopConfirmed===false);

  async function list(context=generation,force=false){
    guard(context);authorized();if(!force&&now()-loadedAt<15000&&loadedAt)return cameras;
    if(loading?.context===context)return loading.promise;
    const entry={context};entry.promise=(async()=>{const result=await cloud().listCameras();guard(context);if(!Array.isArray(result))throw new CloudError('INVALID_LIST','设备列表格式无效');cameras=result;loadedAt=now();return result;})();
    loading=entry;try{return await entry.promise;}finally{if(loading===entry)loading=undefined;}
  }
  async function camera(id,context){
    if(!validId(id))throw new CloudError('INVALID_CAMERA','请选择有效摄像头',400);
    const result=(await list(context)).find(item=>item.id===id);guard(context);if(!result)throw new CloudError('CAMERA_NOT_FOUND','摄像头不在当前账号设备列表中',404);return result;
  }
  function client(context){
    guard(context);authorized();const result=cloud();
    // HikCloud.live/PTZ/recordings share the account-scoped 15-second list cache.
    result.camera=id=>camera(id,context);return result;
  }
  async function stopAll(){
    await Promise.allSettled([...leases.values()].map(item=>item.done));
    let failure;
    for(const [id,item] of ptzState)if(item.stopConfirmed===false)try{await cloud().stop(id,item.direction);}catch(error){failure=error;}
    if(failure||ptzBlocked())throw new CloudError('PTZ_STOP_REQUIRED','云台停止尚未确认，请先重试停止，再切换账号或关闭',409);
    return {stopped:true};
  }
  async function move(id,direction,duration=300,speed=2){
    const context=generation;guard(context);authorized();
    if(loginBusy)throw new CloudError('LOGIN_BUSY','登录正在进行，请稍后操作',409);
    if(leases.has(id))throw new CloudError('PTZ_BUSY','云台正在执行上一条操作',409);
    let finish;const operation={done:new Promise(resolve=>{finish=resolve;})};leases.set(id,operation);
    try{return await client(context).ptz(id,direction,duration,speed);}finally{leases.delete(id);finish();}
  }
  async function closeMedia(dispose=false){
    let failure,disposal;
    if(dispose&&captures)try{disposal=Promise.resolve(captures.dispose());disposal.catch(()=>{});}catch(error){failure=error;}
    const closeStreams=(async()=>{
      if(!streams)return;
      let error;try{await streams.close();}catch(value){error=value;}
      await previewTail;
      try{if(dispose)await streams.dispose();else await streams.close();}catch(value){error??=value;}
      currentPreview=undefined;if(error)throw error;
    })();
    const closeCaptures=(async()=>{
      await captureTail;
      if(dispose){await disposal;return;}
      if(!captures)return;
      for(const [id,key] of captureOwners){await captures.cancel(id,{accountKey:key});captureOwners.delete(id);}
      if(connected()){
        const key=state.accountOwner||hash(state.session.userId||state.session.uid||state.session.headers.Authorization);
        for(const job of await captures.list({accountKey:key}))if(job.status==='running')await captures.cancel(job.id,{accountKey:key});
      }
    })();
    const results=await Promise.allSettled([closeStreams,closeCaptures]);
    for(const result of results)if(result.status==='rejected')failure??=result.reason;
    if(failure)throw failure;
  }
  async function expire(error,context,session){
    if(!(error instanceof CloudError)||error.status!==401||context!==generation||session!==state.session||phase!=='ready'||!connected())return;
    phase='expiring';const epoch=invalidate();
    await queueLifecycle(async()=>{
      try{
        const results=await Promise.allSettled([stopAll(),closeMedia()]);state.expired=true;
        // Preserve old authorization for explicit stop retries if stopping has failed.
        if(!ptzBlocked())state.session={headers:{}};
        await save();const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
      }finally{if(generation===epoch&&phase==='expiring')phase='ready';}
    });
  }
  async function status(){
    if(!connected()&&!configured())return {connected:false,configured:false,configurationRequired:true,message:configurationMessage,local:true,mcpPath:'/mcp'};
    if(!connected()||state.expired||phase==='closing'||phase==='closed'||phase==='expiring')return {connected:false,...(state.expired?{expired:true}:{}),...(ptzBlocked()?{stopRequired:true}:{}),local:true};
    if(phase!=='ready')return {connected:true,account:'海康互联',local:true,switching:true,mcpPath:'/mcp'};
    const context=generation,session=state.session;
    try{await cloud(session).verifySession();guard(context);return {connected:true,account:'海康互联',local:true,mcpPath:'/mcp'};}
    catch(error){if(context!==generation||session!==state.session)throw changed();if(error instanceof CloudError&&error.status===401){await expire(error,context,session);return {connected:false,expired:true,local:true,...(ptzBlocked()?{stopRequired:true}:{})};}throw error;}
  }
  async function login(phone,code,context){
    const phoneHash=hash(phone);let pending=state.pendingLogin;
    if(!pending||pending.phoneHash!==phoneHash||now()-pending.createdAt>300000){
      const result=await cloud().login(phone,code),token=result?.t||result?.access_token||result?.accessToken||result?.token;
      if(typeof token!=='string'||!token||/[\r\n\0]/.test(token))throw new CloudError('LOGIN_FORMAT_UNKNOWN','登录响应未返回可用令牌',502);
      const session={headers:{...state.config.headers,Authorization:token.startsWith('Bearer ')?token:'Bearer '+token},...(typeof result.refreshToken==='string'?{refreshToken:result.refreshToken}:{})};
      pending={session,phoneHash,owner:phoneHash,createdAt:now()};state.pendingLogin=pending;
      // The consumed SMS exchange is persisted even if shutdown arrived while it was in flight.
      await save();
    }
    const check=()=>{if(context!==generation||phase!=='authenticating')throw changed();};check();
    try{
      const fresh=cloud(pending.session);await fresh.verifySession();check();
      const teams=await fresh.request('/api-link-common/v2/team/list/info/own');check();const mine=Array.isArray(teams?.myTeam)?teams.myTeam:[];
      if(!mine.some(team=>team.isCurrent)&&mine.length===1){await fresh.request('/api-link-common/v2/team/change',{method:'POST',body:{teamNo:mine[0].teamNo}});check();}
      return await queueLifecycle(async()=>{
        check();await closeMedia();check();
        if(ptzBlocked())throw new CloudError('PTZ_STOP_REQUIRED','请先确认云台停止，再更换账号',409);
        const previous=state,next={...state,session:pending.session,accountOwner:pending.owner||phoneHash};delete next.pendingLogin;delete next.expired;
        await saveValue(next);
        try{check();}catch(error){await saveValue(previous);throw error;}
        state=next;ptzState.clear();return {connected:true};
      });
    }catch(error){if(error instanceof CloudError&&error.status===401&&context===generation){delete state.pendingLogin;await save();}throw error;}
  }
  const recordings=async()=>dependencies.recordings||import('../lib/recordings.mjs');
  const quality=value=>{if(value===undefined)return 2;if(value===1||value==='main')return 1;if(value===2||value==='sub')return 2;throw new CloudError('INVALID_QUALITY','请选择有效码流',400);};
  async function mediaSource(args,context){
    const item=await camera(args.cameraId,context);guard(context);const provider=client(context);
    if(dependencies.mediaSource){const result=await dependencies.mediaSource({client:provider,camera:item,args,context});guard(context);return {...result,item};}
    if((args.mode??'live')==='live'){
      const result=await provider.live(args.cameraId,quality(args.quality));guard(context);return {...result,item,sourceInfo:{mode:'live'}};
    }
    if(args.mode!=='playback')throw new CloudError('INVALID_SOURCE','请选择实时视频或录像回放',400);
    const helpers=await recordings();guard(context);const result=await helpers.recordingSource(provider,args.cameraId,args);guard(context);return {...result,item};
  }
  async function preview(args,playback=false){
    const context=generation,sequence=++previewSequence;guard(context);const target=player();
    const check=()=>{guard(context);if(sequence!==previewSequence)throw changed();};
    const source=await mediaSource({...args,mode:playback?'playback':'live'},context);check();
    const launch=previewTail.then(async()=>{
      check();if(currentPreview&&currentPreview!==args.cameraId){await target.close(currentPreview);currentPreview=undefined;check();}
      const result=await target.start(args.cameraId,source.url,{finite:playback,format:source.protocol});
      try{check();}catch(error){await target.close(args.cameraId);if(currentPreview===args.cameraId)currentPreview=undefined;throw error;}
      currentPreview=args.cameraId;return {...result,mode:playback?'playback':'live',sourceInfo:source.sourceInfo,pageUrl:(media.baseUrl||'http://127.0.0.1:8787')+'/?'+new URLSearchParams({cameraId:args.cameraId,...(playback?{playback:'1',source:args.source||'cloud',date:args.date||'',...(args.recordId?{recordId:args.recordId}:{startTime:args.startTime||'',endTime:args.endTime||''})}:{preview:'1'})})};
    });previewTail=launch.catch(()=>{});return launch;
  }
  function captureOptions(args,snapshot){
    const kind=snapshot?'frames':args.kind??'frames',durationSeconds=snapshot?1:args.durationSeconds??10,fps=snapshot?1:args.fps??1,maxWidth=args.maxWidth??1280;
    if(!['frames','video'].includes(kind)||!Number.isInteger(durationSeconds)||durationSeconds<1||durationSeconds>(kind==='frames'?3600:600)||!Number.isFinite(fps)||fps<0.1||fps>5||!Number.isInteger(maxWidth)||maxWidth<320||maxWidth>1920||kind==='frames'&&Math.ceil(durationSeconds*fps)>1800)throw new CloudError('INVALID_CAPTURE','采集时长、帧率或分辨率超出范围',400);
    return {kind,durationSeconds,fps,maxWidth,...(snapshot?{frameLimit:1}:{})};
  }
  async function startCapture(args,snapshot=false){
    const context=generation;guard(context);const target=store(),key=accountKey(),options=captureOptions(args,snapshot);
    const source=await mediaSource({...args,...(snapshot?{mode:'live'}:{})},context);guard(context);
    if(source.durationSeconds&&options.durationSeconds>source.durationSeconds)throw new CloudError('CAPTURE_RANGE','采集时长不能超过所选录像片段',400);
    const launch=captureTail.then(async()=>{
      guard(context);const job=await target.start({...options,cameraId:args.cameraId,cameraName:source.item.name||source.item.deviceName,sourceUrl:source.url,sourceFormat:source.protocol,sourceInfo:source.sourceInfo,accountKey:key});captureOwners.set(job.id,key);
      try{guard(context);}catch(error){await target.cancel(job.id,{accountKey:key});captureOwners.delete(job.id);throw error;}return job;
    });captureTail=launch.catch(()=>{});let job=await launch;guard(context);
    if(!snapshot)return {job};
    const clock=dependencies.snapshotNow||now,sleep=dependencies.snapshotPause||pause,deadline=clock()+18000;
    while(job.status==='running'&&!job.frames?.length&&clock()<deadline){await sleep(250);guard(context);job=await target.status(job.id,{accountKey:key});guard(context);}
    return {job,...(job.frames?.[0]?{frame:job.frames[0]}:{}),pending:job.status==='running'};
  }
  function page(args,max=200){const offset=args.offset??0,limit=args.limit??50;if(!Number.isSafeInteger(offset)||offset<0||offset>150000||!Number.isInteger(limit)||limit<1||limit>max)throw new CloudError('INVALID_PAGE','分页参数无效',400);return {offset,limit};}
  async function action(name,body={}){
    if(!body||typeof body!=='object'||Array.isArray(body))throw new CloudError('INVALID_BODY','请求格式无效',400);
    validateAction(name,body);
    if(name==='status')return status();
    if(name==='login'||name==='send_code')loginConfigured();
    if(name==='stop'){const result=body.cameraId?await cloud().stop(body.cameraId,body.direction):await stopAll();if(state.expired&&!ptzBlocked()){state.session={headers:{}};await save();}return result;}
    if(name==='login'){
      if(loginBusy||phase!=='ready')throw new CloudError('LOGIN_BUSY','登录或关闭正在进行，请稍后重试',409);
      if(ptzBlocked())throw new CloudError('PTZ_STOP_REQUIRED','请先确认云台停止，再更换账号',409);
      loginBusy=true;phase='authenticating';const context=invalidate();
      try{return await login(body.phone,body.code,context);}finally{loginBusy=false;if(context===generation&&phase==='authenticating')phase='ready';}
    }
    const context=generation,session=state.session;guard(context);
    try{
      const result=await(async()=>{switch(name){
        case 'send_code':if(now()<nextSms)throw new CloudError('SMS_COOLDOWN','请稍后再获取验证码',429,{retryAfterSeconds:Math.ceil((nextSms-now())/1000)});nextSms=now()+60000;await cloud().sendCode(body.phone,body.captchaVerifyParam);return {sent:true};
        case 'list':return {cameras:await list(context,true)};
        case 'live':authorized();return client(context).live(body.cameraId,body.quality??2);
        case 'move':return move(body.cameraId,body.direction,body.durationMs??300,body.speed??2);
        case 'preview':return preview(body);
        case 'playback':return preview(body,true);
        case 'capabilities':{const item=await camera(body.cameraId,context);guard(context);const provider=client(context);return typeof provider.capabilities==='function'?provider.capabilities(body.cameraId):{cameraId:item.id,live:{available:item.online&&!item.encrypted},ptz:{available:item.ptzAvailable??null},sdPlayback:{available:null},cloudRecording:{queryAvailable:null}};}
        case 'recording-dates':{await camera(body.cameraId,context);const helpers=await recordings();guard(context);return {source:body.source??'cloud',dates:await helpers.recordingDates(client(context),body.cameraId,body.source),timeZone:'Asia/Shanghai'};}
        case 'recordings':{const {offset,limit}=page(body);await camera(body.cameraId,context);const helpers=await recordings();guard(context);const rows=await helpers.listRecordings(client(context),body.cameraId,body.date,body.source??'cloud');guard(context);return {cameraId:body.cameraId,date:body.date,source:body.source??'cloud',recordings:rows.slice(offset,offset+limit),total:rows.length,offset,limit,hasMore:offset+limit<rows.length,timeZone:'Asia/Shanghai'};}
        case 'capture-start':return startCapture(body);
        case 'snapshot':return startCapture(body,true);
        case 'capture-status':{const {offset,limit}=page(body,100),job=await store().status(body.jobId,{accountKey:accountKey()}),totalFrames=job.frames?.length||0;return {job:{...job,frameCount:totalFrames,frames:job.frames?.slice(offset,offset+limit)||[]},offset,limit,totalFrames,hasMore:offset+limit<totalFrames,nextOffset:Math.min(offset+limit,totalFrames)};}
        case 'capture-list':{const jobs=await store().list({accountKey:accountKey()});return {jobs:body.cameraId?jobs.filter(job=>job.cameraId===body.cameraId):jobs,root:captures.root};}
        case 'capture-cancel':{const job=await store().cancel(body.jobId,{accountKey:accountKey()});if(terminal(job.status))captureOwners.delete(job.id);return {job};}
        default:throw new CloudError('INVALID_ACTION','未知操作',400);
      }})();guard(context);return result;
    }catch(error){if(context!==generation)throw changed();if(name!=='send_code')await expire(error,context,session);throw error;}
  }
  const runtime={action,streams,captures,
    async streamFile(id,name){const context=generation;guard(context);authorized();const result=await player().getFile(id,name);guard(context);return result;},
    async captureFile(id,name){const context=generation;guard(context);const result=await store().getFile(id,name,{accountKey:accountKey()});guard(context);return result;},
    async captureManifest(id){const context=generation;guard(context);const result=await store().status(id,{accountKey:accountKey()});guard(context);return result;},
    dispose(){phase='closing';const context=invalidate();return queueLifecycle(async()=>{try{const results=await Promise.allSettled([stopAll(),closeMedia(true)]);await saving;const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;if(context===generation&&phase==='closing')phase='closed';}catch(error){if(context===generation&&phase==='closing')phase='ready';throw error;}});},
    toolContext:()=>({action,
      cloud:{listCameras:async()=>(await action('list')).cameras,live:(cameraId,quality)=>action('live',{cameraId,quality})},
      connectionStatus:()=>action('status'),move:(cameraId,direction,durationMs,speed)=>action('move',{cameraId,direction,durationMs,speed}),
      stop:(cameraId,direction)=>action('stop',{cameraId,...(direction?{direction}:{})})
    })
  };return runtime;
}
