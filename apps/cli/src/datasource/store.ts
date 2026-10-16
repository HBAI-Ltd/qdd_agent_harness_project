import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Product {
  sku: string;
  name: string;
  category: string;
  price: number;
  cost: number;
  unit: string;
}

export interface InventoryItem {
  sku: string;
  stock: number;
  safetyStock: number;
}

export interface OrderItem {
  sku: string;
  qty: number;
  price: number;
}

export interface Order {
  id: string;
  /** 本地时间，格式 YYYY-MM-DD HH:mm */
  time: string;
  channel: "门店" | "外卖" | "小程序";
  items: OrderItem[];
  total: number;
}

export interface InventoryMove {
  id: string;
  /** YYYY-MM-DD HH:mm */
  time: string;
  sku: string;
  type: "receipt" | "sale" | "stocktake";
  /** delta：增量；set：盘点后的绝对库存 */
  op: "delta" | "set";
  delta: number;
  /** op=set 时的盘点结果 */
  stock: number | null;
}

export interface StoreData {
  store: { name: string; address: string; openHours: string; generatedAt: string };
  products: Product[];
  /** 当前库存（= 期初 + 全部流水回放） */
  inventory: InventoryItem[];
  /** 期初库存（第一天 00:00） */
  opening: { at: string; rows: { sku: string; stock: number }[] };
  movements: InventoryMove[];
  orders: Order[];
}

const CATALOG: [string, string, number, number, string, number][] = [
  // name, category, price, cost, unit, popularity
  ["农夫山泉 550ml", "饮料", 2, 1.1, "瓶", 10],
  ["可口可乐 330ml", "饮料", 3.5, 2.1, "罐", 8],
  ["东方树叶 500ml", "饮料", 5, 3.2, "瓶", 6],
  ["元气森林 480ml", "饮料", 5.5, 3.4, "瓶", 6],
  ["蒙牛纯牛奶 250ml", "乳品", 3.5, 2.4, "盒", 7],
  ["光明酸奶 200g", "乳品", 6.5, 4.3, "杯", 4],
  ["乐事薯片 75g", "零食", 7.5, 4.6, "袋", 5],
  ["奥利奥 97g", "零食", 8.9, 5.8, "盒", 3],
  ["卫龙辣条 106g", "零食", 5, 2.9, "袋", 5],
  ["德芙巧克力 43g", "零食", 9.9, 6.2, "条", 2],
  ["康师傅红烧牛肉面", "速食", 4.5, 2.9, "桶", 6],
  ["统一老坛酸菜面", "速食", 4.5, 2.9, "桶", 4],
  ["饭团（金枪鱼）", "鲜食", 6.9, 3.8, "个", 6],
  ["三明治（火腿芝士）", "鲜食", 9.9, 5.6, "个", 4],
  ["关东煮套餐", "鲜食", 12, 5.5, "份", 3],
  ["青岛啤酒 500ml", "烟酒", 6, 3.9, "罐", 4],
  ["清风抽纸 3包", "日用品", 9.9, 6.5, "提", 2],
  ["高露洁牙膏 140g", "日用品", 12.9, 8.1, "支", 1],
  ["雨伞（折叠）", "日用品", 29, 15, "把", 1],
  ["充电宝租借", "服务", 4, 1, "次", 2],
];

