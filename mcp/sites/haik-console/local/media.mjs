import {Transform} from 'node:stream';
import {EventEmitter} from 'node:events';
import {spawn as nativeSpawn} from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import {CloudError} from '../lib/hik-cloud.mjs';

const mediaError=()=>new CloudError('MEDIA_TRANSPORT_FAILED','授权视频传输未完成，已停止本地解码',502);

/** Legacy FLV codec 12 -> Enhanced FLV hvc1. Encoded HEVC bytes stay unchanged. */
export class NormalizeLegacyFlv extends Transform {
  constructor({maxTagBytes=16*1024*1024}={}){super();this.buffer=Buffer.alloc(0);this.headerDone=false;this.maxTagBytes=maxTagBytes;}
  _transform(chunk,encoding,callback){
    try{
      this.buffer=Buffer.concat([this.buffer,chunk]);
      if(!this.headerDone){
        if(this.buffer.length<9)return callback();
        if(this.buffer.toString('ascii',0,3)!=='FLV')throw mediaError();
        const size=this.buffer.readUInt32BE(5)+4;
        if(size<13||size>4096)throw mediaError();
        if(this.buffer.length<size)return callback();
        this.push(this.buffer.subarray(0,size));this.buffer=this.buffer.subarray(size);this.headerDone=true;
      }
      while(this.buffer.length>=11){
        const length=this.buffer.readUIntBE(1,3);
        if(length>this.maxTagBytes)throw mediaError();
        if(this.buffer.length<length+15)break;
        const header=Buffer.from(this.buffer.subarray(0,11));let payload=this.buffer.subarray(11,11+length);
        if(header[0]===9&&payload.length&&(payload[0]&15)===12&&!(payload[0]&128)){
          if(payload.length<5||![0,1,2].includes(payload[1]))throw mediaError();
          const packetType=payload[1],prefix=Buffer.concat([Buffer.from([128|(payload[0]&112)|packetType]),Buffer.from('hvc1')]);
          payload=Buffer.concat([prefix,...(packetType===1?[payload.subarray(2,5)]:[]),payload.subarray(5)]);header.writeUIntBE(payload.length,1,3);
        }
        const previousSize=Buffer.alloc(4);previousSize.writeUInt32BE(11+payload.length);
        this.push(Buffer.concat([header,payload,previousSize]));this.buffer=this.buffer.subarray(length+15);
      }
      callback();
    }catch{callback(mediaError());}
  }
  _flush(callback){if(!this.headerDone||this.buffer.length)callback(mediaError());else callback();}
}

/** Only runtime-owned SDK URLs may enter here. No redirects, URL/stderr logging or files. */
export function createMediaSpawn({spawn=nativeSpawn,get=(url,options,callback)=>(url.protocol==='https:'?https:http).get(url,options,callback)}={}){
  return function spawnMedia(binary,args,options={}){
    const index=args.indexOf('-i');let url;
    try{url=new URL(args[index+1]);}catch{return spawn(binary,args,options);}
    const formatIndex=args.slice(0,index).lastIndexOf('-f'),format=formatIndex>=0?args[formatIndex+1]:undefined;
    const flv=format==='flv'||(!format&&/\.flv$/i.test(url.pathname));
    if(!flv)return spawn(binary,args,options);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||/[\r\n\0]/.test(url.href))throw mediaError();
    const inputPrefix=['-hide_banner','-loglevel','error','-nostdin','-y','-probesize','65536','-analyzeduration','1000000','-f','flv','-i','pipe:0'];
    const child=spawn(binary,[...inputPrefix,...args.slice(index+2)],{...options,windowsHide:true,shell:false,stdio:['pipe','ignore','ignore']});
    const proxy=new EventEmitter();let request,response,normalizer,forceTimer,closed=false,failed=false,cancelled=false;
    const cleanup=()=>{clearTimeout(forceTimer);request?.destroy();response?.destroy();normalizer?.destroy();child.stdin?.destroy();request=null;response=null;normalizer=null;};
    const kill=signal=>{cancelled=true;cleanup();try{return child.kill(signal);}catch{return false;}};
    proxy.kill=kill;
    const abort=()=>{
      if(closed||cancelled||failed)return;failed=true;cleanup();
      try{child.kill('SIGTERM');}catch{}
      forceTimer=setTimeout(()=>{if(!closed)try{child.kill('SIGKILL');}catch{}},1500);forceTimer.unref?.();
    };
    child.once('error',()=>{failed=true;cleanup();proxy.emit('error',mediaError());});
    child.once('close',(code,signal)=>{if(closed)return;closed=true;cleanup();proxy.emit('close',failed?1:code,signal);});
    child.stdin?.on('error',()=>{});
    try{
      request=get(url,{family:4,timeout:20000},incoming=>{
        response=incoming;
        if(closed||cancelled){incoming.destroy();return;}
        if(incoming.statusCode!==200){abort();return;}
        normalizer=new NormalizeLegacyFlv();normalizer.on('error',abort);incoming.on('error',abort);incoming.on('aborted',abort);
        // Pipe preserves backpressure; unlike the exploratory script it cannot buffer a live feed unboundedly.
        incoming.pipe(normalizer).pipe(child.stdin);
      });
      request.on('error',abort);request.on('timeout',abort);
    }catch{abort();}
    return proxy;
  };
}
