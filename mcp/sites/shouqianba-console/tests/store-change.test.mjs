import test from 'node:test';
import assert from 'node:assert/strict';
import {orderBridge,storedBridge,explainStore} from '../lib/store-change.mjs';

test('订单增加仍可能收入下降；两项金额影响四舍五入后精确闭合',()=>{
 const r=orderBridge({orderCount:65,orderAmount:'347590'},{orderCount:69,orderAmount:'308870'});
 assert.equal(r.orders,4);assert.equal(r.beforePerOrder,'5348');assert.equal(r.afterPerOrder,'4476');assert.equal(r.volumeEffect,'21390');assert.equal(r.unitEffect,'-60110');assert.equal(BigInt(r.volumeEffect)+BigInt(r.unitEffect),BigInt(r.amount));
});
test('没有基期订单或金额缺失时，不猜测每单金额影响',()=>{
 const r=orderBridge({orderCount:0,orderAmount:'0'},{orderCount:2,orderAmount:'10000'});assert.equal(r.beforePerOrder,null);assert.equal(r.volumeEffect,null);assert.equal(r.unitEffect,null);
 assert.equal(orderBridge({orderCount:2,orderAmount:null},{orderCount:2,orderAmount:'100'}),null);
});
test('储值冲回减少储值贡献；充值本金不参与营业实收桥接',()=>{
 const r=storedBridge({orderAmount:'780060',stored:{redeemAmount:'408900',redeemRefundAmount:'13800',reloadPrincipal:'300000'}},{orderAmount:'604980',stored:{redeemAmount:'354600',redeemRefundAmount:'0',reloadPrincipal:'330000'}});
 assert.equal(r.before,'395100');assert.equal(r.delta,'-40500');assert.equal(r.otherDelta,'-134580');assert.equal(BigInt(r.delta)+BigInt(r.otherDelta),-175080n);
 assert.equal(storedBridge({orderAmount:'10',stored:{redeemAmount:null,redeemRefundAmount:'0'}},{orderAmount:'0',stored:{redeemAmount:'0',redeemRefundAmount:'0'}}),null);
});
test('项目与日报必须先完整对上，才显示贡献和去除一天的敏感性比较',()=>{
 const week=(amount)=>({orderAmount:amount,orderCount:1,complete:true,products:[{amount}],stored:{redeemAmount:'0',redeemRefundAmount:'0'}});
 const s={weeks:{before:week('100'),after:week('120')},productChanges:[{delta:'20'}],matchedDays:[{delta:'50'},{delta:'-30'}]};
 const r=explainStore(s);assert.equal(r.productsReconciled,true);assert.equal(r.daysReconciled,true);assert.equal(r.otherDayDelta,'-30');
 s.weeks.before.complete=false;s.matchedDays.pop();const missing=explainStore(s);assert.equal(missing.productsReconciled,false);assert.equal(missing.daysReconciled,false);assert.equal(missing.dominantDay,null);
});
