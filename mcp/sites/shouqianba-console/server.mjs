import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {timingSafeEqual} from 'node:crypto';
import {networkInterfaces,hostname} from 'node:os';
import {openLocalRuntime} from './lib/local-runtime.mjs';
import {ServiceError} from './lib/cloud.mjs';
import {SessionKeeper} from './lib/session-keeper.mjs';
import {recordMaintenance} from './lib/maintenance-log.mjs';
import {mcpMessage} from './lib/mcp.mjs';

const root=process.env.SQB_STATE_DIR||fileURLToPath(new URL('../../.local/shouqianba/',import.meta.url));
const port=Number(process.env.SQB_PORT||8788);
const listenAddress=process.env.SQB_HOST||'127.0.0.1';
const mcpHosts=new Set([`${hostname()}:${port}`,...Object.values(networkInterfaces()).flat().filter(x=>x.family==='IPv4').map(x=>`${x.address}:${port}`)]);
await mkdir(root,{recursive:true});
const {credentials,runtime}=await openLocalRuntime(root);
const {keys:{mcp:mcpKey,browser:browserKey}}=credentials.snapshot();
const keeper=new SessionKeeper({runtime,record:entry=>recordMaintenance(root+'/keepalive-history.json',entry)});runtime.keepaliveStatus=()=>keeper.status();
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
async function readJson(req,objectOnly=true){
 if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new ServiceError('JSON_REQUIRED','请求必须为JSON',415);
 let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)throw new ServiceError('BODY_TOO_LARGE','请求过大',413);chunks.push(chunk);}
 try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(objectOnly&&(!value||typeof value!=='object'||Array.isArray(value)))throw new Error();return value;}catch{throw new ServiceError('INVALID_JSON','JSON格式无效');}
}
let authBusy=false;
export const server=http.createServer(async(req,res)=>{
 try{
  const origins=[`http://127.0.0.1:${port}`,`http://localhost:${port}`];
  const remoteMcp=listenAddress==='0.0.0.0'&&req.url?.split('?')[0]==='/mcp'&&mcpHosts.has(req.headers.host);
  if(!origins.map(x=>new URL(x).host).includes(req.headers.host)&&!remoteMcp)throw new ServiceError('BAD_HOST','主机不被允许',403);
  if(req.headers.origin&&!origins.includes(req.headers.origin))throw new ServiceError('BAD_ORIGIN','跨站请求不被允许',403);
  const url=new URL(req.url,origins[0]);
  if((url.pathname.startsWith('/api/')||url.pathname==='/mcp')&&req.headers['sec-fetch-site']==='cross-site')throw new ServiceError('CROSS_SITE','跨站请求不被允许',403);
  if(url.pathname==='/health'&&req.method==='GET')return json(res,200,{ok:true,service:'shouqianba',local:true});
  if(url.pathname==='/mcp'){
   if(!equal(req.headers.authorization,`Bearer ${mcpKey}`))throw new ServiceError('MCP_AUTH_REQUIRED','MCP访问需要本地密钥',401);
   if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});return res.end();}
   let message;try{message=await readJson(req,false);}catch(e){if(e.code!=='INVALID_JSON')throw e;return json(res,200,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
   const result=await mcpMessage(message,runtime);if(result.body===null){res.writeHead(result.status);return res.end();}return json(res,result.status,result.body);
  }
  if(url.pathname.startsWith('/api/')){
   const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('sqb_local='))?.slice(10);
   if(!equal(cookie,browserKey))throw new ServiceError('LOCAL_SESSION_REQUIRED','请刷新本地控制台页面',401);
   if(req.method==='GET'&&url.pathname==='/api/status')return json(res,200,runtime.status());
   if(req.method==='GET'&&url.pathname==='/api/analysis'){
    runtime.requireToken();if(!runtime.session.verified)await runtime.checkSession();
    let report;try{report=JSON.parse(await readFile(root+'/analysis/report.json','utf8'));}catch{throw new ServiceError('ANALYSIS_PENDING','尚未生成经营分析报告',409);}
    if(!report.merchantId||String(report.merchantId)!==String(runtime.session.merchant?.merchantId))throw new ServiceError('ANALYSIS_IDENTITY_MISMATCH','报告所属商户与当前身份不同，请重新生成报告',403);
    return json(res,200,report);
   }
   if(req.method!=='POST')throw new ServiceError('METHOD_NOT_ALLOWED','请求方式无效',405);
   const body=await readJson(req);
   const actions={'/api/auth/sms':()=>runtime.sendCode(body),'/api/auth/login':()=>runtime.login(body),'/api/auth/check':()=>runtime.checkSession(),'/api/auth/identity':()=>runtime.chooseIdentity(body),'/api/auth/disconnect':()=>runtime.disconnect()};
   if(actions[url.pathname]){
    if(authBusy)throw new ServiceError('AUTH_BUSY','登录操作正在处理，请稍候',429);
    authBusy=true;try{return json(res,200,await actions[url.pathname]());}finally{authBusy=false;}
   }
   if(url.pathname==='/api/data')return json(res,200,await runtime.readData(body.kind,body));
   throw new ServiceError('NOT_FOUND','接口不存在',404);
  }
  const staticFiles={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/session.js':['session.js','text/javascript; charset=utf-8'],'/captcha-flow.js':['captcha-flow.js','text/javascript; charset=utf-8'],'/transaction-types.js':['transaction-types.js','text/javascript; charset=utf-8'],'/money.js':['money.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
  Object.assign(staticFiles,{'/lab':['analysis.html','text/html; charset=utf-8'],'/analysis.js':['analysis.js','text/javascript; charset=utf-8'],'/analysis.css':['analysis.css','text/css; charset=utf-8'],'/analysis-case.json':['../cases/multi-source-business-review.json','application/json; charset=utf-8']});
  const file=staticFiles[url.pathname];
  if(!file||!['GET','HEAD'].includes(req.method))throw new ServiceError('NOT_FOUND','页面不存在',404);
  const data=await readFile(new URL('web/'+file[0],import.meta.url));
  if(url.pathname==='/'||url.pathname==='/lab')res.setHeader('Set-Cookie',`sqb_local=${browserKey}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
  res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});res.end(req.method==='HEAD'?undefined:data);
 }catch(e){if(!res.headersSent)json(res,e.status||500,{code:e.code||'SERVICE_ERROR',message:e.code?e.message:'本地服务请求失败，请稍后重试',...(/^[A-Za-z0-9]{1,32}$/.test(e.upstreamCode||'')?{upstreamCode:e.upstreamCode}:{})});else res.end();}
});
server.requestTimeout=60000;server.headersTimeout=15000;
server.listen(port,listenAddress,()=>{console.log(`收钱吧经营台 http://${listenAddress}:${port}`);void keeper.start();});
server.on('close',()=>keeper.stop());
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'收钱吧端口已被占用':'本地服务启动失败');process.exitCode=1;});
