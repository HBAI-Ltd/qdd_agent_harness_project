import {createHash} from 'node:crypto';
import {ServiceError} from './cloud.mjs';

const BASE='https://mapi.shouqianba.com';
const ENDPOINTS=new Map([
  ['/v6/appUser/sendAuthCodeWithRisk','POST'],
  ['/v6/appUser/sendAuthCodeChooseRisk','POST'],
  ['/v6/appUser/loginWithAuthCodeV2','POST'],
  ['/v6/appUser/getLoginInfo','GET'],
  ['/V2/Account/get','GET'],
  ['/v6/appUser/changeLoginUser','POST'],
  ['/v6/appUser/loginWithAppToken','POST'],
  ['/v5/ucToken/refreshToken','GET'],
]);
const LOCATION_FIELDS=['device_address','latitude','longitude'];
const fail=(code,message,status=400)=>{throw new ServiceError(code,message,status);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const text=(value,max=1024)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value);

function checkedProfile(profile){
  if(!plain(profile)||!text(profile.appId,128)||!text(profile.appSecret)||typeof profile.version!=='string'||!/^\d+\.\d+\.\d+$/.test(profile.version)||!plain(profile.device))fail('NATIVE_PROFILE_INVALID','原生连接配置不完整，请重新生成本机配置');
  const {fingerprint,brand,model,name}=profile.device;
  if(!text(fingerprint,128)||!text(brand,128)||!text(model,256)||!text(name,256)||/[^\u0020-\u00ff]/u.test(profile.appId+brand+model)||!['1','2','3'].includes(profile.commonDeviceModel??'1'))fail('NATIVE_PROFILE_INVALID','原生设备配置无效，请重新生成本机配置');
  return Object.freeze({appId:profile.appId,appSecret:profile.appSecret,version:profile.version,commonDeviceModel:profile.commonDeviceModel??'1',device:Object.freeze({fingerprint,brand,model,name})});
}

/** Recovered ru4.c: sort entire value=key entries, then uppercase MD5. */
export function signNativeParams(params,appSecret){
  if(!plain(params)||!text(appSecret))fail('NATIVE_REQUEST_INVALID','原生请求参数无效');
  const values=new Map(Object.entries(params));
  values.set('appSecret',appSecret);
  const preimage=[...values].map(([key,value])=>`${value==null?'':String(value)}=${key}`).sort().join('&');
  return createHash('md5').update(preimage,'utf8').digest('hex').toUpperCase();
}

function jsonObject(body){
  if(!plain(body))fail('NATIVE_REQUEST_INVALID','原生接口需要 JSON 对象');
  try{
    // Restrict to JSON data, avoiding custom serializers and silent coercion.
    const visit=(value,ancestors=new Set())=>{
      if(value===null||typeof value==='string'||typeof value==='boolean')return;
      if(typeof value==='number'&&Number.isFinite(value))return;
      if(!Array.isArray(value)&&!plain(value))throw new Error();
      if(ancestors.has(value)||Object.hasOwn(value,'toJSON'))throw new Error();
      const next=new Set(ancestors);next.add(value);
      for(const child of Object.values(value))visit(child,next);
    };
    visit(body);
    return JSON.parse(JSON.stringify(body));
  }catch{fail('NATIVE_REQUEST_INVALID','原生请求包含无效 JSON 数据');}
}

