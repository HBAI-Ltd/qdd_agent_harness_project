# 原生 Android MCP 桥接

[English](README.md)

独立 Rust 子包，将 `apps/android-mcp` 的 Windows 设备操作台迁移为原生程序。
操作台、设置页和 22 个 MCP 工具定义均内置，迁移对应的源码哈希保存在
[TypeScript 基线](docs/typescript-baseline.json)。原 TypeScript 包继续保留用于对照。

交付文件是单个 Windows x64 EXE，用户无需安装 Node.js、Rust 工具链、浏览器引擎或
串口原生插件。界面使用系统浏览器；JPEG/PNG 目标预览通过同一个 EXE 启动受限子进程
处理。手机投屏和 ESP BLE HID 继续使用现有设备协议。

## 构建与验证

开发环境使用 Rust 1.87+、Windows MSVC 链接器，以及仓库的 Node 24/npm 11。
每次 Cargo 构建都会运行 `tools/prepare-assets.mjs`，使用锁定的 **esbuild 0.28.2**，
因此先安装 npm 依赖；Node 不在 PATH 时用 `QDD_NODE` 指定可执行路径。
保留可读 `assets/` 源码，JS/CSS（含设置页内联代码）由解析器压缩、JSON 去格式空白，
HTML 只去已知结构标签间的排版缩进，保留 DOM/属性、内联间距和 pre/textarea 内容。
生成文件只在 Cargo `OUT_DIR`；构建身份覆盖脚本、压缩器版本/参数和实际生成字节，
打包时重新生成核对，源码与 EXE 不一致则拒绝。最终 EXE 运行仍不需要 Node。
Cargo 依赖由 `Cargo.lock` 固定；Windows 构建静态链接 C 运行库，启用体积优化、LTO
和符号裁剪。

在仓库根目录运行：

```powershell
npm ci
npm run check:android:rust
npm run test:android:rust
npm run build:android:rust
npm run test:exe --workspace @qdd/android-mcp-rust
node apps/android-mcp-rust/tools/test-assets.mjs
node apps/android-mcp-rust/tools/test-generated-ui.mjs
```

根目录原有 `build`/`typecheck` 继续检查 TypeScript；上述独立命令检查 Rust 子包。
Cargo 包不需要加入 TypeScript 项目引用。

生成文件均在被 Git 忽略的 `build/` 中：

- `build/windows/设备操作台.exe`：独立交付文件。
- `build/windows/设备操作台.zip`：仅包含 EXE，不包含本机连接配置。
- `build/windows/manifest.json`：EXE/ZIP 字节数、SHA-256、构建身份与 Flash 容量比较。
- `build/windows/exe-smoke.json`：打包程序的离线夹具验证结果。

若旧 EXE 正在使用，设置绝对路径环境变量 `QDD_RUST_OUTPUT_DIR` 指向独立版本目录
（例如 `F:\aidol\qdd_agent_harness_project\apps\android-mcp-rust\build\windows\v43`），
再运行 `npm run size --workspace @qdd/android-mcp-rust` 与 `test:exe`，两者使用同一目录。
默认输出路径不变，无需停止用户正在运行的旧版本；更新 stdio MCP 配置时须切换到新版路径。

## 离线安装与兼容 USB 接收页

ESP、电脑和被控手机连接同一无线网，打开 ESP 根页面 `http://<设备IP>:3334/`，
即可直接下载电脑 ZIP 或手机 APK。三步页面支持手动上一步、下一步，无需互联网，
不要求保存本地 HTML。下述 USB 端点仅保留兼容，不出现在普通引导中。

`build/usb-browser/v55/设备USB接收.html` 是独立、内置 JS/CSS 的接收页，不需要先运行
原生下载器。ESP 保留 `/qdd-usb-receiver.html` 附件入口，旧 `/usb-receiver` 页面
现会跳转到内网下载首页。普通设备 IP HTTP 无串口权限；
保存后用桌面 Chrome/Edge 打开，点击选择控制板，接收完成且 SHA-256 核对通过后保存 ZIP。
之后解压并运行操作台。首次取得 HTML 需要网页连接或预先分发文件，已有 HTML 后可离线接收。

