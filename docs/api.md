# 网关 API（前端对接文档）

harness 不提供界面，前端通过本网关完成：许愿与会话、展示生成的页面、风格设置。
所有类型定义见 `packages/shared/src/index.ts`（`@qdd/shared`），可直接引用。

- 地址：`npm run qdd -- serve` 启动，默认 `http://127.0.0.1:5173`
- 跨域：在 `harness.config.json` 的 `gateway.corsOrigins` 中加入前端源（如 `http://localhost:3000`）
- 错误：非 2xx 响应体统一为 `{ "error": string }`

## 鉴权

| 调用方 | 方式 | 权限 |
| --- | --- | --- |
| 前端 / 管理 | `Authorization: Bearer <网关 token>`；`EventSource` 无法设请求头时用 `?access_token=<token>`（仅 GET） | 全部 `/api/*`、`/mcp` |
| 生成的页面 | SDK 自动携带 `X-QDD-Page` + `X-QDD-Page-Token` | 仅 `POST /api/tools/<页面声明的工具>`、本页面的 `/api/state/<slug>`，以及声明了 `useAgent` 时的 `POST /api/ask` |

网关 token 来自环境变量 `QDD_GATEWAY_TOKEN`（至少 16 位）；未设置时首次启动自动生成到 `workspace/.gateway-token`，`npm run qdd -- token` 查看。

## 许愿与会话

```http
POST /api/wishes                     { "wish": "最近 30 天各品类毛利", "slug"?: "在已有页面上修改" }
→ 201 SessionMeta                    agent 在后台运行
```

```http
GET  /api/sessions                   → SessionMeta[]（按更新时间倒序）
GET  /api/sessions/:id               → SessionDetail（元信息 + 全部事件）
GET  /api/sessions/:id/events        → SSE，先回放历史事件再推送实时事件；?since=N 跳过前 N 条
POST /api/sessions/:id/messages      { "text": "把图表改成按周" } → 202 SessionMeta（运行中时 409）
POST /api/sessions/:id/approvals/:requestId   { "approved": true }
POST /api/sessions/:id/questions/:requestId   { "answers": { "<问题id>": ["<候选项 label 或自填内容>"] } }
POST /api/sessions/:id/cancel        → 202
```

`SessionEvent`（每条 SSE `data:` 一个 JSON）：

| type | 字段 | 说明 |
| --- | --- | --- |
| `user` | `text` | 店长的消息 |
| `status` | `status`: `running` / `waiting` / `idle` / `error` | 本轮开始/结束；`waiting` 表示在等店长回答问题或授权 |
| `say` | `text` | agent 的回复 |
| `tool` | `text` | 数据查询、快照、写文件等进度 |
| `warn` | `text` | 守卫拦截、工具失败等 |
| `approval_required` | `requestId, tool, source, args` | 写入类数据工具等待授权，5 分钟未处理视为拒绝 |
| `approval_resolved` | `requestId, approved` | |
| `question_required` | `requestId, round, questions: ClarifyQuestion[]` | agent 引导式提问，30 分钟未回答按推荐项继续 |
| `question_answered` | `requestId, answers \| null` | `null` 表示未回答 |
| `gaps` | `gaps: CapabilityGap[]` | 本轮的能力缺口声明（同时写入页面并由网关强制展示） |
| `published` | `page, files` | 页面已发布，可刷新展示 |
| `error` | `message` | 本轮失败 |

### 引导式提问（需求对齐）

新许愿在写页面前，agent 会先用 `question_required` 与店长逐项对齐（由 `llm.clarify` 控制：`required` 默认 / `auto` / `off`）。每个 `ClarifyQuestion`：

| 字段 | 说明 |
| --- | --- |
| `id` | 回答时的键 |
| `header` | ≤12 字短标签，适合做标签页/步骤条 |
| `question` | 问题 |
| `options[]` | 2-5 个候选 `{ label, description? }`，**第一个为推荐项**（label 带「（推荐）」） |
| `multiSelect` | 是否多选 |
| `allowOther` | 是否允许自填（候选项之外的内容） |

建议的界面：一次一题的向导，默认选中第一个候选，最后一步汇总确认后一次性提交。回答校验失败（单选给了多个、不允许自填却自填）返回 400。一轮最多 4 题，最多 3 轮。

## 页面

```http
GET /api/pages → PageView[]
```

`PageEntry` 中与跨会话相关的字段：`version`（每次发布 +1）、`metrics`（展示的指标）、`datasets`（发布时依赖的数据集版本，可与 `/api/datasets` 对比判断数据是否更新）、`stale`（指标口径变更后的复核提示，非空时建议在界面上提示）。

