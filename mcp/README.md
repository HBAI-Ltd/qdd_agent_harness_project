# 监控与收钱吧本地 MCP 连接器

四个独立的 Node.js 服务，包含本地网页、MCP 接口和离线测试。运行目录与主项目隔离，主项目无需安装这些服务的前端依赖。凭据保存使用 Windows DPAPI，需要 Windows 10/11、Node.js 24.5+、npm 11+。

| 服务 | 源码 | 默认网页及 HTTP MCP | 工具数 |
| --- | --- | --- | --- |
| 海康互联 | `sites/haik-console` | `http://127.0.0.1:8787/`、`/mcp` | 15 |
| 天翼视联 | `apps/tysl-console` | `http://127.0.0.1:8790/`、`/mcp` | 14 |
| 萤石 | `apps/ezviz-console` | `http://127.0.0.1:8791/`、`/mcp` | 15 |
| 收钱吧 | `sites/shouqianba-console` | `http://127.0.0.1:8788/`、`/mcp`（密钥鉴权） | 18 |

## 安装与启动

在仓库的 `mcp` 目录运行：

```powershell
npm run setup
npm run build
```

`setup` 按各自锁文件安装海康、萤石前端和 `tools` 下的 FFmpeg / Sharp。天翼及收钱吧服务仅依赖 Node.js 内置模块。首次安装 FFmpeg 需要下载二进制；可分别设置 `HAIK_FFMPEG`、`TYSL_FFMPEG`、`EZVIZ_FFMPEG` 使用其他 FFmpeg。

按需启动，每项均有对应的 `Stop-*.ps1`：

```powershell
.\Start-TYSL.ps1
.\Start-EZVIZ.ps1
.\Start-Shouqianba.ps1
# 海康先完成下方的客户端配置初始化
.\Start-HAIK.ps1
```

服务仅监听本机；查询设备、视频和经营数据仍需要访问厂商云。三个摄像头服务支持设备列表、预览、云台、录像查询、回放、持久截图与 MP4 采集，实际功能受账号权限与设备能力限制。海康与萤石请使用停止脚本完成云台停止及媒体清理。

## 各服务配置

- **海康互联**：仓库不包含 App 客户端认证或 SDK 密钥。将 `haik-client-config.example.json` 复制到 `.local/haik-client-config.json`，填写自己合法取得的客户端参数，再运行 `node scripts/initialize-haik.mjs`。首次初始化生成独立安装标识和加密空会话，然后在网页中手动完成人机验证及短信登录。初始化不会覆盖已有凭据；未填写客户端参数时无法短信登录或取视频。
- **天翼视联**：启动后从网页打开官方登录页，用自己的账号完成登录，将完整官方返回地址粘贴回本地网页。支持自有、分享及级联列表，设备按编号去重。
- **萤石**：在网页中填自己的官方开放平台 AppKey / AppSecret。当前有离线测试，尚无真实萤石设备联调；加密视频暂不支持，不会自动关闭设备加密。
- **收钱吧**：在网页手动完成人机验证、短信登录和商户身份选择。MCP 提供只读经营工具，不提供收款、退款、充值或数据修改操作。金额单位及覆盖范围以工具响应为准；未接入的数据不能视为零。

海康首次初始化命令（复制后先编辑 JSON，再运行初始化）：

```powershell
New-Item -ItemType Directory -Force .local
Copy-Item haik-client-config.example.json .local/haik-client-config.json
# 在本机编辑 .local/haik-client-config.json，填写自己的参数
node scripts/initialize-haik.mjs
```

## MCP 客户端

先启动对应服务，再按 `mcp.client.example.json` 配置客户端。收钱吧的 `args` 必须改为实际绝对路径；stdio 桥接会读取本机生成的密钥，无需把密钥写进配置。其 HTTP 入口要求 Bearer 密钥，不可直接套用摄像头的无密钥 HTTP 示例。

三个摄像头也分别提供 `local/mcp-stdio.mjs` 桥接；`plugins/` 包含相应本地插件清单及使用技能。端口可用 `HAIK_PORT`、`TYSL_PORT`、`EZVIZ_PORT` 调整并同步修改客户端配置。收钱吧启动脚本默认 8788；自定义端口请设置 `SQB_PORT` 后直接运行 `node --use-env-proxy sites/shouqianba-console/server.mjs`，stdio 端也使用同一个 `SQB_PORT`。

## 验证

```powershell
npm test
npm run build
```

现有测试涵盖协议、参数、登录状态、账号隔离、只读数据口径、路径检查、MCP 和媒体持久化。媒体测试使用 FFmpeg 本地生成的画面，不连接真实摄像头；不会发短信、操作云台或读取真实商户数据。主仓库仍按根目录的命令执行 `npm run typecheck`、`npm run build`。

## 本地数据与许可证

`.local/` 包含运行后生成的加密账号、访问密钥、截图、视频和任务清单，已在 Git 中忽略。仓库不含本机登录会话、商户报告、顾客数据或监控画面；重新分发时从干净源码构建。收钱吧的分析页仅保留通用代码，未生成当前商户报告时会显示未就绪。

厂商协议可能变更；海康当前令牌不支持录像月历时可直接按日期查询，真实录像是否可用以设备返回为准。FFmpeg、Sharp、播放器及前端库保留各自许可证；本仓库提交源码、必要播放器资源及许可证，安装后的依赖和编译产物不入库。
