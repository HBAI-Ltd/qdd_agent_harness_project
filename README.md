# qdd_agent_harness_project

Aidol 创造营参赛项目——钱多多门店人工智能助手：店铺管理 harness。

本仓库包含 **harness**（数据源 + agent + 网关）与 Vue / Element Plus 工作台前端。前端使用 [docs/api.md](docs/api.md) 中的接口，启动和界面说明见 [apps/web/README.md](apps/web/README.md)。

店长许愿 → agent 通过数据源取数 → 生成**零后端、零 SQL** 的静态页面 → 页面运行时经网关**直连**数据工具，只在需要时调用 agent。

## 架构

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 数据源 | `apps/cli/src/datasource/` | 内置门店工具 `store__*`（只读）+ 远程 MCP 服务 `mcp__<服务>__*`（Streamable HTTP，Bearer 鉴权） |
| Agent | `apps/cli/src/agent/` | 许愿：取数 → 写页面 → 审查发布；续聊；页面运行时的只读问答 `qdd.ask` |
| 网关 | `apps/cli/src/gateway/` | 前端唯一出口：会话/页面/设置 API、SSE 事件、页面托管与 SDK 注入、`/mcp` 端点 |
| 工作台前端 | `apps/web/` | 对话与提问授权、任务页面、技能、定时任务、连接器和工作台总览 |
| 数据集 | `apps/cli/src/datasets/` | `DatasetStore` 接口 + JSONL 实现：按天分区的只追加日志、检查点、主键去重、跨进程锁、增量刷新 |
| 计算引擎 | `packages/shared/src/compute.ts` | 零 SQL 声明式聚合 / 时间线回放 / 状态区间 / 关联；数据源侧与浏览器共用同一份代码 |
| 会话 | `apps/cli/src/sessions.ts` | 普通对话存于 `workspace/sessions/`，定时执行对话存于 `workspace/schedule-sessions/`；终端与前端共享 |
| 手机投屏 App | `apps/android-screen/` | 安卓 MediaProjection 内网连续投屏，带系统授权与停止通知 |
| 安卓设备 MCP | `apps/android-mcp/` | 连续接收手机画面，提供电脑鼠标键盘遥控和视觉 MCP；通过 Wi-Fi 或 USB 连接 ESP32，再由 BLE HID 控制安卓 |
| 硬件桥接 | `apps/esp/` | AI Passport ESP32-C3 的蓝牙键鼠、实体停止、中文界面和板上 Wi-Fi 密码键盘 |

### 页面如何取数

- `qdd.tool(name, args)`：页面直连只读数据工具，不经过 agent。agent 发布时必须声明页面用到的工具，网关按页面 token 校验，未声明的一律 403。
- `qdd.ask(question, context)`：需要 agent 能力时使用（只读工具），页面需声明 `useAgent`。
- `snapshot_data` 生成的 `data/*.js`：实时数据不可用时的兜底。

### 连续状态与聚合（零 SQL）

- **指标口径** `workspace/metrics.json` 是唯一来源：`flow` 可加总、`stock` 取期末（按实体）、`ratio` 由汇总后的分子 ÷ 分母重算（不对比率求平均）、`state` 按区间统计。修改需店长授权，并会把依赖页面标记为待复核。
- **数据集**：事实表按天分区只追加；事件流（如 `inventory_moves`）以「检查点 + 流水回放」得到任意时刻状态，`qdd compact` 生成新检查点缩短回放；维度表（`products`）与编号映射（`keymap/*`）用于跨来源关联。
- **工具**：`store__aggregate`（过滤/分桶/分组/补齐/窗口/关联）、`store__timeline`、`store__segments`、`store__list_metrics`、`store__list_datasets`。
- **跨会话**：页面记录依赖的数据集版本与页面版本（乐观锁，同一页面同时只允许一个会话修改）；会话摘要 + 页面清单构成共享记忆，agent 用 `recall` / `read_session` / `read_artifact` 检索；页面参数用 `qdd.state` 持久化。
- **存储可替换**：上层只依赖 `DatasetStore` 接口。数据集超过百万行、连锁多店或出现多进程写入冲突时，新增 SQLite 实现即可替换，SQL 仍只存在于存储实现内部，agent 与页面始终零 SQL。

### 需求对齐与能力缺口

- **引导式提问**：新许愿写页面前，agent 必须先用 `clarify` 逐项对齐（对象、时间范围、口径、矛盾取舍、估测假设），候选项来自真实数据、推荐项在前；前端或终端回答（终端支持编号多选、回车选推荐、直接输入自定义）。`llm.clarify` 可设为 `required`（默认）/ `auto` / `off`。
- **能力缺口**：`gaps` 由 harness 校验生成（如结论数字未能核验），无需模型提交；网关把检测到的缺口固定展示在页面顶部，页面代码无法移除。数据缺失、估测假设或能力受限仍需在页面或回复正文中说明。

### 拒绝后端与未授权更改

