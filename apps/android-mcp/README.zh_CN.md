<p align="right"><strong>简体中文</strong> · <a href="README.md">English</a></p>

# 设备操作台

手机安装[设备投屏 App](../android-screen/README.zh_CN.md)，经用户明确授予
MediaProjection 录屏权限后，通过一个持续的 Wi-Fi MJPEG 连接向电脑传送可选画质预览。
操作台显示连续预览；MCP 截图和操作后画面另行请求新采集的原始分辨率 JPEG。设备控制器通过
Wi-Fi TCP 或 USB 串口连接电脑，并以 BLE 键盘鼠标连接手机。

```text
设备投屏 App → Wi-Fi 连续 MJPEG 预览 → 电脑最新帧缓存 → 设备操作台
设备投屏 App → 按需新采集原图 JPEG → 电脑 MCP 图片
电脑鼠标键盘 / MCP 输入 → Wi-Fi TCP（或 USB）→ 设备控制器 → BLE HID → 手机
```

运行时手机无需连接 USB，也不依赖 ADB；首次安装 APK 可以使用 ADB。
所有输入都经过硬件 HID，不需要无障碍服务、ADB 输入、剪贴板注入或模型 API Key。
参考 [esp32-iphone-agent](https://github.com/onehumanbeing/esp32-iphone-agent)，
并针对 ESP32-C3 改为 BLE HID。

## Windows EXE 启动

使用打包后的 `build/windows/设备操作台.exe`，电脑无需另装 Node.js、npm 或依赖。
双击会启动本机 MCP 服务并打开操作台。旁边的 `qdd-android.json` 保存本机连接设置；
首次没有配置时会显示设置页，之后可以通过操作台的 **连接设置** 修改。

1. 设备控制器连接同一 Wi-Fi，屏幕显示二维码及 IP。手机扫码下载、安装投屏 App，再通过连接页打开 App。
2. 按 App 和设备控制器引导连接手机蓝牙；已有配对会保留。在 App 点击 **开始投屏**，同意系统共享屏幕。
3. 电脑打开 EXE，在连接设置点 **自动查找**，确认目标控制板并保存。也可显式选择 USB 串口（本机 `COM5`）。
4. 点击实时画面操作手机，按 Esc 返回电脑。多块板子须选择目标；找不到时仍可手动填写 App 地址。

操作台显示实际内网地址，例如 `http://192.168.1.10:8790/`，同一局域网的手机和其他
电脑都可以打开。MCP 使用同一地址加 `/mcp`，例如 `http://192.168.1.10:8790/mcp`，
无需令牌。请将示例 IP 替换为操作台显示的地址。
需要 stdio 时先退出已占用控制板的 HTTP 服务，再使用绝对路径：

```json
{
  "mcpServers": {
    "deviceController": {
      "command": "F:\\aidol\\qdd_agent_harness_project\\apps\\android-mcp\\build\\windows\\设备操作台.exe",
      "args": ["--stdio"]
    }
  }
}
```

EXE 的 `--help` 显示命令行选项，`--self-test` 检查内嵌资源及串口模块。
关闭 EXE 的控制台窗口或按 Ctrl+C 会释放键鼠并停止服务。重新双击相同版本和配置会复用已有服务。
修改连接设置会在同一 EXE 内关闭旧连接并启动新服务；不会重放断开前的输入。
手机 IP 改变后请更新地址。ADB 仅用于安装、配置和诊断，运行时画面始终来自手机 Wi-Fi。

HTTP 默认监听 `0.0.0.0`，只接受本机回环及私有 IPv4 局域网来源、Host 和浏览器
Origin。HTTP CORS 与实时 WebSocket 使用同一边界，公网地址和来源会被拒绝。
`/health` 返回 `operatorUrl`、`mcpUrl` 和备选 `lanUrls`；展示地址优先选择实际
Wi-Fi、以太网接口，没有私网接口时回退到 `http://localhost:8790/`。
`0.0.0.0` 是监听地址，浏览器应打开实际内网地址。

## 源码开发与启动

1. 安装 Node.js 24+、npm 11+，在仓库根目录运行 `npm ci`。
2. [构建并安装设备投屏 APK](../android-screen/README.zh_CN.md)，让手机和电脑连接同一
   Wi-Fi 局域网，打开 **设备投屏**。
3. 烧录[设备控制器固件](../esp/docs/android-bridge.zh_CN.md)，在主界面用上下键选择设置，确认进入 Wi-Fi，
   用屏幕键盘输入密码。手机、电脑、板子连接同一内网；在手机蓝牙设置中选择设备控制器屏幕显示的名称。
4. 将 `apps/android-mcp/.env.example` 复制为 `.env`，填写实际配置：

| 配置 | 内容 |
| --- | --- |
| `ANDROID_SCREEN_URL` | 手机 App 显示的私网 IPv4 地址，例如 `http://192.168.1.20:8791`；请替换为实际地址 |
| `ANDROID_DEVICE_ID` | 可选，App 生成的准确 UUID，不是 ADB serial |
| `ESP_HOST` | 板上显示的内网 IP 或局域网主机名；填写后优先使用 Wi-Fi |
| `ESP_TCP_PORT` | 板子的 TCP 端口，默认 `3333` |
| `ESP_SETUP_URL` | 可选，自动发现填入的控制板连接页地址，如 `http://192.168.1.30:3334` |
| `ESP_PORT` | 可选 USB 串口，例如 `COM5`；`ESP_HOST` 留空时使用 |
| `ANDROID_MCP_PORT` | 局域网 HTTP 端口，默认 `8790`，监听 `0.0.0.0` |

5. 在手机上点击 **开始投屏**，确认系统屏幕共享授权。
   Wi-Fi 地址变化后更新 URL；访客网络的客户端隔离可能阻止局域网连接。
6. 在仓库根目录运行：

```powershell
.\start-android.cmd
# 只启动前台服务，不打开浏览器：
.\start-android.cmd --no-browser
```

Node 启动器读取 `.env`，缺少 `dist/` 时先构建；已有健康的本地服务则直接复用，
否则以前台方式启动。浏览器打开后自动连接本机服务，无需填写令牌。
Ctrl+C 关闭本次启动的服务。
启动器不会安装 App、烧录固件或发送手机输入。

操作台自动连接后，只需按页面提示：**点击画面操作，Esc退出**。
第一次点击画面只建立遥控，不会把这次点击发给手机；后续移动、点击、拖动、滚动
和输入才操作手机真实指针。遥控期间整页隐藏电脑光标，不另外画模拟指针。
当前一加/IAB 交互检查已通过，高帧率连续流畅度仍未验收，见下方记录。

人工鼠标发送相对 HID 移动，允许手机现有加速度，不再把网页绝对位置换算为手机
像素，也不需要标定、撞角归零或 AI 坐标路径的 100 ms 定位节拍。浏览器允许
PointerLock 时可无限相对移动；浏览器拒绝捕获时，在网页范围内继续相对输入。
移出手机画面不会退出遥控，按 Esc 才退出并恢复电脑光标。
页面没有开始、接管或暂停按钮。遥控时整页点击发给手机，不会同时误触网页工具栏；
Esc 退出后工具栏可直接使用，连接准备在内部完成。
坐标调整设置只用于 AI 点按/滑动，真实指针速度和加速度由手机决定。

“实时画面”标题旁可选择 **画质**；遥控期间整页点击仍发给手机，请先按 **Esc**
退出再切换。设置保存在手机 App 中，直接应用到现有预览流。

| 选项 | 档位 ID | 预览短边 | 色彩 | JPEG 质量 |
| --- | --- | --- | --- | --- |
| 极速（灰度） | `turbo` | 360 像素 | 灰度 | 45 |
| 快速 | `fast` | 540 像素 | 彩色 | 60 |
| 标准（默认） | `standard` | 720 像素 | 彩色 | 70 |
| 原画 | `original` | 手机物理尺寸 | 彩色 | 75 |

只有预览降采样，保持屏幕比例，小屏幕不会放大。MCP 截图和操作后返回的图片始终
从 `/frame.jpg` 请求新采集的原尺寸彩色 JPEG，质量为 75。例如 1080×2400 手机的
标准预览为 720×1600，MCP 坐标仍使用 1080×2400。流中的 `width`/`height` 是 JPEG
实际尺寸，`deviceWidth`/`deviceHeight` 是人工鼠标比例和 AI 坐标使用的物理尺寸。
切换画质不视为手机旋转，也不清除标定；画面尺寸提示显示实际 JPEG 尺寸，不把预览
标成原图。

操作台通过可内网访问的 `GET /screen/profile` 读取手机设置，通过
`POST /screen/profile` 提交 JSON 修改：

```powershell
Invoke-RestMethod http://192.168.1.10:8790/screen/profile
Invoke-RestMethod http://192.168.1.10:8790/screen/profile -Method Post `
  -ContentType "application/json" -Body '{"profile":"fast"}'
```

结果包含 `profile`，已知物理尺寸时另含 `deviceWidth`/`deviceHeight`。电脑将请求
转发给手机的 `GET`/`POST /preview/profile`。两个 POST 接口均要求仅包含一个
`profile` 字段，值为上表四个 ID，请求体最多 256 字节。画质请求无需 MCP 会话，
不会启用、暂停或抢占键鼠输入。快速连续选择只保留最新待应用档位；失败时重新
读取实际设置，并保留具体原因。旧手机 App 可继续投屏，切换画质则需要更新 APK，
操作台会明确提示升级。

画面不再每两秒请求一次截图：手机 `/stream.mjpg` 持续送帧，电脑只保留最新帧，
`/screen/stream` 以二进制 JPEG 连续送到操作台，省去 Base64 转码；
`/screen/events` 仅保留兼容。慢客户端跳过中间帧，浏览器也只留一个待解码帧。
连续投屏以固定 33 毫秒目标采集（约每秒 30 帧），JPEG 按所选预览画质编码；静止画面也不降帧。
采集与 JPEG 编码分开，旧待编码帧直接让给最新画面。这里描述的是目标，
实际实收帧率取决于手机和内网吞吐。
浏览器排队、传输和解码耗时都计入三秒时效限制。
相对移动在最多四条报告的传输窗口内累加，后续移动无需逐条等待 Wi-Fi 回执；
快速滑动超出累计范围时只合并并限制移动量，不再错误触发断连；
每轮的序号保留按下与松开的顺序。缺少序号、取消或确认失败时释放输入，不重放。
普通 AI 操作先等已有实时报送结束，再独占执行。这样可以提高吞吐，不保证降低延迟。
浏览器输入和每 250ms 的续约经独立 WebSocket 传送，不占用持续视频和 MCP 的 HTTP 连接池。
续约不等待鼠标报告 ACK，
超过 900ms 没有续约就松开并暂停，避免网页卡住后按键一直按着。
画面中断、页面隐藏、浏览器窗口失焦或捕获退出会停止遥控并松开输入；跨过画面
边缘或同页元素切换焦点不会退出。画面恢复不会自动重新进入遥控。
在设备控制器上用上下键选择 **紧急停止**（默认选中），按确认键执行。解除时选择
**取消急停** 并确认，电脑无法远程解除实体锁。设置同样使用上下纵向选择、确认键执行。

v8 固件在正常输入时检查连接、加密、绑定、订阅、心跳与实体锁。第一条有效
MOVE/KEY/CONSUMER 会先释放旧报告再激活，无需手动 ARM。v8 固件门禁、保留 NVS 的
烧录及无 ARM 真机检查已完成。MCP 兼容的 ARM/PAUSE 工具在内部保留，网页没有手动启停流程。

可信本地配对初始化：先停止 MCP，再运行 `node apps/android-mcp/tools/pair.mjs`；
加 `--status` 可读取板上当前显示的 PIN。工具打开两分钟配对窗口，不删除绑定，
也不解除物理停止锁。PIN 只供本机 USB 终端使用，不进入 MCP 工具或保存到日志。

## 连接 MCP 客户端

HTTP 客户端直接连接操作台显示的内网 MCP 地址，例如 `http://192.168.1.10:8790/mcp`，
无需认证请求头；运行服务的电脑也可使用 localhost。服务监听 `0.0.0.0`，
检查私网来源、Host 和 Origin，支持取消和 DELETE 终止会话。
持有当前输入的会话关闭时释放键鼠；只读观察会话或视频观看连接关闭，不会停止
另一个操作者。真实手机投屏源中断时仍会释放输入。

使用 stdio 前，先停止 HTTP 服务以释放 ESP 连接；也可保留 HTTP 并共用其 endpoint。
以下命令生成直接使用绝对 Node 路径的客户端配置：

```powershell
$nodePath = (Get-Command node -CommandType Application).Source
$entryPath = (Resolve-Path ./apps/android-mcp/dist/index.js).Path
@{ mcpServers = @{ deviceController = @{ command = $nodePath; args = @($entryPath, "--transport", "stdio") } } } |
  ConvertTo-Json -Depth 6
```

stdio 请直接调用 Node，避免 npm 启动横幅破坏协议。服务根据自身入口读取 `.env`，
不要求客户端工作目录位于仓库。支持 `--screen-url`、`--device`（App UUID）、
`--esp-host`、`--esp-tcp-port`、`--esp-port` 和 `--transport` 覆盖。客户端须支持 MCP 图片工具结果；仓库现有 CLI
的模型对话尚未自动接入这个独立服务的截图。

## 工具与坐标限制

| 工具 | 用途 |
| --- | --- |
| `android_control` | 推荐的观察—操作—再观察流程：执行一次动作后返回真实更新画面 |
| `android_devices`、`android_screenshot`、`android_hid_status` | 已配置手机、JPEG 图片、桥接就绪状态 |
| `android_hid_arm`、`android_hid_pause`、`android_release` | 显式启用、取消排队输入、释放按住的报告 |
| `android_mouse_move`、`android_mouse_click`、`android_scroll` | 相对计数、当前位置点击、滚轮 |
| `android_calibrate_pointer`、`android_pointer_home`、`android_tap`、`android_swipe` | 标定后估算坐标 |
| `android_type`、`android_key`、`android_key_report` | 美式布局 ASCII、组合键、原始键盘报告 |
| `android_consumer_report`、`android_home`、`android_back` | 原始消费控制用途码及主页/返回 |

目前有 20 个工具。先调用 `android_screenshot`，再用结果中的 `frameId` 调用
`android_control`。例如 `{ "action": "move", "frameId": "<最新frameId>", "dx": 80,
"dy": 0 }` 会移动真实鼠标，并返回动作完成后采集的新画面；后续沿用返回的新
`frameId`。输入准备在内部完成，move/click/scroll/key/type/home/back 无需指针
标定。`wait` 只延时观察，不启用输入。实体急停锁始终优先。

`android_control` 的 tap/swipe 仍需明确测量、设置标定；原有独立输入工具保留
`android_hid_arm` 和操作后单独截图的兼容流程。人工相对遥控及原始相对移动不需要
坐标标定。动作后的图片超时时，检查 `actionStarted`、`actionCompleted` 与
`observedAfterAction`；动作已经完成时，请用 `android_screenshot` 重新观察，不要盲目重做。
取消或操作后画面超时也会取消底层原图 HTTP 请求；已取消的排队截图会被跳过，
不会继续占用队列拖慢下一次观察。
图片包含原始宽高、物理 `deviceWidth`/`deviceHeight`、`previewProfile: "original"`、
SHA-256、采集时间和会话自己的 `frameId`；超过三秒的源画面会被拒绝。
每个会话各自保留最新截图，坐标操作要求不超过 30 秒；其他会话截图不会替换本会话的 `frameId`。
归零、点击和滑动在排队结束、实际发送前再次检查截图；过期或被本会话新图替换时停止并暂停输入。
全局共享手机身份、尺寸和旋转 epoch：任意变化都会使所有会话旧截图失效，停止
输入并清除标定，包括宽高不变的 180 度旋转。

比例含义是每个截图像素所需的 HID 计数，例如 200 计数移动 100 像素对应 scale 2。
坐标仍是估算值，支持像素与 `normalized1000`。指针速度或键鼠设置变化后需重新标定。
坐标操作归零后等待 550 ms，每条非零定位/拖动报告收到 ACK 后至少等待 100 ms，
最后一条定位报告也等待后再点击；这解决了本次测试手机上观察到的加速影响。
滑动 `durationMs` 是最短时间，返回的 `plannedDurationMs` 可能为保持节拍而延长，
不含归零和移动到起点的时间。一次坐标操作的归零、定位、拖动报告合计最多 300 条。
原始相对鼠标移动保留自身语义，不使用这套坐标节拍。

文字会先检查完整字符串，仅支持美式布局 ASCII、Tab 和换行；非 ASCII 会在发送
任何前缀前拒绝。请选择英文实体键盘布局；服务不注入 Unicode 或剪贴板文本。
主页/返回映射和鼠标拖动支持取决于手机及目标 App。投屏失败、取消或传输/报告
错误会停止输入并释放按住的报告；连接恢复就绪后，重新点击画面进入人工遥控，
MCP 客户端保留上方兼容调用流程。固件还会在 BLE 断开或
电脑心跳缺失超过 1500 ms 时停止输入。

## 验证边界

`src/*.test.ts` 覆盖协议、共享输入控制器、TCP/串口、预览解析与缓存、独立原图采集、官方 MCP
HTTP/stdio 客户端。`tests/operator.test.mjs` 在 VM 中执行实际浏览器脚本，检查
掉流与解码竞争、鼠标捕获、按键松开、画质切换竞争、物理坐标比例、旧服务识别；根目录 `npm run test:android`
同时运行这两组测试。

在根目录运行 `npm run typecheck`、`npm run build`、`npm run test:android`。
Windows x64 使用仓库固定的 Node 24.15.0 打包：

```powershell
npm run build:exe --workspace @qdd/android-mcp
npm run test:exe --workspace @qdd/android-mcp
node apps/android-mcp/tools/soak-exe.mjs
```

EXE 检查从中文/空格路径和空 PATH 启动，验证首次设置、重复启动、同进程重载、
HTTP/stdio 官方 MCP 连接及资源校验。持续压力使用本机假手机/假 ESP，不能代替真机验收。
测试使用 mock 设备，并通过官方 MCP 客户端验证 stdio 与本机 HTTP；JPEG 接收会校验
尺寸、分段长度、扫描段与完整结尾，保留 PNG 测试适配。当前真机结果与待验项目见下方验收记录。
保留的 `tools/preview.ps1` 仅供可选只读 USB/scrcpy
诊断，不提供产品截图，也不参与局域网运行链路。

已观察结果、产物哈希与剩余真机检查见[验收记录](docs/acceptance.zh_CN.md)。
