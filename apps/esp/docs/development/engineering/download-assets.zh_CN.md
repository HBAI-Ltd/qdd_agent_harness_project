<p align="right"><strong>简体中文</strong> · <a href="download-assets.md">English</a></p>

# 驱动下载资源

控制器根页面 `http://<设备IP>:3334/` 改为三步手动引导：连接同一无线网
→ 下载安装包 → 安装并打开。全程无需互联网，ESP、电脑和被控手机都连接该无线网。
上一步/下一步不会自动下载、配对或标记安装成功。Windows 默认原生单次请求下载
`/qdd-desktop.zip`；Android 默认下载 `/qdd-remote.apk`，两个平台入口始终可选。
用户在浏览器下载列表确认文件后进入安装说明。电脑 ZIP 只含一个 Windows x64 EXE，
先全部解压，再打开程序。

默认流程通过内网页面直接下载，不再要求保存本地 HTML 或选择 USB 串口。
旧 USB 附件端点仅保留兼容，不出现在普通引导和设置入口。兼容 USB 页分为准备、接收、保存三步，
校验详情折叠。普通 HTTP 不能使用 Web Serial：先保存单文件 HTML，使用电脑
Chrome/Edge 本地打开；点击选择设备才开始接收。接收时禁止翻页，取消后关闭串口，
完整 SHA-256 核验通过后才允许保存。

已有 `assets` 分区的设备继续只使用该资源；分区数据损坏时明确报错。
没有 `assets` 的板（例如当前 COM5 factory 布局）使用固件 Flash 内置 ZIP 回退。
`tools/prepare_desktop_zip.py` 核对 v50 清单、ZIP 内容及解压 EXE 身份。
该回退增加 943,153 字节 Flash，共用原 2 KiB 读写/校验缓存，不改分区、不将整包
放进 RAM。最终应用仍须满足目标设备实际应用分区容量。

## 浏览器 USB 接收页构建

在仓库根目录安装锁定的 npm 依赖后运行：

```powershell
node apps/android-mcp-rust/tools/prepare-usb-receiver.mjs
node apps/android-mcp-rust/tools/test-usb-receiver.mjs
```

产物为 `apps/android-mcp-rust/build/usb-browser/v55/设备USB接收.html` 与 `manifest.json`。
页面内置全部 JS/CSS，由锁定的 esbuild 压缩，不加载 CDN、外部字体或网络脚本。
`tools/prepare_usb_receiver.py` 校验源码和产物身份、UTF-8、大小及外部依赖限制，
生成确定性 gzip Flash 字节；HTTP 不解压、不把整份页面复制进 RAM。
`/qdd-usb-receiver.html` 以附件保存兼容接收页。旧 `/usb-receiver` 网页固定 HTTP 307
跳转同源根页面 `/`，请求参数无法改变跳转目标。
HTTP 页面禁用连接并解释保存步骤；本地页面仍检查安全上下文、Web Serial 和 WebCrypto。
串口选择必须由用户点击触发，页面只接受 VID 303A/PID 1001，不设置 DTR/RTS。
重试仅针对只读文件块，逐块核对 CRC、会话与偏移，整包 SHA 匹配后才显示保存按钮。
取消、掉线和失败均结束读取并关闭端口，不提供 HID、重启或刷写动作。

首次获取 HTML 仍需要现有网页连接或预先分发的文件；这不是 U 盘，也不代表
普通 HTTP 网页获得串口权限。浏览器支持和真实 USB 传输需要单独实机验证。

## 兼容的原生 USB 下载器构建

旧 `/qdd-usb-installer.exe` 下载入口保留兼容，已不是 Windows 首页的首选入口。

编译固件前，在仓库根目录使用 Node 24 和已安装的 MinGW-w64 x64 编译器构建小工具：

```powershell
$env:QDD_USB_CC = 'C:/path/to/x86_64-w64-mingw32-gcc.exe'
node apps/android-mcp-rust/tools/usb-driver/build.mjs
```

