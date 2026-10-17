export * from "./compute.js";
export * from "./page-bridge.js";

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
    /** 单次回复的最大输出 token（长页面文件需要较大值） */
    maxTokens: number;
    /** required：新许愿写页面前必须先 clarify；auto：由模型判断；off：不提问 */
    clarify: "required" | "auto" | "off";
  };
  /** 授权请求等待店长处理的时长（分钟），超时视为拒绝；工作台可集中处理。 */
  approvalTimeoutMin: number;
  /** 浏览器工具：agent 操作本机 Chrome/Edge，前端可实时观看与接管 */
  browser: {
    enabled: boolean;
    /** 浏览器程序绝对路径；留空自动查找 Chrome / Edge / Chromium */
    executablePath: string;
    /** confirm：每个会话首次点击/输入前需店长授权；auto：无需授权 */
    permission: "confirm" | "auto";
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

/** record：门店在页面上登记的记录（报损、处置回填等），由页面经网关写入。 */
export type DatasetKind = "fact" | "dimension" | "event_log" | "record";

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
  /** record 数据集的字段说明（店长确认过的登记表结构） */
  record?: RecordSchema;
  /** 内容版本：每次写入变化 */
  version: string;
  /** 已包含数据的最新时间 */
  watermark: string | null;
  rowCount: number;
  updatedAt: string;
}

// ---------------------------------------------------------------- 记录数据集

export interface RecordField {
  name: string;
  label: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  /** 候选值（只允许这些值） */
  options?: string[];
}

/**
 * 记录数据集 records/<name>：每行自带 id（主键）、time（YYYY-MM-DD HH:mm，按天分区）、page（登记来源页面）。
 * 更新按 id 覆盖，作废写入墓碑，聚合与读取都只看最新且未作废的行。
 */
export interface RecordSchema {
  label: string;
  fields: RecordField[];
}

/** POST /api/records/:name 的单行或多行；PUT /api/records/:name/:id 为部分字段。 */
export type RecordInput = Record<string, string | number | boolean | null>;

// ---------------------------------------------------------------- 能力缺口

/**
 * 无法用真实数据回答的部分必须显式声明：
 * missing_data 缺数据；estimate 基于假设的估测/推演；unsupported 当前能力不支持；permission 需要授权/被拒绝。
 */
export type GapKind = "missing_data" | "estimate" | "unsupported" | "permission";

export interface CapabilityGap {
  kind: GapKind;
  /** 涉及的需求或指标 */
  item: string;
  /** 为什么做不到 / 估测依据的假设 */
  reason: string;
  /** 补齐能力需要什么（接入哪个数据源、授权等） */
  suggestion?: string;
}

// ---------------------------------------------------------------- 需求澄清

export interface ClarifyOption {
  label: string;
  description?: string;
}

/** agent 向店长提出的引导式问题：给出候选项，推荐项排第一。 */
export interface ClarifyQuestion {
  id: string;
  /** 简短标签，如「时间范围」 */
  header: string;
  question: string;
  options: ClarifyOption[];
  multiSelect: boolean;
  /** 允许店长输入候选项以外的内容 */
  allowOther: boolean;
}

/** 回答：问题 id → 选中的候选项 label（或自填内容）。 */
export type ClarifyAnswers = Record<string, string[]>;

