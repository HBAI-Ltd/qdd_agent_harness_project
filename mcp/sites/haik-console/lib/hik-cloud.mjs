export const DIRECTIONS = Object.freeze({up:0,down:1,left:2,right:3,up_left:4,down_left:5,up_right:6,down_right:7,zoom_in:8,zoom_out:9});

export class CloudError extends Error {
  constructor(code,message,status=502,details){super(message);this.code=String(code);this.status=status;if(details)this.details=details;}
}

function outcome(value){return value?.result ?? value;}
export function checked(value,kind='hik'){
  const result=outcome(value);
  if(String(result?.code)!==(kind==='hik'?'0':'200')){
    const code=String(result?.code ?? 'INVALID_RESPONSE');
    const unauthorized=['10002','10001','401','401001','401002'].includes(code)||/未登录|登录.*(失效|过期)|token.*(invalid|expired|失效|过期)|令牌.*(失效|过期)/i.test(String(result?.msg??result?.message??''));
    throw new CloudError(code,String(result?.msg ?? result?.message ?? '云端请求未成功'),unauthorized?401:502);
  }
  return value?.result ? value.data ?? result.data : result.data;
}

export function cleanHeaders(headers={}){
  return Object.fromEntries(Object.entries(headers).filter(([k])=>!['host','connection','content-length','accept-encoding'].includes(k.toLowerCase())));
}

