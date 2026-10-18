<p align="right"><strong>简体中文</strong> · <a href="acceptance.md">English</a></p>

# 安卓内网投屏与控制验收

## 用户真机反馈与当前边界

2026-10-17：用户明确反馈真机下载正常，并要求停止下载排查和推测性修改。
本记录以该实际使用反馈为准。此前电脑 curl、Node 及经 ADB 启动的手机 curl 探测出现超时或截断，
仅说明这些特定探测未通过，不能等同于用户浏览器/App 下载功能故障；原始日志仍保留供追溯。
该停止要求针对此前的推测性排查。此后用户新报更换控制器后的局域网问题，
本轮仅按新问题范围进行有界传输验证：v26 新板 APK 下载及哈希通过，没有修改 APK 源码，
也不把下载通过当作手机已安装。

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
