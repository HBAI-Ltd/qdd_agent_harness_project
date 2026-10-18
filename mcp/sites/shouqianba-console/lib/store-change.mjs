import {fen,sumFen} from './analysis.mjs';

// Round rational fen once, then use the residual so the bridge adds up exactly.
function divideRounded(value,divisor){const sign=value<0n?-1n:1n;return sign*((value*sign+divisor/2n)/divisor);}
export function orderBridge(before,after){
 const a=fen(before.orderAmount),b=fen(after.orderAmount),n=before.orderCount,m=after.orderCount;
 if(a===null||b===null||![n,m].every(v=>Number.isSafeInteger(v)&&v>=0))return null;
 const change=b-a,volume=n>0?divideRounded(a*BigInt(m-n),BigInt(n)):null;
 return {amount:change.toString(),orders:m-n,beforePerOrder:n?divideRounded(a,BigInt(n)).toString():null,afterPerOrder:m?divideRounded(b,BigInt(m)).toString():null,volumeEffect:volume?.toString()??null,unitEffect:volume===null?null:(change-volume).toString()};
}
export function storedBridge(before,after){
 const values=[before.orderAmount,after.orderAmount,before.stored.redeemAmount,before.stored.redeemRefundAmount,after.stored.redeemAmount,after.stored.redeemRefundAmount].map(fen);
 if(values.some(v=>v===null))return null;
 const[a,b,x,xr,y,yr]=values,oldNet=x-xr,newNet=y-yr;
 return {before:oldNet.toString(),after:newNet.toString(),delta:(newNet-oldNet).toString(),otherBefore:(a-oldNet).toString(),otherAfter:(b-newNet).toString(),otherDelta:((b-newNet)-(a-oldNet)).toString()};
}
export function explainStore(store){
 const a=store.weeks.before,b=store.weeks.after,orders=orderBridge(a,b),stored=storedBridge(a,b);
 const productsBefore=sumFen(a.products,'amount'),productsAfter=sumFen(b.products,'amount'),changes=sumFen(store.productChanges,'delta');
 const productsReconciled=a.complete===true&&b.complete===true&&productsBefore===a.orderAmount&&productsAfter===b.orderAmount&&changes===orders?.amount;
 const daySum=sumFen(store.matchedDays,'delta'),daysReconciled=daySum===orders?.amount;
 const dominantDay=daysReconciled?[...store.matchedDays].sort((x,y)=>Math.abs(Number(y.delta))-Math.abs(Number(x.delta)))[0]:null;
 return {orders,stored,productsReconciled,daysReconciled,productDelta:changes,dominantDay,otherDayDelta:dominantDay?(BigInt(orders.amount)-BigInt(dominantDay.delta)).toString():null};
}
