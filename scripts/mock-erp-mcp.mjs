// 本地假 ERP MCP 服务（Streamable HTTP，JSON 响应），只用于开发联调，数据为固定种子生成的假数据。
// 用法：node --env-file-if-exists=.env scripts/mock-erp-mcp.mjs   （默认 http://127.0.0.1:3100/mcp）
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const HOST = process.env.MOCK_ERP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MOCK_ERP_PORT ?? 3100);
const TOKEN = process.env.ERP_MCP_TOKEN;

// ---------- 假数据 ----------
let seed = 20261016;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const round2 = (n) => Math.round(n * 100) / 100;

const store = { store_id: "S001", name: "钱多多生鲜·示例店", city: "深圳", address: "南山区示例路 88 号", area_m2: 320, open_hours: "07:00-22:30" };

const catalog = [
  ["蔬菜", ["上海青", "西兰花", "番茄", "黄瓜", "土豆", "胡萝卜", "生菜", "茄子"], [2.5, 9]],
  ["水果", ["香蕉", "苹果", "橙子", "葡萄", "西瓜", "火龙果"], [5, 25]],
  ["肉禽", ["猪五花", "猪里脊", "鸡胸肉", "鸡翅中", "牛腩"], [18, 68]],
  ["水产", ["鲈鱼", "基围虾", "鱿鱼"], [28, 88]],
  ["蛋奶", ["鸡蛋(10枚)", "鲜牛奶 1L", "酸奶"], [8, 22]],
  ["粮油", ["东北大米 5kg", "花生油 5L", "挂面"], [6, 89]],
];
const products = [];
for (const [category, names, [lo, hi]] of catalog) {
  for (const name of names) {
    const price = round2(lo + rand() * (hi - lo));
    products.push({ sku: `SKU${String(products.length + 1).padStart(4, "0")}`, name, category, unit: category === "粮油" || category === "蛋奶" ? "件" : "斤", price, cost: round2(price * (0.55 + rand() * 0.2)), supplier: pick(["鲜丰供应链", "城南批发", "绿源农场", "海港水产"]) });
  }
}

const today = new Date("2026-10-16T00:00:00+08:00");
const dayStr = (d) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
const sales = []; // 近 60 天逐日逐 SKU 销售
for (let i = 60; i >= 1; i--) {
  const d = new Date(today.getTime() - i * 86400e3);
  const weekend = [0, 6].includes(d.getDay()) ? 1.35 : 1;
  for (const p of products) {
    const qty = Math.round((5 + rand() * 40) * weekend);
    sales.push({ date: dayStr(d), sku: p.sku, qty, revenue: round2(qty * p.price * (0.9 + rand() * 0.1)), cost: round2(qty * p.cost) });
  }
}
const inventory = products.map((p) => ({ sku: p.sku, name: p.name, on_hand: Math.round(rand() * 200), safety_stock: 30, updated_at: `${dayStr(today)}T08:00:00+08:00` }));

const members = Array.from({ length: 50 }, (_, i) => ({ member_id: `M${String(i + 1).padStart(4, "0")}`, level: pick(["普通", "银卡", "金卡"]), joined: dayStr(new Date(today.getTime() - Math.floor(rand() * 700) * 86400e3)), points: Math.floor(rand() * 5000) }));
const orders = Array.from({ length: 200 }, (_, i) => {
  const items = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => {
    const p = pick(products);
    const qty = 1 + Math.floor(rand() * 3);
    return { sku: p.sku, name: p.name, qty, amount: round2(qty * p.price) };
  });
  const t = new Date(today.getTime() - Math.floor(rand() * 14 * 86400e3));
  return { order_id: `O${String(i + 1).padStart(6, "0")}`, created_at: t.toISOString(), member_id: rand() < 0.6 ? pick(members).member_id : null, channel: pick(["门店", "门店", "小程序", "美团"]), items, total: round2(items.reduce((s, x) => s + x.amount, 0)) };
}).sort((a, b) => b.created_at.localeCompare(a.created_at));