```powershell
node apps/android-mcp-rust/tools/prepare-usb-receiver.mjs
node apps/android-mcp-rust/tools/test-usb-receiver.mjs
```

从仓库根目录运行。源文件位于 `assets/usb-receiver/`，构建使用锁定的 esbuild，
产物清单记录源码和 HTML 哈希。页面只使用既有 `QDDDRV/1` 的 INFO/READ/CANCEL，
不发送控制输入、不改串口信号、不启动 EXE；进度、取消、掉线和错误均有反馈。
只读块重试受次数与总时限约束，CRC、偏移、会话和完整 SHA 不匹配时不保存不完整 ZIP。
浏览器/系统串口支持及真实板传输需单独验收，HTML 主机测试不能代替设备结果。

## 压缩传输包

单 EXE 的 `设备操作台.zip` 是压缩运行包，不含本地连接配置。另有开发用
`android-mcp-rust-source.zip`，按明确白名单保存源码、锁定的 Cargo 文件和必要公开测试夹具，
排除构建产物、缓存、依赖、日志、私密配置，并附编译说明与逐文件哈希清单。

使用 Python 3.8+ 审计已有版本并复现源码归档：

```powershell
python tools/pack-transfer.py --artifact-dir build/windows/v47
```

工具核对 ZIP 文件名/CRC，在空临时目录解压，验证 exact EXE 哈希并执行 `--self-test`，
不启动服务；旁边写 `transfer-compression-audit.json`，不改 EXE 或原 `manifest.json`。
源码条目固定时间戳并排序，相同输入与 Python/zlib 版本可生成相同 ZIP。

## 使用

双击 EXE 设置手机和 ESP 地址。`--no-browser` 仅在控制台运行服务。
配置继续使用相邻的 `qdd-android.json` 或 `%LOCALAPPDATA%/QDDAndroid/config.json`，
格式与 TypeScript 桌面版一致，未知配置字段不会保存。

```powershell
.\设备操作台.exe --configure
.\设备操作台.exe --no-browser --config .\qdd-android.json
.\设备操作台.exe --stdio --config .\qdd-android.json
.\设备操作台.exe --self-test
```

HTTP MCP 地址为 `http://<电脑内网IP>:8790/mcp`，操作台位于同一地址的 `/`。
服务校验连接来源、Host 和 Origin，只接受本机或私有局域网访问。输入不回退到 ADB，
物理急停只能在 ESP 设备上解除。

## 指针定位与校准

部分平板不会把系统鼠标光标绘进投屏画面。此时 `hover` 的回图不能证明真实落点，
`probe` 前后图相同会返回 `measurable:false` / `measurementAvailable:false`，保留两图、
暂停输入且不生成 `probeId`。不要凭空填写 `finish` 坐标或把驱动增益固定为 2。

推荐在新版手机投屏 App 内主动打开“指针校准”，保持校准页在前台，然后：

1. 调用 `android_screenshot` 取得本会话最新 `frameId`。
2. 调用 `android_pointer_calibration`，传入 `{"phase":"auto","frameId":"..."}`。
3. 确认结果 `measurementSource:"android-mouse-events"` 与 `calibrated:true`，再返回业务页观察。

`auto` 只读手机 `/pointer/calibration` 的真实鼠标事件坐标；先小移动显示实际位置，
静置 550 ms 后向屏幕中心探测默认 96 HID counts，再计算两轴 counts/pixel。
全程不点击、不启动页面；校准页自己把实际坐标标记绘进投屏画面。
失焦、旋转、过期或缺失事件、边缘裁切、外部鼠标移动都会停止测量并暂停输入，
不覆盖已有校准。加速度仍可能使之后的坐标存在误差，应先用 `android_preview_tap`
查看模拟目标及局部放大图；该预览不代表真实鼠标已移动到目标。

