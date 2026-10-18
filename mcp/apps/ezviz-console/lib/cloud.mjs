export const DIRECTIONS=Object.freeze({up:0,down:1,left:2,right:3,up_left:4,down_left:5,up_right:6,down_right:7,zoom_in:8,zoom_out:9});
export class CloudError extends Error{
  constructor(code,message,status=502,details){super(message);this.code=String(code);this.status=status;if(details)this.details=details;}
}
const HOST='https://open.ys7.com';
const ROUTES=new Set(['/api/lapp/token/get','/api/lapp/device/list','/api/lapp/device/camera/list','/api/lapp/v2/live/address/get','/api/lapp/device/ptz/start','/api/lapp/device/ptz/stop','/api/lapp/device/capacity','/api/lapp/video/by/time']);
function checked(value){
  if(String(value?.code)!=='200'){
    const raw=String(value?.code||'INVALID_RESPONSE'),code=/^[A-Za-z0-9_-]{1,60}$/.test(raw)?raw:'INVALID_RESPONSE';
    const messages={'10001':'萤石请求参数错误','10002':'萤石访问令牌失效，请重新连接应用','10005':'萤石应用已冻结或不可用','10011':'账号未开通所需萤石服务','10013':'当前账号没有开发者权限','10017':'萤石应用不存在','10030':'AppKey 与 AppSecret 不匹配','20002':'设备不存在','20006':'设备网络异常','20007':'设备不在线','20008':'设备响应超时','20018':'当前应用无权访问该设备','20032':'当前应用下通道不存在','60000':'设备不支持该功能','60001':'当前应用没有云台权限','60002':'云台已到上限位','60003':'云台已到下限位','60004':'云台已到左限位','60005':'云台已到右限位','60020':'设备不支持该命令'};
    throw new CloudError(code,messages[code]||'萤石开放平台请求未成功（'+code.replace(/[^A-Za-z0-9_-]/g,'').slice(0,60)+'）',code==='10002'?401:502);
  }
  return value.data;
}
export function validateCredentials(appKey,appSecret){
  if(typeof appKey!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(appKey)||typeof appSecret!=='string'||!/^[A-Za-z0-9_-]{8,256}$/.test(appSecret))throw new CloudError('INVALID_CREDENTIALS','请填写有效的 AppKey 和 AppSecret；不要填写手机号或短信验证码',400);
}
export class EzvizCloud{
  constructor(session={},config={},fetcher=fetch,ptzState=new Map(),onSession=async()=>{},now=Date.now){this.session=session;this.config=config;this.fetcher=fetcher;this.ptzState=ptzState;this.onSession=onSession;this.now=now;this.refreshing=null;}
  async form(route,params){
    if(!ROUTES.has(route))throw new CloudError('INVALID_PATH','不支持该萤石接口',400);
    let response;try{response=await this.fetcher(HOST+route,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params),signal:AbortSignal.timeout(15000),redirect:'error'});}catch{throw new CloudError('CLOUD_UNAVAILABLE','无法连接萤石开放平台，请检查网络');}
    if(!response.ok)throw new CloudError('HTTP_'+response.status,'萤石开放平台返回 HTTP '+response.status,response.status===401?401:502);
    let result;try{result=await response.json();}catch{throw new CloudError('INVALID_RESPONSE','萤石返回内容无法解析');}return checked(result);
  }
  async exchange(appKey,appSecret){
    validateCredentials(appKey,appSecret);const data=await this.form('/api/lapp/token/get',{appKey,appSecret});
    if(typeof data?.accessToken!=='string'||!data.accessToken||/[\r\n\0]/.test(data.accessToken)||!Number.isSafeInteger(Number(data.expireTime))||Number(data.expireTime)<this.now()+60000)throw new CloudError('INVALID_TOKEN','萤石未返回有效的访问令牌和到期时间');
    return {headers:{Authorization:data.accessToken},expireTime:Number(data.expireTime)};
  }
  requireSession(){if(!this.session?.headers?.Authorization)throw new CloudError('LOGIN_REQUIRED','请先在本地网页连接自己的萤石开放平台应用',401);}
  async token(force=false){
    this.requireSession();
    if(!force&&(!this.session.expireTime||this.session.expireTime>this.now()+60000))return this.session.headers.Authorization;
    if(this.refreshing)return this.refreshing;
    const previous=this.session;
    this.refreshing=(async()=>{const credentials=this.config.credentials;if(!credentials)throw new CloudError('LOGIN_REQUIRED','请重新连接萤石开放平台应用',401);const fresh=await this.exchange(credentials.appKey,credentials.appSecret);await this.onSession(fresh,previous);this.session=fresh;return fresh.headers.Authorization;})();
    try{return await this.refreshing;}finally{this.refreshing=null;}
  }
  async ys(route,token,params){
    try{return await this.form(route,{accessToken:token,...params});}
    catch(error){
      // A timed-out movement may have executed: never replay start. Read/stop calls
      // can renew an explicitly rejected token once, with no generic retry loop.
      if(error.code!=='10002'||route.startsWith('/api/lapp/device/ptz/'))throw error;
      const fresh=this.session.headers.Authorization!==token?await this.token():await this.token(true);
      return this.form(route,{accessToken:fresh,...params});
    }
  }
  async verifySession(){await this.ys('/api/lapp/device/list',await this.token(),{pageStart:'0',pageSize:'1'});return true;}
  async listCameras(){
    const token=await this.token(),rows=[],seen=new Set();
    for(let page=0;page<100;page++){
      const data=await this.ys('/api/lapp/device/list',token,{pageStart:String(page),pageSize:'50'});
      if(!Array.isArray(data))throw new CloudError('INVALID_LIST','萤石通道列表格式不受支持');
      for(const device of data){
       const deviceSerial=String(device.deviceSerial||'');if(!deviceSerial)throw new CloudError('INVALID_LIST','设备列表缺少序列号');
       const channels=await this.ys('/api/lapp/device/camera/list',token,{deviceSerial});
       if(!Array.isArray(channels))throw new CloudError('INVALID_LIST','萤石通道列表格式不受支持');
       for(const row of channels){
        const serial=String(row.deviceSerial||deviceSerial),channel=Number(row.channelNo);
        if(serial!==deviceSerial)throw new CloudError('INVALID_LIST','萤石通道与所选设备不一致');
        if(!serial||!Number.isInteger(channel)||channel<1)throw new CloudError('INVALID_LIST','萤石返回的设备或通道编号无效');
        const id=serial+':'+channel;if(seen.has(id))continue;seen.add(id);
        const flag=value=>value===1||value==='1'?true:value===0||value==='0'?false:null;
        rows.push({id,deviceSerial:serial,channelNo:channel,name:String(row.channelName||device.deviceName||serial),deviceName:String(device.deviceName||serial),model:String(device.deviceType||device.model||''),zoneName:'萤石云设备',online:flag(device.status)===false?false:flag(row.status),encrypted:flag(row.isEncrypt),ptzAvailable:null});
       }
      }
      if(data.length<50)return rows;
    }
    throw new CloudError('LIST_LIMIT','通道列表达到分页上限，请缩小账号设备范围');
  }
  async camera(id){const row=(await this.listCameras()).find(item=>item.id===id);if(!row)throw new CloudError('CAMERA_NOT_FOUND','摄像头不在当前应用有权访问的设备列表中',404);return row;}
  async videoToken(){return this.token();}
  async live(id,quality=2){
    const camera=await this.camera(id);
    if(!camera.online)throw new CloudError('CAMERA_OFFLINE','摄像头当前离线',409);
    if(camera.encrypted!==false)throw new CloudError('CAMERA_ENCRYPTED',camera.encrypted?'当前本地解码暂不支持设备加密流，请使用官方 App 播放':'尚未确认设备加密状态，请先检查官方 App 的视频加密设置',409);
    const data=await this.ys('/api/lapp/v2/live/address/get',await this.token(),{deviceSerial:camera.deviceSerial,channelNo:String(camera.channelNo),protocol:'4',type:'1',quality:String(quality===1?1:2),expireTime:'300',supportH265:'1',diserr:'1',mute:'1'});
    let url;try{url=new URL(data?.url);}catch{}
    if(!url||url.protocol!=='https:'||url.username||url.password)throw new CloudError('INVALID_PLAY_URL','萤石未返回有效的 HTTPS FLV 地址');
    return {cameraId:id,url:url.href,protocol:'flv',expiresIn:300};
  }
  async capabilities(id){
    const camera=await this.camera(id),data=await this.ys('/api/lapp/device/capacity',await this.token(),{deviceSerial:camera.deviceSerial,channelNo:String(camera.channelNo)});
    if(!data||typeof data!=='object'||Array.isArray(data))throw new CloudError('INVALID_CAPABILITIES','设备能力响应格式不受支持');
    const yes=key=>String(data[key])==='1';
    return {cameraId:id,live:{available:camera.online===true&&camera.encrypted===false},ptz:{available:yes('ptz_left_right')||yes('ptz_top_bottom'),horizontal:yes('ptz_left_right'),vertical:yes('ptz_top_bottom')},sdPlayback:{available:yes('support_disk')},cloudRecording:{queryAvailable:true,available:yes('support_cloud')},localCapture:{available:camera.online===true&&camera.encrypted===false},note:'功能以设备、令牌权限及服务开通情况为准；当前项目尚无实机联调结果。'};
  }
  async recordingCalendar(camera,month,source){
    const run=async token=>{
      const query=new URLSearchParams({deviceSerial:camera.deviceSerial,channelNo:String(camera.channelNo),recType:source==='sd'?'2':'1',queryMonth:month});
      let response;try{response=await this.fetcher(HOST+'/api/v3/open/cloud/video/exist/query/month?'+query,{headers:{accessToken:token},signal:AbortSignal.timeout(15000),redirect:'error'});}catch{throw new CloudError('CLOUD_UNAVAILABLE','无法连接萤石录像月历');}
      if(!response.ok)throw new CloudError('HTTP_'+response.status,'录像月历请求未完成');
      let body;try{body=await response.json();}catch{throw new CloudError('INVALID_CALENDAR','录像月历格式无效');}
      if(String(body?.meta?.code)!=='200')throw new CloudError(String(body?.meta?.code)==='10002'?'10002':'CALENDAR_REJECTED','萤石未返回可用录像月历，请检查设备能力和服务权限');
      if(!Array.isArray(body.data))throw new CloudError('INVALID_CALENDAR','录像月历格式无效');return body.data;
    };
    try{return await run(await this.token());}catch(error){if(error.code!=='10002')throw error;return run(await this.token(true));}
  }
  async ptz(id,direction,durationMs=300,speed=1){
    if(!Object.hasOwn(DIRECTIONS,direction))throw new CloudError('INVALID_DIRECTION','不支持的云台方向',400);
    if(!Number.isInteger(durationMs)||durationMs<100||durationMs>1000||!Number.isInteger(speed)||speed<0||speed>2)throw new CloudError('INVALID_MOTION','移动为100–1000毫秒，萤石速度为0–2',400);
    if(this.ptzState.get(id)?.stopConfirmed===false)throw new CloudError('PTZ_STOP_REQUIRED','上次停止尚未确认，请先停止云台',409);
    const camera=await this.camera(id);if(!camera.online)throw new CloudError('CAMERA_OFFLINE','摄像头当前离线',409);
    const token=await this.token();this.ptzState.set(id,{camera,token,direction,stopConfirmed:false});let startError,stopError;
    try{await this.ys('/api/lapp/device/ptz/start',token,{deviceSerial:camera.deviceSerial,channelNo:String(camera.channelNo),direction:String(DIRECTIONS[direction]),speed:String(speed)});await new Promise(resolve=>setTimeout(resolve,durationMs));}
    catch(error){startError=error;}
    finally{try{await this.stop(id,direction);}catch(error){stopError=error;}}
    if(stopError)throw new CloudError('PTZ_STOP_UNCONFIRMED','停止请求未确认，请检查原 App',502,{startCode:startError?.code||null,stopCode:stopError.code||'UNKNOWN'});
    if(startError){startError.details={cameraId:id,direction,stopped:true};throw startError;}
    return {cameraId:id,direction,durationMs,speed,stopped:true};
  }
  async stop(id,direction){
    const previous=this.ptzState.get(id);direction=previous?.stopConfirmed===false?previous.direction:direction??previous?.direction;
    if(!direction)throw new CloudError('STOP_DIRECTION_REQUIRED','请提供真实最近移动方向',400);
    if(!Object.hasOwn(DIRECTIONS,direction))throw new CloudError('INVALID_DIRECTION','不支持的停止方向',400);
    const camera=previous?.camera||await this.camera(id);let token=previous?.token||await this.token(),refreshed=false;
    for(let attempt=0;;attempt++){
      try{await this.ys('/api/lapp/device/ptz/stop',token,{deviceSerial:camera.deviceSerial,channelNo:String(camera.channelNo),direction:String(DIRECTIONS[direction])});break;}
      catch(error){
        if(error.code==='10002'&&!refreshed){token=await this.token(true);refreshed=true;if(previous)previous.token=token;continue;}
        if(attempt>=2||!['20008','HTTP_502','HTTP_503','HTTP_504'].includes(error.code))throw error;
      }
    }
    if(previous)previous.stopConfirmed=true;return {cameraId:id,stopped:true};
  }
}
