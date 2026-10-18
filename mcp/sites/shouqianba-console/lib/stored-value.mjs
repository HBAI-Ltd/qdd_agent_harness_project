import {EDGE,ServiceError} from './cloud.mjs';
import {redact} from './runtime.mjs';
const prefix='/v4/marketing-saas-prepaid-card/';
export const storedOrderTypes={RELOAD:'充值',REDEEM:'消费',REDEEM_REFUND:'消费退款',MANUAL_IMPORT:'手工导入',RELOAD_REFUND:'储值退款',TRANSFER_OUT:'转出'};
const id=value=>typeof value==='string'&&/^[-\w]{1,160}$/.test(value);
const fail=()=>{throw new ServiceError('DATA_SCHEMA_CHANGED','储值卡返回结构需要核对',502);};
export async function storedIssuers(runtime){
 const owners=await runtime.authenticated(prefix+'storedOwner/queryStoredMerchant',{base:EDGE,body:{}});
 if(!Array.isArray(owners))fail();
 return owners.map(o=>({id:String(o.storedIssuerId),name:o.name,stores:Array.isArray(o.effectiveStoreList)?o.effectiveStoreList.map(s=>({id:String(s.storeId),name:s.storeName})):[]}));
}
export async function readStoredValue(runtime,kind,input){
 if(kind==='member_detail'){
  if(!id(input.userId))throw new ServiceError('INVALID_CUSTOMER','顾客ID无效');
  const member=await runtime.authenticated('/v4/member-identity/member-info/queryMemberInfo',{base:EDGE,body:{userId:input.userId}});
  if(!member||typeof member!=='object'||Array.isArray(member))fail();
  return {kind,member:redact(member),verifiedAt:new Date().toISOString()};
 }
 if(kind==='members'){
  const page=input.page??1,size=input.pageSize??20;
  if(!Number.isInteger(page)||page<1||!Number.isInteger(size)||size<1||size>100)throw new ServiceError('INVALID_PAGE','页码或每页数量无效');
  if(input.cursor!==undefined&&(typeof input.cursor!=='string'||!/^\d{1,30}$/.test(input.cursor)))throw new ServiceError('INVALID_CURSOR','请使用上一页返回的nextCursor');
  if(page>1&&!input.cursor)throw new ServiceError('CURSOR_REQUIRED','顾客翻页需要上一页返回的nextCursor');
  if(input.phone!==undefined&&(typeof input.phone!=='string'||!(/^(?:1\d{10}|\d{4})$/.test(input.phone))))throw new ServiceError('INVALID_PHONE','顾客搜索请输入完整手机号或后4位');
  const records=await runtime.authenticated('/v4/member-identity/member-info/'+(input.phone?'queryMembersByCellphone':'pageQueryMembersWithRecentlyConsume'),{base:EDGE,body:input.phone?{segmentId:input.cursor||null,size,cellphone:input.phone}:{segmentId:input.cursor||'0',size}});
  if(!Array.isArray(records))fail();
  const hasMore=records.length===size,nextCursor=hasMore?String((input.phone?records[0]:records.at(-1))?.segmentId):null;
  if(hasMore&&!/^\d{1,30}$/.test(nextCursor))fail();
  runtime.dataSeen.add(kind);
  return {kind,records:redact(records),total:null,page,pageSize:size,hasMore,nextCursor,scope:{timeRange:'当前顾客档案，按上游游标顺序'},notes:['当前接口未提供顾客总数；每页记录数不代表顾客总数','顾客标签按上游档案展示；无标签不等于没有储值余额'],verifiedAt:new Date().toISOString()};
 }
 const owners=await storedIssuers(runtime);
 if(kind==='stored_value_issuers')return {kind,records:owners,total:owners.length,page:1,pageSize:owners.length,hasMore:false,verifiedAt:new Date().toISOString()};
 const owner=input.issuerId?owners.find(o=>o.id===input.issuerId):owners.length===1?owners[0]:null;
 if(!owner)throw new ServiceError(owners.length?'STORED_ISSUER_REQUIRED':'STORED_VALUE_UNAVAILABLE',owners.length?'请选择储值方案（issuerId取储值方案列表）':'当前账号没有可读取的储值方案',409);
 const call=(path,body)=>runtime.authenticated(prefix+path,{base:EDGE,body:{storedIssuerId:owner.id,...body}});
 const scope={issuer:owner,stores:owner.stores,moneyUnit:'fen',timeRange:'累计至查询时点；不受营业日期筛选影响'};
 if(kind==='stored_value_detail'){
  if(!id(input.userId))throw new ServiceError('INVALID_CUSTOMER','顾客ID无效，请使用账户列表返回的userId');
  const account=await call('storedAccount/queryByUser',{userId:input.userId});
  if(!account||typeof account!=='object'||Array.isArray(account))fail();
  return {kind,account:redact(account),scope,verifiedAt:new Date().toISOString()};
 }
 if(kind==='stored_value_bill_detail'){
  if(!id(input.orderSn))throw new ServiceError('INVALID_ORDER','请使用储值流水返回的associatedSn');
  const bill=await call('storedAccount/queryStoredAccountBillDetail',{orderSn:input.orderSn});
  if(!bill||typeof bill!=='object'||Array.isArray(bill))fail();
  return {kind,bill:{...redact(bill),orderTypeLabel:storedOrderTypes[bill.orderType]||bill.orderType},scope,verifiedAt:new Date().toISOString()};
 }
 const page=input.page??1,pageSize=input.pageSize??20;
 if(!Number.isInteger(page)||page<1||page>10000||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new ServiceError('INVALID_PAGE','页码或每页数量无效');
 if(input.phone!==undefined&&(typeof input.phone!=='string'||!/^1\d{10}$/.test(input.phone)))throw new ServiceError('INVALID_PHONE','请用完整11位手机号搜索储值顾客');
 if(kind==='stored_value_bills'){
  if(input.orderType!==undefined&&!Object.hasOwn(storedOrderTypes,input.orderType))throw new ServiceError('INVALID_STORED_TYPE','储值流水类型无效');
  if(input.cursor!==undefined&&(typeof input.cursor!=='string'||!/^\d{1,40}$/.test(input.cursor)))throw new ServiceError('INVALID_CURSOR','请使用上一页返回的nextCursor');
  if(page>1&&!input.cursor)throw new ServiceError('CURSOR_REQUIRED','储值流水翻页需要上一页返回的nextCursor');
  if(input.storeId&&!owner.stores.some(s=>s.id===input.storeId))throw new ServiceError('UNKNOWN_STORE','该门店不在储值方案开通门店中');
  const path=!input.orderType?'queryAllStoredAccountBillList':input.phone?'queryStoredAccountBillListByUserId':'queryStoredAccountBillList';
  const data=await call('storedAccount/'+path,{storeIdList:input.storeId?[input.storeId]:null,orderType:input.orderType||'RELOAD',phoneNumber:input.phone||'',transactionId:input.cursor||'0',pageInfo:{page,pageSize}});
  if(!Array.isArray(data?.data))fail();
  const hasMore=data.data.length===pageSize,nextCursor=hasMore?String(data.data.at(-1)?.transactionId):null;
  if(hasMore&&!/^\d{1,40}$/.test(nextCursor))fail();
  runtime.dataSeen.add(kind);
  return {kind,records:redact(data.data).map(r=>({...r,orderTypeLabel:storedOrderTypes[r.orderType]||r.orderType})),total:null,page,pageSize,hasMore,nextCursor,scope:{...scope,storeId:input.storeId||null,orderType:input.orderType||null},notes:['储值专用账单，按交易游标翻页；当前为全部历史，不受营业日期筛选影响','上游未提供可用总数；满页时可继续查询下一页，不将本页条数当作总数','充值、消费、赠送与退款分别显示；不将充值与消费重复计入收入'],verifiedAt:new Date().toISOString()};
 }
 if(input.cursor!==undefined&&(typeof input.cursor!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(input.cursor)))throw new ServiceError('INVALID_CURSOR','请使用上一页返回的nextCursor');
 if(page>1&&!input.cursor)throw new ServiceError('CURSOR_REQUIRED','储值账户翻页需要上一页返回的nextCursor');
 const [result,statistics]=await Promise.allSettled([call('storedOwner/pageQueryMembers',{sortField:'RELOAD_TIME',sort:'DESC',pageInfo:{page,pageSize},beginFieldValue:input.cursor||'',cellphone:input.phone||''}),call('storedOwner/queryStoredOwnerStatistic',{storeIdList:owner.stores.map(s=>s.id)})]);
 if(result.status==='rejected')throw result.reason;
 const data=result.value;
 if(!Array.isArray(data?.data))fail();
 const hasMore=data.data.length===pageSize,last=data.data.at(-1)?.latestReloadTime;
 const nextCursor=hasMore&&typeof last==='number'&&Number.isFinite(last)?new Date(last+8*3600000).toISOString().slice(0,19).replace('T',' '):null;
 if(hasMore&&!nextCursor)throw new ServiceError('DATA_SCHEMA_CHANGED','储值账户翻页时间字段需要核对',502);
 runtime.dataSeen.add('stored_value_accounts');
 return {kind,records:redact(data.data),total:null,page,pageSize,hasMore,nextCursor,scope,statistics:statistics.status==='fulfilled'?redact(statistics.value):null,notes:['账户余额为当前余额；累计充值与消费不等于所选日期的收入','储值方案覆盖的顾客账户跨开通门店，不按单店重复加总','上游未提供可用顾客总数；按时间游标翻页',...(statistics.status==='rejected'?['累计统计暂未读取成功：'+statistics.reason.message]:[])],verifiedAt:new Date().toISOString()};
}
