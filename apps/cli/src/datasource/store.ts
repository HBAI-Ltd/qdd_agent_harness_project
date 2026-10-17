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

const pad = (n: number) => String(n).padStart(2, "0");
export const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function emptyStoreData(): StoreData {
  return {
    store: { name: "", address: "", openHours: "", generatedAt: "" },
    products: [],
    inventory: [],
    opening: { at: "", rows: [] },
    movements: [],
    orders: [],
  };
}

export async function ensureStoreData(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, JSON.stringify(emptyStoreData()), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function loadStoreData(file: string): Promise<StoreData> {
  await ensureStoreData(file);
  return JSON.parse(await readFile(file, "utf8")) as StoreData;
}