export class HikCloud {
  constructor(session,config={},fetcher=fetch,ptzState=new Map()){
    this.session=session;this.config=config;this.fetcher=fetcher;this.ptzState=ptzState;
  }
  /** @param {string} path @param {{method?:string,body?:unknown,headers?:Record<string,string>,timeout?:number}} options */
  async request(path,{method='GET',body,headers={},timeout=15000}={}){
    if(!path.startsWith('/api-')||path.includes('://'))throw new CloudError('INVALID_PATH','请求路径不受支持',400);
    const h={...cleanHeaders(this.config.headers),...cleanHeaders(this.session?.headers),...headers};
    if(body!==undefined)h['Content-Type']='application/json';
    const response=await this.fetcher('https://api.hikiot.com'+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout),redirect:'error'});
    if(!response.ok)throw new CloudError('HTTP_'+response.status,'海康云服务返回 HTTP '+response.status,response.status===401?401:502);
    const value=await response.json();
    return checked(value);
  }
  requireSession(){if(!this.session?.headers?.Authorization)throw new CloudError('LOGIN_REQUIRED','请先登录海康互联账号',401);}
  async verifySession(){this.requireSession();await this.request('/api-link-common/v1/account/getLoginSessionInfo');return true;}
  async zones(){this.requireSession();return await this.request('/api-device/zone/v2/listRootZone')||[];}
  async listCameras(){
    this.requireSession();const zones=await this.zones();const all=[];const seen=new Set();
    for(const zone of zones){
      for(let page=1;page<=100;page++){
        const devices=await this.request('/api-device/resource/view/v1/homePage?'+new URLSearchParams({page:String(page),size:'50',zoneId:String(zone.id)}));
        if(!Array.isArray(devices))throw new CloudError('INVALID_LIST','设备列表格式不受支持');
        for(const device of devices){for(const c of device.cameraList||[]){
          const serial=String(c.deviceSerial||device.deviceSerial||'');const channel=Number(c.channelNo);
          if(!serial||!Number.isInteger(channel))continue;const id=serial+':'+channel;if(seen.has(id))continue;seen.add(id);
          all.push({id,deviceSerial:serial,channelNo:channel,name:c.cameraName||c.channelName||c.osdName||device.deviceName||serial,
            deviceName:device.deviceName||serial,model:device.model||device.deviceType||'',zoneName:zone.name||'',online:Number(c.status??device.status)===1,
            encrypted:Number(c.isEncrypt??device.isEncrypt)===1,ptzAvailable:null});
        }}
        if(devices.length<50)break;
        if(page===100)throw new CloudError('LIST_LIMIT','列表达到分页上限，请按区域拆分后重试');
      }
    }
    return all;
  }
  async camera(id){const camera=(await this.listCameras()).find(c=>c.id===id);if(!camera)throw new CloudError('CAMERA_NOT_FOUND','该摄像头不在当前账号设备列表中',404);return camera;}
  async videoToken(camera){
    const tokens=await this.request('/api-device/app/token/v1/device/get?'+new URLSearchParams({deviceSerial:camera.deviceSerial,channelNo:String(camera.channelNo),isReplaceTalk0:'false'}));
    if(!tokens?.deviceVideoToken)throw new CloudError('VIDEO_TOKEN_MISSING','未取得通道视频授权');
    return tokens.deviceVideoToken;
  }
  async ys(path,token,params){
    if(!['/api/lapp/v2/live/address/get','/api/device/ptz/start','/api/device/ptz/stop','/api/lapp/video/by/time','/api/lapp/device/capacity'].includes(path))throw new CloudError('INVALID_PATH','不支持该视频操作',400);
    const form=new URLSearchParams({...this.config.sdk,accessToken:token,...params});
    const response=await this.fetcher('https://open.ys7.com'+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(12000),redirect:'error'});
    if(!response.ok)throw new CloudError('VIDEO_HTTP_'+response.status,'视频云服务暂不可用');
    return checked(await response.json(),'ys');
  }
  async live(id,quality=2,protocol='flv'){
    const camera=await this.camera(id);if(!camera.online)throw new CloudError('CAMERA_OFFLINE','摄像头当前离线',409);
    if(camera.encrypted)throw new CloudError('CAMERA_ENCRYPTED','设备视频已加密，需要设备验证码及兼容的加密播放器',409);
    if(!['flv','hls'].includes(protocol))throw new CloudError('INVALID_PROTOCOL','不支持的播放协议',400);
    const params={deviceSerial:camera.deviceSerial,channelNo:String(camera.channelNo),protocol:protocol==='flv'?'4':'2',type:'1',quality:String(quality===1?1:2),expireTime:'300',...(protocol==='flv'?{supportH265:'1'}:{})};
    let token=await this.videoToken(camera),data;
    try{data=await this.ys('/api/lapp/v2/live/address/get',token,params);}
    catch(error){
      // This read can encounter a stale channel authorization while the device remains listed.
      // Refresh once only after an explicit rejection; never change the requested channel.
      if(!['20001','20032'].includes(error.code))throw error;
      token=await this.videoToken(camera);data=await this.ys('/api/lapp/v2/live/address/get',token,params);
    }
    if(!data?.url||!String(data.url).startsWith('https://'))throw new CloudError('INVALID_PLAY_URL','服务未返回 HTTPS 播放地址');
    return {cameraId:camera.id,url:data.url,protocol,expiresIn:300,expireTime:data.expireTime};
  }
  async capabilities(id){
    const camera=await this.camera(id),token=await this.videoToken(camera);
    const data=await this.ys('/api/lapp/device/capacity',token,{deviceSerial:camera.deviceSerial,channelNo:String(camera.channelNo)});
    if(!data||typeof data!=='object'||Array.isArray(data))throw new CloudError('INVALID_CAPABILITIES','设备能力响应格式不受支持');
    const yes=key=>String(data[key])==='1';
    return {cameraId:id,live:{available:camera.online&&!camera.encrypted},ptz:{available:yes('support_ptz'),horizontal:yes('ptz_left_right'),vertical:yes('ptz_top_bottom')},sdPlayback:{available:yes('support_disk'),downloadSupported:yes('support_replay_download')},cloudRecording:{available:yes('support_cloud'),queryAvailable:true,calendarAvailable:false},localCapture:{available:camera.online&&!camera.encrypted,frames:true,video:true},note:'设备能力不代表已存在录像；当前令牌不支持录像月历，请按日期查询。'};
  }
  async ptz(id,direction,durationMs=300,speed=2){
    if(!Object.hasOwn(DIRECTIONS,direction))throw new CloudError('INVALID_DIRECTION','不支持该云台方向',400);
    if(!Number.isInteger(durationMs)||durationMs<100||durationMs>1000)throw new CloudError('INVALID_DURATION','移动时间必须在 100–1000 毫秒之间',400);
    if(!Number.isInteger(speed)||speed<1||speed>5)throw new CloudError('INVALID_SPEED','云台速度必须在 1–5 之间',400);
    if(!this.config.sdk?.appKey)throw new CloudError('SDK_CONFIG_MISSING','视频 SDK 配置尚未就绪',409);
    if(this.ptzState.get(id)?.stopConfirmed===false)throw new CloudError('PTZ_STOP_REQUIRED','上次停止尚未确认，请先停止云台再移动',409);
    const camera=await this.camera(id);if(!camera.online)throw new CloudError('CAMERA_OFFLINE','摄像头当前离线',409);
    let token=await this.videoToken(camera);const params={deviceSerial:camera.deviceSerial,channelNo:String(camera.channelNo),direction:String(DIRECTIONS[direction])};
    this.ptzState.set(id,{camera,token,direction,stopConfirmed:false});
    let startError;let stopError;
    try{
      try{await this.ys('/api/device/ptz/start',token,{...params,newSpeed:String(speed)});}
      catch(error){
        // A rejected channel authorization is safe to refresh. Never retry an ambiguous start timeout.
        if(error.code!=='20032')throw error;
        token=await this.videoToken(camera);this.ptzState.get(id).token=token;
        await this.ys('/api/device/ptz/start',token,{...params,newSpeed:String(speed)});
      }
      await new Promise(r=>setTimeout(r,durationMs));
    }catch(e){startError=e;}
    finally{try{await this.stop(id,direction);}catch(e){stopError=e;}}
    if(stopError)throw new CloudError('PTZ_STOP_UNCONFIRMED','停止请求未确认，请在原 App 中确认云台状态',502,{startCode:startError?.code||null,stopCode:stopError.code||stopError.name});
    if(startError){startError.details={...startError.details,cameraId:id,direction,stopped:true};throw startError;}
    return {cameraId:id,direction,durationMs,stopped:true};
  }
  async stop(id,direction){
    const previous=this.ptzState.get(id);
    direction??=previous?.direction;
    if(previous?.stopConfirmed===false)direction=previous.direction;
    if(!direction)throw new CloudError('STOP_DIRECTION_REQUIRED','没有最近移动方向，请指定要停止的方向',400);
    if(!Object.hasOwn(DIRECTIONS,direction))throw new CloudError('INVALID_DIRECTION','不支持该云台方向',400);
    // Retain authorization from the movement so stopping is not delayed by another list/token round trip.
    const camera=previous?.camera||await this.camera(id);let token=previous?.token||await this.videoToken(camera),refreshed=false;
    const params={deviceSerial:camera.deviceSerial,channelNo:String(camera.channelNo),direction:String(DIRECTIONS[direction])};
    for(let attempt=0;;attempt++){
      try{await this.ys('/api/device/ptz/stop',token,params);break;}
      catch(error){
        if(error.code==='20032'&&!refreshed){token=await this.videoToken(camera);refreshed=true;if(previous)previous.token=token;continue;}
        if(attempt>=2||!(['20008','VIDEO_HTTP_502','VIDEO_HTTP_503','VIDEO_HTTP_504'].includes(error.code)||['TimeoutError','TypeError'].includes(error.name)))throw error;
      }
    }
    if(previous)previous.stopConfirmed=true;
    return {cameraId:id,stopped:true};
  }
  async sendCode(phone,captchaVerifyParam=''){
    if(!/^1\d{10}$/.test(phone))throw new CloudError('INVALID_PHONE','请输入有效的 11 位手机号',400);
    return this.request('/api-link-saas/open/v3/sendMessage',{method:'POST',body:{phone,captchaVerifyParam},headers:{Authorization:this.config.loginAuthorization||'', 'x-seq':''}});
  }
  async login(phone,code){
    if(!/^1\d{10}$/.test(phone)||!/^\d{4,8}$/.test(code))throw new CloudError('INVALID_LOGIN','请检查手机号和验证码',400);
    if(!this.config.loginAuthorization)throw new CloudError('LOGIN_CONFIG_MISSING','登录配置尚未就绪',409);
    return this.request('/api-link-common/open/v1/codeLogin',{method:'POST',body:{phone,code},headers:{Authorization:this.config.loginAuthorization,'x-seq':''}});
  }
}
