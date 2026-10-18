<p align="right"><strong>简体中文</strong> · <a href="acceptance.md">English</a></p>

# 安卓内网投屏与控制验收

## 用户真机反馈与当前边界

2026-10-17：用户明确反馈真机下载正常，并要求停止下载排查和推测性修改。
本记录以该实际使用反馈为准。此前电脑 curl、Node 及经 ADB 启动的手机 curl 探测出现超时或截断，
仅说明这些特定探测未通过，不能等同于用户浏览器/App 下载功能故障；原始日志仍保留供追溯。
该停止要求针对此前的推测性排查。此后用户新报更换控制器后的局域网问题，
本轮仅按新问题范围进行有界传输验证：v26 新板 APK 下载及哈希通过，没有修改 APK 源码，
也不把下载通过当作手机已安装。

## v55 内网直接安装与免输配对码

2026-10-18：ESP、电脑和被控手机连接同一无线网。用户的 OPPO 热点仅为测试网络，
不写成产品 UI 的指定步骤。普通安装流程改回打开 ESP 根 HTML 页面直接下载安装包，
无需保存本地接收 HTML 或选择 USB 串口。

- UI：网页三步手动操作（无线网、下载、安装打开），原生 Windows ZIP / Android APK
  链接，上一步/下一步，不自动下载、不虚报安装完成。旧 `/usb-receiver` 固定 307
  跳到同源 `/`，请求参数不能指定目标。ESP 六页手动引导不会被连接事件抢跳；设置依次为
  驱动下载、连接无线网、手机蓝牙、按键指南、重置。旧 USB 端点/协议保留兼容，普通
  导航中不再出现。按用户最终布局，底部为三条独立竖排选项：上一步、当前页操作、
  下一步；突出中间操作，实体按键语义不变。
- 存储：当前 COM5 没有 `assets` 分区。v54 热点基线复现根页/APK 200、ZIP 503；
  新版无该分区时使用应用内置、已校验的 v50 ZIP（943,153 B）。已有分区损坏仍明确失败。
  SHA 和读取共用 2 KiB 缓存，不重新分区、不把整包放入 RAM。
- 蓝牙：显式配对窗口使用 Just Works，无需数字 PIN，仍要求加密、绑定和实际 16 字节
  链路密钥。保留旧绑定，`authenticated` 仍如实表示 MITM；设备全名放入 30 B 主广播。
  Android 接受 encrypted/bonded/ready 且 authenticated=false 的连接。保留控制权、
  急停与输入时限。新 APK **66,090 B**，SHA
  `9ed39d723773852bd070b034aa29bb6b794b07244c58aaa9c2a5d1bd7ac5683a`。
- 对抗审查：修复双份页码状态竞态，退出引导等主界面完成刷新后再提交，快速双确认保持
  中性。实际 HID/中文自定义通知也检查密钥长度，不仅依赖 GATT 权限；生产函数回归
  拒绝 7/15 字节、接受 16 字节。删除“被控手机自己开热点”的默认说明，不声称 APK
  已支持热点提供端接口。
- Host 证据：根 TypeScript typecheck/build、Android 主机/构建/签名，BLE 9/9、
  文本集成 4/4、HTTP C mocks、JS 20/20、接收页 18/18、内置 ZIP 准备器 4/4、资源格式
  11/11 均通过。Edge 153 在 1040/390 宽度验证原生单次 GET、手动上下步、无 JS 可读、
  旧路径跳转，使用隔离夹具，不等同于真机：
  `apps/esp/build/ui-browser-v55/landing-lan-report.json`。
- Build/device：最终固件完整门禁与 COM5 app-only 验证进行中，产物身份和实际传输结果待补。
- 未验收：新手机首次免码配对、实体按键/显示、真实投屏输入反馈及长期无线稳定性仍需
  独立验证。本轮不将此前高频 LAN 失败或模拟性能改记为完整成品通过。

## v54 局域网取页面、USB 收安装包——WiFi 优先引导

2026-10-18：按用户最新要求，按键指南之后先连接 WiFi，再进入电脑 USB 安装步骤。
电脑与 ESP 在同一局域网，通过已有 `3334` 端口获取单文件 HTML，再在本地 Chrome/Edge
打开，通过 USB 接收板载 ZIP；整个流程不依赖互联网。普通设备 IP HTTP 只能展示页面和
提供附件，不能直接使用 Web Serial，未添加不安全来源例外或改变浏览器安全设置。

- 页面与源码：`/usb-receiver` 内联展示，`/qdd-usb-receiver.html` 下载相同 HTML。
  最终接收页 `apps/android-mcp-rust/build/usb-browser/v54/设备USB接收.html` 为 **16,674 B**，
  SHA `de88e84316ea479d2cc6149bd7532ba3bdcc31746ab812b071939404dc8bed3c`；
  确定性 gzip **7,452 B**，SHA `26fae9381627760dfb41127070a5a864a5183b55af860bc67811e5a13b1f41e4`。
  已核对五项源码身份。JS/CSS 全内联、无 CDN；旧原生下载器入口兼容保留，首页改推浏览器接收页。
- Host：接收器 **16/16 PASS**。CRC 与 SHA guard 移除均触发真实红测；独立审查复现
  “取得 reader 后获取 writer 失败，关闭时 reader 锁残留”，红测后修复并通过。
  只读重试受次数与总时间限制，校验 session/offset/CRC/整包 SHA，取消或失败不保存残缺 ZIP，
  关闭时释放流锁与端口；不会发送 HID、改变串口信号或启动 EXE。
  ESP HTTP 生产处理器 mock、接收页准备器和兼容 helper 准备器通过。
- UI/浏览器 Host：WiFi 优先模型实红 exit 3 后转绿，17 项编译后按键契约通过；
  字库覆盖 238 个非 ASCII 字形，3 项检查通过。8 个实际 LVGL 渲染入口通过，
  100 次状态不变刷新零重绘，24 KiB 主机内存池峰值 17,064 B；长 IP/端口/路径分两行完整显示。
  最终 `de88...` 在 Edge 153 的 1040/390 宽度无横向溢出，file 环境可用原生 Web Serial；
  文档 IP 的 HTTP 夹具不可访问串口，保存入口正确显示，未发实际网络或串口请求。
  证据：`ui-wifi-first-v54/ui-wifi-first-v54-report.json`，接收页目录的 `browser-final-host.json`。
- Browser/Device 专项：真实 Edge 153 在本地 HTML 中使用原生 `navigator.serial`，无 shim/fixture。
  本轮 Computer Use 无法确认浏览器 URL，停止了自动选择串口；随后请求实际获准并完成传输。
  测试页面是文案更新前的 `b8b9df13...`，目标是保留 v53 固件的 COM6。完整收到并保存
  **943,153 B** ZIP，SHA `100f4ce0924f1310e878aaa62c9887745ddc14d7fb0283617f5e08a6ca4d7494`；
  ZIP CRC、单条目与内含 EXE **1,924,096 B** / SHA `12a80feda10d24043afdb2c8bcbef9644bba3b04b731fe605258a44ed3dc17f6`
  全部匹配，未执行 EXE。页面显示 **180.6 KB/s**；150,509ms 包含等待串口授权，不能当传输时长。
  无页面错误、外部 HTTP 请求；测试浏览器已关闭。最终 `de88...` 只改两处流程/提示文字，
  不把旧页面实测伪记为新页面完整物理流程。证据：`apps/esp/build/browser-usb-v54-device.json`、
  `browser-usb-v54-zip-verify.json`；旧 gzip 身份固定在 `build/history/usb-browser-v54/b8b9df.../`。
  `html-copy-delta.json` 记录净增 33 B 的两处文案变化；CSS 字节不变，JS 统一提示字符串后
  经相同解析器规范化字节相同，协议和关闭逻辑未改变。
- Build：完整 `tools/idf.ps1 --validate` **PASS**，session 63265 exit 0，
  `browser-usb-v54-full-gate.log`；主机门禁含现有平台 skips **4+5+12**，没有声称零跳过。
  根 TypeScript typecheck/build 通过。归档独立 verify 通过；full SHA / 目录名为
  `d873ac803143742aa21289335f06784feab27eadac0626d0369d8dc63d0c9d98`，APP **1,731,040 B**，
  SHA `509efd668e7294a36cc69ac52656668532260755439daf366ac614d171ff3a20`，匹配 ELF
  `8bbe7f4695c1b21e6bcab3093fef0b81162da0c0497ebb43df4e03937787cda4`。
- Flash Device：**PASS**。重新读取 COM6，确认 MAC `4c:11:ae:31:32:6c` / ESP32-C3 / 8MB，
  实际表 SHA `bd386c960f8b827e812dd238af37d469c319d7e9ecc2d7501d00296c46804a4f` 与 MD5 有效，
  只写 OTA0 `0x20000`；擦除范围 `[0x20000, 0x1c7000)`，session 87454 exit 0、
  `Hash of data verified`。没有写入 NVS、bootloader、分区表、otadata、PHY、assets 或 OTA1。
  证据为 `com6-v54-{layout-read.log,partition-table.bin,flash-plan.json,flash.log}`。
- COM5 刷写交接：用户明确要求刷入 COM5，新鲜枚举为 VID/PID `303A:1001`、MAC
  `4c:11:ae:2f:a1:b8`、ESP32-C3 rev1.1 / 8MB Flash。实际分区表与 COM6 不同：SHA
  `b4a705f5dcd64100c5c40e0de65b2a2acae70a2827ae56044317575331f4620d`，MD5 有效，
  NVS `0x9000/0x6000`、PHY `0xf000/0x1000`、唯一 factory 应用 `0x10000/0x7f0000`，
  **没有 assets 分区**。同一份独立核验的 v54 应用只写 `0x10000`，擦除范围
  `[0x10000,0x1b7000)`，session 69526 exit 0，`Hash of data verified`。
  未写 bootloader、分区表、NVS、PHY，未重新分区或使用 merged 镜像。30.032 秒只读观察
  **9/9 回复**，未观察到 fault 或分配失败，串口正常关闭。原有蓝牙绑定恢复为
  `QDD-Passport-A1BA`，三次样本均 encrypted/bonded/ready，armed/locked 均 false。
  WiFi 仍为已配置但未连接、IP 为空，未测试网页。启动/协议专项通过，WiFi、UI 与完整流程待核验。
  因缺少 assets 分区，该板无法通过 USB 提供板载 Windows ZIP；本次应用刷写未授权或执行
  存储布局迁移。未修改 APK、EXE 或源码。证据：
  `com5-v54-{layout-read.log,partition-table.bin,flash-plan.json,flash.log,startup.json}`。
- 初次固件 Device 状态：30 秒只读观察 **9/9 回复**，无 fault/OOM，串口已关闭。
  但设备报告 **WiFi configured=false / connected=false**，BLE 未连接/未就绪，因此启动观察的
  整体 `pass=false`；当时 `192.168.101.75:3334` HTTP 请求未通过。
  `com6-v53-startup.json` 在 06:01 UTC 曾确认已配置、BLE ready，但本次写入前未采配置对照，
  不能从 app-only 写入范围推断配置仍在，也不能把未配置原因归咎为固件回归或用户重置。
  未做猜测性存储/配对修复，已请用户按新引导连接 WiFi。新固件另一次中立 INFO/CANCEL
  187ms/47ms 通过，板载 ZIP **943,153 B / 100f4ce0...7494** 仍一致；会话与串口正常关闭。
  证据：`com6-v54-startup.json`、`browser-usb-v54-http.initial-unconfigured.json`、`browser-usb-v54-info.json`。
- 配网后 Device 复验：用户反馈已完成 WiFi 配置后，**06:42:37 UTC** 单次只读 `WIFI_STATUS`
  在 47ms 返回 configured/connected 均为 true，IP `192.168.101.75`，控制端口 3333；
  COM6 已关闭，未复位或发送控制输入。电脑是 `192.168.100.160/23`，Windows 选择 WLAN
  直连路由，两者属于同一网段。随后诊断为 RSSI -61dBm、信道 11、网络 up，无断连或
  beacon 丢失事件，内存分配失败为零。但接收页 HTTP 请求仍触发 10 秒截止；TCP3334
  超时，单次 TCP3333 握手在 359ms 成功，单次 UDP3335 发现及两次 ICMP 也超时。
  目前不能唯一定位为 HTTP、ESP、电脑或 AP 原因，未猜测修改固件/网络参数或重刷。
  **WiFi 连接通过，真实 HTTP 页面端口验收仍失败**；首次未配置是历史结果，不再描述当前 WiFi 状态。
  证据：`com6-v54-wifi-connected.json`、`com6-v54-connected-diag.json`、
  `com6-v54-connected-tcp.json`、`com6-v54-connected-udp.json`、
  `browser-usb-v54-http.connected-timeout.json` / `browser-usb-v54-http.json`。
  随后在已核对的 WLAN 网卡进行了 8 秒、非混杂模式的 Npcap 包头观察：客户端发出三次 SYN，
  3,084ms 才观察到服务端 SYN/ACK，请求报文重复发送，首个服务端载荷到 6,541ms 才出现，
  已超过该探针的 5 秒绝对截止。因此 HTTP 端口有响应，但探针未在截止前收到状态/正文，
  不能据此认定监听未启动或 HTML 处理器有缺陷。未保存包载荷或 pcap，抓包句柄和请求 socket
  均正常关闭。证据：`capture-v54-http-headers.json`、`capture-v54-http-headers-summary.json`。
  用户随后确认同一 WiFi 的手机也打不开页面，故实际失败不只限于电脑探针。为读取先前观察到的
  延迟 HTTP 状态，又做了一次诊断请求：8,563ms 建立连接，12 秒内仍未收到响应头。
  `com6-v54-late-http-status.json` 保留失败结果；旧错误文案写了五秒，实际诊断预算以
  `timeoutSeconds=12`、`durationMs=12000` 为准。产品 ACK/看门狗/HTTP 截止没有修改。
  已停止相同条件下的重复请求，射频/AP 链路与 ESP 运行态仍未定位。现有本地单文件 HTML
  仍可独立用于 USB 接收，但这不能替代失败的设备网页获取步骤。
- Unverified：最终板上按键、WiFi 配置、保存页面、授权串口、安装程序的整条用户流程仍需实物核验。
  不证明 U 盘挂载、自动安装、所有浏览器/系统兼容、真实投屏/HID 全闭环或旧高频 LAN 时延问题通过。
  现有主操作台 PID 111040 / v47 路径与 health 200 已核对，未退出/替换服务。
  未修改 APK 或板载 v50 ZIP，未请求重置、清除网络或配对；不提交、不发布。

## v53 USB 优先的设备引导与设置——Build/Host/USB Device PASS，实物 UI 待核验

2026-10-18：设备引导现将**电脑 USB 安装放在 WiFi 设置之前**。首次引导与设置 USB 页
统一展示四步：接 USB 数据线、运行已有的**设备USB下载器**、保存并解压 ZIP、启动设备操作台。
离线页说明安装准备不需要 WiFi；如果尚无小下载器，也明确其获取前提，不暗示插线即出现 U 盘、
自动运行或自动安装。只有用户选择**“已安装，下一步”**才进入 WiFi，扫描仍需显式确认；
传输状态不会自行推进引导或授权 HID。

- 展示 / snapshot：worker 提供加锁的 **16B** 只读快照，表示 idle/checking/transferring/
  sent/cancelled/error 与有界字节进度，不新增 task/分配。SENT 仅指 ESP 已发送帧，
  不等于电脑已保存/校验/安装；UI 明示**“传输完成不等于已安装”**，让用户在电脑确认保存和解压。
  CONTROL_BUSY 明示**“退出电脑控制后重试”**，避免把进入设置/暂停等同于释放旧 owner。
  设置顺序为**电脑 USB / 手机 App / WiFi / 手机蓝牙 / 按键指南 / 重置**，固定返回入口，
  上下箭头表示分页；USB 返回只改变页面。手机 App 页保留根配置/下载 QR 入口及重入/IP/离线行为。
- 专项 Host：**PASS**。旧模型对新增离线 USB 首步断言实红，修改后绿；worker snapshot
  状态转移有 **红 exit 3 → 绿 exit 0**。setup model、快照/清理/安全契约及 HID 状态不变检查通过。
  证据：`apps/esp/build/ui-v53-model-{red,green}.log`、`usb-driver-ui-v53-focused.json`、
  `setup-usb-v53-focused.json`。USB 协议与 **1200ms ACK / 1500ms 安全看门狗**保持。
- 字体：**PASS**，旧字库真实**红 exit 1 → 3/3 绿**。使用已有缓存的 **lv_font_conv 1.5.3**
  完全离线生成 Source Han Sans SC **14/20px、4bpp、无压缩**子集，
  **219 → 230** 个非 ASCII 字形，两种字号均加 **95** 个可打印 ASCII；字表、授权源元数据、
  生成哈希与实际控件选用字体一致。证据：`apps/esp/build/usb-ui-v53-font-{red,generate,green}.log`
  和 `usb-ui-v53-font-host-report.json`。
- 独立 LVGL Host / 视觉：**PASS**，完整套件加 **7** 个专项入口
  （`usb/intro/menu/download/guide/pair/scan`）通过。首版 USB 页的 **100 次不变刷新**缓存
  断言实际失败，修正生产缓存后恢复 **0 flush / 分配稳定**，原红测日志/EXE 保留；
  既有 **120** 次页面替换仍通过。**24KiB 主机 pool**峰值 **17,192B**，不等于设备 RAM 峰值。
  已查看实际 240×320 主机渲染：中文无缺字方框/截断，离线四步、真实 SENT/error 提示、
  菜单双向箭头和末页返回清楚。证据：`apps/esp/build/ui-v53-fonts/render-*/render.log`、
  `usb-ui-v53-host-cache-red.log`、`ui-v53-fonts/usb-ui-v53-contact.png` 及上述独立报告。
- Build：**PASS**，完整门禁 **72872 exit 0**，日志 `apps/esp/build/ui-usb-v53-full-gate.log`，
  保留既存 **21** 个平台 skips（**4+5+12**）；固件布局/产物/调试归档核验通过。
  归档/full SHA-256 `16addce3d6e7cad10b58c160e0470f6257f3df35c169b87d11157fc27283247e`，
  App **1,720,192B**，SHA-256 `ced5667867c641bbd83be3f9ec13a3aa980b2a3a894c2ed2929543b853494e39`，
  匹配 ELF `973c89538f3f978c399c82344ada35cefc0792cf35886e07fc8ac56648ab0ebc`。
- Flash：**PASS**，烧录 **60770 exit 0**。新鲜 COM6 / MAC **4c:11:ae:31:32:6c** 及表 SHA-256
  `bd386c960f8b827e812dd238af37d469c319d7e9ecc2d7501d00296c46804a4f` 与 app-only 计划一致，
  `apps/esp/build/com6-v53-flash-plan.json`：**@0x20000**、擦除 **[0x20000,0x1c4000)**，
  保留 bootloader/分区表/otadata/NVS/配对/PHY/assets/OTA1。exact **1,720,192B** App
  **6.9 秒**写入、`Hash of data verified`，日志 `apps/esp/build/com6-v53-flash.log`。
- 启动 Device：**PASS**，观察 **64400 exit 0**，`apps/esp/build/com6-v53-startup.json`：
  **30 秒 / 9** 个只读样本，**1.063 秒**已观察到 WiFi/IP **192.168.101.75** 连接，
  **15.063 / 25.063 秒** BLE encrypted/bonded/ready；无 fault/errors、SDK/wrapped OOM
  或 trace 失败，COM6 已关闭。时间相对观察开始，非精确 boot 时长。
- 原生 USB Device：**PASS**，`apps/esp/build/usb-driver-v53-native-device.json`，实际运行未改的
  v52 helper，**exit 0 / 922 次 READ / 5,641ms**（含 wrapper **5,734ms**），保存完整
  **943,153B** ZIP，SHA-256 `100f4ce0924f1310e878aaa62c9887745ddc14d7fb0283617f5e08a6ca4d7494`。
  严格 CRC/raw-DEFLATE/PE 验证内含 EXE **1,924,096B**、SHA-256
  `12a80feda10d24043afdb2c8bcbef9644bba3b04b731fe605258a44ed3dc17f6`；无残留 partial，
  未启动主服务/发送 HID/使用 ADB。
- USB 协议 / 中性 Device：**PASS**，**17574 exit 0**，
  `apps/esp/build/usb-driver-v53-device-acceptance.{json,log}`。stale session 与两项 bad range 拒绝，
  **1,024B** 首块 / **1B** 尾块 CRC、两次 fresh INFO、CANCEL 及旧会话拒绝通过。
  独立 **25.016 秒**中性压力 **552/552 ACK**、max **32ms**，原 **1200ms** 时限保持；
  配置 **20ms / 最多 4**，但实际最多 **1** 未确认、约 **22.1 req/s**，**不称持续 50Hz 通过**。
  PAUSE ACK、等待 **2 秒**后 owner 到期；前后 BLE encrypted/bonded/ready、unarmed/unlocked，
  OOM/trace 均零。无非零 HID、画面、ADB 或凭据采集。
- 其余 Device / 部署边界：**尚未观察物理 LCD 逐页画面与实体按键导航**，
  Host 渲染不能算实物 UI 验收。当前板端部署为 **v53 App + 保留的 v50 assets**；最终只读 health
  **200 / status:ok**、未知 route **404**，动态核对 PID **111040** 与
  `apps/android-mcp-rust/build/windows/v47/设备操作台.exe` 一致，未停止/启动主服务。
  本轮未改 PC EXE、APK、assets payload
  或 USB helper，ZIP 保持 v50、helper 保持 v52。保留原 v52 USB 实测与源码包，
  与新的 v53 启动/USB/协议实测分别记录。LAN 小下载器获取、完整成品/实物输入/UI、中文 APK/IME
  仍有未验证/未通过项。没有提交/push/发布。

## v52 离线 USB 安装包下载器——Build/Host/USB Device PASS，LAN 获取入口未通过

2026-10-18：用户要求完全离线、优先 USB 直传。新增独立小型原生 Windows 下载器，
只枚举精确 **USB VID303A/PID1001** COM 设备，多板必须明确选择；支持保存对话框及
`--port COM6 --output <new.zip>`。通过 **QDDDRV/1** 读取现有 assets ZIP，严格核对
request ID/session/offset/length/CRC32 和最终 Windows BCrypt SHA-256，完整后原子保存新文件，
不覆盖已有输出。不会解压/启动主 EXE、退出服务、发送手机输入、使用 ADB 或擦除 Flash。
实现中禁用 DTR/RTS，实际运行未请求 reset，但这不是精确证明打开端口永不重启。
已有本地 helper 的用户可完全离线经 USB 下载安装包，不依赖 WiFi、Node、Python 或 ADB。

- Helper Build / Host：**PASS**。`apps/android-mcp-rust/build/usb-driver/v52/manifest.json`
  绑定 **13** 个源码输入、编译器/参数和 PE 审计。`设备USB下载器.exe` **17,920B**，SHA-256
  `66e0013d6791c464ebeee5f8901eb24379e0ced8e7b03766c508cfd54af6aebf`。
  生产 parser 敌对帧检查、**24** 项传输/恢复场景、**26** 项精确硬件 ID 检查通过。
  实际原生空 PATH 自测覆盖 BCrypt 分配/双 cleanup、原子保存/禁止覆盖；仅导入
  **7 个 Windows 系统 DLL**。Node 与 x64 MinGW-w64 GCC（`QDD_USB_CC` 或 PATH）只用于构建，
  不成为运行时依赖。日志：`build/usb-driver/v52/{build,test-protocol,test-transfer,test-hardware}.log`。
- Node 生成 gzip **9,243B**，SHA-256
  `d098c0df5bad9d07583dd35b523734b9b3fa35499f439d73b8ac2a80f62e25be`；
  ESP Python 预生成 gzip **8,958B**，SHA-256
  `bcfb0e5f3e96eb87f177acc69874d4e35a9350b6241c726d46aa7cc3822a9fb8`。
  两者压缩流不同，均解码为同一 exact helper EXE，不能混用 compressed hash。
  证据：`apps/esp/build/usb-installer-v52-identity.json`。
- 只读传输边界：READ 最多 **1,024B**，同一未确认 offset 最多三次新 ID 尝试，
  单请求四秒/总三分钟。STALE/IO 仅允许一次重新 INFO，ZIP 类型/大小/SHA 逐项相同才续读，
  取消或版本改变即终止。旧回复/日志/非法帧不追加字节；独占 CREATE_NEW 临时文件在失败/取消时
  清理，释放 COM/BCrypt 句柄。这些准备通道的数据重读不重放 HID。
- ESP 专项 Host：生产 worker/parser/main 安全契约、串行 TX、TTL、HTTP/USB 资源互斥
  及中性诊断通过。late-CANCEL 对旧生产代码有 **红测 exit 3**，原子终态交接后绿测通过，
  独立复核无新增确定阻断。慢 hash/read/TX 在 worker 执行，不阻塞安全主循环。
  新增固定 buffers 合计 **5,376B** 加 **4,096B** worker stack，只是分配预算，非实测峰值。
  Windows 页推荐 helper、`/qdd-usb-installer.exe` 生产 handler 红/绿，以及
  **4** 项 prepare/audit（含源码漂移和 PE x64 边界）通过；repo 扫描 **455** 个文本文件通过。
  证据：`apps/esp/build/usb-driver-v52-*`、
  `usb-installer-v52-{onboarding-red,onboarding-green,prepare-green,repo}.log`。
  首次完整固件门禁 **40894** exit **1**，`usb-driver-v52-full-gate-red.log` 保留字体测试
  因 Windows 默认 GBK 触发的 `UnicodeDecodeError`。显式 UTF-8 读取修正测试假设后，
  字体专项 **3/3 PASS**，`usb-driver-v52-fonts-green.log`；完整重跑 **47290** exit **0**，
  日志 `usb-driver-v52-full-gate.log`，保留既存平台 skips，固件布局/调试归档核验通过。
  归档/full SHA-256 `313f9af0aad80397c507b5a48a1fea694a74e52c142231bf3ed37a7a69ceb8eb`，
  App **1,713,808B**，SHA-256 `65aa5a24c85c0c18233683b60ff5f0348f485e378a98061d022b255df6e06b42`，
  匹配 ELF `c9469c75c4099d0d42a55647749f55b3eb66130fcde722cd98c49632bd915989`。
- Flash：限定 exact app-only 范围 **PASS**。已核对新鲜 COM6 / MAC **4c:11:ae:31:32:6c**
  及表 SHA-256 `bd386c960f8b827e812dd238af37d469c319d7e9ecc2d7501d00296c46804a4f`，
  只写 exact App **@0x20000**，擦除 **[0x20000,0x1c3000)**，`Hash of data verified`。
  bootloader/分区表/otadata/NVS/配对/PHY/assets/OTA1 保留。证据：
  `apps/esp/build/com6-v52-{layout-read.log,flash-plan.json,flash.log}`。
  刷写身份核验与下述有界启动/USB 实测分别记录。
- 源码归档：**PASS**，`apps/android-mcp-rust/build/windows/v52-source/android-mcp-rust-source.zip`，
  **273,323B**，SHA-256 `68cdd7ba53e66bf6fa484b7d880a62962eb224ab346b138e9127092809e0823d`。
  **70** 个白名单源码/公开夹具加 README/manifest 共 **72** 条目，含 helper C/H/tests/构建说明。
  条目哈希、确定性 ZIP、v50 生成构建身份和 helper 源码身份核验通过，不含 build 二进制、
  私密配置或日志；原 v50 EXE/运行 ZIP/源码 ZIP/manifest 保留。
  审计：`v52-source/transfer-compression-audit.json`。
- 启动 Device：**PASS**，限定 **30.000 秒 / 9** 个白名单采样的观察，证据
  `apps/esp/build/com6-v52-startup.json`。**15.078 / 25.062 秒** BLE 已 encrypted/bonded/ready，
  **29.078 秒**最终 WiFi 观察恢复 **192.168.101.75**。无 fault、SDK/wrapped OOM 或分配 trace
  失败，COM6 已关闭；时间相对观察开始，非精确 boot 时长，也不证明长期连续稳定。
- 原生 USB 整包 Device：**PASS**，`apps/esp/build/usb-driver-v52-native-device.{json,log}`。
  实际冻结原生 helper exit **0**，**922 次 READ / 5,875ms**（含 wrapper **5,969ms**）
  保存完整 **943,153B** ZIP，SHA-256
  `100f4ce0924f1310e878aaa62c9887745ddc14d7fb0283617f5e08a6ca4d7494`，**无 partial 文件**。
  严格 ZIP CRC/raw-DEFLATE/PE 验证通过，内含 EXE **1,924,096B**、SHA-256
  `12a80feda10d24043afdb2c8bcbef9644bba3b04b731fe605258a44ed3dc17f6`。
  helper 未启动主服务、未发 HID/使用 ADB、未请求 reset。
- USB 协议 / 中性 Device：**PASS**，`apps/esp/build/usb-driver-v52-device-acceptance.{json,log}`。
  stale session 与两项 bad range 拒绝；**1,024B** 及末尾 **1B** CRC 通过；CANCEL ACK、
  旧会话拒绝及两次 fresh INFO 重读同一核验前缀通过。中性压力 **25 秒**，配置
  **20ms / 最多 4 未确认 / 原 1200ms ACK**，**543/543** 回复、max **32ms**；
  实际 **21.72 req/s**、实测最多 **1** 未确认，**不能称持续 50Hz 已通过**。
  PAUSE、等待 **2 秒** owner 到期、之后 INFO/CANCEL 通过；前后 BLE encrypted/bonded/ready、
  unarmed/unlocked、无 OOM/trace 失败。后续独占 COM6 验收成功，确认原生 helper 已释放端口。
  未测试非零 HID 或真实画面反馈闭环。
- HTTP/浏览器获取 helper：**未通过**，`apps/esp/build/usb-installer-v52-http-device.json`。
  IAB 新 tab 为 `ERR_CONNECTION_RESET`；直接 GET `/` 得到完整 **200 / 4,128B** HTML，
  Windows USB 主入口存在，但 `/qdd-usb-installer.exe` 宣告 **200 / 8,958B gzip**，
  仅收到 **5,371B** 即 EOF（`EOFError`），不是完整下载。USB 成功不等于浏览器/LAN 获取入口
  成功，也不据此唯一定位无线物理路径。
