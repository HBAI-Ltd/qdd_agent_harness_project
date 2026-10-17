# Harness 前端

前端位于 `apps/web`，界面参考产品原型动画，使用 Element Plus UI 组件库和统一的 `--qdd-*` 门店主题，支持浅色与深色模式。数据来自后端实际的会话、已发布页面与工具接口。接口与类型以根目录的 `docs/api.md` 和 `@qdd/shared` 为准。

前端与网关需要分别启动。在仓库根目录打开两个终端，终端一启动后端：

```powershell
npm run dev
```

该命令会先构建后端再启动网关；已构建时也可运行 `npm start`。终端二启动前端：

```powershell
npm run dev:web
```

访问 `http://127.0.0.1:5177`。前端的默认网关地址和开发/预览代理目标按以下顺序读取配置：`API_PROXY_TARGET` → 根目录 `.env` 的 `HOST`、`PORT` → `harness.config.json` 的 `gateway.host`、`gateway.port` → 后端内置默认值。`.env.example` 与 `harness.config.example.json` 均使用 `http://127.0.0.1:3000`。环境中的 `HOST`、`PORT` 会覆盖后端配置文件中的地址。

开发模式会预热入口、公共布局和默认聊天页，并显式预构建 Element Plus 的自动导入入口，减少首次打开时的串行转换与新增依赖触发的重新预构建。实时浏览器组件在点击查看画面后才加载；版本更新提示插件只在生产构建启用。保留 Vite 的 `node_modules/.vite` 缓存，日常启动无需使用 `--force`。修改 Vite 配置后重启 `npm run dev:web`；首次重建依赖缓存仍需时间，后续启动会复用缓存。

在「设置」检查网关地址与后端启动时打印的地址一致；浏览器可能保留了旧地址，可点击「使用配置地址」更新。修改地址配置后需重启 Vite；预览或部署已有构建时需重新构建前端。`API_PROXY_TARGET` 只调整前端连接目标，不会启动网关或改变后端监听地址。

在另一个终端查看网关 token，然后填入「设置」并连接：

```powershell
npm run qdd -- token
```

网关配置的 `gateway.corsOrigins` 需精确包含前端来源，例如 `http://127.0.0.1:5177`；示例配置已包含该地址。若使用 `http://localhost:5177`，需另行添加该来源，并让网关地址也使用 `localhost`。前后端使用相同的主机名与协议，以便页面 cookie 正常工作。修改网关配置后需重启后端。

生成的任务页面需要直接使用实际网关来源：页面级 token、cookie、SDK 注入、CSP 嵌入权限和父页面通信均由网关处理。`gateway.corsOrigins` 同时控制跨域请求、页面嵌入与 SDK 允许的主界面来源。网关 token 只存于当前浏览器会话，不放入页面地址。

