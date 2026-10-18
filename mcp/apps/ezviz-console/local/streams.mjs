import {createMediaSpawn} from './media.mjs';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir,readFile,stat,realpath,lstat,rm,unlink} from 'node:fs/promises';
import path from 'node:path';
import {CloudError} from '../lib/cloud.mjs';

const ID=/^[a-f0-9]{32}$/;
const FILE=/^(?:index\.m3u8|seg_[0-9]{6,12}\.ts)$/;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const failure=()=>new CloudError('STREAM_FAILED','视频转流失败，请刷新后重试');
const closed=()=>new CloudError('STREAM_CLOSED','预览已停止，请重新打开',409);

/** Local-only, bounded FFmpeg HLS sessions. Never log arguments or stderr. */
export class StreamManager{
  constructor({ffmpeg,root,baseUrl},dependencies={}){
    this.spawn=dependencies.spawn||createMediaSpawn(dependencies.transport);
    if(typeof ffmpeg!=='string'||!ffmpeg||typeof root!=='string'||!root)throw new TypeError('ffmpeg and root are required');
    const base=new URL(baseUrl);
    if(!['http:','https:'].includes(base.protocol)||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.username||base.password||base.search||base.hash)throw new TypeError('baseUrl must be a loopback HTTP URL');
    if(!base.pathname.endsWith('/'))base.pathname+='/';
    this.ffmpeg=ffmpeg;this.root=path.resolve(root);this.baseUrl=base.href;
    this.sessions=new Map();this.cameras=new Map();this.tail=Promise.resolve();this.disposed=false;
    this.timer=setInterval(()=>{
      this._queue(async()=>{
        for(const session of [...this.sessions.values()])if(Date.now()-session.touched>=90000)await this._stop(session);
      }).catch(()=>{});
    },5000);
    this.timer.unref?.();
  }

  _queue(work){const result=this.tail.then(work);this.tail=result.catch(()=>{});return result;}

  _child(directory){
    const target=path.resolve(directory),relative=path.relative(this.root,target);
    if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw failure();
    return target;
  }

  async _clean(session){
    const directory=this._child(session.directory);
    try{
      const info=await lstat(directory);
      if(info.isSymbolicLink()){await unlink(directory);return;}
      const actual=await realpath(directory),relative=path.relative(this.rootReal,actual);
      if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw failure();
      await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
    }catch(error){if(error?.code!=='ENOENT')throw failure();}
  }