- 保留历史 / 部署：较早开发者 bootloader 只读资源实验仍为独立 **FAIL**：
  `apps/esp/build/driver-usb-v50-read.{json,log}` 请求 **947,249B**，在 **245,760B**
  报 corrupt（**期望 4096 / 收到 4045**）、exit **2**，之后 chip-ID/hard-reset 恢复。
  该实验不是生产 helper 协议，也不是普通用户传输。
  `usb-v52-baseline.json` 观察 **30.015 秒**，BLE secure/ready、无 OOM/fault、COM6 已关闭，
  但 **WiFi connected=false / pass=false**，不能写整体 PASS。
  较早 v51 完整门禁 **87906** 最终 exit **0**，归档
  `b3c27300235427e067849b34580234875695a8e586f09c3e4d3644ad9ba1f8cd`、App **1,698,960B**；
  用户改选 USB 后未刷入。当前板为 v52 App + 保留的 v50 assets，8790 仍是用户手动启动的 v47
  （health PID **111040** 与动态核对的程序路径
  `apps/android-mcp-rust/build/windows/v47/设备操作台.exe` 一致、health OK），未替换主服务。
  USB 安装包传输和中性门禁现已在上述范围通过，浏览器小 helper 获取仍未完成。
  既有 LAN 整包失败、中文 APK/IME、实物输入/UI 边界保持，
  **仍不能当完整成品验收**。没有提交/push/发布。

## v51 默认原生 ZIP 下载——专项 Host PASS，固件/Device 待核验

2026-10-18：用户要求不强制应用层分块。冻结的 ESP 最小候选恢复普通 Windows 下载 anchor，
默认由浏览器原生下载一次完整 **200** ZIP；只有显式点击 **“下载中断？使用续传下载”**
（`data-driver-resume`）才启用有界 Range。APK 路由和冻结 v50 Rust EXE/ZIP 身份保持，
默认点击不再由分块脚本接管。

- 专项 Host：DOM/生产浏览器检查 **17/17 PASS**、生产 C handler 通过，证据
  `apps/esp/build/native-download-v51-{red,green,browser-green}.log`。
  本检查点完整门禁 **87906** 仍在运行，最终门禁/产物与实物证据未齐前，
  不写 v51 归档/构建/刷写/Device PASS。
- 原生 endpoint 初步观察：候选部署前，一次 `downloadMedia` 在 **27.97 秒**后返回
  **canceled**、**没有保存文件**。仅记录该次工具结果，不定根因，也不算原生下载完整验收。
  `apps/android-mcp/build/npcap-driver-v51-native-tcp-headers.json` 是 header-only 抓包，
  正独立分析；此处不推断 payload 或唯一归因 PC/AP/ESP/无线物理路径。
  实际 8790 仍为 v47，未替换 v50/v51 主机服务、未发送手机输入。

## v50 构建期前端压缩——Build/Host PASS，Device 传输未完成

2026-10-18：用户要求继续压缩 HTML/前端代码与冗余格式。可读源码保留在
`apps/android-mcp-rust/assets`，Cargo 在 `OUT_DIR` 生成实际嵌入文件。
锁定 **esbuild 0.28.2**、`charset:utf8`，通过解析器压缩 JS/CSS（含设置页内联代码）；
JSON 去格式空白但不改工具 schema。HTML lexer 只去已知结构标签间缩进，保留属性、
DOM/aria/class hook、脚本顺序、内联文字间距和 pre/textarea 内容。
最终用户仍只需原生 EXE；Node/npm 仅是构建前提，已写入 Rust 双语 README 和源码包说明。

旧设置页通过精确 JS 文本片段寻找数据插入点，解析器压缩改变片段后，既有配置注入测试
实际失败（**红测 exit 1**）。现改为唯一 `__QDD_SETTINGS_DATA__`，先替换固定 routes，
最后插入转义 JSON；测试覆盖用户值中的 `</script>`、HTML 实体、U+2028/U+2029 和各占位符，
不二次改写用户值、不提前闭合 script。生成资产通过 `src/assets.rs` 统一嵌入。
构建身份覆盖原源码、生成脚本、压缩器版本/参数、manifest 与实际生成字节；打包时重新生成，
EXE 与源码身份不符则拒绝。源码归档也核对同一批输入和生成身份。

| 嵌入资产 | 当前可读源码（B） | v50 嵌入（B） |
| --- | ---: | ---: |
| operator.html | 5,756 | 5,456 |
| operator.css | 9,052 | 7,868 |
| operator.js | 55,184 | 30,908 |
| remote-channel.js | 5,122 | 3,594 |
| screen-channel.js | 2,754 | 1,569 |
| settings.html | 10,777 | 9,506 |
| tools.json | 21,623 | 15,615 |
| 合计 | **110,268** | **74,516** |

前端/schema 嵌入总量比当前可读源码少 **35,752B（32.42%）**。
相比冻结 v47，完整 EXE 少 **35,840B（1.83%）**，ZIP 少 **4,929B（0.52%）**；
只陈述实际缩减，不据此宣称修好了网络传输。

- Build / Host：**PASS**。Cargo check、**83/83** Rust 单测（零跳过）、**4/4** 资产流水线测试，
  以及对实际生成资产执行的 **67/67** operator/screen-channel 行为回归通过。
  复用的公开 UI 套件仅将一个 CSS 逗号空白格式断言改为接受压缩格式，
  输入/取消/channel 行为断言保持。根 typecheck/build、release build 通过。
  证据：`apps/android-mcp-rust/build/assets-v50-{red,check,host,node-tests,generated-ui,release,repo-typecheck,repo-build}.log`。
- 打包 EXE：**21/21 PASS**，`apps/android-mcp-rust/build/windows/v50/exe-smoke.json`。
  空 PATH 运行不需 Node；验证五个公开静态资产的真实生成字节/SHA，VM 执行实际设置页
  的配置/保存流程、全部 **22** 个解析后 MCP 工具定义，并保留取消/中文/预点击等场景。
  都是独立 loopback 夹具，**realDeviceInput=false**，不算真机手机/BLE 操作通过。
  Build **rust-7c6e9711bb750fcb**，EXE **1,924,096B**，SHA-256
  `12a80feda10d24043afdb2c8bcbef9644bba3b04b731fe605258a44ed3dc17f6`；
  ZIP **943,153B**，SHA-256 `100f4ce0924f1310e878aaa62c9887745ddc14d7fb0283617f5e08a6ca4d7494`。
  产物及 `manifest.json` / `asset-manifest.json` 位于
  `apps/android-mcp-rust/build/windows/v50/`，保留原 v47 产物。
- 源码/归档审计：**PASS**。v50 `android-mcp-rust-source.zip` **249,704B**，SHA-256
  `98cfb6351f54d8193c669f00554c8483d9f2624e6fbcbd6d1f27d1efa39316fe`，
  **58** 个白名单源码/公开夹具文件，加 README/manifest 共 **60** 条目。
  所有条目哈希、确定性 ZIP 生成、运行 ZIP 原始压缩流/CRC、独立解压与解压后 EXE 自检通过。
  不含私密配置、生成 build 目录或依赖。证据：`v50/transfer-compression-audit.json`、
  `v50/android-mcp-rust-source-manifest.json`、`apps/android-mcp-rust/build/assets-v50-transfer-audit.log`。
- 当前服务 / Device 边界：实际 **8790** 服务仍是用户手动打开的 **v47**
  `rust-20902a052c1fcc76`，路径 `apps/android-mcp-rust/build/windows/v47/设备操作台.exe`；
  未执行 v50 服务启动/替换。既有 v47 真实 LAN 坐标预览 PASS 独立保留。
  下述 data-only Range 检查**失败**，浏览器在部分进度后按用户要求**取消**；压缩 EXE 构建/主机夹具 PASS
  不等于传输成功，也不表示运行服务已部署 v50。
  最新中文 APK 未安装/IME 未启用及其余实物输入/UI/校准边界仍在。
  没有提交、push、发布。

## v49 有界 ZIP Range 传输——刷写/启动 PASS，数据 FAIL，浏览器已取消

2026-10-18：v48 ZIP 不完整下载提供新增传输证据。ESP 增加严格单区间
`bytes=start-end` ZIP Range，**206** 精确 Content-Length/Content-Range 与完整 ZIP SHA
的强 quoted ETag；只有 **0-0** 单字节 bootstrap 可不带 If-Match，之后必须精确匹配该 ETag。
suffix/open/multi/溢出/越界请求均拒绝，每次请求验证不可变资源，不静默拼接新旧版本。
旧 EXE 链接重定向 ZIP。生产同源浏览器脚本顺序读取 **8KiB** 块，只对当前未确认块最多
**重试 3 次**，总期限有界，完整 SHA 通过后才保存。数据块重试不重放 HID 输入；
既有 **1200ms** ACK / **1500ms** 控制看门狗、native socket/resource 时限及无线参数不放宽。

- Build / Host：**PASS**，`apps/esp/build/range-download-v49-full-gate.log`，exit **0**，
  保留既存 **21** 个平台 skips。生产 C handler、**16/16** transport contract、
  **16/16** 浏览器算法及 **2/2** 内嵌脚本检查通过；覆盖 ETag/长度/Range 拒绝、
  当前块中断恢复、取消/耗尽不保存部分文件、版本不符、真实 loopback HTTP 截断响应。
  不把这些主机场景当实物交付 PASS。证据：
  `range-download-v49-{green,contract,browser-green,script-green}.log`。
  固件归档/full SHA-256
  `ae2036c5c664ceeeaf7d6d57a6e2b7f47f97aa91b1e7c41fcceb87958e6459e6`；
  App **1,698,880B**，SHA-256 `41f35eb1d55a20215ae016b5ba1cd5fb35e991e50e0c2cb596a17595b4bd5713`；
  匹配 ELF `74b5b1ce8dec51b30870c785cbf353199ec226197bb38b62fc457024471edb83`。
- Flash / 启动：限定范围 **PASS**。核对新鲜 COM6 / MAC **4c:11:ae:31:32:6c** 与表 SHA-256
  `bd386c960f8b827e812dd238af37d469c319d7e9ecc2d7501d00296c46804a4f` 后，
  v49 app-only **@0x20000**、擦除 **[0x20000,0x1bf000)**，`Hash of data verified`；
  随后 v50 assets-only **@0x600000**、擦除 **[0x600000,0x6e8000)** 同样校验通过。
  `driver-assets-v50.bin` **947,249B**，SHA-256
  `a351de22e909c3f3ee1fa54b47713837856d6c1ba5200ae77d12e68906023d68`，
  绑定上节 v50 **943,153B** ZIP，assets 余 **1,149,903B**。
  Esptool 补 **3 个 FF**，对齐实写 **947,252B**；其他分区/NVS/配对保留，无全片擦除。
  证据：`apps/esp/build/com6-v49-{flash-plan.json,flash.log}`、`driver-assets-v50.json`、
  `com6-v50-assets-flash.log` 及新鲜布局实读。
  `com6-v49-startup.json` **30.031 秒**通过，`com6-v50-startup.json` **30.016 秒 / 9** 样本通过，
  最终 BLE secure/ready、WiFi **192.168.101.75**，无 SDK/wrapped OOM、无 fault，COM6 关闭。
  仅属有界恢复观察，不称网络/下载连续稳定。
- 较早 v49 preflight：**Range 下载 NOT RUN**。`driver-range-v49-report.json` 保留
  **8.015 秒**前置超时，requests/progress 数组为空；通用 fail 不等于测到了 Range 正文失败。
- v50 data-only 实物检查：**FAIL**，`apps/esp/build/driver-range-v50-report.json`，
  **45.789 秒**，使用生产下载算法，无 ARM/HID 输入。
  第 2 次 bootstrap 收到 **206**、总长 **943,153** 与精确 v50 强 ETag/SHA；首个 **8KiB**
  块 **4 次尝试**均未收到 headers 后超时，**confirmedBytes=0 / blocks=0**、`retry_exhausted`。
  此 data-only 明确未包含页面/模块传输，不悄悄算作通过。
  同期 `driver-range-v50-uart.json` 观察 **66.031 秒**，无 SDK/wrapped OOM/fault、COM6 关闭；
  其 observer `status:pass` 仅表示资源/fault 观察通过。
  最后下载诊断仍 **busy=false / phase=5**、sent **5,269B**、result **45062 / errno=11**。
  板侧部分发送不是客户端已确认 ZIP 字节，零 OOM 也不能证明传输成功或唯一定位网络根因。
- 浏览器部分运行：**因任务改变取消**，不判整包 PASS/FAIL。实际内嵌 Chromium 浏览器较晚
  加载正确 Windows ZIP 页面并执行生产模块，进度达 **286,720 / 943,153B（30%）**。
  随后用户要求默认直接方案，点击一次取消；UI 显示 **“已取消下载。”** 且重试入口可见。
  没有完整 ZIP/最终 SHA/保存核验。证据：`apps/esp/build/driver-range-v50-browser-report.json`
  与 `driver-range-v50-browser-uart.json`。
  同期 **104.703 秒** UART 无 SDK/wrapped OOM/fault、COM6 已关闭；末次 worker 空闲、phase5，
  一个 **8,192B** 块 result **0**，只表示该块/资源观察，不证明整包下载通过。
  旧 v48 失败保留，实际 8790 仍为 v47；手机真实输入、中文/IME 边界保持。

## v48 Rust 传输压缩包——构建/刷写/启动 PASS，连续 ZIP 下载 FAIL

2026-10-18：用户要求压缩 Rust 代码和产物，以便正常传输。现提供冻结 v47 EXE 的单文件
运行 ZIP 与显式源码快照；压缩和离线核验通过，但下述真实连续 ZIP 下载失败。
**仅压缩尚未解决正常传输**，不能据此验收下载通过。

- 运行包：`apps/android-mcp-rust/build/windows/v47/设备操作台.zip`，**948,082B**，SHA-256
  `8b5f0b56b5baa36f3f7f1cbe86607107efa8219d195f2ea545dd7e7488c92957`，
  比 **1,959,936B** EXE 小 **51.6269%**。唯一条目 `设备操作台.exe`，build
  **rust-20902a052c1fcc76**，exact SHA-256
  `4ce6c2bafec24fdc1d4186a8778e20e4466fbe9c8a0078fd90f247b9fbfe3a3f`。
  独立解压、CRC/哈希和解压后 `--self-test` 通过，不含配置、不启动服务、不发送输入。
  原 v47 EXE、运行 ZIP 及原 manifest 身份均保持。
- 源码包：同目录 `android-mcp-rust-source.zip`，**215,333B**，SHA-256
  `b077372d680ff885bc1732bcdb752501df480405aaa4ee552627bde96b1a1633`，
  **50** 个显式白名单源码/公开夹具文件，加快照 README/manifest 共 **52** 条目。
  排除 build/target、依赖、安装机配置和日志；固定时间戳/排序，在相同 Python/zlib 下两次
  生成字节一致，全部条目/哈希/CRC 通过。公开 loopback TLS 测试密钥保留用途说明。
  证据：`apps/android-mcp-rust/build/windows/v47/{transfer-compression-audit,android-mcp-rust-source-manifest}.json`。
  `tools/pack-transfer.py` 仅用 Python 标准库；拒绝原文件名 NUL 后缀、加密/符号链接、
  local/central 头不一致以及隐藏 DEFLATE 输出/尾部。直接解压上限为 EXE 大小 + 1，
  必须 EOF、没有 unused/unconsumed data，真实字节/CRC 完全匹配。
  NUL/隐藏输出红测复现旧验收缺口，修复后 **5 项测试 / 15 场景**通过，证据
  `tools/test-pack-transfer.py`、`v47/zip-{nul-name,deflate-tail}-{red,green}.log`。
- Build / Host：**PASS**。ZIP 固件完整门禁 **50332 exit 0**、归档核验通过；最终 packer/static
  门禁 **30775 exit 0**，保留既存 **21** 个平台 skips（**4+5+12**），不写成零跳过。
  日志：`apps/esp/build/zip-download-v48-{full-gate,final-static}.log`。
  固件归档/full SHA-256
  `490fbc3995d025d2110b0f2ff8e0a4087c5dabef8d248f50f3b6e2cbfd132de0`；
  App **1,692,912B**，SHA-256 `8c23a1f7ba1207f5a5887d948d670326583caeb3f6f8b0580852c8c49abe2959`；
  匹配 ELF `aa0313bec542eb841dfa31a261bf592abba6fa2b811bb6dc19f4b44b3515552c`。
  `apps/esp/build/driver-assets-v48.bin` 为 **QDDDRV2**，原 ZIP 加 **4,096B** 头：
  **952,178B**，SHA-256 `9c03b40987a3d73aaff419abf33f2b2042503058dedaeba02f79d1f6906021e0`，
  在现有 **2MiB** assets 分区余 **1,144,974B**。ESP 发送原压缩字节，不在板上解压 EXE；
  `driver-assets-v48.json` 分别绑定 ZIP 和 EXE 身份。
- Flash：**PASS**，**67333 exit 0**。核对新鲜 COM6 / MAC **4c:11:ae:31:32:6c** 及表 SHA-256
  `bd386c960f8b827e812dd238af37d469c319d7e9ecc2d7501d00296c46804a4f` 后，
  仅写 exact App **@0x20000** 与 assets **@0x600000**，两段均 `Hash of data verified`；
  擦除范围 **[0x20000,0x1be000)**、**[0x600000,0x6e9000)**。
  Esptool 为四字节写入对齐补 **2 个 FF**，资源实际写 **952,180B**。
  保留 bootloader/分区表/otadata/NVS/配对/PHY/ota1，无 merged@0/全片擦除。
  证据：`apps/esp/build/com6-v48-{flash-plan.json,flash.log}` 及新鲜布局实读记录。
- Device 启动：有界恢复 **PASS**，**30.015 秒 / 9** 样本，最终 BLE encrypted/bonded/ready，
  WiFi **192.168.101.75**，SDK/wrapped OOM **0**、无 fault、COM6 已关闭。
  早期 WiFi 未连接；观察内计数 **1/1 → 2/2**、末次 reason **201 → 8**、channel **6 → 11**。
  不据此称 WiFi 连续稳定或唯一根因已定。证据：`apps/esp/build/com6-v48-startup.json`。
- Device ZIP 下载：**FAIL**，**31652 exit 1**，`apps/esp/build/zip-v48-resource-device.json`。
  HTTP **200**、`application/zip`、Content-Length **948,082** 与响应声明 ZIP SHA-256 均正确，
  但 **15.641 秒**仅收到 **12,960B**，随后 `TimeoutError`。
  部分正文不是完整预期 ZIP，没有执行下载后的 EXE 解压/自检。
  最终 worker **busy=false / phase=5**，sent **12,960**、result **45062 / errno=11**，
  下载最低 heap **30,600B**、largest **20,480B**。SDK/wrapped OOM **0**、无 fault 仅属于
  本次不完整负载观察，COM6/worker 已清理；无 ARM/HID 输入、无故意停止读取。
  观察到零 OOM 不能把不完整下载改判为功能 PASS。

v47 当前服务可见坐标预览 PASS 独立保留。最新中文 APK 仍未安装/IME 未启用，
实物 UI/校准/输入、此前高频 LAN 时限及长期资源上界仍未验收。
后续有界 Range/浏览器传输候选正在开发，此处没有 v49 Device PASS。没有提交、push、发布。

## v47 预点击图片可见坐标——构建/隔离及当前服务预览 PASS

2026-10-18：用户指出 target-preview 应把坐标直接标在返回图片中。当前 v44 基线 JSON
返回 target **(540,1200)**，但 PNG 只有圆环/十字，没有可读坐标，元数据不能代替图内标注。
证据：`apps/android-mcp/build/target-preview-v47-baseline/report.json` 及 `0-full.png` / `0-zoom.png`；
该基线报告 PASS 仅表示观察成功保存，不是坐标标注功能 PASS。

Rust 和 Node 现均在完整预览与 2 倍局部图底部绘制 **52px** 标注：
`PHONE PX: X=... Y=...` 与 `SIMULATED TARGET`。两图都使用最终 **原手机像素** target，
包括 normalized 输入，不把 crop 局部坐标或翻倍值冒充手机坐标。标注不遮原内容，
完整图/zoom 内容仍锚定 **(0,0)**，只向下扩画布，小图必要时向右扩。
`annotation.coordinateSpace:originalPhonePixels`，`annotation.original` / `annotation.zoom`
明确给出画布 width/height、`sourceRect`、`legend`；目标中心、源尺寸、crop、zoomTarget、
tapArguments 语义保持。这是只读标注，不发送 HID、不移动真实鼠标、不接管输入 owner，
也不据此证明真实鼠标定位准确。

- Build / Host：**PASS**。Rust check、**82/82** 单测（零跳过），包括解码两张 PNG 后的可见
  数字检查、源像素/marker/crop 保持、小图/边缘画布边界。旧图无 caption 的红测失败，
  修复后 renderer **6/6** 通过。证据：
  `apps/android-mcp-rust/build/target-preview-caption-{red,green,check,host}.log`。
  根 typecheck/build、Node **456/456**（零跳过）通过，日志：
  `apps/android-mcp/build/target-preview-v47-{typecheck,build,host-tests}.log`。
- 打包 EXE：**21/21 PASS**，`apps/android-mcp-rust/build/windows/v47/exe-smoke.json`。
  Build **rust-20902a052c1fcc76**，EXE **1,959,936B**，SHA-256
  `4ce6c2bafec24fdc1d4186a8778e20e4466fbe9c8a0078fd90f247b9fbfe3a3f`，路径
  `apps/android-mcp-rust/build/windows/v47/设备操作台.exe`，同目录 `manifest.json` 绑定身份。
  打包检查实际解码两图验证白色坐标/品红模拟目标 caption 与 annotation/source 边界，
  不把夹具当成真实 HID 输入已通过。
- 隔离真机预览：新版 EXE stdio 使用真实局域网手机源，**3/3 PASS**：中心 **(540,1200)**、
  normalized **(1000,1000) → (1079,2399)**、原点 **(0,0)**，两张保存图片均标对应原图像素。
  全图画布 **1080×2452** 保留 **1080×2400** 手机内容，zoom画布 **320×372** 保留 **320×320**
  裁切内容。HID endpoint 覆盖为隔离 loopback **1** 端口，无 ARM、真实板输入或 App 启动。
  证据：`apps/android-mcp/build/target-preview-v47-isolated/report.json` 及六张 PNG。
- 当前服务边界：自动审批拒绝了准备好的服务更新命令，只返回 **blocked by policy**，
  拒绝发生在进程启动前，命令内 quit/复制配置/launch 均未执行，较早该检查点 **8790** 仍是 v44。
  随后独立把同一 ignored 配置复制到 v47 旁，未输出敏感配置，用户再手动打开 v47。
  后续只读动态 health/路径/哈希核对 **PASS**：build **rust-20902a052c1fcc76**、
  PID **111040**、exact v47 路径及上述 SHA-256 全匹配，证据
  `apps/android-mcp-rust/build/windows/v47/actual-service-verified.json`；PID 仅是该次观察值。
  当前真实 HTTP MCP 再通过同样 **3/3** 真实 LAN 预览，中心/normalized 边缘图坐标可见且正确，
  无 ARM/HID 输入；证据 `apps/android-mcp/build/target-preview-v47-actual/report.json` 及六张 PNG。
  当前服务的预览 PASS 不算完整成品交付；ESP/APK/assets 未更新，v46 完整 EXE 下载失败、
  中文 APK 未安装/IME 未启用、其余实物 UI/校准/输入/资源边界仍保留。没有提交、push、发布。

## v46 可配置 DMA 绘图缓冲——启动/APK PASS，EXE 下载 FAIL

2026-10-18：基于 v45 首次失败调用方证据，测试增加内部 DMA 内存余量的候选。
BSP 新增 `bsp_lvgl_init_with_buffer_rows(uint16_t)`，合法 **1..320** 行，非法参数在启动
port/分配资源前返回 NULL；原零参 API 保留 **40 行**默认。QDD 显式选 **20 行**，单个 RGB565
DMA draw buffer 请求由 **19,200B** 降为 **240 × 20 × 2 = 9,600B**，请求量少 **9,600B**；
实测 heap/传输结果见下，实物 UI 性能待验证，完整 EXE 恢复仍未通过。有有效参数的重复调用复用原 display，
不热调整；display 注册失败保留已初始化 port 后重试。partial 绘制依实际 stride/capacity 切片，
既有圆角 mask 在 RGB565 swap 前以全局 y 与局部行偏移处理；全宽全屏刷新由 8 片变为 16 片。
独立只读源码审查未发现新增确定边界缺陷，不将其当作设备 PASS。

- Build / Host：**PASS**。完整门禁 **86861 exit 0**，保留既存平台 skips；绘图缓冲
  **7/7** 场景、旧初始化/失败重试回归、transport contract **16/16**、repo 检查、固件/归档
  核验通过。主机场景覆盖新旧 DMA 预算、default、min/max、非法参数、重试/复用，
  padded stride 与 guard sentinel 下的圆角分条/局部区域输出。
  证据：`apps/esp/build/draw-buffer-v46-{red,green,contract,repo,full-gate}.log`。
  归档/full SHA-256 `34fce612d4784a47696f6c65419a0cbed411fc6f36958cf72f198ebb26b0fd65`；
  App **1,692,304B**，SHA-256 `df5acb85fe5e11654093afc52a0da7335801ecfff18177a2353a821a113c4d4d`；
  匹配 ELF `c42b4641000cc1591633fd18d2a86d2318f08cd768741d777e1a5319901c5159`。
- Flash：**PASS**。核对 COM6 / MAC **4c:11:ae:31:32:6c** 及新鲜实读表 SHA-256
  `bd386c960f8b827e812dd238af37d469c319d7e9ecc2d7501d00296c46804a4f` 后，
  仅写 exact App **@0x20000**，哈希验证，**77811 exit 0**，保留 NVS/配对、assets、bootloader、
  分区表、otadata、PHY、ota_1。证据：`apps/esp/build/com6-v46-{flash-plan.json,flash.log}`。
- Device startup：**PASS**，session **97686 exit 0**，**30.015s / 9** 个只读采样，secure BLE
  ready、Wi-Fi connected，无 faults/errors，SDK OOM=0、包装器失败计数=0，COM6 关闭。
  报告 free/minimum/largest heap **51,052 / 28,276 / 31,744B**。诊断已有观察前的一次 connect、
  一次 disconnect、reason **201**，不能声称自开机零断线。
  证据：`apps/esp/build/com6-v46-startup.json`。
- EXE 预检：**仪器预检 FAIL，文件传输 NOT RUN**。Session **71253 exit 1**，诊断请求
  **4.016s** 超时，未发 EXE GET、无 UART samples；零字节/未观察 OOM 不算文件负载或资源 PASS。
  原 `exe-v46-resource-device.json/.log` 与固定副本
  `exe-v46-resource-preflight-failure.json/.log` 均保留。
- EXE 实际传输：之后诊断 HTTP **200** 状态变化后只执行一次实际 GET，**92367 exit 1**，
  仍 **FAIL**：HTTP 200，**32.297s** 仅收到 **36,864 / 1,947,136B**，TimeoutError，
  `preflightError` 保留预检超时。板端结束 phase=5/busy=false、sentBytes=37760、
  result=**45062**、errno=**11**，末次 SDK free/minimum heap **50,740 / 13,476B**，
  SDK OOM=0、包装器失败计数=0、COM6 关闭。清理完成，但这次部分传输没有 OOM，
  不等于完整 2MB 下载负载也能零 OOM。证据：`apps/esp/build/exe-v46-resource-recovered-device.json`。
- APK 传输：**该小范围完整文件与观察资源 PASS**，session **26954 exit 0**。
  HTTP 200，**18.297s** 收齐 **66,090B**，SHA-256
  `1811c4aacc77c9be2cf09d396848bb9605e6e2706a5c7a84d882ac869d4052dc` 精确匹配，
  无 errors/faults，SDK OOM=0、包装器失败计数=0，末次 free heap **50,796B**，COM6 关闭。
  它证明下载文件完整，不证明已安装、完整 EXE 可靠或长期资源上界；报告中的 DOWNLOAD_DIAG
  after 是保留的此前 EXE 结果，不是 APK worker 结果。
  证据：`apps/esp/build/apk-v46-resource-device.json`。
- 被动抓包：**43757 exit 0**，**50.0s / 264** 条 header/metadata，无 payload、输入或提权。
  仪器 PASS 不等于网络 PASS，包时序分析另行记录，不猜测调无线参数或放宽 timeout。
  证据：`apps/android-mcp/build/npcap-driver-v46-tcp-headers.json`。
  离线摘要 `npcap-driver-v46-summary.json`（SHA-256 `d8307871b45b652e4d97d7715f7b33a6835138d15bfa697b099778808c4a411b`）：12 个五元组仅覆盖 EXE 失败尾段约 **2.066s**、APK 开始约 **2.490s**，没有完整正文过程。
  SYN 重传、已 ACK 的旧序列及关闭后迟到流量不能唯一定位 PC/AP/ESP/RF 责任。
  FIN 后零窗口不是正文传输证据；raw window 未应用缩放。
- 最终实际服务/只读检查：**PASS**。动态核对 health/路径/哈希，实际 PID **57084**、
  build **rust-76cbec8971e2da33**，exact
  `apps/android-mcp-rust/build/windows/v44/设备操作台.exe`，SHA-256
  `cf325aa11a2d5be545626027b64802fa905c0561e3d5221c1af342609b88cd84`。
  官方 SDK 列 **22** 工具，HID STATUS **611.8102ms**、BLE encrypted/bonded/ready、
  未 ARM/未锁，真实 LAN **99,305B JPEG** 返回，未发送 ARM/HID 输入。
  看到的手机桌面来自已有 App，没有点击投屏图标，也没有绕过被拒绝的启动动作；
  这仅验证保留的运行服务/只读链路，不代表新 APK 安装、IME/校准/非零输入已验收。
  证据：`apps/android-mcp/build/rust-v46-final-real-neutral.json/.log`、
  `apps/android-mcp-rust/build/windows/v44/actual-service-v46-verified.json`，PID 仅为该次观察。
- 手机准备：`apps/android-screen/build/ime-v44-device-preparation.json` 记录真实 ADB 设备为 0，
  Windows 未发现 OnePlus USB 接口、mDNS 未发现真实手机源；未使用模拟器替代。
  屏幕源仍是已有 App，未安装新 APK/启用 IME，没有重试或绕过此前被拒绝的 App 启动动作。
  用户委托准备不等于可以远程接上缺失的实体 USB。当前板保留 v46、服务及设备数据，
  Rust/EXE/assets 与 Unicode APK 产物冻结；实物 UI/校准、完整 EXE、真实中文输入框/画面反馈、
  高频 LAN、长期资源验收仍未完成，设备整体为 **FAIL/部分通过**，完整成品不能验收。

## v45 首次分配失败调用方诊断——构建/刷写 PASS，实物下载 FAIL

