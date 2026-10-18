'use client';
import {useEffect,useRef,useState} from 'react';
import {Camera,Radio,ShieldCheck,Link2,ArrowUp,ArrowDown,ArrowLeft,ArrowRight,Square,Settings2,LoaderCircle,RefreshCw,X,Play,Maximize2,Copy,Check,LockKeyhole,Cloud,ChevronRight} from 'lucide-react';
import LoginModal from './login-modal';
import MediaPanel,{type PlaybackResult} from './media-panel';
import {api} from '../lib/client-api';

type CameraInfo={id:string;deviceSerial:string;channelNo:number;name:string;zoneName:string;online:boolean;encrypted:boolean};
const tools=[['camera_usage_guide','读取内置使用技能（首次连接）'],['camera_connection_status','检查云端连接'],['list_cameras','查询摄像头与在线状态'],['get_live_stream','打开实时预览'],['move_camera','短时移动云台并停止'],['stop_camera','请求立即停止云台'],['camera_capabilities','检查设备支持的能力'],['camera_recording_dates','查询云录像日期'],['camera_recordings','分页查询录像片段'],['camera_playback','打开历史录像回放'],['camera_snapshot','获取并保存单张截图'],['camera_capture_start','按时长、帧率保存图片或录像'],['capture_status','查看采集进度与文件'],['capture_list','查询持久保存的采集任务'],['capture_cancel','取消运行中的采集任务']];

