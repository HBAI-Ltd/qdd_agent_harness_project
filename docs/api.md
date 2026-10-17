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
| 生成的页面 | SDK 自动携带 `X-QDD-Page` + `X-QDD-Page-Token` | 仅 `POST /api/tools/<页面声明的工具>`、本页面的 `/api/state/<slug>`、页面代码中用到的 `/api/records/<name>`，以及声明了 `useAgent` 时的 `POST /api/ask` |

网关 token 来自环境变量 `QDD_GATEWAY_TOKEN`（至少 16 位）；未设置时首次启动自动生成到 `workspace/.gateway-token`，`npm run qdd -- token` 查看。

## 许愿与会话

```http
POST /api/wishes                     { "wish": "最近 30 天各品类毛利", "slug"?: "在已有页面上修改", "skillId"?: "技能名称或 id" }
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
| `approval_required` | `requestId, tool, source, args` | 写入类工具、保存技能（`tool: save_skill`）、推送消息（`tool: send_notification`, `source: connector:<id>`）等待授权；`approvalTimeoutMin`（默认 60）分钟未处理视为拒绝，也可在工作台待办中统一处理 |
| `skill` | `skill: {id,name}, action: loaded \| saved` | 技能已加载 / 已保存 |
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

## 工作台：总览与待办

```http
GET /api/overview   → Overview：会话（运行中/待确认/失败/活跃列表）、页面（总数/待复核）、技能数、定时任务（启用数/下一次）、连接器（已接入数）、待办
GET /api/pending    → PendingItem[]：所有会话中等待店长处理的授权与澄清问题
```

`PendingItem` 带 `kind: approval | question`、`requestId`、`sessionId`、`sessionTitle`、`origin`（定时任务触发时）、`expiresAt`。处理方式与会话内相同：
`POST /api/sessions/:sessionId/approvals/:requestId` / `.../questions/:requestId`。全局 `GET /api/events` 在待办变化时推送 `{ "type": "pending_changed" }`。

## 技能

```http
GET    /api/skills          → Skill[]
POST   /api/skills          { "name", "description", "steps": ["…"], "tools"?: ["store__get_inventory", "send_notification"] } → 201 Skill
GET    /api/skills/:id      → Skill
PUT    /api/skills/:id      （同 POST 字段）→ Skill
DELETE /api/skills/:id      被定时任务使用时 409
```

agent 也可在对话中用 `save_skill` 提炼技能（`source: "agent"`），保存前触发 `approval_required`（`tool: save_skill`，`args` 为技能内容，对应「就这样，保存为技能 / 再改改」）。对话中需求与技能吻合时 agent 会 `load_skill`，会话产生 `skill` 事件。变化时推送 `skills_changed`。

## 定时任务

```http
GET    /api/schedules            → Schedule[]
POST   /api/schedules            { "name": "经营日报", "cron": "0 8 * * *", "prompt": "汇总昨日销售与异常",
                                   "skillId"?: "技能名或 id", "slug"?: "刷新的页面", "notify"?: { "connectorId": "…" }, "enabled"?: true } → 201