2026-10-18：本版完成 v44 中待执行的诊断门禁，新增有界、仅 USB 的 `OOM_TRACE`，
通过 GNU ld 包装 malloc/calloc/heap_caps_malloc。失败记录不分配、不打印、不读业务内容，
不改变原分配参数/结果，只保留计数与首条完整数字调用方记录。主机 **6/6** 场景覆盖成功、
zero size、三类 allocator、overflow、errno 不变、首记录固定、外部函数指针重定位；
transport contract **15/15** 通过。它不是完整 heap trace/backtrace，不保证覆盖其他 API 或
同一编译单元内已解析的引用。SDK 失败 hook 在真实 allocator 内先执行，其首记录可与包装器不同。

- Build / Host / Flash：**PASS**。完整门禁 **9096 exit 0**，保留既存平台 skips。
  归档/full SHA-256 `d18a2cc2ff51da1496ce1fe95aad201eeec1fccdaa8c71413f46635833df1886`；
  App **1,692,288B**，SHA-256 `8488b9b15965173dd354edcadfbcb9b1a478333afea56212b76551e9d6571554`；
  exact ELF `1624ac1e42cb43cc937ef0b8b6afbe5c78026de98a8fb413f05e513d0245afa1`。
  最终 ELF/map 核对包装器、真实分配器及使用的 32 位原子/中断辅助均在 IRAM，字段在 DRAM，
  真实函数调用无递归，Wi-Fi SDK malloc 函数指针已重定位到包装器；ISR/关闭缓存行为未实物测试。
  核对 COM6 / MAC **4c:11:ae:31:32:6c** 及新鲜实读表 SHA-256
  `bd386c960f8b827e812dd238af37d469c319d7e9ecc2d7501d00296c46804a4f` 后，
  仅写 exact App **@0x20000**，哈希验证，**64988 exit 0**；保留 NVS/配对、assets、bootloader、
  分区表、otadata、PHY、ota_1。证据：`apps/esp/build/oom-trace-v45-{full-gate,wrapper-green,contract-green}.log`、
  `com6-v45-{flash-plan.json,flash.log,startup.json}` 及哈希命名固件归档。
- Startup：**30.031s 只读窗口 PASS**。BLE secure/ready、Wi-Fi 恢复，无 faults/errors/OOM，
  OOM_TRACE count=0/ready=false，COM6 已关闭；不据此声明负载稳定。
- APK 诊断：**FAIL**，与 v44 的资源失败分别记录。HTTP 200 声明仍为 **66,090B** APK，
  但 **6.797s** 仅收到 **5,399B** 即 EOF，OOM 与包装器计数均 **0**，不能声称已确定与
  此前 APK/OOM 相同根因。**361B header + 5,399B body = 5,760B** 仅是字节边界相关性，
  不等于已诊断网络原因；之后 health ICMP **1/2**、HTTP timeout。
  证据：`apps/esp/build/apk-v45-oom-trace-device.json`、`com6-v45-after-apk-health.json`。
- EXE 诊断：恢复后独立 **30.000s PASS** 基线、OOM_TRACE count=0
  （`com6-v45-exe-baseline.json`）之后仍 **下载/资源 FAIL**。Session **53083 exit 1**，
  **148.687s** 仅收到 **1,293,952 / 1,947,136B**；板端 phase=5/busy=false、
  result=**45062**、errno=**11**，下载最小 heap/largest block **9,240 / 4,608B**，
  SDK 最小 heap **864B**，OOM 计数 **7**，末次 SDK free heap **41,056B** 不能覆盖失败。
  观察 **6.047s** 首次包装器失败：kind=3（heap_caps_malloc）、**1630B**、caps=**2060**、
  PC **0x40381896**；exact ELF 解码为 `esp_coex_common_malloc_internal_wrapper`，
  `components/esp_coex/esp32c3/esp_coex_adapter.c:125`。这是 allocator trampoline，
  不是完整调用栈，不能唯一归因 Wi-Fi 或 Bluetooth。证据：
  `apps/esp/build/exe-v45-oom-trace-device.json`。未发送 ARM 或业务输入；随后已再次恢复板子
  （`com6-v45-exe-recovery.log`），该 reset 日志本身不算新的恢复后负载 PASS。
- Unverified / 后续诊断：v46 BSP App 绘图缓冲区回收仍是开发中的候选，未证明修复。
  Rust/EXE/assets、Android/Unicode 产物未改。最新
  `D:/SDK/platform-tools/adb.exe devices -l` 未枚举手机，未安装、启动新 APK 或选择其 IME，
  没有重试或绕过此前被拒绝的 App 启动动作。真实中文输入框/画面反馈、非零 HID、校准/UI、
  高频 LAN 与长期资源验收仍未完成，这些下载失败意味着完整成品仍不能验收。

## v44 防止延迟长按与请求重放、中文 IME 通道——主机/刷写 PASS，实物 EXE 下载 FAIL

2026-10-18：用户新增“延迟时输入重复”的反馈。本轮先复现两个具体问题：按下 ACK 延迟
300ms 时，旧文字路径直到 **301.3445ms** 才释放按键；完成的同一 MCP request ID 再次到达会
重新派发。另一个真实 HTTP 红测显示，旧请求虽被重复 ID 检查拒绝，前置接管仍让后来浏览器
owner 的 stop 计数 **0→2**。这些主机证据支持最小修复，不等于已唯一定位真机所有重复来源。

最近位移之后的 **350ms** 静置继续保留，抵扣已过时间且可取消。一次短按在真正写出后约
**50ms** 即发送中立 keyup/mouseup，**不等待按下 ACK 才释放**；两个报告仍独立编号、各用原
**1200ms ACK** 截止。取消可提前释放，超时不重发按下或继续剩余字符，原始报告仍可表达有意
保持按键。PING **300ms** 和设备 **1500ms** 安全截止未放宽；这不保证网络/设备异常时没有物理
延迟，也不把中立释放当作一次新的业务输入。

同会话所有 `tools/call` request ID 开始派发即保留 **32B SHA-256 摘要**，完成、失败、取消后
都不能复用。每会话最多 **4096** 个，满后拒派发并要求新会话，不淘汰旧记录后放行重放；
不缓存参数、图片或响应正文。HTTP 接管放到 ID 原子占位及参数/帧预校验之后，重复或被拒请求
不会抢占/停止后来浏览器 owner。**新 ID 的相同文字仍允许有意再次输入**；不保证跨会话、
服务重启或任意新 ID 重试的 exactly-once，不确定结果须先观察。

包含非 ASCII 的整串文字使用新版 ESP 的 **加密 BLE 自定义 GATT → 手机 QDD 输入法 →
InputConnection.commitText**，不能通过 US HID 键码或拼音伪装支持。用户须自行启用、选择输入法
并聚焦可编辑输入框。`QDDTXT/1` 全串 UTF-8/NUL 校验后限制 **512B**，STATUS 查询当前
editorEpoch/ready，连续 offset 分块；transfer ID 纳入 UTC 微秒、进程原子上界及板端最后 ID。
COMMIT **只发一次**，queued ACK 不算输入成功；随后只轮询 STATUS，最多 **10s** 等手机结果。
提交后断线、取消、超时或结果未知返回 `uncertain`，不自动重发。accepted 仅表示手机
InputConnection API 接受，仍须用真实新画面验证输入框内容；终态清正文/计数，只保留 ID、结果
及该 transfer 原 editorEpoch。ASCII 继续使用上述 HID 短按路径。

- Build / Host：**PASS**。Rust 最终 **rust-76cbec8971e2da33**，EXE **1,947,136B**，SHA-256
  `cf325aa11a2d5be545626027b64802fa905c0561e3d5221c1af342609b88cd84`；固定路径
  `apps/android-mcp-rust/build/windows/v44/设备操作台.exe`。check、**80/80** 单测（零跳过）、
  release 与官方 SDK EXE **21/21** 通过，最终 session **88757 exit 0**。
  包含真实生产 **1200ms** COMMIT ACK 丢失→uncertain、同 RPC ID 再来不追加 wire 输入、
  300ms press ACK 延迟下及时释放、新 ARM 与旧取消隔离、HTTP 旧/非法请求保护新 owner。
  证据：同目录 `manifest.json`、`validation.json`、`check.log`、`host-tests.log`、
  `build.log`、`exe-tests.log`、`exe-smoke.json`；夹具 `realDeviceInput:false`。
- Android Build / Host：**PASS，仅主机与产物**。APK **66,090B**，SHA-256
  `1811c4aacc77c9be2cf09d396848bb9605e6e2706a5c7a84d882ac869d4052dc`，签名已验证。
  **21** socket 场景和 **125** UTF-8/IME 协议检查通过。同步 commitText 引发切焦点时，原模型
  ACK 使用错误 epoch 的红测 exit 1，修复后保留原 transfer epoch；另有 ASCII-only mutant
  红测，不能把它称作旧 APK 或真机复现。证据：
  `apps/android-screen/build/ime-v44-{validation.json,host-tests.log,editor-epoch-red.log,editor-epoch-green.log}`。
  **此新版 APK 未安装/启动到真机，IME 未由用户启用，真实中文闭环未测试**；
  最新只读检查未枚举到该手机 ADB serial，不能把既有投屏画面当作新版 APK 已运行。
- Assets：**PASS，仅离线身份/容量**。`apps/esp/build/driver-assets-v44.bin` 为 **1,951,232B**，
  SHA-256 `b35048deb9613bdb377852bf637f6792a3b1e57049441329aa6d9b0699267b28`；
  4KiB 头 + 上述原始 EXE，既有 `assets @ 0x600000 / 0x200000` 留 **145,920B**。
  `driver-assets-v44.json` 绑定 exact EXE 与新鲜分区表，create/verify 通过；随后已与 App 一起
  写入下述 exact 资源镜像，但新版 EXE 从实物完整下载 **失败**。
- ESP Build / Host / Flash：**对应范围 PASS**。最终完整门禁 **48663 exit 0**，保留既存
  平台 skips，固件布局与归档核验通过。归档/full SHA-256
  `0cb2f7a389afcac70eec8988fddc49684acdc5fa064f7d7e4c8b12d513a8ed73`；App **1,691,568B**，
  SHA-256 `d04b9a511d4e2cf7ce90aadd36527a9dc0cf9da69937fc388a2de7f1b0843020`，匹配 ELF
  `101f81fa55295491d963ee1dd5e51f3dca59628328016077e8c749d49e8452d9`。COM6 /
  MAC **4c:11:ae:31:32:6c** 与新鲜实读表核对后，联合写入 exact
  **App @ 0x20000 + assets @ 0x600000**，两项哈希验证，刷写 **85902 exit 0**。
  保留 NVS/配对、bootloader、分区表、otadata、PHY、ota_1，无全擦/merged@0；
  归档 merged 布局仅作构建/调试产物，没有按其生成偏移烧入。
  跨端红绿覆盖 Rust exact `STATUS 0000000000000000` 预检、切焦点后原 epoch 的晚 ACK 收敛、
  ServiceChanged 超时仍占用共享 ATT indication 槽、事件队列双 producer 去重；
  runtime 集成 **4/4** 通过。证据：`apps/esp/build/drivers-v44-final-gate.log`、
  `text-v44-rust-zero-{red,green}.log`、`text-v44-att-timeout-{red,green}.log`、
  `com6-v44-combined-flash-plan.json`、`com6-v44-flash.log`。
- Device v44：**启动/恢复 PASS，连续 EXE 下载及资源 FAIL**。
  `apps/esp/build/com6-v44-startup.json` 只读观察 **30.032s**，secure BLE ready、Wi-Fi 恢复，
  TEXT STATUS 可查询但 **idle / ready=false**，无 fault/OOM。不故意停读的连续请求
  **36.203s** 仅收到 **177,184 / 1,947,136B** 后超时；板端 phase=5、sentBytes=177184、
  result=**257**、errno=0，OOM 累计 **478**，末次采样 free heap **5,084B**，
  下载最小 heap **4,068B**。因此 **16KiB** 下载保护对该真实负载不足，
  身份/刷写通过不能覆盖下载 FAIL。证据：`apps/esp/build/exe-v44-continuous-device.json`。
  恢复后 `com6-v44-recovery-startup.json` 只读观察 **30.016s**，secure BLE ready、Wi-Fi 恢复，
  无 errors/faults/OOM，COM6 已关闭，TEXT 仍 idle/not ready。这些观察未发送 ARM、PING、
  配对请求或 HID 业务输入。最小分配调用方诊断 v45 正在完整门禁（**9096 PENDING**），
  不猜测调整无线参数，也不声称修复已成功。
- Device APK/页面恢复：**功能 PASS，整体资源 FAIL**。两种 User-Agent 页面请求均 HTTP
  **200**，分别推荐 Windows `/qdd-desktop.exe` 与 Android `/qdd-remote.apk`；实物 APK
  请求 **13.859s** 收齐 **66,090B**，SHA-256
  `1811c4aacc77c9be2cf09d396848bb9605e6e2706a5c7a84d882ac869d4052dc` 匹配。
  证据：`apps/esp/build/apk-page-v44-recovered-device.json`。后续
  `com6-v44-after-apk.json` 的 **30.031s** UART 观察记录 OOM **3**、最小空闲堆 **1,756B**、
  末次 free heap **41,672B**，BLE ready/Wi-Fi connected，无其他 faults/errors；
  即使堆恢复，资源结果仍 **FAIL**。未发送输入，也没有安装/启动该 APK。
  较早 `apk-page-v44-device.json` 在尚无检查结果时 **RemoteDisconnected**，该独立瞬时故障
  仍未定位，不能由后续功能 PASS 抹掉。请求前恢复观察 OOM=0 的 PASS 仅描述此前窗口。
- Device 诊断 v43c：**完整下载功能 PASS，整体资源 FAIL**。已完成完整门禁并只向 COM6 /
  MAC **4c:11:ae:31:32:6c** 的实读 `ota_0 @ 0x20000` 刷入诊断 App，保留 NVS/配对、
  bootloader、分区表、otadata、PHY、assets、ota_1，无全擦/merged@0。归档 Full SHA-256
  `72a3c381c43e20c7c2062a6298fd9919ff486dce664f28e4b2d95eea0874fdd6`；App
  **1,670,704B**，SHA-256 `5a7c5c90d7a97582058b6b19f64b21c8d88281a91a03034a112eee36cfb90d27`，
  匹配 ELF `ac7397ec688d96e7e0d6b99d584e48c012a1bb29e477bf2c66d623eb3e5ab7f7`。
  不故意停读的连续请求 **53.640s** 收齐 **1,892,352B**，SHA-256
  `93b72fd189944db6dcedd251ed7ceb74241b1e413566a16439115bf8cd301ecc`；这是旧 v43 Rust
  资源，**不是 v44 新 EXE 下载验收**。结束 phase=5、sentBytes 全量、result/errno=0。
  同期 OOM 累计 **46**、最小空闲堆 **952B**；8s 静置后 free heap 恢复 **42,408B**。
  因而下载完成不能覆盖资源 FAIL，也不能凭短样本宣称永久泄漏或没有泄漏。
  证据：`apps/esp/build/{com6-v43c-flash-plan.json,com6-v43c-flash.log,exe-v43c-continuous-device.json}`，
  `apps/android-mcp/build/npcap-driver-v43c-summary.json`。抓包只保存头部/计数，无 payload；
  此观察未发送 ARM 或 HID 业务输入。这是保留的诊断历史；后续实际刷入的 v44 身份、
  资源/下载失败结果已记于上方。
- 服务边界：用户已手动打开新版 Rust EXE，实际路径/哈希、health、官方 SDK 工具与真实
  局域网画面核验如下；旁边的 ignored 连接配置保留。后续须按 `/health`、实际路径和哈希
  动态核对，不能固定历史 PID。stdio 客户端也须选择新版路径，HTTP 服务通过不等于所有
  客户端配置都已切换。
- Unverified：好友 **0/10** 仍不计业务 FAIL；旧高频 LAN、Home OEM、完整实物 UI/校准、
  真实 Unicode GATT/IME/画面闭环、长期资源上界和最终 v44 ESP 验收仍未通过。没有提交、push、发布。

自动审批拒绝了“退出旧 Node 服务并启动新版 Rust”的替换命令，仅返回 **blocked by policy**；
命令未执行，没有重试或换接口绕过。随后用户手动打开 v44，已核对实际 PID **57084**、
程序路径及最终 EXE 哈希；官方 SDK 列 **22** 工具，中立 STATUS **730.8651ms**、
BLE encrypted/bonded/ready、未 ARM，真实手机局域网投屏 JPEG **99,169B** 返回成功。
这验证当前实际 Rust 服务与只读链路，仍不代替 Unicode 或非零 HID 验收。
证据：`apps/android-mcp-rust/build/windows/v44/actual-service-verified.json`、
`apps/android-mcp/build/rust-v44-real-neutral.json`；PID 仅是该次观察值，后续须动态核对。

## v43 驱动分发与不依赖系统光标的校准——主机 PASS，实物下载 FAIL，v43b 待验

2026-10-18：用户新增 Rust 操作台、assets 分区分发及平板校准反馈。好友的 **0/10** 表示
业务用例尚未执行，不能记作目标应用 FAIL 或 PASS。`CONFIGURING`、paused、PING 超时和点击
变拖动属于仪器链路问题；OEM Home 导航是否生效也必须从新画面判断，不能只凭 HID ACK。
本轮没有放宽 **1200ms ACK / 1500ms 安全截止**、重放输入或使用 ADB 业务输入/截图回退。

设置项和二维码页面改为 **驱动下载**。同一个板端页面按访问设备推荐 Android APK 或 Windows
EXE，并始终保留两个明确的平台链接；Windows 使用 `/qdd-desktop.exe`，Android 使用
`/qdd-remote.apk`。独立下载 worker 避免大文件占住注册/状态服务；并发 EXE 下载返回 503，
资源缺失、损坏或容量不符时拒绝提供文件，不修改分区表来迁就大小。页面仍是下载入口，
不能据此宣称手机安装或电脑运行成功。

点击/按下前按最近成功位移 ACK 的单调时间保证 **350ms** 静置，抵扣已经经过的时间，
可取消/暂停；不会给每次点击额外固定加 350ms，也不会重新发送位移或点击。
相同 `probe` 前后图返回两图和 `measurable:false` / `measurementAvailable:false`、
`reason:identical_images`，暂停且不发 `probeId`，禁止凭空填写光标坐标或猜测增益。

新版 APK 提供用户主动打开的 **指针校准** 页，接收真实鼠标 MotionEvent 的 rawX/rawY 并把
实际坐标标记绘进 MediaProjection；不依赖系统是否捕获鼠标光标。MCP 新增
`android_pointer_calibration {"phase":"auto","frameId":"..."}`，只读 `/pointer/calibration`
的 active/session/geometry/point 信息，不通过网络启动 App 或打开校准页。
显标小移动后静置 **550ms**，向屏幕中心探测默认 **96 HID counts**，只在同会话新 sequence、
两轴真实位移有效且未触边时计算 counts/pixel；完整 GET RTT 计入坐标年龄。失焦、旋转、过期、
没有事件或外部移动会暂停并保留已有校准。它不发送业务点击，加速度下的后续落点仍是估算。

- Build：**PASS，仅限已列产物**。根目录 typecheck/build 日志
  `apps/android-mcp/build/drivers-v43-{typecheck,build}.log`。Rust 最终 build
  **rust-447d9cad992b51c3**，EXE **1,892,352B**，SHA-256
  `93b72fd189944db6dcedd251ed7ceb74241b1e413566a16439115bf8cd301ecc`；固定目录
  `apps/android-mcp-rust/build/windows/v43/` 的 `manifest.json`、`validation.json` 和
  `exe-smoke.json`。原默认目录 EXE 因现有用户进程占用而保留，`QDD_RUST_OUTPUT_DIR` 支持独立
  版本目录；使用 stdio 的客户端须切换到新路径，不能把旧进程当新版。
  APK **53,727B**，SHA-256
  `d01126223e601678af72f42e31241d09b1e58c8a70ff6bb79e51a23811fd54d1`。
- Host tests：**PASS**。Node **562/562、零跳过**，日志
  `apps/android-mcp/build/drivers-v43-node-tests.log`；Rust check、**66/66** 单测、release 及
  官方 SDK 打包夹具 **18/18** 通过。覆盖静置红绿、取消前不按下、已静置点击不追加等待、
  相同图片无票据、auto 的失焦/旋转/旧事件/裁切/插入移动/取消边界，以及只读 GET 和传输年龄。
  EXE 夹具隔离于真实服务，`realDeviceInput:false`，不是真实平板精度或 BLE 性能。
- Assets：**PASS，格式/身份/容量专项**。`QDDDRV1` 资源为 **4KiB 头 + 原始 EXE**，
  **1,896,448B**，SHA-256
  `d08e880176f364b3a9e5f4460cd1ab08945929a4978785769d254d8147cc9cae`。
  COM6 / MAC **4c:11:ae:31:32:6c** 新鲜实读表 SHA-256
  `bd386c960f8b827e812dd238af37d469c319d7e9ecc2d7501d00296c46804a4f`，
  `assets @ 0x600000 / 0x200000`，剩余 **200,704B**。固件核对头、长度、SHA 与边界，
  不把 ZIP 能装下当作原始 EXE 能装下。证据 `apps/esp/build/driver-assets-v43.{bin,json}`、
  `com6-v43-{assets-verify.log,combined-flash-plan.json}`。
- Device tests：**FAIL，v43 第一版大文件下载/内存**。第一版完整门禁及归档通过，bundle
  `dd73c262a0ddb2f39fa51691ecf60d82060a4a892e2292e537356f2314faf9bc`；
  App **1,668,976B**，SHA-256
  `82899c73e9891db5471c108c49679f3a307b924006416f8c383d18c5fc0e1603`，匹配 ELF
  `a9f325a512482e7f35e3cf458c002111ffe9f6913e58207fe4e135fe45f880b3`。
  COM6 已核对身份/实际布局后只写 App `ota_0 @ 0x20000` 与上述 assets，写入哈希通过，
  保留 bootloader、分区表、otadata、NVS/配对、PHY、ota_1；没有 merged@0 或全片擦除。
  Android/Windows 推荐链接、APK 完整下载及其 SHA 通过；EXE 普通连续读取却在 **22.303s**
  截断为 **872,064 / 1,892,352B**，哈希不符。同期 UART OOM 累计 **398**、最小空闲堆
  **568B**。虽然 BLE 仍 ready，也必须判为内存/下载 FAIL。
  原 observer 只检查 BLE 的错误 PASS 谓词已更正；原始结果保存在
  `com6-v43-after-download-original.json`，更正结果为 `com6-v43-after-download.json`。
  证据：`apps/esp/build/{drivers-v43-full-gate.log,com6-v43-flash.log,driver-download-v43-device.json,exe-v43-continuous-device.json}`。
- v43b：**PENDING**。针对上述新实物证据复用校验/传输 staging、减少常驻 **2,048B**，
  并增加独立 `/api/download-status` 内存/发送阶段观察点；完整门禁正在运行，日志
  `apps/esp/build/drivers-v43b-full-gate.log`。新产物身份、刷入和完整连续下载结果待补，
  当前不能声称 v43b 已修复、下载已恢复或内存验收通过。
- Unverified：新 APK 尚未完成真机安装/校准页测量闭环；真实平板非零 HID、完整实体 UI、
  OEM Home、旧高频 LAN 时延根因和长期资源上界继续未验收。电脑实际服务切换及最终真机结果
  待补；未提交、push 或发布，保留所有历史记录和自动审批拒绝边界。

## v42 设置排序与下一页箭头——已更新 COM6

2026-10-18：设置顺序调整为 **无线网络 → 手机蓝牙配对 → 手机投屏下载 → 按键指南 →
重置设备 → 返回主界面**。常用项在第一页，重置位于第二页且仍默认取消、需再次确认。
第一页右侧空隙显示小 **↓**，仅表示下方还有选项；最后一页隐藏，返回第一页恢复。
箭头用 LVGL 三条线绘制，不依赖现有字库未覆盖的 U+2193，不增加字体资源。
菜单动作和各子页返回位置改为具名索引，避免排序后进入错误页面。

- Build：**PASS**，完整门禁及归档复验，日志 `apps/esp/build/settings-v42-full-gate.log`。
  归档 `apps/esp/build/firmware/983dbf511cf953ea8e52905814e62aeac46419b2151517514e449136f898c28a`，
  Full SHA-256 与目录名一致。App **1,666,320B**，SHA-256
  `3c6cba5a656ab30e0cb924ea6d37c61dd4ad6121f488db76745794cab39d2ddf`；匹配 ELF SHA-256
  `a92b03f01f03b1c81e244ef307502c9bf9de8b2d80807686b35606b4fcc81bc5`。
- Host tests：**PASS**。旧模型编译成功后语义红测 exit 3，新模型 exit 0；真实 LVGL 9.5 的
  menu/download/full/intro/pair/scan/guide **7 组**通过。覆盖排序、全部返回索引、3↔4 跨页及首尾循环、
  重置默认取消、箭头像素和隐藏后的背景清除。每页 100 次无变化刷新零 flush/分配稳定，
  下载 120 次切页稳定，24KiB LVGL 池峰值 **17,040B**。完整门禁保留既有平台跳过项。
  证据及渲染图：`apps/esp/build/settings-menu-regression/`；源码摘要 `settings-v42-source-identity.json`。
- Device tests：**PASS，仅限烧录/启动/连接恢复**。新鲜核对 COM6 / MAC **4c:11:ae:31:32:6c**
  及实际分区表 MD5，只写 `ota_0 @ 0x20000 / 0x2f0000`；写入哈希通过，擦除结束不含 `0x1b7000`。
  保留 bootloader、分区表、otadata、NVS/配对、PHY、assets、ota_1。
  **30.000 秒**只读观察六个回复，BLE **QDD-Passport-326E** 持续 encrypted/bonded/ready，
  未启用输入/未锁定，fault/OOM **0**。最早 Wi-Fi 样本尚在恢复，后续 DIAG up=1，最终独立查询确认
  **192.168.101.75:3333** 已连接。未发送 PING、PAIR、ARM 或业务输入，未保存原始串口，COM6 已关闭。
  证据：`apps/esp/build/com6-v42-{archive-verify.log,layout-read.log,partition-table.bin,flash-plan.json,flash.log,startup.json,final-link.json}`。
- Unverified：实物屏幕上的箭头/菜单与实体按键效果、扫码操作仍需实物观察；本轮主机渲染不代替实屏验收，
  也不扩大已有高频 LAN 与完整成品验收结论。未更改电脑服务/APK，未提交、push 或发布。

## v41 预点击标记与真实悬停——电脑已更新，真机专项 PASS

2026-10-18：新增只读 `android_preview_tap`。传入最新 `frameId`、坐标及可选 `coordinateSpace`，
从新采集的真实原画生成高对比模拟目标全图和 2× 局部图，中心保留底图。返回原图 `target`、
裁片 `crop`、`zoomTarget`、区分源图/标注图的 SHA 和可直接复用的 `tapArguments`。
它不要求校准或 ARM，也不发送 HID、抢占输入。源图与后续动作使用同一像素/normalized1000 转换，
渲染后重查本会话最新 frame、手机/旋转 epoch，并把渲染耗时计入原图 age；超过既有 3000ms 则拒绝。

`android_control` 新增 `hover`：按已测量比例定位真实鼠标、不按下按钮，并返回真实后图；
确认光标正确后再 `click`。旧鼠标按住状态会在定位前中立释放，避免沿定位路径拖动。
截图标记确认拟选择的 UI 目标，hover 检查真实 HID 落点，两者不混为一项精度证明。

- Build：**PASS**，根目录 typecheck/build。EXE build **3c8091bb77c3efd2c94d**，**95,678,464B**，
  SHA-256 `c7ab0b2c329afab7a835e286adb1c322ce3676f37958383363d5e244285b4414`；旧 v40 包
  已核验备份至 `build/windows/history/222be5b37c4e785e183b`。APK、v39 ESP 固件与设备数据未改。
- Host tests：**537/537 PASS，零跳过**；EXE **17/17 PASS**。涵盖 JPEG/PNG、坐标/放大逐像素
  一致、四角/窄图、中心保留、解压上限、只读无 HID/owner 接管、取消/并发新图/几何/age、
  hover 旧按键中立释放和旧控制轮隔离。纯 JS 编解码在独立 worker 中运行，最多一个 active、
  一个排队，5s 超时/取消终止；主线程定时器继续运行，取消排队者不会提前释放位置。
  单 EXE 在空 PATH/独立目录中验证内嵌 worker，不依赖外部 Node 文件。打包 fixture 不是真机性能。
  证据：`build/preclick-v41-{typecheck,build,host-tests,worker-tests,hover-input,exe-build,exe-tests}.log`。
- Device tests：**PASS，仅限此预点击流程**。官方 SDK 列 **22** 工具，真实一加 8 原画 **1080×2400**。
  未校准/未启用输入时预览 SAI 图标 (140,280)，**516ms** 返回全图及 **320×320** 局部图，
  crop=(60,200,160,160)、zoomTarget=(160,160)，input 仍 armed=false；图中标记位于预期图标内。
  复用 v40 对同一手机实测的 scale **1/1**，`hover` 含首次归零 **3363ms**，真实光标仍在该图标内。
  检查图片后 `click` **270ms**；首张后图仍是桌面，再只读 `wait` 观察到 SAI 已打开，未重放点击。
  随后 Home/只读等待恢复桌面，最终 encrypted/bonded/ready、armed/locked=false，诊断 exit **0**。
  运行时全部画面来自手机 App 内网、输入来自 ESP BLE。证据：`build/preclick-v41-live.json`、
  `preclick-v41-image-*.{png,jpg}`；标记局部图为 `preclick-v41-image-3.png`。
- 最终服务 PID **17268**，路径/哈希核对，监听 **0.0.0.0:8790**；LAN/loopback health **200**、
  未知路由 **404**，证据 `build/preclick-v41-final-service.json`。未提交/push/发布。

Unverified：自动控件识别、其它手机/加速设置下的落点精度、全 UI、高频 LAN 根因和长期资源上界。
本轮提供先看后点的工具及实物闭环，不宣称自动识别所有控件或完整成品通过。历史验收与审批边界保留。

## v40 MCP 两阶段鼠标校准——电脑已更新，真机专项 PASS

2026-10-18：新增 `android_pointer_calibration`。`probe` 自动释放输入、ARM、小幅显标，
返回测量前后两张新原画；`finish` 接收 AI 从图中读取的起终点，计算每像素 HID 计数，
不再移动。保留旧手动校准；相对移动、当前位置点击、键盘和滚轮仍无需校准。
会话、手机/旋转、输入轮次、实际派发 revision、过期及一次性记录均有检查。
允许只读截图/等待刷新画面，动作已完成但取图失败时不得盲目重放。

