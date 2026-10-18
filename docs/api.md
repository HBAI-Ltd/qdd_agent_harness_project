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

页面的 `useAgent` 只开启问答入口；问答 agent 与 `qdd.tool` 一样，只能调用该页面 `tools` 声明的只读工具，不能借问答访问未声明的工具。管理 token 调用问答时可使用全部只读工具。

外部 MCP 工具只有同时满足 `annotations.readOnlyHint: true`、没有 `destructiveHint: true`、名称不含系统识别的写入动作（如 `update`、`delete`、`send`、`exec`）时才视为只读。缺少只读声明或声明冲突时，工具按写入处理：只能由许愿 agent 在店长授权后调用；服务配置 `allowWrite: true` 表示店长已预先授权该服务的写入。直接 `POST /api/tools/:name` 始终拒绝写入类工具，包括管理 token 调用，返回 403。现有 MCP 服务若希望页面直接读取数据，需为工具补充明确的只读注解。

工具调用请求体必须是 JSON 对象（空请求体按 `{}` 处理）。畸形 URL 编码、非法 JSON 或字段格式返回 400；普通请求体超过 1 MiB、页面状态超过 64 KiB（按 UTF-8 字节计）返回 413。

## 许愿与会话

```http
POST /api/chat/images                { "url": "http://127.0.0.1:8787/captures/<32位十六进制任务ID>/frame_000001.jpg" }
                                    → image/jpeg（二进制，Cache-Control: no-store）
```

对话里的摄像头截图经此接口读取，前端携带网关 token 后将响应转换为 Blob URL 显示，避免监控服务的同源资源策略阻止跨端口图片加载。页面 token 不可使用此接口；网关 token 不进入图片链接。仅允许已安装、状态为 `connected` 且运行时工具成功加载的海康、天翼、萤石连接器来源，以及 `/captures/<32位小写十六进制ID>/frame_<6位序号>.jpg` 路径。拒绝凭据、查询串、片段、路径编码绕过和重定向，不转发浏览器或 MCP 凭据。截图最多 10 MiB，读取超时 10 秒，校验响应 MIME 与 JPEG 文件标记。

错误体沿用 `{ "error": string }`：400 地址或请求格式不合法；401 缺少网关鉴权；403 来源未接入、连接器不可用或源拒绝访问；404 截图不存在或过期；405 非 POST；413 请求体超过 4 KiB 或截图超过 10 MiB；502 源响应失败、跳转或无效 JPEG；504 读取超时。后端回归测试位于 `apps/cli/src/chat-images.test.ts`，执行 `npm run build` 后用 `node --test apps/cli/dist/chat-images.test.js` 单独运行，也纳入 `npm test`。

```http
GET /api/chat/options                → ChatOptions（需网关 token）
```

对话框从该接口加载模型与思考强度，响应只包含展示与选择信息，不返回服务商地址、密钥或环境变量名：

```json
{
  "models": [
    {
      "id": "deepseek-chat",
      "label": "DeepSeek Chat",
      "reasoningEfforts": ["default", "none", "low", "high", "max"],
      "defaultReasoningEffort": "default"
    }
  ],
  "defaults": { "model": "deepseek-chat", "reasoningEffort": "default" }
}
```

```http
POST /api/wishes                     { "wish": "最近 30 天各品类毛利", "slug"?: "在已有页面上修改", "skillId"?: "技能名称或 id", "model"?: "deepseek-chat", "reasoningEffort"?: "high" }
→ 201 SessionMeta                    agent 在后台运行
```

```http
GET  /api/sessions                   → SessionMeta[]（仅普通对话，按更新时间倒序）
GET  /api/sessions/:id               → SessionDetail（元信息 + 全部事件）
GET  /api/sessions/:id/events        → SSE，先回放历史事件再推送实时事件；?since=N 跳过前 N 条
POST /api/sessions/:id/messages      { "text": "把图表改成按周", "model"?: "deepseek-chat", "reasoningEffort"?: "low" } → 202 SessionMeta（运行中时 409）
PUT  /api/sessions/:id/permissions   { "permissionMode": "approval" | "full-access" } → 200 SessionMeta
POST /api/sessions/:id/approvals/:requestId   { "approved": true }
POST /api/sessions/:id/questions/:requestId   { "answers": { "<问题id>": ["<候选项 label 或自填内容>"] } }
POST /api/sessions/:id/cancel        → 202
```