const jsonValue=value=>value===null?'null':typeof value==='object'?JSON.stringify(value):String(value);
const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** Pure construction; contains no fetch, location lookup or credential persistence. */
export function buildNativeRequest(profile,path,{method='POST',body,token='',query={}}={},time=Date.now()){
  const config=checkedProfile(profile);
  if(ENDPOINTS.get(path)!==method)fail('INVALID_ENDPOINT','原生接口地址或请求方式无效');
  if(!plain(query)||typeof token!=='string'||/[\u0000-\u001f\u007f]/u.test(token)||token.length>16384||!Number.isSafeInteger(time)||time<0||!Number.isSafeInteger(time*1000))fail('NATIVE_REQUEST_INVALID','原生请求参数无效');
  if(method==='GET'&&body!==undefined)fail('NATIVE_REQUEST_INVALID','GET 接口不能携带请求体');
  const originalQuery=[];
  for(const [key,value] of Object.entries(query)){
    if(!text(key,128)||(key==='token'&&path!=='/V2/Account/get')||(value!=null&&!['string','number','boolean'].includes(typeof value))||(typeof value==='number'&&!Number.isFinite(value)))fail('NATIVE_REQUEST_INVALID','原生查询参数无效');
    if(value!=null)originalQuery.push([key,String(value)]);
  }
  // Existing POST query is not part of w97's JSON signature branch; reject it
  // here instead of silently transmitting an unsigned caller parameter.
  if(method==='POST'&&originalQuery.length)fail('NATIVE_REQUEST_INVALID','原生 JSON 接口不接受额外查询参数');
  const common={client_version:config.version,deviceId:config.device.fingerprint,device_model:config.commonDeviceModel,os_type:'0'};
  const timestamp=String(time*1000);
  const signParams=Object.assign(Object.create(null),{appId:config.appId,timestamp});
  let serialized;
  if(method==='POST'){
    const payload=jsonObject(body??{});
    if(path==='/v6/appUser/loginWithAuthCodeV2'&&plain(payload.uc_device)){
      if(payload.ip==null)payload.ip='';
      delete payload.uc_device.IP;
      for(const key of LOCATION_FIELDS)payload.uc_device[key]='';
    }
    serialized=JSON.stringify(payload);
    for(const [key,value] of Object.entries(payload))signParams[key]=jsonValue(value);
  }else{
    for(const [key,value] of originalQuery)signParams[key]=value;
  }
  Object.assign(signParams,common);
  const pairs=[...originalQuery,...Object.entries(common)];
  if(token)pairs.push(['token',token]);
  const url=new URL(path,BASE);
  url.search=pairs.map(([key,value])=>`${encode(key)}=${encode(value)}`).join('&');
  const headers={
    'Shouqianba-Client':'shouqianba-app-native',appId:config.appId,timestamp,
    'App-Background':'0',device_id:config.device.fingerprint,
    device_brand:config.device.brand,device_type:config.device.model,
    signature:signNativeParams(signParams,config.appSecret),
    ...(method==='POST'?{'Content-Type':'application/json; charset=UTF-8'}:{}),
  };
  return {url,init:{method,headers,...(serialized!==undefined?{body:serialized}:{}),redirect:'error'}};
}

function upstreamError(code,message,status,upstreamCode){
  const error=new ServiceError(code,message,status);
  // Preserve a bounded code for explicit endpoint-specific handling, never a
  // raw response, request, captcha, token or application profile.
  if(/^[A-Za-z0-9]{1,32}$/.test(String(upstreamCode??'')))error.upstreamCode=String(upstreamCode);
  return error;
}

export class NativeCloudClient{
  #profile;
  constructor({profile,fetcher=fetch,now=Date.now}={}){
    this.#profile=checkedProfile(profile);
    if(typeof fetcher!=='function'||typeof now!=='function')fail('NATIVE_PROFILE_INVALID','原生连接配置无效');
    this.fetcher=fetcher;this.now=now;
  }
  async request(path,options={}){
    const {url,init}=buildNativeRequest(this.#profile,path,options,this.now());
    let response;
    try{response=await this.fetcher(url,{...init,signal:AbortSignal.timeout(25000)});}
    catch{throw new ServiceError('NETWORK_ERROR','暂时无法连接收钱吧，请检查网络后重试',502);}
    if(!response?.ok)throw new ServiceError('UPSTREAM_HTTP',`收钱吧服务返回 HTTP ${Number.isInteger(response?.status)?response.status:'错误'}`,502);
    let envelope;
    try{envelope=await response.json();}catch{throw new ServiceError('UPSTREAM_FORMAT','收钱吧返回格式发生变化',502);}
    if(!plain(envelope)||(Object.hasOwn(envelope,'code')&&!['string','number'].includes(typeof envelope.code)))throw new ServiceError('UPSTREAM_FORMAT','收钱吧返回格式发生变化',502);
    const code=Object.hasOwn(envelope,'code')?String(envelope.code):null;
    if(code===null||code==='10000'){
      if(!Object.hasOwn(envelope,'data'))return envelope;
      if(envelope.data==null||envelope.data==='')return {};
      if(typeof envelope.data!=='string')return envelope.data;
      try{return JSON.parse(envelope.data);}catch{throw new ServiceError('UPSTREAM_FORMAT','收钱吧返回数据格式发生变化',502);}
    }
    if(code==='900003')throw upstreamError('AUTH_EXPIRED','收钱吧登录已过期，请重新登录',401,code);
    if(code==='900001')throw upstreamError('NATIVE_TOKEN_INVALID','收钱吧原生登录凭据已失效，请重新登录',401,code);
    throw upstreamError('UPSTREAM_REJECTED','收钱吧未接受本次原生请求',400,code);
  }
}