非整数比例的坐标操作现在保留实际整数 HID 报告对应的估算位置，避免反复丢弃位置后归零。
主机成本回归：1080×2400、scale 1.25，连续点按 (541,1201)、(542,1202)，第二次由旧路径
**40** 条报告降至 **3** 条，预定等待 **1800→150ms**；不含传输/手机时间，不是真机非整数比例性能证明。

- Build：**PASS**，根目录 typecheck/build。最终 EXE build **222be5b37c4e785e183b**，
  **94,448,128B**，SHA-256 `1352d1c02a00d16bbf44e08360b2e1f8325eb55995f3419a37d2b0c6e5e26c14`。
  旧产物与中间验证产物保存在 `build/windows/history/{c2042f779676b1fb0546,fb0935471db537163b4f}`。
- Host tests：**498/498 PASS，零跳过**；EXE **16/16 PASS**。覆盖两张原图/四方向、finish 零输入、
  跨会话/过期/几何/插入输入、旧取消轮隔离、非整数位置漂移及报告成本。HTTP 红绿证实并修正
  错误 finish 提前打断浏览器，以及缺参数被拒绝的会话仍可借用全局 armed 领取租约的问题。
  租约、会话关闭和丢失响应现统一读取真实 MCP owner，关闭被拒绝的借用者不影响原持有者。
  打包场景是独立 loopback fixture，不是真机性能。证据：`build/calibration-v40-*-{red,green}.log`、
  `calibration-v40-{typecheck,build,host-tests,exe-build,exe-tests}.log`。
- Device tests：**PASS，仅限最终包校准/连续点按专项**。最初 ESP 在设置中返回 `CONFIGURING`，
  没有绕过守护；用户用实体按键退出后恢复。最终包官方 SDK 列 **21** 工具，真实一加 8 App
  经内网提供 **1080×2400** 原图，输入经 COM6 对应板的 BLE。`probe` **1488ms**；图中圆心
  人工读为 (543,1203)→(447,1107)，`finish` **3ms**，scaleX/scaleY **1/1**。随后
  (541,1201)、(542,1202) 两次点击均 `actionCompleted/observedAfterAction=true`，**3878/444ms**，
  图片可见光标在请求中心附近。该短样本含首次归零与取图，不是旧版对比或独立像素误差测量。
  最终 BLE encrypted/bonded/ready，armed/locked=false；诊断脚本正常 exit 0。
  证据：`build/calibration-v40-final-live.json`、`calibration-v40-final-image-*.jpg`。
- 最终服务路径/哈希核对，PID **106560**、监听 **0.0.0.0:8790**，LAN/loopback health **200**、
  未知路由 **404**，证据 `build/calibration-v40-final-service.json`。APK 与 v39 ESP 固件未改。
  夜间 automation 已按上海 09:00 截止要求删除，保留服务与设备数据；未提交/push/发布。

Unverified：其它真机/非整数比例的加速及误差、完整实物 UI、高频 LAN 失败根因、长期资源上界。
校准仍为估算，本轮低频专项不等于完整成品验收。历史 v36 高频失败及 App 启动自动审批拒绝
边界继续保留，未重试或绕过被拒绝的启动动作。

## v39 设置重新打开安装二维码——已构建并更新 COM6

2026-10-18：设置新增 **手机投屏下载**，显示已有 APK 下载页的二维码、当前局域网 IP、
同网与浏览器下载提示；确认 **返回设置**，光标仍停留在下载项。离线时显示连接提示，
不自动打开无线扫描。该页面不改变引导完成标记、Wi-Fi、蓝牙配对、急停或 NVS。

- Build：**PASS**，完整固件门禁及归档复验。App **1,666,016B**，SHA-256
  `fcb04a400855a4847f1ac0a0d54164002d0464672766ed78243596cd3983ebde`；
  归档 `apps/esp/build/firmware/f0bada5e21afe55b44399881505e1213c4b9fc47cacbf460ed4a5ae1a0bdeb4d`，
  ELF SHA-256 `20bb40f39eb59dc717c47050ffe8d6e4d31c2c4429c65295503f43f48df2dc7e`。
- Host tests：**PASS**。模型红绿、完整真实 LVGL 渲染、字库/布局、同 IP 重入、IP 更新、离线隐藏 QR、
  返回光标和原退出/重置路径均通过；100 次相同页面刷新零 flush，120 次页面切换内存池稳定。
  保留完整门禁已有平台跳过项。证据：`apps/esp/build/settings-download-*.log`。
- Device tests：**PASS，仅限烧录/启动/连接恢复**。新鲜核对 COM6 / MAC **4c:11:ae:31:32:6c**
  和实际分区表后，仅写 `ota_0 @ 0x20000`；写入哈希校验通过、擦除结束不含 `0x1b7000`。
  保留 bootloader、分区表、otadata、NVS/配对、PHY、assets、ota_1。30 秒只读观察六个样本通过，
  地址仍 **192.168.101.75:3333**、BLE encrypted/bonded/ready，未启用输入，无 fault/OOM，COM6 已关闭。
  证据：`apps/esp/build/new-com6-v39-{layout-read.log,flash-plan.json,flash.log,startup.json}`。
- COM5 追加安装（2026-10-18 上海 09:53）：**Device tests PASS，仅限烧录与启动观察**。
  用户明确指定 COM5；新鲜核对 MAC **4c:11:ae:2f:a1:b8**、8MB ESP32-C3 和实际分区表 MD5，
  该板是 `factory @ 0x10000 / 0x7f0000`，与 COM6 的 OTA 布局不同。
  复验上方同一 v39 归档后仅写 **1,666,016B** App，写入哈希通过，擦除结束不含 `0x1a7000`；
  未擦除 bootloader、分区表、NVS/配对或 PHY。Build/Host tests 沿用该精确产物已有完整门禁，未重建。
  **30.015 秒**只读串口观察六个回复通过：Wi-Fi **192.168.100.167:3333**，
  **QDD-Passport-A1BA** 持续 encrypted/bonded/ready、未启用输入/未锁定，fault/OOM **0**。
  未发送 PING、PAIR、ARM 或业务输入，未保存原始串口，COM5 已关闭。
  证据：`apps/esp/build/com5-v39-{archive-verify.log,layout-read.log,partition-table.bin,layout.json,flash-plan.json,flash.log,startup.json}`。
  实体菜单/按键、扫码下载及该板真实画面与 HID 反馈闭环仍未验收；未改变电脑配置或服务。
- 电脑服务已恢复为实际 PID **91668**，EXE build **c2042f779676b1fb0546** 未改；官方 SDK
  **20** 工具、STATUS **5/5**、最大 **267ms**、七次 POST 全 SSE，LAN/loopback health **200**、未知路由 **404**。
  证据：`apps/android-mcp/build/mcp-v39-final-status.json`。

本轮另在上海 **08:36** 观察到真实一加 8 的投屏 App 已启动；未重试或绕过之前拒绝的启动动作。
原画 **1080×2400**、来源 UUID **1651863a-9f91-4d0c-b689-168a2c78fc62**；实际图片核对了
Home 返回桌面、相对鼠标移动及 Tab 焦点变化。19 次官方工具调用无错误，暂停/自动恢复及暂停后
legacy 移动拒绝通过。证据：`mcp-v39-live.json`、`mcp-v39-frame-*.jpg`、`mcp-v39-paused-rejection.json`。
浏览器点击画面进入、Esc 退出和四档画质切换通过，灰度实际可见，观察约 **13–16fps**。
仍出现一次真实 **ESP32 PING acknowledgement timed out**，没有因此宣称断连解决。

