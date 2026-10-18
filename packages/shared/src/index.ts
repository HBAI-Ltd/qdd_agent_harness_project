export * from "./compute.js";
export * from "./page-bridge.js";

export const SERVICE_NAME = "qdd-agent-harness";
export const HARNESS_VERSION = "0.3.0";

export type JsonObject = { [key: string]: unknown };

/** 数据源工具的统一描述（内置 tools 与 MCP 工具共用）。 */
export interface ToolSpec {
  name: string;
  /** 后端提供的易读展示名称，name 仍为调用标识。 */
  title?: string;
  description: string;
  inputSchema: JsonObject;
}

/** 远程 MCP 服务（Streamable HTTP）。 */
export interface McpServerConfig {
  url: string;
  /** 存放 Bearer token 的环境变量名；token 不写进配置文件。 */
  bearerTokenEnv?: string;
  /** 每次连接时读取的 Bearer token 文件；相对路径基于项目根目录，与 bearerTokenEnv 二选一。 */
  bearerTokenFile?: string;
  headers?: Record<string, string>;
  /** 只暴露名称匹配的工具（支持 * 通配）；缺省为全部。 */
  allowTools?: string[];
  /** 为 true 时写入类工具无需逐次授权。 */
  allowWrite?: boolean;
}

export interface ModelConfig extends ChatModelConfig {
  /** 提供方分组名，如 DeepSeek */
  provider?: string;
  /** 实际请求的模型名；缺省使用 id，兼容原有模型配置。 */
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
  thinking?: "enabled" | "disabled";
}

/** 前端可选的模型目录（不含密钥与地址）。 */
export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  model: string;
  /** 对应的 API Key 环境变量是否已配置 */
  available: boolean;
}

export interface ModelCatalog {
  models: ModelOption[];
  default: string;
}

/** 会话附件引用（任意扩展名；文件夹上传时 path 保留目录结构）。 */
export interface AttachmentRef {
  id: string;
  name: string;
  /** 相对路径，如 报表/2026-09/销售.csv */
  path: string;
  size: number;
  mime: string;
}

