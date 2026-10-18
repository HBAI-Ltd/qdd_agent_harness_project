import {readFile} from 'node:fs/promises';
import {createCipheriv,createDecipheriv,createHmac,createPublicKey,publicEncrypt,randomBytes,randomUUID,constants} from 'node:crypto';

const config=JSON.parse(await readFile(new URL('./protocol-config.json',import.meta.url),'utf8'));
const publicDer=Buffer.from(config.publicKey,'base64');
const rsaKey=createPublicKey({key:publicDer,type:'spki',format:'der'});
const signedFields=new Set(['X-TIMESTAMP','X-NONCE','X-ENTRY-KEY','Authorization','body']);

export class CloudError extends Error{
  constructor(code,message,status=502){super(message);this.code=String(code);this.status=status;}
}

export function signature(headers,body){
  const values={...headers,...(body?{body}:{})};
  const canonical=Object.keys(values).sort().filter(key=>signedFields.has(key)).map(key=>key+values[key]).join('');
  return createHmac('sha256',publicDer).update(canonical).digest('hex');
}

export function encryptedRequest(body,{token,role,clientVersion='4.0.8'}={}){
  const key=randomBytes(32),iv=randomBytes(16);
  const cipher=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(body),'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');
  const headers={
    Accept:'application/json', 'Content-Type':'application/json;charset=UTF-8',
    'Cache-Control':'no-cache',reqId:randomUUID(),
    'X-APP-ID':config.appId,'X-CLIENT-TYPE':'1','X-API-VERSION':'1.0',
    'X-TIMESTAMP':String(Date.now()),'X-NONCE':iv.toString('base64'),'X-ENC-ALG':'1',
    'X-ENTRY-KEY':publicEncrypt({key:rsaKey,padding:constants.RSA_PKCS1_PADDING},Buffer.from(key.toString('base64'),'utf8')).toString('base64'),
    'X-CLIENT-VERSION':clientVersion,'X-CLIENT-VERSION-ID':'108',
    'X-TRACE-ID':randomUUID(),'X-CLIENT-MODEL':'local-console','X-OS-VERSION':'1.0'
  };
  if(token)headers.Authorization=token;
  if(role?.roleId!==undefined)headers['X-ROLE-ID']=String(role.roleId);
  if(role?.id!==undefined)headers['X-USER-ROLE-ID']=String(role.id);
  headers['X-SIGNATURE']=signature(headers,ciphertext);
  return {headers,body:ciphertext,key,iv};
}

function decodeResponse(text,key,iv){
  let wire;
  try{wire=JSON.parse(text);}catch{wire=text.trim();}
  // Gateways may return an unencrypted error before request authentication.
  if(wire&&typeof wire==='object')return wire;
  if(typeof wire!=='string'||!wire.length||wire.length>12*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(wire))throw new CloudError('INVALID_RESPONSE','云端响应格式不受支持');
  try{
    const bytes=Buffer.from(wire,'base64');
    if(bytes.length<16)throw new Error('short ciphertext');
    const decipher=createDecipheriv('aes-256-gcm',key,iv,{authTagLength:16});
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0,-16)),decipher.final()]).toString('utf8'));
  }catch{throw new CloudError('INVALID_RESPONSE','无法验证云端加密响应');}
}

