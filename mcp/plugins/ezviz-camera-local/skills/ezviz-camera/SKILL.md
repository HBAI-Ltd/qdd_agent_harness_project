---
name: ezviz-camera
description: 使用本地萤石 MCP 查看本人授权的设备、录像与保存的实际图片，进行定时帧采集和用户要求的短时云台操作。
---

本插件连接 `http://127.0.0.1:8791/mcp`，网页为同端口根路径。萤石、海康、天翼是独立服务；这里仅使用 `ezviz_` 前缀工具。

先用 `ezviz_camera_list` 取得真实 cameraId。未连接时引导用户在本地网页配置自己的萤石开放平台 AppKey/AppSecret；不要索取密钥到聊天，也不要调用其他品牌的登录工具。AppSecret 和令牌由本机 Windows 加密保存，MCP 不返回。空列表可以表示账号暂无设备，不要生成示例设备。

查看画面时调用 `ezviz_camera_snapshot`，读取返回的 JPEG 路径或下载图片，再描述实际可见内容。`online`、取流 URL、人工封面和旧截图均不是当前画面的证据。不要通过 computer use 或浏览器截图读取摄像头画面。网页截图可用于界面排查，不能代替直接采集的视频帧。

`ezviz_camera_preview` 返回本机预览地址；`ezviz_camera_capabilities` 查询能力，不保证账号有操作权限或已购买存储。`online=null`、`encrypted=null` 均表示未知。加密或加密状态未知的视频不进入当前 FLV/FFmpeg 链路；保留设备设置，解释需要官方 EZOPEN 解密播放器。H.265 能否实际解码仍需设备联调。

查询历史：`ezviz_camera_recording_dates` 按 month（YYYY-MM）和 source（cloud/sd）读月历；`ezviz_camera_recordings` 按北京时间 date 查询片段。回放用同一摄像头的 date/source/recordId 调 `ezviz_camera_playback`；不要把云录像来源猜成 SD。没有片段时如实报告。保存回放视频属于本地重编码留存，不是云文件原件下载。

连续图片或视频分析先读 [references/capture.md](references/capture.md)，使用持久化采集工具。服务重启后已保存的文件仍在；其他账号的任务不可见。

云台仅用于用户要求的移动、调测或查看周边。同一摄像头串行执行 `ezviz_camera_ptz`，方向和速度以实际支持为准；默认 300ms、speed=1，范围 0慢/1中/2快，部分海康型号不接受0。每次动作都会安排停止。只有返回 stopped=true（或错误 details.stopped=true）才说明停止已确认；开始请求超时不能自动重放。停止不明时优先 `ezviz_camera_stop` 并传真实最近方向，再失败则停止后续移动并请用户检查官方 App。无角度反馈，不声称已精确旋转某角度或覆盖360度。移动后可等待数秒再采集，比较实际图片以判断缓冲延迟。

当前接入按官方契约及离线响应验证；尚无真实萤石账号与设备联调结果。以后应区分列表、播放、录像、云台各项实测状态。