产物为 `apps/android-mcp-rust/build/usb-driver/v52/设备USB下载器.exe` 及构建清单。
`tools/prepare_usb_installer.py` 校验精确 PE x64 镜像、128 KiB 上限、十三个源码身份
及 EXE 哈希后，生成确定的 gzip 正文和固件头文件。源码漂移或小工具缺失会阻断
固件构建，不嵌入旧二进制。HTTP 直接发送 Flash 字节，提供 `Content-Encoding: gzip`、
EXE 附件文件名及解码后 EXE 哈希，ESP 不解压。这与 `assets` 中的原始 ZIP 独立。

小工具只列出 VID 303A / PID 1001 的 COM 设备，多板时必须明确选择；关闭 DTR/RTS，
独占串口。先创建新的临时文件，核对完整 ZIP 哈希后以不覆盖方式改名；取消、超时
和无效数据会移除未完成文件并关闭串口。源码及主机测试仅描述预期行为，真实吞吐、
串口驱动行为和板端内存仍需独立实物检查。

仓库默认的最小分区表保持不变。可选的 `assets` data 分区优先于内置 Windows ZIP；
没有该分区时使用固件已校验的内置 ZIP。选中资源格式错误或损坏时返回 HTTP 503，不影响内置 APK 下载。
成功下载 Windows 包不会推进手机 APK 安装里程碑。

## 资源镜像

`tools/pack_download_assets.py` 生成独立资源镜像，不访问设备、不刷写、不合并固件。
镜像由 64 字节小端序头、填充至 4096 字节的 `0xff`、原始 EXE 或 ZIP 顺序组成。
`QDDDRV1` 保持原始 EXE 兼容；`QDDDRV2` 明确存放 ZIP，旧固件会拒绝。
不得把 ZIP 字节放在 v1 头下伪装为 EXE。

| 字节偏移 | 大小 | 内容 |
| ---: | ---: | --- |
| 0 | 8 | `QDDDRV1` 或 `QDDDRV2` 后跟 NUL |
| 8 | 4 | 格式版本，EXE 为 1，ZIP 为 2 |
| 12 | 4 | 正文偏移，4096 |
| 16 | 4 | 实际正文长度，v2 为压缩 ZIP 字节数 |
| 20 | 4 | 类型：v1 EXE 为 0，v2 ZIP 为 1 |
| 24 | 32 | 实际正文的 SHA-256 |
| 56 | 8 | 保留，零 |

在 `apps/esp` 下，使用独立读取且 MD5 校验通过的目标分区表，以及最终 Rust 构建
清单执行：

```powershell
$driverZip = (Resolve-Path -LiteralPath '../android-mcp-rust/build/windows/v47/设备操作台.zip').Path
python tools/pack_download_assets.py create --zip $driverZip --exe-manifest ../android-mcp-rust/build/windows/v47/manifest.json --partition-table build/target-partition-table.bin --output build/driver-assets.bin
python tools/pack_download_assets.py verify --exe-manifest ../android-mcp-rust/build/windows/v47/manifest.json --partition-table build/target-partition-table.bin --output build/driver-assets.bin
```

`create --exe <path>` 仍可生成 v1，`--exe` 与 `--zip` 互斥；`verify` 自动识别
已保存镜像的格式。ZIP 必须只有一个 UTF-8 名称的 `设备操作台.exe` 条目，ZIP 长度与
哈希匹配清单，CRC 正确，解压后的 EXE 长度、哈希和 PE x64 身份精确匹配。
主机解压受 16 MiB 上限和声明 EXE 长度限制，拒绝额外/带路径条目、加密、非普通文件
模式及不支持的压缩格式。