GET    /api/schedules/:id        → Schedule（含 nextRunAt、lastRun）
PUT    /api/schedules/:id        部分字段；skillId/slug/notify 传 null 解绑
DELETE /api/schedules/:id
POST   /api/schedules/:id/run    立即执行一次 → 202 { "sessionId" }
```

- `cron` 为 5 段（分 时 日 月 周），按网关时区；例：`0 8 * * *` 每天 8 点、`0 9 * * 1` 每周一 9 点、`0 */2 * * *` 每 2 小时。
- 到点以**无人值守**方式发起会话（`SessionMeta.origin = { kind: "schedule", … }`）：不提问；写入类操作进入工作台待办等待授权。
- 完成后把结论推送到 `notify` 连接器；配置推送目标即视为店长授权该任务的推送。执行结果记录在 `lastRun`（含推送结果）。
- 网关停机期间错过的执行，启动后补跑一次。变化时推送 `schedules_changed`。
- agent 也能在会话中用 `create_schedule` 创建任务：先以 `approval_required`（`tool: "create_schedule"`，参数含名称、cron、下次执行时间、任务描述、绑定页面、推送目标）请店长确认，确认后才写入。这类任务带 `createdBy: { kind: "agent", sessionId }`；定时执行的会话本身不能再创建任务。

## 连接器

```http
GET    /api/connectors              → { catalog: ConnectorCatalogEntry[], connectors: ConnectorView[] }
POST   /api/connectors              安装：先验证，验证失败返回 400 且不保存 → 201 ConnectorView
GET    /api/connectors/:id
PUT    /api/connectors/:id          { "name"?, "permission"?, "receiveId"?, "receiveIdType"? }（换凭据请删除后重装）
DELETE /api/connectors/:id          被定时任务用于推送时 409
POST   /api/connectors/:id/verify   重新验证并记录 status/detail
POST   /api/connectors/:id/test     { "text"? } 发送测试消息
```

`connectors` 包含内置数据（`origin: builtin`）、配置文件中的 MCP 服务（`origin: mcp`，只读展示）与通过 API 安装的连接器（`origin: installed`）。`catalog` 中 `available: false` 的类型（收银、ERP、摄像头、门店手机、外卖平台、企业微信）暂未开放安装。

`permission`：`read` 只查看（不能推送）/ `confirm` 每次推送需店长确认（默认）/ `auto` 无需确认。

**飞书**（`type: "feishu"`）两种模式：

| mode | 字段 | 验证方式 |
| --- | --- | --- |
| `webhook` 自定义机器人 | `webhookUrl`（必须是 `https://open.feishu.cn/open-apis/bot/v2/hook/…`）、`signSecret`（开启签名校验时） | 向群发送一条测试消息，返回 code 0 才保存 |
| `app` 企业自建应用 | `appId`、`appSecret`、`receiveId`（群 chat_id 等，可后补）、`receiveIdType`（默认 `chat_id`） | 换取 tenant_access_token、读取机器人信息；设置了 receiveId 时再发送测试消息 |

常见失败会翻译成中文提示（签名错误、关键词不匹配、IP 白名单、App Secret 错误、机器人不在群中等）。凭据用 AES-256-GCM 加密保存在 `workspace/connectors.json`（密钥来自 `QDD_SECRET_KEY` 或自动生成的 `workspace/.secret-key`），接口只返回脱敏后的地址与「是否已设置」。

## 浏览器（实时画面与人工接管）

在 `harness.config.json` 中开启（需要本机 Chrome / Edge / Chromium）：

```json
"browser": { "enabled": true, "executablePath": "", "permission": "confirm" }
```

agent 获得 `browser` 工具（open / navigate / snapshot / read / click / hover / type / pressKey / scroll / screenshot / tabs / newTab / selectTab / closeTab / close）。每个会话一个独立浏览器会话（临时资料，不读个人浏览器登录），可跨多轮续用；取消会话会关闭浏览器。`permission: confirm` 时，每个会话首次点击、输入或按键前触发 `approval_required`（`tool: browser`, `source: browser`）。只允许 HTTP/HTTPS 网页。

会话事件 `{ "type": "browser", "browser": BrowserSessionState }` 给出 `browserSessionId`、`tabId`、当前地址与标题。浏览器会话建立后、导航完成前即发送首次状态，动作完成后再发送最新状态，前端据此自动展开画面并订阅后续变化：

```http
GET  /api/browser/:browserSessionId          → BrowserSessionState
GET  /api/browser/:browserSessionId/stream   → SSE BrowserStreamEvent：state / frame（base64 JPEG，1280×800）/ closed / error
POST /api/browser/:browserSessionId/input    { "tabId": "…", "type": "click", "x": 100, "y": 200 } → BrowserSessionState
```

`input` 支持 `mouse`（move/down/up）、`click`、`wheel`、`key`、`text`、`release`、`navigate`、`back`、`forward`、`reload`，坐标为画面像素（类型见 `BrowserInput`）。标签页切换或页面变化后返回 409，等待新画面后重试；画面失焦或停止观看时发送 `release` 释放按住的鼠标和按键。

运行时移植自 [Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app) 的 `packages/tools/browser`（MIT），默认减少常见自动化特征，但并非完全隐身；遇到登录或人工验证时请在实时画面中手动接管。

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

页面通过 `qdd.state` 保存推演参数、筛选条件等，跨会话、跨设备共享；前端也可读写。逐条登记的数据请用记录数据集。

## 记录数据集（门店登记）

试吃报损、临期处置回填、巡检、日报确认等需要员工逐条登记的数据，存为数据集 `records/<name>`（`kind: "record"`）。每行自动带 `id`（主键）、`time`（`YYYY-MM-DD HH:mm`，未传时取当前时间）、`page`（来源页面 slug，前端写入为 `@admin`）。