// ---------- 工具 ----------
const ro = { readOnlyHint: true };
const str = (description) => ({ type: "string", description });
const tools = [
  { name: "get_store_info", description: "门店基本信息", inputSchema: { type: "object", properties: {} }, annotations: ro, run: () => store },
  {
    name: "list_products", description: "商品列表，可按品类筛选", annotations: ro,
    inputSchema: { type: "object", properties: { category: str("品类：蔬菜/水果/肉禽/水产/蛋奶/粮油") } },
    run: ({ category }) => ({ products: products.filter((p) => !category || p.category === category) }),
  },
  {
    name: "query_sales", description: "按日期范围查询逐日逐 SKU 销售明细（近 60 天）", annotations: ro,
    inputSchema: { type: "object", properties: { from: str("开始日期 YYYY-MM-DD"), to: str("结束日期 YYYY-MM-DD（含）"), sku: str("可选 SKU") } },
    run: ({ from = "0000", to = "9999", sku }) => ({ rows: sales.filter((r) => r.date >= from && r.date <= to && (!sku || r.sku === sku)) }),
  },
  {
    name: "query_inventory", description: "当前库存与安全库存，可只看低于安全库存的商品", annotations: ro,
    inputSchema: { type: "object", properties: { below_safety: { type: "boolean" } } },
    run: ({ below_safety }) => ({ items: inventory.filter((x) => !below_safety || x.on_hand < x.safety_stock) }),
  },
  {
    name: "list_orders", description: "近 14 天订单，按时间倒序", annotations: ro,
    inputSchema: { type: "object", properties: { limit: { type: "integer", default: 50 }, channel: str("门店/小程序/美团") } },
    run: ({ limit = 50, channel }) => ({ orders: orders.filter((o) => !channel || o.channel === channel).slice(0, Math.min(limit, 200)) }),
  },
  {
    name: "list_members", description: "会员列表", annotations: ro,
    inputSchema: { type: "object", properties: { level: str("普通/银卡/金卡") } },
    run: ({ level }) => ({ members: members.filter((m) => !level || m.level === level) }),
  },
];

// ---------- MCP Streamable HTTP ----------
const sessions = new Set();
function handle(msg) {
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-erp", version: "0.0.0" } });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: tools.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `未知工具 ${msg.params?.name}`);
      const data = tool.run(msg.params?.arguments ?? {});
      return ok({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
    }
    default:
      return fail(-32601, `不支持的方法 ${msg.method}`);
  }
}

createServer(async (req, res) => {
  if (new URL(req.url, "http://x").pathname !== "/mcp") return res.writeHead(404).end();
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end("unauthorized");
  const sid = req.headers["mcp-session-id"];
  if (req.method === "DELETE") { sessions.delete(sid); return res.writeHead(204).end(); }
  if (req.method !== "POST") return res.writeHead(405).end();
  let body = "";
  for await (const chunk of req) body += chunk;
  let msg;
  try { msg = JSON.parse(body); } catch { return res.writeHead(400).end("bad json"); }
  const headers = { "Content-Type": "application/json" };
  if (msg.method === "initialize") {
    const id = randomUUID();
    sessions.add(id);
    headers["Mcp-Session-Id"] = id;
  } else if (sid && !sessions.has(sid)) {
    return res.writeHead(404).end("session expired");
  }
  if (msg.id === undefined) return res.writeHead(202).end(); // 通知
  res.writeHead(200, headers).end(JSON.stringify(handle(msg)));
}).listen(PORT, HOST, () => {
  console.log(`假 ERP MCP 已启动 http://${HOST}:${PORT}/mcp（${tools.length} 个工具，${products.length} 个商品${TOKEN ? "，需 Bearer ERP_MCP_TOKEN" : "，未鉴权"}）`);
});
