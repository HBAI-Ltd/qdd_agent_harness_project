<p align="right"><strong>简体中文</strong> · <a href="android-bridge.md">English</a></p>

# 设备控制器 Wi-Fi/USB 到 BLE 键鼠桥接

电脑通过局域网 Wi-Fi TCP 或 AI Passport 的 USB Serial/JTAG CDC 串口发出指令；AI Passport 作为
已配对的 BLE HOGP 键盘和相对鼠标连接安卓。手机安装独立的“设备投屏”App，
通过 Wi-Fi 内网将画面传给电脑；指针校准、手势、文本映射和 MCP 由电脑负责。
手机 USB 仅用于首次安装或调试，详见 monorepo 的
`apps/android-screen/README.zh_CN.md` 与 `apps/android-mcp/README.zh_CN.md`。
固件不包含无障碍执行器、AirPlay 接收器、Wi-Fi 热点或云端密钥。
实时预览提供极速灰度、快速、标准、原画四档；MCP 按需等待新的原尺寸 JPEG 截图。手机 App 与电脑 MCP/操作台不要求
应用令牌或连接码；安卓屏幕共享授权和 BLE 系统六位配对 PIN 仍保留，
已绑定手机重连无需重复配对。

参考项目 [esp32-iphone-agent](https://github.com/onehumanbeing/esp32-iphone-agent)
使用 ESP32-S3 原生 USB HID 和 AirPlay。当前 C3 的 USB Serial/JTAG 是固定
串口/调试外设，因此输入改用 BLE HOGP。保留 FoloToy BSP 驱动，应用与屏幕
独立实现，应用通过 ESP-IDF NimBLE 公开 GATT API 注册 HOGP 服务。刻意不调用
`esp_hidd_dev_init`：IDF 5.5.3 私有 HID listener 在 CONNECT 失败时会 assert，
也没有安全移除该 listener 的公开 API。应用只有自己的 GAP 回调，CONNECT
失败时重置状态并在连接查询前返回，不注册私有 HID listener。

[HOGP ICS 表 3 和 4](https://files.bluetooth.com/wp-content/uploads/2024/10/HOGP.ICS.p8.pdf)
要求 Battery Service、Device Information Service 和 PnP ID。GATT 提供
Battery Service（`180F`，可读 Battery Level `2A19`）
及 Device Information Service（`180A`，可读 PnP ID `2A50`）。电量读取使用
显示任务已有的 0..100 缓存，GATT 回调不执行 I2C；缓存不可用时返回 ATT 错误，
不编造电量百分比。

在 `menuconfig` → **QDD Android HID bridge** 中配置 PnP vendor-ID source
（1 Bluetooth SIG / 2 USB-IF）、有权使用的 vendor ID、product ID 和 version。
开发默认是 source **1**、vendor **FFFF**、product **0000**、version **0100**，
明确作为 unknown 开发哨兵，不是已分配的厂商身份。只使用分配给自己或已获得
授权的标识，不冒用其他厂商 ID。本原型不宣称通过 Bluetooth qualification。
这些源码默认值同时保存在 `sdkconfig.defaults`。

## 连接与操作

1. 先执行 `npm run build:android:screen`，再从 monorepo 根目录执行 `npm run build:esp`。
   固件直接嵌入已签名 APK，CMake 会核对 APK 与 `build/manifest.json` 的 SHA-256；
   缺少 APK 或哈希不一致时构建失败。门禁使用新的
   `sdkconfig.defaults`，包含 HID、Secure Connections 与配对持久化。
   已忽略的开发用 `sdkconfig` 可能覆盖默认值；增量开发请使用独立配置/构建目录。
2. 按 [AGENTS.md](../AGENTS.zh_CN.md) 取得明确设备授权后才烧录。
   分区兼容时，分段烧录可以保留 NVS；合并镜像可能重置 NVS，包括蓝牙配对。
3. 手机安装投屏 App，让手机和电脑连接同一 Wi-Fi 内网。
   Passport 可以通过 USB 串口连接电脑；选择 Wi-Fi 控制时，在主界面用上下键选择“设置”，
   确认进入后选择 Wi-Fi，并用屏幕键盘输入密码。
4. 在安卓蓝牙设置中选择 `QDD-Passport-XXXX`。未配对的新设备会开启两分钟
   配对窗口；在设置内选择“手机配对”可重新开启。在安卓配对弹窗中输入 Passport 屏幕上的六位码。
5. 将电脑端 `ESP_HOST` 填成 Passport 显示的 IPv4，`ESP_TCP_PORT` 填端口
   （默认 3333），再启动桥接。留空 `ESP_HOST` 时显式使用 `ESP_PORT` 的 USB 串口。
   电脑每 300 ms 发送 PING，无需另外手动启用。只有 BLE 已认证、
   加密并保存配对、安卓已订阅当前协议的鼠标与键盘通知，且电脑心跳新鲜时，
   中文屏幕才显示“可以远程操作”。

| 设备按键/页面 | 行为 |
| --- | --- |
| 主界面上下键 | 在急停 / 取消急停、设置两项中选择，不执行输入动作。启动及返回主界面默认选中急停。 |
| 主界面确认单击 | 执行选中项：急停立即锁定并释放输入；取消急停只可在设备上确认；设置进入纵向菜单。 |
| 设置及普通子页 | 上下选择、确认进入；纵向“返回上一级”返回，无需长按。按键指南及手机配对位于设置内。 |
| 密码键盘 | 保留上下选行/选字及确认输入；长按确认打开纵向完成菜单。 |

独立的 240 × 320 中文屏幕优先显示“已紧急停止”，其次是等待电脑、手机连接，
以及“可以远程操作”。“电脑已连接”要求当前控制源 PING 心跳在线（不超过
1500 ms），接入数据线或仅连上 Wi-Fi 都不算。电量位于右上角，不可用显示 `--%`。
底部身份卡显示蓝牙名称，连接助手显示联网地址；只有配对窗口打开且配对码可见时显示本地六位 PIN。错误与操作反馈均为固定中文。

统一产品名称为“设备控制器 / 设备投屏 / 设备操作台”。屏幕采用暗色 `#d4380d` 主题，
右侧固定三条无文字主题色圆头竖条，对应上、下、确认；上下端距边缘各 4 px。
普通菜单纵向排列，返回项清楚可选；所有菜单期间持续阻断手机输入并释放旧输入，
退出不清除急停锁，也不要求手动启用。全部文字使用有许可的 14/20 px CJK 子集，
见[资源说明](../assets/README.zh_CN.md)。主题色提示条和键盘自绘以控制内存，文字和状态不变时不重绘。
按键指南按实物显示灰色高机身、顶部挂绳槽、上半部偏左屏幕、右下斜纹扬声器及银色侧键，附有引线和上移、下移、确认执行说明，底部保留“返回上一级”。
原测试菜单不参与链接且不可进入；手机绑定、控制协议、USB 连接检测和心跳门禁均保留。

### 直接在设备上配网

首次连接按屏幕的六步引导进行：连接 Wi-Fi → 扫码安装 → 等待 App → 连接手机蓝牙
→ 打开电脑 EXE → 开始操作。已完成的步骤自动跳过。主界面上下选择急停并确认，默认选中急停；进入设置后手机输入被阻断。
未配置网络时自动打开网络列表和屏幕键盘；已保存网络失联时保留配置并尝试重连。

联网后二维码与 `http://<控制板IP>:3334/` 指向控制板自身的中文连接页。
扫码页和等待安装页同时提示：可扫码，也可在手机浏览器输入屏幕上的 IP 和端口下载 App。
手机、电脑和 ESP 必须连接同一局域网，手机连接页也会醒目提示；此安装页面仅在该内网可用。
手机扫码下载 `/qdd-remote.apk`，安装后在连接页点“打开投屏 App”将控制板地址传给 App。
App 也会自动查找同一内网唯一的控制板，并显示已有蓝牙名称；不会删除原配对。
电脑打开“设备操作台”，连接设置的“自动查找”会读取手机地址、设备身份和控制板地址，
确认保存即可使用。多块控制板须选择目标，不会任意接管第一块。

HTTP 3334 提供 `/api/status`、`POST /api/phone` 和 `POST /api/pc`，UDP 3335 回应
`QDD-DISCOVER/1`。手机和电脑注册仅更新引导页，15 秒过期，不能授予输入权限。
手机连接页不要求访问电脑的本机端口；电脑操作台按其连接设置提供本机与局域网访问。
APK 存于应用 Flash，保留既有 NVS、PHY 分区与蓝牙绑定。

设备支持 2.4 GHz Wi-Fi。列表最多显示八个网络，按信号强度排序，带页码、“重新查找”和“返回”。上下
选择，确认进入。长名称仅在屏幕上缩短，原始有效 UTF-8 SSID（最多 32 字节）
完整保留用于连接；字体不支持的名称显示网络序号与 BSSID 后四位。隐藏网络
可用下方可选 USB 诊断工具配置。

屏幕键盘每页四行六列，共四页，涵盖数字、小写、大写、标点及明确写出的“空格”，
共 95 个可打印 ASCII 字符。上下先选行，确认进入该行，上下选字，确认输入并回到
行选择，记住上次位置。长按确认进入纵向“连接网络、继续输入、删除一位、返回上一级”；继续无损返回键盘。
普通 Wi-Fi 列表和其它菜单均直接选择“返回上一级”，最终从设备菜单选择“返回主界面”。删除完整移除末尾一个
UTF-8 字符。密码始终掩码显示，不进入日志或协议状态。个人网络密码为 8..63
字节，或恰好 64 位十六进制 PSK；开放网络允许空密码，不提供企业网络登录。

整个设置期间用原子禁止标记持续阻断非零手机输入和电脑启用命令。设置页下键仅
用于选择；主界面同样上下选择、确认执行，默认选中急停。退出使旧输入失效，不清除实体急停锁；成功联网后
返回主界面并显示地址，手机安全连接及电脑心跳就绪后即可接收新操作。网络单独保存为 NVS 的
`qdd_wifi/profile`，连接失败不会清除网络信息、手机绑定或整个 NVS。

可选 USB 诊断：创建已忽略的 `apps/esp/.wifi.local.json`，填写 `port`、`ssid`、
`password`，从 monorepo 根目录运行 `start-esp-wifi.cmd`。可用 `--config PATH`
指定本机 JSON，`--check` 仅检查格式，不打开串口。先手动停止占用串口的电脑
服务；工具不会杀进程或重启服务，不打印密码，先暂停再配置，始终不会恢复操作。

### 唯一控制源与重连

TCP 仅监听当前私网 IPv4，默认端口 3333，可由 `CONFIG_QDD_TCP_PORT` 配置。
最多接受一个 TCP 连接，多余连接立即关闭。USB 与 TCP 使用相同的下方有界行协议，
首个 PING 取得唯一控制权。只有该来源能续心跳或改变输入，另一个来源可读 STATUS，
但 PING、ARM、PAUSE、RELEASE 与输入操作返回 `CONTROL_BUSY`，不能干扰控制源。
TCP 配对管理返回 `USB_ONLY`。配网期间拒绝新控制源与 ARM，返回 `CONFIGURING`。

USB 在线信号经过 50 ms 连续丢失确认，避免 ESP-IDF SOF 检测的毫秒级抖动误清除
控制源或半行数据。启动时未连接、持续丢失和时钟倒退仍停止控制；USB 恢复后仍须
新的有效 PING。该确认不延长 1500 ms 心跳期限，也不影响实体确认急停的即时阻断。

Socket 关闭、Wi-Fi/地址连接代次变化、USB 控制源断开或超过 1500 ms 无心跳时，
释放输入、暂停并清除控制权；TCP 控制源同时关闭 Socket。即使相同 IP 重连，新 TCP 也不能继承旧输入缓冲、
租约或启用状态。回复不积压、不重试，部分写入或失败会关闭 TCP 连接。
Wi-Fi 按有界退避重连，不自动切到 USB。新控制源须发送新鲜 PING，手机安全连接
就绪后即可接收新命令，实体急停锁仍阻止操作。此 hackathon 局域网
协议不使用应用令牌或 TLS，请连接预期的本地网络；USB 是显式备用选项。

可选 USB 配网使用独立的 `QDDNET/1 <id>` 行：`WIFI_STATUS`、
`WIFI_SSID <base64 UTF-8>`、`WIFI_PASS <base64>`（空密码为 `-`）、`WIFI_SAVE`、
`WIFI_RETRY`、`WIFI_CLEAR`。修改要求已暂停且没有 TCP 控制源，原生配网页面期间
也拒绝 USB 修改。SSID 与密码必须都暂存后才能 SAVE；回复仅含是否已配置、是否
联网、IP 和端口，不包含网络名称或密码。CLEAR 只删除网络配置键，TCP 一律拒绝。

配对窗口以外拒绝未知设备。已有配对手机重连不会恢复旧按键，就绪后可直接接收
新鲜电脑命令，无需手动启用。固件保存一个
手机的配对，不擦除 NVS、不淘汰旧配对，也不静默接受重复配对。如果安卓忘记
密钥或需要换主人，必须明确维护配对数据；打开配对窗口不会删除原手机密钥。

## USB/TCP 协议：QDDHID/1

使用 ASCII 行，以 LF 结尾，支持 CRLF。缓冲行最大 128 字节，包含可选 CR、
不包含 LF。忽略空行。请求 id 为 1..2147483647 的十进制整数。

```text
QDDHID/1 <id> <OP> <args>\n
QDDHID/1 <id> OK <状态 JSON>\n
QDDHID/1 <id> ERR <错误码>\n
```

每条非空请求恰好一条回复。无有效解析 id 的非法/超长行回复 id `0`。
超长行会丢弃到 LF 后才恢复解析，不能把尾部当新命令。拒绝嵌入 NUL、非 ASCII、
整数溢出、未知操作、多余/缺少参数和越界数字。ESP-IDF 启动日志没有
`QDDHID/1` 前缀，不属于协议回复。
启动成功后静音 ESP-IDF 运行日志，避免日志与协议回复共用 CDC 时交错。

| 操作 | 参数与行为 |
| --- | --- |
| `PING` | 刷新电脑控制租约；只有 PING 能刷新。 |
| `STATUS` | 获取当前状态。 |
| `ARM` | 保留兼容的可选启用命令。未锁定、BLE 已连接/认证/加密/保存配对、当前鼠标与键盘均已订阅、最近 PING 不超过 1500 ms 时启用；先释放旧输入。正常输入命令会自动执行同样的检查。 |
| `PAUSE` | 内部释放与重置命令，保留实体停止锁；下一条有效输入无需另行 ARM。 |
| `RELEASE` | 释放全部鼠标键、键盘键/修饰键及 Consumer usage，保留 armed 与实体锁状态。 |
| `MOVE dx dy wheel buttons` | 相对鼠标报告。dx/dy/wheel 各为 -127..127；buttons 为左/右/中键的 0..7 位掩码。 |
| `KEY modifier keycode` | 一个 USB HID 键盘 usage，不是安卓 keycode。modifier 与 keycode 各为 0..255。keycode=0 释放全部键及修饰键。 |
| `CONSUMER usage` | 16 位 HID Consumer usage，0..65535；0 释放。AC Home 为 547（`0x0223`），AC Back 为 548（`0x0224`）；安卓实际映射需要实机验证。 |
| `PAIR` | 仅本地 USB 初始化：先暂停、释放，再打开两分钟配对窗口；保留实体停止锁。 |
| `PAIR_STATUS` | 仅本地 USB 初始化：只读配对窗口/配对码状态，不改变状态，也不续心跳。 |

所有 OK 回复均使用固定 JSON 字段：

```json
{"v":1,"connected":true,"encrypted":true,"armed":false,"locked":false,"bonded":true,"ready":true,"name":"QDD-Passport-1234"}
```

只有 `PAIR` 与 `PAIR_STATUS` 在完整状态后追加 `pairingOpen`、`passkeyVisible`。
仅在配对窗口打开且已生成可见配对码时包含数值 `passkey`。`PING`、普通 `STATUS`、
错误及其他回复均不携带配对码。两个 USB 管理操作供本地初始化脚本使用，不
暴露成 MCP Agent 工具；display-only MITM 配对及设备实体停止锁继续生效。

错误码为 `BAD_COMMAND`、`LINE_TOO_LONG`、`LOCKED`、`NOT_CONNECTED`、
`NOT_AUTHENTICATED`、`HID_NOT_READY`、`HEARTBEAT_EXPIRED`、`HID_SEND_FAILED`、
`CONTROL_BUSY`、`USB_ONLY` 或 `CONFIGURING`。
`ready` 要求当前 Report/Boot 协议的键盘和鼠标通知均已订阅，加密本身不等于
输入就绪。取消其中一项订阅会停用输入；切换协议或暂停 HID 也会停用。
Consumer 订阅不阻止 ARM，但非零 Consumer usage 需要其自己的订阅。
没有订阅接收方的中性释放报告为 no-op。
OK 表示本机 BLE 栈接受报告，不证明安卓目标 App 已执行。发送失败会停用并释放。
固件只发送短小即时报告，不缓存长手势或打字序列；电脑逐条组合点击、拖动、
滑动和文本。字符取决于安卓当前实体键盘布局，协议不传输 Unicode 文本。

当前控制源断开、超过 1500 ms 没有 PING、BLE 安全状态丢失或 BLE 断连都会停用输入。
断开的链路不能向安卓送达释放报告；安卓需要清除已断连 HID 的按键状态。
固件在安全重连后先发送中性报告，再接收新输入；不会重放旧按键或解除实体急停，
新的有效输入可自动激活控制，无需手动 ARM。

## 验证

`tests/test_qdd_hid.c` 测试纯 C 解析器、每个流切分位置、粘包、超长排空、
非法输入、数值边界、报告字节、心跳边界、实体锁、断连重连、释放失败与回复格式。
它随 `tools/validate.sh --static` 执行，保留原 BSP/演示逻辑宿主测试。
`tests/test_qdd_control.c` 验证控制源隔离、所有权、私网地址与心跳边界；
`tests/test_qdd_net_config.c` 验证本地配置严格解析；`tests/test_qdd_setup_model.c`
通过实际焦点模型遍历全部 95 个键，覆盖 UTF-8 字节边界/删除、扫描返回与密码清除。
`tests/test_qdd_ui_model.c` 验证中文状态优先级、链路与心跳区别、心跳边界、
PIN 可见性、提示到期及确认键的实际策略。`tests/test_qdd_fonts.py` 检查字符清单、
生成 cmap 与控件字体绑定。可选原生主机工程 `tests/qdd_ui_host/` 使用真实 LVGL 9.5
字形查询与缺字负例，检查所有标签宽度/边界，并按本板圆角遮罩捕获七种主界面与十种配网 RGB565
画面。使用相同 24 KiB LVGL 池及 240 × 20 绘制缓冲，100 次相同刷新没有刷屏或
新增活跃分配。二十次进入退出保持相同活跃分配数，分配器对齐循环有界且稳定。
这些是宿主验证，不能替代实体屏幕与 BLE/Wi-Fi 同时运行时堆内存验收。
`tests/test_qdd_hid.c` 还覆盖独立的 Report/Boot CCCD 掩码、延迟/部分订阅、运行中取消订阅、
Consumer 就绪和重连清除订阅。`tests/test_qdd_ble_contract.py` 检查 CONNECT
失败提前返回路径，以及未引入 SDK 私有 listener 的入口。
它也检查 BAS/DIS 必需特征声明和缓存电量读取；C 测试验证 PnP 的七字节小端
编码及 ID source 校验。

实机验收仍需指定安卓手机：六位码加密配对、重连、鼠标键/滚轮、按住键时释放、
实体停止、拔 USB、电脑崩溃/心跳超时、旋转与指针校准、文本布局、Consumer
Home/Back、电量和屏幕显示。编译与宿主测试不能证明这些结果。
