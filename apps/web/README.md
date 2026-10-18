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

开发模式会预热入口、公共布局和默认聊天页。Element Plus 的运行时代码显式从 `element-plus/es/components/<组件族>/index` 导入，由 Vite 扫描并预构建实际使用的入口，避免加载整库 JavaScript；类型仍可从 `element-plus` 导入。新增 UI 组件时沿用组件级导入（例如 `ElButton` 使用 `button/index`，`ElFormItem` 使用 `form/index`）。实时浏览器组件在需要展示画面时才加载；版本更新提示插件只在生产构建启用。保留 `apps/web/node_modules/.vite` 缓存，日常启动无需使用 `--force`。修改 Vite 配置后重启 `npm run dev:web`；首次重建依赖缓存仍需时间，后续启动会复用缓存。

开发时保存文件即可触发热更新，通常无需手动刷新。浏览器开发者工具 Network 中不要勾选 **Disable cache**；普通刷新会复用预构建依赖，源码的 `304` 请求只是检查是否修改，不会重新下载整份代码。`Ctrl+F5` 等强制刷新会绕过缓存，适合排查缓存问题；不要作为日常刷新方式。缓存行为见 [Vite 性能指南](https://vite.dev/guide/performance.html#review-your-browser-setup)。

在「设置」检查网关地址与后端启动时打印的地址一致；浏览器可能保留了旧地址，可点击「使用配置地址」更新。修改地址配置后需重启 Vite；预览或部署已有构建时需重新构建前端。`API_PROXY_TARGET` 只调整前端连接目标，不会启动网关或改变后端监听地址。

在另一个终端查看网关 token，然后填入「设置」并连接：

```powershell
npm run qdd -- token
```

网关配置的 `gateway.corsOrigins` 需精确包含前端来源，例如 `http://127.0.0.1:5177`；示例配置已包含该地址。若使用 `http://localhost:5177`，需另行添加该来源，并让网关地址也使用 `localhost`。前后端使用相同的主机名与协议，以便页面 cookie 正常工作。修改网关配置后需重启后端。

生成的任务页面需要直接使用实际网关来源：页面级 token、cookie、SDK 注入、CSP 嵌入权限和父页面通信均由网关处理。`gateway.corsOrigins` 同时控制跨域请求、页面嵌入与 SDK 允许的主界面来源。网关 token 只存于当前浏览器会话，不放入页面地址。

- 对话：支持新建对话、历史记录与会话切换，发送经营需求、续聊、查看 SSE 进度，并完成需求确认与显式授权。点击「新建对话」进入空白草稿，首次发送消息时通过 `POST /api/wishes` 建立会话；已有对话通过 `POST /api/sessions/:id/messages` 续聊。
- 同一轮助手消息使用统一的 `parts` 按输出顺序展示，正文、思考、工具、技能与浏览器记录依次穿插，思考和工具行可独立展开。`text/thinking` 按 `blockId` 累积实时 `delta`，收到 `content/done` 后以完整内容替换；同一回复内按块序号补齐迟到的块，完成时保留原行及展开状态。结构化工具事件读取 `tool.id/name/args/status/progress/result`，按调用 id 在原位置合并进度和结果，状态区分 `running/success/error`；旧版纯文本工具记录仍可查看。
- 回复中的 loading、等待确认和停止提示放在当前助手消息正文末尾，不单独新增头像或消息行。首个内容块尚未返回时，先展示当前轮的助手容器，随后在同一容器中继续渲染内容。
- 实时增量不进入持久化事件数组，SSE 重连的 `since` 只计算落盘事件。切换会话、连接、开始新一轮或执行结束会清理未完成增量，重连通过完整回放恢复内容；已结束的会话不会继续显示工具调用中，明确取消时显示「已中断」。持续输出时仅在消息区接近底部时跟随滚动。
- 助手正文与思考支持 Markdown 标题、表格、代码块、引用、任务列表和链接；用户输入保留原文。表格和代码横向滚动，原始 HTML 按文字显示，危险链接协议不渲染为链接。
- 对话媒体：Markdown 图片 `![说明](URL)` 和图片链接显示可打开原图的预览；视频链接 `[说明](URL)` 显示播放卡片，支持 MP4/WebM/MOV 等浏览器可解码格式，以及 HLS（`.m3u8`）和 HTTP-FLV（`.flv`）。查询参数保留不变；无扩展名链接用 title 指明 MIME，例如 `[直播](https://example.com/live "application/vnd.apple.mpegurl")` 或 `[监控](https://example.com/live "video/x-flv")`。同一消息块内相同 URL 只展示一张媒体卡片，代码块和原始 HTML 不会触发播放。
- 视频不自动播放，点击后才加载播放器及流；图片加载失败、视频错误和加载超时均显示提示并可重试。上传的图片/视频在输入区和历史消息中均可点击预览（文件夹内媒体也可预览），通过带鉴权的附件接口读取 Blob，不把网关 token 放进 URL；切换媒体、凭据或卸载组件时取消下载、销毁播放器并释放 Blob URL，原附件下载入口保留。
- HLS 使用浏览器原生能力或本地打包的 hls.js，FLV 使用本地打包的 mpegts.js/MSE；浏览器必须支持实际视频编码，聊天播放器不提供 H.265 WASM 软解。跨域流及 HLS 子资源需要媒体服务器允许前端来源的 CORS，HTTPS 页面不能播放被浏览器拦截的 HTTP 混合内容。RTSP/RTMP 需数据源提供 HTTP(S) 地址；上传的 HLS 播放列表不会同时上传/解析关联分片。展示媒体不等同于模型能够分析画面。
- 对话记录来自 `GET /api/sessions`，按更新时间倒序展示；切换时加载 `GET /api/sessions/:id` 并订阅该会话的 SSE。前端按网关保存当前选择，刷新或重新连接后恢复同一会话或新对话草稿状态。
- 工作台总览：接入 `GET /api/overview` 与 `GET /api/pending`，展示真实计数、已启用定时任务、最近对话和已发布页面。可在总览直接回答问题或授权，也可进入来源对话；侧栏同步技能、任务和已连接来源数量。
- 任务：按后端 `PageView.kind` 区分定时与一次性页面，支持类型筛选、关联定时任务名称搜索，并展示各任务启停状态。列表和预览可置顶或取消置顶多个页面，侧边栏同步标记，始终保留后端的置顶顺序。侧边栏支持搜索和 `Ctrl K` 展开并聚焦搜索框。页面通过 `PageView.url` 嵌入，保留网关注入的 SDK、样式及页面鉴权。
- 侧边栏：桌面端可收缩为图标导航并保存偏好；移动端使用抽屉，可通过遮罩或 `Escape` 关闭。
- 设置：Element Plus 输入框、按钮和开关，用于网关连接、浅色/深色主题、发送快捷键及后端统一页面风格。
- 修改已发布页面时，在同一对话面板恢复该页面对应的原始会话，继续其上下文，不额外创建会话。
- 后端没有任务重命名、删除和手动状态接口，前端不提供这些操作。
- 对话底部参考 Toonflow 的模型与思考强度组合选择器，模型目录由 `GET /api/models` 返回，可搜索并按服务商分组；未配置 API Key 的模型显示原因且不可选择。思考档位来自 `GET /api/chat/options`，只显示所选模型支持的档位。已有会话切换模型调用 `PUT /api/sessions/:id/model`，下一轮生效；首次发送和续聊都会传递 `model` / `reasoningEffort`，会话重载后恢复已保存的选择。可在 `llm.models` 中配置不同服务商、模型与支持档位，详见根目录 `harness.config.example.json` 和 `docs/api.md`。
- 附件通过选择、多选、整文件夹、拖放或粘贴添加，原文件上传到网关并随消息发送附件引用；支持仅附件发送、任意扩展名、单文件最多 50 MiB、每条最多 500 个附件，上传期间禁止发送。图片/视频支持上述预览，其他文件仍可下载；模型能否解析文件取决于实际工具与模型能力。
- 发送时立即清空输入框和附件，并在消息区展示用户消息和等待进度，发送位置切换为「停止回复」；发送失败会恢复未被编辑的草稿及附件，不覆盖发送后继续输入或主动删除的内容。附件与输入草稿按会话、网关隔离，异步转换会保留在原会话，首次会话创建时迁移后续草稿与附件。执行中或等待回答、授权时均可停止，下一条草稿可以继续编辑。停止请求被接受后仍等待真实终态再恢复发送。
- 刷新工作空间保留正在提交的请求和当前会话；续聊、答题、授权与取消通过 SSE 原位更新，避免重载聊天记录。新建请求尚未返回会话 ID 时点击停止，会在创建确认后取消该会话。
- 提问器：后端已有 `question_required` / `question_answered` 事件和 `POST /api/sessions/:id/questions/:requestId`，前端沿用现有接口；按原型同时展示问题及标签选项，支持推荐默认值、单选、多选、自填、答案汇总和确认。
- 连接器：使用后端目录与安装列表，支持飞书 Webhook / 企业自建应用安装、设置、验证、测试消息和删除；内置与配置文件 MCP 来源只读展示。安装或重新验证可能发送验证消息，表单明确说明；其他未开放目录类型保持禁用与 `// TODO`。
- 技能：技能库与模板分组展示，支持按来源筛选和搜索名称、说明、步骤及工具；详情提供运行、编辑和来源对话入口，编辑器支持步骤排序及可选工具设置。加载、断连、失败、空列表与无搜索结果分别展示对应操作。运行时以 `POST /api/wishes` 的 `skillId` 预加载技能；对话中的 `skill` 事件显示加载与保存结果，`save_skill` 授权展示实际名称、步骤与工具。
- 定时任务：支持真实列表、新建、编辑、删除、启停、立即执行、执行结果及通知状态，可绑定技能、已发布页面和可推送连接器；高级 cron 保留已有自定义规则，空值编辑发送 `null` 解绑。cron 按网关时区执行；配置通知目标即授权该任务完成后自动推送，数据修改默认需确认，并遵守工作空间已有的授权设置。
- 对话与总览待办中的 `define_record`、`create_schedule` 授权展示登记字段、执行规则、网关提供的下次时间、关联页面/技能及推送接收方，保留原始参数供核对。助手创建的定时任务显示创建来源，可返回创建对话。
- 设置中的「门店登记」接入 `/api/records`，支持登记表结构创建与扩展、按日期及条数查询、填写、修改和作废记录。动态表单保留数字零、否和未填写的区别；更新不改登记时间，结构调整不删除或改类型。提交前确认，连接或选择变化后不提交过期表单；写入成功后同步刷新数据与指标。任务卡片和预览按 `PageEntry.records` 提供对应登记表入口，进入 `/settings?record=<name>#settings-records` 自动选择并定位。
- 浏览器：参考 Toonflow 的浏览器面板，将真实 `browser` 事件的实时 JPEG 画面显示为对话消息区最底部的紧凑卡片，后续回复始终排在画面上方；展示域名、页面标题和连接状态。同一轮的浏览器状态合并更新，整个对话只订阅一条画面流。点击「放大」在弹窗中观看并显示导航、人工接管及中文输入；通过 Teleport 移动同一画面，点击「返回对话」不重复建立连接。卡片与放大窗口中的「关闭浏览器」会调用 `DELETE /api/browser/:id` 真正结束浏览器会话，断开画面流并保存关闭事件；也可在对话中说「关闭浏览器」，由助手调用 `browser` 的 `close` 动作。关闭后必须通过对话重新打开浏览器；输入框下方单独标明的「收起浏览器」仅暂停观看，可通过「查看浏览器」恢复。默认只读，按图片实际尺寸换算接管坐标，校验会话和标签标识，409 不重放输入；窗口失焦或退出放大时释放输入并退出人工接管。页面隐藏时暂停订阅，返回后自动恢复只读观看；切会话、停止观看和卸载时释放输入并关闭订阅，已关闭浏览器不会自动重连。
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

开发加载与缓存回归使用独立 Vite 端口、临时依赖缓存和干净的 Chrome 会话，验证重复刷新复用依赖、源码返回 `304`，以及模块热更新无需重载文档：

```powershell
node scripts/test-frontend-dev-cache.mjs
```

默认使用本机 Chrome；可通过 `CHROME_PATH` 指定浏览器可执行文件。脚本输出本机加载耗时和传输量，不设固定耗时门槛。

网关地址与接口回归测试位于 `tests/gateway-config.test.ts`、`tests/workspace-api.test.ts` 和 `tests/workspace.test.mjs`，使用 Node.js 内置测试器：

```powershell
node --test apps/web/tests/gateway-config.test.ts apps/web/tests/workspace-api.test.ts apps/web/tests/workspace.test.mjs
```

对话选择、输入草稿与实际状态逻辑的回归测试位于 `tests/conversation-selection.test.ts`、`tests/conversation-drafts.test.ts` 和 `tests/workspace-conversation.test.mjs`，覆盖新建、续聊、历史切换、草稿与选择恢复、并发防重、过期请求隔离及页面修改：

```powershell
node --test apps/web/tests/conversation-selection.test.ts apps/web/tests/conversation-drafts.test.ts apps/web/tests/workspace-conversation.test.mjs
```

聊天模板交互回归位于 `tests/chat-view.test.mjs`，结合真实草稿逻辑验证延迟请求期间立即清空、失败恢复、新输入保护、首发消息、loading、停止与恢复发送、草稿编辑和 Enter 防重；草稿回归另覆盖重复相同文本、主动删除与身份清除隔离。会话状态回归另覆盖发送期间刷新、创建响应与历史快照竞态、停止失败重试及旧连接响应隔离。所有前端测试可一次执行：

```powershell
node --test apps/web/tests/*.test.*
```

对话排布回归使用真实聊天与 Markdown 组件，覆盖独立折叠、状态更新时保留展开、切换会话重置、工具行合并与旧事件兼容。`tests/chat-timeline.test.ts` 检查显示分组不会修改原始 SSE 事件；`tests/markdown.test.ts` 检查 Markdown 内容与 HTML、链接安全处理：

```powershell
node --test apps/web/tests/chat-view.test.mjs apps/web/tests/chat-timeline.test.ts apps/web/tests/markdown.test.ts
```

消息内浏览器回归使用生产界面、真实网关和本机 Chrome，模型响应通过本地脚本提供。覆盖截图解码、对话底部位置、跨轮次复用连接、人工输入、移动端布局、切换对话后的订阅释放、按钮真实关闭与对话指令关闭：

```powershell
npm run build
npm run build:web
node scripts/test-chat-browser-preview.mjs
```

可通过 `CHROME_PATH` 指定 Chrome 可执行文件。参考实现：[Toonflow 对话组件](https://github.com/HBAI-Ltd/Toonflow-app/blob/master/apps/web/src/components/agent/conversation.vue)、[浏览器面板](https://github.com/HBAI-Ltd/Toonflow-app/blob/master/packages/tools/browser/src/browserPanel.vue)。

流式消息状态与 SSE 游标回归位于 `tests/workspace-conversation.test.mjs`，登记接口、真实登记表单、任务登记入口与设置联动覆盖如下：

```powershell
node --test apps/web/tests/workspace-conversation.test.mjs apps/web/tests/records-api.test.ts apps/web/tests/workspace-records.test.mjs apps/web/tests/settings-records-integration.test.mjs apps/web/tests/task-pages-view.test.mjs apps/web/tests/task-preview.test.mjs
node --test apps/web/tests/approval-preview.test.ts apps/web/tests/session-approval-preview.test.mjs apps/web/tests/schedules-actions.test.mjs
```

技能界面交互回归位于 `tests/skills-view.test.mjs`，直接编译实际 Vue 模板，覆盖来源与步骤搜索、加载和失败重试、模板自定义、步骤排序与校验、编辑草稿及工具保留、运行和删除：

```powershell
node --test apps/web/tests/skills-view.test.mjs
```

提问与授权状态的回归测试位于 `tests/session-actions.test.mjs`，直接编译真实组件的 setup 脚本，验证默认选项、答案校验、多选与自填、会话切换重置、已解决请求过滤和提交防重：

```powershell
node --test apps/web/tests/session-actions.test.mjs
```

新增领域接口、资源订阅及浏览器输入回归位于 `tests/connectors-api.test.mjs`、`tests/skills-schedules-api.test.ts`、`tests/gateway-resource.test.mjs`、`tests/browser-session.test.mjs`、`tests/session-browser.test.mjs`。浏览器组件回归覆盖失焦后持续收帧、隐藏后恢复只读、隐藏期间切会话，以及关闭或卸载后不重连；聊天组件回归覆盖自动展开及用户关闭后的行为。测试只使用本地桩，不发送外部消息：

```powershell
node --test apps/web/tests/connectors-api.test.mjs apps/web/tests/skills-schedules-api.test.ts apps/web/tests/gateway-resource.test.mjs apps/web/tests/browser-session.test.mjs apps/web/tests/session-browser.test.mjs
```

通信协议和来源隔离测试使用 Node.js 内置测试器。先在根目录构建共享包，再运行：

```powershell
npm run build
node --test apps/cli/dist/page-bridge.test.js apps/cli/dist/page-sdk-bridge.test.js
node --test apps/web/tests/task-page-bridge.test.ts
```

设置中的「数据与指标」通过 `/api/datasets` 和 `/api/metrics` 展示数据集版本、水位线、行数、来源及统一指标口径。可对全部配置来源或单个数据集执行增量刷新；逐项展示 `/api/datasets/refresh` 返回的成功与失败，没有增量来源的数据集只读展示。切换连接、凭据或离开设置时会取消请求并隔离迟到响应。

浏览器人工接管支持悬停、拖动、双击及左/中/右键。鼠标和键盘输入按顺序发送，连续移动只保留最新坐标；移出画面、失焦或切换标签时释放输入，遇到 409 不重放操作。

任务分类、计划关联、置顶和页面预览的真实组件交互回归位于 `tests/task-pages-view.test.mjs`；置顶接口、防重与旧响应隔离另由 `tests/workspace-api.test.ts` 和 `tests/workspace-conversation.test.mjs` 覆盖。

对应 API 与真实组件模板的回归测试覆盖部分刷新失败、空刷新结果、连接切换取消和旧响应隔离：

```powershell
node --test apps/web/tests/datasets-api.test.mjs apps/web/tests/workspace-data.test.mjs
```

整页刷新、跳转或离页时，工作空间和实时浏览器通过 `pagehide` 主动关闭事件流，避免旧文档占满 Chrome 的 HTTP 连接；从浏览器历史返回时通过 `pageshow` 恢复订阅，浏览器画面恢复为只读。站内路由切换继续复用公共布局的连接。技能与定时任务编辑器在断连时保留草稿并提示未保存；保存中断时明确提示结果尚未确认，切换地址或 token 后阻止把旧编辑目标写入新连接。任务页面请求超过 15 秒未加载时显示可重试的错误；已加载但 SDK 握手未完成仍使用 8 秒期限。

相关组件回归位于 `tests/workspace-conversation.test.mjs`、`tests/workspace-api.test.ts`、`tests/session-browser.test.mjs`、`tests/skills-view.test.mjs`、`tests/schedules-view.test.mjs`、`tests/schedules-actions.test.mjs` 和 `tests/task-preview.test.mjs`，包含静默事件流取消、离页恢复、离线保存、模板技能、任务启停/立即执行/执行对话、自定义执行规则以及页面加载和握手超时。使用上方全量前端测试命令执行。

真实 Chrome 回归使用独立临时工作区和本机 HTTP 服务，不调用外部模型或发送消息。连接回归使用完整生产构建与真实网关，记录网关实际收到的请求和活动事件流，默认执行 30 次整页跳转、30 次站内切换、5 次离页及 15 次历史前进后退。预览回归将实际 TaskPreview 组件和 SDK 打包为生产模式，验证 30 次正常握手、挂起请求和缺失 SDK 的超时反馈，并覆盖同源隔离与跨源两种预览的独立弹窗。弹窗可正常使用表单和存储，原 iframe 仍保持隔离。浏览器默认使用本机 Chrome；可通过 `CHROME_PATH` 指定路径，连接回归次数可通过 `NAVIGATION_ROUNDS` 调整：

```powershell
npm run build
npm run build:web
node scripts/test-frontend-navigation.mjs
node scripts/test-task-preview-browser.mjs
```

任务页面可以通过用户点击打开独立窗口，使用 `noopener,noreferrer`。直播 FLV 是媒体流，需要播放器解码。任务内可通过网关同源的 `/assets/camera-player/` 加载官方 FLV/H.265 播放器、样式和 WASM，设置 `autoWasm:true` 并关闭 SDK 遥测（`ignoreMonitor:true`）。`mediaOrigins:["*"]` 放行所有视频来源，配置修改后重新加载任务即可生效。独立窗口应打开 MCP 本地播放器，避免直接打开带临时签名的 FLV 地址。海康支持 `/?cameraId=<设备编号>&preview=1&quality=sub`，控制台来源使用实际 MCP 配置地址。关闭画面时销毁播放器，并忽略关闭前尚未返回的取流响应。

模型选择的状态与竞态回归位于 `tests/composer-model-selection.test.ts`，覆盖目录重试、不可用模型、连续切换、失败恢复及凭据变更隔离，包含在上述前端测试命令中。生产界面与真实网关的 Chrome 回归验证模型选择、思考档位、下一轮生效、刷新恢复、附件发送和移动端弹层；模型回复使用本地桩，不调用外部模型：

```powershell
npm run build
npm run build:web
node scripts/test-chat-composer-browser.mjs
```

对话媒体回归使用真实 Vue 组件、Chrome 和 FFmpeg 合成的本地图片/MP4/HLS/FLV，不访问外部媒体或模型。覆盖实际解码出帧、无自动播放、流式回复更新不打断视频、附件鉴权、错误提示、凭据切换/卸载资源释放和移动端宽度。脚本位于 [test-chat-media-browser.mjs](../../scripts/test-chat-media-browser.mjs)，可用 `CHROME_PATH` 和 `FFMPEG_PATH` 指定本机程序：

```powershell
node --test apps/web/tests/markdown.test.ts apps/web/tests/chat-view.test.mjs
node scripts/test-chat-media-browser.mjs
```
