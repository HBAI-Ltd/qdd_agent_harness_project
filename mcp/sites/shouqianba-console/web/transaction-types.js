// Observed in the official s-upay public configuration basic.constant.orderTypeMap.
export const transactionTypes=Object.freeze({'10':'撤单','11':'退款','12':'预授权撤销','13':'预授权完成','14':'预授权完成撤销','15':'记账','17':'储值核销','18':'储值充值','19':'储值退款','20':'储值核销退款','21':'记账退款','23':'挂账','24':'挂账退款','25':'销账还款','26':'次卡销售','27':'次卡退卡','28':'次卡核销','29':'次卡核销退款','30':'付款','31':'退款撤销','32':'预授权'});
export const refundTypes=Object.freeze(['11','19','20','21','24','27','29']);
export function validateTransactionType(kind,value){
 if(value===undefined||value==='')return kind==='refunds'?'11':undefined;
 if(typeof value!=='string'||!Object.hasOwn(transactionTypes,value)||kind==='refunds'&&!refundTypes.includes(value))return null;
 return value;
}
