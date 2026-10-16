# qdd_agent_harness_project

Aidol 创造营参赛项目——钱多多门店人工智能助手。

基于 Node.js、TypeScript 和 npm workspaces 的 monorepo，前端使用 Vue 3、Vite 和 TDesign。

## 环境

- Node.js 24 或更高版本（当前验证版本：24.15.0）
- npm 11 或更高版本（当前验证版本：11.12.1）

## 快速开始

在仓库根目录执行，前端无需单独安装依赖：

```powershell
npm ci
npm run dev
```

- 前端：`http://127.0.0.1:5177`；连接检查页为 `/test`，展示后端连接状态，支持重新检查。
- 后端：`http://127.0.0.1:3000`，健康检查地址为 `/health`。
- 前端请求 `/api/health`，Vite 去掉 `/api` 前缀后转发到后端 `/health`；前后端复用 `@qdd/shared` 的 `HealthResponse` 类型。

如需修改后端监听地址或端口，将 `.env.example` 复制为根目录下的 `.env` 后调整配置：

```powershell
Copy-Item .env.example .env
```

Vite 同样读取根目录 `.env`。默认代理目标由 `HOST` 和 `PORT` 决定；监听所有网卡时，代理连接本机回环地址。也可设置 `API_PROXY_TARGET` 指向单独运行的后端。修改配置后需要重新启动开发服务。`HOST`、`PORT` 和 `API_PROXY_TARGET` 仅供服务端工具读取，不应加 `VITE_` 前缀或放入秘密信息。

前端固定监听本机 5177 端口，端口被占用时会报错。需要局域网访问时可单独执行 `npm run dev --workspace @qdd/web -- --host 0.0.0.0`。

## 目录结构

```text
apps/
  server/             Node.js HTTP 服务入口（@qdd/server）
  web/                Vue 3 前端（@qdd/web）
    src/api/          后端接口客户端与待对接接口
    src/pages/        对话工作空间、连接检查与 404 页面
    src/router/       Vue Router 路由
    src/utils/        Axios 客户端与全局工具
packages/
  shared/             应用间共享的类型和常量（@qdd/shared）
package.json          workspace 定义与根命令
package-lock.json     全仓唯一依赖锁文件
tsconfig.base.json    共享严格 TypeScript 配置
tsconfig.json         普通 tsc 使用的后端及共享包 references
tsconfig.check.json   后端及共享包的无产物类型检查
```

服务端使用 NodeNext 模块解析，前端覆盖为 Bundler 模块解析并加入 DOM 类型。前端 Vue SFC 和 Vite 配置由 `@qdd/web` 的 `typecheck` 命令检查。后端保留 TypeScript 7；Vue 检查使用前端的 TypeScript 6，通过 `scripts/vue-typecheck.mjs` 显式解析，避免 npm 提升依赖后误用不兼容的编译器。前端独立的 `tsconfig.check.json` 直接检查共享源码，不依赖已有构建产物。根命令先构建共享包和后端，再检查、打包前端，避免使用普通 `tsc` 编译 Vue SFC。

新增 Node.js workspace 时，需要同步维护根目录的构建 references 和构建命令；Vue workspace 使用自己的 references，并通过 `vue-tsc` 检查，不要加入根目录普通 `tsc` 的引用链。新增共享包时，也需要维护类型检查的 `paths`、依赖声明和使用方的 project references。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 同时启动后端编译监听、后端自动重启和 Vite 热更新 |
| `npm run dev:server` | 单独启动后端开发服务 |
| `npm run dev:web` | 单独启动前端；需有运行中的后端才能请求 API |
| `npm run build` | 构建共享包、后端和前端，产物位于各 workspace 的 `dist/` |
| `npm run build:server` | 构建共享包和后端 |
| `npm run build:web` | 检查并打包前端 |
| `npm run typecheck` | 检查后端、共享包、Vue SFC 和 Vite 配置 |
| `npm start` | 启动编译后的 JSON 后端服务，需先构建 |
| `npm run preview --workspace @qdd/web` | 预览前端生产产物，固定端口 5177，支持 API 代理 |
| `npm run clean` | 清理各 workspace 的构建产物与增量信息 |

## 验证

```powershell
npm run typecheck
npm run build
npm run dev
```

访问前端 `/test` 应显示“服务连接正常”；`GET http://127.0.0.1:3000/health` 和 `GET http://127.0.0.1:5177/api/health` 均应返回 HTTP 200，例如：

```json
{ "status": "ok", "service": "qdd-agent-harness" }
```

