import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,rmdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import http from 'node:http';
import {writeVault,readVault,clearVault} from '../lib/vault.mjs';
import {readMcpKey} from '../lib/credentials.mjs';

const local=fileURLToPath(new URL('../../../.local/',import.meta.url));
test('Windows DPAPI凭据可加密还原，磁盘不含明文',async()=>{
 await mkdir(local,{recursive:true});const dir=await mkdtemp(local+'sqb-vault-test-'),path=dir+'/session.dpapi';
 try{await writeVault(path,{token:'synthetic-vault-test-value'});const disk=await readFile(path,'utf8');assert(!disk.includes('synthetic-vault-test-value'));assert.deepEqual(await readVault(path),{token:'synthetic-vault-test-value'});}
 finally{await clearVault(path);await rmdir(dir);}
});
test('真实HTTP服务保护会话和MCP，允许用户从浏览器打开登录页',async()=>{
 await mkdir(local,{recursive:true});const dir=await mkdtemp(local+'sqb-server-test-');
 const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env:{...process.env,SQB_PORT:'18888',SQB_STATE_DIR:dir},windowsHide:true,stdio:['ignore','pipe','pipe']});
 try{
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('test server exited');}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('test server timeout')),20000).unref())]);
  const base='http://127.0.0.1:18888';
  assert.equal((await fetch(base+'/api/status')).status,401);
  assert.equal((await fetch(base+'/api/analysis')).status,401);
  assert.equal((await fetch(base+'/lab')).status,200);
  assert.equal((await fetch(base+'/analysis-case.json')).status,200);
  const root=await fetch(base,{headers:{'sec-fetch-site':'cross-site'}});assert.equal(root.status,200);const cookie=root.headers.get('set-cookie').split(';')[0];assert(root.headers.get('set-cookie').includes('HttpOnly'));assert(root.headers.get('set-cookie').includes('SameSite=Strict'));
  const status=await fetch(base+'/api/status',{headers:{Cookie:cookie}});assert.equal(status.status,200);assert.equal((await status.json()).stage,'signed_out');
  const report=await fetch(base+'/api/analysis',{headers:{Cookie:cookie}});assert.equal(report.status,401);assert.equal((await report.json()).code,'LOGIN_REQUIRED');
  assert.equal((await fetch(base+'/api/status',{headers:{Cookie:cookie,Origin:'https://foreign.example'}})).status,403);
  const wrongHost=await new Promise((resolve,reject)=>{http.get(base+'/api/status',{headers:{Cookie:cookie,Host:'foreign.example'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);});assert.equal(wrongHost,403);
  assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const key=await readMcpKey(dir),headers={'Content-Type':'application/json',Authorization:`Bearer ${key}`};
  const rpc=async message=>{const response=await fetch(base+'/mcp',{method:'POST',headers,body:JSON.stringify(message)});return {status:response.status,data:response.status===202?null:await response.json()};};
  assert.equal((await rpc({jsonrpc:'2.0',id:1,method:'tools/list'})).data.result.tools.length,18);
  assert.equal((await rpc({jsonrpc:'2.0',method:'notifications/initialized'})).status,202);
  assert.equal((await rpc([])).data.error.code,-32600);
  const bad=await fetch(base+'/mcp',{method:'POST',headers,body:'{'});assert.equal((await bad.json()).error.code,-32700);
  const stdio=spawn(process.execPath,[fileURLToPath(new URL('../mcp-stdio.mjs',import.meta.url))],{env:{...process.env,SQB_PORT:'18888',SQB_MCP_KEY_PATH:dir+'/mcp-key'},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const chunks=[];stdio.stdout.on('data',c=>chunks.push(c));stdio.stdin.end(JSON.stringify({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-03-26'}})+'\n'+JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/list'})+'\n');
  const [code]=await once(stdio,'exit');assert.equal(code,0);const replies=Buffer.concat(chunks).toString('utf8').trim().split('\n').map(JSON.parse);assert.equal(replies.length,2);assert.equal(replies[0].result.serverInfo.name,'shouqianba-local');assert.equal(replies[1].result.tools.length,18);
 }finally{const exit=once(child,'exit');child.kill();await exit;await rm(dir+'/mcp-key',{force:true});await rm(dir+'/browser-key',{force:true});await rm(dir+'/credentials.dpapi',{force:true});await rmdir(dir);}
});
