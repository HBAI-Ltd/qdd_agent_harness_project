# HAIK 本地摄像头控制台

本项目当前使用独立 Node HTTP 服务与 React 网页，默认仅监听 127.0.0.1:8787；不依赖 Sites 运行环境。安装与客户端配置见 [总说明](../../README.md)。

使用 `mcp` 目录的启动/停止脚本，或 node local/server.mjs。凭据从工作区 .local/haik-credentials.dpapi 读取，由 Windows DPAPI 加密。

运行 npm run build 构建前端。node --test tests/cloud.test.mjs 验证协议与错误处理。

HTTP MCP 位于 /mcp；local/mcp-stdio.mjs 是标准输入输出桥接。现有 15 个工具：内置使用指南、连接状态、设备列表、实时地址、移动与停止，以及设备能力、录像日期/片段/回放、单张截图、批量采集、任务查询/列表/取消。服务端检查 Host/Origin，移动有互斥与 finally 停止。

核心协议来自 APK 6.8.5 运行时观察；云端列表、通道视频令牌、HLS 授权、云台移动及停止已使用本人账号验证。完整网页短信登录已由本人通过人机验证、新短信验证码实测成功。私有协议可能随服务变更而需要适配。

实际网页已验证 H.265 HTTPS FLV 播放。播放器使用萤石官方 ezuikit-flv2.1.1，本地提供 decoder.js/decoder.wasm；不依赖摄像头切换为 H.264。源设备主子码流编码选项被原 App 置灰，未强行修改。

## 录像与本地影像

网页的“录像回放”可按北京时间日期查询云端或 SD 卡片段，并使用返回的真实片段 ID 回放、保存到本机。当前账号令牌不支持录像月历，日期按钮会显示实际限制；直接选定日期查询即可，不需要为月历错误重新登录。设备支持回放不代表当前有录像；空列表会如实显示，没有录像时不会用实时画面冒充回放。加密、服务未开通或设备不支持的情况以云端返回为准。

“截图与本地录像”直接解码视频，在本机保存文件，供网页和 MCP 共用：

- 单张截图：`camera_snapshot`，返回任务和已就绪图片；如果 `pending: true`，查询同一任务，不要反复新建截图。
- 批量截图：`camera_capture_start`，`kind: "frames"`，默认建议 10 秒、1 帧/秒、最大宽度 1280。时长 1–3600 秒，帧率 0.1–5，`ceil(时长 × 帧率)` 不超过 1800 张，最大宽度 320–1920。
- 本地录像：`kind: "video"`，每次 1–600 秒，输出 H.264 MP4、固定 15 帧/秒、无音频。截图帧率参数不改变录像帧率，也不改变摄像头设置。
- 历史采集：先用 `camera_recordings` 查询，再使用相同的 `date/source/recordId`，以 `mode: "playback"` 创建采集；采集时长不能超过片段范围。网页每次最多保存片段前 600 秒。

例如先用 `list_cameras` 取得真实 ID，再调用：

```json
{"name":"camera_capture_start","arguments":{"cameraId":"<设备列表中的 ID>","mode":"live","kind":"frames","durationSeconds":10,"fps":1,"maxWidth":1280,"quality":2}}
```

任务立即返回 `job.id`。用 `capture_status {"jobId":"…","offset":0,"limit":50}` 查看状态和文件；`running` 时约每 5 秒刷新，使用 `nextOffset/hasMore` 翻页。`capture_list {}` 可以恢复当前账号以前的任务；`capture_cancel` 取消采集并保留已保存文件。

文件持久保存在工作区 `.local/haik-captures/<任务 ID>/`，预览缓存位于 `.local/haik-streams/`。关闭网页不影响已提交任务，完成的文件在服务重启后保留；中断任务会标为 `interrupted`，不能视为完整采集。网页任务详情可下载图片、MP4 和 JSON 清单，或复制绝对路径交给本机图片分析工具。

图片包含序号、相对采样时间、近似本机采集时间、路径、字节数和 SHA256。清单下载为 `/api/captures/<任务 ID>/manifest`，文件下载为 `/captures/<任务 ID>/<文件名>`；仅当前账号可访问，清单不含云端签名地址。`capturedAt` 不保证摄像头精确曝光时间；历史录像时间应查看 `sourceInfo`。远程 MCP 客户端不能自动访问本机路径或 127.0.0.1，需要实际的文件传输通道。

分析前必须读取真实保存图片。在线状态、HTTP 成功或完成任务不保证有效画面，云端错误卡片也可能是视频内容；空、失败、少帧、冻结或遮挡应如实报告。禁止用播放器页面截图替代直接解码图片。

## 内置操作技巧

用户提供的 `haik-camera-survey` 经验已整理为 `skills/haik-camera/references/survey.md`：先检查真实 probe 图片、4G 视频停止后约 4 秒再采样、限位排查、质量 2 基线、HEVC FLV、错误代码恢复和像素差异的使用边界。设备型号、倒装方向、分辨率、变焦支持等标为有日期的设备经验，不当作所有摄像头的永久规则。

MCP 客户端可通过 `camera_usage_guide {"section":"survey"}` 或 `resources/read` 读取 `haik://skills/haik-camera/references/survey.md`；`section: "survey-script"` 与 `haik://skills/haik-camera/scripts/camera-survey.mjs` 返回辅助脚本文本。它们均无需账号、不会启动采集或移动。原有 `skill` / `capture` 入口保持兼容，总工具数仍为 15。

`skills/haik-camera/scripts/camera-survey.mjs` 复用持久化 MCP 采集，提供 status、probe、survey、sheet；调用方须先看 probe 原图，再对用户已请求的调测运行 survey。默认等待 4 秒，每次最多 40 步；失败停止本批次，最多补一次明确方向的停止。它保留原始任务并生成关联 SHA256 的报告、查看副本与拼图，不声称精确归位或完成 360°。具体命令与依赖见上述参考。

## 离线验证

`npm run skill:build` 将 `skills/haik-camera/` 的规范文档嵌入 MCP；`npm run skill:check` 检查一致性。`node --test tests/mcp.test.mjs tests/mcp-skill.test.mjs` 验证协议、15 工具发现、参数范围/来源组合、动作路由和无凭据的技能发现。实际云端录像能否取得仍取决于账号服务、设备与当天录像，离线测试不会伪造云端成功结果。