- 对话：支持新建对话、历史记录与会话切换，发送经营需求、续聊、查看 SSE 进度，并完成需求确认与显式授权。点击「新建对话」进入空白草稿，首次发送消息时通过 `POST /api/wishes` 建立会话；已有对话通过 `POST /api/sessions/:id/messages` 续聊。
- 对话记录来自 `GET /api/sessions`，按更新时间倒序展示；切换时加载 `GET /api/sessions/:id` 并订阅该会话的 SSE。前端按网关保存当前选择，刷新或重新连接后恢复同一会话或新对话草稿状态。
- 工作台总览：接入 `GET /api/overview` 与 `GET /api/pending`，展示真实计数、已启用定时任务、最近对话和已发布页面。可在总览直接回答问题或授权，也可进入来源对话；侧栏同步技能、任务和已连接来源数量。
- 任务：侧边栏展示历史对话和已发布页面，支持搜索和 `Ctrl K` 展开侧边栏并聚焦搜索框。页面通过 `PageView.url` 嵌入，保留网关注入的 SDK、样式及页面鉴权。
- 侧边栏：桌面端可收缩为图标导航并保存偏好；移动端使用抽屉，可通过遮罩或 `Escape` 关闭。
- 设置：Element Plus 输入框、按钮和开关，用于网关连接、浅色/深色主题、发送快捷键及后端统一页面风格。
- 修改已发布页面时，在同一对话面板恢复该页面对应的原始会话，继续其上下文，不额外创建会话。
- 后端没有任务重命名、删除和手动状态接口，前端不提供这些操作。
- 发送后立即在消息区展示用户消息和等待进度，发送位置切换为「停止回复」；执行中或等待回答、授权时均可停止，下一条草稿可以继续编辑。停止请求被接受后仍等待真实终态再恢复发送。
- 刷新工作空间保留正在提交的请求和当前会话；续聊、答题、授权与取消通过 SSE 原位更新，避免重载聊天记录。新建请求尚未返回会话 ID 时点击停止，会在创建确认后取消该会话。
- 提问器：后端已有 `question_required` / `question_answered` 事件和 `POST /api/sessions/:id/questions/:requestId`，前端沿用现有接口；按原型同时展示问题及标签选项，支持推荐默认值、单选、多选、自填、答案汇总和确认。
- 连接器：使用后端目录与安装列表，支持飞书 Webhook / 企业自建应用安装、设置、验证、测试消息和删除；内置与配置文件 MCP 来源只读展示。安装或重新验证可能发送验证消息，表单明确说明；其他未开放目录类型保持禁用与 `// TODO`。
- 技能：支持真实列表、新建、编辑、删除、来源对话和运行。运行时以 `POST /api/wishes` 的 `skillId` 预加载技能；对话中的 `skill` 事件显示加载与保存结果，`save_skill` 授权展示实际名称、步骤与工具。
- 定时任务：支持真实列表、新建、编辑、删除、启停、立即执行、执行结果及通知状态，可绑定技能、已发布页面和可推送连接器；高级 cron 保留已有自定义规则，空值编辑发送 `null` 解绑。cron 按网关时区执行；配置通知目标即授权该任务完成后自动推送，数据修改默认需确认，并遵守工作空间已有的授权设置。
- 浏览器：收到真实 `browser` 会话事件后，可显式打开实时 JPEG 画面；默认只读，开启「人工接管」后可导航、点击、滚动、键盘与中文输入。按画面尺寸换算坐标，校验会话和标签标识，409 不重放输入；切会话、失焦和停止观看时释放输入并关闭订阅。
- 数据同步：全局 SSE 的 `skills_changed`、`schedules_changed`、`connectors_changed`、`pending_changed` 更新对应资源及总览；重连后重新拉取。切换 token 或网关会取消旧请求并清空资源，迟到响应不会覆盖新连接。
- 任务详情继续通过 iframe 加载后端提供的 `PageView.url`，主界面顶部提供「通过对话修改」，不在前端重建原型动画中的经营图表。

UI 对接入口：

- `src/page/layout/index.vue`：公共页面框架，提供侧边栏、顶栏与 `router-view`，在路由切换时保持网关连接及共享状态。
- `src/views/`：Vue Router 注册的界面，包含 `chat`、`overview`、`tasks`、`schedules`、`skills`、`connectors`、`settings`、连接检查与 404；对应 `/chat`、`/overview`、`/tasks/:slug?`、`/schedules`、`/skills`、`/connectors`、`/settings`、`/test`。`/` 跳转至 `/chat`。
- `src/components/WorkspaceSidebar.vue`：导航、搜索、新建对话、历史记录及收缩展示。
- `src/composables/workspaceContext.ts`：页面共享状态和导航入口；各会话的未发送输入在当前浏览器访问期间独立保留。
- `src/composables/useConversationDrafts.ts`：按会话隔离输入草稿，处理切换后发送完成及首次创建期间继续输入。
- `src/api/workspace.ts`：使用共享契约的网关请求、鉴权和 SSE。
- `src/api/catalog.ts`：只读工具列表请求，使用共享 `ToolInfo` 契约。
- `src/api/skills.ts`、`src/api/schedules.ts`、`src/api/connectors.ts`、`src/api/dashboard.ts`、`src/api/browser.ts`：共享类型的领域接口，复用网关鉴权、错误与 SSE 解析。
- `src/composables/useGatewayResource.ts`：按资源订阅全局变化，处理刷新、错误、取消及连接切换。
- `src/components/DashboardPending.vue`：跨会话问题与授权处理；始终使用待办自带的 `sessionId` 和 `requestId`。
- `src/components/SessionBrowser.vue`：会话浏览器画面与接管 UI；`browserSession.ts` 负责输入队列、帧身份与生命周期保护。
- `src/composables/useWorkspace.ts`：提供 `sessions`、`activeSessionId`、`activeSession`、`pages`、`activePage`，以及连接、`startNewConversation`、`selectSession`、发送、确认、取消和页面修改方法。
- `activeSession.events` 为真实事件流；`status` 区分执行中、等待、空闲和失败。
- 页面预览使用 `PageView.url`，不再将页面内容作为三段源码拼接。
- `TaskPreview` 通过 `@message="handleTaskMessage"` 将经过来源校验的模板消息交给主界面。主界面也派发 `qdd:task-message` 供业务模块监听，并可用 `message.reply("host:result", payload)` 回传。
- 模板等待 `qdd.host.ready` 后调用 `qdd.host.emit(type, payload)`；使用 `qdd.host.on(type, listener)` 监听回传并取得取消监听函数。详细示例见根目录 `docs/api.md`。

