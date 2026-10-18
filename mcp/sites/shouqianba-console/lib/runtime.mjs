import {randomUUID} from 'node:crypto';
import {CloudClient,ServiceError,phone,dateRange,EDGE} from './cloud.mjs';
import {readVault,writeVault,clearVault} from './vault.mjs';
import {transactionTypes,validateTransactionType} from '../web/transaction-types.js';
import {coverageFor} from './capabilities.mjs';
import {readStoredValue} from './stored-value.mjs';

export const modules=[
  {key:'overview',name:'营业概览',state:'awaiting_login'},
  {key:'transactions',name:'交易流水',state:'awaiting_login'},
  {key:'refunds',name:'退款记录',state:'awaiting_login'},
  {key:'stores',name:'门店汇总',state:'awaiting_login'},
  {key:'products',name:'商品销量',state:'awaiting_validation'},
  {key:'inventory',name:'库存',state:'awaiting_validation'},
  {key:'gross_profit',name:'订单分析',state:'awaiting_login'},
  {key:'members',name:'顾客档案',state:'awaiting_validation'},
  {key:'stored_value_accounts',name:'储值卡账户',state:'awaiting_validation'}
];
export function redact(value){
  if(Array.isArray(value))return value.map(redact);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!/(token|password|cookie|secret|auth_code|send_id|sendId)/i.test(key)).map(([key,v])=>[key,redact(v)]));
}
export class Runtime {
  constructor({vault,client=new CloudClient(),nativeClient=null,nativeDevice=null,save=writeVault,load=readVault,clear=clearVault}={}){
    this.nativeClient=nativeClient;this.nativeDevice=nativeDevice;this.nativeStartup=false;
    this.vault=vault;this.client=client;this.save=save;this.load=load;this.clear=clear;this.session=null;this.pending=null;this.sending=false;this.loggingIn=false;this.stores=new Map();this.offsetHour=null;this.dataSeen=new Set();this.refreshing=null;this.sessionEpoch=0;this.sessionSaved=false;this.persistenceQueue=Promise.resolve();
  }
  async init(){const stored=await this.load(this.vault);if(stored?.ucToken){this.session={...stored,verified:false};this.nativeStartup=stored.authSource==='apk';this.sessionSaved=true;for(const [base,values] of stored.cookies||[])this.client.cookies.set(base,new Map(values));}return this;}
  status(){const s=this.session;return {service:'shouqianba',auth:{loginSource:this.nativeClient?'apk':'web',sessionSource:s?.ucToken?(s.authSource||'web'):null,captcha:{sceneId:this.nativeClient?'1wuucxrx':'1cq7nw11',region:'cn',prefix:'1ewi7m'}},stage:s?.verified?'authenticated':s?.ucToken?'saved_session':'signed_out',phone:s?.phone?`${s.phone.slice(0,3)}****${s.phone.slice(-4)}`:null,merchant:s?.verified?s.merchant:null,identities:s?.ucToken?(s.identities||[]).map((r,i)=>({index:i,name:r.name||r.merchant_name||r.group_name||r.brand_name||'商户身份',role:r.role|| (r.group_user_id?'group_super_admin':'未知角色')})):[],modules:modules.map(m=>({...m,state:this.dataSeen.has(m.key)?'live_verified':s?.verified&&['overview','transactions','refunds','stores','products','inventory','gross_profit','catalog','members','stored_value_accounts','stored_value_bills'].includes(m.key)?'ready_for_query':m.state})),coverage:coverageFor(this.dataSeen),persistence:{saved:this.sessionSaved,savedAt:s?.persistedAt||null},hasPendingSms:!!this.pending&&Date.now()-this.pending.createdAt<600000,lease:{expiresAt:s?.authSource==='apk'&&Number.isSafeInteger(s.expireTime)&&s.expireTime>946684800000&&s.expireTime<4102444800000?s.expireTime:null,lastVerifiedAt:s?.lastVerifiedAt||null,lastRefreshAt:s?.refreshTime||null},keepalive:this.keepaliveStatus?.()||{enabled:false},liveDataVerified:this.dataSeen.size>0};}
  async persist(){
    if(!this.session)return;
    const epoch=this.sessionEpoch,value=structuredClone({...this.session,persistedAt:Date.now(),cookies:[...this.client.cookies].map(([base,v])=>[base,[...v]])});
    const task=this.persistenceQueue.then(async()=>{
      if(epoch!==this.sessionEpoch)return;
      try{await this.save(this.vault,value);}catch{this.sessionSaved=false;throw new ServiceError('SESSION_SAVE_FAILED','登录状态未能加密保存到本机，请检查磁盘空间与当前用户的写入权限后重试',503);}
      if(epoch===this.sessionEpoch&&this.session?.ucToken===value.ucToken){this.session.persistedAt=value.persistedAt;this.sessionSaved=true;}
    });
    this.persistenceQueue=task.catch(()=>{});return task;
  }
  assertSession(epoch){if(epoch!==this.sessionEpoch||!this.session?.ucToken)throw new ServiceError('SESSION_CHANGED','账号连接已变化，请重新检查连接',409);}
  async sendCode(input){
    const number=phone(input.phone);
    if(this.sending)throw new ServiceError('SMS_BUSY','短信正在发送，请稍候',429);
    if(this.pending&&Date.now()-this.pending.createdAt<60000)throw new ServiceError('SMS_COOLDOWN','请等待60秒后重发',429);
    if(typeof input.captchaVerifyParam!=='string'||!input.captchaVerifyParam||input.captchaVerifyParam.length>24000)throw new ServiceError('CAPTCHA_REQUIRED','请先完成人机验证');
    this.sending=true;
    try{
      const riskData=JSON.stringify({version:'v2',captchaVerifyParam:input.captchaVerifyParam,sceneId:this.nativeClient?'1wuucxrx':'1cq7nw11'});
      const result=await (this.nativeClient||this.client).request(this.nativeClient?'/v6/appUser/sendAuthCodeWithRisk':'/api/login/ucUser/getRiskCode',{body:{identifier:number,riskData,scene:'auth_login'}});
      if(Number(result?.bizCode)===400)return {sent:false,retryVerification:true};
      if(Number(result?.bizCode)!==200||!result.sendId)throw new ServiceError('SMS_REJECTED','短信未发送成功，请重试验证');
      this.pending={phone:number,sendId:result.sendId,createdAt:Date.now(),authSource:this.nativeClient?'apk':'web'};
      return {sent:true,retryAfter:60};
    }finally{this.sending=false;}
  }
  async login(input){
    if(this.loggingIn)throw new ServiceError('LOGIN_BUSY','登录正在处理，请稍候',429);
    const number=phone(input.phone);
    if(!this.pending||this.pending.phone!==number||Date.now()-this.pending.createdAt>600000)throw new ServiceError('SMS_REQUIRED','请先为此手机号获取验证码');
    if(typeof input.code!=='string'||!/^\d{4,8}$/.test(input.code))throw new ServiceError('INVALID_CODE','请输入短信中的验证码');
    this.loggingIn=true;
    try{
      const native=this.pending.authSource==='apk';
      const result=native?await this.requireNative().request('/v6/appUser/loginWithAuthCodeV2',{body:{authCode:input.code,identifier:number,sendId:this.pending.sendId,scene:'auth_login',uc_device:this.nativeUcDevice()}}):await this.client.request('/api/login/ucUser/loginByCode',{loginHeaders:true,body:{username:number,auth_code:input.code,send_id:this.pending.sendId,uc_device:{device_type:2,default_device:0,platform:'商户服务平台',device_name:'收钱吧商户平台',device_model:'Windows',device_brand:'Chrome',device_fingerprint:input.fingerprint&&/^[\w-]{16,80}$/.test(input.fingerprint)?input.fingerprint:randomUUID()}}});
      if(native)this.validateNativeLogin(result);
      if(Number(result?.code)===50212)throw new ServiceError('DEVICE_AUTH_REQUIRED','该账号需要在收钱吧APP确认新设备，请先在官方商户平台完成登录');
      const token=result?.mchUserTokenInfo?.token;
      if(typeof token!=='string'||!token.trim()||result.loginUserInfos!=null&&!Array.isArray(result.loginUserInfos))throw new ServiceError('LOGIN_SCHEMA_CHANGED','登录结果没有可识别的会话，需要核对官方登录流程',502);
      if(native)this.client.cookies.clear();this.stores.clear();this.offsetHour=null;this.dataSeen.clear();
      this.sessionEpoch++;this.sessionSaved=false;this.nativeStartup=false;this.session={ucToken:token,authSource:native?'apk':'web',ucUserId:result.uc_user_id||null,phone:number,identities:result.loginUserInfos||[],verified:false,validTime:result.mchUserTokenInfo.valid_time,expireTime:result.mchUserTokenInfo.expire_time??null,refreshTime:Date.now()};
      this.pending=null;
      await this.persist();
      if(this.session.identities.length<=1)await this.checkSession();
      return this.status();
    }finally{this.loggingIn=false;}
  }
  requireToken(){if(!this.session?.ucToken)throw new ServiceError('LOGIN_REQUIRED','请先在网页登录收钱吧',401);return this.session.ucToken;}
  requireNative(){if(!this.nativeClient)throw new ServiceError('NATIVE_PROFILE_REQUIRED','此会话需要本机的 App 连接配置，请恢复配置后检查连接',503);return this.nativeClient;}
  nativeUcDevice(){
    this.requireNative();const d=this.nativeDevice;
    if(!d?.fingerprint)throw new ServiceError('NATIVE_PROFILE_REQUIRED','本机 App 设备配置不可用',503);
    return {device_type:1,device_name:d.name,device_brand:d.brand,device_model:d.model,platform:'收钱吧APP',device_fingerprint:d.fingerprint};
  }
  validateNativeLogin(result){
    const code=String(result?.code??'');
    if(code==='20034')throw new ServiceError('DEVICE_AUTH_REQUIRED','收钱吧要求原有设备确认本次登录，当前不能仅凭短信完成连接',409);
    if(['20041','20043'].includes(code))throw new ServiceError('ADDITIONAL_AUTH_REQUIRED','收钱吧要求额外身份验证，当前短信登录尚未完成',409);
    if(code==='20033')throw new ServiceError('MERCHANT_ACCOUNT_REQUIRED','此账号还需在收钱吧完成商户设置',409);
    if(code&&code!=='10000')throw new ServiceError('LOGIN_REJECTED','收钱吧未接受本次登录，请检查验证码或重新获取',400);
  }
  async restoreNativeStartup(){
    if(!this.nativeStartup)return;
    const epoch=this.sessionEpoch,token=this.requireToken();
    try{
      if(token.length>40)await this.refreshToken();
      else{
        const result=await this.requireNative().request('/v6/appUser/loginWithAppToken',{token,body:{token,uc_device:this.nativeUcDevice()}});this.assertSession(epoch);this.validateNativeLogin(result);
        const next=result?.mchUserTokenInfo?.token;
        if(typeof next!=='string'||!next.trim())throw new ServiceError('SESSION_REFRESH_UNAVAILABLE','尚未取得 App 登录恢复结果，已保留本机记录',502);
        this.session={...this.session,ucToken:next,ucUserId:result.uc_user_id||this.session.ucUserId,identities:result.loginUserInfos||this.session.identities,validTime:result.mchUserTokenInfo.valid_time,expireTime:result.mchUserTokenInfo.expire_time??null,refreshTime:Date.now()};await this.persist();
      }
      this.nativeStartup=false;
    }catch(e){if(['AUTH_EXPIRED','NATIVE_TOKEN_INVALID'].includes(e.code)&&epoch===this.sessionEpoch)await this.disconnect();throw e;}
  }
  async authenticated(path,options={}){
    this.requireToken();
    const epoch=this.sessionEpoch,wasVerified=this.session.verified;let usedToken;
    const {nativeAuth=false,...requestOptions}=options;
    const request=async()=>{this.assertSession(epoch);usedToken=this.requireToken();const client=nativeAuth?this.requireNative():this.client;const body=nativeAuth&&requestOptions.body&&Object.hasOwn(requestOptions.body,'token')?{...requestOptions.body,token:usedToken}:requestOptions.body;const result=await client.request(path,{...requestOptions,...(body!==undefined?{body}:{}),token:usedToken,query:{...requestOptions.query,...(requestOptions.queryToken===false?{}:{token:usedToken})}});this.assertSession(epoch);return result;};
    // Web sessions verify first. App startup recovery follows its separate SDK path.
    try{return await request();}
    catch(e){
      if(e.code==='NATIVE_TOKEN_INVALID'){if(epoch===this.sessionEpoch)await this.disconnect();throw e;}
      if(e.code==='AUTH_EXPIRED'&&!nativeAuth&&this.session?.authSource==='apk'){
        // A web data service rejecting an App token does not revoke its native lease.
        await this.checkNativeSession();
        throw new ServiceError('DATA_AUTH_UNVERIFIED','App 登录有效，但此经营数据接口尚未接受该会话，需要继续核对 App 数据接口',409);
      }
      if(e.code!=='AUTH_EXPIRED')throw e;this.assertSession(epoch);this.session.verified=false;
      try{if(usedToken===this.session.ucToken)await this.refreshToken();const result=await request();this.session.verified=wasVerified;return result;}
      catch(f){if(['AUTH_EXPIRED','NATIVE_TOKEN_INVALID'].includes(f.code)&&epoch===this.sessionEpoch){console.warn('[session] '+new Date().toISOString()+' auth rejected after recovery; clearing rejected session');await this.disconnect();}throw f;}
    }
  }
  async refreshToken(){
    if(this.refreshing)return this.refreshing;
    const epoch=this.sessionEpoch,token=this.requireToken();
    const task=(async()=>{
      const native=this.session.authSource==='apk';
      const result=native?await this.requireNative().request('/v5/ucToken/refreshToken',{method:'GET',token,query:{threshold:86400}}):await this.client.request('/api/login/ucUser/refreshToken',{token,query:{token}});this.assertSession(epoch);
      if(result?.status!==undefined&&result?.status!==null&&['0',...(native?['1']:[])].includes(String(result.status)))throw new ServiceError('AUTH_EXPIRED','收钱吧确认登录已失效，请重新进行短信登录',401);
      if(Number(result?.status)!==2||typeof result.token!=='string'||!result.token.trim())throw new ServiceError('SESSION_REFRESH_UNAVAILABLE','暂未取得有效的登录刷新结果，已保留本机登录记录，请稍后检查连接',502);
      this.sessionSaved=false;this.session={...this.session,ucToken:result.token,refreshTime:Date.now(),validTime:result.valid_time,expireTime:result.expire_time??null};await this.persist();
    })();
    this.refreshing=task;try{return await task;}finally{if(this.refreshing===task)this.refreshing=null;}
  }
  async checkSession(){
    if(this.session?.authSource==='apk')return this.checkNativeSession();
    const epoch=this.sessionEpoch;
    const current=await this.authenticated('/api/login/ucUser/getCurrentUser',{method:'GET'});
    this.assertSession(epoch);
    if(!current?.trade_user_info)throw new ServiceError('MERCHANT_SELECTION_REQUIRED','请选择商户身份，或先在官方商户平台完成账号设置');
    const trade=current.trade_user_info;
    this.session={...this.session,verified:true,businessToken:current.token,context:{role:trade.role,merchant_id:trade.merchant_id,merchant_user_id:trade.merchant_user_id,group_id:trade.group_id,group_user_id:trade.group_user_id,brand_user_id:trade.brand_user_id},merchant:{name:current.loginUserInfo?.name||current.loginUserInfo?.brand_name||'当前商户',merchantId:trade.merchant_id||null,merchantSn:trade.merchant_sn||null,role:trade.role||(trade.group_user_id?'group_super_admin':trade.brand_user_id?'brand_super_admin':'未知角色')}};
    await this.persist();return this.status();
  }
  async checkNativeSession(){
    const epoch=this.sessionEpoch;await this.restoreNativeStartup();
    const current=await this.authenticated('/V2/Account/get',{method:'GET',nativeAuth:true});this.assertSession(epoch);
    const admin=current?.admin,merchant=current?.merchant;
    if(!admin||typeof admin!=='object'||!(admin.merchant_id||merchant?.id||admin.group_user_id))throw new ServiceError('MERCHANT_SELECTION_REQUIRED','请选择收钱吧商户身份，当前尚未获得商户信息',409);
    const selected=this.session.selectedIdentity||(this.session.identities?.length===1?this.session.identities[0]:null);
    const context={role:admin.role,merchant_id:admin.merchant_id||merchant?.id,merchant_user_id:admin.merchant_user_id||selected?.merchant_user_id,group_id:admin.group_id,group_user_id:admin.group_user_id};
    this.session={...this.session,verified:true,lastVerifiedAt:Date.now(),context,merchant:{name:merchant?.name||admin.merchant_name||current.group?.name||'当前商户',merchantId:context.merchant_id||null,merchantSn:admin.merchant_sn||merchant?.sn||null,role:admin.role||(admin.group_user_id?'group_super_admin':'未知角色')}};
    await this.persist();return this.status();
  }
  async keepAlive(){
    if(!this.session?.ucToken||this.session.authSource!=='apk')return {skipped:true};
    if(this.nativeStartup)return this.checkSession();
    const epoch=this.sessionEpoch;
    try{await this.refreshToken();this.assertSession(epoch);return await this.checkSession();}
    catch(e){if(['AUTH_EXPIRED','NATIVE_TOKEN_INVALID'].includes(e.code)&&epoch===this.sessionEpoch)await this.disconnect();throw e;}
  }
  async chooseIdentity(input){
    this.requireToken();
    if(!Number.isInteger(input.index)||!this.session.identities?.[input.index])throw new ServiceError('INVALID_IDENTITY','请选择列表中的商户身份');
    const identity=this.session.identities[input.index];
    if(this.session.authSource==='apk'){
      if(identity.brand_user_id||identity.group_user_id)throw new ServiceError('IDENTITY_UNSUPPORTED','此 App 集团或品牌身份的原生切换流程尚未验证，请选择普通商户身份',409);
      const id=identity.merchant_user_id;
      if(!id)throw new ServiceError('IDENTITY_SCHEMA_CHANGED','App 商户身份格式需要核对');
      // The SDK models this response as dtc (empty); it keeps the existing token.
      await this.authenticated('/v6/appUser/changeLoginUser',{nativeAuth:true,queryToken:false,body:{merchantUserId:id,token:this.requireToken()}});
      this.session.selectedIdentity=identity;this.sessionEpoch++;this.session.verified=false;this.stores.clear();this.offsetHour=null;this.dataSeen.clear();await this.persist();return this.checkSession();
    }
    let method='chooseLoginUser',query={merchantUserId:identity.merchant_user_id},body={merchantUserId:identity.merchant_user_id};
    if(identity.brand_user_id){method='chooseLoginBrandUser';query={brandUserId:identity.brand_user_id};body=undefined;}
    else if(identity.group_user_id){method='chooseLoginGroupUser';query={groupUserId:identity.group_user_id};body={groupUserId:identity.group_user_id};}
    if(!Object.values(query)[0])throw new ServiceError('IDENTITY_SCHEMA_CHANGED','商户身份格式需要核对');
    await this.authenticated('/api/login/ucUser/'+method,{query,body,loginHeaders:true});
    this.sessionEpoch++;this.session.verified=false;this.stores.clear();this.offsetHour=null;this.dataSeen.clear();return this.checkSession();
  }
  async disconnect(){this.sessionEpoch++;this.sessionSaved=false;this.session=null;this.pending=null;this.refreshing=null;this.client.cookies.clear();this.stores.clear();this.offsetHour=null;this.dataSeen.clear();await this.persistenceQueue;await this.clear(this.vault);return this.status();}
  async readInventory(input={}){
    if(typeof input.storeId!=='string'||!input.storeId)throw new ServiceError('STORE_REQUIRED','库存请先选择一家门店，不将各店库存直接相加');
    const stores=await this.authenticated('/v4/uf4b-app/multi/terminal/retail/merchant/findUserStores',{base:EDGE,queryToken:false});
    if(!Array.isArray(stores))throw new ServiceError('DATA_SCHEMA_CHANGED','零售门店返回结构需要核对',502);
    const store=stores.find(s=>String(s.store_id)===input.storeId);
    if(!store)throw new ServiceError('RETAIL_STORE_UNAVAILABLE','该门店未出现在当前账号的零售模块授权列表中',403);
    const body={storeId:store.store_id,bizOwner:{code:'SMART',scene:'retail'}};
    const permission=await this.authenticated('/v4/uf4b-app/multi/terminal/user/authorize/queryUserAuthorize',{base:EDGE,queryToken:false,body:{...body,dataScene:'goods_stock_sensitive'}});
    if(typeof permission?.has_permission!=='boolean')throw new ServiceError('DATA_SCHEMA_CHANGED','库存成本权限返回结构需要核对',502);
    const data=await this.authenticated('/v4/uf4b-app/multi/terminal/stock/queryTotalStock',{base:EDGE,queryToken:false,body});
    if(typeof data?.total_stock!=='number'||!Number.isFinite(data.total_stock))throw new ServiceError('DATA_SCHEMA_CHANGED','库存总量字段需要核对',502);
    const costAllowed=permission.has_permission;
    if(costAllowed&&!(typeof data.total_price==='number'&&Number.isFinite(data.total_price)||typeof data.total_price==='string'))throw new ServiceError('DATA_SCHEMA_CHANGED','库存价值字段需要核对',502);
    this.dataSeen.add('inventory');
    return {kind:'inventory',records:[{storeName:store.store_name,totalStock:data.total_stock,...(costAllowed?{stockValue:data.total_price}:{})}],total:1,page:1,pageSize:1,hasMore:false,costAllowed,scope:{store:{id:String(store.store_id),name:store.store_name},moneyUnit:'fen'},notes:[costAllowed?'当前账号具备库存成本查看权限，库存价值按原字段返回':'当前账号无库存成本查看权限，仅返回数量，不返回库存价值','此处为零售库存汇总，不是库存明细/流水；数量单位以商品基础单位为准，不将混合单位解释为单一件数'],source:'/v4/uf4b-app/multi/terminal/stock/queryTotalStock',verifiedAt:new Date().toISOString()};
  }
  async readCatalog(input={}){
    if(typeof input.storeId!=='string'||!input.storeId)throw new ServiceError('STORE_REQUIRED','商品档案请先选择一家门店');
    const page=input.page??1,pageSize=input.pageSize??20;
    if(!Number.isInteger(page)||page<1||page>10000||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new ServiceError('INVALID_PAGE','页码或每页数量无效');
    if(input.keyword!==undefined&&(typeof input.keyword!=='string'||input.keyword.length>100))throw new ServiceError('INVALID_SEARCH','商品关键词最长100字');
    const stores=await this.authenticated('/v4/uf4b-app/multi/terminal/retail/merchant/findUserStores',{base:EDGE,queryToken:false});
    if(!Array.isArray(stores))throw new ServiceError('DATA_SCHEMA_CHANGED','商品门店返回结构需要核对',502);
    const store=stores.find(s=>String(s.store_id)===input.storeId);
    if(!store)throw new ServiceError('RETAIL_STORE_UNAVAILABLE','该门店不在当前账号商品模块授权列表中',403);
    const body={storeId:store.store_id,bizOwner:{code:'SMART',scene:'retail'}};
    const permission=await this.authenticated('/v4/uf4b-app/multi/terminal/user/authorize/queryUserAuthorize',{base:EDGE,queryToken:false,body:{...body,dataScene:'goods_stock_sensitive'}});
    if(typeof permission?.has_permission!=='boolean')throw new ServiceError('DATA_SCHEMA_CHANGED','商品成本权限返回结构需要核对',502);
    const data=await this.authenticated('/v4/uf4b-app/multi/terminal/retail/product/page_v2x',{base:EDGE,queryToken:false,body:{...body,page,pageSize,needStock:true,queryTerms:input.keyword?{searchKeyword:input.keyword}:{}}});
    if(!Array.isArray(data?.records)||!Number.isFinite(Number(data.total)))throw new ServiceError('DATA_SCHEMA_CHANGED','商品档案返回结构需要核对',502);
    const records=data.records.map(r=>{const p=r.template_props;if(!p||typeof p!=='object')throw new ServiceError('DATA_SCHEMA_CHANGED','商品属性需要核对',502);return {spuId:String(r.spu_id),skuId:String(r.sku_id),title:p.title,barcode:p.barcode,price:p.price,memberPrice:p.member_price,unit:p.unit,saleStatus:p.sale_status,stockQuantity:p.stock?.quantity,...(permission.has_permission?{purchasePrice:p.purchase_price,costPrice:p.cost_price}:{})};});
    this.dataSeen.add('catalog');
    return {kind:'catalog',records,total:Number(data.total),page,pageSize,hasMore:page*pageSize<Number(data.total),costAllowed:permission.has_permission,scope:{store:{id:String(store.store_id),name:store.store_name},moneyUnit:'fen'},notes:['商品档案为当前门店商品/服务，销量请在商品销售查询','库存数量缺失时显示未提供，不当作零；成本按当前账号权限展示'],verifiedAt:new Date().toISOString()};
  }
  async readData(kind,input={}){
    this.requireToken();
    if(!this.session.verified)await this.checkSession();
    if(['members','member_detail','stored_value_accounts','stored_value_detail','stored_value_issuers','stored_value_bills','stored_value_bill_detail'].includes(kind))return readStoredValue(this,kind,input);
    const supported=['stores','transactions','refunds','overview','products','gross_profit','inventory','transaction_detail','catalog'];
    if(!supported.includes(kind))throw new ServiceError('DATA_ADAPTER_PENDING','此模块仍在核实接口和数据口径，当前没有已验证的数据',409);
    if(kind==='inventory')return this.readInventory(input);
    if(kind==='catalog')return this.readCatalog(input);
    if(kind==='transaction_detail'){
      if(typeof input.orderSn!=='string'||!input.orderSn||input.orderSn.length>160||!/^[-\w]+$/.test(input.orderSn))throw new ServiceError('INVALID_ORDER','订单号无效，请使用流水返回的订单号');
      const body={order_sn:input.orderSn},query={client_version:'7.0.0'};
      const [order,transactions]=await Promise.all([this.authenticated('/api/orderStatement/getOrderDetail',{query,body}),this.authenticated('/api/transaction/getTransactionListByOrderSn',{query,body})]);
      if(!order||typeof order!=='object'||Array.isArray(order)||!Array.isArray(transactions))throw new ServiceError('DATA_SCHEMA_CHANGED','订单详情返回结构需要核对',502);
      this.dataSeen.add(kind);
      return {kind,order:redact(order),transactions:redact(transactions).map(r=>({...r,transactionTypeLabel:transactionTypes[r.type]||'未知业务类型('+r.type+')'})),scope:{moneyUnit:'fen'},notes:['支付订单与关联收款/退款记录；商品服务明细按业务订单另行查询'],verifiedAt:new Date().toISOString()};
    }
    const page=input.page??1,pageSize=input.pageSize??(kind==='overview'?100:20);
    if(!Number.isInteger(page)||page<1||page>10000||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new ServiceError('INVALID_PAGE','页码或每页数量无效');
    const transactionType=validateTransactionType(kind,input.transactionType);
    if(transactionType===null||input.transactionType!==undefined&&!['transactions','refunds'].includes(kind))throw new ServiceError('INVALID_TRANSACTION_TYPE','此交易类型不适用于当前查询');
    const query={client_version:'7.0.0'};
    if(kind==='stores'){
      const data=await this.authenticated('/api/findStores',{query,body:{page,page_size:pageSize}});
      if(!Array.isArray(data?.records)||!Number.isFinite(Number(data.total)))throw new ServiceError('DATA_SCHEMA_CHANGED','门店列表格式需要核对',502);
      const coordinate=(v,min=-180,max=180)=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))&&Number(v)>=min&&Number(v)<=max?Number(v):null;
      const rows=data.records.map(r=>({id:String(r.id),sn:String(r.sn),name:r.name,address:r.province&&r.street_address?.startsWith(r.province)?r.street_address:[r.province,r.city,r.district,r.street_address].filter(Boolean).join(''),province:r.province||null,city:r.city||null,district:r.district||null,location:{longitude:coordinate(r.longitude),latitude:coordinate(r.latitude,-90,90),coordinateSystem:'unspecified',source:'merchant_profile'}}));
      for(const row of rows)this.stores.set(row.id,row);
      this.dataSeen.add(kind);
      return {kind,records:rows,total:Number(data.total),page,pageSize,hasMore:page*pageSize<Number(data.total),source:'/api/findStores',verifiedAt:new Date().toISOString()};
    }
    const range=dateRange(input.start,input.end);
    let selectedStore;
    if(input.storeId){
      if(typeof input.storeId!=='string'||input.storeId.length>120)throw new ServiceError('INVALID_STORE','门店无效');
      if(!this.stores.has(input.storeId))await this.readData('stores',{page:1,pageSize:100});
      selectedStore=this.stores.get(input.storeId);
      if(!selectedStore)throw new ServiceError('UNKNOWN_STORE','请先查询包含此门店的门店列表页，再使用返回的门店ID');
    }
    if(this.offsetHour===null){
      const config=await this.authenticated('/v4/merchantGray/query',{base:EDGE,method:'GET',query:{...query,type:'3'}});
      const value=Number.parseInt(config?.value,10)||0;
      if(value<0||value>23)throw new ServiceError('OFFSET_SCHEMA_CHANGED','营业日起算时间需要核对',502);
      this.offsetHour=value;
    }
    const startMs=Date.parse(range.start+'T00:00:00+08:00')+this.offsetHour*3600000;
    const endMs=Date.parse(range.end+'T00:00:00+08:00')+this.offsetHour*3600000+86400000-1;
    const scope={timezone:'Asia/Shanghai',start:range.start,end:range.end,businessDayStartsAt:`${String(this.offsetHour).padStart(2,'0')}:00`,startMs,endMs,store:selectedStore||null,moneyUnit:'fen'};
    if(kind==='transactions'||kind==='refunds'){
      const body={upayQueryType:0,page,page_size:pageSize,date_start:startMs,date_end:endMs,show_fund_state:true,...(selectedStore?{store_sn:selectedStore.sn}:{}),...(transactionType?{type:transactionType}:{})};
      const data=await this.authenticated('/api/transaction/findTransactions',{query,body});
      if(!Array.isArray(data?.records)||!Number.isFinite(Number(data.total)))throw new ServiceError('DATA_SCHEMA_CHANGED','交易流水格式需要核对',502);
      this.dataSeen.add(kind);
      return {kind,records:redact(data.records).map(r=>({...r,transactionTypeLabel:transactionTypes[r.type]||'未知交易类型('+r.type+')'})),total:Number(data.total),page,pageSize,hasMore:page*pageSize<Number(data.total),scope:{...scope,transactionType:transactionType||null},notes:[kind==='refunds'?`当前仅${transactionType==='11'?'普通退款':transactionTypes[transactionType]}(type=${transactionType})，保留成功/处理中/失败状态；没有合并其他退款类型`:'移动支付交易(upayQueryType=0)，包括付款、记账、储值充值/核销等类型；银行卡交易尚未接入','储值充值、核销、次卡和记账分别列示，不将所有流水金额相加作为营业收入','金额原始单位为分；本页不是整个区间汇总'],source:'/api/transaction/findTransactions',verifiedAt:new Date().toISOString()};
    }
    const ctx=this.session.context;
    if(!ctx?.merchant_id||!ctx?.merchant_user_id)throw new ServiceError('MERCHANT_CONTEXT_REQUIRED','营业概览目前需要普通商户身份，请在上方选择商户；集团和品牌报表待接入',409);
    const body={source:'msp',role:ctx.role,offsetHour:this.offsetHour,tMode:'day',tDimension:'merchant',tStartDate:startMs,tEndDate:endMs,page:kind==='overview'?1:page,pageSize:kind==='overview'?100:pageSize,merchant_user_id:ctx.merchant_user_id,merchant_id:ctx.merchant_id,...(selectedStore?{storeIds:selectedStore.id}:{})};
    if(kind==='products'||kind==='gross_profit'){
      const path=kind==='products'?'/v4/data-report/statistics/getGoodsReportSummaryList':'/v4/data-report/statistics/getOrdersReportSummaryList';
      const data=await this.authenticated(path,{base:EDGE,query,body});
      if(!Array.isArray(data?.records)||!Number.isFinite(Number(data.total)))throw new ServiceError('DATA_SCHEMA_CHANGED','商品或毛利报表结构需要核对',502);
      const returnedPage=Number(data.page??page),returnedPageSize=Number(data.pageSize??pageSize);
      if(!Number.isInteger(returnedPage)||returnedPage<1||!Number.isInteger(returnedPageSize)||returnedPageSize<1)throw new ServiceError('DATA_SCHEMA_CHANGED','报表分页参数需要核对',502);
      this.dataSeen.add(kind);
      return {kind,records:redact(data.records),total:Number(data.total),page:returnedPage,pageSize:returnedPageSize,hasMore:returnedPage*returnedPageSize<Number(data.total),scope:{...scope,profitRateUnit:'upstream_display_string'},notes:['金额原始单位为分，数值字符串按分换算；脱敏/不可用占位符保持原样','毛利额、毛利率来自收钱吧报表；毛利不是净利润，不代表已扣除房租、人工、税费等经营费用','毛利率保留上游展示值，不自动乘100；商品成本录入和计算口径仍需与官方报表核对'],source:path,verifiedAt:new Date().toISOString()};
    }
    const data=await this.authenticated('/v4/account_report_v2/getAccountRecordReportSummaryList',{base:EDGE,query,body});
    if(!Array.isArray(data?.records)||data.records.length>1||!Number.isFinite(Number(data.total)))throw new ServiceError('DATA_SCHEMA_CHANGED','营业报表格式需要核对',502);
    const rows=data.records[0]?.accountSummaryReport;
    if(data.records.length&& !Array.isArray(rows))throw new ServiceError('DATA_SCHEMA_CHANGED','营业汇总字段需要核对',502);
    this.dataSeen.add(kind);
    return {kind,records:redact(rows||[]),total:Number(data.total),page:1,pageSize:100,hasMore:Number(data.total)>100,scope,summaryTitle:data.records[0]?.summaryShowTitle,notes:['按日汇总；paymentAmount为付款金额，receivedAmount为实收口径；清算金额与利润不同','金额原始单位为分'],source:'/v4/account_report_v2/getAccountRecordReportSummaryList',verifiedAt:new Date().toISOString()};
  }
}