`PageView.url` 形如 `/pages/<slug>/?page_token=...`，直接作为 iframe 的 `src`（拼上网关地址）即可：网关校验后写入该页面路径的 cookie 并跳转，页面子资源随后凭 cookie 加载。页面带 CSP，只能连回网关，并只允许被 `corsOrigins` 中的源嵌入。

热重载：订阅全局事件，收到 `pages_changed` 后重新拉取 `/api/pages` 并刷新 iframe。

```http
GET /api/events?access_token=<token>   → SSE GatewayEvent
  { "type": "pages_changed" }
  { "type": "session_updated", "session": SessionMeta }
```

### 引导式提问（需求对齐）

新许愿在写页面前，agent 会先用 `question_required` 与店长逐项对齐（由 `llm.clarify` 控制：`required` 默认 / `auto` / `off`）。每个 `ClarifyQuestion`：

| 字段 | 说明 |
| --- | --- |
| `id` | 回答时的键 |
| `header` | ≤12 字短标签，适合做标签页/步骤条 |
| `question` | 问题 |
| `options[]` | 2-5 个候选 `{ label, description? }`，**第一个为推荐项**（label 带「（推荐）」） |
| `multiSelect` | 是否多选 |
| `allowOther` | 是否允许自填（候选项之外的内容） |

建议的界面：一次一题的向导，默认选中第一个候选，最后一步汇总确认后一次性提交。回答校验失败（单选给了多个、不允许自填却自填）返回 400。一轮最多 4 题，最多 3 轮。

## 页面状态

```http
GET /api/state/:slug     → { "state": {...} }
PUT /api/state/:slug     body 为 JSON 对象（≤64KB）→ { "state": {...} }
```

页面通过 `qdd.state` 保存推演参数、筛选条件等，跨会话、跨设备共享；前端也可读写。

## 指标口径与数据集

```http
GET  /api/metrics            → MetricCatalog（唯一口径来源，展示格式也据此统一）
GET  /api/datasets           → DatasetManifest[]（版本、水位线 watermark＝数据截至、行数）
POST /api/datasets/refresh   { "datasets"?: string[] } → 增量刷新结果
```

指标类型：`flow`（可加总）、`stock`（取期末）、`ratio`（汇总后分子 ÷ 分母）、`state`（状态，按区间统计）。口径只能由 agent 提议、店长在会话中授权后修改。

## 设置：风格提示词

```http
GET    /api/style        → text/plain
PUT    /api/style        body 为纯文本 → 保存后的文本
DELETE /api/style        → 恢复默认后的文本
```

## 数据工具

```http
GET  /api/tools          → ToolInfo[]（含 source、mutating）
POST /api/tools/:name    body 为参数对象 → { "result": ... }
```

写入类工具（`mutating: true`）不开放直接调用（403），只能在许愿会话中经 `approval_required` 授权后由 agent 执行。

### 引导式提问（需求对齐）

新许愿在写页面前，agent 会先用 `question_required` 与店长逐项对齐（由 `llm.clarify` 控制：`required` 默认 / `auto` / `off`）。每个 `ClarifyQuestion`：

| 字段 | 说明 |
| --- | --- |
| `id` | 回答时的键 |
| `header` | ≤12 字短标签，适合做标签页/步骤条 |
| `question` | 问题 |
| `options[]` | 2-5 个候选 `{ label, description? }`，**第一个为推荐项**（label 带「（推荐）」） |
| `multiSelect` | 是否多选 |
| `allowOther` | 是否允许自填（候选项之外的内容） |

建议的界面：一次一题的向导，默认选中第一个候选，最后一步汇总确认后一次性提交。回答校验失败（单选给了多个、不允许自填却自填）返回 400。一轮最多 4 题，最多 3 轮。

## 页面运行时 SDK（供了解，前端无需处理）

网关在每个页面 `<head>` 注入 `/sdk/qdd.js`，生成页面通过它取数：

```js
await qdd.tool("store__sales_summary", { groupBy: "day" }); // 直连数据工具，不经过 agent
await qdd.data("sales", "store__sales_summary", { groupBy: "day" }); // 失败时回退到快照
await qdd.ask("这周毛利为什么下降？", context); // 需要 agent 时
qdd.agg(rows, { groupBy: ["category"], metrics: ["revenue", "grossMargin"] }); // 与数据源侧同一计算引擎
qdd.format(0.234, "grossMargin"); // "23.4%"
await qdd.state.set({ priceUp: 0.05 });
```

## MCP 端点

`POST /mcp`（Streamable HTTP，JSON 响应，需网关 token）对外暴露门店只读工具，可供其它 agent 接入：

```json
{ "mcpServers": { "qdd": { "type": "http", "url": "http://127.0.0.1:5173/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```
