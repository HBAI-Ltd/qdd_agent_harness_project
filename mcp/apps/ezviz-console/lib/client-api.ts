export type ApiError = Error & {status?:number;code?:string;details?:{retryAfterSeconds?:number}};
export async function api<T=unknown>(action:string,data?:Record<string,unknown>):Promise<T>{
 try {
  const response=await fetch(data?'/api/camera':'/api/camera?action='+action,data?
   {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...data}),keepalive:action==='stop',signal:AbortSignal.timeout(120000)}:
   {cache:'no-store',signal:AbortSignal.timeout(30000)});
  let result:{message?:string;error?:string;code?:string;details?:{retryAfterSeconds?:number}};
  try{result=await response.json();}catch{throw new Error('服务返回格式异常，请稍后重试');}
  if(!response.ok)throw Object.assign(new Error(result.message||result.error||'请求未完成'),{status:response.status,code:result.code,details:result.details});
  return result as T;
 }catch(error){
  if(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name))throw new Error('请求超时，请检查网络后重试');
  if(error instanceof TypeError)throw new Error('无法连接本地服务，请确认摄像头控制台已启动');
  throw error;
 }
}
