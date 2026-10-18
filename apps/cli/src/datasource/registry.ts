import type { JsonObject, McpServerConfig, MetricCatalog, ToolSpec } from "@qdd/shared";
import type { LoadedConfig } from "../config.js";
import { loadMetrics } from "../datasets/metrics.js";
import { JsonlDatasetStore, type DatasetStore } from "../datasets/store.js";
import { loadInstalledMcpServers } from "../workbench/local-mcp.js";
import { createStoreTools } from "./builtin.js";
import { McpClient } from "./mcp-client.js";
import { loadStoreData, type StoreData } from "./store.js";

export interface DataTool extends ToolSpec {
  /** 来源：store（内置）或 mcp:<服务名> */
  source: string;
  /** 写入类工具调用前需要用户授权。 */
  mutating: boolean;
  /** 已在配置中预先授权写入，或属于可立即执行的摄像头紧急停止。 */
  preauthorized: boolean;
  call(args: JsonObject): Promise<unknown>;
}

/** 返回 true 表示用户授权本次调用。 */
export type Authorizer = (tool: DataTool, args: JsonObject) => Promise<boolean>;

const MUTATING_NAME = /(^|[_\-.])(create|update|delete|remove|set|write|insert|drop|put|post|patch|upsert|add|cancel|refund|send|exec|run|move|ptz|snapshot|capture|start|stop)/i;

// 停止已有云台动作不能等待审批；仅豁免这些已知服务的非破坏性停止工具。
const CAMERA_EMERGENCY_STOPS = new Map([
  ["haik", "stop_camera"],
  ["ezviz", "ezviz_camera_stop"],
  ["tysl", "tysl_camera_stop"],
]);

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

export class DataSources {
  private mcpQueue: Promise<void> = Promise.resolve();
  private activeServers: Record<string, McpServerConfig> = {};
  private closed = false;

  private constructor(
    readonly tools: DataTool[],
    private readonly clients: McpClient[],
    readonly warnings: string[],
    /** 数据集存储（当前为 JSONL 实现，可替换） */
    readonly datasets: DatasetStore,
    readonly metrics: () => Promise<MetricCatalog>,
  ) {}

  static async open(loaded: LoadedConfig, options: { connectMcp?: boolean } = {}): Promise<DataSources> {
    const { paths } = loaded;
    let cache: StoreData | undefined;
    const load = async () => (cache ??= await loadStoreData(paths.store));
    const datasets = new JsonlDatasetStore(paths.datasets);
    const metrics = () => loadMetrics(paths);
    const tools: DataTool[] = createStoreTools({ load, store: datasets, metrics }).map((t) => ({
      name: `store__${t.name}`,
      description: t.description,
      inputSchema: t.inputSchema,
      source: "store",
      mutating: false,
      preauthorized: false,
      call: (args) => t.run(args),
    }));

    const sources = new DataSources(tools, [], [], datasets, metrics);
    if (options.connectMcp !== false) await sources.reloadMcp(loaded);
    return sources;
  }

  /** 显式配置与用户安装选择组成的当前 MCP 服务；未选择的本地服务不会接入。 */
  get mcpServers(): Readonly<Record<string, McpServerConfig>> {
    return this.activeServers;
  }

  /** 原位更新，SessionHub、定时任务及网关继续共享同一个数据源实例。 */
  reloadMcp(loaded: LoadedConfig): Promise<void> {
    const run = this.mcpQueue.then(async () => {
      if (this.closed) throw new Error("数据源已关闭");
      // 在队列执行时读取持久化选择，防止并发安装/卸载用旧快照覆盖新状态。
      const servers = await loadInstalledMcpServers(loaded.paths, loaded.config.mcpServers);
      const loadedServers = await Promise.all(Object.entries(servers).map(async ([name, server]) => {
        let client: McpClient | undefined;
        try {
          client = new McpClient(name, server);
          await client.start();
          const allow = (server.allowTools ?? ["*"]).map(globToRegExp);
          const tools: DataTool[] = [];
          for (const t of await client.listTools()) {
            if (!allow.some((re) => re.test(t.name))) continue;
            const readOnly = t.annotations?.readOnlyHint;
            const emergencyStop = CAMERA_EMERGENCY_STOPS.get(name) === t.name && t.annotations?.destructiveHint === false;
            tools.push({
              name: `mcp__${sanitize(name)}__${sanitize(t.name)}`.slice(0, 64),
              description: `[MCP ${name}] ${t.description ?? ""}`,
              inputSchema: t.inputSchema ?? { type: "object", properties: {} },
              source: `mcp:${name}`,
              // 工具名无法证明没有副作用，未明确声明只读的 MCP 工具均需授权。
              mutating: t.annotations?.destructiveHint === true || MUTATING_NAME.test(t.name) || !readOnly,
              preauthorized: server.allowWrite === true,
              call: (args) => client!.callTool(t.name, args),
            });
          }
          return { client, tools, warning: undefined };
        } catch (error) {
          await client?.close();
          return { client: undefined, tools: [], warning: `MCP 服务 ${name} 接入失败：${(error as Error).message}` };
        }
      }));
      const oldClients = this.clients.splice(0);
      this.tools.splice(0, this.tools.length, ...this.tools.filter((t) => t.source === "store"), ...loadedServers.flatMap((s) => s.tools));
      this.warnings.splice(0, this.warnings.length, ...loadedServers.flatMap((s) => s.warning ? [s.warning] : []));
      this.clients.push(...loadedServers.flatMap((s) => s.client ? [s.client] : []));
      this.activeServers = servers;
      await Promise.all(oldClients.map((c) => c.close()));
    });
    this.mcpQueue = run.catch(() => undefined);
    return run;
  }

  get(name: string): DataTool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  /** 页面 agent 与直接工具调用共用页面声明的最小工具权限。 */
  restricted(names: readonly string[]): DataSources {
    const allowed = new Set(names);
    return new DataSources(this.tools.filter((tool) => allowed.has(tool.name)), [], this.warnings, this.datasets, this.metrics);
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
    this.closed = true;
    await this.mcpQueue;
    await Promise.all(this.clients.splice(0).map((c) => c.close()));
  }
}
