'use client';
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {X,Smartphone,LockKeyhole,LoaderCircle,Link2,RefreshCw} from 'lucide-react';
import {api,type ApiError} from '../lib/client-api';
import {loadCaptcha,type CaptchaInstance,type CaptchaWindow} from '../lib/captcha-loader';
export default function LoginModal({connected,onClose,onConnected}:{connected:boolean;onClose:()=>void;onConnected:()=>void}){
 const [phone,setPhone]=useState(''),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[waiting,setWaiting]=useState(false),[error,setError]=useState(''),[sent,setSent]=useState(false),[cooldown,setCooldown]=useState(0),[captchaReady,setCaptchaReady]=useState(false),[captchaFailed,setCaptchaFailed]=useState(false),[revision,setRevision]=useState(0);
 const pendingPhone=useRef(''),captcha=useRef<CaptchaInstance|null>(null),alive=useRef(true),locked=useRef(false),phoneRef=useRef(phone),verified=useRef<{param:string;at:number}|null>(null);
 useEffect(()=>{phoneRef.current=phone;},[phone]);
 const restartCaptcha=useCallback(()=>{setCaptchaReady(false);setCaptchaFailed(false);setRevision(n=>n+1);},[]);
 const sendSms=useCallback(async(number:string,param:string)=>{
  verified.current=null;setWaiting(false);setBusy(true);
  try{await api('send_code',{phone:number,captchaVerifyParam:param});if(alive.current){setSent(true);setCooldown(60);}}
  catch(e){if(alive.current){setError((e as Error).message);const retry=(e as ApiError).details?.retryAfterSeconds;if(retry)setCooldown(retry);}}
  finally{locked.current=false;if(alive.current){setBusy(false);restartCaptcha();}}
 },[restartCaptcha]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{
  let active=true;let timer:ReturnType<typeof setTimeout>|undefined;
  const fail=(message:string)=>{if(!active)return;clearTimeout(timer);pendingPhone.current='';locked.current=false;setWaiting(false);setBusy(false);setCaptchaReady(false);setCaptchaFailed(true);setError(message);};
  void loadCaptcha().then(()=>{
   if(!active)return;
   timer=setTimeout(()=>fail('人机验证初始化超时，请重试'),15000);
   try{(window as CaptchaWindow).initAliyunCaptcha?.({
    SceneId:'lcrd581l',mode:'embed',element:'#haik-captcha',button:'#haik-captcha-trigger',slideStyle:{width:320,height:40},
    getInstance:(instance:CaptchaInstance)=>{if(!active){instance.destroy?.();return;}clearTimeout(timer);captcha.current=instance;setCaptchaReady(true);},
    success:async(param:string)=>{
     if(!active)return;
     if(typeof param!=='string'||!param){fail('人机验证未返回有效结果，请重试');return;}
     if(!pendingPhone.current){verified.current={param,at:Date.now()};return;}
     const number=pendingPhone.current;pendingPhone.current='';
     if(number!==phoneRef.current){locked.current=false;setWaiting(false);setError('手机号已更改，请重新获取验证码');restartCaptcha();return;}
     await sendSms(number,param);
    },
    fail:()=>{if(!active)return;pendingPhone.current='';locked.current=false;setWaiting(false);setError('请完成人机验证后重试');},
    onError:()=>fail('人机验证暂不可用，请重试'),
   });}catch{fail('人机验证初始化失败，请重试');}
  },e=>fail(e.message));
  return()=>{active=false;clearTimeout(timer);pendingPhone.current='';verified.current=null;captcha.current?.destroy?.();captcha.current=null;};
 },[revision,restartCaptcha,sendSms]);
 useEffect(()=>{if(!cooldown)return;const timer=setTimeout(()=>setCooldown(n=>Math.max(0,n-1)),1000);return()=>clearTimeout(timer);},[cooldown]);
 const send=()=>{
  if(locked.current||cooldown||!captchaReady)return;
  setError('');if(!/^1\d{10}$/.test(phone)){setError('请输入有效的 11 位手机号');return;}
  locked.current=true;
  if(verified.current&&Date.now()-verified.current.at<60000){void sendSms(phone,verified.current.param);return;}
  if(verified.current){verified.current=null;restartCaptcha();}
  pendingPhone.current=phone;setWaiting(true);
  document.getElementById('haik-captcha-trigger')?.click();
 };
 const login=async(event:FormEvent)=>{
  event.preventDefault();if(locked.current)return;
  setError('');if(!/^1\d{10}$/.test(phone)){setError('请输入有效的 11 位手机号');return;}
  if(!/^\d{4,8}$/.test(code)){setError('请输入 4–8 位短信验证码');return;}
  locked.current=true;setBusy(true);
  try{await api('login',{phone,code});if(alive.current)onConnected();}
  catch(e){if(alive.current)setError((e as Error).message);}
  finally{locked.current=false;if(alive.current)setBusy(false);}
 };
 return <div className="modal-backdrop" onPointerDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}><section className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title"><button className="modal-close icon-button" aria-label="关闭登录" onClick={onClose} disabled={busy}><X size={19}/></button><span className="large-icon"><Smartphone size={26}/></span><div className="eyebrow">CLOUD CONNECTION</div><h2 id="login-title">连接海康互联</h2><p>{connected?'当前会话已连接。需要更换或续接账号时，可使用短信登录。':'使用手机号和短信验证码连接云端摄像头。'}</p><form onSubmit={login}><label>手机号码<input autoFocus autoComplete="tel" inputMode="tel" placeholder="请输入手机号" maxLength={11} value={phone} disabled={busy||waiting} onChange={e=>{setPhone(e.target.value.replace(/\D/g,''));setSent(false);}}/></label><div className="captcha-wrap" id="haik-captcha"/><button type="button" id="haik-captcha-trigger" className="captcha-trigger" tabIndex={-1} aria-hidden="true"/>{!captchaReady&&!captchaFailed&&<p role="status">正在加载人机验证…</p>}{captchaFailed&&<button type="button" className="text-button" onClick={()=>{setError('');restartCaptcha();}}><RefreshCw size={13}/> 重试人机验证</button>}<label>短信验证码<div className="code-field"><input inputMode="numeric" autoComplete="one-time-code" placeholder="请输入验证码" maxLength={8} value={code} disabled={busy||waiting} onChange={e=>setCode(e.target.value.replace(/\D/g,''))}/><button type="button" onClick={send} disabled={busy||waiting||cooldown>0||!captchaReady}>{cooldown>0?cooldown+' 秒后重发':waiting?'请完成人机验证':sent?'重新获取':'获取验证码'}</button></div></label>{waiting&&<button className="text-button" type="button" onClick={()=>{pendingPhone.current='';locked.current=false;setWaiting(false);restartCaptcha();}}>取消验证</button>}{error&&<div className="form-error" role="alert">{error}</div>}<button className="primary-button login-submit" type="submit" disabled={busy||waiting||!/^1\d{10}$/.test(phone)||!/^\d{4,8}$/.test(code)}>{busy?<LoaderCircle size={17} className="spin"/>:<Link2 size={16}/>}登录并连接</button></form><div className="login-privacy"><LockKeyhole size={13}/> 令牌由 Windows 加密保存在本机，验证码不写入日志。</div></section></div>;
}
