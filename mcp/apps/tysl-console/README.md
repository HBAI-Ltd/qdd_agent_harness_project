# 天翼视联本地控制台

本项目独立于海康控制台，网页和 MCP 监听 `127.0.0.1:8790`。

在 `mcp` 目录运行 `Start-TYSL.ps1`。网页地址为 http://127.0.0.1:8790/ ，MCP 地址为 http://127.0.0.1:8790/mcp 。停止时使用`Stop-TYSL.ps1`，服务会先停止活动云台及视频。

运行依赖本机 Node.js 24.5+、Windows DPAPI 和 `tools/node_modules/ffmpeg-static/ffmpeg.exe`；也可设置 `TYSL_FFMPEG`。前端及 HLS 播放库均保存在本机，无需前端构建或云端部署。账号会话保存在 `.local/tysl-credentials.dpapi`，仅当前 Windows 用户可解密；不要把该目录上传到代码仓库。

网页登录：打开本机网页左下角账号面板，点击“打开官方登录页面”，在天翼账号官方页面输入手机号与验证码。登录后复制浏览器地址栏中的完整返回地址（必须是 `https://active1-e.ctseelink.cn/`，带唯一的 `paras` 参数），粘贴回本机表单并点击“连接此账号”。官方返回页即使空白或显示错误，也可复制地址栏。每次本地流程有效期为 10 分钟，只能交换一次；请勿向他人发送返回地址。账号、验证码均在官方页面输入，返回地址仅由本机服务处理，无需云托管。

新授权先经 Windows DPAPI 暂存至 `.local/tysl-pending.dpapi`，角色信息完整并停止旧账号的云台与视频后才激活。若官方授权结果缺少 `roleInfos.id` 等必要信息，界面会明确报错并保留加密暂存，当前账号不被替换；旧版用户信息接口没有该角色ID，程序不会猜测。当前已验证官方登录页获取成功，实际短信登录后的回填和令牌结果仍需用户完成一次验证。

通过原账号云端接口读取设备、获取 RTSP，并由本机 FFmpeg 转为 H.264 HLS。预览暂不转发音频，最多两路、空闲 90 秒回收。云台每次操作为 200–1000 毫秒的短脉冲，服务端负责发送停止指令。

MCP 提供 14 个工具（下表）。支持 HTTP，也提供 `node apps/tysl-console/local/mcp-stdio.mjs` 作为已运行本地服务的 stdio 代理。

客户端连接示例见 [总说明](../../README.md) 和 `mcp/mcp.client.example.json`。

列表同时读取自有、分享和级联目录，并按设备编号去重。级联读取失败时会显示部分列表提示。

本地持久采集模块为 `local/captures.mjs` 的 `CaptureManager`：构造参数 `{root,ffmpeg,baseUrl,quotaBytes?,maxJobs?}` 均使用本机配置，先 `await init()`。`start({cameraId,cameraName?,sourceUrl,durationSeconds,fps?,maxWidth?,kind?,frameLimit?,accountKey,sourceInfo?})` 在启动 FFmpeg 后立即返回任务，随后用 `status(id,{accountKey})` 查询完整帧列表、`list({accountKey})` 查询任务摘要、`cancel(id,{accountKey})` 取消并保留部分结果、`getFile(id,filename,{accountKey})` 获取已登记文件，关闭时 `await dispose()`。`sourceUrl` 只能由运行时从当前账号的已授权实时或回放接口取得，不作为网页或 MCP 的用户输入；模块校验网络协议，并且不记录它。第二个构造参数仅为离线测试提供依赖注入。

截图支持 1–3600 秒整数、每秒 0.1–5 帧、最大宽度 320–1920（默认 1280），单任务最多 1800 张 JPEG。单张截图可用 `durationSeconds:1,fps:1,frameLimit:1`。录像支持 1–600 秒，固定输出 15 fps、H.264、无音频的分片 MP4，以便取消后尽量保留可用视频。一次只运行一个任务，默认总配额 2 GiB、最多 200 个任务；开始前预检预计占用和磁盘空间，运行中监测占用。配额不足时需用户手动整理文件，不自动删除旧图片。

