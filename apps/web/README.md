# Harness 前端

前端位于 `apps/web`，使用 Element Plus UI 组件库和统一的 `--qdd-*` 门店主题，支持浅色与深色模式。数据来自后端实际的会话与已发布页面接口。接口与类型以根目录的 `docs/api.md` 和 `@qdd/shared` 为准。

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

- 概览：真实会话与页面 KPI、近七天会话图表和最近页面明细。
- 对话：创建许愿、续聊、SSE 进度、需求确认与显式授权。
- 任务：直接展示后端已发布页面，通过 `PageView.url` 嵌入，保留网关注入的 SDK、样式及页面鉴权。
- 设置：Element Plus 输入框、按钮和开关，用于网关连接、浅色/深色主题、发送快捷键及后端统一页面风格。
- 后端没有任务重命名、删除和手动状态接口，前端不提供这些操作。
- 等待回答或授权时隐藏停止按钮；执行中可请求取消。

UI 对接入口：

- `src/api/workspace.ts`：使用共享契约的网关请求、鉴权和 SSE。
- `src/pages/chat/useWorkspace.ts`：提供 `sessions`、`activeSession`、`pages`、`activePage`，以及连接、发送、确认、取消和页面修改方法。
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

通信协议和来源隔离测试使用 Node.js 内置测试器。先在根目录构建共享包，再运行：

```powershell
npm run build
node --test apps/cli/dist/page-bridge.test.js apps/cli/dist/page-sdk-bridge.test.js
node --test apps/web/tests/task-page-bridge.test.ts
```