/** 确定性伪随机数，保证同一天生成的数据一致。 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
export const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function generateStoreData(endDate = new Date(), days = 60): StoreData {
  const rand = mulberry32(20260101);
  const products: Product[] = CATALOG.map(([name, category, price, cost, unit], i) => ({
    sku: `SKU${String(i + 1).padStart(3, "0")}`,
    name,
    category,
    price,
    cost,
    unit,
  }));
  const weights = CATALOG.map((c) => c[5]);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const pick = () => {
    let r = rand() * weightSum;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i]!;
      if (r <= 0) return products[i]!;
    }
    return products[products.length - 1]!;
  };
  // 早中晚三个高峰
  const hourWeights = [0, 0, 0, 0, 0, 0, 0, 3, 8, 5, 3, 5, 9, 6, 3, 3, 4, 6, 9, 7, 5, 4, 3, 2];
  const hourSum = hourWeights.reduce((a, b) => a + b, 0);
  const pickHour = () => {
    let r = rand() * hourSum;
    for (let h = 0; h < 24; h++) {
      r -= hourWeights[h]!;
      if (r <= 0) return h;
    }
    return 12;
  };

  const safety = new Map(products.map((p, i) => [p.sku, 10 + weights[i]! * 4]));
  const stock = new Map(products.map((p) => [p.sku, safety.get(p.sku)! * 2]));
  const firstDay = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - (days - 1));
  const opening = { at: `${formatDate(firstDay)} 00:00`, rows: products.map((p) => ({ sku: p.sku, stock: stock.get(p.sku)! })) };
  const movements: InventoryMove[] = [];
  const move = (m: Omit<InventoryMove, "id">) => movements.push({ id: `M${String(movements.length + 1).padStart(6, "0")}`, ...m });

  const orders: Order[] = [];
  let seq = 1;
  for (let d = days - 1; d >= 0; d--) {
    const day = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - d);
    const date = formatDate(day);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const trend = 1 + (days - d) / days / 5;

    // 早上到货：低于安全库存的商品大概率补货（偶尔漏补，形成缺货区间）
    for (const p of products) {
      const s = stock.get(p.sku)!;
      const safe = safety.get(p.sku)!;
      if (s < safe && rand() < 0.7) {
        const qty = safe * 2 - s + Math.floor(rand() * 5);
        move({ time: `${date} 06:30`, sku: p.sku, type: "receipt", op: "delta", delta: qty, stock: null });
        stock.set(p.sku, s + qty);
      }
    }

    const count = Math.round((45 + rand() * 35) * (weekend ? 1.25 : 1) * trend);
    const dayOrders: Order[] = [];
    for (let k = 0; k < count; k++) {
      const lines = new Map<string, OrderItem>();
      const n = 1 + Math.floor(rand() * rand() * 4);
      for (let j = 0; j < n; j++) {
        const p = pick();
        const line = lines.get(p.sku) ?? { sku: p.sku, qty: 0, price: p.price };
        line.qty += 1;
        lines.set(p.sku, line);
      }
      const r = rand();
      dayOrders.push({
        id: "",
        time: `${date} ${pad(pickHour())}:${pad(Math.floor(rand() * 60))}`,
        channel: r < 0.68 ? "门店" : r < 0.88 ? "外卖" : "小程序",
        items: [...lines.values()],
        total: 0,
      });
    }
    dayOrders.sort((a, b) => a.time.localeCompare(b.time));
    for (const o of dayOrders) {
      // 库存不足的商品卖不出去
      o.items = o.items.filter((it) => {
        const s = stock.get(it.sku)!;
        if (s < it.qty) return false;
        stock.set(it.sku, s - it.qty);
        return true;
      });
      if (!o.items.length) continue;
      o.id = `O${String(seq++).padStart(6, "0")}`;
      o.total = Math.round(o.items.reduce((sum, it) => sum + it.qty * it.price, 0) * 100) / 100;
      for (const it of o.items) move({ time: o.time, sku: it.sku, type: "sale", op: "delta", delta: -it.qty, stock: null });
      orders.push(o);
    }

    // 每月 1 日、15 日闭店后盘点（时间晚于当天所有订单），记录损耗
    if (day.getDate() === 1 || day.getDate() === 15) {
      for (const p of products) {
        const s = stock.get(p.sku)!;
        const counted = Math.max(0, s - Math.floor(rand() * 3));
        move({ time: `${date} 23:59:59`, sku: p.sku, type: "stocktake", op: "set", delta: counted - s, stock: counted });
        stock.set(p.sku, counted);
      }
    }
  }

  return {
    store: {
      name: "钱多多便利店（示例门店）",
      address: "示例市示例区幸福路 88 号",
      openHours: "07:00-24:00",
      generatedAt: new Date().toISOString(),
    },
    products,
    inventory: products.map((p) => ({ sku: p.sku, stock: stock.get(p.sku)!, safetyStock: safety.get(p.sku)! })),
    opening,
    movements,
    orders,
  };
}

export async function ensureStoreData(file: string): Promise<void> {
  try {
    // 旧版本数据没有库存流水，重新生成
    if (!(await readFile(file, "utf8")).includes('"movements"')) throw new Error("outdated");
  } catch {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(generateStoreData()), "utf8");
  }
}

export async function loadStoreData(file: string): Promise<StoreData> {
  await ensureStoreData(file);
  return JSON.parse(await readFile(file, "utf8")) as StoreData;
}
