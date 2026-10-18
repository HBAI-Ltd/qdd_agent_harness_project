export function getCaptchaAuth(status){
 const auth=status?.auth;
 if(!['web','apk'].includes(auth?.loginSource)||typeof auth?.captcha?.sceneId!=='string'||!auth.captcha.sceneId.trim())throw new Error('本地服务未返回有效的人机验证配置，请重启收钱吧服务后刷新页面');
 return auth;
}
export function createCaptchaFlow({initialize,send,onState,onError,retryLimit=()=>2,setTimer=setTimeout,clearTimer=clearTimeout,waitMs=90000,loadMs=20000}){
 let phase='idle',generation=0,instance=null,timer=null,retries=0;
 const update=next=>{phase=next;onState(next);};
 const clear=()=>{if(timer!==null)clearTimer(timer);timer=null;};
 const fail=(id,error)=>{if(id!==generation)return;clear();generation++;instance=null;update('idle');onError(error);};
 const arm=(id,duration,text)=>{clear();timer=setTimer(()=>fail(id,new Error(text)),duration);};
 async function success(id,param,complete){
  if(id!==generation||phase!=='waiting')return;
  let acknowledged=false;
  const acknowledge=sent=>{if(acknowledged)return;acknowledged=true;try{complete?.({captchaResult:sent,bizResult:sent});}catch{}};
  clear();update('sending');
  try{
   const result=await send(param);
   if(id!==generation){acknowledge(false);return;}
   acknowledge(!!result.sent);
   if(result.retryVerification&&retries++<retryLimit()){update('waiting');arm(id,waitMs,'验证等待超时，请重新获取验证码');if(retryLimit()===1&&typeof instance.show==='function')instance.show();else instance.startTracelessVerification();return;}
   if(!result.sent)throw new Error('验证未通过，请重试');
   instance=null;generation++;update('completed');
  }catch(e){acknowledge(false);fail(id,e);}
 }
 return {get phase(){return phase;},async start(){
  if(['loading','waiting','sending'].includes(phase))return;
  const id=++generation;retries=0;instance=null;update('loading');arm(id,loadMs,'人机验证加载超时，请检查网络后重试');
  try{
   // A completed SDK instance cannot be reused for a later SMS attempt.
   const created=await initialize({success:(param,complete)=>success(id,param,complete),fail:result=>{if(id!==generation||phase!=='waiting')return;const code=captchaErrorCode(result);onError(new Error('安全验证未通过，请在当前弹窗中重试'+(code?'（'+code+'）':'')));arm(id,waitMs,'验证等待超时，请重新获取验证码');},close:reason=>{if(id!==generation||phase==='sending')return;if(reason==='userDismiss'){clear();generation++;instance=null;update('idle');}else{arm(id,10000,'验证已结束但未收到成功结果，请重新获取验证码');}},error:info=>{const code=captchaErrorCode(info);fail(id,new Error('人机验证组件加载失败，请重试'+(code?'（'+code+'）':'')));}});
   if(id!==generation)return;
   instance=created;update('waiting');arm(id,waitMs,'验证等待超时，请重新获取验证码');instance.startTracelessVerification();
  }catch(e){fail(id,e);}
 }};
}
export function captchaErrorCode(result){const code=typeof result==='string'?result:result?.code??result?.Code;return typeof code==='number'||typeof code==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(code)?String(code):'';}
