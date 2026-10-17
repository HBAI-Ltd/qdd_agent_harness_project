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

在「设置」检查网关地址与后端启动时打印的地址一致；浏览器可能保留了旧地址，可点击「使用配置地址」更新。修改地址配置后需重启 Vite；预览或部署已有构建时需重新构建前端。`API_PROXY_TARGET` 只调整前端连接目标，不会启动网关或改变后端监听地址。

在另一个终端查看网关 token，然后填入「设置」并连接：

```powershell
npm run qdd -- token
```

网关配置的 `gateway.corsOrigins` 需精确包含前端来源，例如 `http://127.0.0.1:5177`；示例配置已包含该地址。若使用 `http://localhost:5177`，需另行添加该来源，并让网关地址也使用 `localhost`。前后端使用相同的主机名与协议，以便页面 cookie 正常工作。修改网关配置后需重启后端。

生成的任务页面需要直接使用实际网关来源：页面级 token、cookie、SDK 注入、CSP 嵌入权限和父页面通信均由网关处理。`gateway.corsOrigins` 同时控制跨域请求、页面嵌入与 SDK 允许的主界面来源。网关 token 只存于当前浏览器会话，不放入页面地址。

- 对话：支持新建对话、历史记录与会话切换，发送经营需求、续聊、查看 SSE 进度，并完成需求确认与显式授权。点击「新建对话」进入空白草稿，首次发送消息时通过 `POST /api/wishes` 建立会话；已有对话通过 `POST /api/sessions/:id/messages` 续聊。
- 对话记录来自 `GET /api/sessions`，按更新时间倒序展示；切换时加载 `GET /api/sessions/:id` 并订阅该会话的 SSE。前端按网关保存当前选择，刷新或重新连接后恢复同一会话或新对话草稿状态。
- 工作台总览：基于真实会话与页面展示进行中对话、待处理确认、最近对话和已发布任务；确认操作需回到对应对话处理。
- 任务：侧边栏展示历史对话和已发布页面，支持搜索和 `Ctrl K` 展开侧边栏并聚焦搜索框。页面通过 `PageView.url` 嵌入，保留网关注入的 SDK、样式及页面鉴权。
- 侧边栏：桌面端可收缩为图标导航并保存偏好；移动端使用抽屉，可通过遮罩或 `Escape` 关闭。
- 设置：Element Plus 输入框、按钮和开关，用于网关连接、浅色/深色主题、发送快捷键及后端统一页面风格。
- 修改已发布页面时，在同一对话面板恢复该页面对应的原始会话，继续其上下文，不额外创建会话。
- 后端没有任务重命名、删除和手动状态接口，前端不提供这些操作。
- 等待回答或授权时隐藏停止按钮；执行中可请求取消。
- 提问器：后端已有 `question_required` / `question_answered` 事件和 `POST /api/sessions/:id/questions/:requestId`，前端沿用现有接口；按原型同时展示问题及标签选项，支持推荐默认值、单选、多选、自填、答案汇总和确认。
- 连接器：提供六类系统与设备的接入信息预览，实际可用工具通过 `GET /api/tools` 读取。安装、账号授权、设备扫码绑定尚无接口，实际操作保持禁用，并在代码中标注 `// TODO`。
- 技能：提供明确标记的技能模板和编辑预览，可将模板带入新对话讨论。技能列表、保存和运行接口待接入，保留 `// TODO`，不会将模板视为已保存的技能。
- 定时任务：提供常用任务模板、执行时间和通知渠道的配置预览；创建、启停和通知绑定接口待接入，保留 `// TODO`，不会实际创建任务或发送消息。
- 任务详情继续通过 iframe 加载后端提供的 `PageView.url`，主界面顶部提供「通过对话修改」，不在前端重建原型动画中的经营图表。

UI 对接入口：

- `src/page/layout/index.vue`：公共页面框架，提供侧边栏、顶栏与 `router-view`，在路由切换时保持网关连接及共享状态。
- `src/views/`：Vue Router 注册的界面，包含 `chat`、`overview`、`tasks`、`schedules`、`skills`、`connectors`、`settings`、连接检查与 404；对应 `/chat`、`/overview`、`/tasks/:slug?`、`/schedules`、`/skills`、`/connectors`、`/settings`、`/test`。`/` 跳转至 `/chat`。
- `src/components/WorkspaceSidebar.vue`：导航、搜索、新建对话、历史记录及收缩展示。
- `src/composables/workspaceContext.ts`：页面共享状态和导航入口；各会话的未发送输入在当前浏览器访问期间独立保留。
- `src/composables/useConversationDrafts.ts`：按会话隔离输入草稿，处理切换后发送完成及首次创建期间继续输入。
- `src/api/workspace.ts`：使用共享契约的网关请求、鉴权和 SSE。
- `src/api/catalog.ts`：只读工具列表请求，使用共享 `ToolInfo` 契约。
- `src/composables/useWorkspace.ts`：提供 `sessions`、`activeSessionId`、`activeSession`、`pages`、`activePage`，以及连接、`startNewConversation`、`selectSession`、发送、确认、取消和页面修改方法。
- `activeSession.events` 为真实事件流；`status` 区分执行中、等待、空闲和失败。
- 页面预览使用 `PageView.url`，不再将页面内容作为三段源码拼接。
- `TaskPreview` 通过 `@message="handleTaskMessage"` 将经过来源校验的模板消息交给主界面。主界面也派发 `qdd:task-message` 供业务模块监听，并可用 `message.reply("host:result", payload)` 回传。
- 模板等待 `qdd.host.ready` 后调用 `qdd.host.emit(type, payload)`；使用 `qdd.host.on(type, listener)` 监听回传并取得取消监听函数。详细示例见根目录 `docs/api.md`。

检查与构建：

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

提问与授权状态的回归测试位于 `tests/session-actions.test.mjs`，直接编译真实组件的 setup 脚本，验证默认选项、答案校验、多选与自填、会话切换重置、已解决请求过滤和提交防重：

```powershell
node --test apps/web/tests/session-actions.test.mjs
```

通信协议和来源隔离测试使用 Node.js 内置测试器。先在根目录构建共享包，再运行：

```powershell
npm run build
node --test apps/cli/dist/page-bridge.test.js apps/cli/dist/page-sdk-bridge.test.js
node --test apps/web/tests/task-page-bridge.test.ts
```
