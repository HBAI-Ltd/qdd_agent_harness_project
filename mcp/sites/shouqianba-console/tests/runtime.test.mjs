import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime,redact} from '../lib/runtime.mjs';
import {CloudClient,dateRange} from '../lib/cloud.mjs';
import {mcpMessage} from '../lib/mcp.mjs';

function fixture(responder){const calls=[],saved=[];let clears=0;const client={cookies:new Map(),async request(path,options){calls.push({path,options});return responder(path,options);}};const runtime=new Runtime({vault:'unused',client,load:async()=>null,save:async(_path,value)=>saved.push(structuredClone(value)),clear:async()=>{clears++;}});return {runtime,calls,saved,get clears(){return clears;}};}
function signedIn(runtime){runtime.session={ucToken:'private-uc-token',verified:true,refreshTime:Date.now(),context:{role:'super_admin',merchant_id:3,merchant_user_id:4},identities:[],phone:'13900000000'};}

test('短信结果绑定手机号；验证码和sendId不会持久化或出现在状态中',async()=>{
 const f=fixture(path=>path.endsWith('getRiskCode')?{bizCode:200,sendId:'private-send-id'}:path.endsWith('loginByCode')?{mchUserTokenInfo:{token:'private-token'},loginUserInfos:[{name:'商户A',merchant_user_id:4},{name:'商户B',merchant_user_id:5}]}:null);
 await f.runtime.sendCode({phone:'13900000000',captchaVerifyParam:'captcha-from-user'});
 await assert.rejects(f.runtime.login({phone:'13800000000',code:'123456'}),{code:'SMS_REQUIRED'});
 await f.runtime.login({phone:'13900000000',code:'123456'});
 const stored=JSON.stringify(f.saved);assert(!stored.includes('123456'));assert(!stored.includes('private-send-id'));
 const status=JSON.stringify(f.runtime.status());assert(!status.includes('private-token'));assert(!status.includes('13900000000'));assert(status.includes('139****0000'));
});
test('未完成人机验证不发送短信，并限制连续重发',async()=>{
 const f=fixture(()=>({bizCode:200,sendId:'send'}));
 await assert.rejects(f.runtime.sendCode({phone:'13900000000',captchaVerifyParam:''}),{code:'CAPTCHA_REQUIRED'});assert.equal(f.calls.length,0);
 await f.runtime.sendCode({phone:'13900000000',captchaVerifyParam:'valid'});
 await assert.rejects(f.runtime.sendCode({phone:'13900000000',captchaVerifyParam:'valid'}),{code:'SMS_COOLDOWN'});assert.equal(f.calls.length,1);
});
test('门店ID映射为门店SN，查询使用UC token和营业日起算时间',async()=>{
 const f=fixture(path=>path==='/api/findStores'?{records:[{id:10,sn:'STORE-SN',name:'测试门店'}],total:1}:path==='/v4/merchantGray/query'?{value:'5'}:{records:[],total:0});signedIn(f.runtime);
 const result=await f.runtime.readData('transactions',{start:'2026-10-01',end:'2026-10-02',storeId:'10'});
 const call=f.calls.at(-1);assert.equal(call.options.body.store_sn,'STORE-SN');assert.equal(call.options.body.store_id,undefined);assert.equal(call.options.query.token,'private-uc-token');assert.equal(call.options.query.client_version,'7.0.0');
 assert.equal(call.options.body.date_start,Date.parse('2026-10-01T05:00:00+08:00'));assert.equal(call.options.body.date_end,Date.parse('2026-10-03T05:00:00+08:00')-1);
 assert.equal(result.scope.businessDayStartsAt,'05:00');assert.equal(result.total,0);assert.equal(f.runtime.status().modules.find(m=>m.key==='transactions').state,'live_verified');
});
test('退款工具只筛选普通退款，不写入或调用退款操作',async()=>{
 const f=fixture(path=>path.endsWith('query')?{value:'0'}:{total:1,records:[{sn:'r1',status:2000,original_amount:'1250',token:'secret',nested:{auth_token:'secret2'}}]});signedIn(f.runtime);
 const result=await f.runtime.readData('refunds',{start:'2026-10-01',end:'2026-10-01'});assert.equal(f.calls.at(-1).options.body.type,'11');assert(f.calls.every(c=>!c.path.includes('/refund/')));assert(!JSON.stringify(result).includes('secret'));assert(result.notes[0].includes('普通退款'));
});
test('分页完整性明示，不将一页当作全量',async()=>{const f=fixture(()=>({total:102,records:[{id:1,sn:'S1',name:'门店'}]}));signedIn(f.runtime);const data=await f.runtime.readData('stores',{page:2,pageSize:20});assert.equal(data.hasMore,true);assert.equal(data.page,2);assert.equal(data.total,102);});
test('营业报表保留分单位及口径，不生成虚构利润',async()=>{
 const f=fixture(path=>path.endsWith('/query')?{value:'0'}:{total:1,records:[{accountSummaryReport:[{tradeDate:'2026-10-01',paymentAmount:'12345',receivedAmount:'12000'}]}]});signedIn(f.runtime);
 const result=await f.runtime.readData('overview',{start:'2026-10-01',end:'2026-10-01'});assert.equal(result.records[0].paymentAmount,'12345');assert.equal(result.scope.moneyUnit,'fen');assert.equal(result.profit,undefined);assert.equal(f.calls.at(-1).options.body.merchant_user_id,4);
});
test('上游结构变化不会变成空列表或零金额',async()=>{const f=fixture(()=>({rows:[]}));signedIn(f.runtime);await assert.rejects(f.runtime.readData('stores'),{code:'DATA_SCHEMA_CHANGED'});});
test('储值充值和核销分别标记；按明确业务类型筛选，不混算收入',async()=>{const f=fixture(path=>path.endsWith('/query')?{value:'0'}:{records:[{type:17,original_amount:500},{type:18,original_amount:10000}],total:2});signedIn(f.runtime);const data=await f.runtime.readData('transactions',{start:'2026-10-01',end:'2026-10-01',transactionType:'18'});assert.equal(f.calls.at(-1).options.body.type,'18');assert.equal(data.records[0].transactionTypeLabel,'储值核销');assert.equal(data.records[1].transactionTypeLabel,'储值充值');assert(data.notes.some(n=>n.includes('不将所有流水金额相加')));});
test('特殊退款须逐种读取且名称明确，拒绝将充值类型当作退款',async()=>{const f=fixture(path=>path.endsWith('/query')?{value:'0'}:{records:[],total:0});signedIn(f.runtime);const data=await f.runtime.readData('refunds',{start:'2026-10-01',end:'2026-10-01',transactionType:'19'});assert.equal(f.calls.at(-1).options.body.type,'19');assert(data.notes[0].includes('储值退款'));const count=f.calls.length;await assert.rejects(f.runtime.readData('refunds',{start:'2026-10-01',end:'2026-10-01',transactionType:'18'}),{code:'INVALID_TRANSACTION_TYPE'});assert.equal(f.calls.length,count);});
test('会话过期使用正常刷新接口重试，刷新失效时清除本机会话',async()=>{
 const f=fixture(path=>{if(path.endsWith('refreshToken'))return{status:2,token:'new-uc-token'};if(f.calls.filter(c=>c.path==='/api/findStores').length===1)throw Object.assign(new Error(),{code:'AUTH_EXPIRED'});return{records:[],total:0};});signedIn(f.runtime);
 await f.runtime.readData('stores');assert.equal(f.runtime.session.ucToken,'new-uc-token');assert.equal(f.calls.at(-1).options.query.token,'new-uc-token');
 const g=fixture(()=>{throw Object.assign(new Error(),{code:'AUTH_EXPIRED'});});signedIn(g.runtime);await assert.rejects(g.runtime.readData('stores'),{code:'AUTH_EXPIRED'});assert.equal(g.runtime.session,null);assert(g.clears>0);
});
test('日期、页码和身份约束在请求上游前验证',async()=>{
 assert.throws(()=>dateRange('2026-02-30','2026-03-01'),{code:'INVALID_RANGE'});assert.throws(()=>dateRange('2026-10-02','2026-10-01'),{code:'INVALID_RANGE'});assert.throws(()=>dateRange('2026-01-01','2026-10-01'),{code:'RANGE_TOO_LARGE'});
 const f=fixture(()=>null);signedIn(f.runtime);await assert.rejects(f.runtime.readData('stores',{page:-1}),{code:'INVALID_PAGE'});await assert.rejects(f.runtime.chooseIdentity({index:999}),{code:'INVALID_IDENTITY'});assert.equal(f.calls.length,0);
});
test('MCP初始化、通知、只读工具和错误语义',async()=>{
 const f=fixture(()=>null);
 const init=await mcpMessage({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26'}},f.runtime);assert.equal(init.body.result.protocolVersion,'2025-03-26');
 assert.equal((await mcpMessage({jsonrpc:'2.0',method:'notifications/initialized'},f.runtime)).status,202);
 const list=await mcpMessage({jsonrpc:'2.0',id:2,method:'tools/list'},f.runtime);assert.equal(list.body.result.tools.length,18);assert(list.body.result.tools.every(t=>!/(login|send|create|pay)/.test(t.name)));
 const call=await mcpMessage({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'sqb_transactions',arguments:{start:'2026-10-01',end:'2026-10-01'}}},f.runtime);assert.equal(call.body.result.isError,true);assert.match(call.body.result.content[0].text,/LOGIN_REQUIRED/);
 const invalid=await mcpMessage({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'sqb_list_stores',arguments:{endpoint:'/refund'}}},f.runtime);assert.equal(invalid.body.error.code,-32602);
});
test('商品报表使用上游实际分页，保留毛利脱敏值与毛利率原值',async()=>{const f=fixture(path=>path.endsWith('/query')?{value:'0'}:{records:[{itemName:'商品A',itemAmount:'12345',profitAmount:'***',profitRate:'--'}],total:51,page:2,pageSize:25});signedIn(f.runtime);const data=await f.runtime.readData('products',{start:'2026-10-01',end:'2026-10-01',page:2,pageSize:10});assert.equal(data.pageSize,25);assert.equal(data.page,2);assert.equal(data.hasMore,true);assert.equal(data.records[0].profitAmount,'***');assert.equal(data.records[0].profitRate,'--');assert.equal(data.scope.moneyUnit,'fen');assert.equal(f.calls.at(-1).options.body.page,2);assert.equal(data.source,'/v4/data-report/statistics/getGoodsReportSummaryList');});
test('库存先检查门店授权与成本权限；无权限时不返回库存价值',async()=>{const f=fixture(path=>path.endsWith('findUserStores')?[{store_id:'S1',store_name:'门店A'}]:path.endsWith('queryUserAuthorize')?{has_permission:false,data_scene:'goods_stock_sensitive'}:{total_stock:12.5,total_price:888888});signedIn(f.runtime);const data=await f.runtime.readData('inventory',{storeId:'S1'});assert.equal(data.costAllowed,false);assert.equal(data.records[0].totalStock,12.5);assert(!Object.hasOwn(data.records[0],'stockValue'));assert(!JSON.stringify(data).includes('888888'));assert.equal(f.calls.at(-1).options.body.bizOwner.scene,'retail');assert.equal(f.calls.at(-1).options.query.token,undefined);assert.equal(f.calls.at(-1).options.token,'private-uc-token');});
test('库存门店缺失或不在零售授权列表时，不读取库存数据',async()=>{const f=fixture(()=>[]);signedIn(f.runtime);await assert.rejects(f.runtime.readData('inventory',{}),{code:'STORE_REQUIRED'});assert.equal(f.calls.length,0);await assert.rejects(f.runtime.readData('inventory',{storeId:'unknown'}),{code:'RETAIL_STORE_UNAVAILABLE'});assert.equal(f.calls.length,1);});
test('CloudClient检查业务错误并避免返回凭证',async()=>{
 const client=new CloudClient(async()=>new Response(JSON.stringify({code:10000,data:{records:[]}}),{headers:{'Content-Type':'application/json'}}));assert.deepEqual(await client.request('/api/findStores'),{records:[]});
 const expired=new CloudClient(async()=>new Response(JSON.stringify({code:50201,msg:'expired'})));await assert.rejects(expired.request('/api/findStores'),{code:'AUTH_EXPIRED'});
 const failed=new CloudClient(async()=>new Response('<html>bad gateway</html>'));await assert.rejects(failed.request('/api/findStores'),{code:'UPSTREAM_FORMAT'});
 assert.deepEqual(redact({token:'x',value:1,nested:{password:'p',amount:2}}),{value:1,nested:{amount:2}});
});
