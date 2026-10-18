<p align="right"><strong>简体中文</strong> · <a href="README.md">English</a></p>

# QDD 安卓内网投屏 App

在手机上安装这个原生 App。用户确认安卓系统的录屏授权后，App 在同一 Wi-Fi
内网向电脑持续传输可选画质的 JPEG 预览。电脑的 `android-mcp` 服务另行请求新采集的原始分辨率 JPEG，返回给支持图片
结果的 MCP 客户端，让 AI 看到屏幕。键鼠输入继续使用独立的 ESP32 BLE HID 链路。

```text
安卓 MediaProjection → Wi-Fi 内网 MJPEG 预览 → 电脑操作台
安卓 MediaProjection → Wi-Fi 内网原图 JPEG → 电脑 MCP → AI 看到屏幕
ESP32 BLE 键盘鼠标 → 安卓输入
```

USB 只用于首次安装 APK 和调试，运行投屏不需要 ADB 转发或 scrcpy。App 不包含
无障碍服务、输入注入、麦克风采集、模型 API 或运行时依赖。

## Windows 构建

构建直接使用 JDK 17+、Android SDK Platform 34 和 Build Tools 36.0.0 中的
`aapt2`、`javac`、`d8`、`zipalign`、`apksigner`，无需下载 Gradle。Java 源码使用
安卓 boot classpath 编译为 Java 8 字节码。
已通过 Windows PowerShell 5.1 实际运行根目录 npm 构建命令；SHA-256 使用 .NET
计算，不依赖 `Get-FileHash` 命令。

在仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./apps/android-screen/tools/build.ps1 `
  -SdkRoot "C:/Android/Sdk" -JavaHome "C:/Java/jdk-17"
```

请将示例路径换为实际 SDK/JDK 目录。也支持有效的 `ANDROID_HOME` /
`ANDROID_SDK_ROOT` 和 `JAVA_HOME`。本机可建立已被 Git 忽略的
`apps/android-screen/.local/toolchain.json`：

```json
{"sdkRoot":"C:/Android/Sdk","javaHome":"C:/Java/jdk-17"}
```

之后从根目录执行 `npm run build:android:screen` 即可使用本机配置。显式脚本参数
优先。每次构建会刷新生成的类文件、验证 APK 签名，并将 SHA-256 写入
`build/manifest.json`。

产物为 `apps/android-screen/build/qdd-android-screen-debug.apk`。本机开发签名保存在
`.local/debug.keystore`；生成文件和签名密钥均被 Git 忽略。请保留该密钥，以便后续
覆盖安装同一应用。这是开发签名 APK，不是已发布的正式版本。

## 安装与连接

新版 ESP 的二维码指向它自己的内网连接页 `http://<控制板IP>:3334/`。
手机扫码下载 APK，安装后回到连接页点“打开投屏 App”；App 会记住目标控制板并显示蓝牙连接引导。
也支持自动发现同一 Wi-Fi 唯一控制板；多块板子时扫描目标二维码选择。
App 将自身 IP、UUID 与投屏状态登记给控制板，电脑 EXE 的“自动查找”据此填写连接信息。
控制板换 IP 后按已选择的蓝牙名称重新发现，不会随意切到其他设备。
上述登记不会授予 HID 输入权限，也不会自动跳过安卓屏幕共享授权。

蓝牙引导仅在控制板的 `connected`、`encrypted`、`bonded`、`ready` 都为真时显示就绪。
Just Works 配对无需手输数字，在手机蓝牙设置中确认设备即可。其 `authenticated` 可以仍为假：
加密和绑定不等于通过配对码验证的中间人攻击防护。

安装到安卓 8+ 手机；当前验收目标是安卓 13。已授权的 USB 开发设备可使用：

```powershell
adb -s YOUR_USB_SERIAL install -r ./apps/android-screen/build/qdd-android-screen-debug.apk
```