- **鉴权**：所有 API 需网关 token；页面只拿到自己的页面级 token（HMAC 派生），无法访问会话、设置或其它工具。
- **写入沙箱**：agent 只能写当前页面目录下的静态文件；`data/` 只能由 harness 快照生成。
- **零后端守卫**（`guard.ts`）：拒绝 fetch/XHR/WebSocket/表单提交/eval、SQL 与浏览器 SQL 引擎、云后端、服务端代码、非白名单域名。
- **草稿 + 原子发布**，失败不留半成品；页面带 CSP，只能连回网关。
- **写入类数据工具**：不开放直接调用；只能在许愿会话里由 agent 发起，并等店长通过 `approval_required` 授权（终端或前端），配置 `allowWrite: true` 才免确认。

### 工作台：技能、定时任务、连接器

- **待办与总览**：`GET /api/overview` / `GET /api/pending` 汇总所有会话里待店长处理的授权和问题；授权等待时长由 `approvalTimeoutMin`（默认 60 分钟）控制。
- **技能**（`workspace/skills/`）：可复用的做事方法；agent 可从对话中 `save_skill`（需店长确认）、`load_skill`。
- **定时任务**（`workspace/schedules.json`）：5 段 cron，网关内调度；到点无人值守执行（可绑定技能、在页面上刷新），结论推送到连接器；停机错过的执行会补跑。店长说「每天 9 点…」时 agent 可用 `create_schedule` 直接创建（需店长确认）；定时执行中的推送若需确认会进入工作台待办，可用于「店长确认后再发」。
- 每次定时执行使用独立会话 ID，与前端刷新无关。手动修改同一页面时，会停止占用页面的后台定时执行，待其完全退出后继续修改；交接和修改期间保留页面锁，其他会话不能同时写入。只取消当前执行，不停用定时配置；普通会话之间的并发修改仍会被拒绝。
- **记录数据集**（`records/<name>`）：试吃报损、临期处置回填、巡检等逐条登记的数据。agent 用 `define_record` 提出结构（需店长确认），页面用 `qdd.records.add/update/remove/list` 读写，网关按结构校验并只允许页面访问代码中用到的记录；修改按 id 覆盖、作废写墓碑，`store__aggregate` 可直接汇总（计数指标 `records`）。
- **连接器**（`workspace/connectors.json`）：目前开放飞书（群机器人 webhook / 企业自建应用），安装前先验证，凭据加密存储；agent 用 `send_notification` 推送（按连接器权限需店长确认）。

### 浏览器

在 `harness.config.json` 设置 `browser.enabled: true` 并重启网关后，agent 可操作本机 Chrome/Edge。浏览器使用内置 Puppeteer + CDP 驱动（移植自 Toonflow-app），无需另接 Chrome MCP 服务；`executablePath` 留空时自动查找本机浏览器。前端收到浏览器事件后自动展开实时画面，通过 `/api/browser/:id/stream` 观看、`/input` 接管；首次点击/输入需店长授权。画面可手动收起，切回标签页后自动恢复只读观看。

### 统一风格

`workspace/style.md` 是所有页面共用的风格提示词（内置主题 `assets/theme.css`）。前端设置页调用 `GET/PUT/DELETE /api/style`，或在终端执行 `npm run qdd -- style --edit`。

## 快速开始

需要 Node.js 24+、npm 11+。

```powershell
npm ci
Copy-Item .env.example .env                              # 填写 DEEPSEEK_API_KEY
Copy-Item harness.config.example.json harness.config.json  # 前端直连需配置 CORS，MCP 按需配置
npm run dev                                              # 构建并启动网关
npm run qdd -- token                                     # 查看网关 token，交给前端
```

另开终端运行 `npm run dev:web`，打开 `http://127.0.0.1:5177`。
前端默认地址会跟随后端的 `HOST`、`PORT` 配置；若浏览器保留旧地址，在设置中点击「使用配置地址」。
`gateway.corsOrigins` 必须包含当前前端来源。没有 MCP 服务时，可只保留该网关配置并移除示例 `erp` 项。

终端也可直接许愿，会话与前端共享：

```powershell
npm run qdd -- wish "最近 30 天各品类销售额和毛利，标出毛利率最高的品类"
npm run qdd -- reply <会话id> "按周汇总"
```

