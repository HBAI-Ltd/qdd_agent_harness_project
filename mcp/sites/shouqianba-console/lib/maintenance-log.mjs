import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
// Keep only operational metadata. Never serialize a Runtime, request or response.
const clean=entry=>({at:entry.at,ok:entry.ok===true,errorCode:/^[A-Z][A-Z0-9_]{0,63}$/.test(entry.errorCode||'')?entry.errorCode:null,expiresAt:Number.isSafeInteger(entry.expiresAt)?entry.expiresAt:null,tokenChanged:entry.tokenChanged===true});
export async function recordMaintenance(path,entry){
  let rows=[];
  try{const value=JSON.parse(await readFile(path,'utf8'));if(Array.isArray(value))rows=value.filter(r=>r&&Number.isSafeInteger(r.at)).map(clean);}
  catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
  rows.push(clean(entry));const temporary=path+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,JSON.stringify(rows.slice(-120),null,2),{flag:'wx',mode:0o600});await rename(temporary,path);}
  finally{await rm(temporary,{force:true});}
}