检查与构建：

生产构建保留路由动态导入，各页面及其依赖由 Vite 自动拆分，首次访问对应路由时加载。部署时需完整发布 `apps/web/dist`（包括 `assets` 目录），并将前端页面路由回退到 `index.html`；网关只提供 API 和生成的任务页面，主界面由独立静态服务托管。本地可在构建后运行 `npm run preview --workspace @qdd/web` 验证生产资源。Element Plus 的基础样式仍全量加载。

```powershell
npm run typecheck --workspace @qdd/web
npm run build:web
```

网关地址与接口回归测试位于 `tests/gateway-config.test.ts`、`tests/workspace-api.test.ts` 和 `tests/workspace.test.mjs`，使用 Node.js 内置测试器：

```powershell
node --test apps/web/tests/gateway-config.test.ts apps/web/tests/workspace-api.test.ts apps/web/tests/workspace.test.mjs
```

对话选择、输入草稿与实际状态逻辑的回归测试位于 `tests/conversation-selection.test.ts`、`tests/conversation-drafts.test.ts` 和 `tests/workspace-conversation.test.mjs`，覆盖新建、续聊、历史切换、草稿与选择恢复、并发防重、过期请求隔离及页面修改：

```powershell
node --test apps/web/tests/conversation-selection.test.ts apps/web/tests/conversation-drafts.test.ts apps/web/tests/workspace-conversation.test.mjs
```

聊天模板交互回归位于 `tests/chat-view.test.mjs`，验证首发消息、loading、停止与恢复发送、草稿编辑和 Enter 防重；会话状态回归另覆盖发送期间刷新、创建响应与历史快照竞态、停止失败重试及旧连接响应隔离。所有前端测试可一次执行：

```powershell
node --test apps/web/tests/*.test.*
```

提问与授权状态的回归测试位于 `tests/session-actions.test.mjs`，直接编译真实组件的 setup 脚本，验证默认选项、答案校验、多选与自填、会话切换重置、已解决请求过滤和提交防重：

```powershell
node --test apps/web/tests/session-actions.test.mjs
```

新增领域接口、资源订阅及浏览器输入回归位于 `tests/connectors-api.test.mjs`、`tests/skills-schedules-api.test.ts`、`tests/gateway-resource.test.mjs`、`tests/browser-session.test.mjs`、`tests/session-browser.test.mjs`。测试只使用本地桩，不发送外部消息：

```powershell
node --test apps/web/tests/connectors-api.test.mjs apps/web/tests/skills-schedules-api.test.ts apps/web/tests/gateway-resource.test.mjs apps/web/tests/browser-session.test.mjs apps/web/tests/session-browser.test.mjs
```

通信协议和来源隔离测试使用 Node.js 内置测试器。先在根目录构建共享包，再运行：

```powershell
npm run build
node --test apps/cli/dist/page-bridge.test.js apps/cli/dist/page-sdk-bridge.test.js
node --test apps/web/tests/task-page-bridge.test.ts
```