工具检查分区表完整性、名称唯一性、对齐、重叠和容量，PE x64 身份，构建清单的精确
长度与哈希，资源头、正文哈希和按扇区取整的擦除范围。`driver-assets.json` 保存
精确镜像身份、构建 ID、分别记录的 EXE/实际正文身份、目标偏移、容量和擦除终点。
实际正文过大时直接失败，不调整
分区。写入资源是独立、需要授权的设备操作，必须使用实际目标分区表和已校验的
精确镜像，不得从零地址写入或作为合并固件刷写。

## 运行方式与验证边界

单个低优先级工作任务先用 2 KiB 读缓存校验完整正文，再发送成功响应。之后按
固定小块读取发送，响应包含精确 `Content-Length`、附件文件名和 SHA-256 头。
校验和发送共用同一块缓存，不会把完整正文读入 RAM，也不进行整份虚拟内存映射。
ZIP 按原始压缩字节发送，ESP 不解压，也不使用 HTTP content encoding。
ZIP 响应使用 `application/zip`、`.zip` 附件名、压缩字节长度和
`X-QDD-ZIP-SHA256`。v1 原始资源仍通过 `/qdd-desktop.exe` 使用原 EXE MIME、
附件名及 `X-QDD-EXE-SHA256`；若旧 URL 遇到 ZIP 资源，校验后以 307 跳转 ZIP
URL，不发送错误标记的文件。仅有 v1 资源时访问 ZIP URL 返回 503，并指出旧 EXE URL。

下载任务持有 HTTPD 异步请求，慢速 Windows 下载不会占住普通状态、手机和电脑注册任务。
并发 Windows 下载返回 503，前一项完成后可重试。Wi-Fi 网络周期变化会取消下载，
等待异步请求完成后才停止其 HTTPD 实例。读写失败会关闭不完整会话，每个异步请求
恰好完成一次。

`GET /api/download-status` 单独提供不超过 256 字节的诊断快照，不扩大普通状态或
发现包。记录 `busy`、`phase`、开始/校验后/最小/结束堆、最小最大连续块、成功发送
的正文字节数、结果和 socket errno；响应头不计入正文进度。阶段 1–5 分别表示
开始、校验结束、发送、完成异步请求、结束。结束堆在异步请求完成后、工作任务自删前
采样，任务栈释放需要之后独立采样确认。这些证据用于定位内存压力，固定缓存节省
并不证明或修复其他未定位的泄漏。

完整静态门禁包含 `test_qdd_download_assets.c`、生产引导 HTTP 处理器与生命周期
测试，以及 `test_pack_download_assets.py`。覆盖格式、范围、哈希拒绝，部分发送，
资源不可用，平台链接，并发忙碌与任务失败，下载等待期间的注册，以及换网取消。
实物下载哈希和浏览器行为仍是独立设备检查，构建和主机测试成功不代表设备验收通过。
压缩减少传输字节，但不证明原有网络超时或截断已修复；无线参数、原发送截止、
ACK/看门狗时限均保持不变。

## 有界 ZIP 范围请求与浏览器下载

完整校验资源后，ZIP 响应提供双引号包围完整 ZIP SHA-256 的强 `ETag`，以及
`Accept-Ranges: bytes`。单段、明确的 `Range: bytes=start-end` 返回 206、精确分段
`Content-Length` 和 `Content-Range: bytes start-end/size`；SHA 头始终标识完整 ZIP。
两个端点必须是无符号十进制整数，且 `start <= end < size`。suffix、open、多段、
溢出、格式错误或过长字段返回 416 和 `Content-Range: bytes */size`。

仅不带 `If-Match` 的 `bytes=0-0` 可用于初始化元数据，返回的一个字节由浏览器丢弃。
其他范围请求必须提供精确匹配完整文件 ETag 的 `If-Match`，缺失、弱标记或不匹配
返回 412，不输出文件字节。初始化或完整 ZIP 请求若提供 `If-Match`，也必须匹配。
每次请求均重新校验完整资源哈希，不缓存；分段复用原工作任务、缓存和清理路径。
不带 Range 的直链仍为完整 200 下载，旧 EXE 跳转保持不变。

