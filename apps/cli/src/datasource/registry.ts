import type { JsonObject, MetricCatalog, ToolSpec } from "@qdd/shared";
import type { LoadedConfig } from "../config.js";
import { loadMetrics } from "../datasets/metrics.js";
import { seedBuiltinDatasets } from "../datasets/seed.js";
import { JsonlDatasetStore, type DatasetStore } from "../datasets/store.js";
import { createStoreTools } from "./builtin.js";
import { McpClient } from "./mcp-client.js";
import { loadStoreData, type StoreData } from "./store.js";

export interface DataTool extends ToolSpec {
  /** 来源：store（内置）或 mcp:<服务名> */
  source: string;
  /** 写入类工具调用前需要用户授权。 */
  mutating: boolean;
  /** 已在配置中预先授权写入。 */
  preauthorized: boolean;
  call(args: JsonObject): Promise<unknown>;
}

/** 返回 true 表示用户授权本次调用。 */
export type Authorizer = (tool: DataTool, args: JsonObject) => Promise<boolean>;

const MUTATING_NAME = /(^|[_\-.])(create|update|delete|remove|set|write|insert|drop|put|post|patch|upsert|add|cancel|refund|send|exec|run)/i;

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

export class DataSources {
  private constructor(
    readonly tools: DataTool[],
    private readonly clients: McpClient[],
    readonly warnings: string[],
    /** 数据集存储（当前为 JSONL 实现，可替换） */
    readonly datasets: DatasetStore,
    readonly metrics: () => Promise<MetricCatalog>,
  ) {}

  static async open({ config, paths }: LoadedConfig): Promise<DataSources> {
    let cache: StoreData | undefined;
    const load = async () => (cache ??= await loadStoreData(paths.store));
    const datasets = new JsonlDatasetStore(paths.datasets);
    const metrics = () => loadMetrics(paths);
    await seedBuiltinDatasets(datasets, load);
    const tools: DataTool[] = createStoreTools({ load, store: datasets, metrics }).map((t) => ({
      name: `store__${t.name}`,
      description: t.description,
      inputSchema: t.inputSchema,
      source: "store",
      mutating: false,
      preauthorized: false,
      call: (args) => t.run(args),
    }));

    const clients: McpClient[] = [];
    const warnings: string[] = [];
    await Promise.all(
      Object.entries(config.mcpServers).map(async ([name, server]) => {
        let client: McpClient | undefined;
        try {
          client = new McpClient(name, server);
          await client.start();
          const allow = (server.allowTools ?? ["*"]).map(globToRegExp);
          for (const t of await client.listTools()) {
            if (!allow.some((re) => re.test(t.name))) continue;
            const readOnly = t.annotations?.readOnlyHint === true;
            tools.push({
              name: `mcp__${sanitize(name)}__${sanitize(t.name)}`.slice(0, 64),
              description: `[MCP ${name}] ${t.description ?? ""}`,
              inputSchema: t.inputSchema ?? { type: "object", properties: {} },
              source: `mcp:${name}`,
              mutating: t.annotations?.destructiveHint === true || (!readOnly && MUTATING_NAME.test(t.name)),
              preauthorized: server.allowWrite === true,
              call: (args) => client!.callTool(t.name, args),
            });
          }
          clients.push(client);
        } catch (error) {
          void client?.close();
          warnings.push(`MCP 服务 ${name} 接入失败：${(error as Error).message}`);
        }
      }),
    );
    return new DataSources(tools, clients, warnings, datasets, metrics);
  }

  get(name: string): DataTool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  async call(name: string, args: JsonObject, authorize: Authorizer): Promise<unknown> {
    const tool = this.get(name);
    if (!tool) throw new Error(`未知数据工具：${name}`);
    if (tool.mutating && !tool.preauthorized && !(await authorize(tool, args))) {
      throw new Error(`用户未授权写入操作 ${name}，不得重试或绕过。`);
    }
    return tool.call(args);
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close()));
  }
}