```http
GET    /api/records                 → [{ name, description, schema, rowCount, watermark, updatedAt }]   仅前端
POST   /api/records                 { "name": "loss_log", "label": "试吃报损登记", "description"?: "…",
                                      "fields": [{ "name": "qty", "label": "数量", "type": "number", "required"?: true, "options"?: [...] }] } → 201   仅前端
GET    /api/records/:name?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=200   → { schema, rows（按时间倒序）, total }
POST   /api/records/:name           单条对象或数组（≤200 条）→ 201 { rows }
PUT    /api/records/:name/:id       部分字段（登记时间不可改）→ { row }
DELETE /api/records/:name/:id       作废 → { ok: true }
```

- 结构由 agent 用 `define_record` 提出（`approval_required`，`tool: "define_record"`），店长确认后建立；也可由前端直接 `POST /api/records`。已存在时只能新增字段、改中文名/候选值；删字段或改类型返回 409。
- 写入按结构校验：未知字段、类型不符、必填为空、不在候选值内均返回 400。
- 修改按 id 覆盖、作废写入墓碑；读取和 `store__aggregate`（`dataset: "records/<name>"`，计数用指标 `records`）只看最新且未作废的行，原始行保留在数据集日志中便于追溯。
- 页面只能访问代码中 `qdd.records.*("<name>")` 出现的记录（发布时写入 `PageEntry.records`），其它返回 403；页面不能定义或列出记录。

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
await qdd.records.add("loss_log", { sku: "SKU013", qty: 2, reason: "试吃" }); // 门店登记
await qdd.records.update("loss_log", id, { qty: 3 });
await qdd.records.remove("loss_log", id); // 作废
await qdd.records.list("loss_log", { from: "2026-10-01", limit: 100 }); // { schema, rows, total }
```

## 任务模板与主界面通信

网关注入的 SDK 提供 `qdd.host`，用于 iframe 模板与主界面双向交换 JSON 事件。主界面使用 `TaskPreview` 的 `@message="handleTaskMessage"` 统一接收；组件校验窗口来源、origin、页面 slug、协议版本和每次加载的 bridgeId。切换或重新加载页面后，旧消息与旧回调失效。

模板发送与监听：

```js
const unsubscribe = qdd.host.on("host:context", (context) => {
  // 初次连接及主题变化都会收到 { theme: "light" | "dark", locale: "zh-CN" }。
  document.documentElement.dataset.theme = context.theme;
});

await qdd.host.ready;
qdd.host.emit("selection:changed", { productId: "SKU-001" });
qdd.host.on("host:result", (payload) => console.log(payload));

// 只填写主界面的对话输入框，用户确认后才发送给 Agent。
qdd.host.emit("conversation:prefill", { text: "分析这个商品最近一周的销售变化" });

// 不再需要时调用 unsubscribe()。
```

主界面中的 `handleTaskMessage(message)` 是统一扩展入口；业务模块也可监听 `window` 上的 `qdd:task-message`：

```js
window.addEventListener("qdd:task-message", (event) => {
  const message = event.detail; // { slug, type, payload, reply }
  if (message.type === "selection:changed") {
    console.log(message.slug, message.payload.productId);
    message.reply("host:result", { received: true });
  }
});
```

发送给模板的事件名使用 `host:` 前缀，`TaskPreview` 也通过组件 ref 暴露 `postMessage(type, payload)`。模板事件名可自定义；`host:init`、`page:ready`、`page:error` 是保留的连接/错误事件。每次成功接收后，主界面回传 `host:received`，表示已收到事件，不代表业务操作已完成。`emit()`/`reply()` 返回布尔值，未完成握手、页面已切换或数据不合法时返回 `false`。

载荷须为 JSON 值，最多 64 KiB、最多 64 层，不包含函数、循环引用或凭据。模板不会收到管理 token。浏览器脚本错误会通过 `page:error` 回报；页面未在加载后建立通信时，主界面显示鉴权/SDK/嵌入权限检查提示。独立打开的页面没有主界面，`qdd.host.ready` 不会完成，其余 `qdd` 数据接口照常使用。

## MCP 端点

`POST /mcp`（Streamable HTTP，JSON 响应，需网关 token）对外暴露门店只读工具，可供其它 agent 接入：

```json
{ "mcpServers": { "qdd": { "type": "http", "url": "http://127.0.0.1:5173/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```