外部模块 `/driver-download.js` 只在用户点击标有 `data-driver-resume` 的专用备用入口后
开始工作，普通 ZIP 与 APK 链接保持浏览器原生行为。默认 ZIP 下载使用原有完整
200 响应，不进行元数据初始化或应用分段。用户显式启用的备用方式串行请求
8 KiB 分段，仅在次数和总时长上限内重试当前文件分段，提供进度、取消和
重新下载控件。每次核对范围、长度、ETag 和完整文件 SHA 身份，最终计算 ZIP SHA
通过后才生成保存文件；失败或不完整分段不会追加，绝不重试设备控制输入。
实际浏览器/网络恢复以及最终 ZIP CRC/EXE 身份仍需设备验收。

`tools/prepare_driver_script.py` 在 CMake 配置阶段用已激活的 IDF Python 生成固定
mtime 的 gzip 模块。原始 UTF-8 脚本限制为 32 KiB，记录压缩长度/哈希并作为 Flash
字节嵌入。HTTP 使用 JavaScript MIME 和 `Content-Encoding: gzip`，由浏览器解压，
ESP 不解压也不整份复制到 RAM。页面仅允许同源外部脚本和连接。
主机检查包含 `test_driver_download.mjs` 和 `test_prepare_driver_script.py`。

## 失败分配调用点观测

中立、仅 USB 可用的 `QDDNET/1 <id> OOM_TRACE` 返回本次开机首个被包装分配失败的数字记录，
JSON 不超过 128 字节。PC 是代码返回地址，不是堆地址或栈转储；真机证据仅写入 ignored 构建目录。
kind 1/2/3 分别代表 malloc/calloc/heap_caps_malloc；公开 API 不带 caps 参数时该字段为零。
count 统计三个包装入口的非零请求返回 NULL 次数，不等同 SDK hook 次数。
noinline IRAM 包装只调用一次原分配器，保留参数、结果和 errno，仅在 NULL 后记录。
零字节返回 NULL 不计失败；calloc 乘积溢出时请求大小用饱和值表示。

GNU ld 包装未定义符号引用，包括 Wi-Fi adapter 表里的函数指针。
同一对象内部调用、其他分配 API 和不透明 ROM 路径不构成完整观测面。
SDK 首 OOM callback 在原分配器内部先发生，包装在返回后才观察，因此两者首条和计数可能不同。
仅使用确实已烧入版本的匹配 ELF 解析返回 PC，必要时同时解析前一指令。
调用位置本身不证明泄漏、分配寿命或完整调用栈。
本观测不改变分配行为、资源门禁、无线参数、ACK/看门狗或原 HTTP 截止。

## 离线内网安装与兼容 USB 协议

按键指南之后，设备提供六页手动引导：无线网、电脑下载、手机安装、蓝牙配对、投屏和
实际连接状态。电脑连接同一无线网，打开 `http://<设备IP>:3334/` 直接下载 ZIP；
手机二维码打开同一首页，优先显示 APK。上一步、下一步不代表安装成功，不自动扫描或
开启配对；相应页面按确认才执行该操作。连接状态变化不会抢走用户当前页面。
设置依次提供驱动下载、连接无线网、手机蓝牙配对、按键指南和重置设备，旧 USB 页不再可选。

以下协议仅保留对已保存 USB 接收器的兼容。

UI 只读取加锁的固定大小工作线程快照：等待、校验、传输、已发送、取消或错误。
进度只累计完整发送 READ 回复形成的连续前缀，重复范围不重复计数，单读尾部不会伪装完成。
“已发送”只代表 ESP 发出全部字节，不代表电脑已保存、校验、解压或安装，绝不自动推进引导。
完整发送后的正常 CANCEL 保留已发送状态，部分传输取消则显示取消。
该快照不改变控制权、配对、协议回复或安全时限。

