export const CAPTCHA_SCRIPT='https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
export type CaptchaInstance={destroy?:()=>void;refresh?:()=>void};
export type CaptchaWindow=Window & {AliyunCaptchaConfig?:{region:string;prefix:string};initAliyunCaptcha?:(options:Record<string,unknown>)=>void};
let loading:Promise<void>|undefined;
export function loadCaptcha():Promise<void>{
 const w=window as CaptchaWindow;
 // This configuration must be set before the provider script is evaluated.
 w.AliyunCaptchaConfig={region:'cn',prefix:'1jgloq'};
 if(w.initAliyunCaptcha)return Promise.resolve();
 if(loading)return loading;
 loading=new Promise<void>((resolve,reject)=>{
  let script=document.querySelector<HTMLScriptElement>('script[data-haik-captcha]');
  if(script?.dataset.state==='failed'){script.remove();script=null;}
  const element=script||document.createElement('script');
  let finished=false;
  const finish=(error?:Error)=>{
   if(finished)return;finished=true;clearTimeout(timer);
   element.removeEventListener('load',loaded);element.removeEventListener('error',failed);
   if(error){element.dataset.state='failed';element.remove();reject(error);}else{element.dataset.state='ready';resolve();}
  };
  const loaded=()=>finish(w.initAliyunCaptcha?undefined:new Error('人机验证加载不完整，请重试'));
  const failed=()=>finish(new Error('无法加载人机验证，请检查网络后重试'));
  const timer=setTimeout(()=>finish(new Error('人机验证加载超时，请重试')),15000);
  element.addEventListener('load',loaded);element.addEventListener('error',failed);
  if(!script){element.src=CAPTCHA_SCRIPT;element.async=true;element.dataset.haikCaptcha='true';element.dataset.state='loading';document.head.appendChild(element);}
 });
 loading.catch(()=>{loading=undefined;});
 return loading;
}
