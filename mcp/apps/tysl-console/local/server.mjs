import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRuntime} from './runtime.mjs';
import {CloudError} from '../lib/cloud.mjs';
import {handleMcpMessage} from '../lib/mcp.mjs';

export function createConsoleServer({runtime,port,assets,onClosed=()=>{}}){
const baseUrl='http://127.0.0.1:'+port;
let closing=false;
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.m3u8':'application/vnd.apple.mpegurl','.ts':'video/mp2t'};
function headers(res){res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');if(!res.hasHeader('Cross-Origin-Resource-Policy'))res.setHeader('Cross-Origin-Resource-Policy','same-origin');}
function mediaHeaders(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Range');
  res.setHeader('Access-Control-Expose-Headers','Content-Length, Content-Range');
  res.setHeader('Cross-Origin-Resource-Policy','cross-origin');
}
function json(res,status,value){headers(res);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
async function artifact(req,res,entry){
  const {size}=await stat(entry.path);let start=0,end=size-1,status=200;
  headers(res);res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Type',entry.mime);
  if(req.headers.range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':'bytes */'+size});return res.end();}
    if(!match[1])start=Math.max(0,size-Number(match[2]));
    else {start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),size-1);}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start){res.writeHead(416,{'Content-Range':'bytes */'+size});return res.end();}
    status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Length',size?end-start+1:0);res.writeHead(status);
  if(req.method==='HEAD'||size===0)return res.end();
  const stream=createReadStream(entry.path,{start,end});stream.once('error',()=>res.destroy());res.once('close',()=>stream.destroy());stream.pipe(res);
}
async function body(req){let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>16384)throw new CloudError('PAYLOAD_TOO_LARGE','请求过大',413);parts.push(chunk);}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new CloudError('INVALID_JSON','请求格式无效',400);}}
function safeError(error){return error instanceof CloudError?{code:error.code,message:String(error.message).replace(/https?:\/\/\S+/g,'[地址已隐藏]').replace(/\beyJ[\w-]+(?:\.[\w-]+){1,2}\b/g,'[令牌已隐藏]').slice(0,240)}:{code:'LOCAL_SERVICE_ERROR',message:'本地服务请求未完成，请稍后重试'};}
const server=http.createServer(async(req,res)=>{try{
  const currentPort=server.address()?.port||port;
  const localOrigins=['http://127.0.0.1:'+currentPort,'http://localhost:'+currentPort];
  if(!['127.0.0.1:'+currentPort,'localhost:'+currentPort].includes(req.headers.host))throw new CloudError('BAD_HOST','不允许访问此主机',403);
  const url=new URL(req.url,baseUrl);
  const stream=url.pathname.match(/^\/streams\/([a-f0-9]{32})\/(index\.m3u8|seg_[0-9]{6,12}\.ts)$/);
  const mediaRequest=!!stream&&['GET','HEAD','OPTIONS'].includes(req.method);
  // The task page runs at another origin (or an opaque sandbox origin). Only
  // bounded HLS artifacts are public media; account and control APIs stay local.
  if(mediaRequest)mediaHeaders(res);
  if(req.headers.origin&&!mediaRequest&&!localOrigins.includes(req.headers.origin))throw new CloudError('BAD_ORIGIN','不允许跨站访问',403);
  if(mediaRequest&&req.method==='OPTIONS'){headers(res);res.writeHead(204);return res.end();}
  if(url.pathname==='/health')return json(res,200,{ok:true,local:true,service:'tysl'});
  if(closing)throw new CloudError('SHUTTING_DOWN','本地服务正在关闭',503);
  if(url.pathname==='/shutdown'&&req.method==='POST'){
    await body(req);closing=true;json(res,200,{closing:true});
    try{await runtime.dispose();server.close(onClosed);server.closeIdleConnections();}catch{closing=false;}
    return;
  }
  if(url.pathname==='/mcp'){
    if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});return res.end();}
    let message;try{message=await body(req);}catch(error){if(error.code==='PAYLOAD_TOO_LARGE')throw error;return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
    const result=await handleMcpMessage(message,runtime);
    if(result.body===null){res.writeHead(result.status);return res.end();}
    return json(res,result.status,result.body);
  }
  if(url.pathname==='/api/status'&&req.method==='GET')return json(res,200,await runtime.status());
  if(url.pathname==='/api/login/complete'&&req.method==='POST'){
    if(!localOrigins.includes(req.headers.origin)||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new CloudError('BAD_ORIGIN','请从本机控制台提交官方返回地址',403);
    const value=await body(req);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['state','callbackUrl'].includes(key))||typeof value.state!=='string'||!/^[a-f0-9]{32}$/.test(value.state)||typeof value.callbackUrl!=='string')throw new CloudError('INVALID_BODY','登录提交格式无效',400);
    const candidate=await runtime.auth.finish(value.state,value.callbackUrl);
    await runtime.acceptLogin(candidate);
    return json(res,200,{ok:true});
  }
  if(url.pathname==='/api/action'&&req.method==='POST'){
    const value=await body(req);if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.action!=='string')throw new CloudError('INVALID_BODY','请求格式无效',400);
    return json(res,200,await runtime.action(value.action,value));
  }
  if(!['GET','HEAD'].includes(req.method))throw new CloudError('METHOD_NOT_ALLOWED','请求方法不受支持',405);
  const manifest=url.pathname.match(/^\/api\/captures\/([a-f0-9]{32})\/manifest$/);
  if(manifest){const value=await runtime.captureManifest(manifest[1]);res.setHeader('Content-Disposition','attachment; filename="capture-'+manifest[1]+'.json"');return json(res,200,value);}
  const capture=url.pathname.match(/^\/captures\/([a-f0-9]{32})\/([^/]+)$/);
  if(capture)return await artifact(req,res,await runtime.captureFile(capture[1],capture[2]));
  let file,type;
  if(stream){const entry=runtime.streams.getFile(stream[1],stream[2]);file=entry.path;type=entry.mime;}
  else{
    file=path.resolve(assets,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(!file.startsWith(assets))throw new CloudError('NOT_FOUND','页面不存在',404);
    type=mime[path.extname(file)]||'application/octet-stream';
  }
  let data;try{data=await readFile(file);}catch{throw new CloudError('NOT_FOUND','资源不存在',404);}
  headers(res);res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'self'");
  res.writeHead(200,{'Content-Type':type});res.end(req.method==='HEAD'?undefined:data);
}catch(error){if(!res.headersSent)json(res,error instanceof CloudError?error.status:500,safeError(error));else res.end();}});
server.requestTimeout=180000;server.headersTimeout=20000;
let terminating=false;
async function shutdown(){if(terminating)return;terminating=true;closing=true;try{await runtime.dispose();server.close(onClosed);server.closeIdleConnections();}catch{terminating=false;closing=false;}}
return {server,shutdown};
}

async function main(){
  const port=Number(process.env.TYSL_PORT||8790);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid TYSL_PORT');
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  const assets=fileURLToPath(new URL('../public/',import.meta.url));
  const baseUrl='http://127.0.0.1:'+port;
  const runtime=await createRuntime({vault:path.join(root,'.local/tysl-credentials.dpapi'),pendingVault:path.join(root,'.local/tysl-pending.dpapi'),ffmpeg:process.env.TYSL_FFMPEG||path.join(root,'tools/node_modules/ffmpeg-static/ffmpeg.exe'),streamRoot:path.join(root,'.local/tysl-streams'),captureRoot:path.join(root,'.local/tysl-captures'),baseUrl});
  const {server,shutdown}=createConsoleServer({runtime,port,assets,onClosed:()=>process.exit(0)});
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'天翼视联本地端口已被占用':'天翼视联本地服务启动失败');process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log('天翼视联本地控制台：'+baseUrl+'  MCP：/mcp'));
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