## 命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` / `npm start` | 构建并启动网关 / 直接启动网关 |
| `npm run dev:web` / `npm run build:web` | 启动前端开发服务 / 检查类型并构建前端 |
| `npm run qdd -- token` | 显示网关 token |
| `npm run qdd -- wish "<需求>" [--page <slug>] [--yes]` | 终端许愿，写入授权在终端确认 |
| `npm run qdd -- reply <会话id> "<消息>"` | 续聊 |
| `npm run qdd -- sessions [会话id]` | 会话列表 / 事件回放 |
| `npm run qdd -- pages` / `tools` | 页面 / 数据工具列表 |
| `npm run qdd -- datasets` / `metrics` | 数据集（版本、水位线）/ 指标口径 |
| `npm run qdd -- refresh [数据集...]` | 从数据源增量刷新（也可配置 `datasets.refreshIntervalSec` 由网关定时执行） |
| `npm run qdd -- compact <数据集> "<时刻>"` | 为事件流生成检查点 |
| `npm run qdd -- style [--edit\|--reset]` | 风格提示词 |
| `npm run qdd -- check` | 守卫重新审查所有页面 |
| `npm test` | 计算引擎不变量、数据集回放/检查点/去重、HTTP MCP、会话与跨会话、并发锁、页面鉴权（模拟 LLM） |
| `npm run check:esp` | 检查 AI Passport 的 ESP-IDF 5.5.3 环境 |
| `npm run build:esp` | 构建并验证 AI Passport 合并固件与匹配的调试归档，不烧录 |
| `npm run validate:esp` | 固件完整门禁：仓库检查、宿主测试、构建与镜像验证 |
| `npm run idf:esp -- <参数>` | 激活 IDF 后转发原生 `idf.py` 参数 |
| `npm run android:mcp` | 启动安卓 stdio MCP；MCP 客户端配置直接使用 `node` 与编译后的入口路径 |
| `npm run android:mcp:http` | 启动本机 Streamable HTTP MCP，无需令牌 |
| `npm run test:android` | 安卓 MCP、连续投屏、Wi-Fi/串口键鼠、操作台与会话清理离线测试 |
| `npm run build:android:screen` | 构建手机局域网投屏 APK（Android SDK + JDK 17） |
| `start-android.cmd` | 启动连续投屏操作台与 MCP；ESP32 可通过 Wi-Fi 或 USB 连接电脑 |

浏览器集成回归位于 `apps/cli/src/browser.test.ts`，使用本机 Chrome/Edge 与本地网页验证操作、授权和实时画面；没有本机浏览器时跳过。会话终态回归位于 `apps/cli/src/session-completion.test.ts`，验证状态持久化完成前保持运行锁。定时执行记录隔离回归位于 `apps/cli/src/schedule-sessions.test.ts`，验证独立存储、旧记录迁移与对话列表隔离。均通过 `npm test` 执行，使用 Node.js 内置测试器，测试文件命名为 `*.test.ts`。

模型流式响应回归位于 `apps/cli/src/llm.test.ts`，覆盖长工具参数、分块传输、输出截断及参数校验。定向运行：先执行 `npm run build`，再执行 `node --test apps/cli/dist/llm.test.js apps/cli/dist/harness.test.js apps/cli/dist/chat-options.test.js`。

若模型只返回思考内容而没有正文或工具调用，客户端会明确报错，不把这条响应加入对话。续聊时会自动过滤旧历史中的空 assistant 消息，避免触发 `Invalid assistant message: content or tool_calls must be set`；正常工具调用携带的思考内容仍原样保留。

若 `write_file` 报参数 JSON 不完整（例如 `Unterminated string in JSON`），说明模型生成的工具参数无法解析，并非文件已经写入。客户端会识别 `finish_reason=length`，阻止该轮工具执行并反馈缩小输出的提示；流意外结束且没有完成标记时直接报错，不执行部分调用。大页面应拆成较小的 HTML、JS、CSS 文件分多轮写入；同一路径仍是完整覆盖，不支持追加。默认 `llm.maxTokens` 为 8192，可在模型支持范围内调整（模型条目自己的 `maxTokens` 会覆盖全局设置），但不要用补引号或补括号的方式“修复”被截断的文件内容。

DeepSeek 官方 API 的 `deepseek-flash` 当前对应 V4.1 Flash（2026-10-17）。如需使用最大输出预算，在 `harness.config.json` 的对应 `llm.models` 条目中设置 `"maxTokens": 393216`（384 × 1024），不要把该值设为所有模型的通用默认值。[官方参数文档](https://api-docs.deepseek.com/api/create-chat-completion/)规定 `max_tokens` 上限为 393216；实际输出仍受输入与输出合计上下文长度限制，长输出可能增加耗时和费用。修改配置后需重启后端。

## 目录结构

```text
apps/cli/            harness（datasource / agent / gateway / guard / sessions）
apps/web/            Vue / Element Plus 工作台（page/layout 公共框架、views 路由界面）
apps/esp/            FoloToy AI Passport ESP32-C3 固件（ESP-IDF 5.5.3，独立构建）
apps/android-screen/ 安卓内网投屏 App（MediaProjection）
apps/android-mcp/    手机内网画面与 ESP32 BLE 键鼠 MCP（电脑运行）
packages/shared/     共享类型（含前端 API 契约）
docs/api.md          前端对接文档
workspace/           运行时生成（已 gitignore）：style.md、metrics.json、datasets/、store.json 门店数据（初始为空，不自动填充示例）、site/、sessions/、schedule-sessions/、state/、.gateway-token
```

AI Passport 环境配置与命令见 [apps/esp/README.zh_CN.md](apps/esp/README.zh_CN.md)。
根 `npm run build` 继续只构建 TypeScript 工程；固件通过 `build:esp` 单独构建。

安卓连接、配对、只读投屏及 MCP 配置见 [apps/android-mcp/README.zh_CN.md](apps/android-mcp/README.zh_CN.md)。
该 MCP 服务直接返回手机原分辨率 JPEG 图像，需要支持 MCP 图像的视觉客户端；现有门店 harness 的文本 MCP 适配器尚不转发图像内容。
