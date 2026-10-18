'use client';
import {useRef,useState,type FormEvent} from 'react';
import {X,KeyRound,LockKeyhole,LoaderCircle,Link2,ExternalLink} from 'lucide-react';
import {api} from '../lib/client-api';

export default function LoginModal({connected,onClose,onConnected}:{connected:boolean;onClose:()=>void;onConnected:()=>void}){
 const [appKey,setKey]=useState(''),[appSecret,setSecret]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const locked=useRef(false);
 const connect=async(event:FormEvent)=>{
  event.preventDefault();if(locked.current)return;locked.current=true;setBusy(true);setError('');
  try{await api('connect',{appKey:appKey.trim(),appSecret:appSecret.trim()});setSecret('');onConnected();}
  catch(e){setError((e as Error).message);}
  finally{locked.current=false;setBusy(false);}
 };
 return <div className="modal-backdrop" onPointerDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}><section className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title"><button className="modal-close icon-button" aria-label="关闭配置" onClick={onClose} disabled={busy}><X size={19}/></button><span className="large-icon"><KeyRound size={26}/></span><div className="eyebrow">EZVIZ OPEN PLATFORM</div><h2 id="login-title">连接萤石应用</h2><p>{connected?'切换应用前会结束当前的本地预览和采集。':'使用自己的萤石开放平台应用凭据连接。暂时没有设备，也可先完成应用配置。'}</p><a className="setup-link" href="https://open.ys7.com/console/application.html" target="_blank" rel="noreferrer">前往官方控制台创建应用 <ExternalLink size={13}/></a><form onSubmit={connect} autoComplete="off"><label>AppKey<input autoFocus name="ezviz-app-key" autoComplete="off" placeholder="开放平台应用的 AppKey" maxLength={128} value={appKey} disabled={busy} onChange={e=>setKey(e.target.value)}/></label><label>AppSecret<input name="ezviz-app-secret" type="password" autoComplete="new-password" placeholder="仅用于本机服务连接" maxLength={256} value={appSecret} disabled={busy} onChange={e=>setSecret(e.target.value)}/></label>{error&&<div className="form-error" role="alert">{error}</div>}<button className="primary-button login-submit" type="submit" disabled={busy||!appKey.trim()||!appSecret.trim()}>{busy?<LoaderCircle size={17} className="spin"/>:<Link2 size={16}/>}连接此应用</button></form><div className="login-privacy"><LockKeyhole size={13}/> 凭据由 Windows 加密保存在本机。网页不保存密钥，MCP 不返回密钥。</div></section></div>;
}
