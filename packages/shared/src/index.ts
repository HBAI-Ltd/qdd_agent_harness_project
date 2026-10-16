export * from "./compute.js";

export const SERVICE_NAME = "qdd-agent-harness";
export const HARNESS_VERSION = "0.3.0";

export type JsonObject = { [key: string]: unknown };

/** 数据源工具的统一描述（内置 tools 与 MCP 工具共用）。 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

/** 远程 MCP 服务（Streamable HTTP）。 */
export interface McpServerConfig {
  url: string;
  /** 存放 Bearer token 的环境变量名；token 不写进配置文件。 */
  bearerTokenEnv?: string;
  headers?: Record<string, string>;
  /** 只暴露名称匹配的工具（支持 * 通配）；缺省为全部。 */
  allowTools?: string[];
  /** 为 true 时写入类工具无需逐次授权。 */
  allowWrite?: boolean;
}

export interface HarnessConfig {
  /** 工作区目录（风格提示词、门店数据、页面、会话），相对仓库根目录。 */
  workspace: string;
  llm: {
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    maxSteps: number;
  };
  gateway: {
    host: string;
    port: number;
    /** 网关访问 token 所在环境变量；未设置时自动生成并保存在工作区。 */
    tokenEnv: string;
    /** 允许跨域调用网关的前端源，如 http://localhost:3000。 */
    corsOrigins: string[];
  };
  /** 页面允许引用的在线包域名。 */
  cdnAllowlist: string[];
  mcpServers: Record<string, McpServerConfig>;
  datasets: {
    /** 网关后台增量刷新数据集的间隔（秒），0 为不自动刷新。 */
    refreshIntervalSec: number;
  };
}

// ---------------------------------------------------------------- 数据集

export type DatasetKind = "fact" | "dimension" | "event_log";

export interface DatasetSource {
  /** 数据工具名（内置或 mcp__*） */
  tool: string;
  args?: JsonObject;
  /** 增量参数名：刷新时传入上次水位线 */
  sinceArg?: string;
  /** 结果中行数组所在字段，缺省时结果本身应为数组 */
  rowsField?: string;
  /** 外部编号映射：{ 字段: 映射数据集 }，映射数据集行格式为 { from, to } */
  keymap?: Record<string, string>;
}

export interface DatasetManifest {
  name: string;
  description: string;
  kind: DatasetKind;
  fields: Record<string, "string" | "number" | "boolean">;
  /** 主键字段 */
  key: string[];
  /** fact/event_log 的时间字段（按天分区） */
  timeField?: string;
  /** event_log 的回放规则 */
  replay?: { key: string; delta: string; op?: string; value: string };
  source?: DatasetSource;
  /** 内容版本：每次写入变化 */
  version: string;
  /** 已包含数据的最新时间 */
  watermark: string | null;
  rowCount: number;
  updatedAt: string;
}

// ---------------------------------------------------------------- 页面

export interface PageEntry {
  slug: string;
  title: string;
  wish: string;
  summary: string;
  /** 页面运行时可直接调用的只读工具。 */
  tools: string[];
  /** 页面运行时可调用 agent（qdd.ask）。 */
  useAgent: boolean;
  /** 页面使用的指标 */
  metrics: string[];
  /** 发布时依赖的数据集版本 */
  datasets: Record<string, string>;
  /** 页面版本，每次发布 +1（并发修改的乐观锁） */
  version: number;
  /** 依赖的指标口径变更后标记，提示需要复核 */
  stale: string | null;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/pages 的条目：附带页面访问地址（含页面级 token）。 */
export interface PageView extends PageEntry {
  url: string;
}

// ---------------------------------------------------------------- 会话

export type SessionStatus = "running" | "idle" | "error";

export interface SessionMeta {
  id: string;
  title: string;
  /** 最近一轮的结论摘要，供跨会话检索 */
  summary: string;
  /** 会话产出的页面；首次发布前为 null。 */
  slug: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

type At = { at: string };

export type SessionEvent = At &
  (
    | { type: "user"; text: string }
    | { type: "status"; status: SessionStatus }
    | { type: "say"; text: string }
    | { type: "tool"; text: string }
    | { type: "warn"; text: string }
    | { type: "approval_required"; requestId: string; tool: string; source: string; args: JsonObject }
    | { type: "approval_resolved"; requestId: string; approved: boolean }
    | { type: "published"; page: PageEntry; files: string[] }
    | { type: "error"; message: string }
  );

export interface SessionDetail extends SessionMeta {
  events: SessionEvent[];
}

// ---------------------------------------------------------------- API

export interface CreateWishBody {
  wish: string;
  /** 在已有页面上修改（新开会话）。 */
  slug?: string;
}

export interface SendMessageBody {
  text: string;
}

export interface ApprovalBody {
  approved: boolean;
}

export interface AskBody {
  question: string;
  context?: unknown;
}

export interface ToolInfo extends ToolSpec {
  source: string;
  mutating: boolean;
}

/** 网关推送（GET /api/events）的全局事件。 */
export type GatewayEvent =
  | { type: "pages_changed" }
  | { type: "session_updated"; session: SessionMeta };

export interface ApiError {
  error: string;
}
