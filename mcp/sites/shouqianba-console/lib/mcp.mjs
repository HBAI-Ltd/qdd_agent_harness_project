import {transactionTypes,refundTypes} from '../web/transaction-types.js';
const range={start:{type:'string',description:'开始日期，YYYY-MM-DD（北京时间）'},end:{type:'string',description:'结束日期，YYYY-MM-DD（北京时间）'}};
const transactionType={type:'string',enum:Object.keys(transactionTypes),description:'可选业务类型：30付款，17储值核销，18储值充值，15记账，23挂账，26次卡销售等；省略返回所有类型。'};
export const toolDefinitions=[
 {name:'sqb_status',description:'查看收钱吧登录及模块接入状态，不返回登录凭据。',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'sqb_list_stores',description:'读取当前登录商户可访问的门店、营业地址与登记坐标，按page翻页；storeId取id。坐标系未标注，不等同实地核验位置；不返回联系人或联系电话。',inputSchema:{type:'object',properties:{page:{type:'integer',minimum:1},pageSize:{type:'integer',minimum:1,maximum:100}},additionalProperties:false}},
 {name:'sqb_transactions',description:'按北京时间营业日查询移动支付业务流水，可筛选付款、记账、充值、核销、次卡等类型；每次一页，金额单位分。不将全部流水相加当作营业收入。银行卡未接入。',inputSchema:{type:'object',properties:{...range,transactionType,page:{type:'integer',minimum:1},pageSize:{type:'integer',minimum:1,maximum:100},storeId:{type:'string'}},required:['start','end'],additionalProperties:false}},
 {name:'sqb_refunds',description:'按北京时间营业日读取指定一种退款类型，默认11普通退款，可选19储值退款、20储值核销退款、21记账退款、24挂账退款、27次卡退卡、29次卡核销退款；保留状态，金额单位分，不会发起退款。',inputSchema:{type:'object',properties:{...range,transactionType:{type:'string',enum:refundTypes,description:'退款类型，默认11普通退款。每次只查询一种，未合并其他类型。'},page:{type:'integer',minimum:1},pageSize:{type:'integer',minimum:1,maximum:100},storeId:{type:'string'}},required:['start','end'],additionalProperties:false}},
 {name:'sqb_overview',description:'读取指定日期范围营业汇总，说明数据来源及统计范围。',inputSchema:{type:'object',properties:{...range,storeId:{type:'string'}},required:['start','end'],additionalProperties:false}},
 {name:'sqb_transaction_detail',description:'读取收款流水对应的支付订单详情及其关联支付/退款记录。orderSn取sqb_transactions返回的order_sn，金额单位分。',inputSchema:{type:'object',properties:{orderSn:{type:'string'}},required:['orderSn'],additionalProperties:false}},
 {name:'sqb_members',description:'读取当前商户普通顾客档案及会员标签。可按完整手机号或后4位phone搜索；无总数；下一页需传nextCursor，并递增page。',inputSchema:{type:'object',properties:{phone:{type:'string'},page:{type:'integer',minimum:1},pageSize:{type:'integer',minimum:1,maximum:100},cursor:{type:'string'}},additionalProperties:false}},
 {name:'sqb_member_detail',description:'读取普通顾客档案详情，userId取sqb_members。储值余额请另查sqb_stored_value_detail。',inputSchema:{type:'object',properties:{userId:{type:'string'}},required:['userId'],additionalProperties:false}},
 {name:'sqb_stored_value_issuers',description:'读取当前账号可访问的储值方案及开通门店，不创建或修改方案。',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'sqb_stored_value_accounts',description:'读取储值顾客、卡号、当前余额和方案累计统计；金额分。可按完整手机号搜索。下一页传nextCursor和递增page；统计为方案全部顾客累计，与搜索及营业日期无关。',inputSchema:{type:'object',properties:{issuerId:{type:'string'},phone:{type:'string'},page:{type:'integer',minimum:1},pageSize:{type:'integer',minimum:1,maximum:100},cursor:{type:'string'}},additionalProperties:false}},
 {name:'sqb_stored_value_detail',description:'读取储值顾客当前余额、本金余额、赠送余额、充值次数与最近充值时间。userId取账户列表。金额分。',inputSchema:{type:'object',properties:{issuerId:{type:'string'},userId:{type:'string'}},required:['userId'],additionalProperties:false}},
 {name:'sqb_stored_value_bills',description:'读取全部历史储值专用账单，可按门店、手机号及充值/消费/退款等orderType筛选。金额分；下一页传nextCursor。不会充值、核销或退款。',inputSchema:{type:'object',properties:{issuerId:{type:'string'},storeId:{type:'string'},phone:{type:'string'},orderType:{type:'string',enum:['RELOAD','REDEEM','REDEEM_REFUND','MANUAL_IMPORT','RELOAD_REFUND','TRANSFER_OUT']},page:{type:'integer',minimum:1},pageSize:{type:'integer',minimum:1,maximum:100},cursor:{type:'string'}},additionalProperties:false}},
 {name:'sqb_stored_value_bill_detail',description:'读取储值专用账单详情；orderSn使用账单associatedSn。金额分，不修改账单。',inputSchema:{type:'object',properties:{issuerId:{type:'string'},orderSn:{type:'string'}},required:['orderSn'],additionalProperties:false}},
 {name:'sqb_products',description:'读取指定营业日范围的商品销量/销售额/毛利报表，每次一页。金额保留分单位，脱敏占位符原样保留，毛利率不自动换算。',inputSchema:{type:'object',properties:{...range,storeId:{type:'string'},page:{type:'integer',minimum:1},pageSize:{type:'integer',minimum:1,maximum:100}},required:['start','end'],additionalProperties:false}},
 {name:'sqb_inventory',description:'读取指定一家门店的零售库存总量；先检查成本查看权限，无权限时不返回库存价值。库存汇总不等同明细或流水。',inputSchema:{type:'object',properties:{storeId:{type:'string',description:'sqb_list_stores返回的门店id，必填'}},required:['storeId'],additionalProperties:false}},
 {name:'sqb_catalog',description:'读取一家门店当前商品/服务档案、售价、会员价、单位、上下架及可用库存数量。按权限返回进货/成本价，金额分；keyword可选搜索。',inputSchema:{type:'object',properties:{storeId:{type:'string'},keyword:{type:'string'},page:{type:'integer',minimum:1},pageSize:{type:'integer',minimum:1,maximum:100}},required:['storeId'],additionalProperties:false}},
 {name:'sqb_gross_profit',description:'读取订单毛利、商品销售额/成本及订单来源报表；毛利不是净利润，不含完整经营费用。金额保留分单位，毛利率保留上游展示值。',inputSchema:{type:'object',properties:{...range,storeId:{type:'string'},page:{type:'integer',minimum:1},pageSize:{type:'integer',minimum:1,maximum:100}},required:['start','end'],additionalProperties:false}},
 {name:'sqb_module_status',description:'查看商品、库存及利润等模块的接入进度与数据缺口。',inputSchema:{type:'object',properties:{},additionalProperties:false}}
];
for(const tool of toolDefinitions)tool.annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:!['sqb_status','sqb_module_status'].includes(tool.name)};
const names={sqb_list_stores:'stores',sqb_transactions:'transactions',sqb_refunds:'refunds',sqb_overview:'overview',sqb_products:'products',sqb_catalog:'catalog',sqb_inventory:'inventory',sqb_gross_profit:'gross_profit',sqb_transaction_detail:'transaction_detail',sqb_members:'members',sqb_member_detail:'member_detail',sqb_stored_value_issuers:'stored_value_issuers',sqb_stored_value_accounts:'stored_value_accounts',sqb_stored_value_detail:'stored_value_detail',sqb_stored_value_bills:'stored_value_bills',sqb_stored_value_bill_detail:'stored_value_bill_detail'};
const rpcError=(id,code,message)=>({status:200,body:{jsonrpc:'2.0',id,error:{code,message}}});
export async function mcpMessage(message,runtime){
 const validId=id=>id===null||typeof id==='string'||typeof id==='number'&&Number.isFinite(id);
 if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||Object.hasOwn(message,'id')&&!validId(message.id))return rpcError(null,-32600,'Invalid Request');
 if(!Object.hasOwn(message,'id'))return {status:202,body:null};
 const id=message.id,params=message.params||{};
 const ok=result=>({status:200,body:{jsonrpc:'2.0',id,result}});
 if(message.method==='initialize')return ok({protocolVersion:['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(params.protocolVersion)?params.protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:false}},serverInfo:{name:'shouqianba-local',version:'0.1.0'},instructions:'先使用 sqb_status 检查会话。用户通过本地网页自行完成短信登录。所有经营工具只读；金额单位以响应口径说明为准，不把未接入数据当作零。'});
 if(message.method==='ping')return ok({});
 if(message.method==='tools/list')return ok({tools:toolDefinitions});
 if(message.method!=='tools/call')return rpcError(id,-32601,'Method not found');
 const def=toolDefinitions.find(t=>t.name===params.name);
 if(!def)return rpcError(id,-32602,'Unknown tool');
 const args=params.arguments||{};
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(def.inputSchema.properties,k)))return rpcError(id,-32602,'Invalid arguments');
 for(const key of def.inputSchema.required||[])if(!Object.hasOwn(args,key))return rpcError(id,-32602,'Missing argument: '+key);
 for(const [key,value] of Object.entries(args)){const schema=def.inputSchema.properties[key];if(schema.type==='string'&&typeof value!=='string'||schema.type==='integer'&&(!Number.isInteger(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))||schema.enum&&!schema.enum.includes(value))return rpcError(id,-32602,'Invalid argument: '+key);}
 try{
  const data=params.name==='sqb_status'?runtime.status():params.name==='sqb_module_status'?{modules:runtime.status().modules,coverage:runtime.status().coverage}:await runtime.readData(names[params.name],args);
  return ok({content:[{type:'text',text:JSON.stringify(data)}],isError:false});
 }catch(e){return ok({content:[{type:'text',text:JSON.stringify({code:e.code||'SERVICE_ERROR',message:e.code?e.message:'本地服务请求失败'})}],isError:true});}
}