后端未知路径以及前端代理下的未知 API 应返回 HTTP 404。前端未知页面由 Vue Router 展示 404 页面。停止后端后，连接检查应显示失败并允许重试。目前没有自动化测试框架。

## 部署

```powershell
npm ci
npm run build
npm start
```

`npm start` 仅提供 JSON API。前端产物位于 `apps/web/dist`，需要通过静态站点服务部署，并配置：

- `/api/*` 反向代理到后端，去掉 `/api` 前缀。
- 页面路径回退到 `index.html`，支持 Vue Router 的浏览器历史路由。

Vite 开发和预览代理配置不会写入生产静态产物。业务接口与认证尚未实现。

## Harness 对话工作空间

前端位于 `C:\worker\qdd_agent_harness_project\apps\web`。运行 `npm run dev:web` 后访问 `http://127.0.0.1:5177/`。

- 界面采用黑白灰配色，左侧包含对话、任务、设置以及后端任务列表。对话与任务分别管理，点击任务后在右侧渲染页面内容。
- 任务列表、任务详情、对话及消息由后端提供。前端通过 `apps/web/src/api/workspace.ts` 统一请求，所有待对接的业务地址均使用 `// TODO` 标注。
- 任务内容是后端返回的原生 `html`、`script`、`css`。前端将其组合为独立文档，使用允许脚本执行的沙箱 iframe 渲染，脚本与样式隔离于聊天界面。
- 设置保存在当前浏览器的 localStorage；任务记录以后端为准。小屏幕通过顶部按钮展开侧边栏。

当前服务端仅实现 `/health`，业务接口等待后端团队代码。以下地址与字段仅为前端临时占位，不是后端接口约定；接入处均标注 `// TODO`，后续以后端实际实现为准。前端已准备好任务列表和 HTML / JavaScript / CSS 页面渲染，接口未就绪时展示待接入与重试状态。

| 待对接地址 | 用途 |
| --- | --- |
| `GET /api/tasks` | 获取任务列表 |
| `GET /api/tasks/:id` | 获取任务详情 |
| `POST /api/tasks` | 从对话创建任务，提交来源对话、消息、标题和说明 |
| `PATCH /api/tasks/:id` | 修改任务标题或状态 |
| `DELETE /api/tasks/:id` | 删除任务 |
| `GET /api/conversations` | 获取对话列表 |
| `POST /api/conversations` | 新建对话 |
| `GET /api/conversations/:id` | 获取对话及消息 |
| `PATCH /api/conversations/:id` | 修改对话标题 |
| `DELETE /api/conversations/:id` | 删除对话，保留其关联任务 |
| `POST /api/conversations/:id/messages` | 发送消息，返回更新后的完整对话 |
| `POST /api/conversations/:id/stop` | 请求后端停止当前对话回复 |

任务列表期望返回数组，每项至少包含 `id`、`title`、`updatedAt`。时间支持毫秒时间戳或 ISO 字符串。可选字段包含 `description`、`status`（`todo` / `in_progress` / `done`）、`createdAt`、`conversationId`、`sourceMessageId` 和 `sourceConversationTitle`。任务详情包含 `content`；暂无页面时可省略或传 `null`。对话详情另有 `messages` 数组，每条消息包含 `id`、`role`、`content`、`createdAt`。页面内容约定如下：

```json
{
  "id": "task-1",
  "title": "门店运营看板",
  "updatedAt": "2026-10-17T08:00:00.000Z",
  "content": {
    "html": "<main><h1>门店运营看板</h1><button id=\"refresh\">刷新</button></main>",
    "script": "document.querySelector('#refresh').addEventListener('click', () => { document.querySelector('h1').textContent = '已刷新'; });",
    "css": "body { font-family: sans-serif; color: #111; background: #fff; }"
  }
}
```

`html` 为页面标记，`script` 与 `css` 分别为不带外层标签的 JavaScript 和 CSS 源码。客户端不保存服务端密钥。页面脚本不能访问宿主 DOM 或 localStorage；沙箱用于隔离宿主页面，不承诺限制任务页面的网络访问。

手动验证：确认后端任务列表显示及任务详情切换；检查空列表、请求失败和重试；后端返回包含样式与按钮脚本的页面，确认 iframe 中布局和交互正常；在设置中切换主题和 Enter 发送；检查窄屏侧边栏。

接口契约测试位于 `apps/web/tests/workspace-api.test.ts`，使用 Node.js 内置测试运行器，不依赖真实后端：

```powershell
node --test apps/web/tests/workspace-api.test.ts
```
