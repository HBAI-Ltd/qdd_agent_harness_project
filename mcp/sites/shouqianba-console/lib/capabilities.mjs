export const capabilityCatalog=Object.freeze([
 {key:'overview',name:'营业与清算报表',implemented:true,observationKey:'overview',note:'付款、退款、实收、手续费、清算分别展示；当前支持普通商户日报。'},
 {key:'stores',name:'门店',implemented:true,observationKey:'stores',note:'读取可访问门店列表；查询按门店筛选。'},
 {key:'transactions',name:'交易与收款流水',implemented:true,observationKey:'transactions',note:'移动支付业务流水；可以筛选付款、储值充值、核销、记账、挂账、次卡等类型。'},
 {key:'refunds',name:'退款流水',implemented:true,observationKey:'refunds',note:'普通退款及储值、核销、记账、挂账、次卡退款按类型分别查询，不执行退款。'},
 {key:'cards',name:'银行卡交易',implemented:false,evidence:'contract_located',note:'已定位查询方式，尚未接入和验证当前账号。'},
 {key:'goods',name:'商品档案',implemented:true,observationKey:'catalog',note:'逐店查询商品/服务名称、售价、会员价、单位和上下架；成本按权限，未返回的库存数量不当作零。'},
 {key:'product_sales',name:'商品销量与商品报表',implemented:true,observationKey:'products',note:'商品销量、销售额及商品毛利报表；数值金额按分换算，脱敏占位原样保留。'},
 {key:'inventory',name:'库存汇总',implemented:true,observationKey:'inventory',note:'逐店读取库存总量，按当前账号成本权限显示库存价值。'},
 {key:'inventory_flows',name:'库存明细与库存流水',implemented:false,evidence:'endpoint_located',note:'已定位商品库存及库存流水路径，尚未接入明细查询。'},
 {key:'purchase',name:'采购入库与退货出库',implemented:false,evidence:'endpoint_located',note:'已定位只读列表路径，尚未接入。'},
 {key:'business_orders',name:'堂食、外卖与商品订单',implemented:false,evidence:'contract_located',note:'已定位业务订单分页和日期条件；与支付流水分开处理。'},
 {key:'members',name:'顾客档案',implemented:true,observationKey:'members',note:'普通商户顾客、手机号搜索、会员标签与详情；游标翻页，上游未给总数。'},
 {key:'stored_value_accounts',name:'储值卡账户与余额',implemented:true,observationKey:'stored_value_accounts',note:'卡号、当前总余额、本金/赠送余额及累计统计；与日期收入分开显示。'},
 {key:'stored_value_bills',name:'储值充值、消费与退款账单',implemented:true,observationKey:'stored_value_bills',note:'储值专用全部历史账单，可按门店、手机号及类型查询，并打开详情。'},
 {key:'count_cards',name:'次卡账户与剩余次数',implemented:false,evidence:'investigating',note:'次卡交易可在收款流水按类型查询，独立账户和剩余次数尚未接入。'},
 {key:'gross_profit',name:'订单毛利与商品成本',implemented:true,observationKey:'gross_profit',note:'直接读取官方毛利、成本字段，尚需核对成本录入和计算口径。'},
 {key:'profit',name:'经营费用与净利润',implemented:false,evidence:'source_unconfirmed',note:'尚未确认房租、人工、税费等完整费用数据；毛利、分账、清算均不是净利润。'},
 {key:'app_only',name:'其他App专属功能',implemented:false,evidence:'investigating',note:'逐项核对App功能及产品开通情况，尚不声称覆盖完整。'}
]);
export function coverageFor(observed){return capabilityCatalog.map(item=>({...item,state:item.implemented?(observed.has(item.observationKey)?'live_verified':'implemented'):(item.evidence||'investigating')}));}