输入框下方可选择“审批”或“完全访问”。新对话及旧数据缺省为 `approval`；创建许愿和续聊请求可传 `permissionMode`，省略时续聊沿用当前会话模式。模式保存在 `SessionMeta.permissionMode`，重启后保留。`full-access` 自动放行该对话的工具审批，包括 MCP、浏览器、保存技能和通知推送，不再逐次产生授权请求；业务需求澄清仍正常进行，连接器自身权限、参数校验和页面隔离继续生效。

`PUT /permissions` 需要网关鉴权，模式非法或缺失返回 400。切换即时生效：从审批切到完全访问会放行本会话尚在等待的工具审批，其他会话不受影响；切回审批后，后续需授权的调用重新请求确认。新对话重新使用审批，不继承另一对话的完全访问。直接 `/api/tools` 的只读限制不受此模式影响。

权限回归测试位于 `apps/cli/src/session-permissions.test.ts`，执行 `npm run build` 后用 `node --test apps/cli/dist/session-permissions.test.js` 运行，也纳入 `npm test`。

同一会话要求修改界面时，默认沿用 `SessionMeta.slug`，先读取现有文件再发布更新。新对话也可以直接指定已有页面名称或 slug，例如「把品类销售页面的图表改成按周」；agent 用 `edit_page({ slug })` 选择已有页面，再通过 `list_files` / `read_file` / `write_file` / `finish` 修改。页面地址、创建时间和未修改的文件保留，`version` 递增，页面列表不增加重复项。

`edit_page` 必须在本轮写文件、生成数据快照或确认绑定新页面的定时任务之前调用；目标不存在或被另一个普通会话占用时，选择失败且保留原绑定。选中成功即保存会话的 `slug`，即使本轮仅回复或随后失败，续聊仍沿用选中的页面。手动修改可以等待该页面正在执行的定时任务退出后接管，后续定时计划照常运行；定时任务本身不能切换目标页面。

页面修改回归测试位于 `apps/cli/src/page-editing.test.ts` 和 `apps/cli/src/page-editing-schedule.test.ts`，与其他后端测试一样通过 `npm test` 执行。

授权或问题不存在、过期时返回 404；前端保留错误提示并重新读取会话详情及续接事件流，不将过期误判为授权成功或强制结束仍在运行的任务。服务重启后，没有对应运行任务的 `running` / `waiting` 会话会在读取时持久化为 `error`，并追加中断原因及终态事件。旧授权不可继续提交；取消接口返回恢复后的元信息，前端解除停止/发送锁，可在原会话重新发送消息。

普通对话保存在 `workspace/sessions/`，定时任务执行对话（含立即运行）保存在 `workspace/schedule-sessions/`，均使用 `<id>.meta.json`、`<id>.events.jsonl`、`<id>.messages.json`。工作区初始化时会自动将旧目录中带 `origin.kind: "schedule"` 的记录迁入新目录。定时执行记录不进入 `/api/sessions` 列表、普通会话统计或全局 `session_updated` 推送；仍可通过执行结果中的 `sessionId` 查看详情、订阅事件并处理授权。

每轮选择都会实际用于模型请求，并保存到 `SessionMeta.model` / `reasoningEffort`。续聊省略选择时沿用该会话上轮设置；仅切换模型时保留兼容的强度，不兼容则使用目标模型的默认强度。旧会话没有这些字段时沿用网关默认设置。未知模型或该模型不支持的强度返回 400，且不启动执行。

模型来自 `harness.config.json` 的 `llm.models`，同一服务商与 API Key 共用；`llm.model` 指定的默认模型始终包含在列表中。可以按服务商实际支持的模型追加条目：

```json
{
  "llm": {
    "model": "deepseek-chat",
    "reasoningEffort": "default",
    "models": [
      {
        "id": "deepseek-chat",
        "label": "DeepSeek Chat",
        "reasoningEfforts": ["default", "none", "low", "high", "max"],
        "defaultReasoningEffort": "default"
      }
    ]
  }
}
```

`default` 省略服务商 `reasoning_effort`，DeepSeek 仍沿用原有 `llm.thinking` 开关；`none` 关闭思考，其余强度透传 `reasoning_effort`。DeepSeek 官方接口未声明能力时提供 `default / none / low / high / max`，对应 [DeepSeek 思考模式文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)；其他兼容服务默认仅提供 `default`，请在每个模型的 `reasoningEfforts` 中显式声明其支持的强度（包括关闭思考的 `none`）。可声明的值为 `default / none / minimal / low / medium / high / xhigh / max / ultra`；不能仅凭名称推断服务商支持某个档位。`defaultReasoningEffort` 必须包含在该模型的候选强度中。