  async start(cameraId,upstreamUrl,{finite=false,format}={}){
    if(typeof cameraId!=='string'||!cameraId||cameraId.length>512)throw new CloudError('INVALID_CAMERA','请选择有效设备',400);
    let upstream;
    try{upstream=new URL(upstreamUrl);}catch{throw new CloudError('INVALID_STREAM','云端未返回有效播放地址',400);}
    if(typeof upstreamUrl!=='string'||!['rtsp:','rtsps:','http:','https:'].includes(upstream.protocol)||!upstream.hostname||/[\r\n\0]/.test(upstreamUrl))throw new CloudError('INVALID_STREAM','云端播放协议不受支持',400);
    format??=/\.m3u8$/i.test(upstream.pathname)?'hls':/\.mp4$/i.test(upstream.pathname)?'mp4':['http:','https:'].includes(upstream.protocol)?'flv':'rtsp';
    const fingerprint=createHash('sha256').update(upstreamUrl).digest('hex');
    const session=await this._queue(async()=>{
      if(this.disposed)throw closed();
      const previous=this.cameras.get(cameraId);
      if(previous?.alive&&!previous.closing&&previous.fingerprint===fingerprint&&previous.finite===finite){previous.touched=Date.now();return previous;}
      if(previous)await this._stop(previous);
      if(this.sessions.size>=2)throw new CloudError('STREAM_LIMIT','最多同时预览两台设备，请先关闭其他预览',409);
      try{
        await mkdir(this.root,{recursive:true});
        if((await lstat(this.root)).isSymbolicLink())throw failure();
        this.rootReal=await realpath(this.root);
      }catch{throw failure();}
      const id=randomBytes(16).toString('hex'),directory=this._child(path.join(this.root,id));
      const entry={id,cameraId,directory,fingerprint,touched:Date.now(),alive:true,closing:false,exitDone:false,readyAt:0,child:null,finite};
      try{await mkdir(directory);}catch{throw failure();}
      this.sessions.set(id,entry);this.cameras.set(cameraId,entry);
      const args=['-hide_banner','-loglevel','error','-nostdin','-y','-protocol_whitelist','rtsp,rtsps,tcp,tls,http,https,udp,rtp,crypto'];
      if(upstream.protocol==='rtsp:'||upstream.protocol==='rtsps:')args.push('-rtsp_transport','tcp');
      if(format&&format!=='rtsp'){if(!['flv','hls','mp4'].includes(format))throw failure();args.push('-f',format==='mp4'?'mov':format);}
      args.push('-i',upstreamUrl,'-map','0:v:0','-an','-c:v','libx264','-preset','veryfast','-tune','zerolatency','-pix_fmt','yuv420p','-vf','setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2','-crf','25','-r','15','-g','30','-keyint_min','30','-sc_threshold','0','-f','hls','-hls_time','2','-hls_list_size',finite?'0':'5','-hls_delete_threshold','2','-hls_flags',finite?'independent_segments+temp_file':'delete_segments+independent_segments+temp_file');
      if(finite)args.push('-hls_playlist_type','vod');
      args.push('-hls_segment_filename',path.join(directory,'seg_%06d.ts'),path.join(directory,'index.m3u8'));
      let exited;
      entry.exited=new Promise(resolve=>{exited=resolve;});
      const finish=code=>{
        if(entry.exitDone)return;
        entry.exitDone=true;entry.alive=finite&&code===0&&!entry.closing;exited();
        // Completed VOD files must remain available while the browser plays them.
        if(entry.alive)return;
        this._queue(()=>this._stop(entry)).catch(()=>{});
      };
      try{
        entry.child=this.spawn(this.ffmpeg,args,{windowsHide:true,stdio:'ignore',shell:false});
        entry.child.once('error',()=>{entry.alive=false;});
        entry.child.once('close',finish);
      }catch{finish();}
      entry.ready=this._ready(entry);
      // A caller may close or replace a session before its pending start resolves.
      entry.ready.catch(()=>{});
      return entry;
    });
    await session.ready;
    if(!session.alive||session.closing||this.cameras.get(cameraId)!==session)throw closed();
    session.touched=Date.now();
    return {url:new URL(`streams/${session.id}/index.m3u8`,this.baseUrl).href,protocol:'hls'};
  }

  async _ready(session){
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){
      if(session.closing)throw closed();
      if(!session.alive)throw failure();
      try{
        const playlist=await readFile(path.join(session.directory,'index.m3u8'),'utf8');
        const segment=playlist.split(/\r?\n/).find(line=>/^seg_[0-9]{6,12}\.ts$/.test(line));
        if(playlist.startsWith('#EXTM3U')&&segment&&(await stat(path.join(session.directory,segment))).size>0){
          if(session.closing||!session.alive)throw closed();
          session.readyAt=Date.now();return;
        }
      }catch{}
      await pause(100);
    }
    this._queue(()=>this._stop(session)).catch(()=>{});
    throw new CloudError('STREAM_TIMEOUT','视频准备超时，请确认设备在线后重试',504);
  }

  getFile(sessionId,filename){
    if(typeof sessionId!=='string'||!ID.test(sessionId)||typeof filename!=='string'||!FILE.test(filename))throw new CloudError('STREAM_NOT_FOUND','播放资源不存在',404);
    const session=this.sessions.get(sessionId);
    if(!session?.alive||session.closing||!session.readyAt)throw new CloudError('STREAM_NOT_FOUND','预览已结束，请重新打开',404);
    session.touched=Date.now();
    return {path:this._child(path.join(session.directory,filename)),mime:filename.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t'};
  }

  async _stop(session){
    session.closing=true;
    if(!session.exitDone&&session.child){
      try{session.child.kill('SIGTERM');}catch{}
      await Promise.race([session.exited,pause(2000)]);
      if(!session.exitDone){
        try{session.child.kill('SIGKILL');}catch{}
        await Promise.race([session.exited,pause(2000)]);
      }
      if(!session.exitDone)throw failure();
    }
    session.alive=false;
    await this._clean(session);
    if(this.cameras.get(session.cameraId)===session)this.cameras.delete(session.cameraId);
    if(this.sessions.get(session.id)===session)this.sessions.delete(session.id);
  }

  close(cameraId){
    return this._queue(async()=>{
      const entries=cameraId===undefined?[...this.sessions.values()]:[this.cameras.get(cameraId)].filter(Boolean);
      let error;
      for(const entry of entries){try{await this._stop(entry);}catch(value){error=value;}}
      if(error)throw error;
    });
  }

  async dispose(){this.disposed=true;clearInterval(this.timer);await this.close();}
}