export default function Dashboard({displayName}:{displayName:string}){
 const [cameras,setCameras]=useState<CameraInfo[]>([]),[selected,setSelected]=useState(''),[connected,setConnected]=useState(false),[loading,setLoading]=useState(true),[notice,setNotice]=useState(''),[loginOpen,setLoginOpen]=useState(false),[speed,setSpeed]=useState(2),[ptzBusy,setPtzBusy]=useState(false),[playing,setPlaying]=useState(false),[starting,setStarting]=useState(false),[stream,setStream]=useState(''),[streamProtocol,setStreamProtocol]=useState('flv'),[copied,setCopied]=useState(false),[view,setView]=useState('live'),[mode,setMode]=useState<'live'|'playback'>('live'),[scope,setScope]=useState(0),[attempt,setAttempt]=useState(0);
 const videoRef=useRef<HTMLVideoElement>(null),held=useRef(false),lastDirection=useRef('right'),currentId=useRef(''),moving=useRef(false),previewGeneration=useRef(0),loadGeneration=useRef(0),frameRef=useRef<HTMLDivElement>(null),modeRef=useRef<'live'|'playback'>('live'),deepLinkRead=useRef(false),deepLink=useRef<{cameraId:string;mode:'live'|'playback';args:Record<string,unknown>}|null>(null),copyTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const camera=cameras.find(c=>c.id===selected);
 function resetPlayer(){previewGeneration.current++;setStream('');setStarting(false);setPlaying(false);setMode('live');modeRef.current='live';}
 const clearConnection=()=>{held.current=false;currentId.current='';loadGeneration.current++;setConnected(false);setCameras([]);setSelected('');setScope(value=>value+1);resetPlayer();};
 const load=async()=>{
  const generation=++loadGeneration.current;setLoading(true);
  try{const status=await api<{connected:boolean;expired?:boolean}>('status');if(generation!==loadGeneration.current)return;setConnected(status.connected);
   if(status.connected){const result=await api<{cameras:CameraInfo[]}>('list');if(generation!==loadGeneration.current)return;if(!Array.isArray(result.cameras))throw Error('设备列表格式无法识别。');setCameras(result.cameras);setSelected(old=>result.cameras.some(item=>item.id===old)?old:result.cameras[0]?.id||'');}
   else{clearConnection();setLoading(false);if(status.expired)setNotice('云端会话已过期，请重新登录');}
  }catch(error){if(generation!==loadGeneration.current)return;if((error as {status?:number}).status===401){clearConnection();setLoading(false);}setNotice((error as Error).message);}
  finally{if(generation===loadGeneration.current)setLoading(false);}
 };
 useEffect(()=>{void load();return()=>{loadGeneration.current++;previewGeneration.current++;clearTimeout(copyTimer.current);};},[]);
 useEffect(()=>{currentId.current=selected;resetPlayer();},[selected]);
 useEffect(()=>{
  if(!connected||!cameras.length)return;
  if(!deepLinkRead.current){deepLinkRead.current=true;const params=new URLSearchParams(window.location.search),id=params.get('cameraId');
   if(id&&cameras.some(item=>item.id===id)){
    if(params.get('playback')==='1')deepLink.current={cameraId:id,mode:'playback',args:{cameraId:id,source:params.get('source')==='sd'?'sd':'cloud',date:params.get('date')||'',...(params.get('recordId')?{recordId:params.get('recordId')}:{startTime:params.get('startTime'),endTime:params.get('endTime')})}};
    else if(params.get('preview')==='1')deepLink.current={cameraId:id,mode:'live',args:{cameraId:id,quality:params.get('quality')==='main'?1:2}};
    if(id!==selected){setSelected(id);return;}
   }
  }
  const pending=deepLink.current;if(!pending||pending.cameraId!==selected)return;deepLink.current=null;
  const generation=++previewGeneration.current,id=pending.cameraId;setStarting(true);setNotice('');
  void api<PlaybackResult>(pending.mode==='playback'?'playback':'live',pending.args).then(result=>{if(currentId.current===id&&previewGeneration.current===generation)acceptStream(result,pending.mode);}).catch(error=>{if(currentId.current===id&&previewGeneration.current===generation){setStarting(false);setNotice((error as Error).message);}});
 },[connected,cameras,selected]);
 useEffect(()=>{
  if(streamProtocol!=='flv'||!stream||view!=='live')return;let gone=false;let player:any;let monitor:ReturnType<typeof setInterval>|undefined;
  (async()=>{try{const {default:Player}=await import('ezuikit-flv');if(gone)return;player=new Player({id:'haik-flv',url:stream,decoder:'/ezflv/decoder.js',autoPlay:true,useMSE:true,autoWasm:true,muted:true,hasAudio:false,isEzviz:false,themeData:null,debug:false,loadingTimeoutReplayTimes:1} as any);
   const loaded=()=>{if(!gone){setPlaying(true);setStarting(false);}};
   monitor=setInterval(()=>{if(!gone&&player?.getState()?.playing)loaded();},300);player.on('play',loaded);player.on('playing',loaded);player.on('videoFrame',loaded);
   player.on('error',()=>{if(!gone){setStarting(false);setPlaying(false);setNotice('视频连接未完成，请重新连接');}});player.on('pause',()=>{if(!gone)setPlaying(false);});
  }catch{if(!gone){setStarting(false);setPlaying(false);setNotice('视频播放器初始化失败，请重新连接');}}})();
  return()=>{gone=true;clearInterval(monitor);player?.destroy();};
 },[stream,streamProtocol,attempt,view]);
 useEffect(()=>{
  if(streamProtocol==='flv'||!stream||view!=='live')return;const video=videoRef.current;if(!video)return;let hls:any;let gone=false;
  (async()=>{try{
   if(streamProtocol==='mp4'){video.src=stream;void video.play().catch(()=>{});return;}
   const {default:Hls}=await import('hls.js');if(gone)return;
   if(Hls.isSupported()){
    hls=new Hls({enableWorker:true});hls.loadSource(stream);hls.attachMedia(video);hls.on(Hls.Events.MANIFEST_PARSED,()=>{if(!gone)void video.play().catch(()=>{});});
    hls.on(Hls.Events.ERROR,(_:unknown,data:{fatal:boolean})=>{if(data.fatal&&!gone){setStarting(false);setPlaying(false);setNotice('视频连接中断，请重新连接');}});
   }else if(video.canPlayType('application/vnd.apple.mpegurl')){video.src=stream;void video.play().catch(()=>{});}
   else{setStarting(false);setNotice('当前浏览器不支持 HLS，请使用新版 Chrome、Edge 或 Safari');}
  }catch{if(!gone){setStarting(false);setPlaying(false);setNotice('视频播放器初始化失败，请重新连接');}}})();
  return()=>{gone=true;hls?.destroy();video.pause();video.removeAttribute('src');video.load();};
 },[stream,streamProtocol,attempt,view]);
 const stop=async()=>{held.current=false;if(currentId.current&&moving.current){try{await api('stop',{cameraId:currentId.current,direction:lastDirection.current});}catch(error){setNotice((error as Error).message);}}};
 useEffect(()=>{
  const halt=()=>{if(held.current)void stop();},released=(event:KeyboardEvent)=>{if(event.key==='Enter'||event.key===' ')halt();},visible=()=>{if(document.hidden)halt();};
  window.addEventListener('keyup',released);window.addEventListener('blur',halt);window.addEventListener('pointerup',halt);window.addEventListener('pointercancel',halt);document.addEventListener('visibilitychange',visible);
  return()=>{halt();window.removeEventListener('keyup',released);window.removeEventListener('blur',halt);window.removeEventListener('pointerup',halt);window.removeEventListener('pointercancel',halt);document.removeEventListener('visibilitychange',visible);};
 },[]);
 const move=async(direction:string)=>{
  if(!camera||!camera.online||moving.current||modeRef.current==='playback')return;held.current=true;moving.current=true;lastDirection.current=direction;setPtzBusy(true);setNotice('');const id=camera.id;
  try{do{await api('move',{cameraId:id,direction,durationMs:350,speed});}while(held.current&&currentId.current===id&&modeRef.current==='live');}
  catch(error){setNotice((error as Error).message);held.current=false;}finally{moving.current=false;setPtzBusy(false);}
 };
 function acceptStream(result:PlaybackResult,nextMode:'live'|'playback'){
  if(!result||typeof result.url!=='string'||!['flv','hls','mp4'].includes(result.protocol||'flv'))throw Error('视频播放响应格式无法识别。');
  held.current=false;if(moving.current)void stop();previewGeneration.current++;setPlaying(false);setStarting(true);modeRef.current=nextMode;setMode(nextMode);setStreamProtocol(result.protocol||'flv');setStream(result.url);setAttempt(value=>value+1);
 }
 const live=async()=>{
  if(!camera)return;const id=camera.id,generation=++previewGeneration.current;setStream('');setPlaying(false);setStarting(true);setMode('live');modeRef.current='live';setNotice('');
  try{const result=await api<PlaybackResult>('live',{cameraId:id,quality:2});if(currentId.current===id&&previewGeneration.current===generation)acceptStream(result,'live');}
  catch(error){if((error as {status?:number}).status===401)clearConnection();if(currentId.current===id&&previewGeneration.current===generation){setStarting(false);setNotice((error as Error).message);}}
 };
 const emergencyStop=async()=>{held.current=false;if(!camera)return;setPtzBusy(true);try{await api('stop',{cameraId:camera.id,direction:lastDirection.current});setNotice('云台停止已确认');}catch(error){setNotice((error as Error).message);}finally{setPtzBusy(false);}};
 const select=(id:string)=>{if(held.current)void stop();currentId.current=id;previewGeneration.current++;setSelected(id);};
 const pad=(direction:string,Icon:typeof ArrowUp,label:string)=><button className={'pad-key '+direction} aria-label={label} disabled={!camera?.online||mode==='playback'||(ptzBusy&&lastDirection.current!==direction)} onPointerDown={event=>{event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);void move(direction);}} onPointerUp={()=>void stop()} onPointerCancel={()=>void stop()} onLostPointerCapture={()=>void stop()} onBlur={()=>void stop()} onKeyDown={event=>{if((event.key==='Enter'||event.key===' ')&&!event.repeat){event.preventDefault();void move(direction);}}} onKeyUp={()=>void stop()}><Icon size={20}/></button>;
 return <div className="console-shell"><aside className="sidebar"><a className="brand" href="/"><span className="brand-mark"><Camera size={23}/></span><span>HAIK<span className="brand-dot">.</span></span></a><div className="workspace-tag"><i/> 本地工作区 <LockKeyhole size={12}/></div><div className="nav-caption">工作台</div><button className={'nav-link '+(view==='live'?'active':'')} onClick={()=>setView('live')}><Radio size={18}/><span>摄像头工作区</span><em>{cameras.length}</em></button><button className={'nav-link '+(view==='mcp'?'active':'')} onClick={()=>{if(held.current)void stop();setView('mcp');}}><Link2 size={18}/><span>MCP 连接</span><ChevronRight size={15}/></button><div className="sidebar-bottom"><div className="private-card"><ShieldCheck size={19}/><strong>仅你可见</strong><p>摄像头与云端会话<br/>保存在你的本机工作区</p></div><button className="account-button" onClick={()=>{if(held.current)void stop();setLoginOpen(true);}}><span className="avatar">{displayName.slice(0,1).toUpperCase()}</span><span><strong>我的云端账号</strong><small>{connected?'海康互联 · 已连接':'连接海康互联'}</small></span><Settings2 size={16}/></button></div></aside>
 <main className="main"><header className="page-header"><div><div className="eyebrow">YOUR SPACE, IN VIEW</div><h1>{view==='live'?'摄像头工作区':'MCP 连接'}</h1><p>{view==='live'?'实时预览、历史回放与本地影像留存。':'把摄像头能力连接到你的 AI 助手。'}</p></div><div className="header-actions"><span className={'connection-badge '+(connected?'online':'')}><i/>{connected?'云端已连接':'等待连接'}</span><button className="icon-button" aria-label="刷新摄像头" onClick={()=>void load()} disabled={loading}><RefreshCw size={17} className={loading?'spin':''}/></button></div></header>
 {notice&&<div className="notice" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={()=>setNotice('')}><X size={16}/></button></div>}
 {view==='mcp'?<section className="mcp-page"><span className="large-icon"><Link2 size={30}/></span><h2>同一个账号，同一套摄像头。</h2><p>MCP 与网页共用云端连接。查询设备和录像、打开预览或回放，并把截图与本地视频持久保存，交给后续工具分析。</p><div className="endpoint-row"><code>{typeof window!=='undefined'?window.location.origin:''}/mcp</code><button className="secondary-button" onClick={async()=>{try{await navigator.clipboard.writeText(window.location.origin+'/mcp');setCopied(true);clearTimeout(copyTimer.current);copyTimer.current=setTimeout(()=>setCopied(false),1800);}catch{setNotice('浏览器未允许复制，可选中 MCP 地址手动复制。');}}}>{copied?<Check size={15}/>:<Copy size={15}/>} {copied?'已复制':'复制地址'}</button></div><small>MCP 服务仅监听本机。内置技能随 initialize、resources 和 camera_usage_guide 提供；录像能力以设备实际返回为准。</small><div className="tool-list">{tools.map(([name,label])=><div className="tool-row" key={name}><code>{name}</code><span>{label}</span></div>)}</div></section>:<>
 <section className="overview"><div><span>全部通道</span><strong>{loading?'—':cameras.length}<small>个</small></strong></div><div><span><i className="status-dot"/>在线设备</span><strong>{loading?'—':cameras.filter(item=>item.online).length}<small>个</small></strong></div><div><span>连接方式</span><strong className="overview-text"><Cloud size={18}/> 云端直连</strong></div><div className="overview-note"><ShieldCheck size={21}/><span>会话已加密保存<br/><small>无需开放摄像头公网端口</small></span></div></section>
 <div className="monitor-grid"><section className="device-panel"><div className="panel-title"><h2>我的摄像头</h2><span>{cameras.length}</span></div><div className="device-list">{loading?<div className="list-empty"><LoaderCircle className="spin" size={24}/><p>正在连接云端</p></div>:cameras.map(item=><button key={item.id} className={'device-item '+(item.id===selected?'selected':'')} onClick={()=>select(item.id)}><span className="device-thumb"><Camera size={24}/><i className={'status-dot '+(!item.online?'offline':'')}/></span><span className="device-details"><strong>{item.name}</strong><small>{item.zoneName||'默认区域'} · 通道 {item.channelNo}</small><em>{item.online?'在线':'离线'}{item.encrypted?' · 已加密':''}</em></span></button>)}{!loading&&cameras.length===0&&<div className="list-empty"><Camera size={28}/><p>{connected?'当前账号没有可用摄像头':'连接账号后显示设备'}</p>{!connected&&<button className="text-button" onClick={()=>setLoginOpen(true)}>连接云端账号 <ChevronRight size={13}/></button>}</div>}</div><div className="device-footer"><i/> 列表来自云端实际设备</div></section>
 <section className="preview-panel"><div className="preview-heading"><div><span className="section-kicker">{mode==='playback'?'RECORDING PLAYBACK':'LIVE PREVIEW'}</span><h2>{camera?.name||'选择摄像头'}</h2></div>{camera&&<span className="subtle-tag">{mode==='playback'?'历史回放':'通道 '+camera.channelNo}</span>}</div><div className="video-frame" ref={frameRef}><div id="haik-flv" style={{position:'absolute',inset:0,display:streamProtocol==='flv'?'block':'none'}}/><video style={{display:streamProtocol==='flv'?'none':'block'}} ref={videoRef} controls autoPlay muted playsInline onPlaying={()=>{setPlaying(true);setStarting(false);}} onWaiting={()=>{if(stream)setStarting(true);}} onPause={()=>setPlaying(false)} onError={()=>{if(stream){setStarting(false);setPlaying(false);setNotice('视频连接未完成，请重新连接');}}}/>{!stream&&<div className="video-empty"><span className="camera-outline"><Camera size={40} strokeWidth={1.3}/></span><h3>{camera?'画面，近在眼前':'你的空间，一屏尽览'}</h3><p>{camera?'开始预览，或在下方查询历史录像':'从左侧选择设备，开始实时预览'}</p><button className="primary-button" onClick={()=>void live()} disabled={!camera?.online||starting}>{starting?<LoaderCircle size={16} className="spin"/>:<Play size={16} fill="currentColor"/>}{starting?'正在连接':'开始预览'}</button></div>}{stream&&starting&&<div className="video-loading"><LoaderCircle size={28} className="spin"/><span>{mode==='playback'?'正在加载历史录像':'正在加载实时画面'}</span></div>}{playing&&<span className={'live-badge '+(mode==='playback'?'playback-badge':'')}><i/>{mode==='playback'?'历史回放':'LIVE'}</span>}</div><div className="video-toolbar"><span><i className={'status-dot '+(!playing?'offline':'')}/>{playing?(mode==='playback'?'正在播放历史录像':'正在实时预览'):stream?'等待播放':'尚未开始预览'}</span><div><button className="toolbar-button" onClick={()=>void live()} disabled={!camera?.online||starting}><RefreshCw size={14}/>{mode==='playback'?'返回实时':'重新连接'}</button><button className="icon-button" aria-label="全屏画面" onClick={()=>void frameRef.current?.requestFullscreen()} disabled={!stream}><Maximize2 size={17}/></button></div></div><div className="preview-meta"><div><span>设备序列号</span><strong>{camera?.deviceSerial||'—'}</strong></div><div><span>设备区域</span><strong>{camera?.zoneName||'—'}</strong></div><div><span>画面类型</span><strong>{mode==='playback'?'历史回放':'实时预览'} · {streamProtocol.toUpperCase()}</strong></div></div></section>
 <section className="ptz-panel"><div className="panel-title"><h2>云台控制</h2><Settings2 size={16}/></div><p className="panel-description">{mode==='playback'?'历史回放期间禁用移动，返回实时后可控制。':'点按微调，按住持续移动'}</p><div className={'control-pad '+(ptzBusy?'moving':'')}>{pad('up',ArrowUp,'向上移动')}{pad('left',ArrowLeft,'向左移动')}<button className="pad-center" aria-label="停止云台" onClick={()=>void emergencyStop()} disabled={!camera}><Square size={16} fill="currentColor"/></button>{pad('right',ArrowRight,'向右移动')}{pad('down',ArrowDown,'向下移动')}</div><div className="speed-header"><span>转动速度</span><strong>{speed}<small> / 5</small></strong></div><input className="speed-slider" aria-label="云台速度" type="range" min="1" max="5" value={speed} disabled={mode==='playback'||ptzBusy} onChange={event=>setSpeed(Number(event.target.value))}/><div className="range-labels"><span>精细</span><span>快速</span></div><button className="stop-button" onClick={()=>void emergencyStop()} disabled={!camera}><Square size={13} fill="currentColor"/> 停止移动</button><div className="control-note"><ShieldCheck size={16}/><span>松开即安排停止<br/><small>每次移动最多 1 秒</small></span></div></section></div>
 <MediaPanel camera={camera} connected={connected} scope={scope} onPlaybackStart={()=>++previewGeneration.current} onPlayback={(result,ticket)=>{if(ticket!==previewGeneration.current)throw Error('已切换播放请求，请重新选择录像。');acceptStream(result,'playback');}} onLive={live}/>
 <footer className="workspace-footer"><span><LockKeyhole size={13}/> 私人摄像头工作区</span><button onClick={()=>setView('mcp')}><Link2 size={13}/> 连接 MCP <ChevronRight size={12}/></button></footer></>}
 </main>{loginOpen&&<LoginModal connected={connected} onClose={()=>setLoginOpen(false)} onConnected={()=>{clearConnection();setLoginOpen(false);void load();}}/>}</div>;
}
