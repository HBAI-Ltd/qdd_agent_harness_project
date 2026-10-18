import {Buffer} from 'node:buffer';

const LIMIT = 16 * 1024;
const rawPort = process.env.TYSL_PORT || '8790';
const port = /^\d{1,5}$/.test(rawPort) && Number(rawPort) >= 1 && Number(rawPort) <= 65535 ? Number(rawPort) : null;
const endpoint = port === null ? null : `http://127.0.0.1:${port}/mcp`;
let pending = Buffer.alloc(0);
let discarding = false;
let chain = Promise.resolve();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const errorReply = (id, code, message) => ({jsonrpc: '2.0', id, error: {code, message}});

async function forward(line) {
  if (!line.length || /^\s*$/.test(line.toString('utf8'))) return;
  let message;
  try { message = JSON.parse(line.toString('utf8')); }
  catch { write(errorReply(null, -32700, 'Parse error')); return; }
  const isObject = message !== null && typeof message === 'object' && !Array.isArray(message);
  const notification = isObject && message.jsonrpc === '2.0' && typeof message.method === 'string' && !own(message, 'id');
  const id = isObject && own(message, 'id') && (message.id === null || typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id))) ? message.id : null;
  try {
    if (!endpoint) throw new Error('port');
    const response = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'}, body: JSON.stringify(message), signal: AbortSignal.timeout(30000), redirect: 'error'});
    if (notification || response.status === 202 || response.status === 204) return;
    if (!response.ok) throw new Error('http');
    const value = await response.json();
    if (!value || typeof value !== 'object' || value.jsonrpc !== '2.0' || !own(value, 'id') || (!own(value, 'result') && !own(value, 'error'))) throw new Error('response');
    write(value);
  } catch {
    if (!notification) write(errorReply(id, -32000, endpoint ? '本地天翼视联服务未启动或无法连接，请先启动本地控制台。' : 'TYSL_PORT 配置无效，请设置 1 至 65535 的端口。'));
  }
}

function enqueue(line) {
  chain = chain.then(() => forward(line)).catch(() => {});
}
function tooLarge() {
  chain = chain.then(() => write(errorReply(null, -32600, '请求行超过 16 KiB 上限。'))).catch(() => {});
}
process.stdin.on('data', chunk => {
  let start = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] !== 10) continue;
    const fragment = chunk.subarray(start, i);
    if (!discarding) {
      if (pending.length + fragment.length > LIMIT) tooLarge();
      else {
        let line = Buffer.concat([pending, fragment]);
        if (line.at(-1) === 13) line = line.subarray(0, -1);
        enqueue(line);
      }
    }
    pending = Buffer.alloc(0);
    discarding = false;
    start = i + 1;
  }
  const rest = chunk.subarray(start);
  if (!discarding) {
    if (pending.length + rest.length > LIMIT) { pending = Buffer.alloc(0); discarding = true; tooLarge(); }
    else pending = Buffer.concat([pending, rest]);
  }
});
process.stdin.on('end', () => { if (!discarding && pending.length) enqueue(pending); pending = Buffer.alloc(0); });
process.stdin.on('error', () => { process.exitCode = 1; });