export class TyslCloud{
  constructor({token,role}={},fetcher=fetch){this.token=token;this.role=role;this.fetcher=fetcher;}
  async post(path,body={},{envelope=false}={}){
    if(!/^\/(?:user-center|device-center|application-center|origin|thirdParty)\/[A-Za-z0-9_./-]+$/.test(path)||path.includes('..'))throw new CloudError('INVALID_PATH','接口路径不受支持',400);
    const request=encryptedRequest(body,{token:this.token,role:this.role});
    try{
      let response;
      try{response=await this.fetcher(config.baseUrl+path,{method:'POST',headers:request.headers,body:request.body,signal:AbortSignal.timeout(20000),redirect:'error'});}
      catch{throw new CloudError('CLOUD_UNREACHABLE','暂时无法连接天翼视联云服务');}
      if(!response.ok)throw new CloudError('HTTP_'+response.status,'云端返回 HTTP '+response.status,response.status===401?401:502);
      const value=decodeResponse(await response.text(),request.key,request.iv);
      if(String(value?.code)!=='0'){
        const message=String(value?.msg||value?.message||'云端请求未完成').slice(0,180);
        const expired=/token|未登录|重新登录|登录.*(?:失效|过期)/i.test(message);
        throw new CloudError(value?.code??'INVALID_RESPONSE',message,expired?401:502);
      }
      return envelope?value:value.data;
    }finally{request.key.fill(0);}
  }
  async listDevices(){
    this.listWarnings=[];
    const devices=new Map((await this.listIndexDevices()).map(item=>[String(item.deviceCode),item]));
    try{
      for(const item of await this.listCascadeDevices()){
        const id=String(item.deviceCode),existing=devices.get(id);
        devices.set(id,existing?{...item,...existing,_regionName:'自有与分享 · 来自级联'}:item);
      }
    }catch(error){
      if(devices.size===0)throw error;
      this.listWarnings=['级联目录暂未加载，当前仅显示已取得的自有与分享设备。'];
    }
    return [...devices.values()];
  }
  async listIndexDevices(){
    const devices=new Map();let lastOne,sortField;
    for(let page=0;page<100;page++){
      const data=await this.post('/device-center/application/app/homePage/v2/index-list',{
        option:0,pageSize:100,...(lastOne?{lastOne}:{}),...(sortField?{sortField}:{})
      });
      if(!Array.isArray(data?.returnList))throw new CloudError('INVALID_LIST','设备列表格式不受支持');
      for(const item of data.returnList)if(item?.deviceCode)devices.set(String(item.deviceCode),item);
      if(data.isLastPage===true||data.returnList.length===0)return [...devices.values()];
      if(typeof data.lastOne!=='string'||!data.lastOne||data.lastOne===lastOne)throw new CloudError('INVALID_CURSOR','设备分页未取得有效游标');
      lastOne=data.lastOne;
      if(typeof data.sortField==='string')sortField=data.sortField;
    }
    throw new CloudError('LIST_LIMIT','设备分页达到上限');
  }
  async listCascadeDevices(){
    const route='/device-center/application/app/homePage/region/';
    const root=await this.post(route+'getRegionWithList',{treeType:'2',regionType:0,useType:0});
    if(!Array.isArray(root))throw new CloudError('INVALID_REGION_LIST','级联目录格式不受支持');
    const queue=root.map(node=>({node,depth:0})),seen=new Set(),devices=new Map();
    while(queue.length){
      const {node,depth}=queue.shift();
      if(!node||!['number','string'].includes(typeof node.id)||(typeof node.id==='number'&&!Number.isSafeInteger(node.id)))throw new CloudError('INVALID_REGION','级联目录标识无效');
      const id=String(node.id);
      if(!id||id.length>256)throw new CloudError('INVALID_REGION','级联目录标识无效');
      if(seen.has(id))continue;
      seen.add(id);
      if(seen.size>256||depth>16)throw new CloudError('REGION_LIMIT','级联目录超过本地读取上限');
      if(node.havDevice===1){
        let fetched=0;
        for(let pageNo=1;pageNo<=100;pageNo++){
          const data=await this.post(route+'getDeviceList',{
            treeType:'2',regionId:id,...(typeof node.regionCode==='string'&&node.regionCode?{regionCode:node.regionCode}:{}),
            isIotDevice:0,hasChildDevices:0,isTraversal:0,pageNo,pageSize:100
          });
          if(!Array.isArray(data?.deviceBaseInfoVOS)||!Number.isSafeInteger(data.total)||data.total<0)throw new CloudError('INVALID_REGION_DEVICES','级联设备列表格式不受支持');
          for(const item of data.deviceBaseInfoVOS)if(item?.deviceCode)devices.set(String(item.deviceCode),{...item,deviceScope:'C',_regionName:'来自级联'});
          fetched+=data.deviceBaseInfoVOS.length;
          if(data.deviceBaseInfoVOS.length===0||fetched>=data.total)break;
          if(pageNo===100)throw new CloudError('LIST_LIMIT','级联设备分页达到上限');
        }
      }
      if(node.hasChildren===true){
        const children=await this.post(route+'getRegionWithList',{treeType:'2',regionId:id,regionType:0,useType:0});
        if(!Array.isArray(children))throw new CloudError('INVALID_REGION_LIST','级联子目录格式不受支持');
        for(const child of children)queue.push({node:child,depth:depth+1});
      }
    }
    return [...devices.values()];
  }
  async supported(deviceCode){return this.post('/device-center/application/media/support/protocol',{deviceCode});}
  async live(deviceCode,mediaType=1){
    const data=await this.post('/device-center/application/media/live',{deviceCode,outProtocol:3,mediaType});
    if(typeof data?.streamUrl!=='string')throw new CloudError('NO_STREAM','云端没有返回直播地址');
    let url;try{url=new URL(data.streamUrl);}catch{throw new CloudError('INVALID_STREAM','云端直播地址格式无效');}
    if(!['rtsp:','rtsps:','https:','http:'].includes(url.protocol))throw new CloudError('UNSUPPORTED_STREAM','云端直播协议暂不支持');
    return {url:data.streamUrl};
  }
  async move(deviceCode,direction,action,speed){
    const commands={up:'UP',down:'DOWN',left:'LEFT',right:'RIGHT'};
    if(!Object.hasOwn(commands,direction)||![0,1].includes(action)||!Number.isInteger(speed)||speed<1||speed>7)throw new CloudError('INVALID_PTZ','云台参数无效',400);
    return this.post('/device-center/application/device/control/ptz/execute',{deviceCode,action,ptzCmd:commands[direction],speed});
  }
}
