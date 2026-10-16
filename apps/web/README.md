# Harness 前端

前端位于 `apps/web`，使用 Element Plus UI 组件库和统一的 `--qdd-*` 门店主题，支持浅色与深色模式。数据来自后端实际的会话与已发布页面接口。接口与类型以根目录的 `docs/api.md` 和 `@qdd/shared` 为准。

在仓库根目录启动：

```powershell
npm run dev:web
```

访问 `http://127.0.0.1:5177`，在「设置」填写网关启动时打印的地址及网关 token（`npm run qdd -- token`）。默认网关地址为 `http://127.0.0.1:5173`。

网关配置的 `gateway.corsOrigins` 需包含前端来源，例如 `http://127.0.0.1:5177`。前后端使用相同的主机名与协议，以便页面 cookie 正常工作。网关 token 只存于当前浏览器会话，不放入页面地址。

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

通信协议和来源隔离测试使用 Node.js 内置测试器。先在根目录构建共享包，再运行：

```powershell
npm run build
node --test apps/cli/dist/page-bridge.test.js apps/cli/dist/page-sdk-bridge.test.js
node --test apps/web/tests/task-page-bridge.test.ts
```