文本正文仍可放入 `wish` 或 `text`（请求体上限 1 MiB）。上传图片或其他二进制附件时，先向 `POST /api/attachments` 发送原始字节，携带管理端鉴权、实际 `Content-Type` 和 URI 编码的 `X-File-Name`，取得附件引用，再在创建或续聊请求中传入 `attachments: [附件id]`。上传上限为 50 MiB；聊天上传图片单张及每条消息图片总大小均不超过 50 MiB，不套用页面图片问答的 5 MiB 限制。

对话图片处理：

- 聊天上传的 PNG/JPEG/GIF/WebP 图片直接编码为 Base64 data URL，在首轮用户消息中发送，无需模型先调用工具；`read_attachment` 也可再次读取历史图片（单张最多 50 MiB）；文本与 Excel 的按段读取行为不变。网络图片链接通过 `view_image({url})` 转成真正的图片输入，仅支持模型服务商可访问、无内嵌凭据的 HTTPS URL。
- 浏览器 `screenshot` 和 MCP `image` 内容自动转为图片输入。摄像头返回的 `job.frames` / `frames` 使用 HTTPS URL，或从已接入摄像头对应的本地采集目录读取 JPEG 并编码为 Base64；不允许任意本地文件、目录穿越或符号链接越界。
- 浏览器、MCP 和摄像头每次工具结果最多 4 张图片，Base64 单张最多 5 MiB、合计最多 10 MiB，网络 URL 最长 8192 字符。多帧采集用 `offset` / `limit` 分批读取；多个摄像头工具可各自携带图片。
- 同批所有 `tool` 回复先完整返回，再追加带来源工具名与调用 ID 的 `user` 图片消息，序列化为 OpenAI 兼容的 `text` + `image_url` 内容块；原工具 JSON 结果和授权策略不变。随后继续模型轮转，图片未分析前不能在同批工具末尾提前 `reply` / `finish`。
- 默认所有模型都支持图片识别，沿用会话选择的模型，不按模型名称拦截，不自动切换。文件缺失、格式/大小错误或服务商拒绝图片时明确报错，不返回虚构的分析结论。
- 图片正文不进入 SSE 事件日志，但会和完整模型对话一起保存到 `<id>.messages.json`，供续聊、进程重启后恢复使用；这些文件包含图片或临时签名 URL，应按门店敏感资料保护。

图片轮转回归位于 `apps/cli/src/tool-images.test.ts`，构建后运行 `node --test apps/cli/dist/tool-images.test.js`，也包含在 `npm test` 中。

模型选择的回归测试位于 `apps/cli/src/chat-options.test.ts`（与其他后端测试使用 `*.test.ts` 命名），执行 `npm test` 可同时验证网关校验、续聊继承、会话重载与实际服务商请求字段。

`SessionEvent`（每条 SSE `data:` 一个 JSON）：

| type | 字段 | 说明 |
| --- | --- | --- |
| `user` | `text` | 店长的消息 |
| `status` | `status`: `running` / `waiting` / `idle` / `error` | 本轮开始/结束；`waiting` 表示在等店长回答问题或授权 |
| `say` | `text` | agent 的回复 |
| `text` / `thinking` | `blockId, delta?, content?, done?` | 助手正文 / 思考内容块；增量只实时推送，完整 `content` 在 `done: true` 时落盘 |
| `tool` | `blockId, tool: {id,name,args?,status,progress?,result?}` | 工具调用，状态为 `running` / `success` / `error`；按 `tool.id` 合并进度与结果 |
| `warn` | `text` | 守卫拦截、工具失败等 |
| `approval_required` | `requestId, tool, source, args` | 写入类工具、保存技能（`tool: save_skill`）、推送消息（`tool: send_notification`, `source: connector:<id>`）等待授权；`approvalTimeoutMin`（默认 60）分钟未处理视为拒绝，也可在工作台待办中统一处理 |
| `skill` | `skill: {id,name}, action: loaded \| saved` | 技能已加载 / 已保存 |
| `approval_resolved` | `requestId, approved` | |
| `question_required` | `requestId, round, questions: ClarifyQuestion[]` | agent 引导式提问，30 分钟未回答按推荐项继续 |
| `question_answered` | `requestId, answers \| null` | `null` 表示未回答 |
| `gaps` | `gaps: CapabilityGap[]` | 本轮的能力缺口声明（同时写入页面并由网关强制展示） |
| `published` | `page, files` | 页面已发布，可刷新展示 |
| `error` | `message` | 本轮失败 |