十秒低幅 WS 诊断首轮因 `sentAt <= Date.now()` 检查提前中止，**132** 发送/**128** 确认，
剩余输入停止且不重放；不是完整压力 PASS，也不能把该脚本断言当作产品断连。
原报告固定为 `ws-v39-real-smallmove-invalid-wall-clock.json`；诊断计时修正及离线校验通过，
尚未复跑，不改变生产代码或任何安全时限。同期 35 秒 UART 观察 35 样本无 fault/OOM/无线重连，
只保存白名单；header-only Npcap 未保存 payload、未提升权限。

Unverified：新下载页的实体按键/实际屏幕/扫码操作、完整实物 UI、当前固件高频 LAN 门禁、
持续输入稳定性与长期内存上界。真实画面及上述最小 HID 反馈已有证据，但**完整成品仍未通过验收**。

## v38 空闲观察连接恢复——真机专项 PASS，完整成品仍未通过验收

2026-10-18：新实物证据闭环确认旧连接占槽机制：绑定来源的新 TCP 连接握手成功并发送 STATUS，
随后收到 FIN/RST、没有回复，板端 TCP epoch/RX/TX 计数仍未改变；持有的沉默观察连接拒绝了新连接。
旧 socket 最初为何沉默仍未知，不据此认定无线根因。证据：
`apps/android-mcp/build/heartbeat-status-loss-tcp.json`、
`heartbeat-status-loss-capture/npcap-v30-tcp-headers.json`、
`apps/esp/build/heartbeat-status-loss-uart-before-tcp.json`。

此次五文件固件修复只允许通过私网校验、非阻塞设置成功的新 peer，在 TCP **不持有控制权**且
旧连接自身 accept/成功 RX 活动年龄严格超过原 **1500ms** 时替换旧观察者。TCP owner、活跃观察者、
无效新 peer、时钟回退均受保护；空闲本身不会主动踢线。新 epoch 仍先清理旧半包，再读取新连接。
没有改变时限、无线参数、输入重放或 NVS 策略；主控及独立审查没有阻断项。

| 本轮检查 | 结果与边界 |
| --- | --- |
| 红绿回归与完整固件门禁 | 已先复现替换断言失败，修复后 **PASS**：socket mock 全集、**13/13** 传输/线路契约，以及完整 static、firmware、合并镜像与归档校验。保留既有静态平台跳过项，不宣称 ESP 零跳过。证据：`apps/esp/build/tcp-observer-v38-{red,green,contract,full-gate}.log` |
| 精确 App-only 烧录 | 新鲜读取核对 COM6 / MAC **4c:11:ae:31:32:6c** 及实际分区表，已有 `ota_0` 为 **0x20000 / 0x2f0000**；仅在 **0x20000** 写入 **1,665,424B** App，擦除范围截至不含 **0x1b7000**，写入哈希校验通过。保留 bootloader、分区表、OTA 元数据、NVS/配对、PHY、assets、`ota_1`；没有整片擦除或从零烧入合并镜像。证据：`apps/esp/build/new-com6-v38-{layout-read.log,partition-table.bin,flash-plan.json,flash.log}` |
| 启动与配对保留 | **30.015 秒**只读观察 **PASS**：观察开始后 **1.047 秒** Wi-Fi 已配置/连接，地址 **192.168.101.75:3333**；**3.047 秒** BLE 未连接，**15.047 秒**及 **25.062 秒**已 encrypted/bonded/ready、未启用输入/未锁定，无需重新配对。这些是观察起点后的采样时间，不是精确开机恢复时刻。无线事件保持 `[1,0,0,0,-1,-1]`，fault/OOM **0**、报告的内部堆最低空闲值 **43,552B**。COM6 已关闭，未保存原始串口。证据：`apps/esp/build/new-com6-v38-startup.json` |
| 真实中立 TCP 恢复场景 | **PASS**：超过 1500ms 的空闲 observer 可被替换；活跃 observer 拒绝竞争连接后原 STATUS 仍成功；中立 PING owner 持续响应且拒绝竞争连接。共 **11** 次成功回复、最大 **394ms**，ACK 仍 **1200ms**。仅 STATUS/PING，没有 ARM/非零 HID，全部 socket 在 `finally` 关闭。证据：`apps/android-mcp/build/tcp-observer-v38-device.json` |
| 恢复实际 EXE / 官方 SDK | 核对原 PID **74036** 后 POST quit **204** 并正常退出，隔离设备验收；恢复未改动的 v37 EXE，核对 PID **90416**、监听 **0.0.0.0:8790**，局域网/loopback health **200**、未知路由 **404**。官方 SDK 列 **20** 工具、**七次** POST 全 SSE、STATUS **5/5**、最大 **177ms**，全部 BLE ready、未启用输入/未锁定。证据：`apps/android-mcp/build/mcp-v38-final-status.json`。既有电脑 **454/454 + 15/15** 门禁没有无变化重跑 |

当前固件归档/合并镜像 SHA-256：
`cb35c2df6d5996efd1c2f4bc7a4f0f1c7dd1ce7cb805b1131e92fb59830fdd74`；
App **1,665,424B**，SHA-256 `a608f6b783602779e3c18c175b43f66e6aad3e8774d07513d0d312d9701de734`；
ELF SHA-256 `430b2e1d096a2dbf409d4abe90eb77258d2cb1876568d16c8e15bdb44b4a7961`。
实际保留的分区表 SHA-256：
`bd386c960f8b827e812dd238af37d469c319d7e9ecc2d7501d00296c46804a4f`。
没有捕获 boot ELF 哈希行；安装身份依据已验证产物及烧录写入校验绑定，不声称实机启动日志哈希匹配。

EXE 仍为 build **c2042f779676b1fb0546**，SHA-256
`b0ec182895000c740e4f3472a4db848b36c539ffd677ad0ea239cb6fe30cd701`；APK 未改。
投屏 App 启动审批边界不变，没有重试或换接口启动。
Build：**PASS**；Host tests：**PASS**；Device tests：**PASS，仅限上述连接恢复专项**。
完整成品尚未通过验收。Unverified：当前固件直接 20ms/1200ms 高频门禁、长期内存上界、
真实 MediaProjection/内网画面、非零 HID 操作反馈及完整手机控制闭环。v36 高频失败仍待解决，
本次中立/低频场景通过不等于该门禁已经通过。

## v37 MCP 已完成请求资源释放专项——回归与十五分钟模拟长测 PASS

2026-10-18：已用实际 HTTP 服务及官方 SDK 客户端复现 SDK **1.32.1** 的资源生命周期缺陷：
`enableJsonResponse: true` 时，已完成 JSON POST 仍残留在 `_streamMapping`，直到会话关闭。
初始化后执行 **100** 次 `listTools`，残留 **102** 个 stream 条目，其中包括一个独立 GET。
证据：`apps/android-mcp/build/mcp-stream-retention-red.log`。该回归没有截图或 HID 输入。

现在使用 `enableJsonResponse: false`，走 SDK 标准 POST SSE 响应；现有操作台本来已兼容 SSE。
生产代码没有读取 SDK 私有字段，也没有升级依赖。只有资源回归检查内部映射：已完成 POST
残留归零，最多保留一个独立 GET，请求到 stream/response 映射为零。
最终专项记录明确观察到 **0** 个 POST、**1** 个独立 GET，且验证唯一剩余项确为 GET：
`apps/android-mcp/build/mcp-stream-retention-resource-final.log`。
四处原始取消测试把 `response.arrayBuffer()` 纳入请求生命周期，保留取消及新 ARM 隔离语义。

| 本轮检查 | 结果与边界 |
| --- | --- |
| 软件门禁 | **PASS**：资源回归及 HTTP/browser **122/122**；typecheck/build；完整主机 **454/454**、零跳过；EXE **15/15**。证据：`apps/android-mcp/build/mcp-stream-retention-{green,typecheck,build,host-tests,exe-build,exe-tests}.log` |
| 实际 EXE 服务 / 官方 SDK | **PASS**：核对程序路径及 PID **74036**，监听 **0.0.0.0:8790**；局域网/loopback health **200**、未知路由 **404**。实际 **七次** POST 均为 `text/event-stream`；**20** 个工具、STATUS **5/5**、最大 **178ms**；每个状态均 connected/encrypted/bonded/ready，未启用输入、未锁定，没有真实输入。证据：`apps/android-mcp/build/mcp-v37-final-status.json` |
| 旧包两小时资源观察 | **已完成——功能/清理 PASS**，**7,200,277ms**，build **ba710a04fbdc29d19fd2**、旧 JSON 响应实现。子进程 PID **65376** exit **0**、未强制结束，残留流/socket 为零、模拟服务器关闭、临时目录删除。内存增长边界详见 v35。固定证据：`apps/android-mcp/build/windows/exe-soak-2h.json`。不是 v37 新包或真实 LAN/BLE 验证 |
| 新包十五分钟模拟观察 | **已完成——功能/清理 PASS**，**900,386ms**，build **c2042f779676b1fb0546**：**27,021** 帧 / **30.0104480674fps**、图像数据 **4,150,425,600B**、最大帧间隔 **57.5429ms**；**37,864** 次模拟 ACK，中位 **0.5052ms**、p95 **1.0944ms**、最大 **22.3903ms**；**860** 次只读观察、**七次**原图截图。子进程 PID **88900** exit **0**、未强制结束、临时目录删除、流/socket **0**、模拟服务器不再监听，`realDeviceInput=false`。固定证据：`apps/android-mcp/build/windows/exe-soak-v37-15m.json`；日志：`exe-soak-v37-15m.log`。属于 loopback 模拟验证，不是真实 LAN/BLE 验收 |

v37 模拟长测覆盖四档预览不抢占输入所有者、MCP 原图采集、45 秒 active 四 report burst、
15 秒 idle、WebSocket 关闭释放后新会话恢复，以及 ACK 前 TCP 丢失不重放输入。
报告完成时间 **2026-10-17T18:41:19.930Z**，SHA-256 为
`d4caa0868880fdff428307bd450de770fde681b2b0d4e67cc4536c22daa4185f`。

**32** 次内存采样中，**61,035ms** 预热样本的 private bytes / working set 为
**82,538,496 / 105,852,928B**，**901,473ms** 结束时为 **149,725,184 / 157,163,520B**，
增量 **67,186,688 / 51,310,592B**，结束值也是采样峰值。有限观察仍显示增长，
不能定性泄漏、无泄漏或长期资源上界；不能把与旧十五分钟/两小时结果的所有差异都归因于 SDK 修复。
独立且确定的 stream 映射红绿回归仍是该具体缺陷及清理修复的证据。

当前 EXE：`apps/android-mcp/build/windows/设备操作台.exe`，buildId **c2042f779676b1fb0546**，
**94,434,816B**，SHA-256 `b0ec182895000c740e4f3472a4db848b36c539ffd677ad0ea239cb6fe30cd701`。
核对原实际 PID **84880**、路径及哈希后，POST `/desktop/quit` 返回 **204** 并优雅退出；
已验证的旧 EXE 与 manifest 保留在
`apps/android-mcp/build/windows/history/ba710a04fbdc29d19fd2`。

stream 残留缺陷已经证实，但不能把此前 Private Bytes/working set 的全部增长都归因于它。
APK/ESP 产物不变，手机 App 仍未启动，内网投屏源返回 `ECONNREFUSED`；v36 的启动审核边界不变。
该 HTTP 资源修复不证明直接局域网高压失败已解决。
Build：**PASS**；Host tests：**PASS**；Device tests：总体 **FAIL**，短时实际 EXE 只读 MCP 与十五分钟模拟长测通过。
Unverified：长期资源行为、真实内网画面/MediaProjection、
非零 HID 及完整手机操作反馈闭环。

## v36 一加新授权与配对——只读 BLE/MCP 专项 PASS，操作闭环仍未验收

2026-10-18：用户新明确授权 ADB 测试后继续准备。一加 8 已解锁并连接电脑所在 Wi-Fi，
本记录不保存凭据。按新授权用 ADB 打开/配置投屏 App 仍被审核拒绝，返回 `blocked by policy`，
没有通过 UI 或深链替代启动。另一个独立动作——打开安卓系统蓝牙设置——获准执行。
首次准备脚本耗时过长，错过约 30 秒的安全挑战；这属于准备失误，不认定为固件缺陷。
调整扫描刷新、数字 keyevent 输入及 `menu_save` 确认后，**QDD-Passport-326E** 成功配对，
保留原 **QDD-Passport-A1BA** bond。证据：`apps/esp/build/oneplus-pairing-result.json`。

新板本轮共重启**两次**：此前启动对照、此次配对后持久化检查；用只读 `chip_id` 核对 MAC 后
执行 `hard_reset`。没有刷入/修改固件、擦除或清空 NVS，
继续使用 v35 已验证产物。ADB 仅用于准备/诊断，运行时仍由内网投屏 App 提供画面、ESP 提供 HID。
本轮没有发送 ARM 或非零 HID 输入。

| 新增检查 | 结果与边界 |
| --- | --- |
| 配对后 BLE 串口观察 | **PASS**，**60.032 秒**、**60/60** STATUS 均 connected/encrypted/bonded/ready，未启用输入、未锁定。7 次无线诊断均 `up=1`、事件计数未变、TCP epoch **1**、OOM/fault/error **0**，采样可用内部堆最低 **36,472B**。协议未暴露 BLE link epoch。结束后关闭 COM6；未保存原始串口或 passkey 字段。证据：`apps/esp/build/oneplus-bonded-stability.json` |
| 实际 EXE / 官方 SDK 只读查询 | **PASS**：**20** 个工具、STATUS **5/5**，所有 payload 均 connected/encrypted/bonded/ready，最大 **277ms**。证据：`apps/android-mcp/build/mcp-oneplus-bonded-status.json` |
| 实际 EXE / 官方 SDK 排队 STATUS 负载 | 该 API 场景 **PASS**：约 **25 秒**、**221/221**、全部 ready，包含并发队列的最大调用延迟 **2,187ms**。保持最多四条并发、目标调度 20ms，但实际仅约 **8.8 次/秒**。证据：`apps/android-mcp/build/mcp-oneplus-status-stress.json`。不能当作直接 TCP 20ms/四条未确认/**1200ms ACK** 门禁通过，也不能宣称最大延迟已解决 |
| 手机发起的网络对照 | 手机→电脑 **15/15**，最小/平均/最大 **6.020/22.827/43.425ms**；手机→ESP **14/15**，**12.096/80.992/356.436ms**。电脑/手机使用同一 5GHz AP，ESP 仍在信道 **6**。证据：`apps/android-mcp/build/oneplus-network-crosscheck.json`。不能唯一定位 AP、电脑或 ESP 原因 |
| 重启后配对持久化/自动恢复 | **30 秒**观察内 **PASS**：**3.16 秒**样本 BLE 未连接；**6.19 秒** Wi-Fi 已恢复 `up=1`、信道 **6**、RSSI **−62dBm**；**25.12 秒**样本前 BLE 已 connected/encrypted/bonded/ready，`pairingOpen/passkeyVisible=false`，无需新 PIN。采样不能给出更精确的 BLE 恢复时刻。无 fault/OOM。证据：`apps/esp/build/oneplus-bonded-reboot-startup.json`。原 EXE 不重启即完成官方 SDK STATUS **5/5**、最大 **582ms**：`apps/android-mcp/build/mcp-oneplus-reboot-recovery.json` |
| BLE 已配对条件下的直接 TCP 门禁 | 原目标 20ms / 最多四条未确认 / **1200ms ACK** 仍 **FAIL**：**18.207 秒**、发送 **245** / 最终收到 **244**；STATUS 100241 在 **16,994ms** 超时、等待 **1,211ms**，最终最大 RTT **1,969ms**。证据：`apps/android-mcp/build/tcp-status-stress-oneplus-bonded.json`。同期 UART **40 秒 / 71** 样本无 fault/error/OOM，采样可用内部堆最低 **36,708B**，无线始终 up、事件计数未变；证据：`apps/esp/build/oneplus-bonded-direct-status-diagnostics.json`。最终 errno **104** / 关闭原因 **4** 是电脑测试关闭后的接收错误，不能据此认定固件主动掉线或初始超时由某一传输方向导致 |
| 恢复实际 EXE / 最终官方 SDK | 核对原 PID **56384** 的路径/版本后，POST quit 返回 **204**，隔离直接 TCP 测试；随后恢复同一 EXE，已核对 PID **84880**、监听 **0.0.0.0:8790**。最终 SDK 列出 **20** 个工具、STATUS **5/5**、最大 **280ms**，五个 payload 均 connected/encrypted/bonded/ready，未启用输入、未锁定。证据：`apps/android-mcp/build/mcp-oneplus-final-status.json` |

MCP 负载报告的 UTC 窗口为 **16:32:50.822–16:33:16.343**，初始化后计时 **25,480ms**；
UART 窗口为 **16:32:55.264–16:33:55.326**。负载约提前 **4.4 秒**开始，串口只覆盖其后段约
**21 秒**，没有完整覆盖全部 25 秒。`sentMs` 以独立 performance 时点计时，上述为时间边界，
不伪造精确包超时。此前五次 SDK 查询也不在该串口窗口内。

Build：**PASS**；Host tests：**PASS**，沿用未改动的 v35 产物及 **453/453 + 15/15** 结果，
没有重复构建或运行。Device tests：总体 **FAIL**——最新只读 BLE/MCP 及配对持久化专项通过，
但本轮在 BLE 已配对条件下直接高频局域网门禁再次失败。投屏 App 仍无进程。
Unverified：真实 MediaProjection 与内网画面、
BLE 输入/操作反馈、全部实物 UI 流程及完整端到端控制。旧包两小时资源观察已完成，功能/清理 PASS；
增长边界见 v35，不代表 v37 或真机性能。

## v35 夜间全面对抗迭代——软件门禁 PASS，真机局域网压力仍 FAIL

2026-10-18：本轮检查电脑服务/EXE、手机 APK 和控制器固件。下列产物身份替代此前记录中的
“当前版本”，原章节保留为历史证据。本轮真机验收结论为 **FAIL**，因为局域网压力仍失败；
下列通过项不代表远控成品已经通过验收。

已修复有证据的以下软件问题：

- 电脑端：设置/重启并发抢占、旧取消误停新 ARM、批量请求/重复 ID、串口写入期间就绪状态失效、
  关闭过程中再次重连；操作台请求有界等待、保存互斥，并覆盖矮视口及键盘激活。
- APK：停止立即撤销采集，资源清理期间禁止新授权重开；用会话代次隔离旧回调及旧资源完成事件。
  生命周期/授权主机回归覆盖通知拒绝、Activity 重建及原有服务启动等待的恢复。
- ESP：从电脑只读注册的新鲜状态反映连接，且不伪造控制授权；已完成引导在手机停止投屏时如实提示，
  不再返回扫码步骤。SSID 按实际标签宽度显示，静止二维码页面避免重复刷新，下载页使用暗色卡片。
  这些展示修复没有修改无线或安全参数。

| 本轮检查 | 结果与边界 |
| --- | --- |
| 电脑构建与主机门禁 | **PASS**：typecheck/build；主机 **453/453**、零跳过；EXE **15/15** 场景，`realDeviceInput=false`。证据：`apps/android-mcp/build/overnight-{typecheck,build,host-tests,exe-tests}.log` |
| EXE 两分钟模拟设备长测 | **PASS**，120,085ms：**3,613** 帧 / **30.0869fps**、**4,540** 次模拟 ACK，中位 **0.6185ms**、p95 **1.3781ms**、最大 **16.0813ms**。覆盖连续画面、空闲/重连、ACK 前连接丢失不重放输入，以及预览档位与原图采集。这是 localhost 模拟设备，不能当作手机/BLE 性能。证据：`apps/android-mcp/build/windows/exe-soak-2m.json` |
| EXE 十五分钟模拟设备长测 | **PASS**，**900,250ms**：**27,021** 帧 / **30.01499fps**、**38,000** 次模拟 ACK，中位 **0.5942ms**、p95 **1.5007ms**、最大 **108.3172ms**；**862** 次只读观察查询。子进程 exit **0**、未强制结束、残留手机流/ESP socket 均为 **0**、模拟服务器已关闭、临时目录已删除。这是 loopback 模拟验证，不是手机/BLE 性能。固定证据：`apps/android-mcp/build/windows/exe-soak-15m.json` |
| 两小时资源观察 | **已完成——功能/清理 PASS**，**7,200,277ms**：**216,018** 帧 / **30.0013456957fps**、图像数据 **33,180,364,800B**、最大帧间隔 **58.8444ms**；**306,556** 次模拟 ACK，中位 **0.4793ms**、p95 **0.9954ms**、最大 **27.6363ms**，**6,950** 次只读观察。子进程 exit **0**、未强制结束、流/socket **0**、模拟服务器关闭、临时目录删除。属于旧 **ba710a04fbdc29d19fd2** JSON 响应版本，不是 v37 或真实 LAN/BLE 验证。固定证据：`apps/android-mcp/build/windows/exe-soak-2h.json`；日志：`exe-soak-2h.log` |
| 实际 EXE 服务 | 已核对 PID **56384** 及程序路径，真实监听 **0.0.0.0:8790**；局域网、loopback `/health` 均 **200** 且匹配版本，未知路由 **404**。实际浏览器显示“操作台已连接”“QDD-Passport-326E”，手机未投屏/未配对提示清楚，没有真实手机画面 |
| 官方 MCP 连接实际控制板 | 只读 **PASS**：列出 **20** 个工具、STATUS **5/5**、最大 **872ms**，没有输入。证据：`apps/android-mcp/build/mcp-overnight-final-status.json`。不代表高频连接或控制通过 |
| EXE 的 MCP 请求格式 | **PASS**：批量 `tools/list` POST 返回 **400**，准确提示 `Send one MCP request per HTTP POST.`；同一官方 SDK 会话随后成功列出 **20** 个工具，没有输入。证据：`apps/android-mcp/build/mcp-overnight-wire.json` |
| 手机离线时的 MCP 行为 | **2,576ms** 返回预期错误，`isError=true`、图片 **0**，服务 health 仍 **200**。证据：`apps/android-mcp/build/mcp-overnight-phone-offline.json`。仅证明错误处理通过，不是手机截图通过 |
| APK 构建/安装 | 构建、签名及完整 host 检查 **PASS**，其中生命周期 **9** 项、授权 **16** 项。已拉取安装后的 base APK，SHA-256 与当前构建一致。证据：`apps/android-screen/build/overnight-apk-{build,tests}.log`、`build/manifest.json`、`build/overnight-installed-hash.json` |
| ESP 构建/渲染门禁 | 完整固件门禁与归档校验 **PASS**。主机渲染覆盖实际字体/布局、引导跳过、配对反馈、扫描反馈及静止刷新；不变二维码刷新为 **0** 次 flush。24KiB LVGL 池剩余 **6,816B**、最大块 **6,432B**、峰值使用 **17,112B**。ESP 静态工具仍有已记录的平台跳过项；上方零跳过仅指电脑测试。证据：`apps/esp/build/overnight-final-gate.log`、`adversarial-esp-static-final.log`、`adversarial-ui-final.log` |
| ESP 烧录/启动 | COM6，MAC **4c:11:ae:31:32:6c**，仅向已有 `ota_0` 的 **0x20000** 写入 App，写入哈希校验通过。保留 NVS、配对、分区表、bootloader、OTA 元数据、PHY 及 assets。**30 秒**启动观察无 fault/OOM，但出现 **reason 8** 断开后重连，不能当作全程无断连。证据：`apps/esp/build/new-com6-overnight-{flash-plan.json,flash.log,startup.json}` |
| USB 中立压力 | 相同目标 20ms / 最多四条未确认 / 1200ms 时限，**25 秒**、**800/800**、最大 **32ms**，**PASS**。此前 v30 对照为 **798/798**、同样最大 **32ms**，均未发送真实输入。证据：`apps/esp/build/usb-neutral-stress-overnight.json` |
| 控制板下载页/API | HTTP **200**、暗色卡片页面、内嵌 APK **53,730B** 且当前 SHA-256 匹配。证据：`apps/android-mcp/build/board-overnight-http.json`。该电脑侧检查不代表手机完成下载或安装 |

十五分钟长测共采集 **32** 次进程内存样本。**63,141ms** 预热样本的 private bytes / working set
为 **99,082,240 / 123,211,776B**，结束时为 **189,009,920 / 162,271,232B**，
增量 **89,927,680 / 39,059,456B**。约 **873 秒** private bytes 回落到 **105,164,800B**，
约 **903 秒** 又出现新峰；目前不据此定性内存泄漏，也不宣称内存已有稳定上界。
十五分钟固定报告 SHA-256 为
`ab564cf3664a8061150d5fbe18a8b7941e28d0c25b379fdfffe071c39cd6d267`。

随后两小时观察已完成，报告时间 **2026-10-17T18:19:45.980Z**，保留 **241** 次内存采样。
**61,083ms** 预热样本的 private bytes / working set 为 **78,479,360 / 102,002,688B**，
**7,201,402ms** 结束时为 **298,536,960 / 203,026,432B**，增量 **220,057,600 / 101,023,744B**。
结束值也是采样峰值，中间有回落。功能与清理通过，但该增长不能证明长期上界或资源稳定，
也不能将全部增长归因于后续已确认的 SDK stream 残留缺陷。两小时固定报告 SHA-256 为
`5e1fb9bca2ad2db178cb511b1fa3e6e5bbe433b80777860a8dd3e0f50e887172`。

当前 EXE：`apps/android-mcp/build/windows/设备操作台.exe`，buildId
`ba710a04fbdc29d19fd2`，**94,434,816B**，SHA-256
`de46ef950dc349f1550f6798f77f3a41c7ec48e7a731c05c2dcf0d030cb8d8ec`。
当前 APK：`apps/android-screen/build/qdd-android-screen-debug.apk`，**53,730B**，SHA-256
`857e803d51f2bba359b85ee3b4898274040c1aff436f9e6fba3ee7f643294940`。
当前固件归档/合并镜像 SHA-256：
`4d6e8d68f2c50ec7669d48d057bbdf8919db7740a6e28c39eabe9624233c3220`；
App **1,665,280B**，SHA-256 `d281ec238dd13c8e59dcd74d188014759a75203f0a6e3bf6fed6cf2de6ee0027`；
ELF SHA-256 `852803b7b82c58bfde5fcaa0d75f977e1f685c7e702a80f3977944c7c53fc9a9`。
归档里的 factory 合并镜像**没有**覆盖烧录到设备已有的 OTA 布局。

真机局域网压力在原有目标间隔 **20ms**、最多 **四条** 未确认请求、ACK 时限 **1200ms** 下仍 **FAIL**：

- PING：总计 **13.751 秒**，发出 **261** 条命令（260 条 PING、1 条清理 RELEASE），收到 **259** 条
  PING 回复。100256 在 **12,541ms** 超时、等待 **1,226ms**；最终收到的最大 RTT 为 **1,468ms**，
  **13,051ms** 出现 peer END。证据：`apps/android-mcp/build/tcp-neutral-stress-overnight.json`、
  `npcap-overnight-stress-tcp-headers.json`；同期 UART
  `apps/esp/build/tcp-overnight-stress-diagnostics.json` 为 **40 秒 / 70** 样本，无 fault/OOM，
  采样可用内部堆最低 **36,912B**。
- 此次首个失败与 v34 初始收包缺口不同：约 **11,598ms** 时，UART 已累计接收
  **5,439B = 259 × 21**、socket 接受整写 **38,332B = 259 × 148**，
  其中 100256–100258 均在电脑时限前写出，ESP TCP ACK 也已确认这些命令。
  但对应回复首次出现在电脑为 **12,679 / 12,847 / 12,852ms**，因此首个超时包括应用整写成功后的
  回包交付延迟。随后 100259 另有入站缺口，重传后 ESP ACK 仍未推进。
  最终 TCP 为外部/安全关闭原因 **1**，与所有权看门狗收尾一致；该窗口无线事件计数未变。
  socket 整写不证明无线送达，也不能唯一定位根因。
- STATUS-only 加低频 ICMP：总计 **6.689 秒**，发送 **130**、最终收到 **130**，仍 **FAIL**：
  STATUS 100126 等待 **1,215ms**，在 **6,378ms** 超时；最终最大 RTT **1,473ms**。
  ICMP **25 包 / 23 成功**，成功 RTT **15–437ms**，另两次状态 **11010** 超时，首次与 STATUS
  缺口重叠。仅说明非控制协议也存在延迟，不能唯一定位 AP、电脑或 ESP 的原因；
  低频诊断不属于等价控制压力通过。证据：`apps/android-mcp/build/tcp-status-stress-overnight-icmp.json`、
  `icmp-overnight-probe.json`、`npcap-overnight-status-icmp-tcp-headers.json`；同期 UART
  `apps/esp/build/tcp-overnight-status-icmp-diagnostics.json` 为 **40 秒 / 71** 样本、无 fault/OOM，
  采样可用内部堆最低 **37,100B**；抓包 **45 秒**。

APK 安装后 `pidof` 仍未发现手机 App 进程。在用户最新明确授权后再次尝试 ADB 打开 App，
仍被自动审核拒绝，返回 `blocked by policy`，没有换接口绕过；未验证新 MediaProjection 会话。
控制 ACK **1200ms**、WebSocket **1500ms**、PING **300ms**、固件看门狗 **1500ms** 均不变，
没有重放输入、整片擦除或 Git 发布。

Build：**PASS**；Host tests：**PASS**；Device tests：**FAIL**——产物安装、USB 中立压力、HTTP 及
短时只读 MCP 通过，但真机高频局域网压力失败。Unverified：恢复手机投屏、真实 BLE 配对、
非零输入、全部实物 UI 流程、完整端到端控制。
软件与模拟设备通过不能替代上述检查，也不能宣称成品已经稳定完成；已结束两小时观察的内存增长边界如上保留。

## v34 远控排队修复——软件检查通过，高频局域网传输仍 FAIL

2026-10-17：红测 `apps/android-mcp/build/remote-status-barrier-red.log` 确认电脑侧存在截止时间问题：
独占 STATUS 等待约 **908ms**，随后合法的 MOVE ACK 等待约 **914ms**，两者排队累计超过原有
**1500ms** WebSocket 报告时限，尽管各自 ACK 未超时。现在控制中的 STATUS 优先读取当前连接
近期已经确认的状态，不再插入阻塞输入的线路查询。快路仅在连接 ready/open、没有传输故障、
控制轮次一致、回复顺序有效且单调时钟年龄不超过原 ACK 时限时生效；新 ARM 一经预约，
便在其准备 PING 前禁用旧快照。状态过期或不可用时仍走普通 STATUS 请求。
另有 `remote-status-arm-reservation-red.log`、`remote-status-final-focused-tests.log` 作为证据。

WebSocket 时限仍为 **1500ms**，控制 ACK **1200ms**、PING 间隔 **300ms**、固件看门狗 **1500ms**。
没有重放输入、放宽时限或修改固件；板子仍运行下方记录的已恢复 **v30 / RX4** App。

| 本轮检查 | 结果与边界 |
| --- | --- |
| 电脑门禁 | **PASS**：typecheck/build；主机 **439/439**，零跳过；EXE **15/15** 场景，`realDeviceInput=false`。证据：`apps/android-mcp/build/queue-v34-{typecheck,build,host-tests,exe-tests}.log`、`build/windows/exe-smoke.json` |
| 最终 EXE / 官方 MCP | buildId **ce2ac5b7b7b36f690738**，已核对 PID **74108**，监听 **0.0.0.0:8790**；`/health` 匹配当前 build/PID，未知路由返回 **404**。官方 SDK 列出 **20** 个工具，真实 `android_hid_status` **5/5** 通过，最大 **366ms**。证据：`apps/android-mcp/build/mcp-v34-final-status.json`。短时间只读检查不代表手机输入通过 |
| STATUS-only 真机压力 | 不发送 PING、不取得所有权仍 **FAIL**：目标间隔 **20ms**、最多 **四条** 未确认请求、原 **1200ms** 时限；发送 **12**、收到 **8**。STATUS 100008 在 **2,152ms** 超时，等待 **1,212ms**，总计 **3,356ms**。证据：`apps/android-mcp/build/tcp-status-stress-v34.json` |
| 同期诊断 | Npcap 30 秒，UART 40 秒 / **70** 样本；OOM **0**、`faults=[]`，采样可用内部堆最低 **39,104B**。证据：`apps/android-mcp/build/npcap-v34-status-stress-tcp-headers.json`、`apps/esp/build/tcp-v34-status-stress-diagnostics.json` |

最后可见的 ESP 回复为约 **1116ms** 的 STATUS 100007，TCP ACK 为 `2330855664`，
接收窗口仍有 **5576B**。后续 STATUS 字节重传，该抓取窗口中没有再收到 ESP 包；
电脑约 **3357ms** 发出 FIN。没有 PING 租约也复现接收缺口，因此不能将此前失败唯一归因于租约到期，
但无线、驱动或网络中的具体根因仍未唯一定位。

UART 窗口随后记录到真实的信标超时：首次样本在 **19,984ms**（事件年龄 148ms），
**22,781ms** 样本出现 Wi-Fi 断开 **reason 200**、`up=0`；**26,250ms** 已自动重连，
信道 **6**、RSSI **−63dBm**，此前为信道 **11**、约 **−76/−74dBm**。
这些后续事件均晚于初始 STATUS 失败，不能倒推为初始缺口的唯一原因。
最终 TCP 关闭原因 **2 / NETWORK** 属于后续网络失效，与 v31/v32 的外部/安全关闭不同。
没有证据表明是 App 代码主动断网；保留既有全信道扫描、按信号选择的连接逻辑，
没有继续修改缓冲、RTO、看门狗或选网设置。

当前 EXE：`apps/android-mcp/build/windows/设备操作台.exe`，**94,431,232B**，
SHA-256 `7c6827a15e9e24e4df2608bc4b41e1339a056a9edf673fd51fe9783f4a321ebf`。
最后只读 ADB `pidof cn.qdd.screenbridge` 仍返回 exit 1、没有进程。
手机仍需手动打开 App 并确认系统投屏授权；此前 ADB 打开/配置命令被审核拒绝，返回
`blocked by policy`，没有换接口绕过。下方 v33 手机诊断仍是当前验收边界。

Build：**PASS**；Host tests：**PASS**；Device tests：**PARTIAL——最终只读 MCP PASS，
高频 STATUS-only 传输 FAIL**。Unverified：恢复投屏、真实 BLE 配对、非零输入及完整端到端控制。
模拟设备的排队回归通过不能替代上述真机检查，不能宣称远控成品已稳定完成。

## v31–v33 对抗检查——只读 MCP 通过，实际控制所需的传输压力仍 FAIL

2026-10-17：已修复一个确认的所有权问题：其他调用者取消正在等待的只读 STATUS，
不再发送 RELEASE/PAUSE，也不会松开当前操作者按住的键。被取消请求的迟到回复不能改变当前控制轮次。
定向回归及 EXE 中两名官方 SDK 客户端的场景覆盖了取消后原操作者继续输入。

从未尝试控制的 bridge 现在直接打开 STATUS 观察连接，不发送 PING、不取得所有权、
不启动心跳，也不进行输入清理。默认只读等待上限为 3000ms，显式配置的更短时限仍生效。
首次尝试控制会关闭观察 socket，在新 socket 上完成原有握手；控制 ACK 仍为 1200ms，
板端看门狗仍为 1500ms，输入不重放。从未控制的只读查询不受手机停止投屏或画面尺寸变化影响；
这不代表没有有效画面时也允许控制。

| 本轮检查 | 结果与边界 |
| --- | --- |
| 电脑门禁 | **PASS**：typecheck/build；完整主机用例 **429/429**，零跳过；EXE **14/14** 场景，`realDeviceInput=false`。日志：`apps/android-mcp/build/observation-v33-{typecheck,build,host-tests,exe-tests}.log` |
| 真实官方 MCP 只读连接 | **PASS**：手机投屏 App 已停止时，`android_hid_status` **60/60**，最大 **1,182ms**，运行窗口约 74 秒；首个请求发出至最后结果为 72,533ms。证据：`apps/android-mcp/build/mcp-v33-observation-status.json`。仅覆盖只读连接，不代表真实输入通过 |
| 同期 UART 与包头观察 | UART 90 秒、**158** 个样本，OOM **0**、`faults=[]`，采样可用内部堆最低 **27,000B**；TCP epoch 为 1，完成整写 **60** 次。证据：`apps/esp/build/tcp-v33-diagnostics.json`、`apps/android-mcp/build/npcap-v33-tcp-headers.json`。整写仅证明 socket 接受字节，不独立证明无线送达 |
| v31 RX4 中立压力 | **FAIL**：目标间隔 20ms、最多四条未确认 PING、时限 1200ms；发送 **23**、收到 **18**。PING 100018 在 **3,582ms** 超时，4,133ms 收到对端 END。证据：`apps/android-mcp/build/tcp-neutral-stress-v31.json`，以及对应的 `npcap-v31-stress-tcp-headers.json` / `apps/esp/build/tcp-v31-stress-diagnostics.json` |
| v32 RX6 对照实验 | 相同配置压力下仍 **FAIL**：发送 **69**、收到 **64**；PING 100064 在 **6,262ms** 超时，当时等待 1,211ms；6,824ms 收到对端 END。OOM **0**。证据：`apps/android-mcp/build/tcp-neutral-stress-v32.json` 及对应 v32 压力包头/UART 文件。两段失败窗口不能证明故障率改善；RX6 不采纳，已回退 |
| 当前电脑服务 | EXE 监听 **0.0.0.0:8790**；`/health` 为 `status=ok`，未知路由为 404。最终核对 PID **10512**，buildId **67726d3e76d3841d47dc** |

RX6 实验版通过完整固件门禁及归档校验，仅向 COM6 已有 `ota_0` 的 `0x20000` 烧录 App，
保留 NVS 及此前记录的其他区域。真机失败后，只回退实验的两处源码修改，
重新刷回已验证的 **v30 App**，写入哈希校验通过；恢复启动观察 30 秒，OOM 0、`faults=[]`。
证据：`apps/esp/build/rx-v32-build.log`、`new-com6-v32-flash.log`、
`restore-v30-after-rx-v32.log`、`restored-v30-startup.json`。
恢复后的 `sdkconfig.defaults` blob 为 `b2a409b760906a9bdbda4e8e807fb6904a8daefe`，
传输契约 blob 为 `2f228ff5f27c2ada6051056029ef9c33d2019d80`，与实验前完全一致。
v32 归档仅保留用于追溯：合并镜像 `15be676d9b191b2a2eb43c4c5c8d622dd50a2b5a44aaf0a1f00692c3c2f65576`，
App `f7971729e7d98eb450a3e5f07ea0fd931f5f5eb4c6e8f380a4b214a53f084ca5`，
ELF `8019c322ddd43c2312e9810930e8fd87bfca03456c0bb3ea61e0c9425fb37eab`。
当前设备内的 v30 身份仍以下方记录为准。

一加 ADB `dcf4e720` 已恢复；只读核对已安装 APK 哈希仍为
`7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812`，
Wi-Fi 地址为 `192.168.101.46`。但 Android 记录 App 在 **23:08:13.816（Asia/Shanghai）**
被系统停止，reason **13 / OTHER KILLS BY SYSTEM**、subreason **2040**；尚未证明是 App 崩溃。
检查时没有 App 进程或 MediaProjection 授权，`/health` 拒绝连接，MCP 截图尝试返回错误且没有图片。
证据：`apps/android-mcp/build/phone-v33-readonly-diagnostic.json`、`mcp-v33-phone-readonly.json`。
ADB 打开/配置命令被自动审核拒绝，仅返回 `blocked by policy`，没有换其他接口重试；
仍等待用户在手机打开 App 并授权投屏。未使用 USB/ADB 业务输入或截图回退。

当前 EXE：`apps/android-mcp/build/windows/设备操作台.exe`，**94,430,208B**，
SHA-256 `226963e6d5cc64e7ec394797591a67be4bdad4a1d84209e631c97c155117afaf`。

Build：**PASS**；Host tests：**PASS**；Device tests：**PARTIAL——只读 MCP 连接 PASS，
高频中立传输压力 FAIL**。Unverified：恢复手机投屏、真实 BLE 配对、非零输入及完整端到端控制。
只读观察通过不覆盖压力失败，不能宣称远控成品已稳定完成。

## v30 TCP 定时粒度——已刷入，MCP 连续查询仍 FAIL

2026-10-17：本轮固件仅将全局 TCP 定时粒度设为 125ms；初始 RTO 仍为 1000ms，
电脑 ACK 时限仍为 1200ms，控制器看门狗仍为 1500ms。该配置也作用于 HTTP 等 TCP 连接，
存在全局定时处理开销的取舍，不保证改善丢包或所有连接延迟。
完整固件门禁、归档校验及 COM6 `ota_0` App-only 烧录 **PASS**：
向 `0x20000` 写入 1,660,224 字节并校验，保留此前记录的 NVS、分区表及其他区域。
证据：`apps/esp/build/tcp-v30-build.log`、`new-com6-v30-flash-plan.json` 及同轮烧录日志。

- 启动观察：30 秒、10 条只读回复、OOM 0、`faults=[]`。初始 DHCP 重试期间记录一次 Wi-Fi 断开，reason 为 8；仅该事件不能证明 RF 故障。证据：`apps/esp/build/new-com6-v30-startup.json`。
- 官方 MCP：前两个样本成功，sample 2 在 4,507ms 后返回 `ESP32 STATUS acknowledgement timed out`，**FAIL**。证据：`apps/android-mcp/build/mcp-v30-new-board-status.json`。
- 只读诊断：90 秒、158 个样本，UART 请求最大 78ms，OOM 0、socket 失败写入 0、`faults=[]`；采样可用内部堆最低 26,196 字节，SDK 自启动历史低水位 19,552 字节。最终事件计数仍仅有启动时的一次断开，无新增断开。证据：`apps/esp/build/tcp-v30-diagnostics.json`。串口响应和内存余量正常不能替代 LAN/MCP 验收。
- APK 来源绑定下载：PASS，HTTP 200、49,634 字节、2,187ms，SHA-256 仍为 `7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812`；证据 `apps/android-mcp/build/new-board-v30-download.json`。
- 实时画面只读观察：标准档 SSE 连续 20 秒收到 287 帧、21,110,826 字节、0 次 unavailable；这是该画面窗口通过，不代表控制链路通过。当前 EXE 在 8790 端口运行。
- 极速档有界对照：从标准档切换极速档成功；官方 MCP sample 0 成功，sample 1 在 3,305ms 后 PING ACK 超时，仍 **FAIL**；finally 恢复标准档成功。证据：`apps/android-mcp/build/profile-v30-turbo-ab.json`、`mcp-v30-turbo-status.json`。降低预览画质未让本轮连续查询通过，削弱“只需降画质即可修复”的解释；有限对照仍不能唯一排除负载影响，也不确定全部断连根因。未运行 BLE 配对或非零输入。
- Device tests：**PARTIAL，MCP 连续查询 FAIL**。实际 BLE 配对、非零输入及最终端到端控制仍 **NOT RUN**；本轮不得宣称连接稳定或成品完成。

固件归档/合并镜像 SHA-256：`3c87ab62d614ae68c09bd10d9444e2e77c9808a1cca3cc96857b98194428b9dc`。
App SHA-256：`088b47c4aa89769926bd506c65862a577bcf89e4edc0b7d9b19c6950f76adfd9`（1,660,224 字节）。
ELF SHA-256：`66a12d4643e7a728bb78254e58e53feb67d8daaa3f1c8ecdf30d7206117bbc23`。

## v29 电脑冷握手心跳修复与包头观察——离线 PASS，真机结果仍有失败

电脑 `serial.ts` 在首次握手 PING 发出前启动中立心跳，慢 RELEASE/PAUSE 回复期间也续租，
握手完成前继续拒绝实时输入；原有至多四个待确认心跳、失败清理和旧连接/迟到 ACK 守卫保留。
两条旧实现红测复现租约空窗，新实现定向 **55/55 PASS**；typecheck/build **PASS**，
完整电脑用例 **419/419 PASS**，最终 EXE **13/13 离线场景 PASS**。
日志：`apps/android-mcp/build/handshake-v29-typecheck.log`、`handshake-v29-build.log`、
`handshake-v29-host-tests.log`、`handshake-v29-exe-tests.log`。
打包场景使用本地模拟手机/控制板，明确 `realDeviceInput=false`，不算真机控制验收。

- 官方 MCP 真机查询仍 **FAIL**：sample 0 在 4,247ms 后 PING ACK 超时；证据 `apps/android-mcp/build/mcp-v29-new-board-status.json`。
- 独立原始 TCP 追踪仍 **FAIL**：前 10 个样本成功，sample 10 PING ACK 超时；证据 `apps/android-mcp/build/tcp-v29-neutral-wire.json`。
- 另一轮与包头抓取并行的原始追踪 **30/30 PASS**：单连接持续约 36.6 秒，Node 事件循环最大延迟 34ms；证据 `apps/android-mcp/build/tcp-v29-capture-wire.json`。该独立通过窗口不覆盖上述失败。
- 普通权限、非混杂、精确 WLAN 与目标/端口过滤的 30 秒包头观察得到 365 个包。发现 **9 次 PC→ESP 重叠序列区间重发**，包含合并重分段；不能仅按序号和长度完全相等查找。例：PING 36 首发后约 532ms、1,043ms 两次重发，之后 ACK 批量到达。入站数据至 Node 回调最大约 5.9ms，未见零窗口或 RST；本轮主要秒级等待发生在 Node 读取前。证据 `apps/android-mcp/build/npcap-v29-tcp-headers.json`，仅保存包头字段，无载荷或 pcap 文件。
- 该抓取与 `tcp-v29-diagnostics.json` 的 UART 窗口**不重叠**，不能作同期串口归因。主机 WLAN 包头证明 PC 栈重发尝试，不能单独证明空口实际发送、RF 丢包、ESP 已收到，或唯一确定去程/回程故障。

电脑 EXE buildId：`b5f42c55d15153b3a302`；SHA-256：`4c0f43a7cee36e0710b7abbedcd38e2ab39ad99e32584e3276a4faf53137735c`（94,428,160 字节）。

## v28 有界 TCP 诊断——已刷入，连续局域网查询仍 FAIL

2026-10-17：初始 TCP RTO 改为 1000ms，并新增 32 字节累计 socket 诊断；
电脑 ACK 时限 1200ms、控制器看门狗 1500ms 不变。诊断不缓存命令、重发输入或解析私有无线包。
本轮完整固件门禁及归档校验 **PASS**，定向 Wi-Fi 后端宿主测试 **17 组 PASS**。
COM6 仅向既有 `ota_0` 的 `0x20000` 写入 1,660,224 字节 App，写入校验通过，
保留 bootloader、原分区表、otadata、NVS、PHY、assets 和另一 OTA 槽；未全擦。
证据：`apps/esp/build/tcp-v28-build-final.log`、`new-com6-v28-flash-plan.json` 及同轮烧录日志。

| 本轮真机检查 | 结果与边界 |
| --- | --- |
| 启动观察 | 30 秒、10 条只读回复，OOM 0、`faults=[]`；证据 `apps/esp/build/new-com6-v28-startup.json`。这是该窗口的观察，不是长期稳定性证明 |
| 只读诊断 | 90 秒、158 个样本、UART 请求最大 78ms，OOM 0、`faults=[]`；采样可用内部堆最低 **23,344** 字节，SDK 自启动历史低水位为 **16,836** 字节，两者不可混称。证据 `apps/esp/build/tcp-v28-diagnostics.json` |
| 控制板 APK 下载 | PASS：HTTP 200、49,634 字节、3,240ms，SHA-256 仍为 `7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812`；证据 `apps/android-mcp/build/new-board-v28-download.json`。不代表手机已安装或投屏初始化成功 |
| 官方 MCP 中立状态查询 | FAIL：前两个样本成功，sample 2 出现 `ESP32 PING acknowledgement timed out`，耗时 5,200ms；证据 `apps/android-mcp/build/mcp-v28-new-board-status.json` |
| 来源绑定的原始 TCP 追踪 | FAIL：sample 0 在 2,076ms 收到对端 END，未完成 STATUS；本地来源为 `192.168.100.160`，Node 事件循环最大延迟 22ms。证据 `apps/android-mcp/build/tcp-v28-neutral-wire.json` |
| 来源绑定 ICMP 对照 | 控制板 `192.168.101.75` 收到 17/20，丢包 15%，平均 239ms、最大 1,061ms；网关 10/10、平均 22ms，手机 10/10、平均 114ms。这组有限样本支持控制板链路仍有丢包/延迟，不能单独确定 RF、路由器或 TCP 根因 |

新诊断在失败窗口记录到 TCP 接收累计值停止增加，而串口仍及时响应；
socket 失败写入计数始终为 0。整写成功只证明 lwIP 接受字节，不证明无线送达；
历史关闭原因/errno 保留到后续连接，必须结合轮次和计数增量判断，不能把旧值当作新故障。
另已发现电脑冷握手完成到周期心跳启动之间的空窗，正在定向修复和复验；
该修复尚未完成真机验收，也不能据此将所有链路失败归因于同一问题。

Build：**PASS**；Host tests：**PASS**；Device tests：**PARTIAL，连续 LAN 查询 FAIL**。
真实 BLE 配对、非零输入及最终端到端成品验收仍 **NOT RUN**；不得描述为已完成或稳定。
v27 及更早的成功和失败记录均保留在下方。

固件归档/合并镜像 SHA-256：`e7b9c1858d6004d0be1fea42cdd619415e97c600210a4f75bdd5d10dac758036`。
App SHA-256：`8e614c846cab586f1468f9cfd4f824b80514d65397dea04508a3fddb2ae103b2`（1,660,224 字节）。
ELF SHA-256：`905d00a988c92d12ad497e73fd3178e4d0a5cc364d2700565d7dbd3766b18666`。

## v27 内存预算调整——观察内 OOM 消失，LAN 查询仍未通过

关闭两项 Wi-Fi IRAM 速度优化后，匹配 ELF 比较确认共享 SRAM 实际回收 **19,456 字节**，
未把 SDK 单项节省估算直接相加；无线缓冲、NimBLE、任务栈、UI 和安全时限不变。
固件门禁、归档校验及 COM6 App-only 烧录 PASS，向原 OTA 槽 `0x20000` 写入 1,659,824 字节，保留数据。

- 启动观察：30 秒内部堆最低 42,588 字节、OOM 为 0；APK 下载与 MCP 查询并行的另一个 30 秒诊断窗口内，最低堆 19,684 字节、OOM 为 0、`faults=[]`，未见 Wi-Fi 断开或重启。证据：`apps/esp/build/new-com6-v27-startup.json`、`new-com6-v27-lan-diag.json`。这些窗口内的内存耗尽已消失，不代表所有链路问题已解决。
- APK 下载：49,634 字节、SHA-256 仍为 `7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812`，2,248ms，PASS。证据：`apps/android-mcp/build/new-board-v27-download.json`。
- 官方 MCP 中立查询：前 17 次成功，18 个样本中的 sample 17 出现 PING ACK 超时，FAIL。证据：`apps/android-mcp/build/mcp-v27-new-board-status.json`。
- 新的来源绑定线路追踪：20 次 STATUS 回复成功；随后 PING 95 在 23,015ms 发送、24,455ms 收到 ACK，耗时 1,440ms，ACK 96–98 在 1,369ms 收包空窗后集中到达。Node 事件循环最大延迟仅 23ms，控制板未在客户端关闭前主动断开。证据：`apps/android-mcp/build/tcp-v27-neutral-wire2.json`。现象符合 TCP 队头阻塞/重传延迟，但尚未确定丢包方向。
- Device tests：PARTIAL，连续 LAN **查询**仍 FAIL。用户明确选择“先验证电脑连接”，BLE 配对及非零输入按该范围偏好为 **NOT RUN**，不是输入功能已测失败。
- 后续：v28 全局初始 TCP RTO 1000ms 和 32 字节有界诊断正在构建，尚未经设备验证；电脑 ACK 1200ms 与固件看门狗 1500ms 保持不变。

固件归档/合并镜像 SHA-256：`eaaa7d7305a954cb47811bfbd169dfd45b3b5c87526cd3cc3b963514432ba233`。
App SHA-256：`6dec0fd45c58249ec59411b81e2f182e8418194199a61ccd1c019fbe33584eb4`（1,659,824 字节）。
ELF SHA-256：`e04c97669536264f32885bcd3e09602436de23db1a01b5f19a6d73a439414953`。

## v26 新控制器与明确局域网来源地址——部分验收

2026-10-17：设置页发现新控制器但没有新鲜手机注册时，保留原投屏地址和 UUID。
主动查找/选择局域网设备会选择 Wi-Fi，本页明确选择 USB 时保留 USB；后台发现保留已保存的 USB。
编辑版本号避免迟到的发现结果覆盖正在编辑的字段。复制 IP:端口、全角冒号或扫码下载地址时，
页面和 API 统一规范化：地址内端口优先，下载端口 3334 纠正为控制端口 3333，裸局域网主机名保持兼容。

实际未绑定连接曾选中 Mihomo TUN 来源 198.18.0.1。TCP 现仅解析主机名一次，验证私网 IPv4 后，
绑定最长匹配子网的本机地址；手机 HTTP 和控制板登记使用各自拥有的来源绑定连接池，
地址变化时替换，关闭时释放。回环和无匹配子网的路由地址保留原行为。
未修改代理/安全软件、HID 时限或动作重试，也没有自动回退 USB。

- Build / Host tests：电脑 typecheck/build PASS；串口/TCP/LAN 定向 59/59、HTTP/投屏/登记定向 57/57 PASS，电脑完整用例 417/417 PASS；EXE 的 13 个离线场景 PASS，含复制端口持久化及 BLE 未就绪时官方 MCP 状态查询，零真实输入。日志：`apps/android-mcp/build/lan-v26-host-tests.log`、`exe-v26-lan-tests.log`。
- 固件 Build / 烧录：门禁及归档校验 PASS；COM6 既有 `ota_0` 仅向 `0x20000` 写入 1,660,800 字节 App，保留原分区表、bootloader、otadata、NVS、PHY 和 assets，未全擦，也未向原 OTA 地址刷合并镜像。方案：`apps/esp/build/new-com6-v26-flash-plan.json`。
- 启动观察：30 秒内 11 条只读回复、`faults=[]`，只代表该启动窗口，不代表长期稳定。证据：`apps/esp/build/new-com6-v26-startup.json`。
- 手机 MCP 真机：发现 20 个工具，连续三次 1080×2400 原图 JPEG 截图 PASS，`realDeviceInput=false`。证据：`apps/android-mcp/build/mcp-v26-phone-readonly.json`。
- 新控制器 LAN：已纠正为同一局域网 `192.168.101.75:3333`；官方 MCP 首次状态成功后，sample 1 出现 PING ACK 超时，FAIL。证据：`apps/android-mcp/build/mcp-v26-new-board-status.json`。来源地址修复尚未解决连续状态查询。
- 内存证据：UART 诊断仍正常回复，内部堆最低仅 312 字节，分配失败计数 295→297。元组顺序为 `[次数,申请大小,能力标记]`，实际失败申请为 **1700 字节**，**6144（0x1800）是 caps**，不能误称 6144 字节申请。证据支持内存压力，尚未识别每次失败的调用者。记录：`apps/esp/build/new-com6-v26-lan-diag.json`。
- APK 传输：明确绑定本机来源后，从新板下载 PASS，HTTP 200、49,634 字节、2,973ms，SHA-256 与下方一致，v2/v3 签名检查 PASS；没有修改 APK 源码。证据：`apps/android-mcp/build/new-board-v26-download.json`。
- Device tests：PARTIAL，连续 LAN 查询仍 FAIL，真实输入 NOT RUN。新控制器尚未 BLE 配对，手机 App 还需选择新控制器；电脑登记不代表手机已经安装。完整配对、实体按键流程及非零输入仍未验收。v27 内存调整的实际结果见上方记录。

EXE buildId：`3ff7c5d09cd457ec3fbf`；SHA-256：`ce6e48761abead97a359f04294bc1a2af65ce72312ea7aef498076f2ea418945`（94,429,696 字节）。
固件归档/合并镜像 SHA-256：`07e676807906e7f6f0bd68df27f22fa2921eebfdac86f097b340b3b0f21e4e14`。
App SHA-256：`d7636d16ed21b8ebde611d4581679002eaf284ed15cc45dbd88072e5e5a7a3e2`；ELF SHA-256：`1617e8b930efddd48a5f87d7e8e52bddfa2f6e6ed0906bfb85f5c58f19e7b494`。
APK SHA-256：`7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812`。

## v25 冷启动诊断保护——已刷入，冷态诊断观察通过

v24 启动诊断异常已定位到 Wi-Fi SDK 尚未初始化时调用查询接口。
本次仅为 `s_initialized && s_started` 增加查询门禁：未激活时返回 `NOT_INIT/NOT_STARTED`，
不调用四个 SDK getter。UI、启动指南及字体保持 v24 版本，没有重置或擦除配置。
冷态/停止态连续诊断局部回归先红后绿 PASS；最终固件门禁及匹配归档校验 PASS，日志
`apps/esp/build/guide-pair-v25-build.log`。COM5 App-only 向 `0x10000` 写入 1,659,920 字节，
哈希校验通过，保留 NVS/PHY。

Device tests：仅 20 秒启动/诊断观察 PASS。11/11 只读请求得到回复（9 次 DIAG、2 次
`WIFI_STATUS`），`faults=[]`，冷态诊断正常返回 `NOT_INIT`；`heap=75060/min=74988` 稳定。
窗口内未见 panic 或重启，查询未启动 Wi-Fi SDK、写入 NVS 或发送 HID 输入。
证据 `apps/esp/build/guide-pair-v25-startup.json` 及对应串口日志。
实体按键、配对视觉及完整引导流程仍未验收；当前 `configured=false` 的原因未知，
不声称 Wi-Fi 已恢复或保存配置仍在，v22 连续链路失败记录保持有效。
电脑服务已重启，health 为 `status=ok`、buildId `7c769d5e10e2f43fa749`；
sidecar 仍明确选择 LAN `192.168.100.167:3333`，设备当前未配网，不代表已连通。

合并镜像 SHA-256：`0fb2551229515213e33788fab6b6ecbe4bdeab72f1e9bad4df437c862f51c4e0`。
App SHA-256：`4d69872dea1a7f637e59a9f3f1c684f7d9f6cf2e9a5d88bda3078ab6d16055f7`（1,659,920 字节）。
ELF SHA-256：`b4107fe50f3e77fa7433bfd35b3efb3bddd55a13e3d1f00f52e03a1a41ab5453`。
归档：`apps/esp/build/firmware/0fb2551229515213e33788fab6b6ecbe4bdeab72f1e9bad4df437c862f51c4e0/manifest.json`。

## v24 蓝牙设置反馈与首次按键指南——已刷入，启动诊断失败

2026-10-17：蓝牙设置页实时区分配对窗口已开启、等待手机、安全连接及键鼠就绪，
配对码过期后及时隐藏。确认操作显示 600ms 按钮描边及 3 秒确认反馈，
不把打开配对窗口当作配对成功，也不修改 BLE 安全条件。
首次无保存 Wi-Fi 或重置后，先显示实体按键图示；短按确认进入原步骤一，不自动扫描。
从正常设置打开按键指南时，返回上一级的行为不变。

- Host checks：UI 模型/setup C、实际 LVGL `--pair` / `--intro` 及三项字体检查 PASS；字体含 222 个非 ASCII 和 95 个可打印 ASCII。均为定向宿主检查。
- Build：PASS，最终固件构建、匹配产物校验通过。
- 烧录：PASS，COM5 App-only 向 `0x10000` 写入 1,659,840 字节，哈希校验通过。
- Device tests：FAIL（启动诊断）。`WIFI_STATUS` 返回未配置，4 秒及 10 秒的 `WIFI_DIAG` 各触发一次 `Load access fault`；证据 `apps/esp/build/guide-pair-v24-startup.json` 及同名日志。匹配 ELF 回溯为 `current_task_is_wifi_task → wifi_api_unlock → esp_wifi_sta_get_rssi → qdd_wifi_diagnostics:92`，支持未初始化 SDK 查询的定位。Wi-Fi 未配置的原因尚未知，未据此重置或擦除 NVS。
- Unverified：实体配对反馈及首次配置完整流程未验收；不宣称原 Wi-Fi 稳定性已修复，下方 v22 FAIL 保留。

合并镜像 SHA-256：`ed18797d76644671e2a7f6ce515eda55e526473047946a9f9822a3630ca72194`。
App SHA-256：`afe83d2b8b1da0f46e7c3f76a08f79704da0c0870f5e85c10c5c7263ffd9b11a`（1,659,840 字节）。
ELF SHA-256：`52eec88be5037b2a8c2bda1ade46674c21f6dec259f401a9cfe4747b88d8e488`。

## v22 恢复局域网优先与设备发现——已刷入，连续控制仍未通过

2026-10-17：首次设置默认局域网，设备 IP 留空供用户填写真实地址，控制端口默认 `3333`。
二维码/App 下载引导页使用 `3334`。打包不再强制清空 `ESP_HOST`；sidecar 只在不存在且
有真实局域网地址时以 `wx` 初始化，保留已有本地选择。有效 UDP 状态经过私网、来源 IP、
board URL 主机及状态格式校验后直接采纳，HTTP 只补充已知地址。
同一 socket 和地址集在原 1,400ms 窗口内发送三次中立发现请求，结果去重，取消/完成时清理重发定时器。
没有增加控制动作重试、自动 USB fallback 或 HID 超时。

| 检查 | 结果与边界 |
| --- | --- |
| 电脑端定向检查 | LAN 默认、sidecar 保留、UDP 直收及首轮丢包/取消清理等 27 项 PASS |
| 最终 EXE | 12 个离线场景 PASS，包含官方 MCP SDK、stdio、首次配置与重载；日志 `apps/android-mcp/build/exe-v22-final-tests.log` 明确 `realDeviceInput=false`，不代表真机输入验收 |
| ESP Build / 烧录 | 固件构建归档及 COM5 App-only 烧录 PASS：向 `0x10000` 写入 1,658,080 字节，写入哈希通过，保留 NVS |
| 当前本机配置 / 发现 | sidecar 为 `ESP_HOST=192.168.100.167`、TCP `3333`，最终服务按 LAN 运行且 `/health` 为 `ok`；再次真实 `/desktop/discover` 可找到控制板，返回 `phone:null`、蓝牙未连接，未继续采用上轮 USB 临时方案 |
| 裸 TCP 心跳 | 60/60 PING 回包成功，最大 1,117ms；证据 `apps/android-mcp/build/tcp-v22-raw.json`。这不能替代 MCP 长连接验收 |
| TCP bridge 补充追踪 | 15/15 `STATUS` 请求成功，最大 1,123ms（不含冷握手 1,611ms），共 81 条回复；关闭清理时 PING 82 / RELEASE 83 / PAUSE 84 未获 ACK 后 socket 关闭。证据 `apps/android-mcp/build/tcp-v22-bridge-trace2.json`；不能据此宣称稳定 |
| 官方 MCP 实机查询 | FAIL：sample 1 仍出现 `ESP32 PING acknowledgement timed out`，证据 `apps/android-mcp/build/mcp-v22-lan-diagnostics-status.json`。连续控制稳定性尚未通过 |
| 90 秒诊断 | 未见 panic，OOM/发送失败计数为 0，`up=1`；证据 `apps/esp/build/lan-v22-diagnostics.json`。首条 3001 回复与启动残片连行，但确有回包，不能称 UART 丢答 |
| 手机与蓝牙 | 最终 `192.168.101.46` 的 health 请求在 3 秒时限超时，ICMP 0/20，ADB 设备枚举为空，蓝牙未连接；无法进行完整真实操控验收，未由此断定路由器故障 |
| Device tests | PARTIAL：发现与部分中立传输通过，MCP 连续链路稳定性 FAIL；手机画面/蓝牙输入端到端仍未验收，不能标为成品 PASS |

电脑 EXE buildId：`7c769d5e10e2f43fa749`。
EXE SHA-256：`51d390cc57ffc8e33285e7014a4f403414d168d9daa26d794a0da0683a26e11d`（93,346,816 字节）。
ESP 合并镜像 SHA-256：`ea35050804fcdf29c69d5f2ab94646d8a1fb8d4ccab7d1df2c23f1df96ca5ddd`（1,723,616 字节）。
App SHA-256：`4f52e2d90da9e8af7af4d2cadea4e39b138b7d7f7c740026668de70ce37b6c14`（1,658,080 字节）。
ELF SHA-256：`7c532c87099486e20f3baf911a2a39948f93728aadb9626ea2b00af1857d8c63`。
归档：`apps/esp/build/firmware/ea35050804fcdf29c69d5f2ab94646d8a1fb8d4ccab7d1df2c23f1df96ca5ddd/manifest.json`。

## v21 心跳确认与引导完成记忆——已刷入，COM5 中立连接通过，Wi-Fi 复测未通过

2026-10-17：电脑端已复现单条定时 PING 回包丢失会阻塞后续心跳的路径。
现在按原间隔继续发送最多四个在途中立心跳，较新的成功回包只淘汰较旧的定时心跳；
全部无回包时仍按原截止时间释放输入，不增加 HID 超时，也不重放操作。
新轮次、重连及关闭仍作废旧心跳；高频输入后迟到的已作废心跳不会误伤当前轮次。
引导完成后的界面记忆另有实际 LVGL 20 轮对象稳定专项检查。

| 检查 | 结果与边界 |
| --- | --- |
| 电脑端检查 | typecheck/build PASS；串口、TCP及连接定向回归 50/50 PASS，单回包丢失场景先红后绿 |
| EXE 检查 | self-test PASS；12 个离线场景 PASS，包含官方 MCP SDK 与 stdio。属于离线验证，不是当前实机输入验收 |
| UI 专项 | 实际 LVGL 引导完成记忆 20 轮对象稳定检查 PASS；不是完整实体按键流程验收 |
| ESP Build | 固件门禁及独立归档复核 PASS |
| 烧录 | PASS：COM5 App-only 写入及哈希校验通过，保留 NVS/PHY |
| 刷入前实机连接 | 运行 sidecar 实际选择 TCP `192.168.100.167:3333`；裸 TCP 5 秒连接失败，UDP/ICMP/ARP 不可达。USB PING 20/20 成功、最大 32ms，但蓝牙状态未连接 |
| 刷入后启动观察 | 35 秒内 11 条 `NETSTATUS` 正常，23 次 UDP 请求收到 21 次回复，未见 panic；仅代表此观察窗口 |
| Wi-Fi 连续控制链路 | FAIL：随后新版 EXE 通过官方 SDK 实际连接 MCP，状态查询在 sample 6（第 7 次）复现 PING acknowledgement timeout。证据 `apps/android-mcp/build/mcp-v21-live-status.json`。短启动观察不能替代连续控制验收，不能宣称 Wi-Fi 已修好 |
| COM5 后续验证 | PASS：新版 EXE 通过官方 SDK 实际调用 `android_hid_status` 15/15 成功，无超时，最大 59ms。证据 `apps/android-mcp/build/mcp-v21-usb-status.json`；仅验证中立连接，不代表手机操作已通过 |
| 当前电脑服务 | EXE 正在运行，health 返回 `status=ok`、buildId `f5636ed8fec2fa799e01`；本机配置 `ESP_HOST` 为空、`ESP_PORT=COM5`。手机局域网投屏配置完全保留，未增加自动 failover 或放宽超时 |
| Device tests | PARTIAL：COM5 中立连接通过，Wi-Fi 连续控制仍 FAIL；最终蓝牙 `connected/encrypted/ready` 均为 false，需要手机连回既有配对设备。未发送真实手机非零输入，不能宣称完整真机远控 PASS |
| Unverified | 蓝牙重连后的真实输入、完整实体引导及更长时间稳定性仍未验收 |

电脑 EXE buildId：`f5636ed8fec2fa799e01`。
EXE SHA-256：`7c4f40229d7ef8d73a2699b3c842c8188184d4414a1a0c421cd5826999e85b93`（93,345,280 字节）。
ESP 合并镜像 SHA-256：`cc0e496af53b0c633fcf9c72618b30cda4d80c7ed723003cb4a1a94ce2bb2ea8`（1,721,680 字节）。
App SHA-256：`dc714d2225c93610379a99c590378db432f0bca5d56ded449a256a9c06c97adb`（1,656,144 字节）。
ELF SHA-256：`1ed6fd5185dfcbf5da9f2bd9ba509bf94a635d6d0d8cc89fe86504087d66475a`。
归档：`apps/esp/build/firmware/cc0e496af53b0c633fcf9c72618b30cda4d80c7ed723003cb4a1a94ce2bb2ea8/manifest.json`。
此前 Wi-Fi 本机配置保留于 ignored 的 `qdd-android.v21-wifi.json`，没有发布。

## v20 重启与可跳过引导——已构建烧录，35 秒观察通过

2026-10-17：用户报告设备反复重启。串口捕获 `Stack protection fault`，但没有完整回溯；
证据 `apps/esp/build/onboarding-v19-reboot-serial.log`。匹配 v19 ELF 的固定调用链静态栈下界
已达 2,976/3,072 字节，支持栈空间不足的判断，仍需新 ELF 及真机稳定观察确认修复效果。
v20 将 `poll_udp` 的 1,024 字节响应缓冲从局部栈移到 worker 独占 BSS，
不扩大任务栈，也不修改下载路径。
新匹配 ELF 确认 `poll_udp` 静态栈帧由 1,152 降至 128 字节，固定主调用链下界由
2,976 降至 1,952 字节；任务栈保持 3,072 字节，名义余量为 1,120 字节，
这不是实测 high-water mark。BSS 增加 1,032 字节，其中响应缓冲为 1,024 字节。

扫码/安装及蓝牙配对说明新增本次开机有效的“跳过”。引导页移除紧急停止，保留跳过/设置；
正常控制页急停仍保留。跳过仅影响说明进度，不伪造实际下载、蓝牙安全连接、ready 或输入能力。

| 检查 | 结果与边界 |
| --- | --- |
| 定向 Host tests | 实际 handler、纯引导界面模型及 220 个字体字形检查 PASS；真实 LVGL `--guide` 专用运行 PASS（exit 0）。这些是定向检查，不代表完整宿主门禁 |
| 引导预览 | 二维码带跳过、蓝牙、电脑及正常未配对四张 PNG 已人工检查，无遮挡或缺字；这是宿主渲染预览，不是实体 LCD 验收 |
| 默认全 UI 运行 | 未通过：旧 Wi-Fi 名称断言期望完整 `1. Updated network`，实际按现有 108px 名称宽度截断；该断言本轮未修改，独立于新增引导专项。不得据此标记整套 Host tests PASS |
| Build | PASS：ESP-IDF 固件门禁、布局、合并镜像及匹配归档校验通过；不覆盖上方失败的默认全 UI 用例 |
| 烧录 | PASS：COM5 仅向 `0x10000` 写入 1,656,016 字节 App，`Hash of data verified`，保留 NVS/PHY |
| Device tests | PARTIAL：35.1 秒串口+UDP 启动观察 PASS，12 条 `WIFI_STATUS` 正常，保持已连接 `192.168.100.167`；26 次发现请求收到 23 次回复，`faults`/`serialErrors`/`bootMarkers` 均为空。本窗口未见重启或栈异常；证据 `apps/esp/build/onboarding-v20-startup.json` |
| 电脑服务 | 设备操作台 EXE 已恢复，`GET /health` 返回 `status=ok`；地址 `http://192.168.100.160:8790/` |
| Unverified | 实体按键跳过、完整引导流程及更长时间稳定性仍未验收；35 秒观察不代表长期稳定，不延伸下载排查 |

合并镜像 SHA-256：`676cff3e8e29dc390893caa77a4e43ff7600047909e134a288f0abc17fec2f93`（1,721,552 字节）。
App SHA-256：`6224adf5eb185e422b77480598bcdd7465c0a39cad27c20352cd62894745c67e`（1,656,016 字节）。
ELF SHA-256：`a1a83ae5ef4fa1243101ec3c577ae4a6f17e113d8e85a90219a1eeffc5b6aa91`。
归档：`apps/esp/build/firmware/676cff3e8e29dc390893caa77a4e43ff7600047909e134a288f0abc17fec2f93/manifest.json`。

## v19 无线与内存诊断——已构建并刷入

本版本仅新增 RSSI、信道、Wi-Fi 省电模式、内部可用堆及最大连续空闲块诊断字段。
没有取得实机无线诊断结果，不宣称诊断完成或下载提速。
v17 的扫描等待动画及配对时不回退二维码步骤的修复已包含在此版本。

| 检查 | 结果与边界 |
| --- | --- |
| Host tests | 诊断字段局部检查 PASS；不代表完整宿主门禁 |
| Build | PASS：编译、布局及匹配归档校验通过 |
| 烧录 | PASS：COM5 仅向 `0x10000` 写入 1,654,416 字节 App，哈希校验通过，保留 NVS |
| 电脑服务 | 设备操作台 EXE 已恢复运行 |
| Device tests | 用户报告真机下载正常；维护者尚未亲自完整核验实体 LCD 引导、扫描动画及配对返回流程；无线诊断未取得 |

合并镜像 SHA-256：`1a61a0193562b1e7eb28e0ecee103115e5115926365e8c2d13cdab45c5fbb5aa`（1,719,952 字节）。
App SHA-256：`82a1282c3df1080f451407c0d40c8f610fd4314f2db4b224353095680e5aa108`（1,654,416 字节）。
ELF SHA-256：`8fdc8efaf26989be076648df96815d3773c7a957e99e9f4e097ae12ba56695bc`。
归档：`apps/esp/build/firmware/1a61a0193562b1e7eb28e0ecee103115e5115926365e8c2d13cdab45c5fbb5aa/manifest.json`。

## v18 有界 Socket 写入与 HTTP 诊断——历史自动探测结果

2026-10-17：针对下方 v17 重复下载中提前关闭的现象，新增 HTTP `send_override`，
将每次原生 Socket 写入限制为最多 2,048 字节；零字节返回按失败处理，负返回值记录 errno。
继续使用 SDK 定长响应，保留 `send_wait_timeout=2`，没有放宽超时。
状态接口补充非敏感 HTTP 诊断，便于区分原生写入失败与其他传输问题。

| 检查 | 结果与边界 |
| --- | --- |
| Host tests | 局部 handler 检查 PASS：部分写入、零返回、写入错误及有界 JSON 输出；不代表完整宿主门禁 |
| Build | PASS：编译、布局及匹配归档校验通过；日志 `apps/esp/build/onboarding-v18-build.log` |
| 烧录 | PASS：COM5 仅向 `0x10000` 写入 1,654,112 字节 App，哈希校验通过，保留 NVS |
| 电脑连续下载 | 三轮顺序 curl 均失败：第 1/3 轮 HTTP 200 后正文 0 字节并在 20 秒时限超时（exit 28）；第 2 轮 HTTP 200，仅 5,513/49,634 字节便提前关闭（exit 18）。证据 `apps/esp/build/onboarding-v18-curl-downloads.json` |
| 手机 curl 探测 | 经 ADB 启动的手机 curl 通过自身 Wi-Fi 发起 20 秒时限请求，HTTP 200，但仅收到 7,079/49,634 字节后超时；此探测不等同于用户实际浏览器下载 |
| 失败后串口观察 | 只读串口状态仍显示 `connected=true`；这不能证明 HTTP 传输正常，也未排除其他射频/运行时问题 |

合并镜像 SHA-256：`62f68963b8f27f874ab6b5f894dac178112dc95b4293320bbc238a3f803a52c0`（1,719,648 字节）。
App SHA-256：`779b0439a6412f615aac3ada8d59b4de0616cb8cd7e2059209bf2ee2a997ce4f`（1,654,112 字节）。
ELF SHA-256：`c4de01fd3d87074acf93af110dbb3776d9db533a2b68d0cc83945f0cb27d2b4d`。
归档：`apps/esp/build/firmware/62f68963b8f27f874ab6b5f894dac178112dc95b4293320bbc238a3f803a52c0/manifest.json`。
上述自动探测为 FAIL，不作为用户下载功能失败的结论；用户随后报告实际下载正常。
未证明这些探测与实际使用之间差异的原因，也不宣称提速或唯一根因。

## v17 引导进度、定长响应与 Wi-Fi 策略——复测仍有提前关闭

2026-10-17：首页明确计算长度后一次调用 `httpd_resp_send`，APK 直接以内嵌指针和准确长度
调用同一 SDK API，不再使用应用层分块/重试循环；仅发送成功才设置 `downloaded=true`。
SDK `send_wait_timeout=2` 保留。Wi-Fi 初始化设为 `WIFI_PS_NONE`，关闭 TCP 控制连接后
也不回到 modem 省电，覆盖 USB 使用及首次下载场景。

App 曾登记的引导进度与 15 秒在线有效期分开；手机切到蓝牙设置后，即使心跳过期也不再退回
二维码/下载步骤。过期仍隐藏实时地址和投屏状态；Wi-Fi 断开会作废手机/电脑实时登记，
但本次开机期间的下载完成与“曾打开 App”标记保留。安全蓝牙就绪后，第五步提示返回 App；
完成首次引导仍要求登记新鲜、正在投屏和电脑控制心跳在线。这些进度不跨重启/重置持久保存。

扫描列表立即显示 40 × 40 LVGL 转动动画及“正在扫描 Wi-Fi”“通常需要 3-5 秒”“请稍候”；
状态缓存不变时动画仍独立运行。扫描期间仅可选“返回上一级”，短按确认回到设置且后台继续扫描，
上下键不能选中旧 SSID。完成、失败和离开页面均销毁转动控件及动画。
14/20 px 字体子集现覆盖 217 个非 ASCII 字符及全部 95 个可打印 ASCII 字符。

| 检查 | 结果与边界 |
| --- | --- |
| Host tests | 引导响应、Wi-Fi、登记过期/网络失效及引导界面模型的局部检查 PASS，不代表完整宿主门禁 |
| 扫描界面专项 | 重新链接后，真实 LVGL `--scan` 字形/布局、缓存状态下动画角度变化及完成/失败/返回的销毁检查 PASS；配网模型专项 PASS。属于宿主验证，不是实体屏幕验收 |
| Build | PASS：最终 ESP-IDF 编译、布局与匹配归档校验通过，日志 `apps/esp/build/onboarding-v17-build-final.log`；此前为合入新增修复停止的构建仍保留部分日志 `apps/esp/build/onboarding-v17-build.log` |
| 烧录 | PASS：COM5 仅向 `0x10000` 写入 1,653,520 字节 App，哈希校验通过；擦除范围 `0x10000..0x1a3fff`，保留 NVS。日志 `apps/esp/build/onboarding-v17-flash.log` |
| 首轮真实 LAN 请求 | Node 5 秒时限下全部 200：首页 1,063ms、状态 850ms、APK 1,869ms/49,634 字节，SHA-256 `7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812` 正确。证据 `apps/esp/build/onboarding-v17-lan-after.json` |
| 连续下载复测 | 20 秒时限 curl 前两轮收到完整且哈希正确的 APK；第三轮 exit 18，headers 为 200，正文 0/49,634 字节，连接提前关闭。证据 `apps/esp/build/onboarding-v17-curl-failure.json`。稳定下载不能标记 PASS |
| 失败后串口观察 | 等待约 0.8 秒后，只读 `NETSTATUS` 仍回复已配置、已连接、IP `192.168.100.167`；本次有限观察未见 panic，不代表已排除所有重启或射频问题 |

合并镜像 SHA-256：`c406fda1b03bb44c714a7f79901d237a28f11685b73ce9897ac364f5156d5884`（1,719,056 字节）。
App SHA-256：`b48433843b2fef27cdff175019a40d0366eae098ba3da491b25fcad709f580ed`（1,653,520 字节）。
ELF SHA-256：`31d015819ac3160bc1d67f9fd73969bf46214b182889c838e388961136ab0e67`。
归档：`apps/esp/build/firmware/c406fda1b03bb44c714a7f79901d237a28f11685b73ce9897ac364f5156d5884/manifest.json`。
首次完整传输及后续失败均保留，尚未证明稳定下载或唯一根因。
新增引导进度、扫描等待动画、耗时文案和返回操作已刷入，但仍待实体交互验收。

## v16 私网 HTTP Socket 延迟——实测结果不一致

2026-10-17：唯一后续传输改动是在已接受的私网 HTTP Socket 上设置 `TCP_NODELAY`。
局部 HTTP/Socket 宿主检查通过。该改动针对 v15 延迟、header分次到达的症状，
下方真实请求结果不一致，尚未证明稳定传输或唯一根因。

| 检查 | 结果与边界 |
| --- | --- |
| Host tests | 仅 HTTP/Socket 局部检查 PASS，不代表完整宿主门禁 |
| Build | PASS：编译、布局及匹配归档校验通过；日志 `apps/esp/build/onboarding-v16-build.log` |
| 首轮烧录尝试 | 写入前失败：打开 COM5 时 `FileNotFoundError(2)`，枚举无串口，UDP 也未发现控制板。原日志保留：`apps/esp/build/onboarding-v16-flash.log` |
| 重连后烧录 | PASS：同一已验证 efbb 产物已向 `0x10000` 写入 1,653,008 字节 App，哈希校验通过；擦除范围 `0x10000..0x1a3fff`，保留 NVS。日志 `apps/esp/build/onboarding-v16-flash-reconnected.log` |
| 串口启动响应 | PARTIAL：只读 `WIFI_STATUS` 返回 `configured=false`、`connected=false`、空 IP，证明固件运行但尚未配置 Wi-Fi。证据 `apps/esp/build/onboarding-v16-serial-status.json` |
| 手动联网后的首轮 LAN 请求 | Node 5秒时限下全部200：首页679ms、状态656ms、APK 4,969ms/49,634字节，SHA-256 `7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812` 正确。证据 `apps/esp/build/onboarding-v16-lan-after.json` |
| 独立复测 | 紧接着20秒时限curl返回code200，但仅收到27,648/49,634字节；首字节0.858120秒、总耗时20.015450秒。保留 `apps/esp/build/onboarding-v16-apk-curl-failure.json`、`apps/esp/build/onboarding-v16-apk-headers.txt` 及截断文件 `apps/esp/build/onboarding-v16-real.apk`。不能标记稳定下载通过 |

合并镜像 SHA-256：`efbb291922f47e9dae6e942ba755b07a92110a5f1895b5c308e2037fcf6299fa`（1,718,544 字节）。
App SHA-256：`4ebe846851bec4a5390414ebb9473c5453fb58aa0aa245d260dc9225be53c4bd`（1,653,008 字节）。
ELF SHA-256：`c815854717cde475b2da6d8be6abe2000fb75683c6f0a780741d709ad79f7956`。
归档：`apps/esp/build/firmware/efbb291922f47e9dae6e942ba755b07a92110a5f1895b5c308e2037fcf6299fa/manifest.json`。
首轮缺串口失败保留在记录中，之后已安装同一已验证产物。
汇总证据：`apps/android-mcp/build/device-tests/firmware-final-v16.json`。
实体菜单/清空密码仍未验证；完整首轮与截断复测均保留，没有宣称稳定下载通过或唯一根因。

## v15 清空密码、Wi-Fi 重试与双栈局域网引导

2026-10-17：密码完成菜单新增“清空密码”，保留“删除一位”。清空会擦除整个密码缓冲区，
包括当前字符串结束位置之后的残留字节，并返回键盘选行状态，保留 SSID 和键盘位置。
纵向菜单现有五项。
未配置网络时，启动停留在引导步骤一，不再自动进入无线网络；用户主动选择“设置”再进入“无线网络”才开始扫描，没有新增控制状态。

已确认 ESP-IDF HTTP 监听采用 `PF_INET6` 双栈 Socket，私网 IPv4 客户端可能表现为
IPv4-mapped IPv6 地址。引导服务现先归一化这类地址，再执行既有私网判断，同时保留普通 IPv4 支持。
修复前，对已安装旧固件 `http://192.168.100.167:3334/` 的真实局域网请求中，
`/` 和 `/api/status` 均返回 HTTP 403，证据为 `apps/esp/build/onboarding-v15-lan-before.json`。

首次 Wi-Fi 连接现最多尝试四次，按 500/1000/2000 ms 退避；重试期间保持
`connecting=true`、`failed=false`，耗尽后才报错。连接 API 立即错误也会重试，
配置暂报 `WIFI_STATE` 时在 250 ms 后重试。旧配置、错误接口或错误 SSID 的 GOT_IP 事件被拒绝。
曾连通网络继续有界退避重连，`ALL_CHANNEL_SCAN` 按 RSSI 选点，不锁定 BSSID。

| 检查 | 结果与边界 |
| --- | --- |
| 引导接口 | 扫码/连接首页、APK 下载、状态及登记的局部 handler 回归 PASS，覆盖 IPv4-mapped 对端；属于宿主验证，不是手机浏览器验收 |
| Wi-Fi 后端 | 重试、配置状态冲突及过期 IP 事件的局部回归 PASS；未运行完整宿主门禁 |
| 密码/设置模型 | 专项纯模型程序 PASS，覆盖整缓冲区清空、保留 SSID/位置、空密码幂等及既有单字符删除 |
| UI 编译 | PASS：UI/模型/字体及 mock getter 编译链接通过，未执行 UI 用例 |
| Build | PASS：最终 ESP-IDF 编译、布局与匹配归档校验；日志 `apps/esp/build/onboarding-v15-build-final.log` |
| 烧录 | PASS：COM5 仅写入 `0x10000` 的 1,652,976 字节 App，哈希校验通过；擦除范围 `0x10000..0x1a3fff`，保留 NVS；日志 `apps/esp/build/onboarding-v15-flash.log` |
| 真实局域网响应 | 板子自动连回 `192.168.100.167`，`/api/status` 返回 200/512 字节。Node 5秒首页/APK请求超时；12秒 curl 首页仍无完整响应，单次状态请求耗时3.19秒且header分次到达。证据 `apps/esp/build/onboarding-v15-lan-after.json` |
| 长时限 APK 完整性 | 另一次20秒时限的curl下载完成：HTTP 200、49,634字节，首字节4.342146秒、总耗时10.688854秒；SHA-256 `7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812` 与预期APK一致。证据 `apps/esp/build/onboarding-v15-apk-curl.json`；此前短时限失败仍保留，响应性能仍差 |
| Device tests | 真实LAN状态/APK传输结果见上；实体密码菜单、重试/射频行为及手机浏览器完整流程仍为 UNVERIFIED |

合并镜像 SHA-256：`1dfb61496156a047546609cd8737fcc8178f10012a1732ba2ee4ae022fa6f579`（1,718,512 字节）。
App SHA-256：`93fbed860a0edd14926f497ecf0e64adf2e11b4b7fc3f48992363f69f6da1090`（1,652,976 字节）。
ELF SHA-256：`437cbf4de1dd7eddf7f98563d4a1272023e5620320e140d343902be59148e6fa`。
归档：`apps/esp/build/firmware/1dfb61496156a047546609cd8737fcc8178f10012a1732ba2ee4ae022fa6f579/manifest.json`。
长时限APK下载成功不能证明首页/下载延迟已达可用水平，也不能据此认定唯一根因。

## v14 ESP Wi-Fi 完整扫描与分页

2026-10-17：扫描由只取 8 条原始记录改为保留信号最强的 **64 个独立 SSID**。
先遍历 SDK 返回的全部 AP 记录，再按 SSID 去重、同名保留最强 AP，并按 RSSI 排序。
采用中国 2.4 GHz **1–13 信道**及 **100–300 ms** 主动扫描驻留时间。
已发布/待发布 AP 列表放在静态存储，轻量状态仅携带扫描版本；带版本校验的 getter 每次只复制一个 AP。
设备列表每页四项，所有结果、“重新查找”和“返回”均可到达；返回保持最后页，
同数量的新扫描也会按版本刷新名称。

| 检查 | 结果与边界 |
| --- | --- |
| Build | PASS：ESP-IDF 5.5.3 编译、固件布局及匹配归档校验通过 |
| Host tests | 仅 Wi-Fi 后端局部回归 PASS；未运行完整宿主门禁 |
| UI 编译 | PASS：仅原生 UI/模型/字体编译及 mock getter 链接，未执行 UI 用例 |
| 烧录 | PASS：COM5 仅写入 `0x10000` 的 1,651,520 字节 App，写入哈希校验通过并 RTS 重启；日志 `apps/esp/build/wifi-v14-flash.log` |
| 电脑服务 | 已重新启动，`GET /health` 返回 `status=ok`、buildId `ee8995646ca7089ab7ec`、runtimeVersion 9、地址 `http://192.168.100.160:8790/`；证据 `apps/android-mcp/build/device-tests/firmware-final-v14.json` |
| Device tests | NOT RUN：实体扫描完整性、实际射频/信道行为及板上菜单分页仍为 UNVERIFIED |

擦除范围为 `0x10000..0x1a3fff`，NVS/PHY 和既有设置、蓝牙绑定保留。
本次刷入没有执行恢复出厂设置（`resetTriggered=false`）。这不能证明所有附近网络均可见，
ESP32-C3 仍只扫描 2.4 GHz 网络。

合并镜像 SHA-256：`bede789711c50b673df0b525665a92cd265478eff11fcd99e3dda203f9520ab0`（1,717,056 字节）。
App SHA-256：`c45b3eabcb146a081585385a9e522e9c2b5cd9af7c631fadf9cf5adc66e0c6eb`（1,651,520 字节）。
ELF SHA-256：`72aa50d2e69494dbdb6ca4c2a499c869b181bb440725490f7f4284525072fa08`。
归档：`apps/esp/build/firmware/bede789711c50b673df0b525665a92cd265478eff11fcd99e3dda203f9520ab0/manifest.json`。
成功构建日志：`apps/esp/build/wifi-v14-build-fixed.log`；下方旧版本证据作为历史保留。

## v13 ESP 设置内重置设备

2026-10-17：已在设置内加入“重置设备”，确认页默认返回；实体确认“清除并重新开始”
后释放输入并重启，在 BLE/Wi-Fi 启动前清空默认 NVS，重走连接引导。手机需忽略旧配对后重配。
本次仅更新应用镜像 `0x10000..0x1a2fff`，没有触及现有 NVS，未代替用户执行重置。
Build：PASS（编译、布局与归档校验）；Host tests：NOT RUN；Device tests：NOT RUN
（按用户要求跳过测试，COM5 烧录及写入哈希校验成功）。Unverified：实体菜单和实际重置流程。
合并镜像 SHA-256 `4f65a1e31e90afb7068c736fa5d41b2dbd6a485c60f765827af737a5228c2699`，
ELF `6460009723503134474b489277044bebc9eeef7e3f8d2af705c113355484c879`。
日志 `apps/esp/build/reset-v13-{build,flash}.log`；下方 v12 实机结果属于历史固件，不能当作本版验收。

## v12 设备操作台、四档预览与控制器卡片界面

检查时间：**2026-10-17。安装包、四档预览及一分钟60Hz真机输入通过；持续画面流畅度与MCP空闲连接稳定性尚未通过。**
本节记录当前版本，下方 v11 及更早版本保留为历史证据。

| 检查 | 结果与证据 |
| --- | --- |
| 局域网操作台 | 默认监听 `0.0.0.0:8790`，显示真实私网地址；本机与私网 peer/Host/Origin 可访问 HTTP、MCP、WebSocket，公网及无效来源拒绝。真实一加通过 Wi-Fi 访问电脑 `/health` 成功，见 `phone-to-console-lan-v12.json` |
| 产品名称与界面 | 电脑为“设备操作台”，ESP 为“设备控制器”，手机为“设备投屏”；三端暗色卡片，主题 `#d4380d`。已有 BLE 标识及 MCP 协议名称保持兼容 |
| ESP 按键与图示 | 正文14px/标题20px；右缘三段主题色无文字指示贴合圆角，上下距边4px。主界面上下选择，默认“紧急停止”，确认后变“取消急停”；取消仅实体确认。设置与返回纵向排列，密码保留原行/字选择。说明图参照实物外壳、挂绳槽、偏上屏幕、扬声器和三个侧键位置，不提示电源键 |
| ESP 主机验证 | 实际 LVGL 字形/文字边界/逐像素右缘/说明图结构、增量与整帧重绘一致、100次静止零刷新、120次切页稳定、快速导航与急停优先回归通过。201个非ASCII+95个ASCII字形，14/20px；24KiB池峰值17,080字节。二维码两张实际解码通过；不能替代真实摄像头扫码或实体按键验收 |
| 四档真实预览 | 同一手机与控制轮次各20秒：极速360灰度 **14.60fps**、快速540彩色 **16.35fps**、标准720彩色 **10.95fps**、原画1080彩色 **7.30fps**；2401/2401条30Hz小幅MOVE收到协议确认，零新增断流/错误。此轮ESP为v11，不冒充新UI固件验收，见 `profiles-v12.json` |
| 原图与坐标 | Pillow逐像素验证8张图：极速确实灰度，四档MCP均返回1080×2400彩色新原图；预览档位不改变物理坐标/控制轮次。原图按需请求391–823ms，切档后恢复标准并释放输入 |
| 延迟与限制 | 四档画面年龄中位/P95依次51/113、44/113、105/298、165/499ms。协议ACK中位约2ms/P95约7ms，不是手机可见响应延迟；最大画面间隔仍约1秒。迟到帧携带增长的源年龄并成批到达，尚不足以认定采集pending1000ms为根因，保留7cff APK，不盲改超时或伪造新帧 |
| MCP取消传播 | 超时/取消贯穿原图HTTP与队列；排队任务立即拒绝且轮到时跳过，进行中的body被取消，迟到响应不发布；不会停其他观察者或预览源。6项回归完成红绿验证，动作超时不重放 |
| Windows端口占用 | Windows上127或具体LAN地址的非HTTP监听可与通配绑定重叠；启动前TCP预检避免误连，占用时进入已有换端口流程。原失败fixture不改监听来掩盖问题，foreign保持运行，回归通过 |
| PC主机门禁与EXE | 最终版本typecheck/build、Node383/383、根CLI35/35通过；EXE12/12、120秒纯loopback压力通过：150KiB夹具30.05fps、最大间隔48ms，丢ACK不重放、重连/关闭/释放通过。压力数据是夹具，不是手机实收帧率。日志 `delivery-v12-*.log` |
| 观察者与画质修复 | 只读原图请求失败不再误停其他输入持有者，本会话失败仍安全释放，旧轮次晚失败不伤新持有者；4项回归通过。实时帧同步实际画质与文案，本页切档及迟到旧帧不覆盖选择，完整VM62/62通过 |
| 视频写入修复 | 原大帧专项曾在全量失败，独立两次通过；新增确定性突发回归证明末帧及断流通知会遗失。改为一条在写记录加一个最新待发记录，回调后发送，排队时间计入帧龄，过3秒不发送，断流通知优先；3项红转绿，专项15/15通过，原1秒时限及夹具未放宽 |
| 最终ESP固件与MCP | 照片指南固件完整门禁通过，COM5分段烧录后三段哈希校验通过，NVS/PHY及BLE绑定保留。与旧9aed EXE的官方MCP13次调用/42报告通过保留在 `exe-real-v12.json`。最终ee899 EXE初始化/listTools20项、10次调用与42/42报告完成，但随后16秒空闲检查发现socket已关闭，尚未归因，见 `exe-real-v12-owner-fix.json`；不能标整轮MCP稳定性通过 |
| 最终60Hz实机压力 | 首轮9aed EXE约49秒时结束，2950已发/2948确认，原FAIL保留 `exe-real-soak-v12-final.json`。最终ee899 EXE与照片指南固件增强复测60秒3600/3600、60Hz最大±127 MOVE通过，ACK中位2.14ms/P95 7.01ms；694帧/11.57fps、帧龄中位101ms/P95 301ms、最大间隔1331ms，仍有卡顿。恢复标准/armed=false，BLE连接/加密/绑定/就绪，见 `exe-real-soak-v12-owner-fix.json`；后续通过不抹去先前失败，也不证明其根因已修复 |
| 最终浏览器 | 新EXE页面已重新加载，真实内网画面、三项连接就绪及标准画质文案正常；未进入远控，保持释放输入。截图 `operator-v12-final.png`。本轮未重复点击/Esc实体输入验收 |

EXE：`build/windows/设备操作台.exe`，buildId `ee8995646ca7089ab7ec`、runtimeVersion=9，
SHA-256 `27771d8856f567299f91660c404f3f8358b03f51cb36726bc48e0687539d6357`，93,252,608字节。
已安装APK SHA-256 `7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812`；
已读取目标一加 `dcf4e720` 的系统实际base.apk核对一致。
当前访问地址 `http://192.168.100.160:8790/`，MCP `http://192.168.100.160:8790/mcp`。

最终ESP合并SHA-256 `d5f3e4c493506804cd0c2ae0a1dd56a8e3f4eb1de1d0c9fa1efdd8898eb83d2b`，
ELF `78cc0a475ec56c9f4eb4622821fc2f3e0d6aadc78f150951cb25c1517592191f`。
App 1,645,552字节，merged 1,711,088字节；已核对App内嵌APK与上方安装包逐字节一致。
仅分段写入bootloader、分区表、App；`0x9000..0xffff`的NVS/PHY未触及。
完整门禁及烧录日志为 `apps/esp/build/device-ui-v12-photo-final-{gate,flash}.log`。

运行时图像始终来自手机LAN MediaProjection，输入始终经过ESP BLE；ADB仅用于安装、授权准备和诊断。
尚未验证新菜单的实体操作/显示、实际扫码完整初次引导、其他厂商及持续30fps；
源码未提交或push，自动检查保持PAUSED。

## v11 历史：固定帧率、快速滑动和连接引导

检查时间：**2026-10-17。静止降帧已移除，快速移动回归通过；持续 30fps 实收和
真实 ESP 内网首次连接尚未通过。** 下方 v10 为历史记录，当时产物以本节为准；当前版本见上方v12。

| 检查 | 结果与证据 |
| --- | --- |
| 固定采集节拍 | 连续流固定 33ms 目标，静止也不降到 500ms；双 ImageReader 轮换且只允许一个待合成刷新，独立 JPEG worker/两个 bitmap/一个最新待编码帧，保留原图 1080×2400、JPEG75 和真实采集时间 |
| 真实静止对照 | 旧版 60s：PC 1.78fps、手机直读 1.80fps；首版固定采集手机约 25–27fps。单路电脑首版 6.05fps，加入会话 Wi-Fi 性能锁后另一次 60s 为 **8.2fps**、源年龄中位 157ms/p95 348ms，零断流/超时。后者是该次实测，不能保证所有网络提速；见 `preview-{baseline,single,wifi-lock}-v11.json` |
| 快速滑动 | 浏览器累计/缩放位移超限改为合并并限制纯移动，不再错误急停；按键/鼠标边沿仍顺序保留。真机 COM5→BLE 一分钟 **3601/3601** 条最大 ±127 MOVE 通过，ACK 中位 2.00ms/p95 6.87ms，无错误；见 `exe-real-soak-v11-fast.json`，该记录使用 v10 ESP 固件、新 PC 与首版固定采集 APK |
| ESP 六步引导 | Wi-Fi→二维码与 IP→下载/安装 App→手机蓝牙→电脑 EXE→操作。板上直接提供嵌入 APK，HTTP3334、UDP3335；扫码或浏览器输入地址下载，并明确手机/电脑/ESP同一局域网。注册不授予输入权限，实体下键急停优先 |
| 发现与归属 | 手机收集去重后只自动选择唯一板；多板须扫码选择目标；旧 IP 按已选择设备名恢复，旧请求不能覆盖新选择。电脑自动发现填入手机地址/UUID，保存前不控制；USB 选择保留 |
| 回归 | 仓库 typecheck/build PASS；Node **338/338**、操作台 **47/47**；EXE **11/11** 打包/HTTP/stdio/生命周期 PASS；原生 socket/pixel/cadence/setup/Wi-Fi 锁回归 PASS；ESP 中文布局/203个非ASCII字形覆盖/真实二维码解码 PASS |
| 同版 MCP 真机 | 最终 EXE+APK+ESP 上，官方 SDK 初始化/listTools 20项、13次工具调用、42条 WS 报告/63次心跳均通过；主页/移动/返回/等待返回动作后真实新图，结束释放输入且保留加密绑定。见 `exe-real-v11.json` |
| 最终固件连续控制 | 同版最终产物一分钟 **3600/3600** 条60Hz最大幅度来回 MOVE 通过，ACK中位1.99ms/p95 6.83ms、画面年龄中位128ms/p95 273ms，697帧/**11.62fps**，无错误。该轮为桌面壁纸画面，不能替代前述 App 静止内容8.2fps对照。见 `exe-real-soak-v11-final.json` |
| 最终浏览器 | 真实 IAB 点击画面进入、Esc退出通过，最终画面显示约11–13fps且三项连接状态正常；操作台留在退出远控、继续投屏状态，见 `operator-v11-final.png` |

当前 EXE buildId `4738559a1d6f4e80029a`，runtimeVersion=7，SHA-256
`eec2f0923406af9bd8ed973f140e7d8ebede3776f47fce4f5c5712967e0c3ec7`（93,224,448字节）。
最终 APK SHA-256 `e3ada15f097807ff5ee1750ff8dc498ce04b93a8bd88f88bc4c3b107f1bda234`
（45,538字节），已覆盖安装并读取系统实际 base.apk 核对一致；一加显示 high_performance 锁已持有。
最终 ESP 合并 SHA-256：`b2d3ca6c37d5d0a06315abba868bdef03bbe602cc1c71e46c1302baf761a2a70`，
ELF：`b4f2b7f4dacc9a4ea217512177cf1c709509dc09169481e223d7eccad0ad6e06`。
App 1,652,576字节、merged 1,718,112字节；完整门禁含 C/LVGL 和 124项 Python检查通过
（21项原有平台跳过）。直接搜索 App 镜像确认嵌入的 45,538字节 APK 与最终安装包逐字节一致。
分区表与 v10 相同；已向同一 COM5 C3 分段写入 0x0、0x8000、0x10000，未触及
0x9000..0xffff 的 NVS/PHY，原有 BLE 加密绑定自动恢复。
门禁与烧录日志：`apps/esp/build/onboarding-v11-{final-gate,flash}.log`。

自动审批拒绝通过 USB 设置 ESP 当前 Wi-Fi（仅 `blocked by policy`），未换接口重试。
因此保留 COM5 联调，板上需要通过现有屏幕键盘连入同一内网后才能验证真实
扫码下载、手机登记和电脑发现。未把 host 仿真、QR 图片解码或普通 API 编译当作真实扫码验收。
运行时画面始终来自 LAN MediaProjection，输入始终走 ESP BLE；ADB 仅安装、授权与只读诊断。
尚未验证真实摄像头扫码、主动 AP/改 IP、实际多板、其他安卓厂商及持续实收30fps。
源码未提交或 push，自动化保持 **PAUSED**。

## v10 历史：Windows EXE 与连接稳定性验收

检查时间：**2026-10-17。Windows EXE、官方 MCP 与一加/COM5 核心链路及
两分钟连续真机控制 PASS。** 手机当前经 Wi-Fi `192.168.101.46:8791` 提供真实
MediaProjection 画面；电脑以 USB COM5 连接 ESP，再由原有加密 BLE 配对输入。
运行时未使用 ADB 截图或 ADB 输入回退。点击画面进入、Esc 退出、移出画面继续控制，
没有开始/接管/暂停按钮。

| 当前检查 | 结果与证据 |
| --- | --- |
| Windows 单文件 EXE | 已生成 `build/windows/QDD-Android.exe`，内嵌 Node 24.15.0、五个页面资源及原生串口模块；空 PATH、中文/空格/# 路径通过，无需另装 Node/npm |
| EXE 设置/生命周期 | **11/11 PASS**：首次设置及并发提交防覆盖、重复启动复用、旧有 EXE 替换、同进程五轮配置重载/换端口、串口/TCP 释放、外来端口占用恢复及旧设置页收尾 |
| 输入通道 | 浏览器 WebSocket 独立于 HTTP 视频/MCP 连接池；四条按序待 ACK，250 ms 续约不等待报告 ACK；丢连接释放，不重放输入 |
| 断连恢复 | 观看自动按 0.5/1/2/4/5 秒退避重连；恢复观看后重新点击进入控制；旧报告、旧心跳、旧工具超时/取消不误停新控制轮次 |
| 主机门禁 | 根目录 typecheck/build PASS；`test:android` **319/319 PASS**，含 MCP 46 项、串口/TCP 46 项、操作台 44 项。日志 `build/device-tests/host-v11-observer-tests.log` |
| 原生投屏 | socket 12、像素 3、刷新节拍 2 项 PASS；最终 APK 已核对 manifest/哈希并覆盖安装，系统投屏授权完成 |
| COM5 实体中性检查 | 181 秒、90/90 STATUS、三次关闭/重新打开均通过；BLE connected/encrypted/bonded/ready=true，armed/locked=false。零非中性输入，见 `usb-neutral-soak-v10.json` |
| 一加静态真实内网流 | 30 秒、55 个唯一源帧、1.83 fps；帧龄中位 123 ms、p95 267 ms；原始 1080×2400，零断流/写失败。见 `native-v10-static.json` |
| EXE 官方 HTTP MCP / 真实 ESP | 20 个工具；截图与 home、两次相对 move、escape、back、wait 均返回 JPEG；每次高层操作后为不同、动作完成后采集的源帧。见 `exe-real-v10.json` |
| EXE WebSocket / 真实 ESP | 42/42 鼠标键盘报告确认，报告 ACK 中位 8.07 ms、p95 14.28 ms；空闲 16 秒、63 次续约回复不断连；STOP 后 armed=false、BLE 就绪/加密/绑定保持。ACK 不是视觉延迟 |
| 最终 EXE 两分钟真机持续控制 | **PASS**：120.008 秒、3600/3600 MOVE（30 reports/s）、465 次续约回复、1819 张完整真实 JPEG（15.16 fps）；零断流/输入错误。ACK 中位 2.02 ms/p95 6.87 ms，源帧年龄中位 79 ms/p95 199 ms，最后释放/未锁定。见 `exe-real-soak-v10.json` |
| 只读会话 | 另一个官方 SDK 观察会话读取并关闭后，原输入持有者仍 armed=true，不被观看连接打断 |
| 观察页误暂停修复 | 纯观看页面隐藏/离线/关闭/画面错误不再发送全局 PAUSE；本页发起实际控制后仍在退出时释放。VM 红→绿验证；runtimeVersion=6 阻止旧页面重连新版 |
| ESP 完整门禁与更新 | 新 50 ms USB SOF 丢失确认通过完整门禁，Python 124 项（含既有平台 SKIP）、C/LVGL 通过；分段烧录 0x0/0x8000/0x10000 并校验，保留 NVS/PHY 与蓝牙绑定 |
| USB 修复后的真实直连 | 同时接收手机 LAN 视频，60 秒 1800/1800 MOVE、每秒 30 条，无心跳过期；清理前 BLE 就绪/加密/绑定、armed=true。见 `usb-realtime-trace-v10.json` |
| 实际 IAB 操作台 | 最终 EXE/固件真实 PASS：点击画面进入、整页 cursor=none、画面右侧外点击仍控制、Esc 后 cursor=auto/无错误；连续 MCP 控制中跳转连接设置再返回也未打断。截图 `operator-v10-final.png`、状态 `operator-v10-final.json` |
| 重复双击 EXE | PASS；正常启动入口打开操作台并复用 PID 54280，没有第二个服务或串口实例 |
| 同传输内核前包 loopback 压力 | 前包 `4ad1c514…`：120 秒、3602 张 150 KiB JPEG、30.009 fps、4508 个 WS ACK；15 秒空闲、WS 断开恢复、TCP 丢 ACK 不重放通过。**仅夹具指标，零真实设备输入**，见 `build/windows/exe-soak.json`；最终包另通过上述真机检查 |

`android_control` 自动准备一次输入并返回新画面；tap/swipe 仍要求真实标定。
普通 AI 输入接管浏览器时关闭旧浏览器输入会话，旧停止/取消请求无法停掉新操作者。
当前轮次失败仍释放键鼠，物理 DOWN 急停始终优先。

手机原热点在本轮中消失，用户提供当前 Wi-Fi 后已通过普通系统设置连接，
电脑与手机处于同一个 `/23` 内网并实际 HTTP 验证身份；未将代理 TCP 成功当作设备可用。
Wi-Fi 密码未写入项目、构建配置或测试日志。ADB 只用于安装、配网、系统投屏授权及只读诊断。

原图静态采集耗时中位 81 ms，其中 JPEG 编码 56 ms；33 ms 是采集间隔上限，
**未证明手机可持续 30 fps 或完全流畅**。两分钟鼠标运动期间实测约 15.16 fps。
ADB 打开动态诊断页被自动审批拒绝（仅返回 `blocked by policy`），该操作已停止，
未更换接口绕过。复杂动态内容/持续 30 fps、
主动 AP/换 IP 恢复、旋转/重新授权、实体 DOWN/OK 新一轮与其他安卓厂商仍不作通过声明。

最终 EXE SHA-256：`549e491565cf7068e10632c458e8f8bf2cf6684b96b84ec284424e2beb7f62a4`，
buildId `972b70a19caa74ca1b38`，93,210,624 字节，runtimeVersion=6。
已安装 APK SHA-256：`d2343a4c42539df17524fe651efc981f5d1570384de299707c3bb7ad01117c59`，
已读取一加系统实际安装包并再次核对一致。
当前 ESP 合并 SHA-256：`24c50368241392d8446af94f08e4fc2585c4d4cd597b387c0994aa108e4e284d`；
ELF：`f104f221c6ecc8add6c53544e2923509a926948e9cdaa14cdb50e04383028814`。
App 1,534,688 字节、merged 1,600,224 字节，分区表与 v8 相同；未擦除 NVS 或蓝牙绑定。
完整门禁/烧录日志为 `apps/esp/build/usb-stability-v10-{gate,flash}.log`。

连续输入最初在 364 条后失败，保存为 `exe-real-soak-v10-before-usb-fix.json`。
独立 USB trace 随后记录：PING 8453 ms 已确认，MOVE 8640 ms 仍正常，8660 ms 却
返回 `HEARTBEAT_EXPIRED`。SDK SOF 在线信号短暂抖动会立即清除旧控制源。
原 probe 曾错误吞掉异步拒绝并标 PASS，原始数据与纠正记录分别保留为
`usb-realtime-trace-v10-original.json` 和 `usb-realtime-trace-v10-audit.json`，不算通过证据。
修复仅对原始 USB 信号确认连续丢失 50 ms，1500 ms PING 与实体 DOWN 仍独立生效。
源码未提交或 push，自动化保持 **PAUSED**。

## v9 历史：传输与 MCP 联调

以下为 v9 的阶段快照；当前进度、进程和产物以本页 v10 为准。

检查时间：**2026-10-17。已实现连续二进制画面与四报告实时输入窗口，首轮真机吞吐
有所提高；整体连续流畅度仍未验收。** 点击画面进入、Esc 退出、移出画面不退出及
整页隐藏电脑光标的交互保持不变。

| v9 改动/检查 | 证据与边界 |
| --- | --- |
| 手机采集 | 每 33 ms 最多一帧（约 30 fps），JPEG 质量 75；保留 1080×2400 原尺寸，减少连续 RGBA 和重复缓冲区复制；不是持续 FPS 实测保证 |
| 手机新版安装 | APK SHA-256 `d55e935bb6a36b108fe8e67a768c00c723f1073d394f9ab1135984ceb9e540d5` 与 manifest 核对后覆盖安装一加 8，用户重新确认投屏授权；原签名一致 |
| 电脑到浏览器 | `/screen/stream` 二进制 JPEG，不再为操作台逐帧 Base64 转码；只留最新待解码帧，传输/解码仍计入三秒时效；SSE 仅保留兼容 |
| 人工输入 | 最多四条待 ACK 报告，发送不再逐条等待 Wi-Fi 回执；每轮序号保留鼠标/按键边沿顺序；缺序号、取消或确认错误即释放，不重放 |
| 普通 AI 输入 | 等已有实时报告完成后独占执行，保留坐标标定、截图守卫与原有定位节拍 |
| MCP | 20 个工具；新增 `android_control`，使用本会话 frameId，内部准备一次动作并返回动作完成后采集的真实新帧；图片超时明确返回动作是否已经完成，不能盲目重做 |
| 会话归属 | 只读观察会话或视频观看连接关闭不再中断其他操作者；输入持有者断开、真实源丢失仍释放键鼠 |
| 主机专项回归 | 输入/串口/TCP 92/92；画面 TS 33/33；原生 socket 10/10、像素 3/3。完整最终门禁与新进程证据待本轮最终联调补齐 |
| ESP | 沿用 v8 合并 SHA-256 `8e4045a5bbf943793ef9f10934bb2ac0108e8969ebdc7f9248562d0728cd2462`；本轮未烧录、未改描述符或 NVS/蓝牙绑定 |

首轮同版后端对照使用真实 ESP Wi-Fi → BLE → 一加，48 次交替 ±2 的 MOVE 均 HTTP 200：

| 输入模式 | 48 条总耗时 | 吞吐 | HTTP 请求完成中位 / p95 |
| --- | --- | --- | --- |
| 串行兼容路径 | 6.689 s | 7.18 reports/s | 105 / 377 ms |
| 四报告窗口 | 4.190 s | 11.46 reports/s | 305 / 920 ms |

这说明本轮吞吐提高，**没有证明单次延迟降低**。记录中的 `medianAckMs` / `p95AckMs`
实际从发出 HTTP 请求计到读取完整结果，含主机排队、ESP 确认及 HTTP 往返；不是单独
BLE ACK、端到端画面延迟或持续视频 FPS。首轮成功记录单独保存在
`remote-performance-v9-before-initial-success.json` 与 `remote-performance-v9-after-initial-success.json`。
此前旧进程测试发到第 25 条后遇到续约 409，保存在
`remote-performance-v9-before-initial-failed.json`，不能计为成功对照。

只读 ICMP 各 20 次：ESP 最小/平均/最大 41/268/732 ms；手机 12/73/208 ms，均无丢包。
见 `lan-latency-v9.json`。这是当时热点的往返抖动，未逐样核验 TCP 控制状态，
不能直接当作 BLE 或整体操控延迟。局域网带宽快不等于每条消息往返及时；旧版
12.5 fps 采集、逐请求 ACK 等待及转码还会叠加开销。

最终连续画面、MCP 真机动作与新版浏览器流程仍在本轮联调，未以旧 v8 交互通过替代。
新版实体 DOWN/OK 与板屏、其他浏览器 PointerLock、长时资源、AP/换 IP、旋转/STOP
重新授权及其他手机仍未复验。代码未提交或 push；自动化保持 **PAUSED**。

<details>
<summary>v8 历史：简化交互与默认输入功能通过，流畅度未验收</summary>

以下 v8 哈希、进程、APK 与门禁属于历史快照；当前 v9 以本页上方为准。

## 点击进入遥控检查点

检查时间：**2026-10-17，当前一加/IAB 的 v8 交互与默认输入功能 PASS，高 FPS 连续流畅度未验收**。
当前交互为 **点击画面操作，Esc退出**。
移出画面绝不退出：document 全页继续相对输入、整页隐藏电脑光标。首次点击画面
只建立遥控，后续点击操作手机已有真实指针，不映射网页点击位置。

最终主机门禁：安卓测试 **235/235 PASS**，包含实际操作台脚本 **31/31 项 VM 回归**；
根目录 build/typecheck/diff 检查通过。日志：`apps/android-mcp/build/host-simple-v8-tests.log`。

| v8 改动/检查 | 当前证据 |
| --- | --- |
| 简化 UI | 开始/接管/暂停按钮与状态 pill 已删除，只保留固定的点击画面进入、Esc 退出说明 |
| 进入与全页输入 | 已实现：首击建立遥控，后续 document 点击输入手机；捕获阶段拦截页面点击，避免同时误触工具栏 |
| 移出画面 | 新固件/UI 真实 IAB PASS：picture 内点击后，再在右侧 15 px 外点击，仍 remoteActive=true/cursor=none/error=false |
| 光标与旧按钮 | 真实 IAB PASS：点击 picture 进入后整页隐藏光标，旧三个控制 DOM 元素数为 0 |
| 闲置工具栏 | 内部准备控制，无手动 ARM 步骤，没有手动启停 UI |
| 正常 Esc 退出 | 真实 IAB 两次 PASS：remoteActive=false/cursor=auto/error=false，activity 为远控已退出；旧 timeout 路径先复现两项 VM 失败，修复退出期间轮询后通过，同轮真实故障仍保留红错直到明确 Esc |
| ESP 默认激活 | 真机 PASS：PING → MOVE 无 ARM；PAUSE → MOVE 也无需 ARM 或 OK；TCP 断开及 1850 ms 租约过期后 fresh STATUS 均 armed=false |
| ESP 实体键 | 主机策略：DOWN 急停锁、OK 只解除该锁、短 UP 无操作、长 UP 保留 Wi-Fi 设置；本轮未实体复测 DOWN/OK 或板屏 |
| 新 ESP 完整门禁/烧录 | PASS；COM5 再次核验目标 MAC 4c11ae2fa1b8，0x0/0x8000/0x10000 分段烧录校验通过，保留 NVS 0x9000–0xefff |

连接、控制源、心跳、BLE 认证/加密、绑定、报告就绪与实体停止仍是内部门禁。
网页进入和闲置工具栏在内部处理连接准备，UI 不显示手动启停或暂停恢复流程。
MCP 兼容的 ARM/PAUSE 调用保留；固件默认激活不等于静默改变当前电脑控制器
API/AI 调用流程。

完整固件门禁 PASS，日志：`apps/esp/build/default-control-v8-gate.log`。
Python 总计 123 项，21 项平台/symlink SKIP（仓库检查 4/归档 5/安装 12）。
C/LVGL 检查通过；主机证据包含锁优先、162 字形、17 张 LVGL 帧与 120 次切屏，
不能替代上表尚未复测的实体显示。app 镜像 1534528 字节，合并镜像 1600064 字节，归档验证通过。
合并 SHA-256：`8e4045a5bbf943793ef9f10934bb2ac0108e8969ebdc7f9248562d0728cd2462`。
ELF SHA-256：`cf2e8836ac1055ba8483460bd136cd24a8fcb2793f8801f55a6e84737d597dfe`。
APK 仍为 `0a4a6f78aa1a0dfe3ee3dcc2ba6d2469251aa42ea89f5e4ab30fe72633318d1b`。

证据：`esp-default-v8-status.json`（Wi-Fi 10.65.201.147、BLE 就绪/加密/绑定，无崩溃标记）、
`esp-default-control-v8.json`（默认输入与租约）、`operator-simple-runtime-v8.json`
（源码哈希与 runtime）及 `operator-simple-v8-final.png`。操作台 JS SHA-256：
`d1959c048eba49f2ac672d853adbb18c56d10988439ce8efa4c78d63574abb78`。
runtime 的 05:23:37Z 状态是合法 active 快照（armed=true），不是空闲或最终状态断言。
旧 v7 helper 复制的 idle 断言因此失败，已单独保留，不计为固件故障。

服务 PID **40392**、runtimeVersion=3，运行于工具托管前台 session **92816**；
health=200、未知路由=404 通过。两次后台 Start-Process 被自动审核拒绝后，受控前台运行
获准，未再尝试隐藏后台启动。Esc 采样当时退出通过；稍后只读截图在另一桌面页显示
“远控已连接”，不能推断是谁重新进入，也不能声称持续空闲或持续 FPS。
服务当前可用，允许默认控制。

高帧率连续流畅度仍未验收（原生采集上限 12.5 fps）；其他浏览器真实 PointerLock、
长时资源、AP/换 IP 恢复、旋转/STOP 重新授权及其他手机仍未验证。

代码尚未提交或 push；
自动化仍为 **PAUSED**。

<details>
<summary>v7 历史：窗口内相对遥控功能通过，高帧率流畅度未验收</summary>

以下属于 v7，其中开始/接管控件与移出画面退出行为不代表当前 v8 交互。

检查时间：**2026-10-17，当前一加/IAB 窗口内相对遥控功能 PASS，高帧率连续流畅度未验收**。
用户明确允许安卓
鼠标加速度，要求隐藏电脑光标，只看投屏里手机真实的鼠标。人工遥控因此从 v6 的
定时坐标定位改为连续相对 HID 移动。下列功能检查已通过，不代表整体高 FPS 成品验收通过。

最终根目录 typecheck/build 与 diff 检查通过；`npm run test:android` **231/231 PASS**，
包含实际操作台脚本 **27/27 项 VM 回归**。日志：
`apps/android-mcp/build/host-relative-v7-tests.log`。源码已冻结。

| v7 方向与证据 | 状态 |
| --- | --- |
| 人工鼠标输入 | 已实现：动画帧调度、相对 MOVE 累加、最多一个请求传输，按键与鼠标边沿保序 |
| PointerLock | 真实 IAB 未允许捕获（lock=null），窗口内相对遥控降级已通过；真实 PointerLock 捕获与其他浏览器未验证，仅可选接管按钮重试捕获 |
| 光标显示 | 真实 IAB 单次 ARM 后 computed cursor=none，只看视频中的手机真实指针；Esc 后 cursor=default |
| 首次画面点击 | 真实 PASS：手机指针已位于主页“小工具”图标时，首击未归零、未吞掉，确实打开文件夹；不是网页点击位置的映射 |
| 安卓加速度 | 允许；人工移动是相对输入，不是网页绝对像素到手机像素的映射 |
| 人工标定、撞角归零、定时坐标定位 | 人工路径取消这些步骤，不需要坐标标定、撞角或 100 ms 定位定时器 |
| AI 坐标工具 | 原逻辑不变：明确标定、估算位置、归零/节拍和截图守卫保留 |
| 暂停与松开 | 最后 reload → ARM → 立即 Escape PASS，包含 ARM/捕获尚未完成时取消：“已按 Esc 暂停，鼠标和键盘已松开”；后续轮询仍暂停，cursor=default/errorVisible=false/lock=null；VM 回归覆盖捕获退出、窗口内移出、失焦、隐藏/离线与掉流 |
| 原始相对通路基准 | 第二轮独立运行完成：32 次 MOVE 均 HTTP 200，总计 3474 ms，约 9.2 reports/s，最后暂停 |
| 同时录制 PC SSE 的原始移动 | 32 次报告耗时 5722.64 ms，收到 40 帧/36 个图片哈希；输入 ACK 中位 107 ms、p95 479 ms、最大 714 ms |
| v7 验收边界 | 当前一加/IAB 窗口内相对遥控功能检查通过，高帧率连续流畅度仍待验收 |

浏览器证据：`operator-relative-v7-click.png`、`operator-relative-v7-final.png`。
`operator-relative-runtime-v7.json` 保存 PID **50580**、`runtimeVersion=3`、冻结哈希及
最终 BLE 状态：connected/encrypted/bonded/ready=true、armed=false、locked=false。
操作台 JS SHA-256：
`478f28690ffe426421b2b6ac7b4d8c4857988b9006926286d913dd0e8ff18b10`。
ARM/捕获待完成时 Esc 的用例先复现失败，修复后通过。最终截图为最新暂停 UI，
手机显示通知栏；此前 click 截图保留打开文件夹的证据，最后这项修复未改变其点击代码。
准备时 BLE Back 先执行，画面稍后才更新；即时缓存截图仍显示文件夹。测试等待真实
浏览器确认主页后才做文件夹首击，未把先前缓存画面记为返回失败。

原始基准只代表请求/报告吞吐，不能当作端到端画面延迟或浏览器流畅度结果。
证据为 `apps/android-mcp/build/device-tests/relative-hover-bench.json`，前后图片为
`relative-hover-before.jpg`、`relative-hover-after.jpg`。首次 helper 在用户同时操作
UI 时被取消，已与第二轮分开，不计为成功基准。

同时录像的记录为 `apps/android-mcp/build/device-tests/relative-hover-video/result.json`。
ACK 耗时不是画面延迟；本轮存在并行 SSE 录制和实际 Wi-Fi 抖动，视频采集上限
12.5 fps，不能据这些数值宣称完全流畅。初始化时旧 MCP tap(540,600) 进入了
文件夹标题编辑，但没有输入任何文字、没有更改文件夹名称；这项初始化操作不算
v7 浏览器遥控验收。

本轮修改浏览器人工输入路径，PC 后端、ESP 固件与手机 APK 哈希不变，未烧录或
处理绑定。v6 已验证的点击与安全事实保留，但其连续悬停流畅度未通过，不能算作
v7 流畅度通过。最终服务已暂停。

源帧时效仍为三秒并计入传输，AI 坐标截图有效期仍为 30 秒。长时资源压力、主动
Wi-Fi AP 掉线/换 IP 恢复、旋转/投屏 STOP/重新授权及其他手机仍未验证。
代码尚未提交或 push；自动化仍为 **PAUSED**。

<details>
<summary>v6 历史：坐标定位遥控的点击/安全已通过，连续悬停未通过</summary>

以下记录属于 v6 坐标定位鼠标模式，其中人工对齐、标定和 100 ms 节拍不适用于
v7 相对人工鼠标；AI 坐标工具仍保留自己的原有节拍。

检查时间：**2026-10-17，v6 IN PROGRESS，连续悬停流畅度未通过**。点击 ARM 后自动进入
画面直接遥控，hover 位置与点击映射到手机像素，不再要求第二个遥控按钮或
PointerLock。新版替代 v5 的窗口内相对遥控交互；此前传输与硬件证据保留在下方。

当前服务 PID **50580**，`runtimeVersion=3`。ESP Wi-Fi 固件仍为
`8b602a11edf74f123183cd70caa1d5fc6413538dd564259753934ad793aa2f42`，
v6 未重新烧录固件。

最终主机门禁：安卓测试 **226/226 PASS**，包含实际操作台脚本 **22/22 项 VM 回归**
及 `preventScroll`。证据：`apps/android-mcp/build/host-direct-release-tests.log`。
旧 poll/refresh 失败竞争先复现三项失败，修复后四项新增回归通过。该门禁早于最新
悬停流畅度反馈，不能视为本次问题已验收。

| v6 直接遥控检查 | 结果 |
| --- | --- |
| ARM 后自动直接操作画面 | 真实 IAB reload 后 PASS；一次 ARM，无第二次遥控按钮或 PointerLock 步骤 |
| 显示区域映射与输入顺序 | 主机 PASS；270×600 显示映射到 1080×2400 手机，按下/松开等边沿保序，hover 合并为最新目标而不积压 |
| Wi-Fi 真实指针目标 | 三次 HTTP 200：(540,1200)、(665,1200)、(675,1210)，耗时约 3869/393/371 ms |
| JPEG 指针位置对照 | 初始质心 (541.1,1201.46)、最终 (674.92,1212.02)，与对应目标误差约 2 px，仅代表本机观察 |
| IAB 真实直接点击 | PASS：ARM → 原生首次 hover 对齐 → 直接画面点击，正确打开“小工具”文件夹，工具截图已观察 |
| 连续悬停流畅度 | 未通过；用户反馈 hover 鼠标明显闪现、卡顿，需要优化后重新验收 |
| 旧 poll/refresh STATUS 失败与新 ARM、正常 Esc 暂停竞争 | 已修复；epoch/revision 守卫及四项新增回归防止旧失败影响新控制轮次，同轮真实错误仍正常报告并暂停 |
| 移出画面 | 真实 IAB PASS；正常暂停，无错误 |
| 最后真实 Esc 复验 | PASS；明确 ARM 后按 Escape，activity 为“已按Esc暂停，鼠标和键盘已松开”，无错误，后续状态轮询未覆盖 |

指针对照采用 JPEG 差分阈值及圆环指针质心，是当前一加手机和设置下的近似观察，
不能作为所有设备通用的标定保证。首次对齐仍约 3.869 秒，随后短距离移动约 0.4 秒。

ARM 后首次 hover 会对齐手机鼠标。请等界面提示对齐完成再点击：对齐期间有等待
提示，点击会被主动忽略，避免点到错误位置。这不是零延迟输入，也不保证所有设备
都能达到相同像素精度。

原始更快移动对照出现漂移：静置 350 ms 后移动 125 counts，实际约 175 像素；
静置 700 ms 后，125 counts 才与预期距离一致。因此当前保留每次 ACK 后 100 ms
间隔，不据此夸大快速远控表现。

证据位于 `apps/android-mcp/build/device-tests/`：

- `pointer-direct-device.json`：三个真实目标 ACK、耗时及该独立测试的最终暂停状态。
- `pointer-direct-1.jpg`、`pointer-direct-2.jpg`、`pointer-direct-3.jpg` 和 `pointer-direct-final.jpg`：真实 JPEG 指针证据。
- `operator-direct-folder-open.png`：实际浏览器打开文件夹的观察。
- `operator-direct-final-runtime.json`：最终 runtime 版本/PID、冻结源码哈希、门禁计数及实际检查记录。
- `operator-direct-final.png`：修复后最终浏览器截图。

已有点击与安全检查事实保留，但连续悬停流畅度未通过，当前整体直接遥控尚不可验收。
上一轮验收结束时已暂停，连续画面仍可用。长时资源压力、
主动 Wi-Fi AP 掉线/换 IP 恢复、旋转/投屏 STOP/重新授权及其他安卓厂商仍为
NOT RUN。源帧年龄保持三秒并计入传输，坐标截图有效期保持 30 秒。

代码尚未提交或 push；自动化仍为 **PAUSED**。

<details>
<summary>v5 历史：Wi-Fi/连续视频与此前相对遥控交互</summary>

以下记录属于 v5，其中窗口内相对遥控描述不代表当前 v6 的直接画面遥控 UI。

检查时间：**2026-10-17，v5 传输/硬件核心 PASS，直接遥控体验 IN PROGRESS**。
一加手机经内网持续发送 MJPEG，MCP 读取有效缓存帧；电脑已通过 Wi-Fi TCP 连接
真实 ESP，再由 BLE 键鼠控制手机。新固件已构建、烧录，板上选择 Wi-Fi、屏幕
键盘输入密码及控制源租约均已有真机证据。本机浏览器窗口内实时键鼠、实体停止
恢复和 Wi-Fi 坐标标定已有通过证据。但用户随后反馈：开始控制后不能直接点击
画面，hover 模拟鼠标也不跟随。现有窗口内相对遥控回退不满足该预期，默认直接
hover/click 及正确映射正在修订，完整遥控体验尚待重新验收。v4 记录单独保留为
旧 USB 路径的历史证据。

直接遥控体验新修订前，最近已完成 PC 检查：**PASS** — `npm run typecheck`、`npm run build`、
`npm run test:android`（**195/195**，已包含实际操作台脚本 **17/17** 项 VM 回归
及 11 项 HTTP 输入检查，防止慢请求正文跨越 ARM、旧回调误暂停新控制会话）。
日志：`apps/android-mcp/build/host-stream-final-tests.log`。
原生生产 FrameServer/FrameStore socket 测试 **10/10 PASS**。
新 ESP 完整固件门禁 **PASS**，包含 **18 个 C 程序**与 **121 项 Python 检查**；
分段烧录通过，保留 NVS。

| 本轮升级检查 | 结果 |
| --- | --- |
| 一加 8 / IN2010、Android 13 安装新 MJPEG APK | PASS；已覆盖旧 APK，用户已开始投屏，哈希见下方 |
| 真实手机内网 `/stream.mjpg` | PASS；25.011 秒内仅一个 HTTP GET，58 张完整 1080×2400 图片、58 个源帧 ID、32 个图片哈希，零错误 |
| 视频新鲜度与帧率 | 含传输最大有效源帧年龄 617 ms；动态画面某一秒峰值 12 帧，不代表持续达到 12 fps |
| 30 次直接读取最新帧缓存 | PASS；本机缓存方法最大 0.0301 ms |
| 官方 InMemory SDK 读取真实手机内网视频 | PASS；30 张图片，缓存命中调用中位 2.0485 ms/最大 7.8379 ms；输入 mock，零输入报告 |
| 新 HTTP 画面路径，只读 SDK 与 SSE | PASS；10/10 JPEG 截图，10 个 MCP frameId/6 个源帧 ID；调用中位 3.496 ms/最大 8.986 ms。10 秒 SSE 收到 10 张完整帧/10 个源帧 ID，最终源帧年龄最大 486 ms，零错误 |
| 板上 Wi-Fi 列表与屏幕密码键盘 | PASS；用户在板上配网成功；USB 只读状态确认 configured/connected=true、TCP 地址 10.65.201.147:3333 |
| 保留 NVS 烧录后的 BLE | PASS；自动恢复 connected/encrypted/bonded/ready=true |
| 真实 TCP → ESP → BLE 键鼠 | PASS；MOVE (12,-8)、反向移动和中性 KEY；前后内网图片确认指针 |
| 不发送 PING 的 1500 ms 控制租约 | PASS；约 1850 ms 后旧 socket 已关闭，新 STATUS 为 armed=false |
| 主动断开 TCP socket | PASS；200 ms 后 STATUS 为 armed=false |
| 官方 MCP 经 HTTP 与 Wi-Fi ESP 输入 | PASS；主页 93 ms、Tab 320 ms、返回 160 ms、PAUSE 302 ms；截图 4/4/5 ms，最终暂停 |
| 最终服务 Wi-Fi `/remote/input` | PASS；鼠标 (4,-4)、Tab 按下和键盘松开均 HTTP 200，耗时 197.59/222.51/21.925 ms；删除租约后 armed=false/locked=false/ready=true |
| 当前固件实体 DOWN/OK | PASS；DOWN 后 locked=true/armed=false，ARM 返回 LOCKED；用户按 OK 后真实浏览器显示已解锁、暂停，明确 ARM 成功 |
| 此前浏览器窗口内相对遥控检查 | 已观察 PASS：画面点击、Tab、短拖动影响手机，Esc 和移出画面暂停；这些检查不代表新要求的直接遥控体验通过 |
| 开始控制后直接画面 hover/click | IN PROGRESS；用户反馈点击和 hover 跟随不符合预期，默认交互与映射待修正并重新验收 |
| PointerLock 兼容 | IAB Chromium 仍拒绝 PointerLock，已通过窗口内遥控回退兼容该浏览器；不声称其他浏览器已验证 |
| Wi-Fi 路径的 AI 坐标标定 | 1:1 PASS；点按 (540,1200)、(550,1210)，JPEG 圆形指针与预期吻合；首次定位 5062 ms，附近第二次 522 ms |
| 长时 Wi-Fi/BLE 压力与资源余量、主动 AP 掉线/换 IP 恢复、旋转、投屏 STOP/重新授权、其他安卓厂商 | NOT RUN |

纯缓存耗时不包含采集、JPEG 编码或内网传输；InMemory SDK 缓存命中耗时不包含
首次冷读取，且输入为 mock。本地 HTTP SDK 耗时包含 HTTP 传输、服务器缓存读取/
序列化及客户端 HTTP/JSON/SDK 处理，不能当作纯缓存或端到端画面延迟；保守计入
整个 RPC 后源帧年龄最大 1245.58 ms。SSE 源帧年龄已通过同机 `sentAt` 计入传输。
后续官方 HTTP/Wi-Fi 核心输入测试使用了真实硬件，与 InMemory 测试分开记录。
Wi-Fi 首次坐标定位较慢，实测 5.062 秒，附近第二次为 0.522 秒；这些结果不能说明
Wi-Fi 控制在所有操作上都快于 USB。

证据位于 `apps/android-mcp/build/device-tests/`：

- `oneplus-stream-v5.json`：单次 GET 连续视频及 30 次直接缓存读取。
- `oneplus-stream-sdk-v5.json`：真实内网视频/InMemory SDK，零输入报告。
- `operator-stream-http-v5.json`：有界只读 HTTP SDK/SSE；结束后 SDK 关闭，服务继续运行。
- `esp-wifi-configured.json`：USB 只读 STATUS/WIFI_STATUS，无 PING 或输入。
- `esp-wifi-device-v5.json`：真实 TCP 移动、租约到期与断连停用。
- `oneplus-wifi-core.actions.json.results.json`：官方 MCP/HTTP/Wi-Fi 真实硬件操作通过。
- `operator-final-remote-v5.json`：最终重启后的真实 `/remote/input` 与租约释放状态。
- `physical-stop-wifi-v5.json`：当前 Wi-Fi 固件实体 DOWN 锁定、ARM 拒绝；随后真实浏览器确认 OK 恢复。
- `oneplus-wifi-calibration.actions.json.results.json`：真实 Wi-Fi 1:1 标定、两次坐标点按及最终暂停。
- `operator-stream-wifi-final.png`：连续 Wi-Fi 操作台最终浏览器截图。
- `oneplus-stream-motion.actions.json.results.json`：此前视频期间使用旧服务/旧固件的 USB 运动检查。

两次测试脚本写错的失败独立保留，不记为产品故障：
`esp-wifi-device-invalid-test-command.json` 将 MOVE 写成 MOUSE；
`oneplus-wifi-core-invalid-test-argument.json` 将 android_key 的 combo 写成 key。
修正后的测试均通过。

已安装流式投屏 APK SHA-256：
`0a4a6f78aa1a0dfe3ee3dcc2ba6d2469251aa42ea89f5e4ab30fe72633318d1b`。
已安装 Wi-Fi 合并固件 SHA-256：
`8b602a11edf74f123183cd70caa1d5fc6413538dd564259753934ad793aa2f42`。
匹配 ELF SHA-256：
`e2aadeae7e66e7a9f93aa46e00ddd79484367f1572cbeda76f674c0d6fd8d72a`。
本地产物哈希已核对。下方旧 `eee6…` 仅属于 v4 历史，不是当前 Wi-Fi 固件。

最终 Wi-Fi HTTP 服务运行于 PID **42880**，配置为 `ESP_HOST=10.65.201.147`、
TCP 端口 3333，健康检查为 `runtimeVersion=2`，服务不占用 COM5。重启已在用户
明确授权后由同一 PowerShell 严格核验目标进程执行，此前自动审批拒绝保留为历史
记录。当前服务保持暂停；传输/硬件证据仍有效，但完整遥控体验须先修正并复验。
NOT RUN 项仍为额外覆盖边界。

代码仍在 `codex/android-agent`，尚未提交或 push；自动化仍为 **PAUSED**。
源帧年龄限制为三秒并计入传输，坐标截图有效期仍为 30 秒，未放宽限制。

<details>
<summary>v4 历史验收：旧版 USB ESP 固件与 HTTP 操作台</summary>

以下为上一轮检查点，保留作为历史证据；其中“当前”均指 v4，不能替代当前 v5
构建的验收结果。

检查时间：**2026-10-17**。手机安装 MediaProjection 投屏 App，经 Wi-Fi 内网发送
原始分辨率 JPEG；电脑提供 MCP 图片和工具，通过 USB 串口连接 ESP32-C3，再由
BLE 键鼠控制手机。运行时手机无需 USB 或 ADB。App 与本机 MCP HTTP 服务均无需
令牌或 Authorization 请求头；MCP HTTP 仍只监听本机，并检查 Host/Origin。

构建与主机检查：**PASS** — `npm run typecheck`、`npm run build`、
`npm run test:android`（**144/144**）与 `npm test`（**35/35**）。
完整隔离 ESP-IDF 固件门禁通过，包含 **14 个 C 程序**与 **116 项 Python 检查**；
APK v2/v3 签名验证通过。主机回归覆盖官方 SDK 会话释放、取消、截图守卫、JPEG
尺寸与截断、串口冷连及操作台异步竞争。坐标操作出队时重新检查截图；源帧年龄
继续限制为三秒并计入传输时间，坐标截图有效期仍为 30 秒。

黑客松核心演示路径：**PASS**。真实 **一加 8 / IN2010、Android 13** 已通过内网
JPEG → MCP → BLE HID 链路；本检查点未覆盖所有恢复路径或其他安卓厂商。

| 当前真机检查 | 结果 |
| --- | --- |
| 无令牌 JPEG 签名 APK 安装与系统投屏授权 | PASS；安装 APK 与下方哈希一致，用户已确认投屏授权 |
| 真实手机内网画面 → 接收端 → MCP 原生图片/操作台 | PASS；1080×2400 原始尺寸、`image/jpeg`，手机 USB 断开仍可工作 |
| 无令牌传输 | PASS；不发送 Authorization 时 `/frame.jpg` 返回 200，旧 `/frame.png` 返回 404 |
| BLE 加密、绑定、HID 就绪、主页、键鼠输入与暂停 | 已观察操作 PASS |
| 当前固件中文 LCD 显示 | 用户确认中文正常、无乱码；代理未实际目视检查实体 LCD |
| 桌面静置 16 秒，再间隔 1 秒串行读取 30 次 | PASS；30/30 新鲜、30 个不同源帧，无超时或过期拒绝；详细统计见下表 |
| 当前中文固件连续校准点按 | PASS；同一官方 HTTP MCP 会话、1:1 标定：(540,1200) 首次耗时 1859 ms，随后 (550,1210) 为 188 ms、(560,1220) 为 169 ms；每次 JPEG 确认指针位置，最后 PAUSE |
| 当前中文固件实体 DOWN 锁定、ARM 拒绝、板上 OK 恢复 | PASS；DOWN 后 locked=true/armed=false，ARM 返回 LOCKED；用户按 OK 后明确 ARM/主页操作成功，官方 SDK 随后确认 locked=false |
| 真实浏览器操作台响应与最终暂停 | PASS；无需令牌输入框、自动连接，明确 ARM 后后台截图期间主页按钮仍启用且执行成功，最后 UI 暂停/释放成功 |
| 当前 APK 运行时旋转、STOP 与重新投屏授权 | NOT RUN；此前模拟器尝试被自动审批审核拒绝，仅返回 blocked by policy，不声称当前真机已验收 |
| Wi-Fi 断开/恢复、地址变化、ESP USB 拔插恢复、其他安卓厂商 | 当前构建尚未验证 |

桌面 JPEG 采样使用下方 APK，保持默认 3000 ms 新鲜度限制，并计入图片正文传输。
30 张均通过 JPEG SOF、分段、SOS 与完整 EOI 结尾结构校验，尺寸均为 1080×2400。
静止桌面产生两个内容哈希，App 源帧 ID 有 30 个；未用 HTTP 返回时间伪造新鲜度。

| 桌面 JPEG 指标 | 最小 | 上中位数 | 最大 |
| --- | ---: | ---: | ---: |
| 图片字节数 | 197672 | 197691 | 197691 |
| HTTP 响应头中的源帧年龄（ms） | 50 | 624 | 1065 |
| 含正文传输的最终源帧年龄（ms） | 99 | 703 | 1260 |
| 单次截图请求耗时（ms） | 131 | 240 | 589 |

上中位数取 30 个样本排序后的第 16 项，与保存的 JSON 汇总一致。

本地证据：`apps/android-mcp/build/device-tests/oneplus-wallpaper-jpeg-v4.json`
与 `oneplus-wallpaper-jpeg-v4-last.jpg`；同目录连续点按证据为
`oneplus-chinese-nearby.actions.json.results.json` 和 `oneplus-chinese-tap-*.jpg`。
此前 PNG 和模拟器记录仅作历史证据，其中连接码/401 检查不代表当前产品合同。
当前实体停止证据为 `oneplus-chinese-physical-stop.json`；浏览器证据为
`operator-no-token-final.json` 与 `operator-no-token-final.png`。随后
`oneplus-chinese-recovery.actions.json.results.json` 确认加密/绑定/就绪，
locked=false/armed=false，真实 JPEG 有效且最后 PAUSE。

此前真机还验证过 MITM 配对、100 ms 鼠标节拍及停止 PING 1.8 秒后看门狗停用输入。
这些不能替代当前构建的恢复测试。

当前中文合并固件 SHA-256：
`eee6d19893483eb6ad38e64cfe280fa607ec17ad060818be9ab4fc314c40dcb1`。
匹配 ELF SHA-256：
`8c7c575762bd9f596a4a93f3f6a7bda665650f7f133aeb6747c00444d84b1775`。
已将验证过的分段镜像烧录到 COM5 的 0x0、0x8000、0x10000，保留 NVS 地址范围及
蓝牙绑定，未执行整片擦除。

已安装签名 APK SHA-256：
`94458e41878fdaac309e6103ab0080504aa1e46a48e557e947a38f790539da89`。
固件产物位于 `apps/esp/build/firmware/<hash>/`，APK 位于 `apps/android-screen/build/`；
日志、截图、本地配置及签名密钥保持 Git 忽略。

当前运行的本机 MCP 服务已包含无令牌、JPEG、操作台与输入优化。最新串口冷连
修复已编译并通过主机测试：仅首次中性握手 PING 的 ACK 超时允许再试一次，输入与
ARM 均不重发；下次服务重启才会生效。本轮本机 MCP 重启被自动审批审核拒绝，
因此不声称当前进程已启用该修复，也未绕过审核。

代码位于 `codex/android-agent`，本轮增量尚未提交或 push。定时自动化已实际
**PAUSED**。剩余真机检查为上表的未验收与未验证项目。

</details>

</details>

</details>

</details>

</details>
