# qdd_agent_harness_project

Aidol 创造营参赛项目——钱多多门店人工智能助手：店铺管理 harness。

本仓库只负责 **harness**（数据源 + agent + 网关），没有前端界面；界面由前端团队按 [docs/api.md](docs/api.md) 对接。

店长许愿 → agent 通过数据源取数 → 生成**零后端、零 SQL** 的静态页面 → 页面运行时经网关**直连**数据工具，只在需要时调用 agent。

## 架构

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 数据源 | `apps/cli/src/datasource/` | 内置门店工具 `store__*`（只读）+ 远程 MCP 服务 `mcp__<服务>__*`（Streamable HTTP，Bearer 鉴权） |
| Agent | `apps/cli/src/agent/` | 许愿：取数 → 写页面 → 审查发布；续聊；页面运行时的只读问答 `qdd.ask` |
| 网关 | `apps/cli/src/gateway/` | 前端唯一出口：会话/页面/设置 API、SSE 事件、页面托管与 SDK 注入、`/mcp` 端点 |
| 数据集 | `apps/cli/src/datasets/` | `DatasetStore` 接口 + JSONL 实现：按天分区的只追加日志、检查点、主键去重、跨进程锁、增量刷新 |
| 计算引擎 | `packages/shared/src/compute.ts` | 零 SQL 声明式聚合 / 时间线回放 / 状态区间 / 关联；数据源侧与浏览器共用同一份代码 |
| 会话 | `apps/cli/src/sessions.ts` | 文件存储（`workspace/sessions/`），终端与前端共享 |

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

### 拒绝后端与未授权更改

- **鉴权**：所有 API 需网关 token；页面只拿到自己的页面级 token（HMAC 派生），无法访问会话、设置或其它工具。
- **写入沙箱**：agent 只能写当前页面目录下的静态文件；`data/` 只能由 harness 快照生成。
- **零后端守卫**（`guard.ts`）：拒绝 fetch/XHR/WebSocket/表单提交/eval、SQL 与浏览器 SQL 引擎、云后端、服务端代码、非白名单域名。
- **草稿 + 原子发布**，失败不留半成品；页面带 CSP，只能连回网关。
- **写入类数据工具**：不开放直接调用；只能在许愿会话里由 agent 发起，并等店长通过 `approval_required` 授权（终端或前端），配置 `allowWrite: true` 才免确认。

### 统一风格

`workspace/style.md` 是所有页面共用的风格提示词（内置主题 `assets/theme.css`）。前端设置页调用 `GET/PUT/DELETE /api/style`，或在终端执行 `npm run qdd -- style --edit`。

## 快速开始

需要 Node.js 24+、npm 11+。

```powershell
npm ci
Copy-Item .env.example .env                              # 填写 DEEPSEEK_API_KEY
Copy-Item harness.config.example.json harness.config.json  # 配置 MCP、CORS（可选）
npm run dev                                              # 构建并启动网关
npm run qdd -- token                                     # 查看网关 token，交给前端
```

终端也可直接许愿，会话与前端共享：

```powershell
npm run qdd -- wish "最近 30 天各品类销售额和毛利，标出毛利率最高的品类"
npm run qdd -- reply <会话id> "按周汇总"
```

## 命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` / `npm start` | 构建并启动网关 / 直接启动网关 |
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

## 目录结构

```text
apps/cli/            harness（datasource / agent / gateway / guard / sessions）
packages/shared/     共享类型（含前端 API 契约）
docs/api.md          前端对接文档
workspace/           运行时生成（已 gitignore）：style.md、metrics.json、datasets/、store.json 示例数据、site/、sessions/、state/、.gateway-token
```
