# qdd_agent_harness_project

Aidol 创造营参赛项目——钱多多门店人工智能助手：店铺管理 harness。

监控与经营数据的独立 MCP 连接器位于 [mcp/](mcp/README.md)，包含海康互联、天翼视联、萤石与收钱吧的源码、配置示例及运行说明。

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
- `qdd.ask(question, context, optionsOrOnEvent)`：需要 agent 能力时使用（只读工具），页面需声明 `useAgent`。第三参数可传进度回调，或 `{ images: [{ url, detail? }], onEvent? }`；支持 Base64 data URL 和 HTTPS 图片 URL，沿用当前模型配置（需支持视觉），限制及示例见 [图片问答](docs/api.md#图片问答)。
- `snapshot_data` 生成的 `data/*.js`：实时数据不可用时的兜底。

### 连续状态与聚合（零 SQL）

- **指标口径** `workspace/metrics.json` 是唯一来源：`flow` 可加总、`stock` 取期末（按实体）、`ratio` 由汇总后的分子 ÷ 分母重算（不对比率求平均）、`state` 按区间统计。修改需店长授权，并会把依赖页面标记为待复核。
- **数据集**：事实表按天分区只追加；事件流（如 `inventory_moves`）以「检查点 + 流水回放」得到任意时刻状态，`qdd compact` 生成新检查点缩短回放；维度表（`products`）与编号映射（`keymap/*`）用于跨来源关联。
- **工具**：`store__aggregate`（过滤/分桶/分组/补齐/窗口/关联）、`store__timeline`、`store__segments`、`store__list_metrics`、`store__list_datasets`。
- **跨会话**：页面记录依赖的数据集版本与页面版本（乐观锁，同一页面同时只允许一个会话修改）；会话摘要 + 页面清单构成共享记忆，agent 用 `recall` / `read_session` / `read_artifact` 检索；页面参数用 `qdd.state` 持久化。
- **存储可替换**：上层只依赖 `DatasetStore` 接口。数据集超过百万行、连锁多店或出现多进程写入冲突时，新增 SQLite 实现即可替换，SQL 仍只存在于存储实现内部，agent 与页面始终零 SQL。

### 需求对齐与能力缺口

- **引导式提问**：新许愿写页面前，agent 必须先用 `clarify` 逐项对齐（对象、时间范围、口径、矛盾取舍、估测假设），候选项来自真实数据、推荐项在前；前端或终端回答（终端支持编号多选、回车选推荐、直接输入自定义）。`llm.clarify` 可设为 `required`（默认）/ `auto` / `off`。
- **能力缺口**：发布和回复都必须声明 `gaps`（缺数据 / 估测 / 不支持 / 需授权），网关把缺口固定展示在页面顶部，页面代码无法移除。

### 拒绝后端与未授权更改

- **鉴权**：所有 API 需网关 token；页面只拿到自己的页面级 token（HMAC 派生），无法访问会话、设置或其它工具。
- **写入沙箱**：agent 只能写当前页面目录下的静态文件；`data/` 只能由 harness 快照生成。
- **零后端守卫**（`guard.ts`）：拒绝 fetch/XHR/WebSocket/表单提交/eval、SQL 与浏览器 SQL 引擎、云后端、服务端代码、非白名单域名。
- **草稿 + 原子发布**，失败不留半成品；页面带 CSP，默认只能连回网关，播放器可使用显式配置的视频源。
- **写入类数据工具**：不开放直接调用；只能在许愿会话里由 agent 发起，并等店长通过 `approval_required` 授权（终端或前端），配置 `allowWrite: true` 才免确认。

### 工作台：技能、定时任务、连接器

- **待办与总览**：`GET /api/overview` / `GET /api/pending` 汇总所有会话里待店长处理的授权和问题；授权等待时长由 `approvalTimeoutMin`（默认 60 分钟）控制。
- **技能**（`workspace/skills/`）：可复用的做事方法；agent 可从对话中 `save_skill`（需店长确认）、`load_skill`。
- **定时任务**（`workspace/schedules.json`）：5 段 cron，网关内调度；到点无人值守执行（可绑定技能、在页面上刷新），结论推送到连接器；停机错过的执行会补跑。店长说「每天 9 点…」时 agent 可用 `create_schedule` 直接创建（需店长确认）；定时执行中的推送若需确认会进入工作台待办，可用于「店长确认后再发」。
- **记录数据集**（`records/<name>`）：试吃报损、临期处置回填、巡检等逐条登记的数据。agent 用 `define_record` 提出结构（需店长确认），页面用 `qdd.records.add/update/remove/list` 读写，网关按结构校验并只允许页面访问代码中用到的记录；修改按 id 覆盖、作废写墓碑，`store__aggregate` 可直接汇总（计数指标 `records`）。
- **连接器**（`workspace/connectors.json`）：在连接器页由用户选择安装飞书、收银系统（收钱吧）或门店摄像头（海康互联、天翼视联、萤石），默认不安装任何厂商。安装前先验证本地服务；选择保存后立即加载相应工具，删除后撤销，重启后保留用户选择。飞书凭据加密存储；agent 用 `send_notification` 推送（按连接器权限需店长确认）。

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
`gateway.corsOrigins` 必须包含当前前端来源。默认 `mcpServers` 为 `{}`。先按 [mcp/README.md](mcp/README.md) 启动所需本地服务，再在工作台连接器页选择平台并点击「验证并安装」。启动 MCP 服务只让它可用，不会自动安装连接器。`mcpServers` 仍可配置自定义 MCP；四个内置厂商的同名配置只覆盖连接地址和鉴权，实际启用取决于用户的安装选择。

安装收钱吧后，后端默认读取 `mcp/.local/shouqianba/mcp-key`；该密钥由本地服务生成，无需复制到表单或 `.env`。自定义 MCP 可用 `bearerTokenFile` 或 `bearerTokenEnv` 指定鉴权来源，两者只能配置一个；文件相对路径基于项目根目录。密钥文件与厂商会话位于 Git 忽略的 `mcp/.local/`，不要提交。安装与账号登录分别进行，商户或摄像头账号仍需在各自本地控制台完成登录。

任务内视频播放器需要跨源取流时，在 `mediaOrigins` 填写视频地址的 HTTPS origin，例如 `"mediaOrigins": ["https://stream.example.com:8443"]`。要允许所有视频来源，显式设置 `"mediaOrigins": ["*"]`：播放器连接允许任意 HTTP、HTTPS、WS、WSS 来源，媒体允许任意 HTTP、HTTPS、blob 和 data 来源。默认仍为空数组，也可继续使用精确来源和端口；`"*"` 必须单独使用，不接受 `https://*.example.com`、签名路径、查询参数、凭据或指令注入。

修改 `mediaOrigins` 后重新加载任务页面即可生效，网关会在每次加载 HTML 时读取最新配置。页面业务代码仍禁止直接 fetch、XHR、WebSocket 和表单提交。播放器可使用 blob 媒体及本地/blob worker；非空 `mediaOrigins` 允许 WASM 解码，不开启 JavaScript eval，也不会把媒体来源加入脚本或 iframe 白名单。

海康 FLV/H.265 播放器与解码器通过 `/assets/camera-player/` 同源提供，包含官方 `ezuikit-flv` 的脚本、样式、WASM 和许可证。无需在任务页面复制临时签名地址或加载其他解码服务。资源及配置热更新测试位于 `apps/cli/src/camera-player-assets.test.ts`；真实浏览器合成视频回归运行 `node scripts/test-camera-player-browser.mjs`。

视频 CSP 专项测试位于 `apps/cli/src/media-csp.test.ts`；构建后运行 `node --test apps/cli/dist/media-csp.test.js`，验证默认隔离、精确来源和端口、注入拒绝及业务请求守卫，不连接摄像头。

### 监控推流播放器

Agent 的白名单播放器规范支持在任务 iframe 内生成监控播放页面，无需嵌入外部播放器站点：

| 格式 | 播放方案 |
| --- | --- |
| HTTP-FLV | 已安装的 `ezuikit-flv@2.1.1`，通过同源 `/assets/camera-player/index.js`、`style.css`、`decoder.js` / `decoder.wasm` 提供 |
| HLS | 优先原生 video；否则使用 `https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js`，须保留该 CDN 域名在白名单中 |
| RTMP / RTMPS / RTSP | 浏览器不能直接播放；页面明确提示提供转流后的 HLS / HTTP-FLV 地址。本项目不新增转流服务，也不通过替换 URL 协议伪造播放地址 |

播放器的内部取流不等于允许页面业务代码直接联网。视频地址通过已授权的 `qdd.tool` 获取，或由用户在页面输入；不要把签名地址写死在页面中，也不要为视频域名授予脚本 CDN 权限。跨源媒体需要配置上述 `mediaOrigins`，并由媒体服务提供 CORS；HLS 清单、分片、密钥和重定向来源都必须允许。HTTPS 页面仍受浏览器混合内容限制。

FLV 使用同源解码器；HLS 使用 `enableWorker: false`，避免被 CSP 拦截的 CDN worker。Agent 规范要求点击播放、失败提示、手动重试、切换/离页释放资源，以及 RTMP 转流提示；不承诺所有编码、有声自动播放或全屏可用。可许愿：“生成监控页面，通过已授权工具获取 HTTP-FLV 或 HLS 地址，在任务 iframe 播放；仅有 RTMP 时提示需要转流。”

规范与守卫回归：[camera-player-prompt.test.ts](apps/cli/src/agent/camera-player-prompt.test.ts)，构建后运行 `node --test apps/cli/dist/agent/camera-player-prompt.test.js apps/cli/dist/media-csp.test.js`。实际 iframe FLV 播放回归运行 `node scripts/test-camera-player-browser.mjs`，需要本机 Chrome/Edge 和 FFmpeg（可通过 `CHROME_PATH` / `FFMPEG_PATH` 指定），仅使用合成视频，不连接真实摄像头。

MCP 鉴权专项测试位于 `apps/cli/src/datasource/mcp-auth.test.ts`；构建后运行 `node --test apps/cli/dist/datasource/mcp-auth.test.js`，验证密钥文件读取、会话重连和环境变量兼容性，不连接厂商服务。

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