`android_preview_tap` 的完整图和 2 倍局部图都直接绘制 `PHONE PX: X=... Y=...`，
始终为原手机像素坐标。52px 底部标注与小图右侧留白不属于手机画面；
`annotation.original` / `annotation.zoom` 返回画布尺寸、`sourceRect` 与 `legend` 边界，
原内容从 (0,0) 开始，目标中心、`crop`、`zoomTarget` 和 `tapArguments` 不变。
标注不会遮住目标，也不会移动真实鼠标、发送点击或接管其他输入 owner。

点击/按下前自动保证距最近成功位移 ACK 至少 350 ms，已经过的时间会抵扣，
可以立即取消或暂停；不会重发位移或点击，也不需要 AI 额外睡眠。
`move` 的 dx/dy 是 HID counts，`tap` / `hover` / `swipe` 是原图像素。
`CONFIGURING`、`input is paused` 和 ACK 超时属于控制链路状态，不能记作目标应用测试失败。
Home/Back 的 ACK 也只表示 HID 报告已被控制板接受，OEM 导航是否发生必须另看新画面。

## 单次输入、重传与中文

ASCII 文字、单键、点击及 Home/Back 使用短按脉冲：按下真正写出后保持约 50ms 即发送
中立释放，**不等按下 ACK 才释放**，两个报告仍分别等待原 1200ms ACK。这避免网络延迟
把一次短按变成长按/系统连发。取消会提前释放；超时不重发按下，也不继续剩余字符。
原始 `key_report` / `mouse_move buttons` 仍可表达用户有意保持的输入。

同一 MCP 会话的 `tools/call` request ID 开始派发后不能复用，成功、失败、取消均保留
32B ID 摘要，重复请求拒绝且不再派发；不保存参数、图片或响应正文。每会话上限 4096 个
工具调用 ID，满后关闭并重建会话，不淘汰旧记录再放行重放。两个新 ID 的相同文字仍是
两次有意输入；该机制无法把任意新 ID 的重试自动识别为旧动作。结果不确定时先观察，不能盲重试。

包含非 ASCII 的文字走新版 ESP 的加密 BLE 文本通道和手机投屏 App 的 QDD 输入法。
用户须自行启用并选择该输入法，再聚焦可编辑输入框；缺少对应固件/IME 会明确拒绝，
不会把拼音当中文，也不回退到 ADB 或网络远程输入。整串须为合法 UTF-8、无 NUL，最多 512B。
`QDDTXT/1` 先查编辑 epoch，再按连续 offset 分块，COMMIT 只发送一次；其 queued ACK
不代表已输入，随后仅查询 STATUS，最多 10s 等待手机 accepted/rejected，原 PING 和安全截止不变。
断线、取消、超时或提交后焦点改变返回 `textTransfer.status:"uncertain"`，不自动再提交。
`accepted` 仅表示手机 InputConnection API 接受，还要检查新的真实画面与目标输入框内容。

## 测试与迁移范围

Rust 单元测试位于各 `src/*.rs` 模块中，`cargo test --locked` 检查解析、图片上限、
坐标节拍、ACK 顺序、取消、会话输入所有权和设备发现校验。测试使用回环地址夹具，
不会打开真实设备串口。

`tools/test-exe.mjs` 保留冻结 TypeScript EXE 的验收场景，仅调整 Node 专属的打包
断言、测试辅助模块导入，并补充不可见光标和校准页前置检查。它通过官方 JavaScript MCP SDK 连接假手机 HTTP 流和假 ESP
TCP 端点，包含空 PATH、中文及空格路径启动。通过这些检查不能证明真实 BLE、物理
指针精度或 ESP 多 MiB 文件下载的表现。

选择存储分区前请阅读[体积评估](docs/size-assessment.zh_CN.md)。本子包不会修改 ESP
固件或刷写设备。
