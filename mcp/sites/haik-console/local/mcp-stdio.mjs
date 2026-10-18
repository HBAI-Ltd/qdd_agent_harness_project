import readline from 'node:readline';
const url = 'http://127.0.0.1:' + (process.env.HAIK_PORT || 8787) + '/mcp';
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set();
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
async function forward(line) {
  let message;
  try { message = JSON.parse(line); }
  catch { output({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: line, signal: AbortSignal.timeout(180000) });
    if (response.status === 202) return;
    const result = await response.json();
    if (result?.jsonrpc !== '2.0') throw new Error('Invalid MCP response');
    output(result);
  } catch {
    if (message && Object.hasOwn(message, 'id')) output({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'HAIK 本地服务未连接，请先运行启动脚本' } });
  }
}
// An emergency stop must not wait behind a slow movement request.
for await (const line of input) {
  if (!line.trim()) continue;
  const task = forward(line);
  pending.add(task);
  task.finally(() => pending.delete(task));
}
await Promise.allSettled(pending);
