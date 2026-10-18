export function formatFen(value){
 if(value===undefined||value===null||value==='')return '—';
 if(typeof value==='number'&&!Number.isFinite(value))return '格式待核对';
 const text=String(value).trim(),match=/^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
 if(!match)return typeof value==='string'&&text.length<=32?text:'格式待核对';
 let amount=BigInt(match[2]);if(match[3]&&match[3][0]>='5')amount++;
 return(match[1]&&amount>0n?'-':'')+(amount/100n).toLocaleString('zh-CN')+'.'+String(amount%100n).padStart(2,'0');
}