export interface HarnessConfig {
  /** 工作区目录（风格提示词、门店数据、页面、会话），相对仓库根目录。 */
  workspace: string;
  llm: {
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    /** 单次回复的最大输出 token（长页面文件需要较大值） */
    maxTokens: number;
    /** required：新许愿写页面前必须先 clarify；auto：由模型判断；off：不提问 */
    clarify: "required" | "auto" | "off";
    /** 思考模式：enabled 时请求 thinking 并以 reasoning_content 流式返回思考过程 */
    thinking: "enabled" | "disabled";
    /** 可选的思考强度默认值；default 沿用 thinking 与服务商默认强度。 */
    reasoningEffort?: ReasoningEffort;
    /** 可切换的模型；缺省只有上面这一个。未填写的字段沿用上面的默认值。 */
    models?: ModelConfig[];
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
  /** 页面播放器允许连接的 HTTPS origin（可含端口）；["*"] 显式允许所有 HTTP/HTTPS 视频源，默认空。 */
  mediaOrigins?: string[];
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
  /** 最近一轮使用的思考强度；旧会话缺省时沿用网关配置。 */
  reasoningEffort?: ReasoningEffort;
  /** 工具调用权限；旧会话缺省为审批。 */
  permissionMode?: PermissionMode;
  /** 会话来源：缺省为店长发起；定时任务触发时记录任务 id。 */
  origin?: { kind: "schedule"; scheduleId: string; scheduleName: string };
  /** 选择的模型 id；缺省用默认模型。下一轮起生效。 */
  model?: string;
  createdAt: string;
  updatedAt: string;
}

type At = { at: string };

/** 一次工具调用；与 Toonflow agent 的 ToolCall 对齐，按 id 合并状态更新。 */
export interface AgentToolCall {
  id: string;
  name: string;
  /** 后端配置的展示名称；旧会话可能没有。 */
  title?: string;
  args?: JsonObject;
  status: "running" | "success" | "error";
  /** 工具执行时的进度说明（如「查询 xx」「写入 xx」） */
  progress?: string;
  result?: string;
}

/**
 * 助手回复的内容块事件，与 Toonflow agent 的 AgentEvent 对齐：
 * blockId 为「回复 id:块序号」，同一回复的思考、正文、工具调用按序号组成一个 parts 数组。
 * delta 只经 SSE 实时推送、不落盘；done 与 tool 事件落盘用于回放。
 */
export type AssistantBlockEvent =
  | { type: "text" | "thinking"; blockId: string; delta?: string; content?: string; done?: boolean }
  | { type: "tool"; blockId: string; tool: AgentToolCall };

export type AssistantPart =
  | { id: string; type: "text" | "thinking"; content: string; done: boolean }
  | { id: string; type: "tool"; tool: AgentToolCall };

export type SessionEvent = At &
  (
    | { type: "user"; text: string; attachments?: AttachmentRef[] }
    | { type: "status"; status: SessionStatus }
    | { type: "say"; text: string }
    | AssistantBlockEvent
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

/** default 不传 reasoning_effort；none 关闭思考，其余值透传服务商。 */
export type ReasoningEffort = "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type PermissionMode = "approval" | "full-access";

export interface ChatSelection {
  model: string;
  reasoningEffort: ReasoningEffort;
  permissionMode?: PermissionMode;
}

export interface ChatModelConfig {
  id: string;
  label?: string;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export interface ChatModelOption {
  id: string;
  label: string;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
}

/** GET /api/chat/options：仅返回安全的可选项，不包含服务商地址或密钥。 */
export interface ChatOptions {
  models: ChatModelOption[];
  defaults: ChatSelection;
}

export interface CreateWishBody extends Partial<ChatSelection> {
  wish: string;
  /** 在已有页面上修改（新开会话）。 */
  slug?: string;
  /** 预先加载的技能（名称或 id） */
  skillId?: string;
  /** 已上传附件的 id */
  attachments?: string[];
  /** 模型 id */
  model?: string;
}

export interface SendMessageBody extends Partial<ChatSelection> {
  text: string;
  attachments?: string[];
  model?: string;
}

export interface SelectModelBody {
  model: string;
}

export interface ApprovalBody {
  approved: boolean;
}

export interface AskImage {
  /** Base64 image data URL or an HTTPS URL accessible to the model provider. */
  url: string;
  detail?: "auto" | "low" | "high";
}

export interface AskBody {
  question: string;
  context?: unknown;
  images?: AskImage[];
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
  source: "user" | "agent" | "builtin";
  /** 内置技能的完整说明，默认加入会话上下文。 */
  instructions?: string;
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
  /** 网关进程内的执行状态，仅接口返回，不写入 schedules.json。 */
  currentRun?: { sessionId: string; status: SessionStatus };
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

export type ConnectorType = "feishu" | "pos" | "camera" | "phone";

export type LocalMcpProvider = "haik" | "tysl" | "ezviz" | "shouqianba" | "android";

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
  /** 本地 MCP 接入平台，由用户选择并确认后才安装。 */
  providers?: { id: LocalMcpProvider; name: string }[];
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

export interface LocalMcpConnectorInput {
  type: "pos" | "camera" | "phone";
  mode: "mcp";
  provider: LocalMcpProvider;
  name?: string;
}

export type ConnectorInput = FeishuConnectorInput | LocalMcpConnectorInput;

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

// ---------------------------------------------------------------- 摄像头云账号

/** haik：海康互联（短信 + 人机验证）；tysl：天翼视联（官方登录页授权） */
export type CameraProvider = "haik" | "tysl";

export interface CameraAccountStatus {
  provider: CameraProvider;
  name: string;
  /** harness.config.json 的 mcpServers 中是否配置了同名服务 */
  configured: boolean;
  /** 本地服务是否可访问 */
  reachable: boolean;
  connected: boolean;
  /** 脱敏后的账号，如 138****0000 */
  account?: string;
  detail?: string;
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