`blockId` 为「回复 id:块序号」，同一回复的思考、正文与工具调用可组成 `AssistantPart[]`，按块序号排列。工具状态和完整文本事件保存在历史中，旧会话中的 `say {text}` 与纯文本 `tool {text}` 仍需兼容。实时文本块示例：

```json
{"type":"thinking","blockId":"reply-1:0","delta":"先核对库存","at":"2026-10-17T03:00:00Z"}
{"type":"thinking","blockId":"reply-1:0","content":"先核对库存。","done":true,"at":"2026-10-17T03:00:01Z"}
{"type":"tool","blockId":"reply-1:2","tool":{"id":"call-1","name":"store__get_inventory","status":"running","args":{},"progress":"正在查询"},"at":"2026-10-17T03:00:02Z"}
{"type":"tool","blockId":"reply-1:2","tool":{"id":"call-1","name":"store__get_inventory","status":"success","result":"查询结果"},"at":"2026-10-17T03:00:03Z"}
```

带 `delta` 的事件不能追加到持久化历史数组或计入 `since`；重连偏移仅为已收到的落盘事件数。完整 `content/done` 替换同一块的实时内容，避免重复拼接；切换会话、开始新一轮或结束执行时清理未完成实时块。正文与思考可按 Markdown 渲染，原始 HTML 应作为文字处理。

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
GET /api/schedules/:id/sessions → SessionMeta[]（该任务全部执行对话，按 createdAt 倒序；包含旧目录中的定时会话，不混入普通对话）
POST   /api/schedules            { "name": "经营日报", "cron": "0 8 * * *", "prompt": "汇总昨日销售与异常",
                                   "skillId"?: "技能名或 id", "slug"?: "刷新的页面", "notify"?: { "connectorId": "…" }, "enabled"?: true } → 201
GET    /api/schedules/:id        → Schedule（含 nextRunAt、lastRun）
PUT    /api/schedules/:id        部分字段；skillId/slug/notify 传 null 解绑
DELETE /api/schedules/:id
POST   /api/schedules/:id/run    立即执行一次 → 202 { "sessionId" }
```

历史接口需网关鉴权；任务不存在返回 404，尚未执行返回 `[]`。例如请求 `GET /api/schedules/<任务ID>/sessions`，返回 `[{"id":"<会话ID>","title":"经营日报","summary":"日报已完成","slug":null,"status":"idle","origin":{"kind":"schedule","scheduleId":"<任务ID>","scheduleName":"经营日报"},"createdAt":"2026-10-18T00:00:00.000Z","updatedAt":"2026-10-18T00:01:00.000Z"}]`。使用其中的 `id` 请求 `GET /api/sessions/:id` 回放完整对话。

- `cron` 为 5 段（分 时 日 月 周），按网关时区；例：`0 8 * * *` 每天 8 点、`0 9 * * 1` 每周一 9 点、`0 */2 * * *` 每 2 小时。
- 到点以**无人值守**方式发起会话（`SessionMeta.origin = { kind: "schedule", … }`）：不提问；工具调用（含写入、浏览器操作、保存技能和消息推送）自动授权，不产生 `approval_required` 或等待人工确认的 `waiting` 状态。立即运行、定时会话续聊（含网关重启后）使用相同策略；普通对话仍按原规则确认，单独设置无人值守不代表自动授权。只读连接器限制、参数校验、数据核验和页面隔离仍生效。
- 定时任务会话（含立即运行）发布页面时，不将任务提示词记入页面的 `wish`：已有页面保留原值，新页面使用空字符串。任务提示词仍用于执行并保存在执行会话中；普通对话发布页面的 `wish` 记录方式不变。
- 完成后把结论推送到 `notify` 连接器；配置推送目标即视为店长授权该任务的推送。执行结果记录在 `lastRun`（含推送结果）。
- 网关停机期间错过的执行，启动后补跑一次。变化时推送 `schedules_changed`。任务列表与详情通过 `currentRun: { sessionId, status }` 返回当前执行状态（仅执行期间存在），前端无需从普通对话列表查找执行记录。
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

`connectors` 包含内置数据（`origin: builtin`）、自定义 MCP 服务（`origin: mcp`，只读展示）与通过 API 安装的连接器（`origin: installed`）。飞书、收银系统、门店摄像头与门店手机开放安装；ERP、外卖平台、企业微信暂未开放。本地 MCP 条目提供 `providers: [{ id, name }]` 供用户选择，默认不安装任何平台。

门店手机安装请求为 `{ "type": "phone", "mode": "mcp", "provider": "android", "name": "门店运营手机" }`，成功返回 201，ID 为 `mcp:android`，权限固定为 `confirm`。Node/Rust 设备操作台共用此连接器，默认接入地址为 `http://127.0.0.1:8792/mcp`；需将操作台服务端口设为 `8792`，避免与天翼视联冲突。`mcpServers.android` 可覆盖地址，配置本身不会自动安装。验证只握手、列工具并检查 Android 工具，不操作手机。手机投屏、蓝牙输入与启动步骤见[接入说明](android-connector.md)。