export interface AnswerBody {
  answers: ClarifyAnswers;
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
  /** 页面运行时可读写的记录数据集（qdd.records，名称不含 records/ 前缀） */
  records?: string[];
  /** 页面使用的指标 */
  metrics: string[];
  /** 发布时依赖的数据集版本 */
  datasets: Record<string, string>;
  /** 页面版本，每次发布 +1（并发修改的乐观锁） */
  version: number;
  /** 依赖的指标口径变更后标记，提示需要复核 */
  stale: string | null;
  /** 能力缺口声明（网关会强制展示在页面上） */
  gaps: CapabilityGap[];
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/pages 的条目：附带页面访问地址（含页面级 token）。 */
export interface PageView extends PageEntry {
  url: string;
  /** scheduled：有定时任务在该页面上刷新；once：一次性产出。 */
  kind: "scheduled" | "once";
  /** 刷新该页面的定时任务 */
  schedules: { id: string; name: string; enabled: boolean }[];
  /** 置顶时间；未置顶为 null。列表中置顶页面按置顶先后排在最前。 */
  pinnedAt: string | null;
}

// ---------------------------------------------------------------- 会话

/** waiting：等待店长回答问题或授权。 */
export type SessionStatus = "running" | "waiting" | "idle" | "error";

export interface SessionMeta {
  id: string;
  title: string;
  /** 最近一轮的结论摘要，供跨会话检索 */
  summary: string;
  /** 会话产出的页面；首次发布前为 null。 */
  slug: string | null;
  status: SessionStatus;
  /** 会话来源：缺省为店长发起；定时任务触发时记录任务 id。 */
  origin?: { kind: "schedule"; scheduleId: string; scheduleName: string };
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
    | { type: "question_required"; requestId: string; round: number; questions: ClarifyQuestion[] }
    | { type: "question_answered"; requestId: string; answers: ClarifyAnswers | null }
    | { type: "published"; page: PageEntry; files: string[] }
    | { type: "gaps"; gaps: CapabilityGap[] }
    | { type: "skill"; skill: { id: string; name: string }; action: "loaded" | "saved" }
    | { type: "browser"; browser: BrowserSessionState }
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
  /** 预先加载的技能（名称或 id） */
  skillId?: string;
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
  | { type: "session_updated"; session: SessionMeta }
  | { type: "pending_changed" }
  | { type: "skills_changed" }
  | { type: "schedules_changed" }
  | { type: "connectors_changed" };

export interface ApiError {
  error: string;
}

// ---------------------------------------------------------------- 工作台：待办与总览

/** 跨会话等待店长处理的事项（授权 / 澄清问题）。 */
export type PendingItem = {
  requestId: string;
  sessionId: string;
  sessionTitle: string;
  origin?: SessionMeta["origin"];
  createdAt: string;
  /** 超时时间，超时后授权视为拒绝、问题按推荐项继续 */
  expiresAt: string;
} & (
  | { kind: "approval"; tool: string; source: string; args: JsonObject }
  | { kind: "question"; questions: ClarifyQuestion[] }
);

/** GET /api/overview：工作台总览与侧边栏计数。 */
export interface Overview {
  sessions: { total: number; running: number; waiting: number; error: number; active: { id: string; title: string; status: SessionStatus }[] };
  pages: { total: number; stale: number };
  skills: { total: number };
  schedules: { total: number; enabled: number; next: { id: string; name: string; at: string } | null };
  connectors: { total: number; connected: number };
  pending: PendingItem[];
}

// ---------------------------------------------------------------- 技能

/** 可复用的做事方法：步骤 + 用到的工具，agent 运行时加载。 */
export interface Skill {
  id: string;
  name: string;
  description: string;
  steps: string[];
  /** 用到的数据工具 / harness 工具，如 store__get_inventory、send_notification */
  tools: string[];
  source: "user" | "agent";
  /** agent 从对话中提炼时的来源会话 */
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillInput {
  name: string;
  description: string;
  steps: string[];
  tools?: string[];
}

// ---------------------------------------------------------------- 定时任务

export interface ScheduleRun {
  at: string;
  sessionId: string | null;
  status: "ok" | "error";
  /** 结论摘要或错误信息 */
  message: string;
  /** 推送结果 */
  notified?: { connectorId: string; ok: boolean; error?: string };
}

export interface Schedule {
  id: string;
  name: string;
  /** 5 段 cron（分 时 日 月 周），按网关所在时区 */
  cron: string;
  /** 每次执行时交给 agent 的任务描述 */
  prompt: string;
  /** 绑定的技能，执行时预先加载 */
  skillId?: string;
  /** 在已有页面上刷新 */
  slug?: string;
  /** 执行完成后推送到的连接器（如飞书） */
  notify?: { connectorId: string };
  /** 由 agent 在会话中创建（经店长授权）时记录来源会话 */
  createdBy?: { kind: "agent"; sessionId: string };
  enabled: boolean;
  nextRunAt: string | null;
  lastRun: ScheduleRun | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleInput {
  name: string;
  cron: string;
  prompt: string;
  skillId?: string | null;
  slug?: string | null;
  notify?: { connectorId: string } | null;
  enabled?: boolean;
}

// ---------------------------------------------------------------- 连接器

export type ConnectorType = "feishu";

/** read：只查看数据；confirm：写入/推送需店长逐次确认；auto：无需确认。 */
export type ConnectorPermission = "read" | "confirm" | "auto";

export type ConnectorStatus = "connected" | "error";

/** 连接器目录条目（含暂未开放的类型，供前端展示）。 */
export interface ConnectorCatalogEntry {
  type: string;
  name: string;
  category: string;
  tags: string[];
  available: boolean;
  /** 安装方式，如 webhook / app / mcp */
  modes: string[];
}

export interface FeishuConnectorInput {
  type: "feishu";
  name?: string;
  permission?: ConnectorPermission;
  /** webhook：自定义机器人；app：企业自建应用（需 receiveId 才能推送） */
  mode: "webhook" | "app";
  webhookUrl?: string;
  /** 自定义机器人「签名校验」密钥 */
  signSecret?: string;
  appId?: string;
  appSecret?: string;
  receiveId?: string;
  receiveIdType?: "chat_id" | "open_id" | "user_id" | "union_id" | "email";
}

export type ConnectorInput = FeishuConnectorInput;

/** 返回给前端的连接器：密钥只给是否已设置，不回传明文。 */
export interface ConnectorView {
  id: string;
  type: string;
  name: string;
  /** builtin：内置数据；mcp：配置文件中的 MCP 服务（只读展示）；installed：通过 API 安装 */
  origin: "builtin" | "mcp" | "installed";
  permission: ConnectorPermission;
  status: ConnectorStatus;
  /** 验证结果说明，如机器人名称或错误信息 */
  detail: string;
  config: Record<string, string | boolean>;
  lastVerifiedAt: string | null;
  createdAt: string | null;
}

// ---------------------------------------------------------------- 浏览器（实时画面）

export interface BrowserSessionState {
  browserSessionId: string;
  tabId: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  status: "running" | "closed";
}

/** GET /api/browser/:id/stream 的 SSE 事件；frame.data 为 base64 JPEG。 */
export type BrowserStreamEvent =
  | { type: "state"; session: BrowserSessionState }
  | { type: "frame"; sessionId: string; tabId: string; data: string; mimeType: "image/jpeg"; width: number; height: number }
  | { type: "closed"; sessionId: string }
  | { type: "error"; message: string };

type Modifier = "Alt" | "Control" | "Meta" | "Shift";

/** POST /api/browser/:id/input 的人工接管输入；坐标为画面像素。 */
export type BrowserInput =
  | { type: "mouse"; event: "move" | "down" | "up"; x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: 1 | 2; modifiers?: Modifier[] }
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: 1 | 2; modifiers?: Modifier[] }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers?: Modifier[] }
  | { type: "key"; key: string; event?: "down" | "up" | "press"; modifiers?: Modifier[] }
  | { type: "text"; text: string }
  | { type: "release" }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" };
