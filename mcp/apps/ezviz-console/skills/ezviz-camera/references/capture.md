# 持久化图片与视频

单图：`ezviz_camera_snapshot {cameraId}` 返回 job 和 frame。若 pending=true，保留同一 job.id 调状态，不要重复创建截图任务。

实时定时采样示例：
```json
{"cameraId":"从列表选择的真实ID","durationSeconds":30,"fps":1,"kind":"frames","mode":"live"}
```
传给 `ezviz_camera_capture_start` 后立即返回 job.id。用 `ezviz_capture_status {jobId,offset:0,limit:50}` 取图片路径、URL、SHA256，按 nextOffset 翻页。durationSeconds 为采集时长，不是等待开始的时间；fps 是每秒帧数。图片任务最多3600秒、0.1–5fps且总计最多1800帧。不要持续高频轮询，一般每几秒查看进度。

视频：kind=video，最长600秒，保存 H.264 MP4、固定15fps、无音频。fps参数只控制图片任务的采样。历史采集用 mode=playback 并提供 source/date/recordId；时长不能超过所选片段。SD也可用明确的 startTime/endTime。

文件保存在工作区 `.local/ezviz-captures/<jobId>/`。只在读取实际图片后进行视觉分析。capturedAt 是本地近似采集时间，历史录像时间范围见 sourceInfo；relativeSeconds 是采样相对时间，不保证摄像头时钟精确同步。

`ezviz_capture_list` 可恢复当前应用的已有任务；`ezviz_capture_cancel` 停止采集并保留完成文件。服务重启后的未完成任务标记为 interrupted，不会自动恢复拉流。出错要看 job.error，不要把空文件当成已获取画面。

远端工具不能直接读取本机绝对路径时，下载返回的本机 artifact URL 到有权限的执行环境。不要对外公开签名取流地址，不要把私有画面发送到未经用户选择的云服务。