打开 **设备投屏**，让手机和电脑连接同一 Wi-Fi 内网，读取界面显示的
`http://<手机内网IP>:8791`。在电脑的 `apps/android-mcp/.env` 配置
`ANDROID_SCREEN_URL`，无需连接码、密码或应用令牌。运行时无需 USB。访客网络或
AP 客户端隔离可能阻止内网设备互访，请使用允许电脑与手机互相连接的网络。

点击 **开始投屏**，再确认安卓系统录屏对话框。首次可选择允许通知；拒绝通知也能继续
请求系统共享授权，不会反复弹通知请求。安卓 14+ 请求整个屏幕。通知开启时，可从持续
通知停止；也可随时回 App 点 **停止投屏**。通知权限与前台服务的关系见
[安卓官方说明](https://developer.android.com/develop/ui/views/notifications/notification-permission)。

停止立即撤销画面，待采集和编码线程释放旧资源后，才允许重新开始。再次开始必须重新取得
系统授权。旋转重建界面会保留正在等待的系统授权，服务启动等待则保留原来的三秒单调时钟
截止时间；启动失败不会因界面重建永久禁用按钮，也不会用旧计时器清掉后来一次授权。

App 在私有偏好存储中保存随机 UUID 设备身份、端口与预览画质，重启后设备身份保持稳定。
应用禁止备份。

USB 配置时，可通过 Activity extra 指定端口（1024..65535）：

```powershell
adb -s YOUR_USB_SERIAL shell am start -n cn.qdd.screenbridge/.MainActivity `
  --ei port 8791
```

这不会绕过系统授权或自动开始投屏。修改端口前请先停止投屏。默认端口为 8791，
配置后的端口会保留。

## 预览画质

电脑操作台“实时画面”标题旁可以选择 **画质**。正在遥控时，先按 **Esc** 退出，
再切换画质。设置立即应用到现有画面流并保存在手机上，不改变蓝牙配对或 AI 点击标定。

| 选项 | 档位 ID | 预览短边 | 色彩 | JPEG 质量 |
| --- | --- | --- | --- | --- |
| 极速（灰度） | `turbo` | 360 像素 | 灰度 | 45 |
| 快速 | `fast` | 540 像素 | 彩色 | 60 |
| 标准（默认） | `standard` | 720 像素 | 彩色 | 70 |
| 原画 | `original` | 手机物理尺寸 | 彩色 | 75 |

预览保持屏幕比例，小于目标尺寸的屏幕不会放大。降采样和灰度处理只影响预览；
`/frame.jpg`、MCP 截图和 MCP 操作后返回的画面始终使用新采集的原尺寸彩色 JPEG，
质量为 75。AI 坐标和人工相对鼠标比例始终以手机物理尺寸为准。例如 1080×2400
手机的标准预览为 720×1600，MCP 仍收到 1080×2400。切换画质不视为手机旋转，
不会清除标定。四档连续采集均保持 33 毫秒目标，不对静止画面降帧；实际帧率仍受
手机性能和内网吞吐影响。

## HTTP 接口

服务只绑定当前 Wi-Fi 的 RFC1918 私有 IPv4 地址，不监听全部网卡；只接受 RFC1918
IPv4 或回环来源。Wi-Fi 地址变化或丢失时会关闭旧监听和连接，自动绑定新地址并
更新界面。手机地址变化后，请更新电脑端 endpoint。

`GET /health` 返回服务状态、稳定 `deviceId`、`model`、`projecting`、当前 `rotation`
（0..3）、帧就绪状态，以及 `format: "jpeg"`、`mimeType: "image/jpeg"`。
还会返回 `streamPath: "/stream.mjpg"`、`streamClients` 和当前采集帧率上限 `maxFps`。
设备身份是 App 自行生成的 UUID，
不是硬件 serial 或 Android ID。

`GET /preview/profile` 读取已保存画质。`POST /preview/profile` 要求
`Content-Type: application/json`，请求体只能包含一个档位字段，最多 256 字节：

```json
{"profile":"standard"}
```

两者返回 `{"profile":"standard"}`，已知手机物理尺寸时另含 `deviceWidth` 和
`deviceHeight`。支持上表四个 ID。电脑通过仅接受私有局域网与本机来源的 `/screen/profile` 提供
同一设置入口。这些请求不发送键鼠输入，也不授予屏幕共享权限；其他手机接口不接受请求体。

`GET /frame.jpg` 无需认证，会请求在收到本次请求后新采集的原图，不复用缩小预览，成功返回 `image/jpeg`，
并包含以下响应头：

| 响应头 | 含义 |
| --- | --- |
| `X-Device-Id` | 与健康状态相同的稳定 UUID |
| `X-Frame-Id` | 当前帧的唯一 UUID |
| `X-Frame-Age-Ms` | 使用安卓单调时钟计算的帧年龄 |
| `X-Captured-At` | UTC ISO 采集时间 |
| `X-Frame-Width`、`X-Frame-Height` | JPEG 实际编码尺寸；`/frame.jpg` 为原始尺寸 |
| `X-Device-Width`、`X-Device-Height` | 坐标使用的手机物理尺寸 |
| `X-Preview-Profile` | `turbo`、`fast`、`standard` 或 `original`；`/frame.jpg` 始终为 `original` |
| `X-Display-Rotation` | 安卓屏幕方向，0..3 |

`GET /stream.mjpg` 建立一个持续的 HTTP 响应，类型为
`multipart/x-mixed-replace; boundary=qdd-frame`，无需认证。每个真实新帧在同一
连接上发送一次：

```text
--qdd-frame\r\n
Content-Type: image/jpeg\r\n
Content-Length: <JPEG 字节数>\r\n
X-Device-Id: <稳定 UUID>\r\n
X-Frame-Id: <当前帧 UUID>\r\n
X-Frame-Age-Ms: <发送时帧龄>\r\n
X-Captured-At: <原始采集 UTC 时间>\r\n
X-Frame-Width: <宽>\r\n
X-Frame-Height: <高>\r\n
X-Device-Width: <手机物理宽度>\r\n
X-Device-Height: <手机物理高度>\r\n
X-Preview-Profile: <turbo|fast|standard|original>\r\n
X-Display-Rotation: <0..3>\r\n
\r\n
<准确数量的 JPEG 字节>\r\n
```

整个响应没有总长度，通过关闭连接结束；客户端按每部分的 `Content-Length`
读取图片，不应在 JPEG 二进制里搜索边界文本。停止投屏会结束连接，重新授权后
需要重新连接。没有新画面时不会重复旧帧或刷新旧时间。`/frame.jpg` 用于新采集的
原尺寸 MCP 与诊断截图。

采集使用 `ImageReader` RGBA，去除行填充，按所选预览档位编码 JPEG。有人连接流时每
33 毫秒最多采集一帧（约每秒 30 帧），无流连接时最多五帧；这是采集上限，不代表
真机保证帧率。连续 RGBA 直接复制到 bitmap；有行填充时复用同一个行视图与像素
缓冲区，不再为每行创建视图。
`/frame.jpg` 请求按需编码原尺寸 JPEG，不编码 PNG。连续投屏时静止画面也按 33 毫秒目标刷新，
不再降到 500 毫秒一帧。两个固定 ImageReader 轮换 surface，继续使用同一个
VirtualDisplay；一次仅等待一个真实新图像，防止反复换 surface 使合成饥饿。
JPEG 编码使用独立线程和两个固定 bitmap，最多保留一个待编码的最新图像，
旧待编码图像被替换，不排长队。像素与 JPEG 输出缓冲区复用，发布帧拥有独立编码字节；
producer 缓冲区在 JPEG 编码前释放。方向或授权变化会拒绝旧 worker 发布。
没有连续流时使用较低的单次截图采集预算。实际更新时间仍受系统调度、
合成、编码和内网吞吐影响。只有实际取得新图像才生成新帧 ID
和采集时间；HTTP 请求不会更新旧图像的时间戳。物理采集与 MCP 图像保留原始尺寸，
预览档位只调整预览编码输出。停止、无法取得新原图或画面超过三秒时，`/frame.jpg` 返回 **503**。未知路径
（包括旧 `/frame.png`）返回 404，不支持的方法返回 405。所有响应禁用缓存。

HTTP 请求头最多 8 KiB / 34 项。短请求使用两条工作线程、四个排队连接，读写总时限
为三秒。画面流使用另外两条线程，最多两路观看连接，总 socket 上限为六个。
流中每次写入最多两秒，慢客户端会被断开；每个观看端都不积压帧，写完后直接取
最新帧。客户端断开、停止投屏、服务关闭或 Wi-Fi 变化时会清理流连接。
只有 `/preview/profile` 接受 JSON 请求体；接口不包含远程输入命令。

投屏期间持有 Wi-Fi 性能锁：安卓 13 及以前请求 high-performance，安卓 14+
请求 low-latency；停止、启动失败及销毁时释放。仅新增普通 `WAKE_LOCK` 权限，
不会修改系统 Wi-Fi 开关或永久省电设置。`wifiLockRequestedMode` 与 `wifiLockHeld`
只表示请求模式和 API 持有状态，不证明设备实际提速。

运行 `npm test --workspace @qdd/android-screen` 执行 host Java/socket 回归。
测试直接编译实际 HTTP 服务和帧存储，以 `tools/tests` 中仅供 host 使用的安卓
时钟与 JSON 替身补全依赖，使用真实 localhost socket 和 JPEG 测试图，不访问
手机、ADB 或 BLE。覆盖持续收帧、帧龄、只取最新帧、连接上限、慢客户端清理、
停止、方向元数据和关闭服务；生命周期与授权回归还覆盖资源回收期间禁止重开、旧回调隔离、
通知拒绝、界面重建和服务启动等待恢复。另有三项像素回归覆盖连续缓冲区复用、行填充和错误
布局拒绝。真机流式帧率与资源使用仍需安装新版本后验证。

## 无系统光标的指针校准

开始投屏后，在 App 内点 **打开指针校准页**。专用全屏页只接收真实鼠标事件，绘制实际坐标亮圈，
由正常 MediaProjection 投屏显示；不增加无障碍、注入或悬浮窗权限。电脑 MCP 可用
`android_pointer_calibration` 的 `phase: "auto"` 自动测量，完成后用系统返回退出。

`GET /pointer/calibration` 是只读私网接口，返回 `active`、`deviceId`、`sessionId`、物理
`width/height`、`rotation` 与 `point: {x,y,sequence,ageMs}`。坐标来自 Android 鼠标事件的
`getRawX/getRawY`，保留小数；没有有效事件时 `point` 为 null。页面失焦或后台后 `active=false`、
会话和坐标均无效，重新进入生成新会话。HTTP 不提供打开页面或发送鼠标事件的方法。
系统光标不入镜时不能通过相同图像推导增益；预点击目标标记也不证明真实指针位置。

## 可选设备中文输入法

电脑通过新版 ESP 固件把原始 UTF-8 文字分片发送到已配对的加密 BLE 通道，APK 的可选输入法
向当前文本框调用 `InputConnection.commitText`。不使用拼音替代、剪贴板、ADB 或网络文字输入。
一次最多 512 个 UTF-8 字节，支持中文、emoji 和 ASCII 混合；不支持 NUL。目标 App 仍可能
限制字符或长度，蓝牙 ACK 只证明编辑 API 接受，实际显示应通过投屏确认。

首次使用需要本人在 App 的 **设备中文输入** 卡片依次完成：

1. 允许 Android 12+ 的“附近设备”连接权限，手动选择已经在系统蓝牙配对的 QDD 控制器。
2. 打开系统输入法设置，启用 **设备中文输入**。
3. 在系统选择器选中它，再回到目标 App 聚焦文本框。

App 只枚举已绑定设备，不扫描附近设备、不请求定位；不会静默启用或选择输入法。输入法窗口
被物理键盘隐藏时仍可工作，只在当前输入连接与加密 GATT 订阅均有效时报告就绪。
输入法服务由 `BIND_INPUT_METHOD` 保护，HTTP 没有文字提交、启动输入法或修改选择的接口。
切换文本框、停用输入法或断链会清除未提交的正文；正文不写入偏好、日志或文件。

GATT 服务 UUID 为 `9bded201-39ba-4a19-8ff7-25c9d00a0001`，控制器 indication 为 `...0002`，
手机加密写入为 `...0003`。协议版本字节为 1，其余整数均为 little-endian：

| 方向/类型 | 正文 |
| --- | --- |
| ESP→手机 `01 BEGIN` | id u64、编辑 epoch u32、UTF-8 长度 u16 |
| ESP→手机 `02 DATA` | id u64、偏移 u16、字节 |
| ESP→手机 `03 COMMIT` | id u64、编辑 epoch u32 |
| ESP→手机 `04 CANCEL` | id u64 |
| 手机→ESP `81 READY` / `83 NOT_READY` | 编辑 epoch u32 |
| 手机→ESP `82 ACK` | id u64、状态 u8、编辑 epoch u32 |

ACK 0 表示 `commitText` 返回 true，1 表示拒绝，2 表示异常导致结果不确定。每个编辑 epoch 中
非零 id 按无符号 u64 递增；重复片必须与已收字节完全一致，重复 COMMIT 只返回缓存结果，不再提交。
确认丢失时可能已经输入，电脑不得自动重放。状态/确认写入串行执行，正文仅通过 ESP BLE 抵达。
新旧 HID 和 GATT 服务共存、已绑定设备的 Service Changed/OEM 缓存行为与真实中文提交尚需真机验收。

## 验证边界

四档画质行为已纳入 host 回归；实际帧率仍需针对 `build/manifest.json` 标识的已安装
APK 验收。下方真机测量属于历史版本，不证明当前四档预览的实际性能。

构建脚本会编译全部 Java 和资源，验证 APK 签名与包权限，不会安装、启动或替手机
授权。优化版 APK SHA-256 为
`d55e935bb6a36b108fe8e67a768c00c723f1073d394f9ab1135984ceb9e540d5`，
已通过构建与签名验证、10 项 host socket 和三项像素回归。2026-10-17 核对
`build/manifest.json` 与实际 APK 哈希后，已覆盖安装至一加 8，用户已重新确认投屏
授权。安装与授权完成不能当作已经测得的持续帧率。此前 APK SHA-256 为
`0a4a6f78aa1a0dfe3ee3dcc2ba6d2469251aa42ea89f5e4ab30fe72633318d1b`
已在真机一加 8（IN2010）覆盖安装，并由用户确认安卓系统投屏授权。真实测试在
25 秒内通过同一个 `/stream.mjpg` 连接收到 58 帧原始 1080×2400 JPEG，包含
58 个不同源帧 ID、32 个不同图像哈希，错误数为零。收到画面的最大帧龄为
617 毫秒；最密集的一秒收到 12 帧，这是实测峰值，不代表持续帧率保证。详见
[当前连续流真机记录](../android-mcp/build/device-tests/oneplus-stream-v5.json)。

同一测试还测量了 30 次读取电脑端已收到画面缓存的耗时，最大 0.0301 毫秒。
这个数字仅指本机缓存方法执行时间，不包含屏幕采集、网络传输、完整 MCP 调用，
也不是端到端投屏延迟。

历史单图验收对应旧 APK SHA-256
`94458e41878fdaac309e6103ab0080504aa1e46a48e557e947a38f790539da89`：
桌面壁纸静置 16 秒后，无令牌内网 `/frame.jpg` 通过 **30/30** 次请求，图像约
193 KiB；截图耗时中位数 240 毫秒、最大 589 毫秒，最终帧龄中位数 703 毫秒、
最大 1260 毫秒。这些是旧版本的单图测试数据，不是当前版本的连续流测量值。
详见[历史单图真机记录](../android-mcp/build/device-tests/oneplus-wallpaper-jpeg-v4.json)。

旋转（包括 180 度）、手动停止投屏及停止后重新确认系统授权、Wi-Fi 断开和地址
变化仍未完成真机验收。安卓受保护窗口可能显示为黑色。
