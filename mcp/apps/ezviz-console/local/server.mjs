import http from 'node:http';
import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,relative,isAbsolute,parse,join,sep,extname} from 'node:path';
import {createRuntime} from './runtime.mjs';
import {CloudError} from '../lib/cloud.mjs';
import {handleMcpMessage,parseFailure} from '../lib/mcp-server.mjs';

const CAPTURE=/^(?:frame_[0-9]{6}\.jpg|recording\.mp4)$/;
const STREAM=/^(?:index\.m3u8|seg_[0-9]{6,12}\.ts)$/;
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.mp4':'video/mp4','.m3u8':'application/vnd.apple.mpegurl','.ts':'video/mp2t','.woff2':'font/woff2','.wasm':'application/wasm','.json':'application/json; charset=utf-8'};
const missing=()=>new CloudError('NOT_FOUND','未找到资源',404);
function headers(res){res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');}
function json(req,res,status,value){headers(res);const data=Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':data.length});res.end(req.method==='HEAD'?undefined:data);}
async function readJson(req){let size=0;const parts=[];for await(const chunk of req){size+=chunk.length;if(size>16384)throw new CloudError('PAYLOAD_TOO_LARGE','请求过大',413);parts.push(chunk);}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new CloudError('INVALID_JSON','请求格式无效',400);}}
function safeText(value){return String(value).replace(/https?:\/\/\S+/gi,'[地址已隐藏]').replace(/Bearer\s+\S+/gi,'[令牌已隐藏]').replace(/\beyJ[\w-]+(?:\.[\w-]+){1,2}\b/g,'[令牌已隐藏]').replace(/\b(?:token|accessToken|Authorization|paras|signature|sign)\s*[:=]\s*["']?[^"'\s,}]+/gi,'[凭据已隐藏]').slice(0,240);}
function safeError(error){
  if(!(error instanceof CloudError))return {code:'LOCAL_SERVICE_ERROR',message:'本地服务请求未完成，请稍后重试'};
  const result={code:/^[A-Za-z0-9_.-]{1,80}$/.test(error.code)?error.code:'CLOUD_ERROR',message:safeText(error.message)};
  if(error.details&&typeof error.details==='object'){
    const details={};
    for(const key of ['startCode','stopCode','cameraId','direction'])if(typeof error.details[key]==='string')details[key]=safeText(error.details[key]);
    if(typeof error.details.stopped==='boolean')details.stopped=error.details.stopped;
    if(Number.isInteger(error.details.retryAfterSeconds)&&error.details.retryAfterSeconds>=0)details.retryAfterSeconds=error.details.retryAfterSeconds;
    if(Object.keys(details).length)result.details=details;
  }
  return result;
}
async function directoryChain(directory){
  const target=resolve(directory),anchor=parse(target).root;let current=anchor;
  for(const segment of relative(anchor,target).split(sep).filter(Boolean)){
    current=join(current,segment);const info=await lstat(current);
    if(!info.isDirectory()||info.isSymbolicLink())throw missing();
  }
}
async function secureOpen(root,file){
  if(typeof root!=='string'||!isAbsolute(root)||typeof file!=='string'||!isAbsolute(file))throw missing();
  const base=resolve(root),target=resolve(file),inside=relative(base,target);
  if(!inside||inside==='..'||inside.startsWith('..'+sep)||isAbsolute(inside))throw missing();
  let handle;
  try{
    await directoryChain(base);await directoryChain(resolve(target,'..'));
    const [baseReal,fileReal,info]=await Promise.all([realpath(base),realpath(target),lstat(target)]);
    const actual=relative(baseReal,fileReal);
    if(!info.isFile()||info.isSymbolicLink()||actual==='..'||actual.startsWith('..'+sep)||isAbsolute(actual))throw missing();
    handle=await open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const opened=await handle.stat();
    if(!opened.isFile()||opened.ino!==info.ino||opened.dev!==info.dev)throw missing();
    return {handle,size:opened.size};
  }catch{await handle?.close().catch(()=>{});throw missing();}
}
function rangeValue(value,size){
  if(value===undefined)return {status:200,start:0,end:size-1,length:size};
  const match=typeof value==='string'&&/^bytes=(\d*)-(\d*)$/.exec(value);
  if(!match||(!match[1]&&!match[2])||size===0)return null;
  let start=0,end=size-1;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return null;start=Math.max(0,size-suffix);}
  else{
    start=Number(match[1]);if(!Number.isSafeInteger(start)||start<0||start>=size)return null;
    if(match[2]){const last=Number(match[2]);if(!Number.isSafeInteger(last)||last<start)return null;end=Math.min(last,size-1);}
  }
  return {status:206,start,end,length:end-start+1};
}
async function serveFile(req,res,{path:filename,mime:contentType},root,download=false){
  const {handle,size}=await secureOpen(root,filename);let transferred=false;
  try{
    headers(res);res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Type',contentType);
    if(download)res.setHeader('Content-Disposition','attachment; filename="'+filename.split(/[\\/]/).at(-1)+'"');
    const range=rangeValue(req.headers.range,size);
    if(!range){res.writeHead(416,{'Content-Range':'bytes */'+size,'Content-Length':0});res.end();return;}
    if(range.status===206)res.setHeader('Content-Range','bytes '+range.start+'-'+range.end+'/'+size);
    res.setHeader('Content-Length',range.length);res.writeHead(range.status);
    if(req.method==='HEAD'||size===0){res.end();return;}
    const stream=handle.createReadStream({start:range.start,end:range.end,autoClose:true});
    transferred=true;stream.once('error',()=>res.destroy());res.once('close',()=>stream.destroy());stream.pipe(res);
  }finally{if(!transferred)await handle.close();}
}

/** No vault reads, listening socket or process handlers are installed when imported by tests. */
export function createLocalServer({runtime,assets,port=8791,onStopped=()=>{}}){
  if(!runtime||typeof runtime.action!=='function'||typeof assets!=='string'||!isAbsolute(assets))throw new TypeError('runtime and absolute assets directory are required');
  let closing=false,shutdownPromise,stoppingListener=false;
  const localPort=()=>server.address()?.port||port;
  const base=()=>'http://127.0.0.1:'+localPort();
  const allowedOrigins=()=>[base(),'http://localhost:'+localPort()];
  async function disposeRuntime(){
    if(shutdownPromise)return shutdownPromise;closing=true;
    shutdownPromise=(async()=>{await runtime.dispose();})();
    try{await shutdownPromise;}catch(error){closing=false;shutdownPromise=null;throw error;}
  }
  function stopListening(){
    if(stoppingListener)return;stoppingListener=true;
    server.close(()=>onStopped());server.closeIdleConnections();
  }
  const server=http.createServer(async(req,res)=>{try{
    if(!['127.0.0.1:'+localPort(),'localhost:'+localPort()].includes(req.headers.host))throw new CloudError('BAD_HOST','不允许访问此主机',403);
    if(req.headers.origin&&!allowedOrigins().includes(req.headers.origin))throw new CloudError('BAD_ORIGIN','不允许跨站访问',403);
    if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//'))throw missing();
    const url=new URL(req.url,base());
    if(url.pathname==='/health')return json(req,res,200,{ok:true,local:true,service:'ezviz',closing});
    if(url.pathname==='/shutdown'&&req.method==='POST'){
      await readJson(req);await disposeRuntime();json(req,res,200,{closing:true});stopListening();return;
    }
    if(closing)throw new CloudError('SHUTTING_DOWN','本地服务正在关闭',503);
    if(url.pathname==='/mcp'){
      if(req.method!=='POST'){headers(res);res.writeHead(405,{Allow:'POST'});return res.end();}
      let message;try{message=await readJson(req);}catch(error){if(error.code==='PAYLOAD_TOO_LARGE')throw error;const result=parseFailure();return json(req,res,result.status,result.body);}
      const result=await handleMcpMessage(message,()=>runtime.toolContext());
      if(result.body===null){headers(res);res.writeHead(result.status);return res.end();}
      return json(req,res,result.status,result.body);
    }
    if(url.pathname==='/api/camera'){
      if(req.method==='GET'){const action=url.searchParams.get('action');if(!['status','list'].includes(action))throw new CloudError('INVALID_ACTION','未知操作',400);return json(req,res,200,await runtime.action(action));}
      if(req.method!=='POST')throw new CloudError('METHOD_NOT_ALLOWED','请求方法不受支持',405);
      const body=await readJson(req);if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.action!=='string')throw new CloudError('INVALID_BODY','请求格式无效',400);
      return json(req,res,200,await runtime.action(body.action,body));
    }
    if(!['GET','HEAD'].includes(req.method))throw new CloudError('METHOD_NOT_ALLOWED','请求方法不受支持',405);
    const manifest=url.pathname.match(/^\/api\/captures\/([a-f0-9]{32})\/manifest$/)||url.pathname.match(/^\/captures\/([a-f0-9]{32})\/manifest\.json$/);
    if(manifest){const value=await runtime.captureManifest(manifest[1]);res.setHeader('Content-Disposition','attachment; filename="capture-'+manifest[1]+'.json"');return json(req,res,200,value);}
    const artifact=url.pathname.match(/^\/(?:captures|artifacts)\/([a-f0-9]{32})\/([^/]+)$/);
    if(artifact){
      if(!CAPTURE.test(artifact[2]))throw missing();
      const entry=await runtime.captureFile(artifact[1],artifact[2]);
      if(resolve(entry.path)!==resolve(runtime.captures.root,artifact[1],artifact[2]))throw missing();
      return await serveFile(req,res,{path:entry.path,mime:mime[extname(artifact[2])]},runtime.captures.root,url.searchParams.get('download')==='1');
    }
    const stream=url.pathname.match(/^\/streams\/([a-f0-9]{32})\/([^/]+)$/);
    if(stream){
      if(!STREAM.test(stream[2]))throw missing();
      const entry=await runtime.streamFile(stream[1],stream[2]);
      if(resolve(entry.path)!==resolve(runtime.streams.root,stream[1],stream[2]))throw missing();
      return await serveFile(req,res,{path:entry.path,mime:mime[extname(stream[2])]},runtime.streams.root);
    }
    // Malformed media paths never fall through into the static application directory.
    if(/^\/(?:captures|artifacts|streams|api\/captures)(?:\/|$)/.test(url.pathname))throw missing();
    let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{throw missing();}
    const filename=resolve(assets,'.'+(pathname==='/'?'/index.html':pathname));
    const extension=extname(filename);if(!Object.hasOwn(mime,extension))throw missing();
    return await serveFile(req,res,{path:filename,mime:mime[extension]},assets);
  }catch(error){if(!res.headersSent)json(req,res,error instanceof CloudError?error.status:500,safeError(error));else res.destroy();}});
  server.requestTimeout=180000;server.headersTimeout=20000;
  server.shutdown=async()=>{await disposeRuntime();stopListening();};
  return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const port=Number(process.env.EZVIZ_PORT||8791);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid EZVIZ_PORT');
  const root=fileURLToPath(new URL('../../../',import.meta.url)),baseUrl='http://127.0.0.1:'+port;
  const runtime=await createRuntime(join(root,'.local/ezviz-credentials.dpapi'),{mediaOptions:{
    ffmpeg:process.env.EZVIZ_FFMPEG||join(root,'tools/node_modules/ffmpeg-static/ffmpeg.exe'),
    captureRoot:join(root,'.local/ezviz-captures'),streamRoot:join(root,'.local/ezviz-streams'),baseUrl
  }});
  const server=createLocalServer({runtime,port,assets:fileURLToPath(new URL('../dist-local',import.meta.url)),onStopped:()=>process.exit(0)});
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'端口已被占用，请检查已有服务':'本地服务启动失败');process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log('EZVIZ 本地控制台：'+baseUrl+'  MCP：/mcp'));
  const terminate=()=>server.shutdown().catch(()=>{console.error('停止尚未确认，服务已保留，请重试停止。');});
  process.on('SIGTERM',terminate);process.on('SIGINT',terminate);
}
