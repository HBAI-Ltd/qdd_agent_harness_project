export class ServiceError extends Error {
  constructor(code,message,status=400){super(message);this.code=code;this.status=status;}
}
export const CGI='https://web-platforms-msp.shouqianba.com';
export const EDGE='https://mapi.shouqianba.com';
const AUTH_EXPIRED=new Set([50201,50210,900003,900001]);
export class CloudClient {
  constructor(fetcher=fetch){this.fetcher=fetcher;this.cookies=new Map();}
  async request(path,{base=CGI,method='POST',body,token='',query={},loginHeaders=false}={}){
    if(![CGI,EDGE].includes(base)||!path.startsWith('/')||path.startsWith('//'))throw new ServiceError('INVALID_ENDPOINT','接口地址无效');
    const url=new URL(path,base);
    for(const [key,value] of Object.entries(query))if(value!==undefined&&value!==null)url.searchParams.set(key,String(value));
    const headers={'Content-Type':'application/json','Accept':'application/json','Origin':'https://s.shouqianba.com','Referer':'https://s.shouqianba.com/'};
    if(token)headers.Authorization=`Bearer ${token}`;
    if(loginHeaders)Object.assign(headers,{appId:'shouqianbaMsp',sub_appid:'sqb'});
    const cookies=this.cookies.get(base);if(cookies?.size)headers.Cookie=[...cookies].map(([k,v])=>`${k}=${v}`).join('; ');
    let response;
    try{response=await this.fetcher(url,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000),redirect:'error'});}
    catch{throw new ServiceError('NETWORK_ERROR','暂时无法连接收钱吧，请检查网络后重试',502);}
    for(const line of response.headers.getSetCookie?.()||[]){const part=line.split(';')[0],index=part.indexOf('=');if(index>0){if(!this.cookies.has(base))this.cookies.set(base,new Map());this.cookies.get(base).set(part.slice(0,index),part.slice(index+1));}}
    if(!response.ok)throw new ServiceError('UPSTREAM_HTTP',`收钱吧服务返回 HTTP ${response.status}`,502);
    let envelope;try{envelope=await response.json();}catch{throw new ServiceError('UPSTREAM_FORMAT','收钱吧返回格式发生变化',502);}
    if(AUTH_EXPIRED.has(Number(envelope.code)))throw new ServiceError('AUTH_EXPIRED','收钱吧登录已过期，请重新登录',401);
    if(![10000,50000].includes(Number(envelope.code)))throw new ServiceError('UPSTREAM_REJECTED',String(envelope.message||envelope.msg||'收钱吧未接受本次请求').slice(0,250),400);
    return envelope.data;
  }
}
export function phone(value){if(typeof value!=='string'||!/^1\d{10}$/.test(value))throw new ServiceError('INVALID_PHONE','请输入11位手机号');return value;}
export function dateRange(start,end){
  const valid=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+'T00:00:00+08:00'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
  if(!valid(start)||!valid(end)||start>end)throw new ServiceError('INVALID_RANGE','请选择有效的起止日期');
  if(Date.parse(end)-Date.parse(start)>31*86400000)throw new ServiceError('RANGE_TOO_LARGE','每次最多查询32天，请缩小日期范围');
  return {start,end};
}
