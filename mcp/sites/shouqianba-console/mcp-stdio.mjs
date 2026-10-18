import readline from 'node:readline';
import {readMcpKey} from './lib/credentials.mjs';
const url='http://127.0.0.1:'+(process.env.SQB_PORT||8788)+'/mcp';
const key=await readMcpKey(process.env.SQB_STATE_DIR||process.env.SQB_MCP_KEY_PATH||new URL('../../.local/shouqianba/',import.meta.url));
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of input){
 if(!line.trim())continue;
 let message;
 try{
  message=JSON.parse(line);
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:line,signal:AbortSignal.timeout(60000)});
  if(response.status===202)continue;
  const value=await response.json();if(value.jsonrpc!=='2.0')throw new Error();
  process.stdout.write(JSON.stringify(value)+'\n');
 }catch{
  if(message&&Object.hasOwn(message,'id'))process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'收钱吧本地服务未连接，请先启动经营台'}})+'\n');
  else if(!message)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');
 }
}
