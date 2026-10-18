# 萤石本地控制台与 MCP

独立服务 `http://127.0.0.1:8791/`，MCP `http://127.0.0.1:8791/mcp`，15 个 `ezviz_` 工具，不共用海康或天翼的账号。网页和服务仅在本机运行；列设备、取流等请求仍会访问萤石官方云平台。

在工作区运行 `Start-EZVIZ.ps1`。停止使用 `Stop-EZVIZ.ps1`，会先确认云台停止和媒体清理。需 Node.js >=22.13、构建后的 dist-local 及本地 FFmpeg；首次安装执行 `npm run setup`，详见 [总说明](../../README.md)。

打开网页“配置萤石应用”，填写自己的 [官方控制台](https://open.ys7.com/console/application.html) AppKey、AppSecret。凭据和访问令牌用 Windows DPAPI 存于 `.local/ezviz-credentials.dpapi`，接近到期或收到明确令牌失效时有界刷新，不要求每七天手动重填。密钥不返回浏览器或 MCP；不要分享该凭据文件。

设备列表、预览、能力、云台、云/SD录像月历、片段查询、回放、本地截图、按时长及帧率采样、MP4留存与任务查询已按官方协议搭建。文件独立保存在 `.local/ezviz-captures`；临时预览在 `.local/ezviz-streams`。

尚无真实萤石账号和设备，当前通过离线协议、运行时、MCP、媒体和网页检查。实际取流权限、服务开通、设备能力及 H.265 兼容性待联调。当前 FLV/FFmpeg 链路不支持加密设备或加密录像；不会自动关闭设备加密，需要后续官方 EZOPEN 解密播放器方案。设备/加密状态未知时明确保留未知。保存回放片段是本地重编码，不是下载云端原文件。

源码构建：安装本 package.json 中依赖后 `npm run build`。测试用 `npm test`，不访问真实摄像头。协议接口使用萤石开放平台。