`QDDDRV/1` 通过应用固件的 USB 串口读取已校验 ZIP 资源，不进入 bootloader、不写 Flash、
不擦 NVS、不授权 HID，也不传输画面或业务输入。TCP 请求返回 `USB_ONLY`。
设备 armed 或已有任何 USB/TCP 控制 owner 时拒绝会话，包括中立 PING 占用的 owner。
INFO 被接收后立即保留只读会话，下一条输入尚未处理时就阻止新控制会话建立。
保留期间，新 PING/ARM、文本修改和网络配置写入返回 `CONTROL_BUSY`；中立查询、PAUSE、
RELEASE 仍可安全执行。HTTP Windows 下载与 USB 会话共享非阻塞资源占用，避免大传输任务并行。

命令和回复均为 LF 结尾的 ASCII 行。请求 id 为正十进制 uint32；session 为非零、恰好
16 位小写十六进制，SHA-256 和 CRC 同样使用小写十六进制。完整语法：

```text
QDDDRV/1 <id> INFO
QDDDRV/1 <id> INFO <session> <ZIP-size> <ZIP-sha256> ZIP
QDDDRV/1 <id> READ <session> <offset> <length>
QDDDRV/1 <id> DATA <session> <offset> <length> <CRC32> <hex-bytes>
QDDDRV/1 <id> CANCEL <session>
QDDDRV/1 <id> OK
QDDDRV/1 <id> ERR <code>
```

INFO 一次性完整校验已存 ZIP 的 SHA，再将新会话绑定本次开机与资源。READ 使用显式 offset，
length 为 1..1024，减法检查资源范围，不维护隐式游标；同一 offset 重读返回相同字节。
CRC32 是原始字节的标准 IEEE/zlib CRC32（初始值零），输出八位 hex；DATA 正文必须恰好是
length 的两倍 hex 字符。接收器最终必须验证完整 ZIP SHA，通过后才允许保存文件。
ZIP CRC 和内含 EXE 身份由资源打包器与设备下载验收另外核对；浏览器接收页不解析或执行 EXE。
该 ZIP 协议不提供旧 v1 原始 EXE 资源。

成功 INFO/READ 后空闲严格超过 60 秒、时钟回退、确认 USB 掉线、出现控制 owner、I/O 失败
或 CANCEL 均释放会话。INFO 会替换旧空闲会话。错误包括 `BAD_COMMAND`、`USB_ONLY`、
`CONTROL_BUSY`、`BUSY`、`STALE_SESSION`、`BAD_RANGE`、`ASSET_ERROR`、`IO_ERROR`。
错误 offset/session 不改变仍有效的当前会话；I/O/哈希失败释放资源，客户端不能拼入其他
身份资源。匹配当前 session 的 CANCEL 可中断进行中的 READ；INFO 尚未返回未知 session 时，
通过物理断开 USB、传输失败或空闲过期结束。仅关闭 Windows COM 句柄不能证明 USB 外设已掉线。

哈希和读取共用一块静态 2 KiB staging，另有固定 2304 字节 ASCII 帧，绝不整 ZIP 复制到 RAM。
独立 4 KiB 栈工作线程是启动后唯一 USB writer，也串行处理主循环的两槽普通回复队列。
由于原 USB TX ring 为 1024 字节，DATA 每次原生写入不超过 256 字节，总发送尝试限制为
2 秒；普通控制回复保留原生 10 ms 发送预算，失败时通过原子通知让安全循环释放 USB owner。
主安全循环不等待 Flash 读取、哈希或 USB 写入；原 1200 ms ACK、1500 ms 看门狗和 HTTP 截止不变。

主机覆盖严格解析、CRC、帧容量、下一条输入前占用、重复 offset、错误/溢出范围、唯一 writer
顺序、取消、读取/发送失败、TTL/时钟回退/掉线清理及主循环 USB-only/控制门禁。
这些检查不证明实物 USB 吞吐或完整文件可靠传输；仍需匹配确切固件的实物完整 ZIP SHA
与会话清理验收。