**本地 MCP** 安装请求示例：

```json
{ "type": "pos", "mode": "mcp", "provider": "shouqianba", "name": "门店收银" }
```

```json
{ "type": "camera", "mode": "mcp", "provider": "haik", "name": "门店摄像头" }
```

摄像头可选择 `haik`、`tysl`、`ezviz`，收银可选择 `shouqianba`。只有用户提交安装才验证对应 MCP 并持久保存，验证失败不保存；重复平台返回输入错误。安装成功后工具立即可用，删除后立即撤销，重启后恢复用户选择。内置本地服务的 `mcpServers` 配置仅作为连接参数覆盖，不表示已安装。返回的 `config` 包含 `mode: "mcp"`、`provider` 和本地 `consoleUrl`，不含密钥；账号登录在控制台另行完成。

本地 MCP 的 `PUT` 仅支持修改名称，`verify` 验证本地 MCP 连接；不发送短信或业务请求。收银权限固定为 `read`，摄像头和门店手机固定为 `confirm`。本地 MCP 不支持 `/test` 消息推送，也不能作为定时任务的消息接收方。

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
DELETE /api/browser/:browserSessionId        { "sessionId": "所属对话 ID" } → BrowserSessionState（status: "closed"）
```

`DELETE` 需要网关 Bearer token，且浏览器必须属于传入的对话。关闭会立即结束该浏览器上下文及全部标签页、终止画面流，并将关闭状态写入对话事件历史；不会发起新一轮 AI 对话。浏览器正在加载网页时也可关闭。旧浏览器 ID 返回 404，不会关闭同一对话后来重新打开的浏览器。对话中说“关闭浏览器”时，agent 调用 `browser` 的 `close` 动作结束实际浏览器会话；之后可通过 `open` 新建浏览器。

`input` 支持 `mouse`（move/down/up）、`click`、`wheel`、`key`、`text`、`release`、`navigate`、`back`、`forward`、`reload`，坐标为画面像素（类型见 `BrowserInput`）。标签页切换或页面变化后返回 409，等待新画面后重试；画面失焦或停止观看时发送 `release` 释放按住的鼠标和按键。

运行时移植自 [Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app) 的 `packages/tools/browser`（MIT），默认减少常见自动化特征，但并非完全隐身；遇到登录或人工验证时请在实时画面中手动接管。

## 页面

```http
GET /api/pages → PageView[]
```

`PageEntry` 中与跨会话相关的字段：`version`（每次发布 +1）、`metrics`（展示的指标）、`datasets`（发布时依赖的数据集版本，可与 `/api/datasets` 对比判断数据是否更新）、`stale`（指标口径变更后的复核提示，非空时建议在界面上提示）。

`PageView.url` 形如 `/pages/<slug>/?page_token=...`，直接作为 iframe 的 `src`（拼上网关地址）即可：网关校验后跳转到 `/pages/<slug>~<page-token>/`，相对脚本、模块、样式和快照继承该目录中的页面令牌进行鉴权，目录深度保持不变。旧 cookie 入口仍可访问并自动跳转。地址含页面权限，请勿公开分享；资源使用 `Referrer-Policy: no-referrer` 防止向外部包服务发送令牌地址。

HTML 与 SVG 等页面资源均返回页面 CSP。静态资源会校验文件的真实路径，拒绝通过符号链接或 Windows junction 读取页面目录、公共资源目录之外的文件。

页面 CSP 和工作台 iframe 均启用不带 `allow-same-origin` 的沙箱：页面不能访问主界面或其它页面的 DOM。脚本与样式只允许本页面目录、公共资源、SDK 和配置的 CDN；网络请求只允许网关 `/api/`，禁止嵌套 iframe、worker 和弹出窗口。页面在浏览器中以 opaque 来源运行，SDK API 请求的 `Origin` 为 `null`：只有有效页面令牌的工具、问答、状态和登记接口响应开放该 CORS 来源，管理接口不开放。模块资源也仅在目录令牌有效时允许该来源。前端 iframe 必须使用 `sandbox="allow-scripts allow-downloads"`，并按 opaque 来源处理经过校验的 SDK 握手。

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
- `time`、`from`、`to` 必须是真实有效的日期/时间，`from` 不得晚于 `to`；`limit` 必须是正整数，结果条数最多 1000。
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

### 图片问答

`qdd.ask(question, context?, optionsOrOnEvent?)` 返回 `Promise<string>`。原有的第三参数进度回调保持兼容；传选项对象可附加图片：

```js
try {
  const answer = await qdd.ask("分析图片中的货架陈列问题", { store: "当前门店" }, {
    images: [
      { url: imageDataUrl, detail: "high" },
      // 也支持由用户提供、模型服务商可访问的 HTTPS 图片 URL。
    ],
    onEvent(event) {
      if (event.type === "tool") statusElement.textContent = `正在查询：${event.name}`;
    },
  });
  answerElement.textContent = answer;
} catch (error) {
  answerElement.textContent = `分析失败：${error.message}`;
}
```

本地 `<input type="file">` 选中的图片可通过 `FileReader.readAsDataURL(file)` 得到 `imageDataUrl`；截图可用 `canvas.toDataURL("image/jpeg", 0.85)`，跨源画面需满足 CORS。读取/截图失败必须显示错误。图片放在 `images` 中，不要放入 `context`（上下文仍按文本处理并截取前 20,000 字符）。只在用户明确提交时发送图片，不要把图片数据或签名 URL 写进日志、生成页面源码或 `qdd.state`。

接口：`POST /api/ask`

```json
{
  "question": "分析这张图片",
  "context": { "store": "当前门店" },
  "images": [
    { "url": "https://images.example.com/shelf.jpg", "detail": "auto" }
  ]
}
```

- `images` 可省略或为空数组；最多 **4 张**。每项必须包含 `url`，`detail` 可省略或为 `auto` / `low` / `high`。
- Base64 data URL：仅支持 PNG、JPEG、GIF、WebP；网关检查编码和文件头与 MIME 的一致性，完整解码由模型服务商负责。按解码后字节数计算，单张最多 **5 MiB**、合计最多 **10 MiB**。
- HTTPS URL：最多 **8192 字符**，不允许内嵌用户名密码。网关**不下载**远程图片，直接传给模型服务商；远程图片的格式、大小、访问权限由服务商校验。带签名的链接也会发送给服务商，不会附带网关凭据；需要本地登录或仅内网可访问的图片应先转为 data URL。
- 该接口的 JSON 请求体上限为 **15 MiB**，其他接口上限不变。无效图片参数返回 HTTP 400，请求体超限返回 413。
- 页面仍须在 `finish` 中声明 `useAgent: true`，SDK 自动携带页面凭据；未声明返回 403，凭据无效返回 401。
- 沿用当前默认模型配置，不自动选择或切换视觉模型；使用者须确保模型及 OpenAI 兼容接口支持 `image_url` 内容块和工具调用。模型拒绝图片或执行失败时，以 SSE `{"type":"error","message":"..."}` 返回，SDK 会抛出异常。
- SSE 工具进度为 `{"type":"tool","name":"..."}`，最终回答为 `{"type":"answer","text":"..."}`；该入口仍只能调用只读数据工具。
- 只读工具返回的 MCP 图片或摄像头采集帧同样会在所有工具结果之后附加为图片输入，并继续回答；不会因此开放截图写入、云台操作或其他写权限。

回归测试位于 `apps/cli/src/ask-images.test.ts`，使用 Node.js 内置测试器，不连接真实模型或远程图片。执行 `npm run build` 后运行 `node --test apps/cli/dist/ask-images.test.js`，验证图片边界、权限、SDK 兼容性、模型请求格式及错误回传。

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