每个任务目录有持久 `manifest.json`，记录文件绝对路径、本机下载 URL、SHA-256、帧序号与相对秒数，不含源 URL 或凭据；公开结果不含账号标识。任务按账号隔离，账号切换时调用方应先取消旧任务。重启后未完成任务标记为 `interrupted`，已保存文件继续保留。下载仅允许已登记产物，并校验目录、文件和摘要，拒绝目录穿越或符号链接跳转。`list` 只返回摘要及 `lastFrame`，完整列表通过 `status` 获取，避免批量历史任务产生过大响应。

`capturedAt` 始终是“任务开始墙钟时间 + 解码采样相对时间”的近似值（`approximateTime:true`），不代表摄像头精确拍摄时间，也不代表回放的历史录像时间。可选 `sourceInfo` 只允许 `{mode,source?,date?,startTime?,endTime?,recordId?}`：实时可用 `{mode:'live'}`；回放为 `mode:'playback'` 且 `source:'cloud'|'sd'`，日期为 `YYYY-MM-DD`，时间支持北京时间 `YYYY-MM-DD HH:mm:ss`、`HH:mm:ss` 或带时区 ISO 8601；记录标识最长 1024 字符。后续分析应结合该来源信息区分实时采集与历史回放。

离线验证：`node --test apps/tysl-console/tests/captures.test.mjs`。测试包含路径与账号隔离、取消、持久化恢复、配额，以及用本机 FFmpeg `lavfi` 生成真实 JPEG 和可解码 H.264 MP4；不会连接摄像头。

网页新增“录像回放”“截图与本地录像”“本地采集任务”。云录像可选择日期、分页查看片段、回放或保存到电脑；SD 卡按日期查询，实际有无录像由云端返回决定。视频保存和截图均不修改摄像头设置。任务文件默认保存在 `C:\McpConnectors\.local\tysl-captures`，可以下载图片、MP4 和公开 JSON 清单，也可以复制绝对路径交给图片分析工具。

| MCP 工具 | 用途 |
| --- | --- |
| `tysl_camera_status` / `tysl_camera_list` | 状态与设备列表 |
| `tysl_camera_preview` / `tysl_camera_ptz` / `tysl_camera_stop` | 实时预览、云台短脉冲与停止 |
| `tysl_camera_capabilities` | 实际设备提供的协议能力 |
| `tysl_camera_recording_dates` | 有云录像的北京时间日期 |
| `tysl_camera_recordings` | 按 `date`、`source: cloud 或 sd` 查询片段；支持 `offset/limit` |
| `tysl_camera_playback` | 指定 `cameraId/date/recordId/source` 回放片段，返回本地网页/HLS |
| `tysl_camera_snapshot` | 实时单张截图，返回任务与图片文件路径 |
| `tysl_camera_capture_start` | 指定时长和帧率批量截图，或 `kind: video` 保存录像 |
| `tysl_capture_status` | 任务状态与文件路径，帧列表每页默认 50 张、最多 100 张 |
| `tysl_capture_list` / `tysl_capture_cancel` | 当前账号任务列表与取消（保留已保存文件） |

持续图像分析示例：先用 `tysl_camera_list` 取得摄像头 ID，再调用 `tysl_camera_capture_start`：

```json
{"cameraId":"从列表取得的ID","mode":"live","kind":"frames","durationSeconds":60,"fps":1,"maxWidth":1280}
```

立即返回 `job.id`。后续调用 `tysl_capture_status`，参数例如 `{"jobId":"返回的任务ID","offset":0,"limit":50}`，取得 `job.frames[].path` 后交给本机图片读取工具分析；下一次从 `nextOffset` 继续，直到任务结束。`frames[].sha256` 可用于去重或校验。保存历史录像或从历史录像抽帧时改用 `mode: playback`，并传入已查询的 `source/date/recordId`。

关闭网页不会停止采集；关闭服务或切换账号会取消运行任务并保留已有文件。重启后可继续读取旧结果，未完成任务不会自动续采。当前账号已实际验证云录像回放、本地 MP4 保存、单张截图和 3 秒每秒 2 帧的批量采集；SD 当天查询返回空列表。完整离线检查：`npm test`（在本目录运行）。
